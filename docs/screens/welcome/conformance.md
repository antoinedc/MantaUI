# Conformance — welcome

App vs `docs/screens/welcome/mockup.html`, from `npm run visual:compare welcome`.
Advisory: nothing here blocks a merge. Findings are recorded so they survive
the PR that found them.

Last reviewed: 2026-08-02 (9d0017a)

## Open divergences

- Heading is 24px (`text-display`); the mockup specifies 30px. No 30px role exists in the type scale.
- Heading letter-spacing: mockup specifies `-0.02em`; the app applies none. No tracking token exists.
- Radii: mockup specifies 10px chips / 14px composer / 9px send button; the app uses the Tailwind radius scale (8 / 12 / 8). The mockup's own spec note claims a 4px grid, which 9, 10 and 14 are not on — the mockup is internally inconsistent and needs an owner ruling.
- Control heights: mockup specifies 34px for the send button, model/effort pills and the two icon buttons. The app renders 36px for the send button and ~24px for the icon buttons (the `IconButton` primitive is `p-1`). 34 is not on the 4px grid; changing `IconButton` is primitive surgery.
- Worktree checkbox is the native browser control; the mockup specifies a custom 16px box (`border-strong`, 4px radius, canvas fill). The mockup shows the unchecked state only, so the checked treatment is unspecified.

## Accepted divergences

- The segmented control is implemented as one bordered wrapper with `overflow-hidden` and an internal `border-l`, rather than two adjacent chips with a shared border. Visually equivalent at every state the screen renders.
- The composer box is not built from the `Card` primitive even though the chrome matches, because it requires the `manta-composer-input-row` hook class for its focus-within ring and the `manta-recording` border state, and primitives accept no `className` (docs/components.md decision 3).
