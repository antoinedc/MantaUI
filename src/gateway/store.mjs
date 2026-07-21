// store.mjs — registration store for the gateway service.
//
// A single JSON file at /var/lib/manta-gateway/boxes.json maps
// box_id → { gateway_token, ip, host, registeredAt, updatedAt, recordId }.
// Box-side callers (manta-server) register their box_id once at startup,
// receive a gateway_token, then re-register on each boot to refresh the
// DNS A record when the box's public IP changes.
//
// Atomic-write pattern (temp + rename + chmod 0600) copied verbatim from
// src/server/secrets.mjs: rename(2) on the same filesystem is atomic, so a
// crash mid-write cannot leave the file truncated or empty; chmod is
// belt-and-suspenders in case the temp file pre-existed with looser perms.
//
// Path injectable via `path` so tests run against /tmp without touching the
// real store. The default `/var/lib/manta-gateway/boxes.json` is created by
// the systemd `StateDirectory=manta-gateway` directive on prod (BET-198 WP6
// runbook step 4).
//
// The store keeps `recordId` (the Cloudflare record-id assigned when the A
// record was first created) so subsequent /register calls from the SAME box
// can PUT a target update without ever searching the zone — a single DNS
// read per box lifetime. (Older stores written by the OVH build used the key
// `ovhRecordId`; normalizeEntry accepts that legacy key too.)

import { writeFile, rename, mkdir, chmod } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";

const DEFAULT_STORE_PATH = "/var/lib/manta-gateway/boxes.json";

// Cap on the entry map: a 128 MiB JSON file is more than enough to hold
// every box in existence for the next decade, and bounds the worst-case
// load() parse. Reads bigger than this fail loudly (better than silently
// holding the whole zone in memory).
export const MAX_STORE_BYTES = 128 * 1024 * 1024;

// Same 32-hex shape as src/server/auth.mjs isValidToken. Re-exported as
// its own validator so the gateway never has to import server-side modules
// (the gateway service runs on its own port with its own deps).
export function isValidBoxId(boxId) {
  return typeof boxId === "string" && /^[0-9a-f]{32}$/.test(boxId);
}

// Pure entry shape (no surprises from JSON.parse, no extra fields from a
// caller that wrote the file out-of-band). `host` is the public FQDN the
// gateway will publish — <box_id>.boxes.mantaui.com for prod.
export function normalizeEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const { gateway_token, ip, host, registeredAt, updatedAt } = raw;
  // Cloudflare record ids are strings; older OVH stores used numbers. Accept
  // both under the canonical `recordId` field (falling back to the legacy
  // `ovhRecordId` key so a store written by the OVH build still loads).
  const rawRecordId = raw.recordId ?? raw.ovhRecordId ?? null;
  const recordId =
    typeof rawRecordId === "string" || typeof rawRecordId === "number"
      ? rawRecordId
      : null;
  if (typeof gateway_token !== "string" || !gateway_token) return null;
  if (typeof ip !== "string" || !ip) return null;
  if (typeof host !== "string" || !host) return null;
  if (typeof registeredAt !== "number") return null;
  if (typeof updatedAt !== "number") return null;
  return {
    gateway_token,
    ip,
    host,
    registeredAt,
    updatedAt,
    recordId,
  };
}

// Atomic temp-rename write. `mode` is the file mode applied to BOTH the
// temp file and the final rename target (rename keeps the temp's mode in
// the same-filesystem case). 0600 = owner-only; the store holds gateway
// tokens which are bearer secrets.
async function atomicWriteJson(path, obj, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const data = JSON.stringify(obj, null, 2);
  await writeFile(tmp, data, { mode });
  await chmod(tmp, mode).catch(() => {});
  await rename(tmp, path);
  await chmod(path, mode).catch(() => {});
}

// Load the store as `{ [box_id]: entry }`. Returns `{}` when the file is
// missing or corrupt — a fresh gateway always starts empty. Reads via
// sync FS so the in-process HTTP handler can stay non-blocking only at the
// request boundary; load() is called at request time and is small.
//
// The cap (MAX_STORE_BYTES) is enforced BEFORE parse so a runaway write
// can't exhaust heap. The test uses a tmp file the test always cleans up.
export function loadStore(path = DEFAULT_STORE_PATH) {
  try {
    if (!existsSync(path)) return {};
    const stat = readFileSync(path, { encoding: null });
    if (stat.byteLength > MAX_STORE_BYTES) {
      throw new Error(
        `store too large: ${stat.byteLength} > ${MAX_STORE_BYTES}`,
      );
    }
    const text = stat.toString("utf-8");
    if (!text.trim()) return {};
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (!isValidBoxId(k)) continue;
      const norm = normalizeEntry(v);
      if (norm) out[k] = norm;
    }
    return out;
  } catch {
    // corrupt/unreadable → empty store. The caller treats this as a fresh
    // boot. Never crash the request loop on a bad file.
    return {};
  }
}

// Save the full map. Overwrites whatever is on disk. The caller is expected
// to load → mutate → save; we do NOT expose diff APIs because the map is
// small and the file is rewritten under rename, so concurrent writers are
// already at the kernel's mercy.
export async function saveStore(map, path = DEFAULT_STORE_PATH) {
  const obj = {};
  for (const [k, v] of Object.entries(map ?? {})) {
    if (!isValidBoxId(k)) continue;
    const norm = normalizeEntry(v);
    if (norm) obj[k] = norm;
  }
  await atomicWriteJson(path, obj);
}

// Compose a fresh entry. `now` injectable for tests. `gateway_token` MUST
// be passed in (the caller generates it) so the registration route can
// return the token to the box on first registration.
export function makeEntry({ box_id, gateway_token, ip, host, recordId = null, now = () => Date.now() }) {
  if (!isValidBoxId(box_id)) throw new Error("makeEntry: invalid box_id");
  if (typeof gateway_token !== "string" || !gateway_token) {
    throw new Error("makeEntry: gateway_token required");
  }
  if (typeof ip !== "string" || !ip) throw new Error("makeEntry: ip required");
  if (typeof host !== "string" || !host) throw new Error("makeEntry: host required");
  const t = now();
  return {
    gateway_token,
    ip,
    host,
    registeredAt: t,
    updatedAt: t,
    recordId,
  };
}

// Pure: build the host FQDN for a box_id. One domain, no friendly names
// (BET-198 §4: "Box hostname = full 32-hex box_id").
export function hostFor(box_id) {
  if (!isValidBoxId(box_id)) throw new Error("hostFor: invalid box_id");
  return `${box_id}.boxes.mantaui.com`;
}
