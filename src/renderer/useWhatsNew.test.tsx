// @vitest-environment jsdom
//
// useWhatsNew: when the automatic "What's new" window may open, and what closing
// it records. Driven through the real hook against a fake server answering
// `serverChangelog`, with the real per-server localStorage record.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { act } from "react";
import { installMockApi, mount, resetStore, type Harness } from "./testHarness";
import { useWhatsNew, whatsNewStorageKey, type WhatsNewView } from "./useWhatsNew";
import type { ChangelogEntry, ServerChangelog } from "../shared/api";
import { NOTES_ENTRY, OLDER_ENTRY, ROUTINES_ENTRY } from "./whatsNewFixtures";

type Props = { connected: boolean; apiGeneration: number; gateVisible: boolean; blocked: boolean };
const BASE: Props = { connected: true, apiGeneration: 0, gateVisible: false, blocked: false };

let latest: { view: WhatsNewView | null; close: () => void; showEntry: (e: ChangelogEntry) => void };
function Probe(props: Props) {
  latest = useWhatsNew(props);
  return <span data-testid="v">{latest.view ? latest.view.entries.map((e) => e.version).join(",") : "none"}</span>;
}

const SERVER = "box-aaa";
const KEY = whatsNewStorageKey(SERVER);
const answer = (entries: ChangelogEntry[], serverId: string | null = SERVER): ServerChangelog => ({ serverId, entries });
const stored = (): { versions: Record<string, string> } | null => {
  const raw = window.localStorage.getItem(KEY);
  return raw ? JSON.parse(raw) : null;
};

describe("useWhatsNew", () => {
  let h: Harness | null = null;
  let current: ServerChangelog | (() => Promise<ServerChangelog>);
  let calls = 0;

  const install = () =>
    installMockApi({
      serverChangelog: () => {
        calls += 1;
        return typeof current === "function" ? current() : Promise.resolve(current);
      },
    });
  const shown = () => h!.container.querySelector('[data-testid="v"]')!.textContent;
  const render = (p: Partial<Props> = {}) => h!.rerender(<Probe {...BASE} {...p} />);

  beforeEach(() => {
    resetStore();
    window.localStorage.clear();
    calls = 0;
    current = answer([NOTES_ENTRY, OLDER_ENTRY]);
    install();
  });
  afterEach(() => {
    h?.unmount();
    h = null;
    vi.restoreAllMocks();
  });

  const start = async (p: Partial<Props> = {}) => {
    h = mount(<Probe {...BASE} {...p} />);
    await h.flush();
  };

  it("first sight of a server is recorded silently and shows nothing", async () => {
    await start();
    expect(shown()).toBe("none");
    expect(stored()?.versions).toEqual({ "1.2.0": "fp-1.2.0", "1.3.0": "fp-1.3.0" });
  });

  it("a later fetch with a new release shows it; closing acknowledges EVERY returned entry", async () => {
    await start();
    current = answer([ROUTINES_ENTRY, NOTES_ENTRY, OLDER_ENTRY]);
    render({ connected: false });
    render({ connected: true }); // reconnect
    await h!.flush();
    expect(calls).toBe(2);
    expect(shown()).toBe("1.4.0");
    expect(latest.view?.previous).toBe("1.3.0");
    // Not recorded until it is closed: a crash now shows it again.
    expect(stored()?.versions["1.4.0"]).toBeUndefined();

    act(() => latest.close());
    expect(shown()).toBe("none");
    expect(stored()?.versions).toMatchObject({ "1.4.0": "fp-1.4.0", "1.3.0": "fp-1.3.0", "1.2.0": "fp-1.2.0" });

    // An ordinary restart afterwards shows nothing.
    render({ connected: false });
    render({ connected: true });
    await h!.flush();
    expect(shown()).toBe("none");
  });

  it("skipped releases are all included, newest first", async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ versions: { "1.2.0": "fp-1.2.0" } }));
    current = answer([ROUTINES_ENTRY, NOTES_ENTRY, OLDER_ENTRY]);
    await start();
    expect(shown()).toBe("1.4.0,1.3.0");
  });

  it("an edited newest entry is shown again", async () => {
    await start();
    current = answer([{ ...NOTES_ENTRY, fingerprint: "edited" }, OLDER_ENTRY]);
    render({ connected: false });
    render({ connected: true });
    await h!.flush();
    expect(shown()).toBe("1.3.0");
  });

  it("no server id → no automatic window and nothing stored", async () => {
    current = answer([ROUTINES_ENTRY], null);
    await start();
    expect(shown()).toBe("none");
    expect(window.localStorage.length).toBe(0);
  });

  it("an empty / unavailable answer neither shows nor baselines", async () => {
    current = { serverId: SERVER, entries: [], unavailable: true };
    await start();
    expect(shown()).toBe("none");
    expect(stored()).toBeNull();
  });

  it("a failed fetch is silent to the user (warn only), and an older server without the channel is fine", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    installMockApi({ serverChangelog: () => Promise.reject(new Error("unknown rpc channel: server:changelog")) });
    await start();
    expect(shown()).toBe("none");
    expect(warn).toHaveBeenCalled();
  });

  it("does nothing until connected, then fetches once it is", async () => {
    await start({ connected: false });
    expect(calls).toBe(0);
    render({ connected: true });
    await h!.flush();
    expect(calls).toBe(1);
  });

  describe("never opens over something else", () => {
    beforeEach(() => {
      window.localStorage.setItem(KEY, JSON.stringify({ versions: { "1.2.0": "fp-1.2.0" } }));
    });

    it("waits while Settings / another dialog is open, then shows", async () => {
      await start({ blocked: true });
      expect(calls).toBe(1);
      expect(shown()).toBe("none");
      render({ blocked: false });
      expect(shown()).toBe("1.3.0");
    });

    it("waits while the upgrade gate is up, refetches when it clears, and then shows", async () => {
      current = answer([OLDER_ENTRY]); // the box mid-upgrade still serves the old changelog
      await start({ gateVisible: true });
      expect(shown()).toBe("none");
      expect(calls).toBe(1);

      current = answer([NOTES_ENTRY, OLDER_ENTRY]); // the upgrade finished on the same connection
      render({ gateVisible: false });
      await h!.flush();
      expect(calls).toBe(2);
      expect(shown()).toBe("1.3.0");
    });

    it("held content stays hidden while the gate is up even after other blockers clear", async () => {
      current = answer([NOTES_ENTRY, OLDER_ENTRY]);
      await start({ blocked: true });
      render({ blocked: false, gateVisible: true });
      expect(shown()).toBe("none");
    });
  });

  it("drops a response that lands after the API generation changed (another server)", async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ versions: { "1.2.0": "fp-1.2.0" } }));
    let release!: (a: ServerChangelog) => void;
    current = () => new Promise<ServerChangelog>((r) => (release = r));
    await start();
    expect(calls).toBe(1);

    // The transport is swapped (new server) while the first answer is in flight.
    current = answer([], "box-bbb");
    render({ apiGeneration: 1 });
    await h!.flush();

    await act(async () => release(answer([ROUTINES_ENTRY, NOTES_ENTRY, OLDER_ENTRY])));
    expect(shown()).toBe("none");
    expect(stored()?.versions["1.4.0"]).toBeUndefined();
  });

  it("drops an older answer that is overtaken by a newer fetch", async () => {
    window.localStorage.setItem(KEY, JSON.stringify({ versions: { "1.2.0": "fp-1.2.0" } }));
    let first!: (a: ServerChangelog) => void;
    current = () => new Promise<ServerChangelog>((r) => (first = r));
    await start();
    current = answer([OLDER_ENTRY]); // the second fetch: nothing new
    render({ connected: false });
    render({ connected: true });
    await h!.flush();
    await act(async () => first(answer([NOTES_ENTRY, OLDER_ENTRY])));
    expect(shown()).toBe("none");
  });

  it("each server has its own record", async () => {
    await start();
    expect(window.localStorage.getItem(whatsNewStorageKey("box-bbb"))).toBeNull();
    current = answer([ROUTINES_ENTRY, NOTES_ENTRY], "box-bbb");
    render({ connected: false });
    render({ connected: true });
    await h!.flush();
    // box-bbb is new to this device: baselined, not announced.
    expect(shown()).toBe("none");
    expect(window.localStorage.getItem(whatsNewStorageKey("box-bbb"))).not.toBeNull();
  });

  describe("manual open (Settings → About)", () => {
    it("shows the entry even over blockers, and closing it records nothing", async () => {
      await start({ blocked: true });
      const before = window.localStorage.getItem(KEY);
      act(() => latest.showEntry(ROUTINES_ENTRY));
      expect(shown()).toBe("1.4.0");
      expect(latest.view?.previous).toBeNull();
      act(() => latest.close());
      expect(shown()).toBe("none");
      expect(window.localStorage.getItem(KEY)).toBe(before);
    });

    it("holds an automatic window back while it is open", async () => {
      window.localStorage.setItem(KEY, JSON.stringify({ versions: { "1.2.0": "fp-1.2.0" } }));
      await start({ blocked: true });
      act(() => latest.showEntry(OLDER_ENTRY));
      render({ blocked: false });
      expect(shown()).toBe("1.2.0");
      act(() => latest.close());
      expect(shown()).toBe("1.3.0");
    });
  });

  it("survives unreadable storage", async () => {
    window.localStorage.setItem(KEY, "{not json");
    await start();
    expect(shown()).toBe("none"); // treated as a first sight
    expect(stored()?.versions["1.3.0"]).toBe("fp-1.3.0");
  });
});
