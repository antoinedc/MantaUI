/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/renderer/**/*.{html,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: "rgb(var(--canvas-rgb) / <alpha-value>)",
          elev: "rgb(var(--panel-rgb) / <alpha-value>)",
          soft: "rgb(var(--card-rgb) / <alpha-value>)",
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
