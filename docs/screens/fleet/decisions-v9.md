# Fleet v9: Ended today badges

Mockup: `docs/screens/fleet/mockup-v9.html` (self-contained throwaway mockup; nothing talks to a box).
Only **Ended today** changed. Everything else is exactly as in v8 (`decisions-v8.md`).

> **Ended today will be iterated on later.** The user isn't sure about this section yet; treat its design as provisional.

## Changes

1. **"New" badge removed** from Ended today rows. The section header no longer says "N new since you last looked"
   either, since nothing marks which rows are new; it reads "6 tasks". (This sets aside v5 default 4's "New" markers.)
2. **The outcome is a coloured badge** (a pill with a 1 px border in the same colour), in a **fixed-width column** so
   every title starts at the same x:
   - **Done**: green (`--ok` on `--ok-bg`)
   - **Didn't finish**: red (`--danger` on `--danger-bg`)
   - **Interrupted**: amber (`--warn` on `--warn-bg`)
   - **Stopped by you**: neutral (`--tx2` on `--fill-active`)

   From a list width of 560 px: the badge column is 116 px, then title · agent · project · when · outcome sentence,
   then Open session. Under 560 px the badge sits on its own line above the title, at the same left edge on every row.

## Checks

Every state that shows Ended today (all except loading; the empty state still shows Ended today), in Fleet · Projects,
Fleet · Agents and Details, light and dark, at 420 / 900 / 1280 px, with "Show more" opened:
- no script errors, no sideways scroll, no "New" marker left;
- scripted: in every render, all badges start at one x and all titles start at one x;
- badge text contrast against its tinted background: light 4.57 (Done), 4.83 (Didn't finish), 5.24 (Interrupted),
  7.76 (Stopped by you); dark 8.50, 5.96, 9.85, 8.65.

Screenshots (Fleet views only, since Needs you is unchanged): `~/.manta/agents/product-designer/home/fleet-redesign/shots-v9/<view>-<state>-<width>-<theme>.png`.
