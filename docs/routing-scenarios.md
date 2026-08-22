# Routing — live behaviour scenario decks

The end-to-end acceptance surface for Automatic Manta Routing. These are run on a
real box against a running app — they exist because the routing epic's original
verification (roughly 40 scenarios) was written and never executed, and a dead
feature passed as done. Every line is a step and its expected result; run them
before the routing set is called done and record the actual result per line (not
"✓") on the owning issue.

- **Deck A — the scenario replay harness** (BET-1276): programmatic replay of
  recorded scenarios through the routing core — `npm run routing:deck`. This
  file's Deck A section below.
- **Deck B — the live behaviour checklist** (BET-1277): this file's Deck B
  section below — a human-in-the-app checklist, run once before the routing set
  is done.

---

## Deck A — the scenario replay harness

Run on a live box against its real routing state:

```
npm run routing:deck
```

It replays 30 scenarios through the routing DECISION core (`chooseModel`) with
the box's real catalogue, usage snapshots and ledger (via the dev-only
`overrides` bag on `routing:choose` — see `src/shared/routingOverrides.mjs`),
judging each against DECISION PROPERTIES (tier, cost, exclusions, determinism),
never a model name. It prints one row per scenario plus the inert-signal
section, and exits non-zero on any failure.

**It is NOT part of `npm test`.** It depends on the box's live account /
catalogue / ledger state, which the suite forbids. It is a diagnostic you run
and read.

**Prompt content is NOT an input to routing.** The decision never reads the
prompt — it is a lookup over the agent, the preset, conversation size,
attachments, account state and the user's tick list. The deck varies exactly
those inputs. Do NOT rebuild it around prompt difficulty; a deck that had to
change every time a prompt "felt" hard would fail every scenario and teach us
nothing.

The scenario set and matcher vocabulary are closed and live in
`scripts/routing/scenarios.json` + `scripts/routing/deck-a.mjs` (12b/12c/12d).
A scenario's expectation is a property of the decision, so a new model or a
renamed provider never requires editing the deck — the property is what the
routing set is built on.

**The matcher vocabulary is the issue's closed §12b list, plus two documented
set-membership additions** — `winnerIn` (winner is one of the given endpoint
keys) and `winnerNotIn` (winner is none of them), the generalised positive
complement of §12b's negative-only `excludes`. The §12c scenarios' set-membership
claims (A14/A16/A17/A20/A21/A26) cannot be expressed with `excludes` alone, so
these two complete it; they remain decision-property assertions (endpoint keys,
never model names). These should be named in the epic's closed list so the spec
stays the single source of truth.

---

## Deck B — the live behaviour checklist

Run once, before the routing set is called done, against a running box and app.
Each line is a step and its expected result. Record the ACTUAL observed result
per line (not a tick) on BET-1277 — "as expected" and "the chip lagged one turn"
look identical as ticks and are completely different findings. Anything that
fails becomes its own follow-up issue. Do not fix unrelated failures inside the
checklist — its job is to find them.

### Auto, on and off

1. Turn Auto on from the composer dropdown → the chip reads **"Auto"** with the accent treatment.
2. Send a turn → the chip reads **"Auto · <model>"**, and that model is the one the transcript says answered.
3. Open the dropdown → the Auto row is **first**, above Server default, and its sub-line names the Balance preset and the reason.
4. **Pick a model → the chip stops saying Auto immediately**, and exactly one row is selected.
5. Send another turn → **no `[router]` line** appears in the box log for it.
6. Re-pick Auto → a fresh decision is made and the reason says the user requested it.
7. Adjust the effort segment while on Auto → **still on Auto**.

### Boundaries and stickiness

8. A long multi-tool turn → the model does **not** change within it.
9. A long conversation with quota drifting → the model does **not** change between boundaries.
10. Compact the session → a fresh decision is made, and the model does **not** change unless something genuinely changed (hysteresis).
11. Grow the conversation past the incumbent's context limit → it switches, and the reason names the constraint.
12. Switch agent (plan ↔ build) → a fresh decision, reason names the boundary.

### Honesty

13. Stop `manta-server`'s routing dependency (delete the catalogue cache and restart) → a turn still sends, **and an error banner says the router was unreachable**.
14. Open a session with a hand-picked model → **no routing RPC on mount**, model unchanged.
15. Two windows, one Auto one fixed → independent; both survive a full app relaunch.
16. Point a custom endpoint at a bad key, send a turn → a notification arrives, and the Accounts row says the same thing the notification did.

### Settings

17. Settings → Models shows exactly **three** cards in the contract's order, and **one** "Plan usage" surface.
18. The identify block does not render when every endpoint is described; it renders with an explanatory line when the catalogue is unavailable.
19. **Click every control in Settings → Models and Settings → Accounts.** Record one line each saying what visibly happened. Any "nothing" is a failure.
20. Untick every Main model, send a turn with Auto on → the turn runs on the incumbent and the reason says no candidate passed. Nothing fails; nothing reaches outside the ticks.
