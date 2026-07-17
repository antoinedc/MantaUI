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

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Default probe set (single source of truth — also used by the test suite).
// Each target is { url, expect, kind }:
//   kind: "body" (full GET) or "head" (HEAD only — saves bytes on tarballs).
//   expect.status: required HTTP status code.
//   expect.bodyStartsWith: optional, the body MUST begin with this string
//      (defends against Caddy returning a 200 default page for a missing
//      asset — "200 OK" + wrong content is still a healthy 200, but a
//      missing /install.sh would silently serve the homepage).
// ---------------------------------------------------------------------------

export const DEFAULT_TARGETS = [
  { url: "https://mantaui.com",                      kind: "body", expect: { status: 200 } },
  { url: "https://relay.mantaui.com",                kind: "body", expect: { status: 401 } },
  { url: "https://app.mantaui.com",                  kind: "body", expect: { status: 200 } },
  { url: "https://mantaui.com/install.sh",           kind: "body", expect: { status: 200, bodyStartsWith: "#!/" } },
  { url: "https://mantaui.com/releases/manta-latest.tar.gz", kind: "head", expect: { status: 200 } },
];

// ---------------------------------------------------------------------------
// Probe runner — pure: every I/O surface is injected so the test suite can
// run with a fake fetch without touching the network.
// ---------------------------------------------------------------------------

/**
 * Run every target; return `{ ok, failures }` where `failures` is the list
 * of { url, reason } entries (empty when ok).
 *
 * @param {object} opts
 * @param {Array}  opts.targets        probe list (default DEFAULT_TARGETS).
 * @param {object} opts.env            env-like object (default process.env).
 * @param {Function} opts.fetchFn      fetch implementation.
 * @param {Function} opts.log          (line) => void — per-target progress.
 */
export async function runHealthcheck({
  targets = parseTargetsEnv(process.env),
  env = process.env,
  fetchFn = globalThis.fetch,
  log = () => {},
} = {}) {
  const list = targets ?? DEFAULT_TARGETS;
  const failures = [];
  for (const t of list) {
    const fail = await checkOne(t, { fetchFn, log });
    if (fail) failures.push(fail);
  }
  return { ok: failures.length === 0, failures };
}

// HEALTHCHECK_TARGETS overrides the default probe set. JSON-encoded array
// of the same shape as DEFAULT_TARGETS. Empty/missing → default.
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
  process.stderr.write(`[healthcheck] OK: all ${DEFAULT_TARGETS.length} targets healthy\n`);
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  cliMain();
}

// Suppress an "unused import" lint when join() is unused on some build paths.
void join;
