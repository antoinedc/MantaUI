// globalBlock.mjs — the user's learned preferences in the global opencode `AGENTS.md` (spec §4.1, §6.8).
//
//   ## Learned preferences (managed by Manta)
//
//   <!-- manta:knowledge:start -->
//   - …
//   <!-- manta:knowledge:end -->
//
// Rendered from `user/preferences.md`, written DIRECTLY (the file isn't in git) and mirrored as a store
// commit (`user/global-block.md`). Only the text between the markers is ever replaced; everything else in
// the file is left byte-for-byte. A user hand edit inside the block is adopted (written back into
// `user/preferences.md` as a user commit) before the next render, so it wins. Its own `## ` heading makes
// the guidance sync treat it as a user section.
//
// Writes are batched: `markPending()` on a preference change, then `runDailyIfDue()` applies it once a day
// at 04:00 box-local (opencode tells running sessions through a system-update message per write, spec
// §6.8). `apply()` is also what undo and the downgrade cleanup call to apply immediately.
//
// ONE mutex serializes every write of the file (undo, the daily batch, the downgrade cleanup), and a write is
// atomic (temp file + rename in the same directory; a symlinked file is written through its target). Everything
// that goes in is secret-scanned first (a hit drops that bullet and is reported). A day's batch is only recorded
// after a successful write; a failure is reported once and retried.
//
// Never call `apply()` / `adopt()` while holding the store lock (they take it themselves).

import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import { createMutex } from "../jsonStore.mjs";
import { localDay } from "./budget.mjs";
import { GLOBAL_BUDGET_LINES, applyBulletOp, newBulletsPage, parseBullets } from "./rules.mjs";
import { parsePage, renderPage } from "./pages.mjs";

export const GLOBAL_HEADING = "## Learned preferences (managed by Manta)";
export const BLOCK_START = "<!-- manta:knowledge:start -->";
export const BLOCK_END = "<!-- manta:knowledge:end -->";
export const PREFERENCES_PATH = "user/preferences.md";
export const MIRROR_PATH = "user/global-block.md";
export const BATCH_HOUR = 4;

const sha = (s) => createHash("sha256").update(s).digest("hex");
const nlnorm = (s) => String(s).replace(/\r\n/g, "\n");

/** Locate the managed block: the text between the markers (or, with only the heading, up to the next `## `). */
export function findBlock(src) {
  const text = nlnorm(src);
  const s = text.indexOf(BLOCK_START);
  if (s >= 0) {
    const e = text.indexOf(BLOCK_END, s + BLOCK_START.length);
    if (e >= 0) return { found: true, markers: true, innerStart: s + BLOCK_START.length, innerEnd: e, inner: text.slice(s + BLOCK_START.length, e).replace(/^\n/, "").replace(/\n$/, "") };
  }
  const h = text.indexOf(`\n${GLOBAL_HEADING}`) >= 0 ? text.indexOf(`\n${GLOBAL_HEADING}`) + 1 : text.startsWith(GLOBAL_HEADING) ? 0 : -1;
  if (h >= 0) {
    const lineEnd = text.indexOf("\n", h);
    const from = lineEnd < 0 ? text.length : lineEnd + 1;
    const nextH = text.indexOf("\n## ", from);
    const to = nextH < 0 ? text.length : nextH + 1;
    return { found: true, markers: false, innerStart: from, innerEnd: to, inner: text.slice(from, to).trim() };
  }
  return { found: false };
}

/** The block text for `bullets` (≤ 200 lines in all, markers and heading included). */
export function renderBlock(bullets) {
  const budget = GLOBAL_BUDGET_LINES - 4; // heading, blank, two markers
  const kept = bullets.slice(0, budget);
  return { text: kept.map((b) => `- ${b}`).join("\n"), truncated: bullets.length > kept.length, count: kept.length };
}

/** `src` with the managed block's inner text replaced (created at the end when absent). Returns the new text. */
export function spliceBlock(src, innerText) {
  const text = nlnorm(src);
  const b = findBlock(text);
  const inner = innerText === "" ? "" : `${innerText}\n`;
  if (b.found && b.markers) return `${text.slice(0, b.innerStart)}\n${inner}${text.slice(b.innerEnd)}`;
  if (b.found) {
    // heading without markers: wrap what it had
    return `${text.slice(0, b.innerStart)}\n${BLOCK_START}\n${inner}${BLOCK_END}\n${b.innerEnd < text.length ? "\n" : ""}${text.slice(b.innerEnd)}`;
  }
  const lead = text === "" ? "" : text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  return `${text}${lead}${GLOBAL_HEADING}\n\n${BLOCK_START}\n${inner}${BLOCK_END}\n`;
}

export const RETRY_AFTER_FAILURE_MS = 15 * 60 * 1000;

/**
 * deps: path (the global AGENTS.md; absent → off), store, state, now, log, scan(text) → {clean, unavailable}
 * (the engine's secret scanner), report({kind, summary, reason, …}) (→ Recent changes), readFileFn/writeFileFn/
 * renameFn/realpathFn (tests).
 */
export function createGlobalBlock({ path, store, state, now = Date.now, log = console.warn, scan, report, readFileFn = readFile, writeFileFn = writeFile, renameFn = rename, realpathFn = realpath } = {}) {
  const enabled = typeof path === "string" && path !== "";
  const kv = { hash: "global.lastHash", pending: "global.pending", batchDay: "global.lastBatchDay", failDay: "global.failNotedDay", nextTry: "global.nextTry" };
  const mutex = createMutex();
  const say = (e) => {
    try {
      report?.(e);
    } catch (err) {
      log("[knowledge] global block report failed:", err?.message ?? err);
    }
  };

  /** Bullets that pass the secret scan; a hit (or an unavailable scanner) drops the bullet and is reported. */
  async function scanBullets(bullets, where) {
    if (!scan) return bullets;
    const out = [];
    for (const b of bullets) {
      let v;
      try {
        v = await scan(b);
      } catch {
        v = { clean: false, unavailable: true };
      }
      if (v.clean) out.push(b);
      else say({ kind: "dropped", summary: `Left a preference out of the global instructions (${where})`, reason: v.unavailable ? "The secret scanner is unavailable, so it wasn't written." : "It looked like it contained a secret, so it wasn't written.", area: "global-block" });
    }
    return out;
  }

  async function writeAtomic(text) {
    let target = path;
    try {
      target = await realpathFn(path);
    } catch {
      /* not there yet */
    }
    await mkdir(dirname(target), { recursive: true });
    const tmp = join(dirname(target), `.${basename(target)}.manta-${process.pid}-${now()}.tmp`);
    try {
      await writeFileFn(tmp, text);
      await renameFn(tmp, target);
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  }

  async function readFileSafe() {
    try {
      return await readFileFn(path, "utf8");
    } catch (e) {
      if (e?.code === "ENOENT") return null;
      throw e;
    }
  }

  async function storeBullets() {
    const src = await store.read(PREFERENCES_PATH);
    return src ? parseBullets(src).map((b) => b.text) : [];
  }

  /** The current block: `{exists, found, bullets, inner}`. */
  async function read() {
    if (!enabled) return { exists: false, found: false, bullets: [], inner: "" };
    const src = await readFileSafe();
    if (src === null) return { exists: false, found: false, bullets: [], inner: "" };
    const b = findBlock(src);
    return { exists: true, found: b.found, bullets: b.found ? parseBullets(b.inner).map((x) => x.text) : [], inner: b.found ? b.inner : "" };
  }

  /**
   * A hand edit inside the block (its text differs from what we last wrote) is adopted: the edited bullets
   * replace `user/preferences.md`'s, as a user commit. Returns `{adopted, bullets}`.
   */
  async function adoptUnlocked() {
    if (!enabled) return { adopted: false };
    const cur = await read();
    if (!cur.found) return { adopted: false };
    const clean = await scanBullets(cur.bullets, "your edit");
    if (clean.length !== cur.bullets.length) cur.bullets = clean;
    const last = state.kvGet(kv.hash);
    if (last !== null && sha(cur.inner) === last) return { adopted: false };
    const have = await storeBullets();
    if (JSON.stringify(have) === JSON.stringify(cur.bullets)) {
      state.kvSet(kv.hash, sha(cur.inner));
      return { adopted: false };
    }
    if (last === null && cur.bullets.length === 0) return { adopted: false };
    const out = await store.withLock(async (tx) => {
      const existing = await tx.read(PREFERENCES_PATH);
      let next = existing ?? newBulletsPage("Preferences", "");
      const page = parsePage(next);
      const lines = page.body.split("\n").filter((l) => !/^[-*]\s+/.test(l));
      while (lines.length && lines[lines.length - 1] === "") lines.pop();
      const body = `${lines.join("\n")}${lines.length ? "\n\n" : ""}${cur.bullets.map((b) => `- ${b}`).join("\n")}\n`;
      next = page.invalid ? `${next.slice(0, page.bodyOffset)}${body}` : renderPage({ frontMatter: page.frontMatter ?? { title: "Preferences" }, body });
      const who = await tx.userIdentity();
      return tx.commit({ path: PREFERENCES_PATH, content: next, message: "Adopt your edit of the global learned preferences", body: "You edited the managed block in the global AGENTS.md; your version is now the source.", author: who });
    });
    state.kvSet(kv.hash, sha(cur.inner));
    return { adopted: out.changed, bullets: cur.bullets.length };
  }

  const adopt = () => mutex.runExclusive(adoptUnlocked);

  /** Adopt any hand edit, render from the store, write the file and mirror it. Returns what happened. */
  const apply = (opts) => mutex.runExclusive(() => applyUnlocked(opts));

  async function applyUnlocked({ reason = "daily" } = {}) {
    if (!enabled) return { ok: false, off: true };
    try {
      const adopted = await adoptUnlocked();
      const bullets = await scanBullets(await storeBullets(), "your preferences");
      const r = renderBlock(bullets);
      const before = await readFileSafe();
      const after = spliceBlock(before ?? "", r.text);
      let changed = false;
      if (before === null || nlnorm(before) !== after) {
        await writeAtomic(after);
        changed = true;
      }
      state.kvSet(kv.hash, sha(findBlock(after).inner));
      state.kvDelete(kv.pending);
      const mirror = renderPage({ frontMatter: { title: "Learned preferences (global block)", verified: localDay(now()) }, body: `# Learned preferences (global block)\n\nMirrored from \`${path}\`. Edit \`user/preferences.md\`, or the block in that file.\n\n${r.text}${r.text ? "\n" : ""}` });
      await store.commit({ path: MIRROR_PATH, content: mirror, message: "Mirror the global learned preferences", body: `Reason: ${reason}.` });
      return { ok: true, changed, adopted: adopted.adopted === true, count: r.count, truncated: r.truncated };
    } catch (e) {
      log("[knowledge] global block write failed:", e?.message ?? e);
      state.kvSet(kv.pending, "1"); // whatever failed is retried by the daily batch
      return { ok: false, error: String(e?.message ?? e) };
    }
  }

  const markPending = () => state.kvSet(kv.pending, "1");
  const isPending = () => state.kvGet(kv.pending) === "1";

  /**
   * The daily 04:00 batch: once per local day, after 04:00, when something is pending (or on first sight of a hand
   * edit). The day is recorded only after a successful write; a failure is reported once a day and retried
   * after 15 minutes.
   */
  async function runDailyIfDue() {
    if (!enabled) return { ran: false, reason: "off" };
    const t = new Date(now());
    if (t.getHours() < BATCH_HOUR) return { ran: false, reason: "before-batch-time" };
    const day = localDay(now());
    if (state.kvGet(kv.batchDay) === day) return { ran: false, reason: "already-ran" };
    if (now() < Number(state.kvGet(kv.nextTry) ?? 0)) return { ran: false, reason: "backoff" };
    if (!isPending()) {
      const cur = await read();
      const last = state.kvGet(kv.hash);
      if (!(cur.found && (last === null ? cur.bullets.length > 0 : sha(cur.inner) !== last))) {
        state.kvSet(kv.batchDay, day);
        return { ran: false, reason: "nothing-pending" };
      }
    }
    const r = await apply({ reason: "daily batch" });
    if (r.ok) {
      state.kvSet(kv.batchDay, day);
      state.kvDelete(kv.nextTry);
      return { ran: true, ...r };
    }
    state.kvSet(kv.nextTry, String(now() + RETRY_AFTER_FAILURE_MS));
    if (state.kvGet(kv.failDay) !== day) {
      state.kvSet(kv.failDay, day);
      say({ kind: "notice", summary: "Couldn't update your global instructions", reason: `${String(r.error ?? "unknown error").slice(0, 200)} It will be retried.`, area: "global-block" });
    }
    return { ran: true, ...r };
  }

  /** Remove `bullets` (normalized-equal) from `user/preferences.md` — used by the downgrade cleanup. */
  const removeFromSource = (source, text) => applyBulletOp(source, { op: "remove", text });

  return { enabled, path, read, adopt, apply, markPending, isPending, runDailyIfDue, removeFromSource };
}
