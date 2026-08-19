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
  PhoneCall,
} from "lucide-react";
import { useStore } from "./store";
import type { AppConfig } from "../shared/types.js";
import { ConfirmModal } from "./ConfirmModal";
import { useFocusTrap } from "./useFocusTrap";
import { Checkbox } from "./Checkbox";
import { Toggle } from "./Toggle";
import { StatusDot } from "./StatusDot";
import { ListRow } from "./ListRow";
import { ProvidersCard } from "./ProvidersCard";
import { ModelsCard } from "./ModelsCard";
import { SubscriptionsCard } from "./SubscriptionsCard";
import { AddPhonePanel } from "./AddPhonePanel";
import { getMantaPreload } from "./preloadAccess";
import { resolveLauncherFlags } from "./chatShared";
import { applyTheme, type ThemePref } from "./theme";
import { ChipGroup } from "./Chip";
import { Card } from "./Card";
import { Field } from "./Field";
import { Button } from "./Button";
import { Eyebrow } from "./Eyebrow";
import { useApplySetting } from "./settingsApply";
import { SettingsRow } from "./SettingsRow";
import { BANNER_BTN } from "./Toast";
import { errorDisclosure } from "./settingsError";
import { describeUpdateTarget, voiceUi } from "./chatUtils";
import { refreshUpdateTargets } from "./updateCheck";
import { rowUpdateState, isCliTarget, desktopUpdateBusy } from "../shared/updateTargets.mjs";
import { forgeCredentialSecondary } from "./chatUtils";
import { useCachedResource } from "./useCachedResource";
import { MantaLoader } from "./MantaLoader";
import {
  useLaunchers,
  updateLauncherFlag,
  useRegistryUrls,
} from "./settingsShared";
import type {
  PluginRegistryRow,
  ForgeRuleRow,
  ForgeStatusResult,
  OpencodeReference,
  UpdateTarget,
} from "../shared/types";
import {
  SETTINGS,
  SETTING_SECTIONS,
  settingsForSection,
  searchSettings,
  sectionIsModified,
  resetAllPayload,
  fieldId,
  validateReferenceAlias,
  classifyReferenceTarget,
  type SettingEntry,
  type SettingSectionId,
} from "../shared/settingsSchema";

const PLATFORM = "desktop" as const;

// BET-1191: the on-call CTO section + fields are hidden unless the build-time
// voice flag is on. `voiceUi` is the SINGLE predicate — it feeds both the nav
// (section list) and the search (which bypasses the section list and reads the
// schema directly), so the two surfaces can never disagree. Everything else in
// Settings is untouched.
const VOICE_SECTIONS = voiceUi ? SETTING_SECTIONS : SETTING_SECTIONS.filter((s) => s.id !== "cto");
const VOICE_SETTINGS = voiceUi ? SETTINGS : SETTINGS.filter((e) => e.section !== "cto");

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
// on the Modal primitive. It closes Settings only when no other dialog is
// currently open in the document (portalled or inline): otherwise Escape
// closes the innermost dialog instead of closing all of Settings around it.
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
      // Bail only if another dialog is currently open in the document —
      // portalled to document.body or rendered inline as a child of Settings
      // — so that dialog's own Escape handler owns the key. Otherwise close
      // Settings regardless of where focus currently sits.
      const otherDialogOpen = Array.from(
        document.querySelectorAll('[role="dialog"]'),
      ).some((d) => d !== root && !d.contains(root));
      if (otherDialogOpen) return;
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
      <SettingsRow name={entry.label} help={entry.help}>
        <Toggle id={id} checked={value} onChange={onApply} ariaLabel={entry.label} />
      </SettingsRow>
    );
  }
  return (
    <SettingsRow name={entry.label} help={entry.help}>
      <Checkbox id={id} checked={value} onChange={onApply} ariaLabel={entry.label} />
    </SettingsRow>
  );
}

function SegmentedField({ entry, value, onApply }: {
  entry: SettingEntry; value: string; onApply: (v: string) => void;
}) {
  return (
    <SettingsRow name={entry.label} help={entry.help}>
      <ChipGroup
        label={entry.label}
        value={value}
        options={entry.options ?? []}
        onChange={onApply}
      />
    </SettingsRow>
  );
}

// Text/path (non-credential): local draft committed on blur → toast + Undo.
// Password (credential): local draft committed on blur → inline "Saved"
// confirmation (role=status), no toast. The ONE blur-commit exception called
// out in the spec.
function SettingField({ entry, value, onCommit, credential }: {
  entry: SettingEntry; value: string; onCommit: (v: string) => void | Promise<void>;
  credential?: boolean;
}) {
  const id = fieldId(entry);
  const [draft, setDraft] = useState(value);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const focused = useRef(false);
  // Keep the draft in sync with the store ONLY when the field is NOT focused
  // (so an external change — a rollback, a reset — is picked up,
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
        if (draft !== value && !saving) {
          void (async () => {
            setSaving(true);
            try {
              await onCommit(draft);
              if (credential) setSavedAt(Date.now());
            } finally {
              setSaving(false);
            }
          })();
        }
      }}
      autoComplete={credential ? "off" : undefined}
      help={entry.help}
      footer={
        saving ? (
          <div role="status" className="text-meta text-text-faint flex items-center gap-2">
            <MantaLoader size="inline" /> Saving…
          </div>
        ) : credential && savedAt ? (
          <div role="status" className="text-meta text-ok">Saved</div>
        ) : undefined
      }
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
  cto: PhoneCall,
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

/**
 * ONE row of the About update list, for ONE target (stage 4, BET-1099).
 *
 * Four columns in this fixed order — dot · name · versions · action — driven
 * entirely by the one shared describe function (`describeUpdateTarget`). The
 * component contains NO per-target branching: the tone it returns picks the
 * action column, and nothing else varies between targets.
 *
 * The dot carries the visual message that the old verdict sentence did — "Up
 * to date", "Couldn't check" and a manual update are all "no button" states,
 * and without a colour they read identically, which is the failure this whole
 * feature exists to make impossible. Version numbers are MONO so the digits
 * align down the column and a change is legible at a glance.
 *
 * `downloading` / `downloadPercent` belong to the desktop leg only (a manual
 * download started from this row replaces the Update button with its
 * progress). Every box-side target (server, opencode, each CLI) shares the
 * same `onUpdate`, which raises `onRequestServerUpdate` — there is no per-CLI
 * apply. When `installReady` is set (a desktop download finished and the
 * pinned "Update ready" strip is up) the desktop row's own Update button is
 * suppressed — the strip IS that single-click action, and a second one for
 * the same target would re-download an already-downloaded update.
 *
 * BET-1160: `rowState` + `error` are the in-flight/result presentation, read
 * from the shared store (via the parent) so this row and the banner can never
 * disagree. `rowState.kind === "updating"` means THIS target is mid-update →
 * its own spinner + "Updating…" (every other row is just disabled);
 * `rowState.kind === "busy"` means some OTHER update is in flight → the button
 * is disabled. `error` is this target's transient result error → the row flips
 * to the shared error tone and the button is re-enabled for retry.
 */
function UpdateTargetRow({
  target,
  desktopBusy,
  installReady,
  onUpdate,
  rowState,
  error,
}: {
  target: UpdateTarget;
  /** BET-1195: the desktop leg's presentation (from `desktopUpdateBusy`), so
   *  the row and the banner agree. null for non-desktop targets / no desktop
   *  run in flight. */
  desktopBusy: { busyLabel: string; progress: { step: number; total: number; label: string; percent?: boolean } | null } | null;
  installReady: boolean;
  onUpdate: (t: UpdateTarget) => void;
  rowState: { kind: "updating" } | { kind: "busy" } | { kind: "idle" };
  error: string | null;
}) {
  const row = describeUpdateTarget(target);
  const hasUpdate = target.latest != null && target.latest !== target.current;
  const updating = rowState.kind === "updating";
  const busy = rowState.kind === "busy";

  // Today's UpdateResultRow dot tones, kept as-is (BET-1099 design contract).
  // A transient update error flips the dot to the error tone (reuses the
  // existing error presentation — no new markup).
  const dotTone = error != null ? "error" : row.tone;
  const dot =
    dotTone === "ok"
      ? "bg-ok"
      : dotTone === "action"
        ? "bg-accent"
        : dotTone === "error"
          ? "bg-danger"
          : "bg-[var(--tx4)]";

  // Action column per tone. `action` is the only tone that gets a button; the
  // rest are quiet text (ok / error) or a manual link (muted, when there is a
  // URL to offer).
  let action: ReactNode = null;
  if (target.id === "desktop" && desktopBusy) {
    // BET-1195: the desktop row shows its REAL in-flight state — the download
    // percent, or the terminal "Restarting Manta Desktop…" beat — from the
    // shared helper, instead of the generic "Updating…" spinner. Same label the
    // banner shows; they can never diverge.
    action = (
      <span className="shrink-0 text-meta text-text-faint">{desktopBusy.busyLabel}</span>
    );
  } else if (updating) {
    // THIS target is the one being updated — its own spinner + label. No other
    // row shows a spinner; those are just disabled via `busy`.
    action = (
      <span className="shrink-0 text-meta text-text-faint inline-flex items-center gap-2">
        <span
          aria-hidden
          className="inline-block h-3 w-3 rounded-full border-2 border-current border-t-transparent animate-spin"
        />
        Updating…
      </span>
    );
  } else if (row.tone === "action") {
    // An update is available (or a failed one to retry). A finished desktop
    // download is marked by the pinned "Update ready" strip (installReady);
    // suppress the desktop row's own Update button then, since a second one
    // would re-download an already-downloaded update.
    if (!(target.id === "desktop" && installReady)) {
      // Disabled while any update is in flight (`busy`); re-enabled (with the
      // inline error above) so the user can retry a failed row.
      action = (
        <button className={BANNER_BTN} disabled={busy} onClick={() => onUpdate(target)}>
          Update
        </button>
      );
    }
  } else if (row.tone === "muted") {
    if (target.manualUrl) {
      const url = target.manualUrl;
      action = (
        <a
          className="shrink-0 text-accent no-underline hover:underline"
          href={url}
          onClick={(e) => {
            e.preventDefault();
            void window.api.openExternal(url);
          }}
        >
          Update manually ↗
        </a>
      );
    }
  } else if (row.tone === "ok") {
    action = <span className="shrink-0 text-text-quiet">Up to date</span>;
  } else if (row.tone === "error") {
    action = <span className="shrink-0 text-danger">Couldn't check</span>;
  }

  return (
    <div className="flex items-center gap-2 text-[length:var(--font-size-2xs)]">
      <span aria-hidden className={`inline-block shrink-0 w-[length:var(--step-dot)] h-[length:var(--step-dot)] rounded-full ${dot}`} />
      <span className="text-text">{target.label}</span>
      <span className={`flex-1 min-w-0 truncate font-mono ${error != null ? "text-danger" : "text-text-quiet"}`}>
        {error != null ? (
          error
        ) : hasUpdate ? (
          <>
            {target.current ?? ""} →{" "}
            <span className="text-text-muted font-medium">{target.latest}</span>
          </>
        ) : (
          target.current ?? ""
        )}
      </span>
      {action}
    </div>
  );
}

export function Settings({
  onClose,
  initialSection,
  onRequestServerUpdate,
  busy = false,
  onCliUpdate,
  onDesktopUpdate,
  desktopRestarting = false,
}: {
  onClose: () => void;
  /** Section to land on when the modal mounts (e.g. the `manta-open-settings`
   *  bridge from "Manage models…"). Defaults to General. */
  initialSection?: SettingSectionId;
  /** Ask App.tsx to run its box-update flow. About's "Update & restart" button
   *  routes here rather than calling `serverUpdateApply()` itself, so the box
   *  is only ever updated through ONE path: App owns the confirm dialog (which
   *  warns that every running agent turn dies), the in-flight/progress state,
   *  the 120s safety cap, and the transient-network-error handling that makes
   *  a successful restart stop looking like a failure. A second call site here
   *  would be a second, subtly different version of all of that. */
  onRequestServerUpdate?: () => void;
  /** Aggregate "an update is in flight" (`updatingTargetId != null ||
   *  boxUpgrading`). Passed DOWN from App because `boxUpgrading` is App-local;
   *  the per-target in-flight + error state itself is read from the shared
   *  store so Settings and the banner can never disagree. */
  busy?: boolean;
  /** BET-1159: App's per-CLI update router. Settings delegates a CLI row here
   *  (decided by the shared `isCliTarget` discriminator) so the Settings rows
   *  and App's banner route through the SAME path — no second discriminator. */
  onCliUpdate?: (t: UpdateTarget) => void;
  /** BET-1195: App's single desktop download runner. Settings delegates the
   *  desktop row here (mirroring the CLI story) so the desktop leg's in-flight
   *  state lives in the shared store — the banner and the row can never
   *  disagree. The row's download percent + restart beat come from the store /
   *  this prop, not a Settings-local copy. */
  onDesktopUpdate?: () => void;
  /** BET-1195: App-local flag set right before quit-and-install (the desktop
   *  analogue of boxRestarting). Passed down so the row can show "Restarting
   *  Manta Desktop…" instead of a download percent the download no longer talks
   *  about. */
  desktopRestarting?: boolean;
}) {
  // BET-730: per-field selectors, never a bare useStore() — a no-selector
  // destructure re-renders the whole Settings tree on every store write.
  const cacheTtl = useStore((s) => s.cacheTtl);
  const groqApiKey = useStore((s) => s.groqApiKey);
  const voiceTranscriptionModel = useStore((s) => s.voiceTranscriptionModel);
  const openaiApiKey = useStore((s) => s.openaiApiKey);
  const allowAgentPush = useStore((s) => s.allowAgentPush);
  const downloadsDir = useStore((s) => s.downloadsDir);
  const worktreePerSession = useStore((s) => s.worktreePerSession);
  const worktreeCleanOnClose = useStore((s) => s.worktreeCleanOnClose);
  const uploadCleanupHours = useStore((s) => s.uploadCleanupHours);
  const voiceNoteTtlHours = useStore((s) => s.voiceNoteTtlHours);
  const autoRenameSessions = useStore((s) => s.autoRenameSessions);
  const alwaysShowUsage = useStore((s) => s.alwaysShowUsage);
  const theme = useStore((s) => s.theme);
  const cto = useStore((s) => s.cto);
  const modelRouting = useStore((s) => s.modelRouting);
  const skillRegistryUrls = useStore((s) => s.skillRegistryUrls);
  const launcherFlags = useStore((s) => s.launcherFlags);
  const updatePrompt = useStore((s) => s.updatePrompt);
  const updateTargets = useStore((s) => s.updateTargets);
  // BET-1160: in-flight/result update state, read from the shared store so
  // Settings and the update banner never disagree. `updatingTargetId` is the
  // single target mid-update (null = none); `targetUpdateErrors[id]` carries a
  // target's last transient error (null = none).
  const updatingTargetId = useStore((s) => s.updatingTargetId);
  const targetUpdateErrors = useStore((s) => s.targetUpdateErrors);
  // BET-1195: the desktop download's live percent, owned in the SHARED store
  // (fed at App level from IPC.autoUpdateProgress) so this row and the banner
  // can never disagree. The old Settings-local copy is what left the banner
  // path and runUpdateAll with no loading state.
  const desktopDownloadPercent = useStore((s) => s.desktopDownloadPercent);
  const setUpdatingTarget = useStore((s) => s.setUpdatingTarget);
  const setTargetUpdateError = useStore((s) => s.setTargetUpdateError);
  // BET-1195: the desktop leg's presentation, decided by the SAME pure shared
  // helper the banner uses, so the row and the banner can never disagree about
  // whether the desktop is downloading (with what percent) or restarting.
  const desktopBusy = desktopUpdateBusy({
    updatingTargetId,
    desktopDownloadPercent,
    desktopRestarting,
  });
  const boxToken = useStore((s) => s.boxToken);
  const serverUrl = useStore((s) => s.serverUrl);
  const push = useStore((s) => s.pushAppToast);
  const applySetting = useApplySetting(push);
  const dialogRef = useDialog(onClose);

  // Active tab + search — declared early so the plugins effect below can read
  // activeTab without a TDZ violation.
  const [activeTab, setActiveTab] = useState<SettingSectionId>(
    initialSection && VOICE_SECTIONS.some((s) => s.id === initialSection) ? initialSection : "general",
  );
  const [query, setQuery] = useState("");
  // A section request that lands while the modal is already open re-targets
  // it, rather than only applying on mount.
  useEffect(() => {
    if (initialSection && VOICE_SECTIONS.some((s) => s.id === initialSection)) setActiveTab(initialSection);
  }, [initialSection]);
  const inSearch = query.trim().length > 0;
  const searchHits = useMemo(() => searchSettings(VOICE_SETTINGS, query, PLATFORM), [query]);

  // Current config values for schema-driven fields, read directly from the
  // store (NO local field state → no stomping bug).
  const values: Record<string, unknown> = useMemo(
    () => ({
      cacheTtl,
      groqApiKey,
      voiceTranscriptionModel,
      openaiApiKey,
      allowAgentPush,
      downloadsDir,
      worktreePerSession,
      worktreeCleanOnClose,
      uploadCleanupHours,
      voiceNoteTtlHours,
      theme,
      autoRenameSessions,
      alwaysShowUsage,
      "cto.enabled": cto?.enabled ?? false,
      "cto.model": cto?.model ?? "",
      "cto.voice": cto?.voice ?? "",
      "cto.alwaysListening": cto?.alwaysListening ?? false,
      "modelRouting.enabled": modelRouting?.enabled ?? false,
      "modelRouting.preset": modelRouting?.preset ?? "balanced",
    }),
    [cacheTtl, groqApiKey, voiceTranscriptionModel, openaiApiKey, allowAgentPush, downloadsDir, worktreePerSession, worktreeCleanOnClose, uploadCleanupHours, voiceNoteTtlHours, theme, autoRenameSessions, alwaysShowUsage, cto, modelRouting],
  );

  const commitKey = async (entry: SettingEntry, nextValue: unknown) => {
    if (entry.configKey == null) return;
    const prev = values[entry.configKey];
    await applySetting(entry, nextValue, prev);
  };

  // Client + server versions for About.
  const [clientVersion, setClientVersion] = useState<string | null>(null);
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      window.api.getClientVersion?.().catch(() => null),
      window.api.getServerVersion?.().catch(() => null),
    ]).then(([client, server]) => {
      if (cancelled) return;
      if (client && typeof client.version === "string") setClientVersion(client.version);
      if (server && typeof server.version === "string") setServerVersion(server.version);
    });
    return () => { cancelled = true; };
  }, []);

  // ===== "Check for updates" (About) =====
  //
  // ONE shared implementation — `refreshUpdateTargets()` (./updateCheck) runs
  // both legs in PARALLEL with a 15s timeout on the server leg (a wedged box
  // must not spin the button forever), builds the canonical UpdateTarget[]
  // with `buildUpdateTargets`, and stores it in the store. The SAME function
  // is what App.tsx's check-on-connect calls, so the Settings button and the
  // on-connect banner can never disagree. `Promise.allSettled` semantics live
  // inside it: a failure of one leg still reports the other.
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  // BET-1160 never-stuck invariant: a fresh Settings open (re)mount resets the
  // transient in-flight update state to idle — no stale spinner, no button left
  // permanently disabled from a previous session. Durable truth (what is
  // available / up to date) comes from `updateTargets`, not from the transient
  // `updatingTargetId` / `targetUpdateErrors`, so discarding them here is safe.
  // The desktop download percent is also cleared here (BET-1195): a re-opened
  // Settings must not present a stale percent for a download that ended.
  useEffect(() => {
    setUpdatingTarget(null);
    useStore.getState().setDesktopDownloadPercent(null);
    const errs = useStore.getState().targetUpdateErrors;
    for (const id of Object.keys(errs)) {
      if (errs[id] != null) setTargetUpdateError(id, null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runUpdateCheck = async () => {
    if (checking) return;
    setChecking(true);
    try {
      await refreshUpdateTargets({ clientVersion, serverVersion });
      setCheckedAt(Date.now());
    } finally {
      setChecking(false);
    }
  };

  // One row per target (BET-1099): the list below maps over the canonical
  // `updateTargets` in its fixed display order, so Settings and the banner
  // always describe the same state. The two bespoke per-leg blocks they
  // replace were deleted in stage 4.
  //
  // The action routes by target id through the shared `isCliTarget`
  // discriminator (BET-1159): desktop delegates to App's single desktop runner
  // (`onDesktopUpdate` — the SAME path the banner uses, so Settings never keeps
  // a second copy of the download/in-flight state; BET-1195); every CLI row
  // delegates to App's per-CLI router (`onCliUpdate`), so a CLI row upgrades
  // JUST that CLI, never the whole box; the server row keeps the box
  // self-update flow (`onRequestServerUpdate`), which App's confirm →
  // applyServerUpdate path owns unchanged. The row's disabled/spinner
  // presentation (busy + updatingTargetId) is BET-1160's `rowUpdateState`,
  // already read from the store — nothing to add here.
  const handleRowUpdate = (t: UpdateTarget) => {
    if (t.id === "desktop") {
      onDesktopUpdate?.();
    } else if (isCliTarget(t)) {
      onCliUpdate?.(t);
    } else {
      onRequestServerUpdate?.();
    }
  };

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
      requestRestart();
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

  // References (custom control — BET-1023). A user-managed list of opencode
  // references (@alias → external dir / git repo) written through the single
  // config-write path via opencodeSetReferences. Read back from GET
  // /api/reference so the list reflects what opencode actually has active.
  const [references, setReferences] = useState<OpencodeReference[]>([]);
  const [refAlias, setRefAlias] = useState("");
  const [refTarget, setRefTarget] = useState("");
  const [refDescription, setRefDescription] = useState("");
  const [refAliasError, setRefAliasError] = useState<string | null>(null);
  const [refTargetError, setRefTargetError] = useState<string | null>(null);
  const refreshReferences = () => {
    window.api.opencodeReferences().then(setReferences).catch(() => {});
  };
  useEffect(() => {
    refreshReferences();
  }, []);
  const onAddReference = async () => {
    const alias = refAlias.trim();
    const aliasErr = validateReferenceAlias(alias);
    setRefAliasError(aliasErr);
    const target = refTarget.trim();
    if (!target) {
      setRefTargetError("Enter a local path or a repository.");
      return;
    }
    setRefTargetError(null);
    if (aliasErr) return;
    const description = refDescription.trim();
    const kind = classifyReferenceTarget(target);
    const upsert = (kind === "repository"
      ? { alias, repository: target, ...(description ? { description } : {}) }
      : { alias, path: target, ...(description ? { description } : {}) });
    try {
      const res = await window.api.opencodeSetReferences({ upsert: [upsert] });
      if (!res.ok) {
        push({ id: `ref-${Date.now()}`, message: `Couldn't add reference: ${res.error ?? "unknown error"}` });
        return;
      }
      setRefAlias(""); setRefTarget(""); setRefDescription(""); setRefAliasError(null); setRefTargetError(null);
      refreshReferences();
      push({ id: `refok-${Date.now()}`, message: "Reference added" });
    } catch (e) {
      push({ id: `err-ref-${Date.now()}`, message: errorDisclosure("Couldn't add reference.", e) });
    }
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
  // The registry list goes through the shared cache (BET-1057).
  const {
    data: plugins,
    loading: pluginsLoading,
    error: pluginsError,
    refresh: refreshPlugins,
  } = useCachedResource<PluginRegistryRow[]>("plugins", () => window.api.pluginsRegistry());
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
      requestRestart();
    } catch (e) {
      setPluginsOn(prev);
      push({ id: `err-plugins-${Date.now()}`, message: errorDisclosure("Couldn't toggle plugins.", e) });
    }
  };
  // Poll the registry while the Extensions tab is open. refresh() never flips
  // loading, so a poll tick can't flash the loader (only the cold first open).
  useEffect(() => {
    if (activeTab !== "extensions") return;
    const timer = setInterval(() => void refreshPlugins(), 10_000);
    return () => clearInterval(timer);
  }, [activeTab, refreshPlugins]);

  // Forge integration (BET-798, mockup [G1]): the connected account + where
  // the token came from + Disconnect, the one global "start agents" toggle
  // (mirrors the plugins toggle — a checkbox, not a switch), and the repos
  // with rules, each showing rule count + validity with invalid ones inline.
  const [forgeRulesOn, setForgeRulesOn] = useState(false);
  const [forgeStatus, setForgeStatus] = useState<ForgeStatusResult | null>(null);
  // The rules list goes through the shared cache (BET-1057). Only the
  // forgeRulesList() call is cached — the enabled flag + connection status
  // stay on a separate plain effect below.
  const {
    data: forgeRules,
    loading: forgeRulesLoading,
    error: forgeRulesError,
    refresh: refreshForgeRules,
  } = useCachedResource<ForgeRuleRow[]>("forgeRules", () => window.api.forgeRulesList());
  // Enabled-flag + connection status: a separate plain effect, refreshed when
  // the Extensions tab is opened (not part of the cached rules list).
  useEffect(() => {
    if (activeTab !== "extensions") return;
    let cancelled = false;
    window.api.configGet().then((c) => { if (!cancelled) setForgeRulesOn(c.forgeRulesEnabled === true); }).catch(() => {});
    window.api.forgeStatus({ validate: true }).then((s) => { if (!cancelled) setForgeStatus(s); }).catch(() => {});
    return () => { cancelled = true; };
  }, [activeTab]);
  // Poll the rules list while the Extensions tab is open. refresh() never
  // flips loading.
  useEffect(() => {
    if (activeTab !== "extensions") return;
    const timer = setInterval(() => void refreshForgeRules(), 10_000);
    return () => clearInterval(timer);
  }, [activeTab, refreshForgeRules]);
  const toggleForgeRules = async (on: boolean) => {
    const prev = forgeRulesOn;
    setForgeRulesOn(on);
    try {
      await window.api.configUpdate({ forgeRulesEnabled: on });
    } catch (e) {
      setForgeRulesOn(prev);
      push({ id: `err-forge-${Date.now()}`, message: errorDisclosure("Couldn't toggle forge rules.", e) });
    }
  };
  const disconnectForge = async () => {
    try {
      const r = await window.api.forgeDisconnect();
      if (r?.ok) setForgeStatus({ connected: false });
      // No Undo action here — Undo was a lie (it only restored local state
      // while the box stayed disconnected). The box now ignores the gh CLI
      // until a successful device sign-in clears the flag (BET-942).
      push({ id: `forge-dc-${Date.now()}`, message: "Disconnected GitHub. Your gh CLI is untouched — Manta will ignore it until you reconnect." });
    } catch (e) {
      push({ id: `err-forge-dc-${Date.now()}`, message: errorDisclosure("Couldn't disconnect GitHub.", e) });
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
      setRemoveResult({ ok: false, message: "Removing a server is only supported in the desktop app." });
      return;
    }
    try {
      const outcome = await preload.authUnpair();
      await useStore.getState().refresh().catch(() => {});
      if (outcome.ok) { setRemoveResult({ ok: true, message: "" }); onClose(); return; }
      setRemoveResult({ ok: false, message: outcome.message || "The server's token could not be revoked remotely. Local credentials were cleared." });
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
    const idx = VOICE_SECTIONS.findIndex((s) => s.id === activeTab);
    const dir = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1;
    const next = VOICE_SECTIONS[(idx + dir + VOICE_SECTIONS.length) % VOICE_SECTIONS.length];
    setActiveTab(next.id);
    railRefs.current[next.id]?.focus();
  };

  const schemaEntries = settingsForSection(SETTINGS, activeTab, PLATFORM);
  const simpleEntries = schemaEntries.filter((e) => e.control !== "custom");

  const renderField = (entry: SettingEntry): ReactNode => {
    if (entry.id === "pluginsEnabled") {
      // Mac-local (configKey null): its value lives in `pluginsOn`, not the
      // generic `values` map, and it renders as a checkbox (its on-screen
      // look for BET-189), not the generic switch.
      return (
        <SettingsRow name={entry.label} help={entry.help}>
          <Checkbox id={fieldId(entry)} checked={pluginsOn} onChange={(v) => void togglePlugins(v)} ariaLabel={entry.label} />
        </SettingsRow>
      );
    }
    const cur = entry.configKey ? values[entry.configKey] : undefined;
    switch (entry.control) {
      case "toggle":
        return <ToggleField entry={entry} value={Boolean(cur)} onApply={(v) => void commitKey(entry, v)} />;
      case "segmented":
        return <SegmentedField entry={entry} value={String(cur ?? "")} onApply={(v) => void commitKey(entry, v)} />;
      case "password":
        return <SettingField credential entry={entry} value={String(cur ?? "")} onCommit={(v) => commitKey(entry, v.trim())} />;
      case "text":
      case "path":
        return <SettingField entry={entry} value={String(cur ?? "")} onCommit={(v) => commitKey(entry, v)} />;
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
            {/* A downloaded desktop update outranks everything below: it is the
                one state where the user's next action is a single click, so it
                stays pinned regardless of whether a check has been run. */}
            {updatePrompt && (
              <div className="rounded-md border border-accent/30 bg-accent/10 px-3 py-2 flex items-center gap-2">
                <span className="flex-1 text-meta text-text">Update ready: <span className="font-medium">{updatePrompt.releaseName || updatePrompt.version}</span></span>
                <button onClick={() => { void window.api.autoUpdateInstall(); }} className={BANNER_BTN}>Restart to update</button>
              </div>
            )}

            <div className="flex items-center gap-3">
              <Button onClick={() => void runUpdateCheck()} disabled={checking} tone="default">
                {checking ? "Checking…" : "Check for updates"}
              </Button>
              {checkedAt != null && !checking && (
                <span className="text-meta text-text-faint">
                  Checked {new Date(checkedAt).toLocaleTimeString()}
                </span>
              )}
            </div>

            {/* One row per update target, in the canonical display order from
                `refreshUpdateTargets` — Manta UI, the box, opencode, then each
                installed CLI. A target the box does NOT have installed produces
                no row at all. */}
            <div className="space-y-2">
              {updateTargets.map((t) => (
                <UpdateTargetRow
                  key={t.id}
                  target={t}
                  desktopBusy={desktopBusy}
                  installReady={Boolean(updatePrompt)}
                  onUpdate={handleRowUpdate}
                  rowState={rowUpdateState(t.id, { updatingTargetId, busy })}
                  error={targetUpdateErrors[t.id] ?? null}
                />
              ))}
            </div>
          </GroupCard>
          <GroupCard title="Danger zone" danger>
            <div className="space-y-3">
              <div className="text-body text-text-faint">Restore every setting below to its default. This does not remove your server pairing or projects.</div>
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
            <div className="space-y-3">
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
                  help="Local port forwarded to the server's opencode serve instance. Defaults to 14096 to avoid colliding with a local opencode on 4096."
                  footer={opencodePortSavedAt ? <div role="status" className="text-meta text-ok">Saved</div> : undefined}
                />
              </div>
            </details>
          </GroupCard>

          <GroupCard title="Danger zone" danger>
            <div className="space-y-3">
              <div className="text-body text-text-faint">Forget this server on the desktop. If the server is reachable, its current token is revoked too.</div>
              <Button onClick={() => setConfirmRemove(true)} disabled={removingBox} tone="default">
                {removingBox ? "Removing…" : "Remove server"}
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
        <GroupCard title="Models">
          <ModelsCard />
        </GroupCard>
      );
    }
    if (section === "extensions") {
      return (
        <>
          <GroupCard>
            {pluginsError ? (
              <div role="alert" className="text-body text-danger">{errorDisclosure("Couldn't load the plugins list.", pluginsError)}</div>
            ) : pluginsLoading ? (
              <div className="py-2">
                <MantaLoader size="inline" label="Loading plugins" />
              </div>
            ) : (plugins ?? []).length === 0 ? (
              <div className="text-body text-text-faint">No plugins installed yet. The AI can author them with <code className="text-text-muted">plugin.write</code> when this toggle is on.</div>
            ) : (
              <div className="space-y-2">
                {(plugins ?? []).map((p) => (
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
          <GroupCard title="Forge">
            {/* Connected account row: presence dot · GitHub · where the token
                came from · Disconnect. Naming the token's provenance is the
                point — "from the gh CLI on your box" reads as a courtesy, not
                surveillance. */}
            {forgeStatus === null ? (
              <ListRow
                leading={<StatusDot tone="idle" />}
                name="GitHub"
                secondary="Checking…"
              />
            ) : forgeStatus.connected ? (
              <ListRow
                leading={<StatusDot tone={forgeStatus.valid === false ? "warn" : "ok"} />}
                name="GitHub"
                secondary={forgeCredentialSecondary(forgeStatus)}
                trailing={<button onClick={() => void disconnectForge()} className="text-label px-3 py-1 rounded-full border border-border text-text-muted hover:text-text">Disconnect</button>}
              />
            ) : (
              <ListRow
                leading={<StatusDot tone="idle" />}
                name="GitHub"
                secondary="Not connected."
              />
            )}
            {/* Divider — the mockup's border-top between connection and rules. */}
            <div className="border-t border-border-subtle my-3" />
            {/* The one global toggle, mirroring the plugins toggle (a checkbox,
                not a switch). Gates dispatch, not the visibility of the list
                below. */}
            <div className="flex items-center gap-2 py-1">
              <Checkbox id="forge-rules-enabled" checked={forgeRulesOn} onChange={(v) => void toggleForgeRules(v)} ariaLabel="Let forge rules start agents on this server" />
              <span className="text-body text-text-muted">Let forge rules start agents on this server</span>
            </div>
            {forgeRulesError ? (
              <div role="alert" className="text-body text-danger">{errorDisclosure("Couldn't load the forge rules list.", forgeRulesError)}</div>
            ) : forgeRulesLoading ? (
              <div className="py-2">
                <MantaLoader size="inline" label="Loading forge rules" />
              </div>
            ) : (forgeRules ?? []).length === 0 ? (
              <div className="text-body text-text-faint">No forge rules yet. The AI authors them on the server with <code className="text-text-muted">forge_rules.save</code>; each is a YAML file at <code className="text-text-muted">~/.manta/forge-rules/</code>.</div>
            ) : (
              <div className="space-y-1">
                {(forgeRules ?? []).map((r) =>
                  r.valid ? (
                    <ListRow
                      key={r.repoKey}
                      leading={<StatusDot tone="ok" />}
                      name={r.repoKey}
                      secondary={`${r.ruleCount ?? 0} rule${r.ruleCount === 1 ? "" : "s"}`}
                      trailing="valid"
                    />
                  ) : (
                    // Invalid rule sets are listed with their error, verbatim
                    // and un-truncated, in danger. A rules file that silently
                    // fails to load is worse than one that loudly refuses.
                    <div key={r.repoKey} className="flex items-center gap-2 py-2 hover:bg-fill rounded-md text-[13px]">
                      <StatusDot tone="error" />
                      <span className="text-text font-medium truncate min-w-0">{r.repoKey}</span>
                      <span className="text-text-faint min-w-0 text-danger break-all">{r.error}</span>
                    </div>
                  ),
                )}
              </div>
            )}
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
          <GroupCard title="References">
            <div className="text-body text-text-faint">Add an external directory or git repository as an opencode reference. Type <code className="text-text-muted">@alias</code> in the chat to attach it, or <code className="text-text-muted">@alias/…</code> to search inside it. Agents can read a reference's files without a permission prompt. Removing a reference isn't available yet.</div>
            <div className="space-y-2">
              {references.length === 0 ? (
                <div className="text-body text-text-faint">No references configured.</div>
              ) : (
                references.map((r) => (
                  <div key={r.name} className="flex items-center gap-2">
                    <code className="flex-1 text-body bg-bg-soft border border-border rounded-xs px-3 py-2 text-text-muted truncate">
                      @{r.name} → {r.path ?? (r.repository ? `${r.repository}${r.branch ? ` (${r.branch})` : ""}` : "")}
                    </code>
                    {r.description && <span className="text-meta text-text-faint truncate max-w-[40%]">{r.description}</span>}
                  </div>
                ))
              )}
            </div>
            <div className="flex gap-2">
              <div className="flex-1">
                <Field placeholder="alias" value={refAlias} onChange={(e) => { setRefAlias(e.target.value); setRefAliasError(null); }} onKeyDown={(e) => e.key === "Enter" && void onAddReference()} />
                {refAliasError && <div role="alert" className="text-meta text-danger">{refAliasError}</div>}
              </div>
              <div className="flex-[2]">
                <Field placeholder="path or repository — e.g. ../docs or owner/repo" value={refTarget} onChange={(e) => { setRefTarget(e.target.value); setRefTargetError(null); }} onKeyDown={(e) => e.key === "Enter" && void onAddReference()} />
                {refTargetError && <div role="alert" className="text-meta text-danger">{refTargetError}</div>}
              </div>
            </div>
            <div className="flex gap-2">
              <div className="flex-1">
                <Field placeholder="optional description" value={refDescription} onChange={(e) => setRefDescription(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void onAddReference()} />
              </div>
              <Button onClick={() => void onAddReference()} disabled={!refAlias.trim() || !refTarget.trim()} tone="default">Add</Button>
            </div>
          </GroupCard>
          {availableLaunchers.some((l) => l.flags.length > 0) && (
            <GroupCard title="CLI launch options">
              <div className="text-body text-text-faint">Flags used when launching an AI CLI (e.g. Claude Code) directly in a session's terminal. Only CLIs detected on this server are shown.</div>
              <div className="space-y-4">
                {availableLaunchers.filter((l) => l.flags.length > 0).map((l) => (
                  <div key={l.id} className="space-y-2">
                    <div className="text-body font-medium text-text">{l.label}</div>
                    {l.flags.map((f) => (
                      <SettingsRow key={f.key} name={f.label}>
                        <Checkbox checked={resolveLauncherFlags(l.flags, launcherFlagValues[l.id])[f.key]} onChange={(v) => setLauncherFlag(l.id, f.key, v)} ariaLabel={f.label} />
                      </SettingsRow>
                    ))}
                  </div>
                ))}
              </div>
            </GroupCard>
          )}
        </>
      );
    }
    if (section === "cto") {
      return (
        <>
          {!cto?.enabled && (
            <GroupCard title="First call">
              <div className="text-body text-text">
                Set up the on-call CTO: toggle <strong>On-call CTO enabled</strong> above, pick its model + voice so it can answer, then add tools to <strong>Trusted actions</strong> to let it run them without asking for a go-ahead. Untrusted tools pause and ask you first during a call.
              </div>
            </GroupCard>
          )}
          <GroupCard title="Trusted actions (allowlist)">
            <div className="text-body text-text-faint">
              Tool names the CTO may run without pausing for your spoken go-ahead. One per line. Empty = ask before every gated tool.
            </div>
            <textarea
              id="cto-trusted-actions"
              rows={6}
              spellCheck={false}
              className="w-full border border-border rounded-xs bg-bg-soft px-3 py-2 text-body text-text font-mono mt-2"
              placeholder={"e.g.\nlist_sessions\nlist_projects"}
              defaultValue={((cto?.trustedActions) ?? []).join("\n")}
              onBlur={(e) => {
                const ids = e.target.value
                  .split(/\n|,/)
                  .map((s) => s.trim())
                  .filter(Boolean);
                useStore.setState({ cto: { ...(cto ?? {}), trustedActions: ids } });
                void window.api
                  .configUpdate({ "cto.trustedActions": ids } as Partial<AppConfig>)
                  .catch(() => {});
              }}
            />
          </GroupCard>
        </>
      );
    }
    return null;
  };

  // Assemble the active section's panels as --card groups, driven entirely by
  // the schema (BET-1174): consecutive non-custom entries sharing a `group`
  // render as one GroupCard titled by that group, then the section's custom
  // content (About/danger-zone, Box, Accounts, plugin registry, ...) renders
  // after — grouped cards first, custom after.
  const renderSection = (section: SettingSectionId): ReactNode => {
    if (section === "cto" && !voiceUi) return null; // BET-1191: hidden unless the build flag is on
    const grouped: { title: string; entries: SettingEntry[] }[] = [];
    for (const e of simpleEntries) {
      const tail = grouped[grouped.length - 1];
      if (e.group && tail && tail.title === e.group) tail.entries.push(e);
      else grouped.push({ title: e.group ?? "", entries: [e] });
    }
    return (
      <>
        {grouped.map((g) => (
          <GroupCard key={g.title} title={g.title}>
            {g.entries.map((entry) => (
              <div key={entry.id}>{renderField(entry)}</div>
            ))}
          </GroupCard>
        ))}
        {renderCustom(section)}
      </>
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
          {VOICE_SECTIONS.map((tab, i) => {
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
        <div className="titlebar-drag h-10 shrink-0" />
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
      <ConfirmModal
        open={confirmRemove}
        title="Remove this server?"
        body="The desktop will forget its pairing and saved projects. If the server is reachable, its current token is also revoked. If the server is offline, the local credentials are cleared and the server's token will be rotated the next time it starts."
        confirmLabel="Remove"
        onConfirm={() => void removeBox()}
        onCancel={() => setConfirmRemove(false)}
      />

      {/* In-app confirm: Reset all settings (BET-419 §B.3). */}
      <ConfirmModal
        open={confirmReset}
        title="Reset all settings?"
        body="Every setting will return to its default. Your server pairing and projects are not affected. You can undo this right after."
        confirmLabel="Reset"
        onConfirm={() => void resetAll()}
        onCancel={() => setConfirmReset(false)}
      />
    </div>
  );
}
