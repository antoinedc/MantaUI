# WS08 review — round3

## Round-2 disposition

| Finding | Result |
|---|---|
| R2-1 — late provider-wide cancellation | Resolved for the reported sequence. The app-lifetime `ProviderOAuthLease` serializes start and retirement across sheet recreation; B waits until A's start and cleanup finish. Reducer and async gated-start tests explicitly cover the sequence (`08-accounts.md:284–328,647–655`). Unique-key cleanup remains separate. |
| R2-2 — reconciliation lacks original state | Resolved. `before: ProviderEndpoint?` is now explicit, callers supply it, and tests distinguish identical reply/read-back/expect with different original selections (`08-accounts.md:754–797`). |
| R2-3 — conflicting mount ledgers | Resolved. Master canonical rows M-08-1/2/3 and M-09-6 agree with WS08; WS09 records the observer and its test, and accepts the price-link mount. The declined direct-seat jump and its unused parameter are removed. See `00-master.md:414–422`, `09-models-usage.md:1362–1372`, and WS08's Mount tables. |

Client-member registry checked: WS08 retains its own account/provider/PTY wrappers and consumes WS10's `opencodeRestart() -> OkResult`; no conflicting owner or signature found. The four-source/three-test manifest agrees with canonical M-08-3. No new blocking issue found.

## Findings

1. **SHOULD — ProviderOAuthLease cancellation feedback.** The new lease contract loses the cancellation error that the explicit Cancel UI promises to report: both the injected cancel closure and `retire` return `Void` without throwing, while the production example uses `try?`. The prose also says to log a thrown error, which that example cannot do. **Evidence:** `08-accounts.md:302–312,323–324` versus F3's explicit failure-banner requirement at `:613–618`; the underlying server action is an RPC (`src/server/rpc.mjs:2262–2266`) whose transport can fail. **Fix:** return a cancellation result from `retire` (or expose an attempt-scoped failure callback), and use explicit do/catch in the injected transport closure. Preserve the specified lease-release policy, but let explicit Cancel display its failure and background cleanup log it. Add a failed-cancel test asserting the caller receives the failure.

2. **SHOULD — F4 retry after an unconfirmed write.** The new retry shortcut confirms a save merely because the ID and base URL match. That bypasses the shared classifier and can report “Added … with N models” when the saved selection differs from the submitted selection. The main reconciliation path correctly requires the expected selection; the retry path should do the same. **Evidence:** `08-accounts.md:735–738` uses only ID/base URL, whereas `:756–773` defines the expected enabled-model set; `src/server/providers.mjs:528–564` explains why persistence and application can diverge. **Fix:** retain the original write snapshot/expectation while unconfirmed, feed the fresh read through the shared classifier, and report partial rather than confirmed when it differs. Test a matching ID/URL with a different model selection; also define that editing the draft does not rewrite the pending attempt's expectation.

VERDICT: APPROVE
