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

import { memo, useEffect, useRef, useState } from "react";
import type { ProviderView, SeatView, UsageWindow } from "../shared/types";
import {
  cssVar,
  findSeat,
  formatLastMove,
  formatUpdatedAgo,
  formatWindowReset,
  hasSeatChoice,
  isMoveComing,
  isSameOrgMove,
  nextSeatHint,
  orderOtherSeats,
  OTHER_SEATS_VISIBLE_ROWS,
  seatBarWindows,
  seatDialSnapshot,
  seatResetHint,
  seatStateText,
  selectConversationSeat,
  selectProviderView,
  selectUsageSnapshot,
  usageDialState,
  usageStale,
  usageTone,
  type UsageDialTone,
} from "./chatUtils";
import { useStore } from "./store";
import { Popover } from "./Popover";
import { Pill } from "./Pill";
import { openAccountsSettings, refreshAccounts, refreshSessionSeat } from "./accountsData";
import { CROSS_ORG_CONFIRM_COPY, useSeatSwitch } from "./hooks/useSeatSwitch";

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
function toneRingColor(tone: UsageDialTone): string {
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
  const state = usageDialState(snapshot, alwaysShow);
  const moveComing = isMoveComing(view, current);

  // Learn which seat this conversation is on (cached in the store; kept
  // current by `accounts.moved`, and re-read whenever the popover opens).
  useEffect(() => {
    if (multi && sessionId) void refreshSessionSeat(sessionId);
  }, [multi, sessionId]);

  // No data / no matching snapshot / adapter failed / below threshold with
  // the opt-in off → render nothing. Absence is the healthy signal.
  if (!snapshot || !state.visible) return null;

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
  const title =
    (state.awaitingReset
      ? `${lead} · the ${windowLabel} quota is resetting`
      : `${lead} · ${pctClamped}% of the ${windowLabel}` + (resetLine ? ` — ${resetLine}` : "")) +
    (moveComing ? " · this conversation will move to another seat soon" : "") +
    " · click for details";

  return (
    <>
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
        surfaceClassName="w-[420px] p-4 max-h-[calc(100vh-24px)] overflow-y-auto"
      >
        <UsagePopoverBody
          snapshot={snapshot}
          state={state}
          label={label}
          view={view}
          multi={multi}
          current={current}
          sessionSeat={sessionSeat}
          nowMs={nowMs}
          onNavigate={() => setOpen(false)}
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
  sessionSeat,
  nowMs,
  onNavigate,
}: {
  snapshot: UsageSnapshotLike;
  state: ReturnType<typeof usageDialState>;
  label: string;
  view: ProviderView | null;
  multi: boolean;
  current: ReturnType<typeof selectConversationSeat>;
  sessionSeat: import("../shared/types").SessionSeat | null;
  nowMs: number;
  onNavigate: () => void;
}) {
  const switcher = useSeatSwitch(view);
  const lastMove = formatLastMove(sessionSeat?.lastMove, nowMs);
  const groups = multi ? orderOtherSeats(view, current?.seat.id ?? null) : [];
  const otherCount = groups.reduce((n, g) => n + g.seats.length, 0);
  const nextId = view && view.mode === "auto" ? nextSeatHint(view, current?.seat.id ?? null) : null;
  // No assignment yet (a brand-new conversation): the windows above are the
  // aggregate — the seat a new conversation would start on. Say so.
  const startsOn =
    multi && !current && view ? findSeat(view, view.mode === "manual" ? view.activeSeatId : view.nextSeatId) : null;

  const seatName = (c: { seat: SeatView; account: { label: string; seats: SeatView[] } }) =>
    c.account.seats.length > 1 ? `${c.account.label} · ${c.seat.label}` : c.account.label;

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

      {multi && (current || startsOn) && (
        <div className="mb-3 flex items-baseline justify-between gap-2 text-meta" data-testid="usage-conversation-seat">
          <span className="min-w-0 truncate font-medium text-text">
            {current ? seatName(current) : startsOn ? seatName(startsOn) : ""}
          </span>
          {!current && startsOn && <span className="shrink-0 text-text-faint">new conversations start here</span>}
        </div>
      )}

      {state.awaitingReset && (
        <div className="mb-3 text-meta text-text-faint">
          Quota is being reset. Usage numbers might look off for a few minutes.
        </div>
      )}

      <div className="flex flex-col gap-3">
        {snapshot.windows.map((w) => (
          <UsageWindowRow key={w.kind} usageWindow={w} nowMs={nowMs} />
        ))}
      </div>

      {snapshot.extras && snapshot.extras.length > 0 && (
        <div className="mt-3 pt-3 border-t border-border-subtle flex flex-col gap-1">
          {snapshot.extras.map((e) => (
            <div key={e.label} className="flex items-center justify-between text-meta">
              <span className="text-text-faint">{e.label}</span>
              <span className="text-text-muted font-mono">{e.value}</span>
            </div>
          ))}
        </div>
      )}

      {lastMove && (
        <div className="mt-3 pt-3 border-t border-border-subtle text-meta text-text-muted" data-testid="usage-last-move">
          <div>{lastMove.line}</div>
          {lastMove.resent && <div className="text-text-faint">{lastMove.resent}</div>}
        </div>
      )}

      {otherCount > 0 && view && (
        <div className="mt-3 pt-3 border-t border-border-subtle" data-testid="usage-other-seats">
          <div className="mb-1 text-label font-medium text-text-faint">Other seats</div>
          <div
            className="manta-seat-list flex flex-col gap-2 overflow-y-auto"
            // ~52px a row (two-line row + gap): the list scrolls inside the popover past five.
            style={otherCount > OTHER_SEATS_VISIBLE_ROWS ? { maxHeight: OTHER_SEATS_VISIBLE_ROWS * 52 } : undefined}
          >
            {groups.map((g) => (
              <div key={g.accountId} className="flex flex-col gap-2">
                {g.showHeading && (
                  <div className="text-label text-text-faint truncate">{g.label}</div>
                )}
                {g.seats.map((seat) => (
                  <OtherSeatRow
                    key={seat.id}
                    seat={seat}
                    view={view}
                    isNext={nextId === seat.id}
                    nowMs={nowMs}
                    switcher={switcher}
                    onFix={() => manage(view.provider)}
                  />
                ))}
              </div>
            ))}
          </div>
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

type UsageSnapshotLike = NonNullable<ReturnType<typeof selectUsageSnapshot>>;

// One compact "Other seats" row: label (+ the "next" tag in automatic mode),
// a second line of facts, two thin bars, and — in manual mode — the Use button.
function OtherSeatRow({
  seat,
  view,
  isNext,
  nowMs,
  switcher,
  onFix,
}: {
  seat: SeatView;
  view: ProviderView;
  isNext: boolean;
  nowMs: number;
  switcher: ReturnType<typeof useSeatSwitch>;
  onFix: () => void;
}) {
  const broken = seatStateText(seat.status);
  const facts = [
    seatResetHint(seat, nowMs),
  ].filter(Boolean) as string[];
  const confirming = switcher.confirmId === seat.id;
  const busy = switcher.busyId === seat.id;
  const crossOrg = !isSameOrgMove(view, view.activeSeatId, seat.id);
  return (
    <div data-seat-id={seat.id} className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1 text-meta text-text min-w-0">
            <span className="truncate">{seat.label}</span>
            {isNext && (
              <span
                className="manta-seat-next shrink-0 rounded-xs px-1 text-label bg-accent-bg text-accent"
                title="Where a move would go"
              >
                next
              </span>
            )}
          </div>
          {(broken || facts.length > 0) && (
            <div className="text-label text-text-faint truncate">
              {broken && <span className="text-warn">{broken}</span>}
              {broken && (
                <>
                  {" · "}
                  <button type="button" onClick={onFix} className="underline decoration-dotted hover:text-text">
                    Fix
                  </button>
                </>
              )}
              {broken && facts.length > 0 ? " · " : ""}
              {facts.join(" · ")}
            </div>
          )}
        </div>
        <SeatMiniBars seat={seat} nowMs={nowMs} />
        {view.mode === "manual" && (
          <button
            type="button"
            onClick={() => switcher.request(seat)}
            disabled={switcher.busyId !== null || broken !== null}
            title={broken ? `${seat.label} is ${broken} — fix it in Settings first` : `Use ${seat.label} for every conversation`}
            className="shrink-0 px-2 py-1 text-meta bg-bg-soft border border-border rounded-xs text-text-muted hover:text-text disabled:opacity-40"
          >
            {busy ? "…" : "Use"}
          </button>
        )}
      </div>
      {confirming && (
        <div role="alert" className="rounded-xs border border-border bg-bg px-2 py-1 text-label text-text-muted">
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
      )}
    </div>
  );
}

// The compact seat meter: the 5h and weekly windows as two thin bars with
// their percentages. Shares the popover's colour ladder (toneRingColor) so a
// seat can never read green here and red in the ring.
export function SeatMiniBars({ seat, nowMs: _nowMs }: { seat: SeatView; nowMs: number }) {
  const windows = seatBarWindows(seat.windows);
  if (windows.length === 0) {
    return <span className="shrink-0 w-[104px] text-label text-text-faint text-right">no reading yet</span>;
  }
  return (
    <div className="shrink-0 w-[104px] flex flex-col gap-[3px]" data-testid="seat-mini-bars">
      {windows.map((w) => {
        const awaiting = w.stale === true;
        const pct = awaiting ? 0 : Math.max(0, Math.min(100, w.pct));
        return (
          <div key={w.kind} className="flex items-center gap-1" data-window-kind={w.kind}>
            <span className="w-5 truncate text-label text-text-faint">{w.label}</span>
            <span className="flex-1 h-[3px] rounded-xs bg-fill-active overflow-hidden">
              <span
                className="block h-full"
                style={{ width: `${pct}%`, backgroundColor: toneRingColor(usageTone(pct)) }}
              />
            </span>
            <span className="w-7 text-right font-mono text-label tabular-nums text-text-muted">
              {awaiting ? "—" : `${Math.round(w.pct)}%`}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// One window's row in the popover: label, right-aligned value, a 7px track
// + fill, and a reset line. The component iterates `snapshot.windows` — it
// never hardcodes "session"/"weekly" so a provider with a third window (or a
// daily one) renders with zero changes here.
export function UsageWindowRow({ usageWindow: w, nowMs }: { usageWindow: UsageWindow; nowMs: number }) {
  // Awaiting its replacement numbers: show no value and no fill rather than a
  // figure we know is the previous window's. The notice above the list says
  // why, and formatWindowReset already renders "resetting…" below.
  const awaitingReset = w.stale === true;
  // Not in force (a model-scoped cap on a model this plan isn't using): shown
  // greyed with no figure and no fill, so it can't be mistaken for real usage.
  const inactive = w.active === false;
  const pctClamped = awaitingReset || inactive ? 0 : Math.max(0, Math.min(100, w.pct));
  const fill = toneRingColor(usageTone(pctClamped));
  const value = inactive
    ? "not active"
    : awaitingReset
      ? "—"
      : w.used != null && w.limit != null
        ? `${w.used.toLocaleString()} / ${w.limit.toLocaleString()} · ${pctClamped}%`
        : `${pctClamped}%`;
  const resetLine = formatWindowReset(w.resetsAt, nowMs);

  return (
    <div className={inactive ? "opacity-50" : undefined} data-inactive={inactive ? "true" : undefined}>
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
      {resetLine && (
        <div className="mt-1 text-label text-text-faint">
          {resetLine}
          {w.binding ? " · binding limit" : ""}
        </div>
      )}
    </div>
  );
}
