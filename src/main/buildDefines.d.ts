// Build-time globals injected into the main process by electron-vite's
// `define` (see electron.vite.config.ts). These exist at bundle time and
// are inlined as string literals — there is no runtime `process.env` read
// in a packaged build. Keeping them as separate ambient declarations
// instead of `declare global` (like src/renderer/types.d.ts does for
// __APP_VERSION__) because the main process already has its own tsconfig
// (`tsconfig.node.json`) and adding a `declare global` here would force a
// module wrapper.

declare const __MANTA_CHANNEL__: string;
