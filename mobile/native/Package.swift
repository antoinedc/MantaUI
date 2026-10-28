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
                "AccountsModels.swift",
                "AccountsSignInModels.swift",
                "ArtifactAgentFileModel.swift",
                "ArtifactModels.swift",
                "ArtifactPresentation.swift",
                "BoxCapabilities.swift",
                "BoxDevicesModels.swift",
                "BoxPairingModels.swift",
                "ChatCardLogic.swift",
                "ChatCardModels.swift",
                "ChatJSON.swift",
                "ChatModel.swift",
                "CloneFromGitHubLogic.swift",
                "CloneFromGitHubSignInLogic.swift",
                "ComposerInsertion.swift",
                "ComposerModels.swift",
                "ComposerTypeahead.swift",
                "ExtensionsModels.swift",
                "GitForgeModels.swift",
                "HandoffModels.swift",
                "InboxModels.swift",
                "InboxWorkModels.swift",
                "MantaError.swift",
                "MantaModels.swift",
                "MantaNavigationModels.swift",
                "MantaPairingModels.swift",
                "MantaStreamModels.swift",
                "ModelsBoxBinding.swift",
                "ModelsIdentifyLogic.swift",
                "ModelsWire.swift",
                "OptimizerLogic.swift",
                "UsageAlertsLogic.swift",
                "UsageResumeLogic.swift",
                "ModelRecents.swift",
                "PendingPrompt.swift",
                "PlanDerivation.swift",
                "ProviderConnectionModels.swift",
                "ProviderEndpointModels.swift",
                "ProviderOAuthLease.swift",
                "SearchModels.swift",
                "SessionCloseLogic.swift",
                "SessionCreateLogic.swift",
                "SessionForgeModels.swift",
                "SessionModeLogic.swift",
                "SessionModels.swift",
                "SessionRouteLogic.swift",
                "SessionSwitcherLogic.swift",
                "SettingsAppearance.swift",
                "SettingsBackupModels.swift",
                "SettingsNotificationModels.swift",
                "SettingsUpdatesModels.swift",
                "SettingsWireModels.swift",
                "TranscriptDisplayOptions.swift",
                "TranscriptMediaModel.swift",
                "TranscriptTurns.swift",
                "UpgradeModels.swift",
                "UsageMeters.swift",
                "VoiceGesture.swift",
                "Waveform.swift",
                "WebhookModels.swift",
            ],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .testTarget(
            name: "MantaUITests",
            dependencies: ["MantaUI"],
            path: "MantaUITests",
            sources: [
                "AccountsSignInTests.swift",
                "AccountsTests.swift",
                "ArtifactAgentFileTests.swift",
                "ArtifactPresentationTests.swift",
                "ArtifactWireTests.swift",
                "BoxCapabilitiesTests.swift",
                "ChatCardsTests.swift",
                "CloneFromGitHubTests.swift",
                "ComposerInsertionTests.swift",
                "ComposerModelsTests.swift",
                "ComposerTypeaheadTests.swift",
                "GitForgeTests.swift",
                "GitHubDeviceSignInTests.swift",
                "HandoffModelsTests.swift",
                "InboxModelsTests.swift",
                "InboxWorkTests.swift",
                "ModelsBoxBindingTests.swift",
                "ModelsTests.swift",
                "OptimizerTests.swift",
                "PendingPromptStoreTests.swift",
                "PlanDerivationTests.swift",
                "ProviderConnectTests.swift",
                "ProviderEndpointTests.swift",
                "SearchTests.swift",
                "SecretScopeTests.swift",
                "SessionModelsTests.swift",
                "SessionsTests.swift",
                "SettingsAppearanceTests.swift",
                "SettingsBackupTests.swift",
                "SettingsBoxTests.swift",
                "SettingsExtensionsTests.swift",
                "SettingsNotificationReminderTests.swift",
                "SettingsUpdatesTests.swift",
                "TranscriptParityTests.swift",
                "UpgradeModelsTests.swift",
                "UsageEscalationTests.swift",
                "UsageMetersTests.swift",
                "UsageResumeTests.swift",
                "VoiceGestureTests.swift",
                "WaveformTests.swift",
                "WebhookTests.swift",
            ],
            swiftSettings: [.swiftLanguageMode(.v6)]
        )
    ]
)
