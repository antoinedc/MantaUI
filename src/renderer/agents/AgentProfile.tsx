// ===== The agent profile (profile v5; agent screens spec §2.2) =====
//
// One agent, one page: a header (name, who-it-is line, description, ONE Chat button), the "Use it when / Not for" block, then the tabs
// Overview · Skills · Seats · Learned · History · Research · Settings. The Architect works in every project, so it has no Seats; the
// lead has no Learned. There is no side column and no pending-change card: a change waiting for the user's click is in Needs you,
// History lists what went live, access is shown in Seats only, and the agent is changed from the Settings tab (or through Manta).
// The tabs are the `tabs` guide's hand-written tablist: a button per tab with `aria-selected`, a roving tab stop, arrows / Home / End
// that move AND select (selection follows focus), the selected tab underlined by a border on a pseudo-element, every panel in the
// markup with `hidden` on all but the selected one. `focusgroup` is not available in the bundled Chromium, so the ~15-line key handler
// stays (nextTab).
//
// Reads: the profile, the agent's history (the History tab), the fleet (each seat's current task) and the registry's projects (for Add
// a seat). The last two are soft: a failed read leaves out what they feed. Every press ends visibly: a window opens, a sentence says why not.

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Ban, Check, MessageSquare } from "lucide-react";
import type { AgentChange, AgentProfile as Profile } from "../../shared/types";
import { AgentBadge } from "../AgentBadge";
import { Button } from "../Button";
import { PageColumn } from "../RoutinesParts";
import { AgentHistory } from "./AgentHistory";
import { AgentLearned } from "./AgentLearned";
import { AgentOverview } from "./AgentOverview";
import { AgentResearch } from "./AgentResearch";
import { AgentSeats } from "./AgentSeats";
import { AgentSettings } from "./AgentSettings";
import { AgentSkills } from "./AgentSkills";
import { AgentsHeader, Crumbs } from "./AgentsParts";
import { appliedHistory, errText, factsLine, nextTab, profileTabs, type ProfileTab } from "./agentsView";
import { useAgentsRead, type AgentsRead } from "./useAgentsRead";
import { openChatWindow } from "./useOpenTask";

const TAB_CLASS =
  "relative flex-none whitespace-nowrap py-2 text-text-faint hover:text-text aria-selected:text-text aria-selected:font-medium " +
  "aria-selected:after:absolute aria-selected:after:inset-x-0 aria-selected:after:bottom-0 aria-selected:after:border-b-2 aria-selected:after:border-accent aria-selected:after:content-[''] " +
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";

/** A read that may still be loading or have failed — the History tab shows it. */
function HistoryState({ history, children }: { history: AgentsRead<AgentChange[]>; children: (records: AgentChange[]) => ReactNode }) {
  if (history.data) return <>{children(history.data)}</>;
  if (history.error) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-label">
        <span role="alert" className="break-words text-danger">
          {history.error}
        </span>
        <Button tone="default" onClick={() => void history.reload()}>
          Try again
        </Button>
      </div>
    );
  }
  return <p className="m-0 text-label text-text-faint">{history.unsupported ? "Update the box to see the history." : "Loading…"}</p>;
}

/** One half of the "how to use it" block: a label with its icon, and the line (or where to write it). */
function UseLine({ label, icon, text, empty }: { label: string; icon: ReactNode; text: string | null; empty: string }) {
  return (
    <div className="min-w-0">
      <h2 className="m-0 mb-1 flex items-center gap-2 text-label font-semibold text-text-muted">
        {icon}
        {label}
      </h2>
      {text ? <p className="m-0 break-words text-body text-text">{text}</p> : <p className="m-0 text-label text-text-faint">{empty}</p>}
    </div>
  );
}

export function AgentProfile({
  slug,
  onBack,
  onOpenWindow = openChatWindow,
}: {
  slug: string;
  /** Back to the Fleet page. */
  onBack: () => void;
  /** Select an agent's chat window (the box made or found it). */
  onOpenWindow?: (tmuxSession: string, windowIndex: number) => Promise<void>;
}) {
  const profile = useAgentsRead<Profile>(() => window.api.agentsProfile({ slug }), slug);
  const history = useAgentsRead<AgentChange[]>(() => window.api.agentsHistory({ slug }), slug);
  const fleet = useAgentsRead(() => window.api.agentsFleet(), 0);
  const projects = useAgentsRead(() => window.api.agentsProjects(), 0);
  const [tab, setTab] = useState<ProfileTab>("overview");
  const [actionError, setActionError] = useState<string | null>(null);
  const [openingChat, setOpeningChat] = useState(false);
  const base = useId();
  const tabRefs = useRef<Partial<Record<ProfileTab, HTMLButtonElement | null>>>({});

  // Another agent: start from its Overview.
  useEffect(() => {
    setTab("overview");
    setActionError(null);
  }, [slug]);
  useEffect(() => {
    tabRefs.current[tab]?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [tab]);

  const reloadAll = () => {
    void profile.reload();
    void history.reload();
    void fleet.reload();
  };

  const p = profile.data;
  const name = p?.info.name || slug;
  const shell = (body: ReactNode) => (
    <div className="manta-agents-pane manta-agents-profile flex h-full w-full flex-col bg-bg" data-screen="agents-profile">
      <AgentsHeader>
        <Crumbs trail={[{ label: "Agents", onClick: onBack }]} current={name} />
      </AgentsHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PageColumn>{body}</PageColumn>
      </div>
    </div>
  );

  if (!p) {
    return shell(
      profile.unsupported ? (
        <p className="m-0 text-label text-text-faint" data-testid="profile-unsupported">
          Update the box to see agent profiles.
        </p>
      ) : profile.error ? (
        <div className="flex flex-wrap items-center gap-2 text-label" data-testid="profile-error">
          <span role="alert" className="break-words text-danger">
            Couldn't load @{slug}: {profile.error}
          </span>
          <Button tone="default" onClick={() => void profile.reload()}>
            Try again
          </Button>
          <Button tone="ghost" onClick={onBack}>
            Back to the Fleet
          </Button>
        </div>
      ) : (
        <p className="m-0 text-label text-text-faint">Loading…</p>
      ),
    );
  }

  const { info } = p;
  const isArchitect = info.role === "architect";

  const openChat = async () => {
    if (openingChat) return;
    setOpeningChat(true);
    setActionError(null);
    try {
      const r = await window.api.agentsOpenChat({ slug });
      await onOpenWindow(r.tmuxSession, r.windowIndex);
    } catch (e) {
      setActionError(`Couldn't open ${info.name || slug}'s chat: ${errText(e)}`);
    } finally {
      setOpeningChat(false);
    }
  };

  const header = (
    <div className="flex flex-col gap-6">
      <div className="flex items-start gap-4" data-testid="profile-header">
        <AgentBadge size="lg" agent={{ name: info.name, slug: info.slug, color: info.color }} />
        <div className="min-w-0 flex-1">
          <h1 className="m-0 text-display font-semibold text-text">{info.name || slug}</h1>
          {!info.error && (
            <div data-testid="profile-facts" className="mt-1 flex flex-wrap text-label text-text-faint [&>span+span]:before:mx-2 [&>span+span]:before:text-text-quiet [&>span+span]:before:[content:'·'_/_'']">
              {factsLine(p).map((f) => (
                <span key={f}>{f}</span>
              ))}
            </div>
          )}
          <p className="m-0 mt-3 max-w-[68ch] text-prose text-text">{info.description}</p>
        </div>
        {!info.error && (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            {isArchitect ? (
              <span className="max-w-[12.5rem] pt-1 text-right text-meta leading-snug text-text-faint">Works through Manta: ask in any chat.</span>
            ) : (
              <Button tone="primary" loading={openingChat} onClick={() => void openChat()} title={`Opens your conversation with ${info.name || slug}`}>
                <MessageSquare size={14} aria-hidden="true" />
                Chat
              </Button>
            )}
          </div>
        )}
      </div>
      {!info.error && (
        <section aria-label={`How to use ${info.name || slug}`} data-testid="profile-howto" className="grid grid-cols-1 gap-x-6 gap-y-4 rounded-lg bg-bg-elev p-4 [@container(min-width:640px)]:grid-cols-2 [[data-theme=dark]_&]:shadow-[inset_0_0_0_1px_var(--border-subtle)]">
          <UseLine label="Use it when" icon={<Check size={14} aria-hidden="true" className="text-ok" />} text={info.useWhen} empty={p.info.role === "specialist" ? "Nothing written yet. Add it in Settings." : "Nothing written yet. Change it through Manta."} />
          <UseLine label="Not for" icon={<Ban size={14} aria-hidden="true" className="text-text-faint" />} text={info.notFor} empty={p.info.role === "specialist" ? "Nothing written yet. Add it in Settings." : "Nothing written yet. Change it through Manta."} />
        </section>
      )}
    </div>
  );

  const actionErrorLine = actionError && (
    <div role="alert" className="break-words text-meta text-danger" data-testid="profile-action-error">
      {actionError}
    </div>
  );

  if (info.error) {
    return shell(
      <div className="flex flex-col gap-4">
        {header}
        <p role="alert" className="m-0 break-words text-label text-danger" data-testid="profile-invalid">
          This agent can't be used: {info.error}
        </p>
      </div>,
    );
  }

  const shownTabs = profileTabs(p);
  const live = history.data ? appliedHistory(history.data).length : null;
  const count: Partial<Record<ProfileTab, number | null>> = {
    skills: (p.skills ?? []).length || null,
    seats: p.seats.length,
    learned: (p.learned ?? []).filter((r) => !r.archived).length || null,
    history: live || null,
    research: p.research.length || null,
  };
  const tabIds = shownTabs.map((t) => t.id);
  const tabId = (id: ProfileTab) => `${base}-tab-${id}`;

  const onTabKey = (e: React.KeyboardEvent<HTMLButtonElement>, id: ProfileTab) => {
    const next = nextTab(id, e.key, tabIds);
    if (!next) return;
    e.preventDefault();
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  const panel = (id: ProfileTab, body: ReactNode) =>
    tabIds.includes(id) && (
      <div role="tabpanel" aria-labelledby={tabId(id)} hidden={tab !== id}>
        <div className="pt-5">{body}</div>
      </div>
    );

  return shell(
    <div className="flex flex-col gap-6 [container-type:inline-size]">
      {header}
      {actionErrorLine}
      <div>
        <div role="tablist" aria-label={`${info.name || slug}`} className="manta-agents-tabs flex gap-5 overflow-x-auto border-b border-border text-label">
          {shownTabs.map((t) => (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[t.id] = el;
              }}
              type="button"
              role="tab"
              id={tabId(t.id)}
              aria-selected={tab === t.id}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => setTab(t.id)}
              onKeyDown={(e) => onTabKey(e, t.id)}
              className={TAB_CLASS}
            >
              {t.label}
              {count[t.id] != null && (
                <>
                  {" "}
                  <span className="text-text-faint">{count[t.id]}</span>
                </>
              )}
            </button>
          ))}
        </div>
        {panel("overview", <AgentOverview name={info.name || slug} instructions={p.instructions ?? ""} />)}
        {panel("skills", <AgentSkills name={info.name || slug} skills={p.skills ?? []} />)}
        {panel("seats", <AgentSeats profile={p} projects={projects.data ?? null} fleet={fleet.data ?? null} onChanged={reloadAll} />)}
        {panel(
          "learned",
          <AgentLearned slug={slug} rules={p.learned ?? []} projectName={(s) => (projects.data ?? []).find((x) => x.slug === s)?.name ?? s} onChanged={reloadAll} />,
        )}
        {panel(
          "history",
          <HistoryState history={history}>
            {(rows) => (
              <AgentHistory
                records={rows}
                onChanged={() => {
                  void profile.reload();
                  void history.reload();
                }}
              />
            )}
          </HistoryState>,
        )}
        {panel("research", <AgentResearch profile={p} onChanged={() => void profile.reload()} />)}
        {panel("settings", <AgentSettings profile={p} onChanged={reloadAll} />)}
      </div>
    </div>,
  );
}
