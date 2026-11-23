// autonomyShared.mjs — the autonomy table shared by the box server and the renderer (Agents Phase 3,
// spec docs/superpowers/specs/2026-11-23-agents-phase3-autonomy.md). One table: rename or re-default here only.

export const LEVELS = Object.freeze(["auto", "tell", "ask", "never"]); // strictness order

export const ACTION_KINDS = Object.freeze([
  "edit_code",
  "handoff",
  "merge",
  "deploy",
  "publish",
  "send_external",
  "delete_data",
  "spend",
  "settings",
  "agent_change",
]);

/** Kinds that only take "auto" or "never". */
export const BINARY_KINDS = Object.freeze(["edit_code"]);

export const MODES = Object.freeze({
  cautious: Object.freeze({ edit_code: "auto", handoff: "tell", merge: "ask", deploy: "ask", publish: "ask", send_external: "ask", delete_data: "ask", spend: "ask", settings: "ask", agent_change: "ask" }),
  balanced: Object.freeze({ edit_code: "auto", handoff: "auto", merge: "ask", deploy: "ask", publish: "ask", send_external: "ask", delete_data: "ask", spend: "ask", settings: "ask", agent_change: "ask" }),
  autonomous: Object.freeze({ edit_code: "auto", handoff: "auto", merge: "auto", deploy: "tell", publish: "tell", send_external: "tell", delete_data: "tell", spend: "ask", settings: "tell", agent_change: "tell" }),
});

export const MODE_NAMES = Object.freeze(["cautious", "balanced", "autonomous"]);
export const DEFAULT_MODE = "balanced";

/** Model-facing phrase per kind (lead brief and job prompt). */
export const KIND_LABELS = Object.freeze({
  edit_code: "change code (yourself or through an agent, on its own branch)",
  handoff: "hand work to your team's agents",
  merge: "merge changes into the main branch",
  deploy: "deploy or release anything",
  publish: "publish anything others can see",
  send_external: "send messages or data to people or services outside this box",
  delete_data: "delete or overwrite data that cannot be recovered",
  spend: "spend money or buy anything",
  settings: "change Manta's settings",
  agent_change: "change an agent's instructions or permissions",
});

/** User-facing row titles (Settings → Agents). */
export const KIND_TITLES = Object.freeze({
  edit_code: "Change code",
  handoff: "Hand work to agents",
  merge: "Merge into the main branch",
  deploy: "Deploy or release",
  publish: "Publish something others can see",
  send_external: "Send something outside (email, posts, comments)",
  delete_data: "Delete data",
  spend: "Spend money",
  settings: "Change Manta settings",
  agent_change: "Change an agent",
});

export const LEVEL_TITLES = Object.freeze({ auto: "Auto", tell: "Tell me", ask: "Ask", never: "Never" });
export const MODE_TITLES = Object.freeze({ cautious: "Cautious", balanced: "Balanced", autonomous: "Autonomous" });
