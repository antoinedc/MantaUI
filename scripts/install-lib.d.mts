// Hand-written type declaration for install-lib.mjs — same pattern as
// src/shared/channel.d.mts (a plain-JS module imported from a checked .ts
// file needs a sibling .d.mts under "moduleResolution": "Bundler").
//
// install-lib.mjs's full surface is the install.sh CLI/pairing-format
// helpers, exercised by the plain-Node scripts/install.test.mjs suite (no
// type declarations needed there — node:test loads the .mjs directly).
// This file declares ONLY the exports a checked .ts file actually imports
// (currently: src/renderer/mobile/pairPayload.test.ts, for the BET-386
// buildPairLink round-trip) — extend it if a future .ts file imports more.

/**
 * Build the canonical box-form pair link. See install-lib.mjs's JSDoc for
 * the full contract (BET-177 §2.4, BET-336 serverUrl, BET-386 scheme).
 */
export function buildPairLink(
  boxId: string,
  code: string,
  opts?: { serverUrl?: string; scheme?: string },
): string;
