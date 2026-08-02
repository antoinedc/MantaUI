# Component primitives — standing decisions & constraints

## Purpose

This is a primitive inventory with adopters — not a design system. Each primitive
exists only because it replaces two or more real call sites, is owned by the owner,
and is validated against the companion below. There is no showcase site, no
documentation site, and no variants nobody uses. This document preserves the rules
that were previously embedded in the BET-527 cell descriptions so they survive those
cells closing; it is authoritative for future issues.

## Source of truth

- **The redesign spec** (component inventory, chrome, variants):
  https://0d5784a7a43451f4ad70dd3d9ee5cf72.boxes.mantaui.com/pages/manta-redesign
- **Tokens**: `src/renderer/tokens.css` (multi-consumer — BET-516 generates a Swift
  theme from it, so a token change is no longer a local edit).
- **Validation surface**: the component companion (`npm run visual:companion`), which
  renders every candidate from the spec's own CSS, in **both themes**. Do not
  re-derive a component's appearance from prose.

## Standing decisions

1. **The owner validates every component personally.** Each primitive is reviewed by
   Antoine before it is adopted anywhere. Route to him; do not merge a primitive on
   agent review alone.
2. **Two-adopter rule.** A primitive is only introduced when it replaces **two or more
   existing call sites**, and those call sites are migrated in the **same PR**. Never
   land a primitive with no adopter. This is what keeps the inventory evidence-driven
   instead of speculative.
3. **No `className` escape hatch.** Primitives own their chrome. A component that
   accepts arbitrary classes at call sites reintroduces exactly the drift it exists to
   prevent.
4. **This is not a design system.** No showcase site, no documentation site, no
   variants nobody uses. It is a primitive inventory with adopters.
5. **Chrome only in the first pass. The transcript is excluded.** It lives inside the
   ChatPanel monolith and the mobile track is migrating its event wiring
   (DECISIONS.md §17, desktop renderer first). Start with card, field, pill, icon
   button, menu item — where both style-diff PoC screens live and where
   `Settings.tsx` already holds half the primitives privately.
6. **No new token.** If the spec needs a value the scale lacks, the scale changes
   first, in its own change, with baselines regenerated.

## Constraints C1–C5

### C1 — Set a foreground whenever you set a background. Otherwise inherit. (NARROWED 2026-08-01)

**Corrected after BET-531.** The original C1 said a primitive must always declare its own `color`. That was over-stated: the evidence came from the component companion, which renders TWO themes in ONE document, so a colour inherited from `<body>` resolved against the wrong theme. The app never does that — `data-theme` is set on `<html>` only (`src/renderer/theme.ts:73`), one theme per document, so inheritance always resolves correctly. `Card` correctly declares no text colour and was merged that way.

The real rule that survives: **if a primitive sets a background that differs from the page surface, it must also set the matching foreground token**, because a surface change invalidates the contrast the inherited colour assumed. A primitive that sets no background inherits, and should.

### C2 — Row metrics come from `[data-density]`, NOT `:root`.

`--row-h` (32px comfortable / 26px compact), `--row-px`, `--row-py`, plus `--prose-lh` and `--ui-lh`, are defined on `[data-density="comfortable"]` and `[data-density="compact"]`. A component rendered outside a density scope gets **none** of them — measured live, a session row collapses from 32px with `6px 10px` padding to an unpadded **18.2px** line. Any primitive consuming a `--row-*` token must state that it requires a density ancestor.

### C3 — Some insets belong to the CONTAINER, not the component.

`.rail-scroll` owns the `--sp-2` horizontal inset, and `.srow.on::before` (the selection marker) sits at `left:-8px` — it hangs **outside** the row into that padding. A row primitive that owned its own left inset would clip its own selection marker.

### C4 — An abstract base is not a variant.

The bare `.pill` sets only padding, radius and font — no background, no colour — and **0 of its 81 uses in the spec omit a modifier**. Rendered bare it is invisible text. A primitive whose base is abstract must make the variant a **required prop with no default**, not an optional one.

### C5 — The shadow scale follows the spec. (SETTLED 2026-08-02, BET-563)

BET-563's owner decision was option **(a) — the spec wins**, so `--shadow-sm/md/lg` in `src/renderer/tokens.css` were changed to the redesign spec's values in both themes (e.g. light `--shadow-md` is now the spec's single-layer `0 8px 24px`, not the app's two-layer form). The spec and `tokens.css` are now in agreement — dark 29/29, light 29/32. Use the token as normal; there is no longer a divergence to report or a side to pick.

## Inventory

Primitives that exist today, their adopting files (matching the two-adopter
count the enforce test asserts, `src/renderer/primitives.test.ts`), and the
variant axes their props actually accept (read from the props, not the spec).
A primitive with fewer than two adopting files is either under-adopted (see the
BET-541 findings) or a **single-surface exemption / waiver** owner-approved in
BET-546 / BET-549. Since BET-549 the two-adopter scan excludes
`src/renderer/mobile/**` — the mobile-redesign deletes that tree wholesale
(DECISIONS.md §12), so a file there would mark a primitive satisfied via one
that vanishes. Adopter counts below are **web** adopters only.

| Primitive | File | Adopters | Variants |
| --- | --- | --- | --- |
| Card | `src/renderer/Card.tsx` | 3 — `Cards.tsx`, `Settings.tsx`, `NewSessionScreen.tsx` | `danger` (optional); `header`/`actions` slots |
| Modal | `src/renderer/Modal.tsx` | 4 — `Sidebar.tsx`, `NewSessionScreen.tsx`, `Settings.tsx`, `FolderPickerModal.tsx` | `size: sm\|md\|lg`; `padded`; `tall`; `onDismiss`; `label` |
| IconButton | `src/renderer/IconButton.tsx` | 2 — `SessionHeader.tsx`, `NewSessionScreen.tsx` | `size: md\|lg\|xl` (`xl` has a single adopting file, `NewSessionScreen.tsx`, by design — it is a size on an existing primitive, not a new primitive, so the two-adopter rule does not gate it); `ariaHaspopup`/`ariaExpanded`/`hook` |
| Checkbox | `src/renderer/Checkbox.tsx` | 5 — `CustomProviderForm.tsx`, `ProvidersCard.tsx`, `ModelsCard.tsx`, `NewSessionScreen.tsx`, `Settings.tsx` | `checked`; `onChange`; `disabled`; `label`; `id`; `ariaLabel` |
| Field | `src/renderer/Field.tsx` | 2 — `Settings.tsx`, `CustomProviderForm.tsx` | `type: text\|password\|number`; `mono` (default true); `label`/`help`/`leading`/`footer`/`disabled` |
| Pill | `src/renderer/Pill.tsx` | 2 — `Cards.tsx`, `SessionHeader.tsx` | `tone: neutral\|accent\|warn` (required); `size: meta\|label`; `border` |
| MenuItem | `src/renderer/MenuItem.tsx` | 1 — `SessionHeader.tsx` — **single-surface waiver** (owner-approved, BET-549) | `variant: normal\|danger\|active` |
| SessionRow | `src/renderer/SessionRow.tsx` | 1 — `Sidebar.tsx` — **single-surface exemption** (owner-approved, BET-546) | `status: run\|att\|idle\|ok\|default` (required); `selected`; `child`; `ageStale` |
