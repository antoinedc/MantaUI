// sessionList.ts — pure mapping of the box's `tmux:list` RPC response into the
// read-only view model the RN FlatList renders.
//
// The box exposes a project/session list on the `tmux:list` rpc channel
// (src/server/rpc.mjs → tmux.listProjects()). Each project is a tmux session
// with one or more windows; a window is a "chat" (has an opencode session id) or
// a "terminal" (does not). This is the M3.2 read-only bar: title + running/idle
// status, NOT the full transcript. Keeping the raw-JSON → view-model transform
// pure makes it unit-testable without a live box.
//
// Running/idle status: the web client streams per-window `running` flags over a
// separate WS channel. For this read-only first render we accept an optional
// status map (session → windowIndex → running) and default to "idle" when the
// box hasn't reported activity yet — matching the web SessionListScreen's
// `running = status?.running ?? false` default.

/** One window as returned by the box (subset of shared TmuxWindow we render). */
export interface RawWindow {
  index: number;
  name: string;
  opencodeSessionId?: string | null;
}

/** One project as returned by `tmux:list` (subset of shared Project). */
export interface RawProject {
  tmuxSession: string;
  windows?: RawWindow[] | null;
}

/** Per-window running status, keyed session → windowIndex → running. */
export type StatusMap = Record<string, Record<number, boolean> | undefined>;

/** A row in the read-only session list. */
export interface SessionRowVM {
  /** Stable key: `<session>:<windowIndex>`. */
  key: string;
  /** Owning tmux session (the project name / section header). */
  project: string;
  /** Window index within its session. */
  windowIndex: number;
  /** Display title (the tmux window name). */
  title: string;
  /** "chat" (opencode-backed) or "terminal". */
  kind: "chat" | "terminal";
  /** Running vs idle, from the status map (default idle). */
  status: "running" | "idle";
}

/** A section (one project) with its rows, for a sectioned FlatList. */
export interface SessionSectionVM {
  project: string;
  rows: SessionRowVM[];
}

function isRunning(
  statuses: StatusMap | undefined,
  session: string,
  windowIndex: number,
): boolean {
  return Boolean(statuses?.[session]?.[windowIndex]);
}

/**
 * Map a raw `tmux:list` response into a flat list of session rows. Defensive
 * against a malformed/partial response (non-array input, missing windows,
 * non-object entries) — a bad shape yields an empty list rather than throwing,
 * so a transient box hiccup can't crash the screen. Pure.
 */
export function mapSessionRows(
  raw: unknown,
  statuses?: StatusMap,
): SessionRowVM[] {
  if (!Array.isArray(raw)) return [];
  const rows: SessionRowVM[] = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    const project = (p as RawProject).tmuxSession;
    if (typeof project !== "string" || project.length === 0) continue;
    const windows = (p as RawProject).windows;
    if (!Array.isArray(windows)) continue;
    for (const w of windows) {
      if (!w || typeof w !== "object") continue;
      const index = (w as RawWindow).index;
      const name = (w as RawWindow).name;
      if (typeof index !== "number" || typeof name !== "string") continue;
      const kind = (w as RawWindow).opencodeSessionId ? "chat" : "terminal";
      rows.push({
        key: `${project}:${index}`,
        project,
        windowIndex: index,
        title: name,
        kind,
        status: isRunning(statuses, project, index) ? "running" : "idle",
      });
    }
  }
  return rows;
}

/**
 * Group the mapped rows by project into sections (preserving project order and
 * row order). Convenience for a sectioned render; the flat form is also fine for
 * a plain FlatList. Pure.
 */
export function mapSessionSections(
  raw: unknown,
  statuses?: StatusMap,
): SessionSectionVM[] {
  const rows = mapSessionRows(raw, statuses);
  const sections: SessionSectionVM[] = [];
  const byProject = new Map<string, SessionSectionVM>();
  for (const row of rows) {
    let section = byProject.get(row.project);
    if (!section) {
      section = { project: row.project, rows: [] };
      byProject.set(row.project, section);
      sections.push(section);
    }
    section.rows.push(row);
  }
  return sections;
}
