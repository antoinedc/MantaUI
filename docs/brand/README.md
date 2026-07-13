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

## Assets in this directory

- `manta-logo.png` — brand mark (raster).
- `tokens.css` — full design-token reference (colors, type, spacing, effects).

The original standalone design bundle was imported from
`~/.bui-uploads/BUI/.../manta UI - Desktop (standalone).html`.
