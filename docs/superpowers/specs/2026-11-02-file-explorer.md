# Built-in file explorer — clickable paths, in-app viewer

Status: AGREED 2026-11-02 — layout A (side dock). Overlay-with-tabs (B) and
inline expand (C) were rejected.

**Design sources — the implementation is a transcription of these, not an
interpretation:**
- `docs/screens/explorer/mockup.html` — the design contract (loads the real
  `tokens.css`, no hex literals, both themes; window 1 is interactive).
- `docs/screens/explorer/contract.md` — every region translated into existing
  primitives + exact Tailwind classes, icons, constants, hooks, visual-registry
  rows.

Owner decisions (2026-11-02): code viewer = **CodeMirror 6**; tree starts at the
**session folder, "up" allowed** (never above home); the transcript/explorer
split is **remembered per session**. The panel is named **Explorer** because
the Artifacts panel already has a "Files" tab.

## Problem

The agent constantly names files — `src/server/peek.mjs:28`, `~/notes/x.md`,
`/home/dev/projects/foo/AGENTS.md` — and today none of them can be opened from
the transcript. The transcript autolink work (2026-10-29) deliberately left
file paths out of scope. The terminal's absolute-path click is a known dead
control (`peekRemoteFile`, flagged in AGENTS.md "NEVER STUB A CONTROL"). To read
a file the user has to SSH in or ask the agent to `cat` it.

## Goals

1. Every real file path shown in a transcript is a link; clicking opens it in Manta.
2. A file viewer: syntax-highlighted code with line numbers, the referenced
   line(s) highlighted and scrolled into view.
3. Markdown files viewable **rendered** and as **source**, toggleable.
4. **Copy** (contents; path variants on secondary action) and **Download** on
   every file, each with visible confirmation or a visible error.
5. A browsable tree rooted at the session's folder, with quick-open —
   **hidden by default**.
6. **⌘B hides / shows the left sidebar** app-wide.
7. A **resizable split** between transcript and files.
8. An **expanded** mode where the file fills the window.

## Non-goals (v1)

- Editing, rename, delete, create, upload-into-tree. Read-only.
- The native iOS client (separate follow-up; the server contract is shared).
- Files outside the user's home directory (same scope as `/api/peek`).
- Paths inside fenced code blocks and unified diffs (follow the autolink
  spec's exclusion; revisit after v1).
- Live file watching (see "Freshness").

## User-visible behaviour

### Path links

- **Detected forms**: absolute (`/home/…`), home (`~/…`), relative with at least
  one `/` (`src/server/peek.mjs`, `./x.ts`, `../y/z.md`), and a bare filename
  only when it is the whole content of an inline-code span **and** the file
  exists in the session folder (`` `AGENTS.md` ``). Optional suffix `:L`,
  `:L:C`, `:L-M`, `#L12` → line target.
- **Resolution**: relative paths resolve against the **session's working
  directory** (the chat window's cwd / worktree), not the box home.
- **A link only appears once the box confirms the path exists and is inside
  home.** Unconfirmed / missing / outside-home paths stay plain text — no dead
  links. Confirmation is one batched request per rendered message (see
  `fs:resolve-paths`), cached per session for the life of the panel and
  invalidated when an Edit/Write/Bash tool completes.
- **Where**: assistant prose, inline code, the user's own bubble, tool card
  headers (Read / Edit / Write / Glob / Grep file paths), tool output lines,
  todo items — the same surfaces `Linkified` already covers for URLs.
- **Style**: mono, accent colour, dotted underline; solid on hover; the path
  currently shown in the viewer gets an active outline.
- **Hover** (400 ms): card with name, type, lines, size, modified time, first
  3 lines around the target, and Copy / Download.
- **Click** → open in the Explorer (opening it if closed). **⌘-click** → open
  and expand. A directory path opens the tree at that folder.

### Layout

The window is: left sidebar · transcript · divider · Explorer. The Explorer
uses the same right-hand slot as the Artifacts panel; the two are mutually
exclusive (opening one closes the other). Each has its own toggle in the
session header (Artifacts ⌘I, unchanged; Explorer ⌘E). The Artifacts panel is
otherwise unchanged except that its mode switch adopts the new `Segmented`
primitive (contract §P1).

**Left sidebar (⌘B).**
- ⌘B (Ctrl+B off macOS) hides / shows the sidebar everywhere in the app, not
  only when the Explorer is open. A sidebar button at the left of the session header
  does the same, so it is never keyboard-only.
- Hidden state is remembered across restarts. ⌘1–9 and ⌥⌘↑/↓ keep working
  while it is hidden. The header leaves room for the macOS window controls
  when the sidebar is gone.
- The freed width is shared by transcript and Explorer in their current
  proportion (the split is stored as a ratio).

**Resizable split.**
- Drag the divider between transcript and Explorer; double-click resets to the
  default (48 % Explorer).
- Minimums: transcript 360 px, Explorer 320 px. Stored as a proportion so it
  survives window resizes and ⌘B.
- **Remembered per session** (owner decision): each session keeps its own
  split ratio, whether its Explorer is open, whether its tree is open, and the
  tree width; persisted across restarts. A session never opened before starts
  with the Explorer closed, the default ratio and the tree hidden.
- Dragging the Explorer past ~85 % of the width snaps into **Expanded**;
  dragging it below 200 px closes it.
- Keyboard: the divider is focusable; ←/→ resize; it has `role="separator"`.

**File tree — hidden by default.**
- A tree button in the Explorer header (and ⌥⌘E) shows it inside the Explorer,
  to the left of the viewer, with its own small divider (width remembered).
- Showing the tree narrows the viewer, never the transcript.
- Opening a file from a link never forces the tree open; when the tree is
  open it reveals the file.

**Expanded.**
- Entered with the expand button in the Explorer header, ⇧⌘E, ⌘-click on a path,
  or the drag snap above.
- The file fills the window to the right of the sidebar (the sidebar keeps its
  own ⌘B state). The transcript folds into a 44 px rail showing a live status
  dot (working / needs you), so a question or approval is never missed.
- Esc, ⇧⌘E, the collapse button (the expand button flips to it) or a click on
  the rail restores the exact split the user had.
- Per session and not persisted: leaving the session or restarting returns to
  the split.

### Viewer

- Top bar (aligned with the session header): tree toggle, root folder name,
  quick open, expand / restore, close.
- File bar: breadcrumb (relative to the tree root, truncating from the left),
  Rendered/Source control (Markdown only), Copy, Download.
- Code: line numbers, highlight + scroll to target range, find-in-file (⌘F while
  the viewer has focus; otherwise ⌘F stays the conversation search), go to line.
- Markdown rendered: same renderer and styling as assistant prose
  (`MarkdownBody`). Relative links to other files navigate inside the viewer;
  relative images load via `/api/peek`; external links open externally. Raw
  HTML inside Markdown is NOT rendered (no `rehype-raw`).
- Rendered/Source choice is remembered (one preference, not per file).
- Footer: language, line count, size, modified time.
- Back / forward history (⌘[ / ⌘]) across opened files; no tabs in A.
- Images / PDF / video reuse the existing `ArtifactPreview` renderers.
- Refusals are explicit states with a Download button: too large (> 25 MiB,
  existing `MAX_PREVIEW_BYTES`), binary, no longer exists, permission denied.

### Tree

- Rooted at the session's working directory (owner decision). An "up to parent
  folder" button moves the root one level up, as far as the home directory and
  never above it (disabled there, with the reason in its tooltip). Path links
  outside the current root still open; the tree re-roots to the nearest
  ancestor that contains them only when the tree is open.
- Lazy-loaded per folder; dot-files hidden by default (toggle); git-ignored
  entries shown dimmed and collapsed (so `node_modules` is visible but never
  auto-expanded or searched).
- Git status badges (M / A / D / ?) from `git status --porcelain` for the root.
- Filter box filters loaded nodes; **⌘P quick open** searches the whole root
  via the same file search the composer's `@` typeahead uses.
- Revealing a file from a path link expands and scrolls the tree to it.

### Copy / Download

- Copy icon: copies file **contents** (text files only; disabled with a reason
  for binary / too-large). Icon flips to a check for 1.5 s; failure → error
  toast. Secondary (right-click / ⌥-click / menu): Copy path, Copy relative path.
- Download: `saveToDownloads` (`src/renderer/downloadFeedback.ts`) — desktop
  saves to `downloadsDir` and toasts the full destination + Reveal; failure
  toasts that the file is still on the box. Non-destructive (source untouched).

### Keyboard

⌘B sidebar · ⌘E toggle Explorer · ⇧⌘E expand / restore · ⌥⌘E toggle tree ·
⌘P quick open (Explorer focused) · ⌘F find in file (viewer focused; otherwise ⌘F
stays conversation search) · ⌘L go to line · ⌘[ / ⌘] back / forward ·
⇧⌘V rendered ↔ source · Esc leaves Expanded, else returns focus to the
transcript. Off macOS ⌘ = Ctrl. (⇧⌘M is voice; ⌘N/T/K/F/I and ⌘1–9 are taken.)
All window-scoped in `App.tsx`, except find / go-to-line which belong to the
focused viewer.

## Contract

### Server (`src/server/files.mjs`, pure + injected I/O, tested)

All paths are resolved with the SAME home-scope rule as `/api/peek`
(extract the guard from `peek.mjs` into one shared helper; no second copy).
`~` expanded at the edge; symlinks resolved with `realpath` before the home
check (closes the escape a symlink inside home → `/etc` would open).

| Channel | Input | Output |
|---|---|---|
| `fs:resolve-paths` | `{ base: string, paths: string[] }` (≤ 200) | `{ results: Array<{ input, abs, kind: "file"\|"dir", size, mtimeMs } \| { input, missing: true }> }` — outside-home and missing both come back `missing` |
| `fs:list` | `{ dir: string, root: string }` | `{ dir, entries: Array<{ name, kind: "file"\|"dir"\|"symlink", size, mtimeMs, hidden, ignored }>, truncated }` (cap 5 000 entries) |
| `fs:git-status` | `{ root: string }` | `{ branch, changes: Record<relPath, "M"\|"A"\|"D"\|"R"\|"?"> }` or `{ supported:false }` for non-git |
| `fs:find` | `{ root, query, limit }` | reuse opencode's file search (`opencodeFindFiles`) — no new indexer |

Bytes: existing `GET/HEAD /api/peek` (range, size guard). The classifier for
"binary" sniffs the first 8 KiB (NUL byte / invalid UTF-8) client-side after a
ranged GET, so no new route.

Error bodies: class 1 (user-visible) per BET-1460 — `respondSafe500`.

### Renderer

- `src/renderer/pathLinks.ts` — pure detection: `findPathCandidates(text)` →
  `{ start, end, raw, path, line?, endLine? }[]`. Pure, tested. Shares
  boundary/punctuation rules with `linkify.ts`; URLs win when both match.
- `src/renderer/usePathResolution.ts` — batches candidates per message into
  `fs:resolve-paths`, caches per session, invalidates on tool completion frames.
- `Linkified` gains an optional resolved-path map and renders `FileLink`
  (the one anchor for file paths, mirroring `ExternalLink`).
- `src/renderer/explorer/` — `ExplorerPanel.tsx`, `ExplorerTree.tsx`,
  `ExplorerViewer.tsx`, `CodeViewer.tsx` (CodeMirror), `prismHighlight.ts`
  (Prism theme → CodeMirror highlight style adapter, pure + tested),
  `layout.ts` (the constants in contract §Constants), `explorerStore.ts`
  (open file, history, per-session layout).
- `src/renderer/Segmented.tsx` — new primitive (contract §P1), adopted by the
  Artifacts panel mode switch in the same PR.
- Layout state, persisted to `localStorage` (device-local): app-wide
  `manta:sidebarHidden`; per session `manta:explorer:<sessionId>` =
  `{ ratio, open, treeOpen, treeWidth }`. `expanded` is per session, in memory
  only. The Rendered/Source preference is app-wide.
- The Artifacts panel keeps its own width code and slot (out of scope).
- Opening a file is a store action `openFile({ abs, line?, endLine? })` so path
  links, tree, quick open and artifacts all go through one entry point.
- `peekRemoteFile` (terminal absolute-path click) is re-pointed at `openFile`,
  fixing the outstanding dead control.

## Libraries considered

Numbers pulled from the npm registry on 2026-11-02.

| Need | Chosen | Considered / why not |
|---|---|---|
| Tree component | **@headless-tree/react** 1.8.0 (MIT, 0 deps, ~841k/wk, published 2026-10-15) — headless, keyboard + ARIA, async children, works with our own rows and virtualization | **react-arborist** 4.0.1 (MIT, 3 deps, ~825k/wk) — capable, but ships its own styled rows + react-window virtualization; harder to match the design system. **react-complex-tree** 2.6.4 (~71k/wk) — smaller adoption |
| Code viewer (large files, line numbers, find, go-to-line, range highlight) | **CodeMirror 6** read-only (owner decision) via **@uiw/react-codemirror** 4.25.12 (MIT, ~6.6M/wk; `@codemirror/view` 6.43 ~22M/wk, `@codemirror/state` ~22M/wk, `@codemirror/search` 6.7 ~15M/wk) with `basicSetup` off and only the extensions in contract §E6 — virtualized rendering handles 10k+ line files | **prism-react-renderer** (already used by `CodeBlock`, ~7.1M/wk, last publish 2024-12) — no virtualization, no search; stays for transcript snippets. **shiki** 4.6.0 (~36M/wk) — renders full HTML (no virtualization), adds a WASM/grammar payload |
| Language detection + grammars for the viewer | **@codemirror/language-data** 6.5.2 (MIT, ~3.6M/wk) — `LanguageDescription.matchFilename`, grammars lazy-loaded | a hand-written extension → language map (duplicates what the package maintains) |
| Syntax colours in the viewer | **@lezer/highlight** 1.2.5 (MIT, ~21M/wk) `HighlightStyle`, fed from the existing `prism-react-renderer` theme objects (`vsDark` / `github`) by a small adapter, so files and transcript code blocks colour identically | a CodeMirror theme package (e.g. one-dark) — would make file colours differ from transcript code blocks; new hand-picked colours — would need new tokens |
| Markdown rendering | **react-markdown** + **remark-gfm** (already in deps, via `MarkdownBody`) — one look for prose and files | **rehype-raw** — rejected: renders arbitrary HTML from files on the box into the app origin. **mermaid** (~24M/wk, 23 deps) — deferred to v2 |
| Quick open search | opencode's existing file search (`opencodeFindFiles`) + **cmdk** (already in deps) for the palette | **fuzzysort** (~19M/wk) — not needed; ranking already comes from opencode |
| Gitignore awareness | `git check-ignore --stdin` / `git status --porcelain --ignored` (git is already required) | **ignore** 7.0.14 (~417M/wk) — would re-implement git's own precedence rules (nested `.gitignore`, `info/exclude`, global excludes); git is authoritative |
| Resizable split, collapse, snap, persistence, keyboard resizing | **react-resizable-panels** 4.16.1 (MIT, 0 deps, ~29M/wk, published 2026-11-01) — collapsible panels, min sizes and an accessible keyboard separator out of the box; per-session persistence is ours (one `localStorage` key per session) | Copying the Artifacts panel's hand-rolled drag code — no keyboard support, no collapse/snap, and it would need a second copy for the tree divider. **allotment** (VS Code's split view) — heavier, CSS-in-JS-free but less adopted in React apps. Pixel minimums: if the v4 API only takes percentages, convert px→% on container resize (one small effect) |
| File watching | none in v1 — refresh on open / focus / tool-completion frames | **chokidar** 6 (~274M/wk), **@parcel/watcher** (~58M/wk) — real watchers on a box with many worktrees cost inotify handles; event-driven refresh covers the agent-changed-a-file case |
| Path detection | own code (`pathLinks.ts`) | No maintained library detects filesystem paths in prose; `linkify-it` (already used) is URL-only. Rules are small and share boundary logic with `linkify.ts` |
| Download / copy feedback | existing `saveToDownloads`; copy via `IconButton` + toast | `CopyButton` — swallows clipboard failures (a silent control, banned by AGENTS.md); not reused |
| Hover card positioning | existing `Popover` primitive + `POPOVER_SURFACE` | floating-ui — `Popover` already solves portal + fixed positioning in this app |
| Segmented control | new `Segmented` primitive lifted from the Artifacts mode switch | a library segmented control — the chrome is ours and already exists in two places |

## Freshness

The viewer re-fetches the open file when: it is opened, the window regains
focus, or a tool that can write files (Edit, Write, Bash, apply_patch) completes
in that session. The tree re-lists open folders on the same triggers. A changed
file shows a quiet "updated" pill rather than jumping scroll.

## Security

- Every server read goes through the one home-scope + `realpath` guard.
- Markdown never executes HTML; links are http(s)/relative only; relative image
  loads stay on `/api/peek` with the bearer token.
- No write routes are added.

## Tests (must exist and pass)

- `pathLinks.test.ts`: absolute / `~` / relative / `./` `../`; line suffixes
  (`:12`, `:12:4`, `:12-30`, `#L12`); trailing punctuation; paths inside URLs
  not double-matched; bare filename only in whole inline-code span; no match in
  fenced code.
- `files.test.mjs`: home guard incl. symlink escape, `..` escape, `~`;
  `resolve-paths` batching cap; `list` cap + hidden/ignored flags; git-status on
  a non-git dir → `supported:false`.
- Layout: ⌘B toggles and persists app-wide; split ratio / open / tree state
  persist PER SESSION (two sessions keep different ratios) and clamp to the
  minimums; double-click resets; drag past the snap point expands; drag below
  200 px closes; Esc / rail restores the previous ratio; tree hidden for a new
  session; Expanded is not persisted; Explorer and Artifacts are mutually
  exclusive.
- `prismHighlight.test.ts`: every Prism type in the table maps; colours equal
  the Prism theme's; theme flip swaps the style.
- Tree root: "up" stops at home (button disabled with reason); a link outside
  the root opens and re-roots only when the tree is open.
- Design: the visual-registry rows in contract §Visual registry exist and
  `npm run visual:compare` has been run for each; differences recorded in
  `docs/screens/explorer/conformance.md`. Both themes checked.
- Component: path link renders only after resolution; missing path stays text;
  click opens viewer at the line; Rendered/Source toggle; Copy shows check +
  writes clipboard; Copy disabled with reason for binary; Download calls
  `saveToDownloads`; too-large / binary / missing states each offer the right
  action; terminal absolute-path click opens the viewer.

## Phasing

1. Layout shell: ⌘B sidebar, header toggles, Explorer slot on
   react-resizable-panels, per-session split, Expanded mode + transcript rail,
   `Segmented` primitive (+ Artifacts adoption).
2. Server channels + path detection + `FileLink` + viewer (code + markdown,
   copy/download) opened from transcript links.
3. Tree (hidden by default), git badges, quick open, history.
4. Hover card, terminal path click.

## Open questions

None blocking. Implementers flag (not silently build) anything the contract
does not cover.
