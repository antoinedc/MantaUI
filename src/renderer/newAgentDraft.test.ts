// @vitest-environment jsdom
//
// The three ways the agent screens open a chat with Manta (agent screens spec §2.2, §2.4): a new-chat draft in the active
// project, prefilled. Nothing is created or sent here — the user sends it.

import { beforeEach, describe, expect, it } from "vitest";
import type { Project } from "../shared/types";
import { openChangeAgentDraft, openMentionDraft, openNewAgentDraft } from "./newAgentDraft";
import { useStore } from "./store";

const project = (tmuxSession: string, defaultCwd: string): Project =>
  ({ tmuxSession, defaultCwd, windows: [], attached: false }) as unknown as Project;

const draft = () => {
  const s = useStore.getState();
  return s.drafts.find((d) => d.id === s.activeDraftId)!;
};

beforeEach(() => {
  useStore.setState({
    drafts: [],
    activeDraftId: null,
    projects: [project("site", "/home/dev/projects/site"), project("api", "/home/dev/projects/api")],
    activeProjectName: "site",
  });
});

describe("openNewAgentDraft", () => {
  it("opens a draft in the active project, with the folder and 'Create an agent that ' typed", () => {
    openNewAgentDraft();
    const d = draft();
    expect(d.mode).toEqual({ projectName: "site" });
    expect(d.cwd).toBe("/home/dev/projects/site");
    expect(d.input).toBe("Create an agent that ");
    expect(useStore.getState().drafts).toHaveLength(1);
  });

  it("with no active project it opens a new-project draft with the text typed", () => {
    useStore.setState({ activeProjectName: null });
    openNewAgentDraft();
    const d = draft();
    expect(d.mode).toBe("new-project");
    expect(d.input).toBe("Create an agent that ");
  });

  it("does not leave the user's own typing in another draft behind", () => {
    const first = useStore.getState().createDraft({ projectName: "api" });
    useStore.getState().updateDraft(first, { input: "my draft" });
    openNewAgentDraft();
    expect(useStore.getState().drafts).toHaveLength(2);
    expect(useStore.getState().drafts.find((d) => d.id === first)?.input).toBe("my draft");
  });
});

describe("openChangeAgentDraft", () => {
  it("prefills 'Change @slug: ' in the active project", () => {
    openChangeAgentDraft("seo");
    const d = draft();
    expect(d.input).toBe("Change @seo: ");
    expect(d.mode).toEqual({ projectName: "site" });
    expect(d.cwd).toBe("/home/dev/projects/site");
  });
});

describe("openMentionDraft", () => {
  it("opens in the project that owns the folder, with '@slug ' typed", () => {
    openMentionDraft("seo", "/home/dev/projects/api");
    const d = draft();
    expect(d.mode).toEqual({ projectName: "api" });
    expect(d.cwd).toBe("/home/dev/projects/api");
    expect(d.input).toBe("@seo ");
  });

  it("a folder no open project owns still opens a chat there, in the active project", () => {
    openMentionDraft("seo", "/home/dev/elsewhere");
    const d = draft();
    expect(d.mode).toEqual({ projectName: "site" });
    expect(d.cwd).toBe("/home/dev/elsewhere");
    expect(d.input).toBe("@seo ");
  });

  it("without a folder it uses the active project's", () => {
    openMentionDraft("seo", null);
    expect(draft().cwd).toBe("/home/dev/projects/site");
    expect(draft().input).toBe("@seo ");
  });
});
