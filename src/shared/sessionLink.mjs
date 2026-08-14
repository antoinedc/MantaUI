// sessionLink.mjs — the session link primitive (§3.4⑥, BET-847).
//
// A session is (a tmux window + an opencode session + a cwd). The link field
// names what that session is about — at most ONE issue and at most ONE pull
// request — so the review pane, the progress forge-sink and the notification
// body all read a single field with no per-feature plumbing.
//
// `repoKey`/`number` reuse the unchanged vocabulary from src/shared/forge.mjs
// (detectForge / PullRequest / Issue shapes) — there is deliberately no second
// id shape.
//
// Contract:
//   - 100% pure. No I/O.
//   - Unknown input is handled defensively: `sessionLink` returns `null` for a
//     missing/empty link.

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
