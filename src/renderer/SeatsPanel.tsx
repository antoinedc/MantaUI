// SeatsPanel — Settings → Accounts, the accounts → seats level of one
// subscription provider row (multi-account spec §7).
//
// Collapsed by default behind one button on the provider row; opened by a
// "Manage seats" / "Fix" link elsewhere (consumeAccountsFocus). Inside: the
// Manual / Automatic choice (>= 2 seats), every account with its seats (label
// editable inline, email, plan, 5h + weekly bars, conversations, status, a
// "live" marker), the manual-mode "Use this seat" control, and Add account /
// Add seat / Rename / Remove.
//
// Every control ends in one of the three legal outcomes (AGENTS.md "never stub
// a control"): the panel's single status line (`role=status` / `role=alert`)
// names what was done or why it was not; an action that cannot apply is
// disabled with its reason in the title.

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Pencil } from "lucide-react";
import type { AccountView, ProviderView, SeatView } from "../shared/types";
import {
  hasSeatChoice,
  isSameOrgMove,
  providerViewOrError,
  seatBarWindows,
  seatLoad,
  seatStateText,
} from "./chatUtils";
import { providerLabel, UsageWindowRow } from "./UsageDial";
import { AddSeatGate } from "./AddSeatFlow";
import { ChipGroup } from "./Chip";
import { consumeAccountsFocus, refreshAccounts } from "./accountsData";
import { CROSS_ORG_CONFIRM_COPY, useSeatSwitch, type SeatActionReport } from "./hooks/useSeatSwitch";
import { useStore } from "./store";

const BTN =
  "px-2 py-1 text-meta bg-bg-soft border border-border rounded-xs text-text-muted hover:text-text disabled:opacity-40";
type Adding = { accountId?: string; accountLabel?: string } | null;

export function SeatsPanel({ view, openSignal }: { view: ProviderView; openSignal?: number }) {
  const [open, setOpen] = useState(() => consumeAccountsFocus(view.provider));
  const [nowMs] = useState(() => Date.now());
  const [notice, setNotice] = useState<SeatActionReport | null>(null);
  const [adding, setAdding] = useState<Adding>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [removeConfirm, setRemoveConfirm] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ kind: "account" | "seat"; id: string; draft: string } | null>(null);
  const switcher = useSeatSwitch(view, setNotice);
  const multi = hasSeatChoice(view);
  const seatCount = view.accounts.reduce((n, a) => n + a.seats.length, 0);

  // The parent just added an account through the row's Connect: show the list
  // so the new account is on screen without a click.
  useEffect(() => {
    if (openSignal) setOpen(true);
  }, [openSignal]);

  // "Manage seats" while Settings is already open on Accounts.
  useEffect(() => {
    const h = (ev: Event) => {
      const d = (ev as CustomEvent<{ provider?: string }>).detail;
      if (d?.provider === view.provider) {
        consumeAccountsFocus(view.provider);
        setOpen(true);
      }
    };
    window.addEventListener("manta-open-settings", h as EventListener);
    return () => window.removeEventListener("manta-open-settings", h as EventListener);
  }, [view.provider]);

  // Fresh numbers whenever the panel opens (§7a "Data").
  useEffect(() => {
    if (open) void refreshAccounts();
  }, [open]);

  // Run one RPC that answers a ProviderView, report both branches.
  const run = useCallback(
    async (key: string, call: () => Promise<unknown>, okText: string, failText: string) => {
      if (busy) return false;
      setBusy(key);
      try {
        const res = providerViewOrError(
          (await call()) as Parameters<typeof providerViewOrError>[0],
        );
        if ("error" in res) {
          setNotice({ ok: false, text: res.error });
          return false;
        }
        useStore.getState().upsertProviderView(res.view);
        setNotice({ ok: true, text: okText });
        return true;
      } catch {
        setNotice({ ok: false, text: `${failText} — the server didn't answer. Try again.` });
        return false;
      } finally {
        setBusy(null);
      }
    },
    [busy],
  );

  const setMode = (mode: "auto" | "manual") => {
    if (mode === view.mode) return;
    void run(
      "mode",
      () => window.api.accountsSetMode({ provider: view.provider, mode }),
      mode === "auto"
        ? "Automatic: Manta now picks a seat for each conversation."
        : "Manual: every conversation now uses the seat you choose.",
      "Couldn't change the seat mode",
    );
  };

  const saveRename = async () => {
    if (!renaming) return;
    const label = renaming.draft.trim();
    const ok = await run(
      `rename:${renaming.id}`,
      () => window.api.accountsRename({ provider: view.provider, kind: renaming.kind, id: renaming.id, label }),
      `Renamed to “${label}”.`,
      "Couldn't rename",
    );
    if (ok) setRenaming(null);
  };

  const removeSeat = async (seat: SeatView) => {
    const ok = await run(
      `remove:${seat.id}`,
      () => window.api.accountsRemoveSeat({ provider: view.provider, seatId: seat.id }),
      `Removed ${seat.label}. Its conversations move to another seat on their next message.`,
      `Couldn't remove ${seat.label}`,
    );
    if (ok) setRemoveConfirm(null);
  };

  const label = providerLabel(view.provider);

  const renameControl = (kind: "account" | "seat", id: string, current: string) =>
    renaming?.id === id && renaming.kind === kind ? (
      <span className="inline-flex items-center gap-1">
        <input
          autoFocus
          value={renaming.draft}
          maxLength={40}
          aria-label={`Rename ${current}`}
          onChange={(e) => setRenaming({ ...renaming, draft: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") void saveRename();
            if (e.key === "Escape") setRenaming(null);
          }}
          className="min-w-0 w-40 rounded-xs border border-border bg-bg px-2 py-[2px] text-text outline-none"
        />
        <button type="button" className={BTN} onClick={() => void saveRename()} disabled={busy !== null || !renaming.draft.trim()}>
          {busy === `rename:${id}` ? "…" : "Save"}
        </button>
        <button type="button" className="text-meta text-text-faint hover:text-text" onClick={() => setRenaming(null)}>
          Cancel
        </button>
      </span>
    ) : (
      <button
        type="button"
        onClick={() => setRenaming({ kind, id, draft: current })}
        className="inline-flex items-center text-text-faint hover:text-text"
        title={`Rename ${current}`}
        aria-label={`Rename ${current}`}
      >
        <Pencil size={12} aria-hidden="true" />
      </button>
    );

  const seatRow = (seat: SeatView, account: AccountView, soleSeat: boolean) => {
    const broken = seatStateText(seat.status);
    const isActive = view.activeSeatId === seat.id;
    const bars = seatBarWindows(seat.windows);
    const load = seatLoad(seat);
    const confirming = switcher.confirmId === seat.id;
    const crossOrg = !isSameOrgMove(view, view.activeSeatId, seat.id);
    return (
      <div key={seat.id} data-seat-id={seat.id} className="rounded-sm border border-border-subtle px-3 py-2 space-y-2">
        <div className="flex items-start gap-2 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-body font-medium text-text min-w-0">
              <span className="truncate">{soleSeat ? account.label : seat.label}</span>
              {renameControl(soleSeat ? "account" : "seat", soleSeat ? account.id : seat.id, soleSeat ? account.label : seat.label)}
              {seat.live && (
                <span
                  className="manta-seat-live text-label rounded-xs px-1 bg-ok-bg text-ok"
                  title="This is the login the box itself uses"
                >
                  live
                </span>
              )}
              {multi && view.mode === "manual" && isActive && (
                <span className="text-label rounded-xs px-1 bg-accent-bg text-accent">in use</span>
              )}
            </div>
            <div className="text-meta text-text-faint truncate">
              {[seat.email, account.plan, `${seat.conversations} conversation${seat.conversations === 1 ? "" : "s"}`]
                .filter(Boolean)
                .join(" · ")}
              {broken && <span className="text-warn"> · {broken}</span>}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {multi && view.mode === "manual" && (
              <button
                type="button"
                className={BTN}
                disabled={isActive || switcher.busyId !== null || broken !== null}
                title={
                  isActive
                    ? "Every conversation already uses this seat"
                    : broken
                      ? `${seat.label} is ${broken} — sign it in again first`
                      : `Use ${seat.label} for every conversation`
                }
                onClick={() => switcher.request(seat)}
              >
                {switcher.busyId === seat.id ? "…" : isActive ? "In use" : "Use this seat"}
              </button>
            )}
            {removeConfirm === seat.id ? (
              <span className="inline-flex items-center gap-2">
                <button
                  type="button"
                  className="px-2 py-1 text-meta bg-danger-bg border border-danger rounded-xs text-danger disabled:opacity-40"
                  disabled={busy !== null}
                  onClick={() => void removeSeat(seat)}
                >
                  {busy === `remove:${seat.id}` ? "…" : "Remove"}
                </button>
                <button type="button" className="text-meta text-text-faint hover:text-text" onClick={() => setRemoveConfirm(null)}>
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                className={BTN}
                disabled={seat.live || busy !== null}
                title={seat.live ? "This is the login the box is using now, so it can't be removed" : `Remove ${seat.label}`}
                onClick={() => setRemoveConfirm(seat.id)}
              >
                Remove
              </button>
            )}
          </div>
        </div>
        {removeConfirm === seat.id && (
          <div className="text-meta text-text-muted">
            Remove {seat.label}? Its {seat.conversations} conversation{seat.conversations === 1 ? "" : "s"} move to another seat on their next message.
          </div>
        )}
        {confirming && (
          <div role="alert" className="rounded-xs border border-border bg-bg px-2 py-1 text-meta text-text-muted">
            <div>{crossOrg ? CROSS_ORG_CONFIRM_COPY : ""} Switch every conversation to {seat.label}?</div>
            <div className="mt-1 flex items-center gap-2">
              <button type="button" className={BTN} disabled={switcher.busyId !== null} onClick={() => void switcher.apply(seat)}>
                {switcher.busyId === seat.id ? "…" : "Switch"}
              </button>
              <button type="button" className="text-meta text-text-faint hover:text-text" onClick={switcher.cancel}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {bars.length > 0 ? (
          <div className="grid grid-cols-2 gap-3">
            {bars.map((w) => (
              <UsageWindowRow key={w.kind} usageWindow={w} nowMs={nowMs} />
            ))}
          </div>
        ) : (
          <div className="text-meta text-text-faint">No usage reading yet.</div>
        )}
        {load != null && load >= 100 && <div className="text-meta text-danger">At its limit.</div>}
      </div>
    );
  };

  return (
    <div className="pl-4 space-y-2" data-testid={`seats-panel-${view.provider}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-meta text-text-muted hover:text-text"
      >
        {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        {label} accounts &amp; seats ({seatCount})
      </button>

      {open && (
        <div className="space-y-3">
          {multi && (
            <div className="flex items-start gap-3 flex-wrap">
              <ChipGroup
                label={`${label} seat choice`}
                value={view.mode}
                options={[
                  { value: "auto" as const, label: "Automatic" },
                  { value: "manual" as const, label: "Manual" },
                ]}
                onChange={setMode}
              />
              <span className="text-meta text-text-faint max-w-[52ch]">
                {view.mode === "auto"
                  ? "Manta picks the least-used seat for each new conversation and moves a conversation when its seat runs out."
                  : "Every conversation uses the seat you choose, from its next message."}
              </span>
            </div>
          )}

          {view.accounts.map((account) => {
            const sole = account.seats.length === 1;
            return (
              <div key={account.id} className="space-y-2" data-account-id={account.id}>
                {!sole && (
                  <div className="flex items-center gap-2 text-meta text-text-muted">
                    <span className="font-medium text-text truncate">{account.label}</span>
                    {renameControl("account", account.id, account.label)}
                    {account.orgName && <span className="text-text-faint truncate">{account.orgName}</span>}
                    {account.plan && <span className="text-text-faint">{account.plan}</span>}
                  </div>
                )}
                {account.seats.map((seat) => seatRow(seat, account, sole))}
                <button
                  type="button"
                  className={BTN}
                  disabled={adding !== null}
                  title={adding ? "Finish or cancel the sign-in below first" : undefined}
                  onClick={() => setAdding({ accountId: account.id, accountLabel: account.label })}
                >
                  Add seat to {account.label}
                </button>
              </div>
            );
          })}

          {/* The action is always here. The terms note (second account only) and
              the sign-in both open BELOW it, inline — never in its place. */}
          <button
            type="button"
            className={BTN}
            disabled={adding !== null}
            title={adding ? "Finish or cancel the sign-in below first" : `Sign in another ${label} account`}
            onClick={() => setAdding({})}
          >
            Add {label} account
          </button>

          {adding && (
            <AddSeatGate
              provider={view.provider}
              view={view}
              accountId={adding.accountId}
              accountLabel={adding.accountLabel}
              onDone={(text) => {
                setAdding(null);
                setNotice({ ok: true, text });
              }}
              onCancel={() => setAdding(null)}
            />
          )}

          {notice && (
            <div role={notice.ok ? "status" : "alert"} className={`text-meta ${notice.ok ? "text-ok" : "text-danger"} break-words`}>
              {notice.text}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
