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
// helpers here (describeMissing, helpText)
// are unit-tested.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import type { AccountsRowStates, DiscoverResult, ProviderEndpoint, ProviderView, SubscriptionStatus } from "../shared/types";
import { autoEligibility, describeMissing } from "../shared/autoEligibility.mjs";
import { providerStateLabel } from "../shared/providerHealthLabel.mjs";
import { isKeyOnlyAuthProvider, selectProviderView } from "./chatUtils";
import { resolveIdentity, type ModelDeclaration } from "../shared/modelIdentity.mjs";
import { qualityScore } from "../shared/modelQuality.mjs";
import { ConfirmInline } from "./ConfirmInline";
import { ConnectProvider } from "./ConnectProvider";
import { SeatsPanel } from "./SeatsPanel";
import { AddSeatGate } from "./AddSeatFlow";
import { refreshAccounts } from "./accountsData";
import { CustomProviderForm } from "./CustomProviderForm";
import { UnpricedModelsPanel } from "./ModelPriceForm";
import { ModelChecklist } from "./ModelChecklist";
import { UpdateBoxNote } from "./components/UpdateBoxNote";
import { useBoxCapability } from "./hooks/useBoxCapabilities";
import { SettingsRow } from "./SettingsRow";
import { MantaLoader } from "./MantaLoader";
import { useCachedResource } from "./useCachedResource";
import { useRoutingCatalog, type RoutingCatalog } from "./routingCatalog";
import { refreshModelCatalog } from "./modelCatalog";
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
  /** The credential is owned outside Manta (e.g. the Claude CLI) — Manta
   *  cannot deliver a Disconnect for it, so the row says so instead. */
  managedExternally?: boolean;
  /** Who owns the credential, e.g. "the Claude CLI on this box". */
  managedBy?: string | null;
  /** Machine keys (autoEligibility MISSING) Auto still needs for a custom row. */
  eligibilityMissing: string[];
  /** Declared price sentence for a custom row that is fully described. */
  declaredPrice?: string;
};

export const STATE_TONE_CLASS: Record<AccountStatus, string> = {
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
  quiet: "text-text-quiet",
};

// The machine-key → phrase map (and `describeMissing`) now live in the shared
// autoEligibility module, so the box's "models we couldn't identify" help
// lines and this card say the same thing. Re-exported for existing importers.
export { describeMissing };

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

// BET-1537 (S5, §W9): the accounts:health response now carries TWO maps — the
// provider facade (keyed by opencode providerID, what gates subscription
// credentials) and the per-ENDPOINT register detail (keyed
// "providerID/modelID", the resolved register state + the rate-limit
// deadline + the last failure's reason). Both come from the ONE health
// engine, so the row/model badges cannot disagree with what blocks Auto.
type HealthMap = Record<string, { state: string; retryInMs?: number | null }>;

type EndpointHealthEntry = {
  state: string;
  until?: number;
  retryInMs?: number;
  streak?: number;
  since?: number;
  // §W9 window activity (server-computed from the aggregates, probe-excluded).
  lastSuccessAt?: number;
  attempts?: number;
  successes?: number;
  reason?: { httpStatus?: number | null; errorName?: string | null } | null;
  /** The one-line state, worded by the box (WS11 D4 / K3). */
  stateLine?: string;
};

type AccountsHealth = {
  providers?: HealthMap;
  endpoints?: Record<string, EndpointHealthEntry>;
  /** The worst endpoint per provider, worded by the box. */
  providerLines?: Record<string, { key: string | null; stateLine: string }>;
} | null;

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
  state: boxState,
  rawHealth,
  seatView,
  busy,
  connectState,
  onConnect,
  onSeatAdded,
  onConnectChange,
  onDisconnect,
  onRetry,
  onDiscover,
  onRemove,
}: {
  row: AccountRowModel;
  /** What the box says this row reads and offers (`accounts:row-states`); null on an older box. */
  state: { text: string; tone: "ok" | "warn" | "danger" | "quiet"; control: "retry" | "disconnect" | "connect" | "none" } | null;
  /** The provider's raw health state — only the older-box fallback label reads it. */
  rawHealth?: string;
  /** The provider's accounts/seats when multi-account is in use for it. Then the
   *  row's Connect adds an ACCOUNT through the seat flow; it must never start a
   *  live login (that would replace the box's own login and add no seat). */
  seatView: ProviderView | null;
  busy: string | null;
  connectState: {
    connectingId: string | null;
    disconnectConfirmId: string | null;
    removeConfirmId: string | null;
    setConnectingId: (id: string | null) => void;
    setDisconnectConfirmId: (id: string | null) => void;
    setRemoveConfirmId: (id: string | null) => void;
  };
  onConnect: (id: string) => void;
  onSeatAdded: (id: string, message: string) => void;
  onConnectChange: (id: string, label: string) => void;
  onDisconnect: (id: string) => void;
  onRetry: (id: string) => void;
  onDiscover: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  // An older box sends no row states: show its raw health label (no controls — their
  // precedence is the box's) and the page shows the update note.
  const state = boxState ?? { text: providerStateLabel(rawHealth ?? "") ?? "", tone: "quiet" as const, control: "none" as const };
  const isBusy = busy === row.id;
  const {
    connectingId,
    disconnectConfirmId,
    removeConfirmId,
    setConnectingId,
    setDisconnectConfirmId,
    setRemoveConfirmId,
  } = connectState;

  // Server-owned destructive action (remove / disconnect) now restarts
  // opencode on the box, interrupting every running session — the confirm
  // spells that consequence out (BET-1320). Rendered inline, not a modal.
  const confirmBlock = (label: string, confirm: () => void, cancel: () => void) => (
    <div className="space-y-1">
      <div className="inline-flex items-center gap-2">
        <ConfirmInline
          label={label}
          busy={isBusy}
          onConfirm={confirm}
          onCancel={cancel}
        />
      </div>
      <div className="text-meta text-text-muted">
        This restarts opencode and interrupts every running session.
      </div>
    </div>
  );

  let control: ReactNode;

  if (state.control === "retry") {
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
          removeConfirmId === row.id ? (
            confirmBlock(
              "Remove",
              () => onRemove(row.id),
              () => setRemoveConfirmId(null),
            )
          ) : (
            <>
              <button
                onClick={() => onDiscover(row.id)}
                disabled={isBusy}
                className="px-2 py-1 text-meta bg-bg-soft border border-border rounded-xs text-text-muted hover:text-text disabled:opacity-40"
              >
                {isBusy ? "…" : "Refresh"}
              </button>
              <button
                onClick={() => {
                  if (busy !== null) return;
                  setRemoveConfirmId(row.id);
                }}
                disabled={busy !== null}
                className="text-meta text-text-faint hover:text-text px-1 inline-flex items-center"
                title="Remove endpoint"
                aria-label={`Remove ${row.name}`}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </>
          )
        ) : state.control === "none" ? (
          // Credential owned by the Claude CLI — no Disconnect Manta can
          // deliver; the state text already says who owns it (BET-1320). On an
          // older box (no row states) no control is offered at all.
          null
        ) : state.control === "disconnect" ? (
          disconnectConfirmId === row.id ? (
            confirmBlock(
              "Disconnect",
              () => onDisconnect(row.id),
              () => setDisconnectConfirmId(null),
            )
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
            onClick={() => onConnect(row.id)}
            disabled={busy !== null || connectingId !== null}
            title={seatView ? `Sign in another ${row.name} account` : undefined}
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

      {row.className !== "Custom" && !seatView && row.connected && row.managedExternally && (
        <div className="pl-4 text-meta text-text-muted break-words" data-testid={`external-signin-hint-${row.id}`}>
          Signed in with {row.managedBy ?? "an external tool"}. If Manta says it needs to reconnect, run{" "}
          <code>claude auth login</code> on the box and sign in with the same account.
        </div>
      )}
      {/* Kimi signs in with an API key and has no seats: Disconnect + Connect with
          a new key is its whole recovery path, so say so next to those buttons. */}
      {row.className !== "Custom" && !seatView && row.connected && !row.managedExternally && isKeyOnlyAuthProvider(row.id) && (
        <div className="pl-4 text-meta text-text-muted break-words" data-testid={`key-reconnect-hint-${row.id}`}>
          If Manta says this needs to reconnect, Disconnect and Connect again with a new key.
        </div>
      )}

      {connectingId === row.id && (
        <div className="pl-4">
          {seatView ? (
            <AddSeatGate
              provider={seatView.provider}
              view={seatView}
              onDone={(message) => onSeatAdded(row.id, message)}
              onCancel={() => setConnectingId(null)}
            />
          ) : (
            <ConnectProvider
              id={row.id}
              label={row.name}
              onDone={() => onConnectChange(row.id, row.name)}
              onCancel={() => setConnectingId(null)}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ===== The one list component =====

/**
 * BET-1537 (S5, §W9): the custom-endpoint row's register line — the worst
 * endpoint state in the register with its deadline, failure reason and window
 * activity, plus the "Send probe" control. The words are the BOX's (`line` is
 * `accounts:row-states` → `registerLine`; WS11 D4): never a client-side guess.
 */
function EndpointRegisterLine({
  providerID,
  line,
  onProbe,
  probeDisabled,
}: {
  providerID: string;
  /** null = the register has nothing to say and no model is enabled → render nothing. */
  line: string | null;
  onProbe: () => void;
  probeDisabled: boolean;
}) {
  if (line == null) return null;
  return (
    <div className="flex items-center gap-2 flex-wrap" data-testid={`endpoint-register-${providerID}`}>
      <span className="text-meta text-text-faint">{line}</span>
      <button
        type="button"
        className="text-meta underline text-text-faint hover:text-text-quiet"
        onClick={onProbe}
        disabled={probeDisabled}
      >
        Send probe
      </button>
    </div>
  );
}

type AccountsData = {
  statuses: SubscriptionStatus[];
  providers: ProviderEndpoint[];
  health: AccountsHealth;
  /** `accounts:row-states` — null on an older box / a failed read. */
  rowStates: AccountsRowStates["rows"] | null;
  declared: Record<string, DeclaredModel> | undefined;
};

export function AccountsCard() {
  const snapshots = useStore((s) => s.usage) ?? [];
  const seatViews = useStore((s) => s.accounts);
  const accountsCopyCap = useBoxCapability("accounts-copy-1");
  const routingCatalog = useRoutingCatalog();

  const [busy, setBusy] = useState<string | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [disconnectConfirmId, setDisconnectConfirmId] = useState<string | null>(null);
  const [removeConfirmId, setRemoveConfirmId] = useState<string | null>(null);
  // Per-endpoint retry verdict: `ok:true` = flag cleared (text-ok), `ok:false` = still refused (text-danger).
  const [retryResult, setRetryResult] = useState<Record<string, { ok: boolean; message: string }>>({});
  // Per-endpoint discovery result (BET-1273 9a/9b): the discovered model list
  // persists so an unticked model stays visible and re-tickable, and the error
  // string renders in text-danger — both branches reported, never discard.
  const [discovered, setDiscovered] = useState<Record<string, { id: string }[]>>({});
  const [discoverError, setDiscoverError] = useState<Record<string, string>>({});

  // Seat data refreshes whenever Settings → Accounts opens (spec §7a).
  useEffect(() => {
    void refreshAccounts();
  }, []);

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
    const rowStates = await window.api.accountsRowStates().then((r) => r.rows).catch(() => null);
    return { statuses: res.providers, providers, health, rowStates, declared };
  });

  // BET-1537 (§W9): this provider's endpoint-register entries, keyed by model
  // id for the ModelChecklist badges. The key format is the router's own
  // endpointKey ("providerID/modelID"), so a key that does not start with the
  // provider id (or a malformed one) is never this provider's.
  const endpointStatesFor = useCallback(
    (providerID: string): Record<string, EndpointHealthEntry> => {
      const all = data?.health?.endpoints ?? {};
      const out: Record<string, EndpointHealthEntry> = {};
      const prefix = `${providerID}/`;
      for (const [key, entry] of Object.entries(all)) {
        if (!key.startsWith(prefix)) continue;
        out[key.slice(prefix.length)] = entry;
      }
      return out;
    },
    [data],
  );

  const rows = useMemo<AccountRowModel[]>(() => {
    if (!data) return [];
    const statuses = data.statuses ?? [];
    const providers = data.providers ?? [];

    // The row's words, tone and control are the BOX's (`accounts:row-states`);
    // what is assembled here is identity, the help line and eligibility.
    const supported: AccountRowModel[] = statuses.map((s) => ({
      id: s.id,
      className: "Supported" as const,
      kind: "subscription" as const,
      name: s.label,
      plan: s.plan,
      connected: s.connected,
      managedExternally: s.managedExternally,
      managedBy: s.managedBy,
      eligibilityMissing: [],
    }));

    const custom: AccountRowModel[] = providers
      .filter((ep) => !isSubscriptionId(ep.id, statuses))
      .map((ep) => {
        const elig = endpointEligibility(ep, data.declared, routingCatalog.matcher);
        return {
          id: ep.id,
          className: "Custom" as const,
          kind: "declared" as const,
          name: ep.name,
          connected: ep.hasApiKey,
          eligibilityMissing: elig.missing,
          declaredPrice: elig.declaredPrice,
        };
      });

    return [...supported, ...custom];
  }, [data, routingCatalog.matcher]);

  const disconnect = useCallback(
    async (id: string) => {
      if (busy) return;
      setBusy(id);
      await mutate(async () => {
        const res = await window.api.opencodeProviderAuth({ action: "disconnect", id });
        if (res.action !== "disconnect") throw new Error("Unexpected response from the box.");
        if (!res.ok) throw new Error(res.error ?? "Disconnect failed.");
        refreshModelCatalog();
        void refresh();
      });
      setBusy(null);
      setDisconnectConfirmId(null);
    },
    [busy, mutate, refresh],
  );

  const onConnectChange = useCallback(() => {
    setConnectingId(null);
    refreshModelCatalog();
    void refresh();
  }, [refresh]);

  // The seat list must be known before Connect decides which flow it opens: a
  // provider that already has seats must not get a live login started on it.
  const startConnect = useCallback(async (id: string) => {
    await refreshAccounts();
    setConnectingId(id);
  }, []);

  // A seat/account was added through the row's Connect: the panel closes, the
  // list (already refreshed by the flow) shows it, and this line names it.
  const [seatNotice, setSeatNotice] = useState<Record<string, { message: string; n: number }>>({});
  const onSeatAdded = useCallback(
    (id: string, message: string) => {
      setConnectingId(null);
      setSeatNotice((n) => ({ ...n, [id]: { message, n: (n[id]?.n ?? 0) + 1 } }));
      refreshModelCatalog();
      void refresh();
    },
    [refresh],
  );

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
        if (data?.rowStates?.[id]?.control === "retry") {
          next[id] = v;
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [data]);

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
        refreshModelCatalog();
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

  // BET-1537 (§W9): "Send probe" on a custom endpoint row — force a health
  // probe against the row's worst register entry (or its first enabled model
  // when the register has nothing yet) and report BOTH branches, never
  // discard (same discipline as Refresh/Try again).
  const [probeResult, setProbeResult] = useState<Record<string, { ok: boolean; message: string }>>({});
  const probe = useCallback(
    async (ep: ProviderEndpoint) => {
      if (busy) return;
      // The box names the worst register key; else the first enabled model.
      const key = data?.health?.providerLines?.[ep.id]?.key ?? (ep.enabledModels.length > 0 ? `${ep.id}/${ep.enabledModels[0]}` : "");
      if (!key) return;
      setBusy(ep.id);
      try {
        const res = await window.api.accountsEndpointProbe(key);
        const ok = res?.ok === true;
        setProbeResult((r) => ({
          ...r,
          [ep.id]: { ok, message: res?.message ?? (ok ? "Probe passed." : "Probe failed — try again.") },
        }));
        void refresh();
      } catch (e) {
        setProbeResult((r) => ({
          ...r,
          [ep.id]: { ok: false, message: e instanceof Error ? e.message : "Probe failed — try again." },
        }));
      } finally {
        setBusy(null);
      }
    },
    [busy, data, refresh],
  );

  const removeEndpoint = useCallback(
    async (ep: ProviderEndpoint) => {
      if (busy) return;
      setBusy(ep.id);
      await mutate(async () => {
        const res = await window.api.opencodeSetProviders({ remove: [ep.id] });
        if (!res.ok) throw new Error(res.error ?? "Remove failed");
        // BET-1318: the server restarts opencode itself as part of the remove
        // op — do NOT raise the shared restart banner here (it would ask the
        // user to do something already done). Keep the removed endpoint's
        // discovery state cleared.
        setDiscovered((d) => {
          const { [ep.id]: _drop, ...rest } = d;
          return rest;
        });
        setDiscoverError((er) => {
          const { [ep.id]: _drop, ...rest } = er;
          return rest;
        });
        refreshModelCatalog();
        void refresh();
      });
      setBusy(null);
      setRemoveConfirmId(null);
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
      {accountsCopyCap === false && <UpdateBoxNote />}

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
            const seatView = row.kind === "subscription" ? selectProviderView(seatViews, snapshots, row.id) : null;
            return (
              <div key={row.id}>
                <AccountRow
                  row={row}
                  state={data?.rowStates?.[row.id] ?? null}
                  rawHealth={data?.health?.providers?.[row.id]?.state}
                  seatView={seatView}
                  onConnect={(id) => void startConnect(id)}
                  onSeatAdded={onSeatAdded}
                  busy={busy}
                  connectState={{
                    connectingId,
                    disconnectConfirmId,
                    removeConfirmId,
                    setConnectingId,
                    setDisconnectConfirmId,
                    setRemoveConfirmId,
                  }}
                  onConnectChange={onConnectChange}
                  onDisconnect={(id) => void disconnect(id)}
                  onRetry={(id) => void retry(id)}
                  onDiscover={() => ep && void discover(ep)}
                  onRemove={() => ep && void removeEndpoint(ep)}
                />
                {seatView && <SeatsPanel view={seatView} openSignal={seatNotice[row.id]?.n} />}
                {seatNotice[row.id] && (
                  <div role="status" data-testid={`seat-notice-${row.id}`} className="text-meta text-ok pl-4 break-words">
                    {seatNotice[row.id].message}
                  </div>
                )}
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
                    <EndpointRegisterLine
                      providerID={ep.id}
                      line={data?.rowStates?.[ep.id]?.registerLine ?? null}
                      onProbe={() => void probe(ep)}
                      probeDisabled={busy === row.id}
                    />
                    {probeResult[ep.id] && (
                      <div
                        role="status"
                        data-testid={`probe-result-${ep.id}`}
                        className={`text-meta ${probeResult[ep.id].ok ? "text-ok" : "text-danger"} break-words`}
                      >
                        {probeResult[ep.id].message}
                      </div>
                    )}
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
                      states={endpointStatesFor(ep.id)}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Sticky-trims §3.4: connected models the optimizer can't price. Renders
          nothing when every model is priced or the box can't report prices. */}
      <UnpricedModelsPanel names={Object.fromEntries(rows.map((r) => [r.id, r.name]))} />

      <CustomProviderForm onSaved={() => void refresh()} />

      <div className="text-meta text-text-quiet pt-3 border-t border-border-subtle">
        One list: subscriptions and custom endpoints are both a way to reach a
        model that costs something and can run out. Supported rows show real
        numbers; custom rows show none, and say what Auto still needs.
      </div>
    </div>
  );
}
