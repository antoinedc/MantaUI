import { describe, it, expect } from "vitest";
import { dayKey, hourKey, bucketKeyToMs, recentBucketKeys } from "./timeBuckets.mjs";

describe("key formats and zero-padding", () => {
  it("dayKey formats a local calendar day with zero-padded month/day", () => {
    expect(dayKey(new Date(2026, 0, 5, 12, 0, 0).getTime())).toBe("2026-01-05");
    expect(dayKey(new Date(2026, 11, 31, 23, 59, 59).getTime())).toBe("2026-12-31");
    expect(dayKey(new Date(2026, 7, 4, 12, 0, 0).getTime())).toBe("2026-08-04");
  });

  it("hourKey formats a local calendar hour with zero-padded order", () => {
    expect(hourKey(new Date(2026, 7, 24, 3, 30, 0).getTime())).toBe("2026-08-24T03");
    expect(hourKey(new Date(2026, 7, 24, 23, 0, 0).getTime())).toBe("2026-08-24T23");
    expect(hourKey(new Date(2026, 7, 24, 0, 0, 0).getTime())).toBe("2026-08-24T00");
  });

  it("hourKey is the dayKey with the hour suffix", () => {
    const ms = new Date(2026, 7, 24, 15, 0, 0).getTime();
    expect(hourKey(ms)).toBe(`${dayKey(ms)}T15`);
  });
});

describe("bucketKeyToMs — inverse of the key functions", () => {
  it("round-trips a day key to the start of that local day", () => {
    const ms = new Date(2026, 7, 24, 12, 0, 0).getTime();
    const key = dayKey(ms);
    expect(dayKey(bucketKeyToMs(key))).toBe(key);
    // The start of the day, not noon.
    expect(new Date(bucketKeyToMs(key)).getHours()).toBe(0);
  });

  it("round-trips an hour key to the start of that local hour", () => {
    const ms = new Date(2026, 7, 24, 15, 45, 0).getTime();
    const key = hourKey(ms);
    expect(hourKey(bucketKeyToMs(key))).toBe(key);
    expect(new Date(bucketKeyToMs(key)).getMinutes()).toBe(0);
  });

  it("zero-padded round-trips survive normalization (single-digit month/day/hour)", () => {
    const day = dayKey(new Date(2026, 0, 4, 0, 0, 0).getTime());
    expect(dayKey(bucketKeyToMs(day))).toBe(day);
    const hour = hourKey(new Date(2026, 0, 4, 5, 0, 0).getTime());
    expect(hourKey(bucketKeyToMs(hour))).toBe(hour);
  });

  it("returns NaN for an unparseable key or a non-string", () => {
    expect(Number.isNaN(bucketKeyToMs("not-a-key"))).toBe(true);
    expect(Number.isNaN(bucketKeyToMs("2026-1-5"))).toBe(true); // single-digit parts
    expect(Number.isNaN(bucketKeyToMs("2026-08-24 12:00"))).toBe(true);
    expect(Number.isNaN(bucketKeyToMs("2026-08-24T"))).toBe(true);
    expect(Number.isNaN(bucketKeyToMs(null))).toBe(true);
    expect(Number.isNaN(bucketKeyToMs(undefined))).toBe(true);
    expect(Number.isNaN(bucketKeyToMs(42))).toBe(true);
  });
});

describe("recentBucketKeys", () => {
  it("returns `count` keys, oldest→newest, ending at the key of `now`", () => {
    const now = new Date(2026, 7, 24, 12, 0, 0).getTime();
    const keys = recentBucketKeys("day", 5, now);
    expect(keys).toHaveLength(5);
    expect(keys[0]).toBe("2026-08-20");
    expect(keys[4]).toBe("2026-08-24");
    for (let i = 0; i < keys.length - 1; i++) expect(keys[i] < keys[i + 1]).toBe(true);
  });

  it("hour bucket keys step by the hour and end at `now`'s hour", () => {
    const now = new Date(2026, 7, 24, 12, 0, 0).getTime();
    const keys = recentBucketKeys("hour", 3, now);
    expect(keys).toEqual(["2026-08-24T10", "2026-08-24T11", "2026-08-24T12"]);
  });

  it("count 1 returns exactly the key of `now`", () => {
    const now = new Date(2026, 7, 24, 12, 0, 0).getTime();
    expect(recentBucketKeys("day", 1, now)).toEqual(["2026-08-24"]);
    expect(recentBucketKeys("hour", 1, now)).toEqual(["2026-08-24T12"]);
  });

  it("produces exactly `count` DISTINCT keys across a DST spring-forward", () => {
    // US DST begins 2026-03-08 02:00 local. A 3-day window crossing it must
    // yield exactly 3 distinct day keys and exactly 3 distinct hour keys.
    const after = new Date(2026, 2, 9, 12, 0, 0).getTime();
    const days = recentBucketKeys("day", 3, after);
    expect(days).toHaveLength(3);
    expect(new Set(days).size).toBe(3);
    const hours = recentBucketKeys("hour", 3, after);
    expect(hours).toHaveLength(3);
    expect(new Set(hours).size).toBe(3);
  });

  it("produces exactly `count` DISTINCT keys across a DST fall-back", () => {
    // US DST ends 2026-11-01 02:00 local. A 5-day window crossing it must
    // yield exactly 5 distinct day keys and exactly 5 distinct hour keys.
    const after = new Date(2026, 10, 2, 12, 0, 0).getTime();
    const days = recentBucketKeys("day", 5, after);
    expect(days).toHaveLength(5);
    expect(new Set(days).size).toBe(5);
    const hours = recentBucketKeys("hour", 5, after);
    expect(hours).toHaveLength(5);
    expect(new Set(hours).size).toBe(5);
  });
});
