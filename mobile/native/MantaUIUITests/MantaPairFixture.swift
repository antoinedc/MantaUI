import Foundation

// Build-time carrier for the live-box pairing drive (MantaPairingDriverUITests).
//
// A UI test runs inside the Simulator in its own sandbox: it cannot read the
// host's filesystem, and `xcodebuild`'s `TEST_RUNNER_*` env passthrough does
// NOT reach the runner on this toolchain (verified empty at run time). The one
// channel that always works is the compiler — so the driver plugin overwrites
// the two values here immediately before `xcodebuild test`, and restores the
// file (git checkout) afterwards.
//
// Both values are EMPTY in the repo on purpose: a pairing code is single-use
// and expires in minutes, so there is nothing to leak, and an ordinary test
// run skips the drive instead of attempting a claim.
enum MantaPairFixture {
    static let code = ""
    static let server = ""
}
