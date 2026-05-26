// Hand-written type declarations for groq.mjs. The implementation is plain
// JS so the mobile server can import it natively; main imports through
// Bundler resolution. Keep in sync with src/shared/groq.mjs.

import type { VoiceAction, VoiceClassifyResult } from "./types.js";

export function transcribeAudio(args: {
  buffer: ArrayBuffer | Uint8Array | Buffer;
  mime: string;
  apiKey: string;
  model?: string;
}): Promise<{ text: string }>;

export function classifyVoiceCommand(args: {
  transcript: string;
  apiKey?: string;
  model?: string;
  useLlmFallback?: boolean;
}): Promise<VoiceClassifyResult & { action: VoiceAction }>;
