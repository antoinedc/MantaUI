// accountReaders.mjs — load the SHIPPED account descriptors and present them as
// ordinary usage readers (BET-1239).
//
// A descriptor is data that declares how to read a credit-based account: the
// URL, the bearer key to send, and which dot-paths in the response become a
// UsageSnapshot (balance, windows, plan label, overage price). Adding a
// supported provider is authoring a JSON file in ./accountDescriptors/ — NOT
// writing an adapter.
//
// The readers produced here are indistinguishable from the code adapters in
// ./usageAdapters/: they expose the same `{id, providerIDs, detect, fetch}`
// interface, so src/server/usage.mjs's ADAPTERS registry holds both and the
// engine never branches on how a reader was made. The descriptor validation
// and payload mapping live in the pure shared module
// (../shared/accountDescriptor.mjs); this module is only the I/O + loading
// half (read the directory, validate each on load, log an invalid one BY NAME,
// never throw past an individual bad file).
//
// A descriptor that fails to fetch or validate leaves that provider with NO
// account state — it must never make the router believe something false. There
// is deliberately no fallback path, no probe of conventional URLs: a connected
// provider with no reader and no descriptor simply has no account state.
//
// SECURITY: `readProviderApiKey` resolves a LIVE credential. It is used only
// inside the reader's detect()/fetch() to build the Bearer header; it is never
// logged and never folded into an error message.

import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readProviderApiKey } from "./opencode.mjs";
import { readDescriptor, validateDescriptor } from "../shared/accountDescriptor.mjs";
import { httpError } from "./usageAdapters/httpError.mjs";

const DESCRIPTORS_DIR = join(dirname(fileURLToPath(import.meta.url)), "accountDescriptors");

/**
 * The opencode providerID whose key this descriptor's account is authenticated
 * with. A descriptor may cover several opencode providerIDs that share one
 * credit pool, but the credential opencode holds lives under ONE auth-store
 * entry — the first providerID is that entry.
 * @param {object} descriptor
 * @returns {string}
 */
function authProviderID(descriptor) {
  return descriptor.providerIDs[0];
}

/**
 * Present one validated descriptor as an ordinary usage reader, exactly like a
 * code adapter: `{id, providerIDs, detect, fetch}`.
 *   - detect() = is the bearer key already held (reused from opencode.mjs)?
 *   - fetch()  = one HTTPS GET with `Authorization: Bearer <key>`, then
 *     readDescriptor. A non-2xx reuses the shared `httpError` shape so the
 *     usage poller's existing quarantine/carry-forward handles it identically
 *     to the code adapters (a 500 leaves the provider with NO account state).
 * @param {object} descriptor a validated descriptor
 * @returns {{ id: string, providerIDs: string[], detect: Function, fetch: Function }}
 */
export function readerFromDescriptor(descriptor) {
  const providerId = authProviderID(descriptor);
  const readKey = () => readProviderApiKey(providerId);
  return {
    id: descriptor.id,
    providerIDs: descriptor.providerIDs,

    async detect({ readKey: inject = readKey } = {}) {
      const key = await inject();
      return typeof key === "string" && key.length > 0;
    },

    async fetch({ readKey: inject = readKey, fetchImpl = fetch, now = () => Date.now() } = {}) {
      const key = await inject();
      if (!key) throw new Error(`no API key available for "${descriptor.id}"`);
      const res = await fetchImpl(descriptor.url, {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!res.ok) throw httpError(res, `${descriptor.id} usage`);
      const payload = await res.json();
      return readDescriptor(descriptor, payload);
    },
  };
}

/**
 * Load every `*.json` descriptor from the shipped directory, validate each on
 * load, log an invalid one BY NAME (never silently skip), and return one reader
 * per valid descriptor. Best-effort and never-throwing: a missing directory, an
 * unreadable file or an invalid descriptor is a logged skip, not a crash.
 * I/O is injected so tests exercise the loader without touching the real dir.
 * @param {object} [opts]
 * @param {string} [opts.dir]
 * @param {(d: string) => string[]} [opts.readDir]
 * @param {(p: string) => unknown} [opts.readJson]
 * @param {(m: string) => void} [opts.log]
 * @returns {ReturnType<typeof readerFromDescriptor>[]}
 */
export function loadAccountReaders({
  dir = DESCRIPTORS_DIR,
  readDir = readdirSync,
  readJson = (p) => JSON.parse(readFileSync(p, "utf-8")),
  log = (m) => console.warn(m),
} = {}) {
  const readers = [];
  let files;
  try {
    files = readDir(dir);
  } catch {
    return readers;
  }
  for (const file of files) {
    if (typeof file !== "string" || !file.endsWith(".json")) continue;

    let raw;
    try {
      raw = readJson(join(dir, file));
    } catch (e) {
      log(`[accountReaders] invalid descriptor "${file}": ${e?.message ?? String(e)}`);
      continue;
    }

    const result = validateDescriptor(raw);
    if (!result.valid) {
      const name = typeof raw?.id === "string" && raw.id ? raw.id : file;
      log(`[accountReaders] invalid descriptor "${name}": ${result.errors.join("; ")}`);
      continue;
    }

    readers.push(readerFromDescriptor(result.descriptor));
  }
  return readers;
}
