// pairPage.mjs — the box-served /pair onboarding page (BET-239).
//
// Three auth-exempt GET routes (wired in index.mjs, exempted in auth.mjs):
//   /pair          → pair.html (static wizard; code arrives in the URL
//                    FRAGMENT so it never reaches the server or its logs)
//   /pair/qr.png   → QR PNG of the canonical manta://pair payload. Shape-
//                    validated encoder only — it never touches the pairing
//                    registry and cannot mint or verify codes.
//   /pair/logo.png → the Manta mark (binary committed next to this file).
//
// Assets are re-read per request (no in-process cache) — mirrors the
// serve-page module's re-read pattern so a deploy is live immediately.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { isPrivateServerUrl } from "../shared/transport.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export const HEX32_RE = /^[0-9a-f]{32}$/;
export const CODE_RE = /^\d{6}$/;

/**
 * Validate the /pair/qr.png query. Returns
 *   { ok: true, payload: "manta://pair?box=<box>&code=<code>[&server=<url>]" }
 * or
 *   { ok: false, error: <string> }.
 * Box is lowercased before validation (hostnames arrive case-insensitive).
 *
 * BET-336 (Tailscale pair link): an optional `server` query param is
 * accepted. When absent or empty, the payload has no `&server=` and the
 * downstream parser falls through to the public hostname — the same wire
 * shape pre-BET-336 callers produce. When present, it must pass
 * `isPrivateServerUrl` (the SAME private/tailnet gate the renderer-side
 * `parsePairPayload` uses); a public or otherwise non-private value is
 * refused outright with an error — a pair link that points the device at
 * a non-private host is exactly the "crafted link → attacker's server"
 * attack the gate prevents.
 */
export function validatePairQrQuery(query) {
  const box =
    typeof query?.box === "string" ? query.box.trim().toLowerCase() : "";
  const code = typeof query?.code === "string" ? query.code.trim() : "";
  const server =
    typeof query?.server === "string" ? query.server.trim() : "";
  if (!HEX32_RE.test(box)) {
    return { ok: false, error: "box must be a 32-char lowercase hex id" };
  }
  if (!CODE_RE.test(code)) {
    return { ok: false, error: "code must be exactly 6 digits" };
  }
  let payload = `manta://pair?box=${box}&code=${code}`;
  if (server !== "") {
    if (!isPrivateServerUrl(server)) {
      return {
        ok: false,
        error: "server must be a private/tailnet http(s) URL",
      };
    }
    payload += `&server=${encodeURIComponent(server)}`;
  }
  return { ok: true, payload };
}

/** Render the QR PNG for a validated payload. */
export async function renderPairQr(payload) {
  return QRCode.toBuffer(payload, { type: "png", width: 360, margin: 1 });
}

/** Read a pair-page asset (pair.html / pair-logo.png) fresh from disk. */
export function readPairAsset(name) {
  return readFileSync(join(HERE, name));
}
