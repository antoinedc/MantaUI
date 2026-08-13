# Conformance — settings

App vs `docs/screens/settings/mockup.html`, from `npm run visual:compare settings`.
Advisory: nothing here blocks a merge. Findings are recorded so they survive
the PR that found them.

Last reviewed: 2026-08-03 (f3a92f6)

## Open divergences

## Resolved divergences

- **The settings panel did not use the `.setrow` row primitive.** BET-619 built
  + registered `SettingsRow` (the `.setrow` chrome) but did NOT convert the
  settings rows to it: the stage's premise that Settings.tsx's private
  `SettingField` already implements `.setrow` was false (that `SettingField`
  is a `Field`-based text/password input, not a row with name/help/children),
  so the migration was reported rather than forced. **Resolved by BET-623:** the
  owner decision to adopt was made, and the settings panel's schema rows
  (`ToggleField`, `SegmentedField`, and the plugins/launcher checkbox rows)
  now render on `SettingsRow`. The visual change (row dividers + spec
  label/help typography) is the expected, approved layout.

## Accepted divergences

- **BET-614 stage 5, the 0.1 line-height delta:** the spec's name line-height
  is `1.4` (`font:500 14px/1.4`); `text-body` is `14px/1.5`. `SettingsRow`
  uses `text-body` and does not invent an arbitrary line-height, so the name
  renders at `1.5` — a 0.1 delta from spec. Recorded per the stage's explicit
  accepted-divergence note.

