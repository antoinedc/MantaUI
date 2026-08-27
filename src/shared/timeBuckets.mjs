// shared/timeBuckets.mjs — local-calendar time-bucket keys shared by the
// optimizer counterfactual store and the model spend ledger (BET-1368).
//
// Pure: no imports, no I/O. Buckets are LOCAL-calendar day "YYYY-MM-DD" and
// hour "YYYY-MM-DDTHH" keys, matching the store and the ledger's existing
// keys — never UTC, never rolling absolute boundaries. DST-safe:
// recentBucketKeys walks with Date arithmetic (setDate / setHours) so a
// transition neither duplicates nor skips a bucket.

function toMs(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Local-calendar day key, "YYYY-MM-DD". */
export function dayKey(ms) {
  const d = new Date(toMs(ms));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Local-calendar hour key, "YYYY-MM-DDTHH". */
export function hourKey(ms) {
  const d = new Date(toMs(ms));
  return `${dayKey(ms)}T${String(d.getHours()).padStart(2, "0")}`;
}

/** Epoch ms at the START of the local day/hour a key names. Inverse of the above. */
export function bucketKeyToMs(key) {
  if (typeof key !== "string") return NaN;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (day) {
    const y = Number(day[1]);
    const m = Number(day[2]);
    const d = Number(day[3]);
    return new Date(y, m - 1, d).getTime();
  }
  const hour = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/.exec(key);
  if (hour) {
    const y = Number(hour[1]);
    const m = Number(hour[2]);
    const d = Number(hour[3]);
    const h = Number(hour[4]);
    return new Date(y, m - 1, d, h).getTime();
  }
  return NaN;
}

/**
 * The `count` most recent bucket keys ending at `now`, oldest→newest, walked
 * with Date arithmetic (setDate / setHours) so a DST transition neither
 * duplicates nor skips a bucket. `bucket` is "day" (default) or "hour".
 */
export function recentBucketKeys(bucket, count, now) {
  const n = Math.max(1, Math.floor(toMs(count)) || 1);
  const base = toMs(now);
  const isHour = bucket === "hour";
  const keys = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(base);
    if (isHour) d.setHours(d.getHours() - i);
    else d.setDate(d.getDate() - i);
    keys.push(isHour ? hourKey(d.getTime()) : dayKey(d.getTime()));
  }
  return keys;
}
