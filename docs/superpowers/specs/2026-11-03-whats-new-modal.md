# "What's new" after an update — design

Status: approved for implementation (rev 2, after Astra review) · 2026-11-03 ·
Desktop only

Mockups: proposal **B** (highlight cards) with **A** (release notes) as the
fallback — https://3655737043030f5927b6c531f05ea650.boxes.mantaui.com/pages/whats-new-proposals

## Goal

When the desktop app connects to a server whose changelog has a release this
device has not acknowledged yet, show one "What's new" window. Shown once per
release per device per server. Identical behaviour whether the server was
updated by the production release process or by `git pull` + restart on a dev
checkout, so the feature can be exercised before a release.

Non-goals: iOS (later), website changelog, notifications/push, announcing
desktop-only updates (see "Known limits").

## Behaviour

### Trigger — the server's changelog, not its version or commit

1. The server parses its own `CHANGELOG.md` and serves the newest 10 entries
   plus its own server id (`box_id`).
2. The desktop keeps, per server id, a map of acknowledged entries
   `{ [version]: fingerprint }` (fingerprint = sha256 of the entry's raw
   section text), bounded to the 50 most recent versions.
3. The desktop fetches the entries:
   - when the connection goes live and on every reconnect (the effect that
     already runs the server-update check, `App.tsx` ~1126);
   - when the upgrade gate clears (the gate-cleared callback, `App.tsx`
     ~1813), because a reconnect during an upgrade gets a 503 and the upgrade
     can finish on the same connection.
   A response is dropped if the API generation / server changed while it was
   in flight.
4. Decision (pure function, `src/shared/whatsNew.mjs`), entries newest first:

| Stored for this server | Result |
|---|---|
| no record (first pair, new server id, fresh install) | record every returned entry silently, show nothing |
| entry's version never acknowledged | unseen |
| newest entry, version acknowledged, fingerprint differs (entry edited) | unseen |
| older entry, version acknowledged, fingerprint differs | **not** unseen (rewording old entries must not re-announce them) |
| version acknowledged, fingerprint equal | not unseen |

   Show the window if anything is unseen (newest 5 at most). Consequences:
   ordinary restarts show nothing; skipped releases are included; rolling the
   server back to an acknowledged release and re-upgrading shows nothing;
   editing the newest entry (the dev testing loop) shows it again.
5. Closing the window (Got it, ×, Escape, overlay click, or a card action)
   records **every returned entry** as acknowledged. A crash before closing
   shows it again next time.
6. It never opens over the upgrade gate, onboarding/pairing, Settings, or
   another modal; pending content waits until they close.
7. No server id in the response (unpaired / auth disabled) → automatic display
   is skipped entirely (nothing to key storage on). Manual open still works.

Why the changelog rather than the commit: a pull that changes no user-facing
text has nothing to announce, and a pull that adds/edits a changelog entry is
exactly what to test. Both update paths restart a server whose `CHANGELOG.md`
moved — one behaviour.

### Content per entry

Each changelog entry may carry an optional highlights block, invisible on
GitHub because it is an HTML comment directly under the heading:

```md
## 1.2.0 — Server + Desktop — 2026-11-01

<!-- highlights
headline: Routines are here
items:
  - title: Routines
    icon: repeat
    text: Recurring work in a fresh session each run, with a report you can follow up on.
    action: routines
  - title: Cheaper handoffs
    icon: arrow-left-right
    text: Cold-cache handoffs are written by a cheap model from a condensed transcript.
    action: settings:models
-->

Ships: …
```

- `items`: 1–3. `headline` optional (default "What's new in Manta X.Y.Z").
- `icon` — exactly one of (lucide names): `sparkles` (default), `repeat`,
  `arrow-left-right`, `refresh-cw`, `zap`, `message-square`, `terminal`,
  `folder`, `settings`, `shield`, `bell`, `mic`, `gauge`, `git-branch`,
  `calendar-clock`. Unknown → `sparkles`.
- `action` — optional, exactly one of: `routines` (opens the Routines list,
  `setRoutinesView({page:"list"})`), or `settings:<id>` where `<id>` is one of
  `general, box, accounts, models, sessions, files, extensions, secrets,
  voice` (from the existing `SETTING_SECTIONS` in
  `src/shared/settingsSchema.ts` — no second list; `cto` is excluded because
  it is build-gated). Validated on the server (invalid → `null`) AND again in
  the renderer against what this desktop build can actually open (unavailable
  → card shows no link). Never a dead link.
- An invalid block (bad YAML, wrong shape, >3 items) is ignored as if absent
  and logged server-side with `console.warn`; the entry falls back to release
  notes.

### The window

- **Newest unseen entry has highlights → B**: hero (eyebrow `MANTA 1.2.0`,
  headline, line "New on your server."), up to 3 cards, then "+ N smaller
  changes · See all" which expands the entry's full notes in place. If older
  unseen entries exist, a quiet footer line "Also new since you last looked:
  1.1.0" whose link expands those notes too.
- **No highlights → A**: eyebrow `UPDATED · 1.1.0 → 1.2.0` (the "from" part
  only when a previously acknowledged version exists), title "What's new in
  Manta 1.2.0", component chips, then the rendered notes of every unseen entry
  (newest first, max 5).
- Footer: "Full changelog ↗" (opens
  `https://github.com/antoinedc/MantaUI/blob/main/CHANGELOG.md` externally)
  and a primary **Got it**.
- A card's link performs its action, then closes the window (acknowledged).
- Rendered notes drop the `Ships: …` paragraph (tag names are noise).
- **Wording: "server", never "box".** Chips map `Box`/`Server` → **Server**,
  `Desktop` → **Desktop**; iOS / Website / Gateway chips are not shown. The
  release skill writes "server" from now on, and the five newest existing
  entries are reworded "box" → "server" in user-facing text (safe: rule 4 does
  not re-announce reworded older entries; the newest is only re-shown to
  devices that had already acknowledged it, and no device has yet).
- Existing `Modal` primitive (size `lg`, 560px, `tall`), existing tokens,
  existing `MarkdownBody` renderer (no raw-HTML plugin, URL filtering kept).
  Light + dark theme.

### Re-opening (manual)

Settings → About gets a **What's new** link. Clicking it:
1. shows a busy state on the link while it fetches;
2. on success closes Settings, then opens the window for the newest entry
   (stored acknowledgements are not changed);
3. `unavailable`, empty, or an old server without the channel → toast
   "This server has no release notes yet.";
4. any other failure → error toast "Couldn't load release notes from the
   server — try again." (class-1 consumer: a human literal, never raw error
   text).

## Contracts

### RPC `server:changelog` (server → desktop)

```ts
// request: {}  response:
{ serverId: string | null;      // box_id from the auth store; null if none
  entries: Array<{
    version: string;            // "1.2.0"
    date: string | null;        // "2026-11-01"
    components: string[];       // ["server","desktop"] — normalised, lowercase; "box" → "server"
    fingerprint: string;        // sha256 hex of the raw section text
    headline: string | null;
    highlights: Array<{ title: string; text: string; icon: string; action: string | null }>;
    markdown: string;           // section body, highlights comment + "Ships:" paragraph removed
  }>;                           // newest first, at most 10
  unavailable?: true;           // CHANGELOG.md missing/unreadable → entries: []
}
```

- Wired like the other `server:*` channels: `src/server/rpc.mjs`,
  `src/renderer/api/httpApi.ts`, `src/shared/api.ts`.
- Source: `new URL("../../CHANGELOG.md", import.meta.url)` from the module
  under `src/server/` — never the process cwd. Re-read when mtime changes,
  otherwise cached.
- A read/parse failure returns `{serverId, entries:[], unavailable:true}` and
  logs with `console.warn`; it never throws a 500 (class-1 consumer).
- Entries whose heading has no semver version are skipped.
- Parsing is a pure function over the file text (tested with fixtures), in
  `src/server/changelog.mjs`, shared with `scripts/release/check-changelog.mjs`.

### Desktop storage

`localStorage["manta:whats-new:<serverId>"] = { versions: { [version]: fingerprint } }`,
bounded to 50 versions. Per device, per server id. Not synced.

### Packaging

- Fresh install: `install.sh` materialises the release commit's full git tree,
  so `CHANGELOG.md` is present.
- Packaged self-update: replaces only the tarball's release-owned paths, and
  the tarball does not include `CHANGELOG.md` → the file goes stale.
  **Fix:** add `CHANGELOG.md` to `INCLUDE` in `scripts/release/pack.mjs` (it
  then becomes release-owned and is replaced on every update).
- Dev checkout (`git reset --hard` / `git pull`): always current.
- Tests: pack includes the file; a payload replacement over an existing stale
  `CHANGELOG.md` yields the new one (fixture-based, using whatever harness
  the existing self-update/pack tests use).

## Release skill change (`.opencode/skills/release-manta/SKILL.md`)

Step 4 gains:

- Write "server" (not "box") in user-facing changelog text; the heading's
  component label is `Server`.
- **Decide on highlights.** Add a block only if the release has 1–3 changes a
  user would want to go and try (a new capability or a visibly new surface).
  Fixes, polish and internal work never qualify. Zero → no block (the window
  shows release notes). Never pad to 3.
- Each item: title ≤ 3 words, text ≤ 110 chars, icon and action from the
  allowed lists (copied into the skill).
- Validate with `node scripts/release/check-changelog.mjs` (new; runs the
  server's parser on `CHANGELOG.md`; exits non-zero on an invalid block or an
  unknown icon/action, and prints what the newest entry will show).

The repo copy is the source of truth; after merge, copy it to
`~/.config/opencode/skills/release-manta/SKILL.md` on this box.

## Known limits

- A desktop-only update with no new changelog entry on the server announces
  nothing. Releases ship server + desktop together with one changelog entry,
  so in practice the server's update carries the announcement.
- The release that introduces this feature is not announced: every desktop
  baselines silently on first connect. The first announcement is the next
  release (or any changelog edit pulled onto a dev server).

## Libraries considered

| Need | Chosen | Considered / why |
|---|---|---|
| Split CHANGELOG.md into versioned entries | `unified` 11.0.5 + `remark-parse` 11.0.0 (MIT; already dependencies; 85M / 78M weekly; repos unifiedjs/unified 5.0k★ pushed 2026-10-03, remarkjs/remark 9.0k★ pushed 2026-09-27): split at level-2 headings, read the highlights comment as an `html` node, slice raw text by node offsets (verified by the reviewer) | `changelog-parser` 4.1.0 (ISC, 1 dep, 43k/wk, 82★, pushed 2026-11-01): tried against our file — versions and dates parse, but it **strips HTML comments** (highlights lost) and returns no raw section for the fingerprint; `keep-a-changelog` 3.2.0 (MIT, 2 deps, 20k/wk, 71★): requires `## [x.y.z] - date` headings, ours are `## x.y.z — … — date`; regex split: rejected per library rule |
| Parse the highlights block | `yaml` 2.9.1 (ISC, 0 deps, 313M/wk, eemeli/yaml 1.7k★ pushed 2026-09-23; already a dependency) | — |
| Render notes markdown | `react-markdown` 10.1.0 + `remark-gfm` 4.0.1 (MIT; 53M / 65M weekly; react-markdown 15.9k★ pushed 2026-10-03; already used via `MarkdownBody`) | — |
| Icons | `lucide-react` (ISC, 0 deps, 125M/wk, lucide 25.5k★ pushed 2026-11-03; already used) — static map of the 15 allowed icons | dynamic icon-by-name import: rejected, bundles every icon |
| Modal chrome, focus trap, Escape | existing `Modal` primitive | a dialog library: the app standardised on its own primitive (BET-588) |
| Version ordering | none — the file is newest-first and the decision is by version key, not ordering | `semver` 7.8.6: unnecessary |
| Fingerprint | `node:crypto` sha256 | — |
| "Seen" storage | `localStorage` | server-side store: acknowledgement is per device by design |

## Tests

- Server (node:test, `src/server/changelog.test.mjs`): parsing the real
  `CHANGELOG.md` and fixtures; highlights valid / bad YAML / >3 items / unknown
  icon / invalid action / `cto` action; `Ships:` removal; component
  normalisation; missing file → `unavailable`; mtime cache; path resolution
  independent of cwd; `serverId` from an injected auth loader (never the real
  `~/.manta/auth.json`).
- Pure decision (`src/shared/whatsNew.test.ts`): every row of the decision
  table, plus rollback/re-upgrade, reworded-older-entry, bound of 50, cap of 5.
- Renderer: B with highlights, A without; multi-entry; card action navigates +
  acknowledges; action unavailable in this build → no link; never opens while
  the upgrade gate / Settings is open; refetch on gate clear; stale response
  after server switch dropped; About link — success, unavailable toast, error
  toast, storage unchanged.
- Packaging: pack includes `CHANGELOG.md`; stale-file replacement.
- `check-changelog.mjs` passes on the current file.

## Manual test (dev box)

1. Pair desktop → no window (baseline).
2. On the server checkout, add a `## 1.3.1 — Server + Desktop — …` entry with a
   highlights block, restart manta-server → desktop reconnects → window B.
3. Close; restart again → nothing.
4. Edit that entry (e.g. remove the highlights block), restart → window A.
5. Settings → About → What's new → window opens; restart → nothing new.
