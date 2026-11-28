// ===== The Fleet page (docs/superpowers/specs/2026-11-28-fleet-redesign.md, mockup v10) =====
//
// A manager's overview: what is being worked on (by project, or by agent), whether anything needs the user, what ended today —
// and, one click away in Details, everything technical. Only statuses the box records appear: In progress, or Paused by you.
// Needs you and the task list are read by the App (the sidebar's numbers come from the same reads) and handed down; this page
// owns the view, Details, and the two task actions (Resume, Stop behind a native dialog).
//
// Every press ends visibly (AGENTS.md, "NEVER STUB A CONTROL"): Resume / Stop report success to a polite live region and failure
// under the row and in Details; Open session reports its refusal on the page; while the box is unreachable the actions are
// disabled with the reason as their title.

import { useEffect, useRef, useState } from "react";
import type { FleetEnded, FleetTask, FleetTasks, NeedsYou } from "../../shared/types";
import { AgentsHeader } from "./AgentsParts";
import { Segmented } from "../Segmented";
import { AGE_TICK_MS, nowMs, useClockTick } from "../clock";
import { findJobById } from "../jobProgress";
import { usePackageAgents } from "../packageAgents";
import { useStore } from "../store";
import { errText } from "./agentsView";
import { FleetDetails, type DetailsItem } from "./FleetDetails";
import { AgentWho, EndedRow, EndedSection, TaskGroupView, TaskRow } from "./FleetRows";
import { StopTaskDialog } from "./StopTaskDialog";
import { fleetHeaderCounts, groupTasks, needsTop, readBanner, readFleetBy, resumeBlockedReason, saveFleetBy, type FleetBy } from "./fleetView";
import { useAfter, type AgentsRead } from "./useAgentsRead";
import { useOpenTask } from "./useOpenTask";
import { AgentBadge } from "../AgentBadge";

const SKELETON_DELAY_MS = 150;

/** The connection is down (not merely quiet): the box's data on screen is the last report. */
export const useBoxOffline = (): boolean => useStore((s) => s.connectionState.state !== "connected" && s.connectionState.state !== "idle");

export function Skeleton({ testId = "fleet-skeleton", groups = 2 }: { testId?: string; groups?: number }) {
  return (
    <div aria-busy="true" data-testid={testId}>
      {Array.from({ length: groups }, (_, g) => (
        <div key={g} className="mt-6 first:mt-0">
          <span className="block h-4 w-36 rounded-xs bg-fill-active motion-safe:animate-pulse" />
          {[62, 50].map((w, i) => (
            <div key={i} className="grid gap-2 border-b border-border-subtle py-[14px]">
              <span className="block h-3 rounded-xs bg-fill-active motion-safe:animate-pulse" style={{ width: `${w}%` }} />
              <span className="block h-3 w-1/3 rounded-xs bg-fill-active motion-safe:animate-pulse" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** The warn / bad banner of a stale or failed read. An unreachable box is a status; a failed read is an alert. */
export function ReadBannerView({ banner, onAction, testId }: { banner: NonNullable<ReturnType<typeof readBanner>>; onAction: () => void; testId: string }) {
  const bad = banner.tone === "bad";
  return (
    <div
      role={bad ? "alert" : "status"}
      data-testid={testId}
      className={`mb-4 flex flex-wrap items-start gap-[10px] rounded-md px-3 py-[10px] text-label leading-snug ${bad ? "bg-danger-bg shadow-[inset_0_0_0_1px_var(--danger)]" : "bg-warn-bg shadow-[inset_0_0_0_1px_var(--warn)]"}`}
    >
      <div className="min-w-[200px] flex-1">
        <b className="font-semibold">{banner.title}</b> {banner.text}
      </div>
      <button
        type="button"
        onClick={onAction}
        className="inline-flex h-[30px] items-center rounded-sm border border-border bg-bg-soft px-3 text-label font-medium text-text shadow-sm hover:bg-fill-hover focus-visible:outline-2 focus-visible:outline-accent"
      >
        {banner.action}
      </button>
    </div>
  );
}

type ActionError = { kind: "stop" | "resume"; text: string };

export function FleetPage({
  tasks,
  needs,
  onOpenNeeds,
}: {
  /** What is in progress, paused and ended today — read by the App (the sidebar's Fleet count comes from the same read). */
  tasks: AgentsRead<FleetTasks>;
  /** What needs the user — only its decisions show here, as one card. */
  needs: AgentsRead<NeedsYou>;
  onOpenNeeds: () => void;
}) {
  const { agents } = usePackageAgents();
  const offline = useBoxOffline();
  const jobs = useStore((s) => s.jobs);
  const skews = useStore((s) => s.jobSkew);
  const projects = useStore((s) => s.projects);
  useClockTick(AGE_TICK_MS);
  const now = nowMs();
  const slow = useAfter(tasks.loading, SKELETON_DELAY_MS);
  const { open: openSession, busyId, error: openError } = useOpenTask();

  const [by, setByState] = useState<FleetBy>(readFleetBy);
  const setBy = (next: FleetBy) => {
    setByState(next);
    saveFleetBy(next);
  };
  const [detailId, setDetailId] = useState<string | null>(null);
  const [stopTarget, setStopTarget] = useState<FleetTask | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, ActionError>>({});
  const [announce, setAnnounce] = useState("");
  const detailRef = useRef<HTMLDivElement>(null);

  const data = tasks.data;
  const infoOf = (slug: string) => agents?.find((a) => a.slug === slug);
  const agentName = (slug: string) => infoOf(slug)?.name || slug;
  const chatNameOf = (sessionId: string | null): string | null => {
    if (!sessionId) return null;
    for (const p of projects) for (const w of p.windows) if (w.opencodeSessionId === sessionId) return w.name || null;
    return null;
  };

  const detail: DetailsItem | null = (() => {
    if (!detailId || !data) return null;
    const run = data.running.find((t) => t.jobId === detailId);
    if (run) return { kind: "running", task: run };
    const end = data.ended.find((t) => t.jobId === detailId);
    return end ? { kind: "ended", task: end } : null;
  })();

  // Esc closes Details (a dialog open on top keeps its own Esc); the focus moves into Details when it opens
  useEffect(() => {
    if (!detail) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector("dialog[open]")) return;
      setDetailId(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [detail]);
  const detailKey = detail?.task.jobId ?? null;
  useEffect(() => {
    if (detailKey) detailRef.current?.querySelector<HTMLElement>("button")?.focus();
  }, [detailKey]);

  const setError = (jobId: string, e: ActionError | null) =>
    setErrors((m) => {
      const next = { ...m };
      if (e) next[jobId] = e;
      else delete next[jobId];
      return next;
    });

  const resume = async (t: FleetTask) => {
    if (actionBusy) return;
    setActionBusy(t.jobId);
    setError(t.jobId, null);
    try {
      const res = await window.api.delegateResume(t.jobId);
      if (!res?.ok) {
        setError(t.jobId, { kind: "resume", text: res?.error || "The box refused to resume it." });
      } else {
        setAnnounce(`Resumed: ${t.title}`);
        await tasks.reload();
      }
    } catch (e) {
      setError(t.jobId, { kind: "resume", text: errText(e) });
    } finally {
      setActionBusy(null);
    }
  };

  const stop = async (t: FleetTask) => {
    if (actionBusy) return;
    setActionBusy(t.jobId);
    setError(t.jobId, null);
    try {
      const res = await window.api.delegateStop(t.jobId);
      if (!res?.ok) {
        setError(t.jobId, { kind: "stop", text: res?.error || "The box didn’t answer, so it’s still running." });
      } else {
        setAnnounce(`Stopped: ${t.title}`);
        if (detailId === t.jobId) setDetailId(null);
        await tasks.reload();
      }
    } catch (e) {
      setError(t.jobId, { kind: "stop", text: errText(e) });
    } finally {
      setActionBusy(null);
    }
  };

  const banner = readBanner({ connected: !offline, hasData: !!data, error: tasks.error, refreshError: tasks.refreshError, updatedAt: tasks.updatedAt }, "Fleet");
  const resumeBlocked = data ? resumeBlockedReason(data.full, data.cap) : null;
  const top = needsTop(needs.data, agentName);
  const groups = data ? groupTasks(data.running, by, agentName) : [];
  const counts = data ? fleetHeaderCounts(data.running) : "";

  const rowFor = (t: FleetTask) => (
    <TaskRow
      key={t.jobId}
      task={t}
      by={by}
      info={infoOf(t.agentSlug)}
      now={now}
      offline={offline}
      resumeBlocked={resumeBlocked}
      openBusy={busyId === t.jobId}
      actionBusy={actionBusy === t.jobId}
      error={errors[t.jobId] ?? null}
      onDetails={setDetailId}
      onOpen={(id) => void openSession(id)}
      onResume={(task) => void resume(task)}
      onRetryStop={setStopTarget}
    />
  );
  const endedRow = (e: FleetEnded) => <EndedRow key={e.jobId} task={e} info={infoOf(e.agentSlug)} now={now} offline={offline} openBusy={busyId === e.jobId} onDetails={setDetailId} onOpen={(id) => void openSession(id)} />;

  return (
    <div className="manta-agents-pane manta-agents-fleet flex h-full w-full flex-col bg-bg" data-screen="agents-fleet">
      <AgentsHeader
        right={
          counts ? (
            <span className="whitespace-nowrap text-meta text-text-muted" data-testid="fleet-header-counts">
              {counts}
            </span>
          ) : undefined
        }
      >
        <h1 className="m-0 text-label font-medium text-text">Fleet</h1>
        <Segmented<FleetBy>
          label="Group by"
          value={by}
          onChange={setBy}
          options={[
            { id: "projects", label: "Projects" },
            { id: "agents", label: "Agents" },
          ]}
        />
      </AgentsHeader>

      <div className="flex min-h-0 flex-1 [container-type:inline-size]">
        <div className={`min-w-0 flex-1 overflow-y-auto ${detail ? "[@container(max-width:719px)]:hidden" : ""}`}>
          <div data-testid="fleet-column" className="mx-auto w-full max-w-[960px] px-4 pb-10 pt-6 [container-type:inline-size] [@container(min-width:640px)]:px-6">
            {banner && <ReadBannerView banner={banner} testId="fleet-banner" onAction={() => void tasks.reload()} />}
            {tasks.loading ? (
              slow ? (
                <Skeleton />
              ) : null
            ) : tasks.unsupported ? (
              <p className="m-0 text-label text-text-faint" data-testid="fleet-unsupported">
                Update the box to see the fleet.
              </p>
            ) : data ? (
              <>
                {top ? (
                  <button
                    type="button"
                    data-testid="fleet-needs-card"
                    onClick={onOpenNeeds}
                    className="mb-8 flex w-full flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-border bg-bg-soft px-4 py-3 text-left text-text shadow-sm [border-left:var(--need-edge-w)_solid_var(--danger)] hover:border-border-strong hover:[border-left-color:var(--danger)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    <span className="min-w-[15rem] flex-1">
                      <span className="block text-prose font-semibold leading-snug">{top.heading}</span>
                      <span className="mt-[2px] block break-words text-label text-text-muted">{top.detail}</span>
                    </span>
                    <span className="whitespace-nowrap text-label font-medium text-accent-tx">Review →</span>
                  </button>
                ) : data.running.length > 0 ? (
                  <p data-testid="fleet-calm" className="m-0 mb-8 flex items-start gap-2 text-label leading-snug text-text-muted">
                    <span aria-hidden="true" className="mt-[6px] h-2 w-2 shrink-0 rounded-full bg-ok" />
                    <span>Nothing needs you right now.</span>
                  </p>
                ) : null}

                {openError && (
                  <p role="alert" data-testid="fleet-open-error" className="m-0 mb-3 break-words text-meta text-danger">
                    {openError}
                  </p>
                )}

                {data.running.length > 0 ? (
                  groups.map((g) => {
                    const id = `fleet-g-${g.key || "none"}`;
                    return (
                      <TaskGroupView
                        key={g.key}
                        group={g}
                        id={id}
                        heading={
                          by === "agents" ? (
                            <>
                              <AgentBadge size="md" agent={{ name: g.label, slug: g.key, color: infoOf(g.key)?.color ?? null }} />
                              {g.label}
                            </>
                          ) : (
                            g.label
                          )
                        }
                      >
                        {g.tasks.map(rowFor)}
                      </TaskGroupView>
                    );
                  })
                ) : (
                  <div data-testid="fleet-empty" className="max-w-[540px] pb-2 pt-4">
                    <h2 className="m-0 mb-1 text-body font-semibold tracking-[-0.01em] text-text">Nothing is being worked on</h2>
                    <p className="m-0 text-body leading-normal text-text-muted">Ask Manta for something in a chat, or mention an agent with @. Work shows up here while it’s in progress.</p>
                  </div>
                )}

                <EndedSection ended={data.ended} renderRow={endedRow} />
              </>
            ) : null}
          </div>
        </div>
        {detail && (
          <div ref={detailRef} className="w-[400px] shrink-0 overflow-y-auto [@container(max-width:719px)]:w-full">
            <FleetDetails
              item={detail}
              info={infoOf(detail.task.agentSlug)}
              storeJob={findJobById(jobs, detail.task.jobId)}
              skew={skews[detail.task.jobId] ?? skewOf(skews, jobs, detail.task.jobId)}
              now={now}
              chatName={chatNameOf(detail.task.askedBy.by === "manta" ? detail.task.askedBy.sessionId : null)}
              offline={offline}
              resumeBlocked={resumeBlocked}
              openBusy={busyId === detail.task.jobId}
              actionBusy={actionBusy === detail.task.jobId}
              error={errors[detail.task.jobId] ?? null}
              onClose={() => setDetailId(null)}
              onOpen={(id) => void openSession(id)}
              onStop={setStopTarget}
              onResume={(t) => void resume(t)}
            />
          </div>
        )}
      </div>

      <StopTaskDialog
        open={stopTarget != null}
        title={stopTarget?.title ?? ""}
        onClose={(confirmed) => {
          const t = stopTarget;
          setStopTarget(null);
          if (confirmed && t) void stop(t);
        }}
      />
      <div role="status" aria-live="polite" className="sr-only">
        {announce}
      </div>
    </div>
  );
}

/** The store keys a job's clock skew by its child session id (see `jobSkew`); the page knows the job id. */
function skewOf(skews: Record<string, number>, jobs: Record<string, { id: string; childSessionID: string | null }>, jobId: string): number | undefined {
  const job = Object.values(jobs).find((j) => j.id === jobId);
  return job?.childSessionID ? skews[job.childSessionID] : undefined;
}

export { AgentWho };
