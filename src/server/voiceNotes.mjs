// voiceNotes.mjs — voice-note store, upload/playback/retry + TTL sweep.
//
// Voice notes are recorded toggled-mode dictation clips (`VOICE_MIN_DURATION_MS`
// and friends live in src/shared/waveform.mjs). Each note is a record in
// ~/.manta/voice-notes.json plus a raw audio file under ~/.manta-voice/.
// This is the SERVER half of the BET-830 voice epic — built to serve both the
// desktop and the mobile client verbatim, so it carries the whole feature's
// durable state.
//
// Durability semantics:
//   - The transcript + waveform (peaks) outlive the audio. After the TTL
//     expires the sweep deletes ONLY the audio file and flips `audioAvailable`
//     to false, so a client can still render the waveform with a disabled play
//     affordance — it never has to guess by probing.
//   - A failed transcription NEVER drops the clip: the audio + record are kept
//     with `transcript: ""` and the client retries against the existing id.
//   - The audio root (~/.manta-voice/) is deliberately NOT ~/.manta-uploads/:
//     the upload tree is swept hourly (uploadCleanupHours) and would delete
//     voice audio an hour after recording.
//
// Modelled closely on servePage.mjs + outbox.mjs: pure logic with injected I/O,
// atomic JSON writes, and a sweep with an `inFlight` guard + `timer.unref()`.

import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { statePath, voiceRoot } from "../shared/paths.mjs";
import { readJsonSync, writeJsonAtomic } from "./jsonStore.mjs";
import { transcribeAudio, filenameFor } from "../shared/groq.mjs";

const STORE_PATH = statePath("voice-notes.json");

// Sweep cadence — 5 min, same as servePage/outbox/schedule.
const CLEANUP_MS = 5 * 60 * 1000;

// Default voice-note audio tenure (7 days). Overridable via config
// `voiceNoteTtlHours`; `0` means "never expires".
export const DEFAULT_TTL_HOURS = 168;

// opencode session id — the same safe token shape the upload route accepts.
const SESSION_RE = /^[A-Za-z0-9._-]+$/;

// ---------------------------------------------------------------------------
// Store — durable registry in ~/.manta/voice-notes.json
// ---------------------------------------------------------------------------

export function loadNotes(path = STORE_PATH) {
  const parsed = readJsonSync(path, {});
  return Array.isArray(parsed.notes) ? parsed.notes : [];
}

export function saveNotes(notes, path = STORE_PATH) {
  return writeJsonAtomic(path, JSON.stringify({ notes }, null, 2));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// 32 lowercase hex chars (128-bit) — the voice-note id. Same strength as the
// box token, and the value the GET route validates against /^[a-f0-9]{32}$/
// before touching the filesystem (the path-traversal guard, same role
// isValidSubdomain plays in servePage.mjs).
export function genId() {
  return randomBytes(16).toString("hex");
}

// Strict id validation. The route MUST call this before any filesystem access
// — otherwise a crafted /api/voice/../../etc/passwd could escape the voice
// root. Every persisted id is 32 lowercase hex, so this is also the registry
// key shape.
export function isValidVoiceId(id) {
  return typeof id === "string" && /^[a-f0-9]{32}$/.test(id);
}

// Derive `expiresAt` (epoch ms) from `voiceNoteTtlHours`, following the
// `resolveExpiry` shape in outbox.mjs. `0` → null (never); any other number →
// now + ttl*3600*1000; anything absent/invalid → DEFAULT_TTL_HOURS.
export function resolveExpiry(ttlHours, now = Date.now()) {
  if (ttlHours === 0) return null;
  const ttl =
    typeof ttlHours === "number" && Number.isFinite(ttlHours) && ttlHours > 0
      ? ttlHours * 3600 * 1000
      : DEFAULT_TTL_HOURS * 3600 * 1000;
  return now + ttl;
}

// File-system extension from mime, reusing groq.mjs's filenameFor (which knows
// the recorder's full mime set). The on-disk file is `<id>.<ext>`.
export function extFor(mime) {
  const file = filenameFor(mime); // e.g. "audio.webm"
  const i = file.lastIndexOf(".");
  return i >= 0 && i < file.length - 1 ? file.slice(i + 1) : "webm";
}

// Absolute path of a note's audio file, resolved from the SAME inputs the
// upload wrote with (id + mime) — so playback and sweep always agree with the
// writer about where the bytes live.
export function resolveAudioPath(id, mime) {
  return join(voiceRoot(), `${id}.${extFor(mime)}`);
}

async function defaultWriteAudio(filePath, bytes) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, bytes);
}

async function defaultReadAudio(filePath) {
  return readFile(filePath);
}

// ---------------------------------------------------------------------------
// Upload — write bytes, transcribe, store. ONE round trip on purpose: the
// client must not upload and transcribe separately.
// ---------------------------------------------------------------------------
//
// I/O is injectable ({load, save, writeAudio, transcribe, now, genId}) so tests
// exercise the full flow with no live HTTP, no real Groq, no real FS.
//
// Success → { ok:true, status:200, record }
// Missing/invalid session, no groq key, or no bytes → { ok:false, status:400, error }
// Transcription failed → { ok:false, status:409, error, record } — audio + record
//   are KEPT with transcript "", so the client retries against the existing id.
//   A clip is never deleted because a network call failed.
export async function uploadVoiceNote(
  {
    sessionId,
    mime = "audio/webm",
    durationMs = 0,
    peaks = "",
    bytes,
    ttlHours,
    apiKey,
    model,
  },
  {
    load = loadNotes,
    save = saveNotes,
    writeAudio = defaultWriteAudio,
    transcribe,
    now = Date.now,
    genId: gen = genId,
  } = {},
) {
  if (!sessionId || typeof sessionId !== "string" || !SESSION_RE.test(sessionId)) {
    return { ok: false, status: 400, error: "missing or invalid session" };
  }
  if (!apiKey || typeof apiKey !== "string") {
    return {
      ok: false,
      status: 400,
      error: "Groq API key not configured. Add it in Settings.",
    };
  }
  if (!bytes || (ArrayBuffer.isView(bytes) ? bytes.byteLength : bytes.length) === 0) {
    return { ok: false, status: 400, error: "no audio bytes" };
  }

  const id = gen();
  const filePath = resolveAudioPath(id, mime);
  await writeAudio(filePath, bytes);

  const createdAt = now();
  const expiresAt = resolveExpiry(ttlHours, createdAt);
  const base = { id, sessionId, mime, durationMs, peaks, createdAt, expiresAt };

  const run = async () => {
    const fn =
      transcribe ??
      (({ buffer, mime: m }) => transcribeAudio({ buffer, mime: m, apiKey, model }));
    return fn({ buffer: bytes, mime });
  };

  let text;
  try {
    const result = await run();
    text = result?.text ?? "";
  } catch (e) {
    // Keep audio + record; the client retries against this id.
    const record = { ...base, transcript: "", audioAvailable: true };
    await save([...load(), record]);
    return { ok: false, status: 409, error: String(e?.message ?? e), record };
  }

  const record = { ...base, transcript: text, audioAvailable: true };
  await save([...load(), record]);
  return { ok: true, status: 200, record };
}

// Re-run transcription for a record whose transcript is empty. Returns the
// same shape as uploadVoiceNote (404 unknown/expired/missing-audio, 409 if it
// fails again, 200 on success). The audio must still be on disk — if the TTL
// swept it, the client gets a 404 and should regenerate the note.
export async function retryTranscript(
  id,
  {
    load = loadNotes,
    save = saveNotes,
    readAudio = defaultReadAudio,
    transcribe,
    now = Date.now,
    apiKey,
    model,
  } = {},
) {
  if (!isValidVoiceId(id)) return { ok: false, status: 404, error: "not found" };
  if (!apiKey || typeof apiKey !== "string") {
    return { ok: false, status: 400, error: "Groq API key not configured. Add it in Settings." };
  }
  const notes = load();
  const idx = notes.findIndex((n) => n.id === id);
  if (idx < 0) return { ok: false, status: 404, error: "not found" };
  const note = notes[idx];
  if (note.expiresAt && now() > note.expiresAt) {
    return { ok: false, status: 404, error: "expired" };
  }
  let bytes;
  try {
    bytes = await readAudio(resolveAudioPath(id, note.mime));
  } catch {
    return { ok: false, status: 404, error: "audio missing" };
  }
  const fn =
    transcribe ??
    (({ buffer, mime: m }) => transcribeAudio({ buffer, mime: m, apiKey, model }));
  try {
    const result = await fn({ buffer: bytes, mime: note.mime });
    note.transcript = result?.text ?? "";
    notes[idx] = note;
    await save(notes);
    return { ok: true, status: 200, transcript: note.transcript };
  } catch (e) {
    return { ok: false, status: 409, error: String(e?.message ?? e) };
  }
}

// Resolve a note's audio for playback. Returns
//   { ok:false, status:404 }  when the id is invalid, unknown, or the record
//                              has expired
//   { ok:true,  note, bytes }  with the raw audio bytes otherwise
// When the on-disk file has vanished EXTERNALLY (not through the sweep), the
// matching record is pruned — the pattern servePage.mjs's readPage copies.
export async function resolvePlayback(
  id,
  { load = loadNotes, save = saveNotes, readAudio = defaultReadAudio, now = Date.now } = {},
) {
  if (!isValidVoiceId(id)) return { ok: false, status: 404 };
  const notes = load();
  const idx = notes.findIndex((n) => n.id === id);
  if (idx < 0) return { ok: false, status: 404 };
  const note = notes[idx];
  if (note.expiresAt && now() > note.expiresAt) {
    return { ok: false, status: 404 };
  }
  let bytes;
  try {
    bytes = await readAudio(resolveAudioPath(id, note.mime));
  } catch {
    // File gone externally → prune the record, best-effort.
    notes.splice(idx, 1);
    await save(notes).catch(() => {});
    return { ok: false, status: 404 };
  }
  return { ok: true, note, bytes };
}

// ---------------------------------------------------------------------------
// Sweep — delete expired audio files but KEEP the records (transcript +
// peaks outlive the clip). Also flips audioAvailable so the client can render
// a disabled play affordance without probing.
// ---------------------------------------------------------------------------

export function createVoiceSweep({
  load = loadNotes,
  save = saveNotes,
  now = () => new Date(),
  rmAudio = (filePath) => rm(filePath, { force: true }),
} = {}) {
  let inFlight = false;

  async function sweep() {
    if (inFlight) return;
    inFlight = true;
    try {
      const notes = load();
      const nowMs = now().getTime();
      const expired = notes.filter((n) => n.expiresAt && nowMs > n.expiresAt);
      if (expired.length === 0) return;

      let changed = false;
      for (const note of expired) {
        try {
          await rmAudio(resolveAudioPath(note.id, note.mime));
        } catch {
          // best-effort per-note cleanup
        }
        // The transcript + peaks survive; only the audio goes away.
        note.audioAvailable = false;
        changed = true;
      }
      if (changed) await save(notes);
    } finally {
      inFlight = false;
    }
  }

  return { sweep };
}

export function startVoiceSweep({ intervalMs = CLEANUP_MS } = {}) {
  const { sweep } = createVoiceSweep();
  // Run once immediately to clean up any leftover expired notes.
  sweep();
  const timer = setInterval(sweep, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer), sweep };
}
