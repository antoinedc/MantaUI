/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/renderer/**/*.{html,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: { DEFAULT: "#0e0f12", elev: "#15171c", soft: "#1b1e25" },
        border: { DEFAULT: "#262932", strong: "#383c47" },
        text: { DEFAULT: "#e6e7ea", muted: "#9aa0aa", faint: "#6b7280" },
        accent: { DEFAULT: "#7c9cff", soft: "#3a4a8a" },
      },
      fontFamily: {
        mono: ["JetBrains Mono", "SF Mono", "Menlo", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};
