// Agents Phase 5A: the Architect's research tools (src/server/research.mjs and research/*). The transport, DNS, execFile and
// the secrets store are fakes or a loopback fixture; nothing reaches the internet.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResearchEngine, addressRefusal, WINDOW_CHARS } from "./research.mjs";
import { createGuardedTransport, fetchFollowing, ResearchError } from "./research/transport.mjs";
import { parseExaResponse, parseExaText, canonicalPost, isAntibotPage, isReadable, inScope } from "./research/reach.mjs";
import { queryRefusal, redact, searchDirs } from "./research/extra.mjs";
import { DEFAULT_ORDER, BUILTIN_SOURCES } from "../shared/researchSources.mjs";

// the research sources store's rows, as `researchSources.rows()` gives them: the user's sources first, then the built-ins in order
const rowsOf = (extras = [], disabled = []) => [
  ...extras.map((s) => ({ ...s, builtin: false, kind: s.command ? "command" : "url", enabled: !disabled.includes(s.id), private: s.private !== false })),
  ...BUILTIN_SOURCES.map((b) => ({ id: b.id, builtin: true, kind: "builtin", enabled: !disabled.includes(b.id), private: false, name: b.name, description: b.description })),
];

const html = (body, title = "A page") => `<html><head><title>${title}</title></head><body>${body}</body></html>`;
const reply = (status, headers, body) => {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body ?? "");
  return { status, headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), body: buf, bytes: buf.length };
};

async function fixture({ routes = {}, bound = true, architect = true, extras = [], disabled = [], secrets = [], exec, now, engineExtra = {} } = {}) {
  const base = await mkdtemp(join(tmpdir(), "research-test-"));
  const calls = [];
  const hop = async (req) => {
    calls.push({ url: req.url, method: req.method ?? "GET", headers: req.headers, body: req.body });
    const route = routes[req.url] ?? routes["*"];
    if (!route) throw new ResearchError("Couldn't reach that address", "failed");
    return typeof route === "function" ? route(req) : route;
  };
  const binds = [];
  const engine = createResearchEngine({
    bind: async (b, tool) => {
      binds.push({ b, tool });
      return bound === true ? { childSessionID: b.sessionID, architect } : { refused: bound };
    },
    root: join(base, "research"),
    agentHome: join(base, "home"),
    home: join(base, "h"),
    pathEnv: join(base, "bin"),
    hop,
    sourceList: async () => rowsOf(extras, disabled),
    loadSecretsStrict: async () => {
      if (secrets === "throw") throw new Error("unreadable");
      return secrets;
    },
    exec,
    log: { warn: () => {} },
    toolsRoot: join(base, "tools", "skills"),
    ...(now ? { now } : {}),
    ...engineExtra,
  });
  return { base, calls, binds, engine, root: join(base, "research"), cleanup: () => rm(base, { recursive: true, force: true }) };
}
const call = (over = {}) => ({ sessionID: "ses_child", messageID: "msg1", callID: "call1", ...over });

test("binding refusals come back as sentences BEFORE any fetch, command or write", async () => {
  const f = await fixture({ bound: "Only the Architect, working on a task from Manta, can use this tool", routes: { "*": reply(200, { "content-type": "text/plain" }, "x") }, extras: [{ id: "bf", name: "n", description: "d", command: ["yc", "{query}"], private: true }] });
  try {
    for (const r of [await f.engine.fetch(call({ url: "https://example.com/" })), await f.engine.read(call({ sourceId: "src_0123456789abcdef" })), await f.engine.search(call({ source: "hn", query: "agents" })), await f.engine.search(call({ source: "bf", query: "agents" }))]) {
      assert.equal(r.ok, false);
      assert.match(r.error, /Only the Architect/);
    }
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.binds.map((b) => b.tool), ["research_fetch", "research_read", "research_search", "research_search"]);
    await assert.rejects(readdir(f.root), /ENOENT/, "nothing written");
  } finally {
    await f.cleanup();
  }
});

test("research_fetch: html becomes text with links inline, is stored as an immutable source of this session, and returns the first window", async () => {
  const page = html(`<h1>Heading</h1><p>Read the <a href="https://docs.example.com/x">docs</a>.</p><script>evil()</script>`, "Docs & Things");
  const f = await fixture({ routes: { "https://example.com/doc": reply(200, { "Content-Type": "text/html; charset=utf-8" }, page) } });
  try {
    const r = await f.engine.fetch(call({ url: "https://example.com/doc" }));
    assert.equal(r.ok, true, r.error);
    assert.match(r.sourceId, /^src_[0-9a-f]{16}$/);
    assert.equal(r.title, "Docs & Things");
    assert.match(r.text, /HEADING/i);
    assert.match(r.text, /docs \[https:\/\/docs\.example\.com\/x\]/);
    assert.ok(!r.text.includes("evil()"));
    assert.equal(r.nextOffset, null);
    const stored = await f.engine.getSource("ses_child", r.sourceId);
    assert.equal(stored.url, "https://example.com/doc");
    assert.equal(stored.finalUrl, "https://example.com/doc");
    assert.equal(stored.private, false);
    assert.equal(stored.text, r.text);
    // per-session isolation: another session can't read it
    assert.equal(await f.engine.getSource("ses_other", r.sourceId), null);
    assert.equal(await f.engine.getSource("../ses_child", r.sourceId), null);
    const other = await f.engine.read(call({ sessionID: "ses_other", sourceId: r.sourceId }));
    assert.equal(other.ok, false);
    assert.match(other.error, /wasn't fetched in this task/);
    assert.equal(f.calls[0].method, "GET");
  } finally {
    await f.cleanup();
  }
});

test("research_read pages a long source by sourceId and offset; a window is 40 000 characters with a note on how to go on", async () => {
  const long = "word ".repeat(30_000); // 150 000 chars
  const f = await fixture({ routes: { "https://example.com/long": reply(200, { "content-type": "text/plain" }, long) } });
  try {
    const first = await f.engine.fetch(call({ url: "https://example.com/long" }));
    assert.equal(first.text.length, WINDOW_CHARS);
    assert.equal(first.total, long.length);
    assert.equal(first.nextOffset, WINDOW_CHARS);
    assert.match(first.note, /research_read/);
    const second = await f.engine.read(call({ sourceId: first.sourceId, offset: first.nextOffset }));
    assert.equal(second.ok, true);
    assert.equal(second.text, long.slice(WINDOW_CHARS, 2 * WINDOW_CHARS));
    const last = await f.engine.read(call({ sourceId: first.sourceId, offset: 3 * WINDOW_CHARS + 1 }));
    assert.equal(last.nextOffset, null);
    assert.equal((await f.engine.read(call({ sourceId: first.sourceId, offset: -1 }))).ok, false);
    assert.equal((await f.engine.read(call({ sourceId: first.sourceId, offset: 1e9 }))).ok, false);
    assert.equal((await f.engine.read(call({ sourceId: "nonsense" }))).ok, false);
  } finally {
    await f.cleanup();
  }
});

test("research_fetch content types: plain text, markdown and JSON as is; HN item JSON as 'author: comment'; anything else refused", async () => {
  const item = { title: "Show HN: Agents", points: 120, author: "pg", url: "https://x.example.com", children: [{ author: "alice", text: "<p>Short rules <i>win</i>.</p>", children: [{ author: "bob", text: "Agreed.", children: [] }] }] };
  const f = await fixture({
    routes: {
      "https://example.com/a.md": reply(200, { "content-type": "text/markdown" }, "# Title\nbody"),
      "https://example.com/a.json": reply(200, { "content-type": "application/json" }, '{"a":1}'),
      "https://hn.algolia.com/api/v1/items/123": reply(200, { "content-type": "application/json" }, JSON.stringify(item)),
      "https://example.com/a.png": reply(200, { "content-type": "image/png" }, "PNG"),
      "https://example.com/missing": reply(404, { "content-type": "text/html" }, "nope"),
    },
  });
  try {
    assert.equal((await f.engine.fetch(call({ url: "https://example.com/a.md" }))).text, "# Title\nbody");
    assert.equal((await f.engine.fetch(call({ url: "https://example.com/a.json" }))).text, '{"a":1}');
    const hn = await f.engine.fetch(call({ url: "https://news.ycombinator.com/item?id=123" }));
    assert.equal(hn.ok, true, hn.error);
    assert.match(hn.text, /Show HN: Agents — 120 points — by pg/);
    assert.match(hn.text, /\n {2}alice: Short rules win\./);
    assert.match(hn.text, /\n {4}bob: Agreed\./);
    assert.equal(f.calls.at(-1).url, "https://hn.algolia.com/api/v1/items/123");
    assert.match((await f.engine.fetch(call({ url: "https://example.com/a.png" }))).error, /This kind of file can't be read yet/);
    assert.match((await f.engine.fetch(call({ url: "https://example.com/missing" }))).error, /status 404/);
  } finally {
    await f.cleanup();
  }
});

test("provider endpoints are reserved: a direct r.jina.ai / mcp.exa.ai / s.jina.ai address, or a redirect to one, makes ZERO provider calls", async () => {
  const f = await fixture({ routes: { "https://example.com/go": reply(302, { location: "https://r.jina.ai/https://example.com/secret" }, ""), "*": reply(200, { "content-type": "text/plain" }, "ok") } });
  try {
    for (const url of ["https://r.jina.ai/https://example.com/", "https://mcp.exa.ai/mcp", "https://s.jina.ai/query", "https://sub.r.jina.ai/x"]) {
      const r = await f.engine.fetch(call({ url }));
      assert.equal(r.ok, false);
      assert.match(r.error, /Use research_search/);
    }
    assert.equal(f.calls.length, 0);
    const redirected = await f.engine.fetch(call({ url: "https://example.com/go" }));
    assert.match(redirected.error, /Use research_search/);
    assert.deepEqual(f.calls.map((c) => c.url), ["https://example.com/go"], "only the first hop was requested");
    assert.match(addressRefusal("ftp://example.com/"), /Only http and https/);
    assert.match(addressRefusal("https://user:pw@example.com/"), /username or password/);
  } finally {
    await f.cleanup();
  }
});

test("Reddit and X posts are read through Jina from validated components; anything out of scope makes zero provider calls", async () => {
  const jina = (title, md) => reply(200, { "content-type": "text/plain" }, `Title: ${title}\nURL Source: https://www.reddit.com/r/x\nPublished Time: 2026-01-02\n\nMarkdown Content:\n${md}`);
  const f = await fixture({ routes: { "https://r.jina.ai/https://www.reddit.com/r/ClaudeAI/comments/abc123/nice_agents": jina("Nice agents", "A long enough post body that clearly has content, with real sentences about agents and how short rules help them. ".repeat(2)), "https://r.jina.ai/https://x.com/someone/status/1234567890123": jina("Tweet", "Short rules beat long ones, and here is a long enough tweet-thread body to count as content for the reader check. ".repeat(2)) } });
  try {
    const r = await f.engine.fetch(call({ url: "https://old.reddit.com/r/ClaudeAI/comments/abc123/nice_agents/" }));
    assert.equal(r.ok, true, r.error);
    assert.equal(r.title, "Nice agents");
    const stored = await f.engine.getSource("ses_child", r.sourceId);
    assert.equal(stored.url, "https://old.reddit.com/r/ClaudeAI/comments/abc123/nice_agents/");
    assert.equal(stored.finalUrl, "https://www.reddit.com/r/ClaudeAI/comments/abc123/nice_agents");
    const t = await f.engine.fetch(call({ url: "https://twitter.com/someone/status/1234567890123" }));
    assert.equal(t.ok, true, t.error);
    const before = f.calls.length;
    for (const url of [
      "https://www.reddit.com/r/ClaudeAI/", // a listing
      "https://www.reddit.com/r/ClaudeAI/comments/abc123/x/?utm=1", // a query
      "https://www.reddit.com/r/ClaudeAI/comments/abc123/x/#frag", // a fragment
      "https://user:pw@www.reddit.com/r/ClaudeAI/comments/abc123/x/", // credentials
      "http://www.reddit.com/r/ClaudeAI/comments/abc123/x/", // not https
      "https://x.com/home", // not a post
      "https://x.com/a/status/12", // too short an id
    ]) {
      const bad = await f.engine.fetch(call({ url }));
      assert.equal(bad.ok, false, url);
    }
    assert.equal(f.calls.length, before, "zero provider calls");
    assert.deepEqual(canonicalPost("https://example.com/"), { error: null });
  } finally {
    await f.cleanup();
  }
});

test("Reddit/X anti-bot pages and login walls are refused with one fixed sentence", async () => {
  const challenge = "Title: Just a moment...\n\nWarning: This page maybe requiring captcha\n\nMarkdown Content:\n## Performing security verification";
  const f = await fixture({
    routes: {
      "https://r.jina.ai/https://x.com/a/status/1234567890": reply(200, { "content-type": "text/plain" }, challenge),
      "https://r.jina.ai/https://x.com/b/status/1234567891": reply(200, { "content-type": "text/plain" }, "Title: Log in\n\nMarkdown Content:\nPlease log in to continue."),
      "https://r.jina.ai/https://x.com/c/status/1234567892": reply(403, { "content-type": "text/plain" }, "forbidden"),
    },
  });
  try {
    for (const url of ["https://x.com/a/status/1234567890", "https://x.com/b/status/1234567891", "https://x.com/c/status/1234567892"]) {
      const r = await f.engine.fetch(call({ url }));
      assert.equal(r.ok, false);
      assert.equal(r.error, "X/Reddit didn't return readable content");
    }
    assert.equal(isAntibotPage(challenge), true);
    assert.equal(isReadable({ title: "Log in", text: "Please sign in to continue" }), false);
    assert.equal(isReadable({ title: "Post", text: "Real content here, with enough words to be a post about something real and useful." }), true);
  } finally {
    await f.cleanup();
  }
});

test("Exa responses: JSON and text/event-stream (last message wins); a tool error and a quota error are told apart from empty results", () => {
  const blocks = "Title: Rules\nURL: https://www.reddit.com/r/x/comments/abc123/rules\nPublished: 2026-01-01\nAuthor: N/A\nText:\nShort rules win.\n\nTitle: Other\nURL: https://example.com/other\nText:\nNot reddit.";
  const json = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: blocks }] } });
  assert.equal(parseExaResponse(json), blocks);
  const sse = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "old" }] } })}\n\nevent: message\ndata: ${json}\n\n`;
  assert.equal(parseExaResponse(sse), blocks);
  const items = parseExaText(blocks);
  assert.equal(items.length, 2);
  assert.equal(items[0].author, null);
  assert.equal(items[0].published, "2026-01-01");
  assert.equal(items[0].text, "Short rules win.");
  assert.throws(() => parseExaResponse(JSON.stringify({ error: { code: 429, message: "slow down" } })), (e) => e.code === "rate-limited" && /built-in websearch/.test(e.message));
  assert.throws(() => parseExaResponse(JSON.stringify({ result: { isError: true, content: [{ type: "text", text: "Free usage limit reached" }] } })), (e) => e.code === "rate-limited");
  assert.throws(() => parseExaResponse(JSON.stringify({ result: { isError: true, content: [{ type: "text", text: "kaboom" }] } })), (e) => e.code === "broken");
  assert.throws(() => parseExaResponse(JSON.stringify({ error: { code: -32602, message: "bad" } })), (e) => e.code === "bad-input");
  assert.throws(() => parseExaResponse("<html>"), (e) => e.code === "broken");
  assert.equal(inScope("https://www.reddit.com/r/x", "reddit"), true);
  assert.equal(inScope("https://example.com/", "reddit"), false);
  assert.equal(inScope("https://twitter.com/a/status/1", "x"), true);
});

test("research_search reddit/x: a scoped Exa search, out-of-scope results dropped; a quota error says so; Exa never reads a page", async () => {
  const text = "Title: Rules\nURL: https://www.reddit.com/r/x/comments/abc123/rules\nText:\nShort rules win.\n\nTitle: Off\nURL: https://example.com/off\nText:\nnope";
  const ok = reply(200, { "content-type": "application/json" }, JSON.stringify({ result: { content: [{ type: "text", text }] } }));
  const f = await fixture({ routes: { "https://mcp.exa.ai/mcp": ok } });
  try {
    const r = await f.engine.search(call({ source: "reddit", query: "agent rules" }));
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.results.map((x) => x.url), ["https://www.reddit.com/r/x/comments/abc123/rules"]);
    const sent = JSON.parse(f.calls[0].body);
    assert.equal(f.calls[0].method, "POST");
    assert.equal(sent.params.name, "web_search_exa");
    assert.match(sent.params.arguments.query, /\(agent rules\) \(site:reddit\.com\)/);
    await f.engine.search(call({ source: "x", query: "agent rules" }));
    assert.match(JSON.parse(f.calls[1].body).params.arguments.query, /site:x\.com OR site:twitter\.com/);
    assert.ok(f.calls.every((c) => !JSON.stringify(c).includes("web_fetch_exa")), "Exa is only used for search");
  } finally {
    await f.cleanup();
  }
  const g = await fixture({ routes: { "https://mcp.exa.ai/mcp": reply(200, { "content-type": "application/json" }, JSON.stringify({ error: { code: 429, message: "rate limit" } })) } });
  try {
    const r = await g.engine.search(call({ source: "reddit", query: "agent rules" }));
    assert.equal(r.ok, false);
    assert.match(r.error, /Exa's search limit was reached; use the built-in websearch with site:/);
  } finally {
    await g.cleanup();
  }
});

test("research_search hn and arxiv: compact results; web is not a source; an unknown source lists the available ones; queries are checked", async () => {
  const hits = { hits: [{ title: "Agents that work", url: "https://a.example.com", points: 300, num_comments: 80, objectID: "42" }, { title: "Ask HN", url: null, points: 5, num_comments: 1, objectID: "43" }] };
  const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/2602.12670v1</id><published>2026-02-01T00:00:00Z</published><title>SkillsBench:\n  skills</title><summary>${"x ".repeat(400)}</summary><author><name>A One</name></author><author><name>B Two</name></author></entry></feed>`;
  const f = await fixture({
    routes: {
      "https://hn.algolia.com/api/v1/search?query=agent%20rules&tags=story&hitsPerPage=10": reply(200, { "content-type": "application/json" }, JSON.stringify(hits)),
      "https://export.arxiv.org/api/query?search_query=all:agent%20skills&start=0&max_results=8&sortBy=relevance": reply(200, { "content-type": "application/atom+xml" }, atom),
    },
    extras: [{ id: "bookface", name: "BF", description: "d", command: ["yc", "{query}"], private: true }],
  });
  try {
    const hn = await f.engine.search(call({ source: "hn", query: "agent rules" }));
    assert.deepEqual(hn.results[0], { title: "Agents that work", url: "https://a.example.com", points: 300, comments: 80, item: "https://news.ycombinator.com/item?id=42" });
    const ax = await f.engine.search(call({ source: "arxiv", query: "agent skills" }));
    assert.equal(ax.ok, true, ax.error);
    assert.equal(ax.results[0].title, "SkillsBench: skills");
    assert.deepEqual(ax.results[0].authors, ["A One", "B Two"]);
    assert.equal(ax.results[0].date, "2026-02-01");
    assert.equal(ax.results[0].url, "https://arxiv.org/abs/2602.12670v1");
    assert.ok(ax.results[0].summary.length <= 300);
    assert.match((await f.engine.search(call({ source: "web", query: "q" }))).error, /websearch/);
    assert.match((await f.engine.search(call({ source: "nope", query: "q" }))).error, /Available: bookface, github, packages, stackoverflow, hn, reddit, arxiv, x$/);
    assert.match((await f.engine.search(call({ source: "hn", query: "-x" }))).error, /dash/);
    assert.match((await f.engine.search(call({ source: "hn", query: "x".repeat(201) }))).error, /1 to 200/);
    assert.match((await f.engine.search(call({ source: "hn", query: "" }))).error, /1 to 200/);
  } finally {
    await f.cleanup();
  }
});

// ---- PDFs ----

// a one-page PDF with a real xref table; `text === null` makes a page with no text at all (a scan has only an image)
function makePdf(text) {
  const stream = text === null ? "" : `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

test("research_fetch reads a PDF: the text is extracted, stored like any source and quotable", async () => {
  const f = await fixture({ routes: { "https://papers.example.com/kohavi.pdf": reply(200, { "content-type": "application/pdf" }, makePdf("Most online experiments are underpowered and show no real effect.")) } });
  try {
    const r = await f.engine.fetch(call({ url: "https://papers.example.com/kohavi.pdf" }));
    assert.equal(r.ok, true, r.error);
    assert.match(r.sourceId, /^src_[0-9a-f]{16}$/);
    assert.match(r.text, /Most online experiments are underpowered and show no real effect\./);
    const stored = await f.engine.getSource("ses_child", r.sourceId);
    assert.equal(stored.url, "https://papers.example.com/kohavi.pdf");
    assert.equal(stored.private, false);
    assert.match(stored.text, /underpowered/);
  } finally {
    await f.cleanup();
  }
});

test("research_fetch on a PDF without a text layer (a scan) or one that is damaged says so in one sentence, and stores nothing", async () => {
  const f = await fixture({
    routes: {
      "https://papers.example.com/scan.pdf": reply(200, { "content-type": "application/pdf" }, makePdf(null)),
      "https://papers.example.com/broken.pdf": reply(200, { "content-type": "application/pdf" }, "this is not a pdf at all"),
    },
  });
  try {
    const scan = await f.engine.fetch(call({ url: "https://papers.example.com/scan.pdf" }));
    assert.equal(scan.ok, false);
    assert.match(scan.error, /no text layer/);
    assert.match(scan.error, /scan/);
    const broken = await f.engine.fetch(call({ url: "https://papers.example.com/broken.pdf" }));
    assert.equal(broken.ok, false);
    assert.match(broken.error, /PDF couldn't be read/);
    await assert.rejects(readdir(f.root), /ENOENT/, "nothing stored");
  } finally {
    await f.cleanup();
  }
});

test("transport: a PDF may be up to the PDF cap, any other page keeps the 2 MiB cap; the refusal names the cap that applied", async () => {
  const body = Buffer.alloc(300_000, 1);
  const s = await serve((req, res) => {
    res.writeHead(200, { "content-type": req.url === "/a.pdf" ? "application/pdf" : "text/plain" });
    res.end(body);
  });
  try {
    const hop = testTransport();
    const opts = { byteCap: 100_000, pdfByteCap: 400_000 };
    const pdf = await fetchFollowing(hop, `http://127.0.0.1:${s.port}/a.pdf`, opts);
    assert.equal(pdf.body.length, 300_000);
    await assert.rejects(fetchFollowing(hop, `http://127.0.0.1:${s.port}/a.txt`, opts), (e) => e.code === "too-large" && /over 98 KiB/.test(e.message));
    await assert.rejects(fetchFollowing(hop, `http://127.0.0.1:${s.port}/a.pdf`, { byteCap: 100_000, pdfByteCap: 200_000 }), (e) => e.code === "too-large" && /over 195 KiB/.test(e.message));
  } finally {
    await s.close();
  }
});

// ---- GitHub ----

const ghJson = (obj, headers = {}) => reply(200, { "content-type": "application/json; charset=utf-8", ...headers }, JSON.stringify(obj));
const repoItem = (over = {}) => ({ full_name: "acme/cro-skill", html_url: "https://github.com/acme/cro-skill", stargazers_count: 1234, pushed_at: "2026-11-02T10:00:00Z", license: { spdx_id: "MIT" }, description: "A skill for landing page reviews", topics: ["agent-skills", "cro"], ...over });

test("research_search github: repositories with name, url, stars, last push, licence and description; unauthenticated, one request, a note says code search needs a token", async () => {
  const f = await fixture({ routes: { "*": (req) => ghJson({ items: [repoItem(), repoItem({ full_name: "x/y", html_url: "https://github.com/x/y", stargazers_count: 3, license: null, description: null, topics: [] })] }) } });
  try {
    const r = await f.engine.search(call({ source: "github", query: "landing page conversion" }));
    assert.equal(r.ok, true, r.error);
    assert.equal(r.source, "github");
    assert.deepEqual(r.results[0], { title: "acme/cro-skill", url: "https://github.com/acme/cro-skill", stars: 1234, pushed: "2026-11-02", license: "MIT", description: "A skill for landing page reviews" });
    assert.deepEqual(r.results[1], { title: "x/y", url: "https://github.com/x/y", stars: 3, pushed: "2026-11-02", license: null, description: null });
    assert.match(r.note, /code search/i);
    assert.equal(f.calls.length, 1);
    const u = new URL(f.calls[0].url);
    assert.equal(u.origin + u.pathname, "https://api.github.com/search/repositories");
    assert.match(u.searchParams.get("q"), /^landing page conversion skill/);
    assert.equal(f.calls[0].headers.Authorization, undefined);
    assert.match(f.calls[0].headers.Accept, /github/);
  } finally {
    await f.cleanup();
  }
});

test("research_search github with a shared GITHUB_TOKEN: the token goes to api.github.com only, code search for SKILL.md files is added, and no redirect is followed", async () => {
  const f = await fixture({
    secrets: [{ key: "GITHUB_TOKEN", scope: "shared", value: "ghp_secretvalue" }],
    routes: {
      "*": (req) => {
        const u = new URL(req.url);
        if (u.pathname === "/search/repositories") return ghJson({ items: [repoItem()] });
        if (u.pathname === "/search/code") return ghJson({ items: [{ name: "SKILL.md", path: "skills/cro/SKILL.md", html_url: "https://github.com/acme/cro-skill/blob/main/skills/cro/SKILL.md", repository: { full_name: "acme/cro-skill", description: "A skill" } }] });
        throw new Error("unexpected");
      },
    },
  });
  try {
    const r = await f.engine.search(call({ source: "github", query: "cro" }));
    assert.equal(r.ok, true, r.error);
    assert.equal(r.results.length, 2);
    assert.deepEqual(r.results[1], { title: "acme/cro-skill — skills/cro/SKILL.md", url: "https://github.com/acme/cro-skill/blob/main/skills/cro/SKILL.md", description: "A skill" });
    assert.equal(r.note, undefined);
    assert.equal(f.calls.length, 2);
    for (const c of f.calls) assert.equal(c.headers.Authorization, "Bearer ghp_secretvalue");
    assert.match(new URL(f.calls[1].url).searchParams.get("q"), /cro filename:SKILL\.md/);
  } finally {
    await f.cleanup();
  }
  const g = await fixture({ secrets: [{ key: "GITHUB_TOKEN", scope: "shared", value: "ghp_secretvalue" }], routes: { "*": reply(302, { location: "https://evil.example.com/" }, "") } });
  try {
    const r = await g.engine.search(call({ source: "github", query: "cro" }));
    assert.equal(r.ok, false);
    assert.ok(!JSON.stringify(r).includes("ghp_secretvalue"));
    assert.equal(g.calls.length, 1, "the redirect target was never asked");
  } finally {
    await g.cleanup();
  }
});

test("research_search github: a project- or session-scoped GITHUB_TOKEN is ignored; an unreadable secrets store still searches without one; a failing code search keeps the repositories", async () => {
  const f = await fixture({ secrets: [{ key: "GITHUB_TOKEN", scope: "project", value: "ghp_nope" }], routes: { "*": ghJson({ items: [repoItem()] }) } });
  try {
    assert.equal((await f.engine.search(call({ source: "github", query: "cro" }))).ok, true);
    assert.equal(f.calls[0].headers.Authorization, undefined);
  } finally {
    await f.cleanup();
  }
  const g = await fixture({ secrets: "throw", routes: { "*": ghJson({ items: [repoItem()] }) } });
  try {
    const r = await g.engine.search(call({ source: "github", query: "cro" }));
    assert.equal(r.ok, true, r.error);
    assert.equal(g.calls[0].headers.Authorization, undefined);
  } finally {
    await g.cleanup();
  }
  const h = await fixture({
    secrets: [{ key: "GITHUB_TOKEN", scope: "shared", value: "ghp_x" }],
    routes: { "*": (req) => (new URL(req.url).pathname === "/search/code" ? reply(422, { "content-type": "application/json" }, "{}") : ghJson({ items: [repoItem()] })) },
  });
  try {
    const r = await h.engine.search(call({ source: "github", query: "cro" }));
    assert.equal(r.ok, true, r.error);
    assert.equal(r.results.length, 1);
    assert.match(r.note, /code search/i);
  } finally {
    await h.cleanup();
  }
});

test("research_search github: the rate limit, a rejected query and an unreadable answer are told apart in fixed sentences; the query is checked first", async () => {
  const limited = await fixture({ routes: { "*": reply(403, { "x-ratelimit-remaining": "0", "content-type": "application/json" }, '{"message":"API rate limit exceeded"}') } });
  const rejected = await fixture({ routes: { "*": reply(422, { "content-type": "application/json" }, '{"message":"Validation Failed"}') } });
  const garbage = await fixture({ routes: { "*": reply(200, { "content-type": "application/json" }, "<html>") } });
  try {
    assert.match((await limited.engine.search(call({ source: "github", query: "cro" }))).error, /search limit.*minute/i);
    assert.match((await rejected.engine.search(call({ source: "github", query: "cro" }))).error, /rejected the search/);
    assert.match((await garbage.engine.search(call({ source: "github", query: "cro" }))).error, /wasn't understood/);
    assert.match((await limited.engine.search(call({ source: "github", query: "-x" }))).error, /dash/);
    assert.equal(limited.calls.length, 1);
  } finally {
    await limited.cleanup();
    await rejected.cleanup();
    await garbage.cleanup();
  }
});

test("research_fetch reads GitHub files raw: a github.com blob address is read from raw.githubusercontent.com, stored as a public source under the original address", async () => {
  const f = await fixture({
    routes: {
      "https://raw.githubusercontent.com/acme/cro-skill/main/skills/cro/SKILL.md": reply(200, { "content-type": "text/plain; charset=utf-8" }, "# CRO\nShow one primary call to action per screen."),
      "https://raw.githubusercontent.com/acme/cro-skill/main/README.md": reply(200, { "content-type": "text/plain; charset=utf-8" }, "# Readme"),
      "https://github.com/acme/cro-skill": reply(200, { "content-type": "text/html" }, html("<p>repo page</p>")),
    },
  });
  try {
    const blob = await f.engine.fetch(call({ url: "https://github.com/acme/cro-skill/blob/main/skills/cro/SKILL.md?plain=1#L3-L9" }));
    assert.equal(blob.ok, true, blob.error);
    assert.match(blob.text, /one primary call to action/);
    assert.equal(f.calls[0].url, "https://raw.githubusercontent.com/acme/cro-skill/main/skills/cro/SKILL.md");
    const stored = await f.engine.getSource("ses_child", blob.sourceId);
    assert.equal(stored.url, "https://github.com/acme/cro-skill/blob/main/skills/cro/SKILL.md?plain=1#L3-L9");
    assert.equal(stored.finalUrl, "https://raw.githubusercontent.com/acme/cro-skill/main/skills/cro/SKILL.md");
    assert.equal(stored.private, false);
    // a raw address works as is; the repository page (not a blob) is read as the page it is
    assert.equal((await f.engine.fetch(call({ url: "https://raw.githubusercontent.com/acme/cro-skill/main/README.md" }))).ok, true);
    const page = await f.engine.fetch(call({ url: "https://github.com/acme/cro-skill" }));
    assert.match(page.text, /repo page/);
    assert.equal(f.calls.at(-1).url, "https://github.com/acme/cro-skill");
  } finally {
    await f.cleanup();
  }
});

// ---- extra sources ----

const cmdSource = (over = {}) => ({ id: "bookface", name: "YC Bookface", description: "Private forum.", private: true, command: ["yc", "search", "{query}", "--json"], ...over });

async function withProgram(f, name = "yc") {
  await mkdir(join(f.base, "bin"), { recursive: true });
  await writeFile(join(f.base, "bin", name), "#!/bin/sh\n", { mode: 0o755 });
}

test("command source: the query is ONE argument (no shell); a leading dash is refused; minimal environment; stderr is never returned", async () => {
  const seen = [];
  const exec = async (file, args, opts) => {
    seen.push({ file, args, opts });
    return { stdout: "found: three posts", stderr: "SECRET-TOKEN-IN-STDERR" };
  };
  const f = await fixture({ extras: [cmdSource({ env: { YC_TOKEN: "{secret:YC_TOKEN}" } })], secrets: [{ key: "YC_TOKEN", scope: "shared", value: "tok-123456789" }], exec });
  try {
    await withProgram(f);
    const r = await f.engine.search(call({ source: "bookface", query: "; rm -rf ~ && echo $HOME" }));
    assert.equal(r.ok, true, r.error);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].args, ["search", "; rm -rf ~ && echo $HOME", "--json"], "one argument, untouched");
    assert.equal(seen[0].opts.shell, false);
    assert.equal(seen[0].file, join(f.base, "bin", "yc"));
    assert.deepEqual(Object.keys(seen[0].opts.env).sort(), ["HOME", "LANG", "PATH", "YC_TOKEN"]);
    assert.equal(seen[0].opts.env.YC_TOKEN, "tok-123456789");
    assert.equal(seen[0].opts.cwd, join(f.base, "home"));
    assert.equal(seen[0].opts.timeout, 60_000);
    assert.equal(seen[0].opts.maxBuffer, 2 * 1024 * 1024);
    assert.ok(!JSON.stringify(r).includes("STDERR"));
    for (const q of ["-rf", "  --token x", "a\nb", ""]) {
      const bad = await f.engine.search(call({ source: "bookface", query: q }));
      assert.equal(bad.ok, false, JSON.stringify(q));
    }
    assert.equal(seen.length, 1, "refused queries never ran anything");
    assert.equal(queryRefusal("fine query"), null);
  } finally {
    await f.cleanup();
  }
});

test("command source failures are fixed sentences: exit code, timeout, size cap, missing program; stderr never leaks", async () => {
  const errs = [
    [Object.assign(new Error("Command failed: yc\nstderr: token=abc"), { code: 3, stderr: "token=abc" }), /The source failed \(exit 3\)/],
    [Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" }), /timed out/],
    [Object.assign(new Error("big"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }), /more than 2 MiB/],
  ];
  for (const [err, re] of errs) {
    const f = await fixture({ extras: [cmdSource()], exec: async () => Promise.reject(err) });
    try {
      await withProgram(f);
      const r = await f.engine.search(call({ source: "bookface", query: "q" }));
      assert.equal(r.ok, false);
      assert.match(r.error, re);
      assert.ok(!r.error.includes("token=abc"));
    } finally {
      await f.cleanup();
    }
  }
  const g = await fixture({ extras: [cmdSource()], exec: async () => ({ stdout: "x" }) });
  try {
    const r = await g.engine.search(call({ source: "bookface", query: "q" })); // no program on PATH
    assert.match(r.error, /isn't installed/);
    assert.deepEqual(searchDirs("yc", { home: "/h", pathEnv: "/a:/b" }), ["/a", "/b", "/h/.local/bin", "/h/.yc/bin"]);
  } finally {
    await g.cleanup();
  }
});

test("secrets: only SHARED ones are used; a session- or project-scoped one of the same name is ignored; missing fails closed; values are redacted", async () => {
  const exec = async () => ({ stdout: "line with tok-123456789 inside and tok-123456789 again" });
  const only = [{ key: "YC_TOKEN", scope: "session", sessionID: "ses_child", value: "session-value-1" }, { key: "YC_TOKEN", scope: "project", project: "p", value: "project-value-1" }];
  const f = await fixture({ extras: [cmdSource({ env: { YC_TOKEN: "{secret:YC_TOKEN}" } })], secrets: only, exec });
  try {
    await withProgram(f);
    const r = await f.engine.search(call({ source: "bookface", query: "q" }));
    assert.equal(r.ok, false);
    assert.equal(r.error, "The source's secret YC_TOKEN is missing");
  } finally {
    await f.cleanup();
  }
  const g = await fixture({ extras: [cmdSource({ env: { YC_TOKEN: "{secret:YC_TOKEN}" } })], secrets: [...only, { key: "YC_TOKEN", scope: "shared", value: "tok-123456789" }], exec });
  try {
    await withProgram(g);
    const r = await g.engine.search(call({ source: "bookface", query: "q" }));
    assert.equal(r.ok, true, r.error);
    assert.equal(r.text, "line with [secret] inside and [secret] again");
    assert.equal((await g.engine.getSource("ses_child", r.sourceId)).text, r.text, "redacted in what is stored too");
    assert.equal(redact("abc tok abc", new Set(["tok"])), "abc [secret] abc");
  } finally {
    await g.cleanup();
  }
  const h = await fixture({ extras: [cmdSource({ env: { YC_TOKEN: "{secret:YC_TOKEN}" } })], secrets: "throw", exec });
  try {
    await withProgram(h);
    assert.match((await h.engine.search(call({ source: "bookface", query: "q" }))).error, /Couldn't read the stored secrets/);
  } finally {
    await h.cleanup();
  }
});

test("a private source's result is stored as a private source with no URL; a public one is not marked private", async () => {
  const exec = async () => ({ stdout: "post about short rules" });
  const f = await fixture({ extras: [cmdSource(), cmdSource({ id: "pub", name: "Pub", private: false })], exec });
  try {
    await withProgram(f);
    const priv = await f.engine.search(call({ source: "bookface", query: "rules" }));
    const pub = await f.engine.search(call({ source: "pub", query: "rules" }));
    const a = await f.engine.getSource("ses_child", priv.sourceId);
    const b = await f.engine.getSource("ses_child", pub.sourceId);
    assert.equal(a.private, true);
    assert.equal(a.url, null);
    assert.equal(a.finalUrl, null);
    assert.equal(b.private, false);
    assert.match(a.title, /YC Bookface: rules/);
  } finally {
    await f.cleanup();
  }
});

const urlSource = (over = {}) => ({ id: "internal", name: "Internal", description: "d", private: true, url: "https://search.example.com/api?q={query}&limit=5", ...over });

test("url source: https origin only, the query URL-encoded; a same-origin redirect is followed without secrets; cross-origin is refused and never asked", async () => {
  const f = await fixture({
    extras: [urlSource()],
    routes: {
      "https://search.example.com/api?q=a%20%26%20b&limit=5": reply(302, { location: "https://search.example.com/v2?q=a" }, ""),
      "https://search.example.com/v2?q=a": reply(200, { "content-type": "application/json" }, '{"hits":[1]}'),
      "https://search.example.com/api?q=away&limit=5": reply(302, { location: "https://evil.example.net/x" }, ""),
      "https://search.example.com/api?q=down&limit=5": reply(302, { location: "http://search.example.com/x" }, ""),
    },
  });
  try {
    const ok = await f.engine.search(call({ source: "internal", query: "a & b" }));
    assert.equal(ok.ok, true, ok.error);
    assert.equal(ok.text, '{"hits":[1]}');
    const away = await f.engine.search(call({ source: "internal", query: "away" }));
    assert.match(away.error, /another site/);
    assert.ok(!f.calls.some((c) => c.url.includes("evil.example.net")), "the second origin is never asked");
    assert.match((await f.engine.search(call({ source: "internal", query: "down" }))).error, /another site/);
  } finally {
    await f.cleanup();
  }
});

test("url source with a secret header: the secret is sent, NO redirect is followed, and the value is redacted from the output", async () => {
  const f = await fixture({
    extras: [urlSource({ headers: { Authorization: "Bearer {secret:EX_TOKEN}", Accept: "application/json" } })],
    secrets: [{ key: "EX_TOKEN", scope: "shared", value: "ex-secret-value" }],
    routes: {
      "https://search.example.com/api?q=ok&limit=5": reply(200, { "content-type": "application/json" }, '{"echo":"ex-secret-value"}'),
      "https://search.example.com/api?q=redir&limit=5": reply(302, { location: "https://search.example.com/same-origin" }, ""),
    },
  });
  try {
    const ok = await f.engine.search(call({ source: "internal", query: "ok" }));
    assert.equal(ok.ok, true, ok.error);
    assert.equal(ok.text, '{"echo":"[secret]"}');
    assert.equal(f.calls[0].headers.Authorization, "Bearer ex-secret-value");
    const redir = await f.engine.search(call({ source: "internal", query: "redir" }));
    assert.match(redir.error, /isn't allowed when it uses secrets/);
    assert.equal(f.calls.length, 2, "the redirect target was never requested");
  } finally {
    await f.cleanup();
  }
});

// ---- the production transport, against a loopback fixture ----

async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}
// the filtering agent refuses loopback unless told otherwise: the fixture lives on 127.0.0.1 (allowed here), and 127.0.0.2 stays blocked
const testTransport = () => createGuardedTransport({ agentOptions: { allowIPAddressList: ["127.0.0.1"] } });

test("transport: the default agent refuses private and loopback addresses, as IP literals too", async () => {
  const s = await serve((req, res) => res.end("secret"));
  try {
    const hop = createGuardedTransport();
    for (const url of [`http://127.0.0.1:${s.port}/`, `http://127.0.0.2:${s.port}/`, "http://10.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/"]) {
      await assert.rejects(hop({ url, deadlineAt: Date.now() + 2000, bytesLeft: 1000 }), (e) => e instanceof ResearchError && e.code === "blocked" && /private and local/.test(e.message), url);
    }
  } finally {
    await s.close();
  }
});

test("transport: a redirect from an allowed host to 127.0.0.2 is refused on the new hop; the redirect target never answers", async () => {
  let reached = false;
  const s = await serve((req, res) => {
    if (req.url === "/go") {
      res.writeHead(302, { location: `http://127.0.0.2:${s.port}/inner` });
      res.end();
    } else {
      reached = true;
      res.end("inner");
    }
  });
  try {
    const hop = testTransport();
    await assert.rejects(fetchFollowing(hop, `http://127.0.0.1:${s.port}/go`), (e) => e.code === "blocked");
    assert.equal(reached, false);
  } finally {
    await s.close();
  }
});

test("transport: gzip is decoded, the byte cap counts DECODED bytes across hops, and one deadline spans every hop", async () => {
  const big = "a".repeat(300_000);
  const s = await serve((req, res) => {
    if (req.url === "/gz") {
      res.writeHead(200, { "content-encoding": "gzip", "content-type": "text/plain" });
      res.end(zlib.gzipSync(Buffer.from("hello gzip")));
    } else if (req.url === "/bomb") {
      res.writeHead(200, { "content-encoding": "gzip", "content-type": "text/plain" });
      res.end(zlib.gzipSync(Buffer.from(big))); // tiny on the wire, big decoded
    } else if (req.url === "/hop1") {
      res.writeHead(302, { location: "/hop2", "content-type": "text/plain" });
      res.end("x".repeat(60_000));
    } else if (req.url === "/hop2") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("y".repeat(60_000));
    } else if (req.url === "/slow") {
      setTimeout(() => res.end("late"), 1500);
    } else if (req.url === "/slowhop") {
      setTimeout(() => {
        res.writeHead(302, { location: "/slow" });
        res.end();
      }, 300);
    }
  });
  try {
    const hop = testTransport();
    const gz = await fetchFollowing(hop, `http://127.0.0.1:${s.port}/gz`);
    assert.equal(gz.body.toString(), "hello gzip");
    await assert.rejects(fetchFollowing(hop, `http://127.0.0.1:${s.port}/bomb`, { byteCap: 100_000 }), (e) => e.code === "too-large");
    // 60 000 bytes of the redirect body + 60 000 of the final page exceed a 100 000-byte budget shared by BOTH hops
    await assert.rejects(fetchFollowing(hop, `http://127.0.0.1:${s.port}/hop1`, { byteCap: 100_000 }), (e) => e.code === "too-large");
    const ok = await fetchFollowing(hop, `http://127.0.0.1:${s.port}/hop1`, { byteCap: 200_000 });
    assert.equal(ok.body.length, 60_000);
    assert.equal(ok.redirects, 1);
    const t0 = Date.now();
    await assert.rejects(fetchFollowing(hop, `http://127.0.0.1:${s.port}/slowhop`, { deadlineMs: 700 }), (e) => e.code === "timeout");
    assert.ok(Date.now() - t0 < 1400, "the deadline is for the whole chain, not per hop");
  } finally {
    await s.close();
  }
});

test("transport: at most five redirects", async () => {
  const s = await serve((req, res) => {
    const n = Number(req.url.slice(1)) || 0;
    res.writeHead(302, { location: `/${n + 1}` });
    res.end();
  });
  try {
    await assert.rejects(fetchFollowing(testTransport(), `http://127.0.0.1:${s.port}/0`), /redirected too many times/);
    const calls = [];
    await assert.rejects(fetchFollowing(async (r) => (calls.push(r.url), { status: 302, headers: { location: "/n" }, body: Buffer.alloc(0), bytes: 0 }), "https://a.example.com/"), /too many times/);
    assert.equal(calls.length, 6, "the first request plus five redirects");
  } finally {
    await s.close();
  }
});

test("store sweep: sessions untouched for 30 days go; over the cap the OLDEST sessions go first", async () => {
  const f = await fixture();
  try {
    const day = 24 * 60 * 60 * 1000;
    const make = async (name, bytes, ageDays) => {
      await mkdir(join(f.root, name), { recursive: true });
      const file = join(f.root, name, "src_0000000000000001.json");
      await writeFile(file, "x".repeat(bytes));
      const t = new Date(Date.now() - ageDays * day);
      await utimes(file, t, t);
    };
    await make("ses_old", 10, 31);
    await make("ses_a", 1000, 3);
    await make("ses_b", 1000, 2);
    await make("ses_c", 1000, 1);
    await mkdir(join(f.root, "not a session"), { recursive: true });
    assert.deepEqual((await f.engine.sweep()).removed, 1);
    assert.deepEqual((await readdir(f.root)).sort(), ["not a session", "ses_a", "ses_b", "ses_c"]);
    assert.equal((await f.engine.sweep({ maxBytes: 2500 })).removed, 1);
    assert.deepEqual((await readdir(f.root)).sort(), ["not a session", "ses_b", "ses_c"]);
    assert.equal((await readFile(join(f.root, "ses_b", "src_0000000000000001.json"), "utf-8")).length, 1000);
  } finally {
    await f.cleanup();
  }
});

// ---- every agent may research, and every enabled source (the user's too) is theirs; `skills` stays the Architect's ----

test("AC-2.4: an agent that is not the Architect searches a user source (Bookface) and the base sources; the command runs", async () => {
  let ran = 0;
  const f = await fixture({
    architect: false,
    extras: [{ id: "bookface", name: "BF", description: "d", command: ["yc", "{query}"], private: true }],
    exec: async () => ((ran += 1), { stdout: "forum text" }),
    routes: {
      "https://example.com/": reply(200, { "content-type": "text/html" }, html("<p>Hello</p>")),
      "https://hn.algolia.com/api/v1/search?query=agents&tags=story&hitsPerPage=10": reply(200, { "content-type": "application/json" }, JSON.stringify({ hits: [{ title: "T", url: "https://t.example", points: 3, num_comments: 1, objectID: "1" }] })),
    },
  });
  try {
    await withProgram(f, "yc");
    const page = await f.engine.fetch(call({ url: "https://example.com/" }));
    assert.equal(page.ok, true);
    assert.equal((await f.engine.read(call({ sourceId: page.sourceId }))).ok, true);
    assert.equal((await f.engine.search(call({ source: "hn", query: "agents" }))).ok, true);
    const extra = await f.engine.search(call({ source: "bookface", query: "agents" }));
    assert.equal(extra.ok, true, extra.error);
    assert.equal(ran, 1, "the user's source ran for a non-Architect");
    assert.equal((await f.engine.getSource("ses_child", extra.sourceId)).private, true, "stored private");
    assert.deepEqual(f.binds.map((b) => b.tool), ["research_fetch", "research_read", "research_search", "research_search"]);
  } finally {
    await f.cleanup();
  }
});

test("a binding that does not say the caller is the Architect reaches user sources but never `skills`", async () => {
  let ran = 0;
  const base = await mkdtemp(join(tmpdir(), "research-test-"));
  try {
    const engine = createResearchEngine({
      bind: async (b) => ({ childSessionID: b.sessionID }),
      root: join(base, "research"),
      sourceList: async () => rowsOf([{ id: "bf", name: "n", description: "d", command: ["yc", "{query}"], private: true }]),
      exec: async () => ((ran += 1), { stdout: "x" }),
      home: join(base, "h"),
      agentHome: join(base, "home"),
      pathEnv: join(base, "bin"),
      log: { warn: () => {} },
    });
    await mkdir(join(base, "bin"), { recursive: true });
    await writeFile(join(base, "bin", "yc"), "#!/bin/sh\n", { mode: 0o755 });
    assert.equal((await engine.search(call({ source: "bf", query: "agents" }))).ok, true);
    assert.equal(ran, 1);
    const skills = await engine.search(call({ source: "skills", query: "agents" }));
    assert.equal(skills.ok, false);
    assert.match(skills.error, /Unknown source "skills"/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("AC-1.5 / FR-007: a source that is turned off is refused with its sentence before anything runs; an unknown one lists the enabled ids in priority order", async () => {
  let ran = 0;
  const f = await fixture({ extras: [{ id: "bookface", name: "BF", description: "d", command: ["yc", "{query}"], private: true }], disabled: ["bookface", "hn", "web"], exec: async () => ((ran += 1), { stdout: "x" }) });
  try {
    await withProgram(f, "yc");
    const off = await f.engine.search(call({ source: "bookface", query: "agents" }));
    assert.deepEqual(off, { ok: false, error: 'The source "bookface" is turned off in Settings → Research sources' });
    assert.equal((await f.engine.search(call({ source: "hn", query: "agents" }))).error, 'The source "hn" is turned off in Settings → Research sources');
    assert.equal((await f.engine.search(call({ source: "web", query: "agents" }))).error, 'The source "web" is turned off in Settings → Research sources');
    const unknown = await f.engine.search(call({ source: "nope", query: "agents" }));
    assert.equal(unknown.error, 'Unknown source "nope". Available: github, packages, stackoverflow, reddit, arxiv, x');
    assert.equal(ran, 0);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.cleanup();
  }
  const g = await fixture({ architect: true });
  try {
    assert.equal((await g.engine.search(call({ source: "nope", query: "q" }))).error, "Unknown source \"nope\". Available: github, packages, stackoverflow, hn, reddit, arxiv, x, skills");
    assert.equal((await g.engine.search(call({ source: "web", query: "q" }))).error, "Use the built-in websearch for the web");
  } finally {
    await g.cleanup();
  }
});

// ---- Architect v2 Stage 2 (spec §4.2): searches are recorded per session; the `skills` source is the Architect's ----

const HN_URL = "https://hn.algolia.com/api/v1/search?query=agents&tags=story&hitsPerPage=10";
const hnReply = reply(200, { "content-type": "application/json" }, JSON.stringify({ hits: [{ title: "T", url: "https://t.example/post", points: 3, num_comments: 1, objectID: "77" }] }));
const SKILLS_OUT = "\nInstall with npx skills add <owner/repo@skill>\n\nacme/cro-skills@landing-pages 12.5K installs\n\u2514 https://skills.sh/acme/cro-skills/landing-pages\n\nother/repo@thing 300 installs\n\u2514 https://skills.sh/other/repo/thing\n";
const skillsExec = (runs) => async (file, args, opts) => {
  runs.push({ file, args, opts });
  if (file === "npm") {
    const prefix = args[args.indexOf("--prefix") + 1];
    await mkdir(join(prefix, "node_modules", "skills", "bin"), { recursive: true });
    await writeFile(join(prefix, "node_modules", "skills", "package.json"), JSON.stringify({ name: "skills", version: "1.9.1" }));
    await writeFile(join(prefix, "node_modules", "skills", "bin", "cli.mjs"), "//");
    return { stdout: "" };
  }
  return { stdout: SKILLS_OUT };
};

test("searchesOf: every research_search call is stored per child session as {source, query, refs}; a failed search and another session leave nothing", async () => {
  const f = await fixture({ routes: { [HN_URL]: hnReply, "https://hn.algolia.com/api/v1/search?query=boom&tags=story&hitsPerPage=10": reply(500, {}, "no") } });
  try {
    assert.deepEqual(await f.engine.searchesOf("ses_child"), []);
    assert.equal((await f.engine.search(call({ source: "hn", query: "agents" }))).ok, true);
    assert.equal((await f.engine.search(call({ source: "hn", query: "boom" }))).ok, false);
    const list = await f.engine.searchesOf("ses_child");
    assert.equal(list.length, 1);
    assert.equal(list[0].source, "hn");
    assert.equal(list[0].query, "agents");
    assert.deepEqual([...list[0].refs].sort(), ["https://news.ycombinator.com/item?id=77", "https://t.example/post"]);
    assert.deepEqual(await f.engine.searchesOf("ses_other"), []);
    assert.deepEqual(await f.engine.searchesOf("../ses_child"), []);
    // the search record sits beside the sources and never counts as one
    assert.equal(await f.engine.getSource("ses_child", "searches"), null);
  } finally {
    await f.cleanup();
  }
});

test("searchesOf: github results are recorded by repository name and address; searches accumulate in order", async () => {
  const repos = JSON.stringify({ items: [{ full_name: "acme/cro-skills", html_url: "https://github.com/acme/cro-skills", stargazers_count: 5, pushed_at: "2026-11-01T00:00:00Z", license: { spdx_id: "MIT" } }] });
  const f = await fixture({ routes: { "*": reply(200, { "content-type": "application/json" }, repos) } });
  try {
    await f.engine.search(call({ source: "github", query: "cro skill" }));
    await f.engine.search(call({ source: "github", query: "second" }));
    const list = await f.engine.searchesOf("ses_child");
    assert.deepEqual(list.map((s) => s.query), ["cro skill", "second"]);
    assert.ok(list[0].refs.includes("acme/cro-skills"));
    assert.ok(list[0].refs.includes("https://github.com/acme/cro-skills"));
  } finally {
    await f.cleanup();
  }
});

test("the skills source: the Architect gets owner/repo@skill, installs and the skills.sh address; the search is recorded with those refs (the ref, its repository and the address)", async () => {
  const runs = [];
  const f = await fixture({ engineExtra: { exec: skillsExec(runs) } });
  try {
    const r = await f.engine.search(call({ source: "skills", query: "landing pages" }));
    assert.equal(r.ok, true, r.error);
    assert.equal(r.source, "skills");
    assert.deepEqual(r.results[0], { ref: "acme/cro-skills@landing-pages", repo: "acme/cro-skills", skill: "landing-pages", installs: 12_500, url: "https://skills.sh/acme/cro-skills/landing-pages" });
    assert.deepEqual(runs.map((x) => x.file === "npm" ? "npm" : x.args.slice(1)), ["npm", ["find", "--", "landing pages"]]);
    const [rec] = await f.engine.searchesOf("ses_child");
    assert.equal(rec.source, "skills");
    for (const ref of ["acme/cro-skills@landing-pages", "acme/cro-skills", "https://skills.sh/acme/cro-skills/landing-pages", "other/repo@thing"]) assert.ok(rec.refs.includes(ref), ref);
  } finally {
    await f.cleanup();
  }
});

test("the skills source refuses a query that starts with a dash before anything is installed or run, and is listed among the Architect's sources", async () => {
  const runs = [];
  const f = await fixture({ engineExtra: { exec: skillsExec(runs) } });
  try {
    const r = await f.engine.search(call({ source: "skills", query: "-rf /" }));
    assert.equal(r.ok, false);
    assert.match(r.error, /dash/);
    assert.equal(runs.length, 0);
    assert.deepEqual(await f.engine.searchesOf("ses_child"), []);
    const unknown = await f.engine.search(call({ source: "nope", query: "q" }));
    assert.match(unknown.error, /Available: github, packages, stackoverflow, hn, reddit, arxiv, x, skills$/);
  } finally {
    await f.cleanup();
  }
});

test("a specialist that isn't the Architect has no skills source: unknown, nothing installed or run", async () => {
  const runs = [];
  const f = await fixture({ architect: false, engineExtra: { exec: skillsExec(runs) } });
  try {
    const r = await f.engine.search(call({ source: "skills", query: "landing pages" }));
    assert.equal(r.ok, false);
    assert.match(r.error, /Unknown source "skills"\. Available: github, packages, stackoverflow, hn, reddit, arxiv, x$/);
    assert.equal(runs.length, 0);
  } finally {
    await f.cleanup();
  }
});

// ---- the research layer: new built-in sources, throttles, the 10-minute answer cache, the outside-query check ----

const json = (v) => reply(200, { "content-type": "application/json" }, JSON.stringify(v));
const DEPS = "https://api.deps.dev/v3/systems";
const depsPackage = (system, name, versions) => ({ packageKey: { system, name }, versions: versions.map(([version, publishedAt, isDefault = false, isDeprecated = false]) => ({ versionKey: { system, name, version }, publishedAt, isDefault, isDeprecated, deprecatedReason: "" })) });

test("packages: `<system>:<name>` reads deps.dev — the default version, its licence, advisories, deprecation, links and the newest versions", async () => {
  const f = await fixture({
    routes: {
      [`${DEPS}/NPM/packages/react`]: json(depsPackage("NPM", "react", [["18.3.1", "2024-04-26T00:00:00Z"], ["19.1.0", "2025-03-28T19:59:42Z", true], ["19.2.0-rc.1", "2025-09-01T00:00:00Z"], ["17.0.2", "2021-03-22T00:00:00Z"]])),
      [`${DEPS}/NPM/packages/react/versions/19.1.0`]: json({ versionKey: { system: "NPM", name: "react", version: "19.1.0" }, publishedAt: "2025-03-28T19:59:42Z", isDefault: true, isDeprecated: false, licenses: ["MIT"], advisoryKeys: [{ id: "GHSA-aaaa" }], links: [{ label: "HOMEPAGE", url: "https://react.dev/" }, { label: "SOURCE_REPO", url: "git+https://github.com/facebook/react.git" }] }),
    },
  });
  try {
    const r = await f.engine.search(call({ source: "packages", query: "npm:react" }));
    assert.equal(r.ok, true, r.error);
    assert.equal(r.source, "packages");
    assert.deepEqual(r.results[0], {
      title: "npm:react",
      url: "https://deps.dev/npm/react",
      version: "19.1.0",
      date: "2025-03-28",
      license: "MIT",
      deprecated: false,
      advisories: 1,
      homepage: "https://react.dev/",
      repo: "https://github.com/facebook/react",
      recent: [{ version: "19.2.0-rc.1", date: "2025-09-01" }, { version: "19.1.0", date: "2025-03-28" }, { version: "18.3.1", date: "2024-04-26" }, { version: "17.0.2", date: "2021-03-22" }],
    });
    assert.deepEqual(f.calls.map((c) => c.url), [`${DEPS}/NPM/packages/react`, `${DEPS}/NPM/packages/react/versions/19.1.0`]);
    // the search is recorded with the package address (what a later claim "I saw it in a result" is checked against)
    assert.ok((await f.engine.searchesOf("ses_child"))[0].refs.includes("https://deps.dev/npm/react"));
  } finally {
    await f.cleanup();
  }
});

test("packages: every ecosystem maps to its deps.dev system and the name is one encoded path word; a missing package is a sentence", async () => {
  const f = await fixture({ routes: { "*": reply(404, {}, "{}") } });
  try {
    for (const [query, url] of [["pypi:requests", `${DEPS}/PYPI/packages/requests`], ["go:github.com/gin-gonic/gin", `${DEPS}/GO/packages/github.com%2Fgin-gonic%2Fgin`], ["maven:org.slf4j:slf4j-api", `${DEPS}/MAVEN/packages/org.slf4j%3Aslf4j-api`], ["cargo:serde", `${DEPS}/CARGO/packages/serde`], ["nuget:Newtonsoft.Json", `${DEPS}/NUGET/packages/Newtonsoft.Json`], ["rubygems:rails", `${DEPS}/RUBYGEMS/packages/rails`], ["NPM:@types/node", `${DEPS}/NPM/packages/%40types%2Fnode`]]) {
      f.calls.length = 0;
      const r = await f.engine.search(call({ source: "packages", query }));
      assert.equal(r.ok, false, query);
      assert.match(r.error, /No package .* found/, query);
      assert.equal(f.calls[0].url, url, query);
    }
  } finally {
    await f.cleanup();
  }
});

test("packages: a bare word searches the npm registry (keyless); results carry version, date, licence, weekly downloads", async () => {
  const f = await fixture({
    routes: {
      "https://registry.npmjs.org/-/v1/search?text=job%20queue&size=8": json({ objects: [{ downloads: { weekly: 1374531, monthly: 1 }, package: { name: "graphile-worker", version: "0.18.0", description: "Job queue for PostgreSQL", license: "MIT", date: "2026-09-08T16:06:26.479Z", links: { npm: "https://www.npmjs.com/package/graphile-worker" } } }] }),
    },
  });
  try {
    const r = await f.engine.search(call({ source: "packages", query: "job queue" }));
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.results[0], { title: "npm:graphile-worker", url: "https://www.npmjs.com/package/graphile-worker", version: "0.18.0", date: "2026-09-08", license: "MIT", weeklyDownloads: 1374531, description: "Job queue for PostgreSQL" });
  } finally {
    await f.cleanup();
  }
});

const SE = (q) => `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(q)}&site=stackoverflow&pagesize=8`;
const seItems = [{ title: "How do I use &quot;pg-boss&quot; &amp; retries?", link: "https://stackoverflow.com/questions/1/x", score: 12, answer_count: 3, is_answered: true, accepted_answer_id: 9, creation_date: 1_684_229_940, tags: ["postgresql", "queue"] }, { title: "Plain", link: "https://stackoverflow.com/questions/2/y", score: 0, answer_count: 0, is_answered: false, creation_date: 1_556_231_712, tags: [] }];

test("stackoverflow: the Stack Exchange API; entities decoded, score / answers / accepted / date / tags, links to the question", async () => {
  const f = await fixture({ routes: { [SE("pg queue")]: json({ items: seItems, quota_max: 300, quota_remaining: 298 }) } });
  try {
    const r = await f.engine.search(call({ source: "stackoverflow", query: "pg queue" }));
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.results[0], { title: 'How do I use "pg-boss" & retries?', url: "https://stackoverflow.com/questions/1/x", score: 12, answers: 3, accepted: true, date: "2023-05-16", tags: ["postgresql", "queue"] });
    assert.equal(r.results[1].accepted, false);
    assert.ok((await f.engine.searchesOf("ses_child"))[0].refs.includes("https://stackoverflow.com/questions/1/x"));
  } finally {
    await f.cleanup();
  }
});

test("stackoverflow: stops for the day at quota 0, honours `backoff`, and says what to do instead", async () => {
  let t = Date.UTC(2026, 10, 28, 10, 0, 0);
  const replies = [json({ items: seItems, quota_remaining: 5, backoff: 30 }), json({ items: seItems, quota_remaining: 0 }), json({ items: seItems, quota_remaining: 300 })];
  const f = await fixture({ now: () => t, routes: { "*": () => replies.shift() } });
  try {
    assert.equal((await f.engine.search(call({ source: "stackoverflow", query: "one" }))).ok, true);
    const paused = await f.engine.search(call({ source: "stackoverflow", query: "two" }));
    assert.equal(paused.ok, false);
    assert.match(paused.error, /Stack Overflow asked for a pause; try again in 30 seconds/);
    assert.equal(f.calls.length, 1, "no request during the backoff");
    t += 31_000;
    assert.equal((await f.engine.search(call({ source: "stackoverflow", query: "two" }))).ok, true);
    const spent = await f.engine.search(call({ source: "stackoverflow", query: "three" }));
    assert.equal(spent.error, "Stack Overflow's free daily limit was reached; use websearch with site:stackoverflow.com");
    assert.equal(f.calls.length, 2);
    t = Date.UTC(2026, 10, 29, 0, 0, 1); // the next UTC day
    assert.equal((await f.engine.search(call({ source: "stackoverflow", query: "three" }))).ok, true);
  } finally {
    await f.cleanup();
  }
  const g = await fixture({ routes: { "*": reply(400, { "content-type": "application/json" }, JSON.stringify({ error_id: 502, error_name: "throttle_violation", error_message: "too many requests from this IP" })) } });
  try {
    assert.match((await g.engine.search(call({ source: "stackoverflow", query: "x" }))).error, /Stack Overflow asked for a pause/);
  } finally {
    await g.cleanup();
  }
});

test("throttles: arXiv is one request per 3 s and GitHub ten per minute, box-wide (p-throttle); a queue that is already long is a refusal, not a wait", async () => {
  const made = [];
  const makeThrottle = (opts) => {
    const wrapper = (fn) => {
      const t = (...args) => {
        t.runs += 1;
        return fn(...args);
      };
      t.runs = 0;
      t.queueSize = 0;
      made.push({ opts, t });
      return t;
    };
    return wrapper;
  };
  const f = await fixture({
    engineExtra: { makeThrottle },
    routes: {
      "https://export.arxiv.org/api/query?search_query=all:q&start=0&max_results=8&sortBy=relevance": reply(200, { "content-type": "application/atom+xml" }, `<feed xmlns="http://www.w3.org/2005/Atom"></feed>`),
      "*": json({ items: [] }),
    },
  });
  try {
    assert.equal((await f.engine.search(call({ source: "arxiv", query: "q" }))).ok, true);
    assert.equal((await f.engine.search(call({ source: "github", query: "q" }))).ok, true);
    const byOpts = Object.fromEntries(made.map((m) => [`${m.opts.limit}/${m.opts.interval}`, m]));
    assert.ok(byOpts["1/3000"], "arxiv: 1 request / 3 s");
    assert.ok(byOpts["10/60000"], "github: 10 / min");
    assert.equal(byOpts["1/3000"].opts.strict, true);
    assert.ok(byOpts["1/3000"].t.runs >= 1 && byOpts["10/60000"].t.runs >= 1, "the requests went through the throttles");
    byOpts["10/60000"].t.queueSize = 5;
    const refused = await f.engine.search(call({ source: "github", query: "other" }));
    assert.equal(refused.ok, false);
    assert.match(refused.error, /GitHub's search limit was reached/);
  } finally {
    await f.cleanup();
  }
});

test("an identical query to the same built-in source within 10 minutes returns the stored answer (one request); after 10 minutes it asks again", async () => {
  let t = 1_800_000_000_000;
  const f = await fixture({ now: () => t, routes: { [HN_URL]: hnReply } });
  try {
    const a = await f.engine.search(call({ source: "hn", query: "agents" }));
    const b = await f.engine.search(call({ sessionID: "ses_other", source: "hn", query: "agents" }));
    assert.deepEqual(b.results, a.results);
    assert.equal(f.calls.length, 1);
    assert.equal((await f.engine.searchesOf("ses_other")).length, 1, "the second session still records its own search");
    t += 10 * 60_000 + 1;
    await f.engine.search(call({ source: "hn", query: "agents" }));
    assert.equal(f.calls.length, 2);
  } finally {
    await f.cleanup();
  }
});

// ---- AC-2.8: the outside-query check runs before any request ----

const SECRET = "sk-live-9f2c41ab77d0e3158c";
const OUTSIDE = "This query would send private material to an outside source; rephrase it in general terms, or use a private source";

test("AC-2.8: research_search to an outside source refuses a secret in the query BEFORE any request; a private source accepts the same query", async () => {
  const seen = [];
  const f = await fixture({
    secrets: [{ key: "K", scope: "shared", value: SECRET }],
    extras: [{ id: "bookface", name: "BF", description: "d", command: ["yc", "{query}"], private: true }, { id: "pubsrc", name: "Pub", description: "d", url: "https://search.example.com/api?q={query}", private: false }],
    exec: async (file, args) => (seen.push(args), { stdout: "private answer" }),
    routes: { "*": json({ hits: [] }) },
  });
  try {
    await withProgram(f, "yc");
    for (const source of ["hn", "arxiv", "github", "packages", "stackoverflow", "reddit", "x", "pubsrc"]) {
      const r = await f.engine.search(call({ source, query: `queue library for ${SECRET}` }));
      assert.deepEqual(r, { ok: false, error: OUTSIDE }, source);
    }
    assert.equal(f.calls.length, 0, "nothing was requested");
    const priv = await f.engine.search(call({ source: "bookface", query: `queue library for ${SECRET}` }));
    assert.equal(priv.ok, true, priv.error);
    assert.equal(seen.length, 1);
    assert.deepEqual(await f.engine.searchesOf("ses_child").then((l) => l.map((x) => x.source)), ["bookface"], "a refused search is not recorded");
  } finally {
    await f.cleanup();
  }
});

test("AC-2.8: a url source's whole built address is checked (a secret in its path is refused), and so is research_fetch's whole URL", async () => {
  const f = await fixture({
    secrets: [{ key: "K", scope: "shared", value: SECRET }],
    extras: [{ id: "pubsrc", name: "Pub", description: "d", url: "https://search.example.com/api?q={query}", private: false }],
    routes: { "*": reply(200, { "content-type": "text/plain" }, "ok") },
  });
  try {
    assert.deepEqual(await f.engine.fetch(call({ url: `https://example.com/docs/${SECRET}/plans` })), { ok: false, error: OUTSIDE });
    assert.deepEqual(await f.engine.fetch(call({ url: "https://example.com/u/jane.doe%40halvorsen.no/" })), { ok: false, error: OUTSIDE });
    assert.deepEqual(await f.engine.fetch(call({ url: "https://example.com/search/billing.int.kestrel.lan/plans" })), { ok: false, error: OUTSIDE });
    assert.equal(f.calls.length, 0);
    assert.equal((await f.engine.fetch(call({ url: "https://example.com/docs/pricing" }))).ok, true);
    assert.equal(f.calls.length, 1);
  } finally {
    await f.cleanup();
  }
});

test("AC-2.8: the check also sees the task's folder and 6+ words copied from a private answer stored in this session", async () => {
  const f = await fixture({
    extras: [{ id: "bookface", name: "BF", description: "d", command: ["yc", "{query}"], private: true }],
    exec: async () => ({ stdout: "Halvorsen Freight signed a forty million dollar deal for the Kestrel queue rewrite" }),
    engineExtra: { folderOf: async (sid) => (sid === "ses_child" ? "/work/acme-secret-project" : null) },
    routes: { "*": json({ hits: [] }) },
  });
  try {
    await withProgram(f, "yc");
    assert.equal((await f.engine.search(call({ source: "bookface", query: "what did we sign" }))).ok, true);
    assert.deepEqual(await f.engine.search(call({ source: "hn", query: "signed a forty million dollar deal for the Kestrel" })), { ok: false, error: OUTSIDE });
    assert.deepEqual(await f.engine.search(call({ source: "hn", query: "is /work/acme-secret-project a monorepo" })), { ok: false, error: OUTSIDE });
    assert.equal((await f.engine.search(call({ sessionID: "ses_other", source: "hn", query: "signed a forty million dollar deal for the Kestrel" }))).ok, true, "another session's private answers don't count");
    assert.equal(f.calls.length, 1);
  } finally {
    await f.cleanup();
  }
});

test("AC-2.9b: when the check can't be made the call is refused and nothing is sent", async () => {
  const f = await fixture({ secrets: "throw", routes: { "*": json({ hits: [] }) } });
  try {
    const s = await f.engine.search(call({ source: "hn", query: "queue library" }));
    assert.deepEqual(s, { ok: false, error: "Couldn't check this query for private material; try again" });
    assert.deepEqual(await f.engine.fetch(call({ url: "https://example.com/" })), { ok: false, error: "Couldn't check this query for private material; try again" });
    assert.equal(f.calls.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("the engine's own check is what the HTTP route calls (outsideCheck): clean ok, secret refused, never throws", async () => {
  const f = await fixture({ secrets: [{ key: "K", scope: "shared", value: SECRET }] });
  try {
    assert.deepEqual(await f.engine.outsideCheck({ sessionID: "ses_child", tool: "websearch", input: { query: "postgres queue library" } }), { ok: true });
    assert.deepEqual(await f.engine.outsideCheck({ sessionID: "ses_child", tool: "webfetch", input: { url: `https://x.example.com/${SECRET}` } }), { ok: false, error: OUTSIDE });
    assert.equal((await f.engine.outsideCheck(null)).ok, false);
  } finally {
    await f.cleanup();
  }
});

// ---- Test (AC-1.10): runs a source without storing anything ----

test("testSource runs a source and reports a count and the first result; nothing is stored, recorded or cached", async () => {
  const f = await fixture({ routes: { [HN_URL]: hnReply } });
  try {
    const r = await f.engine.testSource({ id: "hn", builtin: true, kind: "builtin" }, "agents");
    assert.equal(r.count, 1);
    assert.deepEqual(r.first, { title: "T", url: "https://t.example/post" });
    await assert.rejects(readdir(f.root), /ENOENT/, "no session folder, no stored source, no search record");
    await f.engine.testSource({ id: "hn", builtin: true, kind: "builtin" }, "agents");
    assert.equal(f.calls.length, 2, "a test is never served from the answer cache");
  } finally {
    await f.cleanup();
  }
  const exec = async () => ({ stdout: "a long private answer ".repeat(20) });
  const g = await fixture({ exec });
  try {
    await withProgram(g, "yc");
    const r = await g.engine.testSource({ id: "bf", builtin: false, kind: "command", name: "BF", private: true, command: ["yc", "{query}"] }, "test");
    assert.equal(r.count, 1);
    assert.match(r.text, /a long private answer/);
    assert.equal(r.first.title.startsWith("a long private answer"), true);
    await assert.rejects(readdir(g.root), /ENOENT/);
  } finally {
    await g.cleanup();
  }
});
