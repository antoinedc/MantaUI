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
]);

export const CAPABILITY_ID_PATTERN = /^[a-z0-9-]+-\d+$/;
