# BET-918 — on-device re-verify of BET-913 force-quit persistence (BET-901 check 1)

On-device verification against a **real box running the merged `main` server
code** (BET-913's `/events` running-snapshot replay, verified live at the wire
level: a fresh `/events` connection instantly receives the `running` frame with
the original `since`, not `0`).

## Target

- **Box**: disposable staging test box `827ed7de60131274059f768c0befd1a6`
  (opencode `anthropic` provider connected; a real turn runs on it).
- **App**: `MantaUI` built from `main` (commit `ec32577b`), Debug, installed on
  the iOS 26.5 simulator (iPhone 17 Pro).
- **Method**: drove a real opencode turn on the box, observed the app's running
  indicator pre force-quit, force-quit, waited ~60s, relaunched, reopened the
  same chat, and read the running indicator and the session-list row timer.

## Observed timers (from the accessibility-tree dump, full tree in
`bet918-hierarchy.txt`, screenshots in this folder)

| Stage | Surface | Timer shown |
|---|---|---|
| PRE (chat, before force-quit) | running indicator | `(37s)` |
| POST-LIST (after force-quit + ~60s reopen) | session-list row | `1m 46s` |
| POST (chat, reopened) | running indicator | `(1m 51s)` |

Timeline: turn `since` on the box was `1786728985157`; the POST-LIST snapshot
was taken at `1786729091489`, i.e. **106s of true elapsed**, matching the
displayed `1m 46s`. The PRE value was `37s`, so after the ~60s force-quit/
reopen gap the timer resumed from where the turn actually started — it did **not**
reset to `0s` and was **not absent** on either the session list or the chat
running indicator.

## Result

**BET-901 check 1 PASSES** on-device against the merged BET-913 server fix.
(Cursor-precise AX excerpts below.)

```
POST-LIST session row:  Button, label: 'sh, running · sonnet 4.6'
                        StaticText, label: '1m 46s'
POST chat running-row:  StaticText, identifier: 'running-indicator',
                        label: 'Considering…, (1m 51s)'
```
