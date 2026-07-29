// pairPage.mjs — the box-served /pair onboarding page (BET-239).
//
// Three auth-exempt GET routes (wired in index.mjs, exempted in auth.mjs):
//   /pair          → pair.html (static wizard; code arrives in the URL
//                    FRAGMENT so it never reaches the server or its logs)
//   /pair/qr.png   → QR PNG of the canonical <scheme>://pair payload. Shape-
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
import { channelConfig } from "../shared/channel.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export const HEX32_RE = /^[0-9a-f]{32}$/;
export const CODE_RE = /^\d{6}$/;

/**
 * Resolve the box's pair-link URL scheme from `MANTA_CHANNEL` (BET-370 +
 * BET-373). The box's release tarball bakes a `MANTA_CHANNEL` env var at
 * deploy time (mirroring the desktop's `__MANTA_CHANNEL__`); the same
 * channel table in `src/shared/channel.mjs` maps it to the OS-registered
 * URL scheme. Without this hook the QR always emits `manta://` regardless
 * of the channel — a staging desktop user scanning a staging-box QR would
 * be routed to whatever app last registered `manta://`, never to their
 * own staging install.
 *
 * Falls back to `"prod"` for an unset / unrecognised env value — matches
 * `resolveChannel`'s defensive rule (a mis-configured box must still
 * mint a working QR, not throw at request time). The function re-reads
 * `process.env.MANTA_CHANNEL` on every call rather than memoizing — it's
 * cheap, and tests rely on being able to mutate the env between cases.
 */
export function resolveBoxChannel() {
  const raw =
    typeof process !== "undefined" && process.env
      ? process.env.MANTA_CHANNEL ?? ""
      : "";
  // channelConfig handles the unknown-channel → prod fallback (same rule
  // as resolveChannel: a bad lookup must still return a usable config).
  return channelConfig(raw || "prod");
}

/**
 * Validate the /pair/qr.png query. Returns
 *   { ok: true, payload: "<scheme>://pair?box=<box>&code=<code>[&server=<url>]" }
 * or
 *   { ok: false, error: <string> }.
 * Box is lowercased before validation (hostnames arrive case-insensitive).
 *
 * BET-373 (channel-aware wire format): `scheme` defaults to the box's own
 * channel-derived URL scheme (so a staging box emits `manta-staging://…`).
 * The caller can still override — tests pin each scheme directly — but
 * the default ties the QR to the OS-registered scheme the box was built
 * for, closing the staging-desktop-pair loop (BET-370 made the desktop
 * channel-aware; this closes the same gap on the box side).
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
export function validatePairQrQuery(query, scheme) {
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
  // BET-373: default to the box's own channel-derived scheme. `scheme ? : …`
  // collapses the "caller passed nothing" / "caller passed undefined" /
  // "caller passed empty string" cases into one fallback — the helper is
  // a thin renderer-side channel lookup, callers shouldn't have to know
  // how to spell "use the box's channel".
  const useScheme = scheme || resolveBoxChannel().urlScheme;
  let payload = `${useScheme}://pair?box=${box}&code=${code}`;
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
