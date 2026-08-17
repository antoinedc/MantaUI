import XCTest
@testable import MantaUI

// ===========================================================================
// BET-1027 — every edge of the pure gesture machine (VoiceGesture), driven
// without any real waiting: `elapsedMs` is fed in by hand, so the cap, the
// min-duration and the pause re-base are all tested against the diagram.
// ===========================================================================

final class VoiceGestureTests: XCTestCase {

    private func step(
        _ phase: VoicePhase,
        _ input: VoiceInput,
        elapsedMs: Int,
        isRTL: Bool = false
    ) -> (VoicePhase, VoiceEffect) {
        VoiceGesture.transition(currentPhase: phase, input: input, elapsedMs: elapsedMs, isRTL: isRTL)
    }

    // MARK: - press / arm

    func testPressArmsRecording() {
        let (phase, effect) = step(.idle, .press, elapsedMs: 0)
        XCTAssertEqual(phase, .recordingHeld)
        XCTAssertEqual(effect, .haptic(.arm))
    }

    func testPressIgnoredWhileRecording() {
        let (phase, effect) = step(.recordingHeld, .press, elapsedMs: 100)
        XCTAssertEqual(phase, .recordingHeld)
        XCTAssertEqual(effect, .none)
    }

    // MARK: - release / min duration

    func testReleaseUnderMinDurationSilent() {
        // 399ms — a mis-tap: silent, NO send effect (decision #7).
        let (phase, effect) = step(.recordingHeld, .release, elapsedMs: 399)
        XCTAssertEqual(phase, .idle)
        XCTAssertEqual(effect, .none)
    }

    func testReleaseAtMinDurationSends() {
        let (phase, effect) = step(.recordingHeld, .release, elapsedMs: 401)
        XCTAssertEqual(phase, .idle)
        XCTAssertEqual(effect, .send)
    }

    // MARK: - drag to lock / cancel

    func testDragUpLocks() {
        let (phase, effect) = step(.recordingHeld, .drag(dx: 0, dy: -100), elapsedMs: 100)
        XCTAssertEqual(phase, .recordingLocked)
        XCTAssertEqual(effect, .haptic(.lock))
    }

    func testLockedTakeIgnoresFurtherDrags() {
        let (phase, effect) = step(.recordingLocked, .drag(dx: -100, dy: -100), elapsedMs: 150)
        XCTAssertEqual(phase, .recordingLocked)
        XCTAssertEqual(effect, .none)
    }

    func testDragLeftArmsCancelling() {
        let (phase, effect) = step(.recordingHeld, .drag(dx: -100, dy: 0), elapsedMs: 100)
        XCTAssertEqual(phase, .cancelling)
        XCTAssertEqual(effect, .haptic(.cancelArmed))
    }

    func testDragBackFromCancellingReturnsToHeld() {
        let (phase, _) = step(.cancelling, .drag(dx: 100, dy: 0), elapsedMs: 200)
        XCTAssertEqual(phase, .recordingHeld)
    }

    func testReleaseWhileCancellingDiscards() {
        let (phase, effect) = step(.cancelling, .release, elapsedMs: 3000)
        XCTAssertEqual(phase, .idle)
        XCTAssertEqual(effect, .discard)
    }

    // MARK: - cap (the take is KEPT, never discarded)

    func testCapEmitsSendNeverDiscard() {
        let (phase, effect) = step(.recordingHeld, .tick, elapsedMs: Waveform.Constants.maxDurationMs)
        XCTAssertEqual(phase, .idle)
        XCTAssertEqual(effect, .send)
    }

    func testCapEmitsSendWhileLockedToo() {
        let (phase, effect) = step(.recordingLocked, .tick, elapsedMs: Waveform.Constants.maxDurationMs + 1)
        XCTAssertEqual(phase, .idle)
        XCTAssertEqual(effect, .send)
    }

    func testBelowCapDoesNotAutoSend() {
        let (phase, effect) = step(.recordingHeld, .tick, elapsedMs: Waveform.Constants.maxDurationMs - 1)
        XCTAssertEqual(phase, .recordingHeld)
        XCTAssertEqual(effect, .none)
    }

    // MARK: - interrupted (any phase → discard)

    func testInterruptedWhileHeldDiscards() {
        let (phase, effect) = step(.recordingHeld, .interrupted, elapsedMs: 2000)
        XCTAssertEqual(phase, .idle)
        XCTAssertEqual(effect, .discard)
    }

    func testInterruptedWhileLockedDiscards() {
        let (phase, effect) = step(.recordingLocked, .interrupted, elapsedMs: 2000)
        XCTAssertEqual(phase, .idle)
        XCTAssertEqual(effect, .discard)
    }

    func testInterruptedWhilePausedDiscards() {
        let (phase, effect) = step(.paused, .interrupted, elapsedMs: 2000)
        XCTAssertEqual(phase, .idle)
        XCTAssertEqual(effect, .discard)
    }

    func testInterruptedWhileIdleNoop() {
        let (phase, effect) = step(.idle, .interrupted, elapsedMs: 0)
        XCTAssertEqual(phase, .idle)
        XCTAssertEqual(effect, .none)
    }

    // MARK: - pause / resume (decision #5 — paused time excluded from cap)

    func testPauseThenResumeExcludesPausedInterval() {
        // A locked take at 250s (below the 300s cap) pauses.
        let (paused, _) = step(.recordingLocked, .tapPause, elapsedMs: 250_000)
        XCTAssertEqual(paused, .paused)

        // While paused the caller's elapsed does NOT advance (re-based) — a
        // tick at the same 250s stays paused and never fires the cap. If the
        // paused wall-time had counted, this would have reached the cap.
        let (duringPause, effectDuring) = step(.paused, .tick, elapsedMs: 250_000)
        XCTAssertEqual(duringPause, .paused)
        XCTAssertEqual(effectDuring, .none)

        // Resuming returns to the locked take; still below cap, still live.
        let (resumed, _) = step(.paused, .tapResume, elapsedMs: 250_000)
        XCTAssertEqual(resumed, .recordingLocked)
        let (live, effectLive) = step(.recordingLocked, .tick, elapsedMs: 250_000)
        XCTAssertEqual(live, .recordingLocked)
        XCTAssertEqual(effectLive, .none)
    }

    func testPauseAndResumeOnlyFromTheirStates() {
        XCTAssertEqual(step(.idle, .tapPause, elapsedMs: 0).0, .idle)
        XCTAssertEqual(step(.recordingHeld, .tapPause, elapsedMs: 100).0, .recordingHeld)
        XCTAssertEqual(step(.idle, .tapResume, elapsedMs: 0).0, .idle)
    }

    // MARK: - locked bar taps

    func testTapSendFromLocked() {
        let (phase, effect) = step(.recordingLocked, .tapSend, elapsedMs: 5000)
        XCTAssertEqual(phase, .idle)
        XCTAssertEqual(effect, .send)
    }

    func testTapDiscardFromLocked() {
        let (phase, effect) = step(.recordingLocked, .tapDiscard, elapsedMs: 5000)
        XCTAssertEqual(phase, .idle)
        XCTAssertEqual(effect, .discard)
    }

    // MARK: - RTL mirroring

    func testRTLMirrorsCancelDirection() {
        // In LTR, dragging left cancels; in RTL the SAME physical drag (right
        // in an RTL layout) is the cancel gesture.
        let ltrRight = step(.recordingHeld, .drag(dx: 100, dy: 0), elapsedMs: 100)
        XCTAssertEqual(ltrRight.0, .recordingHeld, "LTR: dragging right is not cancel")

        let ltrLeft = step(.recordingHeld, .drag(dx: -100, dy: 0), elapsedMs: 100)
        XCTAssertEqual(ltrLeft.0, .cancelling)

        let rtlRight = step(.recordingHeld, .drag(dx: 100, dy: 0), elapsedMs: 100, isRTL: true)
        XCTAssertEqual(rtlRight.0, .cancelling, "RTL: dragging right must arm cancel (mirrored)")

        let rtlLeft = step(.recordingHeld, .drag(dx: -100, dy: 0), elapsedMs: 100, isRTL: true)
        XCTAssertEqual(rtlLeft.0, .recordingHeld, "RTL: dragging left must not cancel (mirrored)")
    }

    // MARK: - tap-toggle (decision #5 — tap #1 starts, tap #2 stops)

    func testTapToggleFromIdleStartsHeld() {
        // Tap #1 starts a finger-up take showing the held surface.
        let (phase, effect) = step(.idle, .tapToggle, elapsedMs: 0)
        XCTAssertEqual(phase, .recordingHeld)
        XCTAssertEqual(effect, .haptic(.arm))
    }

    func testTapToggleFromHeldSends() {
        // Tap #2 while held: "a second tap stops" → stop and send.
        let (phase, effect) = step(.recordingHeld, .tapToggle, elapsedMs: 300)
        XCTAssertEqual(phase, .idle)
        XCTAssertEqual(effect, .send)
    }

    func testTapToggleFromLockedSends() {
        let (phase, effect) = step(.recordingLocked, .tapToggle, elapsedMs: 5000)
        XCTAssertEqual(phase, .idle)
        XCTAssertEqual(effect, .send)
    }

    func testTapToggleFromPausedSends() {
        let (phase, effect) = step(.paused, .tapToggle, elapsedMs: 5000)
        XCTAssertEqual(phase, .idle)
        XCTAssertEqual(effect, .send)
    }

    func testTapToggleFromCancellingIgnored() {
        let (phase, effect) = step(.cancelling, .tapToggle, elapsedMs: 3000)
        XCTAssertEqual(phase, .cancelling)
        XCTAssertEqual(effect, .none)
    }

    // MARK: - drag → progress mapping (view-facing, BET-1028)

    func testLockProgress() {
        XCTAssertEqual(VoiceGesture.lockProgress(dy: 0), 0, accuracy: 0.0001)
        XCTAssertEqual(VoiceGesture.lockProgress(dy: -80), 1, accuracy: 0.0001)
        XCTAssertEqual(VoiceGesture.lockProgress(dy: -40), 0.5, accuracy: 0.0001)
        // Clamped above threshold.
        XCTAssertEqual(VoiceGesture.lockProgress(dy: -200), 1, accuracy: 0.0001)
        // Positive dy (dragging down) is never lock progress.
        XCTAssertEqual(VoiceGesture.lockProgress(dy: 40), 0, accuracy: 0.0001)
    }

    func testCancelProgressLTR() {
        XCTAssertEqual(VoiceGesture.cancelProgress(dx: 0, isRTL: false), 0, accuracy: 0.0001)
        XCTAssertEqual(VoiceGesture.cancelProgress(dx: -64, isRTL: false), 1, accuracy: 0.0001)
        XCTAssertEqual(VoiceGesture.cancelProgress(dx: -32, isRTL: false), 0.5, accuracy: 0.0001)
        // Clamped.
        XCTAssertEqual(VoiceGesture.cancelProgress(dx: -200, isRTL: false), 1, accuracy: 0.0001)
        // Dragging right is not cancel in LTR.
        XCTAssertEqual(VoiceGesture.cancelProgress(dx: 64, isRTL: false), 0, accuracy: 0.0001)
    }

    func testCancelProgressMirrorsForRTL() {
        // In RTL the SAME physical drag (right) advances cancel, mirroring the
        // machine's own horizontal mirror.
        XCTAssertEqual(VoiceGesture.cancelProgress(dx: 64, isRTL: true), 1, accuracy: 0.0001)
        XCTAssertEqual(VoiceGesture.cancelProgress(dx: 32, isRTL: true), 0.5, accuracy: 0.0001)
        XCTAssertEqual(VoiceGesture.cancelProgress(dx: -64, isRTL: true), 0, accuracy: 0.0001)
    }
}
