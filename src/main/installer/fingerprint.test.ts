// fingerprint.test.ts — parseFingerprint / isHostKeyVerificationFailure.
// Pure: feeds the canonical OpenSSH stderr snippets and asserts on the
// structured result. No ssh, no I/O.

import { describe, it, expect } from "vitest";
import {
  parseFingerprint,
  isHostKeyVerificationFailure,
} from "./fingerprint.js";

describe("parseFingerprint", () => {
  it("parses the modern OpenSSH stderr line (ED25519 key fingerprint is SHA256:…)", () => {
    const stderr = [
      "The authenticity of host 'box.example.com (203.0.113.5)' can't be established.",
      "ED25519 key fingerprint is SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG=.",
      "Host key verification failed.",
    ].join("\n");
    const r = parseFingerprint(stderr);
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.fingerprint.algo).toBe("ED25519");
    expect(r.fingerprint.sha256).toBe("SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG=");
  });

  it("parses the RSA variant", () => {
    const stderr =
      "RSA key fingerprint is SHA256:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=.";
    const r = parseFingerprint(stderr);
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.fingerprint.algo).toBe("RSA");
    expect(r.fingerprint.sha256).toBe("SHA256:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=");
  });

  it("parses the ECDSA variant", () => {
    const r = parseFingerprint(
      "ECDSA key fingerprint is SHA256:EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE=.",
    );
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.fingerprint.algo).toBe("ECDSA");
  });

  it("parses the BET-361-issue variant 'ED25519 fingerprint: SHA256:…'", () => {
    const r = parseFingerprint("ED25519 fingerprint: SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG=");
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.fingerprint.algo).toBe("ED25519");
    expect(r.fingerprint.sha256).toBe("SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG=");
  });

  it("normalizes the algorithm to upper-case", () => {
    const r = parseFingerprint("ed25519 key fingerprint is SHA256:AAAA=");
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.fingerprint.algo).toBe("ED25519");
  });

  it("returns found:false for an auth-failed stderr (Permission denied)", () => {
    const stderr = "Permission denied (publickey).";
    expect(parseFingerprint(stderr).found).toBe(false);
  });

  it("returns found:false for an unreachable stderr (Connection refused)", () => {
    const stderr = "ssh: connect to host 203.0.113.5 port 22: Connection refused";
    expect(parseFingerprint(stderr).found).toBe(false);
  });

  it("returns found:false for empty / non-string input", () => {
    expect(parseFingerprint("").found).toBe(false);
    expect(parseFingerprint("just some log output\nwith no fingerprint").found).toBe(false);
  });

  it("returns found:false when a SHA256 token appears without an algorithm name", () => {
    // A stray base64-ish blob that isn't a host-key line.
    expect(parseFingerprint("digest SHA256:abcd== for payload").found).toBe(false);
  });

  it("handles CRLF line endings", () => {
    const stderr =
      "ED25519 key fingerprint is SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG=.\r\nHost key verification failed.\r\n";
    const r = parseFingerprint(stderr);
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.fingerprint.algo).toBe("ED25519");
  });
});

describe("isHostKeyVerificationFailure", () => {
  it("recognizes 'Host key verification failed'", () => {
    expect(isHostKeyVerificationFailure("Host key verification failed.")).toBe(true);
  });

  it("recognizes 'authenticity of host'", () => {
    expect(
      isHostKeyVerificationFailure(
        "The authenticity of host 'box (1.2.3.4)' can't be established.",
      ),
    ).toBe(true);
  });

  it("returns false for auth / network failures", () => {
    expect(isHostKeyVerificationFailure("Permission denied (publickey).")).toBe(false);
    expect(isHostKeyVerificationFailure("Connection refused")).toBe(false);
    expect(isHostKeyVerificationFailure("")).toBe(false);
  });
});
