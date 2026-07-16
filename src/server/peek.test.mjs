// Tests for the /api/peek route — file peek for HTTP-mode desktop.
// Run via `npm run test:server` (node:test).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import http from "node:http";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Helper: make a GET request and return { status, headers, body }
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on("error", reject);
  });
}

// Helper: start a minimal server with the peek route logic
async function startPeekServer(testDir) {
  const { readFile, stat: fsStat } = await import("node:fs/promises");
  const { createReadStream } = await import("node:fs");
  const { pipeline } = await import("node:stream/promises");
  const { resolve: pathResolve, extname, basename } = await import("node:path");
  const httpMod = await import("node:http");

  const MIME = {
    ".txt": "text/plain; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".html": "text/html; charset=utf-8",
  };

  return new Promise((serverResolve) => {
    const server = httpMod.createServer(async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const path = url.pathname;

      if (req.method === "GET" && path === "/api/peek") {
        try {
          const raw = url.searchParams.get("path") ?? "";
          if (!raw) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "path is required" }));
            return;
          }
          let resolved = raw;
          if (resolved === "~") resolved = homedir() + "/";
          else if (resolved.startsWith("~/")) resolved = homedir() + resolved.slice(1);
          else resolved = pathResolve(resolved);

          const home = homedir() + "/";
          if (resolved !== home && !resolved.startsWith(home)) {
            res.writeHead(403, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "path outside home directory" }));
            return;
          }

          let s;
          try {
            s = await fsStat(resolved);
          } catch (e) {
            if (e?.code === "ENOENT") {
              res.writeHead(404, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "not found" }));
              return;
            }
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: String(e?.message ?? e) }));
            return;
          }
          if (!s.isFile()) {
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "not a file" }));
            return;
          }

          const ext = extname(resolved);
          const contentType = MIME[ext] ?? "application/octet-stream";
          res.writeHead(200, {
            "content-type": contentType,
            "content-length": String(s.size),
            "content-disposition": `inline; filename="${basename(resolved).replace(/"/g, "")}"`,
          });
          await pipeline(createReadStream(resolved), res);
        } catch (e) {
          if (!res.headersSent) {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: String(e?.message ?? e) }));
          } else {
            res.destroy();
          }
        }
        return;
      }

      res.writeHead(404);
      res.end("not found");
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      serverResolve({ server, port: addr.port });
    });
  });
}

test("/api/peek serves a text file with correct content", async () => {
  const testDir = join(homedir(), ".manta-test-peek-" + Date.now());
  await mkdir(testDir, { recursive: true });
  const testFile = join(testDir, "test.txt");
  await writeFile(testFile, "hello world");

  try {
    const { server, port } = await startPeekServer(testDir);
    try {
      const res = await httpGet(`http://127.0.0.1:${port}/api/peek?path=${encodeURIComponent(testFile)}`);
      assert.equal(res.status, 200, `Response body: ${res.body.toString()}`);
      assert.equal(res.headers["content-type"], "text/plain; charset=utf-8");
      assert.equal(res.body.toString(), "hello world");
    } finally {
      server.close();
    }
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
});

test("/api/peek rejects missing path with 400", async () => {
  const { server, port } = await startPeekServer();
  try {
    const res = await httpGet(`http://127.0.0.1:${port}/api/peek`);
    assert.equal(res.status, 400);
    const body = JSON.parse(res.body.toString());
    assert.equal(body.error, "path is required");
  } finally {
    server.close();
  }
});

test("/api/peek rejects path traversal with 403", async () => {
  const { server, port } = await startPeekServer();
  try {
    // Try to access a file outside home dir
    const res = await httpGet(`http://127.0.0.1:${port}/api/peek?path=/etc/passwd`);
    assert.equal(res.status, 403);
    const body = JSON.parse(res.body.toString());
    assert.equal(body.error, "path outside home directory");
  } finally {
    server.close();
  }
});

test("/api/peek returns 404 for non-existent file", async () => {
  const nonExistent = join(homedir(), "nonexistent-file-12345.txt");
  const { server, port } = await startPeekServer();
  try {
    const res = await httpGet(`http://127.0.0.1:${port}/api/peek?path=${encodeURIComponent(nonExistent)}`);
    assert.equal(res.status, 404);
    const body = JSON.parse(res.body.toString());
    assert.equal(body.error, "not found");
  } finally {
    server.close();
  }
});

test("/api/peek returns 404 for directory", async () => {
  const testDir = join(homedir(), ".manta-test-peek-dir-" + Date.now());
  await mkdir(testDir, { recursive: true });
  const { server, port } = await startPeekServer();
  try {
    const res = await httpGet(`http://127.0.0.1:${port}/api/peek?path=${encodeURIComponent(testDir)}`);
    assert.equal(res.status, 404);
    const body = JSON.parse(res.body.toString());
    assert.equal(body.error, "not a file");
  } finally {
    server.close();
    await rm(testDir, { recursive: true, force: true });
  }
});

test("/api/peek expands ~ to home directory", async () => {
  // Create a file in home dir
  const ts = Date.now();
  const testFile = join(homedir(), `.manta-test-peek-home-${ts}.txt`);
  await writeFile(testFile, "home file content");
  const relativePath = `~/.manta-test-peek-home-${ts}.txt`;

  const { server, port } = await startPeekServer();
  try {
    const res = await httpGet(`http://127.0.0.1:${port}/api/peek?path=${encodeURIComponent(relativePath)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.toString(), "home file content");
  } finally {
    server.close();
    await rm(testFile, { force: true });
  }
});

test("/api/peek serves JSON with correct content-type", async () => {
  const testDir = join(homedir(), ".manta-test-peek-json-" + Date.now());
  await mkdir(testDir, { recursive: true });
  const testFile = join(testDir, "data.json");
  await writeFile(testFile, '{"key":"value"}');

  try {
    const { server, port } = await startPeekServer(testDir);
    try {
      const res = await httpGet(`http://127.0.0.1:${port}/api/peek?path=${encodeURIComponent(testFile)}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers["content-type"], "application/json; charset=utf-8");
      assert.equal(res.body.toString(), '{"key":"value"}');
    } finally {
      server.close();
    }
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
});
