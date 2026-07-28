// The extensible launcher registry. Add a new AI TUI here — nothing else in
// the PTY / renderer / dropdown needs to change (BET-138 refinement).
//
// id       stable launcher id (persisted in localStorage as `tui:<id>`, used
//          in AppConfig.launcherFlags keys). NEVER reuse/rename without a
//          migration.
// label    dropdown label.
// bin      binary probed with `command -v` for availability.
// flags    flag schema: [{ key, label, type:"boolean", default, arg }]. `arg`
//          is the CLI flag emitted when a boolean flag is truthy.
// buildArgs(values) -> string[] argv (excluding the bin itself).
// hidden   when true, the entry still resolves via findLauncher (so a
//          non-dropdown consumer like the Claude connect card can spawn it)
//          but is filtered OUT of launchers:list so it never shows in the
//          session-mode dropdown. Used by the Claude auth-login launcher
//          (BET-354) which is driven programmatically, not chosen by the
//          user.

export const LAUNCHERS = [
  {
    id: "claude",
    label: "Claude Code",
    bin: "claude",
    flags: [
      {
        key: "skipPermissions",
        label: "Skip all permission prompts",
        type: "boolean",
        default: true,
        arg: "--dangerously-skip-permissions",
      },
    ],
    buildArgs(values) {
      const args = [];
      for (const f of this.flags) {
        if (f.type === "boolean" && values?.[f.key]) args.push(f.arg);
      }
      return args;
    },
  },
  {
    id: "codex",
    label: "Codex",
    bin: "codex",
    flags: [],
    buildArgs: () => [],
  },
  {
    id: "kimi",
    label: "Kimi Code",
    bin: "kimi",
    flags: [],
    buildArgs: () => [],
  },
  // BET-354: Claude OAuth login flow. Reuses the pty bus so the existing
  // pty:spawn / pty:write / pty:kill channels drive it transparently; the
  // connect card just listens to the same pty event stream and feeds the
  // callback code back through pty:write. Hidden from the session-mode
  // dropdown — it's a one-shot interactive flow, not a user-selectable
  // terminal mode. argv = `claude auth login` per the BET-352 POC; bare
  // `claude` opens the normal TUI and never offers a login.
  {
    id: "claude-auth-login",
    label: "Claude auth login",
    bin: "claude",
    flags: [],
    hidden: true,
    buildArgs: () => ["auth", "login"],
  },
];

export function findLauncher(id) {
  return LAUNCHERS.find((l) => l.id === id) || null;
}
