# POC: SSH Claude login

Throwaway spike (Stage 1, BET-352). Its only job is to answer the four
questions in `RESULTS.md`; the app is just how you obtain the answers.

## What it does

Spawns `ssh -tt <host> claude` and shows the raw remote output in a log
pane. The `-tt` flag forces a remote PTY so `claude` believes it is
interactive even though the local side is just pipes — no pseudo-terminal
library needed, no dependencies beyond Electron itself.

When the first `https://` URL appears in the output, it becomes a button
that opens it via `shell.openExternal`. The full output is also mirrored
to the log, so detection failures are visible (paste-able).

A code input field writes the typed text + `\r` to stdin (the same byte
sequence a real terminal sends on Enter).

A Check button runs three commands over a separate, plain SSH connection:
`~/.claude/.credentials.json` exists, `curl http://127.0.0.1:4096/provider`
before AND after `systemctl --user restart opencode-serve`.

## Run it

```
cd poc/ssh-claude-login
npm install
npm start
```

Then type your SSH host (an alias from `~/.ssh/config` or `user@host`),
click Connect, click through the OAuth flow in your browser, paste the
code back, click Check.

## Pre-flight

- `claude` and `opencode` must be installed on the target box.
- Neither has ever been launched (so there is no `~/.claude/.credentials.json`
  yet). If you are using the dev box and `~/.claude/.credentials.json` is
  there, **back it up** first and restore it afterwards.
- SSH key auth that works without a passphrase.
- `opencode-serve` runs on `127.0.0.1:4096` on the box.

## Filling in `RESULTS.md`

The four questions are in `RESULTS.md`. Run the flow once on a real box,
paste the raw output under each one, and answer the yes/no questions.
Add anything surprising (theme/telemetry prompts, timing) to the notes
section. End with a one-paragraph "what I'd do differently in the real
implementation".

## Why this isn't wired into the rest of the repo

Per the issue body:

- It must NOT be referenced from the root `package.json`,
  `electron.vite.config.*`, `electron-builder.yml`, or any CI workflow.
- Nothing in `src/` may import from it.
- `poc/` is NOT in `.gitignore` — commit it so the human can run it.
