// sshConfig.test.ts — parseSshConfig unit tests.
// Pure helpers; no SSH I/O. The integration with the real ssh_config is
// exercised via runner.ts's `ssh -G` path (which is what we use for any
// actual connection).

import { describe, it, expect } from "vitest";
import { parseSshConfig } from "./sshConfig.js";

describe("parseSshConfig", () => {
  it("returns [] on empty / non-string input", () => {
    expect(parseSshConfig("")).toEqual([]);
    expect(parseSshConfig("   \n\n   ")).toEqual([]);
    // @ts-expect-error – deliberate: defensive runtime check
    expect(parseSshConfig(null)).toEqual([]);
    // @ts-expect-error – deliberate: defensive runtime check
    expect(parseSshConfig(undefined)).toEqual([]);
  });

  it("extracts a single Host block with one pattern", () => {
    const text = `
# my boxes
Host dev
    HostName 10.0.0.5
    User dev
`;
    expect(parseSshConfig(text)).toEqual([
      { alias: "dev", patterns: ["dev"] },
    ]);
  });

  it("extracts multiple Host blocks in source order", () => {
    const text = `
Host alpha
HostName alpha.example
Host beta
HostName beta.example
Host gamma
HostName gamma.example
`;
    expect(parseSshConfig(text)).toEqual([
      { alias: "alpha", patterns: ["alpha"] },
      { alias: "beta", patterns: ["beta"] },
      { alias: "gamma", patterns: ["gamma"] },
    ]);
  });

  it("expands multi-pattern Host lines into the patterns[] list", () => {
    const text = `Host foo bar "my box" baz\n`;
    expect(parseSshConfig(text)).toEqual([
      { alias: "foo", patterns: ["foo", "bar", "my box", "baz"] },
    ]);
  });

  it("skips the default `Host *` block", () => {
    const text = `
Host *
    User root
Host dev
    HostName 10.0.0.5
`;
    expect(parseSshConfig(text)).toEqual([
      { alias: "dev", patterns: ["dev"] },
    ]);
  });

  it("drops a `Host *`-mixed directive entirely (no pickable patterns)", () => {
    const text = `Host *\n    User root\n`;
    expect(parseSshConfig(text)).toEqual([]);
  });

  it("keeps the non-* patterns from a mixed Host line", () => {
    const text = `Host dev *\n    User dev\n`;
    expect(parseSshConfig(text)).toEqual([
      { alias: "dev", patterns: ["dev"] },
    ]);
  });

  it("accepts case-insensitive directive spellings", () => {
    const text = `
host lower
HOST UPPER
hOsT MiXeD
`;
    expect(parseSshConfig(text).map((e) => e.alias)).toEqual([
      "lower",
      "UPPER",
      "MiXeD",
    ]);
  });

  it("tolerates an `= foo` leading `=` (ssh allows `-o Host = foo`) ", () => {
    const text = `Host = dev\n    HostName 10.0.0.5\n`;
    expect(parseSshConfig(text)).toEqual([
      { alias: "dev", patterns: ["dev"] },
    ]);
  });

  it("ignores comment lines and inline `#` comments", () => {
    const text = `
# top-level comment
Host alpha # trailing inline comment
    HostName 10.0.0.1 # another
Host beta
    HostName 10.0.0.2
`;
    expect(parseSshConfig(text)).toEqual([
      { alias: "alpha", patterns: ["alpha"] },
      { alias: "beta", patterns: ["beta"] },
    ]);
  });

  it("ignores property lines inside Host blocks (we only enumerate aliases)", () => {
    const text = `
Host alpha
    HostName 10.0.0.1
    User dev
    IdentityFile ~/.ssh/id_ed25519
    ForwardAgent yes
Host beta
    HostName 10.0.0.2
`;
    expect(parseSshConfig(text)).toEqual([
      { alias: "alpha", patterns: ["alpha"] },
      { alias: "beta", patterns: ["beta"] },
    ]);
  });

  it("ignores Include / Match directives without erroring", () => {
    const text = `
Include ~/.ssh/conf.d/*
Match host *.internal exec "true"
Host real
    HostName 10.0.0.3
`;
    expect(parseSshConfig(text)).toEqual([
      { alias: "real", patterns: ["real"] },
    ]);
  });

  it("strips surrounding double quotes from alias tokens", () => {
    const text = `Host "my box" "another"\n`;
    expect(parseSshConfig(text)).toEqual([
      { alias: "my box", patterns: ["my box", "another"] },
    ]);
  });

  it("tolerates Windows CRLF line endings", () => {
    const text = "Host dev\r\n    HostName 10.0.0.1\r\nHost beta\r\n";
    expect(parseSshConfig(text)).toEqual([
      { alias: "dev", patterns: ["dev"] },
      { alias: "beta", patterns: ["beta"] },
    ]);
  });
});
