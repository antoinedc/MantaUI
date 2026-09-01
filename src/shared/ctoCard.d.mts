// Hand-written type declarations for ctoCard.mjs. The implementation is
// plain JS so it can be imported by both Node-side modules (ctoEngine) and
// the renderer (ctoView). Keep this in sync with src/shared/ctoCard.mjs.

// True when the raw wire card carries a non-empty coerced title or body —
// the exact drop rule the §10.3 card mappers apply (BET-1467), shared with
// the server's needs-you count (BET-1476). Defensive: null/undefined or a
// non-object card carries no content.
export function cardHasContent(card: unknown): boolean;
