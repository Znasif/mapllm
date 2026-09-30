/**
 * Synthetic DOT Pad scenes for `test_dotpad_lattice.mjs` — seeded, no deps.
 *
 *   - {@link viewHomography}: a pinhole camera looking at the pad plane —
 *     pitch at the field centre, in-plane rotation, tilt about any in-plane
 *     axis (real perspective, so the pitch varies across the field), and a
 *     placement that keeps the pin field inside the frame.
 *   - {@link renderPad}: the device drawn procedurally in template coordinates
 *     (dotpad.png px) through that view: body, display window, 60 × 40 pins
 *     (optionally sparse / map-like, optionally invisible or saturated on one
 *     side), braille text line, a pop-it-like background, illumination ramp,
 *     clipping, noise.
 *   - {@link augmentReal}: a real frame + its ground-truth corners re-projected
 *     through a random new view, with colour cast, gamma, an exposure ramp that
 *     clips one side, blur and noise (JPEG round-trip is left to the caller).
 *   - {@link renderDistractor}: frames with NO pad — pop-it bubble grids, wrong-
 *     sized and hexagonal dot grids, braille-like text, checkerboards.
 *
 * Images are {data: Uint8Array (luma) | Uint8ClampedArray (RGBA), width, height}.
 */

import { DOTPAD_TEMPLATE, applyH, homography4 } from '../../src/lib/dotpadTemplate.js';
import { invert3 } from '../../src/lib/dotpadLattice.js';

const T = DOTPAD_TEMPLATE;
const P = T.pinPitchPx;
const [PX0, PY0] = T.pinCorners[0];
export const PIN_IDX = [[0, 0], [59, 0], [59, 39], [0, 39]];

/** Template px → pin units and back. */
const tplToPin = (u, v) => [(u - PX0) / P, (v - PY0) / P];
const pinToTpl = (c, r) => [PX0 + c * P, PY0 + r * P];

/** Deterministic PRNG helpers around a mulberry32 stream. */
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = {
    next,
    uni: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => Math.floor(lo + (hi - lo + 1) * next()),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    gauss: () => { const u = Math.max(1e-12, next()); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next()); },
  };
  return r;
}

const matMul3 = (A, B) => A.map((row) => [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));

/**
 * Pin (c, r) → image homography for a pinhole view of the pad.
 *
 * @param {{width: number, height: number, pitchPx: number, rotDeg?: number,
 *   tiltDeg?: number, tiltAxisDeg?: number, focal?: number, centre?: number[],
 *   rand?: ReturnType<typeof rng>, marginPins?: number}} v
 *   `centre` in image px (default: random placement that fits, via `rand`).
 * @returns {number[][]|null} null when the field cannot fit.
 */
export function viewHomography(v) {
  const { width: W, height: Hh, pitchPx, rotDeg = 0, tiltDeg = 0, tiltAxisDeg = 0 } = v;
  const f = v.focal ?? 0.9 * Math.max(W, Hh);
  const D = f / pitchPx;
  const rot = (rotDeg * Math.PI) / 180, tilt = (tiltDeg * Math.PI) / 180, ax = (tiltAxisDeg * Math.PI) / 180;
  const project = (c, r) => {
    // Pin units about the field centre, pad rotated on the table.
    let X = c - 29.5, Y = r - 19.5;
    [X, Y] = [X * Math.cos(rot) - Y * Math.sin(rot), X * Math.sin(rot) + Y * Math.cos(rot)];
    // Tilt about the in-plane axis at angle `ax`.
    const ux = Math.cos(ax), uy = Math.sin(ax);
    const along = X * ux + Y * uy, across = -X * uy + Y * ux;
    const acrossP = across * Math.cos(tilt), Z = across * Math.sin(tilt);
    const Xr = along * ux - acrossP * uy, Yr = along * uy + acrossP * ux;
    return [(f * Xr) / (D + Z), (f * Yr) / (D + Z)];
  };
  const src = [[-30, -30], [90, -30], [90, 70], [-30, 70]];
  const H0 = homography4(src, src.map(([c, r]) => project(c, r)));
  // Placement: the pin field ± marginPins must be inside the frame.
  const m = v.marginPins ?? 2;
  const ring = [[-m, -m], [59 + m, -m], [59 + m, 39 + m], [-m, 39 + m]].map((p) => applyH(H0, p));
  const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
  const lo = [-Math.min(...xs), -Math.min(...ys)], hi = [W - Math.max(...xs), Hh - Math.max(...ys)];
  if (lo[0] > hi[0] || lo[1] > hi[1]) return null;
  let centre = v.centre;
  if (!centre) {
    const r = v.rand;
    centre = r ? [r.uni(lo[0], hi[0]), r.uni(lo[1], hi[1])] : [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2];
  }
  return matMul3([[1, 0, centre[0]], [0, 1, centre[1]], [0, 0, 1]], H0);
}

/** Braille text: 20 cells of 2 × 4 dots, cell pitch ≈ 3.3 pins, inside the text window. */
function textDots(rand, fill = 0.55) {
  const dots = [];
  const cy0 = (T.textWindow[0][1] + T.textWindow[2][1]) / 2 - 1.5 * P;
  const x0 = T.textWindow[0][0] + 0.12 * (T.textWindow[1][0] - T.textWindow[0][0]);
  for (let cell = 0; cell < 20; cell++) {
    for (let a = 0; a < 2; a++) for (let b = 0; b < 4; b++) {
      if (rand.next() < fill) dots.push([x0 + cell * 3.3 * P + a * P, cy0 + b * P]);
    }
  }
  return dots;
}

const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

/**
 * Render a synthetic pad frame (luma).
 *
 * @param {object} o
 * @param {number} o.width
 * @param {number} o.height
 * @param {number[][]} o.Hpin      pin (c, r) → image.
 * @param {number} [o.seed]
 * @param {number} [o.windowGrey]  display surface (default 150).
 * @param {number} [o.bodyGrey]    device body (default 40).
 * @param {number} [o.pinGrey]     raised pin top (default 235).
 * @param {number} [o.holeGrey]    lowered pin (default: same as raised → uniform).
 * @param {number} [o.raisedFrac]  fraction of pins raised in map-like blobs (default 1).
 * @param {boolean} [o.holesVisible] lowered pins still drawn as holes (default true).
 * @param {number} [o.hideCols]    left-most columns not drawn at all (washed out).
 * @param {boolean} [o.text]       braille text line (default true).
 * @param {boolean} [o.popit]      pop-it bubbles as background (default true).
 * @param {number[]} [o.gain]      [g0, g1]: exposure ramp across `gainDirDeg`.
 * @param {number} [o.gainDirDeg]
 * @param {number} [o.noise]       Gaussian σ, grey levels.
 */
export function renderPad(o) {
  const { width: W, height: Hh, Hpin } = o;
  const rand = rng(o.seed ?? 1);
  const windowGrey = o.windowGrey ?? 150, bodyGrey = o.bodyGrey ?? 40, pinGrey = o.pinGrey ?? 235;
  const holeGrey = o.holeGrey ?? pinGrey;
  const raisedFrac = o.raisedFrac ?? 1;
  const holesVisible = o.holesVisible ?? true;
  const hideCols = o.hideCols ?? 0;
  const [g0, g1] = o.gain ?? [1, 1];
  const gd = ((o.gainDirDeg ?? 0) * Math.PI) / 180;
  const noise = o.noise ?? 2;

  // Template px → image, and back.
  const Htpl = matMul3(Hpin, [[1 / P, 0, -PX0 / P], [0, 1 / P, -PY0 / P], [0, 0, 1]]);
  const Hinv = invert3(Htpl);
  const imgPerTpl = Math.hypot(...[0, 1].map((k) => applyH(Htpl, [PX0 + 1, PY0])[k] - applyH(Htpl, [PX0, PY0])[k]));
  const soft = 0.7 / Math.max(1e-3, imgPerTpl); // ≈ 0.7 image px, in template px

  // Map-like raised pattern: a few random discs in pin space.
  const blobs = Array.from({ length: 6 }, () => [rand.uni(0, 59), rand.uni(0, 39), rand.uni(4, 12)]);
  const raised = new Uint8Array(60 * 40);
  for (let c = 0; c < 60; c++) for (let r = 0; r < 40; r++) {
    let on = raisedFrac >= 1;
    if (!on) on = blobs.some(([bc, br, rad]) => Math.hypot(c - bc, r - br) < rad * Math.sqrt(raisedFrac * 2));
    raised[r * 60 + c] = on ? 1 : 0;
  }
  const tdots = o.text === false ? [] : textDots(rand);
  const bez = T.bezel;
  const body = [bez[0][0] - 25, bez[0][1] - 18, bez[1][0] + 25, T.textWindow[2][1] + 18];
  const popPitch = rand.uni(35, 60), popPhase = [rand.uni(0, 60), rand.uni(0, 60)];
  const popBase = [rand.uni(120, 220), rand.uni(120, 220)];

  const out = new Uint8Array(W * Hh);
  for (let y = 0; y < Hh; y++) {
    for (let x = 0; x < W; x++) {
      const [u, v] = applyH(Hinv, [x, y]);
      let g;
      const inBody = u > body[0] && u < body[2] && v > body[1] && v < body[3];
      if (!inBody) {
        if (o.popit === false) g = 110;
        else {
          // Pop-it: bubbles on a grid in IMAGE space, bright rim, dark centre.
          const bx = ((x + popPhase[0]) % popPitch) - popPitch / 2, by = ((y + popPhase[1]) % popPitch) - popPitch / 2;
          const d = Math.hypot(bx, by) / (popPitch / 2);
          const band = Math.floor((y + popPhase[1]) / (popPitch * 3)) % 2;
          g = popBase[band] + 35 * Math.exp(-((d - 0.8) ** 2) / 0.01) - 30 * (d < 0.5 ? 1 - d / 0.5 : 0);
        }
      } else {
        g = bodyGrey;
        const dw = T.displayWindow, tw = T.textWindow;
        if (u > dw[0][0] && u < dw[1][0] && v > dw[0][1] && v < dw[2][1]) {
          g = windowGrey;
          const [pc, pr] = tplToPin(u, v);
          const c = Math.round(pc), r = Math.round(pr);
          if (c >= hideCols && c < 60 && r >= 0 && r < 40) {
            const [cu, cv] = pinToTpl(c, r);
            const d = Math.hypot(u - cu, v - cv);
            const isUp = raised[r * 60 + c] === 1;
            if (isUp || holesVisible) {
              const a = 1 - smooth(0.3 * P - soft, 0.3 * P + soft, d);
              g = g * (1 - a) + (isUp ? pinGrey : holeGrey) * a;
            }
          }
        } else if (u > tw[0][0] && u < tw[1][0] && v > tw[0][1] && v < tw[2][1]) {
          g = windowGrey - 10;
          for (const [du, dv] of tdots) {
            const d = Math.hypot(u - du, v - dv);
            if (d < 0.3 * P + soft) g = g * smooth(0.3 * P - soft, 0.3 * P + soft, d) + pinGrey * (1 - smooth(0.3 * P - soft, 0.3 * P + soft, d));
          }
        }
      }
      const tt = ((x / W - 0.5) * Math.cos(gd) + (y / Hh - 0.5) * Math.sin(gd)) + 0.5;
      g *= g0 + (g1 - g0) * Math.min(1, Math.max(0, tt));
      g += noise * rand.gauss();
      out[y * W + x] = Math.max(0, Math.min(255, Math.round(g)));
    }
  }
  return { data: out, width: W, height: Hh };
}

/** Pin-corner ground truth of a view. */
export const cornersOf = (Hpin) => PIN_IDX.map((p) => applyH(Hpin, p));

/* ------------------------------------------------------- real augmentation -- */

/** Separable Gaussian blur of a luma buffer (σ in px); returns a new Uint8Array. */
export function blurLuma(img, sigma) {
  if (!(sigma > 0.2)) return img;
  const { data, width: W, height: Hh } = img;
  const r = Math.ceil(3 * sigma);
  const k = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
  const ks = k.reduce((a, b) => a + b, 0);
  const tmp = new Float32Array(W * Hh);
  for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += k[i + r] * data[y * W + Math.min(W - 1, Math.max(0, x + i))];
    tmp[y * W + x] = s / ks;
  }
  const out = new Uint8Array(W * Hh);
  for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += k[i + r] * tmp[Math.min(Hh - 1, Math.max(0, y + i)) * W + x];
    out[y * W + x] = Math.round(s / ks);
  }
  return { data: out, width: W, height: Hh };
}

/**
 * Re-project a real RGBA frame through a new random view.
 *
 * @param {{data: Uint8Array, width: number, height: number}} src  RGBA.
 * @param {number[][]} gt   TL,TR,BR,BL in src px.
 * @param {ReturnType<typeof rng>} rand
 * @param {{width: number, height: number, pitchPx: number, rotDeg: number,
 *   tiltDeg: number, tiltAxisDeg: number}} view
 * @param {{cast: number[], gamma: number, gain: number[], gainDirDeg: number, noise: number}} photo
 * @returns {{rgba: Uint8ClampedArray, width: number, height: number, corners: number[][]} | null}
 */
export function augmentReal(src, gt, rand, view, photo) {
  const Hdst = viewHomography({ ...view, rand });
  if (!Hdst) return null;
  const Hsrc = homography4(PIN_IDX, gt);             // pin → src
  const M = matMul3(Hsrc, invert3(Hdst));             // dst px → src px
  const { width: W, height: Hh } = view;
  const out = new Uint8ClampedArray(W * Hh * 4);
  const sw = src.width, sh = src.height, sd = src.data;
  const gd = (photo.gainDirDeg * Math.PI) / 180;
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) lut[i] = 255 * (i / 255) ** photo.gamma;
  for (let y = 0; y < Hh; y++) {
    for (let x = 0; x < W; x++) {
      const w = M[2][0] * x + M[2][1] * y + M[2][2];
      let sx = (M[0][0] * x + M[0][1] * y + M[0][2]) / w;
      let sy = (M[1][0] * x + M[1][1] * y + M[1][2]) / w;
      sx = Math.min(sw - 1.001, Math.max(0, sx)); sy = Math.min(sh - 1.001, Math.max(0, sy));
      const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
      const o = (y0 * sw + x0) * 4;
      const tt = ((x / W - 0.5) * Math.cos(gd) + (y / Hh - 0.5) * Math.sin(gd)) + 0.5;
      const gain = photo.gain[0] + (photo.gain[1] - photo.gain[0]) * Math.min(1, Math.max(0, tt));
      for (let ch = 0; ch < 3; ch++) {
        const v = (sd[o + ch] * (1 - fx) + sd[o + 4 + ch] * fx) * (1 - fy)
          + (sd[o + sw * 4 + ch] * (1 - fx) + sd[o + sw * 4 + 4 + ch] * fx) * fy;
        const g = lut[Math.max(0, Math.min(255, Math.round(v)))] * gain * photo.cast[ch] + photo.noise * rand.gauss();
        out[(y * W + x) * 4 + ch] = g;
      }
      out[(y * W + x) * 4 + 3] = 255;
    }
  }
  return { rgba: out, width: W, height: Hh, corners: cornersOf(Hdst) };
}

/* ------------------------------------------------------------ distractors -- */

/**
 * A frame with NO DOT Pad in it.
 *
 * @param {'popit'|'grid-small'|'grid-large'|'grid-near'|'hex'|'braille'|'checker'} kind
 */
export function renderDistractor(kind, { width: W, height: Hh, seed = 1 }) {
  const rand = rng(seed);
  const out = new Uint8Array(W * Hh);
  const bg = rand.uni(60, 180);
  const pitch = rand.uni(4, 18);
  const rot = rand.uni(0, Math.PI);
  const cs = Math.cos(rot), sn = Math.sin(rot);
  let dims = null;
  if (kind === 'grid-small') dims = [rand.int(15, 45), rand.int(10, 28)];
  if (kind === 'grid-large') dims = [rand.int(75, 120), rand.int(55, 90)];
  // Within reach of 60 × 40 by "missing lines", but with no display window around it.
  if (kind === 'grid-near') dims = [rand.int(51, 57), rand.int(32, 37)];
  if (kind === 'hex') dims = [rand.int(55, 66), rand.int(38, 50)];
  const text = kind === 'braille' ? Array.from({ length: 12 }, () => textDots(rand, 0.6)) : null;
  for (let y = 0; y < Hh; y++) {
    for (let x = 0; x < W; x++) {
      let g = bg;
      const X = (x - W / 2) * cs + (y - Hh / 2) * sn, Y = -(x - W / 2) * sn + (y - Hh / 2) * cs;
      if (kind === 'popit') {
        const pp = 3 * pitch;
        const bx = ((X % pp) + pp) % pp - pp / 2, by = ((Y % pp) + pp) % pp - pp / 2;
        const d = Math.hypot(bx, by) / (pp / 2);
        g += 50 * Math.exp(-((d - 0.8) ** 2) / 0.01) - 35 * (d < 0.5 ? 1 - d / 0.5 : 0) + 25 * Math.exp(-(((bx + 0.2 * pp) ** 2 + (by + 0.2 * pp) ** 2) / (0.01 * pp * pp)));
      } else if (dims) {
        let c = X / pitch + dims[0] / 2, r = Y / pitch + dims[1] / 2;
        if (kind === 'hex') { r = Y / (pitch * 0.866) + dims[1] / 2; c -= 0.5 * (Math.round(r) % 2); }
        const ci = Math.round(c), ri = Math.round(r);
        if (ci >= 0 && ci < dims[0] && ri >= 0 && ri < dims[1]) {
          const d = Math.hypot(c - ci, (r - ri) * (kind === 'hex' ? 0.866 : 1)) * pitch;
          g += 90 * (1 - smooth(0.3 * pitch - 0.7, 0.3 * pitch + 0.7, d));
        }
      } else if (kind === 'braille') {
        // 12 lines of braille cells at pitch/P scale, stacked.
        const s = pitch / P;
        const line = Math.floor((Y / s + 400) / 30);
        const dots = text[((line % 12) + 12) % 12];
        const u = X / s + 160, v = ((Y / s + 400) % 30) + T.textWindow[0][1];
        for (const [du, dv] of dots) if (Math.abs(u - du) < P && Math.abs(v - dv) < P && Math.hypot(u - du, v - dv) < 0.3 * P) g += 90;
      } else if (kind === 'checker') {
        g += ((Math.floor(X / (2 * pitch)) + Math.floor(Y / (2 * pitch))) & 1) ? 70 : -40;
      }
      out[y * W + x] = Math.max(0, Math.min(255, Math.round(g + 2 * rand.gauss())));
    }
  }
  return { data: out, width: W, height: Hh };
}

/**
 * Paint the pin field (± `grow` pitches) of a real frame with the surrounding
 * display-window grey: a REAL negative (mat, bezel, text line, cables remain).
 */
export function erasePinField(gray, corners, grow = 1.2) {
  const { data, width: W, height: Hh } = gray;
  const Hs = homography4(PIN_IDX, corners);
  const Hi = invert3(Hs);
  const out = new Uint8Array(data);
  // Window grey: median of a ring 2–3.5 pitches outside the field.
  const ring = [];
  for (let k = 0; k < 400; k++) {
    const t = k / 400;
    const side = k % 4, d = 2 + 1.5 * ((k * 7) % 10) / 10;
    const p = side === 0 ? [t * 59, -d] : side === 1 ? [59 + d, t * 39] : side === 2 ? [t * 59, 39 + d] : [-d, t * 39];
    const [x, y] = applyH(Hs, p).map(Math.round);
    if (x >= 0 && y >= 0 && x < W && y < Hh) ring.push(data[y * W + x]);
  }
  ring.sort((a, b) => a - b);
  const fill = ring.length ? ring[ring.length >> 1] : 128;
  for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
    const [c, r] = applyH(Hi, [x, y]);
    if (c > -grow && c < 59 + grow && r > -grow && r < 39 + grow) out[y * W + x] = fill;
  }
  return { data: out, width: W, height: Hh };
}
