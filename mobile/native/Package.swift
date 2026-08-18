// swift-tools-version: 6.0
//
// A LINUX-BUILDABLE VIEW OF THE APP'S PURE LOGIC.
//
// This package does not own any source. It lists a subset of the iOS app target's
// existing files — the ones that import nothing but Foundation — so they can be
// compiled and unit-tested headlessly with `swift test`, in Docker, on a machine
// with no Xcode. The Xcode project (generated from project.yml by xcodegen) still
// compiles the very same files for the app; this is a second, parallel view of
// them, not a fork.
//
// WHY: there is no Swift toolchain on the Linux dev box, so an agent working there
// otherwise cannot compile or test ANY Swift, and every change round-trips through
// a Mac. That loop is slow enough that logic regressions ship. Most of the testable
// logic needs a Mac only by accident of where it lives.
//
// The module is deliberately named `MantaUI` so the existing tests' `@testable
// import MantaUI` resolves unchanged. It is a separate build from the Xcode target
// of the same name; they never link together.
//
// NO `platforms:` CLAUSE ON PURPOSE — declaring an iOS platform would make this
// unbuildable on Linux, which is the entire point of the package.
//
// TO ADD A FILE: append it to `sources` and run ./verify.sh. If it fails to build,
// it depends on UIKit/SwiftUI (directly or through another type) and does not
// belong here. Never edit a source file to make it fit.

import PackageDescription

let package = Package(
    name: "MantaCore",
    products: [
        .library(name: "MantaUI", targets: ["MantaUI"])
    ],
    targets: [
        .target(
            name: "MantaUI",
            path: "MantaUI",
            sources: [
                "ArtifactDerivation.swift",
                "ChatJSON.swift",
                "ChatModel.swift",
                "ComposerTypeahead.swift",
                "MantaError.swift",
                "MantaModels.swift",
                "MantaStreamModels.swift",
                "ModelRecents.swift",
                "PlanDerivation.swift",
                "UsageMeters.swift",
                "VoiceGesture.swift",
                "Waveform.swift",
            ],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .testTarget(
            name: "MantaUITests",
            dependencies: ["MantaUI"],
            path: "MantaUITests",
            sources: [
                "ArtifactDerivationTests.swift",
                "ComposerTypeaheadTests.swift",
                "PlanDerivationTests.swift",
                "UsageMetersTests.swift",
                "VoiceGestureTests.swift",
                "WaveformTests.swift",
            ],
            swiftSettings: [.swiftLanguageMode(.v6)]
        )
    ]
)
