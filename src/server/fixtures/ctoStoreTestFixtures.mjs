// fixtures/ctoStoreTestFixtures.mjs — shared CTO-store test fixtures (BET-1536
// review cycle 2, Block 1: the strict duplication gate flagged the tmp-dir
// harness + ledger capture repeated across endpointAttempts.test.mjs and
// endpointHealth.test.mjs).
//
// Pure test infrastructure: no production imports, no network, no state.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A throwaway dir per scenario; removed even when the body throws. */
export async function withTmpDir(prefix, fn) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** An in-memory cto-ledger double that records every appended row. */
export function captureLedger() {
  const rows = [];
  return { rows, append: async (row) => { rows.push(row); return true; } };
}
