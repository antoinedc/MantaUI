// reach.mjs — Reddit and X access for the Architect, ported from the agent-reach project's public route
// (https://github.com/Panniantong/agent-reach, MIT; see THIRD_PARTY.md in this folder for the notice):
//   search = Exa's free hosted search (JSON-RPC at mcp.exa.ai, no key) scoped with `site:`;
//   read   = the Jina reader (r.jina.ai), which renders pages a plain request can't (reddit blocks data-centre requests,
//            x.com needs JavaScript).
// Ported: the Exa response handling (JSON or `text/event-stream` `data:` lines, last message wins; a provider tool error and a
// quota error told apart from an empty result), the `Title:/URL:/Published:/Author:` block parser, the Jina page parser, the
// anti-bot / login-wall detection and the scope check. Not ported: the Python runtime, backends and browser.
//
// Copyright (c) 2025 Agent Eyes — MIT License. Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
// of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
// Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
// THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
// COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
// ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

import { ResearchError } from "./transport.mjs";

export const EXA_ENDPOINT = "https://mcp.exa.ai/mcp";
export const JINA_ORIGIN = "https://r.jina.ai/";
/** Provider hosts the generic fetch never reaches: only the dedicated adapters build a request to them. */
export const RESERVED_HOSTS = Object.freeze(["r.jina.ai", "mcp.exa.ai", "s.jina.ai"]);
export const RESERVED_SENTENCE = "Use research_search, or a Reddit or X post address, instead";
export const RATE_LIMIT_SENTENCE = "Exa's search limit was reached; use the built-in websearch with site: instead";
export const UNREADABLE_SENTENCE = "X/Reddit didn't return readable content";

const EXA_LIMIT_RE =
  /\b429\b|rate[ _-]?limit|too many requests|\bquota\b|(?:usage|request|daily|monthly|free)[ _-]+limit|(?:credit|credits|balance).{0,40}(?:exhaust|deplet|insufficient|exceed|reach)|(?:out of|insufficient|exhausted).{0,20}credits?/i;

/** What a failed Exa call says, told apart: `{ code: "rate-limited" | "bad-input" | "broken", message }`. */
export function exaError(text, rpcCode) {
  const t = String(text ?? "").slice(0, 300);
  if (rpcCode === -32602 || rpcCode === "-32602") return new ResearchError(`Exa rejected the search: ${t}`, "bad-input");
  if (rpcCode === 429 || rpcCode === "429" || EXA_LIMIT_RE.test(String(text ?? ""))) return new ResearchError(RATE_LIMIT_SENTENCE, "rate-limited");
  return new ResearchError("Exa's search failed; try the built-in websearch with site: instead", "broken");
}

/** The text of one Exa tool call from its raw response (JSON, or SSE `data:` lines — the last message wins). Throws a ResearchError. */
export function parseExaResponse(raw) {
  const text = String(raw ?? "");
  const payloads = text.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
  let msg;
  try {
    msg = JSON.parse(payloads.length > 0 ? payloads[payloads.length - 1] : text);
  } catch {
    throw new ResearchError("Exa's search answered in a format that wasn't understood", "broken");
  }
  if (msg && typeof msg === "object" && msg.error) throw exaError(msg.error.message ?? JSON.stringify(msg.error), msg.error.code);
  const result = msg?.result ?? {};
  const out = (Array.isArray(result.content) ? result.content : []).filter((c) => c?.type === "text").map((c) => c.text ?? "").join("\n");
  if (result.isError) throw exaError(out);
  return out;
}

const EXA_HEADER_RE = /^(Title|URL|Published|Author):\s*(.*)$/;
const na = (v) => (v == null || v === "" || v === "N/A" ? null : v);

/** Split Exa's `Title: / URL: / Published: / Author:` blocks into items `{ title, url, author, published, text }`. */
export function parseExaText(text) {
  const items = [];
  for (const block of `\n${String(text ?? "").trim()}`.split(/\n(?=Title: )/)) {
    const lines = block.trim().split("\n");
    if (!lines[0]?.startsWith("Title:")) continue;
    const fields = {};
    let i = 0;
    for (; i < lines.length; i++) {
      const m = EXA_HEADER_RE.exec(lines[i]);
      if (!m) break;
      fields[m[1].toLowerCase()] = m[2].trim();
    }
    const body = lines.slice(i).filter((l) => !["Highlights:", "Text:"].includes(l.trim()));
    items.push({ title: na(fields.title), url: na(fields.url), author: na(fields.author), published: na(fields.published), text: body.join("\n").trim() });
  }
  return items;
}

export const SCOPES = Object.freeze({
  reddit: { query: "site:reddit.com", hosts: ["reddit.com"] },
  x: { query: "site:x.com OR site:twitter.com", hosts: ["x.com", "twitter.com"] },
});

const hostIs = (host, base) => host === base || host.endsWith(`.${base}`);

/** Is a result's address inside the platform's scope? */
export function inScope(url, platform) {
  try {
    const u = new URL(url);
    return SCOPES[platform].hosts.some((h) => hostIs(u.hostname.toLowerCase(), h));
  } catch {
    return false;
  }
}

/** The request body of one Exa search, scoped to a platform. */
export function exaSearchBody(query, platform, limit = 10) {
  const scoped = `(${query}) (${SCOPES[platform].query})`;
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "web_search_exa", arguments: { query: scoped, objective: scoped, numResults: limit } } });
}

/**
 * Search one platform through Exa. `hop` is the guarded transport's single request. Returns the in-scope results
 * `{ title, url, published, snippet }[]` (an out-of-scope result is dropped; a response with no recognisable result is an
 * error, never a "successful empty search").
 */
export async function exaSearch(hop, query, platform, { deadlineAt, limit = 10 } = {}) {
  const res = await hop({
    url: EXA_ENDPOINT,
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: exaSearchBody(query, platform, limit),
    deadlineAt,
    bytesLeft: 1024 * 1024,
  });
  const raw = res.body.toString("utf-8");
  if (res.status === 429) throw exaError(raw, 429);
  if (res.status >= 400) throw exaError(raw.slice(0, 300));
  const items = parseExaText(parseExaResponse(raw));
  if (items.length === 0) throw new ResearchError("Exa returned no recognisable results", "broken");
  return items
    .filter((it) => it.url && inScope(it.url, platform))
    .slice(0, limit)
    .map((it) => ({ title: it.title, url: it.url, published: it.published, snippet: it.text.replace(/\s+/g, " ").slice(0, 200) }));
}

// ---- reading a post through Jina ----

/** Canonicalise a Reddit or X post address; `{ platform, url }` or `{ error }`. Anything else is refused with zero provider calls. */
export function canonicalPost(input) {
  let u;
  try {
    u = new URL(String(input));
  } catch {
    return { error: "That isn't a valid address" };
  }
  const host = u.hostname.toLowerCase();
  const reddit = ["reddit.com", "www.reddit.com", "old.reddit.com"].includes(host);
  const x = ["x.com", "twitter.com", "www.x.com", "www.twitter.com", "mobile.twitter.com"].includes(host);
  if (!reddit && !x) return { error: null };
  const bad = { error: "Reddit and X posts must be post addresses (/r/<sub>/comments/<id>… or /<user>/status/<id>) with no query or fragment" };
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) return bad;
  if (reddit) {
    const m = /^\/r\/([A-Za-z0-9_]{2,21})\/comments\/([a-z0-9]{4,10})(?:\/[^/?#]*)?(?:\/([a-z0-9]{4,10}))?\/?$/i.exec(u.pathname);
    if (!m) return bad;
    return { platform: "reddit", url: `https://www.reddit.com${u.pathname.replace(/\/+$/, "")}` };
  }
  const m = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{5,25})\/?$/.exec(u.pathname);
  if (!m) return bad;
  return { platform: "x", url: `https://x.com/${m[1]}/status/${m[2]}` };
}

/** A Jina challenge / captcha response (high-confidence signs only). */
export function isAntibotPage(body) {
  const sample = String(body ?? "").slice(0, 4096).toLowerCase();
  const captchaWarning = sample.includes("warning:") && sample.includes("requiring captcha");
  const challenge = ["title: just a moment...", "## performing security verification", "title: attention required! | cloudflare"].some((m) => sample.includes(m));
  const cloudflare = sample.includes("title: attention required! | cloudflare") && (sample.includes("ray id") || sample.includes("/cdn-cgi/challenge-platform/"));
  return (captchaWarning && challenge) || cloudflare;
}

/** The title, publish time and Markdown content of a Jina response. */
export function parseJina(body) {
  const text = String(body ?? "");
  const title = /^Title:\s*(.*)$/m.exec(text);
  const published = /^Published Time:\s*(.*)$/m.exec(text);
  const content = text.includes("Markdown Content:") ? text.split("Markdown Content:").slice(1).join("Markdown Content:") : text;
  return { title: title ? title[1].trim() : null, published: published ? published[1].trim() : null, text: content.trim() };
}

const WALL = "log\\s*in|sign\\s*in|join\\s+(?:now|linkedin)|登录|登入|注册|just a moment|prove your humanity|access denied|security verification|安全验证|验证码";
const LOGIN_ONLY = "(?:(?:please\\s+)?(?:log\\s*in|sign\\s*in)(?:\\s+to\\s+continue)?[.!?\\s]*|(?:请)?(?:登录|登入)(?:后继续|以继续)?[。！\\s]*)+";

/** Reject empty shells and clear login / challenge pages (not inline login links). */
export function isReadable({ title, text }) {
  const t = String(text ?? "").trim();
  const head = String(title ?? "").trim();
  if (!t || (t.length < 80 && t.toLowerCase() === head.toLowerCase())) return false;
  if (new RegExp(`^(?:${WALL})(?:\\s*[-|·:].*)?$`, "i").test(head)) return false;
  return !new RegExp(`^${LOGIN_ONLY}$`, "i").test(t);
}

/**
 * Read one canonical post through Jina. The URL must already have passed `canonicalPost` (the only caller builds the
 * request from validated components). `{ title, published, text }` or throws the fixed "didn't return readable content".
 */
export async function jinaRead(hop, canonicalUrl, { deadlineAt, bytesLeft }) {
  const res = await hop({ url: `${JINA_ORIGIN}${canonicalUrl}`, headers: { Accept: "text/plain" }, deadlineAt, bytesLeft });
  const body = res.body.toString("utf-8");
  if (res.status !== 200 || isAntibotPage(body)) throw new ResearchError(UNREADABLE_SENTENCE, "unreadable");
  const page = parseJina(body);
  if (!isReadable(page)) throw new ResearchError(UNREADABLE_SENTENCE, "unreadable");
  return page;
}
