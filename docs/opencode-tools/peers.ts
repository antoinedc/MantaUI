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

const BUI_SERVER = process.env.BUI_SERVER_URL || "http://127.0.0.1:8787";

const z = tool.schema;

async function call(path: string, method = "GET", body?: unknown): Promise<any> {
  const res = await fetch(`${BUI_SERVER}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
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
    "List the OTHER agent sessions working in the same workspace (the sibling",
    "windows of the same tmux session) and a one-line summary of what each is",
    "doing. Use when you notice files changing, git status shifting, or",
    "otherwise suspect another agent is working alongside you and you want to",
    "know who and on what. Shows each peer's branch, number of uncommitted",
    "files, status (working/idle/blocked), and current activity. Call",
    "peers_inspect for a detailed look at one peer.",
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
    "Inspect ONE peer session in your workspace in detail: its full git status",
    "(which files it's changing), branch, and — for chat sessions — its recent",
    "transcript turns and active todo list, or — for terminal sessions — the",
    "tail of its terminal pane. Use after peers_list to dig into what a specific",
    "agent is doing. Identify the peer by its window name, window index, or",
    "opencode session id (all shown by peers_list).",
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
    "window). The message is injected into that peer's chat as a new turn,",
    "prefixed with context about who sent it (your session name + workspace) so",
    "the receiving agent knows it came from a peer, not its user. Use to",
    "coordinate, hand off work, ask a question, or share a finding with another",
    "agent — e.g. 'I just changed the API in src/x.ts, rebase before you",
    "continue'. Identify the peer by its window name, window index, or opencode",
    "session id (all shown by peers_list). Only chat-mode peers can receive a",
    "message; terminal (claude-TUI) peers cannot.",
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
