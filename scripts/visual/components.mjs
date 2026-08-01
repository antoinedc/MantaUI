/**
 * scripts/visual/components.mjs — THE component registry.
 *
 * This file is data. It is the only thing you edit to add a candidate
 * primitive to the component companion; no script change, no test and no
 * CI step is touched. `scripts/visual/companion.mjs` loops over this list
 * to render every candidate in both themes, and each adopter PR (BET-527
 * epic) is validated against that output.
 *
 * The canonical markup in `variants` mirrors the CSS selectors verified in
 * the redesign spec — not page-specific copies. Markup is the spec's own.
 *
 * Adding a component:
 *   1. Owner-validate the primitive against the companion (BET-527 standing
 *      decision 1) — never add an unvalidated candidate.
 *   2. Add an entry here.
 *   3. Adopt it at >= 2 call sites in the SAME PR (two-adopter rule).
 *
 * Field notes:
 *   id        stable slug, used as the DOM id and the anchor
 *   name      human label in the card header
 *   cls       the spec's class name, counted to show usage
 *   app       what exists in the app today, verbatim and honest
 *   note      optional constraint shown on the card (HTML allowed)
 *   full      optional; render one full-width column instead of the grid
 *   wrap      optional (html) => html, to place the demo in its real container
 *   variants  [label, html][] — canonical markup, mirroring the spec's selectors
 */

// Icons are referenced from the spec's sprite via `<use href="#i-…">`. The
// markup embeds them at module load, so this helper must live here with the
// data rather than in the companion.
const ic = (n) => `<svg class="ic"><use href="#i-${n}"/></svg>`;

// Canonical examples. Markup mirrors the CSS selectors verified in the spec
// (e.g. `.setrow .lab b`, `.sw i`, `.srow .st.run`) — not page-specific copies.
export const COMPONENTS = [
  { id: "btn", name: "Button", cls: "btn", app: "none — every screen inlines utilities",
    variants: [["default", `<button class="btn">Cancel</button>`],
               ["primary", `<button class="btn pri">Create session</button>`],
               ["ghost", `<button class="btn ghost">Skip</button>`],
               ["small", `<button class="btn sm">${ic("plus")} Add</button>`]] },
  { id: "pill", name: "Status pill", cls: "pill", app: "none — inline in ContextBar / SessionHeader",
    note: "The bare <code>.pill</code> is an ABSTRACT base — 0 of its 81 uses in the spec omit a modifier, and the base sets no background or colour, so it renders as plain bold text. The React component should require a variant rather than defaulting to none.",
    variants: [["base (abstract — never used alone)", `<span class="pill" style="outline:1px dashed var(--border);outline-offset:2px">draft</span>`],
               ["good", `<span class="pill good">passing</span>`],
               ["warn", `<span class="pill warn">stale</span>`],
               ["bad", `<span class="pill bad">failed</span>`],
               ["info", `<span class="pill info">default</span>`]] },
  { id: "chip", name: "Chip", cls: "chip", app: "none — ModelPicker inlines its own",
    variants: [["default", `<button class="chip">${ic("branch")} feat/orders-csv</button>`],
               ["on", `<button class="chip on">${ic("terminal")} Terminal</button>`],
               ["split", `<span class="chip split"><span>Opus 4.7</span><span>high</span></span>`]] },
  { id: "tag", name: "Tag", cls: "tag", app: "none",
    variants: [["default", `<span class="tag">${ic("key")} secret</span>`]] },
  { id: "icard", name: "Icon card", cls: "icard", app: "none",
    variants: [["default", `<div class="icard">${ic("folder")}<span>folder</span></div>`,
      ], ["second", `<div class="icard">${ic("clock")}<span>clock</span></div>`]] },
  { id: "callout", name: "Callout", cls: "callout", app: "none",
    variants: [["default", `<div class="callout"><p>The box keeps running when the app is closed.</p></div>`],
               ["ok", `<div class="callout ok"><p>Paired. Your box is reachable.</p></div>`],
               ["warn", `<div class="callout warn"><p>Context is nearly full — consider /compact.</p></div>`],
               ["danger", `<div class="callout danger"><p>This deletes the worktree and its uncommitted changes.</p></div>`]] },
  { id: "card", name: "Card", cls: "card", app: "GroupCard — PRIVATE to Settings.tsx",
    variants: [["default", `<div class="card"><h4>Appearance</h4><p>Theme, density and font size for this device.</p></div>`]] },
  { id: "setrow", name: "Settings row", cls: "setrow", app: "SettingField — PRIVATE to Settings.tsx",
    variants: [["with control", `<div class="setgrp"><h5>General</h5>
      <div class="setrow"><span class="lab"><b>Trust this box</b><span class="h">Auto-approve tool runs in every session.</span></span><span class="ctl"><span class="sw on"><i></i></span></span></div>
      <div class="setrow"><span class="lab"><b>Downloads folder</b></span><span class="ctl"><input class="inp" value="~/Downloads"></span></div></div>`]] },
  { id: "inp", name: "Input", cls: "inp", app: "SettingField — PRIVATE to Settings.tsx",
    variants: [["mono", `<input class="inp" value="~/projects/infra">`],
               ["sans", `<input class="inp sans" value="Deploy new billing service">`]] },
  { id: "sw", name: "Toggle", cls: "sw", app: "none — inline in Settings",
    variants: [["off", `<span class="sw"><i></i></span>`], ["on", `<span class="sw on"><i></i></span>`]] },
  { id: "srow", name: "Session row", cls: "srow", app: "none — inline in Sidebar.tsx",
    note: "Two things this row does not own. Its <b>inset</b> belongs to <code>.rail-scroll</code> — the selection marker (<code>.srow.on::before</code>) sits at <code>left:-8px</code> and hangs outside the row into that padding, so a primitive owning its own left inset would clip it. Its <b>metrics</b> belong to <code>[data-density]</code> — <code>--row-h/--row-px/--row-py</code> are defined there, not on <code>:root</code>, so the row collapses to an 18px unpadded line if it is rendered outside a density scope.",
    full: true,
    variants: [["comfortable — 32px rows", `<div data-density="comfortable">` + `<div class="rail-scroll" style="width:264px;padding:var(--sp-1) var(--sp-2) var(--sp-3)">
      <div class="grp" style="margin-top:0"><div class="grp-h">Sessions</div>
      <div class="srow"><span class="st idle"></span><span class="t">Add CSV export</span><span class="age">4m</span></div>
      <div class="srow on"><span class="st run"></span><span class="t">Deploy new billing service</span><span class="age">now</span></div>
      <div class="srow child"><span class="st ok"></span><span class="t">subagent · research</span><span class="age">1m</span></div>
      <div class="srow"><span class="st att"></span><span class="t">Refactor auth middleware</span><span class="age">12m</span></div>
      <div class="srow"><span class="st"></span><span class="t">Landing page copy</span><span class="age">2h</span></div>
      </div></div>` + `</div>`],
               ["compact — 26px rows", `<div data-density="compact">` + `<div class="rail-scroll" style="width:264px;padding:var(--sp-1) var(--sp-2) var(--sp-3)">
      <div class="grp" style="margin-top:0"><div class="grp-h">Sessions</div>
      <div class="srow"><span class="st idle"></span><span class="t">Add CSV export</span><span class="age">4m</span></div>
      <div class="srow on"><span class="st run"></span><span class="t">Deploy new billing service</span><span class="age">now</span></div>
      <div class="srow child"><span class="st ok"></span><span class="t">subagent · research</span><span class="age">1m</span></div>
      <div class="srow"><span class="st att"></span><span class="t">Refactor auth middleware</span><span class="age">12m</span></div>
      <div class="srow"><span class="st"></span><span class="t">Landing page copy</span><span class="age">2h</span></div>
      </div></div>` + `</div>`]] },
  { id: "eyebrow", name: "Eyebrow", cls: "eyebrow", app: "none",
    variants: [["default", `<div class="eyebrow">Section label</div>`]] },
];
