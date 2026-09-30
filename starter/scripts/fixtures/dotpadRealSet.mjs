/**
 * The real DOT Pad frames, their ground truth, and the augmented held-out set
 * built from them — shared by `test_dotpad_lattice.mjs` and diagnostics.
 *
 * `augCase(seed, split)` is fully determined by its arguments: the TUNE split
 * draws only from the frames marked "tune" in ground_truth.json, the REPORT
 * split from all of them, with a different seed stream.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import jpeg from 'jpeg-js';
import { rgbaToGray } from '../../src/lib/dotpadLattice.js';
import { applyH, homography4, rotateQuad } from '../../src/lib/dotpadTemplate.js';
import { augmentReal, blurLuma, rng, PIN_IDX } from './dotpadScenes.mjs';

const FRAMES = join(dirname(fileURLToPath(import.meta.url)), 'dotpad_frames');

/** Local pin pitch (px) at each GT corner. */
export function cornerPitches(gt) {
  const H = homography4(PIN_IDX, gt);
  return PIN_IDX.map(([c, r]) => {
    const p = applyH(H, [c, r]);
    const a = applyH(H, [c + (c ? -1 : 1), r]), b = applyH(H, [c, r + (r ? -1 : 1)]);
    return (Math.hypot(a[0] - p[0], a[1] - p[1]) + Math.hypot(b[0] - p[0], b[1] - p[1])) / 2;
  });
}

/**
 * Score one detection against ground truth. Without text evidence the pad's
 * 180° is legitimately open (the component asks for a confirm touch), so the
 * corners are compared modulo 180° — never modulo 90°.
 */
export function score(r, gt) {
  if (!r) return { found: false };
  const pit = cornerPitches(gt);
  const errsFor = (rot) => rotateQuad(r.pinCorners, rot).map((p, k) => Math.hypot(p[0] - gt[k][0], p[1] - gt[k][1]));
  const e0 = errsFor(0), e2 = errsFor(2);
  const m0 = Math.max(...e0.map((e, k) => e / pit[k])), m2 = Math.max(...e2.map((e, k) => e / pit[k]));
  const use = r.textFound || m0 <= m2 ? e0 : e2;
  const pins = use.map((e, k) => e / pit[k]);
  const maxPins = Math.max(...pins);
  return {
    found: true, px: use, pins, maxPins,
    textFound: r.textFound,
    orientationOk: r.textFound ? m0 <= m2 : null,
    correct: maxPins <= 1,
    falseAccept: maxPins > 2 || (r.textFound && m0 > m2),
  };
}
export const fmt = (a, d = 2) => a.map((v) => v.toFixed(d)).join(' ');
export const pct = (arr, q) => { if (!arr.length) return NaN; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))]; };

/** Decode one fixture JPEG to RGBA. */
export function decode(file) {
  return jpeg.decode(readFileSync(join(FRAMES, file)), { useTArray: true, maxMemoryUsageInMB: 2048 });
}

/** Integer box downscale of a luma image, and the matching point map. */
export function downscale(img, f) {
  if (f <= 1) return { img, map: (p) => p };
  const W = Math.floor(img.width / f), H = Math.floor(img.height / f);
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0;
    for (let b = 0; b < f; b++) for (let a = 0; a < f; a++) s += img.data[(y * f + b) * img.width + x * f + a];
    out[y * W + x] = Math.round(s / (f * f));
  }
  return { img: { data: out, width: W, height: H }, map: ([x, y]) => [(x + 0.5) / f - 0.5, (y + 0.5) / f - 0.5] };
}
export const unmap = (f) => ([x, y]) => [(x + 0.5) * f - 0.5, (y + 0.5) * f - 0.5];

export const GT = JSON.parse(readFileSync(join(FRAMES, 'ground_truth.json'), 'utf8')).frames;
const lumaCache = new Map();
/** Real frame as luma, PXL stills downscaled so the long side ≤ 1600 (f = 3). */
export function realLuma(file) {
  if (!lumaCache.has(file)) {
    const raw = decode(file);
    const full = { data: rgbaToGray(raw.data, raw.width, raw.height), width: raw.width, height: raw.height };
    const f = Math.max(1, Math.ceil(Math.max(raw.width, raw.height) / 1600));
    lumaCache.set(file, { full, f, ...downscale(full, f) });
  }
  return lumaCache.get(file);
}

/** Real source for augmentation: RGBA, with the PXL stills halved (pitch ≈ 12). */
const srcCache = new Map();
export function augSource(file) {
  if (!srcCache.has(file)) {
    const raw = decode(file);
    let rgba = raw.data, w = raw.width, h = raw.height, map = (p) => p;
    if (w * h > 4e6) {
      const W = w >> 1, H = h >> 1, out = new Uint8Array(W * H * 4);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let c = 0; c < 4; c++) {
        out[(y * W + x) * 4 + c] = (rgba[((2 * y) * w + 2 * x) * 4 + c] + rgba[((2 * y) * w + 2 * x + 1) * 4 + c]
          + rgba[((2 * y + 1) * w + 2 * x) * 4 + c] + rgba[((2 * y + 1) * w + 2 * x + 1) * 4 + c]) >> 2;
      }
      rgba = out; w = W; h = H; map = ([x, y]) => [(x + 0.5) / 2 - 0.5, (y + 0.5) / 2 - 0.5];
    }
    srcCache.set(file, { src: { data: rgba, width: w, height: h }, gt: GT[file].corners.map(map) });
  }
  return srcCache.get(file);
}

/** One augmented case, fully determined by its seed and split. */
export function augCase(seed, split) {
  const rand = rng(seed * 7919 + (split === 'tune' ? 13 : 7));
  const files = split === 'tune' ? Object.keys(GT).filter((f) => GT[f].split === 'tune') : Object.keys(GT);
  const file = rand.pick(files);
  const [W, H] = rand.pick([[640, 480], [1280, 720], [1920, 1080]]);
  const rotDeg = rand.uni(0, 360), tiltDeg = rand.uni(0, 40), tiltAxisDeg = rand.uni(0, 180);
  let pitchPx = Math.exp(rand.uni(Math.log(3), Math.log(20)));
  const photo = {
    cast: [rand.uni(0.8, 1.2), rand.uni(0.8, 1.2), rand.uni(0.8, 1.2)],
    gamma: Math.exp(rand.uni(Math.log(0.6), Math.log(1.6))),
    gain: null, gainDirDeg: rand.uni(0, 360), noise: rand.uni(0, 5),
  };
  const g0 = rand.uni(0.5, 1.1);
  photo.gain = [g0, g0 * rand.uni(1, 2.2)];
  const blurFrac = rand.uni(0, 0.12), quality = rand.int(40, 95);
  const { src, gt } = augSource(file);
  let out = null;
  for (let k = 0; k < 14 && !out; k++, pitchPx *= 0.87) {
    out = augmentReal(src, gt, rand, { width: W, height: H, pitchPx, rotDeg, tiltDeg, tiltAxisDeg }, photo);
  }
  if (!out) return null;
  let luma = { data: rgbaToGray(out.rgba, W, H), width: W, height: H };
  luma = blurLuma(luma, blurFrac * pitchPx);
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { rgba[4 * i] = rgba[4 * i + 1] = rgba[4 * i + 2] = luma.data[i]; rgba[4 * i + 3] = 255; }
  const dec = jpeg.decode(jpeg.encode({ data: rgba, width: W, height: H }, quality).data, { useTArray: true });
  return {
    img: { data: rgbaToGray(dec.data, W, H), width: W, height: H },
    gt: out.corners,
    desc: `${file.replace('.jpg', '')} ${W}×${H} p=${pitchPx.toFixed(1)} rot=${rotDeg.toFixed(0)} tilt=${tiltDeg.toFixed(0)} γ=${photo.gamma.toFixed(2)} gain=${photo.gain.map((v) => v.toFixed(2)).join('→')} q=${quality}`,
  };
}

