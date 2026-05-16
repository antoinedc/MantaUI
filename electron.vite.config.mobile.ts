import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  base: "./",
  plugins: [react()],
  resolve: { alias: { "@": resolve(__dirname, "src/renderer") } },
  build: {
    outDir: resolve(__dirname, "mobile/www"),
    emptyOutDir: true,
    rollupOptions: { input: resolve(__dirname, "src/renderer/index.html") },
  },
});
