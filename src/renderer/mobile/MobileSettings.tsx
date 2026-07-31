import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { useStore } from "../store";
import { ProvidersCard } from "../ProvidersCard";
import { SubscriptionsCard } from "../SubscriptionsCard";
import { resolveLauncherFlags } from "../chatShared";
import { TtlToggle } from "../TtlToggle";
import { ToastStack } from "../Toast";
import {
  useLaunchers,
  updateLauncherFlag,
  useRegistryUrls,
} from "../settingsShared";
import { useSettingsToasts, useApplySetting } from "../settingsApply";
import { errorDisclosure } from "../settingsError";
import type { OpencodeModel } from "../../shared/types";
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
} from "../../shared/settingsSchema";
import {
  isPushSupported,
  pushPermission,
  hasActiveSubscription,
  enablePush,
  disablePush,
  resubscribePush,
} from "./push";

type Props = { onClose: () => void };

const PLATFORM = "mobile" as const;

// Mobile-friendly settings — single scrollable column, no modal overlay
// (overlays + iOS keyboard interact badly). The whole screen IS the surface;
// a "‹" back button pops to wherever the user came from.
//
// BET-419: this surface now renders from the shared settingsSchema (same
// source as desktop Settings.tsx), uses instant-apply + Undo (no Save
// button), and routes every failure through a local toast — no native dialogs.

export function MobileSettings({ onClose }: Props) {
  const store = useStore();
  const { toasts, push, dismiss } = useSettingsToasts();
  const applySetting = useApplySetting(push);

  // Current config values for schema-driven fields (read directly from the
  // store — NO local field state + resync effect, which was the stomping
  // bug fixed in BET-419).
  const values: Record<string, unknown> = useMemo(
    () => ({
      cacheTtl: store.cacheTtl,
      groqApiKey: store.groqApiKey,
      voiceTranscriptionModel: store.voiceTranscriptionModel,
      voiceCommandModel: store.voiceCommandModel,
      chatAutoAllow: store.chatAutoAllow,
      autoRenameSessions: store.autoRenameSessions,
    }),
    [store.cacheTtl, store.groqApiKey, store.voiceTranscriptionModel, store.voiceCommandModel, store.chatAutoAllow, store.autoRenameSessions],
  );

  const commitKey = async (entry: SettingEntry, nextValue: unknown) => {
    if (entry.configKey == null) return;
    const prev = values[entry.configKey];
    await applySetting(entry, nextValue, prev);
  };

  // Search (BET-419 §B.1) — filters schema entries by label + help.
  const [query, setQuery] = useState("");
  const inSearch = query.trim().length > 0;
  const searchHits = useMemo(() => searchSettings(SETTINGS, query, PLATFORM), [query]);

  // Reset all settings (BET-419 §B.3) — danger zone, General section.
  const [confirmReset, setConfirmReset] = useState(false);
  const resetAll = async () => {
    setConfirmReset(false);
    const payload = resetAllPayload(SETTINGS);
    const prev = { ...values };
    useStore.setState(payload);
    try {
      await window.api.configUpdate(payload);
      push({
        id: `reset-${Date.now()}`,
        message: "All settings reset to defaults.",
        action: { label: "Undo", onClick: () => { void useStore.setState(prev); window.api.configUpdate(prev).catch(() => {}); } },
      });
    } catch (e) {
      useStore.setState(prev);
      push({ id: `err-reset-${Date.now()}`, message: errorDisclosure("Couldn't reset settings.", e) });
    }
  };

  // Server URL — mobile-local (localStorage["manta_server"]), not a server
  // config key. Committed on blur (instant apply). Seeded once on mount; the
  // draft is never resynced from anywhere while focused (stomping fix).
  const [serverUrlDraft, setServerUrlDraft] = useState(
    () => (typeof localStorage !== "undefined" ? localStorage.getItem("manta_server") ?? "" : ""),
  );
  const serverUrlFocused = useRef(false);
  const [serverUrlSavedAt, setServerUrlSavedAt] = useState<number | null>(null);
  const commitServerUrl = () => {
    const trimmed = serverUrlDraft.trim();
    try {
      if (trimmed) localStorage.setItem("manta_server", trimmed);
      else localStorage.removeItem("manta_server");
      setServerUrlSavedAt(Date.now());
      push({ id: `server-url-${Date.now()}`, message: trimmed ? "Server URL set" : "Server URL cleared" });
    } catch (e) {
      push({ id: `err-server-url-${Date.now()}`, message: errorDisclosure("Couldn't save the server URL.", e) });
    }
  };

  // Default model — instant apply on change (replaces the old batched Save).
  const [selectedModel, setSelectedModel] = useState(store.defaultModel ?? null);
  const [models, setModels] = useState<OpencodeModel[] | null>(null);
  const commitModel = (val: string) => {
    if (!val) {
      setSelectedModel(null);
      void useStore.setState({ defaultModel: null });
      window.api.configUpdate({ defaultModel: undefined }).catch(() => {});
      return;
    }
    const [providerID, modelID] = val.split("::");
    const model = { providerID, modelID };
    const prev = store.defaultModel ?? null;
    setSelectedModel(model);
    void useStore.setState({ defaultModel: model });
    window.api.configUpdate({ defaultModel: model })
      .then((r) => { const saved = (r as Record<string, unknown>).defaultModel; useStore.setState({ defaultModel: (saved && typeof saved === "object" ? saved : model) as { providerID: string; modelID: string } | null }); })
      .catch((e: unknown) => { useStore.setState({ defaultModel: prev }); setSelectedModel(prev); push({ id: `err-model-${Date.now()}`, message: errorDisclosure("Couldn't save the default model.", e) }); });
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

  // Push notifications — per-device subscription, not server config.
  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushErr, setPushErr] = useState<string | null>(null);
  const [pushErrRaw, setPushErrRaw] = useState<string | null>(null);
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  useEffect(() => { hasActiveSubscription().then(setPushOn).catch(() => setPushOn(false)); }, []);
  const togglePush = async () => {
    setPushErr(null);
    setPushErrRaw(null);
    setPushBusy(true);
    try {
      if (pushOn) { await disablePush(); setPushOn(false); }
      else {
        const state = await enablePush();
        if (state === "granted") setPushOn(true);
        else if (state === "denied") setPushErr("Notifications are blocked. Enable them for this site in iOS Settings.");
        else if (state === "unsupported") setPushErr("Push needs the app installed to your home screen (iOS 16.4+).");
        else setPushErr("Permission not granted.");
      }
    } catch (e) {
      setPushErr("Couldn't toggle notifications.");
      setPushErrRaw(e instanceof Error ? e.message : String(e));
    } finally {
      setPushBusy(false);
    }
  };
  const resubscribe = async () => {
    setPushErr(null);
    setPushErrRaw(null);
    setPushBusy(true);
    try {
      const state = await resubscribePush();
      if (state === "granted") setPushOn(true);
      else if (state === "denied") setPushErr("Notifications are blocked. Enable them for this site in iOS Settings.");
      else if (state === "unsupported") setPushErr("Push needs the app installed to your home screen (iOS 16.4+).");
      else setPushErr("Permission not granted.");
    } catch (e) {
      setPushErr("Couldn't re-subscribe to notifications.");
      setPushErrRaw(e instanceof Error ? e.message : String(e));
    } finally {
      setPushBusy(false);
    }
  };

  useEffect(() => { window.api.opencodeModels().then((list) => setModels(list)).catch(() => {}); }, []);
  useEffect(() => { window.api.getServerVersion().then(({ version }) => setServerVersion(version)).catch(() => {}); }, []);

  // ----- schema-driven field renderers (mobile-styled) -----
  const renderField = (entry: SettingEntry): ReactNode => {
    const id = fieldId(entry);
    const cur = entry.configKey ? values[entry.configKey] : undefined;
    if (entry.control === "toggle") {
      return (
        <label htmlFor={id} className="flex items-center justify-between gap-3">
          <span className="block text-micro font-semibold uppercase text-text-muted">{entry.label}</span>
          <input id={id} type="checkbox" checked={Boolean(cur)} onChange={(e) => void commitKey(entry, e.target.checked)} className="w-5 h-5 accent-accent" />
        </label>
      );
    }
    if (entry.control === "segmented") {
      if (entry.id === "cacheTtl") {
        return (
          <>
            <label htmlFor={id} className="block text-micro font-semibold uppercase text-text-muted">{entry.label}</label>
            <TtlToggle ttl={String(cur ?? "1h") as "5m" | "1h"} setTtl={(v) => void commitKey(entry, v)} compact />
            {entry.help && <div className="text-meta text-text-faint">{entry.help}</div>}
          </>
        );
      }
      return null;
    }
    // text / password
    const isCred = entry.commitOnBlur;
    if (isCred) {
      return <MobilePassword entry={entry} value={String(cur ?? "")} onCommit={(v) => void commitKey(entry, v.trim())} />;
    }
    // voiceTranscriptionModel / voiceCommandModel — text, commit on blur.
    return <MobileText entry={entry} value={String(cur ?? "")} onCommit={(v) => void commitKey(entry, v)} />;
  };

  // Server URL is a mobile-only schema entry with configKey null (localStorage).
  const serverUrlEntry = SETTINGS.find((e) => e.id === "serverUrlMobile") as SettingEntry;

  // Group schema entries by their section for the single-scroll layout.
  // BET-420: the schema now has 8 sections; mobile skips Files (no mobile
  // entries, no mobile custom content) and keeps the rest.
  const hasMobileCustom = (id: SettingSectionId): boolean =>
    id === "general" || id === "box" || id === "accounts" ||
    id === "models" || id === "extensions";
  const sections = SETTING_SECTIONS.filter(
    (s) => settingsForSection(SETTINGS, s.id, PLATFORM).length > 0 || hasMobileCustom(s.id),
  );

  return (
    <div className="mobile-screen">
      <div className="mobile-header">
        <button className="mobile-tap text-accent text-2xl leading-none" onClick={onClose} aria-label="Back">‹</button>
        <div className="flex-1 text-text font-bold text-title">Settings</div>
        <div className="w-8" />
      </div>

      <div className="manta-scroll-y flex-1 overflow-y-auto px-4 py-3 space-y-5">
        {/* Search (BET-419 §B.1) — filters schema entries by label + help. */}
        <input
          type="text"
          placeholder="Find a setting…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search settings"
          className="w-full bg-bg-soft border border-border px-3 py-2 text-body rounded focus:outline-none focus:border-accent"
        />

        {inSearch ? (
          <div className="space-y-4">
            <div className="text-meta text-text-faint">{searchHits.length} match{searchHits.length === 1 ? "" : "es"} for “{query.trim()}”</div>
            {searchHits.length === 0 ? (
              <div className="text-body text-text-faint">No settings match. Try another term.</div>
            ) : (
              searchHits.map((entry) => (
                <div key={entry.id} className="space-y-2 pt-1 border-t border-border">
                  <div className="text-micro uppercase text-text-faint">{SETTING_SECTIONS.find((s) => s.id === entry.section)?.label}</div>
                  {renderField(entry)}
                  {entry.help && entry.control !== "toggle" && <div className="text-meta text-text-faint">{entry.help}</div>}
                </div>
              ))
            )}
          </div>
        ) : (
          <>
            {/* Server URL — the most important field for a fresh install. */}
            <section className="space-y-2">
              <label htmlFor={fieldId(serverUrlEntry)} className="block text-micro font-semibold uppercase text-text-muted">Server URL</label>
              <input
                id={fieldId(serverUrlEntry)}
                placeholder={typeof window !== "undefined" ? window.location.origin : ""}
                value={serverUrlDraft}
                onChange={(e) => { setServerUrlDraft(e.target.value); setServerUrlSavedAt(null); }}
                onFocus={() => { serverUrlFocused.current = true; }}
                onBlur={() => { serverUrlFocused.current = false; commitServerUrl(); }}
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="off"
                inputMode="url"
                className="w-full bg-bg-soft border border-border px-3 py-2 text-body rounded focus:outline-none focus:border-accent"
              />
              <div className="text-meta text-text-faint">Leave blank to use the page's own origin (default). Override only if your Manta server is on a different host. Changes take effect immediately.</div>
              <div className="text-meta text-text-faint">Server v{serverVersion ?? "?"}</div>
              {serverUrlSavedAt && <div role="status" className="text-meta text-ok">Saved</div>}
            </section>

            {/* Schema-driven simple fields, grouped by section. */}
            {sections.map((section) => {
              // Skip custom entries (rendered via renderMobileCustom) and the
              // serverUrl entry (rendered specially above).
              const entries = settingsForSection(SETTINGS, section.id, PLATFORM)
                .filter((e) => e.control !== "custom" && e.id !== "serverUrlMobile");
              if (entries.length === 0 && !hasMobileCustom(section.id)) return null;
              return (
                <section key={section.id} className="space-y-3 pt-1 border-t border-border">
                  <div className="flex items-center gap-2">
                    <span className="text-micro font-semibold uppercase text-text-muted">{section.label}</span>
                    {sectionIsModified(SETTINGS, section.id, PLATFORM, values) && (
                      <span aria-hidden="true" className="inline-block w-1.5 h-1.5 rounded-full bg-accent" title="Modified" />
                    )}
                  </div>
                  {entries.map((entry) => (
                    <div key={entry.id} className="space-y-2">
                      {renderField(entry)}
                      {entry.help && entry.control !== "toggle" && <div className="text-meta text-text-faint">{entry.help}</div>}
                    </div>
                  ))}
                  {/* Per-section custom content for mobile. */}
                  {renderMobileCustom(section.id)}
                </section>
              );
            })}
          </>
        )}

        {toasts.length > 0 && <ToastStack toasts={toasts} onDismiss={dismiss} />}
      </div>

      {/* In-app confirm: Reset all settings (BET-419 §B.3). */}
      {confirmReset && (
        <div role="alertdialog" aria-modal="true" aria-labelledby="mobile-confirm-reset-title" className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-5 space-y-4">
            <h3 id="mobile-confirm-reset-title" className="text-title font-semibold">Reset all settings?</h3>
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

  // Per-section custom content for mobile. BET-420 split the old AI section
  // into accounts (subs + endpoints), models (default model) and extensions
  // (launcher flags + skill registries); push moved from general to box.
  function renderMobileCustom(sectionId: SettingSectionId): ReactNode {
    if (sectionId === "models") {
      return (
        <div className="space-y-1">
          <label htmlFor="setting-defaultModel" className="block text-micro font-semibold uppercase text-text-muted">Default model</label>
          <select
            id="setting-defaultModel"
            value={selectedModel ? `${selectedModel.providerID}::${selectedModel.modelID}` : ""}
            onChange={(e) => commitModel(e.target.value)}
            className="w-full bg-bg-soft border border-border px-3 py-2 text-body rounded focus:outline-none focus:border-accent"
          >
            <option value="">opencode default</option>
            {models && models.map((m) => (
              <option key={`${m.providerID}::${m.id}`} value={`${m.providerID}::${m.id}`}>{m.name} ({m.providerID})</option>
            ))}
          </select>
          <div className="text-meta text-text-faint">Used for every new and cleared session. Can be overridden per-session in the chat composer.</div>
        </div>
      );
    }
    if (sectionId === "accounts") {
      return (
        <>
          <SubscriptionsCard />
          <ProvidersCard />
        </>
      );
    }
    if (sectionId === "extensions") {
      return (
        <>
          {availableLaunchers.some((l) => l.flags.length > 0) && (
            <div role="group" aria-labelledby="setting-mobile-launchers" className="space-y-2">
              <span id="setting-mobile-launchers" className="text-micro font-semibold uppercase text-text-muted">AI CLI launch options</span>
              <div className="text-meta text-text-faint">Flags used when launching an AI CLI directly in a session's terminal.</div>
              {availableLaunchers.filter((l) => l.flags.length > 0).map((l) => (
                <div key={l.id} className="space-y-2">
                  <div className="text-body font-medium text-text">{l.label}</div>
                  {l.flags.map((f) => (
                    <label key={f.key} className="flex items-center justify-between gap-3">
                      <span className="text-body text-text">{f.label}</span>
                      <input type="checkbox" checked={resolveLauncherFlags(l.flags, launcherFlagValues[l.id])[f.key]} onChange={(e) => setLauncherFlag(l.id, f.key, e.target.checked)} className="w-5 h-5 accent-accent" />
                    </label>
                  ))}
                </div>
              ))}
            </div>
          )}
          {/* Skill registries */}
          <div className="space-y-2">
            <label htmlFor="setting-mobile-skillRegistries" className="text-micro font-semibold uppercase text-text-muted">Skill registries</label>
            <div className="text-meta text-text-faint">Extra opencode skill registry URLs. The default Manta registry is always included.</div>
            <div className="space-y-1">
              {registryUrls.map((url) => (
                <div key={url} className="flex items-center gap-2 bg-bg-soft border border-border rounded px-2 py-2">
                  <code className="flex-1 min-w-0 text-meta text-text-muted truncate">{url}</code>
                  <button onClick={() => onRemoveRegistry(url)} className="mobile-tap text-text-faint hover:text-text px-1 -my-2 inline-flex items-center" aria-label={`Remove ${url}`}><X size={14} aria-hidden="true" /></button>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <input id="setting-mobile-skillRegistries" placeholder="https://example.com/skills" value={newRegistryUrl} onChange={(e) => setNewRegistryUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && onAddRegistry()} spellCheck={false} autoComplete="off" autoCapitalize="off" inputMode="url" className="flex-1 min-w-0 bg-bg-soft border border-border px-3 py-2 text-body rounded focus:outline-none focus:border-accent" />
              <button onClick={onAddRegistry} disabled={!newRegistryUrl.trim()} className="px-3 py-2 text-body bg-accent-solid text-on-accent rounded disabled:opacity-40">Add</button>
            </div>
          </div>
        </>
      );
    }
    if (sectionId === "box") {
      // Push notifications — per-device subscription, stays mobile-only under
      // Box (BET-420: no Notifications section; push is a box-level concern).
      if (!isPushSupported()) return null;
      return (
        <div role="group" aria-labelledby="setting-mobile-notifications" className="space-y-2">
          <span id="setting-mobile-notifications" className="text-micro font-semibold uppercase text-text-muted">Notifications</span>
          <div className="text-meta text-text-faint">Push alerts when Claude needs a permission/question, finishes a turn, or hits an error.{pushPermission() === "default" && " iOS only delivers these to the app installed on your home screen."}</div>
          <button onClick={togglePush} disabled={pushBusy} className={`w-full px-3 py-2 text-body rounded border ${pushOn ? "bg-accent-soft text-white border-accent" : "bg-bg-soft text-text-muted border-border"} ${pushBusy ? "opacity-60" : ""}`}>
            {pushBusy ? "Working…" : pushOn ? "Notifications on — tap to disable" : "Enable notifications"}
          </button>
          {pushOn && (
            <button onClick={resubscribe} disabled={pushBusy} className={`w-full px-3 py-2 text-meta rounded border border-border bg-bg-soft text-text-muted ${pushBusy ? "opacity-60" : ""}`}>Not getting notifications? Re-subscribe</button>
          )}
          {pushErr && <div role="alert" className="text-meta text-danger">{errorDisclosure(pushErr, pushErrRaw)}</div>}
        </div>
      );
    }
    if (sectionId === "general") {
      return (
        <div className="space-y-2 pt-1 border-t border-border">
          <span className="text-micro font-semibold uppercase text-text-muted">Reset all settings</span>
          <div className="text-meta text-text-faint">Restore every setting to its default. This does not remove your box pairing or projects.</div>
          <button onClick={() => setConfirmReset(true)} className="w-full px-3 py-2 text-body rounded border border-danger text-danger hover:bg-danger/10">Reset all settings…</button>
        </div>
      );
    }
    return null;
  }
}

// Mobile-styled password (credential) field: commit on blur, inline "Saved".
function MobilePassword({ entry, value, onCommit }: {
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
        onBlur={() => { focused.current = false; if (draft !== value) { onCommit(draft); setSavedAt(Date.now()); } }}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        className="w-full bg-bg-soft border border-border px-3 py-2 text-body rounded focus:outline-none focus:border-accent font-mono"
      />
      {savedAt && <div role="status" className="text-meta text-ok">Saved</div>}
    </div>
  );
}

// Mobile-styled text field: local draft committed on blur → toast + Undo.
function MobileText({ entry, value, onCommit }: {
  entry: SettingEntry; value: string; onCommit: (v: string) => void;
}) {
  const id = fieldId(entry);
  const [draft, setDraft] = useState(value);
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
        onBlur={() => { focused.current = false; if (draft !== value) onCommit(draft); }}
        spellCheck={false}
        autoCapitalize="off"
        className="w-full bg-bg-soft border border-border px-3 py-2 text-meta rounded focus:outline-none focus:border-accent font-mono"
      />
    </div>
  );
}
