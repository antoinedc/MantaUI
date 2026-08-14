// Tests for src/server/voiceNotes.mjs — the voice-note store, upload /
// playback / retry orchestration and the TTL sweep. Pure + injected I/O only:
// no live HTTP, no real Groq, no real filesystem outside a temp dir.
//
// Run via `npm run test:server` (node:test).

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import {
  genId,
  isValidVoiceId,
  resolveExpiry,
  extFor,
  resolveAudioPath,
  uploadVoiceNote,
  retryTranscript,
  resolvePlayback,
  createVoiceSweep,
  loadNotes,
  saveNotes,
  DEFAULT_TTL_HOURS,
} from "./voiceNotes.mjs";

const ID = "a".repeat(32);

// ---------------------------------------------------------------------------
// id validation — the path-traversal guard
// ---------------------------------------------------------------------------

test("isValidVoiceId rejects traversal / malformed ids", () => {
  assert.equal(isValidVoiceId("../../etc/passwd"), false); // traversal
  assert.equal(isValidVoiceId("..%2f..%2fetc"), false);
  assert.equal(isValidVoiceId("a".repeat(31)), false); // too short
  assert.equal(isValidVoiceId("a".repeat(33)), false); // too long
  assert.equal(isValidVoiceId("A".repeat(32)), false); // uppercase
  assert.equal(isValidVoiceId("g".repeat(32)), false); // not hex (g)
  assert.equal(isValidVoiceId(""), false);
  assert.equal(isValidVoiceId(null), false);
  assert.equal(isValidVoiceId(123), false);
  assert.equal(isValidVoiceId("a".repeat(32)), true); // 32 lowercase hex
  assert.equal(isValidVoiceId("0123456789abcdef".repeat(2)), true);
});

test("genId returns a valid 32-char lowercase hex id", () => {
  const id = genId();
  assert.equal(id.length, 32);
  assert.equal(isValidVoiceId(id), true);
});

// ---------------------------------------------------------------------------
// expiry maths
// ---------------------------------------------------------------------------

test("resolveExpiry maths: default, explicit, 0 = never", () => {
  const NOW = 1_000_000;
  // Explicit ttl.
  assert.equal(resolveExpiry(24, NOW), NOW + 24 * 3600 * 1000);
  assert.equal(resolveExpiry(1, NOW), NOW + 3600 * 1000);
  // 0 = never.
  assert.equal(resolveExpiry(0, NOW), null);
  // Absent → default (168h).
  assert.equal(resolveExpiry(undefined, NOW), NOW + DEFAULT_TTL_HOURS * 3600 * 1000);
  assert.equal(resolveExpiry(null, NOW), NOW + DEFAULT_TTL_HOURS * 3600 * 1000);
  // Invalid (negative / non-number / NaN/Infinity) → default (outbox.mjs shape).
  assert.equal(resolveExpiry(-1, NOW), NOW + DEFAULT_TTL_HOURS * 3600 * 1000);
  assert.equal(resolveExpiry("nope", NOW), NOW + DEFAULT_TTL_HOURS * 3600 * 1000);
  assert.equal(resolveExpiry(NaN, NOW), NOW + DEFAULT_TTL_HOURS * 3600 * 1000);
  assert.equal(resolveExpiry(Infinity, NOW), NOW + DEFAULT_TTL_HOURS * 3600 * 1000);
});

// ---------------------------------------------------------------------------
// file extension / path resolution
// ---------------------------------------------------------------------------

test("extFor derives the recorder extension from mime", () => {
  assert.equal(extFor("audio/webm;codecs=opus"), "webm");
  assert.equal(extFor("audio/webm"), "webm");
  assert.equal(extFor("audio/mp4"), "m4a");
  assert.equal(extFor("audio/m4a"), "m4a");
  assert.equal(extFor("audio/ogg"), "ogg");
  assert.equal(extFor(""), "webm"); // fallback
});

test("resolveAudioPath places the file as <id>.<ext> under the voice root", () => {
  const p = resolveAudioPath(ID, "audio/webm");
  assert.ok(p.endsWith(`/${ID}.webm`), `unexpected path: ${p}`);
  const mp4 = resolveAudioPath(ID, "audio/mp4");
  assert.ok(mp4.endsWith(`/${ID}.m4a`), `unexpected path: ${mp4}`);
});

// ---------------------------------------------------------------------------
// base64 peaks round trip
// ---------------------------------------------------------------------------

test("base64 peaks survive a save/load round trip", async () => {
  const dir = await mkdtemp(join(tmpdir(), "voicenotes-"));
  try {
    const store = join(dir, "voice-notes.json");
    const peaks = Buffer.from([0, 1, 2, 128, 255]).toString("base64");
    const notes = [
      {
        id: genId(),
        sessionId: "s1",
        transcript: "hello",
        mime: "audio/webm",
        durationMs: 1200,
        peaks,
        createdAt: 1,
        expiresAt: null,
        audioAvailable: true,
      },
    ];
    await saveNotes(notes, store);
    const loaded = loadNotes(store);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].peaks, peaks);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// upload validation (400s happen before any write)
// ---------------------------------------------------------------------------

test("uploadVoiceNote 400s on invalid session, no api key, or no bytes", async () => {
  assert.equal(
    (await uploadVoiceNote({ sessionId: "", bytes: Buffer.from("x"), apiKey: "k" })).status,
    400,
  );
  assert.equal(
    (await uploadVoiceNote({ sessionId: "../escape", bytes: Buffer.from("x"), apiKey: "k" })).status,
    400,
  );
  assert.equal(
    (await uploadVoiceNote({ sessionId: "s", bytes: Buffer.from("x"), apiKey: "" })).status,
    400,
  );
  assert.equal(
    (await uploadVoiceNote({ sessionId: "s", bytes: Buffer.from("x"), apiKey: undefined })).status,
    400,
  );
  assert.equal(
    (await uploadVoiceNote({ sessionId: "s", bytes: Buffer.alloc(0), apiKey: "k" })).status,
    400,
  );
});

// ---------------------------------------------------------------------------
// failed transcription → retryable record (audio + record kept)
// ---------------------------------------------------------------------------

test("failed transcription keeps audio + record with empty transcript (retryable)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "voicenotes-"));
  try {
    const store = join(dir, "voice-notes.json");
    const audioDir = join(dir, "audio");
    const written = [];
    const { ok, status, record } = await uploadVoiceNote(
      {
        sessionId: "ses_abc123",
        mime: "audio/webm",
        durationMs: 2000,
        peaks: "QUJD",
        bytes: Buffer.from("RIFF....audio"),
        ttlHours: 24,
        apiKey: "gsk_x",
        model: "whisper-large-v3-turbo",
      },
      {
        load: () => loadNotes(store),
        save: (n) => saveNotes(n, store),
        writeAudio: async (fp, b) => {
          written.push(fp);
          await mkdir(audioDir, { recursive: true });
          await writeFile(join(audioDir, basename(fp)), b);
        },
        transcribe: async () => {
          throw new Error("groq down");
        },
        now: () => 1000,
        genId: () => ID,
      },
    );
    assert.equal(ok, false);
    assert.equal(status, 409);
    assert.equal(record.id, ID);
    assert.equal(record.transcript, "");
    assert.equal(record.audioAvailable, true);
    // The audio file was still written (a clip is never deleted on failure).
    assert.equal(written.length, 1);
    assert.ok((await readFile(join(audioDir, `${ID}.webm`))).length > 0);
    // One retryable record persisted.
    const saved = loadNotes(store);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].id, ID);
    assert.equal(saved[0].transcript, "");
    assert.equal(saved[0].expiresAt, 1000 + 24 * 3600 * 1000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// successful upload + retry
// ---------------------------------------------------------------------------

test("successful upload stores the transcript; retry re-runs transcription", async () => {
  const dir = await mkdtemp(join(tmpdir(), "voicenotes-"));
  try {
    const store = join(dir, "voice-notes.json");
    const audioDir = join(dir, "audio");
    let transcriptResult = "hello world";
    const res = await uploadVoiceNote(
      {
        sessionId: "ses_x",
        mime: "audio/webm",
        durationMs: 900,
        peaks: "eA==",
        bytes: Buffer.from("ABC"),
        ttlHours: 0,
        apiKey: "k",
        model: "m",
      },
      {
        load: () => loadNotes(store),
        save: (n) => saveNotes(n, store),
        writeAudio: async (fp, b) => {
          await mkdir(audioDir, { recursive: true });
          await writeFile(join(audioDir, basename(fp)), b);
        },
        transcribe: async () => ({ text: transcriptResult }),
        now: () => 5000,
        genId: () => "b".repeat(32),
      },
    );
    assert.equal(res.ok, true);
    assert.equal(res.status, 200);
    assert.equal(res.record.id, "b".repeat(32));
    assert.equal(res.record.transcript, "hello world");
    assert.equal(res.record.expiresAt, null); // ttlHours 0 → never
    assert.equal(res.record.audioAvailable, true);

    // Retry against the same id re-transcribes in place.
    transcriptResult = "retried text";
    const retry = await retryTranscript("b".repeat(32), {
      load: () => loadNotes(store),
      save: (n) => saveNotes(n, store),
      readAudio: async (fp) => readFile(join(audioDir, basename(fp))),
      transcribe: async () => ({ text: "retried text" }),
      apiKey: "k",
      model: "m",
      now: () => 5000,
    });
    assert.equal(retry.ok, true);
    assert.equal(retry.status, 200);
    assert.equal(retry.transcript, "retried text");
    const saved = loadNotes(store);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].transcript, "retried text");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("retryTranscript 404s on unknown id and on expired record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "voicenotes-"));
  try {
    const store = join(dir, "voice-notes.json");
    await saveNotes(
      [{ id: ID, sessionId: "s", transcript: "", mime: "audio/webm", durationMs: 1, peaks: "", createdAt: 1, expiresAt: 10, audioAvailable: true }],
      store,
    );
    // Unknown id.
    const unknown = await retryTranscript("c".repeat(32), {
      load: () => loadNotes(store),
      save: (n) => saveNotes(n, store),
      readAudio: async () => Buffer.from("x"),
      transcribe: async () => ({ text: "t" }),
      apiKey: "k",
      model: "m",
      now: () => 5000,
    });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.status, 404);
    // Expired id (expiresAt 10 < now 5000).
    const expired = await retryTranscript(ID, {
      load: () => loadNotes(store),
      save: (n) => saveNotes(n, store),
      readAudio: async () => Buffer.from("x"),
      transcribe: async () => ({ text: "t" }),
      apiKey: "k",
      model: "m",
      now: () => 5000,
    });
    assert.equal(expired.ok, false);
    assert.equal(expired.status, 404);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("retryTranscript 409s when transcription fails again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "voicenotes-"));
  try {
    const store = join(dir, "voice-notes.json");
    await saveNotes(
      [{ id: ID, sessionId: "s", transcript: "", mime: "audio/webm", durationMs: 1, peaks: "", createdAt: 1, expiresAt: null, audioAvailable: true }],
      store,
    );
    const r = await retryTranscript(ID, {
      load: () => loadNotes(store),
      save: (n) => saveNotes(n, store),
      readAudio: async () => Buffer.from("x"),
      transcribe: async () => {
        throw new Error("still down");
      },
      apiKey: "k",
      model: "m",
      now: () => 5000,
    });
    assert.equal(r.ok, false);
    assert.equal(r.status, 409);
    // Record unchanged.
    assert.equal(loadNotes(store)[0].transcript, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// playback + prune-on-missing-file
// ---------------------------------------------------------------------------

test("resolvePlayback returns bytes for a valid unexpired note", async () => {
  const dir = await mkdtemp(join(tmpdir(), "voicenotes-"));
  try {
    const store = join(dir, "voice-notes.json");
    await saveNotes(
      [{ id: ID, sessionId: "s", transcript: "t", mime: "audio/webm", durationMs: 1, peaks: "", createdAt: 1, expiresAt: null, audioAvailable: true }],
      store,
    );
    const r = await resolvePlayback(ID, {
      load: () => loadNotes(store),
      save: (n) => saveNotes(n, store),
      readAudio: async (fp) => Buffer.from("BYTES"),
      now: () => 5000,
    });
    assert.equal(r.ok, true);
    assert.equal(r.note.id, ID);
    assert.equal(String(r.bytes), "BYTES");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolvePlayback prunes a record whose file vanished externally", async () => {
  const dir = await mkdtemp(join(tmpdir(), "voicenotes-"));
  try {
    const store = join(dir, "voice-notes.json");
    await saveNotes(
      [{ id: ID, sessionId: "s", transcript: "t", mime: "audio/webm", durationMs: 1, peaks: "", createdAt: 1, expiresAt: null, audioAvailable: true }],
      store,
    );
    const before = loadNotes(store);
    assert.equal(before.length, 1);
    const r = await resolvePlayback(ID, {
      load: () => loadNotes(store),
      save: (n) => saveNotes(n, store),
      readAudio: async () => {
        throw new Error("ENOENT");
      },
      now: () => 5000,
    });
    assert.equal(r.ok, false);
    assert.equal(r.status, 404);
    // The missing-file record is pruned.
    assert.equal(loadNotes(store).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolvePlayback 404s on an expired record (file may still exist)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "voicenotes-"));
  try {
    const store = join(dir, "voice-notes.json");
    await saveNotes(
      [{ id: ID, sessionId: "s", transcript: "t", mime: "audio/webm", durationMs: 1, peaks: "", createdAt: 1, expiresAt: 10, audioAvailable: true }],
      store,
    );
    const r = await resolvePlayback(ID, {
      load: () => loadNotes(store),
      save: (n) => saveNotes(n, store),
      readAudio: async () => Buffer.from("x"),
      now: () => 5000, // > expiresAt 10
    });
    assert.equal(r.ok, false);
    assert.equal(r.status, 404);
    // Record kept (sweep handles audio separately).
    assert.equal(loadNotes(store).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// sweep — delete audio, keep records, flip audioAvailable
// ---------------------------------------------------------------------------

test("sweep deletes expired audio but KEEPS every record (audioAvailable false)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "voicenotes-"));
  try {
    const store = join(dir, "voice-notes.json");
    const kept = { id: "d".repeat(32), sessionId: "s", transcript: "kept", mime: "audio/webm", durationMs: 1, peaks: "", createdAt: 1, expiresAt: 10_000, audioAvailable: true };
    const expired = { id: "e".repeat(32), sessionId: "s", transcript: "gone", mime: "audio/mp4", durationMs: 1, peaks: "", createdAt: 1, expiresAt: 100, audioAvailable: true };
    const never = { id: "f".repeat(32), sessionId: "s", transcript: "never", mime: "audio/webm", durationMs: 1, peaks: "", createdAt: 1, expiresAt: null, audioAvailable: true };
    await saveNotes([kept, expired, never], store);

    const removedFiles = [];
    const { sweep } = createVoiceSweep({
      load: () => loadNotes(store),
      save: (n) => saveNotes(n, store),
      now: () => new Date(5000), // expired(100) < 5000 < kept(10000)
      rmAudio: async (fp) => {
        removedFiles.push(fp);
      },
    });
    await sweep();

    const saved = loadNotes(store);
    // All three records survive — audio expiry never drops the record.
    assert.equal(saved.length, 3);
    const expiredSaved = saved.find((n) => n.id === "e".repeat(32));
    assert.equal(expiredSaved.audioAvailable, false);
    const keptSaved = saved.find((n) => n.id === "d".repeat(32));
    assert.equal(keptSaved.audioAvailable, true);
    const neverSaved = saved.find((n) => n.id === "f".repeat(32));
    assert.equal(neverSaved.audioAvailable, true);
    // Only the expired file was removed, and it referenced the mp4 ext.
    assert.equal(removedFiles.length, 1);
    assert.ok(removedFiles[0].includes("e".repeat(32)) && removedFiles[0].endsWith(".m4a"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sweep is a no-op (no save) when nothing is expired", async () => {
  const NOW = 1_000_000;
  const notes = [
    { id: "d".repeat(32), expiresAt: NOW + 10_000 },
    { id: "f".repeat(32), expiresAt: null },
  ];
  let saveCalled = false;
  const { sweep } = createVoiceSweep({
    load: () => notes,
    save: async () => {
      saveCalled = true;
    },
    now: () => new Date(NOW),
  });
  await sweep();
  assert.equal(saveCalled, false);
});
