// @vitest-environment jsdom
//
// Unit tests for the shared staged-attachment upload round-trip
// (uploadDraftAttachment). Both submit() and submitFanOut() route through it,
// so its contract — return the remote path on success, null when uploadBuffer
// returns an empty/falsy path — is what every creation path relies on.

import { describe, it, expect, afterEach } from "vitest";
import { uploadDraftAttachment } from "./NewSessionScreen";

function stagedFile(): { filename: string; file: File } {
  const file = new File(["content"], "note.md", { type: "text/markdown" });
  // jsdom's File lacks arrayBuffer(); uploadDraftAttachment() reads bytes this
  // way — same polyfill the harness applies to staged files.
  (file as File & { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer = () =>
    Promise.resolve(new ArrayBuffer(1));
  return { filename: "note.md", file };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function setUploadBuffer(impl: (args: unknown) => unknown): void {
  (window as any).api = { uploadBuffer: impl };
}

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).api;
});

describe("uploadDraftAttachment", () => {
  it("returns the remote path when uploadBuffer succeeds", async () => {
    let received: unknown = null;
    setUploadBuffer((args) => {
      received = args;
      return Promise.resolve("/remote/note.md");
    });

    const rp = await uploadDraftAttachment("proj", stagedFile());

    expect(rp).toBe("/remote/note.md");
    expect(received).toMatchObject({ projectName: "proj", filename: "note.md" });
  });

  it("returns null when uploadBuffer returns an empty/falsy path", async () => {
    setUploadBuffer(() => Promise.resolve(""));
    expect(await uploadDraftAttachment("proj", stagedFile())).toBeNull();

    setUploadBuffer(() => Promise.resolve(undefined));
    expect(await uploadDraftAttachment("proj", stagedFile())).toBeNull();
  });
});
