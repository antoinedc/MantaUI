// @vitest-environment jsdom
//
// BET-943: the ConnectOffer's "Connect" chip (shown in a forge-origin session
// while the forge is disconnected and not dismissed) is wired through
// onConnectForge. These mount the real <SessionHeader> via the render harness
// and assert the chip's presence/behaviour — and that omitting onConnectForge
// (tests, non-forge callers) renders the × only, never a button that does
// nothing.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import {
  installMockApi,
  resetStore,
  mountSessionHeader,
  type Harness,
} from "./testHarness";

const connectButton = (h: Harness) =>
  [...h.container.querySelectorAll("button")].find(
    (b) => b.textContent === "Connect",
  );
const dismissButton = (h: Harness) =>
  [...h.container.querySelectorAll("button")].find(
    (b) => b.textContent === "×",
  );

function mountDisconnected({
  onConnectForge,
  onDismissForgeConnect,
}: {
  onConnectForge?: () => void;
  onDismissForgeConnect?: () => void;
} = {}) {
  return mountSessionHeader({
    forgeKind: "github",
    forgeConnected: false,
    forgeConnectOfferDismissed: false,
    onConnectForge,
    onDismissForgeConnect,
  });
}

describe("SessionHeader connect offer (BET-943)", () => {
  let h: Harness | null = null;

  beforeEach(() => {
    installMockApi();
    resetStore();
  });

  afterEach(() => {
    h?.unmount();
    h = null;
    document.body.innerHTML = "";
  });

  it("renders the Connect chip and clicking it calls onConnectForge once", () => {
    const onConnectForge = vi.fn();
    h = mountDisconnected({ onConnectForge });

    const chip = connectButton(h);
    expect(chip, "expected a Connect chip").toBeTruthy();
    act(() => chip!.click());

    expect(onConnectForge).toHaveBeenCalledTimes(1);
  });

  it("omitting onConnectForge renders the × but no Connect chip", () => {
    h = mountDisconnected({ onDismissForgeConnect: () => {} });

    expect(connectButton(h), "expected no Connect chip").toBeUndefined();
    expect(dismissButton(h), "expected the × to still render").toBeTruthy();
  });
});
