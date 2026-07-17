// Hand-written type declarations for webhooks.mjs. Implementation is plain JS
// so the renderer/main/relay tsconfig import it without crossing the process
// boundary. Keep this in sync with src/server/webhooks.mjs — only the exports
// actually consumed from `.ts` files need to be declared here; `.mjs` callers
// bypass TS and see the runtime shape directly.

// True when `token` is exactly 32 lowercase hex chars (128 bits) — the shape
// box_id / box_token / account_token / device_token all share.
export function isValidToken(token: unknown): token is string;
