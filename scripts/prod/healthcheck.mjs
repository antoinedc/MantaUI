// healthcheck.mjs — prod box uptime probe. Runs from the dev box (off-site)
// every 10 minutes via schedule_create in a long-lived opencode session on
// the dev box. Exits non-zero and prints the failing URL on any mismatch;
// the caller (this same session) responds by calling `notify` urgent:true.
//
// Why the dev box, not the prod box: the property we need is "an off-site
// observer saw the prod surface go away". A self-check on the prod box
// would pass even when Caddy is wedged, the network is partitioned, etc.
//
// Why not an external service (UptimeRobot et al.): no owner account is
// available, and reuse-what-exists is the cheaper default.
//
// INSTALL on the dev box (in this opencode session):
//   schedule_create cron "*/10 * * * *" running `node /path/healthcheck.mjs`
//   on failure the cron turn should call `notify` urgent:true naming the
//   failing URL.
//
// Override (env): HEALTHCHECK_TARGETS (JSON array — see DEFAULT_TARGETS).
// The override filters the FLAT probes only; the manifest↔tarball drift
// check (the most important leg) runs unconditionally — there's no clean
// way to express "fetch manifest, then iterate arches" in a JSON array of
// { url, kind, expect } entries, and an off-site drift check is the whole
// point of this script.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Single source of truth — mirror scripts/release/publish.sh.
// Adding an arch = one entry in ARCH_KEYS + one entry in publish.sh's
// ARCHES. No copy-pasted per-arch blocks downstream of this list.
// ---------------------------------------------------------------------------

export const SITE_URL = "https://mantaui.com";
export const ARCH_KEYS = ["linux_x64", "linux_arm64"];

// ---------------------------------------------------------------------------
// Default probe set (single source of truth — also used by the test suite).
// Each target is { url, expect, kind }:
//   kind: "body" (full GET) or "head" (HEAD only — saves bytes on tarballs).
//   expect.status: required HTTP status code.
//   expect.bodyStartsWith: optional, the body MUST begin with this string
//      (defends against Caddy returning a 200 default page for a missing
//      asset — "200 OK" + wrong content is still a healthy 200, but a
//      missing /install.sh would silently serve the homepage).
//
// Note: the per-arch tarball URLs are NOT listed here — they live behind
// the manifest (manta-latest.txt) and shift on every publish. We HEAD +
// sha256-verify them in verifyManifestDrift below, which is the same shape
// as publish.sh's post-upload verify loop (publish.sh:245-257).
// ---------------------------------------------------------------------------

export const DEFAULT_TARGETS = [
  { url: "https://mantaui.com",                      kind: "body", expect: { status: 200 } },
  { url: "https://gateway.mantaui.com",              kind: "body", expect: { status: 200 } },
  { url: "https://app.mantaui.com",                  kind: "body", expect: { status: 200 } },
  { url: "https://mantaui.com/install.sh",           kind: "body", expect: { status: 200, bodyStartsWith: "#!/" } },
];

// ---------------------------------------------------------------------------
// Manifest parser — pure, mirrors the install.sh `manifest_get` shape
// (scripts/install.sh reads `key=value` lines, first-occurrence wins).
// Keys we care about per arch: file_<archkey>= and sha256_<archkey>=
// (e.g. file_linux_x64=manta-1.2.3-linux-x64.tar.gz). Future keys are
// ignored — we never want a new arch to break a stale parser.
// ---------------------------------------------------------------------------

export function parseManifest(text) {
  const out = {};
  if (typeof text !== "string") return out;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z0-9_]+)=(.+)$/);
    if (!m) continue;
    if (!(m[1] in out)) out[m[1]] = m[2];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Manifest ↔ tarball drift check (BET-171 F4 class, generalized to BOTH
// arches per BET-264). Same loop publish.sh runs at verify-time, but
// pushed out to every 10 min from an off-site box: catches the case
// where the served tarball silently drifted from what manta-latest.txt
// promises (file replaced, partial upload, etc.) AFTER publish.sh's
// one-shot verification has already passed.
//
// Flow per arch:
//   1. parse file_<archkey>= + sha256_<archkey>= from the served manifest
//   2. HEAD <site>/releases/<file_<archkey>=>  → expect 200
//   3. GET <site>/releases/<file_<archkey>=>, sha256 it, compare to
//      sha256_<archkey>=. Mismatch → failure (client would sha256-fail
//      on install and die).
//
// Every I/O surface is injected so the test suite can run without the
// network. `fetchFn(url, init?)` must return a Response-like with
// { status, text(), arrayBuffer() } — same contract as globalThis.fetch.
// ---------------------------------------------------------------------------

export async function verifyManifestDrift({
  siteUrl = SITE_URL,
  archKeys = ARCH_KEYS,
  fetchFn = globalThis.fetch,
  log = () => {},
} = {}) {
  const failures = [];
  const base = String(siteUrl ?? "").replace(/\/+$/, "");
  if (base === "") {
    return { ok: false, failures: [{ url: "<manifest>", reason: "siteUrl is empty" }] };
  }
  const manifestUrl = `${base}/releases/manta-latest.txt`;

  // 1. Fetch + parse the manifest. If this fails we can't do anything else
  // (the whole point of the drift check is the manifest). Bail early with a
  // single failure entry rather than speculating about per-arch URLs.
  let manifestText = "";
  try {
    const res = await fetchFn(manifestUrl);
    const status = res?.status;
    if (typeof status !== "number") {
      log(`${manifestUrl}: no status (fetch returned no Response)`);
      failures.push({ url: manifestUrl, reason: `expected status 200, got no-status` });
      return { ok: false, failures };
    }
    if (status !== 200) {
      log(`${manifestUrl}: status=${status} expected=200`);
      failures.push({ url: manifestUrl, reason: `expected status 200, got ${status}` });
      return { ok: false, failures };
    }
    manifestText = await res.text();
  } catch (e) {
    const reason = `fetch error: ${e?.message ?? e}`;
    log(`${manifestUrl}: ${reason}`);
    failures.push({ url: manifestUrl, reason });
    return { ok: false, failures };
  }

  const kv = parseManifest(manifestText);

  // 2. For each arch: HEAD the file_<arch>= URL, then GET+sha256 it.
  for (const key of archKeys) {
    const fileKey = `file_${key}`;
    const shaKey  = `sha256_${key}`;
    const fileVal = kv[fileKey];
    const shaVal  = kv[shaKey];

    if (typeof fileVal !== "string" || fileVal === "") {
      const reason = `manifest missing ${fileKey}= (arch=${key})`;
      log(`${manifestUrl}: ${reason}`);
      failures.push({ url: manifestUrl, reason });
      continue;
    }
    if (typeof shaVal !== "string" || shaVal === "") {
      const reason = `manifest missing ${shaKey}= (arch=${key})`;
      log(`${manifestUrl}: ${reason}`);
      failures.push({ url: manifestUrl, reason });
      continue;
    }
    // Guard against manifest entries that try to escape the releases dir
    // (a `file_linux_x64=../../etc/passwd` would curl-fetch outside our
    // intent). Tarball names in publish.sh are produced by pack.mjs and
    // match `manta-<version>-linux-<arch>.tar.gz` — anything else is
    // almost certainly a corrupted manifest.
    if (fileVal.includes("/") || fileVal.includes("..") || fileVal.includes("\0")) {
      const reason = `manifest ${fileKey}= contains unsafe characters (${JSON.stringify(fileVal)})`;
      log(`${manifestUrl}: ${reason}`);
      failures.push({ url: manifestUrl, reason });
      continue;
    }
    const tarballUrl = `${base}/releases/${fileVal}`;

    // HEAD — the cheap liveness probe. A 200 here + a sha256 mismatch below
    // is the classic "served file replaced post-publish" scenario.
    try {
      const headRes = await fetchFn(tarballUrl, { method: "HEAD" });
      const status = headRes?.status;
      if (typeof status !== "number" || status !== 200) {
        const got = typeof status === "number" ? status : "no-status";
        log(`${tarballUrl}: HEAD status=${got} expected=200`);
        failures.push({ url: tarballUrl, reason: `expected status 200, got ${got}` });
        continue;
      }
    } catch (e) {
      const reason = `HEAD fetch error: ${e?.message ?? e}`;
      log(`${tarballUrl}: ${reason}`);
      failures.push({ url: tarballUrl, reason });
      continue;
    }

    // GET + sha256. Bytes flow through Node Buffer for the hash so we
    // don't pull in a streaming pipeline for a one-shot ~100MB tarball.
    try {
      const getRes = await fetchFn(tarballUrl, { method: "GET" });
      const status = getRes?.status;
      if (typeof status !== "number" || status !== 200) {
        const got = typeof status === "number" ? status : "no-status";
        log(`${tarballUrl}: GET status=${got} expected=200`);
        failures.push({ url: tarballUrl, reason: `expected status 200, got ${got}` });
        continue;
      }
      const ab = await getRes.arrayBuffer();
      const buf = Buffer.from(ab);
      const actualSha = createHash("sha256").update(buf).digest("hex");
      if (actualSha !== shaVal) {
        const reason = `sha256 mismatch: manifest=${shaVal} actual=${actualSha} (arch=${key})`;
        log(`${tarballUrl}: ${reason}`);
        failures.push({ url: tarballUrl, reason });
        continue;
      }
      log(`${tarballUrl}: OK (sha256 matches ${shaKey}, ${buf.length} bytes)`);
    } catch (e) {
      const reason = `sha256 verify error: ${e?.message ?? e}`;
      log(`${tarballUrl}: ${reason}`);
      failures.push({ url: tarballUrl, reason });
    }
  }

  return { ok: failures.length === 0, failures };
}

// ---------------------------------------------------------------------------
// Probe runner — pure: every I/O surface is injected so the test suite can
// run with a fake fetch without touching the network.
// ---------------------------------------------------------------------------

/**
 * Run every target + the manifest drift check; return `{ ok, failures }`
 * where `failures` is the list of { url, reason } entries (empty when ok).
 *
 * @param {object} opts
 * @param {Array}  opts.targets        flat probe list (default DEFAULT_TARGETS).
 * @param {object} opts.env            env-like object (default process.env).
 * @param {Function} opts.fetchFn      fetch implementation.
 * @param {Function} opts.log          (line) => void — per-target progress.
 * @param {boolean} [opts.skipDriftCheck=false]  escape hatch for tests
 *                  that only want to exercise the flat probe set.
 */
export async function runHealthcheck({
  targets = parseTargetsEnv(process.env),
  env = process.env,
  fetchFn = globalThis.fetch,
  log = () => {},
  skipDriftCheck = false,
} = {}) {
  const list = targets ?? DEFAULT_TARGETS;
  const failures = [];
  for (const t of list) {
    const fail = await checkOne(t, { fetchFn, log });
    if (fail) failures.push(fail);
  }
  if (!skipDriftCheck) {
    const drift = await verifyManifestDrift({
      siteUrl: SITE_URL,
      archKeys: ARCH_KEYS,
      fetchFn,
      log,
    });
    for (const f of drift.failures) failures.push(f);
  }
  return { ok: failures.length === 0, failures };
}

// HEALTHCHECK_TARGETS overrides the default FLAT probe set. JSON-encoded
// array of the same shape as DEFAULT_TARGETS. Empty/missing → default.
// Note: this filters the flat probes only; the manifest drift check
// always runs (see file header).
export function parseTargetsEnv(env) {
  const raw = env?.HEALTHCHECK_TARGETS;
  if (typeof raw !== "string" || raw === "") return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function checkOne(target, { fetchFn, log }) {
  const url = target?.url;
  const expect = target?.expect ?? {};
  const kind = target?.kind ?? "body";
  if (typeof url !== "string" || url === "") {
    return { url: "<missing>", reason: "target.url missing" };
  }
  try {
    const res = await fetchFn(url, { method: kind === "head" ? "HEAD" : "GET" });
    if (typeof expect.status === "number" && res.status !== expect.status) {
      log(`${url}: status=${res.status} expected=${expect.status}`);
      return { url, reason: `expected status ${expect.status}, got ${res.status}` };
    }
    if (typeof expect.bodyStartsWith === "string" && expect.bodyStartsWith !== "") {
      const text = await res.text();
      if (!text.startsWith(expect.bodyStartsWith)) {
        log(`${url}: body does not start with ${JSON.stringify(expect.bodyStartsWith)} (first 80 chars: ${JSON.stringify(text.slice(0, 80))})`);
        return { url, reason: `body did not start with ${JSON.stringify(expect.bodyStartsWith)}` };
      }
    }
    log(`${url}: OK (status=${res.status}${expect.bodyStartsWith ? ", body matches" : ""})`);
    return null;
  } catch (e) {
    log(`${url}: error ${e?.message ?? e}`);
    return { url, reason: `fetch error: ${e?.message ?? e}` };
  }
}

// ---------------------------------------------------------------------------
// CLI entry — runs only when invoked directly. Prints a single line per
// target and a final summary, and exits non-zero on any failure.
// ---------------------------------------------------------------------------

function cliLog(line) {
  process.stderr.write(`[healthcheck] ${line}\n`);
}

async function cliMain() {
  const result = await runHealthcheck({ log: cliLog });
  if (!result.ok) {
    process.stderr.write(`[healthcheck] FAIL: ${result.failures.length} target(s) unhealthy:\n`);
    for (const f of result.failures) {
      process.stderr.write(`  - ${f.url}: ${f.reason}\n`);
    }
    process.exit(1);
  }
  process.stderr.write(`[healthcheck] OK: all ${DEFAULT_TARGETS.length} flat targets + ${ARCH_KEYS.length} arch drift checks healthy\n`);
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  cliMain();
}

// Suppress an "unused import" lint when join() is unused on some build paths.
void join;
