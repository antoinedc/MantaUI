// BET-1386: the Adaptive CTO `⚙` Settings & health pane (§10.5) + the
// §10.6-5 paused banner + the A12 Activity-ledger drill-down. This issue ships
// the P1 subset of card 1 (Behavior) and card 2 (Health), card 4's Activity
// ledger, and the paused state. Overnight-work switch, Tonight's-budget gauge
// and the other Internals drill-downs ship with their features (rule 4).
//
// Overview renders from the single `ctoState` the App holds; the settings view
// reads config + health on open (never polled). Controls hit the box RPCs
// added in this issue (configUpdate / ctoPause / ctoResume) and the health +
// ledger GETs — the engine publishes a fresh `{kind:"ctoState"}` on pause /
// resume so the banner reflects it.
import { useCallback, useEffect, useRef, useState } from "react";
import { digestBusy, showPausedBanner, statDisplay, type CtoState } from "./ctoView";
import type { CtoHealthStat, CtoLedgerPage, CtoLedgerRow } from "../shared/api.js";
import { Toggle } from "./Toggle";
import { useStore } from "./store";

type Config = {
  ctoEnabled?: boolean;
  ctoTier?: "low" | "medium" | "high";
  ctoAmbientCap?: number;
  ctoDigestPush?: boolean;
};

// Effort-dial options (§12.1, D12). Plain-language scope per tier. Medium and
// High list the features they ADD over the tier below; their additional
// features are P2 (not yet merged), so the radio carries an honest "coming in
// P2" note rather than implying the capability exists (§ no-dead-controls).
type EffortLevel = { value: "low" | "medium" | "high"; title: string; scope: string; comingInP2?: boolean };
const EFFORT_LEVELS: EffortLevel[] = [
  {
    value: "low",
    title: "Low",
    scope:
      "Background digest, work rollups, facts blackboard, Now / Just-finished rails and the activity ledger.",
  },
  {
    value: "medium",
    title: "Medium",
    scope:
      "Adds suggestions and tool discovery probes — coming in P2.",
    comingInP2: true,
  },
  {
    value: "high",
    title: "High",
    scope: "Adds overnight planning and veto-window actions — coming in P2.",
    comingInP2: true,
  },
];

// A minimal non-interactive clock (for the paused-at line + ledger timestamps).
function formatTime(ts: number | null | undefined): string {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function CtoPanel({ state }: { state: CtoState | null }) {
  const [view, setView] = useState<"overview" | "settings" | "ledger">("overview");
  const pushToast = useStore((s) => s.pushAppToast);

  const busy = digestBusy(state);
  const restingRef = useRef<HTMLDivElement>(null);
  const wasBusyRef = useRef(busy);

  // On generation completion (generationInFlight true → false), scroll to the
  // resting line (§10.2) — unchanged from the shell issue.
  useEffect(() => {
    const prev = wasBusyRef.current;
    wasBusyRef.current = busy;
    if (prev && !busy) {
      restingRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [busy]);

  // §10.6-5: the kill switch being active drives the banner via the pure
  // state→banner selector (tested in ctoView.test.ts).
  const paused = showPausedBanner(state);

  const openSettings = () => setView("settings");
  const openOverview = () => setView("overview");
  const openLedger = () => setView("ledger");

  // The paused banner (§10.6-5): kill switch active → banner replaces the
  // header (visible in both the overview and the settings pane when paused).
  function PausedBanner() {
    if (!paused) return null;
    return (
      <div className="mb-4 flex flex-col gap-2 rounded-lg border border-border-subtle bg-fill-active p-3">
        <div className="text-sm font-medium text-text">
          Paused <span className="text-text-muted">· {formatTime(state?.pausedAt ?? null)}</span>
        </div>
        <p className="text-sm text-text-muted">
          No probes, no jobs, no analysis; digest data keeps accumulating passively.
        </p>
        <div>
          <button
            type="button"
            onClick={() => void resumeCto()}
            className="rounded-md border border-border px-3 py-1 text-sm font-medium text-text hover:bg-fill-hover"
          >
            Resume
          </button>
        </div>
      </div>
    );
  }

  const resumeCto = useCallback(async () => {
    try {
      const r = await window.api.ctoResume();
      if (!r.ok) throw new Error(r.error ?? "resume failed");
    } catch (e) {
      pushToast({
        id: `resume-${Date.now()}`,
        message: `Couldn't resume the CTO: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }, [pushToast]);

  if (view === "settings" || view === "ledger") {
    return view === "settings" ? (
      <SettingsView
        paused={paused}
        pausedAt={state?.pausedAt ?? null}
        onBack={openOverview}
        onLedger={openLedger}
        onResume={resumeCto}
      />
    ) : (
      <LedgerView
        onBack={() => setView("settings")}
        pushToast={pushToast}
      />
    );
  }

  return (
    <div className="h-full w-full overflow-y-auto bg-bg">
      <div
        className="mx-auto px-6 py-8"
        style={{ maxWidth: "var(--cto-col-max-w)" }}
      >
        {/* Header row (§10.2): title · spacer · ⚙ */}
        <div className="flex items-center gap-2 pb-4">
          <h1 className="text-lg font-semibold text-text">CTO</h1>
          <div className="flex-1" />
          <button
            type="button"
            onClick={openSettings}
            className="rounded-md p-2 text-text-muted hover:bg-fill-hover hover:text-text"
            title="Settings & health"
            aria-label="Open CTO settings & health"
          >
            ⚙
          </button>
        </div>

        {/* §10.6-5 paused banner replaces the resting content's header space */}
        <PausedBanner />

        {/* §10.2 section scaffolds — collapse to nothing while empty. */}
        <div className="space-y-8" />

        {/* Resting state (§10.6-1): no needs-you items → a single centered
            "Nothing needs you ✓" line. Only rendered when the needs-you count
            is zero; paused still shows the resting line below the banner. */}
        {(state?.needsYouCount ?? 0) === 0 && !paused && (
          <div ref={restingRef} className="flex flex-col items-center gap-1 py-12">
            <div className="text-text-muted">
              Nothing needs you <span aria-hidden>✓</span>
            </div>
            <div className="text-sm text-text-faint">
              I&rsquo;ll surface anything that needs your attention here.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings & health (§10.5)
// ---------------------------------------------------------------------------
function SettingsView({
  paused,
  pausedAt,
  onBack,
  onLedger,
  onResume,
}: {
  paused: boolean;
  pausedAt: number | null;
  onBack: () => void;
  onLedger: () => void;
  onResume: () => void;
}) {
  const pushToast = useStore((s) => s.pushAppToast);
  // Local mirror of the adaptive-CTO config cluster, loaded on open so the
  // controls reflect the box; edits write through configUpdate (instant-apply).
  const [config, setConfig] = useState<Config | null>(null);
  const [capText, setCapText] = useState("");
  const [health, setHealth] = useState<CtoHealthStat[]>([]);
  const [busyPause, setBusyPause] = useState(false);

  useEffect(() => {
    let alive = true;
    void window.api.configGet().then((c) => {
      if (!alive) return;
      setConfig({ ctoEnabled: !!c?.ctoEnabled, ctoTier: c?.ctoTier, ctoAmbientCap: c?.ctoAmbientCap, ctoDigestPush: !!c?.ctoDigestPush });
      setCapText(String(c?.ctoAmbientCap ?? 2.5));
    });
    void window.api.ctoHealthGet().then((h) => {
      if (alive) setHealth(h.stats);
    });
    return () => {
      alive = false;
    };
  }, []);

  const applyConfig = useCallback(
    async (patch: Partial<Config>) => {
      const prev = config;
      setConfig((c) => ({ ...(c ?? {}), ...patch }));
      try {
        const next = (await window.api.configUpdate(patch)) as Config;
        setConfig((c) => ({ ...c, ...patch, ctoAmbientCap: next?.ctoAmbientCap }));
      } catch (e) {
        setConfig(prev ?? {});
        pushToast({
          id: `cto-cfg-${Date.now()}`,
          message: `Couldn't update: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    },
    [config, pushToast],
  );

  const saveCap = useCallback(() => {
    const n = Number(capText);
    if (!Number.isFinite(n) || n < 0) {
      pushToast({ id: `cap-${Date.now()}`, message: "Daily cap must be a non-negative dollar amount." });
      return;
    }
    void applyConfig({ ctoAmbientCap: Math.round(n * 100) / 100 });
  }, [capText, applyConfig, pushToast]);

  const doPause = useCallback(async () => {
    setBusyPause(true);
    try {
      const r = await window.api.ctoPause();
      if (!r.ok) throw new Error(r.error ?? "pause failed");
    } catch (e) {
      pushToast({ id: `pause-${Date.now()}`, message: `Couldn't pause the CTO: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusyPause(false);
    }
  }, [pushToast]);

  return (
    <div className="h-full w-full overflow-y-auto bg-bg">
      <div className="mx-auto px-6 py-8" style={{ maxWidth: "var(--cto-col-max-w)" }}>
        <button
          type="button"
          onClick={onBack}
          className="rounded-md p-2 text-text-muted hover:bg-fill-hover hover:text-text"
          aria-label="Back to the CTO overview"
        >
          ← Back to CTO
        </button>
        <h2 className="mt-4 text-lg font-semibold text-text">Settings &amp; health</h2>

        {paused && (
          <div className="mt-3 flex flex-col gap-1 rounded-lg border border-border-subtle bg-fill-active p-3">
            <div className="text-sm font-medium text-text">
              Paused <span className="text-text-muted">· {formatTime(pausedAt)}</span>
            </div>
            <p className="text-sm text-text-muted">
              No probes, no jobs, no analysis; digest data keeps accumulating passively.
            </p>
          </div>
        )}

        <div className="mt-4 space-y-6">
          {/* ---------- Behavior card (§10.5 card 1, P1 subset) ---------- */}
          <section className="rounded-lg border border-border-subtle p-4">
            <h3 className="text-sm font-semibold text-text">Behavior</h3>
            <p className="mt-1 text-sm text-text-faint">
              One hard daily cap (<span className="font-mono">${config?.ctoAmbientCap ?? 2.5}</span>)
              bounds all autonomous work, independent of the effort dial.
            </p>

            <div className="mt-4 space-y-4">
              {/* Enabled */}
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-text">Enabled</div>
                  <div className="text-sm text-text-muted">
                    Off = fully idle (event ingestion continues, nothing runs).
                  </div>
                </div>
                <Toggle
                  checked={config?.ctoEnabled ?? false}
                  onChange={(v) => void applyConfig({ ctoEnabled: v })}
                  ariaLabel="Adaptive CTO enabled"
                />
              </div>

              {/* Effort dial */}
              <div>
                <div className="text-sm font-medium text-text">Effort</div>
                <div className="mt-2 grid gap-2 sm:grid-cols-3">
                  {EFFORT_LEVELS.map((lv) => (
                    <label
                      key={lv.value}
                      className={
                        "cursor-pointer rounded-md border p-3 text-sm " +
                        ((config?.ctoTier ?? "low") === lv.value
                          ? "border-accent bg-fill-hover"
                          : "border-border-subtle")
                      }
                    >
                      <span className="flex items-center gap-2">
                        <input
                          type="radio"
                          name="cto-effort"
                          value={lv.value}
                          checked={(config?.ctoTier ?? "low") === lv.value}
                          onChange={() => void applyConfig({ ctoTier: lv.value })}
                          className="accent-accent"
                        />
                        <span className="font-medium text-text">{lv.title}</span>
                      </span>
                      <span className="mt-1 block text-xs text-text-muted">{lv.scope}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Ambient cap editor */}
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-text">Hard daily cap</div>
                  <div className="text-sm text-text-muted">Dollar amount per day (default $2.50).</div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-text-muted">$</span>
                  <input
                    type="number"
                    min={0}
                    step={0.25}
                    value={capText}
                    onChange={(e) => setCapText(e.target.value)}
                    onBlur={saveCap}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveCap();
                    }}
                    className="w-20 rounded-md border border-border bg-bg px-2 py-1 text-sm text-text"
                    aria-label="Hard daily ambient cap in dollars"
                  />
                </div>
              </div>

              {/* Push digest to phone */}
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-text">Push digest to phone</div>
                  <div className="text-sm text-text-muted">
                    Also notify your phone when a digest is pre-generated.
                  </div>
                </div>
                <Toggle
                  checked={!!config?.ctoDigestPush}
                  onChange={(v) => void applyConfig({ ctoDigestPush: v })}
                  ariaLabel="Push digest to phone"
                />
              </div>

              {/* Pause / Resume (§10.6-5 kill switch) */}
              <div className="flex items-center justify-between gap-3 border-t border-border-subtle pt-4">
                <div>
                  <div className="text-sm font-medium text-text">
                    {paused ? "Paused" : "Pause everything now"}
                  </div>
                  <div className="text-sm text-text-muted">
                    {paused
                      ? "Probes, jobs and analysis are stopped; digest data keeps accumulating."
                      : "Stops all autonomous work immediately. You can resume any time."}
                  </div>
                </div>
                {paused ? (
                  <button
                    type="button"
                    onClick={onResume}
                    className="rounded-md border border-border px-3 py-2 text-sm font-medium text-text hover:bg-fill-hover"
                  >
                    Resume
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void doPause()}
                    disabled={busyPause}
                    className="rounded-md border border-danger/40 px-3 py-2 text-sm font-medium text-danger hover:bg-danger/10 disabled:opacity-50"
                  >
                    Pause now
                  </button>
                )}
              </div>
            </div>
          </section>

          {/* ---------- Health card (§10.5 card 2, P1 rows) ---------- */}
          <section className="rounded-lg border border-border-subtle p-4">
            <h3 className="text-sm font-semibold text-text">Health</h3>
            <ul className="mt-3 divide-y divide-border-subtle">
              {HEALTH_ROW_ORDER.map((id) => {
                const stat = health.find((s) => s.id === id) ?? {
                  id,
                  label: id === "ambientSpendToday" ? "Ambient spend today" : id === "digestOpens" ? "Digest opens · 7d" : "Pipeline lag (close → summary)",
                  value: null,
                  n: 0,
                  min: 1,
                };
                const d = statDisplay(stat);
                return (
                  <li key={id} className="flex items-baseline justify-between gap-3 py-2">
                    <span className="text-sm text-text-muted">{stat.label}</span>
                    <span className={"text-right text-sm " + (d.ready ? "font-mono text-text" : "text-text-faint")}>
                      {d.ready ? d.text : <><span>{stat.label}</span> · {d.text}</>}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>

          {/* ---------- Internals: Activity ledger entry point ---------- */}
          <section className="rounded-lg border border-border-subtle p-4">
            <h3 className="text-sm font-semibold text-text">Internals</h3>
            <button
              type="button"
              onClick={onLedger}
              className="mt-2 flex w-full items-center justify-between rounded-md border border-border-subtle px-3 py-2 text-left hover:bg-fill-hover"
            >
              <span>
                <span className="block text-sm font-medium text-text">Activity ledger</span>
                <span className="block text-xs text-text-muted">
                  Reverse-chronological record of everything the CTO has done.
                </span>
              </span>
              <span className="text-text-muted">›</span>
            </button>
          </section>
        </div>
      </div>
    </div>
  );
}

const HEALTH_ROW_ORDER = ["ambientSpendToday", "digestOpens", "pipelineLag"] as const;

// ---------------------------------------------------------------------------
// Activity ledger drill-down (A12)
// ---------------------------------------------------------------------------
const LEDGER_ACTORS = ["cto", "user", "job"];

function LedgerView({
  onBack,
  pushToast,
}: {
  onBack: () => void;
  pushToast: (t: { id: string; message: string }) => void;
}) {
  const [rows, setRows] = useState<CtoLedgerRow[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [actor, setActor] = useState<string>("");
  const [kind, setKind] = useState<string>("");
  const [loading, setLoading] = useState(false);

  const loadPage = useCallback(
    async (before?: number, replace = false) => {
      setLoading(true);
      try {
        const page: CtoLedgerPage = await window.api.ctoLedgerGet({
          before,
          actor: actor || undefined,
          kind: kind || undefined,
          limit: 100,
        });
        setRows((prev) => (replace ? page.rows : [...prev, ...page.rows]));
        setNextBefore(page.nextBefore);
      } catch (e) {
        pushToast({
          id: `ledger-${Date.now()}`,
          message: `Couldn't load the ledger: ${e instanceof Error ? e.message : String(e)}`,
        });
      } finally {
        setLoading(false);
      }
    },
    [actor, kind, pushToast],
  );

  // Reload when a filter changes (first page, replacing).
  useEffect(() => {
    void loadPage(undefined, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actor, kind]);

  // Distinct kinds across the rows loaded so far, for the §10.5 card-4
  // "filter by type" chips (a kind chip that's been paged past stays selectable
  // on the next page too, since we always pass the current filter to the box).
  const kinds = Array.from(new Set(rows.map((r) => r.kind).filter((k): k is string => !!k))).sort();

  return (
    <div className="h-full w-full overflow-y-auto bg-bg">
      <div className="mx-auto px-6 py-8" style={{ maxWidth: "var(--cto-col-max-w)" }}>
        <button
          type="button"
          onClick={onBack}
          className="rounded-md p-2 text-text-muted hover:bg-fill-hover hover:text-text"
          aria-label="Back to CTO settings"
        >
          ← Back to settings
        </button>
        <h2 className="mt-4 text-lg font-semibold text-text">Activity ledger</h2>

        {/* Filter chips by actor */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-text-faint">Actor</span>
          <button
            type="button"
            onClick={() => setActor("")}
            className={"rounded-full border px-3 py-1 text-xs " + (actor === "" ? "border-accent bg-fill-hover text-text" : "border-border-subtle text-text-muted")}
          >
            All
          </button>
          {LEDGER_ACTORS.map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => setActor(actor === a ? "" : a)}
              className={"rounded-full border px-3 py-1 text-xs capitalize " + (actor === a ? "border-accent bg-fill-hover text-text" : "border-border-subtle text-text-muted")}
            >
              {a}
            </button>
          ))}
        </div>

        {/* Filter chips by type (kind) */}
        {kinds.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-xs uppercase tracking-wide text-text-faint">Type</span>
            <button
              type="button"
              onClick={() => setKind("")}
              className={"rounded-full border px-3 py-1 text-xs " + (kind === "" ? "border-accent bg-fill-hover text-text" : "border-border-subtle text-text-muted")}
            >
              All
            </button>
            {kinds.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(kind === k ? "" : k)}
                className={"rounded-full border px-3 py-1 font-mono text-xs " + (kind === k ? "border-accent bg-fill-hover text-text" : "border-border-subtle text-text-muted")}
              >
                {k}
              </button>
            ))}
          </div>
        )}

        {rows.length === 0 && !loading ? (
          <p className="mt-8 text-sm text-text-faint">
            No activity recorded yet{actor || kind ? ` for "${[actor, kind].filter(Boolean).join(" / ")}"` : ""}.
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-border-subtle">
            {rows.map((r, i) => (
              <li key={`${r.ts}-${i}`} className="flex items-start justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-sm text-text">
                    <span className="mr-2 font-mono text-xs text-text-muted">{r.kind ?? "entry"}</span>
                    {r.reason ? <span className="text-text-muted">· {r.reason}</span> : null}
                  </div>
                  <div className="text-xs text-text-faint">
                    {r.actor ? <span className="capitalize">by {r.actor}</span> : null}
                    {r.sessionID ? <span> · {r.sessionID}</span> : null}
                  </div>
                </div>
                <span className="shrink-0 text-xs text-text-faint">{formatTime(r.ts)}</span>
              </li>
            ))}
          </ul>
        )}

        {nextBefore != null && (
          <button
            type="button"
            onClick={() => void loadPage(nextBefore)}
            disabled={loading}
            className="mt-4 rounded-md border border-border px-3 py-2 text-sm text-text hover:bg-fill-hover disabled:opacity-50"
          >
            {loading ? "Loading…" : "Load more"}
          </button>
        )}
      </div>
    </div>
  );
}
