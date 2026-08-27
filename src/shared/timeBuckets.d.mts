// Type declarations for the pure shared timeBuckets.mjs (BET-1368). Mirrors the
// other shared .mjs modules: shared .mjs consumed from .ts must ship a
// hand-written .d.mts (the .mjs itself has no bundled types). Pure, no I/O.

/** Local-calendar day key, "YYYY-MM-DD". */
export function dayKey(ms: number): string;
/** Local-calendar hour key, "YYYY-MM-DDTHH". */
export function hourKey(ms: number): string;
/** Epoch ms at the START of the local day/hour a key names. Unparseable → NaN. */
export function bucketKeyToMs(key: unknown): number;
/**
 * The `count` most recent bucket keys ending at `now`, oldest→newest, walked
 * with Date arithmetic so a DST transition neither duplicates nor skips a
 * bucket. `bucket` is "day" (default) or "hour".
 */
export function recentBucketKeys(
  bucket: "day" | "hour",
  count: number,
  now: number,
): string[];
