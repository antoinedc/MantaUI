// The one line a Fleet row shows about what a session is doing now (docs/superpowers/specs/2026-11-28-fleet-redesign.md §5b).
//
// It is the background job card's own line, for ANY session: the latest `progress_report` label while it is fresh, else the
// in-progress to-do item, else the last short line the assistant wrote. The first two are exactly `headlineOf` of the job
// card (jobProgressView.mjs), so a chat and a job say the same kind of thing the same way. Never a subagent's name.
// Pure priority logic, plus a reader whose I/O is injected.

import { LABEL_FRESH_MS, headlineOf, normalizeChecklist } from "./jobProgressView.mjs";

/** A line is at most this many characters. */
export const LINE_MAX = 120;

const clip = (s, max) => (s.length > max ? `${s.slice(0, max - 1).replace(/\s+$/, "")}…` : s);

/** The last short line of an assistant message: last non-empty line, fences and markdown marks removed, one line, capped. "" when none. */
export function statusLineOf(text, max = LINE_MAX) {
  const lines = String(text ?? "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i];
    if (/^\s*(```|~~~)/.test(raw)) continue;
    // eslint-disable-next-line no-control-regex
    const clean = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/^[\s#>*+-]+/, "").replace(/[`*_]+/g, "").replace(/\s+/g, " ").trim();
    if (clean) return clip(clean, max);
  }
  return "";
}

/**
 * The line for one session. Every input is optional.
 * @param {object} a
 * @param {{label?: string, updatedAt?: number}|null} [a.report] the session's own `progress_report` record
 * @param {Array<{content?: string, text?: string, status?: string}>|null} [a.todos] the session's live to-do list
 * @param {{label?: string, labelAt?: number|null, checklist?: Array<{text: string, status: string}>|null}|null} [a.jobProgress] a job row's record
 * @param {string} [a.lastAssistant] the session's last assistant message
 * @param {number} a.now
 */
export function sessionOneLiner({ report = null, todos = null, jobProgress = null, lastAssistant = "", now } = {}) {
  // the newer of the job record's label and the session's own report
  let label = "";
  let labelAt = null;
  const consider = (text, at) => {
    if (typeof text !== "string" || !text.trim() || !Number.isFinite(at)) return;
    if (labelAt == null || at > labelAt) {
      label = text;
      labelAt = at;
    }
  };
  consider(jobProgress?.label, jobProgress?.labelAt);
  consider(report?.label, report?.updatedAt);
  const checklist = Array.isArray(jobProgress?.checklist) && jobProgress.checklist.length > 0 ? jobProgress.checklist : normalizeChecklist(todos);
  const { headline } = headlineOf({ label, labelAt, checklist: checklist ?? [] }, { now });
  return headline || statusLineOf(lastAssistant);
}

/**
 * A reader of lines. `readReports()` → `{ [sessionId]: record }` (one read of the progress store per `read`), `todosOf(sid)` the
 * interpreter's live to-do list, `lastAssistantOf(sid)` the session's last assistant text (asked only when the report and the
 * to-do give nothing; remembered briefly). A failing read is an empty line, never an error on a display read.
 */
export function createSessionLines({ readReports, todosOf = () => null, lastAssistantOf = async () => "", now = Date.now, cacheMs = 20_000 } = {}) {
  const lastCache = new Map(); // sid → { at, text }
  async function lastAssistant(sid) {
    const hit = lastCache.get(sid);
    if (hit && now() - hit.at < cacheMs) return hit.text;
    let text = "";
    try {
      text = String((await lastAssistantOf(sid)) ?? "");
    } catch {
      text = "";
    }
    lastCache.delete(sid);
    lastCache.set(sid, { at: now(), text });
    for (const k of lastCache.keys()) {
      if (lastCache.size <= 200) break;
      lastCache.delete(k);
    }
    return text;
  }

  return {
    /** @param {Array<{sessionId: string, jobProgress?: object|null}>} targets @returns {Promise<Record<string, string>>} */
    async read(targets) {
      let reports = {};
      try {
        reports = (await readReports?.()) ?? {};
      } catch {
        reports = {};
      }
      const out = {};
      await Promise.all(
        (targets ?? []).map(async (t) => {
          if (!t?.sessionId) return;
          let todos = null;
          try {
            todos = todosOf(t.sessionId) ?? null;
          } catch {
            todos = null;
          }
          const input = { report: reports[t.sessionId] ?? null, todos, jobProgress: t.jobProgress ?? null, now: now() };
          let line = sessionOneLiner(input);
          if (!line) line = sessionOneLiner({ ...input, lastAssistant: await lastAssistant(t.sessionId) });
          out[t.sessionId] = line;
        }),
      );
      return out;
    },
  };
}

export { LABEL_FRESH_MS };
