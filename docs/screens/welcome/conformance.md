# Conformance — welcome

App vs `docs/screens/welcome/mockup.html`, from `npm run visual:compare welcome`.
Advisory: nothing here blocks a merge. Findings are recorded so they survive
the PR that found them.

Last reviewed: 2026-08-02 (<commit>)

## Open divergences

- None.

## Accepted divergences

- The segmented branch/worktree control is one bordered wrapper with an internal
  divider rather than two adjacent chips sharing a border. Visually equivalent
  in every state the screen renders.
- The composer box is not built from `Card` despite matching its chrome: it
  needs the `manta-composer-input-row` hook class for its focus ring and the
  `manta-recording` border state, and primitives accept no `className`
  (`docs/components.md` decision 3).
- The send button is hand-rolled rather than a primitive. It is the only
  bordered icon button in the app; at one call site it fails the two-adopter
  rule (`docs/components.md` decision 2). Revisit if a second one appears.
