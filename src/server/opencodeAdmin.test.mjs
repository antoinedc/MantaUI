// Tests for src/server/opencodeAdmin.mjs
//
// `exec` is injected so these never actually run systemctl.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { restartOpencode, runServerSelfUpdate, parseProgressLine } from "./opencodeAdmin.mjs";
import { statePath } from "../shared/paths.mjs";

// A fake detached child that exits with `code` once the caller has attached
// its listeners. Shared because several cases differ ONLY in the exit code and
// what they assert afterwards — inlining it three times is what the
// duplication gate (rightly) flagged.
function exitingChild(code) {
  const child = new EventEmitter();
  child.pid = 4242;
  child.unref = () => {};
  return () => {
    setImmediate(() => setTimeout(() => child.emit("exit", code), 0));
    return child;
  };
}

describe("restartOpencode", () => {
  it("invokes systemctl --user restart opencode-serve with a fixed argv (no shell string)", async () => {
    const calls = [];
    const exec = async (cmd, args) => { calls.push({ cmd, args }); return { stdout: "", stderr: "" }; };
    const result = await restartOpencode(exec);
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, "systemctl");
    assert.deepEqual(calls[0].args, ["--user", "restart", "opencode-serve"]);
  });

  it("returns ok:false with the error message when the command fails", async () => {
    const exec = async () => { throw new Error("Unit opencode-serve.service not found."); };
    const result = await restartOpencode(exec);
    assert.equal(result.ok, false);
    assert.equal(result.error, "Unit opencode-serve.service not found.");
  });

  it("never interpolates arguments into a single shell string", async () => {
    // Defense-in-depth regression guard: args must always be an array of
    // fixed literals, never a caller-influenced string that could carry
    // shell metacharacters. This function takes no external input at all,
    // so the array is always exactly these three literals.
    const calls = [];
    const exec = async (cmd, args) => { calls.push({ cmd, args }); };
    await restartOpencode(exec);
    for (const arg of calls[0].args) {
      assert.equal(typeof arg, "string");
    }
    assert.equal(calls[0].args.join(" "), "--user restart opencode-serve");
  });
});

describe("runServerSelfUpdate", () => {
  // The injection here uses the callback-shaped execFile (not the
  // promisified one) because the production path needs the raw
  // ChildProcess handle to .unref() it. A quiet stub returns a fake child
  // with a fixed pid and a no-op unref (and NO exit/error emitters), so the
  // watch simply times out → ok:true. A scripted stub extends EventEmitter
  // and lets the test emit `exit`/`error` to exercise the early-failure path.
  function quietSpawn(records, pid = 4242) {
    return (cmd, args, opts) => {
      records.push({ cmd, args, opts });
      return { pid, unref() {} };
    };
  }

  it("spawns the script detached + unref'd with no argv (fire-and-forget)", async () => {
    const calls = [];
    const result = await runServerSelfUpdate("/abs/scripts/self-update.sh", quietSpawn(calls), {
      timeoutMs: 10,
    });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, "/abs/scripts/self-update.sh");
    assert.deepEqual(calls[0].args, []);
    // detached:true is the load-bearing flag — without it the child would
    // keep the manta-server alive after the restart. stdio:"ignore" keeps
    // the script's stdout/stderr from blowing up manta-server's stdio.
    assert.equal(calls[0].opts.detached, true);
    assert.equal(calls[0].opts.stdio, "ignore");
  });

  it("returns ok:false with the error message when spawn throws (script missing, no exec bit)", async () => {
    const spawn = () => {
      throw new Error("spawn /abs/scripts/self-update.sh EACCES");
    };
    const result = await runServerSelfUpdate("/abs/scripts/self-update.sh", spawn, {
      timeoutMs: 10,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "spawn /abs/scripts/self-update.sh EACCES");
  });

  it("never interpolates arguments into a single shell string", async () => {
    // Same defense-in-depth guard as restartOpencode: this function takes
    // no caller input (the script path is resolved at module load from
    // import.meta.url), so the argv array must always be exactly [].
    const calls = [];
    await runServerSelfUpdate("/abs/scripts/self-update.sh", quietSpawn(calls), { timeoutMs: 10 });
    assert.deepEqual(calls[0].args, []);
  });

  it("resolves ok:false with the log's last line when the child exits non-zero fast", async () => {
    // BET-640: an early failure (before the server restart) is knowable. The
    // script writes its output to the state-dir log; a non-zero exit inside
    // the watch window must surface as ok:false with that line — NOT as a
    // silent "ok:true". Stub a child that emits `exit` non-zero after the log
    // holds a failure line.
    const logPath = statePath("self-update.log");
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, "▸ self-update: fetching manifest\n✗ self-update: manifest fetch failed: https://mantaui.com/releases/\n");

    const child = new EventEmitter();
    child.pid = 4242;
    child.unref = () => {};
    const spawn = () => {
      // Emit the exit asynchronously so runServerSelfUpdate has attached its
      // listener before the event fires.
      setImmediate(() => setTimeout(() => child.emit("exit", 1), 0));
      return child;
    };
    const result = await runServerSelfUpdate("/abs/scripts/self-update.sh", spawn, {
      timeoutMs: 500,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "✗ self-update: manifest fetch failed: https://mantaui.com/releases/");
  });

  it("resolves ok:true when the child exits zero fast", async () => {
    // An early clean exit ("already at version", no update needed) is success.
    const result = await runServerSelfUpdate("/abs/scripts/self-update.sh", exitingChild(0), {
      timeoutMs: 500,
    });
    assert.equal(result.ok, true);
  });

  it("resolves ok:true when the child is still running at the watch timeout", async () => {
    // BET-640: the normal case — the script reached the server restart, which
    // kills manta-server in a sibling process, so the child may keep running
    // (or die with our process). Still-running-at-timeout must resolve ok:true
    // and never hang the RPC past the window.
    const child = new EventEmitter();
    child.pid = 4242;
    child.unref = () => {};
    const calls = [];
    const spawn = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return child;
    };
    const result = await runServerSelfUpdate("/abs/scripts/self-update.sh", spawn, {
      timeoutMs: 5,
    });
    assert.equal(result.ok, true);
    // And the child was detached + unref'd even though it kept running.
    assert.equal(calls[0].opts.detached, true);
  });

  it("publishes each new progress step in ascending order and never republishes one already sent", async () => {
    // The self-update script emits `MANTA_PROGRESS <step>/<total> <label>`
    // markers into its log; runServerSelfUpdate tails the log and republishes
    // each strictly-increasing step as a `serverUpdateProgress` bus event.
    const logPath = statePath("self-update.log");
    mkdirSync(dirname(logPath), { recursive: true });
    // Seed the log with three markers (and unrelated log noise). The poll runs
    // every 500ms; with a longer timeout the first tick reads all three.
    writeFileSync(
      logPath,
      [
        "MANTA_PROGRESS 1/6 Checking for updates",
        "▸ self-update: fetching origin/main",
        "MANTA_PROGRESS 2/6 Downloading update",
        "MANTA_PROGRESS 3/6 Installing dependencies",
        "",
      ].join("\n"),
    );

    const events = [];
    const publish = (e) => events.push(e);

    const child = new EventEmitter();
    child.pid = 4242;
    child.unref = () => {};
    const spawn = () => {
      // Exit cleanly a little after the first poll tick fires so the poller
      // has a chance to read the seeded markers.
      setTimeout(() => child.emit("exit", 0), 600);
      return child;
    };

    const result = await runServerSelfUpdate("/abs/scripts/self-update.sh", spawn, {
      timeoutMs: 5000,
      publish,
    });
    assert.equal(result.ok, true);

    const progress = events.filter((e) => e.kind === "serverUpdateProgress");
    assert.equal(progress.length, 3);
    assert.deepEqual(
      progress.map((e) => e.payload.step),
      [1, 2, 3],
    );
    assert.deepEqual(progress[0].payload, {
      step: 1,
      total: 6,
      label: "Checking for updates",
    });
    assert.deepEqual(progress[2].payload, {
      step: 3,
      total: 6,
      label: "Installing dependencies",
    });
  });

  it("does not throw when publish is omitted (no polling)", async () => {
    const result = await runServerSelfUpdate("/abs/scripts/self-update.sh", exitingChild(0), {
      timeoutMs: 500,
    });
    assert.equal(result.ok, true);
  });
});

describe("parseProgressLine", () => {
  it("parses a well-formed MANTA_PROGRESS line", () => {
    assert.deepEqual(parseProgressLine("MANTA_PROGRESS 3/6 Installing dependencies"), {
      step: 3,
      total: 6,
      label: "Installing dependencies",
    });
  });

  it("returns null for a non-matching line, empty string, null and undefined", () => {
    assert.equal(parseProgressLine("▸ self-update: fetching origin/main"), null);
    assert.equal(parseProgressLine(""), null);
    assert.equal(parseProgressLine(null), null);
    assert.equal(parseProgressLine(undefined), null);
  });

  it("returns null when step > total and when step < 1", () => {
    assert.equal(parseProgressLine("MANTA_PROGRESS 7/6 Too far"), null);
    assert.equal(parseProgressLine("MANTA_PROGRESS 0/6 Zero"), null);
  });

  it("tolerates surrounding whitespace", () => {
    assert.deepEqual(parseProgressLine("   MANTA_PROGRESS 2/6 Downloading update   "), {
      step: 2,
      total: 6,
      label: "Downloading update",
    });
  });
});
