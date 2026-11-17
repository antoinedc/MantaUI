// The replay harness's "before" policy is vendored from a pinned commit
// (scripts/seats/baseline/PINNED.md). Prove the vendored copies are unmodified.
// This lives in src/server/ so the `test:server` glob runs it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PINNED = "f95bfe2b";
const vendored = (name) => readFileSync(join(root, "scripts/seats/baseline", name), "utf8");

function pinned(path) {
  try {
    return execFileSync("git", ["show", `${PINNED}:${path}`], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

// Provenance (vendored == git history) needs git and the pinned commit, which a source tarball or a shallow clone
// does not have. The digests below are the always-on guard that the vendored files are unmodified; the git
// comparison proves where they came from whenever the commit is reachable, and is skipped when it is not.
const unavailable = (t) => t.skip("git or the pinned commit is unavailable (the digest test below still guards the files)");

// sha256 of the vendored files as pinned. They change only by re-pinning (see PINNED.md): update these with them.
const VENDORED_SHA256 = {
  "seatChoice.mjs": "46bdc3fdde32d131ce3fcdf7513a8545eae0597011555755ff16b69f0895397e",
  "seatAssignment.mjs": "8679ec6383f5b88827cde56a38657c7f40537b72aaf53a5c71b012cae4fc9054",
};

test("the vendored baseline files are unmodified (digest)", () => {
  for (const [name, digest] of Object.entries(VENDORED_SHA256)) {
    assert.equal(createHash("sha256").update(readFileSync(join(root, "scripts/seats/baseline", name))).digest("hex"), digest, `${name} was edited — see scripts/seats/baseline/PINNED.md`);
  }
});

const SERVICE_BANNER = "// ---------------------------------------------------------------------------\n// The service\n";
const SERVICE_IMPORTS = [
  'import { readJsonSync, writeJsonAtomic, createMutex } from "./jsonStore.mjs";',
  'import { statePath } from "../shared/paths.mjs";',
  'import { leastLoadedSeat, isSeatExhausted, seatLoad, seatLoadWindow, nextResetAt, soonestResettingSeat } from "../shared/seatChoice.mjs";',
  'import { ACCOUNT_PROVIDERS, notePluginSeen } from "./accounts.mjs";',
  "",
].join("\n");
const VENDORED_IMPORTS =
  'import { leastLoadedSeat, isSeatExhausted, seatLoad, seatLoadWindow, nextResetAt, soonestResettingSeat } from "./seatChoice.mjs";\n' +
  'const ACCOUNT_PROVIDERS = ["claude", "codex"];\n';

test("baseline seatChoice.mjs is byte-identical to the pinned commit", (t) => {
  const src = pinned("src/shared/seatChoice.mjs");
  if (src === null) return unavailable(t);
  assert.equal(vendored("seatChoice.mjs"), src);
});

test("baseline seatAssignment.mjs is the pinned pure section, with only the service imports swapped", (t) => {
  const src = pinned("src/server/seatAssignment.mjs");
  if (src === null) return unavailable(t);
  const cut = src.indexOf(SERVICE_BANNER);
  assert.ok(cut > 0, "the pinned file has the service banner");
  const pure = src.slice(0, cut);
  assert.ok(pure.includes(SERVICE_IMPORTS), "the pinned file has the four service imports");
  assert.equal(vendored("seatAssignment.mjs"), pure.replace(SERVICE_IMPORTS, VENDORED_IMPORTS));
});

test("the vendored pure section loads and decides", async () => {
  const { decideSeat, MOVE_AT_PCT } = await import("../../scripts/seats/baseline/seatAssignment.mjs");
  assert.equal(MOVE_AT_PCT, 95);
  const seats = [
    { seatId: "a", usable: true, orgId: "o" },
    { seatId: "b", usable: true, orgId: "o" },
  ];
  const snap = (seatId, pct) => ({ seatId, provider: "claude", fetchedAt: 0, windows: [{ kind: "session", pct }] });
  const out = decideSeat({ existing: null, mode: "auto", activeSeatId: "a", seats, seatSnapshots: [snap("a", 60), snap("b", 10)], nowMs: 0 });
  assert.deepEqual(out, { seatId: "b", reason: "assigned" });
});
