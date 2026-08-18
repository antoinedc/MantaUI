# BET-1113 — iOS Simulator test-run report (macos verification)

Verified on Antoine's Mac (agent `macos`) against the exact branch source
(`multica/BET-1113-ios-keychain-entitlement`, head `bb4e65ff`), in a clean
git worktree so the shared checkout was not disturbed.

## Environment

- Xcode 26.6 (Build 17F113)
- Swift 6.3.3
- iOS Simulator: iPhone 17 Pro — iOS 26.5 (device id `25EEA3D7-2995-4B76-A991-7F817E94A4FB`, iOS 26.5)
- Project regenerated with `xcodegen generate` from `mobile/native/project.yml`
  (the committed source of truth, which wires `CODE_SIGN_ENTITLEMENTS` =
  `MantaUITests/MantaUITests.entitlements` into the `MantaUITests` target).

## Result — the reported failure is fixed

The failing test now passes:

```
Test Case '-[MantaUITests.MantaTransportTests
  testTokenRoundTripsThroughKeychainAndIsAbsentFromUserDefaults]' passed (0.013 seconds).
Test Suite 'MantaTransportTests' passed at 2026-08-18 14:35:24.867.
     Executed 1 test, with 0 failures (0 unexpected) in 0.013 (0.014) seconds
** TEST EXECUTE SUCCEEDED **
```

No `errSecMissingEntitlement` (`-34018`) and the `UserDefaults`-absence
assertion is green: the token round-trips through the Keychain and is absent
from `UserDefaults`.

## Full MantaUITests suite

```
Executed 552 tests, with 0 failures (0 unexpected) in 1.079 (1.311) seconds
** TEST SUCCEEDED **
```

This reproduces/re-exceeds the CI suite scale noted in BET-1113 (CI reported
~548 total; local run has 552 due to in-flight test additions on the branch).

## Conclusion

manta-dev's fix (add `keychain-access-groups` entitlement to the `MantaUITests`
target via `mobile/native/project.yml` + `MantaUITests.entitlements`) resolves
the simulator Keychain round-trip failure. Ready for manta-reviewer.
