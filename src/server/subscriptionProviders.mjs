// Subscription-provider registry + pure resolvers (BET-308, BET-309).
//
// The renderer UI is dumb on purpose: a single `IPC.opencodeProviderAuth`
// channel dispatches one of five actions (status / start / code / key /
// disconnect) and every rendering decision lives here. This file holds the
// registry of supported providers and the PURE functions that resolve an
// opencode auth-method array into a usable action. All HTTP I/O lives in
// src/server/opencode.mjs; this module never touches the network.
//
// Analogues: src/server/launcherRegistry.mjs (the AI-CLI TUI registry) and
// src/server/launchers.mjs (the availability probe over it). Mirror those
// files' shape — registry + a small findXxx — and add the auth-method
// resolver as the third leg. No provider-specific knowledge here other
// than the registry table itself.
//
// id        stable provider id, also opencode's auth-store key. NEVER reuse
//           or rename without a migration. Persisted in the user's
//           localStorage by the renderer.
// label     human label for the connect card.
// plan      the plan the user is paying for (Claude Pro/Max, ChatGPT
//           Plus/Pro, Kimi For Coding). Rendered on the connect card.
// prefer    ordered preference list for selecting an auth method. Each
//           entry's `type` and lowercased `match` are matched against an
//           opencode method's `type` and lowercased `label`. The first
//           match wins. An empty array means "do not use the prefer path"
//           (Kimi: opencode reports no auth methods, only the generic
//           API-key write works).
// detect    filesystem probe hints — files whose existence strongly
//           implies the provider is connected (e.g. Claude's credential
//           file). Reserved for a later stage's install-time detection
//           (BET-308 stage 2); ignored here.
// console   the web URL where the user creates an API key for this
//           provider, if any. Null where no separate console exists
//           (Claude: signed in via `claude` CLI; ChatGPT: signed in via
//           the OAuth flow itself).
// docs      the canonical "how to use this provider with opencode" doc.

export const SUBSCRIPTION_PROVIDERS = [
  {
    id: "anthropic",
    label: "Claude",
    plan: "Claude Pro / Max",
    prefer: [{ type: "oauth", match: "claude code account" }],
    detect: ["~/.claude/.credentials.json"],
    console: null,
    docs: "https://claude.com/pricing",
    // BET-354: tag that flags this row for the claude-login connect shape
    // + the `claude auth login` spawn path. Kept here (rather than
    // special-cased in describeConnectShape by id) so the registry table
    // remains the single source of truth — adding a second
    // Claude-auth-style provider later means adding a row, not editing a
    // branch. describeConnectShape consults this tag.
    authFlow: "claude-cli",
  },
  {
    id: "openai",
    label: "Codex",
    plan: "ChatGPT Plus / Pro",
    // Headless FIRST and deliberately: the browser variant redirects to
    // localhost:1455 ON THE BOX, which is unreachable from the user's laptop
    // or phone. Never let the browser variant win.
    prefer: [
      { type: "oauth", match: "headless" },
      { type: "oauth", match: "chatgpt" },
    ],
    detect: [],
    console: null,
    docs: "https://openai.com/chatgpt/pricing",
  },
  {
    id: "kimi-for-coding",
    label: "Kimi",
    plan: "Kimi For Coding",
    // opencode reports no auth methods for this provider; it takes the generic
    // API-key path. This empty array is correct, not an oversight.
    prefer: [],
    detect: [],
    console: "https://www.kimi.com/code/console",
    docs: "https://www.kimi.com/code/docs/en/third-party-tools/opencode.html",
  },
];

// Lookup by id. Mirrors findLauncher's shape exactly so the renderer can
// pattern-match against either without special-casing.
export function findSubscriptionProvider(id) {
  return SUBSCRIPTION_PROVIDERS.find((p) => p.id === id) || null;
}

// ---------------------------------------------------------------------------
// Auth-method resolution
// ---------------------------------------------------------------------------
//
// opencode's `GET /provider/auth` returns a per-provider array of auth
// methods, each `{ type, label, prompts? }`. The Codex headless method
// sits at index 1 today but opencode reorders freely across releases —
// matching by label + type is the only safe way to pick it. This is the
// standing rule from BET-308 ("never pass a literal method index") made
// into a function.

/**
 * Pick the best surviving auth method for `entry` from the array opencode
 * returned for this provider id. `methods` may be `null`/`undefined` (e.g.
 * Kimi reports `null` — there's no OAuth, only the API-key path).
 *
 * Selection rules, in order:
 *   1. `methods` null/undefined/empty → `null`. Caller treats null as
 *      "use the generic API-key path".
 *   2. Discard any method whose `prompts` array is non-empty. Multi-step
 *      prompt flows are out of scope for this epic (see BET-308). A
 *      provider whose only methods are discarded resolves to `null`.
 *   3. Walk `entry.prefer` in order. For each rule, return the first
 *      surviving method whose `type` equals the rule's `type` and whose
 *      `label`, lowercased, contains the rule's `match`, lowercased.
 *   4. Otherwise, fall back to the first surviving method with
 *      `type === "api"`.
 *   5. Otherwise return `null`.
 *
 * The returned `index` is the method's index into the ORIGINAL `methods`
 * array, not the filtered one — that is what gets POSTed to opencode.
 *
 * @param {object} entry     a SUBSCRIPTION_PROVIDERS row
 * @param {Array<{type:string,label?:string,prompts?:Array<unknown>}>|null|undefined} methods
 * @returns {{index:number, method:object}|null}
 */
export function resolveAuthMethod(entry, methods) {
  if (!methods || !Array.isArray(methods) || methods.length === 0) return null;

  const surviving = methods
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => !Array.isArray(m?.prompts) || m.prompts.length === 0);

  // Prefer rules first (in registry order).
  for (const rule of entry?.prefer ?? []) {
    const wantType = rule?.type;
    const wantMatch = String(rule?.match ?? "").toLowerCase();
    for (const { m, i } of surviving) {
      if (m?.type !== wantType) continue;
      const label = String(m?.label ?? "").toLowerCase();
      if (label.includes(wantMatch)) return { index: i, method: m };
    }
  }

  // Generic API-key fallback.
  for (const { m, i } of surviving) {
    if (m?.type === "api") return { index: i, method: m };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Connect shape
// ---------------------------------------------------------------------------
//
// The renderer needs to know which UI to render for a given provider:
//   "oauth-auto"    — paste-back flow where the user opens a URL on their
//                     own device and types a device code back. The renderer
//                     shows the URL + the "Enter the code shown on the page"
//                     input.
//   "oauth-code"    — paste-back flow where opencode returns a short code
//                     AND the auth URL. The renderer shows the code and the
//                     URL (the user can copy either). Same renderer UX as
//                     auto; the distinction matters for callers that want
//                     to know whether to display the inline code.
//   "api-key"       — the user pastes an API key into a password input.
//   "claude-login"  — Claude-specific (BET-354). opencode's anthropic
//                     auth-method has type "oauth" but the authorize URL is
//                     empty (Anthropic is a passthrough over
//                     ~/.claude/.credentials.json; the only way to write
//                     that file is to run `claude auth login` on the box).
//                     The renderer mounts a live terminal pane, extracts the
//                     OAuth URL from the stream, and lets the user paste the
//                     Anthropic callback code back. Resolved by
//                     `describeConnectShape` ONLY when the resolved oauth
//                     method has an empty url AND the registry id is
//                     "anthropic" — the explicit-id gate is what keeps the
//                     shape Claude-specific (BET-354: "Do not special-case
//                     Claude in the components — but the registry CAN
//                     special-case it because the policy lives here").
//
// Resolved by `describeConnectShape(resolvedMethod, authorizeResponse, id)`:
//   id === "anthropic" && resolvedMethod.method.type === "oauth"
//       && (oauthResponse?.url == null || oauthResponse.url === "")
//                                                         → "claude-login"
//   resolvedMethod == null                               → "api-key"
//   resolvedMethod.method.type === "api"                 → "api-key"
//   authorizeResponse?.method === "code"                 → "oauth-code"
//   otherwise                                            → "oauth-auto"

/**
 * @typedef {{ok:true, url:string, method?:string, instructions?:string} | {ok:false, error:string, detail?:string} | null | undefined} AuthorizeResponse
 */

/**
 * Pick the connect-card shape from the resolved method + opencode's
 * authorize response + the registry id.
 *
 * @param {{index:number,method:object}|null} resolvedMethod  result of resolveAuthMethod
 * @param {AuthorizeResponse} authorizeResponse               opencode's authorize response (ok/ok-false/null)
 * @param {string} [id]                                       registry id; gates the Claude-specific shape
 * @returns {"oauth-auto"|"oauth-code"|"api-key"|"claude-login"}
 */
export function describeConnectShape(resolvedMethod, authorizeResponse, id) {
  if (resolvedMethod == null) return "api-key";
  if (resolvedMethod.method?.type === "api") return "api-key";
  if (id === "anthropic" && resolvedMethod.method?.type === "oauth") {
    // opencode's anthropic authorize returns an empty URL because Claude
    // auth is a passthrough over `~/.claude/.credentials.json`. Route to
    // the live-terminal connect shape instead of pretending we got a URL.
    const url = typeof authorizeResponse?.url === "string" ? authorizeResponse.url : "";
    if (!url) return "claude-login";
  }
  if (authorizeResponse?.method === "code") return "oauth-code";
  return "oauth-auto";
}

// ---------------------------------------------------------------------------
// Status projection
// ---------------------------------------------------------------------------
//
// `status` action payload: one row per registry entry, marked connected
// based on opencode's `GET /provider` `connected[]`. Registry order is
// preserved — the renderer's connect card lists providers in the same
// order the registry declares them.

/**
 * @typedef {object} SubscriptionStatus
 * @property {string} id         provider id from the registry
 * @property {string} label      human label
 * @property {string} plan       the plan the user is paying for
 * @property {string|null} console  where to mint a key, or null
 * @property {string} docs       canonical setup doc URL
 * @property {boolean} connected  true iff id ∈ connected
 */

/**
 * @param {string[]} connected  the `connected[]` array from opencode's GET /provider
 * @returns {SubscriptionStatus[]}
 */
export function subscriptionStatuses(connected) {
  const set = new Set(Array.isArray(connected) ? connected : []);
  return SUBSCRIPTION_PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    plan: p.plan,
    console: p.console,
    docs: p.docs,
    connected: set.has(p.id),
  }));
}
