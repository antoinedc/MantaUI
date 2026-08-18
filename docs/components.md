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
  docs/screens/redesign-spec.html  (committed archive — read this)
  https://0d5784a7a43451f4ad70dd3d9ee5cf72.boxes.mantaui.com/pages/manta-redesign
  (served copy, EXPIRES 2026-08-13 — do not rely on it)
- **Tokens**: `src/renderer/tokens.css` (multi-consumer — BET-516 generates a Swift
  theme from it, so a token change is no longer a local edit).
- **Validation surface**: the component companion (`npm run visual:companion`), which
  renders every candidate from the spec's own CSS, in **both themes**. Do not
  re-derive a component's appearance from prose.

## Standing decisions

1. **The owner validates every primitive personally — after merge.** Each
   primitive is reviewed by Antoine visually against a staging desktop build
   AFTER it merges (amended BET-636: the tool-card primitives do not block the
   PR on per-primitive owner sign-off). The review gate is the pre-merge
   authority; owner validation happens post-merge on the staging build.
2. **Two-adopter rule.** A primitive is only introduced when it replaces **two or more
   existing call sites**, and those call sites are migrated in the **same PR**. Never
   land a primitive with no adopter. This is what keeps the inventory evidence-driven
   instead of speculative.
3. **No `className` escape hatch.** Primitives own their chrome. A component that
   accepts arbitrary classes at call sites reintroduces exactly the drift it exists to
   prevent.
4. **This is not a design system.** No showcase site, no documentation site, no
   variants nobody uses. It is a primitive inventory with adopters.
5. **Transcript chrome is in scope (first pass complete).** The first pass now
   covers the transcript's tool rendering (LIFTED BET-636 — decision 5's
   original exclusion of the transcript is rescinded now that the first pass
   shipped). Transcript chrome is built as reusable primitives that later
   screens adopt, not as inline markup inside the transcript components.
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

**Menu surface chrome (BET-644, collision 1 — C5 precedent).** The whole
dropdown family — `Dropdown` (MenuItem) and both picker menus — uses one
surface token, `--card`/`bg-bg-soft`, and the spec's `--r-lg`/`--shadow-lg`
chrome, replacing the old `--panel`/`bg-bg-elev`/`rounded-md`/`shadow-md`
contract. When the spec (the proposal's `.dd`) and the code (`docs/components.md` + `Dropdown`'s contract comment) disagreed, the spec won, and
SessionHeader's session menu moved with it.


| Primitive | File | Adopters | Variants |
| --- | --- | --- | --- |
| Button | `src/renderer/Button.tsx` | 2 — `Settings.tsx`, `FolderPickerModal.tsx` | `tone: default\|primary\|ghost\|danger` (required, no default — the bare base is abstract, C4); `disabled`; `type`; `title`; `children`; `hook`. No `size` prop — one size only (the spec has no `.btn.sm` rule). |
| Chip | `src/renderer/Chip.tsx` | 2 — `NewSessionScreen.tsx` (folder chip + branch chip); `ModelPicker.tsx` (via the shared module) | `on` (the accent "active" state); `onClick`; `title`; `children`; `hook`. No `size` prop — one size only (29px hit area) |
| SplitChip | `src/renderer/Chip.tsx` | 2 — `ModelPicker.tsx` (model ▸ effort split); `NewSessionScreen.tsx` (via the shared module) | `left`/`right` (ReactNode); `onLeftClick`/`onRightClick`; `rightAccent` (accent-tx + semibold on the right — replaces the composer's old inline `var(--accent-tx)`); `leftTitle`/`rightTitle`; `popup` (OPT-IN `aria-haspopup="listbox"` on both segments — a generic split control does not assume popup semantics, so a non-popup adopter omits it); `hook`. Both co-reside in `Chip.tsx` because they share the shell and must not diverge |
| Card | `src/renderer/Card.tsx` | 3 — `Cards.tsx`, `Settings.tsx`, `NewSessionScreen.tsx` | `danger` (optional); `header`/`actions` slots |
| Modal | `src/renderer/Modal.tsx` | 4 — `Sidebar.tsx`, `NewSessionScreen.tsx`, `Settings.tsx`, `FolderPickerModal.tsx` | `size: sm\|md\|lg`; `padded`; `tall`; `onDismiss`; `label` |
| IconButton | `src/renderer/IconButton.tsx` | 2 — `SessionHeader.tsx`, `NewSessionScreen.tsx` | `size: md\|lg\|xl` (`xl` has a single adopting file, `NewSessionScreen.tsx`, by design — it is a size on an existing primitive, not a new primitive, so the two-adopter rule does not gate it); `ariaHaspopup`/`ariaExpanded`/`hook` |
| Checkbox | `src/renderer/Checkbox.tsx` | 5 — `CustomProviderForm.tsx`, `ProvidersCard.tsx`, `ModelsCard.tsx`, `NewSessionScreen.tsx`, `Settings.tsx` | `checked`; `onChange`; `disabled`; `label`; `id`; `ariaLabel` |
| Field | `src/renderer/Field.tsx` | 2 — `Settings.tsx`, `CustomProviderForm.tsx` | `type: text\|password\|number`; `mono` (default true); `label`/`help`/`leading`/`footer`/`disabled` |
| Pill | `src/renderer/Pill.tsx` | 2 — `Cards.tsx`, `SessionHeader.tsx` | `tone: neutral\|accent\|warn` (required); `size: meta\|label`; `border` |
| MenuItem | `src/renderer/MenuItem.tsx` | 3 — `SessionHeader.tsx` (session menu); `ModelMenu.tsx` + `EffortMenu.tsx` (both via `Dropdown`) — BET-549 single-surface waiver **resolved** (BET-644) | `variant: normal\|danger\|active` (MenuItem). Co-exports `Dropdown` — the four-region menu surface — with `hook`; `placement: below\|above`; `align: start\|end`; `width: menu\|wide\|narrow`; `role: menu\|listbox`; `search`/`header`/`footer` slots |
| MenuOption | `src/renderer/MenuOption.tsx` | 2 — `ModelMenu.tsx` (model list), `EffortMenu.tsx` (effort list) | `selected` (the --accent-bg fill + --accent-tx label + visible check, C1); `active` (roving-highlight target); `label`; `sub?` (presence → 44px density; absent → 34px); `trailing?`; `id` |
| SessionRow | `src/renderer/SessionRow.tsx` | 1 — `Sidebar.tsx` — **single-surface exemption** (owner-approved, BET-546) | `status: run\|att\|idle\|ok\|default` (required); `selected`; `child`; `ageStale` |
| Toggle | `src/renderer/Toggle.tsx` | 2 call sites in 1 file — `Settings.tsx` (`chatAutoAllow`, `allowAgentPush`) — **single-surface case** (both boolean switch rows live in the one settings form, BET-614) | `checked`; `onChange`; `disabled`; `ariaLabel`; `id` |
| Callout | `src/renderer/Callout.tsx` | 2 — `Onboarding.tsx`, `ConnectProvider.tsx` | `tone: info\|ok\|warn\|danger` (required, no default — the bare base is abstract, C4); `children` |
| Tag | `src/renderer/Tag.tsx` | 3 — `SessionHeader.tsx` (branch indicator); `ModelMenu.tsx` (model-menu context badge); `ModelsCard.tsx` (settings models-table count) — BET-618 report **closed** (BET-644) | `icon?` (lucide at `size={12}`); `title?`; `numeric?` (tabular-nums for counts); `tone: default\|accent` (accent = a selected menu row's badge); `children` |
| IconCard | `src/renderer/IconCard.tsx` | 0 — **reported** (BET-618): neither named adopter (`Settings.tsx`, `NewSessionScreen.tsx`) has an icon-above-label tile; registered under the enforce net pending owner decision | `icon` (lucide at `size={20}`); `label` |
| Eyebrow | `src/renderer/Eyebrow.tsx` | 1 — `Settings.tsx` (the GroupCard section label) — **reported** (BET-618): 2nd named adopter `NewSessionScreen.tsx` has no uppercase section label; registered as a single-web-adopter case | `children` |
| SettingsRow | `src/renderer/SettingsRow.tsx` | 1 — `Settings.tsx` (the settings form's schema rows: `ToggleField`, `SegmentedField`, the plugins toggle, and the launcher flag rows) — **single-surface case** (BET-623): the settings panel is one surface, like `Toggle` | `name`; `help?`; `children` (the control) |
| StatusDot | `src/renderer/StatusDot.tsx` | 2 — `ToolCard.tsx` (card header dot), `TaskCard.tsx` (subagent status line) | `tone: ok\|running\|error\|idle` (required) |
| OutputWell | `src/renderer/OutputWell.tsx` | 2 — `ToolBodies.tsx` (tool output + diff), `Cards.tsx` (permission ask command) | `variant: attached\|standalone` (required); `maxHeight?` |
| ToolCard | `src/renderer/ToolCard.tsx` | 2 — `ToolCall.tsx` (generic tool call), `TaskCard.tsx` (subagent card) | `tone?` (StatusDot tone; omitted when the card renders its own status dot in the body); `name`; `arg?`; `meta?`; `expanded?`; `onToggle?`; `children?` |
| MeasureColumn | `src/renderer/MeasureColumn.tsx` | 3 — `Transcript.tsx` (message column; full width), `ChatPanel.tsx` (working indicator; full width), `InputArea.tsx` (composer inner wrapper) | `stacked` (false default — plain block; true — flex column with `--turn-gap`), `width` (`"measure"` default — capped + centred; `"full"` — no cap, no centring, keeps the 28px inset) |
| MantaLoader | `src/renderer/MantaLoader.tsx` | 2 — `MessageRow.tsx` (the working row), `ChatPanel.tsx` (session connect) | `size: inline\|screen` (default `inline`); `label?` (accessible name; omit when the surrounding row names the state). Also exports `MantaMark` — the same mark with no arcs, for the finished-turn footer. **This file is the ONLY brand mark in the app** (artwork: `src/renderer/assets/manta-mark-128.png`); never hand-draw a substitute SVG or gradient tile — see `docs/brand/README.md` |
| MessageBubble | `src/renderer/MessageBubble.tsx` | 1 — `MessageRow.tsx` (the user message) — **single-surface exemption** (owner-approved, BET-637): the user message is the only bubble in the app today; the owner wants the chrome owned by a primitive now rather than re-derived when mobile and any future review surface need it | `children` |
