# WS10 review — round3

All five round-2 findings are resolved:
- #1: F12 and the client table now provide launcher discovery, both wire types, and the flag resolver from WS10/A1. WS04 consumes those same members in A2; the master registry agrees. The resolver/update rules match `src/renderer/chatShared.tsx:504-511` and `src/renderer/settingsShared.ts:41-57`.
- #2: WS04's M-10-1 receipt now matches WS10 and the canonical ledger, including `preference(for:).colorScheme`, both provider files, and the A2 applier.
- #3: §0.2 now serializes batch reset/undo against commits and T1 tests both interleavings.
- #4: F18 uses the existing `UpgradeStatus.isUpgradeRefusal(statusCode:body:)`; F14 uses `serverURL?.absoluteString`; `RawRPCResponse` is explicitly in the Foundation-only models.
- #5: C2 defines one-shot section scrolling after load, nil/unknown fallback, and a non-first-section test. M-10-1/2/3 and incoming M-09-1 now match the canonical ledger; Settings presentation is correctly WS04's own work.

Mount/member audit: WS03 references, WS05 forge status, WS08 restart, WS04 launcher/theme/removal consumers, and WS09's incoming Models entry are consistent. The canonical M-09-4 later extends the removal closure with WS09 cleanup, so that cleanup need not be duplicated in WS10's A1 mount. No new blocking issue found.

1. **SHOULD — C2 deep-link view hierarchy.** The new text says to wrap `sectionList` in `ScrollViewReader`, but that list currently sits inside the screen's existing `ScrollView`. Specify the reader around the actual scrolling container rather than only the nested section stack, so the proxy clearly owns the scroll view being targeted. **Evidence:** `10-settings-box.md:1304-1316`; `mobile/native/MantaUI/SettingsScreen.swift:44-64` has `ScrollView { VStack { … sectionList … } }`. **Fix:** pin `ScrollViewReader { proxy in ScrollView { … } }`, with the load/one-shot scroll task inside the proxy's scope. Keep the existing target test, and verify the actual non-first-section landing on the Mac—the pure target helper alone cannot verify scrolling.

2. **NIT — §0.2 confirmed-value invariant wording.** “Values holds only confirmed values” and “the box and the screen always end with the same value” remain broader than the chosen implementation: reset/undo deliberately retain optimistic values on a failed batch write. The new guard fixes interleaving, not that explicitly deferred failure behavior. **Evidence:** `10-settings-box.md:93,116-134`; `mobile/native/MantaUI/MantaSettingsStore.swift:173-224` mutates values before reset/undo writes and retains them on failure. **Fix:** scope the confirmed-value claim to individual commits and the ordering claim to successful serialized writes; retain the explicit optimistic-reset deferral without promising it has been fixed.

VERDICT: APPROVE
