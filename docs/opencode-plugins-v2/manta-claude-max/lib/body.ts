// Request-body rewrites (M5/M6) and header signing (M3), as PURE functions.
// Ported from opencode-claude-auth@2.2.1 `transforms.js`/`signing.js`, with two
// deliberate changes: tool-name un-prefixing uses the exact name map recorded
// from the request (the leading-case flip alone is not invertible), and nothing
// here reads the network or the disk.

import { createHash, randomUUID } from "node:crypto";
import { cliVersion, getModelOverride, modelBetas, userAgent } from "./config.ts";

export const SYSTEM_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
export const TOOL_PREFIX = "mcp_";
const BILLING_SALT = "59cf53e54c78";
const BILLING_PREFIX = "x-anthropic-billing-header";
export const TOOL_RESULT_PLACEHOLDER = "Tool result unavailable (removed during context compaction).";

// ---------------------------------------------------------------------------
// Billing header signature (R6: undocumented, the likeliest thing to change)
// ---------------------------------------------------------------------------

export function firstUserText(messages: any[]): string {
  const u = Array.isArray(messages) ? messages.find((m) => m?.role === "user") : undefined;
  if (!u) return "";
  if (typeof u.content === "string") return u.content;
  if (Array.isArray(u.content)) {
    const t = u.content.find((b: any) => b?.type === "text");
    if (t?.text) return t.text;
  }
  return "";
}

export const computeCch = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 5);

export function computeVersionSuffix(text: string, version: string): string {
  const sampled = [4, 7, 20].map((i) => (i < text.length ? text[i] : "0")).join("");
  return createHash("sha256").update(`${BILLING_SALT}${sampled}${version}`).digest("hex").slice(0, 3);
}

export function buildBillingHeaderValue(messages: any[], version: string, entrypoint: string): string {
  const text = firstUserText(messages);
  return `${BILLING_PREFIX}: cc_version=${version}.${computeVersionSuffix(text, version)}; cc_entrypoint=${entrypoint}; cch=${computeCch(text)};`;
}

// ---------------------------------------------------------------------------
// Tool-name prefix (OAuth billing validation rejects lowercase tool names)
// ---------------------------------------------------------------------------

export const prefixName = (name: string): string => `${TOOL_PREFIX}${name.charAt(0).toUpperCase()}${name.slice(1)}`;
const unprefixName = (name: string): string => `${name.charAt(0).toLowerCase()}${name.slice(1)}`;

/**
 * Reverse prefixName on text. `nameMap` (prefixed → original, recorded from the
 * request's own tool list) wins; unknown names fall back to the case flip.
 */
export function stripToolPrefix(text: string, nameMap?: ReadonlyMap<string, string>): string {
  return text.replace(/"name"\s*:\s*"(mcp_[^"]+)"/g, (_m, full: string) => {
    const original = nameMap?.get(full) ?? unprefixName(full.slice(TOOL_PREFIX.length));
    return `"name":${JSON.stringify(original)}`;
  });
}

// ---------------------------------------------------------------------------
// tool_use <-> tool_result adjacency repair (placeholder strategy, V1 default)
// ---------------------------------------------------------------------------

const toolUseIdOf = (b: any): string | undefined => (b?.type === "tool_use" && typeof b.id === "string" ? b.id : undefined);
const toolResultIdOf = (b: any): string | undefined =>
  b?.type === "tool_result" && typeof b.tool_use_id === "string" ? b.tool_use_id : undefined;

/**
 * Guarantee every tool_use has its tool_result in the very next message and
 * every tool_result follows its call, without ever deleting a block from an
 * assistant turn (so thinking blocks stay byte-identical).
 */
export function synthesizeMissingToolResults(messages: any[]): any[] {
  const pass1: any[] = [];
  messages.forEach((message, index) => {
    if (!Array.isArray(message?.content)) {
      pass1.push(message);
      return;
    }
    const filtered = message.content.filter((block: any) => {
      const id = toolResultIdOf(block);
      if (id === undefined) return true;
      const prev = messages[index - 1];
      return Array.isArray(prev?.content) && prev.content.some((b: any) => toolUseIdOf(b) === id);
    });
    if (filtered.length === 0 && message.content.length > 0) return;
    pass1.push(filtered.length === message.content.length ? message : { ...message, content: filtered });
  });

  const out: any[] = [];
  for (let i = 0; i < pass1.length; i++) {
    const message = pass1[i];
    out.push(message);
    if (!Array.isArray(message?.content)) continue;
    const useIds = message.content.map(toolUseIdOf).filter((id: string | undefined): id is string => id !== undefined);
    if (useIds.length === 0) continue;
    const next = pass1[i + 1];
    const present = new Set<string>(
      Array.isArray(next?.content)
        ? next.content.map(toolResultIdOf).filter((id: string | undefined): id is string => id !== undefined)
        : [],
    );
    const missing = useIds.filter((id: string) => !present.has(id));
    if (missing.length === 0) continue;
    const synthetic = missing.map((id: string) => ({
      type: "tool_result",
      tool_use_id: id,
      content: TOOL_RESULT_PLACEHOLDER,
      is_error: true,
    }));
    if (next?.role === "user" && Array.isArray(next.content)) {
      out.push({ ...next, content: [...synthetic, ...next.content] });
      i++;
    } else if (next?.role === "user" && typeof next.content === "string") {
      const text = next.content;
      out.push({ ...next, content: text.length > 0 ? [...synthetic, { type: "text", text }] : synthetic });
      i++;
    } else {
      out.push({ role: "user", content: synthetic });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// transformBody
// ---------------------------------------------------------------------------

export interface BodyResult {
  /** The rewritten JSON (or the input untouched when it was not a JSON object). */
  body: string;
  /** prefixed → original, for every tool name rewritten. */
  nameMap: Map<string, string>;
  /** The request's `model`, when present. */
  model: string | null;
  rewritten: boolean;
}

export function transformBody(
  raw: string,
  env: Record<string, string | undefined> = process.env,
): BodyResult {
  const nameMap = new Map<string, string>();
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { body: raw, nameMap, model: null, rewritten: false };
    }
    const model = typeof parsed.model === "string" ? parsed.model : null;
    const version = cliVersion(env);
    const entrypoint = env.CLAUDE_CODE_ENTRYPOINT || "sdk-cli";

    // system as an array; accept the string form too
    let system: any[] = Array.isArray(parsed.system)
      ? parsed.system
      : typeof parsed.system === "string" && parsed.system
        ? [{ type: "text", text: parsed.system }]
        : [];
    system = system.filter(
      (e) => !(e?.type === "text" && typeof e.text === "string" && e.text.startsWith(BILLING_PREFIX)),
    );
    // billing header is system[0], without cache_control
    system.unshift({ type: "text", text: buildBillingHeaderValue(parsed.messages ?? [], version, entrypoint) });

    // identity prefix must be its OWN system entry (OpenCode joins system text)
    const split: any[] = [];
    for (const entry of system) {
      if (
        entry?.type === "text" &&
        typeof entry.text === "string" &&
        entry.text.startsWith(SYSTEM_IDENTITY) &&
        entry.text.length > SYSTEM_IDENTITY.length
      ) {
        const rest = entry.text.slice(SYSTEM_IDENTITY.length).replace(/^\n+/, "");
        const { text: _t, ...props } = entry;
        const { cache_control: _cc, ...identityProps } = props;
        split.push({ ...identityProps, text: SYSTEM_IDENTITY });
        if (rest.length > 0) split.push({ ...props, text: rest });
      } else {
        split.push(entry);
      }
    }
    system = split;

    // third-party system prompts trip Anthropic's OAuth validation: keep only the
    // billing header + identity in system[], move the rest into the first user turn
    const kept: any[] = [];
    const moved: string[] = [];
    for (const entry of system) {
      const txt = typeof entry === "string" ? entry : (entry?.text ?? "");
      if (txt.startsWith(BILLING_PREFIX) || txt.startsWith(SYSTEM_IDENTITY)) kept.push(entry);
      else if (txt.length > 0) moved.push(txt);
    }
    parsed.system = system;
    if (moved.length > 0 && Array.isArray(parsed.messages)) {
      const firstUser = parsed.messages.find((m: any) => m?.role === "user");
      if (firstUser) {
        parsed.system = kept;
        const prefix = moved.join("\n\n");
        if (typeof firstUser.content === "string") firstUser.content = `${prefix}\n\n${firstUser.content}`;
        else if (Array.isArray(firstUser.content)) firstUser.content.unshift({ type: "text", text: prefix });
      }
    }

    // models that reject `effort` (haiku)
    if (getModelOverride(model ?? "")?.disableEffort) {
      if (parsed.output_config) {
        delete parsed.output_config.effort;
        if (Object.keys(parsed.output_config).length === 0) delete parsed.output_config;
      }
      if (parsed.thinking && "effort" in parsed.thinking) {
        delete parsed.thinking.effort;
        if (Object.keys(parsed.thinking).length === 0) delete parsed.thinking;
      }
    }

    // PascalCase mcp_ prefix on tool definitions AND on replayed tool_use blocks
    const note = (name: string) => {
      const full = prefixName(name);
      if (!nameMap.has(full)) nameMap.set(full, name);
      return full;
    };
    if (Array.isArray(parsed.tools)) {
      parsed.tools = parsed.tools.map((t: any) => ({ ...t, name: t?.name ? note(t.name) : t?.name }));
    }
    if (Array.isArray(parsed.messages)) {
      parsed.messages = parsed.messages.map((m: any) =>
        Array.isArray(m?.content)
          ? {
              ...m,
              content: m.content.map((b: any) =>
                b?.type === "tool_use" && typeof b.name === "string" ? { ...b, name: note(b.name) } : b,
              ),
            }
          : m,
      );
      parsed.messages = synthesizeMissingToolResults(parsed.messages);
    }
    return { body: JSON.stringify(parsed), nameMap, model, rewritten: true };
  } catch {
    return { body: raw, nameMap, model: null, rewritten: false };
  }
}

// ---------------------------------------------------------------------------
// Headers (M3 + M4)
// ---------------------------------------------------------------------------

function stainlessHeaders(): Record<string, string> {
  return {
    "x-stainless-arch": process.arch === "arm64" ? "arm64" : process.arch,
    "x-stainless-lang": "js",
    "x-stainless-os": process.platform === "darwin" ? "MacOS" : process.platform,
    "x-stainless-package-version": "0.81.0",
    "x-stainless-retry-count": "0",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": process.version,
    "x-stainless-timeout": "600",
  };
}

/** Stable per-process id, like Claude Code's X-Claude-Code-Session-Id. */
export const PROC_SESSION_ID = randomUUID();

/** `?beta=true` on /v1/messages, as Claude Code sends. */
export function withBetaParam(rawUrl: string): string {
  const u = new URL(rawUrl);
  if (u.pathname === "/v1/messages" && !u.searchParams.has("beta")) u.searchParams.set("beta", "true");
  return u.toString();
}

/** A copy of `incoming` carrying the Claude Code identity and `accessToken`. */
export function claudeHeaders(
  incoming: Headers,
  accessToken: string,
  modelId: string,
  excludedBetas?: ReadonlySet<string>,
  env: Record<string, string | undefined> = process.env,
): Headers {
  const headers = new Headers(incoming);
  const merged = [
    ...new Set([
      ...modelBetas(modelId, excludedBetas, env),
      ...(incoming.get("anthropic-beta") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ]),
  ];
  headers.set("authorization", `Bearer ${accessToken}`);
  headers.set("anthropic-version", "2023-06-01");
  headers.set("anthropic-beta", merged.join(","));
  headers.set("anthropic-dangerous-direct-browser-access", "true");
  headers.set("x-app", "cli");
  headers.set("user-agent", userAgent(env));
  headers.set("x-client-request-id", randomUUID());
  headers.set("X-Claude-Code-Session-Id", PROC_SESSION_ID);
  for (const [k, v] of Object.entries(stainlessHeaders())) if (!headers.has(k)) headers.set(k, v);
  headers.delete("x-api-key");
  return headers;
}
