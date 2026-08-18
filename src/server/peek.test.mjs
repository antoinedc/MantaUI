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

import { parseByteRange } from "./range.mjs";

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

// Helper: make a HEAD request — same response shape, body expected empty.
function httpHead(url) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: "HEAD" }, (res) => {
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
    req.end();
  });
}

// Helper: make a GET request with the given Range header.
function httpGetRange(url, range) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      url,
      { headers: range === undefined ? {} : { Range: range } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
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

      if ((req.method === "GET" || req.method === "HEAD") && path === "/api/peek") {
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
          const baseHeaders = {
            "content-type": contentType,
            "accept-ranges": "bytes",
            "content-disposition": `inline; filename="${basename(resolved).replace(/"/g, "")}"`,
          };
          const range = parseByteRange(req.headers.range ?? null, s.size);
          if (range === "unsatisfiable") {
            res.writeHead(416, {
              ...baseHeaders,
              "content-range": `bytes */${s.size}`,
            });
            res.end();
            return;
          }
          if (range) {
            const length = range.end - range.start + 1;
            res.writeHead(206, {
              ...baseHeaders,
              "content-range": `bytes ${range.start}-${range.end}/${s.size}`,
              "content-length": String(length),
            });
            if (req.method === "HEAD") {
              res.end();
              return;
            }
            await pipeline(
              createReadStream(resolved, { start: range.start, end: range.end }),
              res,
            );
            return;
          }
          res.writeHead(200, {
            ...baseHeaders,
            "content-length": String(s.size),
          });
          if (req.method === "HEAD") {
            res.end();
            return;
          }
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

test("/api/peek HEAD reports content-length without a body", async () => {
  const testDir = join(homedir(), ".manta-test-peek-head-" + Date.now());
  await mkdir(testDir, { recursive: true });
  const testFile = join(testDir, "test.txt");
  const content = "hello world";
  await writeFile(testFile, content);

  try {
    const { server, port } = await startPeekServer(testDir);
    try {
      const res = await httpHead(`http://127.0.0.1:${port}/api/peek?path=${encodeURIComponent(testFile)}`);
      assert.equal(res.status, 200, `Response body: ${res.body.toString()}`);
      assert.equal(res.headers["content-type"], "text/plain; charset=utf-8");
      assert.equal(res.headers["content-length"], String(Buffer.byteLength(content)));
      assert.equal(res.body.length, 0, "HEAD must not stream a body");
    } finally {
      server.close();
    }
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
});

test("/api/peek HEAD rejects path traversal with 403", async () => {
  const { server, port } = await startPeekServer();
  try {
    // Node suppresses the body on HEAD responses; the status must match GET's 403.
    const res = await httpHead(`http://127.0.0.1:${port}/api/peek?path=/etc/passwd`);
    assert.equal(res.status, 403);
    assert.equal(res.body.length, 0);
  } finally {
    server.close();
  }
});

test("/api/peek HEAD returns 404 for non-existent file", async () => {
  const nonExistent = join(homedir(), "nonexistent-file-12345.txt");
  const { server, port } = await startPeekServer();
  try {
    // Node suppresses the body on HEAD responses; the status must match GET's 404.
    const res = await httpHead(`http://127.0.0.1:${port}/api/peek?path=${encodeURIComponent(nonExistent)}`);
    assert.equal(res.status, 404);
    assert.equal(res.body.length, 0);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// parseByteRange — pure unit tests (no HTTP, no server)
// ---------------------------------------------------------------------------

test("parseByteRange: closed range bytes=0-99", () => {
  assert.deepEqual(parseByteRange("bytes=0-99", 1000), { start: 0, end: 99 });
});

test("parseByteRange: closed range clamps end to EOF", () => {
  assert.deepEqual(parseByteRange("bytes=900-2000", 1000), { start: 900, end: 999 });
});

test("parseByteRange: open-ended range bytes=100-", () => {
  assert.deepEqual(parseByteRange("bytes=100-", 1000), { start: 100, end: 999 });
});

test("parseByteRange: suffix range bytes=-100", () => {
  assert.deepEqual(parseByteRange("bytes=-100", 1000), { start: 900, end: 999 });
});

test("parseByteRange: suffix larger than file returns whole file", () => {
  assert.deepEqual(parseByteRange("bytes=-5000", 1000), { start: 0, end: 999 });
});

test("parseByteRange: start past EOF is unsatisfiable", () => {
  assert.equal(parseByteRange("bytes=1000-", 1000), "unsatisfiable");
  assert.equal(parseByteRange("bytes=1001-2000", 1000), "unsatisfiable");
});

test("parseByteRange: end before start is unsatisfiable", () => {
  assert.equal(parseByteRange("bytes=50-10", 1000), "unsatisfiable");
});

test("parseByteRange: zero-length / empty suffix range is unsatisfiable", () => {
  assert.equal(parseByteRange("bytes=-0", 1000), "unsatisfiable");
  assert.equal(parseByteRange("bytes=-", 1000), "unsatisfiable");
});

test("parseByteRange: range on empty file is unsatisfiable", () => {
  assert.equal(parseByteRange("bytes=0-", 0), "unsatisfiable");
  assert.equal(parseByteRange("bytes=-1", 0), "unsatisfiable");
});

test("parseByteRange: absent header returns null", () => {
  assert.equal(parseByteRange(null, 1000), null);
  assert.equal(parseByteRange(undefined, 1000), null);
  assert.equal(parseByteRange("", 1000), null);
});

test("parseByteRange: unparseable header returns null", () => {
  assert.equal(parseByteRange("bytes", 1000), null);
  assert.equal(parseByteRange("bytes=", 1000), null);
  assert.equal(parseByteRange("items=0-10", 1000), null);
  assert.equal(parseByteRange("bytes=abc-def", 1000), null);
  assert.equal(parseByteRange("bytes=0-99 extra", 1000), null);
});

test("parseByteRange: multi-range request returns null (serve whole file)", () => {
  assert.equal(parseByteRange("bytes=0-99,300-400", 1000), null);
});

// ---------------------------------------------------------------------------
// /api/peek Range behaviour — integration tests against the mock server
// ---------------------------------------------------------------------------

test("/api/peek advertises accept-ranges on GET and HEAD", async () => {
  const testDir = join(homedir(), ".manta-test-peek-ranges-" + Date.now());
  await mkdir(testDir, { recursive: true });
  const testFile = join(testDir, "test.txt");
  const content = "0123456789abcdefghij"; // 20 bytes
  await writeFile(testFile, content);

  try {
    const { server, port } = await startPeekServer(testDir);
    try {
      const url = `http://127.0.0.1:${port}/api/peek?path=${encodeURIComponent(testFile)}`;
      const get = await httpGet(url);
      assert.equal(get.headers["accept-ranges"], "bytes");
      const head = await httpHead(url);
      assert.equal(head.headers["accept-ranges"], "bytes");
    } finally {
      server.close();
    }
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
});

test("/api/peek ranged GET returns 206 with the correct bytes and content-range", async () => {
  const testDir = join(homedir(), ".manta-test-peek-range-get-" + Date.now());
  await mkdir(testDir, { recursive: true });
  const testFile = join(testDir, "test.txt");
  const content = "0123456789abcdefghij"; // 20 bytes
  await writeFile(testFile, content);

  try {
    const { server, port } = await startPeekServer(testDir);
    try {
      const url = `http://127.0.0.1:${port}/api/peek?path=${encodeURIComponent(testFile)}`;
      const res = await httpGetRange(url, "bytes=5-9");
      assert.equal(res.status, 206, `Response body: ${res.body.toString()}`);
      assert.equal(res.body.toString(), "56789");
      assert.equal(res.headers["content-range"], "bytes 5-9/20");
      assert.equal(res.headers["content-length"], "5");
    } finally {
      server.close();
    }
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
});

test("/api/peek open-ended ranged GET returns the tail", async () => {
  const testDir = join(homedir(), ".manta-test-peek-range-open-" + Date.now());
  await mkdir(testDir, { recursive: true });
  const testFile = join(testDir, "test.txt");
  const content = "0123456789abcdefghij"; // 20 bytes
  await writeFile(testFile, content);

  try {
    const { server, port } = await startPeekServer(testDir);
    try {
      const url = `http://127.0.0.1:${port}/api/peek?path=${encodeURIComponent(testFile)}`;
      const res = await httpGetRange(url, "bytes=15-");
      assert.equal(res.status, 206);
      assert.equal(res.body.toString(), "fghij");
      assert.equal(res.headers["content-range"], "bytes 15-19/20");
      assert.equal(res.headers["content-length"], "5");
    } finally {
      server.close();
    }
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
});

test("/api/peek unsatisfiable range returns 416 with bytes */size", async () => {
  const testDir = join(homedir(), ".manta-test-peek-range-416-" + Date.now());
  await mkdir(testDir, { recursive: true });
  const testFile = join(testDir, "test.txt");
  await writeFile(testFile, "0123456789abcdefghij");

  try {
    const { server, port } = await startPeekServer(testDir);
    try {
      const url = `http://127.0.0.1:${port}/api/peek?path=${encodeURIComponent(testFile)}`;
      const res = await httpGetRange(url, "bytes=100-200");
      assert.equal(res.status, 416);
      assert.equal(res.headers["content-range"], "bytes */20");
      assert.equal(res.body.length, 0);
    } finally {
      server.close();
    }
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
});

test("/api/peek unranged GET is byte-identical to a plain 200", async () => {
  const testDir = join(homedir(), ".manta-test-peek-unranged-" + Date.now());
  await mkdir(testDir, { recursive: true });
  const testFile = join(testDir, "test.txt");
  const content = "hello world";
  await writeFile(testFile, content);

  try {
    const { server, port } = await startPeekServer(testDir);
    try {
      const url = `http://127.0.0.1:${port}/api/peek?path=${encodeURIComponent(testFile)}`;
      // Explicit no-range GET behaves exactly like the existing 200.
      const res = await httpGetRange(url, undefined);
      assert.equal(res.status, 200);
      assert.equal(res.body.toString(), content);
      assert.equal(res.headers["content-length"], String(Buffer.byteLength(content)));
    } finally {
      server.close();
    }
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
});

test("/api/peek multi-range request degrades to a full 200", async () => {
  const testDir = join(homedir(), ".manta-test-peek-multirange-" + Date.now());
  await mkdir(testDir, { recursive: true });
  const testFile = join(testDir, "test.txt");
  const content = "0123456789abcdefghij";
  await writeFile(testFile, content);

  try {
    const { server, port } = await startPeekServer(testDir);
    try {
      const url = `http://127.0.0.1:${port}/api/peek?path=${encodeURIComponent(testFile)}`;
      const res = await httpGetRange(url, "bytes=0-1,5-6");
      assert.equal(res.status, 200);
      assert.equal(res.body.toString(), content);
    } finally {
      server.close();
    }
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
});

test("/api/peek plain HEAD still reports the full size with no body (unchanged)", async () => {
  const testDir = join(homedir(), ".manta-test-peek-head-range-" + Date.now());
  await mkdir(testDir, { recursive: true });
  const testFile = join(testDir, "test.txt");
  const content = "0123456789abcdefghij"; // 20 bytes
  await writeFile(testFile, content);

  try {
    const { server, port } = await startPeekServer(testDir);
    try {
      const res = await httpHead(`http://127.0.0.1:${port}/api/peek?path=${encodeURIComponent(testFile)}`);
      assert.equal(res.status, 200, "plain HEAD stays 200 with the full size");
      assert.equal(res.headers["content-length"], String(Buffer.byteLength(content)));
      assert.equal(res.body.length, 0, "HEAD must not stream a body");
    } finally {
      server.close();
    }
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
});

test("/api/peek HEAD with a Range reports the slice length with no body", async () => {
  const testDir = join(homedir(), ".manta-test-peek-head-range2-" + Date.now());
  await mkdir(testDir, { recursive: true });
  const testFile = join(testDir, "test.txt");
  await writeFile(testFile, "0123456789abcdefghij"); // 20 bytes

  try {
    const { server, port } = await startPeekServer(testDir);
    try {
      const req = await new Promise((resolve, reject) => {
        const r = http.request(
          `http://127.0.0.1:${port}/api/peek?path=${encodeURIComponent(testFile)}`,
          { method: "HEAD", headers: { Range: "bytes=5-9" } },
          (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({
                status: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks),
              }),
            );
          },
        );
        r.on("error", reject);
        r.end();
      });
      assert.equal(req.status, 206);
      assert.equal(req.headers["content-range"], "bytes 5-9/20");
      assert.equal(req.headers["content-length"], "5");
      assert.equal(req.body.length, 0, "HEAD must not stream a body");
    } finally {
      server.close();
    }
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
});
