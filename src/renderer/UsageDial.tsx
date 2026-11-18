// ===== Usage dial + popover (BET-738) =====
//
// The composer icon row's subscription-usage meter: a 16px ring trigger plus
// a detail popover. Renders through the shared portalled Popover primitive
// (BET-865) — trigger and panel stay siblings, and the panel is portalled to
// <body> so it can never be clipped or stacked behind the transcript.
//
// THIS IS NOT THE CONTEXT-WINDOW PILL. ContextPill (SessionHeader.tsx) is
// per-CONVERSATION token usage; this is per-SUBSCRIPTION plan usage (BET-737's
// engine). Different data source, different colour scale, different
// placement — the whole point is that the two meters can never be confused.
// Never share code, colours, or thresholds between them.

import { Fragment, lazy, memo, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { ProviderView, SeatProviderId, SeatView, UsageWindow } from "../shared/types";
import {
  combinedSeatWindows,
  cssVar,
  findSeat,
  formatUpdatedAgo,
  formatWindowReset,
  hasSeatChoice,
  isMoveComing,
  isSameOrgMove,
  nextSeatHint,
  orderOtherSeats,
  seatDialSnapshot,
  seatStateText,
  selectConversationSeat,
  selectProviderView,
  selectUsageSnapshot,
  usageDialState,
  usageStale,
  usageWindowBlocker,
  usageColumnHeader,
  usagePopoverMinWidth,
  usageTableColumns,
  windowProgress,
  windowResetState,
  type UsageDialTone,
} from "./chatUtils";
import { useStore } from "./store";
import { Popover } from "./Popover";
import { Pill } from "./Pill";
import { ResetTimer } from "./ResetTimer";
import { openAccountsSettings, refreshAccounts, refreshSessionSeat } from "./accountsData";
import { CROSS_ORG_CONFIRM_COPY, useSeatSwitch } from "./hooks/useSeatSwitch";

// The re-sign modal pulls in the Claude terminal (xterm) — load it only when a
// "Logged out" badge is actually pressed, not with every composer.
const ResignSeatFlow = lazy(() => import("./ResignSeatFlow").then((m) => ({ default: m.ResignSeatFlow })));

/** The seat a "Logged out" badge was pressed on. */
type ResignTarget = { provider: SeatProviderId; seat: SeatView; accountLabel: string };

// Lucide icons render a 24-unit viewBox scaled to size. A stroked circle
// draws r ± strokeWidth/2 (the stroke straddles the path), so at size 16 the
// Clock's outer disc spans (2·10 + 2)/24·16 = 22/24 of the box and its ring
// is 2/24 of the box. The dial mirrors that drawn geometry exactly.
const ICON_PX = 16;
import { mbtn } from "./ComposerParts";

// The ONLY provider-name-aware thing in this file — an icon/label lookup
// table, explicitly the one exception the spec allows ("nothing in the
// renderer may know a provider name beyond an icon/label lookup table").
// Falls back to Title-Casing the snapshot's own `provider` id for any
// adapter this table doesn't know about yet, so a 4th adapter needs no
// renderer change. Exported so the usage escalation toasts (BET-739) reuse
// the same single lookup instead of duplicating it.
const PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "OpenAI",
  kimi: "Kimi",
};

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

// The ONE usage colour ladder — the ring and every popover row go through it,
// so a user glancing at the ring and then opening the popover can never see
// two different colours for the same number. (An earlier spec kept the ring
// off --ok below 70 so it read as "pay attention only"; that produced a grey
// ring above a green bar.)
// The tone itself is the BOX's (`window.tone`, WS09 SF-M18). A window with no
// tone (an older box) renders in the neutral track colour — no colour is
// invented here.
function toneRingColor(tone: UsageDialTone | null | undefined): string {
  if (tone == null) return cssVar("--border-strong") || cssVar("--tx4");
  if (tone === "over" || tone === "danger") return cssVar("--danger");
  if (tone === "warn") return cssVar("--warn");
  return cssVar("--ok");
}

type UsageDialProps = {
  // The active model's opencode providerID (e.g. "anthropic"), already
  // resolved by ChatPanel via resolveActiveModel and threaded through
  // InputArea — this component never re-resolves the model itself.
  providerID: string | null;
  // The conversation this dial belongs to (multi-account): the ring shows the
  // seat THIS conversation is on. Absent on the pre-session composer, where the
  // ring shows the provider snapshot as it always did.
  sessionId?: string | null;
};

export const UsageDial = memo(function UsageDial({ providerID, sessionId = null }: UsageDialProps) {
  const snapshots = useStore((s) => s.usage);
  const alwaysShow = useStore((s) => s.alwaysShowUsage);
  const accounts = useStore((s) => s.accounts);
  const sessionSeat = useStore((s) => (sessionId ? s.sessionSeats[sessionId] ?? null : null));
  const [open, setOpen] = useState(false);
  // The re-sign modal is mounted HERE, outside the popover: the popover closes on
  // any outside click, which would otherwise tear the sign-in down mid-flow.
  const [resign, setResign] = useState<ResignTarget | null>(null);
  const closeResign = useCallback(() => setResign(null), []);
  // Snapshotted at open time (not a ticking clock) — cheap, deterministic,
  // and accurate enough for a short-lived popover.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Seat awareness exists only for a provider with >=2 seats. With one seat
  // (or no seat info at all) `current` stays null and everything below is the
  // plain provider snapshot — byte-for-byte today's dial.
  const view = selectProviderView(accounts, snapshots, providerID);
  const multi = hasSeatChoice(view);
  const current = multi ? selectConversationSeat(view, sessionSeat) : null;
  const base = selectUsageSnapshot(snapshots, providerID);
  const snapshot = base ? seatDialSnapshot(base, current) : null;
  // The popover keeps this conversation's seat; only the ring and its tooltip
  // switch to the all-seats figure, and only in automatic mode.
  const combined = multi && view?.mode === "auto" ? combinedSeatWindows(view) : null;
  const popoverState = usageDialState(snapshot, alwaysShow);
  const state =
    snapshot && combined
      ? usageDialState({ ...snapshot, windows: combined.windows }, alwaysShow, { applyBlocking: false })
      : popoverState;
  const moveComing = isMoveComing(view, current, nowMs);

  // Learn which seat this conversation is on (cached in the store; kept
  // current by `accounts.moved`, and re-read whenever the popover opens).
  useEffect(() => {
    if (multi && sessionId) void refreshSessionSeat(sessionId);
  }, [multi, sessionId]);

  // No data / no matching snapshot / adapter failed / below threshold with
  // the opt-in off → render nothing. Absence is the healthy signal.
  const resignModal = resign ? (
    <Suspense fallback={null}>
      <ResignSeatFlow
        provider={resign.provider}
        seatId={resign.seat.id}
        seatLabel={resign.seat.label}
        accountLabel={resign.accountLabel}
        email={resign.seat.email}
        onDone={closeResign}
        onCancel={closeResign}
      />
    </Suspense>
  ) : null;

  // (A sign-in in progress outlives the dial's own visibility.)
  if (!snapshot || !state.visible) return resignModal;

  // No assignment yet (a brand-new conversation): the windows are the aggregate —
  // the seat a new conversation would start on. The seat the table leads with is
  // this conversation's, or where a new one starts.
  const startsOn =
    multi && !current && view ? findSeat(view, view.mode === "manual" ? view.activeSeatId : view.nextSeatId) : null;
  const headerSeat = current ?? startsOn;
  const groups = multi ? orderOtherSeats(view, headerSeat?.seat.id ?? null) : [];
  const columns = usageTableColumns(snapshot.windows, [
    headerSeat?.seat.windows,
    ...groups.flatMap((g) => g.seats.map((s) => s.windows)),
  ]);

  const ringColor = toneRingColor(state.tone);
  const trackColor = cssVar("--border-subtle");
  const pctClamped = Math.max(0, Math.min(100, state.pct));
  const label = providerLabel(snapshot.provider);
  const windowLabel = state.window?.label ?? "usage";
  const resetLine = formatWindowReset(state.window?.resetsAt, nowMs);
  const seatName = current
    ? current.account.seats.length > 1
      ? `${current.account.label} · ${current.seat.label}`
      : current.account.label
    : null;
  const lead = seatName ? `${label} · ${seatName}` : label;
  const blockedReset = state.blockedBy ? formatWindowReset(state.blockedBy.resetsAt, nowMs) : null;
  const nextReset = resetLine?.startsWith("resets ") ? `next reset ${resetLine.slice(7)}` : resetLine;
  const title =
    (combined
      ? state.awaitingReset
        ? `${label} · the ${windowLabel} quota is resetting on every seat`
        : `${label} · ${pctClamped}% of the ${windowLabel} across ${combined.seatCount} seats` +
          (nextReset ? ` — ${nextReset}` : "")
      : state.blockedBy
        ? `${lead} · the ${state.blockedBy.label} limit is used up` +
          (blockedReset ? ` — ${blockedReset}` : "")
        : state.awaitingReset
          ? `${lead} · the ${windowLabel} quota is resetting`
          : `${lead} · ${pctClamped}% of the ${windowLabel}` + (resetLine ? ` — ${resetLine}` : "")) +
    (moveComing ? " · this conversation will move to another seat soon" : "") +
    " · click for details";

  return (
    <>
      {resignModal}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          setNowMs(Date.now());
          if (!open) {
            // Fresh seat data every time the popover opens (§7a "Data").
            void refreshAccounts();
            void refreshSessionSeat(sessionId);
          }
          setOpen((v) => !v);
        }}
        className={`manta-usage-dial ${mbtn}${open ? " bg-fill-active" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="plan usage"
        title={title}
      >
        {/* A 16×16 BOX holding a disc sized to a stroked lucide circle. The
            box keeps the button's metrics identical to the 16px lucide icons
            beside it (so the row does not shift), while the disc matches what
            those icons actually DRAW: a lucide circle is r=10 stroked at
            strokeWidth=2 in a 24 viewBox, and the stroke straddles the path,
            so the drawn outer is (2·10 + 2)/24 of the box and the ring is
            2/24 of the box, both scaled by the 16px icon size. */}
        <span
          aria-hidden="true"
          className={
            "inline-flex items-center justify-center" +
            (state.awaitingReset ? " animate-pulse" : "")
          }
          style={{ width: 16, height: 16 }}
        >
          <span
            aria-hidden="true"
            className="relative block rounded-full"
            style={{
              width: (22 / 24) * ICON_PX,
              height: (22 / 24) * ICON_PX,
              background:
                state.tone === "over"
                  ? ringColor
                  : `conic-gradient(${ringColor} 0% ${pctClamped}%, ${trackColor} ${pctClamped}% 100%)`,
            }}
          >
            {/* Inner disc in the surrounding surface colour turns the pie into
                a ring — skipped for tone "over" (>=100%), which is a solid
                disc with no hole per the design spec. The stroke straddles
                the circle path, so the inner hole is (2·10 - 2)/24 of the box
                and sits in by the ring width 2/24, both scaled by the 16px
                icon size — matching the neighbours' strokeWidth={2}
                (unchanged from BET-756). */}
            {state.tone !== "over" && (
              <span
                aria-hidden="true"
                className="block rounded-full bg-bg"
                style={{
                  width: (18 / 24) * ICON_PX,
                  height: (18 / 24) * ICON_PX,
                  margin: (2 / 24) * ICON_PX,
                }}
              />
            )}
            {/* Automatic mode, seat past the move line and rule 3 would move
                this conversation: the ring keeps its tone, a small ↷ says a
                move is coming. */}
            {moveComing && (
              <span
                aria-hidden="true"
                data-move-coming="true"
                className="manta-usage-move absolute flex items-center justify-center rounded-full bg-bg border border-border text-text font-bold leading-none"
                style={{ top: -5, right: -7, width: 11, height: 11, fontSize: 9 }}
              >
                ↷
              </span>
            )}
          </span>
        </span>
      </button>

      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={triggerRef}
        placement="above"
        align="end"
        role="dialog"
        ariaLabel="Plan usage"
        hook="manta-usage-popover"
        // Sized to its content: at least 420px, wider when a row needs it (long
        // seat/account names, credit lines), capped by the window. Free-flowing
        // prose below opts out of driving the width (`w-0 min-w-full`) so a
        // sentence wraps instead of stretching the card. It never scrolls while
        // it fits; the height cap + overflow-y is ONLY the last resort for a
        // card taller than the window, so the footer and a seat-switch confirm
        // stay reachable instead of being clipped off-screen.
        surfaceClassName="w-max min-w-[420px] max-w-[calc(100vw-16px)] max-h-[calc(100vh-16px)] overflow-y-auto overflow-x-hidden p-4"
        // A third window column needs room: 110px more for each one past two.
        surfaceStyle={columns.length > 2 ? { minWidth: `min(${usagePopoverMinWidth(columns.length)}px, calc(100vw - 16px))` } : undefined}
      >
        <UsagePopoverBody
          snapshot={snapshot}
          state={popoverState}
          label={label}
          view={view}
          multi={multi}
          current={current}
          headerSeat={headerSeat}
          groups={groups}
          columns={columns}
          nowMs={nowMs}
          onNavigate={() => setOpen(false)}
          onResign={(target) => {
            setOpen(false);
            setResign(target);
          }}
        />
      </Popover>
    </>
  );
});

// The popover's content. One seat / one subscription renders exactly what it
// always did (header, windows, extras, footer); every seat-aware section below
// is skipped — never rendered empty — unless there is something to say.
function UsagePopoverBody({
  snapshot,
  state,
  label,
  view,
  multi,
  current,
  headerSeat,
  groups,
  columns,
  nowMs,
  onNavigate,
  onResign,
}: {
  snapshot: UsageSnapshotLike;
  state: ReturnType<typeof usageDialState>;
  label: string;
  view: ProviderView | null;
  multi: boolean;
  current: ReturnType<typeof selectConversationSeat>;
  headerSeat: ReturnType<typeof selectConversationSeat>;
  groups: ReturnType<typeof orderOtherSeats>;
  columns: UsageWindow[];
  nowMs: number;
  onNavigate: () => void;
  onResign: (target: ResignTarget) => void;
}) {
  const switcher = useSeatSwitch(view);
  const nextId = view && view.mode === "auto" ? nextSeatHint(view, current?.seat.id ?? null, nowMs) : null;

  const seatName = (c: { seat: SeatView; account: { label: string; seats: SeatView[] } }) =>
    c.account.seats.length > 1 ? `${c.account.label} · ${c.seat.label}` : c.account.label;

  const resignTarget = (seat: SeatView, accountLabel: string): ResignTarget | null =>
    view ? { provider: view.provider, seat, accountLabel } : null;

  // The leading, highlighted row: this conversation's seat (or where a new one
  // starts); with no seat choice, the subscription itself, from the snapshot.
  const firstRow: SeatTableFirst | null = headerSeat
    ? {
        seat: headerSeat.seat,
        name: seatName(headerSeat),
        sub: current ? "this conversation" : "new conversations start here",
        windows: headerSeat.seat.windows,
        onResign: () => {
          const t = resignTarget(headerSeat.seat, headerSeat.account.label);
          if (t) onResign(t);
        },
      }
    : multi
      ? null
      : {
          seat: null,
          name: view?.accounts[0]?.label ?? snapshot.planLabel ?? label,
          sub: "this conversation",
          windows: snapshot.windows,
          onResign: null,
        };

  const manage = (provider?: ProviderView["provider"]) => {
    onNavigate();
    openAccountsSettings(provider);
  };

  return (
    <>
      <div className="flex items-baseline justify-between gap-2 mb-3">
        <span className="text-prose font-semibold text-text">{label}</span>
        <span className="flex items-baseline gap-2 min-w-0">
          {snapshot.planLabel && (
            <span className="text-meta text-text-faint truncate">{snapshot.planLabel}</span>
          )}
          {multi && view && (
            <span
              className="manta-seat-mode shrink-0"
              title={
                view.mode === "auto"
                  ? "Automatic: Manta picks a seat per conversation"
                  : "Manual: every conversation uses the seat you chose"
              }
            >
              <Pill tone="neutral" border>
                {view.mode === "auto" ? "Automatic" : "Manual"}
              </Pill>
            </span>
          )}
        </span>
      </div>

      {state.awaitingReset && (
        <div className="mb-3 w-0 min-w-full break-words text-meta text-text-faint">
          Quota is being reset. Usage numbers might look off for a few minutes.
        </div>
      )}

      <SeatTable
        view={multi ? view : null}
        columns={columns}
        first={firstRow}
        groups={groups}
        nextId={nextId}
        nowMs={nowMs}
        switcher={switcher}
        onResign={(seat, accountLabel) => {
          const t = resignTarget(seat, accountLabel);
          if (t) onResign(t);
        }}
      />
      {snapshot.windows.some((w) => w.tone == null) && (
        <div className="mt-2 w-0 min-w-full break-words text-meta text-text-faint">Update your box to see usage colours.</div>
      )}

      {snapshot.extras && snapshot.extras.length > 0 && (
        <div className="mt-3 pt-3 border-t border-border-subtle flex flex-col gap-1">
          {snapshot.extras.map((e) => (
            <div key={e.label} className="flex items-center justify-between gap-3 text-meta">
              <span className="text-text-faint">{e.label}</span>
              <span className="min-w-0 break-words text-right text-text-muted font-mono">{e.value}</span>
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 pt-3 border-t border-border-subtle flex items-center justify-between gap-2">
        {multi ? (
          <button
            type="button"
            onClick={() => manage(view?.provider)}
            className="text-meta text-text-muted underline decoration-dotted hover:text-text"
          >
            Manage seats
          </button>
        ) : (
          <span />
        )}
        <span
          className={
            "text-meta " +
            (usageStale(snapshot.fetchedAt, nowMs) ? "text-warn" : "text-text-faint")
          }
        >
          {formatUpdatedAgo(snapshot.fetchedAt, nowMs)}
        </span>
      </div>
    </>
  );
}

// The warn badge on a seat whose login is dead. It IS the control: pressing it
// opens the sign-in for that seat. The title says whether it expired or was
// signed out.
function LoggedOutBadge({ seat, onClick }: { seat: SeatView; onClick: () => void }) {
  const why = seatStateText(seat.status);
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="seat-logged-out"
      title={`${seat.label}: ${why ?? "logged out"} — click to sign it back in`}
      className="manta-seat-logged-out shrink-0 rounded-full px-2 text-label font-semibold bg-warn-bg text-warn hover:opacity-80"
    >
      Logged out
    </button>
  );
}

type UsageSnapshotLike = NonNullable<ReturnType<typeof selectUsageSnapshot>>;

const clampPct = (n: number) => Math.max(0, Math.min(100, n));

// A usage bar: the coloured fill is how much of the quota is used, the small
// white dot is how far through its window "now" is (fill ahead of the dot =
// burning faster than the window). No dot when the position isn't known.
export function WindowBar({ w, nowMs }: { w: UsageWindow; nowMs: number }) {
  const empty = windowResetState(w, nowMs) === "resetting";
  const progress = windowProgress(w, nowMs);
  return (
    <span
      className="relative block h-[3px] w-full rounded-full bg-fill-active"
      title={progress != null ? `${Math.round(progress * 100)}% of the way through this window` : undefined}
    >
      <span
        className="absolute inset-y-0 left-0 rounded-full"
        style={{
          width: `${empty ? 0 : clampPct(w.pct)}%`,
          backgroundColor: toneRingColor(empty ? "under" : w.tone),
        }}
      />
      {progress != null && (
        // Painted as a gradient on a full-size overlay rather than as a small
        // positioned element: its centre is then exactly the bar's centre line at
        // any row offset, instead of snapping to a different pixel than the bar.
        // White core 1px in radius, ring out to 1.5px, soft edge.
        <span
          data-window-dot="true"
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-full"
          style={{
            backgroundImage: `radial-gradient(circle at ${Math.max(4, Math.min(96, progress * 100))}% 50%, var(--usage-dot) 1px, var(--usage-dot-ring) 1.2px 1.5px, transparent 1.8px)`,
          }}
        />
      )}
    </span>
  );
}

type SeatTableFirst = {
  /** The seat behind the row; null for a subscription with no seat choice. */
  seat: SeatView | null;
  name: string;
  sub: string;
  windows: UsageWindow[];
  onResign: (() => void) | null;
};

// The usage table: one row per seat, each with its 5-hour and weekly window as a
// figure + countdown + bar. The conversation's seat (or the one a new
// conversation starts on) leads, highlighted; the rest follow in the box's
// order. A subscription with no seat choice is the same table with one row.
function SeatTable({
  view,
  columns,
  first,
  groups,
  nextId,
  nowMs,
  switcher,
  onResign,
}: {
  view: ProviderView | null;
  columns: UsageWindow[];
  first: SeatTableFirst | null;
  groups: ReturnType<typeof orderOtherSeats>;
  nextId: string | null;
  nowMs: number;
  switcher: ReturnType<typeof useSeatSwitch>;
  onResign: (seat: SeatView, accountLabel: string) => void;
}) {
  if (columns.length === 0) return null;
  const span = columns.length + 1;
  return (
    <div className="w-0 min-w-full" data-testid="usage-seat-table">
      <table className="manta-seat-list w-full table-fixed border-collapse text-label">
        <colgroup>
          <col />
          {columns.map((c) => (
            <col key={c.kind} style={{ width: 118 }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th className="pb-[6px] pl-2 text-left text-micro font-medium uppercase text-text-faint">Seat</th>
            {columns.map((c) => {
              const head = usageColumnHeader(c);
              return (
                <th key={c.kind} title={head.title} className="pb-[6px] pl-[14px] text-left text-micro font-medium uppercase text-text-faint">
                  {head.text}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {first && (
            <SeatRow
              seat={first.seat}
              name={first.name}
              sub={first.sub}
              windows={first.windows}
              highlighted
              isNext={false}
              columns={columns}
              view={view}
              nowMs={nowMs}
              switcher={switcher}
              onResign={first.onResign}
              span={span}
            />
          )}
          {groups.map((g) => (
            <Fragment key={g.accountId}>
              {g.showHeading && (
                <tr>
                  <td colSpan={span} className="truncate pl-2 pt-2 text-meta text-text-faint">
                    {g.label}
                  </td>
                </tr>
              )}
              {g.seats.map((seat) => (
                <SeatRow
                  key={seat.id}
                  seat={seat}
                  name={seat.label}
                  sub={null}
                  windows={seat.windows}
                  highlighted={false}
                  isNext={nextId === seat.id}
                  columns={columns}
                  view={view}
                  nowMs={nowMs}
                  switcher={switcher}
                  onResign={() => onResign(seat, g.label)}
                  span={span}
                />
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SeatRow({
  seat,
  name,
  sub,
  windows,
  highlighted,
  isNext,
  columns,
  view,
  nowMs,
  switcher,
  onResign,
  span,
}: {
  seat: SeatView | null;
  name: string;
  sub: string | null;
  windows: UsageWindow[];
  highlighted: boolean;
  isNext: boolean;
  columns: UsageWindow[];
  view: ProviderView | null;
  nowMs: number;
  switcher: ReturnType<typeof useSeatSwitch>;
  onResign: (() => void) | null;
  span: number;
}) {
  const broken = seat ? seatStateText(seat.status) : null;
  const confirming = seat != null && switcher.confirmId === seat.id;
  const busy = seat != null && switcher.busyId === seat.id;
  const crossOrg = seat != null && view != null && !isSameOrgMove(view, view.activeSeatId, seat.id);
  const cell = "border-t border-border-subtle pt-2 pb-[9px] align-top" + (highlighted ? " bg-accent-bg" : "");
  return (
    <>
      <tr data-seat-id={seat?.id} data-current={highlighted ? "true" : undefined}>
        <td
          className={`${cell} pl-2 break-words`}
          style={highlighted ? { boxShadow: "inset 2px 0 0 var(--accent)" } : undefined}
        >
          <div className="flex flex-wrap items-center gap-x-1 text-text">
            <span className="min-w-0 break-words">{name}</span>
            {seat && broken && onResign && <LoggedOutBadge seat={seat} onClick={onResign} />}
            {isNext && (
              <span
                className="manta-seat-next shrink-0 rounded-xs px-1 text-meta bg-accent-bg text-accent"
                title="Where a move would go"
              >
                next
              </span>
            )}
          </div>
          {sub && <div className="text-meta text-text-faint">{sub}</div>}
          {seat && !highlighted && view?.mode === "manual" && (
            <button
              type="button"
              onClick={() => switcher.request(seat)}
              disabled={switcher.busyId !== null || broken !== null}
              title={broken ? `${seat.label} is ${broken} — sign it back in first` : `Use ${seat.label} for every conversation`}
              className="text-meta text-text-muted underline decoration-dotted hover:text-text disabled:opacity-40"
            >
              {busy ? "…" : "Use this seat"}
            </button>
          )}
        </td>
        {columns.map((c, i) => (
          <td key={c.kind} className={`${cell} whitespace-nowrap pl-[14px] ${i === columns.length - 1 ? "pr-2" : ""}`}>
            <SeatWindowCell windows={windows} reference={c} nowMs={nowMs} />
          </td>
        ))}
      </tr>
      {seat && confirming && (
        <tr>
          <td colSpan={span} className="pb-2 pl-2 pr-2">
            <div role="alert" className="w-0 min-w-full break-words rounded-xs border border-border bg-bg px-2 py-1 text-label text-text-muted">
              <div>{crossOrg ? CROSS_ORG_CONFIRM_COPY : ""} Switch every conversation to {seat.label}?</div>
              <div className="mt-1 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void switcher.apply(seat)}
                  disabled={busy}
                  className="px-2 py-1 text-meta bg-bg-soft border border-border rounded-xs text-text hover:text-text disabled:opacity-40"
                >
                  {busy ? "…" : "Switch"}
                </button>
                <button
                  type="button"
                  onClick={switcher.cancel}
                  disabled={busy}
                  className="px-2 py-1 text-meta text-text-faint hover:text-text disabled:opacity-40"
                >
                  Cancel
                </button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// One row's reading for one column: the figure, the countdown only (never a
// date — the tooltip carries that), and the bar. Shares the popover's colour
// ladder (toneRingColor) so a seat can never read green here and red in the ring.
function SeatWindowCell({ windows, reference, nowMs }: { windows: UsageWindow[]; reference: UsageWindow; nowMs: number }) {
  if (windows.length === 0) return <span className="text-meta text-text-faint">no reading</span>;
  const w = windows.find((b) => b.kind === reference.kind);
  if (!w) return <span className="text-meta text-text-faint">—</span>;
  const state = windowResetState(w, nowMs);
  const blockedBy = usageWindowBlocker(windows, w);
  const hot = state !== "resetting" && (w.tone === "warn" || w.tone === "danger" || w.tone === "over");
  return (
    <div
      data-window-kind={w.kind}
      data-blocked={blockedBy ? "true" : undefined}
      className={blockedBy ? "opacity-40" : undefined}
      title={blockedBy ? `Not usable until the ${blockedBy.label} limit resets` : undefined}
    >
      <div className="mb-[5px] flex items-baseline justify-between gap-2">
        <span
          className={"font-mono font-medium tabular-nums" + (hot ? "" : " text-text")}
          style={hot ? { color: toneRingColor(w.tone) } : undefined}
        >
          {state === "resetting" ? "—" : `${Math.round(clampPct(w.pct))}%`}
        </span>
        {state === "scheduled" ? (
          <ResetTimer resetsAt={w.resetsAt as number} startedAt={w.startedAt} nowMs={nowMs} className="text-meta text-text-muted" />
        ) : state === "resetting" ? (
          <span className="text-meta text-text-faint">resetting…</span>
        ) : state === "not-started" ? (
          <span className="text-meta text-text-faint">not started</span>
        ) : null}
      </div>
      <WindowBar w={w} nowMs={nowMs} />
    </div>
  );
}

// One window's row (Settings → Accounts): label, right-aligned value, a 7px track
// + fill, and a reset line. The component iterates `snapshot.windows` — it
// never hardcodes "session"/"weekly" so a provider with a third window (or a
// daily one) renders with zero changes here.
export function UsageWindowRow({
  usageWindow: w,
  nowMs,
  blockedBy = null,
}: {
  usageWindow: UsageWindow;
  nowMs: number;
  // A longer, used-up window that makes this one unusable despite its own
  // headroom: the row keeps its figure but is greyed and says why.
  blockedBy?: UsageWindow | null;
}) {
  // Awaiting its replacement numbers: show no value and no fill rather than a
  // figure we know is the previous window's. The notice above the list says
  // why, and formatWindowReset already renders "resetting…" below.
  const awaitingReset = w.stale === true;
  // Not in force (a model-scoped cap on a model this plan isn't using): shown
  // greyed with no figure and no fill, so it can't be mistaken for real usage.
  const inactive = w.active === false;
  const pctClamped = awaitingReset || inactive ? 0 : Math.max(0, Math.min(100, w.pct));
  const fill = toneRingColor(awaitingReset || inactive ? "under" : w.tone);
  const value = inactive
    ? "not active"
    : awaitingReset
      ? "—"
      : w.used != null && w.limit != null
        ? `${w.used.toLocaleString()} / ${w.limit.toLocaleString()} · ${pctClamped}%`
        : `${pctClamped}%`;
  const resetLine = formatWindowReset(w.resetsAt, nowMs);
  const blocked = !inactive && blockedBy != null;
  const blockedLine = blocked ? `not usable until the ${blockedBy.label} limit resets` : null;

  return (
    <div
      className={inactive || blocked ? "opacity-50" : undefined}
      data-inactive={inactive ? "true" : undefined}
      data-blocked={blocked ? "true" : undefined}
    >
      <div className="flex items-center justify-between text-meta mb-1">
        <span className="text-text-muted">{w.label}</span>
        <span className="font-mono font-medium text-text tabular-nums">{value}</span>
      </div>
      <div className="w-full h-[7px] rounded-xs bg-fill-active overflow-hidden">
        <span
          className="block h-full"
          style={{ width: `${pctClamped}%`, backgroundColor: fill }}
        />
      </div>
      {(resetLine || blockedLine) && (
        <div className="mt-1 text-label text-text-faint">
          {blockedLine ?? resetLine}
          {!blockedLine && w.binding ? " · binding limit" : ""}
        </div>
      )}
    </div>
  );
}
