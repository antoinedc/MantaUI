# File explorer — design contract

Companion to `docs/screens/explorer/mockup.html` (the design) and
`docs/superpowers/specs/2026-11-02-file-explorer.md` (the behaviour). This file
translates every region of the mockup into **existing primitives + exact Tailwind
classes**, so the implementation is a transcription, not an interpretation. Where
this file and the mockup disagree, the mockup wins and this file is the bug.

## Rules

Restated from `docs/components.md` and `docs/visual-verification.md` because they
decide review outcomes:

1. **Use the existing primitive** wherever one exists (IconButton, Button, Popover /
   `POPOVER_SURFACE`, Dropdown + MenuItem, OutputWell, StatusDot, PaletteShell,
   MarkdownBody, Toast via `saveToDownloads`). No inline re-implementation of their
   chrome, no `className` escape hatch.
2. **No raw hex, no off-grid spacing.** Spacing from the Tailwind steps
   (`px`=1 `1`=4 `2`=8 `3`=12 `4`=16 `5`=20 `6`=24 `8`=32 …). Type from the roles
   `text-title`(17) `text-prose`(15) `text-body`(14) `text-label`(13) `text-meta`(12)
   `text-micro`(11) `text-code`(13). Dimensions (h-/w-) may use the full scale.
3. **No new tokens.** Every value in the mockup resolves to an existing token in
   `src/renderer/tokens.css`. Layout numbers that belong to this component alone
   (default split, minimum widths, tree width) are **constants in code**, listed in
   §Constants — the same precedent as the Artifacts panel's 340 px default width.
4. **One new primitive: `Segmented`** (see §P1). It is lifted from the Artifacts
   panel's mode switch, which adopts it in the same PR (two-adopter rule). Record it
   in `docs/components.md` and `src/renderer/primitives.test.ts`.
5. **Hook classes.** Every new region carries the `manta-explorer-*` hook listed
   below so the visual registry can crop it. Hooks carry no styles.
6. **Both themes.** Nothing here has a per-theme override. Check the mockup's theme
   switch in light and dark before reporting done.
7. **Colour utilities used below** (all exist in `tailwind.config.js`):
   `text-text`=--tx1, `text-text-muted`=--tx2, `text-text-faint`=--tx3,
   `text-text-quiet`=--tx4 (decorative only — line numbers, never a label or path),
   `bg-bg`=--canvas, `bg-bg-elev`=--panel, `bg-bg-soft`=--card, `bg-raised`,
   `bg-inset`, `bg-fill`/`-hover`/`-active`, `border-border-subtle`, `border-border`,
   `text-accent-tx`, `bg-accent-bg`, `bg-accent`, `text-ok`, `text-warn`,
   `text-danger`.

## Icons (lucide-react)

Mockup symbol → lucide name. IconButton sets the glyph size (16); inline glyphs
state their size.

| Mockup | lucide | Where |
|---|---|---|
| `i-sidebar` | `PanelLeft` | session header, sidebar toggle |
| `i-panel-right` | `PanelRight` | session header, Artifacts toggle (unchanged) |
| `i-folder-tree` | `FolderTree` | session header, Explorer toggle |
| `i-list-tree` | `ListTree` | Explorer top bar, tree toggle |
| `i-folder` | `Folder` (14) | root label, tree folders |
| `i-file` | `File` (14) | tree files, quick open rows |
| `i-chev-r` / `i-chev-d` | `ChevronRight` / `ChevronDown` (12) | tree disclosure |
| `i-up` | `ArrowUp` | tree "up to parent" (IconButton) |
| `i-search` | `Search` | quick open |
| `i-max` / `i-min` | `Maximize2` / `Minimize2` | expand / restore, rail |
| `i-x` | `X` | close Explorer |
| `i-copy` / `i-check` | `Copy` / `Check` | copy + its confirmation |
| `i-download` | `Download` | download |
| `i-link` | `Link` (14) | copy-path menu items |
| `i-file-warn` | `FileWarning` (20) | too large |
| `i-binary` | `Binary` (20) | binary file |
| `i-file-x` | `FileX` (20) | missing |
| `i-lock` | `Lock` (20) | permission denied |

## Constants (code, not tokens)

Put them in `src/renderer/explorer/layout.ts` with a comment pointing here.

| Name | Value | Notes |
|---|---|---|
| `EXPLORER_DEFAULT_RATIO` | 0.48 | Explorer share of the content width (sidebar excluded) |
| `TRANSCRIPT_MIN_PX` / `EXPLORER_MIN_PX` | 360 / 320 | enforced on every container resize |
| `EXPAND_SNAP_RATIO` | 0.85 | drag past → Expanded, ratio left unchanged |
| `CLOSE_SNAP_PX` | 200 | drag the Explorer narrower than this → close it |
| `TREE_DEFAULT_PX` / range | 176 (`w-44`) / 140–320 | |
| `HOVER_DELAY_MS` | 400 | path hover card |
| `COPY_CONFIRM_MS` | 1500 | same as CopyButton |
| Sidebar animation | `--motion-slow` + `--ease-out` | "panel slides" in the motion scale |

---

## E0 — Window composition (`App.tsx`)

```
<div class="flex h-full">                                   ← existing
  <Sidebar/>                         w-64 (existing). Hidden = stays mounted, slides out:
                                     -ml-64, transition-[margin] duration-[var(--motion-slow)]
                                     ease-[var(--ease-out)], then aria-hidden + inert.
  <PanelGroup direction="horizontal" class="manta-explorer-split flex-1 min-w-0">
    <Panel  id="transcript" minSize={…}>  <ChatPanel …/> </Panel>
    <PanelResizeHandle …/>                (E2)
    <Panel  id="explorer" collapsible minSize={…}> <ExplorerPanel …/> </Panel>
  </PanelGroup>
</div>
```

- Library: `react-resizable-panels`. Sizes are percentages; convert the px minimums
  to % on container resize (one `ResizeObserver` effect).
- **Per-session layout.** Store `{ ratio, open, treeOpen, treeWidth }` per opencode
  session id in `localStorage` key `manta:explorer:<sessionId>` (device-local, like
  the per-session model override). A session never seen before gets: open = false,
  ratio = default, tree closed. `expanded` is in memory only.
- `sidebarHidden` is app-wide, `localStorage` key `manta:sidebarHidden`.
- The Artifacts panel keeps its own implementation and slot; Explorer and Artifacts
  are mutually exclusive in the right slot (opening one closes the other).

## E1 — Session header (`SessionHeader.tsx`, existing `manta-session-header`)

Two additions, nothing else changes:

1. **Sidebar toggle**, first child, before the crumb:
   `<IconButton icon={<PanelLeft/>} label={hidden ? "Show sidebar" : "Hide sidebar"}
   title="… (⌘B)" hook="manta-sidebar-toggle" />`.
2. **Explorer toggle**, registered beside the Artifacts toggle (same registry entry
   shape, priority 81 so it sits left of Artifacts):
   `<IconButton icon={<FolderTree className={open ? "text-[var(--accent-tx)]" : undefined}/>}
   label={open ? "Hide file explorer" : "Show file explorer"} title="… (⌘E)"
   hook="manta-explorer-toggle" />` — the exact pattern the Artifacts toggle uses.

**Sidebar hidden on macOS:** the header gets `pl-20` instead of `pl-3` and the
`titlebar-drag` class (its buttons `titlebar-no-drag`), so the window controls sit
in the header and the window stays draggable. Windows/Linux: unchanged `pl-3`.

## E2 — Resize handle (`PanelResizeHandle`, hook `manta-explorer-handle`)

```
<PanelResizeHandle class="manta-explorer-handle group relative z-10 -mx-1 flex w-2 shrink-0 cursor-col-resize justify-center outline-none"
                   aria-label="Resize file explorer">
  <span class="h-full w-px bg-border transition-colors
               group-hover:w-[2px] group-hover:bg-accent
               group-data-[resize-handle-state=drag]:w-[2px] group-data-[resize-handle-state=drag]:bg-accent
               group-focus-visible:w-[2px] group-focus-visible:bg-accent" />
</PanelResizeHandle>
```
Double-click → default ratio. ←/→ when focused resize (the library's keyboard
support). The handle's 1 px `--border` line IS the Explorer's left border — do not
add `border-l` to the panel as well.

## E3 — Explorer shell + top bar (`ExplorerPanel.tsx`, hooks `manta-explorer`, `manta-explorer-top`)

```
<section class="manta-explorer flex h-full min-w-0 bg-bg-elev">
  [expanded] <ExplorerRail/>                                  (E9)
  <div class="flex min-w-0 flex-1 flex-col">
    <div class="manta-explorer-top flex h-11 shrink-0 items-center gap-1 border-b border-border px-2">
      <IconButton icon={<ListTree className={treeOpen ? "text-[var(--accent-tx)]" : undefined}/>}
                  label={treeOpen ? "Hide file tree" : "Show file tree"} title="… (⌥⌘E)" />
      <span class="flex min-w-0 flex-1 items-center gap-2 text-label font-semibold text-text">
        <Folder size={14} class="shrink-0 text-text-faint"/><span class="truncate">{rootName}</span>
      </span>
      <IconButton icon={<Search/>}   label="Quick open"  title="Quick open (⌘P)" />
      <IconButton icon={expanded ? <Minimize2/> : <Maximize2/>}
                  label={expanded ? "Restore split" : "Expand"} title={expanded ? "Restore split (Esc)" : "Expand (⇧⌘E)"} />
      <IconButton icon={<X/>} label="Close file explorer" title="Close (⌘E)" />
    </div>
    <div class="flex min-h-0 flex-1">
      [treeOpen] <ExplorerTree/> + tree handle                 (E4)
      <ExplorerViewer/>                                        (E5–E8)
    </div>
  </div>
</section>
```
`h-11` is the session header's height: the two bottom borders must form one line.
`rootName` is the basename of the tree root (the session folder until "up" is used).

## E4 — Tree (`ExplorerTree.tsx`, hooks `manta-explorer-tree`, `manta-explorer-row`)

Built on `@headless-tree/react`; this section is only the chrome.

```
<div class="manta-explorer-tree flex shrink-0 flex-col border-r border-border-subtle" style={{width: treeWidth}}>
  <div class="flex items-center gap-1 p-2">
    <input placeholder="Filter files"
           class="min-w-0 flex-1 bg-bg border border-border px-2 py-1 text-meta rounded-xs focus:outline-none focus:border-accent placeholder:text-text-faint"/>
           ← the Artifacts panel search input, byte-identical classes
    <IconButton icon={<ArrowUp/>} label="Up to parent folder"
                title={`Up to ${parentName}`}  disabled={atHome}  (disabled title: "Already at your home folder") />
  </div>
  <div role="tree" class="min-h-0 flex-1 overflow-y-auto px-1 pb-2"> rows </div>
</div>
+ tree handle: <div class="relative z-10 -mx-1 w-2 shrink-0 cursor-col-resize" role="separator" aria-label="Resize file tree"/>
  (same 1px→2px accent treatment as E2; the line is the tree's border-r)
```

Row (`role="treeitem"`, `aria-level`, `aria-expanded` on folders, `aria-selected`):
```
<div class="manta-explorer-row flex h-6 cursor-pointer items-center gap-1 rounded-sm pr-2 text-label
            {selected ? 'bg-accent-bg text-text' : ignored ? 'text-text-faint hover:bg-fill-hover' : 'text-text-muted hover:bg-fill-hover'}"
     style={{paddingLeft: depth * 12}}>                    ← 12 px per level (= step 3)
  folder: <ChevronRight|ChevronDown size={12} class="shrink-0 text-text-faint"/>   file: <span class="w-3 shrink-0"/>
  <Folder|File size={14} class="shrink-0 text-text-faint"/>
  <span class="truncate">{name}</span>
  [git] <span class="ml-auto font-mono text-micro font-semibold {M:'text-warn' A:'text-ok' D:'text-danger' ?:'text-text-faint'}">{M|A|D|?}</span>
</div>
```
Git-ignored entries: `text-text-faint`, never auto-expanded. Dot-files hidden unless
the filter text starts with `.`.

## E5 — File bar (`ExplorerViewer.tsx`, hook `manta-explorer-filebar`)

```
<div class="flex min-w-0 flex-1 flex-col bg-bg">                      ← the viewer surface
  <div class="manta-explorer-filebar flex h-10 shrink-0 items-center gap-1 border-b border-border-subtle bg-bg-elev pl-3 pr-2">
    <span class="min-w-0 flex-1 truncate text-left font-mono text-meta text-text-faint [direction:rtl]">
      <bdi>{dirs.join(" / ")} / <span class="font-medium text-text">{name}</span>
           [line] <span class="text-text-faint">· line {n}</span> | <span>· lines {a}–{b}</span></bdi>
    </span>                                       ← truncates from the LEFT, name always visible
    [markdown only] <Segmented label="Markdown view" options={["Rendered","Source"]} />   (P1)
    <IconButton icon={copied ? <Check class="text-ok"/> : <Copy/>} label="Copy contents" … />   (E11)
    <IconButton icon={<Download/>} label="Download" title={`Download ${name}`} />
  </div>
  <div class="min-h-0 flex-1 overflow-auto"> E6 | E7 | E10 </div>
  <ExplorerFooter/>                                                  (E8)
</div>
```
For non-Markdown files the Segmented is not rendered (no reserved gap).

## P1 — `Segmented` primitive (new, `src/renderer/Segmented.tsx`)

Lifted verbatim from the Artifacts panel mode switch. Adopters in the same PR:
`ArtifactsPanel.tsx` (Artifacts | Review) and `ExplorerViewer.tsx` (Rendered | Source).

```
<div role="group" aria-label={label} class="flex shrink-0 rounded-md border border-border-subtle bg-inset p-1 {fill ? 'w-full' : ''}">
  <button aria-pressed={on}
          class="inline-flex items-center justify-center gap-1 rounded-sm px-2 py-1 text-meta font-medium
                 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent
                 {fill ? 'flex-1' : ''} {on ? 'bg-raised shadow-sm text-text' : 'text-text-faint hover:text-text'}">
```
Props: `label` (required), `options: {id, label}[]`, `value`, `onChange`, `fill?`
(Artifacts uses `fill`; Explorer does not), `hook?`. No `className`. The Artifacts
panel's `mb-2` stays on its wrapper, not in the primitive.

## E6 — Code view (`CodeViewer.tsx`, CodeMirror 6 read-only, hook `manta-explorer-code`)

Extensions: `EditorState.readOnly.of(true)`, `EditorView.editable.of(false)`,
`lineNumbers()`, `highlightSpecialChars()`, `search({top: true})` +
`searchKeymap`, `gotoLine` (⌘L), language by filename via
`@codemirror/language-data` (`LanguageDescription.matchFilename`, lazy-loaded).

**Chrome theme** — `EditorView.theme`, values are CSS variables only:
```ts
{
  "&":                        { height: "100%", backgroundColor: "var(--canvas)", color: "var(--tx1)", fontSize: "13px" },
  ".cm-scroller":             { fontFamily: "var(--font-mono)", lineHeight: "1.55" },
  ".cm-content":              { padding: "var(--sp-2) 0" },
  ".cm-line":                 { padding: "0 var(--sp-4) 0 0" },
  ".cm-gutters":              { backgroundColor: "var(--canvas)", color: "var(--tx4)", border: "none" },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "48px", padding: "0 var(--sp-4) 0 0" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "transparent" },
  "&.cm-focused":             { outline: "none" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "rgb(var(--accent-rgb) / .25)" },
  ".cm-manta-target":         { backgroundColor: "var(--accent-bg)", boxShadow: "inset 2px 0 0 var(--accent)" },
  ".cm-manta-target-gutter":  { color: "var(--accent-tx)" },
  ".cm-searchMatch":          { backgroundColor: "var(--warn-bg)" },
  ".cm-searchMatch-selected": { backgroundColor: "rgb(var(--warn-rgb) / .35)" },
  ".cm-panels":               { backgroundColor: "var(--panel)", color: "var(--tx1)", borderColor: "var(--border-subtle)" },
  ".cm-panel input":          /* = the filter input: */ { background: "var(--canvas)", border: "1px solid var(--border)", borderRadius: "var(--r-xs)", padding: "var(--sp-1) var(--sp-2)", fontSize: "var(--font-size-xs)", color: "var(--tx1)" },
  ".cm-panel button":         /* = a Segmented button: */ { background: "transparent", border: "1px solid var(--border-subtle)", borderRadius: "var(--r-sm)", padding: "var(--sp-1) var(--sp-2)", fontSize: "var(--font-size-xs)", color: "var(--tx2)" },
}
```
`.cm-manta-target` is a line decoration on the target line(s) (`:28`, `:28-30`);
the matching gutter marker gets `.cm-manta-target-gutter`. Scroll the first target
line to ~⅓ from the top on open.

**Syntax colours** come from the SAME objects the transcript's CodeBlock uses —
`themes.vsDark` (dark) / `themes.github` (light) from `prism-react-renderer` —
through one adapter `prismThemeToHighlightStyle(theme)` that maps Prism token types
to `@lezer/highlight` tags:

| Prism type | lezer tag(s) |
|---|---|
| comment, prolog, doctype, cdata | `tags.comment` |
| string, char, attr-value, template-string | `tags.string`, `tags.special(tags.string)` |
| keyword, atrule, important | `tags.keyword`, `tags.controlKeyword`, `tags.modifier` |
| function | `tags.function(tags.variableName)`, `tags.function(tags.propertyName)` |
| number | `tags.number` |
| boolean, constant | `tags.bool`, `tags.atom`, `tags.constant(tags.variableName)` |
| operator | `tags.operator` |
| punctuation | `tags.punctuation`, `tags.bracket` |
| property | `tags.propertyName` |
| class-name, builtin | `tags.className`, `tags.typeName`, `tags.standard(tags.variableName)` |
| tag | `tags.tagName` |
| attr-name | `tags.attributeName` |
| regex | `tags.regexp` |
| title (Markdown heading), bold, italic | `tags.heading`, `tags.strong`, `tags.emphasis` |
| url | `tags.url`, `tags.link` |

Theme + highlight style live in a `Compartment` reconfigured when the resolved app
theme flips (`useResolvedTheme`). The Prism theme's `plain.backgroundColor` is
ignored (the surface is `--canvas`), exactly as CodeBlock ignores it. The mockup's
`.sx-*` colours are stand-ins and NOT under conformance.

## E7 — Rendered Markdown (hook `manta-explorer-md`)

```
<div class="manta-explorer-md max-w-[var(--measure)] px-6 py-5">
  <MarkdownBody text={file} linkResolver={…}/>          ← unchanged component
</div>
```
`MarkdownBody` gets ONE optional prop for this surface: a resolver that turns a
relative link / image `src` into an Explorer navigation / `/api/peek` URL. No style
changes to MarkdownBody. Raw HTML stays unrendered.

## E8 — Footer (hook `manta-explorer-footer`)

```
<div class="manta-explorer-footer flex h-7 shrink-0 items-center gap-3 border-t border-border-subtle bg-bg-elev px-3 text-meta text-text-faint">
  <span>{language}</span><span>{lines} lines</span><span>{formatBytes(size)}</span>
  <span class="ml-auto">{target ? `Ln ${line}` : `modified ${relative(mtime)}`}</span>
</div>
```
Use the existing `formatBytes` (`chatUtils.ts`); language label from
`previewLanguage`.

## E9 — Expanded + rail (hook `manta-explorer-rail`)

Expanded collapses the `transcript` Panel to 0 and hides the handle; the Explorer
fills the content width (sidebar unaffected). The rail is the first child of the
Explorer shell:
```
<button class="manta-explorer-rail flex w-11 shrink-0 flex-col items-center gap-3 border-r border-border bg-bg pt-3 hover:bg-fill-hover"
        aria-label="Back to transcript" title="Back to transcript (Esc)">
  <Minimize2 size={16} class="text-text-faint"/>
  <StatusDot tone={running ? "running" : needsYou ? "warn" : "idle"}/>
  <span class="rotate-180 text-meta text-text-faint [writing-mode:vertical-rl]">Transcript</span>
</button>
```
(The rail is one button; the glyph is not a nested IconButton.) Restore returns to
the ratio held before expanding.

## E10 — Path link (`FileLink` in `Linkified.tsx`, hook `manta-file-link`)

The ONE anchor for confirmed file paths, sibling of `ExternalLink`:
```
<a href="#" data-path={abs}
   class="manta-file-link -mx-px rounded-xs px-px text-accent-tx underline decoration-dotted decoration-accent/50 underline-offset-[3px]
          hover:bg-accent-bg hover:decoration-solid
          {active ? 'bg-accent-bg no-underline ring-1 ring-inset ring-accent/40' : ''}">
  {pathText}[<span class="text-text-faint">{":28" | ":28-34"}</span>]
</a>
```
- Inside inline code the `<code>` keeps its existing styling; the link inherits its
  font. Outside code (tool-card args, plain text) add `font-mono text-[0.88em]` —
  the inline-code size MarkdownBody already uses.
- `active` = the file (and range) currently shown in this session's Explorer.
- A path that is unresolved, missing or outside home renders as plain text /
  plain inline code — never a link with a disabled look.
- `stopPropagation` on click, like `ExternalLink`, so a tool-card header doesn't toggle.

## E11 — Hover card (hook `manta-explorer-hover`)

`<Popover placement="below">` with the shared `POPOVER_SURFACE` chrome, `w-72 p-3`:
```
<div class="flex items-center gap-1">
  <span class="min-w-0 flex-1 truncate font-mono text-label text-text">{relPath}</span>
  <IconButton Copy …/> <IconButton Download …/>
</div>
<div class="mb-2 text-meta text-text-faint">{language} · {lines} lines · {size} · modified {rel}</div>
<OutputWell variant="standalone">{3 lines around the target, each prefixed with its number}</OutputWell>
```
Opens after `HOVER_DELAY_MS`, closes on leave (with the usual grace into the card).
Binary / too-large files: no OutputWell; the meta line says why.

## E12 — Can't-preview states (hook `manta-explorer-refusal`)

Centred in the viewer body (the mockup boxes them only to show four at once):
```
<div class="manta-explorer-refusal flex h-full flex-col items-center justify-center gap-1 px-4 py-8 text-center">
  <Icon size={20} class="mb-1 text-text-faint"/>
  <span class="text-label font-medium text-text">{title}</span>
  <span class="text-meta text-text-faint">{detail}</span>
  [downloadable] <div class="mt-3"><Button tone="primary"><Download size={14}/>Download</Button></div>
</div>
```
| Case | Icon | Title | Detail | Download |
|---|---|---|---|---|
| > 25 MiB | `FileWarning` | Too large to preview | `{name} is {size} · the limit is 25 MB` | yes |
| binary | `Binary` | Binary file | `{name} can't be shown as text` | yes |
| ENOENT | `FileX` | No longer exists | Moved or deleted after it was mentioned | no |
| EACCES | `Lock` | Can't read this file | The box user has no permission to open it | no |

Images / PDF / video use the existing `ArtifactPreview` renderers inside the body.

## E13 — Copy and download feedback

- **Copy contents**: IconButton; on success swap the glyph to `<Check class="text-ok"/>`
  for `COPY_CONFIRM_MS`, label "Copied". On failure: error toast "Couldn't copy —
  the clipboard is unavailable". (Do NOT reuse `CopyButton` as-is: it swallows the
  failure.) Disabled with a reason in `title` for binary / too-large files.
- **Copy menu**: right-click or ⌥-click on the copy button opens
  `Dropdown` (align end) with `MenuItem`s: Copy contents (`Copy` 14) · Copy path
  (`Link` 14, trailing hint "⌥ click") · Copy relative path (`Link` 14).
- **Download**: `saveToDownloads(absPath)` — its toasts are the whole UI. Nothing new.

## E14 — Quick open (hook `manta-explorer-quickopen`)

`PaletteShell` unchanged, placeholder "Go to file…". Rows:
```
<div role="option" aria-selected class="flex items-center gap-2 rounded-sm px-2 py-1 font-mono text-label
     {selected ? 'bg-accent-bg text-text' : 'text-text-muted'}">
  <File size={14} class="shrink-0 text-text-faint"/>
  <span class="min-w-0 truncate">{dir}/<mark class="bg-transparent font-semibold text-accent-tx">{match}</mark>{rest}</span>
  [git] <span class="ml-auto font-mono text-micro font-semibold {tone}">{M|A|D|?}</span>
</div>
```
Footer hints add `⌘⏎ open expanded` to PaletteShell's existing ones.

---

## Hooks (no styles)

`manta-sidebar-toggle`, `manta-explorer-toggle`, `manta-explorer-split`,
`manta-explorer-handle`, `manta-explorer`, `manta-explorer-top`, `manta-explorer-tree`,
`manta-explorer-row`, `manta-explorer-filebar`, `manta-explorer-code`,
`manta-explorer-md`, `manta-explorer-footer`, `manta-explorer-rail`,
`manta-file-link`, `manta-explorer-hover`, `manta-explorer-refusal`,
`manta-explorer-quickopen`.

## Visual registry rows (`scripts/visual/screens.mjs`)

| Row | App region | Mockup region | State to reach (demo mode) |
|---|---|---|---|
| `explorer-default` | full window | `.mk-win-default` | session open, Explorer open on `docs/peek-scope.md`, tree closed |
| `explorer-tree` | full window | `.mk-win-tree` | sidebar hidden, tree open, `src/server/peek.mjs:28-30` |
| `explorer-expanded` | full window | `.mk-win-expanded` | same file, expanded, session running |
| `explorer-links` | transcript turn with paths | `.mk-links` | demo turn with every link state |
| `explorer-hover` | `.manta-explorer-hover` | `.mk-hover` | hover `src/server/peek.mjs:28` |
| `explorer-md-source` | `.manta-explorer` | `.mk-source` | Source view |
| `explorer-refusal` | `.manta-explorer-refusal` | `.mk-refusals` (one tile per row variant) | each refusal fixture |
| `explorer-quickopen` | `.manta-explorer-quickopen` | `.mk-quickopen` | ⌘P, query `peek` |

The demo fixture's file names, sizes and line counts must equal the mockup's
(`peek-scope.md` 18 lines 612 B, `peek.mjs` 142 lines 4.8 KB), so the side-by-side
compares layout and not words. Write `docs/screens/explorer/conformance.md` at the
end listing every deliberate difference.
