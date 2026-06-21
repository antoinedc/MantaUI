// opencode integration — Phase 1 (read-only transcript).
//
// Architecture:
//
//   remote host:
//     ┌──────────────────────────────────────────────┐
//     │ tmux session `bui-opencode` (detached)       │
//     │   └─ opencode serve --port 4096 --hostname   │
//     │      127.0.0.1   ← single server per remote  │
//     └──────────────────────────────────────────────┘
//                          ▲
//                    SSH local -L forward
//                  (4096 on remote → 14096 local)
//                          │
//   bui main (Electron):
//     - ensureRunning() boots the server if absent
//     - ensureForward() attaches a -L forward to the existing
//       SSH ControlMaster (same socket pty.ts uses)
//     - subscribeEvents() opens one long-lived SSE stream and
//       forwards every event to the renderer via IPC
//     - createSession() / listMessages() are thin HTTP clients
//
// Chat-mode tmux windows hold `sleep infinity` panes; the bui React UI is
// what the user actually interacts with. The tmux window exists only to keep
// the same project/window model that claude-TUI windows use.
//
// Auth: server binds 127.0.0.1 on the remote; the SSH tunnel keeps it off
// the wire. No OPENCODE_SERVER_PASSWORD configured.

import { spawn as cpSpawn } from "node:child_process";
import { join as pathJoin } from "node:path";
import {
  runSshOnce,
  getBranch as getBranchSsh,
  expandRemotePath,
} from "./pty.js";
import {
  decideEviction,
  isPortForwardingFailure,
  parseLsofListeners,
} from "./forwardHeal.js";
import {
  dropCachedTranscript,
  getCachedTranscript,
  setCachedTranscript,
} from "./transcriptCache.js";
import type {
  AppConfig,
  OpencodeMessage,
  OpencodeModel,
  OpencodeSessionListItem,
} from "../shared/types.js";

const REMOTE_PORT = 4096;
export const BUI_OPENCODE_TMUX_SESSION = "bui-opencode";
export const OPENCODE_SID_OPT = "@bui-session-id";

// Mobile/web server (src/server/index.mjs) listens on 127.0.0.1:8787 on the
// box. The desktop forwards it to a local port so it can POST desktop-presence
// heartbeats — letting the box suppress mobile "done" pushes while the user is
// active on desktop. Best-effort: if the mobile server isn't running, the
// forward still binds (it's the local socket that's created) and POSTs just
// fail, which the presence reporter swallows.
const MOBILE_SERVER_REMOTE_PORT = 8787;
export const PRESENCE_LOCAL_PORT = 18787;

function localPort(config: AppConfig): number {
  return config.opencodePort ?? 14096;
}

function sshTarget(config: AppConfig): string {
  return config.user ? `${config.user}@${config.host}` : config.host;
}

// ===== Dedicated event-stream tunnel =====
//
// The SSE event stream rides its OWN `ssh -L -N` process, completely
// separate from the shared ControlMaster the RPC/pty/-L-forward path uses.
// Rationale (proven this session): a single ControlMaster multiplexing ~10
// long-lived SSE streams + RPC + the forward goes half-dead after a network
// transition — heartbeats trickle but substantive frames stall, and tearing
// the master down to recover also disrupts RPC/pty. Isolating the event
// transport means: (1) a degraded event tunnel can be killed + respawned
// WITHOUT touching RPC/pty, and (2) recovery is a plain process restart
// (fully verifiable on demand — see eventTunnelRestart), not ssh -O
// surgery on a shared mux. NO ControlMaster here on purpose: a fresh
// dedicated connection each time sidesteps the half-dead-mux failure mode
// entirely for the stream that matters most.
const EVENT_LOCAL_PORT = 14097;

let eventTunnelProc: ReturnType<typeof cpSpawn> | null = null;
let eventTunnelReady: Promise<void> | null = null;

function spawnEventTunnel(config: AppConfig): Promise<void> {
  if (eventTunnelReady) return eventTunnelReady;
  eventTunnelReady = new Promise<void>((resolve, reject) => {
    if (!config.host) {
      reject(new Error("No host configured"));
      return;
    }
    const args = [
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
      // No ControlMaster/ControlPath: this is a standalone connection.
      "-o", "ControlMaster=no",
      "-o", "ControlPath=none",
      "-N",
      "-L", `${EVENT_LOCAL_PORT}:127.0.0.1:${REMOTE_PORT}`,
    ];
    if (config.identityFile) args.push("-i", config.identityFile);
    args.push(sshTarget(config));
    const p = cpSpawn("ssh", args, { stdio: ["ignore", "ignore", "pipe"] });
    eventTunnelProc = p;
    let settled = false;
    let stderr = "";
    p.stderr.on("data", (b) => (stderr += b.toString()));
    p.on("error", (e) => {
      if (!settled) { settled = true; eventTunnelReady = null; reject(e); }
    });
    p.on("exit", (code) => {
      eventTunnelProc = null;
      eventTunnelReady = null;
      if (!settled) {
        settled = true;
        reject(
          new Error(
            `event tunnel ssh exited ${code} before ready: ${stderr.trim()}`,
          ),
        );
      }
    });
    // `-N` never prints on success; the forward is usable within a moment of
    // the TCP connect. Poll the local port until opencode answers, then
    // resolve. Bounded so a wedged connect rejects instead of hanging.
    void (async () => {
      for (let i = 0; i < 40; i++) {
        if (settled) return;
        try {
          const res = await fetch(
            `http://127.0.0.1:${EVENT_LOCAL_PORT}/global/health`,
            { signal: AbortSignal.timeout(1000) },
          );
          if (res.ok) { settled = true; resolve(); return; }
        } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!settled) {
        settled = true;
        eventTunnelReady = null;
        try { p.kill(); } catch { /* already dead */ }
        reject(new Error("event tunnel did not become ready within 10s"));
      }
    })();
  });
  return eventTunnelReady;
}

// Ensure the dedicated event tunnel is up. Idempotent: reuses a live one,
// (re)spawns if absent. Called by subscribeEvents before each connect.
export async function ensureEventTunnel(config: AppConfig): Promise<void> {
  if (eventTunnelProc && eventTunnelReady) {
    await eventTunnelReady;
    return;
  }
  await spawnEventTunnel(config);
}

// Recovery primitive: kill the dedicated event tunnel so the next
// subscribeEvents respawns a FRESH connection. Replaces the ControlMaster
// eviction for the event path — no shared-mux collateral. Also the manual
// degradation hook for verification (simulate a dead event transport).
export function eventTunnelRestart(): void {
  const p = eventTunnelProc;
  eventTunnelProc = null;
  eventTunnelReady = null;
  if (p) {
    try { p.kill("SIGKILL"); } catch { /* already dead */ }
  }
}

export function teardownEventTunnel(): void {
  eventTunnelRestart();
}

// ===== server lifecycle =====

export async function ensureRunning(config: AppConfig): Promise<void> {
  // Probe the REMOTE port directly — `tmux has-session` only tells us the
  // wrapping tmux is alive, not that opencode inside it didn't crash on
  // startup or get killed by an upgrade/OOM. Trusting tmux's presence was
  // how a dead opencode produced a bare `TypeError: fetch failed` at the
  // next session-create.
  const { stdout } = await runSshOnce(
    config,
    `if curl -fsS -o /dev/null --max-time 2 http://127.0.0.1:${REMOTE_PORT}/global/health; then echo healthy; ` +
    `elif tmux has-session -t ${BUI_OPENCODE_TMUX_SESSION} 2>/dev/null; then echo stale; ` +
    `else echo down; fi`,
  );
  const state = stdout.trim();
  if (state === "healthy") return;

  // Stale tmux session (opencode crashed inside) — tear it down so the
  // new-session below isn't a no-op (tmux refuses to create a session that
  // already exists). Best-effort kill.
  if (state === "stale") {
    await runSshOnce(
      config,
      `tmux kill-session -t ${BUI_OPENCODE_TMUX_SESSION} 2>/dev/null || true`,
    );
  }

  // Ubuntu's stock .bashrc returns early when non-interactive, so the PATH
  // export the opencode installer writes never runs under `bash -lc`. Prepend
  // ~/.opencode/bin explicitly. If the user has a non-standard install we'll
  // surface a config knob for it later.
  const startCmd =
    `tmux new-session -d -s ${BUI_OPENCODE_TMUX_SESSION} ` +
    `'bash -c "export PATH=\\$HOME/.opencode/bin:\\$PATH; ` +
    `opencode serve --port ${REMOTE_PORT} --hostname 127.0.0.1"'`;
  await runSshOnce(config, startCmd);

  // First start runs sqlite migrations (a few seconds); subsequent restarts
  // are sub-second. Probe /global/health until it responds.
  await runSshOnce(
    config,
    `for i in $(seq 1 30); do ` +
    `  curl -fsS -o /dev/null http://127.0.0.1:${REMOTE_PORT}/global/health && exit 0; ` +
    `  sleep 1; ` +
    `done; exit 1`,
  );
}

// ===== local SSH -L forward =====
//
// We attach `-L localPort:127.0.0.1:REMOTE_PORT` to the SAME ControlMaster
// connection pty.ts uses, via `ssh -O forward`. Cancel is symmetric.

// Must match pty.ts's CONTROL_PATH exactly so we share its ControlMaster.
// `/tmp` (not tmpdir()) because macOS tmpdir() overflows the sun_path limit.
const CONTROL_PATH = pathJoin("/tmp", "bui-cm-%C");

function controlArgs(config: AppConfig): string[] {
  const args = [
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=${CONTROL_PATH}`,
    "-o", "ControlPersist=10m",
  ];
  if (config.identityFile) args.push("-i", config.identityFile);
  return args;
}

type SshControlResult = { code: number | null; stderr: string };

// Run `ssh -O <op>` and hand back the raw exit code + stderr instead of
// throwing. The healing path needs the stderr text to tell a benign
// "already forwarded" from a real "port forwarding failed".
function runSshControl(
  config: AppConfig,
  op: string,
  extra: string[] = [],
): Promise<SshControlResult> {
  return new Promise((resolve, reject) => {
    const args = [...controlArgs(config), "-O", op, ...extra, sshTarget(config)];
    const p = cpSpawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (b) => (stderr += b.toString()));
    p.on("error", reject);
    p.on("exit", (code) => resolve({ code, stderr }));
  });
}

function sshControl(config: AppConfig, op: string, extra: string[] = []): Promise<void> {
  return runSshControl(config, op, extra).then(({ code, stderr }) => {
    if (code === 0) return;
    // "Forward already exists" is a normal idempotent case for `-O forward`.
    if (/already forwarded/i.test(stderr)) return;
    throw new Error(`ssh -O ${op} exited ${code}: ${stderr.trim()}`);
  });
}

// Ask ssh for its *effective* config and read back the expanded ControlPath
// (the `%C` token resolved to a concrete /tmp/bui-cm-<hash>). This is the
// socket the live master listens on; the orphan is any other bui socket.
function resolveLiveSocket(config: AppConfig): Promise<string | null> {
  return new Promise((resolve) => {
    const args = [...controlArgs(config), "-G", sshTarget(config)];
    const p = cpSpawn("ssh", args, { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    p.stdout.on("data", (b) => (stdout += b.toString()));
    p.on("error", () => resolve(null));
    p.on("exit", () => {
      const line = stdout
        .split("\n")
        .find((l) => l.toLowerCase().startsWith("controlpath "));
      resolve(line ? line.slice("controlpath ".length).trim() : null);
    });
  });
}

function runCapture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const p = cpSpawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (b) => (out += b.toString()));
    p.on("error", () => resolve(""));
    p.on("exit", () => resolve(out));
  });
}

// Evict a stale ControlMaster from a previous app run that is still holding
// the local forward port (kept alive by ControlPersist). Returns true if it
// took an action that warrants retrying the forward.
async function evictStaleForwardHolder(config: AppConfig): Promise<boolean> {
  const port = localPort(config);
  const lsofOut = await runCapture("lsof", [
    "-nP",
    `-iTCP:${port}`,
    "-sTCP:LISTEN",
    "-F",
    "pcn",
  ]);
  const holders = parseLsofListeners(lsofOut);
  if (holders.length === 0) return false;

  // Full command line per pid so decideEviction can read each ssh's
  // `-o ControlPath=...` and match it against the live socket.
  const psByPid = new Map<number, string>();
  for (const h of holders) {
    const ps = await runCapture("ps", ["-o", "command=", "-p", String(h.pid)]);
    psByPid.set(h.pid, ps.trim());
  }

  const liveSocket = await resolveLiveSocket(config);
  if (!liveSocket) return false;

  const decision = decideEviction(holders, psByPid, liveSocket);
  if (decision.action === "evict") {
    // `ssh -O exit` on the ORPHAN's own socket (not our controlArgs path):
    // graceful master shutdown, which closes its listeners and frees the
    // port. Target the socket explicitly so we never touch the live master.
    await new Promise<void>((r) =>
      cpSpawn(
        "ssh",
        [
          "-o",
          `ControlPath=${decision.socketPath}`,
          "-O",
          "exit",
          sshTarget(config),
        ],
        { stdio: "ignore" },
      )
        .on("exit", () => r())
        .on("error", () => r()),
    );
    return true;
  }
  if (decision.action === "foreign") {
    throw new Error(
      `opencode local port ${port} is held by another process ` +
        `(pid ${decision.pid}, ${decision.command}). Close it or set a ` +
        `different opencodePort in settings.`,
    );
  }
  return false;
}

let forwarded = false;

// Probe + rebuild on every call. A cached "we already forwarded once" boolean
// lies after wifi drops, laptop sleep, or remote sshd restart — the master
// socket is gone but the flag still says up, and every fetch lands on a dead
// port. `ssh -O check` is ~1ms when the master is alive; we eat that cost to
// keep the path self-healing. `-O forward` is idempotent (sshControl treats
// "already forwarded" as success).
export async function ensureForward(config: AppConfig): Promise<void> {
  try {
    await sshControl(config, "check");
  } catch {
    // ControlMaster is gone (or never existed). Boot it via the same path
    // runSshOnce uses elsewhere.
    forwarded = false;
    await runSshOnce(config, "true");
  }
  const spec = `${localPort(config)}:127.0.0.1:${REMOTE_PORT}`;
  const first = await runSshControl(config, "forward", ["-L", spec]);
  if (first.code === 0 || /already forwarded/i.test(first.stderr)) {
    forwarded = true;
    return;
  }

  // The forward was rejected. If it's specifically a port-binding failure,
  // the usual cause is a stale ControlMaster from a previous app run still
  // holding the port (ControlPersist outlives the killed instance). Evict
  // that orphan and retry once. Any other failure is real — surface it.
  if (isPortForwardingFailure(first.stderr)) {
    const evicted = await evictStaleForwardHolder(config);
    if (evicted) {
      const retry = await runSshControl(config, "forward", ["-L", spec]);
      if (retry.code === 0 || /already forwarded/i.test(retry.stderr)) {
        forwarded = true;
        return;
      }
      throw new Error(
        `ssh -O forward exited ${retry.code} after evicting stale ` +
          `master: ${retry.stderr.trim()}`,
      );
    }
  }
  throw new Error(
    `ssh -O forward exited ${first.code}: ${first.stderr.trim()}`,
  );
}

export async function teardownForward(config: AppConfig): Promise<void> {
  if (!forwarded) return;
  const spec = `${localPort(config)}:127.0.0.1:${REMOTE_PORT}`;
  await sshControl(config, "cancel", ["-L", spec]).catch(() => {});
  forwarded = false;
}

// Best-effort `-L PRESENCE_LOCAL_PORT:127.0.0.1:8787` forward on the shared
// ControlMaster so the desktop can POST presence heartbeats to the mobile
// server. Idempotent ("already forwarded" is success). Never throws — a
// missing mobile server or a forwarding hiccup must not break the opencode
// path; presence is a nice-to-have. Assumes the ControlMaster is already up
// (callers invoke this right after ensureForward()).
let presenceForwarded = false;
export async function ensurePresenceForward(config: AppConfig): Promise<boolean> {
  try {
    const spec = `${PRESENCE_LOCAL_PORT}:127.0.0.1:${MOBILE_SERVER_REMOTE_PORT}`;
    const res = await runSshControl(config, "forward", ["-L", spec]);
    presenceForwarded =
      res.code === 0 || /already forwarded/i.test(res.stderr);
    return presenceForwarded;
  } catch {
    return false;
  }
}

export function invalidateForward(): void {
  forwarded = false;
  // The presence forward rides the same master; when it dies, re-establish on
  // the next ensurePresenceForward() too.
  presenceForwarded = false;
}

// Force-evict OUR OWN live ControlMaster, then mark the forward stale.
//
// `evictStaleForwardHolder` only fires on a port-bind failure and only
// targets *orphan* sockets (a different master than the live one). It has
// no answer for the half-dead-master case: the master we are actively
// using passes `ssh -O check` and still services short calls, but has
// stopped pumping long-lived SSE streams (see classifyStreamHealth in
// forwardHeal.ts). The only recovery is to tear that master down so the
// next ensureForward() boots a fresh one.
//
// `ssh -O exit` here uses controlArgs() → ControlPath=/tmp/bui-cm-%C, i.e.
// it targets the master for THIS config's connection (the one we use), not
// an orphan. Best-effort: if the socket is already gone, the next
// ensureForward() rebuilds anyway.
export async function forceEvictControlMaster(
  config: AppConfig,
): Promise<void> {
  await runSshControl(config, "exit").catch(() => {});
  forwarded = false;
}

// ===== HTTP client =====

function apiUrl(config: AppConfig, path: string): string {
  return `http://127.0.0.1:${localPort(config)}${path}`;
}

// ===== Side-channel backpressure =====
//
// Every side-channel HTTP call (permissions, questions, prompt, models, …)
// rides the `-L` forward over the SHARED ssh ControlMaster. undici opens a
// fresh TCP socket per concurrent fetch to 127.0.0.1:<port>, and each becomes
// a multiplexed ssh channel. With many sessions mounted, ChatPanel fans these
// out unbounded; once concurrent channels exceed the remote sshd MaxSessions,
// sshd refuses new ones and in-flight requests die with
// `SocketError: other side closed` / `ssh exited 255` — the user sees the
// send spinner hang forever and live updates stop. Cap concurrency here so the
// client can never flood the mux, independent of how many sessions are open.
// (Remote MaxSessions was also raised to 50; this is the belt to that braces.)
//
// The cap is a CEILING against mux exhaustion, not a throttle on normal
// traffic. During an active turn, ChatPanel fires a full-transcript refetch
// (listMessages) on every message.part.updated/.updated, and with several
// chat panels streaming at once those refetches contend for slots. A cap of 6
// queued them behind each other and made streaming visibly lag. 16 stays
// comfortably under the remote MaxSessions=50 (leaving headroom for the SSE
// streams and ensureForward's own channels) while no longer starving the
// refetch storm — the regression that made live updates feel slow.
const FORWARD_FETCH_MAX_CONCURRENCY = 16;
let forwardFetchInFlight = 0;
const forwardFetchQueue: Array<() => void> = [];

function acquireForwardSlot(): Promise<void> {
  if (forwardFetchInFlight < FORWARD_FETCH_MAX_CONCURRENCY) {
    forwardFetchInFlight++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => forwardFetchQueue.push(resolve));
}

function releaseForwardSlot(): void {
  const next = forwardFetchQueue.shift();
  if (next) {
    // Hand the slot directly to the next waiter; count stays unchanged.
    next();
  } else {
    forwardFetchInFlight--;
  }
}

// Drop-in replacement for `fetch(apiUrl(...))` that is gated by the
// concurrency semaphore above. Same signature/return as global fetch.
//
// A hung request is catastrophic here, not merely slow: the SSH ControlMaster
// can silently stall a forwarded connection (mux channel exhaustion, a dropped
// link), and a `fetch` with no signal then waits FOREVER. Because the request
// holds its semaphore slot until the `finally` runs, six such hangs exhaust
// FORWARD_FETCH_MAX_CONCURRENCY and every subsequent forwardFetch deadlocks at
// acquireForwardSlot() — the whole side channel wedges with no recovery (this
// is what left the chat panel's "↻ refreshing…" hint stuck and unclearable).
// So every request gets a hard timeout that aborts it, which releases the slot.
// 90s is well past opencode's worst-case ~35s transcript fetch but bounded, so
// a genuinely dead connection surfaces as an error the caller can handle
// instead of an eternal pending promise. Callers that pass their own signal
// (none today on this path — SSE streams use raw fetch) are still aborted by
// whichever fires first.
const FORWARD_FETCH_TIMEOUT_MS = 90_000;

async function forwardFetch(
  url: string,
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  await acquireForwardSlot();
  const timeoutSignal = AbortSignal.timeout(FORWARD_FETCH_TIMEOUT_MS);
  const signal = init?.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  try {
    return await fetch(url, { ...init, signal });
  } finally {
    releaseForwardSlot();
  }
}

export type CreatedSession = {
  id: string;
  title: string;
  directory: string;
  projectID: string;
};

// ===== Per-session project-directory scope =====
//
// opencode's tool execution (Bash, Read, Grep, etc.) runs from the SERVER
// process's startup cwd, NOT from session.directory metadata. To make tools
// execute inside the project worktree, every session-mutating POST must
// carry `?directory=<absolute-worktree-path>` (issue #25561 — the directory
// query param IS the channel).
//
// opencode's `/event` stream is ALSO scoped by `?directory=`: a POST with
// `?directory=X` emits its message/session events on the stream subscribed
// to `?directory=X` only. The event bus in src/main/index.ts therefore
// opens one subscription per known directory; here we just have to remember
// each session's directory so prompt/command/fork/compact can append the
// right query string.
const sessionDirectoryCache = new Map<string, string>();
const directoryListeners = new Set<(directory: string) => void>();

// Repair the `/home/<user>/~/...` corruption that opencode persists when a
// session was created (pre-createSession-fix) with a tilde directory: it
// naively joins its cwd ($HOME) with the literal `~/...`, yielding a path
// that does not exist on disk. Every prompt then scopes to that dead path
// and the turn hangs. The fix at createSession stops NEW corruption; this
// repairs sessions ALREADY persisted corrupt, applied at the cache-ingestion
// chokepoint so a stale `?directory=` is never emitted. Pure + exported for
// tests. Collapses a `/~/` segment; leaves clean paths untouched.
export function repairCorruptDirectory(directory: string): string {
  // Only the `/<dir>/~/<rest>` shape is the known corruption. A legitimate
  // path component literally named "~" is implausible on a real worktree.
  const idx = directory.indexOf("/~/");
  return idx === -1 ? directory : directory.slice(0, idx) + directory.slice(idx + 2);
}

function rememberSessionDirectory(
  sessionId: string,
  directory: string | undefined | null,
): void {
  if (!sessionId || typeof directory !== "string" || directory.length === 0) {
    return;
  }
  directory = repairCorruptDirectory(directory);
  const prev = sessionDirectoryCache.get(sessionId);
  sessionDirectoryCache.set(sessionId, directory);
  if (prev !== directory) {
    for (const fn of directoryListeners) {
      try { fn(directory); } catch { /* ignore listener error */ }
    }
  }
}

// Subscribe to discovery of new session directories. Used by the event bus
// in src/main/index.ts to auto-open a `/event?directory=` stream whenever
// bui learns of a new project worktree.
export function onSessionDirectoryAdded(
  listener: (directory: string) => void,
): () => void {
  directoryListeners.add(listener);
  return () => { directoryListeners.delete(listener); };
}

// Snapshot of every directory the cache currently knows about. Used by the
// bus on (re)start to open scoped streams for sessions discovered before
// the subscription was active.
export function knownSessionDirectories(): string[] {
  return Array.from(new Set(sessionDirectoryCache.values()));
}

// The event bus registers a readiness gate here. getSessionDirectoryQuery
// awaits it after resolving a session's directory so a scoped POST never
// goes out before the matching `/event?directory=` subscription is live —
// otherwise opencode emits the response onto a stream with no subscriber and
// the events are lost. No-op until the bus registers (e.g. host not set).
let directoryReadyGate: ((directory: string) => Promise<void>) | null = null;

export function setDirectoryReadyGate(
  gate: ((directory: string) => Promise<void>) | null,
): void {
  directoryReadyGate = gate;
}

async function fetchSessionDirectory(
  config: AppConfig,
  sessionId: string,
): Promise<string | null> {
  await ensureForward(config);
  try {
    const res = await forwardFetch(apiUrl(config, `/session/${encodeURIComponent(sessionId)}`));
    if (!res.ok) return null;
    const body = (await res.json()) as { directory?: unknown };
    return typeof body.directory === "string" ? body.directory : null;
  } catch {
    return null;
  }
}

// Look up (and lazily populate) the per-session directory, then return the
// query-string fragment opencode needs to scope tools + event emission.
// Returns "" only when we genuinely can't resolve a directory.
async function getSessionDirectoryQuery(
  config: AppConfig,
  sessionId: string,
): Promise<string> {
  let dir = sessionDirectoryCache.get(sessionId);
  if (!dir) {
    const fetched = await fetchSessionDirectory(config, sessionId);
    if (fetched) {
      // Route through rememberSessionDirectory (NOT a bare cache.set) so the
      // onSessionDirectoryAdded listeners fire. Without this, an existing
      // session resolved lazily on its first prompt never triggers the event
      // bus to open the `?directory=` scoped stream — and opencode emits that
      // prompt's response events ONLY on that scoped stream, so they vanish
      // and the session looks frozen (SSE "broken in existing sessions").
      rememberSessionDirectory(sessionId, fetched);
      dir = fetched;
    }
  }
  if (dir && directoryReadyGate) {
    // Block until the bus confirms the scoped SSE subscription for this
    // directory is open. Bounded inside the gate; failure must not wedge
    // the prompt, so swallow and proceed (degrades to old behavior).
    try {
      await directoryReadyGate(dir);
    } catch {
      /* gate failed — proceed unscoped-safe rather than hang the prompt */
    }
  }
  return dir ? `?directory=${encodeURIComponent(dir)}` : "";
}

// Returns the cached directory for a session (sync). Used by the event-bus
// manager to know which scoped stream to keep open. Returns null if we have
// never created or fetched this session's directory.
export function getSessionDirectorySync(sessionId: string): string | null {
  return sessionDirectoryCache.get(sessionId) ?? null;
}

// Resolve a session's directory, lazily fetching + caching it on a miss.
// Used by the event bus's stream-open IPC: a ChatPanel mounting for a session
// needs the dir to open the matching scoped `/event?directory=` stream, but
// the dir may not be cached yet on first mount. Returns null only when the
// directory genuinely can't be resolved.
export async function resolveSessionDirectory(
  config: AppConfig,
  sessionId: string,
): Promise<string | null> {
  const cached = sessionDirectoryCache.get(sessionId);
  if (cached) return cached;
  const fetched = await fetchSessionDirectory(config, sessionId);
  if (fetched) {
    rememberSessionDirectory(sessionId, fetched);
    return fetched;
  }
  return null;
}

// Test-only: reset cache between scenarios.
export function _resetSessionDirectoryCache(): void {
  sessionDirectoryCache.clear();
}

export async function createSession(
  config: AppConfig,
  directory: string,
  title: string,
): Promise<CreatedSession> {
  await ensureForward(config);
  // opencode requires an ABSOLUTE directory: given `~/projects/x` it resolves
  // the tilde against its own server cwd ($HOME), persisting the corrupt
  // `/home/dev/~/projects/x`. resolveProjectCwd-fed callers (/clear, /fork's
  // window) pass tilde paths, so expand here at the single creation
  // chokepoint rather than relying on every caller to remember.
  const absDir = directory.startsWith("~")
    ? await expandRemotePath(config, directory)
    : directory;
  const url = apiUrl(config, `/session?directory=${encodeURIComponent(absDir)}`);
  let res: Response;
  try {
    res = await forwardFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
  } catch (e) {
    // Bare `TypeError: fetch failed` from undici drops the cause chain by the
    // time it crosses IPC. Surface the underlying connect error (ECONNREFUSED
    // / ETIMEDOUT) so the renderer toast is actionable instead of mysterious.
    const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
    const detail = cause?.code || cause?.message || (e as Error).message;
    throw new Error(`opencode createSession transport error (${url}): ${detail}`);
  }
  if (!res.ok) {
    throw new Error(`opencode createSession ${res.status}: ${await res.text()}`);
  }
  const sess = (await res.json()) as CreatedSession;
  // Cache session.directory immediately. Prefer the server-confirmed value
  // (handles symlink resolution / canonicalization); fall back to the
  // EXPANDED input (never the raw tilde — that's the bug we just fixed).
  rememberSessionDirectory(sess.id, sess.directory ?? absDir);
  return sess;
}

// Fetch the full transcript for a session. Phase 1 renders the result as-is;
// the renderer ignores parts it can't render (everything except text/reasoning).
export async function listMessages(
  config: AppConfig,
  sessionId: string,
): Promise<OpencodeMessage[]> {
  await ensureForward(config);
  const url = apiUrl(config, `/session/${encodeURIComponent(sessionId)}/message`);
  const res = await forwardFetch(url);
  if (!res.ok) {
    throw new Error(`opencode listMessages ${res.status}: ${await res.text()}`);
  }
  const messages = (await res.json()) as OpencodeMessage[];
  // Stash the fresh transcript so the next mount of this session can render
  // immediately instead of blocking on the (slow) opencode fetch.
  setCachedTranscript(sessionId, messages);
  return messages;
}

// Synchronous-ish cache lookup for renderer-initiated fast paths. Returns
// `null` on miss; the renderer should then fall back to `listMessages` and
// show its loading state. Reading is cheap (memory hit first, disk read at
// worst), so the IPC handler can call this on the main thread without
// blocking other IPC.
export function getCachedMessages(sessionId: string): OpencodeMessage[] | null {
  return getCachedTranscript(sessionId);
}

// Send a user message into the session.
//
// We use the v1 `prompt_async` endpoint (returns 204 immediately, the
// assistant response streams via SSE events). The v2 `/api/session/{id}/prompt`
// endpoint also exists but returns 400 with a "Expected Session.Message, got {}"
// error even when the body matches its documented Prompt schema — looks like
// an upstream bug. Revisit if/when opencode fixes it.
//
// Body shape: `{parts: [{type:"text", text}], model?, ...}` — verified empirically.
// When `model` is omitted opencode falls back to the user's configured default.
// `model` is per-prompt: opencode has no session-level model setting — PATCH
// /session/{id} accepts only title/permission/archived.
export type PromptModel = { providerID: string; modelID: string; variant?: string };

// Attached file: scp'd to the remote, referenced by absolute remote path. The
// server reads from file:// URLs on its own filesystem (opencode runs there).
export type PromptAttachment = {
  remotePath: string;        // absolute path on the remote
  mime: string;
  filename?: string;
};

// Agent mention: structured part for @<agent-name> tokens. `source` carries
// the {start, end} offsets in the rendered text so opencode can correlate
// where the mention appears in the typed message.
export type PromptAgentMention = {
  name: string;
  source: { value: string; start: number; end: number };
};

export async function sendPrompt(
  config: AppConfig,
  sessionId: string,
  text: string,
  model?: PromptModel,
  attachments?: PromptAttachment[],
  mentions?: PromptAgentMention[],
): Promise<void> {
  await ensureForward(config);
  // Scope tools + event emission to the session's worktree. The matching
  // per-directory SSE subscription in src/main/index.ts (OpencodeEventBus)
  // is what makes assistant text reach the renderer; without that subscription
  // the events would only land on the scoped channel and the global stream
  // would see nothing.
  const dirQ = await getSessionDirectoryQuery(config, sessionId);
  const url = apiUrl(config, `/session/${encodeURIComponent(sessionId)}/prompt_async${dirQ}`);
  const parts: Array<Record<string, unknown>> = [];
  if (attachments) {
    for (const a of attachments) {
      parts.push({
        type: "file",
        mime: a.mime,
        url: `file://${a.remotePath}`,
        ...(a.filename ? { filename: a.filename } : {}),
      });
    }
  }
  if (mentions) {
    for (const m of mentions) {
      parts.push({
        type: "agent",
        name: m.name,
        source: m.source,
      });
    }
  }
  parts.push({ type: "text", text });

  const body: Record<string, unknown> = { parts };
  if (model) {
    body.model = { providerID: model.providerID, modelID: model.modelID };
    if (model.variant) body.variant = model.variant;
  }
  const res = await forwardFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`opencode sendPrompt ${res.status}: ${await res.text()}`);
  }
}

// Interrupt the running generation for a session. Idempotent — fine to call
// when nothing is running (the server just returns success).
//
// MUST carry `?directory=<session.directory>` like every other session-
// mutating POST (prompt_async, command, fork, compact). opencode v2 routes
// session mutations to the per-directory worker; an unscoped abort lands
// on the wrong worker so the per-directory worker keeps generating. The
// renderer's running indicator clears because opencode emits *some* idle
// signal in response, but the model loop never actually stops.
export async function abortSession(config: AppConfig, sessionId: string): Promise<void> {
  await ensureForward(config);
  const dirQ = await getSessionDirectoryQuery(config, sessionId);
  const url = apiUrl(config, `/session/${encodeURIComponent(sessionId)}/abort${dirQ}`);
  const res = await forwardFetch(url, { method: "POST" });
  if (!res.ok) {
    throw new Error(`opencode abortSession ${res.status}: ${await res.text()}`);
  }
}

// ===== Permission flow =====
//
// Tools like Write/Edit/Bash can request user approval before executing.
// While a permission is pending the tool's state.status stays at "pending"
// — that's the source of the "stuck on write pending" symptom you saw.
//
// API:
//   GET  /permission                          — list ALL pending permissions
//   POST /permission/{id}/reply  {reply: ...} — approve/deny one
//                                  reply: "once" | "always" | "reject"
// Events: permission.asked, permission.replied (already forwarded by bus).

export type PermissionRequest = {
  id: string;
  sessionID: string;
  permission: string;
  patterns?: string[];
  always?: string[];
  metadata?: Record<string, unknown>;
  tool?: { messageID: string; callID: string };
};

// `sessionId` is optional. When present we scope the list to that session's
// worktree directory — opencode's `WorkspaceRoutingMiddleware` makes the
// unscoped endpoint return [] for sessions bound to a non-default directory
// (verified live against 1.15.5). Skipping `?directory=` here was the root
// cause of "PermissionCard never appears" wedges: the live `per_…` was
// sitting in the server's pending map, we just couldn't see it.
export async function listPermissions(
  config: AppConfig,
  sessionId?: string,
): Promise<PermissionRequest[]> {
  await ensureForward(config);
  const dirQ = sessionId
    ? await getSessionDirectoryQuery(config, sessionId)
    : "";
  const res = await forwardFetch(apiUrl(config, `/permission${dirQ}`));
  if (!res.ok) {
    throw new Error(`opencode listPermissions ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as PermissionRequest[];
}

// Same workspace-routing rule as listPermissions: the reply endpoint silently
// no-ops if the request is routed to the wrong workspace. Pass `sessionId`
// so the reply lands on the pending entry's scope. Without this, bui-side
// "Allow"/"Deny" clicks looked like they worked client-side but never
// reached the server — the tool stayed pending forever.
export async function replyPermission(
  config: AppConfig,
  requestId: string,
  reply: "once" | "always" | "reject",
  sessionId?: string,
): Promise<void> {
  await ensureForward(config);
  const dirQ = sessionId
    ? await getSessionDirectoryQuery(config, sessionId)
    : "";
  const url = apiUrl(
    config,
    `/permission/${encodeURIComponent(requestId)}/reply${dirQ}`,
  );
  const res = await forwardFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reply }),
  });
  if (!res.ok) {
    throw new Error(`opencode replyPermission ${res.status}: ${await res.text()}`);
  }
}

// ===== Question flow =====
//
// When Claude invokes the Question tool, opencode emits question.asked and
// blocks. The user picks options; we POST to /question/{id}/reply to unblock.
// API is v2-only. Events: question.asked, question.replied, question.rejected.

export type QuestionOption = { label: string; description: string };
export type QuestionInfo = {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
};
export type QuestionRequest = {
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
  tool?: { messageID: string; callID: string };
};

// REGRESSION FIX: opencode's /question endpoints are `?directory=`-scoped,
// exactly like prompt_async / the /event stream. The directory-scoping work
// (7392534 et al.) threaded ?directory= onto prompt_async but NOT onto
// list/reply/reject — so after a question fires on the scoped channel, an
// UNSCOPED reply is accepted (HTTP 200) yet the scoped session's blocked
// tool never receives it: the agent hangs in "processing" forever. Append
// the session's scoped query the same way prompt_async does.
//
// The same workspace scoping applies to LIST: `GET /question` (unscoped)
// returns [] for sessions whose worktree isn't the server's default. The
// live `que_…` IDs are sitting in the server's pending map; we just can't
// see them without the right `?directory=`. (Verified live against 1.15.5;
// matches packages/opencode/src/server/routes/instance/httpapi/middleware/
// workspace-routing.ts behavior.) This was the root cause of the
// "QuestionCard never appears" wedge: bui's initial-mount fetch returned
// [], the `que_` was already consumed by the live SSE event we missed,
// and the question stayed unrenderable until manual recovery.
export async function listQuestions(
  config: AppConfig,
  sessionId?: string,
): Promise<QuestionRequest[]> {
  await ensureForward(config);
  const dirQ = sessionId
    ? await getSessionDirectoryQuery(config, sessionId)
    : "";
  const res = await forwardFetch(apiUrl(config, `/question${dirQ}`));
  if (!res.ok) {
    throw new Error(`opencode listQuestions ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as QuestionRequest[];
}

// answers is one string[] per QuestionInfo — the selected option labels (or
// the user's free-text input when custom is true).
export async function replyQuestion(
  config: AppConfig,
  requestId: string,
  answers: string[][],
  sessionId?: string,
): Promise<void> {
  await ensureForward(config);
  const dirQ = sessionId
    ? await getSessionDirectoryQuery(config, sessionId)
    : "";
  const url = apiUrl(
    config,
    `/question/${encodeURIComponent(requestId)}/reply${dirQ}`,
  );
  const res = await forwardFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers }),
  });
  if (!res.ok) {
    throw new Error(`opencode replyQuestion ${res.status}: ${await res.text()}`);
  }
}

export async function rejectQuestion(
  config: AppConfig,
  requestId: string,
  sessionId?: string,
): Promise<void> {
  await ensureForward(config);
  const dirQ = sessionId
    ? await getSessionDirectoryQuery(config, sessionId)
    : "";
  const url = apiUrl(
    config,
    `/question/${encodeURIComponent(requestId)}/reject${dirQ}`,
  );
  const res = await forwardFetch(url, { method: "POST" });
  if (!res.ok) {
    throw new Error(`opencode rejectQuestion ${res.status}: ${await res.text()}`);
  }
}

// ===== Model list =====
//
// Two sources we care about:
//   GET /provider     — full provider registry. `all[]` has every known
//                       provider opencode ships with (~128 of them, thousands
//                       of models). `connected[]` is the small subset the
//                       server has actually authed against. `default` maps
//                       provider id → its default model id.
//   GET /api/model    — v2-style flat list, BUT it returns providers that
//                       have credentials configured even if they aren't in
//                       `connected` — and the response embeds raw API keys
//                       under `options.aisdk.provider.apiKey`. Unusable.
//
// We want: only models from CONNECTED providers, surfaced in a flat list.
// `connected` is just an array of provider ids; we filter `all` by it and
// flatten each provider's `models` map.
// What opencode uses when prompt_async is called without an explicit model.
//
// PRIMARY source: the user's configured `model` in opencode.jsonc, surfaced by
// `/config` as `"<providerID>/<modelID>"`. This is what opencode actually uses
// for a new session, so it's what the picker must show. We deliberately do NOT
// rely on `/provider`'s `default` map for this — that map is a per-provider
// CATALOG default (e.g. anthropic → claude-sonnet-4-6) that ignores the user's
// configured `model`, so reading it made new sessions show the wrong model.
//
// FALLBACK (no `model` configured): the catalog default for the first connected
// provider, so we still render a meaningful label before the first response.
export async function getDefaultModel(
  config: AppConfig,
): Promise<{ providerID: string; modelID: string } | null> {
  await ensureForward(config);

  // Configured default wins. `/config.model` is "<providerID>/<modelID>".
  try {
    const cfgRes = await forwardFetch(apiUrl(config, "/config"));
    if (cfgRes.ok) {
      const cfg = (await cfgRes.json()) as { model?: string };
      const slash = cfg.model?.indexOf("/") ?? -1;
      if (cfg.model && slash > 0) {
        return {
          providerID: cfg.model.slice(0, slash),
          modelID: cfg.model.slice(slash + 1),
        };
      }
    }
  } catch {
    /* fall through to provider catalog default */
  }

  const res = await forwardFetch(apiUrl(config, "/provider"));
  if (!res.ok) return null;
  type R = { connected?: string[]; default?: Record<string, string> };
  const data = (await res.json()) as R;
  const connected = data.connected ?? [];
  const defaults = data.default ?? {};
  for (const id of connected) {
    const modelID = defaults[id];
    if (modelID) return { providerID: id, modelID };
  }
  return null;
}

// Current VCS branch for a working directory. Backs the chat footer's
// "⎇ <branch>" indicator and is polled periodically (every ~5s) by the
// renderer so terminal-side `git checkout` shows up without restarting bui.
//
// IMPORTANT: We deliberately do NOT call opencode's `GET /vcs` here.
// opencode caches the branch per-worker and only refreshes via its own
// internal watcher; a `git checkout` performed in the user's terminal does
// NOT invalidate that cache, so `/vcs` returns stale data ("main" forever)
// and `vcs.branch.updated` never fires. Going direct to `git` over the warm
// ControlMaster (~30ms) is authoritative.
//
// Returns null for: no host, no directory, non-git dir, detached HEAD, or
// transport failure. Detached HEAD is intentionally null — the indicator
// only makes sense as a branch name.
export async function getVcsBranch(
  config: AppConfig,
  directory?: string,
): Promise<string | null> {
  if (!directory) return null;
  return getBranchSsh(config, directory);
}

// Only include models from CONNECTED providers (`/provider.connected`).
// `/api/model` lists Anthropic-via-OAuth + others, but those routes don't
// actually serve prompts — opencode rejects them with "Model not found"
// when invoked. Until `/provider.connected` includes a given provider, its
// models stay out of the picker.
export async function listModels(config: AppConfig): Promise<OpencodeModel[]> {
  await ensureForward(config);
  const out: OpencodeModel[] = [];
  try {
    const res = await forwardFetch(apiUrl(config, "/provider"));
    if (res.ok) {
      type ProviderRow = {
        id?: string;
        models?: Record<string, Record<string, unknown>>;
      };
      type ProviderResponse = { all?: ProviderRow[]; connected?: string[] };
      const data = (await res.json()) as ProviderResponse;
      const connected = new Set(data.connected ?? []);
      for (const p of data.all ?? []) {
        if (!p.id || !connected.has(p.id)) continue;
        for (const modelId of Object.keys(p.models ?? {})) {
          out.push(normalizeProviderModel(p.id, modelId, (p.models ?? {})[modelId]));
        }
      }
    }
  } catch {
    /* non-fatal */
  }
  return out;
}

function normalizeProviderModel(
  providerID: string,
  modelId: string,
  m: Record<string, unknown>,
): OpencodeModel {
  let variants: Array<{ id: string }> | undefined;
  const vRaw = m.variants;
  if (Array.isArray(vRaw)) {
    variants = vRaw
      .map((v) =>
        v && typeof v === "object" ? String((v as Record<string, unknown>).id ?? "") : "",
      )
      .filter(Boolean)
      .map((id) => ({ id }));
  } else if (vRaw && typeof vRaw === "object") {
    variants = Object.keys(vRaw).map((id) => ({ id }));
  }
  return {
    id: String(m.id ?? modelId),
    providerID,
    family: typeof m.family === "string" ? m.family : undefined,
    name: typeof m.name === "string" ? m.name : String(m.id ?? modelId),
    status: typeof m.status === "string" ? m.status : undefined,
    enabled: typeof m.enabled === "boolean" ? m.enabled : undefined,
    limit: m.limit as OpencodeModel["limit"],
    capabilities: m.capabilities as OpencodeModel["capabilities"],
    variants: variants && variants.length > 0 ? variants : undefined,
  };
}

// ===== Slash commands, agents, file search =====
//
// Commands: built-in (/init etc.) and user-defined (markdown templates).
// Agents: built-in primary agents + user-defined sub-agents. Both are used
// as typeahead sources for the @-mention popup in ChatPanel.
// File search: relative paths under a directory, fast enough for live
// keystroke-driven typeahead.

export type OpencodeCommand = {
  name: string;
  description?: string;
  source?: string;     // "command" (built-in) | "project" | "global"
  argumentHint?: string;
  agent?: string;
  model?: string;
};

export type OpencodeAgent = {
  name: string;
  description?: string;
  mode?: string;       // "primary" | "subagent"
  native?: boolean;
  builtIn?: boolean;
};

export async function listCommands(config: AppConfig): Promise<OpencodeCommand[]> {
  await ensureForward(config);
  const res = await forwardFetch(apiUrl(config, "/command"));
  if (!res.ok) {
    throw new Error(`opencode listCommands ${res.status}: ${await res.text()}`);
  }
  const raw = (await res.json()) as Array<Record<string, unknown>>;
  return raw.map((c) => ({
    name: String(c.name ?? ""),
    description: typeof c.description === "string" ? c.description : undefined,
    source: typeof c.source === "string" ? c.source : undefined,
    argumentHint: typeof c.argumentHint === "string" ? c.argumentHint : undefined,
    agent: typeof c.agent === "string" ? c.agent : undefined,
    model: typeof c.model === "string" ? c.model : undefined,
    template: typeof c.template === "string" ? c.template : undefined,
  }));
}

export async function listAgents(config: AppConfig): Promise<OpencodeAgent[]> {
  await ensureForward(config);
  const res = await forwardFetch(apiUrl(config, "/agent"));
  if (!res.ok) {
    throw new Error(`opencode listAgents ${res.status}: ${await res.text()}`);
  }
  const raw = (await res.json()) as Array<Record<string, unknown>>;
  return raw.map((a) => ({
    name: String(a.name ?? ""),
    description: typeof a.description === "string" ? a.description : undefined,
    mode: typeof a.mode === "string" ? a.mode : undefined,
    native: typeof a.native === "boolean" ? a.native : undefined,
    builtIn: typeof a.builtIn === "boolean" ? a.builtIn : undefined,
  }));
}

// File search via opencode's ripgrep-backed endpoint. Returns relative paths
// from `directory`. Empty query returns top-level entries of `directory` —
// exactly what the @-mention typeahead wants when the user has just typed
// `@` with no filter, so we pass empty queries through.
export async function findFiles(
  config: AppConfig,
  query: string,
  directory: string,
): Promise<string[]> {
  await ensureForward(config);
  const qs =
    `?query=${encodeURIComponent(query)}&directory=${encodeURIComponent(directory)}`;
  const res = await forwardFetch(apiUrl(config, `/find/file${qs}`));
  if (!res.ok) {
    throw new Error(`opencode findFiles ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as string[];
}

// Invoke a slash command. Returns when the server accepts the message; the
// assistant response streams via SSE just like prompt_async.
//
// `command` is the command name (no leading slash). `arguments` is the rest
// of the line (everything after `/cmd `). Parts mirror prompt_async — caller
// can attach files alongside the command.
export async function runCommand(
  config: AppConfig,
  sessionId: string,
  command: string,
  argumentsStr: string,
  attachments?: PromptAttachment[],
  model?: PromptModel,
): Promise<void> {
  await ensureForward(config);
  // Same rationale as sendPrompt: scope tools + events to the session worktree.
  const dirQ = await getSessionDirectoryQuery(config, sessionId);
  const url = apiUrl(config, `/session/${encodeURIComponent(sessionId)}/command${dirQ}`);
  const parts: Array<Record<string, unknown>> = [];
  if (attachments) {
    for (const a of attachments) {
      parts.push({
        type: "file",
        mime: a.mime,
        url: `file://${a.remotePath}`,
        ...(a.filename ? { filename: a.filename } : {}),
      });
    }
  }
  const body: Record<string, unknown> = {
    command,
    arguments: argumentsStr,
    parts,
  };
  // /session/{id}/command takes model as a string (e.g. "provider/model"),
  // not the structured object prompt_async uses.
  if (model) {
    body.model = `${model.providerID}/${model.modelID}`;
    if (model.variant) body.variant = model.variant;
  }
  const res = await forwardFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`opencode runCommand ${res.status}: ${await res.text()}`);
  }
}

// ===== Session management =====

// GET /session?directory=... lists sessions scoped to a project directory.
// We don't paginate (limit defaults large on the server). Returns trimmed
// metadata only — the renderer fetches full transcripts on demand.
//
// Side effect: every session whose payload carries a `directory` gets cached
// here. That feeds the per-directory event bus (`onSessionDirectoryAdded`),
// so any call from the sidebar / renderer transparently keeps the streams
// up to date for sessions bui learns about post-launch.
export async function listSessions(
  config: AppConfig,
  directory?: string,
): Promise<OpencodeSessionListItem[]> {
  await ensureForward(config);
  const qs = directory ? `?directory=${encodeURIComponent(directory)}` : "";
  const res = await forwardFetch(apiUrl(config, `/session${qs}`));
  if (!res.ok) {
    throw new Error(`opencode listSessions ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as OpencodeSessionListItem[];
  for (const s of data) {
    const sid = (s as { id?: unknown }).id;
    const dir = (s as { directory?: unknown }).directory;
    if (typeof sid === "string" && typeof dir === "string") {
      rememberSessionDirectory(sid, dir);
    }
  }
  return data;
}

// Fork: copies session history up to `messageID` (or end if omitted) into a
// fresh session. Returns the new session's metadata (same shape as create).
export async function forkSession(
  config: AppConfig,
  sessionId: string,
  messageID?: string,
): Promise<CreatedSession> {
  await ensureForward(config);
  // Scope to the parent session's directory; the fork inherits it.
  const dirQ = await getSessionDirectoryQuery(config, sessionId);
  const url = apiUrl(config, `/session/${encodeURIComponent(sessionId)}/fork${dirQ}`);
  const res = await forwardFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(messageID ? { messageID } : {}),
  });
  if (!res.ok) {
    throw new Error(`opencode forkSession ${res.status}: ${await res.text()}`);
  }
  const sess = (await res.json()) as CreatedSession;
  // The fork inherits the parent session's directory; cache it so the new
  // session id's first prompt POST already carries the right ?directory=.
  rememberSessionDirectory(sess.id, sess.directory);
  return sess;
}

// Compact: v2 endpoint summarizes the session in-place, freeing context. The
// server emits session.compacted via SSE so the renderer's normal refetch
// path picks up the new transcript automatically.
export async function compactSession(config: AppConfig, sessionId: string): Promise<void> {
  await ensureForward(config);
  const dirQ = await getSessionDirectoryQuery(config, sessionId);
  const url = apiUrl(config, `/api/session/${encodeURIComponent(sessionId)}/compact${dirQ}`);
  const res = await forwardFetch(url, { method: "POST" });
  if (!res.ok) {
    throw new Error(`opencode compactSession ${res.status}: ${await res.text()}`);
  }
}

// Delete: removes the session and its messages on the server. Caller is
// responsible for tearing down the matching tmux window separately.
export async function deleteSession(config: AppConfig, sessionId: string): Promise<void> {
  await ensureForward(config);
  // Drop the cache entry — sid will not be reused.
  sessionDirectoryCache.delete(sessionId);
  // Drop the persisted transcript so we don't leak it on disk after delete.
  dropCachedTranscript(sessionId);
  const url = apiUrl(config, `/session/${encodeURIComponent(sessionId)}`);
  const res = await forwardFetch(url, { method: "DELETE" });
  if (!res.ok) {
    throw new Error(`opencode deleteSession ${res.status}: ${await res.text()}`);
  }
}

// ===== Auto-rename: generate a short title via a throwaway session =====
//
// opencode has no cheap one-shot completion endpoint (its only LLM path is a
// session-bound prompt that streams over SSE). To derive a 1-2 word window
// name using the user's OWN opencode model — without a Groq key and without
// polluting the real chat transcript — we spin up a HIDDEN session in the same
// directory, fire one prompt_async, poll its transcript for the assistant
// reply, then delete the session.
//
// `instruction` is the fully-built summarizer prompt (the renderer builds it
// from the live transcript via buildTitleInstruction so the prompt text has a
// single source of truth). Returns the RAW model reply — the caller sanitizes
// it into a window name (sanitizeGeneratedTitle in chatUtils.ts). Returns ""
// on timeout / transport failure so the caller skips the rename rather than
// surfacing an error: an auto-rename is a nicety, never worth a banner.
//
// Cost note: this is gated to every Nth turn (see AUTO_RENAME_EVERY_N_TURNS)
// precisely because the create→prompt→poll→delete dance is ~9s and spends a
// few hundred tokens. Do NOT call it per-turn.
export async function generateSessionTitle(
  config: AppConfig,
  directory: string,
  instruction: string,
): Promise<string> {
  await ensureForward(config);
  const absDir = directory.startsWith("~")
    ? await expandRemotePath(config, directory)
    : directory;
  // A short-lived model preference: reuse the session's configured default so
  // the title matches the voice of the user's own model. null → opencode picks.
  let model: { providerID: string; modelID: string } | null = null;
  try {
    model = await getDefaultModel(config);
  } catch {
    /* non-fatal — opencode falls back to its own default */
  }

  let sid: string | null = null;
  try {
    const createUrl = apiUrl(
      config,
      `/session?directory=${encodeURIComponent(absDir)}`,
    );
    const createRes = await fetch(createUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "bui-auto-title" }),
    });
    if (!createRes.ok) return "";
    sid = ((await createRes.json()) as CreatedSession).id;

    const promptBody: Record<string, unknown> = {
      parts: [{ type: "text", text: instruction }],
    };
    if (model) {
      promptBody.model = { providerID: model.providerID, modelID: model.modelID };
    }
    const promptUrl = apiUrl(
      config,
      `/session/${encodeURIComponent(sid)}/prompt_async?directory=${encodeURIComponent(absDir)}`,
    );
    const promptRes = await fetch(promptUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(promptBody),
    });
    if (!promptRes.ok) return "";

    // Poll the transcript for the assistant's text. Bounded at ~30s; the title
    // model is tiny so this normally resolves in <10s.
    const msgUrl = apiUrl(config, `/session/${encodeURIComponent(sid)}/message`);
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const r = await fetch(msgUrl);
      if (!r.ok) continue;
      const msgs = (await r.json()) as OpencodeMessage[];
      const text = extractAssistantText(msgs);
      if (text) return text;
    }
    return "";
  } catch {
    return "";
  } finally {
    // Best-effort cleanup — never leave the hidden session behind.
    if (sid) {
      try {
        await deleteSession(config, sid);
      } catch {
        /* ignore */
      }
    }
  }
}

// Concatenate all assistant text parts in a transcript. Used only by
// generateSessionTitle to read the throwaway session's reply.
function extractAssistantText(msgs: OpencodeMessage[]): string {
  const out: string[] = [];
  for (const m of msgs) {
    if (m.info.role !== "assistant") continue;
    for (const p of m.parts) {
      if (p.type === "text" && typeof p.text === "string") out.push(p.text);
    }
  }
  return out.join("").trim();
}

// ===== SSE event subscription =====
//
// Returns an async iterator of parsed events. Caller calls dispose() to abort.
// SSE framing: events are separated by blank lines; data: lines carry JSON.

export type EventStream = {
  iter: AsyncIterableIterator<{ id?: string; type: string; properties: Record<string, unknown> }>;
  dispose: () => void;
};

// `directory` opens a project-scoped event stream. opencode emits message /
// session events on the stream whose `?directory=` matches the POST that
// triggered them — a global (`undefined`) subscription sees only events from
// POSTs that themselves had no `?directory=`. To get both, you must open one
// stream per directory you care about. See OpencodeEventBus in src/main/index.ts.
export async function subscribeEvents(
  config: AppConfig,
  directory?: string,
): Promise<EventStream> {
  // Ride the DEDICATED event tunnel, not the shared ControlMaster forward.
  // `?directory=` scoping is unchanged (it's a URL concern, separate from
  // which connection carries the request).
  await ensureEventTunnel(config);
  const controller = new AbortController();
  const path = directory
    ? `/event?directory=${encodeURIComponent(directory)}`
    : "/event";
  const res = await fetch(`http://127.0.0.1:${EVENT_LOCAL_PORT}${path}`, {
    signal: controller.signal,
    headers: { accept: "text/event-stream" },
  });
  if (!res.ok || !res.body) {
    throw new Error(`opencode SSE ${res.status}: ${res.statusText}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  async function* gen(): AsyncIterableIterator<{ id?: string; type: string; properties: Record<string, unknown> }> {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let data = "";
          for (const line of chunk.split("\n")) {
            if (line.startsWith("data:")) {
              data += (data ? "\n" : "") + line.slice(5).trimStart();
            }
            // ignore event: / id: / retry: — type discriminator is inside the JSON
          }
          if (!data) continue;
          try {
            const parsed = JSON.parse(data);
            yield parsed;
          } catch {
            // skip malformed event rather than tear down the stream
          }
        }
      }
    } finally {
      try { reader.releaseLock(); } catch { /* already released */ }
    }
  }

  return { iter: gen(), dispose: () => controller.abort() };
}
