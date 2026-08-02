#!/usr/bin/env node
/**
 * mobile/native/measure.mjs — the measurement layer of the native
 * visual-verification harness. It answers, for two captures produced by
 * capture.sh, "do they agree?" and "by how much, exactly?".
 *
 * Two legs are compared:
 *   - the SCREENSHOT leg (colour/typography/radius) pixel-by-pixel;
 *   - the HIERARCHY leg (geometry/text) byte-for-byte after capture.sh's
 *     normalisation (0xADDR / pid PID placeholders).
 *
 * TOLERANCES ARE ABSOLUTE, never a ratio, and always reported with the
 * measurement that produced them. The pixel verdict is an absolute count of
 * differing pixels, and a spatial mask can exclude KNOWN noise by location so
 * the magnitude tolerance elsewhere can approach zero.
 *
 * The worked example (from the epic's Verification section): the Dynamic
 * Island's anti-aliased edge is a known variable few pixels on a FIXED
 * region. `--mask dynamic-island` excludes that region by location, then
 * requires near-exact equality everywhere else. The measured capsule region
 * below is pinned to this device (iPhone 17 Pro, iOS 26.5) — a different
 * pinned device would report its own rect.
 *
 * Usage:
 *   node measure.mjs <dirA> <dirB> [--scene NAME] [--mask MASK]...
 *     MASK: "dynamic-island" | "X,Y,width,height" (pixel coords, repeatable)
 *
 * Exit: 0 = both legs identical (hierarchy byte-equal, pixels equal outside
 * any mask); 1 = a real difference was measured. Never retries, never widens
 * a tolerance to converge.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readFile } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Pinned-device measurement (iPhone 17 Pro, iOS 26.5): the Dynamic Island
// capsule, in PIXEL coordinates, measured from an actual capture
// (central contiguous dark run, x 138.3-263.3 pt, y 14.0-40.0 pt @3x). This
// is the "known 4-pixel band on a fixed region" from the epic.
const DYNAMIC_ISLAND = { x: 415, y: 42, width: 375, height: 78 };

function usage() {
  console.error(
    "usage: node measure.mjs <dirA> <dirB> [--scene NAME] [--mask MASK]...\n" +
      "  MASK: dynamic-island | X,Y,width,height  (pixel coords, repeatable)",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const positional = [];
  const masks = [];
  let scene = "screen";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--scene") {
      scene = argv[++i];
      if (!scene) usage();
    } else if (a === "--mask") {
      const m = argv[++i];
      if (!m) usage();
      if (m === "dynamic-island") {
        masks.push(DYNAMIC_ISLAND);
      } else {
        const [x, y, w, h] = m.split(",").map(Number);
        if (![x, y, w, h].every(Number.isFinite)) usage();
        masks.push({ x, y, width: w, height: h });
      }
    } else if (a.startsWith("-")) {
      usage();
    } else {
      positional.push(a);
    }
  }
  if (positional.length !== 2) usage();
  return { dirA: positional[0], dirB: positional[1], scene, masks };
}

// Decode a PNG to a flat BGR(A) pixel buffer via `sips` -> uncompressed BMP.
// The BMP is 32-bit BGRA, top-down (negative height) on this toolchain, so
// rows need no alignment padding. Returns {width, height, buf(BGRA bytes)}.
function decodePng(pngPath) {
  const work = mkdtempSync(join(tmpdir(), "manta-measure-"));
  const bmpPath = join(work, "frame.bmp");
  try {
    execFileSync("sips", ["-s", "format", "bmp", pngPath, "--out", bmpPath], {
      stdio: "ignore",
    });
    const data = readFileSync(bmpPath);
    // 138-byte BITMAPINFOHEADER/bitmap headers for sips output.
    const offset = 138;
    const width = data.readInt32LE(18);
    const height = data.readInt32LE(22); // negative => top-down
    const bpp = data.readUInt16LE(28);
    if (bpp !== 32) throw new Error(`bmp not 32bpp: ${bpp}`);
    const topDown = height < 0;
    const h = Math.abs(height);
    const rowBytes = width * 4;
    const buf = Buffer.from(data.subarray(offset, offset + width * h * 4));
    // Make it always top-down for comparison.
    return topDown ? { width, height: h, buf } : flipRows(buf, width, h);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function flipRows(buf, width, height) {
  const row = width * 4;
  const out = Buffer.alloc(buf.length);
  for (let y = 0; y < height; y++) {
    buf.copy(out, y * row, (height - 1 - y) * row, (height - y) * row);
  }
  return { width, height, buf: out };
}

function inAnyMask(x, y, masks) {
  for (const m of masks) {
    if (x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height) return true;
  }
  return false;
}

function comparePixels(a, b, masks) {
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  const dimsMatch = a.width === b.width && a.height === b.height;
  let diffTotal = 0;
  let diffMasked = 0;
  let maxChannel = 0;
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const dr = Math.abs(a.buf[i] - b.buf[i]);
      const dg = Math.abs(a.buf[i + 1] - b.buf[i + 1]);
      const db = Math.abs(a.buf[i + 2] - b.buf[i + 2]);
      // A pixel differs if ANY channel differs.
      if (dr === 0 && dg === 0 && db === 0) continue;
      diffTotal++;
      if (inAnyMask(x, y, masks)) {
        diffMasked++;
        continue;
      }
      // "Max channel delta" is the largest SINGLE-channel delta (per the epic;
      // a colour-only defect was detected at max channel delta 30).
      let c = dr > dg ? dr : dg;
      if (db > c) c = db;
      if (c > maxChannel) maxChannel = c;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const outsideDiff = diffTotal - diffMasked;
  return {
    dimsMatch,
    diffTotal,
    diffMasked,
    outsideDiff,
    maxChannelOutside: maxChannel,
    diffBBox:
      outsideDiff > 0
        ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
        : null,
    outsideMaskValid: dimsMatch && outsideDiff === 0,
  };
}

const { dirA, dirB, scene, masks } = parseArgs(process.argv.slice(2));
const pngA = join(dirA, `${scene}.png`);
const pngB = join(dirB, `${scene}.png`);
const hierA = join(dirA, `${scene}-hierarchy.txt`);
const hierB = join(dirB, `${scene}-hierarchy.txt`);

let exitCode = 0;
const out = [];

// ---- hierarchy leg (geometry/text) — byte-for-byte after normalisation ----
const hierSame = readFileSync(hierA).equals(readFileSync(hierB));
out.push(`hierarchy leg: ${hierSame ? "IDENTICAL (byte-for-byte)" : "DIFFER"}`);
if (!hierSame) exitCode = 1;

// ---- screenshot leg (colour/typography/radius) — absolute pixel diff ------
const a = decodePng(pngA);
const b = decodePng(pngB);
const r = comparePixels(a, b, masks);
out.push(`screenshot leg: ${a.width}x${a.height} vs ${b.width}x${b.height} (${r.dimsMatch ? "dims match" : "DIMS DIFFER"})`);
if (!r.dimsMatch) exitCode = 1;

const maskLabel = masks.length ? masks.map((m) => `[${m.x},${m.y} ${m.width}x${m.height}]`).join(" ") : "(none)";
out.push(`masks applied: ${maskLabel}`);
out.push(`differing pixels (absolute): ${r.diffTotal}`);
out.push(`  inside mask: ${r.diffMasked}`);
out.push(`  outside mask: ${r.outsideDiff}`);
out.push(`max channel delta outside mask (absolute): ${r.maxChannelOutside}`);
if (r.diffBBox) {
  out.push(`diff bounding box (px): x=${r.diffBBox.x} y=${r.diffBBox.y} w=${r.diffBBox.width} h=${r.diffBBox.height}`);
}

const pixelOk = r.dimsMatch && r.outsideDiff === 0;
const verdict = hierSame && pixelOk ? "PASS" : "FAIL";
if (!pixelOk) exitCode = 1;
out.push(`VERDICT: ${verdict}`);

console.log(out.join("\n"));
process.exit(exitCode);
