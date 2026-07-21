// Server-update poller (BET-225 stage 2 — server wiring).
//
// Pulls the static version manifest from mantaui.com once at boot and every 6h,
// compares against the running `currentVersion`, and on a newer release:
//   1. publishes a `serverUpdateAvailable` bus event for the renderer banner
//      (stage 3 will surface this as the shared UpdateBar component), AND
//   2. fires ONE informational notification through the existing
//      `push.fireNotify` router (the same path the AI `notify` tool uses) so
//      a closed/minimised app still gets told via Web Push / APNs.
// Dedup is per-version: a re-poll of the same version publishes nothing. A
// strictly newer version resets the gate.
//
// Shape mirrors src/server/outbox.mjs: a pure `createUpdateCheck(...)`
// returning an async `tick()` that does the manifest fetch + compare, plus a
// `startServerUpdatePoller(...)` wrapper that wires boot+interval+inFlight
// guard+unref and owns the dedup state. The split exists so the compare + the
// fetch failure path are testable without timers, network, or live `push`.

import { isUpdateAvailable } from "../shared/versionCompare.mjs";

const POLL_MS = 6 * 60 * 60 * 1000; // 6h, per the stage-2 spec.

// Hardcoded by design — the update endpoint is part of the deployed website
// (website/updates/server.json) and is not user-configurable. A box should not
// be able to override where it learns about a new release.
export const MANIFEST_URL = "https://mantaui.com/updates/server.json";

/**
 * Default `fetchManifest` used when no override is supplied — fetches the
 * manifest URL and parses JSON. Any non-2xx is treated as a fetch failure so
 * `createUpdateCheck`'s catch-handler returns `{ available:false }` rather than
 * crashing the poller. Kept tiny on purpose so the override-injection point
 * the spec requires stays a single line in production wiring.
 *
 * Exported separately so tests can import it as a baseline stub shape and
 * so production callers can swap to a different fetch impl without rewriting
 * the URL/parse logic.
 */
export async function defaultFetchManifest(url = MANIFEST_URL) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`manifest fetch failed: ${res.status}`);
  return await res.json();
}

/**
 * Build a single update-check step (testable without timers or a live bus).
 * Returns `{ tick }` which: fetches the manifest via the injectable
 * `fetchManifest`, runs `isUpdateAvailable` against `currentVersion`, and
 * returns `{ available, version, notesUrl }`. On a fetch throw or a malformed
 * manifest (missing/non-string `version`) it returns `{ available:false }`
 * and does NOT re-throw — a flaky manifest URL must never crash the server.
 *
 * Re-entrancy guarded (same shape as `createOutboxScanner`): a tick that is
 * still running when a second one is invoked returns immediately.
 *
 * @param {object} deps
 * @param {(url:string) => Promise<any>} deps.fetchManifest
 * @param {string} deps.currentVersion
 * @returns {{ tick: () => Promise<{available:boolean, version?:string, notesUrl?:string|null}> }}
 */
export function createUpdateCheck({ fetchManifest, currentVersion }) {
  let inFlight = false;

  async function tick() {
    if (inFlight) return { available: false };
    inFlight = true;
    try {
      const manifest = await fetchManifest(MANIFEST_URL);
      if (!manifest || typeof manifest.version !== "string") {
        return { available: false };
      }
      const available = isUpdateAvailable(currentVersion, manifest.version);
      const notesUrl =
        typeof manifest.notes_url === "string" ? manifest.notes_url : null;
      return available
        ? { available: true, version: manifest.version, notesUrl }
        : { available: false };
    } catch {
      return { available: false };
    } finally {
      inFlight = false;
    }
  }

  return { tick };
}

/**
 * Start the server-update poller. Mirrors `startOutboxPoller`'s shape exactly
 * (boot-tick + setInterval + unref + stop()):
 *
 *   - runs `tick()` once immediately, then every 6h
 *   - re-entrancy guarded inside `tick()` (no duplicate publishes per tick)
 *   - on `available:true`, publishes ONE `serverUpdateAvailable` bus event AND
 *     fires ONE informational notification via the injected `notify` (the
 *     caller passes `push.fireNotify` in production; tests pass a stub)
 *   - dedup gate: `lastNotifiedVersion` ensures a single version is published
 *     AT MOST ONCE across the whole process lifetime — re-poll of the same
 *     manifest version is a no-op, a strictly newer version resets the gate
 *
 * `fetchManifest` defaults to `defaultFetchManifest` (uses `globalThis.fetch`).
 * Tests inject a stub.
 *
 * @param {object} deps
 * @param {{ publish: (evt:any) => void }} deps.bus
 * @param {string} deps.currentVersion
 * @param {(args:{message:string, title?:string, sessionID?:string|null}) => Promise<any>} [deps.notify]
 * @param {(url:string) => Promise<any>} [deps.fetchManifest]
 * @returns {{ stop: () => void }}
 */
export function startServerUpdatePoller(
  { bus, currentVersion, notify, fetchManifest } = {},
) {
  const realFetchManifest = fetchManifest ?? defaultFetchManifest;
  const { tick } = createUpdateCheck({
    fetchManifest: realFetchManifest,
    currentVersion,
  });
  let lastNotifiedVersion = null;

  async function runTick() {
    const result = await tick();
    if (!result?.available || !result.version) return;
    if (result.version === lastNotifiedVersion) return;
    lastNotifiedVersion = result.version;

    bus.publish({
      kind: "serverUpdateAvailable",
      version: result.version,
      notesUrl: result.notesUrl ?? null,
    });

    if (typeof notify === "function") {
      try {
        await notify({
          message: `Server update ${result.version} available`,
          title: "mantaui",
          sessionID: null,
        });
      } catch (e) {
        // Push must never crash the poller; mirror the warn-and-continue
        // pattern used elsewhere in push.mjs.
        console.warn(
          "[serverUpdate] notify failed:",
          e?.message ?? e,
        );
      }
    }
  }

  void runTick();
  const timer = setInterval(() => void runTick(), POLL_MS);
  timer.unref();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
