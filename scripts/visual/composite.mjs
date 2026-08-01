#!/usr/bin/env node
/**
 * scripts/visual/composite.mjs — shared side-by-side compositing for the
 * visual scripts, built on sharp (already a direct dependency).
 *
 * Extracted from compare.mjs so both the app-vs-mockup comparison AND the
 * baseline before/after diff use the same two helpers. compare.mjs must not
 * define these itself — this file is the single source.
 */

import sharp from "sharp";

const LABEL_H = 22; // dark label band above each half
const GAP = 12; // gutter between the two halves

/** Stamp a dark label band with `label` across the top of an image buffer. */
export async function withLabel(img, label) {
  const { width } = await sharp(img).metadata();
  const band = Buffer.from(
    `<svg width="${width}" height="${LABEL_H}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#131318"/>
      <text x="8" y="15" fill="#e6e6ec" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">${label}</text>
    </svg>`,
  );
  return sharp(img)
    .extend({ top: LABEL_H, background: "#131318" })
    .composite([{ input: band, top: 0, left: 0 }])
    .toBuffer();
}

/**
 * Join the left and right halves side by side at IDENTICAL scale (both scaled
 * to the taller half's height) and write the single composite to `outPath`.
 * Labels default to "app"/"mockup" for the designer-comparison use; pass a
 * two-element array (e.g. ["before", "after"]) for other halves.
 */
export async function writeComposite(leftPng, rightPng, outPath, labels = ["app", "mockup"]) {
  const [aMeta, mMeta] = await Promise.all([
    sharp(leftPng).metadata(),
    sharp(rightPng).metadata(),
  ]);
  const targetH = Math.max(aMeta.height, mMeta.height);
  const [leftScaled, rightScaled] = await Promise.all([
    sharp(leftPng).resize({ height: targetH, withoutEnlargement: false }).toBuffer(),
    sharp(rightPng).resize({ height: targetH, withoutEnlargement: false }).toBuffer(),
  ]);
  const [leftLabelled, rightLabelled] = await Promise.all([
    withLabel(leftScaled, labels[0]),
    withLabel(rightScaled, labels[1]),
  ]);
  const [a, m] = await Promise.all([
    sharp(leftLabelled).metadata(),
    sharp(rightLabelled).metadata(),
  ]);
  const canvasW = a.width + GAP + m.width;
  const canvasH = a.height;
  await sharp({
    create: { width: canvasW, height: canvasH, channels: 4, background: "#000000" },
  })
    .composite([
      { input: leftLabelled, top: 0, left: 0 },
      { input: rightLabelled, top: 0, left: a.width + GAP },
    ])
    .png()
    .toFile(outPath);
  return canvasW;
}
