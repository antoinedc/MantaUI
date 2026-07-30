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
        },
        accent: {
          DEFAULT: "rgb(var(--accent-rgb) / <alpha-value>)",
          soft: "rgb(var(--accent-soft-rgb) / <alpha-value>)",
        },
      },
      fontFamily: {
        mono: ["JetBrains Mono", "SF Mono", "Menlo", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};
