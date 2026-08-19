// @vitest-environment jsdom
//
// Render tests for the agent-file toast's save lifecycle (BET-1198).
//
// The regression this locks: a COMPLETED save has to read as a completed save.
// The pre-BET-1198 copy ("· saved to Downloads", same ↓ glyph as before the
// save) was faint enough — and ambiguous enough once a custom downloads folder
// is configured — that a working save was reported as "nothing happened".

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mount, installMockApi, type Harness } from "./testHarness";
import { GlobalToasts } from "./GlobalToasts";
import { useStore } from "./store";

describe("agent-file toast", () => {
  let h: Harness | null = null;

  beforeEach(() => {
    useStore.setState({ appToasts: [], agentFileToast: null, systemNotice: null });
  });

  afterEach(() => {
    h?.unmount();
    h = null;
    useStore.setState({ appToasts: [], agentFileToast: null });
  });

  function toastText() {
    return h!.container.textContent ?? "";
  }

  it("offers Save before the pull, with no claim about where anything landed", () => {
    installMockApi({});
    useStore.setState({
      agentFileToast: {
        remotePath: "/home/dev/.manta-outbox/ses_x/dog-running.mp4",
        name: "dog-running.mp4",
        size: 983374,
        sessionName: "ses_x",
        autoPulled: false,
      },
    });
    h = mount(<GlobalToasts />);

    expect(toastText()).toContain("AI sent you a file");
    expect(toastText()).not.toContain("saved to");
    const labels = [...h.container.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toContain("Save");
  });

  it("confirms the save by naming the FULL folder, and offers Reveal", () => {
    installMockApi({});
    useStore.setState({
      agentFileToast: {
        remotePath: "/home/dev/.manta-outbox/ses_x/dog-running.mp4",
        name: "dog-running.mp4",
        size: 983374,
        sessionName: "ses_x",
        autoPulled: true,
        localPath: "/Users/antoine/Downloads/dog-running.mp4",
      },
    });
    h = mount(<GlobalToasts />);

    expect(toastText()).toContain("saved to /Users/antoine/Downloads");
    expect(toastText()).toContain("✓");
    const labels = [...h.container.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toContain("Reveal");
  });

  it("falls back to the generic wording when there is no OS path (mobile/web)", () => {
    installMockApi({});
    useStore.setState({
      agentFileToast: {
        remotePath: "/home/dev/.manta-outbox/ses_x/dog-running.mp4",
        name: "dog-running.mp4",
        size: 983374,
        sessionName: "ses_x",
        autoPulled: true,
      },
    });
    h = mount(<GlobalToasts />);

    // No path is claimed, because none exists on that transport.
    expect(toastText()).toContain("saved to Downloads");
    expect(toastText()).not.toContain("saved to /");
  });
});
