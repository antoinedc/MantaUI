// groq.mjs — thin client for api.groq.com used by both transports.
//
// Runs in main (Electron Node) and the mobile server (Node). Stays out of
// the renderer so the Groq API key never leaves the trusted process. Uses
// only Node 22 built-ins (global fetch, FormData, Blob) — no SDK dep.
//
// Two operations:
//   - transcribeAudio: POST /openai/v1/audio/transcriptions (multipart, file+model)
//   - classifyCommand: rules-first (voiceClassifier.mjs), then optionally
//     POST /openai/v1/chat/completions with JSON response_format
//
// Error contract: both functions throw Error with a single-line message
// suitable for renderer toast display. Transport errors get the bare-fetch-
// failed unwrap treatment that opencode.ts uses elsewhere (cause.code).

import {
  classifyByRules,
  buildClassifierPrompt,
  coerceLlmAction,
} from "./voiceClassifier.mjs";

const GROQ_BASE = "https://api.groq.com/openai/v1";

const DEFAULT_TRANSCRIPTION_MODEL = "whisper-large-v3-turbo";
const DEFAULT_COMMAND_MODEL = "llama-3.1-8b-instant";

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
function filenameFor(mime) {
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

/**
 * Classify a transcript into a VoiceAction. Tries the rules classifier
 * first (zero cost), falls back to a Groq llama call when no rule matches
 * AND `useLlmFallback !== false` AND an API key is configured. When the
 * LLM is unreachable or unset, returns `{kind:"unknown",transcript}` so
 * the renderer can surface the raw text.
 *
 * @param {object} args
 * @param {string}  args.transcript
 * @param {string}  [args.apiKey]
 * @param {string}  [args.model]
 * @param {boolean} [args.useLlmFallback=true]
 * @returns {Promise<{ action: import("./types.js").VoiceAction; source: "rules" | "llm" | "none" }>}
 */
export async function classifyVoiceCommand({
  transcript,
  apiKey,
  model,
  useLlmFallback = true,
}) {
  const ruled = classifyByRules(transcript);
  if (ruled) return { action: ruled, source: "rules" };

  if (!useLlmFallback || !apiKey) {
    return {
      action: { kind: "unknown", transcript: String(transcript ?? "") },
      source: "none",
    };
  }

  const { system, user } = buildClassifierPrompt(String(transcript ?? ""));
  const url = `${GROQ_BASE}/chat/completions`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: model || DEFAULT_COMMAND_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        // JSON-mode keeps the reply parseable without prompt gymnastics.
        response_format: { type: "json_object" },
        // Tight cap — the schema is small. Anything longer than ~80 tokens
        // is the model going off-script; truncating saves cost.
        max_tokens: 120,
        temperature: 0,
      }),
    });
  } catch (e) {
    // Network failure → fall back to unknown. The user already paid the
    // mic-press cost; degrading to a textarea-insert is friendlier than a
    // hard error toast.
    return {
      action: {
        kind: "unknown",
        transcript: `${transcript} (classifier offline: ${explainFetchError(e)})`,
      },
      source: "none",
    };
  }
  if (!res.ok) {
    return {
      action: { kind: "unknown", transcript: String(transcript ?? "") },
      source: "none",
    };
  }
  let json;
  try {
    json = await res.json();
  } catch {
    return {
      action: { kind: "unknown", transcript: String(transcript ?? "") },
      source: "none",
    };
  }
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    return {
      action: { kind: "unknown", transcript: String(transcript ?? "") },
      source: "none",
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return {
      action: { kind: "unknown", transcript: String(transcript ?? "") },
      source: "none",
    };
  }
  const coerced = coerceLlmAction(parsed);
  if (!coerced) {
    return {
      action: { kind: "unknown", transcript: String(transcript ?? "") },
      source: "none",
    };
  }
  return { action: coerced, source: "llm" };
}
