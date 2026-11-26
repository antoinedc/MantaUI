// ===== An agent's seats (agent screens spec §2.2, §5.1; proposal A) =====
//
// A seat places an agent in one project, with a brief and a memory scope. The page is two columns: one hairline row per seat on
// the left — the project and its notes count, the agent's current task there, the whole brief, that seat's own access map, and
// the actions "Edit brief" (inline textarea with a character count) and "Remove seat" (asks first) — and the tinted pane on the
// right saying what a seat is and offering "Add a seat". The access map describes what the knowledge tools give a task in that
// seat; it does not claim a filesystem boundary. The lead and the Architect work in every project: no seats, no seat actions.
//
// Every press ends visibly: the profile is read again on success, and a refusal is a sentence in the row.

import { useId, useState } from "react";
import { Folder } from "lucide-react";
import type { AgentFleet, AgentProfile, AgentSeat } from "../../shared/types";
import { Button } from "../Button";
import { ConfirmInline } from "../ConfirmInline";
import { StatusDot } from "../StatusDot";
import { BlockTitle, LinkButton, PaneTitle, QuietLink } from "./AgentsParts";
import { Pane, PaneGroup, TwoColumn } from "./ProfileLayout";
import { SEAT_BRIEF_MAX, cellView, errText, memoryLabel, seatNotesLabel } from "./agentsView";
import { useOpenTask } from "./useOpenTask";

type Project = { slug: string; name: string };

const FIELD =
  "w-full rounded-md border border-border bg-bg px-2 py-2 text-label text-text placeholder:text-text-quiet outline-none focus-visible:ring-2 focus-visible:ring-accent";

const ACCESS_TAG: Record<"read" | "read-write" | "none", string> = {
  "read-write": "bg-accent-bg text-accent-tx",
  read: "bg-fill-active text-text-muted",
  none: "text-text-faint",
};

/**
 * What the knowledge tools give a task in this seat: one entry per memory, its name and one tag (read / read + write / no
 * access) — the note is the entry's tooltip. Entries, not cards: nothing here is clickable. `inline` runs them along a seat's
 * row; `pane` is the Overview's details pane version, one per line under its own quiet title.
 */
export function MemoryMap({ seat, variant = "inline" }: { seat: AgentSeat | null | undefined; variant?: "inline" | "pane" }) {
  if (!seat || seat.memory.length === 0) return null;
  const pane = variant === "pane";
  return (
    <div data-testid="memory-map" className="manta-agents-memory">
      {pane && <PaneTitle sub={`in the ${seat.projectName} seat`}>Access</PaneTitle>}
      <ul aria-label={`Access in the ${seat.projectName} seat`} className={"m-0 flex list-none p-0 " + (pane ? "flex-col" : "flex-wrap gap-x-4 gap-y-1")}>
        {seat.memory.map((m) => (
          <li key={m.label} data-testid="memory-row" title={m.note} className={"flex items-center gap-2 " + (pane ? "min-h-7 py-px text-label" : "text-meta text-text-muted")}>
            <span className={"min-w-0 truncate " + (pane ? "text-text" : "")}>{m.label}</span>
            <span data-access={m.access} className={`${pane ? "ml-auto " : ""}shrink-0 whitespace-nowrap rounded-xs px-1 text-meta ${ACCESS_TAG[m.access]}`}>
              {memoryLabel(m.access)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SeatRow({
  slug,
  seat,
  task,
  onChanged,
}: {
  slug: string;
  seat: AgentSeat;
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

  const brief = seat.brief.trim();
  return (
    <li data-testid="seat-row" data-project={seat.project} className="border-b border-border-subtle py-4">
      <div className="flex items-center gap-3">
        <Folder size={16} aria-hidden="true" className="shrink-0 text-text-faint" />
        <span className="min-w-0 flex-1 truncate text-body font-semibold text-text">{seat.projectName}</span>
        <span className="shrink-0 whitespace-nowrap text-meta text-text-faint">{seatNotesLabel(seat.notes)}</span>
      </div>
      <div className="ml-7 mt-1 flex flex-col gap-2">
        {task && (
          <div className="flex items-center gap-2 text-meta text-text-faint">
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
          <div role="alert" className="break-words text-meta text-danger">
            {openError}
          </div>
        )}
        {mode === "edit" ? (
          <div className="flex flex-col gap-2">
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
          <>
            <p className={"m-0 whitespace-pre-line break-words text-body " + (brief ? "text-text" : "text-text-faint")}>{brief || "No brief yet"}</p>
            <MemoryMap seat={seat} variant="inline" />
            <div className="flex items-center gap-4">
              {mode === "confirm" ? (
                <div className="flex items-center gap-1">
                  <ConfirmInline
                    label="Remove seat"
                    busy={busy}
                    onConfirm={() => void run(() => window.api.agentsSeatRemove({ slug, project: seat.project }), () => setMode("view"))}
                    onCancel={() => {
                      setMode("view");
                      setError(null);
                    }}
                  />
                </div>
              ) : (
                <>
                  <LinkButton
                    spaced={false}
                    onClick={() => {
                      setDraft(seat.brief);
                      setError(null);
                      setMode("edit");
                    }}
                  >
                    Edit brief
                  </LinkButton>
                  <QuietLink danger onClick={() => setMode("confirm")}>
                    Remove seat
                  </QuietLink>
                </>
              )}
            </div>
          </>
        )}
        {error && (
          <div role="alert" className="break-words text-meta text-danger" data-testid="seat-error">
            {error}
          </div>
        )}
      </div>
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
    <div data-testid="seat-add" className="flex flex-col gap-2 text-label">
      {projects == null ? (
        <p className="m-0 text-meta text-text-faint">Couldn't list the projects, so a seat can't be added right now.</p>
      ) : free.length === 0 ? (
        <p className="m-0 text-meta text-text-faint">Every project has a seat.</p>
      ) : (
        <div className="flex items-center gap-2">
          <select id={selectId} aria-label="Choose the project for a new seat" value={choice} onChange={(e) => setChoice(e.target.value)} disabled={busy} className={`${FIELD} min-w-0 flex-1`}>
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
  const { info, seats } = profile;
  const everywhere = info.role === "lead" || info.role === "architect";
  const row = fleet?.rows.find((r) => r.slug === info.slug);
  const whatIsASeat = (
    <PaneGroup title="What a seat is" testId="seats-about">
      <p className="m-0 text-label text-text">A seat lets the agent work in one project. Its brief is read at the start of every task there; its notes are that project's memory.</p>
    </PaneGroup>
  );
  return (
    <TwoColumn
      main={
        <section className="manta-agents-seats">
          <BlockTitle>Seats</BlockTitle>
          {everywhere ? (
            <p className="m-0 text-label text-text" data-testid="seats-everywhere">
              Works in every project.
            </p>
          ) : seats.length === 0 ? (
            <p className="m-0 text-label text-text-faint">No seats yet. A seat is created when this agent is mentioned in a project, or with Add a seat.</p>
          ) : (
            <ul className="m-0 list-none border-t border-border-subtle p-0" data-testid="seat-list">
              {seats.map((s) => {
                const view = row ? cellView(row.cells[s.project]) : { kind: "none" as const };
                const cell = row?.cells[s.project];
                return (
                  <SeatRow
                    key={s.project}
                    slug={info.slug}
                    seat={s}
                    task={view.kind === "cell" && cell ? { jobId: view.openable ? cell.jobId : "", title: view.title, line: view.line, tone: view.tone } : null}
                    onChanged={onChanged}
                  />
                );
              })}
            </ul>
          )}
        </section>
      }
      pane={
        <Pane label="Seats">
          {whatIsASeat}
          {!everywhere && (
            <PaneGroup title="Add a seat">
              <AddSeat slug={info.slug} projects={projects} taken={new Set(seats.map((s) => s.project))} onChanged={onChanged} />
            </PaneGroup>
          )}
        </Pane>
      }
    />
  );
}
