#!/usr/bin/env node
// manta-pair.mjs — the `bui pair` CLI.
//
// Mints a fresh pairing code by hitting the LOOPBACK-only endpoint
// GET http://127.0.0.1:8787/auth/pair and pretty-printing the
// {pairing_code, box_id, expiresAt} response. Re-runnable any time: each call
// supersedes the previous code (auth.mjs keeps a single active code).
//
// It is the ONLY intended caller of /auth/pair — the route is loopback-gated in
// src/server/index.mjs (rejects any request carrying proxy forwarding headers),
// so this must run ON the box (or over an SSH -L forward that terminates here).
//
// Install paths (see package.json + install.sh):
//   * `npm run pair`            (from the repo)
//   * `bui pair`                (via ~/.local/bin/bui shim the installer drops)
//
// Exit codes: 0 on success, 1 on any failure (server down, non-2xx, 403 because
// the request wasn't local). Keep the logic thin — all formatting lives in the
// tested install-lib.mjs.

import { resolveConfig, formatPairingOutput } from "./install-lib.mjs";

async function main() {
  const cfg = resolveConfig();
  const url = `http://127.0.0.1:${cfg.port}/auth/pair`;

  let res;
  try {
    res = await fetch(url, { method: "GET" });
  } catch (e) {
    fail(
      `Could not reach manta-server at ${url}\n` +
        `  Is it running?  systemctl --user status manta-server\n` +
        `  (${e?.message ?? e})`,
    );
    return;
  }

  if (res.status === 403) {
    fail(
      "manta-server refused to mint a pairing code: this command must run ON the box.\n" +
        "  Pairing codes are loopback-only. Run `bui pair` directly on the server\n" +
        "  (or over an SSH -L 8787 forward that terminates on the box).",
    );
    return;
  }

  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      if (body?.error) detail = `: ${body.error}`;
    } catch {
      /* non-JSON body — ignore */
    }
    fail(`manta-server returned HTTP ${res.status}${detail}`);
    return;
  }

  let data;
  try {
    data = await res.json();
  } catch (e) {
    fail(`manta-server returned an unparseable response (${e?.message ?? e})`);
    return;
  }

  try {
    const block = formatPairingOutput({
      pairing_code: data?.pairing_code,
      box_id: data?.box_id,
      expiresAt: data?.expiresAt,
    });
    process.stdout.write(block + "\n");
  } catch (e) {
    fail(`unexpected pairing response from manta-server (${e?.message ?? e})`);
  }
}

function fail(msg) {
  process.stderr.write(`bui pair: ${msg}\n`);
  process.exitCode = 1;
}

main();
