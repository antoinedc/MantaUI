// media.mjs — inline media server tools (media_save / media_begin / media_show).
//
// Lets the AI put a generated image or video INTO the transcript, with a
// correctly-sized placeholder while it is still being produced. Mirrors
// src/server/appControl.mjs: pure logic with injected I/O, one `dispatch`
// switch, client-visible effects published on the bus as ONE kind, `media`,
// with an `action` discriminator (`begin` | `show` | `fail`). The bus envelope
// ({ kind:"media", payload }) is added by index.mjs; each function here calls
// its injected `publish` with the bare payload.
//
// Three tools, locked (do not redesign):
//   - media_save  — the model has media in *some* form (base64 blob, or a file
//                   it downloaded with curl). Writes it into the artifact
//                   mailbox (~/.manta-outbox/<sessionID>/) via pushArtifact and
//                   measures it, returning the real path + metadata.
//   - media_begin — called BEFORE a slow generation. Declares *intended*
//                   metadata so the UI can reserve the exact final space.
//                   Returns a handle.
//   - media_show  — called AFTER, with a local path (+ the handle). Swaps the
//                   real media in.
//
// media_show accepts ONLY a local path — it never fetches a URL and never
// accepts raw bytes. The model is responsible for turning whatever it received
// into a file first (via media_save, or its own curl). This is deliberate: it
// keeps the display path total and removes any outbound-request decision from
// the box.

import { readFile, writeFile, rm, mkdtemp } from "node:fs/promises";
import { homedir as osHomedir, tmpdir } from "node:os";
import { join, basename, resolve, extname } from "node:path";
import { randomBytes } from "node:crypto";
import { pushArtifact as defaultPushArtifact } from "./outbox.mjs";

// A `begin` with no matching `show` publishes `action:"fail"` and is dropped
// after this long. In-memory only — a placeholder need not survive a restart.
export const ORPHAN_TIMEOUT_MS = 10 * 60 * 1000;
export const MEDIA_SWEEP_MS = 30 * 1000;

// Small extension → MIME map for the tools' returns. Video is never measured
// (see readImageSize) — its mime is still reported from the extension.
const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".m4v": "video/x-m4v",
};

export function guessMime(name) {
  return MIME_BY_EXT[(extname(name || "") || "").toLowerCase()] ?? "application/octet-stream";
}

// Opaque 128-bit handle id (matches the box_id token pattern: 32 hex chars).
export function randomHex() {
  return randomBytes(16).toString("hex");
}

// In-memory pending-placeholder store. Handles survival is not required, so an
// in-memory Map is the whole durability story — no durable store, no JSON file.
export function createPendingMediaStore() {
  const map = new Map();
  return {
    set(handle, meta) {
      map.set(handle, { createdAt: Date.now(), ...meta });
    },
    get(handle) {
      return map.get(handle);
    },
    delete(handle) {
      map.delete(handle);
    },
    entries() {
      return [...map.entries()];
    },
    size() {
      return map.size;
    },
  };
}

// Header-only image dimension reader — no new dependency. PNG / JPEG / GIF /
// WebP → { width, height }; anything else (or truncated/unknown bytes) →
// null. This is a supported outcome, never a throw. Video is deliberately NOT
// measured (ffprobe/ffmpeg may not exist on the box); video relies on the
// metadata declared in media_begin.
export function readImageSize(buffer) {
  try {
    if (!Buffer.isBuffer(buffer) || buffer.length < 8) return null;
    const b = buffer;
    // PNG: 8-byte signature, then IHDR width/height as 4-byte BE at 16/20.
    if (
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
    ) {
      if (b.length < 24) return null;
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    }
    // GIF87a / GIF89a: logical screen descriptor width/height as 2-byte LE at 6/8.
    if (
      b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 &&
      (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61
    ) {
      if (b.length < 10) return null;
      return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    }
    // JPEG: walk markers to the first SOFn segment; height/width as 2-byte BE
    // right after the 1-byte precision field.
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
      let i = 2;
      while (i + 9 <= b.length) {
        if (b[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = b[i + 1];
        // Standalone markers carry no length field.
        if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
          i += 2;
          continue;
        }
        if (marker === 0xff) {
          i++;
          continue;
        }
        if (i + 4 > b.length) return null;
        const segLen = b.readUInt16BE(i + 2);
        // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC).
        if (
          marker >= 0xc0 && marker <= 0xcf &&
          marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
        ) {
          if (i + 9 > b.length) return null;
          return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
        }
        i += 2 + segLen;
      }
      return null;
    }
    // WebP (RIFF container): branch on the first chunk type.
    if (
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
    ) {
      const signature = Buffer.from(b.subarray(12, 16)).toString("latin1");
      if (signature === "VP8X") {
        if (b.length < 30) return null;
        return {
          width: readLE24(b, 24) + 1,
          height: readLE24(b, 27) + 1,
        };
      }
      if (signature === "VP8L") {
        if (b.length < 25 || b[20] !== 0x2f) return null;
        const width = b[21] | ((b[22] & 0x3f) << 8);
        const height = ((b[22] >> 6) & 0x3) | (b[23] << 2) | ((b[24] & 0x0f) << 10);
        return { width: width + 1, height: height + 1 };
      }
      if (signature === "VP8 ") {
        if (b.length < 30 || !(b[20] === 0x9d && b[21] === 0x01 && b[22] === 0x2a)) return null;
        return { width: b.readUInt16LE(26), height: b.readUInt16LE(28) };
      }
      return null;
    }
    return null;
  } catch {
    return null; // truncated / malformed → unsupported, not a throw
  }
}

function readLE24(b, offset) {
  return b[offset] | (b[offset + 1] << 8) | (b[offset + 2] << 16);
}

// The SAME path rule /api/peek applies (see src/server/peek.mjs): expand a
// leading `~` / lone `~`, resolve, and require the result to stay inside the
// user's home directory. Returns the resolved absolute path, or null when the
// path is outside home (callers reject that with a clear error).
export function resolvePathWithinHome(raw, home) {
  if (typeof raw !== "string" || !raw) return null;
  const base = home.endsWith("/") ? home : home + "/";
  let resolved;
  if (raw === "~") resolved = base;
  else if (raw.startsWith("~/")) resolved = base + raw.slice(2);
  else resolved = resolve(raw);
  if (resolved !== base && !resolved.startsWith(base)) return null;
  return resolved;
}

async function readForMeasure(filePath, deps) {
  const read = deps.readFile || readFile;
  return read(filePath);
}

// media_save — write media (base64 blob OR an existing local file) into the
// artifact mailbox and measure it. Exactly one of `data` / `sourcePath` must
// be supplied. Returns { path, mime, width, height, size } (width/height null
// when unmeasurable). The write goes through the existing pushArtifact (the
// artifact mailbox is ~/.manta-outbox/<sessionID>/, swept by the existing
// expireArtifacts sweep — no new retention, no new folder).
export async function saveMedia(
  { data, sourcePath, filename, sessionID, messageID },
  deps = {},
) {
  const write = deps.writeFile || writeFile;
  const remove = deps.rm || rm;
  const mkTemp = deps.mkdtemp || mkdtemp;
  const pushArtifact = deps.pushArtifact || defaultPushArtifact;

  if (!sessionID || typeof sessionID !== "string" || !sessionID.trim()) {
    return { ok: false, error: "sessionID is required." };
  }
  const hasData = typeof data === "string" && data !== "";
  const hasSource = typeof sourcePath === "string" && sourcePath !== "";
  if (hasData === hasSource) {
    return {
      ok: false,
      error: hasData
        ? 'Pass exactly one of "data" (base64) or "sourcePath", not both.'
        : 'One of "data" (base64) or "sourcePath" is required.',
    };
  }

  const displayName =
    typeof filename === "string" && filename.trim()
      ? basename(filename)
      : hasSource
        ? basename(sourcePath)
        : "media";

  let measurePath = sourcePath;
  let tempDir = null;
  if (hasData) {
    let buf;
    try {
      buf = Buffer.from(data, "base64");
    } catch {
      return { ok: false, error: '"data" is not a valid base64 string.' };
    }
    if (buf.length === 0) return { ok: false, error: '"data" is empty.' };
    tempDir = await mkTemp(join(tmpdir(), "manta-media-"));
    const safeName = displayName.replace(/[^A-Za-z0-9._-]/g, "_") || "media";
    measurePath = join(tempDir, safeName);
    await write(measurePath, buf);
  }

  let measureBuf;
  try {
    measureBuf = await readForMeasure(measurePath, deps);
  } catch (err) {
    if (tempDir) await remove(tempDir, { recursive: true, force: true }).catch(() => {});
    return { ok: false, error: srcReadError(hasSource ? sourcePath : measurePath, err) };
  }
  const size = measureBuf.length;

  const pushed = await pushArtifact(measurePath, sessionID, {
    messageID: typeof messageID === "string" && messageID ? messageID : undefined,
  });

  if (tempDir) await remove(tempDir, { recursive: true, force: true }).catch(() => {});

  if (!pushed?.ok) {
    return { ok: false, error: pushed?.error ?? "Failed to write into the artifact mailbox." };
  }

  const dim = readImageSize(measureBuf);
  const mime = guessMime(displayName);
  return {
    ok: true,
    path: pushed?.row?.path ?? measurePath,
    mime,
    width: dim?.width ?? null,
    height: dim?.height ?? null,
    size,
  };
}

function srcReadError(target, err) {
  return `Could not read "${target}": ${err?.message ?? err}`;
}

// media_begin — declare INTENDED metadata before a slow generation so the UI
// can reserve the exact final space. `kind` is "image" | "video". Returns
// { handle }; publishes { action:"begin", handle, ... }.
export async function beginMedia(
  { kind, width, height, aspectRatio, count, title, sessionID, messageID },
  deps = {},
) {
  const pending = deps.pending;
  const publish = deps.publish || (() => {});
  if (kind !== "image" && kind !== "video") {
    return { ok: false, error: 'kind must be "image" or "video".' };
  }
  if (!sessionID || typeof sessionID !== "string" || !sessionID.trim()) {
    return { ok: false, error: "sessionID is required." };
  }
  const handle = randomHex();
  if (pending) pending.set(handle, { sessionID, messageID: messageID ?? null, kind });
  publish({
    action: "begin",
    handle,
    sessionID,
    messageID: messageID ?? null,
    kind,
    width: typeof width === "number" ? width : null,
    height: typeof height === "number" ? height : null,
    aspectRatio: typeof aspectRatio === "number" ? aspectRatio : null,
    count: typeof count === "number" ? count : null,
    title: typeof title === "string" && title ? title : null,
  });
  return { ok: true, handle };
}

// media_show — display an EXISTING local file (the model turned whatever it
// received into a file first). Validates the path (home-only rule), measures
// it, publishes { action:"show", ... }; clears the pending entry when a handle
// is supplied. Works with no handle — the standalone case.
export async function showMedia(
  { path, handle, title, sessionID, messageID },
  deps = {},
) {
  const homedir = deps.homedir || osHomedir;
  const pending = deps.pending;
  const publish = deps.publish || (() => {});
  if (typeof path !== "string" || !path.trim()) {
    return { ok: false, error: 'path is required — pass a local path to an existing file.' };
  }
  const resolved = resolvePathWithinHome(path, deps.home ?? homedir());
  if (!resolved) {
    return { ok: false, error: "path must be inside the user's home directory." };
  }
  let buf;
  try {
    buf = await readForMeasure(resolved, deps);
  } catch (err) {
    return { ok: false, error: srcReadError(path, err) };
  }
  if (handle && pending) pending.delete(handle);
  const dim = readImageSize(buf);
  const mime = guessMime(resolved);
  const payload = {
    action: "show",
    path: resolved,
    handle: handle ?? null,
    title: typeof title === "string" && title ? title : null,
    sessionID,
    messageID: messageID ?? null,
    mime,
    width: dim?.width ?? null,
    height: dim?.height ?? null,
    size: buf.length,
  };
  publish(payload);
  return { ok: true, ...payload };
}

// Pure: given the pending store's entries, return the handles whose begin has
// not been followed by a show within ORPHAN_TIMEOUT_MS. The poller publishes
// `action:"fail"` and deletes each.
export function sweepPendingMedia(now, pending, timeoutMs = ORPHAN_TIMEOUT_MS) {
  const out = [];
  for (const [handle, entry] of pending.entries()) {
    if (entry && now - entry.createdAt > timeoutMs) out.push(handle);
  }
  return out;
}

// Thin poller wiring for the box (mirrors createArtifactSweep's shape):
// inFlight guard + timer.unref(). Publishes `action:"fail"` for each orphaned
// placeholder and clears it.
export function createMediaSweep({
  pending,
  publish = () => {},
  intervalMs = MEDIA_SWEEP_MS,
  now = Date.now,
} = {}) {
  let timer = null;
  let running = false;
  const sweep = () => {
    if (running) return;
    running = true;
    try {
      const t = now();
      for (const handle of sweepPendingMedia(t, pending, ORPHAN_TIMEOUT_MS)) {
        const entry = pending.get(handle);
        publish({
          action: "fail",
          handle,
          sessionID: entry?.sessionID ?? null,
          messageID: entry?.messageID ?? null,
        });
        pending.delete(handle);
      }
    } finally {
      running = false;
    }
  };
  return {
    start() {
      void sweep();
      timer = setInterval(() => void sweep(), intervalMs);
      if (timer.unref) timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    sweep,
  };
}

// Dispatch an /api/media request on its `action` (`save` | `begin` | `show`),
// mirroring /api/app-control. One switch — action handling never scatters
// across the route and the module. Returns `{ ok: true, ... }` or `{ ok:
// false, error }`.
export async function dispatch(action, body = {}, deps = {}) {
  switch (action) {
    case "save":
      return saveMedia(body, deps);
    case "begin":
      return beginMedia(body, deps);
    case "show":
      return showMedia(body, deps);
    default:
      return {
        ok: false,
        error: `unknown action "${action}". Supported actions: save, begin, show.`,
      };
  }
}
