# File explorer — conformance notes

Compared with `npm run visual:compare -- <id>` (app left, `mockup.html` right) for the
fourteen `explorer-*` rows. Light and dark were both reviewed for `explorer-default`,
`-tree`, `-links` and `-quickopen` (`VISUAL_COLOR_SCHEME=dark`); the rest in light.
Baselines recorded for all fourteen rows. Differences left on purpose or open:

Last reviewed: 2026-11-02 (67b38ac7)

## Deliberate

- **Window chrome and rail content are context, not design.** The mockup draws a window
  frame (traffic lights, a Theme bar) and a sidebar that lists only the projects; the
  app shows the real sidebar (Workspace header, CTO / Routines rows, New session /
  New workspace rows, Settings) and a wider column. The `explorer-default|tree|expanded`
  rows compare the layout of transcript · divider · Explorer, not the sidebar's content.
- **One transcript serves the three windows.** The mockup draws a different, shorter
  turn in each window ("The guard lives in `src/server/peek.mjs:28-30`…"); the demo has
  one session whose turn says `src/server/peek.mjs:28-30` and `docs/peek-scope.md`. The
  `:28-30` range is there so `explorer-tree` highlights lines 28-30 as in the mockup;
  `explorer-default` therefore shows a range where the mockup says `:28`.
- **Tool calls are the app's own grouped row** ("Read a file, edited a file ›"). The mockup
  draws two cards (`Read src/server/peek.mjs · 142 lines`, `Edit src/server/index.mjs:3927`);
  their paths are links in the real expanded card (`argPath`), but the collapsed group is
  what a capture sees.
- **Transcript layout is the app's**: a short turn sits at the bottom of the pane (the
  mockup top-aligns it), the composer placeholder is "Reply, or describe the next task…"
  (mockup: "Message the agent…") and carries the model picker row; a working row ("Brewed
  for 20s") closes the turn.
- **Link text is the full relative path** (`src/server/peek.mjs:28-30`), where the mockup
  abbreviates to `peek.mjs:28`. A bare file name only links when the whole inline code is
  that name and then resolves against the session folder, which would need a second
  `peek.mjs` fixture; the "With a line / range" line of `explorer-links` keeps the full
  path for the same reason. A link that wraps (`…peek.mjs:28-` / `30`) wraps like any text.
- **Tree order and contents.** Folders first in natural order (spec): `node_modules` sorts
  among the folders and is dimmed, where the mockup lists it last; the tree also shows
  `peek.test.mjs` (the quick-open list has it, the mockup's tree omits it).
- **The code view scrolls the target to ⅓ of the real viewport** (900 px tall → line 15 at
  the top for line 28); the mockup crops a fixed 24-line window starting at line 18.
  Footer sizes and line counts equal the mockup's (`peek-scope.md` 18 lines 612 B,
  `peek.mjs` 142 lines 4.8 KB); the age reads `modified 2m ago` where the mockup writes
  `2 min ago`, and a large file reads `5811 lines` where the mockup writes "5,811".
- **Rendered Markdown keeps MarkdownBody's look** (contract E6: component unchanged):
  inline code (`$HOME`, `403`, the table's `/api/peek`) is plain mono; the mockup draws it
  in the accent colour. The only accent-coloured link is the real one at the end.
- **The `peek-scope.md` fixture text differs from the mockup's** to total exactly
  612 B / 18 lines ("symlinks included", "tree too", a longer line 5, `~/` rather than a
  bare `` `~` ``, which Playwright's YAML aria snapshot reads as a null and rejects).
- **Syntax colours come from the transcript's prism themes** (contract); in dark the
  comments are the vsDark green, not the mockup's grey italic.
- **Typography**: the app's copy uses typographic apostrophes ("Couldn’t load this
  file", "Can’t read this file"); the mockup draws straight ones.
- **States and refusals are captured as the viewer body**, not as a tile: the state
  column fills the 568 px viewer pane (the mockup shows four small tiles). The mockup's
  "Loading (Skeleton, after 150 ms)" caption is an annotation and is not drawn. Each
  state is its own row (`explorer-states` empty, `-error`, `-loading`; `explorer-refusal`
  too large, `-binary`, `-missing`, `-permission`) and compares against that tile.
  The error / loading / refusal rows open their file from the `routines-ui` turn, so two
  chat panels are mounted and every popup trigger is listed twice in `surfacesClosed`.
- **Quick open rows are `py-1`** (contract E14, 26 px each); the mockup pads 6 px (33 px).
  The row captures the list wrapper (the shell has no hook), so the input and the footer
  of the mockup's palette are not in the crop.
- **`explorer-links` cannot show every link state at once**: "Hovered" and "Shown in the
  Explorer" are not both reproducible in a single capture, and the mockup's second row
  uses `peek.mjs:28` / `:28-34` (see above). The demo adds a line for a path that
  resolves but is not open.
- **Demo versions**: the `explorer` state reports client and box `1.0.0`. The shared demo
  pair (`0.0.13`) now reads "incompatible" against the wire major 1 and raises the
  blocking banner over every capture; the other states are untouched (see Open).
- **Demo file ages are relative to load time** (not the 2023 `DEMO_T0`), because the
  viewer's footer reads the real clock; "2m ago" holds for about 30 s after load.
- **Narrow row**: at 900×700 the sidebar stays visible and the Explorer opens Expanded
  (the transcript is the rail), as in the mockup's expanded window.

## Open

- Hover and Shown-in-the-Explorer link states, the copy-confirmed button, the More menu
  and the download toast (mockup §8) have no registry row; the `More` trigger's popup is
  therefore unverified.
- The 212 KB `index.mjs` fixture (Large / too-large footer states) is not captured by any
  row.
- `explorer-states*` / `-refusal*` crop the whole viewer body, so their pixel baselines
  are mostly empty space; a hook on the centred column would give a tighter crop.
- The shared demo version pair is "incompatible" on `main` for every other state
  (`supportedMajor` is 1 since the V2 cutover); their baselines predate it.
- Interaction checks that cannot be pixel-compared (scroll to the target on open, the
  ⌥⌘E refusal toast, Esc precedence) are covered by unit tests, not by a row.
