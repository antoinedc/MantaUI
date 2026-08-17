import Foundation

// ===========================================================================
// VoiceGesture.swift — the PURE recording gesture state machine.
//
// Deliberately contains NO AVFoundation, NO SwiftUI, NO timers, and NO clocks.
// It is a value-driven transition function: feed it `(currentPhase, input,
// elapsedMs)` and it returns `(nextPhase, effect)`. `elapsedMs` is an input,
// not something the machine tracks — the caller owns time (and the pause
// re-basing that keeps paused time out of the cap, decision #5).
//
// ```
// Idle ─────────────────────────────────────────► RecordingHeld
//   │                                                │
//   │ press                                          │ release(hold) → .send
//   │                                                │ release(too short) → Idle (silent)
//   ▼                                                │ drag up   > lockThreshold → RecordingLocked
// RecordingLocked ◄───────────────────────────────── │ drag left > cancelThreshold → Cancelling
//   │  tapSend ──► .send (bar button)                │ tapLock (release under tapHoldMs) → RecordingLocked
//   │  tapDiscard ───► .discard                      │
//   │  tapPause ──► Paused ⇄ tapResume               │
// Cancelling ── dragBack ──► RecordingHeld           │
//            └─ release ──► .discard                 │
// any ── elapsed ≥ 300_000ms ──► .send          (the take is KEPT)
// any ── interrupted ──► .discard
// ```
//
// Recording starts on PRESS (decision #4); the hold threshold only decides, at
// release, whether the press was a tap or a hold. Reaching the cap SENDS the
// take (decision #6). A release under `VOICE_MIN_DURATION_MS` discards
// silently (decision #7). Haptic intents are part of the machine's output so
// the UI layer stays dumb: fire on arm, lock, cancel-armed, and send.
// ===========================================================================

/// The recording gesture/phases. Mirrors the desktop `VoicePhase` names so the
/// two implementations are greppable as a pair.
enum VoicePhase: Equatable {
    case idle
    case recordingHeld
    case recordingLocked
    case paused
    case cancelling
}

/// Which haptic the UI should play (fired on arm, lock, cancel-armed, send).
enum VoiceHaptic: Equatable {
    case arm
    case lock
    case cancelArmed
    case send
}

/// A side-effect the machine asks the UI to perform. The UI stays dumb: it
/// only ever reacts to these.
enum VoiceEffect: Equatable {
    case none
    case send
    case discard
    case haptic(VoiceHaptic)
}

/// Inputs to the gesture machine. Drags are raw physical points in the current
/// layout; the machine mirrors the horizontal component itself when `isRTL`
/// so slide-to-cancel is the mirrored direction in Arabic/Hebrew/Urdu.
enum VoiceInput: Equatable {
    case press
    case drag(dx: Double, dy: Double)
    case release
    case tick
    case interrupted
    case tapSend
    case tapPause
    case tapResume
    case tapDiscard
    /// The single meaning of "a press ended quickly enough to be a tap": lock
    /// the take into the hands-free bar. It no longer toggles anything — a tap
    /// ON locks (decision #5/#6), and the bar's own send button is the only
    /// way to stop it. Distinct from `.release` so a quick tap is not
    /// swallowed by the `.release` mis-tap discard rules.
    case tapLock
}

enum VoiceGesture {

    /// The two distances the recording gesture is defined by, in points. The
    /// machine DECIDES with these and the view DRAWS with them, so they live in
    /// exactly one place — a view that filled its lane against a different number
    /// than the machine acted on would show you a lie.
    enum Thresholds {
        /// Drag up this far to arm the lock.
        static let lock: Double = 80
        /// Drag left (mirrored in RTL) this far to arm cancel.
        static let cancel: Double = 96
    }

    /// The whole machine. Thresholds are parameters with defaults
    /// `lockThreshold = Thresholds.lock`, `cancelThreshold = Thresholds.cancel`.
    /// `isRTL` mirrors the horizontal drag direction for right-to-left layouts.
    static func transition(
        currentPhase: VoicePhase,
        input: VoiceInput,
        elapsedMs: Int,
        isRTL: Bool = false,
        lockThreshold: Double = Thresholds.lock,
        cancelThreshold: Double = Thresholds.cancel
    ) -> (VoicePhase, VoiceEffect) {

        // An external interruption invalidates the take from any phase — it
        // takes precedence over even the cap (a take torn apart by a phone
        // call must never be transcribed).
        if input == .interrupted {
            switch currentPhase {
            case .idle: return (.idle, .none)
            default: return (.idle, .discard)
            }
        }

        // Reaching the hard cap within a recording phase SENDS the take; it is
        // kept, never discarded (decision #6). Paused time never counts toward
        // the cap, so the caller's rebased elapsed only reaches it while live.
        if (currentPhase == .recordingHeld || currentPhase == .recordingLocked),
           elapsedMs >= Waveform.Constants.maxDurationMs {
            return (.idle, .send)
        }

        switch input {
        case .press:
            // Recording starts on PRESS (decision #4) — do not wait for the
            // hold threshold; the threshold only decides at release whether
            // this was a tap or a hold.
            switch currentPhase {
            case .idle: return (.recordingHeld, .haptic(.arm))
            default: return (currentPhase, .none)
            }

        case .tick:
            return (currentPhase, .none)

        case .release:
            switch currentPhase {
            case .recordingHeld:
                if elapsedMs < Waveform.Constants.minDurationMs {
                    // A mis-tap: discarded silently, no callback (decision #7).
                    return (.idle, .none)
                }
                return (.idle, .send)
            case .cancelling:
                return (.idle, .discard)
            default:
                return (currentPhase, .none)
            }

        case let .drag(dx, dy):
            let x = isRTL ? -dx : dx
            return drag(currentPhase: currentPhase, x: x, dy: dy,
                        lockThreshold: lockThreshold, cancelThreshold: cancelThreshold)

        case .tapSend:
            switch currentPhase {
            case .recordingLocked, .paused: return (.idle, .send)
            default: return (currentPhase, .none)
            }

        case .tapPause:
            switch currentPhase {
            case .recordingLocked: return (.paused, .none)
            default: return (currentPhase, .none)
            }

        case .tapResume:
            switch currentPhase {
            case .paused: return (.recordingLocked, .none)
            default: return (currentPhase, .none)
            }

        case .tapDiscard:
            switch currentPhase {
            case .recordingLocked, .paused: return (.idle, .discard)
            default: return (currentPhase, .none)
            }

        case .tapLock:
            switch currentPhase {
            case .recordingHeld: return (.recordingLocked, .haptic(.lock))
            default: return (currentPhase, .none)
            }

        case .interrupted:
            // handled above (unreachable)
            return (.idle, .discard)
        }
    }

    private static func drag(
        currentPhase: VoicePhase,
        x: Double,
        dy: Double,
        lockThreshold: Double,
        cancelThreshold: Double
    ) -> (VoicePhase, VoiceEffect) {
        switch currentPhase {
        case .recordingHeld:
            if dy < -lockThreshold {
                // slide up to lock the take
                return (.recordingLocked, .haptic(.lock))
            }
            if x < -cancelThreshold {
                // slide left to arm cancel (mirrored for RTL upstream)
                return (.cancelling, .haptic(.cancelArmed))
            }
            return (.recordingHeld, .none)

        case .cancelling:
            // dragging back out of the cancel zone returns to the held take
            if x >= -cancelThreshold {
                return (.recordingHeld, .none)
            }
            return (.cancelling, .none)

        case .recordingLocked:
            // a locked take ignores further drags
            return (.recordingLocked, .none)

        default:
            return (currentPhase, .none)
        }
    }

    // MARK: - Drag → progress mapping (pure, view-facing)

    /// 0...1 of how far the vertical drag is toward the lock threshold (lock is
    /// sliding UP, so a negative `dy` advances it). Clamped. RTL never mirrors
    /// the vertical axis, so `isRTL` is deliberately absent. The view uses this
    /// to brighten the lock lane / scale its glyph as the lock threshold is
    /// approached; it must NOT decide the transition itself.
    static func lockProgress(dy: Double, threshold: Double = Thresholds.lock) -> Double {
        guard threshold > 0 else { return 0 }
        return min(1, max(0, -dy / threshold))
    }

    /// 0...1 of how far the horizontal drag is toward the cancel threshold,
    /// with the direction mirrored for RTL (mirrors the machine's own mirror
    /// so the hint/veil track the true cancel direction). Clamped.
    static func cancelProgress(dx: Double, isRTL: Bool, threshold: Double = Thresholds.cancel) -> Double {
        let x = isRTL ? -dx : dx
        guard threshold > 0 else { return 0 }
        return min(1, max(0, -x / threshold))
    }
}
