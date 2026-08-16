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
import { resolveBoxChannel } from "../shared/channel.mjs";
import { startPoller } from "./startPoller.mjs";

const POLL_MS = 6 * 60 * 60 * 1000; // 6h, per the stage-2 spec.

// Not user-configurable — the update endpoint is part of the deployed website
// (website/updates/server.json) and a box must not be able to point itself at
// an arbitrary source. It IS channel-derived, though.
//
// This used to be a hardcoded prod URL, which quietly broke the staging track:
// a box installed with MANTA_CHANNEL=staging checked the PROD manifest and
// therefore updated itself onto PROD builds. The staging server track was
// published and live but nothing could ever follow it — which is why staging
// sat versions behind with no one noticing.
//
// `channelConfig().updateFeed` is the single source for this (prod →
// /updates, staging → /staging/updates, dev → null). `null` means "this build
// has no update feed": see startServerUpdatePoller, which skips polling
// entirely rather than inventing a URL. A local/dev box chasing a public feed
// is exactly what you don't want.
export function manifestUrl(channel = resolveBoxChannel()) {
  const feed = channel?.updateFeed;
  return feed ? `${feed}/server.json` : null;
}

/** Back-compat alias for the prod URL — kept because tests and callers import
 *  it as the default. Prefer `manifestUrl()`, which respects the channel. */
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
export function createUpdateCheck({ fetchManifest, currentVersion, url }) {
  let inFlight = false;
  // Channel-derived by default (prod → /updates, staging → /staging/updates).
  // `null` means this build has no feed — see tick().
  const feedUrl = url === undefined ? manifestUrl() : url;

  async function tick() {
    if (inFlight) return { available: false };
    // A dev build has `updateFeed: null`. Report "no update" rather than
    // falling back to the prod feed: a local build must never talk a real box
    // into installing a public release over it.
    if (!feedUrl) return { available: false };
    inFlight = true;
    try {
      const manifest = await fetchManifest(feedUrl);
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

    // Match the bus envelope documented in src/server/events.mjs: every
    // `{kind, payload}` event from the server carries the per-kind fields
    // INSIDE `payload`, not as siblings of `kind`. The renderer's dispatchFrame
    // (src/renderer/api/httpApi.ts) destructures `{kind, payload}` and hands
    // `payload` to its listeners; nesting here is what makes the stage-3
    // `onServerUpdateAvailable` subscription see `{version, notesUrl}`.
    bus.publish({
      kind: "serverUpdateAvailable",
      payload: { version: result.version, notesUrl: result.notesUrl ?? null },
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

  return startPoller(runTick, { intervalMs: POLL_MS, label: "server-update" });
}

/**
 * Map opencode's own `installation.update-available` event onto the EXISTING
 * `serverUpdateAvailable` bus event, so the shared update banner (which the
 * user already confirmed) raises for an opencode binary upgrade exactly as it
 * does for a server release (BET-1016).
 *
 * opencode may emit the same version repeatedly, and re-raising the banner for
 * a version already shown is noise — so this mirrors the
 * `startServerUpdatePoller` `lastNotifiedVersion` gate with its own dedup on
 * the last published opencode version. The dedup state lives in the closure
 * returned by the factory (module-level in effect: it persists across events),
 * keeping the mapping side-effect-free and unit-testable without a live event
 * stream or bus.
 *
 * @returns {(evt:any) => ({kind:string, payload:any}|null)} An `onEvent`
 *   handler for the opencode pump. Returns the bus event to publish for an
 *   opencode update (version not yet shown), or `null` when the event is not
 *   an opencode update, carries no usable version, or is a version already
 *   published.
 */
export function createOpencodeUpdateForwarder() {
  let lastPublishedOpencodeVersion = null;

  return function onEvent(evt) {
    if (!evt || evt.type !== "installation.update-available") return null;
    const version = evt.properties?.version;
    if (typeof version !== "string" || !version) return null;
    if (version === lastPublishedOpencodeVersion) return null;
    lastPublishedOpencodeVersion = version;
    return {
      kind: "serverUpdateAvailable",
      payload: { version, notesUrl: null },
    };
  };
}
