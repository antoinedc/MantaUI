// ===== The agent profile (agent screens spec §2.2) =====
//
// One agent, one page: a header (name, who-it-is line, description, actions), its pending change (one summary line, the change
// folded), then the tabs Overview · Research · Seats · History (there is no Tests tab until Tests exist). The Overview is two
// columns: how to use the agent and the research it rests on, beside one tinted details pane (details, seats, access, refresh)
// that stacks under the main column when the page is narrow. History is a tab, not an Overview block. The tabs are the `tabs` guide's hand-written tablist: a button per tab with
// `aria-selected`, a roving tab stop, arrows / Home / End that move AND select (selection follows focus), the selected tab
// underlined by a border on a pseudo-element, every panel in the markup with `hidden` on all but the selected one. `focusgroup`
// is not available in the bundled Chromium, so the ~15-line key handler stays (nextTab).
//
// Reads: the profile, the agent's history (shared by the Overview preview, the History tab and the pending cards), the fleet
// (each seat's current task) and the registry's projects (for Add a seat). The last two are soft: a failed read leaves out what
// they feed. Every press ends visibly: a draft opens, a window opens, a sentence says why not.

import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronRight, Folder } from "lucide-react";
import type { AgentChange, AgentProfile as Profile } from "../../shared/types";
import { AgentBadge } from "../AgentBadge";
import { AgentChangeView } from "../AgentChangeCard";
import { parseAgentMdView } from "../agentChange";
import { Button } from "../Button";
import { openChangeAgentDraft, openMentionDraft } from "../newAgentDraft";
import { ResearchRows } from "../ResearchRows";
import { PageColumn } from "../RoutinesParts";
import { Segmented } from "../Segmented";
import { useStore } from "../store";
import { AgentHistory } from "./AgentHistory";
import { AgentSeats, MemoryMap } from "./AgentSeats";
import { AgentsHeader, BlockTitle, Crumbs, PaneTitle } from "./AgentsParts";
import { OVERVIEW_PREVIEW, PROFILE_TABS, currentSnapshot, detailRows, errText, factsLine, nextTab, seatFolder, seatNotesLabel, type ProfileTab } from "./agentsView";
import { useAgentsRead, type AgentsRead } from "./useAgentsRead";
import { openChatWindow } from "./useOpenTask";

const TAB_CLASS =
  "relative flex-none whitespace-nowrap py-2 text-text-faint hover:text-text aria-selected:text-text " +
  "aria-selected:after:absolute aria-selected:after:inset-x-0 aria-selected:after:bottom-0 aria-selected:after:border-b-2 aria-selected:after:border-accent aria-selected:after:content-[''] " +
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";

const LinkButton = ({ onClick, children, spaced = true }: { onClick: () => void; children: ReactNode; spaced?: boolean }) => (
  <button type="button" onClick={onClick} className={`${spaced ? "mt-2 " : ""}rounded-sm text-meta font-medium text-accent-tx hover:underline focus-visible:outline-2 focus-visible:outline-accent`}>
    {children}
  </button>
);

/** A read that may still be loading or have failed — the History tab and the Overview's History block show it the same way. */
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

/** One group of the details pane: a hairline above every group but the first, the title one step down from the main column's. */
function PaneGroup({ testId, title, sub, children }: { testId?: string; title: string; sub?: string; children: ReactNode }) {
  return (
    <section data-testid={testId} className="border-t border-border pt-4 first:border-t-0 first:pt-0 [&:not(:first-child)]:mt-5 [[data-theme=dark]_&]:border-border-subtle">
      <PaneTitle sub={sub}>{title}</PaneTitle>
      {children}
    </section>
  );
}

function RefreshControl({ profile, onChanged }: { profile: Profile; onChanged: () => void }) {
  const slug = profile.info.slug;
  const [override, setOverride] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  // Turned off from the Routines page (or on again): the box's word beats an answer we kept.
  useEffect(() => setOverride(null), [profile.refresh.enabled]);
  const enabled = override ?? profile.refresh.enabled;

  const set = async (next: "monthly" | "off") => {
    const want = next === "monthly";
    if (busyRef.current || want === enabled) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const r = await window.api.agentsRefreshSet({ slug, enabled: want });
      setOverride(r.enabled);
      onChanged();
    } catch (e) {
      setError(errText(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <PaneGroup title="Refresh with new research" testId="profile-refresh">
      <div className="flex items-center gap-3">
        <Segmented
          label="Refresh with new research"
          options={[
            { id: "monthly", label: "Monthly" },
            { id: "off", label: "Off" },
          ]}
          value={enabled ? "monthly" : "off"}
          onChange={(v) => void set(v)}
        />
        {busy && <span className="text-meta text-text-faint">Saving…</span>}
      </div>
      <p className="m-0 mt-2 text-meta text-text-faint">
        {enabled ? "Once a month the agent checks the research it rests on and proposes changes. They wait for your click." : "The agent is not refreshed on its own."}
      </p>
      {error && (
        <div role="alert" data-testid="refresh-error" className="mt-1 break-words text-meta text-danger">
          {error}
        </div>
      )}
    </PaneGroup>
  );
}

/** "How to use it": a definition list of what the agent's file says about when to reach for it, and the full instructions folded. */
function HowToUse({ profile, snapshot }: { profile: Profile; snapshot: string | null }) {
  const { info } = profile;
  const instructions = useMemo(() => (snapshot ? parseAgentMdView(snapshot)?.body || null : null), [snapshot]);
  const rows = [
    ["Use it when", info.useWhen],
    ["Not for", info.notFor],
  ].filter((r): r is [string, string] => !!r[1]);
  return (
    <section data-testid="profile-howto">
      <BlockTitle>How to use it</BlockTitle>
      {rows.length > 0 ? (
        <dl className="m-0 grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-4 gap-y-3">
          {rows.map(([k, v]) => (
            <Fragment key={k}>
              <dt className="pt-px text-label text-text-faint">{k}</dt>
              <dd className="m-0 break-words text-body text-text">{v}</dd>
            </Fragment>
          ))}
        </dl>
      ) : (
        <p className="m-0 text-label text-text-faint">Nothing written yet. Change via Manta can add when to use this agent.</p>
      )}
      {instructions && (
        <details className="group mt-4 border-t border-border-subtle pt-3">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-label font-medium text-text-muted hover:text-text [&::-webkit-details-marker]:hidden">
            <ChevronRight size={14} aria-hidden="true" className="shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
            Full instructions
            <span className="text-meta font-normal text-text-faint">· {instructions.split("\n").length} lines</span>
          </summary>
          <pre className="m-0 mt-2 whitespace-pre-wrap break-words rounded-md bg-fill px-3 py-2 text-meta text-text-muted">{instructions}</pre>
        </details>
      )}
    </section>
  );
}

function SeatsGroup({ profile, onManage }: { profile: Profile; onManage: () => void }) {
  const everywhere = profile.info.role === "lead" || profile.info.role === "architect";
  return (
    <PaneGroup title="Seats" testId="profile-seats">
      {everywhere ? (
        <p className="m-0 text-label text-text">Works in every project.</p>
      ) : (
        <>
          {profile.seats.length === 0 ? (
            <p className="m-0 text-label text-text-faint">No seats yet.</p>
          ) : (
            <ul className="m-0 flex list-none flex-col p-0">
              {profile.seats.map((s) => (
                <li key={s.project} className="flex min-h-7 items-center gap-2 text-label">
                  <Folder size={14} aria-hidden="true" className="shrink-0 text-text-faint" />
                  <span className="min-w-0 truncate text-text">{s.projectName}</span>
                  <span className="ml-auto shrink-0 whitespace-nowrap text-meta text-text-faint">{seatNotesLabel(s.notes)}</span>
                </li>
              ))}
            </ul>
          )}
          <LinkButton onClick={onManage}>Manage seats</LinkButton>
        </>
      )}
    </PaneGroup>
  );
}

/** The right-hand pane: every fact and setting about the agent in one tinted region. */
function DetailsPane({ profile, refreshable, onManage, onChanged }: { profile: Profile; refreshable: boolean; onManage: () => void; onChanged: () => void }) {
  const first = profile.seats[0];
  return (
    <aside
      aria-label="Details"
      data-testid="profile-pane"
      className="manta-agents-details min-w-0 rounded-lg bg-bg-elev p-4 top-4 [@container(min-width:720px)]:sticky [[data-theme=dark]_&]:shadow-[inset_0_0_0_1px_var(--border-subtle)]"
    >
      <PaneGroup title="Details" testId="profile-details">
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-label">
          {detailRows(profile).map(([k, v]) => (
            <Fragment key={k}>
              <dt className="text-text-faint">{k}</dt>
              <dd className="m-0 min-w-0 break-words text-right text-text">{v}</dd>
            </Fragment>
          ))}
        </dl>
      </PaneGroup>
      <SeatsGroup profile={profile} onManage={onManage} />
      {first && first.memory.length > 0 && (
        <section data-testid="profile-access" className="border-t border-border pt-4 mt-5 [[data-theme=dark]_&]:border-border-subtle">
          <MemoryMap seat={first} compact />
        </section>
      )}
      {refreshable && <RefreshControl profile={profile} onChanged={onChanged} />}
    </aside>
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
  const [settled, setSettled] = useState<ReadonlyMap<string, AgentChange>>(new Map());
  const [actionError, setActionError] = useState<string | null>(null);
  const [openingChat, setOpeningChat] = useState(false);
  const base = useId();
  const tabRefs = useRef<Partial<Record<ProfileTab, HTMLButtonElement | null>>>({});

  // Another agent: start from its Overview.
  useEffect(() => {
    setTab("overview");
    setSettled(new Map());
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

  // The cards shown above the tabs: every pending record, and any this page settled (they keep their card, in the new state).
  const cards = useMemo(() => {
    const records = history.data ?? [];
    const live = records.filter((r) => r.state === "pending" || settled.has(r.id)).map((r) => settled.get(r.id) ?? r);
    return live;
  }, [history.data, settled]);
  const cardIds = useMemo(() => new Set(cards.map((c) => c.id)), [cards]);
  const snapshot = useMemo(() => currentSnapshot(history.data ?? []), [history.data]);

  const p = profile.data;
  const name = p?.info.name || slug;
  const crumbs = (
    <Crumbs trail={[{ label: "Agents", onClick: onBack }]} current={name} />
  );
  const shell = (body: ReactNode) => (
    <div className="manta-agents-pane manta-agents-profile flex h-full w-full flex-col bg-bg" data-screen="agents-profile">
      <AgentsHeader>{crumbs}</AgentsHeader>
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
  const refreshable = info.role === "specialist";

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
          <Button tone="ghost" onClick={() => openChangeAgentDraft(info.slug)} title="Opens a chat with Manta to describe the change">
            Change via Manta
          </Button>
          {!isArchitect && (
            <Button tone="default" loading={openingChat} onClick={() => void openChat()} title="Talk to this agent directly">
              Chat
            </Button>
          )}
          <Button
            tone="primary"
            onClick={() => openMentionDraft(info.slug, seatFolder(p.seats[0], useStore.getState().projects))}
            title="Opens a chat with this agent mentioned"
          >
            Mention in a chat
          </Button>
        </div>
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

  const records = history.data;
  const tabs = PROFILE_TABS.map((t) => ({
    ...t,
    text:
      t.id === "research"
        ? `Research · ${p.research.length}`
        : t.id === "seats"
          ? info.role === "specialist"
            ? `Seats · ${p.seats.length}`
            : "Seats"
          : t.id === "history"
            ? records ? `History · ${records.length}` : "History"
            : t.label,
  }));
  const tabIds = PROFILE_TABS.map((t) => t.id);
  const tabId = (id: ProfileTab) => `${base}-tab-${id}`;

  const onTabKey = (e: React.KeyboardEvent<HTMLButtonElement>, id: ProfileTab) => {
    const next = nextTab(id, e.key, tabIds);
    if (!next) return;
    e.preventDefault();
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  const overview = (
    <div className="[container-type:inline-size]">
      <div data-testid="profile-overview-grid" className="grid grid-cols-1 items-start gap-8 [@container(min-width:720px)]:grid-cols-[minmax(0,1fr)_18rem]">
        <div data-testid="profile-main" className="flex min-w-0 flex-col gap-8">
          <HowToUse profile={p} snapshot={snapshot} />
          <section data-testid="profile-research-block">
            <BlockTitle aside={p.research.length > 0 ? <LinkButton spaced={false} onClick={() => setTab("research")}>{`All ${p.research.length} →`}</LinkButton> : undefined}>Research it relies on</BlockTitle>
            <ResearchRows entries={p.research} limit={OVERVIEW_PREVIEW.research} emptyText="Nothing yet. The research this agent's changes rest on shows here." />
            {p.research.length > 0 && <p className="m-0 mt-2 text-meta text-text-faint">From the shared research library. Thin means fewer than 3 independent sources.</p>}
          </section>
        </div>
        <DetailsPane profile={p} refreshable={refreshable} onManage={() => setTab("seats")} onChanged={() => void profile.reload()} />
      </div>
    </div>
  );

  return shell(
    <div className="flex flex-col gap-6">
      {header}
      {actionErrorLine}
      {cards.length > 0 && (
        <div className="flex flex-col" style={{ gap: "var(--block-gap)" }} data-testid="profile-pending">
          {cards.map((c) => (
            <AgentChangeView
              key={c.id}
              change={c}
              collapsed
              onChange={(next) => {
                setSettled((m) => new Map(m).set(next.id, next));
                reloadAll();
              }}
            />
          ))}
        </div>
      )}
      <div>
        <div role="tablist" aria-label={`${info.name || slug}`} className="manta-agents-tabs flex gap-5 overflow-x-auto border-b border-border text-label">
          {tabs.map((t) => (
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
              {t.text}
            </button>
          ))}
        </div>
        <div role="tabpanel" aria-labelledby={tabId("overview")} hidden={tab !== "overview"}>
          <div className="pt-4">{overview}</div>
        </div>
        <div role="tabpanel" aria-labelledby={tabId("research")} hidden={tab !== "research"}>
          <div className="pt-4">
            <ResearchRows entries={p.research} emptyText="Nothing yet. The research this agent's changes rest on shows here." />
            <p className="m-0 mt-2 text-meta text-text-faint">From the shared research library. Thin means fewer than 3 independent sources.</p>
          </div>
        </div>
        <div role="tabpanel" aria-labelledby={tabId("seats")} hidden={tab !== "seats"}>
          <div className="pt-4">
            <AgentSeats profile={p} projects={projects.data ?? null} fleet={fleet.data ?? null} onChanged={reloadAll} />
          </div>
        </div>
        <div role="tabpanel" aria-labelledby={tabId("history")} hidden={tab !== "history"}>
          <div className="pt-4">
            <HistoryState history={history}>
              {(rows) => (
                <AgentHistory
                  records={rows}
                  cardsAbove={cardIds}
                  onChanged={() => {
                    void profile.reload();
                    void history.reload();
                  }}
                />
              )}
            </HistoryState>
          </div>
        </div>
      </div>
    </div>,
  );
}
