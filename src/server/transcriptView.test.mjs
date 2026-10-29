import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTurns, truncationOf, annotateView, annotateSingle, isBackgroundResultMessage } from "./transcriptView.mjs";
import { describeTruncation } from "../shared/streamInterpretation.mjs";

// ---- fixtures (ported from chatUtils.test.ts `computeTurnInfo` + the iOS TranscriptParityTests) ----
const user = (id) => ({ info: { role: "user", id }, parts: [] });
const asst = (id, o = {}) => ({
  info: {
    role: "assistant",
    id,
    ...(o.created != null || o.completed != null ? { time: { created: o.created, completed: o.completed } } : {}),
    ...(o.output != null || o.reasoning != null ? { tokens: { input: 0, output: o.output ?? 0, reasoning: o.reasoning ?? 0, cache: { read: 0, write: 0 } } } : {}),
    ...(o.finish ? { finish: o.finish } : {}),
  },
  parts: o.parts ?? [],
});
const bg = (id, o = {}) => asst(id, { ...o, parts: [{ type: "background-result", id: `${id}-p` }] });

test("running + transcript ends in an assistant message → no entry; idle → entry", () => {
  const m = [user("u1"), asst("a1", { created: 1000, completed: 5000, output: 42 })];
  assert.equal(computeTurns(m, { running: true }).size, 0);
  assert.deepEqual(computeTurns(m, { running: false }).get("a1"), { durationMs: 4000, tokens: 42, verbSeedId: "a1" });
});

test("running with the transcript ending in a USER message → the finished turn keeps its footer", () => {
  const m = [user("u1"), asst("a1", { created: 1000, completed: 5000, output: 9 }), user("u2")];
  assert.deepEqual(computeTurns(m, { running: true }).get("a1"), { durationMs: 4000, tokens: 9, verbSeedId: "a1" });
});

test("a multi-step turn: only the final assistant message gets the entry; tokens sum output+reasoning; seed is the FIRST", () => {
  const m = [
    user("u1"),
    asst("a1", { created: 1000, completed: 2000, output: 10, reasoning: 1 }),
    asst("a2", { created: 2000, completed: 3000, output: 20, reasoning: 2 }),
    asst("a3", { created: 3000, completed: 7000, output: 30, reasoning: 3 }),
  ];
  const t = computeTurns(m, { running: false });
  assert.equal(t.has("a1"), false);
  assert.equal(t.has("a2"), false);
  assert.deepEqual(t.get("a3"), { durationMs: 6000, tokens: 66, verbSeedId: "a1" });
  assert.equal(computeTurns(m, { running: true }).size, 0, "the still-streaming final assistant gets no footer");
});

test("zero tokens → null; a zero-length or missing duration → null", () => {
  const m = [user("u1"), asst("a1", { created: 1000, completed: 1000, output: 0, reasoning: 0 })];
  assert.deepEqual(computeTurns(m).get("a1"), { durationMs: null, tokens: null, verbSeedId: "a1" });
  const noTimes = [user("u1"), { info: { role: "assistant", id: "a1", time: { completed: 5 } }, parts: [] }];
  assert.deepEqual(computeTurns(noTimes).get("a1"), { durationMs: null, tokens: null, verbSeedId: "a1" });
});

test("the last assistant message must have time.completed (the iOS rule): an uncompleted one gets no footer", () => {
  const m = [user("u1"), asst("a1", { created: 1000, completed: 2000, output: 5 }), asst("a2", { created: 2000, output: 5 })];
  assert.equal(computeTurns(m, { running: false }).size, 0);
});

test("a null / empty transcript is an empty map", () => {
  assert.equal(computeTurns(null).size, 0);
  assert.equal(computeTurns([]).size, 0);
});

test("a background result starts a turn like a user message and is not part of the turn before it", () => {
  const m = [
    user("u1"),
    asst("a1", { created: 1000, completed: 2000, output: 5 }),
    bg("b1", { created: 50_000, completed: 51_000, output: 1 }),
    asst("a2", { created: 51_000, completed: 54_000, output: 7 }),
  ];
  assert.equal(isBackgroundResultMessage(m[2]), true);
  const t = computeTurns(m);
  // The earlier turn ends at a1 (its duration does not span the idle gap); the background result heads the next.
  assert.deepEqual(t.get("a1"), { durationMs: 1000, tokens: 5, verbSeedId: "a1" });
  assert.deepEqual(t.get("a2"), { durationMs: 3000, tokens: 7, verbSeedId: "a2" });
  assert.equal(t.has("b1"), false);
});

test("two turns: each user message starts its own", () => {
  const m = [user("u1"), asst("a1", { created: 0, completed: 1000, output: 1 }), user("u2"), asst("a2", { created: 2000, completed: 5000, output: 2 })];
  const t = computeTurns(m);
  assert.deepEqual([...t.keys()], ["a1", "a2"]);
});

// ---- truncation ----
const step = (reason) => ({ type: "step-finish", id: "sf", reason });

test("truncation per finish: output cap, context wall, tool cutoff, benign → none", () => {
  assert.equal(truncationOf(asst("a", { finish: "max_tokens" })).kind, "output-cap");
  assert.equal(truncationOf(asst("a", { finish: "length" })).kind, "output-cap");
  assert.equal(truncationOf(asst("a", { finish: "model_context_window_exceeded" })).kind, "context-wall");
  assert.equal(truncationOf(asst("a", { finish: "end_turn" })), null);
  assert.equal(truncationOf(asst("a", {})), null);
  assert.equal(truncationOf(user("u")), null);
});

test("a step-finish reason takes precedence over info.finish; tool-calls + a max_tokens reason is a tool cut-off", () => {
  assert.equal(truncationOf(asst("a", { finish: "tool-calls", parts: [step("max_tokens")] })).kind, "tool-cutoff");
  assert.equal(truncationOf(asst("a", { finish: "end_turn", parts: [step("max_tokens")] })).kind, "output-cap");
  assert.equal(truncationOf(asst("a", { finish: "max_tokens", parts: [step("end_turn")] })), null);
  // The LAST step-finish with a non-empty reason wins; an empty reason is skipped.
  assert.equal(truncationOf(asst("a", { finish: "end_turn", parts: [step("max_tokens"), step("")] })).kind, "output-cap");
});

test("the truncation carries the label AND hint (describeTruncation): the canonical view equals what the live frame sends", () => {
  const view = truncationOf(asst("a", { finish: "max_tokens" }));
  assert.deepEqual(view, { kind: "output-cap", ...describeTruncation("output-cap") });
});

test("annotateView: `view` only where there is something; getMessage-style single gets a truncation, never a turn", () => {
  const m = [user("u1"), asst("a1", { created: 1000, completed: 5000, output: 4, finish: "max_tokens" })];
  const out = annotateView(m, { running: false });
  assert.equal(out[0].view, undefined);
  assert.equal(out[1].view.turn.durationMs, 4000);
  assert.equal(out[1].view.truncation.kind, "output-cap");
  const single = annotateSingle(m[1]);
  assert.equal(single.view.turn, undefined);
  assert.equal(single.view.truncation.kind, "output-cap");
  assert.equal(annotateSingle(m[0]), m[0]);
  // The input is not mutated.
  assert.equal(m[1].view, undefined);
});

// ---- D9: canonical media (every iOS `canonicalEntries` / `showOutput` case, ported) ----
import { canonicalMediaEntries, parseShowOutput, beginHandle, filePartMedia } from "./transcriptView.mjs";

const toolPart = (id, messageID, tool, { status = "completed", input = {}, output } = {}) => ({ type: "tool", id, messageID, tool, state: { status, input, ...(output != null ? { output } : {}) } });
const begin = (id, mid, handle, input = { kind: "image", aspectRatio: 16 / 9, title: "Cat" }) =>
  toolPart(id, mid, "media_begin", { input, output: `Placeholder reserved. Handle: ${handle}. Keep it and pass it to media_show once the media file exists.` });
const show = (id, mid, handle, path, { dims = " 600x600", mime = "image/png", size = 1234, title } = {}) =>
  toolPart(id, mid, "media_show", { input: { path, ...(handle ? { handle } : {}), ...(title ? { title } : {}) }, output: `Displayed ${path} (${mime}${dims}, ${size} bytes) in the transcript.` });
const am = (id, parts) => ({ info: { role: "assistant", id, time: { created: 1, completed: 2 } }, parts });

test("showOutput: with dimensions, without, the last '(' anchor for paths with spaces and parentheses, junk", () => {
  assert.deepEqual(parseShowOutput("Displayed /home/u/cat.png (image/png 600x400, 1234 bytes) in the transcript."), { path: "/home/u/cat.png", mime: "image/png", width: 600, height: 400, size: 1234 });
  const noDims = parseShowOutput("Displayed /home/u/c.mp4 (video/mp4, 99 bytes) in the transcript.");
  assert.deepEqual([noDims.mime, noDims.width, noDims.height, noDims.size], ["video/mp4", null, null, 99]);
  const tricky = parseShowOutput("Displayed /home/u/my pics (copy) (1).png (image/png 10x20, 5 bytes) in the transcript.");
  assert.deepEqual([tricky.path, tricky.mime, tricky.width, tricky.size], ["/home/u/my pics (copy) (1).png", "image/png", 10, 5]);
  for (const junk of ["nope", "Displayed /x.png in the transcript.", "Displayed  (image/png, 5 bytes) in the transcript."]) assert.equal(parseShowOutput(junk), null, junk);
});

test("beginHandle", () => {
  assert.equal(beginHandle("Placeholder reserved. Handle: 1a2b3c4d. Keep it."), "1a2b3c4d");
  assert.equal(beginHandle("Placeholder reserved."), null);
  assert.equal(beginHandle("Handle: zzz"), null);
});

test("begin in A, show in B (same handle): ONE ready entry owned by A with the begin's geometry, the show's file", () => {
  const e = canonicalMediaEntries([am("A", [begin("pa", "A", "a1b2")]), am("B", [show("pb", "B", "a1b2", "/home/u/cat.png")])]);
  assert.equal(e.length, 1);
  assert.equal(e[0].id, "media:h:a1b2");
  assert.equal(e[0].ownerMessageId, "A");
  assert.equal(e[0].path, "/home/u/cat.png");
  assert.equal(e[0].aspectRatio, 16 / 9);
  assert.equal(e[0].width, null);
  assert.equal(e[0].title, "Cat");
});

test("a show with no handle uses the message + path identity and the show's dimensions", () => {
  const e = canonicalMediaEntries([am("B", [show("pb", "B", null, "/home/u/x.png", { dims: " 30x20" })])]);
  assert.deepEqual(e.map((x) => x.id), ["media:s:B:/home/u/x.png"]);
  assert.deepEqual([e[0].width, e[0].height, e[0].aspectRatio], [30, 20, null]);
});

test("a show whose begin is outside the loaded window is owned by the show's message; a begin never shown draws nothing; an error show yields nothing", () => {
  const e = canonicalMediaEntries([am("B", [show("pb", "B", "late", "/a.png")])]);
  assert.deepEqual([e[0].id, e[0].ownerMessageId], ["media:h:late", "B"]);
  assert.deepEqual(canonicalMediaEntries([am("A", [begin("pa", "A", "a1b2"), toolPart("pe", "A", "media_show", { status: "error", input: { path: "/x.png" }, output: "boom" })])]), []);
});

test("missing mime falls back to the extension; paths with spaces/parentheses survive; entries are deterministic and ordered by first sight", () => {
  const out = "Displayed /a/b.MOV (video/quicktime, 9 bytes) in the transcript.";
  const msgs = [am("A", [begin("pa", "A", "h1")]), am("B", [show("pb", "B", "h1", "/a.png"), show("pc", "B", null, "/b.png")])];
  assert.deepEqual(canonicalMediaEntries(msgs), canonicalMediaEntries(msgs));
  assert.deepEqual(canonicalMediaEntries(msgs).map((x) => x.id), ["media:h:h1", "media:s:B:/b.png"]);
  void out;
});

test("annotateView: media goes on the OWNER message only; a file part that is an image/video gains part.view.media", () => {
  const filePart = { type: "file", id: "f1", messageID: "B", mime: "image/png", url: "file:///home/u/f.png" };
  const dataPart = { type: "file", id: "f2", messageID: "B", mime: "image/png", url: "data:image/png;base64,AAAA" };
  const textFile = { type: "file", id: "f3", messageID: "B", mime: "text/csv", url: "file:///x.csv" };
  const msgs = [
    { info: { role: "user", id: "u" }, parts: [] },
    am("A", [begin("pa", "A", "a1b2")]),
    am("B", [show("pb", "B", "a1b2", "/home/u/cat.png"), filePart, dataPart, textFile]),
  ];
  const out = annotateView(msgs);
  assert.equal(out[2].view?.media, undefined);
  assert.equal(out[1].view.media.length, 1);
  assert.equal(out[1].view.media[0].ownerMessageId, undefined, "the owner is the message it rides on");
  assert.deepEqual(out[2].parts[1].view, { media: { kind: "image", path: "/home/u/f.png" } });
  assert.equal(out[2].parts[2].view, undefined, "an inline data: URL is not a box path");
  assert.equal(out[2].parts[3].view, undefined);
  assert.equal(filePartMedia({ type: "tool" }), null);
});

test("getMessage-style single: the media of that ONE message (a show whose begin is elsewhere is owned by it), never a turn", () => {
  const single = annotateSingle(am("B", [show("pb", "B", "a1b2", "/home/u/cat.png")]));
  assert.equal(single.view.media[0].id, "media:h:a1b2");
  assert.equal(single.view.turn, undefined);
});

// ---- the golden: what the box says about a transcript, shared with the iOS tests (D8–D10 review, NIT 5) ----
// `mobile/native/MantaUITests/Fixtures/transcript-view.golden.json` holds each scenario's raw messages and the
// `annotateView` output for them. THIS test pins the box to the file (regenerate with UPDATE_GOLDEN=1 after a deliberate
// rule change); the Swift tests decode the same file, so a changed rule fails here first and then on the phone's side.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const GOLDEN_PATH = fileURLToPath(new URL("../../mobile/native/MantaUITests/Fixtures/transcript-view.golden.json", import.meta.url));
const goldenStep = (id, reason) => ({ type: "step-finish", id: `${id}:step-finish`, messageID: id, reason });
// The box's messages always carry the session id and each part its message id (the Swift decoder requires them).
const goldenSession = (messages) =>
  messages.map((m) => ({
    ...m,
    info: { ...m.info, sessionID: "ses_golden" },
    parts: m.parts.map((p) => ({ messageID: m.info.id, ...p })),
  }));
const goldenTool = (id, name) => ({ type: "tool", id, tool: name, callID: `c-${id}`, state: { status: "completed", input: { filePath: `/w/${id}.ts` }, output: "ok" } });
const goldenText = (id, text) => ({ type: "text", id, text });
const goldenReasoning = (id, text) => ({ type: "reasoning", id, text });
const goldenUser = (id, text) => ({ info: { role: "user", id }, parts: [{ type: "text", id: `${id}:t`, text }] });
const goldenScenarios = () => [
  {
    name: "one finished turn: duration from first created to last completed, tokens = output + reasoning",
    running: false,
    input: [user("u1"), asst("a1", { created: 1000, completed: 5000, output: 40, reasoning: 2 })],
  },
  {
    name: "a multi-step turn: only the last assistant message carries the turn; the seed is the first",
    running: false,
    input: [
      user("u1"),
      asst("a1", { created: 1000, completed: 2000, output: 10 }),
      asst("a2", { created: 2000, completed: 7000, output: 20 }),
    ],
  },
  {
    name: "a still-running turn has no footer",
    running: true,
    input: [user("u1"), asst("a1", { created: 1000, completed: 2000, output: 10 })],
  },
  {
    name: "running with the transcript ending in a user message keeps the finished turn's footer",
    running: true,
    input: [user("u1"), asst("a1", { created: 1000, completed: 5000, output: 9 }), user("u2")],
  },
  {
    name: "a background result starts a new turn",
    running: false,
    input: [
      user("u1"),
      asst("a1", { created: 1000, completed: 2000, output: 5 }),
      bg("b1", { created: 3000, completed: 3000 }),
      asst("a2", { created: 4000, completed: 6000, output: 7 }),
    ],
  },
  {
    name: "truncation: output cap, context wall and a cut-off tool call; the step-finish reason wins over info.finish",
    running: false,
    input: [
      user("u1"),
      asst("a1", { created: 1, completed: 2, output: 1, finish: "max_tokens" }),
      user("u2"),
      asst("a2", { created: 3, completed: 4, output: 1, finish: "tool-calls", parts: [goldenStep("a2", "max_tokens")] }),
      user("u3"),
      asst("a3", { created: 5, completed: 6, output: 1, finish: "end_turn", parts: [goldenStep("a3", "model_context_window_exceeded")] }),
      user("u4"),
      asst("a4", { created: 7, completed: 8, output: 1, finish: "max_tokens", parts: [goldenStep("a4", "")] }),
    ],
  },
  {
    name: "no tokens and no duration: the turn still exists, both null",
    running: false,
    input: [user("u1"), asst("a1", { created: 1000, completed: 1000, output: 0, reasoning: 0 })],
  },
  {
    name: "runs: one run spans three assistant messages; text splits it; a drawing user message ends it",
    running: false,
    input: [
      user("u1"),
      asst("a1", { created: 1, completed: 2, parts: [goldenTool("t1", "read"), goldenTool("t2", "bash")] }),
      asst("a2", { created: 2, completed: 3, parts: [goldenTool("t3", "read")] }),
      asst("a3", { created: 3, completed: 4, parts: [goldenText("x3", "Found it."), goldenTool("t4", "edit")] }),
      goldenUser("u2", "next"),
      asst("a4", { created: 5, completed: 6, parts: [goldenTool("t5", "read")] }),
    ],
  },
  {
    name: "runs: reasoning starts a segment; whitespace text and todo writes are transparent; a handoff stands alone",
    running: false,
    input: [
      user("u1"),
      asst("a1", { created: 1, completed: 2, parts: [goldenTool("t1", "read"), goldenText("x1", "\n"), goldenTool("t2", "todowrite")] }),
      asst("a2", { created: 2, completed: 3, parts: [goldenReasoning("r1", "thinking it over"), goldenTool("t3", "grep")] }),
      asst("a3", { created: 3, completed: 4, parts: [goldenTool("h1", "handoff"), goldenTool("t4", "read")] }),
    ],
  },
  {
    name: "runs: a background-job completion USER message is transparent, a hidden user message too",
    running: false,
    input: [
      user("u1"),
      asst("a1", { created: 1, completed: 2, parts: [goldenTool("t1", "read")] }),
      goldenUser("u2", '[background job "x" done]\n\nbody'),
      asst("a2", { created: 3, completed: 4, parts: [goldenTool("t2", "read")] }),
    ],
  },
  {
    name: "the last assistant message must have time.completed",
    running: false,
    input: [user("u1"), asst("a1", { created: 1000, completed: 2000, output: 5 }), asst("a2", { created: 2000, output: 5 })],
  },
];

test("transcript-view.golden.json equals what annotateView produces (UPDATE_GOLDEN=1 regenerates it)", () => {
  const built = JSON.parse(JSON.stringify(goldenScenarios().map((s) => {
    const input = goldenSession(s.input);
    return { name: s.name, running: s.running, input, output: annotateView(structuredClone(input), { running: s.running }) };
  })));
  if (process.env.UPDATE_GOLDEN === "1") writeFileSync(GOLDEN_PATH, `${JSON.stringify(built, null, 2)}\n`);
  assert.deepEqual(JSON.parse(readFileSync(GOLDEN_PATH, "utf8")), built);
});
