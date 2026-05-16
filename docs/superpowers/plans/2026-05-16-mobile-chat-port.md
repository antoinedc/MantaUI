# Mobile Chat Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Capacitor Android app render the same React renderer as desktop (full chat + terminal + session-management parity) by adding a browser `window.api` shim and an HTTP/SSE backend on the mobile server that proxies the opencode service.

**Architecture:** Approach A. The React renderer (`src/renderer/`) is unchanged — it already targets `window.api.*` only. A new browser shim implements that exact contract over HTTP (`POST /rpc/<channel>`) and one SSE stream (`GET /events`). The mobile server (`src/server/`) gains a thin RPC router + event fan-out; chat calls proxy directly to opencode at `127.0.0.1:4096` (same box — no SSH forward, unlike desktop's `src/main/opencode.ts`). Desktop (Electron main/preload) is untouched.

**Tech Stack:** Node.js (ESM, `.mjs`, no framework — matches existing `src/server/index.mjs`), `node:http`, `EventSource`/SSE, React + Vite (existing renderer), `ws` (existing), Capacitor (existing), vitest (existing).

---

## Reference: Spec

Design spec: `docs/superpowers/specs/2026-05-16-mobile-chat-port-design.md`. Read it first.

## Reference: The exact window.api contract

The shim must implement the surface in `src/preload/index.ts` (read it in full — it is the source of truth for signatures). Type imports come from `src/shared/types.ts`. Channel string values are in the `IPC` const in `src/shared/types.ts` (e.g. `tmuxList: "tmux:list"`, `opencodePrompt: "opencode:prompt"`).

**Two method shapes:**
- **Request/response (38):** `(...args) => Promise<T>` → desktop does `ipcRenderer.invoke(channel, ...args)`. Mobile: `POST /rpc/<channel>` with `{args}`, returns JSON.
- **Event subscription (4):** `onOpencodeEvent`, `onPtyEvent`, `onStatusEvent`, `onScreenshotDetected` — `(cb) => (() => void)`. Desktop does `ipcRenderer.on`. Mobile: register `cb` against a kind on the shared `EventSource`, return an unsubscribe.
- **Pure-local (1):** `getPathForFile(file: File): string` — no server. On mobile return `""` (browser `File` has no OS path; matches the documented Electron fallback).

## Reference: opencode proxy

`src/main/opencode.ts` is the desktop opencode client. Mobile reuses its **HTTP logic** but **drops** the SSH layer. Concretely:
- Desktop `apiUrl(config, path)` = `http://127.0.0.1:<localForwardPort><path>`. Mobile `apiUrl(path)` = `http://127.0.0.1:4096<path>` (constant; `REMOTE_PORT = 4096`).
- **Skip entirely:** `ensureRunning`, `ensureForward`, `teardownForward`, `invalidateForward`, all `ssh`/ControlMaster code, the `config: AppConfig` parameter.
- **Port the body of:** `createSession`, `listMessages`, `sendPrompt`, `abortSession`, `listPermissions`, `replyPermission`, `listQuestions`, `replyQuestion`, `rejectQuestion`, `getDefaultModel`, `getVcsBranch`, `listModels`, `listCommands`, `listAgents`, `findFiles`, `runCommand`, `listSessions`, `forkSession`, `compactSession`, `deleteSession`, `subscribeEvents` — each is a `fetch(apiUrl(...))` call; copy the URL/method/body/parse logic verbatim, just swap `apiUrl`.

---

## File Structure

**Create:**
- `src/renderer/api/httpApi.ts` — browser `window.api` implementation (~250 lines).
- `src/server/rpc.mjs` — channel→handler map + `POST /rpc/<channel>` dispatch.
- `src/server/events.mjs` — single `GET /events` SSE endpoint + fan-out registry.
- `src/server/opencode.mjs` — opencode HTTP proxy (ported from `src/main/opencode.ts`, no SSH).
- `src/server/tmux.mjs` — tmux list/CRUD/config (current `listProjects()` moves here + siblings).
- `src/server/local.mjs` — git worktrees, fsListDirs, openExternal, peekRemoteFile, clipboard stubs, config.
- `electron.vite.config.mobile.ts` — Vite config building `src/renderer/` → `mobile/www/`.
- `src/server/rpc.test.mjs`, `src/server/opencode.test.mjs` — node:test unit tests for pure logic.

**Modify:**
- `src/renderer/main.tsx` — select Electron `window.api` if present, else install `httpApi`.
- `src/server/index.mjs` — mount `/rpc` + `/events`; move `listProjects` to `tmux.mjs`; keep `/pty` WS, static, upload.
- `package.json` — add `build:mobile` script.
- `mobile/sync-web.sh` — copy built renderer instead of the vanilla `www/`.
- `mobile/capacitor.config.json` — already `androidScheme:http` + cleartext (done in prior commit `150e259`); no change unless `webDir` differs.

**Not changed:** all `src/main/*`, all `src/preload/*`, every `src/renderer/*.tsx`, the `/pty` WebSocket protocol, `src/shared/types.ts`.

---

## Slice 1 — Shim + RPC/SSE skeleton; session list loads on phone

Goal: renderer boots in the WebView, `tmuxList()` works over `/rpc`, `/events` SSE connects.

### Task 1: Server — extract tmux module

**Files:**
- Create: `src/server/tmux.mjs`
- Modify: `src/server/index.mjs` (remove `listProjects`, import from `tmux.mjs`)
- Test: `src/server/tmux.test.mjs`

- [ ] **Step 1: Write the failing test**

`src/server/tmux.test.mjs`:
```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSessions } from "./tmux.mjs";

test("parseSessions builds project list from tmux -F output", () => {
  const sess = "alpha\t1\nbeta\t0";
  const wins = "alpha\t1\tmain\t1\t/home/u/alpha\nbeta\t1\tmain\t1\t/home/u/beta";
  const out = parseSessions(sess, wins);
  assert.equal(out.length, 2);
  assert.equal(out[0].tmuxSession, "alpha");
  assert.equal(out[0].attached, true);
  assert.equal(out[0].windows[0].paneCurrentPath, "/home/u/alpha");
  assert.equal(out[1].attached, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/server/tmux.test.mjs`
Expected: FAIL — cannot find module `./tmux.mjs` (or `parseSessions` undefined).

- [ ] **Step 3: Create `src/server/tmux.mjs`**

Move the existing `run()` helper and `listProjects()` body out of `src/server/index.mjs` into `tmux.mjs`. Refactor the parsing into a pure exported `parseSessions(sessStdout, winStdout)` that `listProjects()` calls. Keep the `FS = "\t"` constant. Add the CRUD + config functions, each shelling out via `run("tmux", [...])` mirroring the tmux commands in `src/main/pty.ts` and `src/main/status.ts`:

```javascript
import { spawn as cpSpawn } from "node:child_process";

const FS = "\t";

export function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = cpSpawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (b) => (stdout += b));
    p.stderr.on("data", (b) => (stderr += b));
    p.on("error", reject);
    p.on("exit", (code) =>
      code === 0 ? resolve({ stdout, stderr })
                 : reject(new Error(`${cmd} exited ${code}: ${stderr.trim() || stdout.trim()}`)));
  });
}

export function parseSessions(sessStdout, winStdout) {
  const attached = new Map();
  for (const line of sessStdout.split("\n").filter(Boolean)) {
    const [name, att] = line.split(FS);
    attached.set(name, att === "1");
  }
  const bySession = new Map();
  for (const line of winStdout.split("\n").filter(Boolean)) {
    const [session, index, wname, active, pane] = line.split(FS);
    if (!bySession.has(session)) bySession.set(session, []);
    bySession.get(session).push({
      index: Number(index), name: wname,
      active: active === "1", paneCurrentPath: pane,
    });
  }
  const out = [];
  for (const [name, windows] of bySession) {
    out.push({
      tmuxSession: name,
      defaultCwd: windows[0]?.paneCurrentPath ?? "~",
      windows,
      attached: attached.get(name) ?? false,
    });
  }
  return out;
}

export async function listProjects() {
  const sessFmt = `#{session_name}${FS}#{?session_attached,1,0}`;
  const winFmt = `#{session_name}${FS}#{window_index}${FS}#{window_name}${FS}#{?window_active,1,0}${FS}#{pane_current_path}`;
  const sess = await run("tmux", ["list-sessions", "-F", sessFmt]).catch(() => ({ stdout: "" }));
  const wins = await run("tmux", ["list-windows", "-a", "-F", winFmt]).catch(() => ({ stdout: "" }));
  return parseSessions(sess.stdout, wins.stdout);
}

export async function newSession({ name, cwd, windowName }) {
  await run("tmux", ["new-session", "-d", "-s", name, "-c", cwd ?? ".",
    ...(windowName ? ["-n", windowName] : [])]);
  return listProjects();
}
export async function newWindow({ sessionName, windowName, cwd }) {
  await run("tmux", ["new-window", "-t", sessionName, "-n", windowName,
    ...(cwd ? ["-c", cwd] : [])]);
  return listProjects();
}
export async function renameSession({ oldName, newName }) {
  await run("tmux", ["rename-session", "-t", oldName, newName]);
  return listProjects();
}
export async function renameWindow({ sessionName, windowIndex, newName }) {
  await run("tmux", ["rename-window", "-t", `${sessionName}:${windowIndex}`, newName]);
  return listProjects();
}
export async function killSession(sessionName) {
  await run("tmux", ["kill-session", "-t", sessionName]).catch(() => {});
  return listProjects();
}
export async function killWindow({ sessionName, windowIndex }) {
  await run("tmux", ["kill-window", "-t", `${sessionName}:${windowIndex}`]).catch(() => {});
  return listProjects();
}
export async function selectWindow({ sessionName, windowIndex }) {
  await run("tmux", ["select-window", "-t", `${sessionName}:${windowIndex}`]);
}
```

- [ ] **Step 4: Update `src/server/index.mjs`**

Remove the local `run`/`listProjects` definitions. Add at top with the other imports:
```javascript
import { listProjects } from "./tmux.mjs";
```
Leave the `/api/projects` route calling `listProjects()` as-is (it still works — backward compatible).

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test src/server/tmux.test.mjs`
Expected: PASS (1 test).

- [ ] **Step 6: Smoke the server still serves projects**

Run: `BUI_MOBILE_PORT=8799 node src/server/index.mjs & sleep 2; curl -s localhost:8799/api/projects | head -c 80; kill %1`
Expected: JSON array (or `[]`) — no crash, no stack trace.

- [ ] **Step 7: Commit**

```bash
git add src/server/tmux.mjs src/server/tmux.test.mjs src/server/index.mjs
git commit -m "refactor(server): extract tmux module from index.mjs"
```

### Task 2: Server — event fan-out (`events.mjs`)

**Files:**
- Create: `src/server/events.mjs`
- Test: `src/server/events.test.mjs`

- [ ] **Step 1: Write the failing test**

`src/server/events.test.mjs`:
```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBus } from "./events.mjs";

test("bus delivers published events to subscribers and stops after unsubscribe", () => {
  const bus = createBus();
  const got = [];
  const off = bus.subscribe((e) => got.push(e));
  bus.publish({ kind: "opencode", payload: { type: "x" } });
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, "opencode");
  off();
  bus.publish({ kind: "opencode", payload: { type: "y" } });
  assert.equal(got.length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/server/events.test.mjs`
Expected: FAIL — cannot find module `./events.mjs`.

- [ ] **Step 3: Create `src/server/events.mjs`**

```javascript
// In-process pub/sub + the GET /events SSE endpoint.
// Event envelope: { kind: "opencode"|"pty"|"status"|"screenshot", payload: any }

export function createBus() {
  const subs = new Set();
  return {
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    publish(evt) { for (const fn of subs) { try { fn(evt); } catch {} } },
  };
}

// Attach to a node:http response. One SSE stream; client demuxes by `kind`.
export function handleEventsRequest(bus, req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "access-control-allow-origin": "*",
  });
  res.write("retry: 2000\n\n");
  const off = bus.subscribe((evt) => {
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  });
  const ka = setInterval(() => res.write(": keep-alive\n\n"), 15000);
  req.on("close", () => { clearInterval(ka); off(); });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/server/events.test.mjs`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/server/events.mjs src/server/events.test.mjs
git commit -m "feat(server): in-process event bus + SSE endpoint"
```

### Task 3: Server — RPC router (`rpc.mjs`) with tmux channels wired

**Files:**
- Create: `src/server/rpc.mjs`
- Test: `src/server/rpc.test.mjs`

- [ ] **Step 1: Write the failing test**

`src/server/rpc.test.mjs`:
```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "./rpc.mjs";

test("dispatch routes a known channel to its handler with args", async () => {
  const handlers = { "echo:it": async (a, b) => ({ sum: a + b }) };
  const out = await dispatch(handlers, "echo:it", [2, 3]);
  assert.deepEqual(out, { sum: 5 });
});

test("dispatch throws a descriptive error for unknown channel", async () => {
  await assert.rejects(() => dispatch({}, "nope:nope", []),
    /unknown rpc channel: nope:nope/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/server/rpc.test.mjs`
Expected: FAIL — cannot find module `./rpc.mjs`.

- [ ] **Step 3: Create `src/server/rpc.mjs`**

```javascript
// Channel -> handler dispatch. Handlers are async (...args) => result.
// Mirrors Electron ipcMain.handle semantics.

export async function dispatch(handlers, channel, args) {
  const fn = handlers[channel];
  if (!fn) throw new Error(`unknown rpc channel: ${channel}`);
  return fn(...args);
}

// Build the full handler map. opencode/local handlers are added in later
// slices; tmux + a no-op set are wired here.
export function buildHandlers({ tmux }) {
  return {
    "tmux:list": () => tmux.listProjects(),
    "tmux:new-session": (i) => tmux.newSession(i),
    "tmux:new-window": (i) => tmux.newWindow(i),
    "tmux:rename-session": (i) => tmux.renameSession(i),
    "tmux:rename-window": (i) => tmux.renameWindow(i),
    "tmux:kill-session": (n) => tmux.killSession(n),
    "tmux:kill-window": (i) => tmux.killWindow(i),
    "tmux:select-window": (i) => tmux.selectWindow(i),
  };
}

// POST /rpc/<channel>  body: {"args":[...]}  ->  {"result":...} | {"error":"..."}
export async function handleRpcRequest(handlers, channel, req, res) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    try {
      const { args = [] } = body ? JSON.parse(body) : {};
      const result = await dispatch(handlers, channel, args);
      res.writeHead(200, { "content-type": "application/json",
        "access-control-allow-origin": "*" });
      res.end(JSON.stringify({ result: result ?? null }));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json",
        "access-control-allow-origin": "*" });
      res.end(JSON.stringify({ error: String(e?.message ?? e) }));
    }
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/server/rpc.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/rpc.mjs src/server/rpc.test.mjs
git commit -m "feat(server): rpc dispatch + tmux channel handlers"
```

### Task 4: Server — mount `/rpc` and `/events` in `index.mjs`

**Files:**
- Modify: `src/server/index.mjs` (the `createServer` handler, after the CORS block, before the existing `/api/projects` route)

- [ ] **Step 1: Add imports** (top of `index.mjs`, with other imports)

```javascript
import * as tmux from "./tmux.mjs";
import { createBus, handleEventsRequest } from "./events.mjs";
import { buildHandlers, handleRpcRequest } from "./rpc.mjs";
```

- [ ] **Step 2: Construct the bus + handlers** (module scope, after `const PUBLIC_DIR = ...`)

```javascript
const bus = createBus();
const rpcHandlers = buildHandlers({ tmux });
```

- [ ] **Step 3: Add routes** inside `createServer(async (req, res) => {`, immediately after the existing CORS / OPTIONS block and before the `/` route:

```javascript
  if (req.method === "GET" && path === "/events") {
    return handleEventsRequest(bus, req, res);
  }
  if (req.method === "POST" && path.startsWith("/rpc/")) {
    const channel = decodeURIComponent(path.slice("/rpc/".length));
    return handleRpcRequest(rpcHandlers, channel, req, res);
  }
```

- [ ] **Step 4: Manual smoke**

Run:
```bash
BUI_MOBILE_PORT=8799 node src/server/index.mjs & sleep 2
curl -s -XPOST localhost:8799/rpc/tmux:list -d '{"args":[]}' | head -c 80
curl -s -N -m 2 localhost:8799/events | head -c 40
kill %1
```
Expected: first curl → `{"result":[...]}`; second → `retry: 2000` then SSE comment lines.

- [ ] **Step 5: Commit**

```bash
git add src/server/index.mjs
git commit -m "feat(server): mount /rpc and /events on mobile server"
```

### Task 5: Renderer — browser `window.api` shim

**Files:**
- Create: `src/renderer/api/httpApi.ts`
- Modify: `src/renderer/main.tsx`

- [ ] **Step 1: Create `src/renderer/api/httpApi.ts`**

Implements every method in `src/preload/index.ts` against `/rpc` + `/events`. The request/response methods are generic via `rpc()`; only signatures/arg-packing differ. Use the `IPC` channel values from `src/shared/types.ts`.

```typescript
import { IPC, type OpencodeEvent, type PtyEvent, type WindowStatus } from "../../shared/types.js";
import type { Api } from "../../preload/index.js";

function serverBase(): string {
  const v = localStorage.getItem("bui_server");
  return (v ? v.replace(/\/+$/, "") : "http://157.90.224.92:8787");
}

async function rpc<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = await fetch(`${serverBase()}/rpc/${encodeURIComponent(channel)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ args }),
  });
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json.result as T;
}

// One SSE stream, demuxed by envelope.kind. Auto-reconnect is built into
// EventSource; on (re)open we notify resync listeners so the renderer
// refetches transcript/permissions/questions (mirrors desktop after sleep).
type Kind = "opencode" | "pty" | "status" | "screenshot";
const listeners: Record<Kind, Set<(p: unknown) => void>> = {
  opencode: new Set(), pty: new Set(), status: new Set(), screenshot: new Set(),
};
let es: EventSource | null = null;
function ensureStream() {
  if (es) return;
  es = new EventSource(`${serverBase()}/events`);
  es.onmessage = (m) => {
    try {
      const { kind, payload } = JSON.parse(m.data);
      const set = listeners[kind as Kind];
      if (set) for (const fn of set) fn(payload);
    } catch { /* keep-alive comment or malformed line */ }
  };
  es.onerror = () => { /* EventSource reconnects automatically */ };
}
function on<T>(kind: Kind, cb: (p: T) => void): () => void {
  ensureStream();
  const fn = cb as (p: unknown) => void;
  listeners[kind].add(fn);
  return () => listeners[kind].delete(fn);
}

export const httpApi: Api = {
  configGet: () => rpc(IPC.configGet),
  configUpdate: (patch) => rpc(IPC.configUpdate, patch),
  projectMetaUpsert: (meta) => rpc(IPC.projectMetaUpsert, meta),
  projectMetaDelete: (s) => rpc(IPC.projectMetaDelete, s),
  transportInfo: () => rpc(IPC.transportInfo),

  tmuxList: () => rpc(IPC.tmuxList),
  tmuxNewSession: (i) => rpc(IPC.tmuxNewSession, i),
  tmuxNewWindow: (i) => rpc(IPC.tmuxNewWindow, i),
  tmuxRenameSession: (i) => rpc(IPC.tmuxRenameSession, i),
  tmuxRenameWindow: (i) => rpc(IPC.tmuxRenameWindow, i),
  tmuxKillSession: (n) => rpc(IPC.tmuxKillSession, n),
  tmuxKillWindow: (i) => rpc(IPC.tmuxKillWindow, i),
  tmuxSelectWindow: (i) => rpc(IPC.tmuxSelectWindow, i),

  gitListWorktrees: (cwd) => rpc(IPC.gitListWorktrees, cwd),
  fsListDirs: (p) => rpc(IPC.fsListDirs, p),
  tmuxConfigStatus: () => rpc(IPC.tmuxConfigStatus),
  tmuxSetupConfig: () => rpc(IPC.tmuxSetupConfig),
  tmuxRestoreConfig: () => rpc(IPC.tmuxRestoreConfig),

  clipboardWriteText: (t) => rpc(IPC.clipboardWriteText, t),
  clipboardReadImage: () => rpc(IPC.clipboardReadImage), // server returns null on mobile
  onScreenshotDetected: (cb) => on("screenshot", cb),

  uploadFiles: (i) => rpc(IPC.uploadFiles, i),
  uploadBuffer: async ({ projectName, filename, buffer }) => {
    const res = await fetch(
      `${serverBase()}/api/upload?project=${encodeURIComponent(projectName)}`,
      { method: "POST", headers: { "x-filename": filename }, body: buffer });
    const json = await res.json();
    if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
    return json.path as string;
  },
  getPathForFile: () => "", // browser File has no OS path (matches Electron fallback)

  peekRemoteFile: (p) => rpc(IPC.peekRemoteFile, p),
  openExternal: (u) => rpc(IPC.openExternal, u),

  ptySpawn: (o) => rpc(IPC.ptySpawn, o),
  ptyWrite: (n, d) => rpc(IPC.ptyWrite, n, d),
  ptyResize: (n, c, r) => rpc(IPC.ptyResize, n, c, r),
  ptyKill: (n) => rpc(IPC.ptyKill, n),
  onPtyEvent: (cb) => on<PtyEvent>("pty", cb),
  onStatusEvent: (cb) => on<WindowStatus[]>("status", cb),

  opencodeMessages: (s) => rpc(IPC.opencodeMessages, s),
  onOpencodeEvent: (cb) => on<OpencodeEvent>("opencode", cb),
  opencodePrompt: (sessionId, text, model, attachments, mentions) =>
    rpc(IPC.opencodePrompt, { sessionId, text, model, attachments, mentions }),
  opencodeAbort: (s) => rpc(IPC.opencodeAbort, s),
  opencodePermissions: () => rpc(IPC.opencodePermissions),
  opencodePermissionReply: (requestId, reply) =>
    rpc(IPC.opencodePermissionReply, { requestId, reply }),
  opencodeQuestions: () => rpc(IPC.opencodeQuestions),
  opencodeQuestionReply: (requestId, answers) =>
    rpc(IPC.opencodeQuestionReply, { requestId, answers }),
  opencodeQuestionReject: (requestId) =>
    rpc(IPC.opencodeQuestionReject, { requestId }),
  opencodeModels: () => rpc(IPC.opencodeModels),
  opencodeDefaultModel: () => rpc(IPC.opencodeDefaultModel),
  opencodeVcsBranch: (d) => rpc(IPC.opencodeVcsBranch, d),
  opencodeListSessions: (d) => rpc(IPC.opencodeListSessions, d),
  opencodeForkSession: (i) => rpc(IPC.opencodeForkSession, i),
  opencodeCompactSession: (s) => rpc(IPC.opencodeCompactSession, s),
  opencodeDeleteSession: (i) => rpc(IPC.opencodeDeleteSession, i),
  opencodeCommands: () => rpc(IPC.opencodeCommands),
  opencodeAgents: () => rpc(IPC.opencodeAgents),
  opencodeFindFiles: (i) => rpc(IPC.opencodeFindFiles, i),
  opencodeRunCommand: (i) => rpc(IPC.opencodeRunCommand, i),
  opencodeClearSession: (i) => rpc(IPC.opencodeClearSession, i),
};
```

- [ ] **Step 2: Modify `src/renderer/main.tsx`** — install the shim only when Electron's preload did not.

Find where the app reads `window.api` (it currently assumes Electron). At the very top of `main.tsx`, before the React render and before any import that touches `window.api`, add:

```typescript
import { httpApi } from "./api/httpApi";

if (!(window as unknown as { api?: unknown }).api) {
  (window as unknown as { api: unknown }).api = httpApi;
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS. If `Api` type mismatches surface, fix the offending shim signature to match `src/preload/index.ts` exactly (do not change preload).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/api/httpApi.ts src/renderer/main.tsx
git commit -m "feat(renderer): browser window.api shim over HTTP/SSE"
```

### Task 6: Mobile build pipeline → `mobile/www/`

**Files:**
- Create: `electron.vite.config.mobile.ts`
- Modify: `package.json` (scripts), `mobile/sync-web.sh`

- [ ] **Step 1: Create `electron.vite.config.mobile.ts`**

A plain Vite (not electron-vite) build of just the renderer to `mobile/www/`:
```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  base: "./",
  plugins: [react()],
  resolve: { alias: { "@": resolve(__dirname, "src/renderer") } },
  build: {
    outDir: resolve(__dirname, "mobile/www"),
    emptyOutDir: true,
    rollupOptions: { input: resolve(__dirname, "src/renderer/index.html") },
  },
});
```

- [ ] **Step 2: Add `package.json` script** (in `"scripts"`)

```json
"build:mobile": "vite build --config electron.vite.config.mobile.ts",
```

- [ ] **Step 3: Update `mobile/sync-web.sh`**

The renderer build now produces `mobile/www/` directly. Read the current `sync-web.sh`; it copies xterm vendor files into the old vanilla `www/`. Since the renderer bundles xterm via npm (esbuild), the vendor copy is no longer needed for the React build. Replace the script body with:
```bash
#!/usr/bin/env bash
set -euo pipefail
# Build the React renderer straight into mobile/www/.
cd "$(dirname "$0")/.."
npm run build:mobile
```

- [ ] **Step 4: Build**

Run: `npm run build:mobile`
Expected: writes `mobile/www/index.html` + `mobile/www/assets/*`; exit 0.

- [ ] **Step 5: Commit**

```bash
git add electron.vite.config.mobile.ts package.json mobile/sync-web.sh
git commit -m "build(mobile): build React renderer into mobile/www"
```

### Task 7: SLICE 1 DEVICE CHECK — session list on the phone

- [ ] **Step 1: Deploy server to the box**

```bash
git push origin HEAD:main
ssh dev@157.90.224.92 'cd /home/dev/projects/better-ui && git fetch -q && git pull --ff-only origin main && grep -q handleRpcRequest src/server/index.mjs && echo OK'
```
Expected: `OK`.

- [ ] **Step 2: Restart bui-server on the box** (safe sequence — only kills its own PID, leaves work sessions)

```bash
ssh dev@157.90.224.92 'PID=$(ss -lntp 2>/dev/null | grep ":8787 " | grep -oE "pid=[0-9]+" | cut -d= -f2 | head -1); kill "$PID" 2>/dev/null; tmux kill-session -t bui-server 2>/dev/null; sleep 2; cd /home/dev/projects/better-ui && tmux new-session -d -s bui-server "BUI_MOBILE_HOST=0.0.0.0 BUI_MOBILE_PORT=8787 node src/server/index.mjs 2>&1 | tee -a /tmp/bui-server.log"; sleep 3; ss -lntp | grep 8787'
```
Expected: `LISTEN 0.0.0.0:8787`.

- [ ] **Step 3: Build + install APK**

```bash
cd mobile && ANDROID_HOME=/opt/homebrew/share/android-commandlinetools ANDROID_SDK_ROOT=/opt/homebrew/share/android-commandlinetools npm run apk
adb -s R83W80ERC6A install -r android/app/build/outputs/apk/debug/app-debug.apk
adb -s R83W80ERC6A shell pm clear com.antoinedc.bui
adb -s R83W80ERC6A shell monkey -p com.antoinedc.bui -c android.intent.category.LAUNCHER 1
```
Expected: `Success`, app launches.

- [ ] **Step 4: Verify via DevTools** (CDP probe like prior sessions)

```bash
PID=$(adb -s R83W80ERC6A shell pidof com.antoinedc.bui | tr -d '\r')
adb -s R83W80ERC6A forward tcp:9222 localabstract:webview_devtools_remote_$PID
# inspect: location.href == http://localhost/, the session list rendered (Sidebar shows tmux sessions),
# EventSource readyState == 1 (OPEN).
```
Expected: renderer loaded, session list populated from `/rpc/tmux:list`, SSE connected. **STOP — do not proceed past this checkpoint until the list renders on the device.**

- [ ] **Step 5: Commit a checkpoint note**

```bash
git commit --allow-empty -m "chore: slice 1 verified on device (session list loads)"
```

---

## Slice 2 — opencode proxy: messages render + prompt streams

### Task 8: Server — opencode proxy module

**Files:**
- Create: `src/server/opencode.mjs`
- Test: `src/server/opencode.test.mjs`

- [ ] **Step 1: Write the failing test** (pure URL/parse logic only — no live opencode)

`src/server/opencode.test.mjs`:
```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { apiUrl, parseSseFrame } from "./opencode.mjs";

test("apiUrl targets local opencode port 4096", () => {
  assert.equal(apiUrl("/session"), "http://127.0.0.1:4096/session");
});

test("parseSseFrame extracts JSON from data: lines", () => {
  const evt = parseSseFrame('data: {"type":"message.updated","x":1}');
  assert.equal(evt.type, "message.updated");
});

test("parseSseFrame returns null for comments/keepalive", () => {
  assert.equal(parseSseFrame(": keep-alive"), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/server/opencode.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/server/opencode.mjs`**

Port each function body from `src/main/opencode.ts` (read it). Drop the `config` arg and the SSH layer. `REMOTE_PORT = 4096`. `subscribeEvents` opens `fetch(apiUrl("/event"))`, reads the stream, and on each frame calls a provided `onEvent`. Skeleton (fill bodies from the TS source — same URLs/methods/JSON shapes):

```javascript
const REMOTE_PORT = 4096;
export function apiUrl(path) { return `http://127.0.0.1:${REMOTE_PORT}${path}`; }

export function parseSseFrame(line) {
  if (!line.startsWith("data:")) return null;
  try { return JSON.parse(line.slice(5).trim()); } catch { return null; }
}

async function j(path, init) {
  const res = await fetch(apiUrl(path), init);
  if (!res.ok) throw new Error(`opencode ${path} -> HTTP ${res.status}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

// --- ported from src/main/opencode.ts (URLs/bodies copied verbatim) ---
export const listMessages = (sessionId) =>
  j(`/session/${encodeURIComponent(sessionId)}/message`);
export const sendPrompt = ({ sessionId, text, model, attachments, mentions }) =>
  j(`/session/${encodeURIComponent(sessionId)}/prompt`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, model, attachments, mentions }), // match TS body exactly
  });
export const abortSession = (sessionId) =>
  j(`/session/${encodeURIComponent(sessionId)}/abort`, { method: "POST" });
export const listPermissions = () => j(`/permission`);
export const replyPermission = ({ requestId, reply }) =>
  j(`/permission/${encodeURIComponent(requestId)}/reply`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ reply }) });
export const listQuestions = () => j(`/question`);
export const replyQuestion = ({ requestId, answers }) =>
  j(`/question/${encodeURIComponent(requestId)}/reply`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers }) });
export const rejectQuestion = ({ requestId }) =>
  j(`/question/${encodeURIComponent(requestId)}/reject`, { method: "POST" });
export const getDefaultModel = () => j(`/global/default-model`).catch(() => null);
export const getVcsBranch = (directory) =>
  j(`/global/vcs-branch?directory=${encodeURIComponent(directory ?? "")}`).catch(() => null);
export const listModels = () => j(`/global/models`);
export const listCommands = () => j(`/global/commands`);
export const listAgents = () => j(`/global/agents`);
export const findFiles = ({ query, directory }) =>
  j(`/global/find-files?query=${encodeURIComponent(query)}&directory=${encodeURIComponent(directory)}`);
export const runCommand = (i) =>
  j(`/session/${encodeURIComponent(i.sessionId)}/command`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(i) });
export const listSessions = (directory) =>
  j(`/session?directory=${encodeURIComponent(directory ?? "")}`);
export const createSession = (directory) =>
  j(`/session?directory=${encodeURIComponent(directory)}`, { method: "POST" });
export const compactSession = (sessionId) =>
  j(`/session/${encodeURIComponent(sessionId)}/compact`, { method: "POST" });
export const deleteSessionRaw = (sessionId) =>
  j(`/session/${encodeURIComponent(sessionId)}`, { method: "DELETE" });

// Long-lived SSE; pushes parsed events into `onEvent`. Self-restarts.
export function subscribeEvents(onEvent) {
  let stopped = false;
  (async function loop() {
    while (!stopped) {
      try {
        const res = await fetch(apiUrl("/event"));
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (!stopped) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
            const evt = parseSseFrame(line);
            if (evt) onEvent(evt);
          }
        }
      } catch { /* fallthrough to reconnect */ }
      if (!stopped) await new Promise((r) => setTimeout(r, 1500));
    }
  })();
  return () => { stopped = true; };
}
```
> NOTE: Verify each URL/body against `src/main/opencode.ts` before relying on it. If a path or body differs in the TS source, the TS source wins — copy it exactly.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/server/opencode.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/opencode.mjs src/server/opencode.test.mjs
git commit -m "feat(server): opencode HTTP proxy (no SSH, local 4096)"
```

### Task 9: Server — wire opencode channels + forward SSE into the bus

**Files:**
- Modify: `src/server/rpc.mjs` (extend `buildHandlers`), `src/server/index.mjs` (start the opencode→bus pump)

- [ ] **Step 1: Extend `buildHandlers` in `rpc.mjs`**

Add an `oc` param and these channels (compose the fork/clear/delete handlers that also touch tmux, mirroring `src/main/index.ts` logic for `opencodeForkSession`/`opencodeClearSession`/`opencodeDeleteSession`):

```javascript
export function buildHandlers({ tmux, oc }) {
  return {
    // ...existing tmux channels...
    "opencode:messages": (s) => oc.listMessages(s),
    "opencode:prompt": (i) => oc.sendPrompt(i),
    "opencode:abort": (s) => oc.abortSession(s),
    "opencode:permissions": () => oc.listPermissions(),
    "opencode:permission-reply": (i) => oc.replyPermission(i),
    "opencode:questions": () => oc.listQuestions(),
    "opencode:question-reply": (i) => oc.replyQuestion(i),
    "opencode:question-reject": (i) => oc.rejectQuestion(i),
    "opencode:models": () => oc.listModels(),
    "opencode:default-model": () => oc.getDefaultModel(),
    "opencode:vcs-branch": (d) => oc.getVcsBranch(d),
    "opencode:list-sessions": (d) => oc.listSessions(d),
    "opencode:compact-session": (s) => oc.compactSession(s),
    "opencode:commands": () => oc.listCommands(),
    "opencode:agents": () => oc.listAgents(),
    "opencode:find-files": (i) => oc.findFiles(i),
    "opencode:run-command": (i) => oc.runCommand(i),
    "opencode:fork-session": async (i) => {
      const created = await oc.createSession(i.cwd);
      const newSessionId = created.id ?? created.sessionID;        // match TS field
      const projects = await tmux.newWindow({
        sessionName: i.sessionName, windowName: i.windowName, cwd: i.cwd });
      return { newSessionId, projects };
    },
    "opencode:clear-session": async (i) => {
      const created = await oc.createSession(i.cwd);
      const newSessionId = created.id ?? created.sessionID;
      const projects = await tmux.listProjects();
      return { newSessionId, projects };
    },
    "opencode:delete-session": async (i) => {
      await oc.deleteSessionRaw(i.sessionId);
      return tmux.killWindow({ sessionName: i.sessionName, windowIndex: i.windowIndex });
    },
  };
}
```
> NOTE: Confirm the new-session id field name and fork/clear/delete side-effects against `src/main/index.ts` (handlers near `IPC.opencodeForkSession`). The TS source is authoritative; adjust the field/sequence to match.

- [ ] **Step 2: Wire it in `index.mjs`** — add import, pass `oc`, start the pump

```javascript
import * as oc from "./opencode.mjs";
// ...
const rpcHandlers = buildHandlers({ tmux, oc });
oc.subscribeEvents((evt) => bus.publish({ kind: "opencode", payload: evt }));
```

- [ ] **Step 3: Manual smoke against the box's opencode**

Run (on the box, or via ssh):
```bash
ssh dev@157.90.224.92 'curl -s -XPOST localhost:8787/rpc/opencode:list-sessions -d "{\"args\":[]}" | head -c 120'
```
Expected: `{"result":[...]}` (a JSON session list from opencode), not `{"error":...}`.

- [ ] **Step 4: Commit**

```bash
git add src/server/rpc.mjs src/server/index.mjs
git commit -m "feat(server): wire opencode channels + SSE->bus pump"
```

### Task 10: SLICE 2 DEVICE CHECK — chat streams on the phone

- [ ] **Step 1: Deploy + restart** (same commands as Task 7 Steps 1–3; `git push`, pull on box, restart bui-server, rebuild+install APK, `pm clear`, launch).

- [ ] **Step 2: Device walkthrough**

On the phone: open a chat session → transcript renders (via `opencode:messages`) → type a prompt → assistant response **streams live** (SSE deltas) → branch indicator + token/cost appear. Verify via CDP probe if needed (`onOpencodeEvent` firing, message DOM growing).
Expected: live streaming chat. **STOP — do not proceed until streaming works on the device.**

- [ ] **Step 3: Checkpoint commit**

```bash
git commit --allow-empty -m "chore: slice 2 verified on device (chat streams)"
```

---

## Slice 3 — permissions + questions (QuestionCard, permission reply)

### Task 11: SLICE 3 DEVICE CHECK — interactive flows

Permissions/questions channels were already wired in Task 9. This slice verifies them end-to-end (no new server code expected; if a gap is found, fix in `opencode.mjs` and re-run).

- [ ] **Step 1:** Ensure latest is deployed (push, pull on box, restart, rebuild+install APK, `pm clear`, launch — same as Task 7 Steps 1–3).

- [ ] **Step 2: Device walkthrough**

On the phone: send a prompt that triggers a tool needing approval (e.g. "create a file X") → permission prompt appears → tap approve → tool proceeds. Send a prompt that makes Claude ask a structured question → **QuestionCard renders** → answer it → flow continues. Verify `opencode:permissions` / `opencode:questions` poll + the SSE `permission.replied`/`question.asked` events drive the UI.
Expected: both interactive flows work. **STOP if either fails** — fix `replyPermission`/`replyQuestion` body shape against `src/main/opencode.ts`, redeploy, retry.

- [ ] **Step 3: Checkpoint commit**

```bash
git commit --allow-empty -m "chore: slice 3 verified on device (permissions + questions)"
```

---

## Slice 4 — terminal via renderer Terminal.tsx

### Task 12: Server — pty channels over rpc + pty output into the bus

**Files:**
- Modify: `src/server/rpc.mjs`, `src/server/index.mjs`

The mobile server already has a working `/pty` WebSocket. `Terminal.tsx` uses `window.api.ptySpawn/ptyWrite/ptyResize/ptyKill` + `onPtyEvent`, not a raw WS. Bridge those channels to the existing PTY machinery.

- [ ] **Step 1: Inspect the existing `/pty` WS handler in `index.mjs`** (the `WebSocketServer` block). Identify the function that spawns the node-pty for a session/window and where its `data`/`exit` are emitted.

- [ ] **Step 2: Add a pty registry module** `src/server/pty.mjs` keyed by `projectName`, exposing `spawn(opts, onEvent)`, `write(name,data)`, `resize(name,cols,rows)`, `kill(name)`, reusing the same `node-pty` spawn the WS path uses (extract the shared spawn into `pty.mjs`; the WS handler calls into it too — no protocol change).

- [ ] **Step 3: Wire channels in `buildHandlers`** (add `pty` param):
```javascript
"pty:spawn": (o) => pty.spawn(o, (e) => bus.publish({ kind: "pty", payload: e })),
"pty:write": (n, d) => pty.write(n, d),
"pty:resize": (n, c, r) => pty.resize(n, c, r),
"pty:kill": (n) => pty.kill(n),
```
(Pass `bus` into `buildHandlers` or curry the publish — match the pattern used for `oc`.)

- [ ] **Step 4: Manual smoke**

```bash
ssh dev@157.90.224.92 'curl -s -XPOST localhost:8787/rpc/pty:spawn -d "{\"args\":[{\"projectName\":\"UI\",\"cols\":80,\"rows\":24}]}"'
```
Expected: `{"result":null}` (no error).

- [ ] **Step 5: Commit**

```bash
git add src/server/pty.mjs src/server/rpc.mjs src/server/index.mjs
git commit -m "feat(server): pty channels over rpc + pty events into bus"
```

### Task 13: SLICE 4 DEVICE CHECK — terminal renders

- [ ] **Step 1:** Deploy + restart + rebuild/install APK + `pm clear` + launch (Task 7 Steps 1–3).

- [ ] **Step 2: Device walkthrough**

On the phone: open a non-chat tmux session → renderer's `Terminal.tsx` renders → live terminal output appears → typing reaches the shell.
Expected: working terminal in the React app. **STOP if blank.**

- [ ] **Step 3: Checkpoint commit**

```bash
git commit --allow-empty -m "chore: slice 4 verified on device (terminal)"
```

---

## Slice 5 — session management + git/fs (full parity)

### Task 14: Server — local module (git/fs/config/clipboard/external)

**Files:**
- Create: `src/server/local.mjs`
- Test: `src/server/local.test.mjs`
- Modify: `src/server/rpc.mjs`, `src/server/index.mjs`

- [ ] **Step 1: Write the failing test**

`src/server/local.test.mjs`:
```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWorktrees } from "./local.mjs";

test("parseWorktrees parses `git worktree list --porcelain`", () => {
  const out = parseWorktrees(
    "worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\n" +
    "worktree /repo/wt\nHEAD def456\ndetached\n");
  assert.equal(out.length, 2);
  assert.equal(out[0].path, "/repo");
  assert.equal(out[0].branch, "main");
  assert.equal(out[1].detached, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/server/local.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/server/local.mjs`** — port logic from `src/main/*` (gitListWorktrees, fsListDirs), stub the rest:

```javascript
import { run } from "./tmux.mjs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export function parseWorktrees(porcelain) {
  const out = [];
  let cur = null;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur) out.push(cur);
      cur = { path: line.slice(9), head: "", branch: null, bare: false, detached: false };
    } else if (line.startsWith("HEAD ")) cur.head = line.slice(5);
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace("refs/heads/", "");
    else if (line === "detached") cur.detached = true;
    else if (line === "bare") cur.bare = true;
  }
  if (cur) out.push(cur);
  return out;
}

export async function gitListWorktrees(cwd) {
  const { stdout } = await run("git", ["-C", cwd, "worktree", "list", "--porcelain"])
    .catch(() => ({ stdout: "" }));
  return parseWorktrees(stdout);
}

export async function fsListDirs(partial) {
  const base = partial && partial.startsWith("/") ? partial : join(homedir(), partial ?? "");
  const dir = partial?.endsWith("/") ? base : join(base, "..");
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory()).map((e) => join(dir, e.name));
}

// Phone has no desktop clipboard / shell / config store. Stubs that match
// the contract without erroring (documented in the design spec).
export const clipboardWriteText = async () => {};
export const clipboardReadImage = async () => null;
export const openExternal = async () => {};
export const peekRemoteFile = async () => {};
export const configGet = async () => ({ host: "", projects: [] });
export const configUpdate = async (patch) => ({ host: "", projects: [], ...patch });
export const projectMetaUpsert = async () => ({ host: "", projects: [] });
export const projectMetaDelete = async () => ({ host: "", projects: [] });
export const transportInfo = async () => ({
  effective: "ssh", preference: "auto", moshLocal: false, moshRemote: false });
export const tmuxConfigStatus = async () => ({ buiManaged: false, backupExists: false });
export const tmuxSetupConfig = async () => ({ buiManaged: false, backupExists: false });
export const tmuxRestoreConfig = async () => ({ buiManaged: false, backupExists: false });
export const uploadFiles = async () => [];
```
> NOTE: If `ChatPanel.tsx`/`Sidebar.tsx` depend on real `configGet` shape (e.g. project metadata persistence), check `src/main/config.ts` and port the real file-backed implementation instead of the stub. Stubs are acceptable only where the renderer tolerates empty data (verify on device in Task 15).

- [ ] **Step 4: Wire channels** in `buildHandlers` (add `local` param): map `config:*`, `project:meta:*`, `transport:info`, `git:list-worktrees`, `fs:list-dirs`, `clipboard:*`, `shell:open-external`, `peek:remote-file`, `tmux:config-status`, `tmux:setup-config`, `tmux:restore-config`, `upload:files` to the corresponding `local.*` functions. Pass `local` from `index.mjs`.

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test src/server/local.test.mjs`
Expected: PASS (1 test).

- [ ] **Step 6: Full test + typecheck**

Run: `node --test src/server/*.test.mjs && npm run typecheck && npm test`
Expected: all node:test pass; typecheck clean; vitest (`chatUtils.test.ts`) still passes.

- [ ] **Step 7: Commit**

```bash
git add src/server/local.mjs src/server/local.test.mjs src/server/rpc.mjs src/server/index.mjs
git commit -m "feat(server): local module (git/fs/config) + remaining channels"
```

### Task 15: SLICE 5 DEVICE CHECK — full parity walkthrough

- [ ] **Step 1:** Deploy + restart + rebuild/install APK + `pm clear` + launch (Task 7 Steps 1–3).

- [ ] **Step 2: Full success-criteria walkthrough on the phone** (from the spec):

Open a session → send a prompt → streaming response → answer a QuestionCard → answer a permission → see live todos + branch + token/cost + compaction → abort works → terminal view works → create/rename/kill a session from the app → git worktree picker + fs dir listing function.
Expected: all pass. Note any gap, fix in the relevant `src/server/*.mjs`, redeploy, re-verify. **This is the definition of done.**

- [ ] **Step 3: Desktop regression check**

Run: `npm run dev` (Electron). Open the desktop app; confirm chat still works (proves the `window.api` shim path did not affect Electron — `main.tsx` only installs the shim when `window.api` is absent).
Expected: desktop chat unaffected.

- [ ] **Step 4: Final commit + spec follow-up note**

```bash
git commit --allow-empty -m "chore: slice 5 verified — mobile chat full parity on device"
```
Then append to `docs/superpowers/specs/2026-05-16-mobile-chat-port-design.md` under "Out of Scope": a line confirming auth/open-port is still open and is the next work item.

---

## Self-Review

**Spec coverage:**
- Architecture (Approach A, shim + server, proxy not SSH) → Slices 1–2, Tasks 5/8/9. ✓
- All 38 req/res + 4 events + getPathForFile → Task 5 (shim, full enumeration) + handlers across Tasks 3/9/12/14. ✓
- Desktop untouched → Task 5 Step 2 (conditional install) + Task 15 Step 3 (regression check). ✓
- Renderer unchanged → no task modifies `*.tsx`; only `main.tsx` gets a 3-line guard (entrypoint, not a component). ✓
- Mobile build → mobile/www/ → Task 6. ✓
- Per-slice device verification → Tasks 7/10/11/13/15. ✓
- Reconnection/keep-alive → Task 2 (keep-alive), Task 5 (EventSource auto-reconnect). ✓
- Error handling (reject → renderer try/catch) → Task 3 (`{error}` + non-2xx), Task 5 (`rpc()` throws). ✓
- Clipboard/binary edge cases → Task 5 (`getPathForFile`/`uploadBuffer`), Task 14 (stubs). ✓
- Out-of-scope auth documented → Task 15 Step 4. ✓

**Placeholder scan:** No "TBD/TODO/handle edge cases" left as instructions. The three `> NOTE:` callouts point the engineer to the authoritative TS source for exact wire shapes that cannot be known without reading that file — they are verification instructions with a concrete source, not placeholders, and each has working default code.

**Type consistency:** `serverBase()`/`rpc()`/`on()`/`Kind` consistent across Task 5. Channel strings always reference `IPC.*` (single source). `parseSessions`/`listProjects`/`newWindow`/`killWindow` names consistent between Tasks 1, 9, 12. Bus envelope `{kind,payload}` consistent across Tasks 2, 5, 9, 12. Handler-map builder is `buildHandlers({...})` everywhere (Tasks 3, 9, 12, 14) — each task adds a param, never renames.

Plan is internally consistent and covers the spec.
