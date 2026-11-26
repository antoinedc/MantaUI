// ===== An agent's seats (agent screens spec §2.2, §5.1) =====
//
// A seat places an agent in one project, with a brief and a memory scope. One row per seat: the project, the first line of its
// brief, how many notes the project's wiki holds, and the agent's current task there. Edit brief (inline textarea), Remove
// (asks first), and "Add a seat in another project". The memory map below shows what the knowledge tools give a task in the
// selected seat — it describes the tools, it does not claim a filesystem boundary. The lead and the Architect work in every
// project: they have no seats and no seat actions.
//
// Every press ends visibly: the profile is read again on success, and a refusal is a sentence in the row.

import { useId, useState } from "react";
import { Folder } from "lucide-react";
import type { AgentFleet, AgentProfile, AgentSeat } from "../../shared/types";
import { Button } from "../Button";
import { ConfirmInline } from "../ConfirmInline";
import { StatusDot } from "../StatusDot";
import { BlockTitle } from "./AgentsParts";
import { SEAT_BRIEF_MAX, cellView, errText, firstLine, memoryLabel, seatNotesLabel } from "./agentsView";
import { useOpenTask } from "./useOpenTask";

type Project = { slug: string; name: string };

const FIELD =
  "w-full rounded-md border border-border bg-bg px-2 py-2 text-label text-text placeholder:text-text-quiet outline-none focus-visible:ring-2 focus-visible:ring-accent";

/** What the knowledge tools give a task in this seat (`.mem`). */
export function MemoryMap({ seat }: { seat: AgentSeat | null | undefined }) {
  if (!seat || seat.memory.length === 0) return null;
  return (
    <div data-testid="memory-map" className="manta-agents-memory">
      <BlockTitle>What it can read and write ({seat.projectName} seat)</BlockTitle>
      <div className="grid grid-cols-2 gap-2">
        {seat.memory.map((m) => (
          <div key={m.label} className="rounded-md border border-border-subtle px-3 py-2 text-meta text-text-faint">
            <div className="text-label font-semibold text-text">{m.label}</div>
            <span className="font-medium text-text-muted">{memoryLabel(m.access)}</span> · {m.note}
          </div>
        ))}
      </div>
    </div>
  );
}

function SeatRow({
  slug,
  seat,
  selected,
  onSelect,
  task,
  onChanged,
}: {
  slug: string;
  seat: AgentSeat;
  selected: boolean;
  onSelect: () => void;
  task: { jobId: string; title: string; line: string; tone: "running" | "warn" | "ok" | "error" | "idle" } | null;
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<"view" | "edit" | "confirm">("view");
  const [draft, setDraft] = useState(seat.brief);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { open, busyId, error: openError } = useOpenTask();
  const briefId = useId();

  const run = async (call: () => Promise<unknown>, done: () => void) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await call();
      done();
      onChanged();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const brief = firstLine(seat.brief);
  return (
    <li data-testid="seat-row" data-project={seat.project} className="flex flex-col gap-2 border-b border-border-subtle py-2 text-label">
      <div className="flex items-center gap-2">
        <Folder size={14} aria-hidden="true" className="shrink-0 text-text-faint" />
        <button
          type="button"
          aria-pressed={selected}
          onClick={onSelect}
          title={`Show what it can read and write in ${seat.projectName}`}
          className={"min-w-0 truncate rounded-sm text-left font-medium hover:underline " + (selected ? "text-text" : "text-text-muted")}
        >
          {seat.projectName}
        </button>
        <span className={"min-w-0 flex-1 truncate text-meta " + (brief ? "text-text-faint" : "text-text-quiet")} title={brief || undefined}>
          {brief || "No brief yet"}
        </span>
        <span className="shrink-0 whitespace-nowrap text-meta text-text-faint">{seatNotesLabel(seat.notes)}</span>
      </div>
      {task && (
        <div className="flex items-center gap-2 pl-6 text-meta text-text-faint">
          {task.tone !== "idle" && <StatusDot tone={task.tone} />}
          {task.jobId ? (
            <button
              type="button"
              disabled={busyId != null}
              onClick={() => void open(task.jobId)}
              title="Open this task's session"
              className="min-w-0 truncate rounded-sm text-left hover:underline disabled:opacity-60"
            >
              {task.title} · {busyId === task.jobId ? "Opening…" : task.line}
            </button>
          ) : (
            <span className="truncate">{task.line}</span>
          )}
        </div>
      )}
      {openError && (
        <div role="alert" className="pl-6 text-meta text-danger break-words">
          {openError}
        </div>
      )}
      {mode === "edit" ? (
        <div className="flex flex-col gap-2 pl-6">
          <label htmlFor={briefId} className="text-meta text-text-muted">
            Brief for {seat.projectName}
          </label>
          <textarea
            id={briefId}
            rows={4}
            maxLength={SEAT_BRIEF_MAX}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="What this agent should know about the project, and how it should work here."
            className={FIELD}
          />
          <div className="flex items-center gap-2">
            <Button tone="primary" loading={busy} onClick={() => void run(() => window.api.agentsSeatSet({ slug, project: seat.project, brief: draft }), () => setMode("view"))}>
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button
              tone="default"
              disabled={busy}
              onClick={() => {
                setMode("view");
                setDraft(seat.brief);
                setError(null);
              }}
            >
              Cancel
            </Button>
            <span className="ml-auto text-meta tabular-nums text-text-faint">
              {draft.length} / {SEAT_BRIEF_MAX}
            </span>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-1 pl-6">
          {mode === "confirm" ? (
            <ConfirmInline
              label="Remove seat"
              busy={busy}
              onConfirm={() => void run(() => window.api.agentsSeatRemove({ slug, project: seat.project }), () => setMode("view"))}
              onCancel={() => {
                setMode("view");
                setError(null);
              }}
            />
          ) : (
            <>
              <Button
                tone="ghost"
                onClick={() => {
                  setDraft(seat.brief);
                  setError(null);
                  setMode("edit");
                }}
              >
                Edit brief
              </Button>
              <Button tone="ghost" onClick={() => setMode("confirm")}>
                Remove
              </Button>
            </>
          )}
        </div>
      )}
      {error && (
        <div role="alert" className="pl-6 text-meta text-danger break-words" data-testid="seat-error">
          {error}
        </div>
      )}
    </li>
  );
}

function AddSeat({ slug, projects, taken, onChanged }: { slug: string; projects: ReadonlyArray<Project> | null; taken: ReadonlySet<string>; onChanged: () => void }) {
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectId = useId();
  const free = (projects ?? []).filter((p) => !taken.has(p.slug));

  const add = async () => {
    if (!choice || busy) return;
    setBusy(true);
    setError(null);
    try {
      await window.api.agentsSeatAdd({ slug, project: choice });
      setChoice("");
      onChanged();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="seat-add" className="flex flex-col gap-2 pt-3 text-label">
      {projects == null ? (
        <p className="m-0 text-meta text-text-faint">Couldn't list the projects, so a seat can't be added right now.</p>
      ) : free.length === 0 ? (
        <p className="m-0 text-meta text-text-faint">Every project has a seat.</p>
      ) : (
        <div className="flex items-center gap-2">
          <label htmlFor={selectId} className="shrink-0 text-meta text-text-muted">
            Add a seat in another project
          </label>
          <select id={selectId} value={choice} onChange={(e) => setChoice(e.target.value)} disabled={busy} className={`${FIELD} min-w-0 flex-1`}>
            <option value="">Choose a project…</option>
            {free.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name}
              </option>
            ))}
          </select>
          <Button tone="default" disabled={!choice} loading={busy} onClick={() => void add()}>
            Add
          </Button>
        </div>
      )}
      {error && (
        <div role="alert" className="text-meta text-danger break-words">
          {error}
        </div>
      )}
    </div>
  );
}

export function AgentSeats({
  profile,
  projects,
  fleet,
  onChanged,
}: {
  profile: AgentProfile;
  /** The registry's projects (for "Add a seat"); null when the box couldn't list them. */
  projects: ReadonlyArray<Project> | null;
  /** The fleet read, for each seat's current task; null leaves the task line out. */
  fleet: AgentFleet | null;
  onChanged: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const { info, seats } = profile;
  if (info.role === "lead" || info.role === "architect") {
    return (
      <p className="manta-agents-seats m-0 text-label text-text-muted" data-testid="seats-everywhere">
        Works in every project.
      </p>
    );
  }
  const row = fleet?.rows.find((r) => r.slug === info.slug);
  const chosen = seats.find((s) => s.project === selected) ?? seats[0];
  return (
    <div className="manta-agents-seats flex flex-col gap-6">
      <div>
        {seats.length === 0 ? (
          <p className="m-0 text-label text-text-faint">No seats yet. A seat is created when this agent is mentioned in a project, or here.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col p-0" data-testid="seat-list">
            {seats.map((s) => {
              const view = row ? cellView(row.cells[s.project]) : { kind: "none" as const };
              const cell = row?.cells[s.project];
              return (
                <SeatRow
                  key={s.project}
                  slug={info.slug}
                  seat={s}
                  selected={s.project === chosen?.project}
                  onSelect={() => setSelected(s.project)}
                  task={view.kind === "cell" && cell ? { jobId: view.openable ? cell.jobId : "", title: view.title, line: view.line, tone: view.tone } : null}
                  onChanged={onChanged}
                />
              );
            })}
          </ul>
        )}
        <AddSeat slug={info.slug} projects={projects} taken={new Set(seats.map((s) => s.project))} onChanged={onChanged} />
      </div>
      <MemoryMap seat={chosen} />
    </div>
  );
}
