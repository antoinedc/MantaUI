# Live Claude Code version claim (issue #1684)

## Problem

The `manta-claude-max` plugin authenticates to Anthropic as Claude Code and
claims a Claude Code version (user-agent + billing header). Anthropic refuses a
model when the claim is below that model's minimum. The claim today comes from
`ANTHROPIC_CLI_VERSION` in the **opencode service environment** (fallback
`CC_VERSION_FALLBACK = 2.1.280`). That value is written into the unit at install
(`resolve_anthropic_cli_version`) and refreshed only by
`ensure_opencode_cli_version`, which runs only when self-update restarts
opencode.

So when only the `claude` CLI changes (self-update's `upgrade-clis.mjs` with
restart plan `none`; the desktop About row → `server:cli-update` →
`upgradeCli()`; a manual `claude update`; Claude's own auto-update) the running
opencode keeps claiming the old version. About shows a current CLI while new
models fail: "Claude Code 2.1.207 does not support this model; version 2.1.260
or newer is required".

Also the floors are stale: `manta_claude_cli_version_floor` is `2.1.257` and the
plugin fallback is `2.1.280`; current gates are Opus 5.5 ≥ 2.1.280, Sonnet 5.5
≥ 2.1.284, Haiku 5.5 ≥ 2.1.293.

## Design

Restarting opencode on every CLI change is out: it kills every in-flight chat
turn. Instead the claim becomes **live and read per request**.

1. **State file** `<state home>/.manta/claude-cli-version` holds the box's real
   `claude --version` number (e.g. `2.1.301`), one line. Path = `statePath()`
   on the server (`MANTA_STATE_HOME` or `$HOME`); the plugin computes the same
   path from its env.
2. **manta-server writes it** (`src/server/claudeCliVersion.mjs`):
   - at boot and on an hourly timer (re-reads `claude --version` through the
     existing `resolveBinary` + `readVersion`; this notices Claude's own
     auto-update and manual `claude update`);
   - whenever the CLI detector probes (About check) — `createCliDetector`
     gets an optional `onDetect` hook;
   - after `upgradeCli("claude")` succeeds.
   Writes are atomic (temp + rename) and happen only when the value changed.
3. **self-update** refreshes the file right after `upgrade-clis.mjs` using
   `claude_cli_version` (so the restart-plan-`none` branch is covered before
   manta-server's next hourly tick).
4. **The plugin** (`cliVersion()`) claims the HIGHEST of: env
   `ANTHROPIC_CLI_VERSION`, the state file, and the built-in fallback. The file
   is read per call, cached on mtime (one `stat` per request), and never throws
   (missing / unreadable / garbage → ignored). `ANTHROPIC_USER_AGENT` override
   is unchanged.
5. **Floors**: `manta_claude_cli_version_floor` (release.sh, and the generated
   inline copy in install.sh) and `CC_VERSION_FALLBACK` (plugin) → `2.1.293`,
   kept equal.

Behaviour change worth noting: an env claim below the fallback is now lifted to
the fallback (previously env always won). A claim below the floor is never
useful, and the plugin test/e2e for "stale env" are updated to say so.

### How it reaches existing boxes (automatic, no manual step)

- Plugin: `upgradeV2Prepare.installV2Plugins` copies
  `docs/opencode-plugins-v2/manta-claude-max/` into
  `~/.config/opencode/plugins/` on every update (hash-manifest, so a changed
  file → `pluginsChanged`); `opencode_restart_plan` then restarts opencode once
  ("a manta opencode plugin changed"). One restart at release time; **none per
  CLI update afterwards**.
- Server code: normal self-update payload swap + server restart; the boot hook
  writes the state file immediately, so the new plugin has a value from its
  first request. The hourly timer keeps it fresh.
- Until the plugin reload, the old plugin ignores the file; the existing
  `ensure_opencode_cli_version` unit patch (now with the higher floor) still
  applies on that same restart.

## Libraries considered

| Need | Chosen | Considered / why not |
|---|---|---|
| Version compare (server) | `compareVersions` in `src/shared/versionCompare.mjs` (existing, tested) | — |
| Version compare (plugin) | 6-line numeric `x.y.z` compare in `lib/config.ts` | `semver` is not a dependency of the repo or of the plugin, and the plugin ships as a standalone dir copied to `~/.config/opencode/plugins/` with no `node_modules`; adding a dependency for one comparison would require bundling. The shared `.mjs` helper can't be imported from there for the same reason. |
| Atomic file write | temp + `rename` with `node:fs/promises` (the store pattern used across `src/server`) | `write-file-atomic` — not a dependency here; every other store (`schedule`, `auth`, config) uses the same 3-line pattern; trivially small. |
| Periodic refresh | `setInterval` + `unref` + in-flight guard (the repo's poller shape) | A durable workflow engine / routine — overkill for a local `claude --version` spawn. |
| CLI version probe | existing `resolveBinary` + `readVersion` (`cliUpdates.mjs`) | — |
| mtime-cached file read | `statSync` + `readFileSync` | `chokidar`/`fs.watch` — watchers are fragile across rename-replace and add lifecycle; one `stat` per request is negligible. |

No new components outside this table.

## Test plan

- Plugin (`scripts/opencode-v2/claude-max.test.mjs`): env only; file only;
  max of env/file/fallback; garbage file; missing file; below-fallback env is
  lifted; file change picked up (mtime cache); state-home override; floor
  constant.
- Server (`src/server/claudeCliVersion.test.mjs`, injected I/O): writes on
  change only; atomic (temp + rename, no partial file); path under the state
  home; ignores junk versions; hourly sync reads CLI version; detector hook and
  upgrade hook write.
- `scripts/lib/release.test.mjs`: floor value + resolver falls back to it; new
  `write_claude_cli_version_file` helper (writes only on change, never an
  empty/garbage value).
- `sync-release-fallback.test.mjs` byte-parity for install.sh stays green.
- Live e2e (`claude-max.e2e.mjs` [7], opt-in, spends quota): a stale env claim
  is lifted to the floor and the Opus turn now succeeds. Not run in CI.
