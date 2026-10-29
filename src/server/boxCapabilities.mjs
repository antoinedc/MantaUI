// boxCapabilities.mjs — the ONE list of server-first capabilities this box
// advertises (master D25). Returned as `capabilities: string[]` from
// GET /api/version and the `server:version` RPC. A client on an older box finds
// an id missing and hides / disables the dependent feature with "Update your
// box to use this" — there is no fallback copy of the moved logic on a client.
//
// Ids are `kebab-name-N` (N bumps when a capability's shape changes
// incompatibly). Every later workstream APPENDS its ids here; nothing else may
// create a second capability list.

export const BOX_CAPABILITIES = Object.freeze([
  "chat-cards-1",
  "artifacts-list-1",
  // WS09 (models / spend / usage)
  "models-table-1",
  "models-picker-1",
  "models-unidentified-1",
  "models-price-form-1",
  "ledger-view-1",
  "optimizer-view-1",
  "usage-resume-view-1",
  "usage-alerts-1",
  "usage-window-tone-1",
  // WS06 (search)
  "search-scope-all-1",
  // WS05 (git / PR / review / inbox)
  "forge-pr-view-1",
  "forge-diff-view-1",
  "forge-inbox-view-1",
  "forge-messages-1",
  // WS11 D2 (stale-cache instant, context against the selected model)
  "cache-stale-at-1",
  "context-selected-model-1",
  // WS11 D3 (box-derived Settings fields)
  "devices-view-1",
  "forge-status-secondary-1",
  "update-targets-view-1",
  "upgrade-view-1",
  "launchers-flags-1",
  // WS11 D4 (accounts copy, row states)
  "accounts-copy-1",
  // WS11 D5 (naming, rename, proposed root)
  "sessions-naming-1",
  "forge-clone-view-1",
  // WS11 D6 (close flow)
  "sessions-close-1",
  // WS11 D7 (window status + job nesting)
  "sessions-window-status-1",
  // WS11 D8–D9 (message.view: turn footer, truncation, canonical media)
  "transcript-view-1",
  // WS11 D10 (plan question data)
  "questions-plan-1",
]);

export const CAPABILITY_ID_PATTERN = /^[a-z0-9-]+-\d+$/;
