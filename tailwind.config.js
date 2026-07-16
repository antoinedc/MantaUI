/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/renderer/**/*.{html,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: { DEFAULT: "#0B1020", elev: "#12182F", soft: "#171F3A" },
        border: { DEFAULT: "#253055", strong: "#33406B" },
        text: { DEFAULT: "#F8FAFC", muted: "#A7B1C4", faint: "#5C6578" },
        accent: { DEFAULT: "#5A88FF", soft: "#1740AE" },
      },
      fontFamily: {
        mono: ["JetBrains Mono", "SF Mono", "Menlo", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};
