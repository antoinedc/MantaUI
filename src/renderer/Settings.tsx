import { useEffect, useState } from "react";
import { useStore } from "./store";
import type {
  BootstrapResult,
  OpencodeModel,
  ProbeCheck,
  ProbeResult,
} from "../shared/types";

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
    defaultModel,
    skillRegistryUrls,
    cacheTtl,
    transport,
    tmuxConfig,
    refresh,
  } = useStore();
  const [h, setH] = useState(host);
  const [u, setU] = useState(user ?? "");
  const [k, setK] = useState(identityFile ?? "");
  const [tp, setTp] = useState<"auto" | "mosh" | "ssh">(transportPreference);
  const [uch, setUch] = useState<string>(String(uploadCleanupHours));
  const [restoring, setRestoring] = useState(false);
  const [settingUp, setSettingUp] = useState(false);
  // Setup wizard — probe runs the diagnostic, bootstrap installs opencode.
  // Both target the *saved* config (Electron IPC reads from main process
  // state, not the form). We disable the buttons while the form is dirty
  // so a user can't run probe against stale values and get confused by
  // the result (regression-bait if you forget — verified live during PR
  // self-review).
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null);
  const [bootstrapping, setBootstrapping] = useState(false);
  const [bootstrapResult, setBootstrapResult] = useState<BootstrapResult | null>(null);

  // True iff any connection-related field differs from the saved config.
  // We compare against the values that probe/bootstrap actually use
  // (host, user, identityFile). Transport/uploadCleanupHours/etc. don't
  // affect the wizard and shouldn't gate it.
  const connectionDirty =
    h.trim() !== host ||
    u.trim() !== (user ?? "") ||
    k.trim() !== (identityFile ?? "");
  // Default model selection
  const [models, setModels] = useState<OpencodeModel[] | null>(null);
  const [selectedModel, setSelectedModel] = useState<{ providerID: string; modelID: string } | null>(
    defaultModel ?? null,
  );
  // Skill registry URLs
  const [registryUrls, setRegistryUrls] = useState<string[]>(skillRegistryUrls ?? []);
  const [newRegistryUrl, setNewRegistryUrl] = useState("");
  // Anthropic prompt cache TTL — used to predict session staleness for the
  // "/clear to save Nk tokens" pill. Must match opencode's actual
  // cache_control.ttl setting; bui doesn't control it directly.
  const [ttl, setTtl] = useState<"5m" | "1h">(cacheTtl);

  useEffect(() => {
    setH(host);
    setU(user ?? "");
    setK(identityFile ?? "");
    setTp(transportPreference);
    setUch(String(uploadCleanupHours));
    setSelectedModel(defaultModel ?? null);
    setRegistryUrls(skillRegistryUrls ?? []);
    setTtl(cacheTtl);
  }, [host, user, identityFile, transportPreference, uploadCleanupHours, defaultModel, skillRegistryUrls, cacheTtl]);

  // Fetch available models once (non-fatal — Settings works even if opencode is unreachable).
  useEffect(() => {
    window.api
      .opencodeModels()
      .then((list) => setModels(list))
      .catch(() => {});
  }, []);

  const save = async () => {
    const hoursNum = Number(uch);
    await window.api.configUpdate({
      host: h.trim(),
      user: u.trim() || undefined,
      identityFile: k.trim() || undefined,
      transport: tp,
      uploadCleanupHours: Number.isFinite(hoursNum) && hoursNum >= 0 ? hoursNum : 1,
      defaultModel: selectedModel ?? undefined,
      skillRegistryUrls: registryUrls,
      cacheTtl: ttl,
    });
    await refresh();
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

  const runProbe = async () => {
    setProbing(true);
    try {
      const r = await window.api.setupProbe();
      setProbeResult(r);
    } catch (e) {
      // Should never throw (probe traps all errors internally), but guard
      // against IPC layer failures.
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setProbing(false);
    }
  };

  // User-initiated probe (button click) clears any prior bootstrap log
  // so the new probe result isn't visually competing with a stale log.
  // runBootstrap → runProbe must NOT clear bootstrapResult, otherwise the
  // bootstrap log flashes for one React commit then disappears (the whole
  // point of the log pane is to read what bootstrap did).
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
      // Re-probe so the status pills refresh.
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

  return (
    <div className="absolute inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-bg-elev border border-border rounded-lg p-6 w-[480px] space-y-4 max-h-[90vh] overflow-y-auto">
        <h2 className="text-lg font-semibold">Settings</h2>

        <div className="space-y-2">
          <label className="block text-xs uppercase tracking-wider text-text-muted">
            Remote host
          </label>
          <input
            placeholder="hostname or IP"
            value={h}
            onChange={(e) => setH(e.target.value)}
            className="w-full bg-bg-soft border border-border px-3 py-2 text-sm rounded focus:outline-none focus:border-accent"
          />
        </div>

        <div className="space-y-2">
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

        <div className="space-y-2">
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

        <div className="space-y-2 pt-2">
          <label className="block text-xs uppercase tracking-wider text-text-muted">
            Transport
          </label>
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

        <div className="space-y-2 pt-2">
          <label className="block text-xs uppercase tracking-wider text-text-muted">
            Auto-clean uploads (hours)
          </label>
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

        <div className="space-y-2 pt-2 border-t border-border">
          <label className="block text-xs uppercase tracking-wider text-text-muted">
            Default model
          </label>
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
          <div className="text-xs text-text-faint">
            Applied to every new and cleared chat session. Can still be overridden per-session
            with the model picker. "opencode default" lets the server decide.
          </div>
        </div>

        <div className="space-y-2 pt-2 border-t border-border">
          <label className="block text-xs uppercase tracking-wider text-text-muted">
            Prompt cache TTL
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setTtl("5m")}
              className={`flex-1 px-3 py-1.5 text-sm rounded border ${
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
              className={`flex-1 px-3 py-1.5 text-sm rounded border ${
                ttl === "1h"
                  ? "bg-accent text-bg border-accent"
                  : "bg-bg-soft text-text-muted border-border hover:text-text"
              }`}
            >
              1 hour (default)
            </button>
          </div>
          <div className="text-xs text-text-faint">
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

        <div className="space-y-2 pt-2 border-t border-border">
          <label className="block text-xs uppercase tracking-wider text-text-muted">
            Remote tmux config
          </label>
          <div className="text-xs text-text-faint">
            Opt-in. Click "Set up" to append a small fenced block to your remote{" "}
            <code className="text-text-muted">~/.tmux.conf</code> with the options bui works
            best with (status off, mouse on, allow-passthrough on, snappy escape time). Your
            original is saved at <code className="text-text-muted">~/.tmux.conf.pre-bui</code>.
            These settings are global and apply to every tmux session on your remote, not
            just bui's — restore anytime with the button below.
          </div>
          {tmuxConfig && (
            <div className="text-xs">
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
              className="text-xs px-3 py-1.5 rounded bg-bg-soft border border-border text-text-muted hover:text-text disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {settingUp ? "Setting up…" : "Set up tmux config"}
            </button>
            <button
              onClick={restore}
              disabled={!tmuxConfig?.buiManaged || restoring}
              className="text-xs px-3 py-1.5 rounded bg-bg-soft border border-border text-text-muted hover:text-text disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {restoring ? "Restoring…" : "Restore previous"}
            </button>
          </div>
        </div>

        <div className="space-y-2 pt-2 border-t border-border">
          <label className="block text-xs uppercase tracking-wider text-text-muted">
            Skill registries
          </label>
          <div className="text-xs text-text-faint">
            Extra skill registry URLs fetched by opencode on startup. The default bui registry is
            always included. Add your own to surface additional skills in the AI's toolset.
          </div>
          <div className="space-y-1">
            {registryUrls.map((url) => (
              <div key={url} className="flex items-center gap-2">
                <code className="flex-1 text-xs bg-bg-soft border border-border rounded px-2 py-1 text-text-muted truncate">
                  {url}
                </code>
                <button
                  onClick={() => removeRegistryUrl(url)}
                  className="text-xs text-text-faint hover:text-text px-1"
                  title="Remove"
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
              className="flex-1 bg-bg-soft border border-border px-3 py-2 text-sm rounded focus:outline-none focus:border-accent"
            />
            <button
              onClick={addRegistryUrl}
              disabled={!newRegistryUrl.trim()}
              className="px-3 py-1.5 text-sm bg-bg-soft border border-border rounded text-text-muted hover:text-text disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Add
            </button>
          </div>
        </div>

        <div className="text-xs text-text-faint">
          Authentication uses your system ssh client (and ssh-agent / ~/.ssh/config). Make sure
          you can already <code className="text-text-muted">ssh {u || "user"}@{h || "host"}</code> from a terminal.
        </div>

        <div className="space-y-2 pt-2 border-t border-border">
          <label className="block text-xs uppercase tracking-wider text-text-muted">
            Connection &amp; remote setup
          </label>
          <div className="text-xs text-text-faint">
            Verify the remote host has everything bui needs: ssh reachable, tmux
            installed, opencode installed, and Anthropic auth wired up for chat
            mode.
          </div>
          {connectionDirty && (
            <div className="text-xs text-amber-400">
              You have unsaved connection changes. Save first — the wizard runs
              against the saved host/user/identity.
            </div>
          )}
          <div className="flex gap-2">
            <button
              onClick={runProbeFromButton}
              disabled={!host || probing || bootstrapping || connectionDirty}
              className="text-xs px-3 py-1.5 rounded bg-bg-soft border border-border text-text-muted hover:text-text disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {probing ? "Testing…" : "Test connection"}
            </button>
            <button
              onClick={runBootstrap}
              disabled={!host || probing || bootstrapping || connectionDirty}
              className="text-xs px-3 py-1.5 rounded bg-bg-soft border border-border text-text-muted hover:text-text disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {bootstrapping ? "Bootstrapping…" : "Bootstrap remote"}
            </button>
          </div>
          {probeResult && (
            <div className="space-y-1 text-xs">
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
            <pre className="text-xs bg-bg-soft border border-border rounded p-2 text-text-muted whitespace-pre-wrap max-h-48 overflow-y-auto">
              {bootstrapResult.log.join("\n")}
            </pre>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-text-muted hover:text-text"
          >
            Cancel
          </button>
          <button
            onClick={save}
            className="px-3 py-1.5 text-sm bg-accent text-bg rounded hover:opacity-90"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
