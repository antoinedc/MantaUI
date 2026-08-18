## Summary

Deprecated models (`OpencodeModel.status === "deprecated"`) are now **disabled by default** (not removed — still importable/visible) in the **main model picker** and **skipped by subagent auto-registration**. A persisted, shared `optInModels` set (`"providerID/modelID"`) flips a given deprecated model back to usable on BOTH paths. Ships exactly one new config set mirroring `deactivatedMainModels`'s existing plumbing — no new IPC channel, no new persistence.

The two axes stay separate: the provider fact (`status === "deprecated"`) and the user's persisted opt-in (`optInModels`). `enabled` and `deactivatedMainModels` are untouched.

## Changes

- **`chatUtils.ts`**: `isDeprecated(m)` predicate (the renderer's single comparison) + `mainPickerGroups(...)` — a main-picker candidate set that KEEPS deprecated models (grouped, sorted, fast-folded exactly as `selectableModelGroups`) but reports which are disabled via `disabledKeys`.
- **`ModelMenu.tsx` / `ModelPicker.tsx`**: a deprecated model not yet opted in renders as a greyed, non-roving row with a small "Enable deprecated" action (outside the selectable/aria-option set). Once opted in it's a normal selectable row. Main picker feeds `mainPickerGroups` and the shared opt-in set.
- **Persistence**: `optInModels: string[]` as an `AppConfig` field + a `store` mirror + `optInModel()` action, mirroring `deactivatedMainModels` verbatim (configGet/configUpdate only). Wired through `ChatPanel` → `InputArea` and `NewSessionScreen` → `ModelPicker`.
- **Subagents**: `reconcileSubagents({ models, existingAgents, deactivated, optIn })` skips deprecated models unless their key is in `optIn`; an already-registered (deprecated) block is still left untouched (preserve-existing unchanged). `syncSubagents` (providers.mjs) and the `opencode:sync-subagents` RPC pass `optIn` through. `ModelsCard` (the SubagentsCard) shows a deprecated model disabled-by-default with the same opt-in action, which immediately re-syncs subagents.

## Deliberate scoping

- The **delegate** model picker (`Cards.tsx`) is unchanged — it keeps filtering deprecated via `selectableModelGroups` (the issue scopes only the main picker + subagents, and the shared opt-in set is what both listed paths read).
- `listModels` / `_normalizeProviderModel` are untouched — deprecated models remain importable.
- No iOS changes (mirrored in a follow-on ticket).

## Note on the two predicates

The issue asks for "one predicate" but `subagentSync.mjs` runs under plain node (server `node:test`; `providers.mjs` imports it) and therefore cannot import the TS `chatUtils.ts`. It carries its own one-line `isDeprecatedModel` for the deprecated-vs-opt-in gate; the renderer path uses `chatUtils.isDeprecated`. Same single guarded comparison in each runtime, necessitated by the module boundary.

## Main-picker opt-in and subagent re-registration

Opting in from the main picker persists to the shared set immediately (main row flips on); subagent re-registration is honored by the **next reconcile** (the set is the single source `reconcileSubagents` reads on every card open / sync). `ModelsCard`'s enable action re-syncs subagents immediately.

**Files changed:** `17` (455 insertions, 21 deletions) — see diff.

**Verification results:**
- PR branch (`multica/BET-1139-deprecated-model-optin @ fc902a36`):
  - typecheck: exit 0. Errors: none. log sha256: `b3e043f9cf03e405d51dbe05ecf0b311f738ab572192d72a50f6b28221a92f13`
  - test: exit 0, **3110 pass / 7 skip / 0 fail**. Failures: none. log sha256: `08da9a1f33470d1f32df4cd0962e4e9f3c7fdc144b3a203fb664c6d5ae936e07`
- Base (`main @ 4a548c26`):
  - typecheck: exit 0. Errors: none. log sha256: `b3e043f9cf03e405d51dbe05ecf0b311f738ab572192d72a50f6b28221a92f13`
  - test: exit 0, **3098 pass / 7 skip / 0 fail**. Failures: none. log sha256: `6e1eb7ad06b18974dae093d58b530bc0b7d6a9b852466c3e37392a6e39c86161`
- **Conclusion:** 0 new test failures; 12 new tests added (isDeprecated, mainPickerGroups, subagent opt-in/reconcile, ModelMenu disabled rows), all passing.

Logs cached at `/tmp/typecheck-pr.log`, `/tmp/typecheck-main.log`, `/tmp/test-pr.log`, `/tmp/test-main.log`.

**Base: origin/main @ `4a548c26`**
