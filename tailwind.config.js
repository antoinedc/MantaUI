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
        mono: ["JetBrains Mono", "SF Mono", "Menlo", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};
