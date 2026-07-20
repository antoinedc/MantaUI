# MantaUI plugins — AI agent authoring guide

You are an AI coding agent authoring MantaUI plugins. A plugin is one YAML
file at `~/.manta/plugins/<name>.yaml` on the **machine the user wants to
drive** (today: only the connected Mac — `host:"mac"`). The user can also
author plugins by hand in any editor; both paths go through the same
validator and the same runner.

The MantaUI plugin system exists so the AI can do things on the user's machine
that the box can't do alone — most importantly, building and launching an iOS
app in the iOS Simulator on the user's Mac, instead of burning CI minutes on
every iteration. Every plugin is just a short YAML manifest with a list of
shell commands to run in order; the runner handles env construction, log
streaming, timeouts, and routing the completion back into the originating chat.

This guide covers authoring in eight sections, in order. Skim §1 and §2, then
pick the example in §5 closest to your use case and copy it as a starting point.
Refer back to §3, §4, and §6 when you hit a specific decision or error. §7 is
the author/test loop you will use most of the time. §8 is the operational facts
that don't change between plugins.

Use the `plugin_docs` tool to pull this guide into your context at any time,
`plugin_list` to see what's already installed, `plugin_save` to write or update
a manifest, `plugin_run` to execute one, and `plugin_status` to read a job's
log tail.

---

## 1. What a plugin is + where it lives

A plugin is one YAML file:

- **Where:** `~/.manta/plugins/<name>.yaml` on the machine the plugin should
  run on (today: the user's Mac).
- **What it is:** a name, a description, an optional input schema, an
  optional env map, and one or more shell commands (steps) to run in order.
- **What it does:** when the user or AI invokes `plugin_run("<name>", inputs)`,
  the executor on the machine validates the inputs against the schema, then
  runs the steps sequentially in `/bin/sh`, with each step's stdout/stderr
  streamed into the originating chat as a job log. When the run finishes
  (success, failure, or 30-minute sweep timeout), the executor reports back
  through the server and a completion turn is injected into the chat session
  that ran the plugin. The chat does not have to poll.

The executor **hot-reloads** the plugin folder: it `fs.watch`es
`~/.manta/plugins/` (debounced 500ms) and rescans on change, at startup, and
on every SSE reconnect. Adding, editing, or deleting a YAML file does not
require restarting MantaUI or the executor.

A plugin is **NOT**:

- A TypeScript handler. There is no per-plugin code in the MantaUI repo; the
  v1 per-capability handler layer was deleted (see BET-189 / BET-190 in the
  repo's commit history).
- A custom executor. All plugins run on the same executor process the box's
  manta-server already knows about — there is exactly one
  `src/main/capExecutor.ts` running on the Mac, and every plugin run goes
  through it.
- A "run arbitrary command" capability. The runner refuses to dispatch any
  capability that is not a valid installed manifest, and refuses any unknown
  input key at validation time.

If the user asks for something the plugin system can't express — a new host,
a new step kind, conditional logic beyond the three `if:` forms — that is a
MantaUI change, not a plugin change. Stop and tell the user what you'd need
to add; do not silently extend the schema.

## 2. Full schema reference

A plugin manifest is a single YAML mapping with the following top-level keys.
Every key is documented with its type, requirement, and validation rule. An
unknown top-level key is a validation error — typos fail loudly.

### Top-level keys

| Key | Type | Required | Description / validation |
| --- | --- | --- | --- |
| `name` | string | yes | `^[a-z0-9][a-z0-9-]{0,63}$`. Must equal the filename minus `.yaml`. The `plugin.` namespace is reserved for built-in capabilities and is impossible by the regex (no dots). |
| `description` | string | yes | Non-empty. One sentence: what the plugin does and when to reach for it. Shown in `plugin_list` and surfaced to the model when picking a tool to call. |
| `host` | string | yes | Must be `"mac"`. v2 accepts ONLY `mac`; any other value produces `host: only "mac" is supported`. |
| `timeout` | string | no | `^\d+(s|m)$` (e.g. `30s`, `5m`, `30m`). Parsed value must be ≤ 30 minutes. Missing → no per-step cap. Why the cap: the server sweep fails any `running` job at 30 minutes; a longer manifest timeout would be killed anyway. |
| `inputs` | array of input objects | no | Each object carries an `id:` field (`^[a-z][a-zA-Z0-9_]*$`). Order is preserved and surfaced to the tool schema verbatim — model-side prompt construction sees them. Optional; missing → plugin takes no inputs. See "Input object" below. |
| `env` | map of `string → string` | no | Plugin-scoped environment variables injected into every step. Reserved names: `MANTA_PLUGIN`, `MANTA_JOB_ID` (the runner injects these itself — user-supplied values are silently ignored). Values with a leading `~` are expanded against `os.homedir()`. |
| `steps` | list of step objects | yes | Required, min 1. Run sequentially in `/bin/sh -c`. See "Step object" below. |

### Input object

| Key | Type | Required | Description / validation |
| --- | --- | --- | --- |
| `id` | string | yes | `^[a-z][a-zA-Z0-9_]*$` — must be a JS-safe identifier. |
| `type` | string | yes | One of `"string"`, `"number"`, `"boolean"`, `"enum"`. |
| `description` | string | yes | One sentence explaining what the input does. Shown to the model in the tool schema. |
| `default` | same as `type` | no | Used when the caller omits the input. Must type-match the declared type; for `enum`, must be one of `values`. |
| `values` | list | required iff `type: enum` | Allowed enum values; otherwise this key is forbidden. |
| `required` | boolean | no | Default `false`. When `true` and no value/default is provided, the call is rejected with a clear error before any step runs. |

### Step object

| Key | Type | Required | Description / validation |
| --- | --- | --- | --- |
| `name` | string | no | Free-form label for logs and the result. Defaults to the first 30 chars of `run`. |
| `run` | string | yes | Shell string passed to `/bin/sh -c`. May use the plugin's `env:` map values, `MANTA_INPUT_<ID>` (uppercased input id) for each supplied input, `MANTA_PLUGIN=<name>`, and `MANTA_JOB_ID=<id>`. **Do NOT interpolate input values into `run` directly** — see §3. |
| `cwd` | string | no | Working directory for the step. `$KEY` / `${KEY}` substitutions resolve from the plugin's `env:` map; a leading `~` expands against the user's home. Non-existent dir → step fails with `cwd: <path> does not exist`. |
| `if` | string | no | One of the three grammar forms — see §4. Anything else → validation error. |
| `continue_on_error` | boolean | no | Default `false`. When `true`, a non-zero exit from this step logs the failure but the job continues to the next step. |
| `quiet` | boolean | no | Default `false`. When `true`, the step's stdout is NOT streamed to the job log (the step still runs and its exit code still gates the job — only the chatter is suppressed). |
| `env` | map of `string → string` | no | Step-scoped env additions on top of the plugin's `env:` map. Same reserved-name rule applies. |

Unknown keys anywhere — top-level or per-step — produce
`unknown key "<key>"` at the appropriate path (`steps[2].<key>` for steps).
This is intentional typo protection.

## 3. The input / env-var rule — never interpolate inputs into commands

Commands (`run:`) MUST NOT interpolate input values via shell. Inputs become
environment variables (`MANTA_INPUT_<ID>`) and the command references them
that way:

```yaml
inputs:
  - id: repo
    type: string
    description: git repository URL to clone
steps:
  - run: git clone "$MANTA_INPUT_REPO" ~/work/clone
```

Why this rule exists: the inputs field is typed data. The runner has already
validated them against the schema. If a value with spaces or shell
metacharacters lands in a string-concatenated `run:`, a typo or a hostile
filename can break the command or worse. The env-var route lets `/bin/sh`
quote-escape naturally without any extra shell-quoting logic in the runner.

The runner also exposes the plugin's `env:` map (`REPO=~/projects/foo` in
the `env:` block becomes `$REPO` in `run:`) and the two plumbing vars
(`MANTA_PLUGIN`, `MANTA_JOB_ID`).

Three further invariants you can rely on:

- Booleans stringify to the literal `true` or `false`. Use
  `if [ "$MANTA_INPUT_VERBOSE" = "true" ]; then …; fi`.
- An optional input with no value AND no default → the `MANTA_INPUT_<ID>`
  variable is **absent** from the env, not present-and-empty. Test with
  `[ -z "${MANTA_INPUT_NOTE:-}" ]`.
- Enum values stringify to whatever you put in `values:` — usually quoted
  strings, occasionally bare numbers. The runner does not invent any
  formatting.

## 4. `if:` grammar — exactly three forms, nothing else

A step's `if:` is one of:

1. **`inputs.<id>`** — truthy: `true` for booleans, or any non-empty string
   for strings. Missing variables count as falsy.
2. **`inputs.<id> == <bare-token>`** — string-compare the input's value to
   one whitespace-free literal token.
3. **`inputs.<id> != <bare-token>`** — the negation of (2).

The bare token is one whitespace-free literal. Booleans stringify to
`true` / `false`, so `inputs.action == launch` is valid; so is
`inputs.verbose != true`. Anything else — operator expressions, function
calls, `${{ }}` interpolations, multiple tokens — fails validation with
`steps[N].if: invalid expression`. This is intentional: the runner does
not implement expression evaluation, and adding it is a design decision,
not an extension.

Examples:

```yaml
- name: pull
  if: inputs.pull                 # skip when pull is false or empty
  run: git -C "$REPO" pull --ff-only origin main

- name: launch-simulator
  if: inputs.action == launch     # run only for the launch action
  run: xcrun simctl boot "$SIM"

- name: skip-on-tagged-release
  if: inputs.channel != tagged
  run: ./deploy-staging.sh
```

If you need richer conditional logic, split it into more steps with
narrower `if:` clauses. The grammar is deliberately small so the runner
can be.

## 5. Worked examples

Three complete manifests, copy-and-edit starting points for the most common
cases. Each shows the schema conventions in context.

### 5.1. iOS app via Capacitor (MantaUI's own flow)

```yaml
name: ios-manta
description: Build the MantaUI iOS app and launch it in the iOS Simulator.
host: mac
timeout: 30m

inputs:
  - id: pull
    type: boolean
    default: false
    description: Run `git pull --ff-only origin main` in the Mac clone before building.
  - id: action
    type: enum
    values: [launch, compile, test]
    default: launch
    description: launch (default): compile + boot simulator + launch app; compile-only: just compile; test: run xcodebuild test.

env:
  REPO: ~/projects/MantaUI
  SCHEME: MantaUI
  BUNDLE_ID: com.mantai.manta

steps:
  - name: pull
    if: inputs.pull
    run: git -C "$REPO" pull --ff-only origin main
    cwd: $REPO

  - name: pod-install
    if: inputs.action != compile
    run: (cd "$REPO/mobile/ios" && pod install)
    continue_on_error: true
    quiet: true

  - name: build
    run: xcodebuild -workspace "$REPO/mobile/ios/App.xcworkspace" -scheme "$SCHEME" -configuration Debug -sdk iphonesimulator -derivedDataPath "$REPO/build" build
    cwd: $REPO/mobile/ios
    timeout: 25m

  - name: launch
    if: inputs.action == launch
    run: |
      UDID=$(xcrun simctl list devices booted | awk -F'[()]' '/Booted/{print $2; exit}')
      [ -n "$UDID" ] || UDID=$(xcrun simctl list devices available | awk -F'[()]' '/iPhone 16 Pro .*Shutdown/{print $2; exit}')
      xcrun simctl boot "$UDID" || true
      open -a Simulator
      xcrun simctl install "$UDID" "$REPO/build/Build/Products/Debug-iphonesimulator/$SCHEME.app"
      xcrun simctl launch "$UDID" "$BUNDLE_ID"

  - name: test
    if: inputs.action == test
    run: xcodebuild -workspace "$REPO/mobile/ios/App.xcworkspace" -scheme "$SCHEME" -sdk iphonesimulator -derivedDataPath "$REPO/build" test
    cwd: $REPO/mobile/ios
    timeout: 25m
```

### 5.2. Plain Xcode app (no Capacitor)

```yaml
name: xcode-hello
description: Build and launch a plain Xcode Swift app in the iOS Simulator.
host: mac
timeout: 20m

inputs:
  - id: pull
    type: boolean
    default: false
    description: git pull --ff-only origin main before building.
  - id: scheme
    type: string
    default: HelloWorld
    description: Xcode scheme name (must match a scheme in the workspace).

env:
  REPO: ~/projects/hello-world

steps:
  - name: pull
    if: inputs.pull
    run: git -C "$REPO" pull --ff-only origin main
    cwd: $REPO

  - name: build
    run: xcodebuild -project "$REPO/HelloWorld.xcodeproj" -scheme "$MANTA_INPUT_SCHEME" -configuration Debug -sdk iphonesimulator -derivedDataPath "$REPO/build" build
    cwd: $REPO
    timeout: 15m

  - name: boot-and-launch
    run: |
      UDID=$(xcrun simctl list devices booted | awk -F'[()]' '/Booted/{print $2; exit}')
      [ -n "$UDID" ] || UDID=$(xcrun simctl list devices available | awk -F'[()]' '/iPhone 16 Pro .*Shutdown/{print $2; exit}')
      xcrun simctl boot "$UDID" || true
      open -a Simulator
      APP="$REPO/build/Build/Products/Debug-iphonesimulator/$MANTA_INPUT_SCHEME.app"
      xcrun simctl install "$UDID" "$APP"
      xcrun simctl launch "$UDID" "$(defaults read "$APP/Info" CFBundleIdentifier)"
```

### 5.3. Generic script plugin

A plugin that just runs a script — useful for housekeeping, deploys, or any
flow that does not need Xcode at all.

```yaml
name: repo-cleanup
description: Run a maintenance script and prune merged branches.
host: mac
timeout: 10m

inputs:
  - id: prune
    type: boolean
    default: true
    description: Also delete local branches already merged into main.
  - id: dry_run
    type: boolean
    default: true
    description: Print the actions without actually performing them.

env:
  REPO: ~/projects/scratch

steps:
  - name: fetch
    run: git -C "$REPO" fetch --all --prune

  - name: clean
    if: inputs.prune
    run: |
      if [ "$MANTA_INPUT_DRY_RUN" = "true" ]; then
        git -C "$REPO" branch --merged main | grep -v '^\*' || true
      else
        git -C "$REPO" branch --merged main | grep -v '^\*' | xargs git -C "$REPO" branch -d
      fi
```

## 6. Error catalogue

The validator returns one line per problem, keyed by the path to the
offending value (`steps[2].run: required`). The executor surfaces them
verbatim into the failed job's `error` field. Read them, fix the manifest,
and re-run.

| Validator message | What it means | Fix |
| --- | --- | --- |
| `name: required` | Missing top-level `name:`. | Add `name:` matching the filename. |
| `name: must match ^[a-z0-9][a-z0-9-]{0,63}$` | Name has uppercase, underscores, dots, or starts with a hyphen. | Use kebab-case (`my-plugin`); rename the file too. |
| `name: must equal filename "<stem>"` | Filename and `name:` disagree. | Pick one (the filename) and put it in `name:`. |
| `description: required` | Empty or missing `description:`. | Add a one-sentence description. |
| `host: only "mac" is supported` | `host:` is not `mac` (likely `box` or a typo). | Change to `host: mac`. Other hosts are not implemented in v2. |
| `inputs.<id>: type required` | An input has no `type:`. | Add `type: string` / `number` / `boolean` / `enum`. |
| `inputs.<id>: description required` | An input is missing `description:`. | Add a one-sentence description. |
| `inputs.<id>: values required for enum` | `type: enum` but no `values:`. | Add a non-empty `values:` list. |
| `inputs.<id>: values forbidden for non-enum` | A non-enum input has `values:`. | Drop `values:`. |
| `inputs.<id>: default type mismatch` | `default:` does not match `type:`. | Coerce or change the default's type. |
| `inputs.<id>: default not in values` | Enum `default:` is not one of `values:`. | Pick a value from `values:`. |
| `steps: required (min 1)` | No steps. | Add at least one step. |
| `steps[N].run: required` | A step has no `run:`. | Add `run:` (or delete the step). |
| `steps[N].<key>: unknown key` | Typo or unsupported key. | Check spelling against §2. |
| `steps[N].if: invalid expression` | `if:` is not one of the three grammar forms. | See §4. |
| `top-level <key>: unknown key` | Typo at the top of the manifest. | Check spelling against §2. |
| `timeout: must match ^\d+(s|m)$` | `timeout:` is not `<digits>(s\|m)`. | Use `30s` / `5m` style. |
| `timeout: must be ≤ 30m` | Manifest timeout exceeds 30 min. | Lower the timeout. The server sweep kills at 30m anyway. |
| `YAML parse error: <yaml detail>` | The file is not parseable YAML. | Fix the YAML syntax (indentation, quoting). |
| `cwd: <path> does not exist` | Step `cwd:` (after `$KEY` / `~` expansion) does not resolve. | Use a path the executor can see (the Mac's filesystem). |

## 7. The author / test loop

1. **Pick a name** (kebab-case) and write a minimal manifest with one step.
   Save it via `plugin_save("<name>", yaml)`. The tool polls for ≤15s for
   the executor's verdict.
2. **If validation fails**, `plugin_save` returns the validator errors
   verbatim in the thrown error. Fix the manifest and call `plugin_save`
   again. Do NOT call `plugin_run` until the manifest is valid — `plugin_run`
   will reject it client-side, but the round-trip is wasteful.
3. **Run a smoke test** with `plugin_run("<name>", inputs)`. The tool
   returns a job id; the completion turn arrives in your session when the
   run finishes. Do not poll.
4. **Read the failure log** if the run failed. Use
   `plugin_status("<job-id>")` to fetch the log tail — the executor writes
   one `--- step N: <name or run-prefix> ---` header per step, with the
   actual stdout/stderr interleaved.
5. **Edit the manifest** (via `plugin_save` with the same name — same-name
   overwrite is supported; the executor hot-reloads on file change). Re-run
   from step 3.
6. **Iterate until green**, then `plugin_list` to confirm the manifest is
   present and `valid`.

This loop is fast on a connected Mac (sub-second for `plugin_save`, a few
seconds for a smoke test). If `plugin_save` returns
`queued; the machine appears offline — it will apply when it reconnects`,
the Mac executor is not running; the user needs to launch MantaUI on the
Mac with the plugins toggle on.

## 8. Operational facts

The plugin system is simple on purpose. These are the facts that don't
change between plugins:

- **One executor per Mac.** Every plugin run on a given Mac goes through
  the same `src/main/capExecutor.ts` process the box's manta-server is
  already connected to via SSE.
- **Serial execution.** Steps in a single plugin run sequentially.
  Distinct plugin invocations are also serialized at the executor — only
  one job runs at a time. Two parallel xcodebuilds would corrupt the
  shared DerivedData, so concurrency is intentionally absent. Plan
  plugins to be short; reach for separate plugins if you need parallel
  work.
- **30-minute hard cap.** The server sweep (`sweepCapJobs` in
  `src/server/capabilities.mjs`) fails any `running` job at 30 minutes.
  A plugin's `timeout:` field can lower this but never raise it.
- **Hot reload.** The executor `fs.watch`es `~/.manta/plugins/` (500ms
  debounce) and rescans on every change, at startup, and on every SSE
  reconnect. No restart is required to pick up a new or edited manifest.
- **The host machine must be awake with MantaUI running and the
  plugins toggle on.** The "Run plugins on this machine" toggle lives in
  MantaUI's desktop Settings → Plugins. It is OFF by default (a deliberate
  trust boundary). The executor gates itself at startup on this flag —
  with the toggle OFF, the plugin system is dormant.
- **Trust model.** The toggle is the only gate. There is no per-plugin
  confirmation — every plugin under `~/.manta/plugins/` runs whatever
  commands it says, exactly as written. Treat the folder like
  `~/.ssh/authorized_keys`: only the user (or the AI on their explicit
  request) should put files there.
- **Result shape on success:** `{ steps: [{name, code, skipped}] }`,
  where `skipped` is `true` for steps that ran the `if:`-skip path. On
  failure the job's `error` field carries the failing step's name and
  exit code, plus any captured stderr.
- **Tests:** pure shared logic in `src/shared/pluginManifest.test.ts`
  (vitest); server endpoints in `src/server/*.test.mjs` (node:test).
  If you discover a manifest that parses but should not, add a
  regression test before fixing the validator.
