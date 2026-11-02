# Built-in file explorer — clickable paths, in-app viewer

Status: AGREED 2026-11-02, revised after the GPT-6 Astra spec review (same day).

**Design sources — the implementation is a transcription of these, not an
interpretation:**
- `docs/screens/explorer/mockup.html` — design contract (loads the real
  `tokens.css`, no hex literals, both themes; window 1 is interactive).
- `docs/screens/explorer/contract.md` — every region as existing primitives +
  exact Tailwind classes, icons, constants, hooks, visual-registry rows.
Spec (this file) owns behaviour; contract owns chrome; mockup wins on looks.

Owner decisions (2026-11-02): side dock layout (A); **CodeMirror 6** viewer;
tree starts at the **session folder, "up" allowed** (never above home);
split remembered **per session**; tree **hidden by default**; **⌘B** hides the
sidebar; **expanded** mode is important. Named **Explorer** (the Artifacts
panel already has a "Files" tab).

## Problem

The agent constantly names files — `src/server/peek.mjs:28`, `~/notes/x.md`,
`/home/dev/projects/foo/AGENTS.md` — and none can be opened from the transcript.
The terminal's absolute-path click is a known dead control (`peekRemoteFile`,
AGENTS.md "NEVER STUB A CONTROL"). To read a file the user has to SSH in or ask
the agent to `cat` it.

## Scope

### In v1
1. File paths in **chat** transcripts become links once the box confirms they
   exist inside home (surfaces listed under "Path links").
2. Explorer panel for chat sessions: read-only CodeMirror viewer, Markdown
   Rendered/Source, images/video inline, copy + download, empty/loading/error
   states.
3. Tree (hidden by default) rooted at the session folder, "up" to home, git
   badges, filter, quick open.
4. Resizable per-session transcript/Explorer split; Expanded mode with a
   transcript rail.
5. ⌘B hides/shows the left sidebar app-wide, with a restore control that is
   always visible.
6. Terminal absolute-path click opens the file in the EXISTING artifact preview
   overlay (fixes the dead control; terminal windows get no Explorer in v1).
7. One shared canonical-home file-access policy for `/api/peek`,
   `/api/download` and the new channels.

### Deferred (v2) — do not build
Hover preview card; drag-to-expand / drag-to-close snaps; links inside tool
OUTPUT lines (grep/glob results) and fenced code; Explorer in terminal / CTO /
routines / draft panes; folder-level git roll-ups; file watching; editing;
iOS client.

## User-visible behaviour

### Path links

- **Detected forms** (`src/renderer/pathLinks.ts`, pure): absolute (`/…`), home
  (`~/…`), relative containing at least one `/` (`src/a.ts`, `./x.ts`,
  `../y/z.md`). A bare filename (`AGENTS.md`) only when it is the **entire**
  content of an inline-code span. Optional suffix `:L`, `:L:C`, `:L-M`, `#L12`
  → line target. URLs always win over paths (a path inside a URL is not a path).
  Trailing sentence punctuation excluded, same rules as `linkify.ts`.
- **Surfaces in v1:**
  - assistant Markdown prose — a remark plugin beside the existing
    `remarkLinkifySchemeless` that turns path candidates in `text` nodes into
    `link` nodes with a `manta-file:` URL; the `a` renderer maps that scheme to
    `FileLink`. Text in `link`, `inlineCode`, `code`, `html` nodes is skipped
    (same `NO_LINKIFY` set);
  - inline code — the existing `code` override: when the WHOLE span is a path
    candidate it renders as `FileLink` inside the `<code>`;
  - the user's own bubble (`Linkified` gains path support);
  - tool card headers for tools with a structured file path input
    (Read / Edit / Write / MultiEdit / apply_patch / List): the path comes from
    the tool INPUT (no text detection), via a new `ToolCard` `argPath` slot
    (contract E10).
- **Resolution:** relative paths resolve against the **session's cwd** (the
  chat window's working directory; for a subagent's child transcript, the
  child session's directory). A link appears **only** after `fs:resolve-paths`
  reports the path exists, is a regular file or directory, and its canonical
  path is inside home. Anything else renders exactly as today (plain text /
  plain inline code) — never a disabled-looking link.
- **Batching & cache** (`usePathResolution`): candidates collected per rendered
  message, debounced 150 ms, chunked ≤ 200 paths per request, ≤ 2 requests in
  flight per session. Cache key `(sessionId, cwd, rawPath)` → result +
  `generation`. A reply whose generation or session no longer matches is
  discarded.
- **Invalidation:** bump the session's generation (re-resolve visible
  candidates) when, for that session or any of its child sessions, a tool run
  of a file-changing tool (`edit`, `write`, `multiedit`, `patch`,
  `apply_patch`, `bash`, `shell`) reaches a terminal state, and on every
  `resync` frame. Implementer pins the exact frame fields from `useSseBus.ts`
  and documents them in the hook.
- **Click** → open in this session's Explorer (opening it). **⌘-click** → open
  and Expand. A directory path opens the tree (forcing it open) at that folder.
  `stopPropagation` like `ExternalLink`.
- **Ownership:** every open carries an explicit owner
  `{ sessionId, cwd }` captured at render time — never "whatever session is
  active when the async resolution finishes".

### Layout

Window = sidebar · transcript · separator · Explorer (chat sessions only).

**Right slot — Explorer vs Artifacts (mutually exclusive):**
- Explorer open state is **per session**; Artifacts open state stays global
  (unchanged `manta:artifacts:open`).
- Shown: Explorer if this session's Explorer is open; else Artifacts if
  Artifacts is open; else nothing.
- Opening Explorer (toggle, ⌘E, any path click) sets this session's Explorer
  open AND Artifacts closed. Opening Artifacts (toggle, ⌘I, the
  `manta-open-review` event) sets Artifacts open AND this session's Explorer
  closed. One store action owns both: `setRightPanel(sessionId, "explorer" |
  "artifacts" | "none")`; every existing Artifacts opener is routed through it.
- Closing Explorer shows nothing (it does not restore Artifacts).
- Artifacts keeps its own preview overlay; artifact rows do NOT open in
  Explorer in v1.

**Left sidebar (⌘B / Ctrl+B):**
- App-wide, persisted (`manta:sidebarHidden`), works on every pane (chat,
  terminal, CTO, routines, drafts, settings excluded).
- The toggle is ONE always-visible button pinned at the window's top-left
  (right of the macOS traffic lights; at the left edge elsewhere). When the
  sidebar is visible it sits in the sidebar's top drag strip; when hidden it
  floats over the main area at the same position. So a restore control exists
  in every pane and in Expanded mode.
- While hidden, the main area sets a CSS variable `--sidebar-hidden-inset`
  (macOS 112 px, other platforms 40 px; `0px` when the sidebar is shown) and
  every pane's top bar uses `padding-left: max(<own padding>,
  var(--sidebar-hidden-inset))`: SessionHeader, terminal pane header, CTO
  header, Routines header, NewSessionScreen header, Explorer top bar in
  Expanded mode (minus the 44 px rail). On macOS the padded strip stays a
  `titlebar-drag` region.
- ⌘1–9, ⌥⌘↑/↓ keep working while hidden. Slide uses `--motion-slow` +
  `--ease-out`; the hidden sidebar is `inert`.

**Resizable split** (`react-resizable-panels` v4: `Group` / `Panel` /
`Separator`, `orientation="horizontal"`):
- Explorer default `"48%"`; transcript `minSize={360}`, Explorer
  `minSize={320}` (numbers are pixels in v4).
- **Per session** (owner decision): `manta:explorer:<sessionId>` =
  `{ open, ratio, treeOpen, treeWidth }`, written on layout change (debounced
  250 ms). A session never seen starts closed / default ratio / tree hidden.
- Double-click on the separator resets to the default. Keyboard: focus the
  separator, ←/→ (library behaviour). No drag snaps in v1.
- **Narrow window:** if the content width is < 680 px (both minimums) when the
  Explorer is opened or the window shrinks, the Explorer shows in Expanded mode
  automatically; when the width allows again it returns to the split.

**Tree — hidden by default:**
- Toggle in the Explorer top bar and ⌥⌘E. Width `clamp(stored, 140,
  explorerWidth − 200)`; the viewer never gets narrower than 200 px. If the
  Explorer is narrower than 340 px the tree toggle is disabled with the title
  "Widen the explorer to show the tree".
- Opening a file from a link never forces the tree open; when open, it reveals
  and selects the file (re-rooting only if the file is outside the current
  root — to the nearest ancestor that is inside home).

**Expanded:**
- Explorer top-bar button, ⇧⌘E, or ⌘-click on a path.
- The transcript Panel collapses; the Explorer fills the content width; the
  transcript folds to a 44 px rail with a status dot: **needs you** (pending
  question/permission) > running > idle.
- Restore: Esc (only when nothing else consumed it — see Keyboard), ⇧⌘E, the
  restore button, or clicking the rail. Restores the exact previous ratio.
- Per session, in memory only.

### Explorer panel

- **Top bar** (44 px, aligned with the session header): tree toggle, root
  folder name, quick open, expand/restore, close.
- **Empty** (no file opened yet this session): centred message "Click a file
  path in the conversation, or open the tree" + a "Show tree" button.
- **File bar:** breadcrumb relative to the tree root (truncates from the left),
  Rendered/Source (`Segmented`, Markdown only), Copy contents, Download, and a
  "More" menu (Copy path, Copy relative path).
- **Code:** CodeMirror 6 read-only — line numbers, target line(s) highlighted
  and scrolled to ~⅓ from the top, find (⌘F while the viewer has focus), go to
  line (⌘L). Language by filename (`@codemirror/language-data`). Syntax colours
  from the prism-react-renderer themes the transcript uses.
- **Markdown:** Rendered via `MarkdownBody` (unchanged look) or Source in
  CodeMirror. Preference app-wide (`manta:explorer:mdView`). A link with a line
  target opens Source at that line regardless of the preference (without
  changing it). Files > 50 000 chars open in Source with a note "Large file —
  showing source". Relative links to files navigate the Explorer (resolved
  against the Markdown file's directory, through `fs:resolve-paths`); `#frag`
  scrolls to the heading; `http(s)` opens externally; any other scheme renders
  as plain text. Relative images load through an authenticated fetch of
  `/api/peek` (Bearer header) into a blob URL, max 10 MiB each, revoked on
  unmount; external images render as their alt text link (CSP blocks them
  anyway). Never put the token in a URL.
- **Images / video:** inline, via a media body extracted from
  `ArtifactPreview` (the overlay keeps working unchanged). **PDF:** a centred
  "Open preview" button that opens the existing `ArtifactPreview` overlay for
  that path (no new PDF path in v1).
- **Footer:** language · lines · size · `Ln N` when targeted, else modified
  time.
- **Loading:** after 150 ms with no response, the existing `Skeleton` in the
  viewer body. **Fetch failure:** "Couldn't load this file" + Retry button.
- **Refusals** (each with its visible state, contract E12): too large
  (> `MAX_PREVIEW_BYTES` 25 MiB) → Download; binary → Download; missing → no
  action; permission → no action; empty file → "Empty file" line.
- **Freshness:** re-fetch the open file and re-list expanded folders when the
  window regains focus or on the same invalidation as path links. If the
  content changed, keep the scroll position and show a quiet "Updated" pill in
  the file bar for 3 s.
- **History:** back / forward (⌘[ / ⌘]) across files opened in this session's
  Explorer, in memory.

### Tree

- Root = session cwd; "Up to <parent>" moves the root one level up, disabled
  at home with title "Already at your home folder".
- `fs:list` per folder, lazy; entries sorted: folders first, then
  case-insensitive natural order. Dot-files are shown (dimmed like ignored);
  `.git` is never listed. Git-ignored entries `text-text-faint`, never
  auto-expanded.
- Symlinks: followed only if their canonical target is inside home; otherwise
  shown, not expandable/openable, title "Links outside your home folder".
- Large folders: first 2 000 entries, then a final row "N more not shown — use
  quick open (⌘P)".
- Filter box filters the loaded rows (case-insensitive substring).
- **Git badges** (`fs:git-status`, 3 s timeout, non-git → no badges):
  `git -C <root> status --porcelain=v1 -z` mapped to the tree root
  (`--show-toplevel` prefix stripped). `??`→`?` faint; `A`/rename target →`A`
  ok; any `M`/`T` →`M` warn; conflicts (`U`, `AA`, `DD`) →`!` danger. Deleted
  files are not listed (they aren't on disk). Nested repos and worktrees: the
  repo that contains the root.
- **Quick open (⌘P, Explorer focused):** `PaletteShell`, searching the
  **session folder** via the existing `opencodeFindFiles({query, directory})`
  (≤ 50 results, relative strings); Enter opens. Errors show in the palette
  footer.

### Copy / Download

- Copy contents: IconButton; success → glyph becomes a check (`text-ok`) for
  1.5 s with label "Copied"; failure → error toast "Couldn't copy — the
  clipboard is unavailable". Disabled (with reason in title) for binary,
  too-large, empty-not-loaded.
- More menu (`Dropdown`): Copy path (absolute), Copy relative path (to the
  session cwd). Same success/failure feedback (toast "Path copied").
- Download: `saveToDownloads(absPath)` — its toasts are the whole UI.

### Keyboard

| Key | Scope | Action |
|---|---|---|
| ⌘B | window | sidebar |
| ⌘E | chat session | toggle Explorer |
| ⇧⌘E | Explorer open | expand / restore |
| ⌥⌘E | Explorer open | toggle tree |
| ⌘P | focus inside Explorer | quick open |
| ⌘F | CodeMirror focused | find in file (CodeMirror preventDefaults; App's conversation ⌘F handler must return early on `e.defaultPrevented`) |
| ⌘L | CodeMirror focused | go to line |
| ⌘[ / ⌘] | focus inside Explorer | back / forward |
| ⇧⌘V | focus inside Explorer, Markdown | Rendered ↔ Source |
| Esc | Explorer | closes (in order) CodeMirror search, menus/palette, then Expanded; App checks `defaultPrevented` |

Off macOS ⌘ = Ctrl. Taken already: ⇧⌘M voice, ⌘N/T/K/F/I, ⌘1–9, ⌥⌘↑↓, ⌘,.
xterm must pass ⌘B through (its custom key handler returns false for it).

## Contract

### Shared file-access policy (`src/server/homePath.mjs`, new, pure + injected fs)

ONE helper used by `/api/peek`, `/api/download` and every `fs:*` channel (the
lexical checks in `peek.mjs` and the download route are replaced by it):

- `resolveInHome(raw, { base? })` → `{ ok:true, abs, canonical, stat }` or
  `{ ok:false, reason }`. Steps: expand `~`; resolve against `base` (must
  itself pass); `realpath` (canonical); compare with `realpath(homedir())` —
  inside means `canonical === home || canonical.startsWith(home + "/")`.
- `openInHome(raw)` for byte access: resolve → `open(canonical, O_RDONLY |
  O_NOFOLLOW | O_NONBLOCK)` → `fstat(fd)` must be a regular file and its
  `dev/ino` must equal the `stat` from resolve (else `reason:"changed"`, retried
  once). Reads stream from that fd. Non-regular files (FIFO, socket, device) →
  `not-file`.
- Threat model (write it in the module header): the client is authenticated;
  the guard keeps reads inside home and stops symlink escapes; an attacker who
  can create symlinks in home already has a shell as the user, so the
  identity check is proportionate.
- `reason` ∈ `missing | outside-home | not-file | permission | changed |
  too-large | unavailable`.

### Server channels (`src/server/files.mjs`, wired in `rpc.mjs` + `src/shared/api.ts` + `httpApi.ts`)

Expected outcomes are RETURNED, never thrown; unexpected errors throw a fixed
safe message ("file system error") after `console.warn` (class 1, BET-1460).

| Channel | Input | Output |
|---|---|---|
| `fs:resolve-paths` | `{ base: string, paths: string[] }` (≤ 200; more → `invalid_input`) | `{ results: Array<{ input, ok:true, abs, kind:"file"\|"dir", size, mtimeMs } \| { input, ok:false, reason }> }` |
| `fs:list` | `{ dir: string, limit?: number }` (default/max 2000) | `{ ok:true, dir, entries: Array<{ name, abs, kind:"file"\|"dir"\|"link-outside", size, mtimeMs, hidden, ignored }>, total, truncated }` or `{ ok:false, reason }` |
| `fs:git-status` | `{ root: string }` | `{ ok:true, changes: Record<pathRelativeToRoot, "M"\|"A"\|"?"\|"!"> }` or `{ ok:false, reason:"not-git"\|"timeout"\|… }` |

Quick open reuses `opencode:find-files` unchanged. `ignored` comes from one
`git check-ignore --stdin -z` call per listing (skipped outside git).

### HTTP routes (existing, behaviour change)

`GET/HEAD /api/peek` and `GET /api/download` switch to `openInHome`. Error
mapping: `missing` 404, `outside-home` 403, `not-file` 404, `permission` 403,
`changed`/`unavailable` 503 — body `{ error: <safe literal>, reason }`. The
viewer maps `reason` to its states. HEAD gives size; the viewer GETs the body
only when ≤ 25 MiB and stops reading at 25 MiB + 1 byte (file grew → too
large). Binary = a NUL byte in the first 8 KiB, or `TextDecoder("utf-8",
{fatal:true})` failing on the whole body. Empty file → "Empty file".

### Renderer modules

- `src/renderer/pathLinks.ts` — detection (pure).
- `src/renderer/usePathResolution.ts` — batching, cache, invalidation.
- `Linkified.tsx` — `FileLink` (sibling of `ExternalLink`) + path support.
- `MarkdownBody.tsx` — remark plugin + `manta-file:` link mapping + optional
  `fileContext` prop (`{ owner, fileDir }`) for Explorer-rendered Markdown
  (relative link/image resolution).
- `src/renderer/explorer/` — `ExplorerPanel.tsx`, `ExplorerTree.tsx`,
  `ExplorerViewer.tsx`, `CodeViewer.tsx`, `prismHighlight.ts` (pure adapter),
  `MediaBody.tsx` (extracted from ArtifactPreview), `layout.ts` (constants),
  `explorerStore.ts` (per-session layout, open file, history, `openFile`,
  `setRightPanel`).
- `src/renderer/Segmented.tsx` — primitive (contract P1), adopted by the
  Artifacts mode switch.
- `src/renderer/SidebarToggle.tsx` — the pinned ⌘B control.
- `Terminal.tsx` / `httpApi.peekRemoteFile` — absolute-path click opens the
  existing `ArtifactPreview` overlay for that path (via a window event the App
  handles), replacing the dead RPC no-op.

## Libraries considered

Numbers from the npm registry, 2026-11-02. React is 18.3.

| Need | Chosen | Considered / why not |
|---|---|---|
| Tree | **@headless-tree/react** 1.8.0 + peer **@headless-tree/core** (MIT, 0 deps, ~841k/wk, published 2026-10-15) — headless, keyboard + ARIA, async children; no virtualization in v1 (2 000-row cap per folder) | **react-arborist** 4.0.1 (MIT, 3 deps, ~825k/wk) — ships its own styled rows + react-window; harder to match the design system. **react-complex-tree** 2.6.4 (~71k/wk) — smaller adoption |
| Code viewer | **CodeMirror 6** (owner decision) via **@uiw/react-codemirror** 4.25.12 (MIT, ~6.6M/wk) with `basicSetup={false}`; `@codemirror/view` 6.43 (~22M/wk), `@codemirror/state` 6.7 (~22M/wk), `@codemirror/search` 6.7 (~15M/wk), `@codemirror/language` (`HighlightStyle`) | **prism-react-renderer** (in deps, ~7.1M/wk, last publish 2024-12) — no virtualization or search; stays for transcript blocks. **shiki** 4.6.0 (~36M/wk) — full HTML, no virtualization, WASM payload |
| Grammars | **@codemirror/language-data** 6.5.2 (MIT, ~3.6M/wk) — `LanguageDescription.matchFilename`, lazy chunks (local, CSP-safe) | hand-written extension map — duplicates the package |
| Syntax colours | **@lezer/highlight** 1.2.5 (MIT, ~21M/wk) tags, fed from the existing prism themes (`vsDark`/`github`) by `prismHighlight.ts` | a CodeMirror theme package — colours would differ from transcript code blocks; new colours would need new tokens |
| Markdown | **react-markdown** + **remark-gfm** (in deps, via `MarkdownBody`) | **rehype-raw** — rejected: renders arbitrary HTML from box files; **mermaid** — v2 |
| Quick open | existing `PaletteShell` + `opencodeFindFiles` | **fuzzysort** (~19M/wk) — ranking already from opencode |
| Gitignore / status | `git status --porcelain=v1 -z`, `git check-ignore --stdin -z` (git already required) | **ignore** 7.0.14 (~417M/wk) — would re-implement git's precedence rules; git is authoritative |
| Split | **react-resizable-panels** 4.16.1 (MIT, 0 deps, ~29M/wk, published 2026-11-01) — `Group`/`Panel`/`Separator`, pixel minimums, keyboard separator; per-session persistence is ours | copying the Artifacts panel's hand-rolled drag code — no keyboard, no collapse; **allotment** — less adopted in React |
| Hover-card / menu positioning | existing `Popover`, `Dropdown` | floating-ui — `Popover` already solves it here |
| Segmented control | new `Segmented` primitive lifted from the Artifacts mode switch | a library control — the chrome is ours and exists twice |
| File watching | none in v1 — focus + tool-completion invalidation | **chokidar** 6 (~274M/wk), **@parcel/watcher** (~58M/wk) — inotify cost across many worktrees |
| Path detection | own (`pathLinks.ts`) | nothing maintained detects filesystem paths in prose; `linkify-it` is URL-only |
| Copy / download feedback | `IconButton` + toasts; `saveToDownloads` | `CopyButton` — swallows clipboard failures (banned silent control) |
| Media in viewer | extracted from `ArtifactPreview` | — |

## Security

- Every file read (peek, download, fs channels) goes through `homePath.mjs`.
- Markdown never renders raw HTML; relative images are fetched with the Bearer
  header into blob URLs; tokens never appear in URLs; external images are not
  loaded.
- No write routes.

## Acceptance tests (must exist and pass)

- `pathLinks.test.ts`: forms, suffixes (`:12`, `:12:4`, `:12-30`, `#L12`),
  punctuation, URL precedence, bare filename only as whole inline code, no
  match in fenced code.
- `homePath.test.mjs` (real tmp dirs): `~`, `..` escape, symlink to outside
  home (file and dir), symlink swapped between resolve and open (`changed`),
  FIFO → `not-file`, EACCES → `permission`, home itself.
- `files.test.mjs`: resolve batching cap; list ordering, cap + `truncated`,
  hidden/ignored, `link-outside`, `.git` excluded; git-status mapping incl.
  rename/conflict, non-git, timeout, nested root.
- peek/download route tests updated for the new reasons/statuses.
- `usePathResolution` tests: debounce/chunk/concurrency, stale reply discarded
  on session switch, missing→created after an edit tool completes,
  deleted→unlinked.
- `prismHighlight.test.ts`: every mapped Prism type; colours equal the theme's.
- Layout tests: ⌘B persists and the pinned toggle exists on chat, terminal,
  CTO and routines panes; per-session ratio/open/tree (two sessions differ);
  Explorer ↔ Artifacts exclusivity incl. `manta-open-review`; narrow window →
  Expanded; Esc precedence; rail priority needs-you > running.
- Component tests: link appears only after resolution; click opens at the
  line; ⌘-click expands; Markdown Rendered/Source, line target → Source, large
  file → Source; relative image fetched with auth header; copy success +
  failure; More menu; refusals; empty/loading/error/retry; terminal path click
  opens the preview overlay.
- Design: visual-registry rows from contract §Visual registry exist;
  `npm run visual:compare` run for each, in both themes; deliberate
  differences in `docs/screens/explorer/conformance.md`.

## Phasing / ownership (parallel implementers, disjoint paths)

Interfaces pinned first (this spec + `src/shared/api.ts` additions +
`explorerStore` API) so the four tracks can run in parallel:

1. **Server** — `homePath.mjs`, `files.mjs`, peek/download migration, `rpc.mjs`
   channels, `src/shared/api.ts`, `httpApi.ts` channel methods, server tests,
   `package.json`/lockfile (all new deps added here, once).
2. **Shell** — `App.tsx`, `Sidebar.tsx`, `SidebarToggle.tsx`, the pane headers'
   inset, `SessionHeader.tsx` toggle, `Segmented.tsx` + ArtifactsPanel
   adoption, `explorer/ExplorerPanel.tsx`, `explorer/explorerStore.ts`,
   `explorer/layout.ts`, Terminal path click → preview overlay, layout tests.
3. **Links** — `pathLinks.ts`, `usePathResolution.ts`, `Linkified.tsx`,
   `MarkdownBody.tsx` (plugin, `manta-file:`, `fileContext`), `ToolCard.tsx`
   `argPath` + its callers, link tests.
4. **Viewer & tree** — `explorer/ExplorerViewer.tsx`, `CodeViewer.tsx`,
   `prismHighlight.ts`, `MediaBody.tsx` (+ ArtifactPreview refactor to use
   it), `ExplorerTree.tsx`, quick open, viewer/tree tests.
5. **Integration** (after 1–4): demo fixtures, visual-registry rows,
   conformance record, end-to-end check.

Nothing ships until every control in the tracks above works (no stubs).
