# Provider Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Providers section to manta Settings (desktop + mobile) to add/remove OpenAI-compatible endpoints, refresh model discovery from each endpoint's `/v1/models`, and toggle which discovered models opencode.jsonc advertises.

**Architecture:** opencode.jsonc on the box stays the single source of truth. New `src/main/providers.ts` does discovery (curl on the box) and the read-merge-write of the `provider` key in opencode.jsonc, reusing the tested `buildRemoteConfigWriteCmd` heredoc writer. Three new IPC channels (`getProviders`, `setProviders`, `discoverModels`) plus a reuse of an existing restart path. UI is a `ProvidersCard` rendered in Settings.tsx with a thin mobile mirror. The model picker is unchanged — it keeps reading opencode `/provider`.

**Tech Stack:** TypeScript, Electron main/preload/renderer, React, vitest, opencode `@ai-sdk/openai-compatible` providers, SSH-over-ControlMaster.

---

## File Structure

- **Create** `src/main/providers.ts` — pure helpers (parse `/v1/models`, merge/remove provider blocks into a parsed config object) + thin SSH-driven functions (discover, get, set). Pure helpers are exported for unit testing.
- **Create** `src/main/providers.test.ts` — unit tests for the pure helpers.
- **Modify** `src/shared/types.ts` — add `ProviderEndpoint`, `DiscoverResult` types and three IPC channel constants.
- **Modify** `src/main/index.ts` — register three `ipcMain.handle` handlers wiring providers.ts to IPC; add an `opencodeRestart` handler.
- **Modify** `src/main/pty.ts` — export `shellQuote` (currently file-private) so providers.ts can quote the API key.
- **Modify** `src/preload/index.ts` — expose `opencodeGetProviders`, `opencodeSetProviders`, `opencodeDiscoverModels`, `opencodeRestart` on `window.api`.
- **Modify** `src/renderer/api/httpApi.ts` — map the new calls to RPC (mobile path).
- **Modify** `src/server/rpc.mjs` — handle the new RPC method names (mobile in-process path delegates to the same main-side functions is not possible on the server, so these return a "desktop only" stub for v1 — see Task 9).
- **Create** `src/renderer/ProvidersCard.tsx` — the shared card component (used by both Settings surfaces).
- **Modify** `src/renderer/Settings.tsx` — render `<ProvidersCard />`.
- **Modify** `src/renderer/mobile/MobileSettings.tsx` — render `<ProvidersCard />`.

---

## Task 1: Provider types and IPC channel constants

**Files:**
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Add the types**

Add near the other opencode-related types in `src/shared/types.ts`:

```ts
export type ProviderEndpoint = {
  id: string;            // opencode provider id, e.g. "voska"
  name: string;          // display name, e.g. "VoskaAI"
  baseURL: string;       // e.g. "https://api.voska.org/v1"
  hasApiKey: boolean;    // true if an apiKey is set; the value never leaves main
  enabledModels: string[]; // model ids present in this provider's opencode `models` map
};

export type DiscoverResult =
  | { ok: true; models: { id: string }[] }
  | { ok: false; error: "unreachable" | "unauthorized" | "bad_response"; detail?: string };

// Input the renderer sends to set/replace a single provider. apiKey is optional:
// omitted/undefined means "keep the existing key"; empty string means "no key".
export type ProviderInput = {
  id: string;
  name: string;
  baseURL: string;
  apiKey?: string;
  enabledModels: string[];
};
```

- [ ] **Step 2: Add the IPC channel constants**

In the `IPC` object in `src/shared/types.ts`, next to `opencodeModels: "opencode:models",` add:

```ts
  opencodeGetProviders: "opencode:get-providers",
  opencodeSetProviders: "opencode:set-providers",
  opencodeDiscoverModels: "opencode:discover-models",
  opencodeRestart: "opencode:restart",
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (no new errors from these additions).

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(providers): types + IPC channels for provider management"
```

---

## Task 2: Pure helper — parse `/v1/models` response

**Files:**
- Create: `src/main/providers.ts`
- Test: `src/main/providers.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/providers.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseModelsResponse } from "./providers.js";

describe("parseModelsResponse", () => {
  it("extracts ids from a valid OpenAI /v1/models body", () => {
    const body = JSON.stringify({
      object: "list",
      data: [
        { id: "qwen3.6-27b", object: "model" },
        { id: "default", object: "model" },
        { id: "ornith", object: "model" },
      ],
    });
    expect(parseModelsResponse(body)).toEqual({
      ok: true,
      models: [{ id: "qwen3.6-27b" }, { id: "default" }, { id: "ornith" }],
    });
  });

  it("returns ok:true with empty list when data is empty", () => {
    expect(parseModelsResponse(JSON.stringify({ data: [] }))).toEqual({
      ok: true,
      models: [],
    });
  });

  it("returns bad_response for non-JSON", () => {
    const r = parseModelsResponse("<html>502 Bad Gateway</html>");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("bad_response");
  });

  it("returns unauthorized when body looks like an auth error", () => {
    const body = JSON.stringify({ error: { message: "Invalid API key", code: "invalid_api_key" } });
    const r = parseModelsResponse(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("unauthorized");
  });

  it("returns bad_response when JSON lacks a data array", () => {
    const r = parseModelsResponse(JSON.stringify({ object: "list" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("bad_response");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/providers.test.ts`
Expected: FAIL — cannot find module `./providers.js` / `parseModelsResponse is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/main/providers.ts`:

```ts
// Provider management: discover models from an OpenAI-compatible endpoint and
// read/merge/write provider blocks in the box's opencode.jsonc. opencode.jsonc
// stays the single source of truth; the model picker keeps reading opencode's
// /provider endpoint (see opencode.ts:listModels) — this file only edits config.
import type { AppConfig } from "../shared/types.js";
import type { DiscoverResult, ProviderEndpoint, ProviderInput } from "../shared/types.js";

// Parse the body of GET <baseURL>/models (OpenAI-compatible shape: { data: [{ id }] }).
// Pure — no I/O — so it is unit-testable against fixture strings.
export function parseModelsResponse(body: string): DiscoverResult {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, error: "bad_response", detail: body.slice(0, 200) };
  }
  const obj = json as Record<string, unknown>;
  // Auth errors come back as 200/4xx JSON with an `error` object on many gateways.
  if (obj && typeof obj === "object" && "error" in obj) {
    const errObj = obj.error as Record<string, unknown> | undefined;
    const msg = errObj && typeof errObj.message === "string" ? errObj.message : "";
    const code = errObj && typeof errObj.code === "string" ? errObj.code : "";
    if (/api key|unauthor|invalid_api_key|401/i.test(`${msg} ${code}`)) {
      return { ok: false, error: "unauthorized", detail: msg || code };
    }
    return { ok: false, error: "bad_response", detail: msg || code };
  }
  const data = obj?.data;
  if (!Array.isArray(data)) {
    return { ok: false, error: "bad_response", detail: "no data array" };
  }
  const models = data
    .map((m) => (m && typeof m === "object" ? String((m as Record<string, unknown>).id ?? "") : ""))
    .filter(Boolean)
    .map((id) => ({ id }));
  return { ok: true, models };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/providers.test.ts`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Commit**

```bash
git add src/main/providers.ts src/main/providers.test.ts
git commit -m "feat(providers): parseModelsResponse with unit tests"
```

---

## Task 3: Pure helpers — merge and remove provider blocks

**Files:**
- Modify: `src/main/providers.ts`
- Test: `src/main/providers.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/main/providers.test.ts`:

```ts
import { upsertProviderBlock, removeProviderBlock, readProviderEndpoints } from "./providers.js";

describe("upsertProviderBlock", () => {
  const base = {
    $schema: "https://opencode.ai/config.json",
    model: "anthropic/claude-opus-4-8",
    plugin: ["opencode-claude-auth-bui@1.5.4-bui.1"],
    skills: { urls: [] },
  };

  it("adds a provider block without touching other keys", () => {
    const out = upsertProviderBlock(base, {
      id: "voska",
      name: "VoskaAI",
      baseURL: "https://api.voska.org/v1",
      apiKey: "sk-test",
      enabledModels: ["qwen3.6-27b", "ornith"],
    });
    expect(out.model).toBe("anthropic/claude-opus-4-8");
    expect(out.plugin).toEqual(["opencode-claude-auth-bui@1.5.4-bui.1"]);
    expect(out.skills).toEqual({ urls: [] });
    const p = (out.provider as Record<string, any>).voska;
    expect(p.npm).toBe("@ai-sdk/openai-compatible");
    expect(p.name).toBe("VoskaAI");
    expect(p.options).toEqual({ baseURL: "https://api.voska.org/v1", apiKey: "sk-test" });
    expect(Object.keys(p.models)).toEqual(["qwen3.6-27b", "ornith"]);
    expect(p.models["ornith"]).toEqual({ id: "ornith", name: "ornith" });
  });

  it("preserves the existing apiKey when input apiKey is undefined", () => {
    const withProv = upsertProviderBlock(base, {
      id: "voska", name: "VoskaAI", baseURL: "https://api.voska.org/v1",
      apiKey: "sk-old", enabledModels: ["qwen3.6-27b"],
    });
    const out = upsertProviderBlock(withProv, {
      id: "voska", name: "VoskaAI", baseURL: "https://api.voska.org/v1",
      enabledModels: ["qwen3.6-27b", "default"], // no apiKey field
    });
    const p = (out.provider as Record<string, any>).voska;
    expect(p.options.apiKey).toBe("sk-old");
    expect(Object.keys(p.models)).toEqual(["qwen3.6-27b", "default"]);
  });
});

describe("removeProviderBlock", () => {
  it("drops only the named provider", () => {
    const cfg = {
      model: "anthropic/x",
      provider: {
        voska: { npm: "@ai-sdk/openai-compatible", models: {} },
        other: { npm: "@ai-sdk/openai-compatible", models: {} },
      },
    };
    const out = removeProviderBlock(cfg, "voska");
    expect((out.provider as Record<string, unknown>).voska).toBeUndefined();
    expect((out.provider as Record<string, unknown>).other).toBeDefined();
    expect(out.model).toBe("anthropic/x");
  });
});

describe("readProviderEndpoints", () => {
  it("returns endpoint metadata with hasApiKey and enabledModels, never the key", () => {
    const cfg = {
      provider: {
        voska: {
          npm: "@ai-sdk/openai-compatible",
          name: "VoskaAI",
          options: { baseURL: "https://api.voska.org/v1", apiKey: "sk-secret" },
          models: { "qwen3.6-27b": { id: "qwen3.6-27b" }, ornith: { id: "ornith" } },
        },
      },
    };
    const eps = readProviderEndpoints(cfg);
    expect(eps).toEqual([
      {
        id: "voska",
        name: "VoskaAI",
        baseURL: "https://api.voska.org/v1",
        hasApiKey: true,
        enabledModels: ["qwen3.6-27b", "ornith"],
      },
    ]);
    // Ensure the key is never present anywhere in the serialized output.
    expect(JSON.stringify(eps)).not.toContain("sk-secret");
  });

  it("returns [] when there is no provider key", () => {
    expect(readProviderEndpoints({ model: "anthropic/x" })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/providers.test.ts`
Expected: FAIL — `upsertProviderBlock`/`removeProviderBlock`/`readProviderEndpoints` not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/main/providers.ts`:

```ts
type Cfg = Record<string, unknown>;
type ProviderBlock = {
  npm: string;
  name?: string;
  options?: { baseURL?: string; apiKey?: string };
  models?: Record<string, { id: string; name?: string }>;
};

function getProviderMap(cfg: Cfg): Record<string, ProviderBlock> {
  const p = cfg.provider;
  return p && typeof p === "object" ? ({ ...(p as Record<string, ProviderBlock>) }) : {};
}

// Insert or replace a single provider block. Only the `provider` key is touched;
// every other key in `cfg` is preserved by spread. If `input.apiKey` is
// undefined, the existing key (if any) is kept — so the renderer never has to
// round-trip the secret.
export function upsertProviderBlock(cfg: Cfg, input: ProviderInput): Cfg {
  const providers = getProviderMap(cfg);
  const prev = providers[input.id];
  const apiKey =
    input.apiKey !== undefined ? input.apiKey : prev?.options?.apiKey ?? "";
  const models: Record<string, { id: string; name: string }> = {};
  for (const id of input.enabledModels) models[id] = { id, name: id };
  providers[input.id] = {
    npm: "@ai-sdk/openai-compatible",
    name: input.name,
    options: { baseURL: input.baseURL, apiKey },
    models,
  };
  return { ...cfg, provider: providers };
}

export function removeProviderBlock(cfg: Cfg, id: string): Cfg {
  const providers = getProviderMap(cfg);
  delete providers[id];
  return { ...cfg, provider: providers };
}

// Project the config's provider map down to renderer-safe metadata. Never
// includes the apiKey value — only whether one is present.
export function readProviderEndpoints(cfg: Cfg): ProviderEndpoint[] {
  const providers = getProviderMap(cfg);
  return Object.entries(providers).map(([id, block]) => ({
    id,
    name: typeof block.name === "string" ? block.name : id,
    baseURL: block.options?.baseURL ?? "",
    hasApiKey: Boolean(block.options?.apiKey),
    enabledModels: Object.keys(block.models ?? {}),
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/providers.test.ts`
Expected: PASS (all cases including the no-key-leak assertion).

- [ ] **Step 5: Commit**

```bash
git add src/main/providers.ts src/main/providers.test.ts
git commit -m "feat(providers): config merge/remove/read helpers (provider key only)"
```

---

## Task 4: Export `shellQuote` from pty.ts

**Files:**
- Modify: `src/main/pty.ts:105-107`

- [ ] **Step 1: Make `shellQuote` exported**

In `src/main/pty.ts`, change:

```ts
function shellQuote(s: string): string {
```
to:
```ts
export function shellQuote(s: string): string {
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main/pty.ts
git commit -m "refactor(pty): export shellQuote for reuse"
```

---

## Task 5: SSH-driven discover/get/set functions in providers.ts

**Files:**
- Modify: `src/main/providers.ts`

These functions do I/O (SSH to the box). They are thin — the parsing/merging logic they call is already tested in Tasks 2-3. We do not unit-test the SSH round-trip itself (no box in CI); the pure helpers carry the coverage.

- [ ] **Step 1: Add the imports and discover function**

At the top of `src/main/providers.ts`, add to the existing imports:

```ts
import { runSshOnce, shellQuote } from "./pty.js";
```

Append these functions:

```ts
const OPENCODE_JSONC = "~/.config/opencode/opencode.jsonc";

// Query an OpenAI-compatible endpoint's /v1/models FROM THE BOX (not the Mac):
// the box is where opencode reaches these endpoints, so discovery must reflect
// the box's network view (honors the "remote box is backend-only" invariant).
export async function discoverModels(
  config: AppConfig,
  baseURL: string,
  apiKey: string,
): Promise<DiscoverResult> {
  // Empty key from the renderer means "use the key already stored on the box"
  // (Refresh on an existing endpoint never re-sends the secret). Re-read it from
  // opencode.jsonc by matching the baseURL. New endpoints persist their key via
  // Add before Refresh, so this same lookup finds it.
  let key = apiKey;
  if (!key) {
    try {
      const cfg = await readRemoteConfig(config);
      const providers = getProviderMap(cfg);
      const match = Object.values(providers).find(
        (b) => b.options?.baseURL?.replace(/\/$/, "") === baseURL.replace(/\/$/, ""),
      );
      key = match?.options?.apiKey ?? "";
    } catch {
      /* fall through with empty key — endpoint may legitimately need none */
    }
  }
  const url = `${baseURL.replace(/\/$/, "")}/models`;
  const cmd =
    `curl -s --max-time 20 -H ${shellQuote(`Authorization: Bearer ${key}`)} ${shellQuote(url)}`;
  try {
    const { stdout } = await runSshOnce(config, cmd, { timeoutMs: 30000 });
    if (!stdout.trim()) return { ok: false, error: "unreachable", detail: "empty response" };
    return parseModelsResponse(stdout);
  } catch (e) {
    return { ok: false, error: "unreachable", detail: e instanceof Error ? e.message : String(e) };
  }
}

// Read opencode.jsonc from the box and parse it (strip // comments, like the
// skill-URLs path in index.ts). Returns {} if the file is absent. THROWS if the
// file exists but is unparseable — callers must NOT overwrite an unparseable
// config (that was the 2026-05-18 corruption failure mode).
async function readRemoteConfig(config: AppConfig): Promise<Cfg> {
  const { stdout } = await runSshOnce(
    config,
    `cat ${OPENCODE_JSONC} 2>/dev/null || echo '{}'`,
  );
  const stripped = stdout.replace(/\/\/[^\n]*/g, "");
  return JSON.parse(stripped) as Cfg; // intentional throw on malformed JSON
}

export async function getProviderEndpoints(config: AppConfig): Promise<ProviderEndpoint[]> {
  const cfg = await readRemoteConfig(config);
  return readProviderEndpoints(cfg);
}

// Apply a set of provider mutations and write opencode.jsonc back using the
// TESTED heredoc writer (no string interpolation of JSON — see remoteConfigWrite.ts).
// Does NOT restart opencode; the caller decides (prompt-before-restart).
export async function setProviders(
  config: AppConfig,
  ops: { upsert?: ProviderInput[]; remove?: string[] },
): Promise<{ ok: boolean; error?: string }> {
  let cfg: Cfg;
  try {
    cfg = await readRemoteConfig(config);
  } catch {
    return { ok: false, error: "opencode.jsonc on the box is unparseable — refusing to overwrite it. Fix it manually first." };
  }
  for (const id of ops.remove ?? []) cfg = removeProviderBlock(cfg, id);
  for (const input of ops.upsert ?? []) cfg = upsertProviderBlock(cfg, input);
  const content = JSON.stringify(cfg, null, 2);
  try {
    const { buildRemoteConfigWriteCmd } = await import("./remoteConfigWrite.js");
    await runSshOnce(config, buildRemoteConfigWriteCmd(content, OPENCODE_JSONC));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Re-run the providers unit tests (ensure no regressions)**

Run: `npx vitest run src/main/providers.test.ts`
Expected: PASS (the pure helpers still pass; new I/O functions are untested by design).

- [ ] **Step 4: Commit**

```bash
git add src/main/providers.ts
git commit -m "feat(providers): SSH-driven discover/get/set against box opencode.jsonc"
```

---

## Task 6: Restart helper in opencode.ts

**Files:**
- Modify: `src/main/opencode.ts`

opencode reloads opencode.jsonc only on (re)start. We expose a restart that tears down the `manta-opencode` tmux session; the existing ensure path respawns it on next use.

- [ ] **Step 1: Add the restart function**

In `src/main/opencode.ts`, after `ensureForward`/the tmux helpers (search for `BUI_OPENCODE_TMUX_SESSION`), add:

```ts
// Restart opencode so it reloads opencode.jsonc (config changes — e.g. provider
// edits — only take effect on (re)start). We kill the manta-opencode tmux session;
// the next ensureForward()/ensureOpencode path respawns a fresh server. Active
// sessions are briefly interrupted — callers MUST gate this behind explicit user
// consent (prompt-before-restart).
export async function restartOpencode(config: AppConfig): Promise<void> {
  await runSshOnce(
    config,
    `tmux kill-session -t ${BUI_OPENCODE_TMUX_SESSION} 2>/dev/null || true`,
  );
  await ensureOpencode(config);
}
```

If the local respawn function is named differently than `ensureOpencode`, use the actual exported function that this file already calls to (re)spawn the server (grep for `tmux new-session -d -s ${BUI_OPENCODE_TMUX_SESSION}` and call its enclosing function). Confirm `runSshOnce` is already imported in this file; if not, add `import { runSshOnce } from "./pty.js";`.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main/opencode.ts
git commit -m "feat(opencode): restartOpencode to reload config on demand"
```

---

## Task 7: Wire IPC handlers in main

**Files:**
- Modify: `src/main/index.ts:1356` (next to the existing `opencodeModels` handler)

- [ ] **Step 1: Add imports**

Near the top of `src/main/index.ts` (next to `listModels as opencodeListModels`), add:

```ts
import {
  getProviderEndpoints as opencodeGetProviders,
  setProviders as opencodeSetProviders,
  discoverModels as opencodeDiscoverModels,
} from "./providers.js";
import { restartOpencode } from "./opencode.js";
```

(If `restartOpencode` should be added to the existing `from "./opencode.js"` import group, add it there instead of a second import line.)

- [ ] **Step 2: Register the handlers**

After `ipcMain.handle(IPC.opencodeModels, () => opencodeListModels(config));`, add:

```ts
  ipcMain.handle(IPC.opencodeGetProviders, () => opencodeGetProviders(config));
  ipcMain.handle(
    IPC.opencodeSetProviders,
    (_e, ops: { upsert?: ProviderInput[]; remove?: string[] }) =>
      opencodeSetProviders(config, ops),
  );
  ipcMain.handle(
    IPC.opencodeDiscoverModels,
    (_e, baseURL: string, apiKey: string) =>
      opencodeDiscoverModels(config, baseURL, apiKey),
  );
  ipcMain.handle(IPC.opencodeRestart, () => restartOpencode(config));
```

Ensure `ProviderInput` is imported from `../shared/types.js` in index.ts (add to the existing type import if absent).

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(providers): register get/set/discover/restart IPC handlers"
```

---

## Task 8: Expose on preload `window.api`

**Files:**
- Modify: `src/preload/index.ts:257` (next to `opencodeModels`)

- [ ] **Step 1: Add the bindings**

After the `opencodeModels` binding, add:

```ts
  opencodeGetProviders: (): Promise<ProviderEndpoint[]> =>
    ipcRenderer.invoke(IPC.opencodeGetProviders),
  opencodeSetProviders: (
    ops: { upsert?: ProviderInput[]; remove?: string[] },
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.opencodeSetProviders, ops),
  opencodeDiscoverModels: (baseURL: string, apiKey: string): Promise<DiscoverResult> =>
    ipcRenderer.invoke(IPC.opencodeDiscoverModels, baseURL, apiKey),
  opencodeRestart: (): Promise<void> => ipcRenderer.invoke(IPC.opencodeRestart),
```

Add `ProviderEndpoint`, `DiscoverResult`, `ProviderInput` to the type imports at the top of the file (from `../shared/types`).

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/preload/index.ts
git commit -m "feat(providers): expose provider IPC on window.api"
```

---

## Task 9: Mobile RPC mapping (desktop-only stub for v1)

**Files:**
- Modify: `src/renderer/api/httpApi.ts:474` (next to `opencodeModels`)
- Modify: `src/server/rpc.mjs:223` (next to `"opencode:models"`)

The mobile/web server (`src/server/`) does not have the main-side providers.ts (it talks to opencode directly, not over SSH from the Mac). For v1, provider editing is a desktop-only action; the mobile picker still SHOWS whatever opencode serves. So the server returns a clear "desktop only" result rather than silently failing.

- [ ] **Step 1: Add httpApi mappings**

In `src/renderer/api/httpApi.ts`, after `opencodeModels: () => rpc(IPC.opencodeModels),` add:

```ts
  opencodeGetProviders: () => rpc(IPC.opencodeGetProviders),
  opencodeSetProviders: (ops) => rpc(IPC.opencodeSetProviders, ops),
  opencodeDiscoverModels: (baseURL, apiKey) => rpc(IPC.opencodeDiscoverModels, baseURL, apiKey),
  opencodeRestart: () => rpc(IPC.opencodeRestart),
```

- [ ] **Step 2: Add server rpc handlers (desktop-only stub)**

In `src/server/rpc.mjs`, after `"opencode:models": () => oc.listModels(),` add:

```js
    "opencode:get-providers": () => [],
    "opencode:set-providers": () => ({
      ok: false,
      error: "Provider editing is available on the desktop app only.",
    }),
    "opencode:discover-models": () => ({
      ok: false,
      error: "unreachable",
      detail: "Provider discovery is available on the desktop app only.",
    }),
    "opencode:restart": () => undefined,
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/api/httpApi.ts src/server/rpc.mjs
git commit -m "feat(providers): mobile RPC mapping (desktop-only stub for editing)"
```

---

## Task 10: ProvidersCard component

**Files:**
- Create: `src/renderer/ProvidersCard.tsx`

This is the shared UI. It owns its own data (loads endpoints on mount), discovery state, and the restart prompt. It calls `window.api.*` which both Settings surfaces provide.

- [ ] **Step 1: Create the component**

Create `src/renderer/ProvidersCard.tsx`:

```tsx
import { useEffect, useState, useCallback } from "react";
import type { ProviderEndpoint, DiscoverResult } from "../shared/types";

type Draft = { id: string; name: string; baseURL: string; apiKey: string };
const EMPTY_DRAFT: Draft = { id: "", name: "", baseURL: "", apiKey: "" };

export function ProvidersCard() {
  const [endpoints, setEndpoints] = useState<ProviderEndpoint[] | null>(null);
  const [discovered, setDiscovered] = useState<Record<string, { id: string }[]>>({});
  const [discoverError, setDiscoverError] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null); // endpoint id being mutated
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [restartNeeded, setRestartNeeded] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);

  const load = useCallback(() => {
    window.api.opencodeGetProviders().then(setEndpoints).catch(() => setEndpoints([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  const refresh = useCallback(async (ep: ProviderEndpoint) => {
    setBusy(ep.id);
    setDiscoverError((e) => ({ ...e, [ep.id]: "" }));
    // apiKey "" => main keeps the stored key (undefined means keep; but discover
    // needs a concrete key, so we pass "" and main uses the stored one via re-read).
    const r: DiscoverResult = await window.api.opencodeDiscoverModels(ep.baseURL, "");
    if (r.ok) {
      setDiscovered((d) => ({ ...d, [ep.id]: r.models }));
    } else {
      setDiscoverError((e) => ({ ...e, [ep.id]: `${r.error}${r.detail ? `: ${r.detail}` : ""}` }));
    }
    setBusy(null);
  }, []);

  const toggleModel = useCallback(async (ep: ProviderEndpoint, modelId: string) => {
    const enabled = ep.enabledModels.includes(modelId)
      ? ep.enabledModels.filter((m) => m !== modelId)
      : [...ep.enabledModels, modelId];
    setBusy(ep.id);
    const res = await window.api.opencodeSetProviders({
      upsert: [{ id: ep.id, name: ep.name, baseURL: ep.baseURL, enabledModels: enabled }],
    });
    setBusy(null);
    if (!res.ok) { setGlobalError(res.error ?? "Save failed"); return; }
    setRestartNeeded(true);
    load();
  }, [load]);

  const addEndpoint = useCallback(async () => {
    const d = draft;
    if (!d.id.trim() || !d.baseURL.trim()) return;
    setBusy(d.id);
    const res = await window.api.opencodeSetProviders({
      upsert: [{
        id: d.id.trim(), name: d.name.trim() || d.id.trim(),
        baseURL: d.baseURL.trim(), apiKey: d.apiKey, enabledModels: [],
      }],
    });
    setBusy(null);
    if (!res.ok) { setGlobalError(res.error ?? "Add failed"); return; }
    setDraft(EMPTY_DRAFT);
    setRestartNeeded(true);
    load();
  }, [draft, load]);

  const removeEndpoint = useCallback(async (ep: ProviderEndpoint) => {
    setBusy(ep.id);
    const res = await window.api.opencodeSetProviders({ remove: [ep.id] });
    setBusy(null);
    if (!res.ok) { setGlobalError(res.error ?? "Remove failed"); return; }
    setRestartNeeded(true);
    load();
  }, [load]);

  const applyRestart = useCallback(async () => {
    await window.api.opencodeRestart();
    setRestartNeeded(false);
  }, []);

  return (
    <div className="space-y-2 pt-2 border-t border-border">
      <label className="block text-xs uppercase tracking-wider text-text-muted">
        Providers
      </label>
      <div className="text-xs text-text-faint">
        OpenAI-compatible endpoints opencode can serve. Refresh to discover models,
        then enable the ones you want in the model picker.
      </div>

      {globalError && <div className="text-xs text-red-400">{globalError}</div>}

      {(endpoints ?? []).map((ep) => (
        <div key={ep.id} className="border border-border rounded p-2 space-y-1">
          <div className="flex items-center gap-2">
            <div className="flex-1 min-w-0">
              <div className="text-sm text-text truncate">{ep.name}</div>
              <code className="text-[10px] text-text-faint truncate block">{ep.baseURL}</code>
            </div>
            <button
              onClick={() => refresh(ep)}
              disabled={busy === ep.id}
              className="px-2 py-1 text-xs bg-bg-soft border border-border rounded text-text-muted hover:text-text disabled:opacity-40"
            >
              {busy === ep.id ? "…" : "Refresh"}
            </button>
            <button
              onClick={() => removeEndpoint(ep)}
              disabled={busy === ep.id}
              className="text-xs text-text-faint hover:text-text px-1"
              title="Remove endpoint"
            >
              ✕
            </button>
          </div>
          {discoverError[ep.id] && (
            <div className="text-[10px] text-red-400">{discoverError[ep.id]}</div>
          )}
          {(discovered[ep.id] ?? ep.enabledModels.map((id) => ({ id }))).map((m) => (
            <label key={m.id} className="flex items-center gap-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={ep.enabledModels.includes(m.id)}
                onChange={() => toggleModel(ep, m.id)}
                disabled={busy === ep.id}
              />
              <span className="text-text-muted">{m.id}</span>
            </label>
          ))}
        </div>
      ))}

      <div className="border border-dashed border-border rounded p-2 space-y-1">
        <div className="text-[10px] uppercase tracking-wider text-text-faint">Add endpoint</div>
        <input className="w-full bg-bg-soft border border-border px-2 py-1 text-xs rounded"
          placeholder="id (e.g. voska)" value={draft.id}
          onChange={(e) => setDraft({ ...draft, id: e.target.value })} />
        <input className="w-full bg-bg-soft border border-border px-2 py-1 text-xs rounded"
          placeholder="name (e.g. VoskaAI)" value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        <input className="w-full bg-bg-soft border border-border px-2 py-1 text-xs rounded"
          placeholder="baseURL (https://api.voska.org/v1)" value={draft.baseURL}
          onChange={(e) => setDraft({ ...draft, baseURL: e.target.value })} />
        <input type="password" className="w-full bg-bg-soft border border-border px-2 py-1 text-xs rounded"
          placeholder="API key" value={draft.apiKey}
          onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} />
        <button
          onClick={addEndpoint}
          disabled={!draft.id.trim() || !draft.baseURL.trim()}
          className="px-3 py-1 text-xs bg-bg-soft border border-border rounded text-text-muted hover:text-text disabled:opacity-40"
        >
          Add
        </button>
      </div>

      {restartNeeded && (
        <div className="flex items-center gap-2 text-xs bg-bg-soft border border-border rounded p-2">
          <span className="flex-1 text-text-muted">
            Restart opencode now to apply? (interrupts active sessions)
          </span>
          <button onClick={applyRestart}
            className="px-2 py-1 bg-accent/20 border border-accent rounded text-text">
            Apply Now
          </button>
          <button onClick={() => setRestartNeeded(false)}
            className="px-2 py-1 border border-border rounded text-text-muted">
            Apply Later
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS. (If `window.api` is typed via a global interface, you may need to add the four new method signatures to that interface — locate the `Window`/`api` type declaration that lists `opencodeModels` and add `opencodeGetProviders`, `opencodeSetProviders`, `opencodeDiscoverModels`, `opencodeRestart` with the same signatures as in preload. Grep for `opencodeModels:` in `.d.ts`/types files.)

- [ ] **Step 3: Commit**

```bash
git add src/renderer/ProvidersCard.tsx
git commit -m "feat(providers): ProvidersCard UI (discover, toggle, add/remove, restart prompt)"
```

---

## Task 11: Render ProvidersCard in both Settings surfaces

**Files:**
- Modify: `src/renderer/Settings.tsx` (after the Skill registries block, around line 609)
- Modify: `src/renderer/mobile/MobileSettings.tsx` (after its model section)

- [ ] **Step 1: Import and render in desktop Settings**

In `src/renderer/Settings.tsx`, add the import at the top:

```ts
import { ProvidersCard } from "./ProvidersCard";
```

After the closing `</div>` of the Skill registries `<div className="space-y-2 pt-2 border-t border-border">` block (the one ending around line 609), add:

```tsx
        <ProvidersCard />
```

- [ ] **Step 2: Import and render in MobileSettings**

In `src/renderer/mobile/MobileSettings.tsx`, add the import:

```ts
import { ProvidersCard } from "../ProvidersCard";
```

After the model-picker section in that file, add `<ProvidersCard />` in the same place relative to other cards.

- [ ] **Step 3: Typecheck + full test run**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS (all existing tests plus the new providers.test.ts).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/Settings.tsx src/renderer/mobile/MobileSettings.tsx
git commit -m "feat(providers): render ProvidersCard in desktop + mobile Settings"
```

---

## Task 12: Manual end-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Build and launch manta locally**

Run the app per the project's run path (e.g. `npm run dev`). The remote box (alphaclaw) must be the configured host — provider edits write to ITS opencode.jsonc.

- [ ] **Step 2: Verify discovery**

Open Settings → Providers. The `voska` endpoint should be listed (it's already in opencode.jsonc). Click **Refresh**. Expected: three checkboxes appear — `qwen3.6-27b` (checked), `default`, `ornith`.

- [ ] **Step 3: Enable a new model + restart**

Check `ornith`. Expected: the restart prompt appears. Click **Apply Now**. Wait ~5s.

- [ ] **Step 4: Confirm it reached opencode**

Run: `ssh dev@157.90.224.92 "curl -s http://127.0.0.1:4096/provider | python3 -c \"import sys,json; d=json.load(sys.stdin); print([m for p in d['all'] if p.get('id')=='voska' for m in p['models']])\""`
Expected: the list now includes `ornith` (and `qwen3.6-27b`).

- [ ] **Step 5: Confirm config integrity (no corruption, plugin preserved)**

Run: `ssh dev@157.90.224.92 "python3 -c \"import json,re; s=open('/home/dev/.config/opencode/opencode.jsonc').read(); s=re.sub(r'//[^\n]*','',s); c=json.loads(s); print('plugin:', c.get('plugin')); print('model:', c.get('model')); print('voska models:', list(c['provider']['voska']['models']))\""`
Expected: `plugin` still lists `opencode-claude-auth-bui...`, `model` unchanged, voska models include `ornith`. Valid JSON parse = no corruption.

- [ ] **Step 6: Add + remove a throwaway endpoint**

In the UI, add a dummy endpoint (id `testrm`, any baseURL), confirm it appears, then remove it and Apply. Re-run Step 5's parse check to confirm `testrm` is gone and the file still parses.

---

## Self-Review Notes

- **Spec coverage:** add endpoint (Task 10/addEndpoint), remove (removeEndpoint), refresh discovery (Task 2 + 5 + refresh), toggle enabled models (Task 3 + toggleModel), prompt-before-restart (Task 6 + restart prompt UI), desktop + mobile (Task 11), opencode.jsonc as source of truth (Task 5 read-merge-write, no second store), corruption mitigation (reuse buildRemoteConfigWriteCmd + abort on unparseable), plugin preservation (Task 3 spread test + Task 12 step 5). All covered.
- **Refresh-without-re-entering-key:** handled in Task 5 — `discoverModels` re-reads the stored `options.apiKey` from opencode.jsonc (matched by baseURL) when the renderer passes an empty key. New endpoints persist their key via Add before Refresh, so the same lookup finds it. The renderer never round-trips the secret.
- **Comment loss:** writing back drops hand-written comments in opencode.jsonc — accepted per spec, consistent with the skill-URLs feature.
