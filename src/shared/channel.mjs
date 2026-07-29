// channel.mjs — build-channel resolution + per-channel config table (BET-370).
//
// One module, one table, one rule. There are exactly three channels — prod,
// staging, dev — and every per-channel value in the desktop app reads from
// `channelConfig(channel)`. New values MUST land here, not as branches at the
// call site; the renderer / main process / install command all reach this
// module for their values.
//
// Lives in src/shared/ because the renderer may later need the scheme or
// app name for display (e.g. a "running in staging" badge in Settings) and
// shared/ is the only place both tsconfigs pick up.
//
// Pure (no electron, no node:fs) → unit-tested in src/shared/channel.test.ts.

// ===========================================================================
// CHANNELS — the per-channel value table.
//
// Copied verbatim from the BET-370 spec. Do NOT derive one value from another
// (e.g. `installShUrl` is NOT `${releaseHost}/install.sh`) — the install.sh
// path is intentionally stable so a staging release with a broken
// `/staging/install.sh` can still be debugged from the prod endpoint.
//
// "same as prod" for dev means we still copy the literal — `CHANNELS.dev`
// must be a complete record. Future readers shouldn't have to fall through
// to prod for some keys; "absent" is NOT a value.
//
// `n/a` cells in the spec are fields the channel doesn't own — there is no
// update feed for dev (it never auto-updates), no electron-builder id for
// dev (it never builds). These are stored as `null` so a future caller that
// accidentally asks for them gets an explicit "no" instead of a silent
// fallback to prod.
// ===========================================================================

export const CHANNELS = Object.freeze({
  prod: Object.freeze({
    id: "prod",
    userDataDir: "manta",
    urlScheme: "manta",
    appName: "Manta UI",
    installShUrl: "https://mantaui.com/install.sh",
    releaseHost: "https://mantaui.com",
    updateFeed: "https://mantaui.com/updates",
    electronBuilderAppId: "com.antoinedc.mantaui",
    electronBuilderProductName: "Manta UI",
  }),
  staging: Object.freeze({
    id: "staging",
    userDataDir: "manta-staging",
    urlScheme: "manta-staging",
    appName: "Manta UI (Staging)",
    installShUrl: "https://mantaui.com/staging/install.sh",
    releaseHost: "https://mantaui.com/staging",
    updateFeed: "https://mantaui.com/staging/updates",
    electronBuilderAppId: "com.antoinedc.mantaui.staging",
    electronBuilderProductName: "Manta UI (Staging)",
  }),
  dev: Object.freeze({
    id: "dev",
    userDataDir: "manta-dev",
    urlScheme: "manta-dev",
    appName: "Manta UI (Dev)",
    installShUrl: "https://mantaui.com/install.sh",
    releaseHost: "https://mantaui.com",
    updateFeed: null,
    electronBuilderAppId: null,
    electronBuilderProductName: null,
  }),
});

// The set of valid channel ids — exported so a caller validating an external
// input (e.g. a debug toggle) can check membership without re-typing the
// list. Frozen + readonly tuple: mutation throws, and a future reader sees
// every legal value at a glance.
export const CHANNEL_IDS = Object.freeze(["prod", "staging", "dev"]);

// ===========================================================================
// resolveChannel — one rule, nowhere else.
//
// `isPackaged` is the runtime signal from `app.isPackaged`. `bakedChannel` is
// the build-time string the bundler injects via electron-vite's `define`
// (see electron.vite.config.ts). The rule:
//
//   channel = isPackaged ? bakedChannel : "dev"
//
// An unpackaged build is ALWAYS dev — regardless of what the build env tried
// to bake — because npm run dev has no concept of "the release channel I'm
// aiming at". An unrecognised baked value (or undefined) falls back to prod;
// a bad build must still launch rather than throw at startup.
// ===========================================================================

const PROD_CHANNEL = "prod";
const DEV_CHANNEL = "dev";

export function resolveChannel(isPackaged, bakedChannel) {
  if (isPackaged !== true) return DEV_CHANNEL;
  if (bakedChannel === "prod" || bakedChannel === "staging" || bakedChannel === "dev") {
    return bakedChannel;
  }
  // An unrecognised baked value (undefined, null, "garbage", typo) — never
  // throw. A bad build must still launch; the fallback is prod because prod
  // is the one channel every release pipeline must produce successfully.
  return PROD_CHANNEL;
}

// ===========================================================================
// channelConfig — return the per-channel record.
//
// Unknown channel id → prod record (same fallback semantics as resolveChannel:
// a wrong lookup must still return a usable config). The record is frozen, so
// callers cannot accidentally mutate the table from a call site.
// ===========================================================================

export function channelConfig(channel) {
  if (channel === "prod" || channel === "staging" || channel === "dev") {
    return CHANNELS[channel];
  }
  return CHANNELS[PROD_CHANNEL];
}
