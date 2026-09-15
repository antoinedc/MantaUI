// ftsQuery.mjs — the ONE literal-query policy for building FTS5 MATCH
// expressions out of a user search string (shared helper; consumed by
// ctoSearchIndex.mjs and reusable by any future FTS surface).
//
// POLICY — the user's query is LITERAL TEXT, never an FTS5 query-language
// expression. FTS5's MATCH syntax treats `*` (prefix), `"` (phrases),
// `AND` / `OR` / `NOT` / `NEAR`, `(` `)`, `:` (column filters) and `^` as
// operators; a raw user string containing any of them is a syntax error or
// silently different query. The policy makes that impossible:
//
//   1. The query is split on ASCII whitespace into terms; EVERY term must
//      appear (implicit AND). No operator vocabulary is exposed.
//   2. Each term is wrapped in double quotes with any internal `"` doubled
//      — inside an FTS5 string literal every other character, including
//      `*`, `(`, `:` and `-`, is a literal token, so metacharacters can
//      never act as operators (`stagi*` does NOT prefix-expand).
//   3. Unicode: FTS5's default `unicode61` tokenizer splits and case-folds
//      unicode text, so a quoted unicode term (`café`) matches the same
//      word in any case. Tokens are unicode words; a term made ONLY of
//      punctuation yields zero tokens and matches nothing — an honest
//      no-hit, never a syntax error.
//
// Verified against the runtime's bundled SQLite (2026-09-15, node 22.22.2):
// quoted punctuation-only terms and empty phrases return no rows without
// error, quoted `*` does not expand, and `"a" AND "b"` is plain boolean
// conjunction.
//
// Pure: no I/O, no imports. Pinned by ctoSearchIndex.test.mjs.

/**
 * Build the MATCH expression for a literal user query.
 *
 * @param {unknown} query
 * @returns {{ ok: true, expr: string, terms: string[] }
 *          | { ok: false, reason: string }}
 */
export function ftsMatchExpression(query) {
  if (typeof query !== "string") return { ok: false, reason: "query must be a string" };
  const terms = query.split(/\s+/).filter((t) => t !== "");
  if (terms.length === 0) return { ok: false, reason: "query must contain non-whitespace text" };
  const quoted = terms.map((t) => `"${t.replace(/"/g, '""')}"`);
  return { ok: true, expr: quoted.join(" AND "), terms };
}
