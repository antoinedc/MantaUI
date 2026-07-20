// Renderer-side log shipping (BET-187). The shared `logShip.mjs` module
// owns the buffering / ingest / format — this file is the thin renderer
// wrapper: it reads AppConfig.axiomToken via `window.api.configGet()` at
// init, mints a stable per-device id in localStorage, installs the
// console-capture wrap, and registers the standard browser event hooks
// (`error`, `unhandledrejection`, `online`, `offline`, `visibilitychange`,
// `pagehide`).
//
// Mobile PWA and desktop renderer both call `initRendererLogging("mobile"
// | "desktop")` from main.tsx after `setWindowApi(httpApi)` lands. The
// token is entered once in desktop Settings (mobile reads server config
// via configGet — no MobileSettings UI per the spec). Without a token,
// `ship()` is a safe no-op and `initRendererLogging` returns without
// installing anything: NO fetches to axiom.co, NO console noise.
//
// SPEC GUARD: the renderer ships DIRECTLY to Axiom (not through bui-
// server). When the phone↔box path is broken — the exact bug being
// debugged — the renderer must still be able to ship, so a bui-server
// proxy is explicitly out of scope.

import {
  createLogShipper,
  captureConsole,
  resolveAxiomConfig,
  type LogShipper,
} from "../shared/logShip.mjs";

// Module-level singleton. Lives for the lifetime of the renderer. `null`
// means "no token configured" — ship() below is a safe no-op.
let shipper: LogShipper | null = null;
let flushOnHide: (() => void) | null = null;

const DEVICE_KEY = "manta_log_device";

/**
 * Mint or restore an 8-hex-char device id from localStorage. Stable per
 * install so events from the same browser/app instance correlate. Falls
 * back to a timestamp-derived id if localStorage is unavailable (private
 * mode) — not stable, but still distinguishable per session.
 */
function getOrMintDevice(): string {
  try {
    const existing = localStorage.getItem(DEVICE_KEY);
    if (existing && /^[0-9a-f]{8}$/.test(existing)) return existing;
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    const id = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
    localStorage.setItem(DEVICE_KEY, id);
    return id;
  } catch {
    return Date.now().toString(16).slice(-8);
  }
}

/**
 * Initialize renderer logging. Reads AppConfig once (fire-and-forget — the
 * boot path must not block on Axiom). No-ops silently when no token is
 * configured. Safe to call multiple times; subsequent calls are idempotent.
 *
 * @param source "mobile" or "desktop" — stamped on every shipped event
 */
export async function initRendererLogging(source: "mobile" | "desktop"): Promise<void> {
  if (shipper) return; // already initialized
  let config: Parameters<typeof resolveAxiomConfig>[0]["config"] = null;
  try {
    config = await window.api.configGet();
  } catch {
    // configGet failing is non-fatal — render in unconfigured state.
    config = null;
  }
  const axiomCfg = resolveAxiomConfig({ env: {}, config });
  if (!axiomCfg) return;

  const device = getOrMintDevice();
  shipper = createLogShipper({
    ...axiomCfg,
    source,
    device,
    // keepalive so a flush fired from `pagehide` (window teardown) can
    // still reach the network — without keepalive the browser drops the
    // request as the document unloads. Batches at maxBatch=100 events
    // stay well under the 64KB keepalive cap.
    fetchFn: (url, init) =>
      fetch(url, { ...init, keepalive: true }),
  });
  captureConsole(shipper);

  // Standard browser event hooks (see spec). Each fires a single structured
  // ship() event so an AI querying Axiom can correlate these signals with
  // server-side state.
  window.addEventListener("error", (e) => {
    ship("error", "window error", {
      error: String(e.message ?? ""),
      source_file: String(e.filename ?? ""),
      line: Number(e.lineno ?? 0),
    });
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason;
    const detail =
      reason instanceof Error
        ? (reason.stack ?? String(reason.message ?? reason))
        : String(reason ?? "");
    ship("error", "unhandled rejection", { error: detail });
  });
  window.addEventListener("online", () => ship("info", "network online"));
  window.addEventListener("offline", () => ship("warn", "network offline"));
  document.addEventListener("visibilitychange", () =>
    ship("info", "visibility", { state: document.visibilityState }),
  );

  // Final flush on teardown. `pagehide` fires reliably across desktop +
  // iOS standalone PWA; `visibilitychange→hidden` is the secondary path
  // (a desktop window closing doesn't fire pagehide in some configs —
  // we trust the 5s flush timer to catch those, and skip a manual flush
  // here to keep the surface small).
  flushOnHide = () => {
    try { void shipper?.flush(); } catch { /* swallow */ }
  };
  window.addEventListener("pagehide", flushOnHide);
}

/**
 * Ship a single structured event. Safe no-op when no token is configured
 * OR init hasn't completed yet. Never throws.
 */
export function ship(
  level: "info" | "warn" | "error",
  msg: string,
  fields?: Record<string, unknown>,
): void {
  try { shipper?.log(level, msg, fields); } catch { /* swallow */ }
}
