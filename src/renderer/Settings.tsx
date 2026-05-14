import { useEffect, useState } from "react";
import { useStore } from "./store";

export function Settings({ onClose }: { onClose: () => void }) {
  const {
    host,
    user,
    identityFile,
    transportPreference,
    uploadCleanupHours,
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

  useEffect(() => {
    setH(host);
    setU(user ?? "");
    setK(identityFile ?? "");
    setTp(transportPreference);
    setUch(String(uploadCleanupHours));
  }, [host, user, identityFile, transportPreference, uploadCleanupHours]);

  const save = async () => {
    const hoursNum = Number(uch);
    await window.api.configUpdate({
      host: h.trim(),
      user: u.trim() || undefined,
      identityFile: k.trim() || undefined,
      transport: tp,
      uploadCleanupHours: Number.isFinite(hoursNum) && hoursNum >= 0 ? hoursNum : 1,
    });
    await refresh();
    onClose();
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
            Remote tmux config
          </label>
          <div className="text-xs text-text-faint">
            On first connect, bui appends a small block to your remote{" "}
            <code className="text-text-muted">~/.tmux.conf</code> with the options it needs
            (status off, mouse on, allow-passthrough on, snappy escape time). Your original is
            saved at <code className="text-text-muted">~/.tmux.conf.pre-bui</code>.
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
          <button
            onClick={restore}
            disabled={!tmuxConfig?.buiManaged || restoring}
            className="text-xs px-3 py-1.5 rounded bg-bg-soft border border-border text-text-muted hover:text-text disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {restoring ? "Restoring…" : "Restore previous tmux config"}
          </button>
        </div>

        <div className="text-xs text-text-faint">
          Authentication uses your system ssh client (and ssh-agent / ~/.ssh/config). Make sure
          you can already <code className="text-text-muted">ssh {u || "user"}@{h || "host"}</code> from a terminal.
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
