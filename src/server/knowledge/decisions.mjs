// decisions.mjs — the curator model's decisions and the bars they must pass (spec §6.3, §9, §11.5).
//
// The model proposes; THIS module decides. Every bar below is checked in code, never left to the model's
// judgement:
//   • user-authored evidence — each rule/preference decision cites user messages with a quoted span; the
//     message must have a recorded `user` origin (`isUserAuthoredRef`) and contain the quote (substring);
//   • grounding — ≥ 3 corrections, or the same correction in ≥ 2 sessions;
//   • support — the rule/preference TEXT must be backed by the words quoted (support.mjs: a ≥ 20 character quote
//     sharing ≥ 2 content words with it); with a detector cluster, the text must also overlap the cluster's lesson;
//   • executed commands — a command line in a fenced block that is new on a page must equal (whitespace
//     normalized) a shell tool call actually run in a cited session, or one whole `&&`/`;`/newline segment of it;
//   • user-written lines — a decision never removes or changes a line the user wrote (git blame: any
//     author but the curator); the conflict is shown in Recent changes, not applied;
//   • tombstones — a decision matching an undone one is dropped;
//   • briefing echo — a note restating its own session's briefing is not corroboration;
//   • budgets — briefing section ≤ 60 lines, project rules ≤ 120, global block ≤ 200.
//
// Validation runs in two stages so no model or message read happens under the store lock:
//   `validate(raw, vctx)`   — shape, evidence, grounding, commands, tombstones (reads only);
//   in-lock helpers (`buildPageEdit`, `removedUserLines`, `checkBudgets`, `createBlame`) — called by the
//   curator while it holds the lock, against the file as it is at that moment.

import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { newDecisionId } from "./ids.mjs";
import { getSection, isSafePagePath, pageArea, parsePage, renderPage, spliceSection, updateFrontMatter } from "./pages.mjs";
import { isValidRef } from "./queue.mjs";
import { feedsShared } from "./sharing.mjs";
import { CURATOR } from "./store.mjs";
import { kindOf, targetKey } from "./tombstones.mjs";
import { claimSupported, contentWords } from "./support.mjs";
import { GLOBAL_BUDGET_LINES, RULES_BUDGET_LINES, cleanBulletText } from "./rules.mjs";

export const DECISION_TYPES = Object.freeze(["page.edit", "rule.add", "rule.change", "rule.remove", "preference.set", "skill.propose", "drop"]);
export const DECISION_AREAS = Object.freeze(["project", "user", "commons", "repo-block", "global-block"]);
export const BRIEFING_SECTION_MAX_LINES = 60;
export const MAX_EVIDENCE = 12;
export const MIN_QUOTE_CHARS = 8;
export const GROUNDING = Object.freeze({ corrections: 3, sessions: 2 });
export const PROTECTED_PAGES = Object.freeze(["user/preferences.md", "user/global-block.md"]);
// pages only their own decision types change: rules.md (rule.*), preferences and how-the-user-works-here.md (preference.set)
export const PROTECTED_PAGE_RE = /^projects\/[^/]+\/(?:rules|how-the-user-works-here)\.md$/;
export const LESSON_OVERLAP = 0.4;

const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
export const normText = norm;
const wsnorm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v, max = 400) => (typeof v === "string" ? v.slice(0, max) : undefined);

// ---- parsing ----------------------------------------------------------------------

/** Pull `{decisions:[…]}` (or a bare array) out of a model answer; tolerates a ```json fence and prose around it. */
export function parseDecisionOutput(text) {
  const src = String(text ?? "");
  const candidates = [];
  const fence = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(src);
  if (fence) candidates.push(fence[1]);
  candidates.push(src);
  for (const c of candidates) {
    for (const [open, close] of [["{", "}"], ["[", "]"]]) {
      const s = c.indexOf(open);
      const e = c.lastIndexOf(close);
      if (s < 0 || e <= s) continue;
      try {
        const v = JSON.parse(c.slice(s, e + 1));
        const list = Array.isArray(v) ? v : Array.isArray(v?.decisions) ? v.decisions : null;
        if (list) return { ok: true, decisions: list };
      } catch {
        /* try the next shape */
      }
    }
  }
  return { ok: false, error: "The model's answer wasn't a JSON list of decisions." };
}

/** A raw model decision → the pinned shape (§11.5), or null. Unknown fields (incl. `internal`) are dropped; the id is always ours. */
export function normalizeDecision(raw, { now = Date.now, newId = newDecisionId } = {}) {
  if (!isObj(raw) || !DECISION_TYPES.includes(raw.type)) return null;
  const t = isObj(raw.target) ? raw.target : {};
  const target = {};
  for (const k of ["area", "slug", "path", "section"]) if (typeof t[k] === "string" && t[k].trim()) target[k] = t[k].trim().slice(0, 200);
  const evidence = (Array.isArray(raw.evidence) ? raw.evidence : []).filter(isObj).map((e) => ({ ref: str(e.ref, 600) ?? "", ...(typeof e.quote === "string" && e.quote ? { quote: e.quote.slice(0, 600) } : {}) }));
  return {
    id: newId(now()),
    type: raw.type,
    target,
    ...(typeof raw.baseCommit === "string" && raw.baseCommit ? { baseCommit: raw.baseCommit.slice(0, 64) } : {}),
    ...(typeof raw.content === "string" ? { content: raw.content } : {}),
    ...(typeof raw.replaces === "string" ? { replaces: raw.replaces.slice(0, 400) } : {}),
    reason: str(raw.reason, 300) ?? "",
    evidence,
    ...(typeof raw.clusterId === "string" && raw.clusterId ? { clusterId: raw.clusterId.slice(0, 120) } : {}),
  };
}

// ---- pure helpers -------------------------------------------------------------------

const SHELL_LANGS = new Set(["sh", "bash", "shell", "zsh", "fish", "console", "shellsession", "sh-session", "shell-session"]);

/**
 * Command lines in the fenced blocks of `markdown`. Shell-language blocks count line by line (backslash
 * continuations joined; `$ ` / `> ` prompts stripped; comments skipped; console-style blocks only their
 * prompt lines). An un-labelled block counts only when it starts with a `$ ` prompt.
 */
export function extractCommands(markdown) {
  const out = [];
  const lines = String(markdown ?? "").split("\n");
  let inBlock = null;
  let buf = [];
  const flush = () => {
    const lang = inBlock.lang;
    const first = buf.find((l) => l.trim() !== "") ?? "";
    const prompted = /^\s*\$\s/.test(first);
    if (!(SHELL_LANGS.has(lang) || (lang === "" && prompted))) return;
    const promptOnly = lang === "console" || lang === "shellsession" || lang === "sh-session" || lang === "shell-session";
    let pending = "";
    for (const raw of buf) {
      let l = raw.replace(/\r$/, "");
      if (!pending) {
        if (promptOnly && !/^\s*\$\s/.test(l)) continue;
        l = l.replace(/^\s*[$>]\s+/, "");
      }
      l = l.trim();
      if (!l || (!pending && l.startsWith("#"))) continue;
      if (l.endsWith("\\")) {
        pending += `${l.slice(0, -1).trim()} `;
        continue;
      }
      out.push(wsnorm(pending + l));
      pending = "";
    }
    if (pending.trim()) out.push(wsnorm(pending));
  };
  for (const line of lines) {
    const m = /^\s*(```+|~~~+)\s*([A-Za-z0-9_+-]*)/.exec(line);
    if (!inBlock) {
      if (m) {
        inBlock = { fence: m[1][0], lang: m[2].toLowerCase() };
        buf = [];
      }
    } else if (m && m[1][0] === inBlock.fence && !m[2]) {
      flush();
      inBlock = null;
    } else buf.push(line);
  }
  return out;
}

/** Split a shell command on `&&`, `||`, `;` and newlines that are OUTSIDE quotes. */
export function splitShellSegments(command) {
  const out = [];
  let cur = "";
  let quote = null;
  const src = String(command ?? "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      cur += ch;
      if (ch === "\\" && quote === '"' && i + 1 < src.length) cur += src[++i];
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\\" && i + 1 < src.length) {
      cur += ch + src[++i];
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === ";" || ch === "\n" || (ch === "&" && src[i + 1] === "&") || (ch === "|" && src[i + 1] === "|")) {
      if (ch === "&" || ch === "|") i++;
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map(wsnorm).filter(Boolean);
}

/**
 * Was `line` run? It must equal a whole executed command or one whole segment of one — never a substring
 * (`echo "git push"` does not validate `git push`).
 */
export function commandExecuted(line, executed) {
  const needle = wsnorm(line);
  if (!needle) return true;
  for (const c of executed ?? []) {
    if (wsnorm(c) === needle) return true;
    if (splitShellSegments(c).includes(needle)) return true;
  }
  return false;
}

/** Command lines that are in `content` but not already on the page (`current`). */
export function newCommandLines(current, content) {
  const had = new Set(extractCommands(current ?? ""));
  return extractCommands(content).filter((c) => !had.has(c));
}

/** Is `quote` inside `text` (exact, or equal after whitespace normalization)? */
export function containsQuote(text, quote) {
  const q = String(quote ?? "");
  if (!q.trim()) return false;
  const t = String(text ?? "");
  return t.includes(q) || wsnorm(t).includes(wsnorm(q));
}

const shingles = (words, n) => {
  const out = new Set();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(" "));
  return out;
};

/** Does a note merely restate text that was in its own session's briefing (§6.3)? */
export function isBriefingEcho(noteText, briefingText) {
  const note = norm(noteText).replace(/[^\p{L}\p{N}\s]/gu, "");
  const brief = norm(briefingText).replace(/[^\p{L}\p{N}\s]/gu, "");
  if (!note || !brief) return false;
  if (brief.includes(note)) return true;
  const nw = note.split(" ");
  if (nw.length < 4) return false;
  const a = shingles(nw, 4);
  const b = shingles(brief.split(" "), 4);
  if (a.size === 0) return false;
  let hit = 0;
  for (const s of a) if (b.has(s)) hit++;
  return hit / a.size >= 0.8;
}

const lineSet = (s) => String(s ?? "").split("\n").map(norm).filter((l) => l && !/^(```+|~~~+|---)$/.test(l));

/** Lines of `before` that the user wrote and `after` no longer contains. */
export function removedUserLines({ before, after, userSet }) {
  if (!userSet || userSet.size === 0) return [];
  const now = new Set(lineSet(after));
  const removed = [];
  for (const l of lineSet(before)) if (userSet.has(l) && !now.has(l)) removed.push(l);
  return removed;
}

export const lineCount = (s) => String(s ?? "").split("\n").filter((l) => l.trim() !== "").length;

/** `{ok, reason?}` — the line budgets (§6.3, §4.1) for a page about to be written. */
export function checkBudgets(rel, source) {
  if (/^projects\/[^/]+\/overview\.md$/.test(rel)) {
    const n = lineCount(getSection(source, "Briefing") ?? "");
    if (n > BRIEFING_SECTION_MAX_LINES) return { ok: false, reason: `The Briefing section would be ${n} lines (the limit is ${BRIEFING_SECTION_MAX_LINES}).` };
  }
  if (/^projects\/[^/]+\/rules\.md$/.test(rel)) {
    const n = (String(parsePage(source).body).match(/^[-*]\s+/gm) ?? []).length;
    if (n > RULES_BUDGET_LINES) return { ok: false, reason: `The rules would be ${n} lines (the limit is ${RULES_BUDGET_LINES}).` };
  }
  if (rel === "user/preferences.md") {
    const n = (String(parsePage(source).body).match(/^[-*]\s+/gm) ?? []).length;
    if (n > GLOBAL_BUDGET_LINES - 4) return { ok: false, reason: `The preferences would be ${n} lines (the global block limit is ${GLOBAL_BUDGET_LINES}).` };
  }
  return { ok: true };
}

const titleCase = (s) => s.replace(/[-_]+/g, " ").replace(/\b\p{L}/gu, (c) => c.toUpperCase());
export const defaultTitle = (rel) => titleCase(String(rel).split("/").pop().replace(/\.md$/, ""));

const mergeSources = (a, b) => {
  const out = [];
  for (const s of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) if (typeof s === "string" && !out.includes(s)) out.push(s);
  return out.slice(-24);
};

/**
 * The page text after a `page.edit`, splicing by mdast positions (section) or replacing the body, then
 * stamping `verified` and merging `sources`. Returns `{source, scopeBefore, scopeAfter}`.
 */
export function buildPageEdit(current, d, { today, sources = [] } = {}) {
  const rel = d.target.path;
  const title = defaultTitle(rel);
  const base = current ?? renderPage({ frontMatter: { title }, body: `# ${title}\n` });
  let next;
  let scopeBefore;
  let scopeAfter;
  if (d.target.section) {
    scopeBefore = getSection(base, d.target.section) ?? "";
    next = spliceSection(base, d.target.section, d.content);
    scopeAfter = getSection(next, d.target.section) ?? "";
  } else {
    const p = parsePage(base);
    const body = parsePage(d.content).body;
    scopeBefore = p.body;
    scopeAfter = body.endsWith("\n") ? body : `${body}\n`;
    // unparsable front matter stays byte for byte where it is
    next = p.invalid ? `${base.slice(0, p.bodyOffset)}${scopeAfter}` : renderPage({ frontMatter: p.frontMatter, body: scopeAfter });
  }
  const fm = parsePage(next).frontMatter ?? {};
  const out = updateFrontMatter(next, { title: fm.title ?? title, verified: today, sources: mergeSources(fm.sources, sources) });
  return { source: out, scopeBefore, scopeAfter };
}

// ---- per-run message cache -------------------------------------------------------------

/**
 * A per-run, per-session cache over `readMessages` with a bound on reads. The reader returns the window of
 * messages around the first id it is asked for (never several ids at once), so one read also fills the cache
 * with that session's neighbours: refs to the same stretch of a session cost one read. `get(sessionID,
 * messageID)` → the message, `null` when the session answered and it isn't there, `undefined` when it can't
 * be told (read failed, or the run's read budget is spent). `prefetch(refs)` just warms the cache.
 */
export function createMessageCache({ readMessages, maxReads = 200, window = 25 } = {}) {
  const bySession = new Map();
  let reads = 0;
  const slot = (sid) => {
    let m = bySession.get(sid);
    if (!m) bySession.set(sid, (m = new Map()));
    return m;
  };
  async function load(sid, id) {
    const m = slot(sid);
    if (!readMessages || reads >= maxReads) {
      m.set(id, undefined);
      return;
    }
    reads++;
    let msgs = null;
    try {
      msgs = await readMessages({ sessionID: sid, messageIDs: [id], radius: window });
    } catch {
      msgs = null;
    }
    if (!Array.isArray(msgs)) {
      m.set(id, undefined);
      return;
    }
    for (const x of msgs) if (x && typeof x.id === "string") m.set(x.id, { id: x.id, role: x.role, text: x.text, at: x.at });
    if (!m.has(id) || m.get(id) === undefined) m.set(id, null);
  }
  return {
    get reads() {
      return reads;
    },
    async prefetch(refs) {
      for (const r of refs ?? []) {
        const x = /^(?:msg|part):([^/]+)\/(.+)$/.exec(r ?? "");
        if (x) await this.get(x[1], x[2]);
      }
    },
    async get(sessionID, messageID) {
      const m = slot(sessionID);
      if (!m.has(messageID)) await load(sessionID, messageID);
      return m.get(messageID);
    },
  };
}

// ---- git blame: which lines did the user write? ---------------------------------------

/**
 * `userLines(rel)` → Set of normalized lines whose last author is NOT the curator (hand edits, adopted
 * edits); an empty set for a file that doesn't exist; `null` when it can't be told (callers fail closed).
 * Uncommitted lines count as the user's.
 */
export function createBlame({ git, dir, curatorEmail = CURATOR.email } = {}) {
  return {
    async userLines(rel) {
      let out;
      try {
        out = await git.run(["blame", "--line-porcelain", "-w", "--", rel], { cwd: dir });
      } catch (e) {
        const msg = String(e?.stderr ?? e?.message ?? e);
        if (!/no such path|does not exist|cannot stat|no such file/i.test(msg)) return null;
        // not in HEAD: absent (nothing to protect) or not committed yet (uncommitted lines are the user's)
        try {
          await access(join(dir, rel));
        } catch {
          return new Set();
        }
        try {
          return new Set(
            String(await readFile(join(dir, rel), "utf8"))
              .split("\n")
              .map(norm)
              .filter((l) => l && !/^(```+|~~~+|---)$/.test(l)),
          );
        } catch {
          return null;
        }
      }
      const set = new Set();
      let mail = "";
      for (const line of String(out).split("\n")) {
        if (line.startsWith("author-mail ")) mail = line.slice(12).replace(/[<>]/g, "").trim();
        else if (line.startsWith("\t")) {
          if (mail !== curatorEmail) {
            const n = norm(line.slice(1));
            if (n && !/^(```+|~~~+|---)$/.test(n)) set.add(n);
          }
        }
      }
      return set;
    },
  };
}

// ---- the validator ------------------------------------------------------------------

const MSG_RE = /^(?:msg|part):([^/]+)\/(.+)$/;
const ok = (decision, extra = {}) => ({ ok: true, decision, ...extra });
const no = (kind, reason, extra = {}) => ({ ok: false, kind, reason, ...extra });

/**
 * deps: store (read), tombstones, isUserAuthoredRef(ref, {sessionID}), readMessages({sessionID, messageIDs, radius}),
 * readShellCommands(sessionID) → string[]|null, now, newId.
 */
export function createDecisionValidator({ store, tombstones, isUserAuthoredRef, readMessages, readShellCommands, now = Date.now, newId = newDecisionId } = {}) {
  const parse = (text) => parseDecisionOutput(text);
  const normalize = (raw) => normalizeDecision(raw, { now, newId });

  /** Verify user-authored message evidence with quotes. Returns `{verified:[{ref, sessionID, messageID, quote}], failed:[{ref, why}]}`. */
  async function verifyEvidence(evidence, { requireQuote = true, messages = null } = {}) {
    const verified = [];
    const failed = [];
    const seen = new Set();
    const cache = new Map();
    for (const e of evidence) {
      const m = /^msg:([^/]+)\/(.+)$/.exec(e.ref ?? "");
      if (!m) {
        failed.push({ ref: e.ref, why: "not a message reference" });
        continue;
      }
      const [, sessionID, messageID] = m;
      const quote = String(e.quote ?? "");
      if (requireQuote && wsnorm(quote).length < MIN_QUOTE_CHARS) {
        failed.push({ ref: e.ref, why: "no usable quote" });
        continue;
      }
      let userAuthored = false;
      try {
        userAuthored = (await Promise.resolve(isUserAuthoredRef?.(e.ref, { sessionID }))) === true;
      } catch {
        userAuthored = false;
      }
      if (!userAuthored) {
        failed.push({ ref: e.ref, why: "not a message you wrote" });
        continue;
      }
      const ck = `${sessionID}/${messageID}`;
      if (!cache.has(ck)) {
        if (messages) cache.set(ck, (await messages.get(sessionID, messageID)) ?? null);
        else {
          let msgs = null;
          try {
            msgs = await readMessages?.({ sessionID, messageIDs: [messageID], radius: 0 });
          } catch {
            msgs = null;
          }
          cache.set(ck, Array.isArray(msgs) ? (msgs.find((x) => x.id === messageID) ?? null) : null);
        }
      }
      const msg = cache.get(ck);
      if (!msg || msg.role !== "user") {
        failed.push({ ref: e.ref, why: "message not found" });
        continue;
      }
      if (requireQuote && !containsQuote(msg.text, quote)) {
        failed.push({ ref: e.ref, why: "the quoted words aren't in that message" });
        continue;
      }
      if (seen.has(ck)) continue;
      seen.add(ck);
      verified.push({ ref: e.ref, sessionID, messageID, quote });
    }
    return { verified, failed };
  }

  /** `{ok, corrections, sessions}` against §6.3's bar. */
  function grounding(verified, cluster) {
    const sessions = Math.max(new Set(verified.map((v) => v.sessionID)).size, cluster?.sessions ?? 0);
    const corrections = Math.max(verified.length, cluster?.count ?? 0);
    return { ok: verified.length > 0 && (corrections >= GROUNDING.corrections || sessions >= GROUNDING.sessions), corrections, sessions };
  }

  /**
   * Stage 1 (no lock). `vctx`: {slug, sharing, allowedRefs: Set|null, clusters: Map(clusterId → cluster), refSharing(ref) → boolean}.
   * `vctx.messages` (optional): a per-run `createMessageCache` shared by every check of the run.
   * `opts.internal`: a decision built in code (rule tracking) — `d` is already normalized and trusted.
   * Returns `{ok:true, decision, drop?}` or `{ok:false, kind:"skipped"|"dropped", reason}`.
   */
  async function validate(raw, vctx, { internal = false, prenormalized = false } = {}) {
    const d = internal || prenormalized ? raw : normalize(raw);
    if (!d) return no("dropped", "The model proposed something that isn't a recognised decision.");
    if (d.type === "drop") return ok(d, { drop: true });
    if (!d.reason.trim()) return no("dropped", "The model gave no reason for the change.");
    if (d.type === "skill.propose") return no("skipped", "Skill drafts come from the weekly skill pass; kept the procedure as notes.");

    const area = d.target.area ?? (d.type === "page.edit" ? undefined : "project");
    if (area !== undefined && !DECISION_AREAS.includes(area)) return no("dropped", `Unknown target area "${area}".`);
    const slug = vctx.slug ?? null;
    const sharing = vctx.sharing ?? "private";

    // refs
    if (!internal) {
      if (d.evidence.length > MAX_EVIDENCE) d.evidence = d.evidence.slice(0, MAX_EVIDENCE);
      for (const e of d.evidence) if (!isValidRef(e.ref)) return no("dropped", `It cited a reference that isn't valid ("${String(e.ref).slice(0, 40)}").`);
      if (vctx.allowedRefs) for (const e of d.evidence) if (!vctx.allowedRefs.has(e.ref)) return no("dropped", "It cited a reference that wasn't in the notes it was given.");
    }

    let cluster = null;
    if (d.clusterId) {
      cluster = vctx.clusters?.get(d.clusterId) ?? null;
      if (!cluster) delete d.clusterId;
      else if (!internal && (d.type.startsWith("rule.") || d.type === "preference.set")) d.evidence = cluster.evidence.map((e) => ({ ref: e.ref, quote: e.quote }));
    }

    const kind = kindOf(d.type);

    if (d.type === "page.edit") {
      const rel = d.target.path;
      if (!isSafePagePath(rel)) return no("dropped", "The page path isn't valid.");
      const pa = pageArea(rel);
      if (!pa || (area && area !== pa.area)) return no("dropped", "The page path doesn't match its area.");
      if (pa.area === "project" && pa.slug !== slug) return no("dropped", "It tried to edit another project's page.");
      if (PROTECTED_PAGES.includes(rel) || PROTECTED_PAGE_RE.test(rel)) return no("skipped", "Rules and preferences are changed through their own decisions, not by editing the page.");
      if ((pa.area === "user" || pa.area === "commons") && !feedsShared(sharing)) return no("skipped", "This project doesn't share its knowledge, so it can't feed shared pages.");
      if (typeof d.content !== "string" || d.content.trim() === "") return no("dropped", "The page change had no content.");
      d.target = { area: pa.area, ...(pa.slug ? { slug: pa.slug } : {}), path: rel, ...(d.target.section ? { section: d.target.section } : {}) };
      if (pa.area === "commons" && vctx.refSharing) d.evidence = d.evidence.filter((e) => vctx.refSharing(e.ref) !== false);
      if (d.evidence.length === 0) return no("skipped", "A page claim needs at least one reference; it had none that could be kept.");
      // executed-command check
      const current = await store.read(rel);
      const cmds = newCommandLines(current, d.content);
      if (cmds.length) {
        const sessions = [...new Set(d.evidence.map((e) => MSG_RE.exec(e.ref)?.[1]).filter(Boolean))];
        const executed = [];
        for (const s of sessions) {
          try {
            executed.push(...((await readShellCommands?.(s)) ?? []));
          } catch {
            /* an unreadable session proves nothing */
          }
        }
        // commands already on a cited wiki page were checked when they were written (or are the user's own)
        for (const e of d.evidence) {
          if (!e.ref.startsWith("page:")) continue;
          const cited = await store.read(e.ref.slice(5));
          if (cited) executed.push(...extractCommands(cited));
        }
        const bad = cmds.find((c) => !commandExecuted(c, executed));
        if (bad) return no("skipped", `The command "${bad.slice(0, 80)}" wasn't run in any of the cited sessions, so it wasn't written down.`);
      }
      const claim = d.content;
      const tomb = await tombstones.match({ kind, target: d.target, claim });
      if (tomb) return no("dropped", "You undid this before, so it won't be proposed again.", { tombstoned: true });
      return ok(d, { claim, kind, tombstoneTarget: d.target, sessions: sessionsOf(d.evidence) });
    }

    // rules and preferences
    const isRule = d.type.startsWith("rule.");
    const text = cleanBulletText(d.content);
    if (!text) return no("dropped", `The ${isRule ? "rule" : "preference"} text was empty or too long.`);
    d.content = text;
    if (d.type === "rule.change") {
      const old = cleanBulletText(d.replaces);
      if (!old) return no("dropped", "A rule change must say which rule it replaces.");
      d.replaces = old;
    }
    if (isRule && !slug) return no("dropped", "Rules belong to a project.");
    d.target = isRule ? { area: "project", slug } : { area: feedsShared(sharing) ? "user" : "project", ...(feedsShared(sharing) ? {} : { slug }) };

    if (!internal) {
      if (d.type === "rule.remove") {
        const v = await verifyEvidence(d.evidence, { messages: vctx.messages });
        if (v.verified.length === 0) return no("skipped", "Removing a rule needs a message you wrote that says so; none could be verified.");
        // the message must be about THIS rule: a real sentence that shares a content word with it
        const about = contentWords(d.content);
        if (!v.verified.some((x) => wsnorm(x.quote).length >= 20 && [...contentWords(x.quote)].some((w) => about.has(w)))) return no("skipped", "None of the messages you wrote is about that rule, so it wasn't removed.");
        d.evidence = v.verified.map((x) => ({ ref: x.ref, quote: x.quote }));
      } else {
        const v = await verifyEvidence(d.evidence, { messages: vctx.messages });
        const g = grounding(v.verified, cluster);
        if (!g.ok) {
          const why = v.verified.length === 0 ? `none of its evidence is a message you wrote with those exact words${v.failed[0] ? ` (${v.failed[0].why})` : ""}` : `it needs ${GROUNDING.corrections} corrections or the same one in ${GROUNDING.sessions} sessions, found ${g.corrections} in ${g.sessions}`;
          return no("skipped", `Not enough evidence for a ${isRule ? "rule" : "preference"}: ${why}.`);
        }
        // the TEXT must be backed by the words quoted — not just any real quotes
        if (!claimSupported(d.content, v.verified.map((x) => x.quote))) return no("skipped", `The ${isRule ? "rule" : "preference"} isn't backed by what you wrote: none of the quoted messages says anything like it.`);
        if (cluster) {
          const a = contentWords(d.content);
          const b = contentWords(cluster.lesson);
          const inter = [...a].filter((w) => b.has(w)).length;
          const overlap = a.size + b.size - inter === 0 ? 0 : inter / (a.size + b.size - inter);
          if (overlap < LESSON_OVERLAP) return no("skipped", `The ${isRule ? "rule" : "preference"} doesn't match the repeated correction it was attached to.`);
        }
        d.evidence = v.verified.map((x) => ({ ref: x.ref, quote: x.quote }));
      }
    }
    const claim = d.type === "rule.remove" ? `-${d.content}` : d.content;
    const tkey = isRule ? { area: "project", slug } : "preference";
    const tomb = await tombstones.match({ kind, target: tkey, claim, clusterId: d.clusterId, sources: sessionsOf(d.evidence) });
    if (tomb) return no("dropped", "You undid this before, so it won't be proposed again.", { tombstoned: true });
    return ok(d, { claim, kind, tombstoneTarget: tkey, sessions: sessionsOf(d.evidence), cluster });
  }

  return { parse, normalize, validate, verifyEvidence, grounding };
}

export const sessionsOf = (evidence) => [...new Set((evidence ?? []).map((e) => MSG_RE.exec(e.ref)?.[1]).filter(Boolean))];

export { targetKey };
