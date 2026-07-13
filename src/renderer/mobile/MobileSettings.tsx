import { useEffect, useState } from "react";
import { useStore } from "../store";
import { ProvidersCard } from "../ProvidersCard";
import { resolveLauncherFlags } from "../chatShared";
import type { AvailableLauncher, OpencodeModel } from "../../shared/types";
import {
  isPushSupported,
  pushPermission,
  hasActiveSubscription,
  enablePush,
  disablePush,
  resubscribePush,
} from "./push";

type Props = { onClose: () => void };

// Mobile-friendly settings — single scrollable column, no modal overlay
// (overlays + iOS keyboard interact badly: focusing an input shrinks the
// visual viewport and the modal's vertical-center anchor pushes the form
// half off-screen). The whole screen IS the modal; a "Done" button in the
// header pops back to wherever the user came from.
//
// Surface area is the subset of desktop Settings that makes sense on a
// device with no SSH layer:
//   - Server URL (localStorage["bui_server"]) — how the mobile/web client
//     finds the box; this is the single most important setting.
//   - Trust mode (chatAutoAllow) — bypasses permission prompts.
//   - Default model — global default for new sessions and /clear.
//   - Cache TTL — display-only knob for the "/clear to save Nk tokens" pill.
//   - Skill registries — extra opencode skill registry URLs.
//
// Deliberately omitted on mobile:
//   - SSH host/user/identity (mobile server has no SSH hop)
//   - Transport selector (mobile is always direct)
//   - Tmux config setup (UI is bui-managed only when the user opts in;
//     deferred for now — not a UX gap in practice)
//   - Setup wizard (rpc.mjs returns stub n/a responses; no UI value)
//   - Upload cleanup hours (server-side default works)
export function MobileSettings({ onClose }: Props) {
  const {
    chatAutoAllow,
    autoRenameSessions,
    defaultModel,
    skillRegistryUrls,
    cacheTtl,
    groqApiKey,
    voiceTranscriptionModel,
    voiceCommandModel,
    launcherFlags,
    refresh,
  } = useStore();

  // The browser-served URL the client points at. localStorage["bui_server"]
  // is the override knob from httpApi.ts; empty string means "use page
  // origin", which works when the client is served from the same host as
  // the API (the named Cloudflare tunnel deployment). Show the current
  // resolved value as placeholder so users know what's in effect.
  const [serverUrl, setServerUrl] = useState(
    () => localStorage.getItem("bui_server") ?? "",
  );
  const [trust, setTrust] = useState(chatAutoAllow);
  const [autoRename, setAutoRename] = useState(autoRenameSessions);
  const [selectedModel, setSelectedModel] = useState<{
    providerID: string;
    modelID: string;
  } | null>(defaultModel ?? null);
  const [ttl, setTtl] = useState<"5m" | "1h">(cacheTtl);
  const [registryUrls, setRegistryUrls] = useState<string[]>(
    skillRegistryUrls ?? [],
  );
  const [newRegistryUrl, setNewRegistryUrl] = useState("");
  const [models, setModels] = useState<OpencodeModel[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedToast, setSavedToast] = useState(false);
  // Voice / Groq. Empty key hides the mic in the composer.
  const [groqKey, setGroqKey] = useState(groqApiKey);
  const [voiceTrModel, setVoiceTrModel] = useState(voiceTranscriptionModel);
  const [voiceCmdModel, setVoiceCmdModel] = useState(voiceCommandModel);
  // AI CLI TUI launch options (BET-138 refinement) — mirrors desktop Settings.
  const [availableLaunchers, setAvailableLaunchers] = useState<AvailableLauncher[]>([]);
  const [launcherFlagValues, setLauncherFlagValues] =
    useState<Record<string, Record<string, boolean>>>(launcherFlags ?? {});

  // Push notifications — not server config (it's a per-device subscription),
  // so it lives outside the Save flow. `pushOn` reflects an actual live
  // subscription; `pushBusy` guards the async enable/disable.
  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushErr, setPushErr] = useState<string | null>(null);
  useEffect(() => {
    hasActiveSubscription().then(setPushOn).catch(() => setPushOn(false));
  }, []);
  const togglePush = async () => {
    setPushErr(null);
    setPushBusy(true);
    try {
      if (pushOn) {
        await disablePush();
        setPushOn(false);
      } else {
        const state = await enablePush();
        if (state === "granted") setPushOn(true);
        else if (state === "denied")
          setPushErr(
            "Notifications are blocked. Enable them for this site in iOS Settings.",
          );
        else if (state === "unsupported")
          setPushErr(
            "Push needs the app installed to your home screen (iOS 16.4+).",
          );
        else setPushErr("Permission not granted.");
      }
    } catch (e) {
      setPushErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPushBusy(false);
    }
  };

  // Self-heal a stale/ghost subscription: iOS can silently invalidate the
  // device-side subscription (post-update / PWA offload) while Apple keeps
  // 201-ing the dead endpoint, so it can't be auto-detected and a plain enable
  // re-uploads the same dead endpoint. Force a fresh subscribe in one tap.
  const resubscribe = async () => {
    setPushErr(null);
    setPushBusy(true);
    try {
      const state = await resubscribePush();
      if (state === "granted") setPushOn(true);
      else if (state === "denied")
        setPushErr(
          "Notifications are blocked. Enable them for this site in iOS Settings.",
        );
      else if (state === "unsupported")
        setPushErr("Push needs the app installed to your home screen (iOS 16.4+).");
      else setPushErr("Permission not granted.");
    } catch (e) {
      setPushErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPushBusy(false);
    }
  };

  // Sync local state if store updates while screen is open (rare —
  // shouldn't happen during a single-screen edit, but matches the
  // desktop Settings pattern).
  useEffect(() => {
    setTrust(chatAutoAllow);
    setAutoRename(autoRenameSessions);
    setSelectedModel(defaultModel ?? null);
    setTtl(cacheTtl);
    setRegistryUrls(skillRegistryUrls ?? []);
    setGroqKey(groqApiKey);
    setVoiceTrModel(voiceTranscriptionModel);
    setVoiceCmdModel(voiceCommandModel);
    setLauncherFlagValues(launcherFlags ?? {});
  }, [chatAutoAllow, autoRenameSessions, defaultModel, cacheTtl, skillRegistryUrls, groqApiKey, voiceTranscriptionModel, voiceCommandModel, launcherFlags]);

  // Model list is best-effort — opencode unreachable just means the
  // picker shows only "opencode default". Same as desktop Settings.
  useEffect(() => {
    window.api
      .opencodeModels()
      .then((list) => setModels(list))
      .catch(() => {});
  }, []);

  // Which AI CLI TUIs are set up on this box — non-fatal, an empty list just
  // hides the launch-options section below.
  useEffect(() => {
    window.api
      .launchersList()
      .then((list) => setAvailableLaunchers(list))
      .catch(() => {});
  }, []);

  const setLauncherFlag = (launcherId: string, flagKey: string, checked: boolean) => {
    const l = availableLaunchers.find((x) => x.id === launcherId);
    if (!l) return;
    setLauncherFlagValues((prev) => ({
      ...prev,
      [launcherId]: { ...resolveLauncherFlags(l.flags, prev[launcherId]), [flagKey]: checked },
    }));
  };

  const save = async () => {
    setSaving(true);
    try {
      // Server URL is a localStorage knob, NOT a server-persisted config
      // field — it tells the BROWSER which server to talk to, which by
      // definition can't be stored on that server. Apply it before the
      // configUpdate so a server-URL change takes effect immediately for
      // the rpc call below (httpApi.ts reads localStorage on every rpc).
      const trimmed = serverUrl.trim();
      if (trimmed) localStorage.setItem("bui_server", trimmed);
      else localStorage.removeItem("bui_server");

      await window.api.configUpdate({
        chatAutoAllow: trust,
        autoRenameSessions: autoRename,
        defaultModel: selectedModel ?? undefined,
        skillRegistryUrls: registryUrls,
        cacheTtl: ttl,
        groqApiKey: groqKey.trim(),
        voiceTranscriptionModel: voiceTrModel.trim(),
        voiceCommandModel: voiceCmdModel.trim(),
        launcherFlags: launcherFlagValues,
      });
      await refresh();
      setSavedToast(true);
      // Auto-dismiss the saved toast after a beat; the user can still
      // navigate away during it.
      setTimeout(() => setSavedToast(false), 1200);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const addRegistryUrl = () => {
    const url = newRegistryUrl.trim();
    if (!url || registryUrls.includes(url)) return;
    setRegistryUrls([...registryUrls, url]);
    setNewRegistryUrl("");
  };
  const removeRegistryUrl = (url: string) => {
    setRegistryUrls(registryUrls.filter((u) => u !== url));
  };

  return (
    <div className="mobile-screen">
      <div className="mobile-header">
        <button
          className="mobile-tap text-accent text-2xl leading-none"
          onClick={onClose}
          aria-label="Back"
        >
          ‹
        </button>
        <div className="flex-1 text-text font-bold text-base">Settings</div>
        <button
          className="mobile-tap text-accent text-sm font-semibold px-2"
          onClick={save}
          disabled={saving}
        >
          {saving ? "…" : "Save"}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-5">
        {/* Server URL — the most important field for a fresh install. */}
        <section className="space-y-2">
          <label className="block text-[11px] uppercase tracking-wider text-text-muted">
            Server URL
          </label>
          <input
            placeholder={window.location.origin}
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            inputMode="url"
            className="w-full bg-bg-soft border border-border px-3 py-2 text-sm rounded focus:outline-none focus:border-accent"
          />
          <div className="text-xs text-text-faint">
            Leave blank to use the page's own origin (default). Override only
            if your bui server is on a different host (e.g.{" "}
            <code className="text-text-muted">https://bui.example.com</code>).
            Changes take effect after Save.
          </div>
        </section>

        {/* Trust mode — high-impact toggle, keep it near the top. */}
        <section className="space-y-2">
          <label className="flex items-center justify-between gap-3">
            <span className="block text-[11px] uppercase tracking-wider text-text-muted">
              Auto-allow tool permissions
            </span>
            <input
              type="checkbox"
              checked={trust}
              onChange={(e) => setTrust(e.target.checked)}
              className="w-5 h-5 accent-accent"
            />
          </label>
          <div className="text-xs text-text-faint">
            Auto-reply "always" to every permission request — equivalent to
            opencode's <code className="text-text-muted">--dangerously-skip-permissions</code>.
            Question tool requests still require an explicit answer.
          </div>
        </section>

        {/* Auto-rename sessions. */}
        <section className="space-y-2 pt-1 border-t border-border">
          <label className="flex items-center justify-between gap-3">
            <span className="block text-[11px] uppercase tracking-wider text-text-muted">
              Auto-rename sessions
            </span>
            <input
              type="checkbox"
              checked={autoRename}
              onChange={(e) => setAutoRename(e.target.checked)}
              className="w-5 h-5 accent-accent"
            />
          </label>
          <div className="text-xs text-text-faint">
            Every few turns, ask the model for a 1-2 word title and rename the
            chat window to match the current work. Overwrites the window name,
            including names you set by hand.
          </div>
        </section>

        {/* Default model. */}
        <section className="space-y-2 pt-1 border-t border-border">
          <label className="block text-[11px] uppercase tracking-wider text-text-muted">
            Default model
          </label>
          <select
            value={
              selectedModel
                ? `${selectedModel.providerID}::${selectedModel.modelID}`
                : ""
            }
            onChange={(e) => {
              const val = e.target.value;
              if (!val) setSelectedModel(null);
              else {
                const [providerID, modelID] = val.split("::");
                setSelectedModel({ providerID, modelID });
              }
            }}
            className="w-full bg-bg-soft border border-border px-3 py-2 text-sm rounded focus:outline-none focus:border-accent"
          >
            <option value="">opencode default</option>
            {models &&
              models.map((m) => (
                <option
                  key={`${m.providerID}::${m.id}`}
                  value={`${m.providerID}::${m.id}`}
                >
                  {m.name} ({m.providerID})
                </option>
              ))}
          </select>
          <div className="text-xs text-text-faint">
            Used for every new and cleared session. Can be overridden
            per-session in the chat composer.
          </div>
        </section>

        <ProvidersCard />

        {/* AI CLI launch options (BET-138 refinement) — mirrors desktop
            Settings' AI tab section. Only CLIs detected on this box are
            shown; an empty list renders nothing. */}
        {availableLaunchers.some((l) => l.flags.length > 0) && (
          <section className="space-y-3 pt-1 border-t border-border">
            <label className="block text-[11px] uppercase tracking-wider text-text-muted">
              AI CLI launch options
            </label>
            <div className="text-xs text-text-faint">
              Flags used when launching an AI CLI (e.g. Claude Code) directly in a
              session's terminal. Only CLIs detected on this box are shown.
            </div>
            {availableLaunchers
              .filter((l) => l.flags.length > 0)
              .map((l) => (
                <div key={l.id} className="space-y-2">
                  <div className="text-sm font-medium text-text">{l.label}</div>
                  {l.flags.map((f) => (
                    <label
                      key={f.key}
                      className="flex items-center justify-between gap-3"
                    >
                      <span className="text-sm text-text">{f.label}</span>
                      <input
                        type="checkbox"
                        checked={resolveLauncherFlags(l.flags, launcherFlagValues[l.id])[f.key]}
                        onChange={(e) => setLauncherFlag(l.id, f.key, e.target.checked)}
                        className="w-5 h-5 accent-accent"
                      />
                    </label>
                  ))}
                </div>
              ))}
          </section>
        )}

        {/* Cache TTL — two buttons, not a select, to match desktop affordance. */}
        <section className="space-y-2 pt-1 border-t border-border">
          <label className="block text-[11px] uppercase tracking-wider text-text-muted">
            Prompt cache TTL
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setTtl("5m")}
              className={`flex-1 px-3 py-2 text-sm rounded border ${
                ttl === "5m"
                  ? "bg-accent text-bg border-accent"
                  : "bg-bg-soft text-text-muted border-border"
              }`}
            >
              5 minutes
            </button>
            <button
              type="button"
              onClick={() => setTtl("1h")}
              className={`flex-1 px-3 py-2 text-sm rounded border ${
                ttl === "1h"
                  ? "bg-accent text-bg border-accent"
                  : "bg-bg-soft text-text-muted border-border"
              }`}
            >
              1 hour
            </button>
          </div>
          <div className="text-xs text-text-faint">
            Must match opencode's <code className="text-text-muted">cache_control.ttl</code> —
            bui only uses this to predict when a chat has gone stale (drives
            the "/clear to save Nk tokens" pill).
          </div>
        </section>

        {/* Voice / Groq STT. Empty key disables the mic button. */}
        <section className="space-y-2 pt-1 border-t border-border">
          <label className="block text-[11px] uppercase tracking-wider text-text-muted">
            Voice (Groq)
          </label>
          <div className="text-xs text-text-faint">
            Adds a push-to-talk mic to the composer. Tap = dictate. Long-press
            (≥500ms) = command mode (say "clear", "compact", "use opus",
            "answer two", …). Get a key at{" "}
            <a
              href="https://console.groq.com/keys"
              target="_blank"
              rel="noreferrer"
              className="text-accent"
            >
              console.groq.com/keys
            </a>
            .
          </div>
          <input
            type="password"
            placeholder="gsk_… (leave blank to disable)"
            value={groqKey}
            onChange={(e) => setGroqKey(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            className="w-full bg-bg-soft border border-border px-3 py-2 text-sm rounded focus:outline-none focus:border-accent font-mono"
          />
          <div className="space-y-1">
            <label className="block text-[10px] uppercase tracking-wider text-text-faint">
              Transcription model
            </label>
            <input
              placeholder="whisper-large-v3-turbo"
              value={voiceTrModel}
              onChange={(e) => setVoiceTrModel(e.target.value)}
              spellCheck={false}
              autoCapitalize="off"
              className="w-full bg-bg-soft border border-border px-2 py-1.5 text-xs rounded focus:outline-none focus:border-accent font-mono"
            />
          </div>
          <div className="space-y-1">
            <label className="block text-[10px] uppercase tracking-wider text-text-faint">
              Command classifier model
            </label>
            <input
              placeholder="llama-3.1-8b-instant"
              value={voiceCmdModel}
              onChange={(e) => setVoiceCmdModel(e.target.value)}
              spellCheck={false}
              autoCapitalize="off"
              className="w-full bg-bg-soft border border-border px-2 py-1.5 text-xs rounded focus:outline-none focus:border-accent font-mono"
            />
          </div>
        </section>

        {/* Push notifications — per-device subscription, not server config, so
            it toggles immediately (outside the Save flow). */}
        {isPushSupported() && (
          <section className="space-y-2 pt-1 border-t border-border">
            <label className="block text-[11px] uppercase tracking-wider text-text-muted">
              Notifications
            </label>
            <div className="text-xs text-text-faint">
              Push alerts when Claude needs a permission/question, finishes a
              turn (only when you're not watching it), or hits an error.
              {pushPermission() === "default" &&
                " iOS only delivers these to the app installed on your home screen."}
            </div>
            <button
              onClick={togglePush}
              disabled={pushBusy}
              className={`w-full px-3 py-2 text-sm rounded border ${
                pushOn
                  ? "bg-accent-soft text-white border-accent"
                  : "bg-bg-soft text-text-muted border-border"
              } ${pushBusy ? "opacity-60" : ""}`}
            >
              {pushBusy
                ? "Working…"
                : pushOn
                  ? "Notifications on — tap to disable"
                  : "Enable notifications"}
            </button>
            {pushOn && (
              <button
                onClick={resubscribe}
                disabled={pushBusy}
                className={`w-full px-3 py-1.5 text-xs rounded border border-border bg-bg-soft text-text-muted ${
                  pushBusy ? "opacity-60" : ""
                }`}
              >
                Not getting notifications? Re-subscribe
              </button>
            )}
            {pushErr && <div className="text-xs text-red-400">{pushErr}</div>}
          </section>
        )}

        {/* Skill registries — add/remove with row buttons. */}
        <section className="space-y-2 pt-1 border-t border-border">
          <label className="block text-[11px] uppercase tracking-wider text-text-muted">
            Skill registries
          </label>
          <div className="text-xs text-text-faint">
            Extra opencode skill registry URLs. The default bui registry is
            always included.
          </div>
          <div className="space-y-1">
            {registryUrls.map((url) => (
              <div
                key={url}
                className="flex items-center gap-2 bg-bg-soft border border-border rounded px-2 py-1.5"
              >
                <code className="flex-1 min-w-0 text-xs text-text-muted truncate">
                  {url}
                </code>
                <button
                  onClick={() => removeRegistryUrl(url)}
                  className="mobile-tap text-text-faint hover:text-text px-1 -my-2"
                  aria-label={`Remove ${url}`}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              placeholder="https://example.com/skills"
              value={newRegistryUrl}
              onChange={(e) => setNewRegistryUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addRegistryUrl()}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              inputMode="url"
              className="flex-1 min-w-0 bg-bg-soft border border-border px-3 py-2 text-sm rounded focus:outline-none focus:border-accent"
            />
            <button
              onClick={addRegistryUrl}
              disabled={!newRegistryUrl.trim()}
              className="px-3 py-2 text-sm bg-accent text-bg rounded disabled:opacity-40"
            >
              Add
            </button>
          </div>
        </section>

        {savedToast && (
          <div className="text-center text-xs text-green-400">Saved</div>
        )}
      </div>
    </div>
  );
}
