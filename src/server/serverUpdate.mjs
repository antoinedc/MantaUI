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

// 30 min. This was 6h, chosen when every poll cost a full manifest download.
// It no longer does: `defaultFetchManifest` sends `If-None-Match`, and the
// website serves an ETag, so a poll that finds nothing new is a bodyless 304.
// Twelve 304s an hour move LESS data than one 200 every six hours did, and the
// worst-case "a release is out and the box hasn't noticed" window drops from
// 6h to 30min.
//
// Latency at the moment it actually matters is handled separately and does not
// depend on this cadence at all: the desktop runs an on-demand check when it
// connects, and Settings → About has a manual button. Both call the same
// `check()` this poller returns. A shorter interval here is the backstop for
// the case where nobody is looking (so the push notification still lands),
// NOT the primary path.
const POLL_MS = 30 * 60 * 1000;

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
 * Build a conditional-GET manifest fetcher.
 *
 * The manifest is a ~95-byte JSON file that changes a handful of times a month,
 * polled forever by every box. Re-downloading it on every tick is pure waste,
 * and that waste is what forced the poll interval to be slow (6h) in the first
 * place. The website serves `ETag` + `Last-Modified` on it (Caddy, verified),
 * so we send `If-None-Match` and the server answers `304 Not Modified` with no
 * body whenever nothing has changed.
 *
 * A 304 carries no body to parse, so the last-seen manifest is cached in the
 * closure and returned as-is. That keeps the fetcher's contract unchanged from
 * the caller's point of view — it always resolves to a manifest object — so
 * `createUpdateCheck` needs to know nothing about caching.
 *
 * A 304 with no cached manifest (possible only if a proxy fabricates one)
 * throws, and `createUpdateCheck` treats a throw as "no update", which is the
 * safe direction.
 *
 * Each returned fetcher owns its own cache, so tests get a clean one per call
 * and the poller's fetcher is never shared with an unrelated caller.
 *
 * `fetchImpl` is resolved PER CALL, not captured at construction: the previous
 * `defaultFetchManifest` was a plain function that called the global `fetch`
 * when invoked, so a caller (or a test) replacing `globalThis.fetch` after
 * import still took effect. Binding it once at module load would have silently
 * removed that.
 */
export function createManifestFetcher({ fetchImpl } = {}) {
  let etag = null;
  let cached = null;

  return async function fetchManifest(url = MANIFEST_URL) {
    const doFetch = fetchImpl ?? globalThis.fetch;
    const headers = etag ? { "if-none-match": etag } : undefined;
    const res = await doFetch(url, headers ? { headers } : undefined);

    if (res.status === 304) {
      if (cached === null) {
        throw new Error("manifest fetch returned 304 with no cached manifest");
      }
      return cached;
    }
    if (!res.ok) throw new Error(`manifest fetch failed: ${res.status}`);

    const manifest = await res.json();
    // Only remember the validator once the body parsed — caching an ETag for a
    // body we failed to read would make every later poll a 304 that returns a
    // stale/absent manifest.
    const nextEtag = res.headers?.get?.("etag") ?? null;
    etag = typeof nextEtag === "string" && nextEtag !== "" ? nextEtag : null;
    cached = manifest;
    return manifest;
  };
}

/**
 * Default `fetchManifest` used when no override is supplied — fetches the
 * manifest URL and parses JSON, with the conditional-GET caching above. Any
 * non-2xx (other than 304) is treated as a fetch failure so
 * `createUpdateCheck`'s catch-handler returns `{ available:false }` rather than
 * crashing the poller.
 *
 * Exported separately so tests can import it as a baseline stub shape and
 * so production callers can swap to a different fetch impl without rewriting
 * the URL/parse logic.
 */
export const defaultFetchManifest = createManifestFetcher();

/**
 * Build a single update-check step (testable without timers or a live bus).
 * Returns `{ tick }` which: fetches the manifest via the injectable
 * `fetchManifest`, runs `isUpdateAvailable` against `currentVersion`, and
 * returns `{ available, version, notesUrl }`. On a fetch throw or a malformed
 * manifest (missing/non-string `version`) it returns `{ available:false }`
 * and does NOT re-throw — a flaky manifest URL must never crash the server.
 *
 * Re-entrancy guarded: a tick invoked while another is still running JOINS the
 * in-flight one and resolves with its result.
 *
 * It deliberately does NOT return `{available:false}` early, which is what the
 * guard used to do. That shortcut was safe while the only caller was a 6h
 * timer, and became a lie the moment a human could ask: a manual "check for
 * updates" that happened to land during a poller tick would be told "up to
 * date" without anything having been compared. Reporting a stale "no update"
 * to someone who explicitly asked is the one answer this whole feature exists
 * to avoid, so concurrent callers share the real answer instead.
 *
 * @param {object} deps
 * @param {(url:string) => Promise<any>} deps.fetchManifest
 * @param {string} deps.currentVersion
 * @returns {{ tick: () => Promise<CheckResult> }} where
 *   CheckResult = { available:boolean, version?:string, notesUrl?:string|null, ok:boolean }
 */
export function createUpdateCheck({ fetchManifest, currentVersion, url }) {
  let inFlight = null;
  // Channel-derived by default (prod → /updates, staging → /staging/updates).
  // `null` means this build has no feed — see tick().
  const feedUrl = url === undefined ? manifestUrl() : url;

  async function run() {
    try {
      const manifest = await fetchManifest(feedUrl);
      if (!manifest || typeof manifest.version !== "string") {
        return { available: false, ok: true };
      }
      const available = isUpdateAvailable(currentVersion, manifest.version);
      const notesUrl =
        typeof manifest.notes_url === "string" ? manifest.notes_url : null;
      return available
        ? { available: true, version: manifest.version, notesUrl, ok: true }
        : { available: false, ok: true };
    } catch {
      // The background poll must survive a flaky feed, so this swallows the
      // throw — but `ok:false` is the flag the ON-DEMAND path needs to tell
      // "there wasn't one" from "we couldn't tell". Without it, a manual
      // "Check for updates" that hit a network hiccup would render the green
      // "you're up to date", which is exactly the false okay this feature
      // exists to prevent.
      return { available: false, ok: false };
    }
  }

  function tick() {
    // A dev build has `updateFeed: null`. Report "no update" rather than
    // falling back to the prod feed: a local build must never talk a real box
    // into installing a public release over it.
    if (!feedUrl) return Promise.resolve({ available: false, ok: true });
    if (inFlight) return inFlight;
    inFlight = run().finally(() => {
      inFlight = null;
    });
    return inFlight;
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
 * Returns `{ stop, check }`. `check()` runs the SAME tick the timer runs and
 * resolves with its result, so an on-demand check (the `server:update-check`
 * RPC behind Settings → About, and the desktop's check-on-connect) reuses one
 * code path instead of growing a second fetch+compare that could disagree with
 * the banner. It is deliberately the full `runTick`, not a bare `tick`: a
 * manual check that finds an update should also raise the banner and fire the
 * notification exactly as the timer would, and the per-version dedup makes
 * that idempotent no matter how often the user clicks.
 *
 * @param {object} deps
 * @param {{ publish: (evt:any) => void }} deps.bus
 * @param {string} deps.currentVersion
 * @param {(args:{message:string, title?:string, sessionID?:string|null}) => Promise<any>} [deps.notify]
 * @param {(url:string) => Promise<any>} [deps.fetchManifest]
 * @returns {{ stop: () => void, check: () => Promise<{available:boolean, version?:string, notesUrl?:string|null}> }}
 */
export function startServerUpdatePoller(
  { bus, currentVersion, notify, fetchManifest } = {},
) {
  // A fetcher of this poller's OWN, not the shared `defaultFetchManifest`
  // singleton, so the conditional-GET cache belongs to exactly one poller and
  // two instances (a test's and production's) can never see each other's ETag.
  const realFetchManifest = fetchManifest ?? createManifestFetcher();
  const { tick } = createUpdateCheck({
    fetchManifest: realFetchManifest,
    currentVersion,
  });
  let lastNotifiedVersion = null;

  // Emit the two side effects of an available update, with separate gating.
  //
  // - The BANNER bus event is what any CONNECTED desktop shows. The timer lets
  //   it through only once per version (a dismissed banner must not come back
  //   every 30 minutes); an on-demand check passes `forceBanner:true` so a
  //   desktop that reconnects AFTER a release — and therefore never saw the
  //   timer's one-and-only banner — surfaces it on open. The banner is an
  //   idempotent store set on the client, so re-publishing is harmless.
  // - The PUSH is deduped for both paths: re-surfacing a banner on a fresh
  //   connect must not re-buzz the phone.
  async function publish(result, { forceBanner }) {
    const firstForVersion = result.version !== lastNotifiedVersion;
    if (forceBanner || firstForVersion) {
      // Match the bus envelope documented in src/server/events.mjs: every
      // `{kind, payload}` event from the server carries the per-kind fields
      // INSIDE `payload`, not as siblings of `kind`. The renderer's
      // dispatchFrame (src/renderer/api/httpApi.ts) destructures `{kind,
      // payload}`; nesting here is what makes the `onServerUpdateAvailable`
      // subscription see `{version, notesUrl}`.
      bus.publish({
        kind: "serverUpdateAvailable",
        payload: { version: result.version, notesUrl: result.notesUrl ?? null },
      });
    }
    if (!firstForVersion) return;

    // Written before the first await below, so two racing ticks cannot both
    // pass this gate (JS microtasks resume sequentially; the second sees the
    // gate already closed). This atomicity is what stops a check that races
    // the timer from double-notifying.
    lastNotifiedVersion = result.version;

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

  async function runTick() {
    const result = await tick();
    // Always hand the caller the comparison result — `check()` returns this so
    // a manual check can say "up to date" as confidently as "update available".
    // The dedup below gates only the SIDE EFFECTS (banner + push), never the
    // answer, so clicking the button twice reports the truth twice while
    // notifying at most once.
    if (!result?.available || !result.version) return result ?? { available: false, ok: true };
    await publish(result, { forceBanner: false });
    return result;
  }

  // The ON-DEMAND path (Settings → About button, and the desktop's
  // check-on-connect). Same comparison as the timer, but it always re-raises
  // the banner (forceBanner:true) so a client that connects after a release
  // still sees it, while the push stays deduped.
  async function check() {
    const result = await tick();
    if (!result?.available || !result.version) return result ?? { available: false, ok: true };
    await publish(result, { forceBanner: true });
    return result;
  }

  const { stop } = startPoller(runTick, {
    intervalMs: POLL_MS,
    label: "server-update",
  });

  return { stop, check };
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
