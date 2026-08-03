# Conformance — settings

App vs `docs/screens/settings/mockup.html`, from `npm run visual:compare settings`.
Advisory: nothing here blocks a merge. Findings are recorded so they survive
the PR that found them.

Last reviewed: 2026-08-03 (dc285c7)

## Open divergences

- **The settings panel does not yet use the `.setrow` row primitive.** BET-619
  built + registered `SettingsRow` (the `.setrow` chrome) but did NOT convert
  the settings rows to it: the stage's premise that Settings.tsx's private
  `SettingField` already implements `.setrow` was false (that `SettingField`
  is a `Field`-based text/password input, not a row with name/help/children).
  Neither named adopter (`Settings.tsx`, `ProvidersCard.tsx`) carries a
  genuine `.setrow` row, so the migration was reported rather than forced.
  The settings schema rows today hand-roll their own simpler chrome
  (`flex items-start gap-3 text-body` in `ToggleField`/`SegmentedField`) with
  no row dividers. Awaiting an owner decision on a `.setrow` migration of the
  settings panel.

## Accepted divergences

- **BET-614 stage 5, the 0.1 line-height delta:** the spec's name line-height
  is `1.4` (`font:500 14px/1.4`); `text-body` is `14px/1.5`. `SettingsRow`
  uses `text-body` and does not invent an arbitrary line-height, so the name
  renders at `1.5` — a 0.1 delta from spec. Recorded per the stage's explicit
  accepted-divergence note.

