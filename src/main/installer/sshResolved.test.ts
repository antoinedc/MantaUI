// sshResolved.test.ts — parseSshG unit tests.
// Pure: takes captured stdout, returns a ResolvedSshConnection. The runner
// spawns the real `ssh -G` and passes the captured output in.

import { describe, it, expect } from "vitest";
import { parseSshG } from "./sshResolved.js";

describe("parseSshG", () => {
  it("returns nulls on empty / non-string input", () => {
    expect(parseSshG("")).toEqual({
      hostname: null,
      user: null,
      port: null,
      identityFiles: [],
    });
    // @ts-expect-error – deliberate: defensive runtime check
    expect(parseSshG(null)).toEqual({
      hostname: null,
      user: null,
      port: null,
      identityFiles: [],
    });
  });

  it("parses the canonical four fields from a real-looking `ssh -G` block", () => {
    const text = [
      "user dev",
      "hostname 10.0.0.5",
      "port 2222",
      "identityfile /Users/dev/.ssh/id_ed25519",
      "identityfile /Users/dev/.ssh/id_rsa",
      "stricthostkeychecking ask",
      "userknownhostsfile /Users/dev/.ssh/known_hosts",
      "forwardagent no",
      "",
    ].join("\n");
    expect(parseSshG(text)).toEqual({
      hostname: "10.0.0.5",
      user: "dev",
      port: 2222,
      identityFiles: [
        "/Users/dev/.ssh/id_ed25519",
        "/Users/dev/.ssh/id_rsa",
      ],
    });
  });

  it("returns null port when the line is non-numeric / out of range", () => {
    expect(parseSshG("port 22\n").port).toBe(22);
    expect(parseSshG("port 0\n").port).toBeNull();
    expect(parseSshG("port 65536\n").port).toBeNull();
    expect(parseSshG("port twenty\n").port).toBeNull();
    expect(parseSshG("port -1\n").port).toBeNull();
  });

  it("collects multiple identityfile lines in source order", () => {
    const text = [
      "identityfile /a",
      "identityfile /b",
      "identityfile /c",
    ].join("\n");
    expect(parseSshG(text).identityFiles).toEqual(["/a", "/b", "/c"]);
  });

  it("ignores unknown keys (ssh -G emits ~20 fields, we read 4)", () => {
    const text = [
      "user dev",
      "hostname box.example",
      "port 22",
      "stricthostkeychecking ask",
      "userknownhostsfile /Users/dev/.ssh/known_hosts",
      "proxycommand none",
      "forwardagent no",
      "compression no",
      "kbdinteractiveauthentication no",
    ].join("\n");
    expect(parseSshG(text)).toEqual({
      hostname: "box.example",
      user: "dev",
      port: 22,
      identityFiles: [],
    });
  });

  it("ignores blank lines without crashing", () => {
    expect(parseSshG("\n\nuser dev\n\nhostname box\n\n").user).toBe("dev");
  });
});
