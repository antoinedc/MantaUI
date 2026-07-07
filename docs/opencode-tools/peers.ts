// bui-native `peers` tools — global opencode custom tools.
//
// Install on the opencode host (the Linux box that runs bui-server + opencode):
//   mkdir -p ~/.config/opencode/tools
//   cp <repo>/docs/opencode-tools/peers.ts ~/.config/opencode/tools/peers.ts
// then `systemctl --user restart opencode-serve` so opencode re-scans tools/.
//
// These tools let THIS session see what OTHER sessions in the same workspace
// (tmux session) are doing AND send them messages — useful when you notice
// files / git status changing and suspect another agent is working alongside
// you, or when you want to hand off / coordinate with a peer agent. They are
// THIN registrars: each hits bui-server (127.0.0.1:8787/api/peers, same box, no
// SSH hop), which resolves the tmux workspace and queries each peer's opencode
// transcript or tmux pane, or injects a message into a peer's chat session.
// See src/server/peers.mjs.
//
// Note: any session may RECEIVE a message from a peer. It arrives as a normal
// user turn prefixed with `[Message from peer agent session "<name>" …]` so you
// can tell it came from another agent (not your user) and reply with
// peers_message if appropriate.

import { tool } from "@opencode-ai/plugin";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BUI_SERVER = process.env.BUI_SERVER_URL || "http://127.0.0.1:8787";

// bui-server enforces `Authorization: Bearer <box_token>` on every /api route
// (M1 auth gate — src/server/auth.mjs). These tools run on the SAME box as the
// same user as bui-server, so they read the token straight from the server's
// own auth store (~/.bui-mobile/auth.json, 0600). Re-read on every call (one
// tiny local file) so a token rotation never requires an opencode-serve
// restart. BUI_BOX_TOKEN env overrides for tests/dev.
function boxToken(): string | null {
  const fromEnv = process.env.BUI_BOX_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    const raw = readFileSync(join(homedir(), ".bui-mobile", "auth.json"), "utf-8");
    const tok = JSON.parse(raw)?.box_token;
    return typeof tok === "string" && /^[0-9a-f]{32}$/.test(tok) ? tok : null;
  } catch {
    return null; // no store yet (auth disabled / first run) → send no header
  }
}

function authHeaders(body?: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (body) headers["content-type"] = "application/json";
  const tok = boxToken();
  if (tok) headers["authorization"] = `Bearer ${tok}`;
  return headers;
}

const z = tool.schema;

async function call(path: string, method = "GET", body?: unknown): Promise<any> {
  const res = await fetch(`${BUI_SERVER}${path}`, {
    method,
    headers: authHeaders(body),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error: text };
  }
  if (!res.ok) {
    throw new Error(json?.error || `bui-server ${res.status}`);
  }
  return json;
}

function q(context: any): string {
  const params = new URLSearchParams();
  if (context?.sessionID) params.set("sessionID", context.sessionID);
  if (context?.directory) params.set("directory", context.directory);
  return params.toString();
}

export const list = tool({
  description: [
    "List the OTHER agent sessions in the same workspace and a one-line summary",
    "of each. COSTS TOKENS AND HAS SIDE EFFECTS: inspecting a peer reads its",
    "transcript and a message WAKES it, warming a possibly-stale context — so",
    "this is NOT a free 'situational awareness' check and must not be called",
    "reflexively at the start of a task.",
    "ONLY call it when there is CONCRETE EVIDENCE another agent is editing the",
    "SAME files right now AND you must coordinate to avoid a collision:",
    "e.g. `git status` shows changes you did not make, a file changed under you",
    "mid-edit, or the user explicitly asks who else is working here.",
    "DO NOT use it to answer questions you can resolve yourself from git / gh /",
    "CI / the filesystem (e.g. 'is main green?', 'did the build pass?', 'what",
    "was done today?') — a peer's opinion is stale and worse than the source of",
    "truth. If in doubt, don't call it. Shows each peer's branch, uncommitted-",
    "file count, status, and current activity; call peers_inspect for detail.",
  ].join(" "),
  args: {},
  async execute(_args, context) {
    const result = await call(`/api/peers?${q(context)}`);
    const peers = result.peers ?? [];
    if (peers.length === 0) {
      return `No other sessions in workspace "${result.workspace}". You're the only agent here.`;
    }
    const lines = peers.map((p: any) => {
      const changes = p.gitChanges > 0 ? `${p.gitChanges} uncommitted` : "clean";
      const branch = p.branch ? ` ⎇${p.branch}` : "";
      return `• [${p.name}] (${p.type}, ${p.status})${branch} · ${changes}\n    ${p.activity}`;
    });
    return `Workspace "${result.workspace}" — ${peers.length} peer session(s):\n${lines.join("\n")}`;
  },
});

export const inspect = tool({
  description: [
    "Inspect ONE peer session in detail: its full git status (which files it's",
    "changing), branch, and — for chat sessions — recent transcript turns +",
    "todos, or — for terminal sessions — the terminal-pane tail. Use ONLY after",
    "peers_list has already shown a peer is actively touching files you care",
    "about and you need to see exactly what, to avoid a collision. Reading a",
    "peer's transcript costs tokens; do not inspect out of curiosity or to",
    "gather facts you can get from git / gh / CI yourself. Identify the peer by",
    "its window name, window index, or opencode session id (from peers_list).",
  ].join(" "),
  args: {
    target: z
      .string()
      .describe("The peer to inspect: its window name, window index, or session id."),
  },
  async execute(args, context) {
    const params = q(context);
    const result = await call(`/api/peers?${params}&target=${encodeURIComponent(args.target)}`);
    const p = result.peer;
    const out: string[] = [];
    out.push(`Peer "${p.name}" (${p.type}, ${p.status})${p.branch ? ` ⎇${p.branch}` : ""}`);
    out.push(`cwd: ${p.cwd}`);

    const files = p.git?.files ?? [];
    if (files.length === 0) {
      out.push("git: clean (no uncommitted changes)");
    } else {
      out.push(`git: ${p.git.count} uncommitted file(s):`);
      for (const f of files.slice(0, 40)) out.push(`  ${f.status.padEnd(2)} ${f.path}`);
      if (files.length > 40) out.push(`  …and ${files.length - 40} more`);
    }

    if (p.type === "chat") {
      const todos = p.todos ?? [];
      if (todos.length) {
        out.push("todos:");
        for (const t of todos) {
          const mark = t.status === "completed" ? "✓" : t.status === "in_progress" ? "▶" : "○";
          out.push(`  ${mark} ${t.content}`);
        }
      }
      const turns = p.turns ?? [];
      if (turns.length) {
        out.push("recent turns:");
        for (const t of turns) {
          const tools = t.tools?.length ? ` [tools: ${t.tools.join(", ")}]` : "";
          out.push(`  ${t.role}: ${t.text || "(no text)"}${tools}`);
        }
      }
    } else if (p.pane) {
      out.push("terminal (last lines):");
      out.push(p.pane);
    }

    return out.join("\n");
  },
});

export const message = tool({
  description: [
    "Send a message to ANOTHER agent session in your workspace (a sibling tmux",
    "window). WAKES the target: it runs a fresh turn, warming its context and",
    "spending its tokens — so only send when you have something the peer",
    "genuinely NEEDS and cannot get otherwise: a real coordination/hand-off, a",
    "warning that you changed a file it's editing, or a direct answer it asked",
    "you for. Do NOT ping a peer for status you can read yourself, to 'check in',",
    "or to share an FYI it didn't request. The message is injected as a new turn",
    "prefixed with your session name + workspace so the receiver knows it came",
    "from a peer, not its user — e.g. 'I just changed the API in src/x.ts, rebase",
    "before you continue'. Identify the peer by window name, index, or session id",
    "(from peers_list). Only chat-mode peers can receive a message; terminal",
    "(claude-TUI) peers cannot.",
  ].join(" "),
  args: {
    target: z
      .string()
      .describe("The peer to message: its window name, window index, or session id."),
    message: z.string().describe("The message text to deliver to the peer agent."),
  },
  async execute(args, context) {
    const result = await call("/api/peers", "POST", {
      target: args.target,
      message: args.message,
      sessionID: context?.sessionID,
      directory: context?.directory,
    });
    return `Message delivered to peer "${result.to}" in workspace "${result.workspace}". It will appear as a new turn in that session.`;
  },
});
