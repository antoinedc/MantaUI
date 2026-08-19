---
name: manta-live-session
description: Talk to a real manta box from an agent session — create a chat session, send a prompt, read the reply, and mint a pairing code for a phone or Simulator. Use whenever a task needs live box data rather than a unit test. Always runs on voska/default.
---

# Live box access — `manta-probe`

## What this is for

Some work cannot be verified by a unit test: a screen that only renders with a
real transcript, a card that only appears when a real turn blocks, a Simulator
that has to be paired to a real box. Before this skill existed, agents wrote
their own `curl` calls against the box and quietly got them wrong — the RPC body
shape, the auth header, the fact that the prompt endpoint is **asynchronous**,
and the fact that the pairing endpoint is **loopback-only** are each easy to miss,
and a half-working request looks exactly like a broken feature.

**`manta-probe` is the one supported way in.** Do not hand-roll `curl` against
the box; if this tool cannot do what you need, say so on the issue rather than
improvising.

## The one rule you cannot break

**Every prompt runs on `voska/default`.** There is no flag, no argument and no
environment variable to change it — the model is a constant inside the tool. The
other providers on this box are metered and are not yours to spend. If you find
yourself wanting a different model, you are doing something this skill is not
for.

## Where it runs

The box is the Linux machine **`alphaclaw`** — the same machine the Linux agents
already run on.

| You are | Command form |
|---|---|
| a Linux agent (`manta-dev`, and anything on the box) | `~/.local/bin/manta-probe <cmd>` |
| the **macos** agent | `ssh dev@alphaclaw '~/.local/bin/manta-probe <cmd>'` |

**Always use the absolute path `~/.local/bin/manta-probe`, never the bare name.**
A non-interactive SSH shell has a minimal `PATH` that does **not** include
`~/.local/bin`, so a bare `manta-probe` fails with "command not found" over SSH.
This is verified, not theoretical — use the absolute form everywhere and the same
line works from both machines.

## Commands

```bash
# The one-shot most tasks want: fresh session, prompt, wait, print the reply.
~/.local/bin/manta-probe ask "Reply with exactly one word: PONG"

# Keep the session afterwards (to inspect it in the app, or prompt it again).
~/.local/bin/manta-probe ask "Read AGENTS.md and summarise section 6" --keep

# Long-form: drive a session across several turns.
SID=$(~/.local/bin/manta-probe new my-label)
~/.local/bin/manta-probe prompt "$SID" "first turn"
~/.local/bin/manta-probe prompt "$SID" "second turn"
~/.local/bin/manta-probe messages "$SID"     # dump the transcript

# Pair an iOS Simulator in one step — the app auto-claims this link, no typing.
~/.local/bin/manta-probe pair-url            # manta://pair?box=…&code=…
~/.local/bin/manta-probe pair-url --simctl   # the full xcrun simctl command
~/.local/bin/manta-probe pair                # raw code + URL (physical phone)
~/.local/bin/manta-probe server              # just the server URL

# Housekeeping — always finish with this.
~/.local/bin/manta-probe list
~/.local/bin/manta-probe clean
```

`ask` prints **the reply on stdout** and progress/diagnostics on stderr, so
`REPLY=$(~/.local/bin/manta-probe ask "…" 2>/dev/null)` captures just the answer.

## Pairing a Simulator — one command, no typing

**Do not drive the pairing screen with XCUITest and do not type a code.** The app
registers the `manta://` URL scheme and **auto-claims** a deep-linked payload —
there is no "Continue" to tap. Opening the link on a booted Simulator pairs it
outright.

From the macos agent, the entire flow is two lines:

```bash
# 1. mint the link ON the box (pairing is loopback-only, so it must run there)
LINK=$(ssh dev@alphaclaw '~/.local/bin/manta-probe pair-url' 2>/dev/null)

# 2. open it on the booted Simulator
xcrun simctl openurl booted "$LINK"
```

`pair-url --simctl` prints the whole `xcrun simctl openurl booted '…'` command
ready to paste, if you prefer one copyable line.

Facts that will otherwise waste your time:

- **Codes expire in minutes.** Mint the link immediately before opening it, never
  at the start of a long job. If pairing fails, mint a fresh one — do not reuse.
- **`/auth/pair` is loopback-only, by design.** Against the public hostname it
  answers `403`. That is why it is minted over SSH on the box. A 403 while
  pairing means you called the public URL — the feature working, not a bug.
- **The link carries no `server=` param, deliberately.** The app REFUSES a
  non-private server URL, and this box is reached over its public gateway
  hostname. With `box=` alone the app derives
  `https://<boxId>.boxes.mantaui.com` itself, which is correct here. Adding
  `server=` would make the payload be rejected outright.
- **Already paired to another box?** The app treats a pairing link as a re-pair
  and shows a "Switch box?" confirmation instead of silently switching — so on
  an already-paired Simulator this needs one tap, or erase the Simulator first
  (`manta-sim-drive action: reset`).

`pair` (without `-url`) prints the raw 6-digit code and server URL. It is the
**fallback for a physical phone**, where you cannot open a link from the host —
type them into the pairing screen by hand.

## How pairing is persisted (and why we do not write it directly)

The claimed credentials live in the **iOS Keychain**
(`KeychainCredentialStore`, a `kSecClassGenericPassword` item), not in a
preferences file. There is no supported way to write another app's Keychain item
from the host — `simctl keychain` only manages certificates — so "just write the
token in" is not available, and any scheme that tried would be reaching into
private app storage.

The deep link is strictly better anyway: it exercises the **real** claim path
(`/auth/claim`, device registration, the app's own error handling), so a
successful pair proves the thing you actually care about works. Writing storage
directly would bypass exactly the code most likely to be broken.

## Cleaning up — not optional

Every probe session is a real opencode session in a tmux project called
`manta-probe`, kept apart from real work so it is trivially findable and
trivially removable. `ask` deletes its session automatically unless you pass
`--keep`.

**Run `clean` when you finish.** Sessions you leave behind are live agent
sessions on someone's machine: they show up in the app's sidebar, they hold
context, and nobody else knows whether they matter.

## Failure modes and what they actually mean

| What you see | What it means |
|---|---|
| `cannot reach manta-server` | the server is down — `systemctl --user status manta-server` |
| `unauthorized — the box token was rejected` | `~/.manta/auth.json` is stale or you are the wrong user; do **not** try to re-pair the box to fix this |
| `command not found` over SSH | you used the bare name instead of `~/.local/bin/manta-probe` |
| `403` from a pairing attempt | you called the public hostname; pairing is loopback-only |
| `no completed reply within Ns` | the turn is still running — inspect with `messages <sid>`, do not retry blindly |

Report a failure as a finding on the issue. **Never** substitute a plausible
answer for one you could not obtain, and never claim you verified something live
when the tool did not run.

## Security — how the token is handled

The box token lives in `~/.manta/auth.json` on `alphaclaw` and is read **inside**
the tool. It is never printed, never logged, never placed in a command line, and
never crosses to another machine. That is why the macos agent runs this over SSH
instead of being handed a token: the value is substituted remotely and never
enters the Mac's context.

**Do not read, print or copy `~/.manta/auth.json` yourself.** If you think you
need the raw token, you need a new subcommand on this tool instead — say so on
the issue.

## Installation

The tool is versioned in this repo at **`scripts/manta-probe.cjs`** and is
installed on `alphaclaw` at `~/.local/bin/manta-probe`. It is plain Node with no
dependencies.

If `~/.local/bin/manta-probe` is missing (a rebuilt box, a fresh machine),
restore it from the repo rather than reconstructing it from memory:

```bash
install -D -m 755 scripts/manta-probe.cjs ~/.local/bin/manta-probe
~/.local/bin/manta-probe server   # smoke test
```

The `.cjs` extension is load-bearing: this package is `"type": "module"`, so a
`.mjs`/`.js` file here would be parsed as ESM and the script's `require` calls
would fail with *"require is not defined in ES module scope"*. The installed
copy is extensionless, which Node treats as CommonJS, so the same source runs
in both places.

It is **not** installed to `/usr/local/bin` because that needs sudo this box
does not grant non-interactively — which is exactly why every invocation in this
skill uses the absolute `~/.local/bin/manta-probe` path.
