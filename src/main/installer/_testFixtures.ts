// _testFixtures.ts — shared test helpers for the installer test suite.
//
// Internal helper (prefixed with `_`); not shipped. The duplication-gate
// (scripts/check-duplication-gate.sh) caught that the makeFakeChild + the
// makeProbeSpawn helpers were repeated verbatim across multiple test files
// — extract them here so each test file just imports what it needs.

import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { vi } from "vitest";
import type { SpawnFn } from "./runner.js";

// ---------------------------------------------------------------------------
// FakeChildProcess — a ChildProcess-shaped stand-in. stdout/stderr are
// Readables we can push to; exit/error can be fired by the test; kill()
// records how many times it was called. Implements the minimum surface the
// runner touches. Used by runner.test.ts + installer.test.ts.
// ---------------------------------------------------------------------------

export type FakeChildHandle = {
  // The fake process itself, typed loosely (a real ChildProcess has many
  // fields we don't touch — using `any` keeps the test scaffolding clean).
  // @ts-expect-error – deliberate: narrow intentionally to the SpawnFn shape.
  child: Parameters<SpawnFn>[0] extends infer _X ? (infer _X) : never;
  pushStdout: (s: string) => void;
  pushStderr: (s: string) => void;
  fireExit: (code: number | null, signal?: NodeJS.Signals) => void;
  fireError: (err: Error) => void;
  killCount: () => number;
};

export function makeFakeChild(): FakeChildHandle {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const emitter = new EventEmitter();
  const fake: any = {
    stdio: ["ignore", stdout, stderr],
    stdout,
    stderr,
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    emit: emitter.emit.bind(emitter),
    kill: vi.fn(),
  };
  return {
    child: fake as any,
    pushStdout: (s) => stdout.push(Buffer.from(s)),
    pushStderr: (s) => stderr.push(Buffer.from(s)),
    fireExit: (code, signal) => emitter.emit("exit", code, signal ?? null),
    fireError: (err) => emitter.emit("error", err),
    killCount: () => (fake.kill as ReturnType<typeof vi.fn>).mock.calls.length,
  };
}

// ---------------------------------------------------------------------------
// makeProbeSpawn — a SpawnFn that pattern-matches the command line and
// returns the matching response. Used by installer.test.ts to simulate
// the six preflight probes + the install + the manta-pair mint.
// ---------------------------------------------------------------------------

export type ProbeResponse = { code: number | null; stdout?: string; stderr?: string };

export function makeProbeSpawn(
  responses: Record<string, ProbeResponse>,
): SpawnFn {
  return (_command, args) => {
    // args layout: ["-o", "ConnectTimeout=10", "-o", "BatchMode=yes", alias, command]
    const cmd = args[args.length - 1];
    const found = Object.keys(responses).find((k) => cmd.includes(k));
    const r =
      found !== undefined
        ? responses[found]
        : { code: 1, stdout: "", stderr: "unknown probe" };
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const emitter = new EventEmitter();
    const fake: any = {
      stdio: ["ignore", stdout, stderr],
      stdout,
      stderr,
      on: emitter.on.bind(emitter),
      once: emitter.once.bind(emitter),
      emit: emitter.emit.bind(emitter),
      kill: vi.fn(),
    };
    setImmediate(() => {
      if (r.stdout) stdout.push(Buffer.from(r.stdout));
      if (r.stderr) stderr.push(Buffer.from(r.stderr));
      emitter.emit("exit", r.code, null);
    });
    return fake as any;
  };
}

// Identify probes by a substring unique to each command. The lookup key is
// the substring the spawn stub pattern-matches against the command line.
export const PROBE_KEYS = {
  REACHABILITY: "command -v true",
  OS: "uname -s;",
  SUDO: "sudo -n true",
  TAILSCALE: "tailscale status --json",
  CLOCK: "date -u +%s",
  AUTH_FILE: "~/.manta/auth.json",
} as const;

export function emptyProbes(): Record<string, ProbeResponse> {
  return Object.fromEntries(
    Object.values(PROBE_KEYS).map((k) => [k, { code: 1, stdout: "", stderr: "" }]),
  );
}

// A SpawnFn that captures the (command, args) it was called with AND
// returns a fake child. Tests assert on the captured values to verify the
// runner built the expected ssh argv.
export function capturingSpawn(fake: FakeChildHandle): {
  spawn: SpawnFn;
  captured: { command: string; args: string[] };
} {
  const captured: { command: string; args: string[] } = { command: "", args: [] };
  const spawn: SpawnFn = (command, args) => {
    captured.command = command;
    captured.args = args;
    return fake.child as any;
  };
  return { spawn, captured };
}

// Standard "happy-path" probe responses for a Linux x86_64 box with sudo,
// no tailscale, fresh clock, no existing install — the same baseline every
// preflight test patches with the ONE thing it cares about. Returning the
// full object here (vs. having each test reassign six keys) is what keeps
// the duplication gate happy — the per-test overrides are just the bits
// that change.
export function happyLinuxProbes(
  overrides: Partial<Record<string, ProbeResponse>> = {},
): Record<string, ProbeResponse> {
  const r = emptyProbes();
  r[PROBE_KEYS.REACHABILITY] = { code: 0, stdout: "ok" };
  r[PROBE_KEYS.OS] = { code: 0, stdout: "Linux\nx86_64\n6.5.0\n" };
  r[PROBE_KEYS.SUDO] = { code: 0, stdout: "0\n" };
  r[PROBE_KEYS.TAILSCALE] = { code: 1, stdout: "" };
  r[PROBE_KEYS.CLOCK] = {
    code: 0,
    stdout: `${Math.floor(Date.now() / 1000)}\n`,
  };
  r[PROBE_KEYS.AUTH_FILE] = { code: 0, stdout: "FRESH\n" };
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) r[k] = v;
  }
  return r;
}
