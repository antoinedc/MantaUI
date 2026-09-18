// projectCwd.mjs — THE sole project-cwd resolver, extracted verbatim from
// rpc.mjs's buildHandlers closure (BET-120 precedence, unchanged behavior) so
// the §7 control-tool families (ctoMantaTools.mjs) and the RPC handlers share
// ONE implementation. Do not reimplement this anywhere; call it.
//
// Precedence (BET-120):
//   1. an explicit caller cwd that is non-empty and not the literal "~";
//   2. the stored project meta (`~/.manta/config.json` projects[].defaultCwd,
//      set by the desktop project-create flow);
//   3. the LIVE tmux session's first-window pane path (canonical "where this
//      project lives" — the config file is frequently empty/stale);
//   4. "~" as the last resort.
//
// NOTE this returns a possibly-tilde path — it picks WHICH cwd, not an
// absolute one. Expansion + missing-dir rejection stay at the single tmux-side
// chokepoint (`tmux.resolveCwdOrThrow`), which every caller (tmux.newSession /
// newWindow / opencode create) already flows through. Never resolve around
// either of them.

import { configGet as localConfigGet } from "./local.mjs";
import { listProjects as tmuxListProjects } from "./tmux.mjs";

export async function resolveProjectCwd(sessionName, inputCwd, io = {}) {
  const configGet = io.configGet ?? localConfigGet;
  const listProjectsFn = io.listProjects ?? tmuxListProjects;
  const trimmed = typeof inputCwd === "string" ? inputCwd.trim() : "";
  if (trimmed && trimmed !== "~") return trimmed;
  // 1. Prefer the stored project meta (set by the desktop on project create).
  const cfg = await configGet();
  const meta = cfg.projects?.find((p) => p.tmuxSession === sessionName);
  const storedCwd = (meta?.defaultCwd ?? "").trim();
  if (storedCwd && storedCwd !== "~") return storedCwd;
  // 2. Fall back to the LIVE tmux session's directory. The config file is
  //    frequently empty or stale (sessions created outside the desktop
  //    project-create flow have no stored meta), which silently dropped every
  //    new window into $HOME. listProjects() derives defaultCwd from the
  //    session's first window's actual pane path — the canonical "where this
  //    project lives" — so consult it before defaulting to ~.
  try {
    const projects = await listProjectsFn();
    const live = projects.find((p) => p.tmuxSession === sessionName);
    const liveCwd = (live?.defaultCwd ?? "").trim();
    if (liveCwd && liveCwd !== "~") return liveCwd;
  } catch {
    // tmux unavailable → fall through to the last-resort default below.
  }
  return storedCwd || trimmed || "~";
}
