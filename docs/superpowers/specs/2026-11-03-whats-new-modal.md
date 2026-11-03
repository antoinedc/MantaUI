# "What's new" after an update — design

Status: draft for review · 2026-11-03 · Desktop only

Mockups: proposal **B** (highlight cards) with **A** (release notes) as the
fallback — https://3655737043030f5927b6c531f05ea650.boxes.mantaui.com/pages/whats-new-proposals

## Goal

The first time the desktop app connects to a server whose changelog has moved
on since this device last looked, show one "What's new" window. Shown once,
then never again for that content. Identical behaviour whether the server was
updated by the production release process or by `git pull` + restart on a dev
checkout, so the feature can be exercised before a release.

Non-goals: iOS (later), a changelog for the website, notifications/push.

## Behaviour

### Trigger — the server's changelog, not its version or commit

1. The server parses its own `CHANGELOG.md` and serves the newest entries.
2. The desktop remembers, per paired server, the last entry it acknowledged:
   `{version, fingerprint}` (fingerprint = sha256 of that entry's raw section).
3. On connect and on every reconnect (the same moment the server-update check
   already runs), the desktop fetches the entries and decides:

| Stored | Server's newest entry | Result |
|---|---|---|
| nothing (first pair / fresh install) | anything | store it silently, show nothing |
| `1.2.0` / fp X | `1.2.0` / fp X | nothing |
| `1.2.0` / fp X | `1.2.0` / fp Y (entry edited) | show that entry |
| `1.1.0` | `1.3.0` (1.2.0 skipped) | show every entry above `1.1.0` in file order |
| `0.9.0` (no longer in the file) | `1.3.0` | show the newest entry only |

Why the changelog rather than the commit: a pull that changes no user-facing
text has nothing to announce, and a pull that adds/edits a changelog entry is
exactly the thing to test. Both paths now restart a server whose
`CHANGELOG.md` moved — one behaviour.

4. "Acknowledged" is written when the window closes (Got it, ×, Escape,
   overlay click). A crash before closing shows it again next time.
5. It never opens over the upgrade gate, onboarding/pairing, or another
   modal; it waits until those close.

### Content per entry

Each changelog entry may carry an optional highlights block, invisible on
GitHub because it is an HTML comment:

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
- `icon`: one of a fixed list (lucide names, mapped in the renderer). Unknown
  → a neutral default icon.
- `action`: optional, one of a fixed list — `routines`, `settings:<section>`
  for an existing settings section id. Unknown/invalid → the card renders
  with no link (never a dead link).
- An invalid block (bad YAML, wrong shape) is ignored as if absent and logged
  server-side; the entry falls back to release notes.

### The window

- **Newest unseen entry has highlights → B**: hero (eyebrow `MANTA 1.2.0`,
  headline, one line "Your server and desktop were updated."), up to 3 cards,
  then a one-line "+ N smaller changes · See all" row that expands the full
  notes in place. If older unseen entries exist, a quiet footer line
  "Also new since you last looked: 1.1.0" whose link expands those notes too.
- **No highlights → A**: eyebrow `UPDATED · 1.1.0 → 1.2.0`, title "What's new
  in Manta 1.2.0", component chips, then the rendered notes of every unseen
  entry (newest first, max 5, then "Full changelog ↗").
- Footer: "Full changelog ↗" (opens the GitHub CHANGELOG.md externally) and a
  primary **Got it**.
- A card's link performs its action and closes the window (acknowledged).
- Rendered notes drop the `Ships: …` paragraph (tag names are noise to users).
- **Wording: "server", never "box".** Component chips map the changelog's
  `Box`/`Server` → **Server**, `Desktop` → **Desktop**; iOS/Website/Gateway
  chips are not shown (desktop-only feature). The release skill writes
  "server" from now on (see below), and the newest five existing entries
  (the most the window can show) are reworded "box" → "server" in
  user-facing text.
- Uses the existing `Modal` primitive (size `lg`, 560px), existing tokens,
  existing markdown renderer. Light + dark theme.

### Re-opening

Settings → About gets a **What's new** link that opens the same window for the
newest entry (does not change the stored acknowledgement). Needed because the
window is one-shot, and useful for testing.

## Contracts

### RPC `server:changelog` (box → desktop)

```ts
// request: {}  response:
{ entries: Array<{
    version: string;            // "1.2.0"
    date: string | null;        // "2026-11-01"
    components: string[];       // ["server","desktop"] — normalised, lowercase
    fingerprint: string;        // sha256 hex of the raw section
    headline: string | null;
    highlights: Array<{ title: string; text: string; icon: string | null; action: string | null }>;
    markdown: string;           // section body, highlights comment and "Ships:" paragraph removed
  }>                            // newest first, at most 10
} | { entries: [], unavailable: true }   // no CHANGELOG.md readable
```

- Source: `CHANGELOG.md` at the server's install root (resolved from the
  server module's own path, never the process cwd). Re-read when its mtime
  changes; otherwise cached.
- Class-2 error contract (BET-1460): a read/parse failure returns
  `{entries:[], unavailable:true}`, never a 500. The desktop then shows nothing.
- Entries whose heading has no semver version are skipped.
- `action` values are validated server-side against the allowlist; invalid →
  `null`. Settings section ids are a shared constant (`src/shared/`) so server
  validation and renderer navigation use one list.

### Desktop storage

`localStorage["manta:whats-new:<boxId>"] = {version, fingerprint}`. Per device,
per server. Not synced via shared config.

### Packaging

`scripts/release/pack.mjs` adds `CHANGELOG.md` to the server tarball (it is
currently excluded, so a production server has none). A dev checkout already
has it.

## Release skill change (`.opencode/skills/release-manta/SKILL.md`)

Step 4 gains:

- Write "server" (not "box") in user-facing changelog text; component label in
  the heading is `Server`.
- **Decide on highlights.** Add a highlights block only if the release has 1–3
  changes a user would want to go and try (a new capability or a visibly new
  surface). Fixes, polish and internal work never qualify. Zero qualifying
  changes → no block (the window shows release notes). Never pad to 3.
- Each item: title ≤ 3 words, text ≤ 110 chars, icon from the allowed list,
  action only if one of the allowed actions opens the feature.
- Validate with `node scripts/release/check-changelog.mjs` (new, runs the
  same parser the server uses; fails on an invalid block).

The repo copy is the source of truth; the box copy at
`~/.config/opencode/skills/release-manta/SKILL.md` is updated by copying it.

## Libraries considered

| Need | Chosen | Considered / why |
|---|---|---|
| Split CHANGELOG.md into versioned entries | `unified` + `remark-parse` (already dependencies): walk the markdown tree, split at level-2 headings, read the highlights comment as an `html` node, slice raw text by node position for the fingerprint | `changelog-parser` 4.1.0 (ISC, 1 dep, 43k/wk): tried against our file — splits versions and dates correctly but **strips HTML comments from the body**, so the highlights block is lost, and returns no raw section for the fingerprint; `keep-a-changelog` 3.2.0 (MIT, 20k/wk): requires `## [x.y.z] - date` headings, ours are `## x.y.z — … — date`; regex heading split: rejected per library rule |
| Parse the highlights block | `yaml` (already a dependency) | — |
| Render notes markdown | `react-markdown` + `remark-gfm` (already used for the transcript) | — |
| Icons | `lucide-react` (already used) | dynamic icon-by-name import: rejected, bundles every icon |
| Modal chrome, focus trap, Escape | existing `Modal` primitive | a dialog library: the app standardised on its own primitive (BET-588) |
| Version ordering | none — entries are compared by position in the newest-first file | `semver` 7.8.6: unnecessary once file order is the ordering |
| Fingerprint | `node:crypto` sha256 | — |
| "Seen" storage | `localStorage` | server-side store: acknowledgement is per device by design |

## Tests

- Server (node:test): parsing the real `CHANGELOG.md`; highlights block valid /
  invalid YAML / >3 items / unknown icon / invalid action; `Ships:` removal;
  component normalisation (`Box` → `server`); unreadable file →
  `unavailable`; mtime cache.
- Shared/pure (vitest): the show decision (every row of the trigger table).
- Renderer: B renders with highlights, A without; multi-entry; card action
  closes + acknowledges; About link re-opens without changing storage; never
  opens while the upgrade gate is up.
- `check-changelog.mjs` passes on the current file.

## Manual test (dev box)

1. Pair desktop → no window (first pair).
2. On the server checkout, add a `## 1.2.1 — Server + Desktop — …` entry with a
   highlights block, restart manta-server → desktop reconnects → window B.
3. Close; restart again → nothing.
4. Remove the highlights block, restart → window A for 1.2.1 (edited entry).
