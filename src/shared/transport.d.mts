// Hand-written type declarations for transport.mjs. The implementation is plain
// JS so any mobile-server code imports it natively; main/renderer import through
// bundler resolution. Keep in sync with src/shared/transport.mjs.

import type { AppConfig } from "./types.js";

// The three transport states a config can resolve to.
//   "http"       — paired to a bui-server (boxToken present)
//   "ssh"        — legacy/power SSH mode (host set), or onboarding was skipped
//   "onboarding" — fresh install; show the full-screen onboarding flow
export type TransportMode = "http" | "ssh" | "onboarding";

// A parsed POST /auth/claim response.
export type ClaimResult =
  | { ok: true; boxToken: string; boxId: string }
  | { ok: false; error: "invalid_response" };

// True iff `token` is a 32-lowercase-hex string (128-bit box_id / box_token).
export function isValidBoxToken(token: unknown): token is string;

// Resolve which transport a config should use (see transport.mjs for the rule).
export function resolveTransportMode(
  config: Partial<AppConfig> | null | undefined,
): TransportMode;

// Validate + normalize the JSON body of a POST /auth/claim response.
export function parseClaimResponse(json: unknown): ClaimResult;
