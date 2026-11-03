---
name: release-manta
description: Cut a MantaUI release from latest main — detect which components (box server, macOS/Windows desktop, iOS, website, gateway) changed since their last release tag, bump versions, update CHANGELOG.md, merge the bump PR, then push the release tags one at a time and verify each deploy. Use when the user says "/release-manta", "cut a release", "ship a release", "release everything that changed".
---

# Release MantaUI

Releases are TAG-DRIVEN: merging to `main` deploys nothing. A release =
(1) one bump PR merged to `main`, then (2) one tag per changed component,
pushed **one at a time**, each verified. Read the "Release & CD pipeline"
section of the repo `AGENTS.md` if anything below is unclear.

## 0. Start from latest main

```bash
git fetch origin --tags --prune
git status --short            # stash/commit stray changes first; never discard user work
git switch --detach origin/main   # main is often checked out in another worktree
```

## 1. Find the last release of each component

```bash
for p in server mac win web ios gateway; do
  echo "$p $(git tag -l "$p-v*" --sort=-creatordate | head -1)"
done
```

Use `--sort=-creatordate`, not version sort — tag schemes changed over time
(`server-v54` → `server-v1.0.0`).

## 2. Decide which components changed

Diff each component's paths from ITS last tag to `origin/main`
(`git diff --name-only <tag> origin/main -- <paths> | wc -l`):

| Component | Tag | Paths that make it "changed" |
|---|---|---|
| Server | `server-v*` | `src/server src/shared scripts docs/opencode-tools docs/opencode-plugins-v2 package.json package-lock.json` |
| Desktop (mac + win, always together) | `mac-v*`, `win-v*` | `src/renderer src/main src/preload src/shared electron-builder*.yml assets package.json` |
| iOS | `ios-v*` | `mobile/native` |
| Website | `web-v*` | `website scripts/install.sh llms-install.md` — **and also whenever the box server is released** (`website/updates/server.json` is published by the web deploy; without it boxes never see the update) |
| Gateway | `gateway-v*` | `src/gateway` only (a restart drops in-flight APNs pushes — never release it without gateway code changes) |

Ignore pure docs/spec/test-only diffs when judging (`docs/superpowers`,
`*.test.*`, `AGENTS.md`) — but a component with only those changes is
"unchanged", not released.

Then list the commits for the changelog:

```bash
git log --format='%h %cs %s' <oldest-relevant-tag>..origin/main
# per-commit component attribution:
for c in $(git rev-list --reverse <tag>..origin/main); do
  git log -1 --format='%h %s' $c; git diff --name-only $c^ $c | cut -d/ -f1-2 | sort -u
done
```

Read bodies (`git show -s <sha>`) of anything whose subject is unclear.

## 3. Bump versions (semver)

- **minor** if any `feat` / new user-visible behaviour in that component,
  **patch** if fixes only, **major** only for a wire-contract break (that also
  needs `supportedMajor` in `src/shared/compatibility.mjs` — never bump major
  without the user's explicit go-ahead).
- **Desktop + server share `package.json` `version`.** If either changed, bump it:
  `npm version X.Y.Z --no-git-tag-version --ignore-scripts` (updates
  `package-lock.json` too).
- **Server released → also set `website/updates/server.json` `version`** to the
  same value (that file drives the "Update the box?" banner).
- **iOS:** bump `MARKETING_VERSION` in `mobile/native/project.yml` (the
  xcodegen source of truth; leave the derived `project.pbxproj` alone). Never
  go below the current line (no `0.x`, no resets).
- Gateway and website have no version file; their tags just increment.

## 4. Update `CHANGELOG.md`

Add a new top section under the intro, newest first:

```
## <desktop/server version> — <components> · iOS <ios version> — YYYY-MM-DD

Ships: <exact tags>. <Unchanged components> unchanged.

### <theme>
- **Headline.** What the user can now do / what stopped breaking.
```

Rules: plain user-facing language (behaviour, not function names); group by
theme, then a short per-surface section (Desktop / iOS / Server); merge related
commits into one bullet; skip internal refactors unless they change behaviour;
name both platforms when a feature landed on both.

**Write "server", never "box"**, in every user-facing line. The heading's
component label is `Server` (e.g. `## 1.4.0 — Server + Desktop — 2026-11-10`).
Tag names (`server-v1.4.0`) stay as they are.

**Decide on highlights.** The desktop shows a "What's new" window after an
update. If the release has 1–3 changes a user would want to go and try (a new
capability or a visibly new surface), add a highlights block as an HTML comment
directly under the heading (invisible on GitHub), above the `Ships:` line:

```
## 1.4.0 — Server + Desktop — 2026-11-10

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

- Fixes, polish and internal work never qualify. Zero qualifying changes → no
  block (the window then shows the release notes). Never pad to three.
- `headline` is optional (default "What's new in Manta X.Y.Z"). 1–3 `items`.
- Each item: `title` ≤ 3 words, `text` ≤ 110 characters.
- `icon` — exactly one of: `sparkles` (default), `repeat`, `arrow-left-right`,
  `refresh-cw`, `zap`, `message-square`, `terminal`, `folder`, `settings`,
  `shield`, `bell`, `mic`, `gauge`, `git-branch`, `calendar-clock`.
- `action` — optional, exactly one of: `routines`, or `settings:<section>` with
  `<section>` one of `general`, `box`, `accounts`, `models`, `sessions`,
  `files`, `extensions`, `secrets`, `voice` (these are internal section ids;
  `box` is the Settings section about the server, whatever its label says).
- More than 3 items, bad YAML or a wrong shape makes the whole block ignored.

Validate before committing:

```bash
node scripts/release/check-changelog.mjs
```

It runs the server's own parser on `CHANGELOG.md`, exits non-zero on an invalid
block or an unknown icon/action, and prints what the newest entry will show
(window B with N cards, or window A = release notes).

## 5. Bump PR → merge

```bash
git switch -c chore/release-X.Y.Z
git add package.json package-lock.json website/updates/server.json mobile/native/project.yml CHANGELOG.md
git commit -m "chore(release): X.Y.Z (server + desktop), iOS A.B.C"
git push -u origin HEAD
gh pr create --title "chore(release): …" --body "<what / tags to push / verification>"
gh pr checks --watch            # typecheck-test is the required check
gh pr merge --squash --delete-branch
git fetch origin && git log -1 origin/main   # tag THIS merge commit
```

Merging a `MARKETING_VERSION` change makes `ios-release-tag.yml` create
`ios-vA.B.C` **and** start the Codemagic TestFlight build by itself — do not
push the iOS tag by hand (check `gh run list --workflow ios-release-tag.yml -L1`).

## 6. Push tags — ONE per `git push`, in this order

GitHub silently drops the push event when one push creates more than three
tags (no workflow runs, no error). Push each alone and confirm a run started
before the next:

```bash
SHA=$(git rev-parse origin/main)
git tag server-vX.Y.Z $SHA && git push origin server-vX.Y.Z
gh run list --workflow server-tarball-deploy.yml -L1   # wait for success BEFORE web
git tag web-vX.Y.Z $SHA && git push origin web-vX.Y.Z  # publishes server.json → boxes see the update
gh run list --workflow website-deploy.yml -L1
git tag mac-vX.Y.Z $SHA && git push origin mac-vX.Y.Z
gh run list --workflow codemagic-mac-trigger.yml -L1
git tag win-vX.Y.Z $SHA && git push origin win-vX.Y.Z
gh run list --workflow windows-desktop-build.yml -L1
# gateway only if src/gateway changed:
git tag gateway-vN $SHA && git push origin gateway-vN
```

Server before web is deliberate: the manifest must not advertise a version
whose tarball isn't published yet. If a tag fired nothing: delete the remote
tag (`git push origin :refs/tags/<tag>`) and push it again, alone.

## 7. Verify (green workflow ≠ live)

```bash
curl -s https://mantaui.com/releases/manta-latest.txt     # version= and git_sha= match the merge commit
curl -s https://mantaui.com/updates/server.json           # version = X.Y.Z
curl -s https://mantaui.com/updates/latest-mac.yml | head -3   # after Codemagic finishes (~20-40 min)
gh release view win-vX.Y.Z                                # .exe attached
```

iOS: Codemagic build status via its API (see AGENTS.md "Monitoring a build"),
then App Store Connect `processingState: VALID`. A mac/iOS Codemagic build
takes a while — schedule a check (`schedule_create`) rather than polling.

## Report

Tell the user: versions bumped, tags pushed (with run links), what is
verified live, what is still building, and anything skipped and why.
Never deploy a component whose paths didn't change; never skip the website tag
when the box server is released.
