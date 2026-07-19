import { useEffect, useState } from "react";
import { useStore } from "./store";
import { ProvidersCard } from "./ProvidersCard";
import { SubagentsCard } from "./SubagentsCard";
import { PairingQR, PairingCountdown } from "./PairingQR";
import { getBuiPreload } from "./preloadAccess";
import { describeModel } from "../shared/modelGuide.mjs";
import { resolveLauncherFlags } from "./chatShared";
import type {
  AuthPairResult,
  AvailableLauncher,
  OpencodeModel,
} from "../shared/types";

const TABS = [
  { id: "connection", label: "Connection" },
  { id: "ai", label: "AI" },
  { id: "voice", label: "Voice" },
  { id: "files", label: "Files" },
  { id: "general", label: "General" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export function Settings({ onClose }: { onClose: () => void }) {
  const {
    allowAgentPush,
    autoRenameSessions,
    downloadsDir,
    defaultModel,
    skillRegistryUrls,
    cacheTtl,
    groqApiKey,
    voiceTranscriptionModel,
    voiceCommandModel,
    launcherFlags,
    refresh,
  } = useStore();

  // AI fields (AI tab)
  const [models, setModels] = useState<OpencodeModel[] | null>(null);
  const [selectedModel, setSelectedModel] = useState<{ providerID: string; modelID: string } | null>(
    defaultModel ?? null,
  );
  const [registryUrls, setRegistryUrls] = useState<string[]>(skillRegistryUrls ?? []);
  const [newRegistryUrl, setNewRegistryUrl] = useState("");
  const [ttl, setTtl] = useState<"5m" | "1h">(cacheTtl);
  const [modelSearchQuery, setModelSearchQuery] = useState("");
  // AI CLI TUI launch options (BET-138 refinement) — flags for launchers
  // detected on this box (e.g. Claude Code's --dangerously-skip-permissions).
  const [availableLaunchers, setAvailableLaunchers] = useState<AvailableLauncher[]>([]);
  const [launcherFlagValues, setLauncherFlagValues] =
    useState<Record<string, Record<string, boolean>>>(launcherFlags ?? {});

  // Files fields (Files tab)
  const [agentPush, setAgentPush] = useState(allowAgentPush);
  const [dlDir, setDlDir] = useState(downloadsDir);

  // General fields (General tab)
  const [autoRename, setAutoRename] = useState(autoRenameSessions);

  // Voice fields (Voice tab)
  const [groqKey, setGroqKey] = useState(groqApiKey);
  const [voiceTrModel, setVoiceTrModel] = useState(voiceTranscriptionModel);
  const [voiceCmdModel, setVoiceCmdModel] = useState(voiceCommandModel);
  // Mobile pairing — one-time code minted on demand. The QR encodes the
  // CANONICAL box-form `manta://pair?box=<boxId>&code=<6-digit>` payload
  // (BET-177 §2.4 — the old `?id=&token=` form was a parsePairPayload
  // rejector; the mobile deep-link handler now matches the same canonical
  // form produced by buildPairPayload). `pairing` is null until the user
  // clicks "Generate code". `pairingExpiry` is a Date parsed from the
  // server's expiresAt ISO string, used to compute the remaining seconds
  // for the countdown UI.
  const [pairing, setPairing] = useState<AuthPairResult | null>(null);
  const [pairingExpiry, setPairingExpiry] = useState<Date | null>(null);
  const [pairingMinting, setPairingMinting] = useState(false);

  // Active tab
  const [activeTab, setActiveTab] = useState<TabId>("connection");

  // Sync local state when store values change
  useEffect(() => {
    setSelectedModel(defaultModel ?? null);
    setRegistryUrls(skillRegistryUrls ?? []);
    setTtl(cacheTtl);
    setAgentPush(allowAgentPush);
    setDlDir(downloadsDir);
    setAutoRename(autoRenameSessions);
    setGroqKey(groqApiKey);
    setVoiceTrModel(voiceTranscriptionModel);
    setVoiceCmdModel(voiceCommandModel);
    setLauncherFlagValues(launcherFlags ?? {});
  }, [defaultModel, skillRegistryUrls, cacheTtl, allowAgentPush, autoRenameSessions, downloadsDir, groqApiKey, voiceTranscriptionModel, voiceCommandModel, launcherFlags]);

  // Fetch available models once (non-fatal — Settings works even if opencode is unreachable).
  useEffect(() => {
    window.api
      .opencodeModels()
      .then((list) => setModels(list))
      .catch(() => {});
  }, []);

  // Fetch which AI CLI TUIs are set up on this box (non-fatal — an empty list
  // just hides the launch-options section).
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

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await window.api.configUpdate({
        allowAgentPush: agentPush,
        autoRenameSessions: autoRename,
        downloadsDir: dlDir.trim(),
        defaultModel: selectedModel ?? undefined,
        skillRegistryUrls: registryUrls,
        cacheTtl: ttl,
        groqApiKey: groqKey.trim(),
        voiceTranscriptionModel: voiceTrModel.trim(),
        voiceCommandModel: voiceCmdModel.trim(),
        launcherFlags: launcherFlagValues,
      });
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
      setSaving(false);
      return;
    }
    try {
      await refresh();
    } catch {
      /* non-fatal — the save already persisted */
    }
    setSaving(false);
    onClose();
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

  // Mint a one-time pairing code for mobile device pairing. The code is valid
  // for ~5 minutes (server-enforced); the UI shows a countdown. A new code
  // supersedes any prior code (the server invalidates the old one).
  const mintPairingCode = async () => {
    setPairingMinting(true);
    try {
      const result = await window.api.authPair();
      setPairing(result);
      if (result.ok) {
        const expiresAt = new Date(result.expiresAt);
        setPairingExpiry(expiresAt);
      }
    } catch (e) {
      // Should not happen — authPair returns { ok:false, error } for failures.
      // But guard against IPC layer crashes.
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setPairingMinting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-bg z-50 flex">
      {/* Left sidebar navigation */}
      <div className="w-48 bg-bg-soft border-r border-border flex flex-col shrink-0">
        <div className="p-4 border-b border-border">
          <h2 className="text-lg font-semibold">Settings</h2>
        </div>
        <nav className="flex-1 py-2">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`w-full text-left px-4 py-2 text-sm transition-colors ${
                activeTab === tab.id
                  ? "bg-accent/10 text-accent border-r-2 border-accent"
                  : "text-text-muted hover:text-text hover:bg-bg-elev"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
        <div className="p-3 border-t border-border">
          <button
            onClick={onClose}
            className="w-full text-left text-xs text-text-muted hover:text-text px-2 py-1 rounded hover:bg-bg-elev transition-colors"
          >
            Close
          </button>
        </div>
      </div>

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header with close button */}
        <div className="flex items-center justify-end p-4 border-b border-border">
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text text-sm px-3 py-1.5 rounded hover:bg-bg-elev transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* Connection Tab */}
          {activeTab === "connection" && (
            <div className="max-w-2xl space-y-6">
              {/* Mobile pairing (BET-80): generate a QR code the mobile app can scan
                  to auto-connect. The QR encodes the canonical box-form
                  `manta://pair?box=<boxId>&code=<code>` (BET-177 §2.4 — the old
                  `?id=&token=` form was a parsePairPayload rejector). The code
                  is one-time, valid for ~5 minutes. A new code supersedes any
                  prior code. */}
              <div>
                <h3 className="text-base font-semibold mb-4">Pair phone</h3>
                <div className="text-sm text-text-faint mb-4">
                  Scan this QR with the BUI mobile app to connect it to your box. The
                  code is one-time and valid for ~5 minutes. Generate a new code if the
                  old one expires.
                </div>
                {!pairing ? (
                  <button
                    onClick={mintPairingCode}
                    disabled={pairingMinting}
                    className="text-sm px-4 py-2 rounded bg-bg-soft border border-border text-text-muted hover:text-text disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {pairingMinting ? "Generating…" : "Generate pairing code"}
                  </button>
                ) : pairing.ok ? (
                  <div className="space-y-4">
                    <div className="flex items-start gap-4">
                      {/* QR code container — rendered as an <img> from the QR data URL. */}
                      <div className="bg-white p-2 rounded border border-border shrink-0">
                        <PairingQR
                          boxId={pairing.boxId}
                          pairingCode={pairing.pairingCode}
                        />
                      </div>
                      <div className="flex-1 space-y-2">
                        <div className="text-sm">
                          <span className="text-text-muted">Code:</span>{" "}
                          <span className="font-mono text-text">{pairing.pairingCode}</span>
                        </div>
                        <div className="text-sm">
                          <span className="text-text-muted">Box ID:</span>{" "}
                          <span className="font-mono text-text break-all" title={pairing.boxId}>
                            {pairing.boxId}
                          </span>
                        </div>
                        {pairingExpiry && (
                          <PairingCountdown expiry={pairingExpiry} />
                        )}
                      </div>
                    </div>
                    <button
                      onClick={mintPairingCode}
                      disabled={pairingMinting}
                      className="text-sm px-4 py-2 rounded bg-bg-soft border border-border text-text-muted hover:text-text disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {pairingMinting ? "Generating…" : "Refresh code"}
                    </button>
                  </div>
                ) : (
                  <div className="text-sm text-red-400">
                    {pairing.error}
                  </div>
                )}
              </div>

              <div className="border-t border-border pt-6">
                <div className="flex items-center justify-between">
                  <div className="text-sm text-text-faint">
                    Re-run the guided setup (pairing, providers, first project).
                  </div>
                  <button
                    onClick={() => {
                      void useStore.getState().relaunchOnboarding();
                      onClose();
                    }}
                    className="text-sm px-4 py-2 rounded bg-bg-soft border border-border text-text-muted hover:text-text shrink-0"
                  >
                    Run setup again
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* AI Tab */}
          {activeTab === "ai" && (
            <div className="max-w-2xl space-y-6">
              <div>
                <h3 className="text-base font-semibold mb-4">Default model</h3>
                <select
                  value={selectedModel ? `${selectedModel.providerID}::${selectedModel.modelID}` : ""}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (!val) {
                      setSelectedModel(null);
                    } else {
                      const [providerID, modelID] = val.split("::");
                      setSelectedModel({ providerID, modelID });
                    }
                  }}
                  className="w-full bg-bg-soft border border-border px-3 py-2 text-sm rounded focus:outline-none focus:border-accent"
                >
                  <option value="">opencode default</option>
                  {models && models.map((m) => (
                    <option key={`${m.providerID}::${m.id}`} value={`${m.providerID}::${m.id}`}>
                      {m.name} ({m.providerID})
                    </option>
                  ))}
                </select>
                <div className="text-xs text-text-faint mt-2">
                  Applied to every new and cleared chat session. Can still be overridden per-session
                  with the model picker. "opencode default" lets the server decide.
                </div>
              </div>

              <div className="border-t border-border pt-6">
                <h3 className="text-base font-semibold mb-4">Model reference</h3>
                <div className="text-xs text-text-faint mb-3">
                  Quick reference for available models. Search by name, provider, or capability.
                </div>
                <input
                  type="text"
                  placeholder="Search models..."
                  value={modelSearchQuery}
                  onChange={(e) => setModelSearchQuery(e.target.value)}
                  className="w-full bg-bg-soft border border-border px-3 py-2 text-sm rounded focus:outline-none focus:border-accent mb-3"
                />
                <div className="space-y-2 max-h-80 overflow-y-auto border border-border rounded p-2 bg-bg-soft">
                  {(() => {
                    if (!models) return null;
                    const filtered = models.filter((m) => {
                      if (!modelSearchQuery) return true;
                      const q = modelSearchQuery.toLowerCase();
                      const info = describeModel(m.providerID, m.id);
                      return (
                        m.name.toLowerCase().includes(q) ||
                        m.providerID.toLowerCase().includes(q) ||
                        m.id.toLowerCase().includes(q) ||
                        (info?.blurb.toLowerCase().includes(q)) ||
                        (info?.goodFor.some((g: string) => g.toLowerCase().includes(q)))
                      );
                    });
                    if (filtered.length === 0) {
                      return <div className="text-xs text-text-faint text-center py-4">No models found</div>;
                    }
                    return filtered.map((m) => {
                      const info = describeModel(m.providerID, m.id);
                      return (
                        <div key={`${m.providerID}::${m.id}`} className="border border-border rounded p-2 bg-bg space-y-1">
                          <div className="flex items-center justify-between">
                            <span className="text-sm text-text font-medium">{m.name}</span>
                            <div className="flex items-center gap-2 text-[10px]">
                              <span className="text-text-faint">{m.providerID}</span>
                              {m.limit?.context && (
                                <span className="text-text-faint">{Math.round(m.limit.context / 1000)}k</span>
                              )}
                              {info && (
                                <span className={`px-1.5 py-0.5 rounded ${
                                  info.tier === "fast" ? "bg-green-900/20 text-green-400" :
                                  info.tier === "balanced" ? "bg-blue-900/20 text-blue-400" :
                                  "bg-purple-900/20 text-purple-400"
                                }`}>
                                  {info.tier}
                                </span>
                              )}
                            </div>
                          </div>
                          {info && (
                            <>
                              <div className="text-xs text-text-muted">{info.blurb}</div>
                              <div className="text-[10px] text-text-faint">
                                Good for: {info.goodFor.join(" · ")}
                              </div>
                            </>
                          )}
                        </div>
                      );
                    });
                  })()}
                </div>
              </div>

              <div className="border-t border-border pt-6">
                <h3 className="text-base font-semibold mb-4">Prompt cache TTL</h3>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setTtl("5m")}
                    className={`flex-1 px-4 py-2 text-sm rounded border ${
                      ttl === "5m"
                        ? "bg-accent text-bg border-accent"
                        : "bg-bg-soft text-text-muted border-border hover:text-text"
                    }`}
                  >
                    5 minutes
                  </button>
                  <button
                    type="button"
                    onClick={() => setTtl("1h")}
                    className={`flex-1 px-4 py-2 text-sm rounded border ${
                      ttl === "1h"
                        ? "bg-accent text-bg border-accent"
                        : "bg-bg-soft text-text-muted border-border hover:text-text"
                    }`}
                  >
                    1 hour (default)
                  </button>
                </div>
                <div className="text-xs text-text-faint mt-2">
                  How long Anthropic keeps a session's prompt cache warm between
                  requests. Used to predict when a session has gone stale and show
                  "/clear to save Nk tokens" in the chat footer. bui doesn't set
                  this value itself — opencode does, when it builds the Anthropic
                  request. Match this setting to opencode's{" "}
                  <code className="text-text-muted">cache_control.ttl</code> so the
                  staleness pill fires at the right time. 1h is the better default
                  for bui's typical "step away to read code" pattern.
                </div>
              </div>

              <div className="border-t border-border pt-6">
                <ProvidersCard />
              </div>

              <div className="border-t border-border pt-6">
                <SubagentsCard />
              </div>

              {/* AI CLI launch options (BET-138 refinement) — flags used when
                  launching an AI CLI (e.g. Claude Code) directly in a
                  session's terminal via the session-mode dropdown. Only CLIs
                  detected on this box (binary on PATH + provider connected)
                  are shown; an empty list renders nothing beyond the muted
                  hint. */}
              {availableLaunchers.some((l) => l.flags.length > 0) && (
                <div className="border-t border-border pt-6">
                  <h3 className="text-base font-semibold mb-1">AI CLI launch options</h3>
                  <div className="text-sm text-text-faint mb-4">
                    Flags used when launching an AI CLI (e.g. Claude Code) directly in a
                    session's terminal. Only CLIs detected on this box are shown.
                  </div>
                  <div className="space-y-4">
                    {availableLaunchers
                      .filter((l) => l.flags.length > 0)
                      .map((l) => (
                        <div key={l.id} className="space-y-2">
                          <div className="text-sm font-medium text-text">{l.label}</div>
                          {l.flags.map((f) => (
                            <label
                              key={f.key}
                              className="flex items-start gap-3 text-sm cursor-pointer"
                            >
                              <input
                                type="checkbox"
                                checked={resolveLauncherFlags(l.flags, launcherFlagValues[l.id])[f.key]}
                                onChange={(e) => setLauncherFlag(l.id, f.key, e.target.checked)}
                                className="mt-0.5"
                              />
                              <span>{f.label}</span>
                            </label>
                          ))}
                        </div>
                      ))}
                  </div>
                </div>
              )}

              <div className="border-t border-border pt-6">
                <h3 className="text-base font-semibold mb-4">Skill registries</h3>
                <div className="text-sm text-text-faint mb-3">
                  Extra skill registry URLs fetched by opencode on startup. The default bui registry is
                  always included. Add your own to surface additional skills in the AI's toolset.
                </div>
                <div className="space-y-2">
                  {registryUrls.map((url) => (
                    <div key={url} className="flex items-center gap-2">
                      <code className="flex-1 text-sm bg-bg-soft border border-border rounded px-3 py-2 text-text-muted truncate">
                        {url}
                      </code>
                      <button
                        onClick={() => removeRegistryUrl(url)}
                        className="text-sm text-text-faint hover:text-text px-2"
                        title="Remove"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
                <div className="flex gap-2 mt-3">
                  <input
                    placeholder="https://example.com/skills"
                    value={newRegistryUrl}
                    onChange={(e) => setNewRegistryUrl(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addRegistryUrl()}
                    className="flex-1 bg-bg-soft border border-border px-3 py-2 text-sm rounded focus:outline-none focus:border-accent"
                  />
                  <button
                    onClick={addRegistryUrl}
                    disabled={!newRegistryUrl.trim()}
                    className="px-4 py-2 text-sm bg-bg-soft border border-border rounded text-text-muted hover:text-text disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Add
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Voice Tab */}
          {activeTab === "voice" && (
            <div className="max-w-2xl space-y-6">
              <div>
                <h3 className="text-base font-semibold mb-4">Voice (Groq)</h3>
                <div className="text-sm text-text-faint mb-4">
                  Enables push-to-talk dictation in the chat composer. Press{" "}
                  <kbd className="text-text-muted">ctrl+m</kbd> to start recording — a
                  pulsing red ring appears around the input. Press{" "}
                  <kbd className="text-text-muted">⏎</kbd> to stop and send, or{" "}
                  <kbd className="text-text-muted">ctrl+m</kbd> again to stop and edit
                  before sending. <kbd className="text-text-muted">esc</kbd> cancels.
                  Get a key at{" "}
                  <a
                    href="https://console.groq.com/keys"
                    onClick={(e) => {
                      e.preventDefault();
                      getBuiPreload()?.openExternal("https://console.groq.com/keys");
                    }}
                    className="text-accent hover:underline"
                  >
                    console.groq.com/keys
                  </a>
                  . Free tier covers normal use.
                </div>
                <div className="space-y-3">
                  <div className="space-y-1">
                    <label className="block text-xs uppercase tracking-wider text-text-muted">
                      Groq API key
                    </label>
                    <input
                      type="password"
                      placeholder="gsk_… (leave blank to disable)"
                      value={groqKey}
                      onChange={(e) => setGroqKey(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      className="w-full bg-bg-soft border border-border px-3 py-2 text-sm rounded focus:outline-none focus:border-accent font-mono"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="block text-[10px] uppercase tracking-wider text-text-faint">
                        Transcription model
                      </label>
                      <input
                        placeholder="whisper-large-v3-turbo"
                        value={voiceTrModel}
                        onChange={(e) => setVoiceTrModel(e.target.value)}
                        spellCheck={false}
                        className="w-full bg-bg-soft border border-border px-3 py-2 text-sm rounded focus:outline-none focus:border-accent font-mono"
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
                        className="w-full bg-bg-soft border border-border px-3 py-2 text-sm rounded focus:outline-none focus:border-accent font-mono"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Files Tab */}
          {activeTab === "files" && (
            <div className="max-w-2xl space-y-6">
              <div className="border-t border-border pt-6">
                <h3 className="text-base font-semibold mb-4">Agent file delivery</h3>
                <div className="space-y-3">
                  <label className="flex items-start gap-3 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={agentPush}
                      onChange={(e) => setAgentPush(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span>
                      Auto-save files the AI sends
                      <span className="block text-xs text-text-faint mt-1">
                        When the AI drops a file in{" "}
                        <code className="text-text-muted">~/.manta-outbox</code> on the remote, save it to your
                        downloads folder without asking. Off = a toast asks before each file is saved.
                      </span>
                    </span>
                  </label>
                  <div className="space-y-1">
                    <label className="block text-xs uppercase tracking-wider text-text-muted">
                      Downloads directory
                    </label>
                    <input
                      type="text"
                      placeholder="~/Downloads (default)"
                      value={dlDir}
                      onChange={(e) => setDlDir(e.target.value)}
                      className="w-full bg-bg-soft border border-border px-3 py-2 text-sm rounded focus:outline-none focus:border-accent"
                    />
                    <div className="text-xs text-text-faint">
                      Destination for AI-sent files. Absolute path; leave empty for your OS Downloads folder.
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* General Tab */}
          {activeTab === "general" && (
            <div className="max-w-2xl space-y-6">
              <div>
                <h3 className="text-base font-semibold mb-4">Auto-rename sessions</h3>
                <label className="flex items-start gap-3 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={autoRename}
                    onChange={(e) => setAutoRename(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>
                    Name sessions from the conversation
                    <span className="block text-xs text-text-faint mt-1">
                      Every few turns, ask the model for a 1-2 word title and rename
                      the chat window to match the current work. Overwrites the
                      window name, including names you set by hand.
                    </span>
                  </span>
                </label>
              </div>

              <div className="border-t border-border pt-6">
                <h3 className="text-base font-semibold mb-4">About</h3>
                <div className="text-sm text-text-faint">
                  Manta UI v0.0.1
                </div>
                <div className="text-xs text-text-faint mt-2">
                  Desktop client for remote Claude Code sessions.
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer with Save/Cancel */}
        <div className="border-t border-border p-4">
          {saveError && (
            <div className="text-sm text-red-400 mb-3">
              Couldn't save: {saveError}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button
              onClick={onClose}
              disabled={saving}
              className="px-4 py-2 text-sm text-text-muted hover:text-text disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="px-4 py-2 text-sm bg-accent text-bg rounded hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
