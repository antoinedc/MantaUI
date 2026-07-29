// channel.test.ts — pins the channel table + resolution rule (BET-370).
//
// Every assertion comes from the spec table — prod | staging | dev are
// frozen values, no derived lookups. A reader who changes one number here
// must change it in the spec, and vice versa.

import { describe, it, expect } from "vitest";
import { CHANNELS, CHANNEL_IDS, resolveChannel, channelConfig } from "./channel.mjs";

// ===========================================================================
// CHANNELS — the per-channel value table (spec verbatim)
// ===========================================================================

describe("CHANNELS — table values are pinned to the BET-370 spec", () => {
  it("prod matches the spec row exactly", () => {
    expect(CHANNELS.prod).toEqual({
      id: "prod",
      userDataDir: "manta",
      urlScheme: "manta",
      appName: "Manta UI",
      installShUrl: "https://mantaui.com/install.sh",
      releaseHost: "https://mantaui.com",
      updateFeed: "https://mantaui.com/updates",
      electronBuilderAppId: "com.antoinedc.mantaui",
      electronBuilderProductName: "Manta UI",
    });
  });

  it("staging matches the spec row exactly", () => {
    expect(CHANNELS.staging).toEqual({
      id: "staging",
      userDataDir: "manta-staging",
      urlScheme: "manta-staging",
      appName: "Manta UI (Staging)",
      installShUrl: "https://mantaui.com/staging/install.sh",
      releaseHost: "https://mantaui.com/staging",
      updateFeed: "https://mantaui.com/staging/updates",
      electronBuilderAppId: "com.antoinedc.mantaui.staging",
      electronBuilderProductName: "Manta UI (Staging)",
    });
  });

  it("dev matches the spec row (install/release same as prod; update + build = n/a)", () => {
    expect(CHANNELS.dev).toEqual({
      id: "dev",
      userDataDir: "manta-dev",
      urlScheme: "manta-dev",
      appName: "Manta UI (Dev)",
      installShUrl: "https://mantaui.com/install.sh",
      releaseHost: "https://mantaui.com",
      updateFeed: null,
      electronBuilderAppId: null,
      electronBuilderProductName: null,
    });
  });

  it("freezes every record + the table itself (no accidental drift)", () => {
    expect(Object.isFrozen(CHANNELS)).toBe(true);
    for (const id of CHANNEL_IDS) {
      expect(Object.isFrozen(CHANNELS[id])).toBe(true);
    }
  });

  it("CHANNEL_IDS lists exactly prod, staging, dev — no fourth channel", () => {
    expect(new Set(CHANNEL_IDS)).toEqual(new Set(["prod", "staging", "dev"]));
  });
});

// ===========================================================================
// resolveChannel — the one rule: packaged ? baked : dev, with bad baked → prod
// ===========================================================================

describe("resolveChannel", () => {
  it("unpackaged always wins — returns 'dev' regardless of baked value", () => {
    expect(resolveChannel(false, "prod")).toBe("dev");
    expect(resolveChannel(false, "staging")).toBe("dev");
    expect(resolveChannel(false, "dev")).toBe("dev");
    expect(resolveChannel(false, undefined)).toBe("dev");
    expect(resolveChannel(false, "garbage")).toBe("dev");
  });

  it("packaged + valid baked channel returns that channel", () => {
    expect(resolveChannel(true, "prod")).toBe("prod");
    expect(resolveChannel(true, "staging")).toBe("staging");
    expect(resolveChannel(true, "dev")).toBe("dev");
  });

  it("packaged + undefined baked value falls back to prod", () => {
    expect(resolveChannel(true, undefined)).toBe("prod");
  });

  it("packaged + null baked value falls back to prod", () => {
    expect(resolveChannel(true, null as unknown as string)).toBe("prod");
  });

  it("packaged + unrecognised baked value falls back to prod (never throws)", () => {
    expect(resolveChannel(true, "garbage")).toBe("prod");
    expect(resolveChannel(true, "PROD")).toBe("prod");
    expect(resolveChannel(true, "")).toBe("prod");
    expect(resolveChannel(true, 42 as unknown as string)).toBe("prod");
  });
});

// ===========================================================================
// channelConfig — returns the record for a channel; unknown → prod
// ===========================================================================

describe("channelConfig", () => {
  it("returns the same frozen record for prod / staging / dev", () => {
    expect(channelConfig("prod")).toBe(CHANNELS.prod);
    expect(channelConfig("staging")).toBe(CHANNELS.staging);
    expect(channelConfig("dev")).toBe(CHANNELS.dev);
  });

  it("returns the prod record for an unknown channel (never throws)", () => {
    expect(channelConfig("unknown" as unknown as "prod")).toBe(CHANNELS.prod);
    expect(channelConfig(undefined)).toBe(CHANNELS.prod);
    expect(channelConfig(null as unknown as "prod")).toBe(CHANNELS.prod);
    expect(channelConfig("" as unknown as "prod")).toBe(CHANNELS.prod);
  });
});

// ===========================================================================
// Scheme-distinctness — the wire-format safety net.
//
// A `manta://pair?...` link intended for the prod app must not be mis-
// delivered to staging, and vice versa. Pinning the schemes here means a
// future PR that tries to unify them has to update this test alongside the
// pair-link parser on the renderer side.
// ===========================================================================

describe("scheme-distinctness guards", () => {
  it("the three URL schemes are pairwise distinct", () => {
    const schemes = new Set(CHANNEL_IDS.map((id) => CHANNELS[id].urlScheme));
    expect(schemes.size).toBe(3);
  });

  it("no URL-form prefix (`scheme://`) is a prefix of another (guards against mis-delivery)", () => {
    // The actual mis-delivery vector is `argv.find(a => a.startsWith(prefix))`
    // in main process — so we compare URL FORM (`scheme://`), not raw scheme.
    // The `://` boundary stops the match for `manta-staging://` vs `manta://`
    // even though "manta" is a substring prefix of "manta-staging".
    const urlForms = CHANNEL_IDS.map((id) => `${CHANNELS[id].urlScheme}://`);
    for (let i = 0; i < urlForms.length; i++) {
      for (let j = 0; j < urlForms.length; j++) {
        if (i === j) continue;
        expect(urlForms[i].startsWith(urlForms[j])).toBe(false);
      }
    }
  });
});
