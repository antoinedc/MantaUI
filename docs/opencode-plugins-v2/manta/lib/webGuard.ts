// The built-in web tools' guard (research layer spec docs/superpowers/specs/2026-11-28-research-layer.md §6.3a).
//
// OpenCode's own `websearch` (a query) and `webfetch` (an address) send text to outside services. Before either runs, the
// plugin's blocking `tool` hook `execute.before` asks manta-server's ONE outside-query check
// (POST /api/research/outside-check, the same function `research_search` / `research_fetch` call in-process) whether the
// text carries private material; a refusal is THROWN, which OpenCode turns into a failed tool call before the tool runs, so
// nothing goes out. It fails closed: an unreachable server, a timeout, an unreadable answer or a refusal all stop the call.
// Every session kind is covered (a lead's chat, an agent's task or conversation, a plain session): the hook is not
// agent-aware. Not covered, by design: network calls made through the shell or an MCP server.

import { authHeaders, serverUrl } from "./server.ts";

export const WEB_GUARD_TIMEOUT_MS = 5000;
export const WEB_TOOLS = ["websearch", "webfetch"] as const;
export const CHECK_UNAVAILABLE = "Couldn't check this query for private material; try again";

type FetchFn = (input: string, init?: Record<string, unknown>) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export interface WebGuardDeps {
  fetch: FetchFn;
  base(): string;
  headers(body?: unknown): Record<string, string>;
  timeoutMs?: number;
}

export interface ToolBeforeEvent {
  tool: string;
  sessionID?: string;
  input?: unknown;
}

/** What the check is shown of a call: `{ query }` for a search, `{ url }` for a fetch; null when the call isn't ours to guard. */
export function guardedInput(event: ToolBeforeEvent): { tool: "websearch" | "webfetch"; input: { query: string } | { url: string } } | null {
  if (event?.tool !== "websearch" && event?.tool !== "webfetch") return null;
  const raw = event.input && typeof event.input === "object" ? (event.input as Record<string, unknown>) : {};
  // a malformed input is still sent as an empty string, so the server (not this plugin) decides what an empty query is
  if (event.tool === "websearch") return { tool: "websearch", input: { query: typeof raw.query === "string" ? raw.query : "" } };
  return { tool: "webfetch", input: { url: typeof raw.url === "string" ? raw.url : "" } };
}

export function createWebGuard(deps: WebGuardDeps) {
  const timeoutMs = deps.timeoutMs ?? WEB_GUARD_TIMEOUT_MS;

  /** Resolves when the call may run; THROWS the refusal sentence when it may not (and when the check can't be made). */
  async function beforeExecute(event: ToolBeforeEvent): Promise<void> {
    const guarded = guardedInput(event);
    if (!guarded) return;
    const body = { sessionID: typeof event.sessionID === "string" ? event.sessionID : "", tool: guarded.tool, input: guarded.input };
    let answer: any;
    try {
      const res = await deps.fetch(`${deps.base()}/api/research/outside-check`, {
        method: "POST",
        headers: deps.headers(body),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`manta-server ${res.status}`);
      answer = await res.json();
    } catch {
      throw new Error(CHECK_UNAVAILABLE);
    }
    if (answer?.ok === true) return;
    throw new Error(typeof answer?.error === "string" && answer.error ? answer.error : CHECK_UNAVAILABLE);
  }

  return { beforeExecute };
}

/**
 * For a tool editor's `update(name, …)`: turn the built-in tool into one that refuses every call. Used ONLY when the guard hook could not
 * be registered — an unguarded `websearch` / `webfetch` must not stay available (fail closed).
 */
export function refuseWebTool(tool: { execute: (...args: any[]) => Promise<unknown> }): void {
  tool.execute = async () => {
    throw new Error(CHECK_UNAVAILABLE);
  };
}

/** The production guard: this box's manta-server, with the box token. */
export function createDefaultWebGuard() {
  return createWebGuard({ fetch: (url, init) => fetch(url, init as any) as any, base: serverUrl, headers: authHeaders });
}
