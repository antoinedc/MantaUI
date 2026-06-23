// bui-native `peers` tools — global opencode custom tools.
//
// Install on the opencode host (the Linux box that runs bui-server + opencode):
//   mkdir -p ~/.config/opencode/tools
//   cp <repo>/docs/opencode-tools/peers.ts ~/.config/opencode/tools/peers.ts
// then `systemctl --user restart opencode-serve` so opencode re-scans tools/.
//
// These tools let THIS session see what OTHER sessions in the same workspace
// (tmux session) are doing — useful when you notice files / git status changing
// and suspect another agent is working alongside you. They are THIN registrars:
// each GETs bui-server (127.0.0.1:8787/api/peers, same box, no SSH hop), which
// resolves the tmux workspace and queries each peer's opencode transcript or
// tmux pane. See src/server/peers.mjs.

import { tool } from "@opencode-ai/plugin";

const BUI_SERVER = process.env.BUI_SERVER_URL || "http://127.0.0.1:8787";

const z = tool.schema;

async function call(path: string): Promise<any> {
  const res = await fetch(`${BUI_SERVER}${path}`);
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
