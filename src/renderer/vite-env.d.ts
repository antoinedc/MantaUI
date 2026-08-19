/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** BET-1191 — build-time flag for the on-call CTO voice UI. When "1" the
   *  voice-call surface is rendered; off (undefined or any other value) by
   *  default. A released app must not contain a reachable path to the UI
   *  unless this is set at build/dev time (`VITE_MANTA_VOICE=1 npm run dev`).
   *  Read exactly once in chatUtils `voiceUi`. */
  readonly VITE_MANTA_VOICE?: string;
}
