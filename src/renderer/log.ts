// Renderer-side log shipping (BET-187, BET-217). The shared `logShip.mjs`
// module owns the buffering / ingest / format — this file is the thin
// renderer wrapper: it reads AppConfig.shareAnalytics via
// `window.api.configGet()` at init (desktop only; mobile always ships),
// mints a stable per-device id in localStorage, installs the console-
// capture wrap, and registers the standard browser event hooks.
//
// Token/dataset come from build-time constants `__MANTA_AXIOM_TOKEN__` /
// `__MANTA_AXIOM_DATASET__` (Vite `define`, sourced from env at build).
// There is no user-typed token anywhere — desktop Settings exposes a
// single boolean opt-out in the General tab.
//
// Mobile PWA and desktop renderer both call `initRendererLogging("mobile"
// | "desktop")` from main.tsx after `setWindowApi(httpApi)` lands. Without
// a build-time token, `ship()` is a safe no-op and `initRendererLogging`
// returns without installing anything: NO fetches to axiom.co, NO console
// noise.
//
// SPEC GUARD: the renderer ships DIRECTLY to Axiom (not through manta-
// server). When the phone↔box path is broken — the exact bug being
// debugged — the renderer must still be able to ship, so a manta-server
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
const ANALYTICS_CACHE_KEY = "manta_share_analytics";

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
 * Read a localStorage key without throwing (private mode / quota /
 * disabled storage). Returns null on any failure — callers must treat
 * absence as "no cached value".
 */
function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Write a localStorage key without throwing (private mode / quota).
 * Mirrors getOrMintDevice's swallow-on-failure pattern.
 */
function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* swallow — private mode / quota */
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

  // Mobile always ships; desktop honors the user's Share-analytics toggle.
  let shareAnalytics = true;
  if (source === "desktop") {
    try {
      const config = await window.api.configGet();
      shareAnalytics = config?.shareAnalytics ?? true;
      safeSet(ANALYTICS_CACHE_KEY, shareAnalytics ? "1" : "0");
    } catch {
      // Box unreachable — honor the last-known choice so an offline boot of a
      // user who opted OUT does not silently start shipping again.
      shareAnalytics = safeGet(ANALYTICS_CACHE_KEY) !== "0";
    }
  }

  const axiomCfg = resolveAxiomConfig({
    env: {},
    config: {
      axiomToken: __MANTA_AXIOM_TOKEN__,
      axiomDataset: __MANTA_AXIOM_DATASET__,
      shareAnalytics,
    },
  });
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
