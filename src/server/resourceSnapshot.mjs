// resourceSnapshot.mjs — read-only box resource headroom snapshot.
//
// Backs the global opencode `resource_snapshot` tool
// (docs/opencode-tools/resource-snapshot.ts) via the authenticated
// `GET /api/resource-snapshot?directory=` route. Spec:
// docs/superpowers/specs/2026-10-04-resource-budget-tool.md.
//
// Advisory only: it measures, it never launches, limits or kills anything.
//
// Safety properties (each pinned by resourceSnapshot.test.mjs):
//   - Every probe is read-only and runs a FIXED argv through execFile — no
//     shell, and no caller-controlled string ever reaches an argv.
//   - Process readings use `ps -o pid=,rss=,comm=`: `comm` is the executable
//     name only. Command lines (`args`) and environments (`e`) are never
//     requested, so they cannot be returned. Docker is only ever asked for
//     `stats` — never `inspect` or `logs`.
//   - Every source has a short timeout and fails independently: a missing
//     Docker, a hung `ps`, or an unreadable /proc yields a warning plus the
//     other readings, never a hang or a whole-request failure.
//   - The cgroup probe only ever reads three fixed filenames (memory.current,
//     memory.max, memory.high) under /sys/fs/cgroup, at a path that came from
//     `systemctl --user show opencode-serve` and passed a strict character
//     allow-list. No caller-supplied path reaches it. If the unit's cgroup
//     can't be identified, nothing is read: this process's OWN cgroup
//     (manta-server's) is never substituted — it is a different budget.
//   - Warnings are fixed literals. Raw stderr / error text is never copied
//     into the response.
//
// Pure helpers are exported; all I/O is injectable via `deps`.

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { readFile as fsReadFile, stat as fsStat, statfs as fsStatfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFileCb);

const KIB = 1024;
const MIB = KIB * 1024;
const GIB = MIB * 1024;

// Deterministic status boundaries. The spec pins the three status names and
// "based on available-memory and disk headroom" but not the numbers, so these
// are the single place they live. Comparisons are strict `<`: a value exactly
// AT a boundary gets the healthier status. Either the absolute floor OR the
// fraction of the total trips a level, so a big box and a small box both read
// sensibly. The overall status is the worse of memory and disk.
export const THRESHOLDS = Object.freeze({
  memory: {
    critical: { bytes: 512 * MIB, fraction: 0.05 },
    constrained: { bytes: 2 * GIB, fraction: 0.15 },
  },
  disk: {
    // 1 GiB matches the "keep >1G free or jobs wedge with ENOSPC" rule of thumb.
    critical: { bytes: 1 * GIB, fraction: 0.03 },
    constrained: { bytes: 5 * GIB, fraction: 0.1 },
  },
});

// Suggested allowance for ONE new heavy job, as a fraction of currently
// available memory. The spec caps it at 20%; it is tightened when headroom is
// already thin so the advice never grows as the box gets tighter.
export const SUGGESTED_FRACTION = Object.freeze({ ok: 0.2, constrained: 0.1, critical: 0 });

export const PROBE_TIMEOUTS_MS = Object.freeze({
  meminfo: 1000,
  disk: 2000,
  processes: 2000,
  docker: 5000, // `docker stats --no-stream` samples for ~1-2s
  cgroup: 3000, // unit lookup (systemctl) + three tiny file reads
});

// opencode runs as its own systemd user service, separate from manta-server
// (which is what serves this route). Its memory budget is the unit's cgroup,
// NOT the server's own — so the unit is looked up by its fixed name.
export const OPENCODE_UNIT = "opencode-serve";
const CGROUP_ROOT = "/sys/fs/cgroup";

export const TOP_PROCESS_LIMIT = 10;
export const CONTAINER_LIMIT = 20;
const MAX_NAME_LEN = 64;
const EXEC_MAX_BUFFER = 4 * MIB;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function isNum(n) {
  return typeof n === "number" && Number.isFinite(n);
}

// Strip control characters and cap length so an odd process / container name
// can never inject structure into the model-facing output.
export function sanitizeName(raw) {
  const cleaned = String(raw ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return cleaned.length > MAX_NAME_LEN ? cleaned.slice(0, MAX_NAME_LEN) : cleaned;
}

// /proc/meminfo → {totalBytes, availableBytes}. Values are in kB (KiB).
// MemAvailable is the kernel's own "can start a workload without swapping"
// estimate; absent on kernels < 3.14, in which case it stays null.
export function parseMeminfo(text) {
  const out = { totalBytes: null, availableBytes: null };
  for (const line of String(text ?? "").split("\n")) {
    const m = /^(MemTotal|MemAvailable):\s+(\d+)\s*kB/i.exec(line);
    if (!m) continue;
    const bytes = Number(m[2]) * KIB;
    if (m[1].toLowerCase() === "memtotal") out.totalBytes = bytes;
    else out.availableBytes = bytes;
  }
  return out;
}

// `ps -axo pid=,rss=,comm=` → [{pid, name, rssBytes}] top-N by RSS desc.
// rss is KiB. `comm` is the executable name only (a path on macOS, which we
// reduce to its basename). Lines that don't parse, and zero-RSS kernel
// threads, are dropped.
export function parsePsOutput(text, limit = TOP_PROCESS_LIMIT) {
  const rows = [];
  for (const line of String(text ?? "").split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const rssBytes = Number(m[2]) * KIB;
    if (!(rssBytes > 0)) continue;
    const name = sanitizeName(path.posix.basename(m[3]));
    if (!name) continue;
    rows.push({ pid, name, rssBytes });
  }
  rows.sort((a, b) => b.rssBytes - a.rssBytes || a.pid - b.pid);
  return rows.slice(0, Math.max(0, limit));
}

const SIZE_UNITS = {
  b: 1,
  kb: 1000,
  mb: 1000 ** 2,
  gb: 1000 ** 3,
  tb: 1000 ** 4,
  kib: KIB,
  mib: MIB,
  gib: GIB,
  tib: GIB * KIB,
};

// "12.5MiB" / "1.9GiB" / "0B" → bytes (docker's human sizes). null on
// anything unparseable (e.g. "N/A", "--").
export function parseSize(raw) {
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z]+)\s*$/.exec(String(raw ?? ""));
  if (!m) return null;
  const unit = SIZE_UNITS[m[2].toLowerCase()];
  if (unit === undefined) return null;
  return Math.round(Number(m[1]) * unit);
}

function parsePercent(raw) {
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*%\s*$/.exec(String(raw ?? ""));
  return m ? Number(m[1]) : null;
}

// Tab-separated `docker stats --no-stream --format '{{.ID}}\t{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}'`
// → items sorted by memory usage desc, capped. Unparseable metrics → null.
export function parseDockerStats(text, limit = CONTAINER_LIMIT) {
  const items = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    const [id, name, cpu, mem] = line.split("\t");
    if (!id || !name) continue;
    const [usage, limitStr] = String(mem ?? "").split("/");
    items.push({
      id: sanitizeName(id).slice(0, 12),
      name: sanitizeName(name),
      cpuPercent: parsePercent(cpu),
      memoryUsageBytes: parseSize(usage),
      memoryLimitBytes: parseSize(limitStr),
    });
  }
  items.sort((a, b) => (b.memoryUsageBytes ?? -1) - (a.memoryUsageBytes ?? -1));
  return items.slice(0, Math.max(0, limit));
}

// Level for one resource: "critical" | "constrained" | "ok" | null (unknown).
function levelFor(availableBytes, totalBytes, t) {
  if (!isNum(availableBytes)) return null;
  const frac = isNum(totalBytes) && totalBytes > 0 ? availableBytes / totalBytes : null;
  const below = (b) => availableBytes < b.bytes || (frac !== null && frac < b.fraction);
  if (below(t.critical)) return "critical";
  if (below(t.constrained)) return "constrained";
  return "ok";
}

// Level of opencode's cgroup memory budget. Only meaningful when the cgroup
// has a FINITE limit: an unlimited cgroup is bounded by the host, which the
// host-memory reading already covers. Same thresholds as host memory, with the
// cgroup limit playing the role of "total".
function cgroupLevel(cg) {
  if (!isNum(cg?.limitBytes) || !isNum(cg?.availableBytes)) return null;
  return levelFor(cg.availableBytes, cg.limitBytes, THRESHOLDS.memory);
}

const SEVERITY = { ok: 0, constrained: 1, critical: 2 };

// Overall status = worst of host memory, opencode's cgroup memory budget, and
// disk. A reading we couldn't take is not evidence of headroom: if NEITHER
// host memory nor disk could be measured the status is "constrained" (be
// conservative), otherwise an unknown one just doesn't contribute. A missing or
// unlimited cgroup never counts as "unmeasured" — it simply adds nothing.
export function classifyStatus({ memory, disk }) {
  const hostAndDisk = [
    levelFor(memory?.availableBytes, memory?.totalBytes, THRESHOLDS.memory),
    levelFor(disk?.availableBytes, disk?.totalBytes, THRESHOLDS.disk),
  ].filter(Boolean);
  if (hostAndDisk.length === 0) return "constrained";
  const levels = [...hostAndDisk, cgroupLevel(memory?.opencodeCgroup)].filter(Boolean);
  return levels.reduce((worst, l) => (SEVERITY[l] > SEVERITY[worst] ? l : worst), "ok");
}

// Allowance for one new heavy job: a status-dependent fraction (max 20%) of
// the LOWER of host-available memory and the finite cgroup-available memory.
// A cgroup already over its limit counts as 0 available.
export function suggestJobMemoryBytes(availableBytes, status, cgroupAvailableBytes = null) {
  const candidates = [];
  if (isNum(availableBytes) && availableBytes >= 0) candidates.push(availableBytes);
  if (isNum(cgroupAvailableBytes)) candidates.push(Math.max(0, cgroupAvailableBytes));
  if (candidates.length === 0) return null;
  const fraction = SUGGESTED_FRACTION[status] ?? 0;
  return Math.floor(Math.min(...candidates) * fraction);
}

// ---------------------------------------------------------------------------
// cgroup parsing (pure)
// ---------------------------------------------------------------------------

// A cgroup path as handed to us by systemd / the kernel. Strict allow-list:
// absolute, no empty/./.. segments, only characters that appear in unit and
// slice names. This is what keeps the file reads below inside /sys/fs/cgroup.
export function isSafeCgroupPath(p) {
  if (typeof p !== "string" || p.length === 0 || p.length > 512 || !p.startsWith("/")) return false;
  const segs = p.split("/").slice(1);
  if (segs.length === 0) return false;
  return segs.every((seg, i) => {
    if (seg === "") return p === "/" && i === 0; // only the root path "/" has an empty tail
    return seg !== "." && seg !== ".." && /^[A-Za-z0-9_.@:\\-]+$/.test(seg);
  });
}

// A cgroup memory counter / limit file → bytes, or null. v2 spells unlimited
// "max" (→ null); anything non-numeric, or implausibly huge (≥ 2^60, a
// defensive stand-in for "unlimited"), is null too.
export function parseCgroupBytes(text) {
  const t = String(text ?? "").trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n < 2 ** 60 ? n : null;
}

// Combine the raw counter + limit file contents into the pinned shape.
// The effective limit is the LOWER finite value of memory.max (hard, OOM) and
// memory.high (soft, throttling starts) — the budget a heavy job can actually
// use before the cgroup is slowed or killed. availableBytes is clamped ≥ 0 and
// is null when there is no finite limit (unlimited ⇒ the host is the bound).
export function computeCgroupMemory({ current, limits }) {
  const currentBytes = parseCgroupBytes(current);
  const finite = (limits ?? []).map(parseCgroupBytes).filter((n) => n !== null);
  const limitBytes = finite.length > 0 ? Math.min(...finite) : null;
  const availableBytes =
    limitBytes !== null && currentBytes !== null ? Math.max(0, limitBytes - currentBytes) : null;
  return { currentBytes, limitBytes, availableBytes };
}

// Validate the optional `directory` input. Returns {ok, dir} | {ok:false,error}.
export async function resolveDirectory(input, { cwd = () => process.cwd(), stat = fsStat } = {}) {
  if (input === undefined || input === null || input === "") return { ok: true, dir: cwd() };
  const raw = String(input);
  if (raw.includes("\0") || !path.isAbsolute(raw)) {
    return { ok: false, error: "directory must be an absolute path" };
  }
  const dir = path.resolve(raw);
  try {
    const st = await stat(dir);
    if (!st.isDirectory()) throw new Error("not a directory");
  } catch {
    return { ok: false, error: "directory does not exist or is not a directory" };
  }
  return { ok: true, dir };
}

// Bound any probe — even an injected one that ignores its own timeout — so a
// single hung source can never hold the response.
export function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    // Deliberately NOT unref'd: this timer is the only thing guaranteed to
    // settle a hung probe, and it is cleared as soon as the race resolves.
    timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function isTimeout(e) {
  return e?.code === "ETIMEDOUT" || e?.killed === true || e?.signal === "SIGKILL";
}

// Default exec: fixed argv, no shell, hard timeout, bounded output.
async function defaultExec(file, args, { timeoutMs }) {
  const { stdout } = await execFileAsync(file, args, {
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: EXEC_MAX_BUFFER,
    windowsHide: true,
  });
  return String(stdout);
}

// ---------------------------------------------------------------------------
// Probes — each resolves to {value?, warning?}; none throws.
// ---------------------------------------------------------------------------

async function probeMemory(d) {
  try {
    if (d.platform === "linux") {
      const text = await withTimeout(d.readFile("/proc/meminfo", "utf8"), d.timeouts.meminfo);
      const parsed = parseMeminfo(text);
      if (isNum(parsed.totalBytes) && isNum(parsed.availableBytes)) return { value: parsed };
    }
  } catch {
    /* fall through to the approximate reading */
  }
  try {
    const total = d.os.totalmem();
    const free = d.os.freemem();
    if (isNum(total) && isNum(free)) {
      return {
        value: { totalBytes: total, availableBytes: free },
        warning: "memory: using approximate values (precise source unavailable)",
      };
    }
  } catch {
    /* unavailable */
  }
  return {
    value: { totalBytes: null, availableBytes: null },
    warning: "memory: unavailable",
  };
}

const NO_CGROUP = Object.freeze({ currentBytes: null, limitBytes: null, availableBytes: null });

// Where is opencode's cgroup? Only the opencode-serve unit's own cgroup counts
// (fixed argv, read-only). There is deliberately NO fallback to this process's
// cgroup: that is manta-server's, a different budget, and presenting it as
// opencode's would mislead the model. No unit path ⇒ nothing is read.
async function resolveUnitCgroupPath(d) {
  const out = await withTimeout(
    d.exec("systemctl", ["--user", "show", OPENCODE_UNIT, "-p", "ControlGroup", "--value"], {
      timeoutMs: d.timeouts.cgroup,
    }),
    d.timeouts.cgroup,
  );
  const p = String(out).trim();
  return isSafeCgroupPath(p) && p !== "/" ? p : null;
}

async function readOptional(d, file) {
  try {
    return await d.readFile(file, "utf8");
  } catch {
    return null;
  }
}

const CGROUP_UNAVAILABLE_WARNING = "memory: opencode unit cgroup could not be identified or read";

// Bounded as a whole (lookup + reads) by timeouts.cgroup. Never throws.
async function probeCgroup(d) {
  if (d.platform !== "linux") return { value: { ...NO_CGROUP } }; // not applicable, not a failure
  try {
    const value = await withTimeout(readUnitCgroup(d), d.timeouts.cgroup);
    if (value) return { value };
  } catch {
    /* fall through to unavailable */
  }
  return { value: { ...NO_CGROUP }, warning: CGROUP_UNAVAILABLE_WARNING };
}

// cgroup v2 only. A v1 host (or a failed lookup) reports unavailable rather
// than guessing at a hierarchy path we haven't verified.
async function readUnitCgroup(d) {
  const path = await resolveUnitCgroupPath(d);
  if (!path) return null;
  const base = `${CGROUP_ROOT}${path}`;
  const current = await readOptional(d, `${base}/memory.current`);
  if (current === null) return null;
  const [max, high] = await Promise.all([
    readOptional(d, `${base}/memory.max`),
    readOptional(d, `${base}/memory.high`),
  ]);
  const value = computeCgroupMemory({ current, limits: [max, high] });
  return value.currentBytes === null ? null : value;
}

async function probeDisk(d, dir) {
  try {
    const s = await withTimeout(d.statfs(dir), d.timeouts.disk);
    const total = Number(s.blocks) * Number(s.bsize);
    const avail = Number(s.bavail) * Number(s.bsize);
    if (isNum(total) && isNum(avail)) {
      return { value: { path: dir, totalBytes: total, availableBytes: avail } };
    }
  } catch {
    /* unavailable */
  }
  return { value: { path: dir, totalBytes: null, availableBytes: null }, warning: "disk: unavailable" };
}

async function probeProcesses(d) {
  try {
    // NOTE: no `args`, `command` or `e` output specifier — see header.
    const out = await withTimeout(
      d.exec("ps", ["-axo", "pid=,rss=,comm="], { timeoutMs: d.timeouts.processes }),
      d.timeouts.processes,
    );
    return { value: parsePsOutput(out, d.topProcessLimit) };
  } catch (e) {
    return {
      value: [],
      warning: isTimeout(e) ? "processes: timed out" : "processes: unavailable",
    };
  }
}

async function probeDocker(d) {
  try {
    // NOTE: `stats` only. Never `inspect` / `logs` / `ps --format` with extras.
    const out = await withTimeout(
      d.exec(
        "docker",
        ["stats", "--no-stream", "--format", "{{.ID}}\t{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}"],
        { timeoutMs: d.timeouts.docker },
      ),
      d.timeouts.docker,
    );
    return { value: { available: true, items: parseDockerStats(out, d.containerLimit) } };
  } catch (e) {
    let warning = "docker: unavailable (daemon not reachable)";
    if (e?.code === "ENOENT") warning = "docker: not installed";
    else if (isTimeout(e)) warning = "docker: timed out";
    return { value: { available: false, items: [] }, warning };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function buildDeps(overrides = {}) {
  return {
    exec: defaultExec,
    readFile: fsReadFile,
    stat: fsStat,
    statfs: fsStatfs,
    os: {
      totalmem: () => os.totalmem(),
      freemem: () => os.freemem(),
      loadavg: () => os.loadavg(),
      cpuCount: () => (typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length),
    },
    platform: process.platform,
    cwd: () => process.cwd(),
    now: () => new Date(),
    timeouts: { ...PROBE_TIMEOUTS_MS },
    topProcessLimit: TOP_PROCESS_LIMIT,
    containerLimit: CONTAINER_LIMIT,
    ...overrides,
    ...(overrides.timeouts ? { timeouts: { ...PROBE_TIMEOUTS_MS, ...overrides.timeouts } } : {}),
  };
}

// Collect a snapshot for an already-validated directory. Never rejects.
export async function collectSnapshot(dir, overrides = {}) {
  const d = buildDeps(overrides);
  const [hostMem, cgroup, disk, procs, docker] = await Promise.all([
    probeMemory(d),
    probeCgroup(d),
    probeDisk(d, dir),
    probeProcesses(d),
    probeDocker(d),
  ]);
  const mem = { value: { ...hostMem.value, opencodeCgroup: cgroup.value } };

  const warnings = [hostMem.warning, cgroup.warning, disk.warning, procs.warning, docker.warning].filter(
    Boolean,
  );

  let cpu;
  try {
    const [l1, l5, l15] = d.os.loadavg();
    cpu = {
      count: d.os.cpuCount(),
      load1: isNum(l1) ? l1 : null,
      load5: isNum(l5) ? l5 : null,
      load15: isNum(l15) ? l15 : null,
    };
  } catch {
    cpu = { count: 0, load1: null, load5: null, load15: null };
    warnings.push("cpu: unavailable");
  }

  const status = classifyStatus({ memory: mem.value, disk: disk.value });
  const memLevel = levelFor(mem.value.availableBytes, mem.value.totalBytes, THRESHOLDS.memory);
  const diskLevel = levelFor(disk.value.availableBytes, disk.value.totalBytes, THRESHOLDS.disk);
  const cgLevel = cgroupLevel(cgroup.value);
  if (memLevel && memLevel !== "ok") warnings.push("memory: headroom is low");
  if (cgLevel && cgLevel !== "ok") warnings.push("memory: opencode cgroup headroom is low");
  if (diskLevel && diskLevel !== "ok") warnings.push("disk: headroom is low");

  return {
    ok: true,
    capturedAt: d.now().toISOString(),
    memory: mem.value,
    cpu,
    disk: disk.value,
    topProcesses: procs.value,
    containers: docker.value,
    status,
    suggestedJobMemoryBytes: suggestJobMemoryBytes(
      mem.value.availableBytes,
      status,
      cgroup.value.availableBytes,
    ),
    warnings,
  };
}

// Route entry: validate the directory, then collect.
// Returns {ok:false,error} for bad input (→ HTTP 400), else the snapshot.
export async function resourceSnapshot({ directory } = {}, overrides = {}) {
  const resolved = await resolveDirectory(directory, {
    cwd: overrides.cwd ?? (() => process.cwd()),
    stat: overrides.stat ?? fsStat,
  });
  if (!resolved.ok) return resolved;
  return collectSnapshot(resolved.dir, overrides);
}
