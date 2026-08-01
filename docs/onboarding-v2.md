# Onboarding v2 — conversational setup

Status: **design agreed, not implemented.** This document is the decision record.
Every "locked" item below was decided explicitly; do not re-litigate them in an
implementation PR.

---

## 1. Why

Today's first run is a 4-step modal wizard (`src/renderer/Onboarding.tsx`):
pair → providers → model → first project. It ends exactly where the work begins:
one empty project, one setting configured (`defaultModel`), and nothing verified.

Concrete failures observed in the current flow:

- **Anthropic cannot be connected from the app at all.** `ProvidersStep.tsx:176-185`
  renders a dead end: "Requires setup on the box … run `opencode auth login`".
  This is step 2 of 4 — the biggest cliff is also the earliest.
- **~24 settings exist in `AppConfig` (`src/shared/types.ts:10-163`); the wizard
  touches one.** Everything else is found by accident.
- **"Skip setup" doesn't work when unpaired.** `Onboarding.tsx:135-138` persists
  `onboardingSkipped`, but `resolveTransportMode` (`src/shared/transport.mjs:63-67`)
  deliberately ignores that flag, so `App.tsx:66-68` immediately re-latches. The
  "Open Settings to connect to your box" empty state is therefore unreachable.
- **Steps 2–4 have no skip**, only Back.
- **Nothing is verified.** Push in particular has never been verified end to end
  (`docs/launch-e2e.md:795-797` marks it human-required and never-reached).

The underlying problem is not a missing screen. Setup is a long tail of decisions
whose right questions depend on earlier answers and on what's actually on the box.
A static form cannot sequence that. An agent can — and Manta already has one
running on the box.

---

## 2. Locked decisions

| # | Decision | Consequence |
|---|---|---|
| D1 | **No dedicated "Manta" workspace.** Setup runs as the first chat session inside the user's first *real* project. | No orphan project, no pinned special workspace, no origin-scoped privilege boundary. |
| D2 | **Clearing the setup session means the user is done.** | No durable setup checklist, no resume logic, no nagging. The transcript *is* the state. |
| D3 | **Opinionated defaults, displayed, never asked.** No open-ended questions. One card shows every default with per-row override. | `ModelStep` (a radio list) is deleted and replaced by a defaults card. |
| D4 | **The agent proposes; the renderer applies.** No agent-side config write path exists. | No new config write endpoint, no server-side write blocklist to enforce, no config cache-coherency risk, no `settings_set`. One code path. |
| D5 | **Scope is Manta configuration only.** The setup agent never provisions the box (no installs, no package managers, no auth for third-party CLIs). | `box_scan` is strictly read-only and reports findings; it never remediates. |
| D6 | **iOS native only. Web Push (VAPID) is removed.** | Whole subsystem deleted, `web-push` dependency dropped, service worker deleted. |
| D7 | **Push verification is an onboarding step**, last, with a real delivery+tap acknowledgement. | Requires a new ack endpoint; the test push must be blocking-tier. |

### D3 — the exact defaults

| Setting | Value |
|---|---|
| Main model | Opus-class (highest-context Anthropic model available) |
| Subagent model | Sonnet-class |
| `worktreePerSession` | `true` |
| `worktreeCleanOnClose` | `true` |
| `cacheTtl` | `"1h"` |
| `autoRenameSessions` | `true` |
| `chatAutoAllow` | `true` |

`chatAutoAllow: true` is a deliberate product choice: it is what makes an
autonomous box agent usable. Its consequences are accepted:

- Prompt injection from repo content or fetched pages becomes actionable with no
  human in the loop, from first launch.
- The user **must see it on the defaults card**. Shown-and-default is acceptable;
  silent-and-default is not.
- **The settings-approval card must never be built on opencode's permission
  mechanism.** `src/server/index.mjs:329-354` auto-replies `"always"` to every
  `permission.asked` when `chatAutoAllow` is on, without inspecting the category.
  A settings approval routed through permissions would be auto-approved and never
  rendered. This is the single hard invariant of the design.

Defaults degrade to what is actually connected: if only one provider with one
model is available, state what is being used rather than presenting a choice.

---

## 3. Target flow

### 3.1 Cold-start floor (stays a modal wizard)

You cannot chat your way to a working chat. The irreducible floor is: reach the
box, have one provider, have one model.

```
1. Pair                (unchanged)
2. Providers           + in-app Anthropic sign-in (§4.1)
3. Defaults card       (replaces the model radio list)
4. First project       seeded from the box scan, not typed by hand
   → opens the setup chat session
```

Expected duration: ~30s if credentials already exist on the box, ~90s otherwise.

### 3.2 Setup conversation

Runs as the first chat session in the project created by step 4. Order:

1. **Scan** — findings, not questions (§4.3).
2. **Propose additional workspaces** from the scan, with worktree fan-out.
3. **Model split** — main vs subagent, explained in cost/latency terms.
4. **Optional extras, offered not forced** — voice, plugins, downloads dir, skill
   registries, analytics. Each with a one-line "why you'd want this".
5. **Mobile + push verification** (§4.5) — last, framed as the payoff.
6. **Graduation** — a real first task, so the session ends with work done.

Every step is skippable. Nothing blocks. Quitting mid-way and returning works for
free: the tmux window and its transcript survive, and the agent re-reads them.

### 3.3 After setup

The user clears the session (D2) and keeps the project. There is no further
onboarding state anywhere in the system, with one exception: a single boolean
recording whether push was ever successfully verified, so Settings can
distinguish "never set up" from "set up and now broken".

---

## 4. Components

### 4.1 In-app Anthropic sign-in

Verified facts:

- The binary is at `~/.local/bin/opencode` and is reachable through a login shell
  (`bash -lc`), which is exactly how `spawnShellPty` (`src/server/pty.mjs:41-84`)
  invokes commands (`$SHELL -l -c "<bin> <args>"`).
- `opencode auth login [url]` takes **no provider argument** — the optional `url`
  is for custom endpoints. The provider is picked from an interactive TUI list.
  Therefore the flow runs `opencode auth login` bare and lets the user choose.
- Credentials land in `~/.claude/.credentials.json`; `src/server/claudeAuth.mjs`
  already has pure predicates for parsing and expiry (`parseCredentials:33`,
  `isRefreshTokenExpired:61`).

Design: reuse the existing launcher registry rather than adding a command
parameter to the PTY layer. `src/server/launcherRegistry.mjs` already models
"run a named CLI in a PTY"; add one hidden entry and `spawnShellPty` needs no
change at all. The renderer reuses `Terminal.tsx` unchanged, polls
`opencodeModels()` until `anthropic` appears in the connected set, then advances.

No output parsing anywhere. The user drives a real terminal; we only detect the
resulting state change.

Deletions: the "Requires setup on the box" status text and the hint block at
`ProvidersStep.tsx:150, 176-185`, and the stale out-of-scope comment at `:26-27`.

### 4.2 Settings proposals (agent proposes, renderer applies)

D4 collapses this to something much smaller than a settings-write API.

- **Read** — one REST endpoint returns the current config with secret-bearing
  fields redacted, plus a static per-field description table so the agent does
  not invent explanations.
- **Propose** — the agent POSTs a change set. The server validates it against an
  allowlist of proposable fields and stores it as a *pending proposal*. Nothing
  is written to config.
- **Apply** — a card in the chat panel renders the pending proposal as
  before → after rows. Approve calls the existing `configUpdate` +
  `refresh()` path from the renderer. Reject discards.

Consequences that fall out for free:

- No new config write path; `local.configUpdate` and its in-memory cache
  (`src/server/local.mjs:52-94`) stay the sole writer, so there is no
  cache-coherency bug to design around.
- The open Settings panel cannot be clobbered, because approval flows through the
  same `refresh()` the panel already reacts to.
- The agent structurally cannot re-enable `chatAutoAllow` behind the user's back,
  because it cannot write anything.
- Fields that are meaningless or harmful for an agent to propose (`serverUrl`,
  `boxId`, `boxToken`, `projects`, `pluginsEnabled`, `groqApiKey`) are simply
  absent from the allowlist. `pluginsEnabled` is additionally Mac-local
  (`src/main/config.ts`) and unreachable from the box.

Card construction follows the existing pinned-resource pattern
(`src/renderer/PanelCards.tsx` + `src/renderer/hooks/useSessionResources.ts`),
poll-driven like schedules/secrets/webhooks. It renders unconditionally when a
proposal is pending — no toolbar toggle — placed in the `ChatPanel.tsx` stack
next to `PermissionCard`.

### 4.3 Box scan (read-only)

Nearly every primitive already exists and should be composed, not rewritten:

| Signal | Existing source |
|---|---|
| tmux sessions, windows, live cwds, chat/TUI type | `tmux.listProjects()` (`src/server/tmux.mjs:77`) |
| git worktrees for a directory | `local.gitListWorktrees()` (`src/server/local.mjs:153`) |
| git dirty-file count + parser | `peers.mjs:180` + pure `parseGitStatus:69` |
| current branch | `opencode.mjs:935` (`git branch --show-current`) |
| single-level directory listing | `local.fsListDirs()` (`src/server/local.mjs:274`) |
| Anthropic credential state | `claudeAuth.mjs` predicates |
| connected providers / models | `providers.getProviders()`, `opencode.listModels()` |

The only genuinely new piece is a **bounded recursive repo discovery walk**
(there is no "find all git repos" primitive today). It must be depth- and
count-bounded and must never descend into `node_modules`, `.git`, or similar.

Output is a structured inventory. It never remediates (D5).

### 4.4 Onboarding restructure

- `ModelStep.tsx` is deleted, replaced by a defaults card that shows the D3 table
  and writes all of it in one `configUpdate`.
- `FirstProjectStep.tsx` stops asking for a name and a path; it offers the top
  scan candidates and creates from one of them, falling back to the current
  manual entry only when the scan finds nothing.
- The dead `onboardingSkipped` flag and the broken skip path are removed rather
  than repaired — with the floor down to four short steps and a real skip on
  every one, a persisted "skipped forever" flag has no remaining purpose.

### 4.5 Push verification

Current state, verified:

- **Web Push is already dead on any auth-enforced box.** Every fetch in
  `src/renderer/mobile/push.ts` sends only `content-type`, and the auth gate
  (`src/server/index.mjs:713-733`) covers all of `/push/*`; the `?token=` fallback
  is allowlisted to `/events` and `/pty` only (`src/server/auth.mjs:206-226`). So
  `/push/vapid`, `/push/subscribe`, `/push/focus`, `/push/answer` all 401.
- **`reportFocus` never fires on the native app** — it is gated on
  `isPushSupported()`, which is false in the Capacitor WebView. So
  `mobileViewingThis` in `routeNotification` (`src/server/push.mjs:343-346`) is
  always false today. Removing the focus path is behaviour-preserving.
- **There is no delivery or tap acknowledgement anywhere.** APNs status is
  classified into `{ok, prune}` for token pruning and discarded. The native tap
  handler (`src/renderer/mobile/nativePush.ts:131-145`) dispatches a local
  `CustomEvent` and reports nothing to the box.

Therefore D6 (remove Web Push) is mostly a deletion, and D7 needs one new authed
ack endpoint plus an ack call from the existing native tap handler.

The verification step itself:

- Test push goes out on the **blocking tier** (`notifTier`, `push.mjs:312-317`),
  because the user is by definition active at the desktop during onboarding and
  informational pushes are suppressed in that state
  (`routeNotification`, `push.mjs:354-357`). The UI copy should explain that
  suppression rule as a feature.
- Green requires the round trip: sent → delivered → tapped → acked.
- Skippable ("no phone on me"); it does not block graduation.

Failure modes must be distinguished, because the fix differs for each:

1. App not installed → show install link + QR, poll for device registration.
2. Installed but not paired → pairing QR.
3. iOS notification permission denied at first launch → OS settings deep link.
4. Device token never reached the gateway → registration failure, visible
   server-side.
5. Box cannot reach the push gateway → egress problem, not user error.
6. Focus / DND swallowed it → delivered but not displayed. Distinguishable only
   with a delivery signal; without a Notification Service Extension
   (`mutable-content` is not set today, `src/gateway/apns.mjs:148-158`) this
   collapses into "sent but no tap".
7. App in foreground → iOS suppresses the banner by default.

Known trap: `App.entitlements` hardcodes `aps-environment: production`, while a
local Xcode debug build gets a *sandbox* token. The gateway always talks to
`api.push.apple.com`. Verification therefore only works on a TestFlight or
App Store build, never a local debug build.

---

## 5. Tool surface

All follow the existing manta-native opencode tool pattern
(`docs/manta-tools-scheduler.md`): a thin registrar copied — never symlinked —
into `~/.config/opencode/tools/`, `fetch`ing manta-server on `127.0.0.1:8787`
with a `Bearer` token read from `~/.manta/auth.json`.

| Tool | Purpose |
|---|---|
| `settings_get` | Read config, secrets redacted, with field descriptions. |
| `settings_propose` | Submit a change set for user approval. Cannot write. |
| `box_scan` | Read-only inventory of the box. |

Note the registered tool id is `<filename>_<exportName>`, so a file named
`settings.ts` exporting `get` and `propose` yields `settings_get` and
`settings_propose`.

Deliberately **not** built:

- `settings_set` — D4 removes the need; one path only.
- `workspace_create` — the setup agent proposes workspaces; the user creates them
  through the existing UI. Adding a creation tool would duplicate a code path
  that already exists in two places (`Sidebar.tsx`, `MobileCreateSheet.tsx`).
- Anything that installs or provisions (D5).

---

## 6. Build order

1. Remove Web Push; iOS-native APNs only. (Pure deletion, independent.)
2. In-app Anthropic sign-in. (Independent, highest single friction removal.)
3. Box scan module + tool. (Independent.)
4. Settings proposal tool + approval card. (Independent.)
5. Onboarding restructure — defaults card, scan-seeded first project, hand-off to
   the setup chat. (Depends on 2, 3, 4.)
6. Push ack + onboarding push-verification step. (Depends on 1, 5.)

Steps 1–4 are independently shippable and independently valuable. 5 is what makes
the flow conversational; 6 is what makes it trustworthy.
