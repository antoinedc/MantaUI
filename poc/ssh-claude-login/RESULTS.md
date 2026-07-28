# Stage 1 (POC) — RESULTS

This file is the real deliverable of the POC. The Electron app is just
how the answers below were obtained. Run the app against a real box,
paste raw output under each question, and answer the yes/no questions
plainly.

**Pre-flight (check the box actually meets the assumptions before you start):**

- `which claude` → path present.
- `which opencode` → path present.
- `~/.claude/.credentials.json` → **absent** (move any existing one aside and
  restore after the run).
- `systemctl --user status opencode-serve` → active.
- `curl -s http://127.0.0.1:4096/provider` → JSON with `connected` array.

---

## Q1 — Is Claude's OAuth callback port fixed or dynamic?

Capture the authorize URL the login prints and read its `redirect_uri`
parameter. Note the port. Restart the login a second time and note
whether the port changed. (For contrast, Codex's is fixed at 1455.)

### Run 1

```
<paste the URL here>
```

Port from `redirect_uri`: **TODO**

### Run 2

```
<paste the URL here>
```

Port from `redirect_uri`: **TODO**

### Verdict

**TODO** — fixed / dynamic, and what that means for Stage 6's callback
tunnel (cheap = port discovery not needed; dynamic = the tunnel must
discover).

---

## Q2 — Can the login URL be extracted reliably from the output?

Report exactly what the raw output looks like around the URL — line
wrapping, escape sequences, redraws. The POC deliberately does NOT strip
ANSI from the log pane (reliability is the question) and prints a
`[detected URL: …]` marker whenever the URL regex matches. If the
detection matches but the visible URL on screen differs from the regex
hit, paste both — that is the answer.

### Raw output around the URL

```
<paste verbatim from the POC log pane>
```

### What the regex actually matched

```
<the URL the POC's button offered to open>
```

### Reliability notes

**TODO** — does the URL stay on screen long enough to match? does the
TUI redraw it across multiple lines? does the regex catch a real URL or
a UI element that looks like one (e.g. a URL in a "recent sign-ins"
sidebar)? any false positives?

---

## Q3 — Does the paste-a-code fallback actually appear when the callback is unreachable?

Quote the prompt text verbatim. Confirm that pasting the code into stdin
completes the login.

### Prompt text from `claude`

```
<paste verbatim>
```

### Did the paste complete the login?

**TODO** — yes / no, and what happened immediately after (success banner,
new prompt, error).

---

## Q4 — Does opencode pick up the new credentials file without a restart?

Use the before/after `/provider` output from the Check button. State
plainly: yes, or no and a restart is required.

### Provider BEFORE restart

```
<paste verbatim from the POC's "Provider BEFORE restart" pane>
```

`connected` array, anthropic present? **TODO**

### Provider AFTER restart

```
<paste verbatim from the POC's "Provider AFTER restart" pane>
```

`connected` array, anthropic present? **TODO**

### Verdict

**TODO** — yes (no restart needed) / no (restart required).

---

## Surprises

Anything not covered above: how long each step took, whether `claude`
asked anything else on first launch (theme, telemetry, trust prompts),
and whether those extra prompts would break an automated driver.

**TODO**

---

## What I'd do differently in the real implementation

One short paragraph — the things this POC taught that the real
implementation should or shouldn't carry over. Examples to consider:
buffered-flush policy for the log pane, escape-code stripping only when
needed, URL detection tolerance (anchored on known Anthropic URL
shapes vs. first-`https://`), stdin write strategy (`\r` vs. `\n` vs.
`\x1b\r` — the iTerm2 sequence), handling of the first-launch prompts
in Q-surprises, retry semantics on a dropped SSH session.

**TODO**
