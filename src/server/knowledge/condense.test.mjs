import { test } from "node:test";
import assert from "node:assert/strict";
import { condenseForCapture } from "./condense.mjs";

const text = (t, id) => ({ id, type: "text", text: t });
const tool = (name, command, o = {}) => ({ id: `t_${name}_${command}`, type: "tool", tool: name, command, output: "", status: "completed", ...o });
const msg = (id, role, at, parts) => ({ id, role, at, parts });

const TURN = [
  msg("u1", "user", 1, [text("please fix the failing build")]),
  msg("a1", "assistant", 2, [
    text("Let me look at the code", "a1p0"),
    tool("read", "/repo/src/server/a.mjs", { output: "x".repeat(500) }),
    tool("read", "/repo/src/server/b.mjs", { output: "y" }),
    tool("grep", "TODO"),
    tool("glob", "**/*.mjs"),
    tool("read", "/repo/src/server/c.mjs"),
  ]),
  msg("a2", "assistant", 3, [
    tool("edit", "/repo/src/server/a.mjs", { output: "diff…" }),
    tool("edit", "/repo/src/server/a.mjs", { output: "diff…" }),
    tool("write", "/repo/src/server/new.mjs"),
    tool("bash", "npm test", { output: "ok\nall passed" }),
    tool("bash", "npm test", { output: "ok" }),
    tool("bash", "git push origin main", { output: "To github.com…" }),
    tool("bash", "npm run build", { output: "boom\nline2\nline3\nERR final", status: "error", exit: 2 }),
    tool("webfetch", "https://a.example"),
    tool("websearch", "how to x"),
    tool("todowrite", "3 todos"),
    text("Fixed: the build passes now.", "a2p9"),
  ]),
  msg("u2", "user", 4, [text("thanks")]),
];

test("condenseForCapture: user messages whole; only the turn's last assistant text stays; ids and srcIndex are kept", () => {
  const out = condenseForCapture(TURN);
  assert.deepEqual(out.map((m) => [m.id, m.srcIndex]), [["u1", 0], ["a1", 1], ["a2", 2], ["u2", 3]]);
  assert.equal(out[0].parts[0].text, "please fix the failing build");
  const texts = out.flatMap((m) => m.parts.filter((p) => p.type === "text").map((p) => p.text));
  assert.deepEqual(texts, ["please fix the failing build", "Fixed: the build passes now.", "thanks"]);
});

test("condenseForCapture: reads/searches collapse into one marker per run; successful read output is dropped", () => {
  const out = condenseForCapture(TURN);
  const notes = out[1].parts.filter((p) => p.type === "note");
  assert.deepEqual(notes.map((n) => n.text), ["read 3 files in /repo/src/server; searched 2 times"]);
  assert.equal(out[1].parts.some((p) => p.type === "tool"), false);
});

test("condenseForCapture: edits become 'edited <path>' once per file; passing checks collapse (×N); failed tools keep first and last output line", () => {
  const out = condenseForCapture(TURN);
  const a2 = out[2].parts;
  assert.deepEqual(
    a2.filter((p) => p.type === "note").map((p) => p.text),
    [
      "edited /repo/src/server/a.mjs",
      "edited /repo/src/server/new.mjs",
      "ran npm test: passed (×2)",
      "ran git push origin main",
      "fetched 2 pages",
    ],
  );
  const failed = a2.find((p) => p.type === "tool");
  assert.equal(failed.command, "npm run build");
  assert.equal(failed.output, "boom … ERR final");
  assert.equal(a2.some((p) => p.tool === "todowrite"), false);
});

test("condenseForCapture: a failed read/test keeps its failure instead of collapsing; messages with nothing left are dropped", () => {
  const out = condenseForCapture([
    msg("u1", "user", 1, [text("go")]),
    msg("a1", "assistant", 2, [tool("read", "/nope", { status: "error", output: "ENOENT: no such file" })]),
    msg("a2", "assistant", 3, [text("early", "p"), tool("todowrite", "x")]),
    msg("a3", "assistant", 4, [text("final answer", "q")]),
  ]);
  assert.deepEqual(out.map((m) => m.id), ["u1", "a1", "a3"]);
  assert.equal(out[1].parts[0].output, "ENOENT: no such file");
});

test("condenseForCapture: separate turns each keep their own last text; an empty user message still bounds a turn", () => {
  const out = condenseForCapture([
    msg("u1", "user", 1, [text("one")]),
    msg("a1", "assistant", 2, [text("answer one", "p1")]),
    msg("u2", "user", 3, []),
    msg("a2", "assistant", 4, [text("answer two", "p2")]),
  ]);
  assert.deepEqual(out.flatMap((m) => m.parts.map((p) => p.text)), ["one", "answer one", "answer two"]);
});

test("condenseForCapture: a command that is not a check, or has an exit code, is not 'passed'", () => {
  const out = condenseForCapture([
    msg("a1", "assistant", 1, [tool("bash", "npm test", { exit: 1, output: "FAIL" }), tool("bash", "echo hello")]),
  ]);
  assert.deepEqual(out[0].parts.map((p) => [p.type, p.command ?? p.text]), [["tool", "npm test"], ["note", "ran echo hello"]]);
});

test("condenseForCapture: deterministic and idempotent (running it on its own output changes nothing), input untouched", () => {
  const before = JSON.stringify(TURN);
  const once = condenseForCapture(TURN);
  assert.equal(JSON.stringify(TURN), before);
  assert.deepEqual(condenseForCapture(TURN), once);
  assert.deepEqual(condenseForCapture(once), once);
  const withEmptyUser = [msg("a0", "assistant", 0, [text("x", "z")]), msg("u0", "user", 1, []), ...TURN];
  const c = condenseForCapture(withEmptyUser);
  assert.deepEqual(condenseForCapture(c), c);
  assert.deepEqual(condenseForCapture([]), []);
  assert.deepEqual(condenseForCapture(null), []);
});

test("condenseForCapture: a long failing output is clipped to its first and last line", () => {
  const out = condenseForCapture([msg("a1", "assistant", 1, [tool("bash", "make", { exit: 2, output: `${"A".repeat(900)}\nmid\n${"Z".repeat(900)}` })])]);
  const o = out[0].parts[0].output;
  assert.ok(o.startsWith("AAA") && o.includes("ZZZ") && !o.includes("mid") && o.length <= 403);
  assert.deepEqual(condenseForCapture(out), out);
});
