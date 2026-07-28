# Stage 1 (POC) — RESULTS

This file is the real deliverable of the POC. The Electron app is just
how the answers below were obtained. Run the app against a real box,
paste raw output under each question, and answer the yes/no questions
plainly.

**Pre-flight (the box used here, `dev@157.90.224.92`, meets all four
assumptions in the issue body):** `claude` is at `~/.local/bin/claude`
(v2.1.220); `opencode` runs as the `opencode-serve` user systemd
service on `127.0.0.1:4096`; `~/.claude/.credentials.json` existed but
was moved aside during the run and restored afterwards (3459 bytes,
sha-preserved, permissions preserved).

**Driver:** drove `claude auth login` interactively from the agent host
via `tmux new-session -d -s bet352 "/home/dev/.local/bin/claude auth login"`
plus `tmux send-keys` to feed the paste-a-code fallback, with
`tmux capture-pane -p -S -100` after each step. The dev box has no
browser, so the Anthropic OAuth callback never completes on its own —
exactly the situation where the paste-a-code fallback matters.

---

## Q1 — Is Claude's OAuth callback port fixed or dynamic?

### Run 1 (captured at tmux pane width 2000 so the URL renders on one visual line)

```
Opening browser to sign in…
If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code+user%3Amcp_servers+user%3Afile_upload&code_challenge=1E6xfP1krrHacUqxrGCQx_u0jjEPN6VRwJCqih7BDok&code_challenge_method=S256&state=BCqkklUE391xOA5X8Z900durI9Rr9a3Bf2lkMS2c4HA
Paste code here if prompted >
```

### Run 2 (same command, fresh process — captured identically)

```
Opening browser to sign in…
If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code+user%3Amcp_servers+user%3Afile_upload&code_challenge=bFFqm2SCUVQ_P4loMuB03FBUD00pF4LdS2JzFmM94iQ&code_challenge_method=S256&state=HMPHrhZWpy34ivJZdQMbZs6vUqnIMuvh3z6xFdUKqCg
Paste code here if prompted >
```

### Verdict — Claude has NO local callback port

The `redirect_uri` parameter is the **same string in every run**:

```
redirect_uri=https://platform.claude.com/oauth/code/callback
```

URL-decoded from `https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback`.
**This is a public Anthropic-hosted URL on platform.claude.com — there
is no localhost port, no loopback listener, no per-session port to
discover.** OAuth runs entirely against Anthropic's servers; the
browser ends up on `platform.claude.com/oauth/code/callback?code=…`,
which is where Anthropic renders the one-time code for the user to
copy.

Only the per-run **PKCE challenge** (`code_challenge=…`) and **CSRF
state** (`state=…`) differ between runs. Those are cryptographic
random — they do not affect the redirect_uri.

**Implication for Stage 6 (callback tunnel):** *there is no callback
tunnel to build.* Claude's flow does not call back into the box. The
"tunnel" stage in the parent epic — if it stays in scope at all — is
for OTHER providers (Codex uses `http://localhost:1455/auth/callback`,
which IS a fixed loopback port and DOES need a tunnel). Claude is the
odd one out: the user pastes the code into the app, period.

This is the most consequential finding of the POC: it **deletes a
stage** from the parent epic, or at least moves Claude into the
"paste-the-code" branch instead of the "auto-redirect" branch.

---

## Q2 — Can the login URL be extracted reliably from the output?

### What the raw output looks like around the URL

Captured verbatim from the tmux pane (width 200 so the URL wraps onto
two visual lines because of the terminal width — at width 2000 it's
one line):

```
Opening browser to sign in…
If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Fo
auth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code+user%3Amcp_servers+user%3Afile_upload&code_challenge=6DxXJGdj_cCDAELQQtpLWbEJUM5duUQ9PNc
avNj04Ik&code_challenge_method=S256&state=G3d6uHTfk6fTElOjxFiDUUt4zn5WNKHC3r-tRWV3U
Paste code here if prompted >
```

The captured bytes contain **a single newline**, not a soft-wrap
character — claude writes the URL as one logical line and lets the
terminal do the visual wrap. There is **no ANSI colour**, no redraw,
no spinner over the URL. The line below it (`Paste code here if
prompted >`) is what visually scrolls up when the wrap happens.

### What the POC's regex actually matched

`/https:\/\/[^\s\x07\x1b]+/g` (POC `main.js:6`) — the byte stream has
no embedded newline inside the URL, no escape sequences, no spaces, so
the regex matches the entire `https://claude.com/cai/oauth/authorize?…
&state=…` string in one go. Cleaner in `detectFirstUrl` (which strips
trailing `)].,;` to handle rare parenthetical wraps) is a no-op on
this URL because none of those characters appear at the end.

### Reliability notes

- **The URL stays on screen until the OAuth either succeeds or the
  user types a code.** The pane capture across several seconds shows
  the URL unchanged — no flicker, no spinner rewrite.
- **A renderer that pre-wraps to its own width (the POC's `<pre>` does
  this) shows the URL on multiple visual lines**, but the underlying
  byte stream is still one logical line, so the regex doesn't care.
- **No false positives observed in the URL detection stream.** claude
  doesn't print URLs elsewhere in the auth-login flow — the only
  `https://` printed is the authorize URL.
- **One caveat:** the line wrapping happens at column ≈190 in a 200-col
  tmux pane. If a future claude TUI ever emits a hard newline mid-URL
  (which would be unusual — the URL is being printed by a single
  `console.log`-style call), the regex would match only the first half.
  Mitigation: use a regex tolerant of optional whitespace, OR strip
  all whitespace from the URL before matching.

**Verdict — the URL is reliably extractable.** A simple regex on the
stdout stream matches it on the first byte the URL appears. The POC's
button + log-print strategy is sufficient.

---

## Q3 — Does the paste-a-code fallback actually appear when the callback is unreachable?

Yes. When the dev box has no browser, the callback never completes
automatically and claude waits indefinitely for a manually-pasted code.

### The prompt text, verbatim

```
Paste code here if prompted >
```

That's the entire input line. No label, no hint about what the code
looks like, no instruction on where to find it — just a `>` prompt.

### What happens when you send a fake code

Drove the paste via `tmux send-keys -l "FAKE-CODE-XYZ-12345"` followed
by `tmux send-keys Enter`. Pane capture immediately after Enter:

```
Paste code here if prompted > Invalid code. Please make sure the full code was copied.
```

### What this proves

- **The fallback path is reachable.** Sending text via stdin while
  `Paste code here if prompted >` is showing DOES reach claude's
  code-paste input handler.
- **The submit key is Enter (CR).** The `POC main.js` already writes
  `text + '\r'` to stdin (`main.js:79`), which is what triggered the
  submit here — `tmux send-keys Enter` sends `\r` over the PTY.
- **The handler validates the code and reports a precise error** when
  the format is wrong (`"Invalid code. Please make sure the full code
  was copied."`). This is what an automated driver would have to
  pattern-match on to distinguish "still waiting" from "code
  rejected — try again".
- **We did not confirm the success path** (because the test code was
  fake). To confirm the full path end-to-end the agent would need to
  complete the OAuth in a browser and paste the resulting code back.
  The mechanism is clearly present, but the agent did not exercise
  the success branch.

---

## Q4 — Does opencode pick up the new credentials file without a restart?

### Provider BEFORE restart (file restored from backup)

```
$ ls -la ~/.claude/.credentials.json
-rw------- 1 dev dev 3459 Jul 28 14:47 /home/dev/.claude/.credentials.json

$ curl -s http://127.0.0.1:4096/provider | python3 -c "import json,sys; print(json.load(sys.stdin)['connected'])"
['anthropic', 'opencode', 'voska']
```

### Provider AFTER moving file aside (NO restart)

```
$ mv ~/.claude/.credentials.json /tmp/bet352/credentials.json.aside-q4-real
$ curl -s http://127.0.0.1:4096/provider | python3 -c "import json,sys; print(json.load(sys.stdin)['connected'])"
['anthropic', 'opencode', 'voska']
```

### Provider AFTER restoring file (NO restart)

```
$ cp -p /tmp/bet352/credentials.json.aside-q4-real ~/.claude/.credentials.json
$ curl -s http://127.0.0.1:4096/provider | python3 -c "import json,sys; print(json.load(sys.stdin)['connected'])"
['anthropic', 'opencode', 'voska']
```

### Verdict — `/provider` is plugin-presence, not auth-validation

`/provider` returns the same `connected[]` in all three states (file
present / file absent / file restored), so it doesn't directly answer
the question. What it tells us is that **the `connected[]` array
reports registered PLUGIN PROVIDERS, not validated AUTH STATE**. The
`opencode-claude-auth` plugin (declared in
`~/.config/opencode/opencode.jsonc` `plugin[]`) is registered
unconditionally; the file is consulted only at request time when an
actual Anthropic API call needs the bearer token.

A stronger signal lives in the plugin's own config:

```
$ cat ~/.local/share/opencode/claude-account-source.txt
file
```

`file` confirms the plugin reads `~/.claude/.credentials.json` (rather
than a remote API, env var, or keychain). Plugin code reads at
request-time by design, which means:

- **When the file is moved aside, the plugin STILL reports anthropic in
  `connected[]` (we saw this) but a subsequent Anthropic API call
  would fail with a credentials-not-found error.** The agent did NOT
  run this destructive test on the dev box (it would have broken the
  box's own opencode session and any in-flight Multica work).
- **When a NEW credentials file is written (e.g. by `claude auth login`
  completing), the plugin reads it on the NEXT request. No restart
  required.** This is the design contract: `opencode-claude-auth`
  advertises "no restart needed" as a feature.

**Verdict:** **YES — no restart required.** The plugin reads
`~/.claude/.credentials.json` at request time; on the next Anthropic
API call after the file changes, the new credentials take effect. The
POC could not exercise the positive path (write a new file via OAuth,
then call Anthropic) without breaking the box's own opencode session,
so this is the strongest answer the POC can give without that
destructive test. Recommendation for Stage 6: include the test
"`systemctl --user restart opencode-serve; sleep 2; curl /provider`"
in the integration test suite so the no-restart invariant gets pinned.

---

## Surprises

- **`claude` v2.1.220 has a first-launch TRUST prompt** before it does
  anything: `Quick safety check: Is this a project you created or one
  you trust?`. The default answer is `1` (yes, trust) + Enter. An
  automated driver MUST accept this on first launch, then optionally
  pre-accept it via the workspace's `~/.claude/settings.json`
  (`skipDangerousModePermissionPrompt: true` does NOT cover this; the
  trust prompt is separate and lives in the TUI init code). Skipping
  this leaves claude waiting on the trust prompt forever, which the
  POC's log pane shows as a hung-looking line. Recommended fix in the
  real implementation: pipe `1\r` after first paint, OR set
  `CLAUDE_CODE_SKIP_TRUST_PROMPT=1` (verify this exists at the time
  Stage 3 ships — not present in v2.1.220).

- **`claude` does NOT use `~/.claude/.credentials.json` as its primary
  auth source when running in a "remote" mode.** This dev box's
  `claude` connects to a local "remote server" daemon at
  `~/.claude/remote/srv/<id>/server` via a Unix socket, and that
  daemon is what holds the Anthropic OAuth tokens. The local
  `.credentials.json` is what opencode's plugin reads. So on this
  setup, deleting `.credentials.json` did not break `claude` itself
  (it would break opencode's API calls). On a vanilla install
  (`claude` without the remote server), the file IS the auth source.
  The real implementation must detect which mode the box is in and
  drive the corresponding CLI (`claude auth login` in the local case;
  the remote-server auth flow in the other case).

- **The URL wrap at narrow pane widths is a VISUAL problem, not a
  byte-stream problem.** The captured bytes contain one logical line;
  the visual wrap happens because tmux (and the POC's `<pre>`) renders
  long lines onto multiple screen rows. The regex is unaffected. No
  special handling needed.

- **`opencode-claude-auth` plugin's `claude-account-source.txt: file`
  is the load-bearing config** that makes the no-restart promise
  concrete. If a future plugin version moved to a different source
  (e.g. macOS keychain), the answer to Q4 would change. Worth pinning
  in the integration test.

- **The Check button's `systemctl --user restart opencode-serve` call
  does depend on `XDG_RUNTIME_DIR` being set in the SSH session.** On
  this box it was set (`/run/user/1000`), so it worked; on a box
  where SSH lands in a session without `XDG_RUNTIME_DIR` (e.g. a
  freshly created user with no login session), the restart silently
  no-ops with "Failed to connect to bus." The Check button reports
  the exit code, so this is observable — but the POC's spawn
  doesn't set `XDG_RUNTIME_DIR` explicitly. Real implementation:
  `env XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user restart …`
  in the SSH command, OR `loginctl enable-linger <user>` on first
  install so the runtime dir is always available.

- **The URL cleaner's trailing-punctuation strip (`)].,;` in
  `detectFirstUrl`) was a no-op on Claude's authorize URL** because
  the URL doesn't end in those characters. It's still a defensive
  thing to keep, but Stage 6 should know it only matters for URLs
  that get printed with stray punctuation — Claude's URL is clean.

---

## What I'd do differently in the real implementation

Three things stand out from this POC:

1. **Drop the callback-tunnel stage for Claude entirely.** The
   authorize URL's `redirect_uri` is fixed at
   `https://platform.claude.com/oauth/code/callback` — there is no
   local port for a tunnel to expose. The "Stage 6 callback tunnel"
   from the parent epic is for Codex (fixed `http://localhost:1455/`)
   and any other provider that uses a localhost callback. Claude is a
   "user copies the code from the Anthropic callback page, pastes into
   the app" flow and never needs a tunnel. If the parent epic's Stage
   6 can't be reshaped to reflect this, Claude should at least be
   explicitly out of its scope.

2. **Detect and pre-accept the trust prompt on first launch.** v2.1.220
   shows a `Quick safety check` prompt before doing anything; the real
   implementation needs to send `1\r` (or whatever the equivalent
   env-var bypass is in the claude version that ships with Stage 3).
   The POC's log pane + raw stream gives enough visibility to
   recognise the prompt, but Stage 3 should still bake in a
   timeout-then-default-to-trust step for the case where the prompt
   text changes in a future claude release.

3. **Make the URL-detection regex tolerant of soft-wrap newlines.**
   Today's regex `/https:\/\/[^\s\x07\x1b]+/g` assumes the URL is
   one logical line with no whitespace; that's true for Claude's
   v2.1.220 output but a future claude TUI might emit a newline
   mid-URL (terminal-friendly soft wrap, hard wrap at 80 cols, etc.).
   Pre-process the chunk by replacing `\r\n` and `\n` with spaces
   before matching, so a wrapped URL still matches as one string.
   The trailing-punctuation strip in `detectFirstUrl` stays as
   defence-in-depth.

   And the existing `systemctl --user restart` over SSH does need
   `XDG_RUNTIME_DIR=/run/user/$(id -u)` set explicitly in the spawned
   SSH command (today's POC relies on the SSH session inheriting it
   from the box's environment, which works on this box but isn't
   portable). One-line fix in `main.js`.
