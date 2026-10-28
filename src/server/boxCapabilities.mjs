// boxCapabilities.mjs — the ONE list of server-first capabilities this box
// advertises (master D25). Returned as `capabilities: string[]` from
// GET /api/version and the `server:version` RPC. A client on an older box finds
// an id missing and hides / disables the dependent feature with "Update your
// box to use this" — there is no fallback copy of the moved logic on a client.
//
// Ids are `kebab-name-N` (N bumps when a capability's shape changes
// incompatibly). Every later workstream APPENDS its ids here; nothing else may
// create a second capability list.

export const BOX_CAPABILITIES = Object.freeze(["chat-cards-1"]);

export const CAPABILITY_ID_PATTERN = /^[a-z0-9-]+-\d+$/;
