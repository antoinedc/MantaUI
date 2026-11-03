import { describe, it, expect } from "vitest";
import {
  MAX_SHOWN_ENTRIES,
  MAX_STORED_VERSIONS,
  acknowledge,
  componentChips,
  decideWhatsNew,
  normalizeStored,
  previousVersion,
} from "./whatsNew.mjs";

const entry = (version: string, fingerprint = `fp-${version}`) => ({ version, fingerprint });
const stored = (versions: Record<string, string>) => ({ versions });

describe("decideWhatsNew — the decision table", () => {
  const entries = [entry("1.2.0"), entry("1.1.0"), entry("1.0.0")];

  it("no record for this server → baseline, show nothing", () => {
    expect(decideWhatsNew(null, entries)).toEqual({ baseline: true });
    expect(decideWhatsNew(undefined, entries)).toEqual({ baseline: true });
  });

  it("a malformed record counts as no record", () => {
    expect(decideWhatsNew("nope", entries)).toEqual({ baseline: true });
    expect(decideWhatsNew({ versions: [] }, entries)).toEqual({ baseline: true });
  });

  it("a version never acknowledged is unseen (skipped releases included, newest first)", () => {
    const r = decideWhatsNew(stored({ "1.0.0": "fp-1.0.0" }), entries);
    expect(r.unseen?.map((e) => e.version)).toEqual(["1.2.0", "1.1.0"]);
  });

  it("everything acknowledged with equal fingerprints → nothing", () => {
    const all = stored({ "1.0.0": "fp-1.0.0", "1.1.0": "fp-1.1.0", "1.2.0": "fp-1.2.0" });
    expect(decideWhatsNew(all, entries)).toEqual({ unseen: [] });
  });

  it("the newest entry acknowledged but edited → unseen again", () => {
    const s = stored({ "1.0.0": "fp-1.0.0", "1.1.0": "fp-1.1.0", "1.2.0": "OLD" });
    expect(decideWhatsNew(s, entries).unseen?.map((e) => e.version)).toEqual(["1.2.0"]);
  });

  it("an OLDER entry acknowledged but reworded → not unseen", () => {
    const s = stored({ "1.0.0": "OLD", "1.1.0": "OLD", "1.2.0": "fp-1.2.0" });
    expect(decideWhatsNew(s, entries)).toEqual({ unseen: [] });
  });

  it("rollback to an acknowledged release and re-upgrade shows nothing", () => {
    const s = stored({ "1.0.0": "fp-1.0.0", "1.1.0": "fp-1.1.0", "1.2.0": "fp-1.2.0" });
    // rolled back: the server's changelog now ends at 1.1.0
    expect(decideWhatsNew(s, [entry("1.1.0"), entry("1.0.0")])).toEqual({ unseen: [] });
    // re-upgraded: 1.2.0 is back, identical
    expect(decideWhatsNew(s, entries)).toEqual({ unseen: [] });
  });

  it("caps the window at 5 entries, newest first", () => {
    const many = ["1.7.0", "1.6.0", "1.5.0", "1.4.0", "1.3.0", "1.2.0", "1.1.0"].map((v) => entry(v));
    const r = decideWhatsNew(stored({ "1.0.0": "x" }), many);
    expect(MAX_SHOWN_ENTRIES).toBe(5);
    expect(r.unseen?.map((e) => e.version)).toEqual(["1.7.0", "1.6.0", "1.5.0", "1.4.0", "1.3.0"]);
  });

  it("no entries → nothing, and never a baseline", () => {
    expect(decideWhatsNew(null, [])).toEqual({ unseen: [] });
    expect(decideWhatsNew(stored({}), [])).toEqual({ unseen: [] });
  });

  it("an empty (but valid) record is a record: everything is unseen, not a baseline", () => {
    expect(decideWhatsNew(stored({}), entries).unseen).toHaveLength(3);
  });

  it("returns the same entry objects it was given", () => {
    const r = decideWhatsNew(stored({}), entries);
    expect(r.unseen?.[0]).toBe(entries[0]);
  });
});

describe("acknowledge", () => {
  it("records every returned entry with its fingerprint", () => {
    const next = acknowledge(null, [entry("1.2.0"), entry("1.1.0")]);
    expect(next).toEqual({ versions: { "1.1.0": "fp-1.1.0", "1.2.0": "fp-1.2.0" } });
    expect(Object.keys(next.versions)).toEqual(["1.1.0", "1.2.0"]); // oldest first
  });

  it("updates an edited fingerprint in place and keeps the rest", () => {
    const next = acknowledge(stored({ "1.1.0": "a", "1.2.0": "old" }), [entry("1.2.0", "new"), entry("1.1.0", "a")]);
    expect(next.versions).toEqual({ "1.1.0": "a", "1.2.0": "new" });
    expect(Object.keys(next.versions)).toEqual(["1.1.0", "1.2.0"]);
  });

  it("an empty list leaves the record alone (and does not invent one)", () => {
    expect(acknowledge(stored({ "1.0.0": "a" }), [])).toEqual({ versions: { "1.0.0": "a" } });
    expect(acknowledge(null, [])).toEqual({ versions: {} });
  });

  it("is bounded to the 50 most recent versions", () => {
    const old: Record<string, string> = {};
    for (let i = 0; i < 50; i++) old[`1.0.${i}`] = `fp${i}`;
    const next = acknowledge(stored(old), [entry("2.0.1"), entry("2.0.0")]);
    const keys = Object.keys(next.versions);
    expect(MAX_STORED_VERSIONS).toBe(50);
    expect(keys).toHaveLength(50);
    expect(keys.slice(-2)).toEqual(["2.0.0", "2.0.1"]);
    expect(next.versions["1.0.0"]).toBeUndefined();
    expect(next.versions["1.0.1"]).toBeUndefined();
    expect(next.versions["1.0.2"]).toBe("fp2");
  });

  it("does not mutate the stored value it was given", () => {
    const s = stored({ "1.0.0": "a" });
    acknowledge(s, [entry("1.1.0")]);
    expect(s).toEqual({ versions: { "1.0.0": "a" } });
  });

  it("acknowledging then deciding shows nothing (the close path)", () => {
    const entries = [entry("1.2.0"), entry("1.1.0")];
    const after = acknowledge(stored({ "1.0.0": "x" }), entries);
    expect(decideWhatsNew(after, entries)).toEqual({ unseen: [] });
  });

  it("the baseline path records everything so the next fetch shows nothing", () => {
    const entries = [entry("1.2.0"), entry("1.1.0")];
    expect(decideWhatsNew(null, entries)).toEqual({ baseline: true });
    expect(decideWhatsNew(acknowledge(null, entries), entries)).toEqual({ unseen: [] });
  });
});

describe("normalizeStored", () => {
  it("drops non-string fingerprints and rejects non-objects", () => {
    expect(normalizeStored({ versions: { "1.0.0": "a", "1.1.0": 7 } })).toEqual({ versions: { "1.0.0": "a" } });
    expect(normalizeStored(null)).toBeNull();
    expect(normalizeStored([])).toBeNull();
    expect(normalizeStored({})).toBeNull();
  });
});

describe("previousVersion", () => {
  const entries = [entry("1.3.0"), entry("1.2.0"), entry("1.1.0"), entry("1.0.0")];

  it("is the newest acknowledged returned entry below the shown ones", () => {
    const s = stored({ "1.0.0": "fp-1.0.0", "1.1.0": "fp-1.1.0" });
    const unseen = decideWhatsNew(s, entries).unseen!;
    expect(unseen.map((e) => e.version)).toEqual(["1.3.0", "1.2.0"]);
    expect(previousVersion(s, entries, unseen)).toBe("1.1.0");
  });

  it("is null without a record", () => {
    expect(previousVersion(null, entries, [entries[0]])).toBeNull();
  });

  it("is null when the newest shown version was itself acknowledged (edited entry)", () => {
    const s = stored({ "1.0.0": "fp-1.0.0", "1.1.0": "fp-1.1.0", "1.2.0": "fp-1.2.0", "1.3.0": "old" });
    const unseen = decideWhatsNew(s, entries).unseen!;
    expect(unseen.map((e) => e.version)).toEqual(["1.3.0"]);
    expect(previousVersion(s, entries, unseen)).toBeNull();
  });

  it("falls back to the last stored version when no returned entry is acknowledged", () => {
    const s = stored({ "0.9.0": "x" });
    expect(previousVersion(s, entries, entries)).toBe("0.9.0");
  });

  it("is null when nothing is shown", () => {
    expect(previousVersion(stored({ "1.0.0": "a" }), entries, [])).toBeNull();
  });
});

describe("componentChips", () => {
  it("shows only Server and Desktop, Box counts as Server", () => {
    expect(componentChips(["desktop", "server"])).toEqual(["Server", "Desktop"]);
    expect(componentChips(["box", "ios", "website", "gateway"])).toEqual(["Server"]);
    expect(componentChips(["ios"])).toEqual([]);
    expect(componentChips(["server", "box"])).toEqual(["Server"]);
    expect(componentChips(undefined)).toEqual([]);
  });
});
