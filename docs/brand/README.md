# manta UI — Brand & Design System

Source of truth for the **manta** rebrand (formerly `bui` / `better-ui`).
Imported from the Claude design project
`d88214b7-700d-4179-b4c1-4bbc3c7de0e8` (2026-07-13).

Rebrand epic: see Multica. Scope for now = **name, logo, brand, colors**.
The full desktop/mobile screen redesign ("screens" section) is **out of
scope** for this cycle.

## Name

- Product name: **manta UI** (wordmark styled lowercase "manta UI").
- Short name: **manta**.
- The wordmark uses a rounded geometric display face (Quicksand family) and
  lives ONLY as an image asset — it is never used in product UI. Product UI
  uses Inter.

## Logo

- `manta-logo.png` — the mark: a stylized manta ray in the brand
  cyan→blue gradient on the navy canvas.
- Gradient: `linear-gradient(135deg, #49D7F5 0%, #2E6BFF 100%)`
  (`--gradient-brand`).
- Icon sets (PWA / iOS / Android / desktop `.icns`) must be regenerated from
  this mark. The current onboarding "logo" is a generic inline SVG and must be
  replaced with the manta mark + wordmark.

## Typography

- **UI / sans:** Inter (`--font-sans`).
- **Code / mono:** JetBrains Mono (`--font-mono`).
- Compact, technical type scale (dev tool, not marketing). Full scale in
  `tokens.css`.

## Colors (dark-first, oceanic)

Base anchors from the brand kit:

| Role       | Hex       | Token           |
| ---------- | --------- | --------------- |
| App bg     | `#0B1020` | `--navy-950`    |
| Primary    | `#2E6BFF` | `--blue-500`    |
| Accent     | `#49D7F5` | `--cyan-400`    |
| Text       | `#F8FAFC` | `--slate-50`    |

Full primitive ramps (navy / blue / cyan / slate / green / amber / red) and
semantic aliases (surfaces, borders, text roles, actions, status, glows,
gradients) are in **`tokens.css`** — the authoritative token list. Product
code should map to the semantic aliases (`--surface-app`, `--action-primary`,
`--status-warning`, …), not raw hex.

### Migration mapping (current → manta)

The current app is Tailwind-theme-based (`tailwind.config.js`) plus a handful
of inline hex constants. Rough target mapping for the colors subissue:

| Current                                   | manta target            |
| ----------------------------------------- | ----------------------- |
| `bg` `#0e0f12` / `#15171c` / `#1b1e25`    | navy `950/850/800`      |
| `border` `#262932` / `#383c47`            | navy `700/600`          |
| `text` `#e6e7ea` / `#9aa0aa` / `#6b7280`  | slate `50/300/500`      |
| `accent` `#7c9cff` / `#3a4a8a`            | blue `400/700`          |
| `CLAUDE_ORANGE` `#d97757` (chatShared.ts) | revisit — brand accent  |
| cache-write amber `#f59e0b` (ContextBar)  | `--amber-500` `#F0A934` |
| cache-read teal `#0ea5a4` (ContextBar)    | `--cyan-500` `#22BEE0`  |
| ctx stage green/yellow/orange/red         | green/amber/red ramps   |

Decide during implementation whether to keep Tailwind + a hex map, or move to
CSS custom properties matching `tokens.css` (the latter mirrors mobile.css's
duplication problem away).

## Voice & content

manta writes like **a senior engineer pairing with you**: direct, concise,
technically literate, never chirpy.

- **Person.** Second person for the user ("your VPS", "you approved"). The
  agent speaks first person, present-progressive, narrating: "I'll add the
  device flow. Let me look at the current auth module first."
- **Tone.** Calm, factual, confident. State outcomes, not adjectives.
  `3 files changed · 42s`, not "Success! 🎉 All done!".
- **Casing.** Sentence case everywhere — buttons, titles, menus (New session,
  not New Session). ALL-CAPS only for tiny eyebrow/section labels with wide
  tracking (TODAY, WORKSPACE).
- **Verbs.** Action labels imperative and short: Run, Stop, Approve, Deny,
  Connect VPS, New session, Create & run.
- **Numbers & code.** Counts, durations, paths, branches, IDs, commands are
  always monospace (JetBrains Mono): `feat/auth`, `vps-fra-1`, `sess_8fa2`,
  `$ npm test`, `+3`.
- **Status vocabulary** (small, controlled): Running · Awaiting approval ·
  Idle · Failed · Offline · Done.
- **Punctuation.** Middot `·` separates metadata (Frankfurt · 4 vCPU · 8 GB).
  Arrows / check-cross (`✓`, `›`) appear in terminal output only.
- **Emoji.** None in product UI. The only icon-in-text is the monospace
  `✓`/`›` inside terminal wells.
- **Errors.** Plain and specific — say what failed and the next action:
  "VPS unreachable. Reconnect?" — never "Oops!".

## Visual foundations

- **Vibe.** Deep-ocean dark. Near-black navy canvas (`#0B1020`), cool slate
  text, lit by electric blue (primary) + bright cyan (accent) — the manta
  mark's gradient. Restrained, technical, high-contrast. "Instrument panel,"
  not "landing page."
- **Color.** Dark-first and **dark-only** (no light theme). Navy elevation
  ramp (`--surface-app → sunken → panel → card → raised`) + a darker-than-
  canvas inset (`#070B17`) for terminals/code wells. Blue = primary actions;
  cyan = accent/highlight and the "agent is alive" color. Semantics lean
  cool: success `#22C79A`, warning `#F0A934`, danger `#F0505F`, info = cyan.
  Color used sparingly — most UI is navy + slate; brand color reserved for
  actions, active states, status.
- **Type.** Inter for all UI; JetBrains Mono for anything machine-generated /
  copy-pasteable. Compact scale — body 14px, dense rows 13px. Tight negative
  tracking on headings. No serifs.
- **Density.** 4px grid, information-dense. Fixed chrome: 56px icon rail,
  264px sidebar, 48px topbar. Controls 28–34px.
- **Backgrounds.** Flat navy fills — no photos, no illustration, no noise.
  Only gradient is brand cyan→blue (`--gradient-brand`): logo mark, small
  agent avatars, active tab underlines, occasional emphasis — never full-bleed.
- **Borders.** Hairlines do the work: 1px translucent white (`--border-subtle`,
  8%) or solid navy (`--border-default`), brightening one step on hover.
- **Shadows.** Deep, cool, low-spread, dark-tuned (`--shadow-xs → xl`) + inset
  for code wells. Elevation for overlays more than resting cards.
- **Glows.** Signature affordance: a colored ring (`--glow-blue`,
  `--glow-cyan`) marks live states. **Cyan glow = "working."**
- **Radii.** Soft, not pill-round: 6–8px controls, 12px cards/panels, 16px+
  sheets/dialogs. `--radius-full` only for pills, dots, switch track.
- **Cards.** `--surface-card` fill, 1px `--border-default`, 12px radius,
  subtle shadow. Interactive: lift 2px + brighten border on hover. "Running"
  cards drop the border for a cyan glow.
- **Transparency/blur.** Overlays only: dialogs/toasts use near-opaque
  `--surface-overlay` + 12px backdrop blur over a dark scrim
  (`rgba(4,7,16,0.66)` + 4px blur). Resting surfaces opaque.
- **Motion.** Quick, precise — 120–280ms, `cubic-bezier(0.22,1,0.36,1)`, no
  bounce. Fades + short translate-ups; live status dot has a gentle ping halo.
  Reduced-motion collapses to instant.
- **Hover/press.** Hover = brighten (fill/border/glow). Press = 0.5px nudge
  down + darker action color. Ghost elements: transparent → ~10% white.
- **Focus.** 2px brand-blue ring offset from surface (`--ring`) + soft blue
  halo on inputs. Always visible — keyboard-first app.

## Provenance & ground truth

Built from a minimal brand kit (`mantaUI_brand_kit.zip`): the **four anchor
colors** (`#0B1020` / `#2E6BFF` / `#49D7F5` / `#F8FAFC`), the **two fonts**
(Inter, JetBrains Mono), and the **logo** are **ground truth**. Everything
else (token ramps, semantic aliases, components) is an original, considered
proposal — open to iteration.

**Font note:** Inter + JetBrains Mono load from Google Fonts (no self-hosted
binaries provided). The logo wordmark uses a rounded-geometric display face
(Quicksand-family look) that lives ONLY in the logo image — never in product
UI. Self-hosted fonts / the exact logo typeface would need the source files.

## Assets in this directory

- `manta-logo.png` — brand mark (raster).
- `tokens.css` — full design-token reference (colors, type, spacing, effects).

The original standalone design bundle was imported from
`~/.bui-uploads/BUI/.../manta UI - Desktop (standalone).html`.
