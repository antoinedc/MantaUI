import { useEffect, useMemo, useRef, useState, type ReactNode, type KeyboardEvent } from "react";
import {
  X,
  Search,
  Settings as SettingsIcon,
  Terminal,
  KeyRound,
  Sparkles,
  GitBranch,
  Folder,
  Plug,
  Mic,
} from "lucide-react";
import { useStore } from "./store";
import { Modal } from "./Modal";
import { useFocusTrap } from "./useFocusTrap";
import { Checkbox } from "./Checkbox";
import { Toggle } from "./Toggle";
import { ProvidersCard } from "./ProvidersCard";
import { ModelsCard } from "./ModelsCard";
import { SubscriptionsCard } from "./SubscriptionsCard";
import { AddPhonePanel } from "./AddPhonePanel";
import { getMantaPreload } from "./preloadAccess";
import { resolveLauncherFlags } from "./chatShared";
import { applyTheme, type ThemePref } from "./theme";
import { TtlToggle } from "./TtlToggle";
import { Card } from "./Card";
import { Field } from "./Field";
import { Button } from "./Button";
import { Eyebrow } from "./Eyebrow";
import { useApplySetting } from "./settingsApply";
import { BANNER_BTN } from "./Toast";
import { errorDisclosure } from "./settingsError";
import {
  useLaunchers,
  updateLauncherFlag,
  useRegistryUrls,
} from "./settingsShared";
import type {
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

// ===== Dialog semantics (BET-419 §C, BET-724): focus trap + Esc + focus
// restore. The trap/initial-focus/restore piece is the shared `useFocusTrap`
// hook (BET-724 lifted it out of here into Modal.tsx's shared implementation
// — this is the one remaining caller of the "own top-level dialog" flavor).
// Escape-to-close stays local to Settings, since Settings itself isn't built
// on the Modal primitive; it defers to a nested Modal (e.g. the "Remove box?"
// / "Reset all settings?" confirms rendered inline below, or a portal'd
// dialog like the model-edit modal) whenever one is open, so Escape closes
// only the innermost dialog instead of closing all of Settings around it.
function useDialog(onClose: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  useFocusTrap(ref, true);
  // `onClose` is an inline arrow from App (recreated on every App render), so
  // the effect MUST NOT key off its identity — otherwise ANY App re-render
  // (e.g. a background SSE/window-status update ticking in every few seconds)
  // re-runs it and steals focus back to the dialog's first element, yanking
  // the caret out of whatever the user is typing (e.g. the model-edit modal's
  // fields). Keep the latest callback in a ref and run the setup ONCE.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const target = e.target as HTMLElement | null;
      // A portal'd nested modal (e.g. the model-edit dialog, rendered into
      // document.body) lives outside `root` in the DOM — its own Escape
      // handler owns it, not Settings'.
      if (target instanceof Node && !root.contains(target)) return;
      // An INLINE nested modal (e.g. the "Remove box?" / "Reset all
      // settings?" confirms, rendered as normal children of this dialog) IS
      // inside `root` — but if focus is currently inside ITS panel, that
      // modal's own Escape ownership (Modal.tsx, BET-724) should win, not
      // Settings'. Bail so Settings never steals Escape from an open confirm.
      const nestedDialog = target?.closest('[role="dialog"]');
      if (nestedDialog && nestedDialog !== root) return;
      e.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);
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
  // The two pure-boolean setting rows adopt the Toggle switch primitive
  // (BET-614 stage 3): chatAutoAllow + allowAgentPush. A switch is for a
  // single live on/off setting; the other `toggle`-schema entries keep the
  // Checkbox (a checkbox in a form and a toggle for a live setting are
  // different controls, both specced).
  if (entry.id === "chatAutoAllow" || entry.id === "allowAgentPush") {
    return (
      <div className="space-y-1">
        <div className="flex items-start gap-3 text-body">
          <Toggle id={id} checked={value} onChange={onApply} ariaLabel={entry.label} />
          <span>
            {entry.label}
            {entry.help && <span className="block text-meta text-text-faint mt-1">{entry.help}</span>}
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <div className="flex items-start gap-3 text-body">
        <Checkbox id={id} checked={value} onChange={onApply} ariaLabel={entry.label} />
        <span>
          {entry.label}
          {entry.help && <span className="block text-meta text-text-faint mt-1">{entry.help}</span>}
        </span>
      </div>
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
      <div role="group" aria-label={entry.label} className="inline-flex rounded-md border border-border overflow-hidden">
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
                selected ? "bg-raised text-text font-semibold" : "text-text-muted hover:text-text hover:bg-bg-elev"
              }`}
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
// Password (credential): local draft committed on blur → inline "Saved"
// confirmation (role=status), no toast. The ONE blur-commit exception called
// out in the spec.
function SettingField({ entry, value, onCommit, credential }: {
  entry: SettingEntry; value: string; onCommit: (v: string) => void;
  credential?: boolean;
}) {
  const id = fieldId(entry);
  const [draft, setDraft] = useState(value);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const focused = useRef(false);
  // Keep the draft in sync with the store ONLY when the field is NOT focused
  // (so an external change — e.g. Undo from another toast — is picked up,
  // but an in-progress edit is never stomped).
  useEffect(() => { if (!focused.current) setDraft(value); }, [value]);
  return (
    <Field
      id={id}
      label={entry.label}
      type={credential ? "password" : "text"}
      placeholder={entry.placeholder}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        if (credential) setSavedAt(null);
      }}
      onFocus={() => { focused.current = true; }}
      onBlur={() => {
        focused.current = false;
        if (draft !== value) {
          onCommit(draft);
          if (credential) setSavedAt(Date.now());
        }
      }}
      autoComplete={credential ? "off" : undefined}
      help={entry.help}
      footer={credential && savedAt ? <div role="status" className="text-meta text-ok">Saved</div> : undefined}
    />
  );
}

// 15px stroked icon per section, inheriting currentColor (BET-461 §1).
const SECTION_ICONS: Record<SettingSectionId, typeof SettingsIcon> = {
  general: SettingsIcon,
  box: Terminal,
  accounts: KeyRound,
  models: Sparkles,
  sessions: GitBranch,
  files: Folder,
  extensions: Plug,
  voice: Mic,
};

// Card groupings for the schema-driven sections. Each { title, entryIds }
// becomes one --card surface with a micro-caps group heading, mirroring the
// mockup's group labels. Sections with per-section custom content (general,
// box, accounts, extensions) are rendered by renderCustom instead.
const SECTION_GROUPS: Partial<Record<SettingSectionId, { title: string; entryIds: string[] }[]>> = {
  models: [
    { title: "Requests", entryIds: ["cacheTtl"] },
    { title: "Plan usage", entryIds: ["alwaysShowUsage"] },
  ],
  sessions: [
    { title: "Naming", entryIds: ["autoRenameSessions"] },
    { title: "Git worktrees", entryIds: ["worktreePerSession", "worktreeCleanOnClose"] },
  ],
  files: [
    { title: "Files the agent sends you", entryIds: ["allowAgentPush", "downloadsDir"] },
    { title: "Files you send the agent", entryIds: ["uploadCleanupHours"] },
  ],
  voice: [
    { title: "Speech to text (Groq)", entryIds: ["groqApiKey", "voiceTranscriptionModel", "voiceCommandModel"] },
  ],
};

// A --card surface with a micro-caps group heading (BET-461 §4). The chrome
// (--card bg, --border edge, --r-lg radius, 12px v / 16px h padding) lives on
// the Card primitive; GroupCard keeps only its group title + the space-y gap
// between its entries (BET-531).
function GroupCard({ title, danger = false, children }: {
  title?: string;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <div>
      {title && <Eyebrow>{title}</Eyebrow>}
      <Card danger={danger}>
        <div className="space-y-4">{children}</div>
      </Card>
    </div>
  );
}

export function Settings({
  onClose,
  initialSection,
}: {
  onClose: () => void;
  /** Section to land on when the modal mounts (e.g. the `manta-open-settings`
   *  bridge from "Manage models…"). Defaults to General. */
  initialSection?: SettingSectionId;
}) {
  // BET-730: per-field selectors, never a bare useStore() — a no-selector
  // destructure re-renders the whole Settings tree on every store write.
  const cacheTtl = useStore((s) => s.cacheTtl);
  const groqApiKey = useStore((s) => s.groqApiKey);
  const voiceTranscriptionModel = useStore((s) => s.voiceTranscriptionModel);
  const voiceCommandModel = useStore((s) => s.voiceCommandModel);
  const allowAgentPush = useStore((s) => s.allowAgentPush);
  const downloadsDir = useStore((s) => s.downloadsDir);
  const worktreePerSession = useStore((s) => s.worktreePerSession);
  const worktreeCleanOnClose = useStore((s) => s.worktreeCleanOnClose);
  const uploadCleanupHours = useStore((s) => s.uploadCleanupHours);
  const autoRenameSessions = useStore((s) => s.autoRenameSessions);
  const alwaysShowUsage = useStore((s) => s.alwaysShowUsage);
  const theme = useStore((s) => s.theme);
  const skillRegistryUrls = useStore((s) => s.skillRegistryUrls);
  const launcherFlags = useStore((s) => s.launcherFlags);
  const updatePrompt = useStore((s) => s.updatePrompt);
  const boxToken = useStore((s) => s.boxToken);
  const serverUrl = useStore((s) => s.serverUrl);
  const boxId = useStore((s) => s.boxId);
  const push = useStore((s) => s.pushAppToast);
  const applySetting = useApplySetting(push);
  const dialogRef = useDialog(onClose);

  // Active tab + search — declared early so the plugins effect below can read
  // activeTab without a TDZ violation.
  const [activeTab, setActiveTab] = useState<SettingSectionId>(initialSection ?? "general");
  const [query, setQuery] = useState("");
  // A section request that lands while the modal is already open re-targets
  // it, rather than only applying on mount.
  useEffect(() => {
    if (initialSection) setActiveTab(initialSection);
  }, [initialSection]);
  const inSearch = query.trim().length > 0;
  const searchHits = useMemo(() => searchSettings(SETTINGS, query, PLATFORM), [query]);

  // Current config values for schema-driven fields, read directly from the
  // store (NO local field state → no stomping bug).
  const values: Record<string, unknown> = useMemo(
    () => ({
      cacheTtl,
      groqApiKey,
      voiceTranscriptionModel,
      voiceCommandModel,
      allowAgentPush,
      downloadsDir,
      worktreePerSession,
      worktreeCleanOnClose,
      uploadCleanupHours,
      theme,
      autoRenameSessions,
      alwaysShowUsage,
    }),
    [cacheTtl, groqApiKey, voiceTranscriptionModel, voiceCommandModel, allowAgentPush, downloadsDir, worktreePerSession, worktreeCleanOnClose, uploadCleanupHours, theme, autoRenameSessions, alwaysShowUsage],
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
  } = useRegistryUrls(skillRegistryUrls ?? []);
  const persistRegistryUrls = async (next: string[]) => {
    const prev = skillRegistryUrls ?? [];
    useStore.setState({ skillRegistryUrls: next });
    try {
      const r = await window.api.configUpdate({ skillRegistryUrls: next });
      const saved = (r as Record<string, unknown>).skillRegistryUrls;
      useStore.setState({ skillRegistryUrls: Array.isArray(saved) ? (saved as string[]) : next });
      push({
        id: `registry-${Date.now()}`,
        message: next.length > prev.length ? "Registry URL added" : "Registry URL removed",
        actions: [{ label: "Undo", onClick: () => { void useStore.setState({ skillRegistryUrls: prev }); window.api.configUpdate({ skillRegistryUrls: prev }).catch(() => {}); } }],
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
  const [launcherFlagValues, setLauncherFlagValues] = useState(launcherFlags ?? {});
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
      push({ id: `plugins-${Date.now()}`, message: `Plugins ${on ? "enabled" : "disabled"} — restart Manta to apply.`, actions: [{ label: "Undo", onClick: () => { setPluginsOn(prev); void preload.pluginsSetEnabled(prev); } }] });
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
        actions: [{ label: "Undo", onClick: () => { void useStore.setState(prev); if (prev.theme) applyTheme(prev.theme as ThemePref); window.api.configUpdate(prev).catch(() => {}); } }],
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
        return <SettingField credential entry={entry} value={String(cur ?? "")} onCommit={(v) => void commitKey(entry, v.trim())} />;
      case "text":
      case "path":
        return <SettingField entry={entry} value={String(cur ?? "")} onCommit={(v) => void commitKey(entry, v)} />;
      default:
        return null;
    }
  };

  // Per-section custom content (cards/lists the schema doesn't describe).
  const renderCustom = (section: SettingSectionId): ReactNode => {
    if (section === "general") {
      return (
        <>
          <GroupCard title="About">
            <div className="text-body text-text-muted">
              Desktop <span className="font-medium text-text">{clientVersion ?? "…"}</span>
              {serverVersion && (<><span className="text-text-faint"> · </span>server <span className="font-medium text-text">{serverVersion}</span></>)}
              {opencodeVersion && (<><span className="text-text-faint"> · </span>opencode <span className="font-medium text-text">{opencodeVersion}</span></>)}
            </div>
            {updatePrompt && (
              <div className="rounded-md border border-accent/30 bg-accent/10 px-3 py-2 flex items-center gap-2">
                <span className="flex-1 text-meta text-text">Update ready: <span className="font-medium">{updatePrompt.releaseName || updatePrompt.version}</span></span>
                <button onClick={() => { void window.api.autoUpdateInstall(); }} className={BANNER_BTN}>Restart to update</button>
              </div>
            )}
          </GroupCard>
          <GroupCard title="Danger zone" danger>
            <div className="flex items-start justify-between gap-4">
              <div className="text-body text-text-faint">Restore every setting below to its default. This does not remove your box pairing or projects.</div>
              <Button onClick={() => setConfirmReset(true)} tone="danger">Reset all settings…</Button>
            </div>
          </GroupCard>
        </>
      );
    }
    if (section === "box") {
      const connected = Boolean(boxToken);
      return (
        <>
          {/* Read-only status card — the URL lives here; changing it means
              re-pairing, so there is no editable Connection block (BET-420). */}
          <GroupCard>
            <div className="flex items-center gap-2">
              <span aria-hidden className={`inline-block w-2 h-2 rounded-full ${connected ? "bg-ok" : "bg-text-faint"}`} />
              <span className="text-body font-medium text-text">{connected ? "Connected" : "Not paired"}</span>
            </div>
            <dl className="space-y-1 text-meta">
              <div className="flex gap-2">
                <dt className="text-text-faint shrink-0">Server URL</dt>
                <dd className="text-text-muted font-mono break-all">{serverUrl || "—"}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-text-faint shrink-0">Box ID</dt>
                <dd className="text-text-muted font-mono break-all">{boxId || "—"}</dd>
              </div>
              {serverVersion && (
                <div className="flex gap-2">
                  <dt className="text-text-faint shrink-0">Server</dt>
                  <dd className="text-text-muted font-mono">v{serverVersion}</dd>
                </div>
              )}
            </dl>
          </GroupCard>

          <GroupCard title="Devices">
            <AddPhonePanel />
            <div className="flex items-center justify-between">
              <div className="text-body text-text-faint">Re-run the guided setup (pairing, providers, first project).</div>
              <Button onClick={() => { void useStore.getState().relaunchOnboarding(); onClose(); }} tone="default">Run setup again</Button>
            </div>
          </GroupCard>

          {/* Advanced — opencodePort, exposed in the UI for the first time
              (BET-420). Collapsed by default; it's an infrequently-touched
              knob. */}
          <GroupCard title="Advanced">
            <details>
              <summary className="text-body text-text-muted cursor-pointer select-none">Advanced</summary>
              <div className="mt-4 space-y-1">
                <Field
                  id="setting-opencodePort"
                  label="opencode port"
                  type="number"
                  min={1}
                  max={65535}
                  value={opencodePortDraft}
                  onChange={(e) => { setOpencodePortDraft(e.target.value); setOpencodePortSavedAt(null); }}
                  onBlur={commitOpencodePort}
                  help="Local port forwarded to the box's opencode serve instance. Defaults to 14096 to avoid colliding with a local opencode on 4096."
                  footer={opencodePortSavedAt ? <div role="status" className="text-meta text-ok">Saved</div> : undefined}
                />
              </div>
            </details>
          </GroupCard>

          <GroupCard title="Danger zone" danger>
            <div className="flex items-center justify-between">
              <div className="text-body text-text-faint">Forget this box on the desktop. If the box is reachable, its current token is revoked too.</div>
              <Button onClick={() => setConfirmRemove(true)} disabled={removingBox} tone="default">
                {removingBox ? "Removing…" : "Remove box"}
              </Button>
            </div>
            {removeResult && !removeResult.ok && <div role="alert" className="text-body text-warn">{removeResult.message}</div>}
          </GroupCard>
        </>
      );
    }
    if (section === "accounts") {
      // Subscriptions + custom endpoints merged into one list (BET-420).
      // Both are "a way to reach a model"; the shared CustomProviderForm
      // lives inside ProvidersCard and probes + validates identically here
      // and in onboarding.
      return (
        <>
          <GroupCard title="Subscriptions">
            <SubscriptionsCard />
          </GroupCard>
          <GroupCard title="Custom endpoints">
            <div className="text-body text-text-faint">OpenAI-compatible endpoints opencode can serve. Add one, refresh to discover models, then enable the ones you want in the model picker.</div>
            <ProvidersCard onRestartNeeded={requestRestart} />
          </GroupCard>
        </>
      );
    }
    if (section === "models") {
      return (
        <GroupCard>
          <ModelsCard />
        </GroupCard>
      );
    }
    if (section === "extensions") {
      return (
        <>
          <GroupCard title="Plugins">
            {pluginsToggleEntry && <div className="space-y-1">
              <div className="flex items-start gap-3 text-body">
                <Checkbox id={fieldId(pluginsToggleEntry)} checked={pluginsOn} onChange={(v) => void togglePlugins(v)} ariaLabel={pluginsToggleEntry.label} />
                <span>
                  {pluginsToggleEntry.label}
                  {pluginsToggleEntry.help && <span className="block text-meta text-text-faint mt-1">{pluginsToggleEntry.help}</span>}
                </span>
              </div>
            </div>}
            {pluginsError ? (
              <div role="alert" className="text-body text-danger">{errorDisclosure("Couldn't load the plugins list.", pluginsError)}</div>
            ) : plugins === null ? (
              <div className="text-body text-text-faint">Loading…</div>
            ) : plugins.length === 0 ? (
              <div className="text-body text-text-faint">No plugins installed yet. The AI can author them with <code className="text-text-muted">plugin.write</code> when this toggle is on.</div>
            ) : (
              <div className="space-y-2">
                {plugins.map((p) => (
                  <div key={p.name} className="border border-border rounded-xs p-3 bg-bg-soft space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-body font-medium text-text">{p.name}</span>
                      {p.valid ? <span className="text-meta px-2 py-px rounded-xs bg-ok-bg text-ok">valid</span> : <span className="text-meta px-2 py-px rounded-xs bg-danger-bg text-danger break-all">parse error: {p.error}</span>}
                      <span className="ml-auto text-meta text-text-faint">{p.stepCount} step{p.stepCount === 1 ? "" : "s"}{p.timeoutMs != null ? ` · ${formatTimeout(p.timeoutMs)}` : ""}</span>
                    </div>
                    {p.description && <div className="text-meta text-text-muted">{p.description}</div>}
                    {p.inputs.length > 0 && <div className="text-meta text-text-faint">Inputs: {p.inputs.map((i) => `${i.id}${i.default !== undefined ? `=${JSON.stringify(i.default)}` : ""}`).join(", ")}</div>}
                  </div>
                ))}
              </div>
            )}
            <button onClick={() => { const preload = getMantaPreload(); if (preload?.revealInFolder) void preload.revealInFolder("~/.manta/plugins"); }} className="text-body px-4 py-2 rounded-xs border border-border text-text-muted hover:text-text">Open plugins folder</button>
          </GroupCard>
          <GroupCard title="Skill registries">
            <div className="text-body text-text-faint">Extra skill registry URLs fetched by opencode on startup. The default Manta registry is always included.</div>
            <div className="space-y-2">
              {registryUrls.map((url) => (
                <div key={url} className="flex items-center gap-2">
                  <code className="flex-1 text-body bg-bg-soft border border-border rounded-xs px-3 py-2 text-text-muted truncate">{url}</code>
                  <button onClick={() => onRemoveRegistry(url)} className="text-body text-text-faint hover:text-text px-2 inline-flex items-center" aria-label="Remove registry URL"><X size={14} aria-hidden="true" /></button>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <div className="flex-1">
                <Field placeholder="https://example.com/skills" value={newRegistryUrl} onChange={(e) => setNewRegistryUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && onAddRegistry()} />
              </div>
              <Button onClick={onAddRegistry} disabled={!newRegistryUrl.trim()} tone="default">Add</Button>
            </div>
          </GroupCard>
          {availableLaunchers.some((l) => l.flags.length > 0) && (
            <GroupCard title="CLI launch options">
              <div className="text-body text-text-faint">Flags used when launching an AI CLI (e.g. Claude Code) directly in a session's terminal. Only CLIs detected on this box are shown.</div>
              <div className="space-y-4">
                {availableLaunchers.filter((l) => l.flags.length > 0).map((l) => (
                  <div key={l.id} className="space-y-2">
                    <div className="text-body font-medium text-text">{l.label}</div>
                    {l.flags.map((f) => (
                      <div key={f.key} className="flex items-start gap-3 text-body">
                        <Checkbox checked={resolveLauncherFlags(l.flags, launcherFlagValues[l.id])[f.key]} onChange={(v) => setLauncherFlag(l.id, f.key, v)} ariaLabel={f.label} />
                        <span>{f.label}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </GroupCard>
          )}
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

  // Assemble the active section's panels as --card groups. Card-grouped
  // schema sections come from SECTION_GROUPS; General's Theme + custom blocks
  // and the fully custom sections (box/accounts/extensions) come from
  // renderCustom.
  const renderSection = (section: SettingSectionId): ReactNode => {
    const grouped = SECTION_GROUPS[section] ?? [];
    const byId = new Map(simpleEntriesExPlugins.map((e) => [e.id, e]));
    const groupedBlocks = grouped.map((g) => (
      <GroupCard key={g.title} title={g.title}>
        {g.entryIds.map((id) => {
          const entry = byId.get(id);
          return entry ? <div key={id}>{renderField(entry)}</div> : null;
        })}
      </GroupCard>
    ));

    let custom: ReactNode = null;
    if (section === "general") {
      const theme = simpleEntriesExPlugins.find((e) => e.id === "theme");
      custom = (
        <>
          {theme && <GroupCard title="Appearance"><div>{renderField(theme)}</div></GroupCard>}
          {renderCustom("general")}
        </>
      );
    } else {
      custom = renderCustom(section);
    }

    return (
      <>{groupedBlocks}{custom}</>
    );
  };

  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="settings-title" className="fixed inset-0 bg-bg z-50 flex">
      {/* Left sidebar navigation (tablist) */}
      <div className="w-48 bg-bg-soft border-r border-border flex flex-col shrink-0">
        <div className="titlebar-drag h-10 shrink-0" />
        <div className="p-4 border-b border-border">
          <h2 id="settings-title" tabIndex={-1} className="text-title font-semibold">Settings</h2>
        </div>
        <nav className="flex-1 py-2 px-2 overflow-y-auto" role="tablist" aria-label="Settings sections">
          {SETTING_SECTIONS.map((tab, i) => {
            const modified = sectionIsModified(SETTINGS, tab.id, PLATFORM, values);
            const prev = i > 0 ? SETTING_SECTIONS[i - 1] : null;
            const showGroup = tab.group && (!prev || prev.group !== tab.group);
            const Icon = SECTION_ICONS[tab.id];
            return (
              <div key={tab.id}>
                {showGroup && (
                  <div aria-hidden className="px-3 pt-3 pb-1 text-micro font-semibold uppercase tracking-wide text-text-faint">{tab.group}</div>
                )}
                <button
                  ref={(el) => { railRefs.current[tab.id] = el; }}
                  role="tab"
                  aria-selected={activeTab === tab.id}
                  aria-controls={`panel-${tab.id}`}
                  id={`tab-${tab.id}`}
                  onClick={() => setActiveTab(tab.id)}
                  onKeyDown={onRailKeyDown}
                  className={`w-full flex items-center gap-2 text-left px-3 py-2 rounded-md text-body transition-colors ${
                    activeTab === tab.id ? "bg-raised text-text font-semibold" : "text-text-faint hover:text-text hover:bg-fill-hover"
                  }`}
                >
                  <Icon size={15} strokeWidth={2} aria-hidden="true" className="shrink-0" />
                  <span className="flex-1 min-w-0 truncate">{tab.label}</span>
                  {modified && <span aria-hidden="true" className="inline-block w-1.5 h-1.5 rounded-full bg-accent shrink-0" title="Modified" />}
                </button>
              </div>
            );
          })}
        </nav>
      </div>

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex items-center gap-3 p-4 border-b border-border">
          <div className="flex-1">
            <div className="max-w-sm">
              <Field placeholder="Find a setting…" value={query} onChange={(e) => setQuery(e.target.value)} ariaLabel="Search settings" mono={false} leading={<Search size={14} aria-hidden="true" />} inputRef={searchRef} />
            </div>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text text-body px-3 py-2 rounded-xs hover:bg-bg-elev transition-colors inline-flex items-center" aria-label="Close settings"><X size={16} aria-hidden="true" /></button>
          <div className="titlebar-inset-right" />
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {/* The ONE restart affordance (BET-420). Sits above the panel so it
              is visible regardless of which section is active. */}
          {restartNeeded && (
            <div role="status" className="mb-4 flex items-center gap-3 rounded-md border border-warn/40 bg-warn-bg px-4 py-3">
              <span className="flex-1 text-body text-text">
                An opencode restart is needed to apply recent model or endpoint changes. Restarting interrupts all running sessions.
              </span>
              <Button onClick={() => void performRestart()} disabled={restarting} tone="default">
                {restarting ? "Restarting…" : "Restart opencode"}
              </Button>
              <Button onClick={() => setRestartNeeded(false)} disabled={restarting} tone="ghost">Later</Button>
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
              {renderSection(activeTab)}
            </div>
          )}
        </div>
      </div>

      {/* In-app confirm: Remove box (replaces window.confirm — BET-419 §D). */}
      <Modal open={confirmRemove} size="md" label="Remove this box?" onDismiss={() => setConfirmRemove(false)}>
          <div className="space-y-4">
            <h3 className="text-title font-semibold">Remove this box?</h3>
            <div className="text-body text-text-faint">The desktop will forget its pairing and saved projects. If the box is reachable, its current token is also revoked. If the box is offline, the local credentials are cleared and the box's token will be rotated the next time it starts.</div>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setConfirmRemove(false)} tone="ghost">Cancel</Button>
              <Button onClick={removeBox} tone="danger">Remove</Button>
            </div>
          </div>
        </Modal>

      {/* In-app confirm: Reset all settings (BET-419 §B.3). */}
      <Modal open={confirmReset} size="md" label="Reset all settings?" onDismiss={() => setConfirmReset(false)}>
          <div className="space-y-4">
            <h3 className="text-title font-semibold">Reset all settings?</h3>
            <div className="text-body text-text-faint">Every setting will return to its default. Your box pairing and projects are not affected. You can undo this right after.</div>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setConfirmReset(false)} tone="ghost">Cancel</Button>
              <Button onClick={resetAll} tone="danger">Reset</Button>
            </div>
          </div>
        </Modal>
    </div>
  );
}
