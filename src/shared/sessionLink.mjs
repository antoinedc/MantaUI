// sessionLink.mjs — the session link primitive (§3.4⑥, BET-847).
//
// A session is (a tmux window + an opencode session + a cwd). The link field
// names what that session is about — at most ONE issue and at most ONE pull
// request — so the checks strip, the review pane, the progress forge-sink,
// the notification body and the inbox row all read a single field with no
// per-feature plumbing.
//
// `repoKey`/`number` reuse the unchanged vocabulary from src/shared/forge.mjs
// (detectForge / PullRequest / Issue shapes) — there is deliberately no second
// id shape.
//
// Contract:
//   - 100% pure. No I/O. The mutators return a NEW session record (the caller
//     persists it through the existing config path); they never mutate input.
//   - Unknown input is handled defensively: `sessionLink` returns `null` for a
//     missing/empty link; the mutators treat a non-object session as a fresh
//     record and throw a `TypeError` on an invalid ref (loud rejection, the
//     forge.mjs discipline).
//   - At most one issue + one PR: saving a new issue replaces the prior issue;
//     saving a new PR replaces the prior PR; the two slots stay independent.

/**
 * Read a session's link — a normalized `{ issue?, pr? }` object (only the set
 * slots present) or `null` when the record has no link. The input record's
 * `link` field is validated/vetted so a malformed stored value degrades to the
 * slots that ARE usable rather than leaking garbage to consumers.
 *
 * @param {{ link?: unknown } | null | undefined} session
 * @returns {{ issue?: { repoKey: string, number: number }, pr?: { repoKey: string, number: number } } | null}
 */
export function sessionLink(session) {
  const raw = session && typeof session === "object" ? session.link : null;
  if (!raw || typeof raw !== "object") return null;
  const out = {};
  const slot = (name) => {
    const ref = raw[name];
    if (!ref || typeof ref !== "object") return;
    const repoKey = typeof ref.repoKey === "string" ? ref.repoKey : null;
    const number = typeof ref.number === "number" ? ref.number : null;
    if (!repoKey || !Number.isInteger(number) || number < 1) return;
    out[name] = { repoKey, number };
  };
  slot("issue");
  slot("pr");
  return Object.keys(out).length ? out : null;
}

// Validate a caller-supplied ref (the SET side). Throws loudly so a bad link
// never silently persists.
function assertLinkRef(ref, what) {
  if (!ref || typeof ref !== "object") {
    throw new TypeError(`${what}: ref must be { repoKey, number }`);
  }
  if (typeof ref.repoKey !== "string" || ref.repoKey.trim() === "") {
    throw new TypeError(`${what}: ref.repoKey must be a non-empty string`);
  }
  if (!Number.isInteger(ref.number) || ref.number < 1) {
    throw new TypeError(`${what}: ref.number must be a positive integer`);
  }
}

// Base record to mutate: the session when it's an object, else a fresh one so
// a null session still yields a link-carrying record.
function baseSession(session) {
  return session && typeof session === "object" ? session : {};
}

/**
 * Set (replace) the session's issue link. The prior issue link is replaced;
 * an existing PR link is preserved. Returns a NEW record.
 *
 * @param {{ link?: unknown } | null | undefined} session
 * @param {{ repoKey: string, number: number }} ref
 * @returns {{ link?: unknown }}
 */
export function linkIssue(session, ref) {
  assertLinkRef(ref, "linkIssue");
  const base = baseSession(session);
  const current = sessionLink(base) ?? {};
  return { ...base, link: { ...current, issue: { repoKey: ref.repoKey, number: ref.number } } };
}

/**
 * Set (replace) the session's pull-request link. The prior PR link is
 * replaced; an existing issue link is preserved. Returns a NEW record.
 *
 * @param {{ link?: unknown } | null | undefined} session
 * @param {{ repoKey: string, number: number }} ref
 * @returns {{ link?: unknown }}
 */
export function linkPullRequest(session, ref) {
  assertLinkRef(ref, "linkPullRequest");
  const base = baseSession(session);
  const current = sessionLink(base) ?? {};
  return { ...base, link: { ...current, pr: { repoKey: ref.repoKey, number: ref.number } } };
}

/**
 * Remove the session's link entirely (both slots). Returns a NEW record with
 * the `link` field absent.
 *
 * @param {{ link?: unknown } | null | undefined} session
 * @returns {{ link?: unknown }}
 */
export function clearLink(session) {
  const base = baseSession(session);
  const { link, ...rest } = base;
  return rest;
}
