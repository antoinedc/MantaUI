// ===== AccountsCard (BET-1250) =====
//
// The ONE Accounts list in Settings. Subscriptions and custom endpoints are
// both "a way to reach a model that costs something and can run out", so they
// live in a single list with a single row renderer — two separate cards is the
// defect this replaces. Supported rows (subscriptions) show real usage
// readings; custom rows show none, and name what Auto still needs.
//
// One list component (AccountsCard) + one row component (AccountRow). The
// connect/disconnect (subscription) and refresh/remove + model toggles (custom)
// flows are folded into that single row; the shared sub-components
// (ConnectProvider, CustomProviderForm) are reused as-is.
//
// The state column is built from the SAME sources that gate the router:
//   - usage readings (window / pace / balance) from the store's usage slice —
//     the identical state the composer dial reads, no second fetch;
//   - health (out-of-credit / rate-limited / failing) from providerHealth via
//     the `accounts:health` RPC — the same engine that excludes Auto, so the
//     UI can never claim something different from what blocks routing;
//   - credential absence (not connected) from the subscription status /
//     provider hasApiKey;
//   - Auto-eligibility gaps for custom rows from the SHARED autoEligibility
//     gate (the one gate the router waits on).
//
// Freshness is refetch-driven (no poll, no bus subscription) — the standing
// desktop-renderer precedent (see the retired SubscriptionsCard). The pure
// helpers here (describeAccountState, describeMissing, usagePace, helpText)
// are unit-tested.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import type { DiscoverResult, ProviderEndpoint, SubscriptionStatus, UsageSnapshot, UsageWindow } from "../shared/types";
import { autoEligibility, MISSING } from "../shared/autoEligibility.mjs";
import { providerStateLabel } from "../shared/providerHealthLabel.mjs";
import { resolveIdentity, type ModelDeclaration } from "../shared/modelIdentity.mjs";
import { qualityScore } from "../shared/modelQuality.mjs";
import { ConnectProvider } from "./ConnectProvider";
import { CustomProviderForm } from "./CustomProviderForm";
import { ModelChecklist } from "./ModelChecklist";
import { SettingsRow } from "./SettingsRow";
import { MantaLoader } from "./MantaLoader";
import { useCachedResource } from "./useCachedResource";
import { useRoutingCatalog, type RoutingCatalog } from "./routingCatalog";
import { useStore } from "./store";

// ===== Pure row logic (unit-tested) =====

export type AccountStatus = "ok" | "warn" | "danger" | "quiet";

export type AccountState = { text: string; tone: AccountStatus };

export type DeclaredModel = {
  catalogId?: string;
  price?: { input?: number; output?: number } | "free";
  caches?: boolean | { read?: boolean; write?: boolean };
};

export type AccountRowModel = {
  /** opencode providerID — the key accounts:health and usage match on. */
  id: string;
  className: "Supported" | "Custom";
  kind: "subscription" | "declared";
  name: string;
  plan?: string;
  /** credential present (subscription connected / custom has an api key). */
  connected: boolean;
  /** A usage reading (window label / pct / pace) when one exists. `pace` is
   *  null when the window carries no timing — never a fabricated pace. */
  reading: { label: string; pct: number; pace: string | null } | null;
  /** Credit balance in dollars, or null when unknown. */
  balance: number | null;
  /** `unknown` when no health engine/entry exists — rendered as no state, never as healthy. */
  health: "ok" | "unknown" | "out-of-credit" | "rate-limited" | "failing";
  /** Remaining rate-limit cooldown, whole minutes (health === "rate-limited"). */
  retryInMinutes?: number;
  /** Machine keys (autoEligibility MISSING) Auto still needs for a custom row. */
  eligibilityMissing: string[];
  /** Declared price sentence for a custom row that is fully described. */
  declaredPrice?: string;
};

const LOW_BALANCE_DOLLARS = 5;

const formatDollars = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : String(n));

/**
 * The state column for an account row — one always-honest string. `No usage
 * data` is never a zero, never a full/empty bar: a reading is real or absent.
 * Precedence: on-fire health outranks a reading (a window pct is not the story
 * when the provider is refusing work); a reading outranks a balance; then
 * credential absence; then "no usage data".
 */
export function describeAccountState(r: AccountRowModel): AccountState {
  if (r.health === "out-of-credit") return { text: providerStateLabel("out-of-credit") ?? "Out of credit", tone: "danger" };
  if (r.health === "rate-limited") {
    const base = providerStateLabel("rate-limited") ?? "Rate limited";
    return {
      text: r.retryInMinutes ? `${base} · retry in ${r.retryInMinutes}m` : base,
      tone: "warn",
    };
  }
  if (r.health === "failing") return { text: providerStateLabel("failing") ?? "Not responding", tone: "warn" };
  if (r.reading) {
    const pct = r.reading.pct;
    const tone: AccountStatus = pct >= 90 ? "danger" : pct >= 70 ? "warn" : "ok";
    // No timing data ⇒ no pace clause: a pace is real or absent, never a guess
    // (BET-1273 9e).
    const text = r.reading.pace
      ? `${r.reading.label} ${pct}% · ${r.reading.pace}`
      : `${r.reading.label} ${pct}%`;
    return { text, tone };
  }
  if (typeof r.balance === "number" && Number.isFinite(r.balance)) {
    return {
      text: `$${formatDollars(r.balance)} remaining`,
      tone: r.balance < LOW_BALANCE_DOLLARS ? "danger" : "ok",
    };
  }
  if (!r.connected) return { text: "Not connected", tone: "quiet" };
  return { text: "No usage data", tone: "quiet" };
}

export const STATE_TONE_CLASS: Record<AccountStatus, string> = {
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
  quiet: "text-text-quiet",
};

/**
 * Classify a subscription window's pace ("under" / "on" / "over") from how fast
 * it is being consumed against how far through the window we are. Deterministic
 * on (nowMs, window). A window with NO timing carries no pace — a pace invented
 * from a percentage alone is a false claim (BET-1273 9e), so it returns null.
 */
export function usagePace(w: UsageWindow, nowMs: number): string | null {
  if (typeof w.startedAt === "number" && typeof w.resetsAt === "number" && w.resetsAt > w.startedAt) {
    const elapsed = (nowMs - w.startedAt) / (w.resetsAt - w.startedAt);
    if (elapsed > 0) {
      const ratio = w.pct / 100 / elapsed;
      if (ratio < 0.9) return "under pace";
      if (ratio > 1.1) return "over pace";
      return "on pace";
    }
  }
  return null;
}

// The machine-key → phrase map lives HERE, in the renderer, once. autoEligibility
// deliberately carries no user-facing copy; the router and this UI share the
// same MISSING keys by construction.
const MISSING_PHRASE: Record<string, string> = {
  [MISSING.IDENTITY]: "which model",
  [MISSING.PRICE]: "what it costs",
  [MISSING.CACHING]: "whether it caches",
  [MISSING.QUALITY]: "how it compares",
};

/** Join missing-eligibility keys into "which model, what it costs, and …". */
export function describeMissing(missing: readonly string[]): string | null {
  const phrases = missing.filter((k) => k in MISSING_PHRASE).map((k) => MISSING_PHRASE[k]);
  if (phrases.length === 0) return null;
  if (phrases.length === 1) return phrases[0];
  const head = phrases.slice(0, -1);
  // Oxford comma style: "which model, and whether it caches" (2+) and
  // "which model, what it costs, whether it caches, and how it compares" (4).
  return `${head.join(", ")}, and ${phrases[phrases.length - 1]}`;
}

/** The row's help line: "Supported · subscription · Max 20x" or the custom form. */
export function helpText(r: AccountRowModel): string {
  if (r.className === "Custom") {
    const missing = describeMissing(r.eligibilityMissing);
    if (missing) return `Custom · Auto needs: ${missing}`;
    return `Custom · declared${r.declaredPrice ? ` · ${r.declaredPrice}` : ""}`;
  }
  return `Supported · subscription${r.plan ? ` · ${r.plan}` : ""}`;
}

// ===== Row assembly (card-side) =====

type HealthMap = Record<string, { state: string; retryInMs?: number | null }>;

function normalizeHealth(h: HealthMap | null | undefined, id: string): {
  health: AccountRowModel["health"];
  retryInMinutes?: number;
} {
  const entry = h?.[id];
  const st =
    entry?.state === "out-of-credit" || entry?.state === "rate-limited" || entry?.state === "failing"
      ? entry.state
      : undefined;
  if (st) {
    const retryInMinutes =
      st === "rate-limited" && typeof entry?.retryInMs === "number"
        ? Math.max(1, Math.ceil((entry.retryInMs ?? 0) / 60000))
        : undefined;
    return { health: st, retryInMinutes };
  }
  // No health entry / engine is UNKNOWN, not healthy — "we have no health data"
  // must never render as "this provider is fine" (BET-1273 9f).
  return { health: "unknown" };
}

function subscriptionReading(snap: UsageSnapshot | undefined, nowMs: number) {
  if (!snap || !Array.isArray(snap.windows) || snap.windows.length === 0) return null;
  const w = snap.windows[0];
  if (typeof w?.pct !== "number") return null;
  return { label: w.label ?? "", pct: w.pct, pace: usagePace(w, nowMs) };
}

const isSubscriptionId = (id: string, statuses: SubscriptionStatus[]) =>
  statuses.some((s) => s.id === id);

/**
 * Auto-eligibility gaps for a custom endpoint — the same gate the router waits
 * on, with the ONE-gate rule applied at the ENDPOINT level. The router will not
 * route an endpoint until EVERY model on it is describable, so the row's
 * "Auto needs" set is the UNION of the per-model gaps across all enabled
 * models. An endpoint that reads "fully described" while a later model still
 * blocks routing is exactly the drift this issue exists to prevent.
 */
export function endpointEligibility(
  ep: ProviderEndpoint,
  declared: Record<string, DeclaredModel> | undefined,
  matcher: RoutingCatalog["matcher"],
): { missing: string[]; declaredPrice?: string } {
  const modelIds = ep.enabledModels?.length ? ep.enabledModels : [null as string | null];
  const missing = new Set<string>();
  let declaredPrice: string | undefined;

  for (const modelId of modelIds) {
    const key = modelId ? `${ep.id}/${modelId}` : null;
    const decl = key ? declared?.[key] : undefined;

    // The candidate — the SAME (provider, model) pair the router judges
    // (modelRouter assess / incumbentStillEligible). Eligibility is computed
    // against the RESOLVED endpoint (identity.effective — declaration merged
    // over the catalogue over the provider's own claims), never an empty
    // model, so PRICE/CACHING/QUALITY reflect what the endpoint actually told
    // us (BET-1273 9d). The card and the router answer the same question about
    // the same object — that is the whole point of sharing the gate.
    const candidate = { providerID: ep.id, id: modelId ?? "" };
    const identity = resolveIdentity(
      candidate,
      // The renderer's DeclaredModel permits `caches: true`; modelIdentity's
      // ModelDeclaration types a declaration-noted absence only. Cast (runtime
      // shape agrees) for reuse of the shared resolver (BET-1273 9d).
      (decl ?? null) as ModelDeclaration | null,
      matcher ?? null,
    );
    const model = identity.effective ?? candidate;
    const catalogEntry = (
      identity.catalogId && matcher ? matcher.lookupModel(identity.catalogId) : null
      // CatalogEntry.limit is typed `number` in modelQuality but the catalogue
      // entry carries {context, output}; runtime shape is compatible.
    ) as unknown as Parameters<typeof qualityScore>[1];
    const quality = qualityScore(model, catalogEntry, undefined);

    const result = autoEligibility({
      model,
      identity: { known: identity.state === "resolved" },
      quality,
      declared: decl,
      providerClass: "custom",
    });
    for (const k of result.missing) missing.add(k);

    if (declaredPrice == null && decl?.price && decl.price !== "free" && typeof decl.price === "object") {
      const p = decl.price as { input?: number; output?: number };
      if (Number.isFinite(p.input ?? 0) || Number.isFinite(p.output ?? 0)) {
        const input = Number.isFinite(p.input ?? 0) ? (p.input as number) : 0;
        const output = Number.isFinite(p.output ?? 0) ? (p.output as number) : 0;
        declaredPrice = `$${input.toFixed(2)} / $${output.toFixed(2)} per M`;
      }
    }
  }

  return { missing: [...missing], declaredPrice };
}

// ===== The one row component =====

function AccountRow({
  row,
  busy,
  connectState,
  onConnectChange,
  onDisconnect,
  onRetry,
  onDiscover,
  onRemove,
}: {
  row: AccountRowModel;
  busy: string | null;
  connectState: {
    connectingId: string | null;
    disconnectConfirmId: string | null;
    setConnectingId: (id: string | null) => void;
    setDisconnectConfirmId: (id: string | null) => void;
  };
  onConnectChange: (id: string, label: string) => void;
  onDisconnect: (id: string) => void;
  onRetry: (id: string) => void;
  onDiscover: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const state = describeAccountState(row);
  const isBusy = busy === row.id;
  const { connectingId, disconnectConfirmId, setConnectingId, setDisconnectConfirmId } = connectState;

  let control: ReactNode;

  if (row.health === "out-of-credit") {
    control = (
      <>
        <span className={STATE_TONE_CLASS[state.tone]}>{state.text}</span>
        <button
          onClick={() => onRetry(row.id)}
          disabled={isBusy}
          className="px-2 py-1 text-meta bg-bg-soft border border-border rounded-xs text-text-muted hover:text-text disabled:opacity-40"
          title={
            row.className === "Custom"
              ? "I've topped this up — clears the flag, sends no traffic."
              : "Re-read the meter and clear the out-of-credit flag if it reports funds."
          }
        >
          {isBusy ? "…" : "Try again"}
        </button>
      </>
    );
  } else {
    control = (
      <>
        <span className={STATE_TONE_CLASS[state.tone]}>{state.text}</span>
        {row.className === "Custom" ? (
          <>
            <button
              onClick={() => onDiscover(row.id)}
              disabled={isBusy}
              className="px-2 py-1 text-meta bg-bg-soft border border-border rounded-xs text-text-muted hover:text-text disabled:opacity-40"
            >
              {isBusy ? "…" : "Refresh"}
            </button>
            <button
              onClick={() => onRemove(row.id)}
              disabled={isBusy}
              className="text-meta text-text-faint hover:text-text px-1 inline-flex items-center"
              title="Remove endpoint"
              aria-label={`Remove ${row.name}`}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </>
        ) : row.connected ? (
          disconnectConfirmId === row.id ? (
            <>
              <button
                onClick={() => onDisconnect(row.id)}
                disabled={busy !== null}
                className="px-2 py-1 text-meta bg-danger-bg border border-danger rounded-xs text-danger hover:text-danger disabled:opacity-40"
              >
                {busy === row.id ? "…" : "Disconnect"}
              </button>
              <button
                onClick={() => setDisconnectConfirmId(null)}
                disabled={busy !== null}
                className="px-2 py-1 text-meta text-text-faint hover:text-text disabled:opacity-40"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              onClick={() => setDisconnectConfirmId(row.id)}
              disabled={busy !== null || connectingId !== null}
              className="px-2 py-1 text-meta bg-bg-soft border border-border rounded-xs text-text-muted hover:text-text disabled:opacity-40"
            >
              Disconnect
            </button>
          )
        ) : (
          <button
            onClick={() => setConnectingId(row.id)}
            disabled={busy !== null || connectingId !== null}
            className="px-2 py-1 text-meta bg-bg-soft border border-border rounded-xs text-text-muted hover:text-text disabled:opacity-40"
          >
            Connect
          </button>
        )}
      </>
    );
  }

  return (
    <div className="space-y-2">
      <SettingsRow name={row.name} help={helpText(row)}>
        {control}
      </SettingsRow>

      {connectingId === row.id && (
        <div className="pl-4">
          <ConnectProvider
            id={row.id}
            label={row.name}
            onDone={() => onConnectChange(row.id, row.name)}
            onCancel={() => setConnectingId(null)}
          />
        </div>
      )}
    </div>
  );
}

// ===== The one list component =====

type AccountsData = {
  statuses: SubscriptionStatus[];
  providers: ProviderEndpoint[];
  health: HealthMap | null;
  declared: Record<string, DeclaredModel> | undefined;
};

export function AccountsCard() {
  const snapshots = useStore((s) => s.usage) ?? [];
  const [nowMs] = useState(() => Date.now());
  const routingCatalog = useRoutingCatalog();

  const [busy, setBusy] = useState<string | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [disconnectConfirmId, setDisconnectConfirmId] = useState<string | null>(null);
  // Per-endpoint retry verdict: `ok:true` = flag cleared (text-ok), `ok:false` = still refused (text-danger).
  const [retryResult, setRetryResult] = useState<Record<string, { ok: boolean; message: string }>>({});
  // Per-endpoint discovery result (BET-1273 9a/9b): the discovered model list
  // persists so an unticked model stays visible and re-tickable, and the error
  // string renders in text-danger — both branches reported, never discard.
  const [discovered, setDiscovered] = useState<Record<string, { id: string }[]>>({});
  const [discoverError, setDiscoverError] = useState<Record<string, string>>({});

  const {
    data,
    loading,
    error,
    refresh,
    mutate,
  } = useCachedResource<AccountsData>("accounts", async () => {
    const res = await window.api.opencodeProviderAuth({ action: "status" });
    if (res.action !== "status") throw new Error("Unexpected response from the box.");
    const providers = await window.api.opencodeGetProviders().catch(() => []);
    const health = await window.api.accountHealth().catch(() => null);
    const cfg = await window.api.configGet().catch(() => null);
    const declared = (cfg as { modelRouting?: { declaredModels?: Record<string, DeclaredModel> } } | null)
      ?.modelRouting?.declaredModels;
    return { statuses: res.providers, providers, health, declared };
  });

  const rows = useMemo<AccountRowModel[]>(() => {
    if (!data) return [];
    const statuses = data.statuses ?? [];
    const providers = data.providers ?? [];
    const health = data.health;

    const supported: AccountRowModel[] = statuses.map((s) => {
      const snap = snapshots.find((u) => u.providerIDs?.includes(s.id));
      const reading = subscriptionReading(snap, nowMs);
      const balance = typeof snap?.balance === "number" ? snap.balance : null;
      const { health: h, retryInMinutes } = normalizeHealth(health, s.id);
      // A reader reporting "exhausted" refuses work — surfaced as a health
      // out-of-credit even before providerHealth sees a 402.
      const effectiveHealth: AccountRowModel["health"] =
        snap?.exhausted === true ? "out-of-credit" : h;
      return {
        id: s.id,
        className: "Supported" as const,
        kind: "subscription" as const,
        name: s.label,
        plan: s.plan,
        connected: s.connected,
        reading,
        balance,
        health: effectiveHealth,
        retryInMinutes,
        eligibilityMissing: [],
      };
    });

    const custom: AccountRowModel[] = providers
      .filter((ep) => !isSubscriptionId(ep.id, statuses))
      .map((ep) => {
        const elig = endpointEligibility(ep, data.declared, routingCatalog.matcher);
        const { health: h, retryInMinutes } = normalizeHealth(health, ep.id);
        return {
          id: ep.id,
          className: "Custom" as const,
          kind: "declared" as const,
          name: ep.name,
          connected: ep.hasApiKey,
          reading: null,
          balance: null,
          health: h,
          retryInMinutes,
          eligibilityMissing: elig.missing,
          declaredPrice: elig.declaredPrice,
        };
      });

    return [...supported, ...custom];
  }, [data, snapshots, nowMs, routingCatalog.matcher]);

  const disconnect = useCallback(
    async (id: string) => {
      if (busy) return;
      setBusy(id);
      await mutate(async () => {
        const res = await window.api.opencodeProviderAuth({ action: "disconnect", id });
        if (res.action !== "disconnect") throw new Error("Unexpected response from the box.");
        if (!res.ok) throw new Error(res.error ?? "Disconnect failed.");
        void refresh();
      });
      setBusy(null);
      setDisconnectConfirmId(null);
    },
    [busy, mutate, refresh],
  );

  const onConnectChange = useCallback(() => {
    setConnectingId(null);
    void refresh();
  }, [refresh]);

  // Try again — reports BOTH outcomes (cleared vs still-refused) per AGENTS.md.
  const retry = useCallback(
    async (id: string) => {
      if (busy) return;
      setBusy(id);
      try {
        const res = await window.api.accountsRetry(id);
        const ok = res?.ok === true;
        setRetryResult((r) => ({
          ...r,
          [id]: { ok, message: res?.message ?? (ok ? "Retry done." : "Retry failed — try again.") },
        }));
        void refresh();
      } catch (e) {
        setRetryResult((r) => ({
          ...r,
          [id]: { ok: false, message: e instanceof Error ? e.message : "Retry failed — try again." },
        }));
      } finally {
        setBusy(null);
      }
    },
    [busy, refresh],
  );

  // A retry verdict only explains an out-of-credit row. The moment the row's
  // health stops being out-of-credit (the retry cleared the flag, or a refetch
  // shows the meter recovered), the verdict is stale — drop it (BET-1273 9c),
  // so a lingering "still reports out of credit" can't sit under a healthy row.
  useEffect(() => {
    setRetryResult((prev) => {
      let changed = false;
      const next: typeof prev = {};
      for (const [id, v] of Object.entries(prev)) {
        if (rows.some((r) => r.id === id && r.health === "out-of-credit")) {
          next[id] = v;
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [rows]);

  const toggleModel = useCallback(
    async (ep: ProviderEndpoint, modelId: string) => {
      if (busy) return;
      const enabled = ep.enabledModels.includes(modelId)
        ? ep.enabledModels.filter((m) => m !== modelId)
        : [...ep.enabledModels, modelId];
      setBusy(ep.id);
      await mutate(async () => {
        const res = await window.api.opencodeSetProviders({
          upsert: [{ id: ep.id, name: ep.name, baseURL: ep.baseURL, enabledModels: enabled }],
        });
        if (!res.ok) throw new Error(res.error ?? "Save failed");
        useStore.getState().setOpencodeRestartNeeded(true);
        void refresh();
      });
      setBusy(null);
    },
    [busy, mutate, refresh],
  );

  // Refresh on a custom endpoint — a read-only probe that reports BOTH
  // branches (BET-1273 9a): success stores the discovered models (which drives
  // the real membership test in 9b) + a confirmation naming the count; failure
  // renders the error in text-danger. Never fire-and-forget, never discard.
  const discover = useCallback(
    async (ep: ProviderEndpoint) => {
      if (busy) return;
      setBusy(ep.id);
      setDiscoverError((e) => ({ ...e, [ep.id]: "" }));
      try {
        const r: DiscoverResult = await window.api.opencodeDiscoverModels(ep.baseURL, "");
        if (r.ok) {
          setDiscovered((d) => ({ ...d, [ep.id]: r.models }));
        } else {
          setDiscoverError((e) => ({
            ...e,
            [ep.id]: `${r.error}${r.detail ? `: ${r.detail}` : ""}`,
          }));
        }
      } catch (e) {
        setDiscoverError((er) => ({ ...er, [ep.id]: e instanceof Error ? e.message : String(e) }));
      } finally {
        setBusy(null);
      }
    },
    [busy],
  );

  const removeEndpoint = useCallback(
    async (ep: ProviderEndpoint) => {
      if (busy) return;
      setBusy(ep.id);
      await mutate(async () => {
        const res = await window.api.opencodeSetProviders({ remove: [ep.id] });
        if (!res.ok) throw new Error(res.error ?? "Remove failed");
        useStore.getState().setOpencodeRestartNeeded(true);
        setDiscovered((d) => {
          const { [ep.id]: _drop, ...rest } = d;
          return rest;
        });
        setDiscoverError((er) => {
          const { [ep.id]: _drop, ...rest } = er;
          return rest;
        });
        void refresh();
      });
      setBusy(null);
    },
    [busy, mutate, refresh],
  );

  return (
    <div className="space-y-2">
      <div className="text-meta text-text-faint">
        Subscriptions and custom endpoints are both a way to reach a model that
        costs something and can run out.
      </div>

      {error && <div className="text-meta text-danger break-words">{error}</div>}

      {loading ? (
        <div className="py-2">
          <MantaLoader size="inline" label="Loading accounts" />
        </div>
      ) : rows.length === 0 ? (
        <div className="text-meta text-text-faint py-2">No accounts configured yet.</div>
      ) : (
        <div className="space-y-4">
          {rows.map((row) => {
            const ep =
              row.className === "Custom"
                ? data?.providers.find((p) => p.id === row.id)
                : undefined;
            return (
              <div key={row.id}>
                <AccountRow
                  row={row}
                  busy={busy}
                  connectState={{
                    connectingId,
                    disconnectConfirmId,
                    setConnectingId,
                    setDisconnectConfirmId,
                  }}
                  onConnectChange={onConnectChange}
                  onDisconnect={(id) => void disconnect(id)}
                  onRetry={(id) => void retry(id)}
                  onDiscover={() => ep && void discover(ep)}
                  onRemove={() => ep && void removeEndpoint(ep)}
                />
                {retryResult[row.id] && (
                  <div
                    role="status"
                    className={`text-meta ${retryResult[row.id].ok ? "text-ok" : "text-danger"} pl-[6px] -mt-1`}
                  >
                    {retryResult[row.id].message}
                  </div>
                )}
                {ep && (
                  <div className="pl-4 space-y-1">
                    <code className="text-meta text-text-faint truncate block">{ep.baseURL}</code>
                    {discoverError[ep.id] && (
                      <div role="alert" className="text-meta text-danger break-words">
                        {discoverError[ep.id]}
                      </div>
                    )}
                    {discovered[ep.id] && discovered[ep.id].length > 0 && (
                      <div role="status" className="text-meta text-ok">
                        Discovered {discovered[ep.id].length} model
                        {discovered[ep.id].length === 1 ? "" : "s"}
                      </div>
                    )}
                    <ModelChecklist
                      models={discovered[ep.id] ?? ep.enabledModels.map((id) => ({ id }))}
                      checked={new Set(ep.enabledModels)}
                      onToggle={(id) => void toggleModel(ep, id)}
                      disabled={busy === row.id}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <CustomProviderForm onSaved={() => void refresh()} />

      <div className="text-meta text-text-quiet pt-3 border-t border-border-subtle">
        One list: subscriptions and custom endpoints are both a way to reach a
        model that costs something and can run out. Supported rows show real
        numbers; custom rows show none, and say what Auto still needs.
      </div>
    </div>
  );
}
