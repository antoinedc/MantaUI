// Pure decisions for the "What's new" window (spec 2026-11-03-whats-new-modal).
// No DOM, no storage, no network: the renderer hook feeds this the stored
// acknowledgements and the server's entries and gets back what to do.
//
// Stored shape (per device, per server id): `{ versions: { [version]: fingerprint } }`,
// kept in insertion order (oldest first) and bounded to MAX_STORED_VERSIONS.

export const MAX_SHOWN_ENTRIES = 5;
export const MAX_STORED_VERSIONS = 50;

const isPlainObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);

/** Read the stored value defensively: anything malformed is "no record". */
export function normalizeStored(raw) {
  if (!isPlainObject(raw) || !isPlainObject(raw.versions)) return null;
  const versions = {};
  for (const [version, fingerprint] of Object.entries(raw.versions)) {
    if (typeof fingerprint === "string") versions[version] = fingerprint;
  }
  return { versions };
}

/**
 * Decide what to do with the entries the server returned (newest first).
 *
 *   no record for this server → `{ baseline: true }` (record silently, show nothing)
 *   otherwise                 → `{ unseen }`, newest first, at most 5:
 *     - a version never acknowledged is unseen;
 *     - the NEWEST entry is also unseen when it was acknowledged but its
 *       fingerprint differs (it was edited);
 *     - an older entry whose fingerprint differs is NOT unseen (rewording old
 *       entries must not announce them again).
 *
 * An empty entry list never baselines: there is nothing to record, and a
 * record made from nothing would make the first real changelog look unseen.
 */
export function decideWhatsNew(stored, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return { unseen: [] };
  const record = normalizeStored(stored);
  if (record == null) return { baseline: true };
  const unseen = [];
  entries.forEach((entry, index) => {
    const known = Object.prototype.hasOwnProperty.call(record.versions, entry.version);
    if (!known || (index === 0 && record.versions[entry.version] !== entry.fingerprint)) unseen.push(entry);
  });
  return { unseen: unseen.slice(0, MAX_SHOWN_ENTRIES) };
}

/**
 * The stored value after the user has seen (or baselined) `entries`: every
 * returned entry acknowledged with its current fingerprint. A version already
 * stored keeps its position; new ones are appended oldest → newest, and the
 * oldest are dropped past MAX_STORED_VERSIONS.
 */
export function acknowledge(stored, entries) {
  const record = normalizeStored(stored) ?? { versions: {} };
  if (!Array.isArray(entries) || entries.length === 0) return record;
  const versions = { ...record.versions };
  for (const entry of [...entries].reverse()) versions[entry.version] = entry.fingerprint;
  const keys = Object.keys(versions);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_STORED_VERSIONS))) delete versions[key];
  return { versions };
}

/**
 * The version the user last had, for the "UPDATED · 1.1.0 → 1.2.0" eyebrow:
 * the newest returned entry that is acknowledged and not itself being shown,
 * else the most recently stored version. null when there is none — and when the
 * newest unseen version is itself acknowledged (an edited entry: the user was
 * already on it).
 */
export function previousVersion(stored, entries, unseen) {
  const record = normalizeStored(stored);
  if (record == null || !Array.isArray(unseen) || unseen.length === 0) return null;
  const target = unseen[0].version;
  if (Object.prototype.hasOwnProperty.call(record.versions, target)) return null;
  const shown = new Set(unseen.map((e) => e.version));
  const returned = (Array.isArray(entries) ? entries : []).find(
    (e) => !shown.has(e.version) && Object.prototype.hasOwnProperty.call(record.versions, e.version),
  );
  if (returned) return returned.version;
  const stored_ = Object.keys(record.versions).filter((v) => v !== target);
  return stored_.length > 0 ? stored_[stored_.length - 1] : null;
}

const CHIP_LABELS = { server: "Server", box: "Server", desktop: "Desktop" };

/** Chips for an entry: "Server" / "Desktop" only, in that order, no duplicates. */
export function componentChips(components) {
  const out = [];
  for (const raw of Array.isArray(components) ? components : []) {
    const label = CHIP_LABELS[String(raw).toLowerCase()];
    if (label && !out.includes(label)) out.push(label);
  }
  return out.sort((a, b) => (a === b ? 0 : a === "Server" ? -1 : 1));
}
