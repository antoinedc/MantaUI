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
