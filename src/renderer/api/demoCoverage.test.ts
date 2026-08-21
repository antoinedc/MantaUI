// demoCoverage.test.ts — the demo transport's coverage-bound inventory
// (BET-471).
//
// The demo transport implements a subset of the `Api` contract explicitly;
// every other method is served by a Proxy fallback returning
// `Promise.resolve(null)`. A capability the demo does not stub renders as
// nothing in every mockup, structure snapshot and pixel baseline — the three
// verification layers all agree with the fixture, so the gap is invisible to
// the gate AND absent from the design spec the gate checks conformance to.
// That already shipped a regression: BET-459 collapsed the session-header
// mode `<select>` into a two-state toggle because the fixture only ever
// exercised two options, and it had to be restored in BET-467. This test
// makes the fallback-bound enumerable: it pins the exact set of unimplemented
// `Api` keys so adding one is a deliberate, recorded act instead of a silent
// gap, and when a capture does start exercising a capability the name must be
// deleted from `DEMO_UNIMPLEMENTED`.
//
// `Api` is a TypeScript type and cannot be enumerated at runtime, but
// `httpApi` is a plain object literal implementing the same contract, so its
// keys are enumerable. The bound is therefore the set of `httpApi` keys the
// demo transport does not implement.

import { describe, it, expect } from "vitest";
import { httpApi } from "./httpApi.js";
import { explicitMethods } from "./demoApi.js";

// Capabilities absent from every captured state, generated from this test's
// own first failure against the post-BET-470 fixture shape — not hand-written.
// Sorted for readable diffs. A change to this list means one of two opposite
// things; the assertion message below distinguishes them:
//   - a NEW key here → an `Api` method was added without a demo stub. Either
//     add a stub, or keep the name here to record that no capture exercises it.
//   - a key removed → someone added a demo stub (or deleted the Api method).
//     Delete the name from this list.
export const DEMO_UNIMPLEMENTED = [
  "accountHealth",
  "accountsRetry",
  "agentPullFile",
  "authClaim",
  "authPair",
  "autoUpdateCheck",
  "autoUpdateDownload",
  "autoUpdateInstall",
  "clipboardReadImage",
  "clipboardWriteText",
  "configUpdate",
  "connectionRetryNow",
  "delegateApprove",
  "delegateDecline",
  "delegateDelete",
  "delegateList",
  "delegatePendingApprovals",
  "delegateStart",
  "delegateStop",
  "downloadFileToDownloads",
  "forgeCloneCancel",
  "forgeCloneStart",
  "forgeCloneStatus",
  "forgeDeviceCancel",
  "forgeDevicePoll",
  "forgeDeviceStart",
  "forgeDiff",
  "forgeDisconnect",
  "forgeDraftComment",
  "forgeDraftGet",
  "forgeDraftSubmit",
  "forgeInbox",
  "forgeMerge",
  "forgeProbe",
  "forgePullRequest",
  "forgeRepos",
  "forgeRulesList",
  "forgeShip",
  "forgeShipPreview",
  "forgeStatus",
  "forgeThreadReply",
  "getPathForFile",
  "gitAddWorktree",
  "gitRemoveWorktree",
  "ledgerSummary",
  "modelPrefsGet",
  "modelPrefsSeed",
  "modelPrefsSet",
  "onAgentFileReady",
  "onAppControl",
  "onAutoUpdateAvailable",
  "onAutoUpdateDownloaded",
  "onAutoUpdateProgress",
  "onDelegateUpdated",
  "onDesktopNotify",
  "onMedia",
  "onModelPrefsUpdated",
  "onProgressUpdated",
  "onPtyEvent",
  "onScreenshotDetected",
  "onServerUpdateAvailable",
  "onServerUpdateProgress",
  "onSyncDelta",
  "onUsageStoppedUpdated",
  "onUsageUpdated",
  "openExternal",
  "opencodeAbort",
  "opencodeAgents",
  "opencodeClaudeCliStatus",
  "opencodeClearSession",
  "opencodeCommands",
  "opencodeCompactSession",
  "opencodeCreateEphemeralSession",
  "opencodeDeleteSession",
  "opencodeDeleteSessionRaw",
  "opencodeDiscoverModels",
  "opencodeFindFiles",
  "opencodeForkSession",
  "opencodeGenerateTitle",
  "opencodeGetProviders",
  "opencodeGetSubagents",
  "opencodeModelCatalog",
  "opencodeModelRoute",
  "opencodePermissionReply",
  "opencodePrompt",
  "opencodeQuestionReject",
  "opencodeQuestionReply",
  "opencodeReferences",
  "opencodeRestart",
  "opencodeRunCommand",
  "opencodeSearchMessages",
  "opencodeSessionAgent",
  "opencodeSetProviders",
  "opencodeSetReferences",
  "opencodeSetSubagents",
  "opencodeSyncSubagents",
  "peekRemoteFile",
  "pluginsRegistry",
   "progressGet",
   "projectMetaDelete",
  "ptyKill",
  "ptyResize",
  "ptySpawn",
  "ptyWrite",
  "pushRegisterApns",
  "revealInFolder",
  "routingChoose",
  "scheduleCreate",
  "scheduleDelete",
  "scheduleList",
  "secretsDelete",
  "secretsList",
  "secretsSet",
  "serverCliUpdate",
  "serverUpdateApply",
  "serverUpdateCheck",
  "tmuxConfigStatus",
  "tmuxKillSession",
  "tmuxKillWindow",
  "tmuxNewSession",
  "tmuxNewWindow",
  "tmuxRenameSession",
  "tmuxRenameWindow",
  "tmuxRestoreConfig",
  "tmuxSelectWindow",
  "tmuxSetupConfig",
  "uploadBuffer",
  "uploadFiles",
  "usageList",
  "usageStoppedArm",
  "usageStoppedDisarm",
  "usageStoppedList",
  "usageStoppedStampLastLooked",
  "voiceFetchNote",
  "voiceListNotes",
  "voiceRetryNote",
  "voiceTranscribe",
  "voiceUploadNote",
  "webhookDelete",
  "webhookList",
];

describe("demo transport — coverage-bound inventory", () => {
  it("documents exactly which opencode/Api capabilities the demo does not stub", () => {
    const unimplemented = Object.keys(httpApi)
      .filter((k) => !(k in explicitMethods))
      .sort();

    const message =
      `The demo transport's Proxy fallback silently serves every Api method it ` +
      `does not stub. This test keeps an honest inventory of those gaps.\n\n` +
      `Actual unimplemented keys:\n  ${JSON.stringify(unimplemented)}\n\n` +
      `How to reconcile (the two directions mean OPPOSITE things):\n` +
      `  - a key is in "actual" but NOT in DEMO_UNIMPLEMENTED → someone added an ` +
      `Api method with no demo stub. Either add a stub, or add the name to ` +
      `DEMO_UNIMPLEMENTED to record that no capture exercises it.\n` +
      `  - a key is in DEMO_UNIMPLEMENTED but NOT in "actual" → someone added a ` +
      `demo stub (or deleted the Api method). Delete the name from ` +
      `DEMO_UNIMPLEMENTED.`;

    // `expect(actual, message)` — the custom message on failure (not a second
    // arg to toEqual) is how vitest surfaces a matcher-specific message.
    expect(unimplemented, message).toEqual(DEMO_UNIMPLEMENTED);
  });
});
