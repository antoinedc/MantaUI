// The extensible launcher registry. Add a new AI TUI here — nothing else in
// the PTY / renderer / dropdown needs to change (BET-138 refinement).
//
// id       stable launcher id (persisted in localStorage as `tui:<id>`, used
//          in AppConfig.launcherFlags keys). NEVER reuse/rename without a
//          migration.
// label    dropdown label.
// bin      binary probed with `command -v` for availability.
// provider opencode provider id that must be `connected` for availability, or
//          null for a pure-CLI launcher with no opencode auth gate.
// flags    flag schema: [{ key, label, type:"boolean", default, arg }]. `arg`
//          is the CLI flag emitted when a boolean flag is truthy.
// buildArgs(values) -> string[] argv (excluding the bin itself).

export const LAUNCHERS = [
  {
    id: "claude",
    label: "Claude Code",
    bin: "claude",
    provider: "anthropic",
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
  // Future example (do NOT add in v1 — illustration only):
  // { id: "codex", label: "Codex", bin: "codex", provider: "openai", flags: [], buildArgs: () => [] },
];

export function findLauncher(id) {
  return LAUNCHERS.find((l) => l.id === id) || null;
}
