import { useEffect, useState } from "react";
import { useStore } from "./store";
import { ProvidersCard } from "./ProvidersCard";
import { PairingQR, PairingCountdown } from "./PairingQR";
import { getBuiPreload } from "./preloadAccess";
import type {
  AuthPairResult,
  BootstrapResult,
  OpencodeModel,
  ProbeCheck,
  ProbeResult,
} from "../shared/types";

const TABS = [
  { id: "connection", label: "Connection" },
  { id: "ai", label: "AI" },
  { id: "voice", label: "Voice" },
  { id: "files", label: "Files" },
  { id: "general", label: "General" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const CHECK_LABELS: Record<ProbeCheck["name"], string> = {
  ssh: "SSH",
  tmux: "tmux",
  opencode: "opencode binary",
  opencodeAuthPlugin: "Auth plugin",
  anthropicAuth: "Anthropic login",
};

function checkLabel(name: ProbeCheck["name"]): string {
  return CHECK_LABELS[name];
}

export function Settings({ onClose }: { onClose: () => void }) {
  const {
    host,
    user,
    identityFile,
    transportPreference,
    uploadCleanupHours,
    allowAgentPush,
    autoRenameSessions,
    downloadsDir,
    defaultModel,
    skillRegistryUrls,
    cacheTtl,
    groqApiKey,
    voiceTranscriptionModel,
    voiceCommandModel,
    transport,
    tmuxConfig,
    refresh,
  } = useStore();

  // Connection fields (Connection tab)
  const [h, setH] = useState(host);
  const [u, setU] = useState(user ?? "");
  const [k, setK] = useState(identityFile ?? "");
  const [tp, setTp] = useState<"auto" | "mosh" | "ssh">(transportPreference);
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null);
  const [bootstrapping, setBootstrapping] = useState(false);
  const [bootstrapResult, setBootstrapResult] = useState<BootstrapResult | null>(null);
  const [settingUp, setSettingUp] = useState(false);
  const [restoring, setRestoring] = useState(false);

  // AI fields (AI tab)
  const [models, setModels] = useState<OpencodeModel[] | null>(null);
  const [selectedModel, setSelectedModel] = useState<{ providerID: string; modelID: string } | null>(
    defaultModel ?? null,
  );
  const [registryUrls, setRegistryUrls] = useState<string[]>(skillRegistryUrls ?? []);
  const [newRegistryUrl, setNewRegistryUrl] = useState("");
  const [ttl, setTtl] = useState<"5m" | "1h">(cacheTtl);

  // Files fields (Files tab)
  const [uch, setUch] = useState<string>(String(uploadCleanupHours));
  const [agentPush, setAgentPush] = useState(allowAgentPush);
  const [dlDir, setDlDir] = useState(downloadsDir);

  // General fields (General tab)
  const [autoRename, setAutoRename] = useState(autoRenameSessions);

  // Voice fields (Voice tab)
  const [groqKey, setGroqKey] = useState(groqApiKey);
  const [voiceTrModel, setVoiceTrModel] = useState(voiceTranscriptionModel);
  const [voiceCmdModel, setVoiceCmdModel] = useState(voiceCommandModel);
  // Mobile pairing — one-time code minted on demand. The QR encodes
  // `bui://pair?id=<boxId>&token=<pairingCode>`; the mobile app scans this to
  // auto-connect. `pairing` is null until the user clicks "Generate code".
  // `pairingExpiry` is a Date parsed from the server's expiresAt ISO string,
  // used to compute the remaining seconds for the countdown UI.
  const [pairing, setPairing] = useState<AuthPairResult | null>(null);
  const [pairingExpiry, setPairingExpiry] = useState<Date | null>(null);
  const [pairingMinting, setPairingMinting] = useState(false);

  // Active tab
  const [activeTab, setActiveTab] = useState<TabId>("connection");

  // Sync local state when store values change
  useEffect(() => {
    setH(host);
    setU(user ?? "");
    setK(identityFile ?? "");
    setTp(transportPreference);
    setSelectedModel(defaultModel ?? null);
    setRegistryUrls(skillRegistryUrls ?? []);
    setTtl(cacheTtl);
    setUch(String(uploadCleanupHours));
    setAgentPush(allowAgentPush);
    setDlDir(downloadsDir);
    setAutoRename(autoRenameSessions);
    setGroqKey(groqApiKey);
    setVoiceTrModel(voiceTranscriptionModel);
    setVoiceCmdModel(voiceCommandModel);
  }, [host, user, identityFile, transportPreference, uploadCleanupHours, allowAgentPush, autoRenameSessions, downloadsDir, defaultModel, skillRegistryUrls, cacheTtl, groqApiKey, voiceTranscriptionModel, voiceCommandModel]);

  // Fetch available models once (non-fatal — Settings works even if opencode is unreachable).
  useEffect(() => {
    window.api
      .opencodeModels()
      .then((list) => setModels(list))
      .catch(() => {});
  }, []);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    const hoursNum = Number(uch);
    try {
      await window.api.configUpdate({
        host: h.trim(),
        user: u.trim() || undefined,
        identityFile: k.trim() || undefined,
        transport: tp,
        uploadCleanupHours: Number.isFinite(hoursNum) && hoursNum >= 0 ? hoursNum : 1,
        allowAgentPush: agentPush,
        autoRenameSessions: autoRename,
        downloadsDir: dlDir.trim(),
        defaultModel: selectedModel ?? undefined,
        skillRegistryUrls: registryUrls,
        cacheTtl: ttl,
        groqApiKey: groqKey.trim(),
        voiceTranscriptionModel: voiceTrModel.trim(),
        voiceCommandModel: voiceCmdModel.trim(),
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

  const runProbe = async () => {
    setProbing(true);
    try {
      const r = await window.api.setupProbe();
      setProbeResult(r);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setProbing(false);
    }
  };

  const runProbeFromButton = async () => {
    setBootstrapResult(null);
    await runProbe();
  };

  const runBootstrap = async () => {
    if (!confirm(
      "Install opencode on the remote and add the Claude auth plugin?\n\n" +
      "• Runs the official opencode installer (curl https://opencode.ai/install | bash) " +
      "if opencode isn't already present.\n" +
      "• Merges the opencode-claude-auth plugin into ~/.config/opencode/opencode.jsonc, " +
      "preserving your existing keys. If you already have a plugin (with or without an " +
      "@version pin), no change is made. If the file is unparseable, it's backed up to " +
      "opencode.jsonc.pre-bui before being replaced.\n\n" +
      "Safe to re-run.",
    )) return;
    setBootstrapping(true);
    try {
      const r = await window.api.setupBootstrap();
      setBootstrapResult(r);
      await runProbe();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBootstrapping(false);
    }
  };

  const setupTmux = async () => {
    setSettingUp(true);
    try {
      await window.api.tmuxSetupConfig();
      await refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setSettingUp(false);
    }
  };

  const restore = async () => {
    if (
      !confirm(
        "Restore your previous tmux config?\n\n" +
          "This puts ~/.tmux.conf back to what it was before bui set it up. " +
          "bui will then look like a plain tmux client (status bar visible, " +
          "no bui chrome optimizations).",
      )
    )
      return;
    setRestoring(true);
    try {
      await window.api.tmuxRestoreConfig();
      await refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setRestoring(false);
    }
  };

  // True iff any connection-related field differs from the saved config.
  const connectionDirty =
    h.trim() !== host ||
    u.trim() !== (user ?? "") ||
    k.trim() !== (identityFile ?? "");

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
              <div>
                <h3 className="text-base font-semibold mb-4">Remote host</h3>
                <div className="space-y-3">
                  <div className="space-y-1">
                    <label className="block text-xs uppercase tracking-wider text-text-muted">
                      Host
                    </label>
                    <input
                      placeholder="hostname or IP"
                      value={h}
                      onChange={(e) => setH(e.target.value)}
                      className="w-full bg-bg-soft border border-border px-3 py-2 text-sm rounded focus:outline-none focus:border-accent"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="block text-xs uppercase tracking-wider text-text-muted">
                      User (optional, falls back to ssh config)
                    </label>
                    <input
                      placeholder="user"
                      value={u}
                      onChange={(e) => setU(e.target.value)}
                      className="w-full bg-bg-soft border border-border px-3 py-2 text-sm rounded focus:outline-none focus:border-accent"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="block text-xs uppercase tracking-wider text-text-muted">
                      Identity file (optional, e.g. ~/.ssh/id_ed25519)
                    </label>
                    <input
                      placeholder="~/.ssh/id_ed25519"
                      value={k}
                      onChange={(e) => setK(e.target.value)}
                      className="w-full bg-bg-soft border border-border px-3 py-2 text-sm rounded focus:outline-none focus:border-accent"
                    />
                  </div>
                </div>
              </div>

              <div>
                <h3 className="text-base font-semibold mb-4">Transport</h3>
                <div className="space-y-2">
                  <select
                    value={tp}
                    onChange={(e) => setTp(e.target.value as "auto" | "mosh" | "ssh")}
                    className="w-full bg-bg-soft border border-border px-3 py-2 text-sm rounded focus:outline-none focus:border-accent"
                  >
                    <option value="auto">Auto (mosh if available)</option>
                    <option value="mosh">Mosh — force</option>
                    <option value="ssh">SSH — force</option>
                  </select>
                  {transport && (
                    <div className="text-xs text-text-faint">
                      Currently using <span className="text-text">{transport.effective}</span>.
                      {" "}Mosh on Mac: {transport.moshLocal ? "yes" : "no"} ·
                      {" "}mosh-server on remote: {transport.moshRemote ? "yes" : "no"}.
                      {!transport.moshLocal && (
                        <> Install with <code className="text-text-muted">brew install mosh</code> for resilient connections.</>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div className="border-t border-border pt-6">
                <h3 className="text-base font-semibold mb-4">Connection &amp; remote setup</h3>
                <div className="text-sm text-text-faint mb-4">
                  Verify the remote host has everything bui needs: ssh reachable, tmux
                  installed, opencode installed, and Anthropic auth wired up for chat
                  mode.
                </div>
                {connectionDirty && (
                  <div className="text-sm text-amber-400 mb-3">
                    You have unsaved connection changes. Save first — the wizard runs
                    against the saved host/user/identity.
                  </div>
                )}
                <div className="flex gap-2 mb-4">
                  <button
                    onClick={runProbeFromButton}
                    disabled={!host || probing || bootstrapping || connectionDirty}
                    className="text-sm px-4 py-2 rounded bg-bg-soft border border-border text-text-muted hover:text-text disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {probing ? "Testing…" : "Test connection"}
                  </button>
                  <button
                    onClick={runBootstrap}
                    disabled={!host || probing || bootstrapping || connectionDirty}
                    className="text-sm px-4 py-2 rounded bg-bg-soft border border-border text-text-muted hover:text-text disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {bootstrapping ? "Bootstrapping…" : "Bootstrap remote"}
                  </button>
                </div>
                {probeResult && (
                  <div className="space-y-1 text-sm">
                    {probeResult.checks.map((c) => (
                      <div key={c.name} className="flex items-baseline gap-2">
                        <span className={c.ok ? "text-green-400" : "text-red-400"}>
                          {c.ok ? "✓" : "✗"}
                        </span>
                        <span className="text-text-muted w-32 shrink-0">{checkLabel(c.name)}</span>
                        <span className="text-text-faint flex-1 break-all">{c.detail}</span>
                      </div>
                    ))}
                  </div>
                )}
                {bootstrapResult && (
                  <pre className="text-sm bg-bg-soft border border-border rounded p-3 text-text-muted whitespace-pre-wrap max-h-64 overflow-y-auto">
                    {bootstrapResult.log.join("\n")}
                  </pre>
                )}
              </div>

              <div className="border-t border-border pt-6">
                <h3 className="text-base font-semibold mb-4">Remote tmux config</h3>
                <div className="text-sm text-text-faint mb-3">
                  Opt-in. Click "Set up" to append a small fenced block to your remote{" "}
                  <code className="text-text-muted">~/.tmux.conf</code> with the options bui works
                  best with (status off, mouse on, allow-passthrough on, snappy escape time). Your
                  original is saved at <code className="text-text-muted">~/.tmux.conf.pre-bui</code>.
                  These settings are global and apply to every tmux session on your remote, not
                  just bui's — restore anytime with the button below.
                </div>
                {tmuxConfig && (
                  <div className="text-sm mb-3">
                    Status:{" "}
                    <span className={tmuxConfig.buiManaged ? "text-green-400" : "text-text-muted"}>
                      {tmuxConfig.buiManaged ? "bui-managed" : "not yet set up"}
                    </span>
                    {" · backup "}
                    <span className={tmuxConfig.backupExists ? "text-text-muted" : "text-text-faint"}>
                      {tmuxConfig.backupExists ? "available" : "none"}
                    </span>
                  </div>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={setupTmux}
                    disabled={!host || tmuxConfig?.buiManaged || settingUp}
                    className="text-sm px-4 py-2 rounded bg-bg-soft border border-border text-text-muted hover:text-text disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {settingUp ? "Setting up…" : "Set up tmux config"}
                  </button>
                  <button
                    onClick={restore}
                    disabled={!tmuxConfig?.buiManaged || restoring}
                    className="text-sm px-4 py-2 rounded bg-bg-soft border border-border text-text-muted hover:text-text disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {restoring ? "Restoring…" : "Restore previous"}
                  </button>
                </div>
              </div>

              {/* Mobile pairing (BET-80): generate a QR code the mobile app can scan
                  to auto-connect. The QR encodes `bui://pair?id=<boxId>&token=<code>`.
                  The code is one-time, valid for ~5 minutes. A new code supersedes
                  any prior code. */}
              <div className="border-t border-border pt-6">
                <h3 className="text-base font-semibold mb-4">Pair phone</h3>
                <div className="text-sm text-text-faint mb-4">
                  Scan this QR with the BUI mobile app to connect it to your box. The
                  code is one-time and valid for ~5 minutes. Generate a new code if the
                  old one expires.
                </div>
                {!pairing ? (
                  <button
                    onClick={mintPairingCode}
                    disabled={pairingMinting || !h}
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
              <div>
                <h3 className="text-base font-semibold mb-4">Upload cleanup</h3>
                <div className="space-y-2">
                  <input
                    type="number"
                    min={0}
                    step={1}
                    placeholder="1"
                    value={uch}
                    onChange={(e) => setUch(e.target.value)}
                    className="w-full bg-bg-soft border border-border px-3 py-2 text-sm rounded focus:outline-none focus:border-accent"
                  />
                  <div className="text-xs text-text-faint">
                    Sweeps <code className="text-text-muted">~/.bui-uploads</code> on the remote, removing
                    drag-and-drop batches older than this. <code className="text-text-muted">0</code>{" "}
                    disables.
                  </div>
                </div>
              </div>

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
                        <code className="text-text-muted">~/.bui-outbox</code> on the remote, save it to your
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
                  Better UI v0.0.1
                </div>
                <div className="text-xs text-text-faint mt-2">
                  Desktop client for remote Claude Code sessions over SSH+tmux.
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
