import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  base: "./",
  plugins: [react()],
  define: {
    __MANTA_AXIOM_TOKEN__: JSON.stringify(process.env.MANTA_AXIOM_TOKEN ?? ""),
    __MANTA_AXIOM_DATASET__: JSON.stringify(process.env.MANTA_AXIOM_DATASET ?? "manta"),
  },
  resolve: { alias: { "@": resolve(__dirname, "src/renderer") } },
  build: {
    outDir: resolve(__dirname, "mobile/www"),
    emptyOutDir: true,
    rollupOptions: { input: resolve(__dirname, "src/renderer/index.html") },
  },
});
