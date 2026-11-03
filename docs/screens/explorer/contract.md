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
| `EXPLORER_DEFAULT_SIZE` | `"48%"` | Explorer `defaultSize` (v4 string = percent) |
| `TRANSCRIPT_MIN_PX` / `EXPLORER_MIN_PX` | 360 / 320 | `minSize` numbers (v4 numbers = px) |
| `AUTO_EXPAND_BELOW_PX` | 680 | content narrower than both minimums → Expanded |
| `TREE_DEFAULT_PX` / range | 176 (`w-44`) / 140 – (explorer − 200) | tree toggle disabled when explorer < 340 |
| `VIEWER_MIN_PX` | 200 | |
| `SIDEBAR_WIDTH_PX` | 256 (`w-64`) | slide distance |
| `TRAFFIC_LIGHT_INSET_PX` / `TRAFFIC_LIGHT_INSET_TOP_PX` | 76 / 40 | macOS traffic-light clearance (x · y) — the inputs of the corner variables below; `cornerInsetVars()` in `layout.ts` is the one place they are combined |
| Explorer slide | `--motion-base` + `--ease-out` | same as the Artifacts panel's slide (`MOTION_BASE` / `MOTION_EASE`); fallback timer = token + 50 ms |
| Segmented pill | `--motion-slow` + `--ease-out` | same as the Artifacts kind tabs (`MOTION_SLOW` / `MOTION_EASE`) |
| `COPY_CONFIRM_MS` | 1500 | |
| `LOADING_DELAY_MS` | 150 | skeleton appears only after this |
| `UPDATED_PILL_MS` | 3000 | |
| Sidebar animation | `--motion-slow` + `--ease-out` | "panel slides" in the motion scale |

v2 only (do NOT build): hover card, drag snaps.

### Window-corner variables (set once on the app root by `App.tsx`)

`cornerInsetVars({isMac, sidebarHidden, bannerShown})` (`layout.ts`, pure) — they
replace the old `--sidebar-hidden-inset`. Exactly one element owns each window
corner; it reads these:

| Variable | Value | Read by |
|---|---|---|
| `--tl-inset-x` | `76px` when macOS and the sidebar is hidden, else `0px`; folded with `--titlebar-inset-left` (RTL Windows puts the caption buttons on the left) via `max()` | the two below |
| `--banner-inset-x` | `--tl-inset-x` while a top banner shows, else `0px` | banners (`ReconnectingBanner`, `UpdateBar`): `padding-left: max(var(--sp-3), var(--banner-inset-x))`; they carry `titlebar-drag`, their buttons `titlebar-no-drag` |
| `--pane-inset-x` | `0px` while a top banner shows, else `--tl-inset-x` | pane headers: `SessionHeader`, the terminal / new-session titlebar, CTO header, Routines header, and the Explorer top bar in Expanded (`calc(var(--pane-inset-x) - 44px)`, since the rail is 44 px) |
| `--pane-inset-top` | `40px` when macOS, sidebar hidden and no banner, else `0px` | the Expanded rail: `padding-top: max(var(--sp-3), var(--pane-inset-top))` (the rail is narrower than the traffic lights, so its content starts below them) |

"A top banner shows" = exactly one of: `ReconnectingBanner`, the incompatible
`UpdateBar`, the in-flight `UpdateBar`, the updates `UpdateBar`; `App` computes it
once as `topBannerShown` and reuses it in the render.

### Windows caption buttons (top-right, `--titlebar-inset-right`)

`titleBarOverlay.height` is **44**, the `h-11` of every header it can sit over
(SessionHeader, Explorer top bar, App titlebar, Routines header, Settings strip).
**Exactly one header per column stack reserves the right inset** — the one touching
the window's right edge:

| Right panel shown for the visible session | Header that reserves `--titlebar-inset-right` |
|---|---|
| none | `SessionHeader` (and the App titlebar / CTO / Routines for their panes) |
| Explorer (split or Expanded) | the Explorer top bar; `SessionHeader` drops to plain `pr-3` |
| Artifacts | the Artifacts title row; `SessionHeader` drops to plain `pr-3` |

Banners keep their own right reservation (they are shorter than the 44 px buttons,
so the header below a banner still reserves). Settings: the drag strip beside the
buttons is `h-11`; its row below carries no second reservation. The buttons follow
the theme: `App` syncs `{color, symbolColor}` (resolved `--bg-elev` / header
background, `--text-muted`) through `setTitleBarOverlay` on mount, theme change and
right-panel change (win32 only; main validates `#RRGGBB`).

---

## E0 — Window composition (`App.tsx`)

```
<div class="flex h-full" style={cornerInsetVars({isMac, sidebarHidden, bannerShown})}>   (corner variables, §Constants)
  <Sidebar/>                        w-64; hidden = stays mounted, style={{marginLeft: -SIDEBAR_WIDTH_PX}},
                                    class "transition-[margin] duration-[var(--motion-slow)] ease-[var(--ease-out)]",
                                    inert + aria-hidden when hidden
  [chat session]
  <Group orientation="horizontal" class="manta-explorer-split min-w-0 flex-1">
    <Panel id="transcript" minSize={TRANSCRIPT_MIN_PX}> <ChatPanel …/> </Panel>
    [explorer shown && !expanded] <Separator …/>            (E2)
    [visible chat] <Panel id="explorer" collapsible collapsedSize={0} minSize={EXPLORER_MIN_PX}>
                     [shown, or closing] <ExplorerPanel …/>
                   </Panel>                                  (collapsed = closed)
  </Group>
  [artifacts shown] <ArtifactsPanel …/>                    (unchanged)
</div>
```
- `react-resizable-panels` **v4** API: `Group` / `Panel` / `Separator`,
  `orientation`, numbers = px, strings = %. No percentage conversion code.
- Existing mounted ChatPanels stay mounted (App keeps visited panels alive) —
  the Group wraps the ACTIVE chat's column only; do not remount inactive panels.
- Per-session layout persistence via `onLayoutChange` (debounced 250 ms) into
  `manta:explorer:<sessionId>`; Expanded = `panelRef.collapse()` on the
  transcript Panel.
- Right slot: `setRightPanel(sessionId, which)` is the only writer (spec
  §Layout); the `manta-open-review` handler and the ⌘I handler call it.
- Not mounted for terminal, CTO, routines, drafts.

**Motion — open / close / Expanded slide** (`ExplorerSplit`). The visible chat keeps
a `collapsible` Explorer Panel (`collapsedSize={0}`); "closed" is collapsed, and
opening restores the stored ratio exactly. Other visited chats keep their
transcript Panel only. The library sizes panels with `flex-grow`, so the slide is a
CSS transition on it:
`.manta-explorer-split[data-animating] > [data-panel] { transition: flex-grow var(--motion-base) var(--ease-out) }`
(none under `prefers-reduced-motion`).
- `data-animating` is set for a programmatic open / close / Expanded ↔ split
  toggle, cleared on `transitionend` (timer fallback: token + 50 ms). Never during a
  drag or key resize — dragging stays 1:1. A chat that just became visible rests at
  its size: no slide.
- No reflow while sliding: `ExplorerPanel` holds a fixed pixel width (the larger of
  the start / end widths) inside the `overflow: hidden` panel, back to `100%` after.
- `ExplorerPanel` mounts on open and unmounts after the close animation, so a
  closed Explorer runs no effects or fetches. The `Separator` renders only while
  open and not Expanded.
- Animated layouts are not user interactions: the stored ratio is untouched. Dragging
  the handle below `EXPLORER_MIN_PX` never collapses the panel (closing is the X / ⌘E).

## E1a — Sidebar button (`SidebarToggle.tsx`, hook `manta-sidebar-toggle`)

No floating control. One `IconButton` (`SidebarToggleButton`:
`<PanelLeft/>`, label `Hide sidebar` / `Show sidebar`, title `… (⌘B)`,
`hook="manta-sidebar-toggle"`), two homes:

- **Sidebar visible** — in the sidebar's Workspace header, immediately left of the
  search button, in the same `gap-1` group. The header's left padding is
  `max(var(--sp-3), var(--titlebar-inset-left))`.
- **Sidebar hidden** — the **first control** of the top-left pane header, after the
  `--pane-inset-x` clearance, via `<SidebarRevealButton/>` (renders nothing while the
  sidebar is visible; carries `titlebar-no-drag`). Rendered as the first child of:
  `SessionHeader`, the App titlebar (terminal / new-session panes), the `CtoChat`
  header, the `RoutinesParts` header, and — in Expanded, where `SessionHeader` is
  folded away — the Explorer top bar, before the tree toggle. `SessionHeader` renders
  it only while the Explorer is not Expanded, so exactly one copy shows.

⌘B, the `manta:sidebarHidden` key and the sidebar's slide are unchanged.

## E1 — Session header (`SessionHeader.tsx`, existing `manta-session-header`)

- Left padding: replace `pl-3` with
  `style={{paddingLeft: "max(var(--sp-3), var(--pane-inset-x, 0px))"}}` and render
  `<SidebarRevealButton/>` first (E1a). The same rule goes on the terminal pane
  header, CTO header, Routines header and NewSessionScreen header. The padded strip
  keeps `titlebar-drag`.
- Right padding: `pr-3`, plus `--titlebar-inset-right` only while no right panel is
  shown for the session (§Windows caption buttons).
- **Explorer toggle**: a registry entry pushed **immediately before** the
  Artifacts entry (the registry keeps insertion order), same shape:
  `<IconButton icon={<FolderTree className={open ? "text-[var(--accent-tx)]" : undefined}/>}
  label={open ? "Hide file explorer" : "Show file explorer"} title="… (⌘E)"
  hook="manta-explorer-toggle" />`. Shown for chat sessions only.

## E2 — Separator (`Separator`, hook `manta-explorer-handle`)

```
<Separator class="manta-explorer-handle group relative z-10 -mx-1 flex w-2 shrink-0 cursor-col-resize justify-center outline-none"
           aria-label="Resize file explorer">
  <span class="h-full w-px bg-border transition-colors
               group-hover:w-[2px] group-hover:bg-accent
               group-active:w-[2px] group-active:bg-accent
               group-focus-visible:w-[2px] group-focus-visible:bg-accent" />
</Separator>
```
Double-click → `EXPLORER_DEFAULT_SIZE` (library `disableDoubleClick` stays
false; implement via the group's `setLayout`). ←/→ when focused (library). The
1 px `--border` line IS the Explorer's left border — no `border-l` on the panel.

## E3 — Explorer shell + top bar (`ExplorerPanel.tsx`, hooks `manta-explorer`, `manta-explorer-top`)

```
<section class="manta-explorer flex h-full min-w-0 bg-bg-elev">
  [expanded] <ExplorerRail/>                                  (E9)
  <div class="flex min-w-0 flex-1 flex-col">
    <div class="manta-explorer-top flex h-11 shrink-0 items-center gap-1 border-b border-border px-2"
         style={expanded ? {paddingLeft: "max(var(--sp-2), calc(var(--pane-inset-x) - 44px))"} : undefined}>
      [expanded] <SidebarRevealButton/>                         (E1a — first control)
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
      <ExplorerViewer/>  or  <ExplorerEmpty/>                  (E5–E8, E12b)
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
                title={`Up to ${parentName}`}  disabled={atTop}  (disabled title: "Already at the top folder (/)") />
  </div>
  <div role="tree" class="min-h-0 flex-1 overflow-y-auto px-1 pb-2"> rows </div>
</div>
+ tree handle (8 px = w-2, same as E2): <div class="group relative z-10 -mx-1 w-2 shrink-0 cursor-col-resize" role="separator"
  aria-orientation="vertical" aria-label="Resize file tree" tabIndex={0}/> — hover/drag/focus shows a 2px bg-accent line;
  the tree's own border-r is the idle line. ←/→ resize by 16 px.
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
Git-ignored entries AND dot-files: `text-text-faint`; ignored folders never
auto-expand. `.git` is never listed. Symlinks show as their target's kind (file or folder),
wherever the target is. Truncated folder: a final non-interactive row `pl-[depth*12] text-meta text-text-faint`
"{n} more not shown — use quick open (⌘P)". Conflict badge `!` uses `text-danger`.

## E5 — File bar (`ExplorerViewer.tsx`, hook `manta-explorer-filebar`)

```
<div class="flex min-w-0 flex-1 flex-col bg-bg">                      ← the viewer surface
  <div class="manta-explorer-filebar flex h-10 shrink-0 items-center gap-1 border-b border-border-subtle bg-bg-elev pl-3 pr-2">
    <span class="min-w-0 flex-1 truncate text-left font-mono text-meta text-text-faint [direction:rtl]">
      <bdi>{dirs.join(" / ")} / <span class="font-medium text-text">{name}</span>
           [line] <span class="text-text-faint">· line {n}</span> | <span>· lines {a}–{b}</span></bdi>
    </span>                                       ← truncates from the LEFT, name always visible
    [markdown only] <Segmented label="Markdown view" options={["Rendered","Source"]} />   (P1)
    [updated] <Pill tone="neutral" size="meta">Updated</Pill>       (3 s after a refresh changed the file)
    <IconButton icon={copied ? <Check class="text-ok"/> : <Copy/>} label={copied ? "Copied" : "Copy contents"} … />   (E13)
    <IconButton icon={<Download/>} label="Download" title={`Download ${name}`} />
    <IconButton icon={<MoreHorizontal/>} label="More" ariaHaspopup="menu" … />  → Dropdown (E13)
  </div>
  <div class="min-h-0 flex-1 overflow-auto"> E6 | E7 | E10 </div>
  <ExplorerFooter/>                                                  (E8)
</div>
```
For non-Markdown files the Segmented is not rendered (no reserved gap).

## P1 — `Segmented` primitive (new, `src/renderer/Segmented.tsx`)

Lifted from the Artifacts panel mode switch, with a sliding highlight. Adopters in the same PR:
`ArtifactsPanel.tsx` (Artifacts | Review) and `ExplorerViewer.tsx` (Rendered | Source).

```
<div role="group" aria-label={label} class="flex shrink-0 rounded-md border border-border-subtle bg-inset p-1 {fill ? 'w-full' : ''}">
  <button aria-pressed={on}
          class="inline-flex items-center justify-center gap-1 rounded-sm px-2 py-1 text-meta font-medium
                 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent
                 {fill ? 'flex-1' : ''} relative z-10 {on ? 'text-text' : 'text-text-faint hover:text-text'}">
    [on] <motion.span layoutId={`${id}-pill`} layoutDependency={value} aria-hidden
           transition={{type: "tween", duration: MOTION_SLOW, ease: MOTION_EASE}}
           class="absolute inset-0 rounded-sm bg-raised shadow-sm" />
    <span class="relative z-10">{label}</span>
```

**The pill.** The active segment no longer paints `bg-raised shadow-sm` itself: it
renders exactly one framer-motion `layoutId` pill (`id` from `useId()`, so two
Segmenteds never share one), behind its label. The pill slides between segments on
`--motion-slow` + `--ease-out`. `layoutDependency={value}` means only a value change
animates — a container resize (dragging the split) moves the pill with its button.
`MotionConfig reducedMotion="user"` disables it. At rest it is pixel-identical to a
painted active segment.
Props: `label` (required), `options: {id, label}[]`, `value`, `onChange`, `fill?`
(Artifacts uses `fill`; Explorer does not), `hook?`. No `className`. The Artifacts
panel's `mb-2` stays on its wrapper, not in the primitive.

## E6 — Code view (`CodeViewer.tsx`, CodeMirror 6 read-only, hook `manta-explorer-code`)

Imports: `HighlightStyle`, `syntaxHighlighting`, `LanguageDescription` from
`@codemirror/language`; `tags` from `@lezer/highlight`; `languages` from
`@codemirror/language-data`. `@uiw/react-codemirror` with `basicSetup={false}`.

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
<div class="manta-explorer-md flex max-w-[var(--measure)] flex-col gap-[var(--block-gap)] break-words px-6 py-5 text-prose text-text">
  <MarkdownBody text={file} fileContext={{ owner, fileDir }}/>      ← component look unchanged
</div>
```
`gap-[var(--block-gap)]` is the transcript's own block rhythm (MarkdownBody
sets only heading/table margins). `fileContext` changes behaviour only:
relative links → Explorer navigation, relative images → authenticated blob
loader (spec §Markdown). > 50 000 chars → Source (E6) with a `Callout tone="info"
size="note"` "Large file — showing source" above it.

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
<button class="manta-explorer-rail flex w-11 shrink-0 flex-col items-center gap-3 border-r border-border bg-bg hover:bg-fill-hover"
        style={{paddingTop: "max(var(--sp-3), var(--pane-inset-top, 0px))"}}
        aria-label="Back to transcript" title="Back to transcript (Esc)">
  <Minimize2 size={16} class="text-text-faint"/>
  <StatusDot tone={needsYou ? "warn" : running ? "running" : "idle"}/>
  <span class="rotate-180 text-meta text-text-faint [writing-mode:vertical-rl]">Transcript</span>
</button>
```
(The rail is one button; the glyph is not a nested IconButton.) Restore returns to
the ratio held before expanding.

## E10 — Path link (`FileLink` in `Linkified.tsx`, hook `manta-file-link`) and ToolCard `argPath`

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
- A path that is unresolved, missing or unreadable renders as plain text /
  plain inline code — never a link with a disabled look.
- `stopPropagation` on click, like `ExternalLink`.

**ToolCard `argPath` slot.** An `<a>` inside the header `<button>` is invalid,
so a card with `argPath` renders its header as
`<div class="…same header classes…" onClick={toggle}>` containing: the status
dot, the name, the `FileLink` (outside code: add `font-mono text-[0.88em]`),
the meta, and the chevron wrapped in the ONLY focusable disclosure control
`<button aria-expanded aria-label="Show details" class="rounded-xs p-1 …IconButton md chrome">`.
Cards without `argPath` keep today's `<button>` header unchanged.

## E11 — (v2) Hover card — not built in v1

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

Images / video: `MediaBody` (extracted from `ArtifactPreview`, which then uses
it too). PDF: centred `<Button tone="default">Open preview</Button>` that opens
the existing ArtifactPreview overlay for the path.

## E12b — Empty / loading / error (hook `manta-explorer-state`)

Same centred column as E12:
- **Empty** (no file opened in this session): icon `FolderTree` 20, title
  "No file open", detail "Click a file path in the conversation, or open the
  tree". No button: opening the Explorer from its header icon or ⌘E always shows
  the tree (a path link keeps the stored tree preference), and a too-narrow
  Explorer explains itself through the disabled tree toggle.
- **Loading**: nothing for `LOADING_DELAY_MS`, then the existing `Skeleton`
  (3 lines) at the top of the body, `px-6 py-5`.
- **Error**: icon `FileWarning` 20, title "Couldn't load this file", detail =
  the safe reason text, `<Button tone="default">Retry</Button>`.
- **Empty file**: `text-meta text-text-faint px-6 py-5` "Empty file".

## E13 — Copy and download feedback

- **Copy contents**: IconButton; on success the glyph becomes
  `<Check class="text-ok"/>` and the label "Copied" for `COPY_CONFIRM_MS`. On
  failure: error toast "Couldn't copy — the clipboard is unavailable". (Do NOT
  reuse `CopyButton`: it swallows failures.) Disabled with the reason in `title`
  for binary / too-large / not-yet-loaded files.
- **More** (`MoreHorizontal` IconButton, `ariaHaspopup="menu"`) → `Dropdown`
  (align end, width menu) with `MenuItem`s: Copy path (`Link` 14) · Copy relative
  path (`Link` 14). Success → toast "Path copied"; failure → the same error toast.
- **Download**: `saveToDownloads(absPath)` — its toasts are the whole UI.

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
PaletteShell is unchanged (no hook prop, no modified-Enter): put the
`manta-explorer-quickopen` hook on the list wrapper rendered as its children.

---

## Hooks (no styles)

`manta-sidebar-toggle`, `manta-explorer-toggle`, `manta-explorer-split`,
`manta-explorer-handle`, `manta-explorer`, `manta-explorer-top`, `manta-explorer-tree`,
`manta-explorer-row`, `manta-explorer-filebar`, `manta-explorer-code`,
`manta-explorer-md`, `manta-explorer-footer`, `manta-explorer-rail`,
`manta-file-link`, `manta-explorer-refusal`, `manta-explorer-state`,
`manta-explorer-quickopen`.

## Visual registry rows (`scripts/visual/screens.mjs`)

| Row | App region | Mockup region | State to reach (demo mode) |
|---|---|---|---|
| `explorer-default` | full window | `.mk-win-default` | session open, Explorer open on `docs/peek-scope.md`, tree closed |
| `explorer-tree` | full window | `.mk-win-tree` | sidebar hidden, tree open, `src/server/peek.mjs:28-30` |
| `explorer-expanded` | full window | `.mk-win-expanded` | same file, expanded, session running |
| `explorer-links` | transcript turn with paths | `.mk-links` | demo turn with every link state |
| `explorer-states` | `.manta-explorer-state` | `.mk-states` | empty / loading / error fixtures |
| `explorer-banner-hidden-sidebar` | full window | `.mk-win-banner` | macOS emulation, sidebar hidden, `reconnecting` banner, Explorer open: the banner owns the traffic-light clearance |
| `explorer-narrow` | full window at 900×700 | `.mk-win-expanded` | Explorer opened in a narrow window → Expanded |
| `explorer-md-source` | `.manta-explorer` | `.mk-source` | Source view |
| `explorer-refusal` | `.manta-explorer-refusal` | `.mk-refusals` (one tile per row variant) | each refusal fixture |
| `explorer-quickopen` | `.manta-explorer-quickopen` | `.mk-quickopen` | ⌘P, query `peek` |

The demo fixture's file names, sizes and line counts must equal the mockup's
(`peek-scope.md` 18 lines 612 B, `peek.mjs` 142 lines 4.8 KB), so the side-by-side
compares layout and not words. Write `docs/screens/explorer/conformance.md` at the
end listing every deliberate difference.
