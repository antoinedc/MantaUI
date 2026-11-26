// ===== The agent profile (agent screens spec §2.2) =====
//
// One agent, one page: a header (name, facts, description, actions), its pending change cards, then the tabs Overview ·
// Research · Seats · History (Tests comes later). The tabs are the `tabs` guide's hand-written tablist: a button per tab with
// `aria-selected`, a roving tab stop, arrows / Home / End that move AND select (selection follows focus), the selected tab
// underlined by a border on a pseudo-element, every panel in the markup with `hidden` on all but the selected one. `focusgroup`
// is not available in the bundled Chromium, so the ~15-line key handler stays (nextTab).
//
// Reads: the profile, the agent's history (shared by the Overview preview, the History tab and the pending cards), the fleet
// (each seat's current task) and the registry's projects (for Add a seat). The last two are soft: a failed read leaves out what
// they feed. Every press ends visibly: a draft opens, a window opens, a sentence says why not.

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Folder } from "lucide-react";
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
import { AgentsHeader, BlockTitle, Crumbs } from "./AgentsParts";
import { OVERVIEW_PREVIEW, PROFILE_TABS, currentSnapshot, errText, factsLine, nextTab, seatFolder, seatNotesLabel, type ProfileTab } from "./agentsView";
import { useAgentsRead, type AgentsRead } from "./useAgentsRead";
import { openChatWindow } from "./useOpenTask";

const TAB_CLASS =
  "relative flex-none whitespace-nowrap py-2 text-text-faint hover:text-text aria-selected:text-text " +
  "aria-selected:after:absolute aria-selected:after:inset-x-0 aria-selected:after:bottom-0 aria-selected:after:border-b-2 aria-selected:after:border-accent aria-selected:after:content-[''] " +
  "disabled:cursor-not-allowed disabled:text-text-quiet disabled:hover:text-text-quiet " +
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent";

const Block = ({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) => (
  <section data-testid={testId}>
    <BlockTitle>{title}</BlockTitle>
    {children}
  </section>
);

const LinkButton = ({ onClick, children }: { onClick: () => void; children: ReactNode }) => (
  <button type="button" onClick={onClick} className="mt-2 rounded-sm text-meta font-medium text-accent-tx hover:underline focus-visible:outline-2 focus-visible:outline-accent">
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
    <Block title="Refresh with new research" testId="profile-refresh">
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
    </Block>
  );
}

function Charter({ profile, snapshot }: { profile: Profile; snapshot: string | null }) {
  const { info } = profile;
  const instructions = useMemo(() => (snapshot ? parseAgentMdView(snapshot)?.body || null : null), [snapshot]);
  const Row = ({ k, v }: { k: string; v: string }) => (
    <li>
      <b className="font-semibold text-text">{k}</b> {v}
    </li>
  );
  return (
    <Block title="Charter" testId="profile-charter">
      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-label text-text-muted">
        <Row k="Does:" v={info.description} />
        {info.useWhen && <Row k="Use when:" v={info.useWhen} />}
        {info.notFor && <Row k="Not for:" v={info.notFor} />}
        <Row k="Works:" v={info.isolation === "worktree" ? "edits code on its own branch" : "Read-only, it doesn't edit code"} />
        <Row k="Model:" v={info.model || "Auto"} />
      </ul>
      {instructions && (
        <details className="mt-2">
          <summary className="cursor-pointer text-meta font-medium text-text-muted">Instructions</summary>
          <pre className="m-0 mt-2 whitespace-pre-wrap break-words rounded-md bg-fill px-3 py-2 text-meta text-text-muted">{instructions}</pre>
        </details>
      )}
    </Block>
  );
}

function SeatsPreview({ profile, onManage }: { profile: Profile; onManage: () => void }) {
  const everywhere = profile.info.role === "lead" || profile.info.role === "architect";
  return (
    <Block title="Seats">
      {everywhere ? (
        <p className="m-0 text-label text-text-muted">Works in every project.</p>
      ) : (
        <>
          {profile.seats.length === 0 ? (
            <p className="m-0 text-label text-text-faint">No seats yet.</p>
          ) : (
            <ul className="m-0 flex list-none flex-col p-0">
              {profile.seats.map((s) => (
                <li key={s.project} className="flex items-center gap-2 border-b border-border-subtle py-2 text-label">
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
    </Block>
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
    <div className="flex items-start gap-3" data-testid="profile-header">
      <AgentBadge size="lg" agent={{ name: info.name, slug: info.slug, color: info.color }} />
      <div className="min-w-0 flex-1">
        <h2 className="m-0 text-title font-semibold text-text">{info.name || slug}</h2>
        {!info.error && (
          <div className="mt-1 flex flex-wrap gap-x-3 text-meta text-text-faint">
            {factsLine(p).map((f) => (
              <span key={f}>{f}</span>
            ))}
          </div>
        )}
        <p className="m-0 mt-2 max-w-[70ch] text-label text-text-muted">{info.description}</p>
      </div>
      {!info.error && (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <Button tone="default" onClick={() => openChangeAgentDraft(info.slug)} title="Opens a chat with Manta to describe the change">
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
    <div className="grid grid-cols-[repeat(auto-fit,minmax(20rem,1fr))] gap-6">
      <div className="flex min-w-0 flex-col gap-6">
        <Charter profile={p} snapshot={snapshot} />
        <Block title="Research it relies on">
          <ResearchRows entries={p.research} limit={OVERVIEW_PREVIEW.research} emptyText="Nothing yet. The research this agent's changes rest on shows here." />
          {p.research.length > 0 && <LinkButton onClick={() => setTab("research")}>{`All research (${p.research.length})`}</LinkButton>}
        </Block>
        <Block title="History">
          <HistoryState history={history}>
            {(rows) => (
              <>
                <AgentHistory records={rows} preview={OVERVIEW_PREVIEW.history} />
                {rows.length > 0 && <LinkButton onClick={() => setTab("history")}>{`All history (${rows.length})`}</LinkButton>}
              </>
            )}
          </HistoryState>
        </Block>
      </div>
      <div className="flex min-w-0 flex-col gap-6">
        <SeatsPreview profile={p} onManage={() => setTab("seats")} />
        <MemoryMap seat={p.seats[0]} />
        {refreshable && <RefreshControl profile={p} onChanged={() => void profile.reload()} />}
        <Block title="Tests">
          <div className="rounded-md border border-dashed border-border px-3 py-2 text-meta text-text-faint">
            <b className="font-semibold">Coming later.</b> Trial runs on sample tasks will show here.
          </div>
        </Block>
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
          <button type="button" role="tab" disabled aria-selected={false} tabIndex={-1} title="Trial runs on sample tasks come later" className={TAB_CLASS}>
            Tests — later
          </button>
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
