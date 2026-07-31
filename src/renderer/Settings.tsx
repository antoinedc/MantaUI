import { useEffect, useMemo, useRef, useState, type ReactNode, type KeyboardEvent } from "react";
import { X, Search } from "lucide-react";
import { useStore } from "./store";
import { ProvidersCard } from "./ProvidersCard";
import { ModelsCard } from "./ModelsCard";
import { SubscriptionsCard } from "./SubscriptionsCard";
import { PairingQR, PairingCountdown } from "./PairingQR";
import { getMantaPreload } from "./preloadAccess";
import { resolveLauncherFlags } from "./chatShared";
import { applyTheme, type ThemePref } from "./theme";
import { TtlToggle } from "./TtlToggle";
import { useSettingsToasts, useApplySetting, ToastStack } from "./settingsApply";
import { errorDisclosure } from "./settingsError";
import {
  useLaunchers,
  updateLauncherFlag,
  useRegistryUrls,
} from "./settingsShared";
import type {
  AuthPairResult,
  PluginRegistryRow,
} from "../shared/types";
import {
  SETTINGS,
  SETTING_SECTIONS,
  settingsForSection,
  searchSettings,
  sectionIsModified,
  resetAllPayload,
  fieldId,
  type SettingEntry,
  type SettingSectionId,
} from "../shared/settingsSchema";

const PLATFORM = "desktop" as const;

// Render a millisecond timeout as "5s" or "30m".
function formatTimeout(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

// ===== Dialog semantics (BET-419 §C): focus trap + Esc + focus restore =====
function useDialog(onClose: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const opener = document.activeElement as HTMLElement | null;
    const firstFocusable = root.querySelector<HTMLElement>("h2[tabindex], button, input, select, textarea, a[href]");
    (firstFocusable ?? root).focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (e.key !== "Tab") return;
      const focusables = root.querySelectorAll<HTMLElement>(
        'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (opener && typeof opener.focus === "function") opener.focus();
    };
  }, [onClose]);
  return ref;
}

// ===== Schema-driven field components =====
// Each reads its current value from the store and commits via the shared
// apply helper. NO local field state is seeded from the store and resynced
// — that resync was the stomping bug (BET-419 §"The bug"). Text-like fields
// keep a local DRAFT for the duration of focus and commit on blur, so an
// in-progress edit survives any store update that lands while typing.

function ToggleField({ entry, value, onApply }: {
  entry: SettingEntry; value: boolean; onApply: (v: boolean) => void;
}) {
  const id = fieldId(entry);
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="flex items-start gap-3 text-body cursor-pointer">
        <input id={id} type="checkbox" checked={value} onChange={(e) => onApply(e.target.checked)} className="mt-px" />
        <span>
          {entry.label}
          {entry.help && <span className="block text-meta text-text-faint mt-1">{entry.help}</span>}
        </span>
      </label>
    </div>
  );
}

function SegmentedField({ entry, value, onApply }: {
  entry: SettingEntry; value: string; onApply: (v: string) => void;
}) {
  const id = fieldId(entry);
  // cacheTtl uses the shared TtlToggle on desktop (matches the old UI's
  // "1 hour (default)" label). Other segmented controls (theme) render the
  // generic inline-flex.
  if (entry.id === "cacheTtl") {
    return (
      <div className="space-y-1">
        <label htmlFor={id} className="block text-micro font-semibold uppercase text-text-muted">{entry.label}</label>
        <TtlToggle ttl={value as "5m" | "1h"} setTtl={onApply} />
        {entry.help && <div className="text-meta text-text-faint mt-2">{entry.help}</div>}
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-micro font-semibold uppercase text-text-muted">{entry.label}</label>
      <div role="group" aria-label={entry.label} className="inline-flex rounded-lg border border-border overflow-hidden">
        {entry.options?.map((opt) => {
          const selected = value === opt.value;
          return (
            <button
              key={opt.value}
              id={selected ? id : undefined}
              type="button"
              aria-pressed={selected}
              onClick={() => onApply(opt.value)}
              className={`px-4 py-2 text-body capitalize transition-colors border-r border-border last:border-r-0 ${
                selected ? "bg-accent-solid" : "text-text-muted hover:text-text hover:bg-bg-elev"
              }`}
              style={selected ? { color: "var(--on-accent)" } : undefined}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      {entry.help && <span className="block text-meta text-text-faint mt-2">{entry.help}</span>}
    </div>
  );
}

// Text/path (non-credential): local draft committed on blur → toast + Undo.
function TextField({ entry, value, onCommit }: {
  entry: SettingEntry; value: string; onCommit: (v: string) => void;
}) {
  const id = fieldId(entry);
  const [draft, setDraft] = useState(value);
  // Keep the draft in sync with the store ONLY when the field is NOT focused
  // (so an external change — e.g. Undo from another toast — is picked up,
  // but an in-progress edit is never stomped).
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setDraft(value); }, [value]);
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-micro font-semibold uppercase text-text-muted">{entry.label}</label>
      <input
        id={id}
        type="text"
        placeholder={entry.placeholder}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => { focused.current = true; }}
        onBlur={() => {
          focused.current = false;
          if (draft !== value) onCommit(draft);
        }}
        spellCheck={false}
        className="w-full bg-bg-soft border border-border px-3 py-2 text-body rounded focus:outline-none focus:border-accent font-mono"
      />
      {entry.help && <div className="text-meta text-text-faint">{entry.help}</div>}
    </div>
  );
}

// Password (credential): local draft committed on blur → inline "Saved"
// confirmation (role=status), no toast. The ONE blur-commit exception called
// out in the spec.
function PasswordField({ entry, value, onCommit }: {
  entry: SettingEntry; value: string; onCommit: (v: string) => void;
}) {
  const id = fieldId(entry);
  const [draft, setDraft] = useState(value);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setDraft(value); }, [value]);
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-micro font-semibold uppercase text-text-muted">{entry.label}</label>
      <input
        id={id}
        type="password"
        placeholder={entry.placeholder}
        value={draft}
        onChange={(e) => { setDraft(e.target.value); setSavedAt(null); }}
        onFocus={() => { focused.current = true; }}
        onBlur={() => {
          focused.current = false;
          if (draft !== value) { onCommit(draft); setSavedAt(Date.now()); }
        }}
        autoComplete="off"
        spellCheck={false}
        className="w-full bg-bg-soft border border-border px-3 py-2 text-body rounded focus:outline-none focus:border-accent font-mono"
      />
      {entry.help && <div className="text-meta text-text-faint">{entry.help}</div>}
      {savedAt && <div role="status" className="text-meta text-ok">Saved</div>}
    </div>
  );
}

export function Settings({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const { toasts, push, dismiss } = useSettingsToasts();
  const applySetting = useApplySetting(push);
  const dialogRef = useDialog(onClose);

  // Active tab + search — declared early so the plugins effect below can read
  // activeTab without a TDZ violation.
  const [activeTab, setActiveTab] = useState<SettingSectionId>("general");
  const [query, setQuery] = useState("");
  const inSearch = query.trim().length > 0;
  const searchHits = useMemo(() => searchSettings(SETTINGS, query, PLATFORM), [query]);

  // Current config values for schema-driven fields, read directly from the
  // store (NO local field state → no stomping bug).
  const values: Record<string, unknown> = useMemo(
    () => ({
      cacheTtl: store.cacheTtl,
      groqApiKey: store.groqApiKey,
      voiceTranscriptionModel: store.voiceTranscriptionModel,
      voiceCommandModel: store.voiceCommandModel,
      allowAgentPush: store.allowAgentPush,
      downloadsDir: store.downloadsDir,
      worktreePerSession: store.worktreePerSession,
      worktreeCleanOnClose: store.worktreeCleanOnClose,
      theme: store.theme,
      autoRenameSessions: store.autoRenameSessions,
    }),
    [store.cacheTtl, store.groqApiKey, store.voiceTranscriptionModel, store.voiceCommandModel, store.allowAgentPush, store.downloadsDir, store.worktreePerSession, store.worktreeCleanOnClose, store.theme, store.autoRenameSessions],
  );

  const commitKey = async (entry: SettingEntry, nextValue: unknown) => {
    if (entry.configKey == null) return;
    const prev = values[entry.configKey];
    await applySetting(entry, nextValue, prev);
  };

  // Client + server versions for About.
  const [clientVersion, setClientVersion] = useState<string | null>(null);
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const [opencodeVersion, setOpencodeVersion] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      window.api.getClientVersion?.().catch(() => null),
      window.api.getServerVersion?.().catch(() => null),
    ]).then(([client, server]) => {
      if (cancelled) return;
      if (client && typeof client.version === "string") setClientVersion(client.version);
      if (server && typeof server.version === "string") setServerVersion(server.version);
      // BET-428: opencode version ships in the same getServerVersion response
      // (opencode's HTTP API has no version endpoint, so the server shells out
      // to `opencode --version` once at startup). Only render when it's a real
      // value — FALLBACK_VERSION ("0.0.0") means opencode isn't installed, so
      // we hide the line rather than show a misleading "v0.0.0".
      if (server && typeof server.opencodeVersion === "string" && server.opencodeVersion && server.opencodeVersion !== "0.0.0") setOpencodeVersion(server.opencodeVersion);
    });
    return () => { cancelled = true; };
  }, []);

  // opencode port — exposed in the Box "Advanced" row (BET-420). Read via
  // configGet (it's an AppConfig key with no store mirror) and committed via
  // configUpdate. Not part of the schema-driven simple fields.
  const [opencodePort, setOpencodePort] = useState<number | null>(null);
  const [opencodePortDraft, setOpencodePortDraft] = useState("");
  const [opencodePortSavedAt, setOpencodePortSavedAt] = useState<number | null>(null);
  useEffect(() => {
    window.api.configGet().then((c) => {
      const port = typeof c.opencodePort === "number" ? c.opencodePort : 14096;
      setOpencodePort(port);
      setOpencodePortDraft(String(port));
    }).catch(() => {});
  }, []);
  const commitOpencodePort = () => {
    const n = Number(opencodePortDraft);
    if (!Number.isFinite(n) || n <= 0 || n > 65535) return;
    const prev = opencodePort;
    setOpencodePort(n);
    void window.api.configUpdate({ opencodePort: n })
      .then((r) => { const saved = (r as Record<string, unknown>).opencodePort; setOpencodePort(typeof saved === "number" ? saved : n); setOpencodePortSavedAt(Date.now()); })
      .catch((e: unknown) => { if (prev != null) setOpencodePort(prev); setOpencodePortDraft(prev != null ? String(prev) : ""); push({ id: `err-port-${Date.now()}`, message: errorDisclosure("Couldn't save the opencode port.", e) }); });
  };

  // Registry URLs (custom control — instant apply on add/remove).
  const {
    registryUrls, setRegistryUrls, newRegistryUrl, setNewRegistryUrl,
  } = useRegistryUrls(store.skillRegistryUrls ?? []);
  const persistRegistryUrls = async (next: string[]) => {
    const prev = store.skillRegistryUrls ?? [];
    useStore.setState({ skillRegistryUrls: next });
    try {
      const r = await window.api.configUpdate({ skillRegistryUrls: next });
      const saved = (r as Record<string, unknown>).skillRegistryUrls;
      useStore.setState({ skillRegistryUrls: Array.isArray(saved) ? (saved as string[]) : next });
      push({
        id: `registry-${Date.now()}`,
        message: next.length > prev.length ? "Registry URL added" : "Registry URL removed",
        action: { label: "Undo", onClick: () => { void useStore.setState({ skillRegistryUrls: prev }); window.api.configUpdate({ skillRegistryUrls: prev }).catch(() => {}); } },
      });
    } catch (e) {
      useStore.setState({ skillRegistryUrls: prev });
      push({ id: `err-registry-${Date.now()}`, message: errorDisclosure("Couldn't update skill registries.", e) });
    }
  };
  const onAddRegistry = () => {
    const url = newRegistryUrl.trim();
    if (!url || registryUrls.includes(url)) return;
    const next = [...registryUrls, url];
    setNewRegistryUrl("");
    setRegistryUrls(next);
    void persistRegistryUrls(next);
  };
  const onRemoveRegistry = (url: string) => {
    const next = registryUrls.filter((u) => u !== url);
    setRegistryUrls(next);
    void persistRegistryUrls(next);
  };

  // Launcher flags (custom control — instant apply per flag).
  const [availableLaunchers] = useLaunchers();
  const [launcherFlagValues, setLauncherFlagValues] = useState(store.launcherFlags ?? {});
  const setLauncherFlag = (launcherId: string, flagKey: string, checked: boolean) => {
    const prev = launcherFlagValues;
    const nextFlags = updateLauncherFlag(availableLaunchers, launcherId, flagKey, checked, prev);
    setLauncherFlagValues(nextFlags);
    useStore.setState({ launcherFlags: nextFlags });
    void window.api.configUpdate({ launcherFlags: nextFlags })
      .then((r) => { const saved = (r as Record<string, unknown>).launcherFlags; useStore.setState({ launcherFlags: (saved && typeof saved === "object" ? saved : nextFlags) as Record<string, Record<string, boolean>> }); })
      .catch((e: unknown) => { useStore.setState({ launcherFlags: prev }); setLauncherFlagValues(prev); push({ id: `err-launcher-${Date.now()}`, message: errorDisclosure("Couldn't save launcher flag.", e) }); });
  };

  // Plugins (desktop-only Mac-local toggle + registry list).
  const [pluginsOn, setPluginsOn] = useState(false);
  const [plugins, setPlugins] = useState<PluginRegistryRow[] | null>(null);
  const [pluginsError, setPluginsError] = useState<string | null>(null);
  useEffect(() => {
    const preload = getMantaPreload();
    if (!preload?.pluginsGetEnabled) return;
    preload.pluginsGetEnabled().then(setPluginsOn).catch(() => {});
  }, []);
  const togglePlugins = async (on: boolean) => {
    const prev = pluginsOn;
    setPluginsOn(on);
    const preload = getMantaPreload();
    if (!preload?.pluginsSetEnabled) return;
    try {
      await preload.pluginsSetEnabled(on);
      push({ id: `plugins-${Date.now()}`, message: `Plugins ${on ? "enabled" : "disabled"} — restart Manta to apply.`, action: { label: "Undo", onClick: () => { setPluginsOn(prev); void preload.pluginsSetEnabled(prev); } } });
    } catch (e) {
      setPluginsOn(prev);
      push({ id: `err-plugins-${Date.now()}`, message: errorDisclosure("Couldn't toggle plugins.", e) });
    }
  };
  useEffect(() => {
    if (activeTab !== "extensions") return;
    let cancelled = false;
    const fetchOnce = () => {
      window.api.pluginsRegistry()
        .then((rows) => { if (!cancelled) { setPlugins(rows); setPluginsError(null); } })
        .catch((e) => { if (!cancelled) setPluginsError(e instanceof Error ? e.message : String(e)); });
    };
    fetchOnce();
    const timer = setInterval(fetchOnce, 10_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [activeTab]);

  // Mobile pairing (Box section).
  const [pairing, setPairing] = useState<AuthPairResult | null>(null);
  const [pairingExpiry, setPairingExpiry] = useState<Date | null>(null);
  const [pairingMinting, setPairingMinting] = useState(false);
  const mintPairingCode = async () => {
    setPairingMinting(true);
    try {
      const result = await window.api.authPair();
      setPairing(result);
      if (result.ok) setPairingExpiry(new Date(result.expiresAt));
    } catch (e) {
      push({ id: `err-pair-${Date.now()}`, message: errorDisclosure("Couldn't generate a pairing code. Try again.", e) });
    } finally {
      setPairingMinting(false);
    }
  };

  // Remove box — in-app confirm replaces window.confirm (BET-419 §D).
  const [removingBox, setRemovingBox] = useState(false);
  const [removeResult, setRemoveResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const removeBox = async () => {
    setConfirmRemove(false);
    if (removingBox) return;
    setRemovingBox(true);
    setRemoveResult(null);
    const preload = getMantaPreload();
    if (!preload?.authUnpair) {
      setRemovingBox(false);
      setRemoveResult({ ok: false, message: "Removing a box is only supported in the desktop app." });
      return;
    }
    try {
      const outcome = await preload.authUnpair();
      await useStore.getState().refresh().catch(() => {});
      if (outcome.ok) { setRemoveResult({ ok: true, message: "" }); onClose(); return; }
      setRemoveResult({ ok: false, message: outcome.message || "The box's token could not be revoked remotely. Local credentials were cleared." });
    } catch (e) {
      setRemoveResult({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setRemovingBox(false);
    }
  };

  // Reset all settings (BET-419 §B.3 — danger zone, General).
  const [confirmReset, setConfirmReset] = useState(false);
  const resetAll = async () => {
    setConfirmReset(false);
    const payload = resetAllPayload(SETTINGS);
    const prev = { ...values };
    useStore.setState(payload);
    if (typeof payload.theme === "string") applyTheme(payload.theme as ThemePref);
    try {
      await window.api.configUpdate(payload);
      push({
        id: `reset-${Date.now()}`,
        message: "All settings reset to defaults.",
        action: { label: "Undo", onClick: () => { void useStore.setState(prev); if (prev.theme) applyTheme(prev.theme as ThemePref); window.api.configUpdate(prev).catch(() => {}); } },
      });
    } catch (e) {
      useStore.setState(prev);
      if (prev.theme) applyTheme(prev.theme as ThemePref);
      push({ id: `err-reset-${Date.now()}`, message: errorDisclosure("Couldn't reset settings.", e) });
    }
  };

  // ===== BET-420: the ONE restart affordance =====
  // ModelsCard (sub toggles) and ProvidersCard (endpoint changes) raise
  // `opencodeRestartNeeded`; this banner is the single place the user is
  // asked to restart. ConnectProvider's connect-completion restart is
  // automatic (it must restart + poll to verify the credential came online),
  // not a user-facing affordance, and clears this flag when it fires.
  const restartNeeded = useStore((s) => s.opencodeRestartNeeded);
  const setRestartNeeded = useStore((s) => s.setOpencodeRestartNeeded);
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  const performRestart = async () => {
    if (restarting) return;
    setRestarting(true);
    setRestartError(null);
    try {
      await window.api.opencodeRestart();
      setRestartNeeded(false);
    } catch (e) {
      setRestartError(`Restart failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRestarting(false);
    }
  };
  const requestRestart = () => setRestartNeeded(true);

  // Arrow-key navigation on the tab rail (BET-419 §C).
  const railRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const searchRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      // ⌘F / Ctrl+F focuses the settings search (BET-419 §B.1).
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const onRailKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const idx = SETTING_SECTIONS.findIndex((s) => s.id === activeTab);
    const dir = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1;
    const next = SETTING_SECTIONS[(idx + dir + SETTING_SECTIONS.length) % SETTING_SECTIONS.length];
    setActiveTab(next.id);
    railRefs.current[next.id]?.focus();
  };

  const schemaEntries = settingsForSection(SETTINGS, activeTab, PLATFORM);
  const simpleEntries = schemaEntries.filter((e) => e.control !== "custom");

  const renderField = (entry: SettingEntry): ReactNode => {
    const cur = entry.configKey ? values[entry.configKey] : undefined;
    switch (entry.control) {
      case "toggle":
        return <ToggleField entry={entry} value={Boolean(cur)} onApply={(v) => void commitKey(entry, v)} />;
      case "segmented":
        return <SegmentedField entry={entry} value={String(cur ?? "")} onApply={(v) => void commitKey(entry, v)} />;
      case "password":
        return <PasswordField entry={entry} value={String(cur ?? "")} onCommit={(v) => void commitKey(entry, v.trim())} />;
      case "text":
      case "path":
        return <TextField entry={entry} value={String(cur ?? "")} onCommit={(v) => void commitKey(entry, v)} />;
      default:
        return null;
    }
  };

  // Per-section custom content (cards/lists the schema doesn't describe).
  const renderCustom = (section: SettingSectionId): ReactNode => {
    if (section === "general") {
      return (
        <>
          <div className="border-t border-border pt-6">
            <h3 className="text-title font-semibold mb-4">About</h3>
            <div className="text-body text-text-faint">Manta v{clientVersion ?? "…"}</div>
            {serverVersion && <div className="text-meta text-text-faint mt-1">Box server v{serverVersion}</div>}
            {opencodeVersion && <div className="text-meta text-text-faint mt-1">Box opencode v{opencodeVersion}</div>}
            <div className="text-meta text-text-faint mt-1">Desktop client for remote Claude Code sessions.</div>
            {store.updatePrompt && (
              <div className="mt-4 rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 flex items-center gap-2">
                <span className="flex-1 text-meta text-text">Update ready: <span className="font-medium">{store.updatePrompt.releaseName || store.updatePrompt.version}</span></span>
                <button onClick={() => { void window.api.autoUpdateInstall(); }} className="shrink-0 rounded bg-accent/20 px-2 py-px text-accent hover:bg-accent/30 font-medium">Restart to update</button>
              </div>
            )}
          </div>
          <div className="border-t border-border pt-6">
            <h3 className="text-title font-semibold mb-4">Reset all settings</h3>
            <div className="text-body text-text-faint mb-3">Restore every setting below to its default. This does not remove your box pairing or projects.</div>
            <button onClick={() => setConfirmReset(true)} className="text-body px-4 py-2 rounded border border-danger text-danger hover:bg-danger/10">Reset all settings…</button>
          </div>
        </>
      );
    }
    if (section === "box") {
      const connected = Boolean(store.boxToken);
      return (
        <>
          {/* Read-only status card — the URL lives here; changing it means
              re-pairing, so there is no editable Connection block (BET-420). */}
          <div className="rounded-lg border border-border bg-bg-soft p-4 space-y-2">
            <div className="flex items-center gap-2">
              <span aria-hidden className={`inline-block w-2 h-2 rounded-full ${connected ? "bg-ok" : "bg-text-faint"}`} />
              <span className="text-body font-medium text-text">{connected ? "Connected" : "Not paired"}</span>
            </div>
            <dl className="space-y-1 text-meta">
              <div className="flex gap-2">
                <dt className="text-text-faint shrink-0">Server URL</dt>
                <dd className="text-text-muted font-mono break-all">{store.serverUrl || "—"}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-text-faint shrink-0">Box ID</dt>
                <dd className="text-text-muted font-mono break-all">{store.boxId || "—"}</dd>
              </div>
              {serverVersion && (
                <div className="flex gap-2">
                  <dt className="text-text-faint shrink-0">Server</dt>
                  <dd className="text-text-muted font-mono">v{serverVersion}</dd>
                </div>
              )}
            </dl>
          </div>

          <div>
            <h3 className="text-title font-semibold mb-4">Pair phone</h3>
            <div className="text-body text-text-faint mb-4">
              Scan this QR with the Manta mobile app to connect it to your box. The code is one-time and valid for ~5 minutes. Generate a new code if the old one expires.
            </div>
            {!pairing ? (
              <button onClick={mintPairingCode} disabled={pairingMinting} className="text-body px-4 py-2 rounded bg-bg-soft border border-border text-text-muted hover:text-text disabled:opacity-40 disabled:cursor-not-allowed">
                {pairingMinting ? "Generating…" : "Generate pairing code"}
              </button>
            ) : pairing.ok ? (
              <div className="space-y-4">
                <div className="flex items-start gap-4">
                  <div className="bg-white p-2 rounded border border-border shrink-0">
                    <PairingQR boxId={pairing.boxId} pairingCode={pairing.pairingCode} />
                  </div>
                  <div className="flex-1 space-y-2">
                    <div className="text-body"><span className="text-text-muted">Code:</span> <span className="font-mono text-text">{pairing.pairingCode}</span></div>
                    <div className="text-body"><span className="text-text-muted">Box ID:</span> <span className="font-mono text-text break-all" title={pairing.boxId}>{pairing.boxId}</span></div>
                    {pairingExpiry && <PairingCountdown expiry={pairingExpiry} />}
                  </div>
                </div>
                <button onClick={mintPairingCode} disabled={pairingMinting} className="text-body px-4 py-2 rounded bg-bg-soft border border-border text-text-muted hover:text-text disabled:opacity-40 disabled:cursor-not-allowed">
                  {pairingMinting ? "Generating…" : "Refresh code"}
                </button>
              </div>
            ) : (
              <div className="text-body text-danger">{pairing.error}</div>
            )}
          </div>

          <div className="border-t border-border pt-6">
            <div className="flex items-center justify-between">
              <div className="text-body text-text-faint">Re-run the guided setup (pairing, providers, first project).</div>
              <button onClick={() => { void useStore.getState().relaunchOnboarding(); onClose(); }} className="text-body px-4 py-2 rounded bg-bg-soft border border-border text-text-muted hover:text-text shrink-0">Run setup again</button>
            </div>
          </div>

          {/* Advanced — opencodePort, exposed in the UI for the first time
              (BET-420). Collapsed by default; it's an infrequently-touched
              knob. */}
          <details className="border-t border-border pt-6">
            <summary className="text-body text-text-muted cursor-pointer select-none">Advanced</summary>
            <div className="mt-4 space-y-1">
              <label htmlFor="setting-opencodePort" className="block text-micro font-semibold uppercase text-text-muted">opencode port</label>
              <input
                id="setting-opencodePort"
                type="number"
                min={1}
                max={65535}
                value={opencodePortDraft}
                onChange={(e) => { setOpencodePortDraft(e.target.value); setOpencodePortSavedAt(null); }}
                onBlur={commitOpencodePort}
                spellCheck={false}
                className="w-full bg-bg-soft border border-border px-3 py-2 text-body rounded focus:outline-none focus:border-accent font-mono"
              />
              <div className="text-meta text-text-faint">Local port forwarded to the box's opencode serve instance. Defaults to 14096 to avoid colliding with a local opencode on 4096.</div>
              {opencodePortSavedAt && <div role="status" className="text-meta text-ok">Saved</div>}
            </div>
          </details>

          <div className="border-t border-border pt-6">
            <h3 className="text-title font-semibold mb-3">Danger zone</h3>
            <div className="flex items-center justify-between">
              <div className="text-body text-text-faint">Forget this box on the desktop. If the box is reachable, its current token is revoked too.</div>
              <button onClick={() => setConfirmRemove(true)} disabled={removingBox} className="text-body px-4 py-2 rounded bg-bg-soft border border-border text-text-muted hover:text-danger hover:border-danger disabled:opacity-40 disabled:cursor-not-allowed shrink-0">
                {removingBox ? "Removing…" : "Remove box"}
              </button>
            </div>
            {removeResult && !removeResult.ok && <div role="alert" className="text-body text-warn mt-3">{removeResult.message}</div>}
          </div>
        </>
      );
    }
    if (section === "accounts") {
      // Subscriptions + custom endpoints merged into one list (BET-420).
      // Both are "a way to reach a model"; the shared AddEndpointForm lives
      // inside ProvidersCard and rejects a scheme-less URL identically here
      // and in onboarding.
      return (
        <>
          <SubscriptionsCard />
          <div className="border-t border-border pt-6">
            <h3 className="text-title font-semibold mb-1">Custom endpoints</h3>
            <div className="text-body text-text-faint mb-3">OpenAI-compatible endpoints opencode can serve. Add one, refresh to discover models, then enable the ones you want in the model picker.</div>
            <ProvidersCard onRestartNeeded={requestRestart} />
          </div>
        </>
      );
    }
    if (section === "models") {
      return <ModelsCard />;
    }
    if (section === "extensions") {
      return (
        <>
          <div className="border-t border-border pt-6">
            <h3 className="text-title font-semibold mb-4">Installed plugins</h3>
            {pluginsError ? (
              <div role="alert" className="text-body text-danger">{errorDisclosure("Couldn't load the plugins list.", pluginsError)}</div>
            ) : plugins === null ? (
              <div className="text-body text-text-faint">Loading…</div>
            ) : plugins.length === 0 ? (
              <div className="text-body text-text-faint">No plugins installed yet. The AI can author them with <code className="text-text-muted">plugin.write</code> when this toggle is on.</div>
            ) : (
              <div className="space-y-2">
                {plugins.map((p) => (
                  <div key={p.name} className="border border-border rounded p-3 bg-bg-soft space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-body font-medium text-text">{p.name}</span>
                      {p.valid ? <span className="text-meta px-2 py-px rounded bg-ok-bg text-ok">valid</span> : <span className="text-meta px-2 py-px rounded bg-danger-bg text-danger break-all">parse error: {p.error}</span>}
                      <span className="ml-auto text-meta text-text-faint">{p.stepCount} step{p.stepCount === 1 ? "" : "s"}{p.timeoutMs != null ? ` · ${formatTimeout(p.timeoutMs)}` : ""}</span>
                    </div>
                    {p.description && <div className="text-meta text-text-muted">{p.description}</div>}
                    {p.inputs.length > 0 && <div className="text-meta text-text-faint">Inputs: {p.inputs.map((i) => `${i.id}${i.default !== undefined ? `=${JSON.stringify(i.default)}` : ""}`).join(", ")}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="border-t border-border pt-6">
            <button onClick={() => { const preload = getMantaPreload(); if (preload?.revealInFolder) void preload.revealInFolder("~/.manta/plugins"); }} className="text-body px-4 py-2 rounded bg-bg-soft border border-border text-text-muted hover:text-text">Open plugins folder</button>
          </div>
          {availableLaunchers.some((l) => l.flags.length > 0) && (
            <div className="border-t border-border pt-6">
              <h3 className="text-title font-semibold mb-1">AI CLI launch options</h3>
              <div className="text-body text-text-faint mb-4">Flags used when launching an AI CLI (e.g. Claude Code) directly in a session's terminal. Only CLIs detected on this box are shown.</div>
              <div className="space-y-4">
                {availableLaunchers.filter((l) => l.flags.length > 0).map((l) => (
                  <div key={l.id} className="space-y-2">
                    <div className="text-body font-medium text-text">{l.label}</div>
                    {l.flags.map((f) => (
                      <label key={f.key} className="flex items-start gap-3 text-body cursor-pointer">
                        <input type="checkbox" checked={resolveLauncherFlags(l.flags, launcherFlagValues[l.id])[f.key]} onChange={(e) => setLauncherFlag(l.id, f.key, e.target.checked)} className="mt-px" />
                        <span>{f.label}</span>
                      </label>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="border-t border-border pt-6">
            <h3 className="text-title font-semibold mb-4">Skill registries</h3>
            <div className="text-body text-text-faint mb-3">Extra skill registry URLs fetched by opencode on startup. The default Manta registry is always included.</div>
            <div className="space-y-2">
              {registryUrls.map((url) => (
                <div key={url} className="flex items-center gap-2">
                  <code className="flex-1 text-body bg-bg-soft border border-border rounded px-3 py-2 text-text-muted truncate">{url}</code>
                  <button onClick={() => onRemoveRegistry(url)} className="text-body text-text-faint hover:text-text px-2 inline-flex items-center" aria-label="Remove registry URL"><X size={14} aria-hidden="true" /></button>
                </div>
              ))}
            </div>
            <div className="flex gap-2 mt-3">
              <input placeholder="https://example.com/skills" value={newRegistryUrl} onChange={(e) => setNewRegistryUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && onAddRegistry()} className="flex-1 bg-bg-soft border border-border px-3 py-2 text-body rounded focus:outline-none focus:border-accent" />
              <button onClick={onAddRegistry} disabled={!newRegistryUrl.trim()} className="px-4 py-2 text-body bg-bg-soft border border-border rounded text-text-muted hover:text-text disabled:opacity-40 disabled:cursor-not-allowed">Add</button>
            </div>
          </div>
        </>
      );
    }
    return null;
  };

  // The plugins toggle is a schema entry but also drives the registry list,
  // so render it specially here (it's Mac-local, not a config key). We pull
  // it out of simpleEntries and render it at the top of the Extensions panel.
  const pluginsToggleEntry = SETTINGS.find((e) => e.id === "pluginsEnabled");
  const simpleEntriesExPlugins = simpleEntries.filter((e) => e.id !== "pluginsEnabled");

  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="settings-title" className="fixed inset-0 bg-bg z-50 flex">
      {/* Left sidebar navigation (tablist) */}
      <div className="w-48 bg-bg-soft border-r border-border flex flex-col shrink-0">
        <div className="titlebar-drag h-10 shrink-0" />
        <div className="p-4 border-b border-border">
          <h2 id="settings-title" tabIndex={-1} className="text-title font-semibold">Settings</h2>
        </div>
        <nav className="flex-1 py-2 overflow-y-auto" role="tablist" aria-label="Settings sections">
          {SETTING_SECTIONS.map((tab, i) => {
            const modified = sectionIsModified(SETTINGS, tab.id, PLATFORM, values);
            const prev = i > 0 ? SETTING_SECTIONS[i - 1] : null;
            const showGroup = tab.group && (!prev || prev.group !== tab.group);
            return (
              <div key={tab.id}>
                {showGroup && (
                  <div aria-hidden className="px-4 pt-3 pb-1 text-micro font-semibold uppercase tracking-wide text-text-quiet">── {tab.group} ──</div>
                )}
                <button
                  ref={(el) => { railRefs.current[tab.id] = el; }}
                  role="tab"
                  aria-selected={activeTab === tab.id}
                  aria-controls={`panel-${tab.id}`}
                  id={`tab-${tab.id}`}
                  onClick={() => setActiveTab(tab.id)}
                  onKeyDown={onRailKeyDown}
                  className={`w-full text-left px-4 py-2 text-body transition-colors ${
                    activeTab === tab.id ? "bg-accent/10 text-accent border-r-2 border-accent" : "text-text-muted hover:text-text hover:bg-bg-elev"
                  }`}
                >
                  <span className="inline-flex items-center gap-2">
                    {tab.label}
                    {modified && <span aria-hidden="true" className="inline-block w-1.5 h-1.5 rounded-full bg-accent" title="Modified" />}
                  </span>
                </button>
              </div>
            );
          })}
        </nav>
      </div>

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex items-center gap-3 p-4 border-b border-border">
          <div className="flex-1 relative">
            <Search size={14} aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 text-text-faint" />
            <input ref={searchRef} type="text" placeholder="Find a setting…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search settings" className="w-full max-w-sm bg-bg-soft border border-border pl-8 pr-3 py-2 text-body rounded focus:outline-none focus:border-accent" />
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text text-body px-3 py-2 rounded hover:bg-bg-elev transition-colors inline-flex items-center" aria-label="Close settings"><X size={16} aria-hidden="true" /></button>
          <div className="titlebar-inset-right" />
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {/* The ONE restart affordance (BET-420). Sits above the panel so it
              is visible regardless of which section is active. */}
          {restartNeeded && (
            <div role="status" className="mb-4 flex items-center gap-3 rounded-lg border border-warn/40 bg-warn-bg px-4 py-3">
              <span className="flex-1 text-body text-text">
                An opencode restart is needed to apply recent model or endpoint changes. Restarting interrupts all running sessions.
              </span>
              <button onClick={() => void performRestart()} disabled={restarting} className="shrink-0 px-3 py-2 text-body rounded bg-warn-bg border border-warn text-warn hover:bg-warn/20 disabled:opacity-40">
                {restarting ? "Restarting…" : "Restart opencode"}
              </button>
              <button onClick={() => setRestartNeeded(false)} disabled={restarting} className="shrink-0 px-2 py-2 text-body text-text-muted hover:text-text disabled:opacity-40">Later</button>
            </div>
          )}
          {restartError && <div role="alert" className="mb-4 text-body text-danger">{restartError}</div>}

          {inSearch ? (
            <div className="max-w-2xl space-y-4">
              <div className="text-body text-text-faint">{searchHits.length} match{searchHits.length === 1 ? "" : "es"} for “{query.trim()}”</div>
              {searchHits.length === 0 ? (
                <div className="text-body text-text-faint">No settings match. Try another term.</div>
              ) : (
                searchHits.map((entry) => (
                  <div key={entry.id} className="border-t border-border pt-4">
                    <div className="text-micro uppercase text-text-faint mb-1">{SETTING_SECTIONS.find((s) => s.id === entry.section)?.label}</div>
                    {renderField(entry)}
                  </div>
                ))
              )}
            </div>
          ) : (
            <div role="tabpanel" id={`panel-${activeTab}`} aria-labelledby={`tab-${activeTab}`} className="max-w-2xl space-y-6">
              {activeTab === "extensions" && pluginsToggleEntry ? (
                <div className="space-y-1">
                  <label htmlFor={fieldId(pluginsToggleEntry)} className="flex items-start gap-3 text-body cursor-pointer">
                    <input id={fieldId(pluginsToggleEntry)} type="checkbox" checked={pluginsOn} onChange={(e) => void togglePlugins(e.target.checked)} className="mt-px" />
                    <span>
                      {pluginsToggleEntry.label}
                      {pluginsToggleEntry.help && <span className="block text-meta text-text-faint mt-1">{pluginsToggleEntry.help}</span>}
                    </span>
                  </label>
                </div>
              ) : null}
              {simpleEntriesExPlugins.map((entry) => <div key={entry.id}>{renderField(entry)}</div>)}
              {renderCustom(activeTab)}
            </div>
          )}
        </div>
      </div>

      {/* Local toast stack — inside the dialog so toasts surface above the overlay. */}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center px-4 pb-4">
        <div className="pointer-events-auto w-full max-w-[420px]">
          <ToastStack toasts={toasts} onDismiss={dismiss} />
        </div>
      </div>

      {/* In-app confirm: Remove box (replaces window.confirm — BET-419 §D). */}
      {confirmRemove && (
        <div role="alertdialog" aria-modal="true" aria-labelledby="confirm-remove-title" className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-5 space-y-4">
            <h3 id="confirm-remove-title" className="text-title font-semibold">Remove this box?</h3>
            <div className="text-body text-text-faint">The desktop will forget its pairing and saved projects. If the box is reachable, its current token is also revoked. If the box is offline, the local credentials are cleared and the box's token will be rotated the next time it starts.</div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmRemove(false)} className="px-4 py-2 text-body text-text-muted hover:text-text">Cancel</button>
              <button onClick={removeBox} className="px-4 py-2 text-body bg-danger text-white rounded hover:opacity-90">Remove</button>
            </div>
          </div>
        </div>
      )}

      {/* In-app confirm: Reset all settings (BET-419 §B.3). */}
      {confirmReset && (
        <div role="alertdialog" aria-modal="true" aria-labelledby="confirm-reset-title" className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-5 space-y-4">
            <h3 id="confirm-reset-title" className="text-title font-semibold">Reset all settings?</h3>
            <div className="text-body text-text-faint">Every setting will return to its default. Your box pairing and projects are not affected. You can undo this right after.</div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmReset(false)} className="px-4 py-2 text-body text-text-muted hover:text-text">Cancel</button>
              <button onClick={resetAll} className="px-4 py-2 text-body bg-accent-solid text-on-accent rounded hover:opacity-90">Reset</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
