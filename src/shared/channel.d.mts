// Hand-written type declarations for channel.mjs. Implementation is plain JS so
// both the renderer tsconfig and the main tsconfig import it without crossing
// the process boundary. Keep in sync with src/shared/channel.mjs.

/**
 * The three valid build channel ids. Anything else resolves to "prod" (per
 * resolveChannel's defensive rule — a bad build must still launch).
 */
export type ChannelId = "prod" | "staging" | "dev";

/**
 * The readonly record for a single channel. Frozen at runtime; the type
 * system reflects that with `readonly` so a caller can't accidentally mutate
 * the table from a call site.
 */
export type ChannelConfig = {
  readonly id: ChannelId;
  /** Electron userData subdir name. */
  readonly userDataDir: string;
  /** OS-level URL scheme (deep-link pairing). */
  readonly urlScheme: string;
  /** Display name passed to `app.setName()`. */
  readonly appName: string;
  /** install.sh URL — read by the SSH installer path. */
  readonly installShUrl: string;
  /** MANTA_RELEASE_HOST value — passed to install.sh on the box. */
  readonly releaseHost: string;
  /** electron-updater generic-provider URL. null on dev (no auto-update). */
  readonly updateFeed: string | null;
  /** electron-builder appId. null on dev (no build). */
  readonly electronBuilderAppId: string | null;
  /** electron-builder productName. null on dev (no build). */
  readonly electronBuilderProductName: string | null;
};

/**
 * The frozen channel table. `Object.freeze` makes the runtime enforce
 * immutability; this typing mirrors it with `Readonly<...>`.
 */
export const CHANNELS: Readonly<Record<ChannelId, ChannelConfig>>;

/**
 * The set of valid channel ids — exported so a caller validating an external
 * input (e.g. a debug toggle) can check membership without re-typing the list.
 */
export const CHANNEL_IDS: readonly ChannelId[];

/**
 * Resolve the running app's channel id.
 *
 *   isPackaged === false → "dev"
 *   isPackaged === true  → bakedChannel (must be "prod" | "staging" | "dev";
 *                          any other value, including undefined, → "prod")
 *
 * @param isPackaged   Electron's `app.isPackaged`.
 * @param bakedChannel Build-time string injected by electron-vite `define`.
 *                     See electron.vite.config.ts.
 */
export function resolveChannel(isPackaged: boolean, bakedChannel: string | undefined): ChannelId;

/**
 * Return the per-channel record for `channel`. Unknown channel → prod record
 * (same fallback semantics as `resolveChannel`: a wrong lookup must still
 * return a usable config, never throw).
 */
export function channelConfig(channel: string | null | undefined): ChannelConfig;
