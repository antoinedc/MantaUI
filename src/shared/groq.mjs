// groq.mjs — thin client for api.groq.com used by both transports.
//
// Runs in main (Electron Node) and the mobile server (Node). Stays out of
// the renderer so the Groq API key never leaves the trusted process. Uses
// only Node 22 built-ins (global fetch, FormData, Blob) — no SDK dep.
//
// One operation:
//   - transcribeAudio: POST /openai/v1/audio/transcriptions (multipart, file+model)
//
// Error contract: throws Error with a single-line message suitable for
// renderer toast display. Transport errors get the bare-fetch-failed unwrap
// treatment that opencode.ts uses elsewhere (cause.code).

const GROQ_BASE = "https://api.groq.com/openai/v1";

const DEFAULT_TRANSCRIPTION_MODEL = "whisper-large-v3-turbo";

/** @param {unknown} e */
function explainFetchError(e) {
  if (!e || typeof e !== "object") return String(e);
  const err = /** @type {{ message?: string; cause?: { code?: string; message?: string } }} */ (e);
  const cause = err.cause;
  const detail = cause?.code || cause?.message || err.message || String(e);
  return detail;
}

/**
 * Pick a filename + extension that matches the recorder's mime type, so
 * Groq's whisper endpoint can route it to the right decoder. The endpoint
 * is content-sniffed but the extension is a robust hint that survives
 * proxies that strip Content-Type.
 *
 * @param {string} mime
 */
export function filenameFor(mime) {
  if (mime.includes("webm")) return "audio.webm";
  if (mime.includes("ogg")) return "audio.ogg";
  if (mime.includes("mp4") || mime.includes("m4a")) return "audio.m4a";
  if (mime.includes("wav")) return "audio.wav";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "audio.mp3";
  if (mime.includes("flac")) return "audio.flac";
  // Fallback: webm is what Chromium produces by default.
  return "audio.webm";
}

/**
 * Transcribe an audio buffer via Groq.
 *
 * @param {object} args
 * @param {ArrayBuffer | Uint8Array | Buffer} args.buffer  — raw audio bytes
 * @param {string}                          args.mime    — recorder mimeType
 * @param {string}                          args.apiKey  — required; throws if empty
 * @param {string}                          [args.model] — defaults to whisper-large-v3-turbo
 * @returns {Promise<{ text: string }>}
 */
export async function transcribeAudio({ buffer, mime, apiKey, model }) {
  if (!apiKey || typeof apiKey !== "string") {
    throw new Error("Groq API key not configured. Add it in Settings.");
  }
  if (!buffer) throw new Error("No audio captured.");

  // Node's Blob accepts ArrayBuffer/Buffer/Uint8Array directly. We normalize
  // to a Uint8Array view so Blob doesn't re-copy a Buffer's slab.
  const view =
    buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer)
      : buffer instanceof Uint8Array
        ? buffer
        : new Uint8Array(buffer);

  // Groq rejects sub-100ms blobs as "audio_too_short". Better to no-op here
  // than to show a confusing API error in the toast.
  if (view.byteLength < 1024) {
    return { text: "" };
  }

  const blob = new Blob([view], { type: mime || "audio/webm" });
  const form = new FormData();
  form.set("file", blob, filenameFor(mime || ""));
  form.set("model", model || DEFAULT_TRANSCRIPTION_MODEL);
  form.set("response_format", "json");
  // Hint English for now — non-English users can edit transcripts in the
  // textarea before sending. We can promote this to a setting if asked.
  // form.set("language", "en");

  const url = `${GROQ_BASE}/audio/transcriptions`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
    });
  } catch (e) {
    throw new Error(`Groq transcribe transport error: ${explainFetchError(e)}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Groq transcribe ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = /** @type {{ text?: string }} */ (await res.json());
  return { text: typeof json.text === "string" ? json.text : "" };
}
