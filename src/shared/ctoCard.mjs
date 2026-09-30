// One predicate for "does this needs-you card carry actionable content?",
// shared by the server's needs-you badge count (ctoEngine defaultGetCounts,
// BET-1476) and the renderer's §10.3 card selectors (ctoView blocker/veto/
// connect mappers). BET-1467 made the mappers drop a card whose coerced
// title AND body are both empty; BET-1476 makes needsYouCount agree so the
// sidebar badge never shows an answerable item that renders nowhere. The
// coercion below matches the mappers' String(c.title ?? "") /
// String(c.body ?? "") exactly — a non-string (number, false, object)
// coerces like the mappers see it, so the two sides cannot drift.

export function cardHasContent(card) {
  if (!card || typeof card !== "object") return false;
  return String(card.title ?? "") !== "" || String(card.body ?? "") !== "";
}

// The closed set of option-action types a BLOCKER card may carry. The server
// (ctoCards healthCardCopy) only ever writes these, and the renderer's
// dispatcher (ctoView BLOCKER_OPTION_HANDLERS) must handle exactly these — a
// test on each side pins that, so a card can never render a button nothing
// handles (AGENTS.md: NEVER STUB A CONTROL TO DO NOTHING).
//   resume-cto   → POST /api/cto/resume (also resolves the health cards)
//   dismiss-card → POST /api/cto/cards/dismiss {id}
export const BLOCKER_ACTION_TYPES = Object.freeze(["resume-cto", "dismiss-card"]);
