// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { mount, type Harness } from "../testHarness";
import { ArtifactPreview } from "../ArtifactPreview";
import type { Artifact } from "../artifacts";
import { MAX_PREVIEW_BYTES } from "../chatUtils";
import { MediaBody, usePeekedMedia } from "./MediaBody";

let h: Harness | null = null;
let created: string[];
let revoked: string[];
let calls: Array<{ method: string; headers: Record<string, string> }>;
let respond: () => Response;

beforeEach(() => {
  localStorage.setItem("manta_server", "http://box.test");
  localStorage.setItem("manta_token", "tok");
  created = [];
  revoked = [];
  calls = [];
  URL.createObjectURL = vi.fn(() => {
    const u = `blob:m-${created.length}`;
    created.push(u);
    return u;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn((u: string) => {
    revoked.push(u);
  }) as typeof URL.revokeObjectURL;
  respond = () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit = {}) => {
      calls.push({ method: init.method ?? "GET", headers: init.headers as Record<string, string> });
      return respond();
    }),
  );
});
afterEach(() => {
  h?.unmount();
  h = null;
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function wait() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

describe("MediaBody", () => {
  it("renders an image and reports its intrinsic size", () => {
    const onDims = vi.fn();
    h = mount(<MediaBody kind="image" url="blob:x" label="pic.png" onDims={onDims} />);
    const img = h.container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("blob:x");
    expect(img.getAttribute("alt")).toBe("pic.png");
    Object.defineProperty(img, "naturalWidth", { value: 40 });
    Object.defineProperty(img, "naturalHeight", { value: 30 });
    act(() => {
      img.dispatchEvent(new Event("load"));
    });
    expect(onDims).toHaveBeenCalledWith({ width: 40, height: 30 });
  });

  it("renders video with controls and no autoplay", () => {
    h = mount(<MediaBody kind="video" url="blob:v" label="clip.mp4" />);
    const v = h.container.querySelector("video")!;
    expect(v.controls).toBe(true);
    expect(v.autoplay).toBe(false);
    expect(v.getAttribute("src")).toBe("blob:v");
  });
});

function Probe({ path, version }: { path: string; version: number }) {
  const m = usePeekedMedia(path, version);
  return <span data-status={m.status} data-url={m.status === "ready" ? m.url : ""} data-reason={m.status === "failed" ? m.reason : ""} />;
}
const probe = () => h!.container.querySelector("span")!;

describe("usePeekedMedia", () => {
  it("loads into a blob URL with the auth header and revokes it on change/unmount", async () => {
    h = mount(<Probe path="/home/dev/a.png" version={0} />);
    await wait();
    expect(probe().dataset.status).toBe("ready");
    expect(probe().dataset.url).toBe("blob:m-0");
    expect(calls[0].headers.authorization).toBe("Bearer tok");
    h.rerender(<Probe path="/home/dev/a.png" version={1} />);
    await wait();
    expect(revoked).toEqual(["blob:m-0"]);
    expect(probe().dataset.url).toBe("blob:m-1");
    h.unmount();
    h = null;
    expect(revoked).toEqual(["blob:m-0", "blob:m-1"]);
  });

  it("reports a failure reason", async () => {
    respond = () => new Response(JSON.stringify({ reason: "missing" }), { status: 404 });
    h = mount(<Probe path="/home/dev/a.png" version={0} />);
    await wait();
    expect(probe().dataset.status).toBe("failed");
    expect(probe().dataset.reason).toBe("missing");
  });
});

describe("ArtifactPreview (shared media path)", () => {
  const art = (label: string, mime: string): Artifact => ({
    id: "i",
    kind: "file",
    origin: "agent",
    label,
    href: `/home/dev/${label}`,
    mime,
    size: null,
    at: 0,
    messageId: null,
    context: null,
    isHosted: false,
    expiry: null,
    plan: null,
  });
  const open = (a: Artifact) =>
    mount(<ArtifactPreview artifacts={[a]} index={0} onClose={() => {}} onDownload={() => {}} onAttach={null} />);

  it("shows an image through the shared MediaBody", async () => {
    h = open(art("pic.png", "image/png"));
    await wait();
    expect(h.container.querySelector("img")?.getAttribute("src")).toBe("blob:m-0");
    expect(calls[0].headers.authorization).toBe("Bearer tok");
  });

  it("shows video through the shared MediaBody", async () => {
    respond = () => new Response(new Uint8Array([1]), { status: 200, headers: { "content-type": "video/mp4" } });
    h = open(art("clip.mp4", "video/mp4"));
    await wait();
    expect(h.container.querySelector("video")?.getAttribute("src")).toBe("blob:m-0");
  });

  it("refuses a too-large file with its size and a Download", async () => {
    respond = () =>
      new Response(null, { status: 200, headers: { "content-length": String(MAX_PREVIEW_BYTES + 5), "content-type": "image/png" } });
    h = open(art("huge.png", "image/png"));
    await wait();
    expect(h.container.textContent).toContain("Too large to preview");
    expect(h.container.querySelector('button[aria-label="Download"]')).toBeTruthy();
  });

  it("reports a load failure", async () => {
    respond = () => new Response("nope", { status: 404 });
    h = open(art("gone.png", "image/png"));
    await wait();
    expect(h.container.textContent).toContain("Couldn’t load this file to preview.");
  });
});
