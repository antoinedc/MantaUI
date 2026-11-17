// ===== BackgroundWorkCard (background work budget spec §10, §17.20/§17.21) =====
//
// Settings → Models: the ONE budget for everything Manta does in the background (shared knowledge and the
// background CTO). Two controls — "Background work on plans" (Off / Light / Normal, the existing Segmented) and
// "API keys: daily cap" (dollars) — each shown only when it applies, plus a status row per plan with the reason
// and the local time when background work resumes.
//
// Every control reports its outcome (AGENTS.md "never stub a control"): a save says what the box now has, a
// failure shows the box's message and puts the previous value back. A half-typed cap survives the 30 s refresh
// (the field shows what was typed until it is saved or cleared).

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "../Button";
import { Card } from "../Card";
import { INPUT_BASE, LABEL_CLS } from "../Field";
import { Segmented } from "../Segmented";
import { UpdateBoxNote } from "../components/UpdateBoxNote";
import type { BackgroundWorkLevel, BudgetStatus } from "../../shared/api";
import {
  CAP_HELP,
  LEVEL_HELP,
  LEVEL_LIMITS_HELP,
  LEVEL_OPTIONS,
  capInputText,
  formatUsd,
  levelLabel,
  paygUsageText,
  parseApiKeyCap,
  planName,
  showCapControl,
  showLevelControl,
  statusRows,
} from "../backgroundWorkFormat";
import {
  BACKGROUND_WORK_ANCHOR_ID,
  consumeBackgroundWorkFocus,
  useBackgroundStatus,
} from "../useBackgroundStatus";

type Notice = { tone: "ok" | "error"; text: string };
const NOTICE_CLS = { ok: "text-ok", error: "text-danger" } as const;
const ROW_CLS = { info: "text-text-muted", warn: "text-warn" } as const;

const errText = (e: unknown): string => String((e as Error)?.message ?? e ?? "").trim() || "Something went wrong.";

export function BackgroundWorkCard() {
  const { state, refresh, adopt } = useBackgroundStatus(true);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  // What the user is choosing/typing right now; null = show what the box has.
  const [pendingLevel, setPendingLevel] = useState<BackgroundWorkLevel | null>(null);
  const [capText, setCapText] = useState<string | null>(null);
  const [capError, setCapError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLSpanElement>(null);
  const capRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const capId = useId();
  const capHelpId = useId();
  const capErrorId = useId();
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // "Change" links elsewhere open Settings here: scroll the card into view and move focus to its heading.
  const reveal = useCallback(() => {
    root.current?.scrollIntoView?.({ block: "start" });
    heading.current?.focus();
  }, []);
  useEffect(() => {
    if (consumeBackgroundWorkFocus()) reveal();
    const onOpen = (ev: Event) => {
      const d = (ev as CustomEvent<{ backgroundWork?: boolean }>).detail;
      if (d?.backgroundWork && consumeBackgroundWorkFocus()) reveal();
    };
    window.addEventListener("manta-open-settings", onOpen);
    return () => window.removeEventListener("manta-open-settings", onOpen);
  }, [reveal]);

  const header = (
    <span ref={heading} tabIndex={-1} className="text-micro uppercase text-text-faint focus:outline-none focus-visible:outline-2 focus-visible:outline-accent">
      Background work
    </span>
  );
  const wrap = (children: React.ReactNode) => (
    <div id={BACKGROUND_WORK_ANCHOR_ID} ref={root} data-testid="background-work-card">
      <Card header={header}>{children}</Card>
    </div>
  );

  if (state.kind === "loading") return wrap(<div className="text-meta text-text-faint">Reading the background work budget…</div>);
  if (state.kind === "unsupported") return wrap(<UpdateBoxNote />);
  if (state.kind === "error") {
    return wrap(
      <div className="space-y-3">
        <div role="alert" className="text-meta text-danger break-words">
          Couldn't read the background work budget: {state.message}
        </div>
        <Button tone="default" onClick={() => void refresh()}>
          Try again
        </Button>
      </div>,
    );
  }

  const status: BudgetStatus = state.status;
  const level = pendingLevel ?? status.level;
  const capShown = capText ?? capInputText(status.dailyCapUsd);
  const capDirty = capText !== null && capText.trim() !== capInputText(status.dailyCapUsd);
  const rows = statusRows(status);
  const showLevel = showLevelControl(status);
  const showCap = showCapControl(status);

  const run = async (patch: { level?: BackgroundWorkLevel; dailyCapUsd?: number }, check: (s: BudgetStatus) => string | null): Promise<boolean> => {
    if (savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    setNotice(null);
    try {
      try {
        await window.api.configUpdate({ backgroundWork: patch });
      } catch (e) {
        if (alive.current) setNotice({ tone: "error", text: `Couldn't save: ${errText(e)}` });
        return false;
      }
      // Saved. The status read that follows is its own step: a failure there is not a failed save.
      let fresh: BudgetStatus | null = null;
      try {
        fresh = await window.api.backgroundStatus();
      } catch {
        if (alive.current) {
          setNotice({ tone: "ok", text: "Saved, but couldn't refresh the status. It will update shortly." });
          void refresh();
        }
        return true;
      }
      if (!alive.current) return true;
      if (fresh && Array.isArray(fresh.plans)) adopt(fresh);
      else void refresh();
      // The status is what the box has now; say that, not what was asked for.
      const problem = fresh ? check(fresh) : null;
      setNotice(problem ? { tone: "error", text: problem } : { tone: "ok", text: okText(patch, fresh) });
      return !problem;
    } finally {
      savingRef.current = false;
      if (alive.current) {
        setSaving(false);
        setPendingLevel(null);
      }
    }
  };

  const okText = (patch: { level?: BackgroundWorkLevel; dailyCapUsd?: number }, fresh: BudgetStatus | null): string => {
    if (patch.level !== undefined) return `Background work on plans set to ${levelLabel(fresh?.level ?? patch.level)}.`;
    return `API-key daily cap set to ${formatUsd(fresh?.dailyCapUsd ?? patch.dailyCapUsd ?? 0)}.`;
  };

  const pickLevel = (next: BackgroundWorkLevel) => {
    if (savingRef.current || next === status.level) return;
    setPendingLevel(next);
    void run({ level: next }, (s) => (s.level === next ? null : `The box kept ${levelLabel(s.level)} instead of ${levelLabel(next)}.`));
  };

  const onCapSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const r = parseApiKeyCap(capShown);
    if (!r.ok) {
      setCapError(r.error);
      capRef.current?.focus();
      return;
    }
    setCapError(null);
    // Saved or refused, the field goes back to what the box has (a refusal's message stays above).
    void run({ dailyCapUsd: r.value }, (s) => (Math.abs(s.dailyCapUsd - r.value) < 0.005 ? null : `The box kept ${formatUsd(s.dailyCapUsd)} instead of ${formatUsd(r.value)}.`)).then(() => {
      if (alive.current) setCapText(null);
    });
  };

  const planNames = status.plans.map(planName).join(", ");
  const paygNames = status.payg.providers.join(", ");

  return wrap(
    <div className="space-y-5">
      <p className="text-meta text-text-faint max-w-[62ch]">
        Shared knowledge and the background CTO use models on their own. This is the one budget for all of it; it never touches
        what you run yourself.
      </p>

      {notice && (
        <div className={`text-meta break-words ${NOTICE_CLS[notice.tone]}`} role={notice.tone === "error" ? "alert" : "status"} data-testid="background-work-notice">
          {notice.text}
        </div>
      )}

      {!showLevel && !showCap && (
        <div className="text-meta text-text-faint" data-testid="background-work-empty">
          No model accounts are connected yet. The budget appears here once you connect a plan or an API key.
        </div>
      )}

      {showLevel && (
        <div className="space-y-2" aria-busy={saving || undefined}>
          <div>
            <span className={LABEL_CLS}>Background work on plans</span>
            <div className="text-meta text-text-faint">{planNames}</div>
          </div>
          <Segmented label="Background work on plans" options={LEVEL_OPTIONS} value={level} onChange={pickLevel} hook="manta-bgwork-level" />
          <div className="text-meta text-text-faint max-w-[62ch]">{LEVEL_HELP}</div>
        </div>
      )}

      {showCap && (
        <form onSubmit={onCapSubmit} noValidate className="space-y-1" aria-label="API-key daily cap">
          <label htmlFor={capId} className={LABEL_CLS}>
            API keys: daily cap
          </label>
          {paygNames && <div className="text-meta text-text-faint">{paygNames}</div>}
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className="text-body text-text-muted">
              $
            </span>
            <div className="w-28">
              <input
                id={capId}
                ref={capRef}
                name="dailyCapUsd"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
                value={capShown}
                disabled={saving}
                aria-invalid={capError ? true : undefined}
                aria-describedby={capError ? `${capHelpId} ${capErrorId}` : capHelpId}
                onChange={(e) => {
                  setCapText(e.target.value);
                  setCapError(null);
                }}
                onBlur={() => {
                  if (!capDirty) return;
                  const r = parseApiKeyCap(capShown);
                  if (!r.ok) setCapError(r.error);
                }}
                className={`${INPUT_BASE} px-4 py-3 font-mono`}
              />
            </div>
            <Button type="submit" tone="default" disabled={saving || !capDirty}>
              Save cap
            </Button>
          </div>
          <div id={capHelpId} className="text-meta text-text-faint max-w-[62ch]">
            {CAP_HELP}
          </div>
          {capError && (
            <div id={capErrorId} role="alert" className="text-meta text-danger break-words">
              {capError}
            </div>
          )}
          {status.payg.providers.length > 0 && (
            <div className="text-meta text-text-muted" data-testid="background-work-payg-usage">
              {paygUsageText(status)}
            </div>
          )}
        </form>
      )}

      {rows.length > 0 && (
        <ul className="space-y-1" data-testid="background-work-status">
          {rows.map((r) => (
            <li key={r.id} className={`text-meta break-words ${ROW_CLS[r.tone]}`} data-status={r.id}>
              {r.text}
            </li>
          ))}
        </ul>
      )}

      {(showLevel || showCap) && <div className="text-meta text-text-faint max-w-[62ch]">{LEVEL_LIMITS_HELP}</div>}
    </div>,
  );
}
