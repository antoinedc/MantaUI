// Hand-written type declarations for transport.mjs. The implementation is plain
// JS so any mobile-server code imports it natively; main/renderer import through
// bundler resolution. Keep in sync with src/shared/transport.mjs.

import type { AppConfig } from "./types.js";

// The three transport states a config can resolve to.
//   "http"       — paired to a manta-server (boxToken present)
//   "ssh"        — legacy/power SSH mode (host set), or onboarding was skipped
//   "onboarding" — fresh install; show the full-screen onboarding flow
export type TransportMode = "http" | "ssh" | "onboarding";

// A parsed POST /auth/claim response.
export type ClaimResult =
  | { ok: true; boxToken: string; boxId: string }
  | { ok: false; error: "invalid_response" };

// True iff `token` is a 32-lowercase-hex string (128-bit box_id / box_token).
export function isValidBoxToken(token: unknown): token is string;

// The single boxes-domain suffix the direct-hostname resolver prefixes every
// per-box URL with (BET-198 — relay dropped). Mirrors the (non-exported)
// BOXES_DOMAIN constant in src/gateway/index.mjs; kept as a literal on both
// sides so neither has to import the other.
export const BOXES_DOMAIN: "boxes.mantaui.com";

// Build the canonical `https://<boxId>.<BOXES_DOMAIN>` URL a direct-mode
// client persists as its server URL after a successful /auth/claim. Throws on
// a malformed boxId — the caller must have already shape-gated it.
export function boxDirectUrl(boxId: string): string;

// Resolve which transport a config should use (see transport.mjs for the rule).
export function resolveTransportMode(
  config: Partial<AppConfig> | null | undefined,
): TransportMode;

// Validate + normalize the JSON body of a POST /auth/claim response.
export function parseClaimResponse(json: unknown): ClaimResult;

// Which client the DESKTOP should install as window.api (BET-58):
//   "http"    — paired config → the httpApi server client (keep preload for
//               Electron-local affordances under window.__mantaPreload)
//   "preload" — SSH/onboarding/skipped → the legacy preload bridge
// `hasPreload` is `!!window.api` (Electron sets it; the mobile build doesn't).
export function selectDesktopTransport(
  config: Partial<AppConfig> | null | undefined,
  hasPreload: boolean,
): "http" | "preload";

// The localStorage keys httpApi reads (manta_server / manta_token), seeded from a
// paired desktop config's serverUrl + boxToken. Returns null when the config
// isn't a usable paired-http config (missing serverUrl or invalid boxToken).
export function desktopHttpClientSeed(
  config: Partial<AppConfig> | null | undefined,
): { manta_server: string; manta_token: string } | null;
