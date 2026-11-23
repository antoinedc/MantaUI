// @vitest-environment jsdom
//
// The sidebar's package-agent cache refetches when the box announces an agent change (a click on ANY desktop) and after
// a reconnect — independent of any chat card — and never lets a read that began before the change be the last word.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import type { AgentChangeEvent, AgentInfo } from "../shared/types";
import { resetPackageAgentsForTest, usePackageAgents } from "./packageAgents";
import { installMockApi, mount, resetStore, type Harness, type MockApi } from "./testHarness";

const agent = (slug: string): AgentInfo => ({ slug, name: slug } as unknown as AgentInfo);

function Probe() {
  const { agents } = usePackageAgents();
  return <div data-testid="slugs">{agents == null ? "loading" : agents.map((a) => a.slug).join(",")}</div>;
}
const slugs = (h: Harness) => h.container.querySelector('[data-testid="slugs"]')?.textContent;

describe("package agents cache", () => {
  let h: Harness | null = null;
  let api: MockApi;
  let bus: ReturnType<typeof installMockApi>["bus"];
  let hint: ((p: AgentChangeEvent) => void) | null;
  let list: AgentInfo[];
  let offCount: number;

  const open = (over: Record<string, unknown> = {}) => {
    ({ api, bus } = installMockApi({
      agentsList: () => Promise.resolve(list),
      onAgentChange: (cb: (p: AgentChangeEvent) => void) => {
        hint = cb;
        return () => {
          offCount++;
          hint = null;
        };
      },
      ...over,
    }));
    h = mount(<Probe />);
  };

  beforeEach(() => {
    resetStore();
    resetPackageAgentsForTest();
    hint = null;
    offCount = 0;
    list = [agent("dev")];
  });
  afterEach(() => {
    h?.unmount();
    h = null;
    resetPackageAgentsForTest();
  });

  it("refetches the list when an agent change is announced", async () => {
    open();
    await h!.flush();
    expect(slugs(h!)).toBe("dev");
    expect(api.calls.agentsList).toHaveLength(1);
    list = [agent("dev"), agent("reviewer")];
    await act(async () => hint!({ id: "ach_1", sessionID: "ses_1", slug: "reviewer" }));
    await h!.flush();
    expect(api.calls.agentsList).toHaveLength(2);
    expect(slugs(h!)).toBe("dev,reviewer");
  });

  it("refetches after a reconnect (the stream resync frame)", async () => {
    open();
    await h!.flush();
    list = [agent("dev"), agent("reviewer")];
    await act(async () => bus.emitStream({ sub: "resync", sessionId: "", payload: {} }));
    await h!.flush();
    expect(slugs(h!)).toBe("dev,reviewer");
  });

  it("an announcement during a read in flight still ends with a read made after it", async () => {
    const resolvers: Array<(l: AgentInfo[]) => void> = [];
    open({ agentsList: () => new Promise<AgentInfo[]>((r) => resolvers.push(r)) });
    await h!.flush();
    expect(resolvers).toHaveLength(1);
    await act(async () => hint!({ id: "ach_1", sessionID: "ses_1", slug: "reviewer" }));
    expect(resolvers).toHaveLength(1); // not started twice
    await act(async () => resolvers[0]([agent("dev")])); // the read that predates the change
    await h!.flush();
    expect(resolvers).toHaveLength(2); // read again once it landed
    await act(async () => resolvers[1]([agent("dev"), agent("reviewer")]));
    await h!.flush();
    expect(slugs(h!)).toBe("dev,reviewer");
  });

  it("stops listening when nothing shows the list any more", async () => {
    open();
    await h!.flush();
    h!.unmount();
    h = null;
    expect(offCount).toBe(1);
  });
});
