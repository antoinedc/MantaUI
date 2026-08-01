// BET-422: trimmed spacing scale to 11 steps. Width/height/minHeight/maxHeight
// are decoupled from theme.spacing and keep the full default Tailwind scale so
// dimension utilities (w-64, h-52, max-h-32, …) survive the spacing trim.
// Off-grid pure-spacing usages (p*, m*, gap*, space-*, inset*) were rounded to
// the nearest step in the renderer source.
const spacingScale = {
  0: "0",
  px: "1px",
  1: "0.25rem",
  2: "0.5rem",
  3: "0.75rem",
  4: "1rem",
  5: "1.25rem",
  6: "1.5rem",
  8: "2rem",
  10: "2.5rem",
  12: "3rem",
};

// Full default Tailwind spacing scale — used for dimension scales that must NOT
// be trimmed (width/height/minHeight/maxHeight). Keeping the full set preserves
// every dimension utility used in the codebase (w-64, h-52, max-h-40, …).
const fullSpacingScale = {
  0: "0",
  px: "1px",
  0.5: "0.125rem",
  1: "0.25rem",
  1.5: "0.375rem",
  2: "0.5rem",
  2.5: "0.625rem",
  3: "0.75rem",
  3.5: "0.875rem",
  4: "1rem",
  5: "1.25rem",
  6: "1.5rem",
  7: "1.75rem",
  8: "2rem",
  9: "2.25rem",
  10: "2.5rem",
  11: "2.75rem",
  12: "3rem",
  14: "3.5rem",
  16: "4rem",
  20: "5rem",
  24: "6rem",
  28: "7rem",
  32: "8rem",
  36: "9rem",
  40: "10rem",
  44: "11rem",
  48: "12rem",
  52: "13rem",
  56: "14rem",
  60: "15rem",
  64: "16rem",
  72: "18rem",
  80: "20rem",
  96: "24rem",
};

const dimensionScale = {
  ...fullSpacingScale,
  full: "100%",
  screen: "100vh",
  min: "min-content",
  max: "max-content",
};

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/renderer/**/*.{html,ts,tsx}"],
  theme: {
    // Replaced (not extended) so only the 11 steps generate padding/margin/
    // gap/space/inset utilities. Dimension scales below are decoupled.
    spacing: spacingScale,
    // MUST be dimensionScale, not fullSpacingScale. fullSpacingScale is only
    // the numeric steps — it has no `full`/`screen`/`min`/`max`. Setting
    // width/height to it silently DELETED `w-full` (73 usages) and `h-full`
    // (17 usages) from the build, so every full-height flex chain in the app
    // collapsed to content height: the sidebar stopped filling the window and
    // the transcript container stopped scrolling. Nothing failed — the classes
    // just compiled to nothing. (BET-422 regression, fixed in BET-447.)
    width: dimensionScale,
    height: dimensionScale,
    minHeight: dimensionScale,
    maxHeight: dimensionScale,
    extend: {
      colors: {
        bg: {
          DEFAULT: "rgb(var(--canvas-rgb) / <alpha-value>)",
          elev: "rgb(var(--panel-rgb) / <alpha-value>)",
          soft: "rgb(var(--card-rgb) / <alpha-value>)",
        },
        // Hover/active fill token (BET-539). `bg-fill-hover` and `bg-fill-active`
        // resolve to --fill-hover / --fill-active; `bg-fill` resolves to the
        // DEFAULT --fill base.
        fill: {
          DEFAULT: "var(--fill)",
          hover: "var(--fill-hover)",
          active: "var(--fill-active)",
        },
        border: {
          DEFAULT: "rgb(var(--border-rgb) / <alpha-value>)",
          subtle: "var(--border-subtle)",
          strong: "var(--border-strong)",
        },
        text: {
          DEFAULT: "rgb(var(--tx1-rgb) / <alpha-value>)",
          muted: "var(--tx2)",
          faint: "var(--tx3)",
          // Decorative text only — sub-AA tier (--tx4, ~3:1). Never use for a
          // timestamp, path, placeholder, or label. The contrast gate
          // (src/shared/contrast.mjs) pins tx4 on canvas at 3:1. (BET-410)
          quiet: "var(--tx4)",
        },
        accent: {
          DEFAULT: "rgb(var(--accent-rgb) / <alpha-value>)",
          soft: "rgb(var(--accent-soft-rgb) / <alpha-value>)",
          solid: "var(--accent-solid)",
          tx: "var(--accent-tx)",
          bg: "var(--accent-bg)",
        },
        ok: {
          DEFAULT: "rgb(var(--ok-rgb) / <alpha-value>)",
          bg: "var(--ok-bg)",
        },
        warn: {
          DEFAULT: "rgb(var(--warn-rgb) / <alpha-value>)",
          bg: "var(--warn-bg)",
        },
        danger: {
          DEFAULT: "rgb(var(--danger-rgb) / <alpha-value>)",
          bg: "var(--danger-bg)",
        },
        info: {
          DEFAULT: "rgb(var(--info-rgb) / <alpha-value>)",
        },
        inset: "var(--inset)",
        raised: "var(--raised)",
        "on-accent": "var(--on-accent)",
      },
      fontFamily: {
        sans: [
          "Inter Variable",
          "Inter",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        mono: [
          "JetBrains Mono Variable",
          "JetBrains Mono",
          "SF Mono",
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
      // BET-413 type scale. Each entry carries its own line-height (and
      // letter-spacing where the role needs it). Weight is applied at the
      // call site with font-* utilities — Tailwind's fontSize config does
      // not bundle weight. These eight roles replace every ad-hoc
      // text-[Npx] / text-xs / text-sm / text-base in the renderer.
      fontSize: {
        display: ["24px", { lineHeight: "1.25" }],
        title: ["17px", { lineHeight: "1.3" }],
        prose: ["15px", { lineHeight: "1.55" }],
        body: ["14px", { lineHeight: "1.5" }],
        label: ["13px", { lineHeight: "1.4" }],
        meta: ["12px", { lineHeight: "1.4" }],
        micro: ["11px", { lineHeight: "1.3", letterSpacing: "0.08em" }],
        code: ["13px", { lineHeight: "1.55" }],
      },
    },
  },
  plugins: [],
};
