// Hand-written type declarations for voiceClassifier.mjs. The implementation
// is plain JS so it can be imported by both Node-side modules (.mjs natively,
// .ts via Bundler resolution) and the renderer test suite (vitest .ts file).
// Keep this in sync with src/shared/voiceClassifier.mjs.

import type { VoiceAction } from "./types.js";

export function normalizeTranscript(raw: string): string;

export function classifyByRules(transcript: string): VoiceAction | null;

export function buildClassifierPrompt(transcript: string): {
  system: string;
  user: string;
};

export function coerceLlmAction(parsed: unknown): VoiceAction | null;
