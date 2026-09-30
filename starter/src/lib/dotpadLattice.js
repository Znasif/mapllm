/**
 * DOT Pad auto-find from the PIN LATTICE itself.
 *
 * Why not the display-window quad (`selectDevice`): on a real top-down camera
 * the light display area carries a strong illumination gradient, so a global
 * threshold splits it mid-field and Canny drowns in 2,400 dot edges — the
 * window never becomes a clean 4-vertex contour. The 60 × 40 dot lattice, on
 * the other hand, is the most distinctive thing in the frame: a few thousand
 * small blobs on a near-square grid. This module finds that grid, indexes it,
 * fits a homography pin-index → pixel with every dot, and uses the KNOWN
 * geometry (exactly 60 × 40, the braille text line below the long edge) to
 * settle the extent and which corner is top-left.
 *
 * Pipeline ({@link detectDotpadLattice}; {@link latticeSearch} is the same
 * search as a generator that yields between steps):
 *   0. Scale: nothing is in pixels. A pyramid (2× down; 2× up on small frames)
 *      and two working-pitch hypotheses per level; the first lattice found
 *      MEASURES the pitch, and everything is re-run with kernels, windows and
 *      tolerances sized to it (pitch ≈ 3 … 50 px).
 *   1. Dot response, illumination-normalised: DoG = G(σd) − G(σb), divided by
 *      its local RMS, so a dim corner and a nearly-saturated side score alike.
 *      Peaks: strict local maxima that pass a Hessian blob test (rims, edges
 *      and cables are ridges), with contrast floors scaled to the frame's own
 *      noise; "strong" ones build the lattice, "weak" ones only fill positions
 *      the fitted lattice predicts.
 *   2. Lattice basis from the 4 nearest neighbours of every dot (pitch = mode
 *      of the NN distance, two dominant directions from an angle histogram —
 *      per axis, so foreshortening is fine).
 *   3. BFS over unit lattice steps (local basis carried along, so perspective
 *      is tolerated) → integer (i, j) per dot; largest component wins (drops
 *      the braille text line, pop-it mat highlights, specular noise).
 *   4. Homography (i, j) → px, least squares over all members with outlier
 *      rejection in index space; grow/trim one row/column at a time by
 *      occupancy.
 *   5. Extent → exactly 60 × 40. Columns/rows that were not detected (a fully
 *      saturated side has no dots to find) are added on the side the display
 *      window says they belong: the window edge sits ~4.5 pitches beyond the
 *      corner-pin centres on every side, so the split that equalises the two
 *      margins wins, and an extended side must then read ≈ 4.5. No usable
 *      evidence → null, never a guess.
 *   6. Validation gate: members, coverage of the 2,400 predicted pins, fit
 *      residual, dotted corners, blank lines just outside, isolated blobs (not
 *      the gaps between pins). Any failure → null.
 *   7. Orientation: the long axis is the 60-pin one (resolves 90°); braille-
 *      like dots in the text-line band below the bottom edge (template rows
 *      ≈ 57–64) versus the mirrored band above resolve 180°. Undecided →
 *      `needsConfirm` (the component asks for one touch on the top-left pin).
 *
 * PLATFORM-FREE: plain typed arrays, no OpenCV, no DOM — tested headlessly by
 * `scripts/test_dotpad_lattice.mjs` on synthetic scenes, real webcam and phone
 * frames, and an augmented held-out set built from them.
 * Corner convention matches `dotpadTemplate.js`: TL, TR, BR, BL corner-PIN
 * CENTRES in image pixels; pin (c, r) = H · (c, r, 1), c ∈ 0..59, r ∈ 0..39.
 */

import { DOTPAD_TEMPLATE, applyH, homography4, rotateQuad } from './dotpadTemplate.js';

const COLS = DOTPAD_TEMPLATE.cols; // 60 — long axis
const ROWS = DOTPAD_TEMPLATE.rows; // 40

/* Template-derived geometry, in pin pitches (dotpad.png: pitch 3.3335 px). */
const TPL = DOTPAD_TEMPLATE;
const PITCH_T = TPL.pinPitchPx;
/** Corner-pin centre → display-window edge, mean over the four sides (≈ 4.5). */
const WINDOW_MARGIN = (
  (TPL.pinCorners[0][0] - TPL.displayWindow[0][0])
  + (TPL.displayWindow[1][0] - TPL.pinCorners[1][0])
  + (TPL.pinCorners[0][1] - TPL.displayWindow[0][1])
  + (TPL.displayWindow[2][1] - TPL.pinCorners[2][1])
) / 4 / PITCH_T;
/** Braille text window in pin rows below the top pin row (≈ 57.3 … 63.6). */
const TEXT_R0 = (TPL.textWindow[0][1] - TPL.pinCorners[0][1]) / PITCH_T;
const TEXT_R1 = (TPL.textWindow[2][1] - TPL.pinCorners[0][1]) / PITCH_T;
const TEXT_C0 = (TPL.textWindow[0][0] - TPL.pinCorners[0][0]) / PITCH_T;
const TEXT_C1 = (TPL.textWindow[1][0] - TPL.pinCorners[0][0]) / PITCH_T;

/* ------------------------------------------------------------ small maths -- */

const hypot = Math.hypot;

function matMul3(A, B) {
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    C[r][c] = A[r][0] * B[0][c] + A[r][1] * B[1][c] + A[r][2] * B[2][c];
  }
  return C;
}

/** 3×3 inverse (adjugate / determinant). */
export function invert3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-18) throw new RangeError('invert3: singular');
  const s = 1 / det;
  return [
    [A * s, -(b * i - c * h) * s, (b * f - c * e) * s],
    [B * s, (a * i - c * g) * s, -(a * f - c * d) * s],
    [C * s, -(a * h - b * g) * s, (a * e - b * d) * s],
  ];
}

/** Solve the n×n system A·x = b in place (partial pivoting). */
function solve(A, b) {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (Math.abs(A[piv][c]) < 1e-12) return null;
    [A[c], A[piv]] = [A[piv], A[c]];
    [b[c], b[piv]] = [b[piv], b[c]];
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      if (f === 0) continue;
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
    x[r] = s / A[r][r];
  }
  return x;
}

/** Similarity that moves the centroid to 0 and the mean distance to √2 (Hartley). */
function normaliser(pts) {
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p[0]; cy += p[1]; }
  cx /= pts.length; cy /= pts.length;
  let d = 0;
  for (const p of pts) d += hypot(p[0] - cx, p[1] - cy);
  const s = Math.SQRT2 / (d / pts.length || 1);
  return [[s, 0, -s * cx], [0, s, -s * cy], [0, 0, 1]];
}

/**
 * Least-squares homography `H·src[k] ∝ dst[k]` over N ≥ 4 pairs (normalised
 * DLT with h33 = 1, normal equations). Returns null when degenerate.
 *
 * @param {number[][]} src
 * @param {number[][]} dst
 * @returns {number[][]|null}
 */
export function fitHomography(src, dst) {
  if (src.length < 4) return null;
  const Ts = normaliser(src);
  const Td = normaliser(dst);
  const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const Atb = new Array(8).fill(0);
  const row = new Array(8);
  const acc = (r, rhs) => {
    for (let a = 0; a < 8; a++) {
      if (r[a] === 0) continue;
      Atb[a] += r[a] * rhs;
      for (let b = 0; b < 8; b++) AtA[a][b] += r[a] * r[b];
    }
  };
  for (let k = 0; k < src.length; k++) {
    const [u, v] = applyH(Ts, src[k]);
    const [x, y] = applyH(Td, dst[k]);
    row[0] = u; row[1] = v; row[2] = 1; row[3] = 0; row[4] = 0; row[5] = 0; row[6] = -u * x; row[7] = -v * x;
    acc(row, x);
    row[0] = 0; row[1] = 0; row[2] = 0; row[3] = u; row[4] = v; row[5] = 1; row[6] = -u * y; row[7] = -v * y;
    acc(row, y);
  }
  const h = solve(AtA, Atb);
  if (!h || !h.every(Number.isFinite)) return null;
  const Hn = [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1]];
  let H;
  try { H = matMul3(invert3(Td), matMul3(Hn, Ts)); } catch { return null; }
  const s = H[2][2];
  return H.map((r) => r.map((x) => x / s));
}

/* ------------------------------------------------------------ image ops -- */

/** RGBA (canvas ImageData) → 8-bit luma. */
export function rgbaToGray(rgba, width, height) {
  const n = width * height;
  const out = new Uint8Array(n);
  for (let i = 0, k = 0; i < n; i++, k += 4) {
    out[i] = (rgba[k] * 77 + rgba[k + 1] * 150 + rgba[k + 2] * 29) >> 8;
  }
  return out;
}

/** Box radii of three passes approximating a Gaussian of `sigma` (Kovesi). */
function boxRadii(sigma) {
  const n = 3;
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl -= 1;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  return Array.from({ length: n }, (_, i) => ((i < m ? wl : wu) - 1) / 2);
}

/** One separable box pass of radius r, edges clamped. `src` and `dst` may not alias. */
function boxBlur(src, dst, w, h, r, tmp) {
  if (r <= 0) { dst.set(src); return; }
  const inv = 1 / (2 * r + 1);
  // Horizontal: src → tmp.
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let acc = (r + 1) * src[o];
    for (let k = 1; k <= r; k++) acc += src[o + Math.min(k, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[o + x] = acc * inv;
      acc += src[o + Math.min(x + r + 1, w - 1)] - src[o + Math.max(x - r, 0)];
    }
  }
  // Vertical: tmp → dst, one accumulator per column (row-major friendly).
  const acc = new Float64Array(w);
  for (let x = 0; x < w; x++) {
    let a = (r + 1) * tmp[x];
    for (let k = 1; k <= r; k++) a += tmp[Math.min(k, h - 1) * w + x];
    acc[x] = a;
  }
  for (let y = 0; y < h; y++) {
    const o = y * w;
    const add = Math.min(y + r + 1, h - 1) * w;
    const sub = Math.max(y - r, 0) * w;
    for (let x = 0; x < w; x++) {
      dst[o + x] = acc[x] * inv;
      acc[x] += tmp[add + x] - tmp[sub + x];
    }
  }
}

/** Gaussian blur approximated by three box passes. Returns a new Float32Array. */
function gaussBlur(src, w, h, sigma) {
  const a = new Float32Array(src);
  const b = new Float32Array(w * h);
  const tmp = new Float32Array(w * h);
  let cur = a, nxt = b;
  for (const r of boxRadii(sigma)) {
    boxBlur(cur, nxt, w, h, r, tmp);
    [cur, nxt] = [nxt, cur];
  }
  return cur;
}

/** Bilinear sample; NaN outside the image. */
function sample(img, w, h, x, y) {
  if (!(x >= 0 && y >= 0 && x <= w - 1 && y <= h - 1)) return NaN;
  const x0 = Math.min(Math.floor(x), w - 2), y0 = Math.min(Math.floor(y), h - 2);
  const fx = x - x0, fy = y - y0;
  const o = y0 * w + x0;
  return (img[o] * (1 - fx) + img[o + 1] * fx) * (1 - fy) + (img[o + w] * (1 - fx) + img[o + w + 1] * fx) * fy;
}

/**
 * Illumination-normalised dot response and its local maxima.
 *
 * D = G(σd) − G(σb) is positive on a bright dot and ~0 on flat surface of any
 * brightness; N = D / (local RMS of D + ε) equalises dim and washed-out parts
 * of the field. A peak is a strict local maximum of N in a (2r+1)² window with
 * N ≥ nWeak and D ≥ the weak contrast floor; it is "strong" above the strong
 * pair. The contrast floors scale with the frame's own noise (robust σ of D),
 * so a grainy low-light frame does not flood the lattice search with noise.
 */
function dotPeaks(f, w, h, pitchHint, t) {
  const n = w * h;
  // Every kernel is a fixed fraction of the pitch hypothesis: dot ≈ 0.2 p,
  // background ≈ 0.55 p, RMS window ≈ 3 p, peak separation ≈ 0.6 p.
  const sd = Math.max(0.75, 0.2 * pitchHint);
  const sb = 0.55 * pitchHint;
  const g1 = gaussBlur(f, w, h, sd);
  const g2 = gaussBlur(f, w, h, sb);
  const D = new Float32Array(n);
  for (let i = 0; i < n; i++) D[i] = g1[i] - g2[i];
  // Noise σ of D: pixel noise (Immerkær: the 3 × 3 kernel [1 −2 1; −2 4 −2;
  // 1 −2 1] has gain 6 on white noise; median-based so edges and smooth
  // texture such as pop-it rims do not count) times the DoG's white-noise gain.
  const smp = [];
  for (let y = 1; y < h - 1; y += 3) {
    for (let x = 1 + (y % 7); x < w - 1; x += 7) {
      const i = y * w + x;
      const v = f[i - w - 1] - 2 * f[i - w] + f[i - w + 1] - 2 * f[i - 1] + 4 * f[i] - 2 * f[i + 1]
        + f[i + w - 1] - 2 * f[i + w] + f[i + w + 1];
      smp.push(Math.abs(v));
    }
  }
  smp.sort((a, b) => a - b);
  const pixNoise = (1.4826 * (smp[smp.length >> 1] || 0)) / 6;
  const gain = Math.sqrt(Math.max(0, 1 / (4 * Math.PI * sd * sd) + 1 / (4 * Math.PI * sb * sb) - 1 / (Math.PI * (sd * sd + sb * sb))));
  const sigma = pixNoise * gain;
  const dWeak = Math.max(t.dWeak, t.kWeak * sigma);
  const dStrong = Math.max(t.dStrong, t.kStrong * sigma);
  // Local RMS of D over ~3 pitches.
  const D2 = new Float32Array(n);
  for (let i = 0; i < n; i++) D2[i] = D[i] * D[i];
  const E = new Float32Array(n);
  boxBlur(D2, E, w, h, Math.max(2, Math.round(1.5 * pitchHint)), new Float32Array(n));
  const N = D2; // reuse
  for (let i = 0; i < n; i++) N[i] = D[i] / (Math.sqrt(E[i]) + t.eps);

  const r = Math.max(1, Math.round(0.3 * pitchHint));
  const xs = [], ys = [], strong = [];
  for (let y = r; y < h - r; y++) {
    for (let x = r; x < w - r; x++) {
      const i = y * w + x;
      const v = N[i];
      if (v < t.nWeak || D[i] < dWeak) continue;
      let isMax = true;
      for (let dy = -r; dy <= r && isMax; dy++) {
        const o = i + dy * w;
        for (let dx = -r; dx <= r; dx++) {
          if (dx === 0 && dy === 0) continue;
          const u = N[o + dx];
          // Strict against earlier pixels, non-strict against later ones: plateaus yield one peak.
          if (u > v || (u === v && (dy < 0 || (dy === 0 && dx < 0)))) { isMax = false; break; }
        }
      }
      if (!isMax) continue;
      const l = N[i - 1], rr = N[i + 1], u = N[i - w], d = N[i + w];
      const cx = l - 2 * v + rr, cy = u - 2 * v + d;
      // Blob, not ridge: both curvatures negative and not too unequal (the
      // SIFT edge test on the Hessian). Rims, edges and lines fail here.
      const cxy = (N[i - w - 1] + N[i + w + 1] - N[i - w + 1] - N[i + w - 1]) / 4;
      const det = cx * cy - cxy * cxy;
      if (!(cx < 0 && cy < 0 && det > 0) || ((cx + cy) ** 2) / det > t.edgeRatio) continue;
      // Sub-pixel: parabola through the 3-tap neighbourhood on each axis.
      const ox = cx < 0 ? Math.max(-0.5, Math.min(0.5, (l - rr) / (2 * cx))) : 0;
      const oy = cy < 0 ? Math.max(-0.5, Math.min(0.5, (u - d) / (2 * cy))) : 0;
      xs.push(x + ox); ys.push(y + oy);
      strong.push(v >= t.nStrong && D[i] >= dStrong ? 1 : 0);
    }
  }
  return { xs, ys, strong, N, bg: g2, noise: sigma };
}

/**
 * Blob-ness of the fitted lattice: median N at the pin centres vs. at the
 * midpoints between neighbouring pins. Real dots are isolated (midpoints are
 * background, N < 0); the lattice of GAPS between densely packed dots — what
 * the inverted-polarity pass sees — is joined by channels, so its midpoints
 * respond almost as strongly as its "centres". Returns midpoint / centre.
 */
function midpointRatio(N, w, h, H, ext) {
  const pin = [], mid = [];
  for (let i = ext.i0; i <= ext.i1; i++) {
    for (let j = ext.j0; j <= ext.j1; j++) {
      const p = applyH(H, [i, j]);
      const v = sample(N, w, h, p[0], p[1]);
      if (Number.isFinite(v)) pin.push(v);
      if (i < ext.i1) { const q = applyH(H, [i + 0.5, j]); const m = sample(N, w, h, q[0], q[1]); if (Number.isFinite(m)) mid.push(m); }
      if (j < ext.j1) { const q = applyH(H, [i, j + 0.5]); const m = sample(N, w, h, q[0], q[1]); if (Number.isFinite(m)) mid.push(m); }
    }
  }
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
  const mp = med(pin);
  return mp > 0 ? med(mid) / mp : Infinity;
}

/* --------------------------------------------------------- spatial grid -- */

function makeGrid(xs, ys, cell) {
  const map = new Map();
  for (let k = 0; k < xs.length; k++) {
    const key = Math.floor(xs[k] / cell) * 65536 + Math.floor(ys[k] / cell);
    let arr = map.get(key);
    if (!arr) { arr = []; map.set(key, arr); }
    arr.push(k);
  }
  return {
    /** Indices within `rad` of (x, y), excluding `self`. */
    near(x, y, rad, self = -1) {
      const out = [];
      const cx0 = Math.floor((x - rad) / cell), cx1 = Math.floor((x + rad) / cell);
      const cy0 = Math.floor((y - rad) / cell), cy1 = Math.floor((y + rad) / cell);
      for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
        const arr = map.get(cx * 65536 + cy);
        if (!arr) continue;
        for (const k of arr) {
          if (k !== self && hypot(xs[k] - x, ys[k] - y) <= rad) out.push(k);
        }
      }
      return out;
    },
  };
}

/* ------------------------------------------------------ lattice structure -- */

/** Pitch = mode of the nearest-neighbour distance, refined by a median. */
function estimatePitch(xs, ys, idx, grid, maxR) {
  const d1 = [];
  for (const k of idx) {
    let best = Infinity;
    for (const q of grid.near(xs[k], ys[k], maxR, k)) {
      const d = hypot(xs[q] - xs[k], ys[q] - ys[k]);
      if (d < best) best = d;
    }
    if (best < Infinity && best >= 2) d1.push(best);
  }
  if (d1.length < 20) return null;
  const bin = 0.25;
  const hist = new Float64Array(Math.ceil(maxR / bin) + 2);
  for (const d of d1) hist[Math.floor(d / bin)] += 1;
  let bestB = 0, bestV = -1;
  for (let b = 1; b < hist.length - 1; b++) {
    const v = hist[b - 1] + hist[b] + hist[b + 1];
    if (v > bestV) { bestV = v; bestB = b; }
  }
  const mode = (bestB + 0.5) * bin;
  const near = d1.filter((d) => d > 0.8 * mode && d < 1.25 * mode).sort((a, b) => a - b);
  return near.length ? near[near.length >> 1] : mode;
}

/**
 * The two dominant NN displacement directions → basis vectors a, b with
 * a × b > 0 in y-down image space (so +i then +j turns clockwise on screen).
 */
function estimateBasis(xs, ys, idx, grid, pitch) {
  const bins = 180;
  const hist = new Float64Array(bins);
  const vecs = [];
  for (const k of idx) {
    // The 4 nearest neighbours: the axis steps even under strong foreshortening
    // (a 40° tilt makes one axis ~1.3× the other; the diagonal is then ~1.6×).
    const nb = grid.near(xs[k], ys[k], 1.7 * pitch, k)
      .map((q) => [q, hypot(xs[q] - xs[k], ys[q] - ys[k])])
      .sort((p, q) => p[1] - q[1])
      .slice(0, 4);
    for (const [q, len] of nb) {
      const dx = xs[q] - xs[k], dy = ys[q] - ys[k];
      if (len < 0.7 * pitch || len > 1.6 * pitch) continue;
      let th = Math.atan2(dy, dx);
      if (th < 0) th += Math.PI;
      if (th >= Math.PI) th -= Math.PI;
      hist[Math.floor((th / Math.PI) * bins) % bins] += 1;
      vecs.push([dx, dy, th, len]);
    }
  }
  if (vecs.length < 40) return null;
  const smooth = (b) => { let s = 0; for (let o = -2; o <= 2; o++) s += hist[(b + o + bins) % bins]; return s; };
  let b1 = 0;
  for (let b = 1; b < bins; b++) if (smooth(b) > smooth(b1)) b1 = b;
  let b2 = -1;
  for (let b = 0; b < bins; b++) {
    const sep = Math.min(Math.abs(b - b1), bins - Math.abs(b - b1));
    if (sep < 35) continue;
    if (b2 < 0 || smooth(b) > smooth(b2)) b2 = b;
  }
  if (b2 < 0 || smooth(b2) < 0.15 * smooth(b1)) return null;

  const refine = (bin) => {
    const th0 = ((bin + 0.5) / bins) * Math.PI;
    const ux = Math.cos(th0), uy = Math.sin(th0);
    let sx = 0, sy = 0;
    const lens = [];
    for (const [dx, dy, th, len] of vecs) {
      let dth = Math.abs(th - th0);
      dth = Math.min(dth, Math.PI - dth);
      if (dth > (10 * Math.PI) / 180) continue;
      const sgn = dx * ux + dy * uy >= 0 ? 1 : -1;
      sx += (sgn * dx) / len; sy += (sgn * dy) / len;
      lens.push(len);
    }
    if (lens.length < 10) return null;
    lens.sort((p, q) => p - q);
    const L = lens[lens.length >> 1];
    const n = hypot(sx, sy);
    return [(sx / n) * L, (sy / n) * L];
  };
  let a = refine(b1);
  let b = refine(b2);
  if (!a || !b) return null;
  // Make a the more horizontal one (cosmetic) and fix handedness.
  if (Math.abs(b[0]) > Math.abs(a[0])) [a, b] = [b, a];
  if (a[0] < 0) a = [-a[0], -a[1]];
  if (a[0] * b[1] - a[1] * b[0] < 0) b = [-b[0], -b[1]];
  return { a, b };
}

/**
 * BFS over unit lattice steps from every well-connected seed; returns the
 * largest component as [pointIndex, i, j] triples.
 */
function largestComponent(xs, ys, idx, grid, basis, pitch, tol) {
  const n = xs.length;
  const comp = new Int32Array(n).fill(-1);
  const I = new Int32Array(n), J = new Int32Array(n);
  const LB = new Float64Array(n * 4); // local basis a.x a.y b.x b.y
  const isCand = new Uint8Array(n);
  for (const k of idx) isCand[k] = 1;

  /** Unit step from p to q under basis (a, b), or null. */
  const stepOf = (ax, ay, bx, by, dx, dy) => {
    const det = ax * by - ay * bx;
    if (Math.abs(det) < 1e-9) return null;
    const al = (dx * by - dy * bx) / det;
    const be = (ax * dy - ay * dx) / det;
    const ra = Math.round(al), rb = Math.round(be);
    if (Math.abs(ra) + Math.abs(rb) !== 1) return null;
    if (Math.abs(al - ra) > tol || Math.abs(be - rb) > tol) return null;
    return [ra, rb];
  };

  // Seeds: points with ≥ 3 unit-step neighbours under the global basis.
  const { a, b } = basis;
  const rad = 1.35 * Math.max(hypot(a[0], a[1]), hypot(b[0], b[1]));
  const seeds = [];
  for (const k of idx) {
    let c = 0;
    for (const q of grid.near(xs[k], ys[k], rad, k)) {
      if (isCand[q] && stepOf(a[0], a[1], b[0], b[1], xs[q] - xs[k], ys[q] - ys[k])) c++;
    }
    if (c >= 3) seeds.push(k);
  }

  let best = null;
  let cid = 0;
  for (const s of seeds) {
    if (comp[s] >= 0) continue;
    const members = [s];
    const keys = new Set([0]);
    comp[s] = cid; I[s] = 0; J[s] = 0;
    LB.set([a[0], a[1], b[0], b[1]], s * 4);
    for (let h = 0; h < members.length; h++) {
      const p = members[h];
      const [pax, pay, pbx, pby] = LB.subarray(p * 4, p * 4 + 4);
      const r = 1.35 * Math.max(hypot(pax, pay), hypot(pbx, pby));
      for (const q of grid.near(xs[p], ys[p], r, p)) {
        if (!isCand[q] || comp[q] >= 0) continue;
        const dx = xs[q] - xs[p], dy = ys[q] - ys[p];
        const st = stepOf(pax, pay, pbx, pby, dx, dy);
        if (!st) continue;
        const qi = I[p] + st[0], qj = J[p] + st[1];
        const key = (qi + 4096) * 8192 + (qj + 4096);
        if (keys.has(key)) continue;
        keys.add(key);
        comp[q] = cid; I[q] = qi; J[q] = qj;
        // Carry the local basis along, nudging the stepped axis toward what we saw.
        if (st[0] !== 0) LB.set([0.5 * pax + 0.5 * st[0] * dx, 0.5 * pay + 0.5 * st[0] * dy, pbx, pby], q * 4);
        else LB.set([pax, pay, 0.5 * pbx + 0.5 * st[1] * dx, 0.5 * pby + 0.5 * st[1] * dy], q * 4);
        members.push(q);
      }
    }
    if (!best || members.length > best.length) best = members;
    cid++;
  }
  if (!best) return null;
  return best.map((k) => [k, I[k], J[k]]);
}

/* --------------------------------------------------------- lattice fit -- */

/**
 * Fit H (i, j) → px over the members, rejecting outliers by their error in
 * INDEX space (pitches — scale-free and perspective-invariant). Returns
 * { H, members, rms (px), rmsIdx (pitches) }; `members` are [pointIndex, i, j].
 */
function robustFit(xs, ys, members) {
  let cur = members;
  let H = null;
  let rms = Infinity, rmsIdx = Infinity;
  for (let it = 0; it < 4; it++) {
    H = fitHomography(cur.map((m) => [m[1], m[2]]), cur.map((m) => [xs[m[0]], ys[m[0]]]));
    if (!H) return null;
    let Hinv;
    try { Hinv = invert3(H); } catch { return null; }
    const res = cur.map((m) => { const q = applyH(Hinv, [xs[m[0]], ys[m[0]]]); return hypot(q[0] - m[1], q[1] - m[2]); });
    const sorted = [...res].sort((p, q) => p - q);
    const med = sorted[sorted.length >> 1];
    const thr = Math.max(0.08, Math.min(0.3, 4 * med));
    const keep = cur.filter((_, k) => res[k] <= thr);
    let s = 0, sp = 0;
    for (let k = 0; k < cur.length; k++) {
      if (res[k] > thr) continue;
      s += res[k] * res[k];
      const p = applyH(H, [cur[k][1], cur[k][2]]);
      sp += (p[0] - xs[cur[k][0]]) ** 2 + (p[1] - ys[cur[k][0]]) ** 2;
    }
    rmsIdx = Math.sqrt(s / Math.max(1, keep.length));
    rms = Math.sqrt(sp / Math.max(1, keep.length));
    if (keep.length === cur.length || keep.length < 8) break;
    cur = keep;
  }
  return { H, members: cur, rms, rmsIdx };
}

/**
 * Reassign every peak to its nearest predicted pin inside [i0−1, i1+1] ×
 * [j0−1, j1+1], within `maxErr` pitches (index space); returns a Map
 * key → [pointIndex, i, j, err].
 */
function reassign(xs, ys, H, ext, maxErr) {
  let Hinv;
  try { Hinv = invert3(H); } catch { return null; }
  const map = new Map();
  for (let k = 0; k < xs.length; k++) {
    const [u, v] = applyH(Hinv, [xs[k], ys[k]]);
    const i = Math.round(u), j = Math.round(v);
    if (i < ext.i0 - 1 || i > ext.i1 + 1 || j < ext.j0 - 1 || j > ext.j1 + 1) continue;
    const e = hypot(u - i, v - j);
    if (e > maxErr) continue;
    const key = (i + 4096) * 8192 + (j + 4096);
    const prev = map.get(key);
    if (!prev || e < prev[3]) map.set(key, [k, i, j, e]);
  }
  return map;
}

/** Occupancy of each line i ∈ [i0−1, i1+1] (over j ∈ [j0, j1]) and vice versa. */
function lineOccupancy(map, ext) {
  const colCount = new Map(), rowCount = new Map();
  for (const [, i, j] of map.values()) {
    if (j >= ext.j0 && j <= ext.j1) colCount.set(i, (colCount.get(i) || 0) + 1);
    if (i >= ext.i0 && i <= ext.i1) rowCount.set(j, (rowCount.get(j) || 0) + 1);
  }
  const nJ = ext.j1 - ext.j0 + 1, nI = ext.i1 - ext.i0 + 1;
  return {
    col: (i) => (colCount.get(i) || 0) / nJ,
    row: (j) => (rowCount.get(j) || 0) / nI,
  };
}

/* --------------------------------------------------- extent & orientation -- */

/**
 * Display-window edge distance, in pitches from the outermost detected line,
 * along one side. Samples the background-blurred image at predicted lattice
 * positions (index space, so perspective is already undone), averages across
 * the side, and finds where the profile first falls halfway from the field
 * level to the bezel level. null when the side leaves the image or shows no
 * contrast.
 *
 * @param side {axis: 'i'|'j', dir: -1|+1}
 */
function windowEdge(bg, w, h, H, ext, side, need, minContrast) {
  const { axis, dir } = side;
  const base = axis === 'i' ? (dir < 0 ? ext.i0 : ext.i1) : (dir < 0 ? ext.j0 : ext.j1);
  const lo = axis === 'i' ? ext.j0 + 2 : ext.i0 + 2;
  const hi = axis === 'i' ? ext.j1 - 2 : ext.i1 - 2;
  if (hi <= lo) return null;
  const prof = (t) => {
    let s = 0, c = 0, tot = 0;
    for (let o = lo; o <= hi; o++) {
      const ij = axis === 'i' ? [base + dir * t, o] : [o, base + dir * t];
      const p = applyH(H, ij);
      const v = sample(bg, w, h, p[0], p[1]);
      tot++;
      if (Number.isFinite(v)) { s += v; c++; }
    }
    return c >= 0.5 * tot ? s / c : NaN;
  };
  const step = 0.25;
  const tMax = need + WINDOW_MARGIN + 3.2; // into the bezel (≈ 3.6 pitches wide)
  const P = [];
  for (let t = 0.5; t <= tMax + 1e-9; t += step) P.push(prof(t));
  if (P.some((v) => !Number.isFinite(v))) return null;
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const F = mean(P.slice(0, 5)); // t ∈ [0.5, 1.5]
  const B = mean(P.slice(-5));   // the last pitch: bezel
  if (Math.abs(F - B) < minContrast) return null;
  for (let k = 1; k < P.length; k++) {
    const a0 = (P[k - 1] - B) / (F - B), a1 = (P[k] - B) / (F - B);
    if (a0 >= 0.5 && a1 < 0.5) return 0.5 + step * (k - 1 + (a0 - 0.5) / (a0 - a1));
  }
  return null;
}

/**
 * Split `need` missing lines between the low and high side of one axis.
 * Evidence: the display-window margins (equal on both sides, ≈ WINDOW_MARGIN).
 * Returns { low, high, imbalance } or null when there is no evidence.
 */
function splitMissing(need, tLow, tHigh) {
  if (need === 0) return { low: 0, high: 0, imbalance: tLow != null && tHigh != null ? Math.abs(tLow - tHigh) : 0, dev: 0 };
  let best = null;
  for (let k = 0; k <= need; k++) {
    let cost;
    if (tLow != null && tHigh != null) {
      // Equal margins after the split, with a weak pull toward the template margin.
      const mL = tLow - k, mH = tHigh - (need - k);
      cost = Math.abs(mL - mH) + 0.25 * (Math.abs(mL - WINDOW_MARGIN) + Math.abs(mH - WINDOW_MARGIN));
    } else if (tLow != null) {
      cost = Math.abs(tLow - k - WINDOW_MARGIN);
    } else if (tHigh != null) {
      cost = Math.abs(tHigh - (need - k) - WINDOW_MARGIN);
    } else {
      return null;
    }
    if (!best || cost < best.cost) best = { low: k, high: need - k, cost };
  }
  const imbalance = tLow != null && tHigh != null
    ? Math.abs((tLow - best.low) - (tHigh - best.high))
    : Math.abs((tLow ?? tHigh) - (tLow != null ? best.low : best.high) - WINDOW_MARGIN);
  // How far a side that RECEIVED lines is from the template margin after the
  // split — that margin is the only evidence those lines exist.
  const dev = Math.max(
    tLow != null && best.low > 0 ? Math.abs(tLow - best.low - WINDOW_MARGIN) : 0,
    tHigh != null && best.high > 0 ? Math.abs(tHigh - best.high - WINDOW_MARGIN) : 0,
  );
  return { low: best.low, high: best.high, imbalance, dev };
}

/**
 * Braille-like dots in a pin-space box: strong peaks whose (c, r) fall inside,
 * that are isolated blobs at the pin scale (N half a pitch away along both pin
 * axes < half the peak), and that have at least two others one pitch away
 * along a pin axis (braille cells are 2 × 4 dots at about the pin pitch).
 * Specular highlights, cable edges and the rims of a pop-it mat do not pass.
 */
function countInBand(pk, w, h, Hp, c0, c1, r0, r1) {
  const { xs, ys, strong, N } = pk;
  const Hinv = invert3(Hp);
  const pts = [];
  for (let k = 0; k < xs.length; k++) {
    if (!strong[k]) continue;
    const [c, r] = applyH(Hinv, [xs[k], ys[k]]);
    if (!(c >= c0 && c <= c1 && r >= r0 && r <= r1)) continue;
    const v = sample(N, w, h, xs[k], ys[k]);
    let isolated = v > 0;
    for (const [dc, dr] of [[0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5]]) {
      if (!isolated) break;
      const q = applyH(Hp, [c + dc, r + dr]);
      const m = sample(N, w, h, q[0], q[1]);
      if (!(m < 0.5 * v)) isolated = false;
    }
    if (isolated) pts.push([c, r]);
  }
  if (pts.length > 4000) return 0; // a texture, not a text line
  let n = 0;
  for (const [c, r] of pts) {
    let nb = 0;
    for (const [c2, r2] of pts) {
      const dc = Math.abs(c2 - c), dr = Math.abs(r2 - r);
      if ((Math.abs(dc - 1) < 0.3 && dr < 0.3) || (Math.abs(dr - 1) < 0.3 && dc < 0.3)) nb++;
    }
    if (nb >= 2) n++;
  }
  return n;
}

/* ------------------------------------------------------------- detector -- */

export const LATTICE_DEFAULTS = Object.freeze({
  // Scale search: working pitches tried on every pyramid level (each level
  // halves the image), so the absolute pitch range is ~3 px … ~50 px.
  workPitches: [4.5, 6.4],
  minPitch: 3.2,              // smallest pitch hypothesis (px, full resolution)
  upsampleMaxPixels: 1.2e6,   // frames this small get a 2× upsampled level for pitch ≈ 3
  minLevelSide: 96,           // stop the pyramid when a side gets this small
  maxLevel0Pixels: 4.2e6,     // larger frames start at level 1 (a 12 MP phone still)
  pitchHint: null,            // px at full res: try this scale first (previous success)
  polarities: [1, -1],        // +1 pins brighter than the surface; −1 only if +1 finds nothing
  nStrong: 1.0, dStrong: 3,   // strong peaks build the lattice (N: normalised, D: grey levels)
  nWeak: 0.5, dWeak: 0.8,     // weak peaks only fill predicted pin positions
  kStrong: 5, kWeak: 3,       // contrast floors are also ≥ k · (noise σ of D)
  edgeRatio: 7.2,             // Hessian tr²/det limit ((r+1)²/r, r = 5): rejects ridges
  eps: 1.5,                   // grey levels added to the local RMS
  stepTol: 0.28,              // BFS: |α − round α| in lattice units
  assignTol: 0.3,             // reassignment: px error / local pitch
  growOcc: 0.35,              // add a boundary line at ≥ this occupancy
  trimOcc: 0.15,              // drop a boundary line below this occupancy
  maxMissing: 10,             // lines per axis that may be added from evidence
  maxImbalance: 0.75,         // opposite window margins must agree to this (pitches)
  maxMarginDev: 0.6,          // … and a side that got added lines must sit this close to ≈ 4.5
  minEdgeContrast: 10,        // grey levels, window vs bezel
  minText: 12,                // dot peaks in the text band to call orientation
  // Validation gate — everything below must hold or the result is null.
  minMembers: 400,            // dots in the final fit
  minCoverage: 0.4,           // of the 2,400 predicted pins, fraction with a dot
  minCornerOcc: 0.3,          // each 8 × 8 corner block of the detected field
  maxOutsideOcc: 0.25,        // each line just outside the 60 × 40
  maxRmsPitch: 0.18,          // fit residual / pitch
  maxMidRatio: 0.3,           // N at pin midpoints / N at pins (isolated dots, not gaps)
});

/** Last failure reason, for debugging (`detectDotpadLattice.lastReason`). */
function fail(reason) {
  detectDotpadLattice.lastReason = reason;
  detectDotpadLattice.trace?.push(reason);
  return null;
}

/** 2× bilinear upsample; level −1 pixel x ↔ full-resolution x / 2 − 0.25. */
function double(src, w, h) {
  const W = 2 * w, Hh = 2 * h;
  const out = new Float32Array(W * Hh);
  for (let y = 0; y < Hh; y++) {
    const sy = Math.min(h - 1, Math.max(0, y / 2 - 0.25));
    const y0 = Math.min(h - 2, Math.floor(sy)), fy = sy - y0;
    for (let x = 0; x < W; x++) {
      const sx = Math.min(w - 1, Math.max(0, x / 2 - 0.25));
      const x0 = Math.min(w - 2, Math.floor(sx)), fx = sx - x0;
      const o = y0 * w + x0;
      out[y * W + x] = (src[o] * (1 - fx) + src[o + 1] * fx) * (1 - fy) + (src[o + w] * (1 - fx) + src[o + w + 1] * fx) * fy;
    }
  }
  return { data: out, w: W, h: Hh };
}

/** 2 × 2 box downsample. */
function halve(src, w, h) {
  const W = w >> 1, Hh = h >> 1;
  const out = new Float32Array(W * Hh);
  for (let y = 0; y < Hh; y++) {
    const a = 2 * y * w, b = a + w, o = y * W;
    for (let x = 0; x < W; x++) out[o + x] = 0.25 * (src[a + 2 * x] + src[a + 2 * x + 1] + src[b + 2 * x] + src[b + 2 * x + 1]);
  }
  return { data: out, w: W, h: Hh };
}

/**
 * Find the DOT Pad pin lattice in a grayscale frame.
 *
 * Scale-free: a pyramid of 2× box downsamples (plus a 2× upsample on small
 * frames), and on each level a couple of working pitch hypotheses — every
 * kernel, window and tolerance is a multiple of the pitch. Stage A (peaks →
 * pitch → basis → largest BFS component) runs per hypothesis, cheapest first.
 * A hypothesis that finds a lattice has MEASURED the pitch: stage A is re-run
 * with kernels sized to that pitch on the level where it is 5–10 px, then
 * stage B (fit, grow, 60 × 40 extent, validation gate, orientation). The first
 * result that passes the gate wins. Bright pins first; the inverted polarity
 * only if the bright pass found nothing that passed.
 *
 * @param {{data: ArrayLike<number>, width: number, height: number}} img  8-bit luma.
 * @param {Partial<typeof LATTICE_DEFAULTS>} [options]
 * @returns {null | {
 *   pinCorners: number[][], H: number[][], pitchPx: number,
 *   members: number, coverage: number, rmsPx: number,
 *   detected: {cols: number, rows: number},
 *   added: {left: number, right: number, top: number, bottom: number},
 *   margins: {left: number|null, right: number|null, top: number|null, bottom: number|null},
 *   textFound: boolean, needsConfirm: boolean, text: {below: number, above: number},
 *   score: number, level: number, polarity: number,
 * }}  `lastReason` on the function says why the last call returned null.
 */
export function detectDotpadLattice(img, options = {}) {
  const it = latticeSearch(img, options);
  for (;;) {
    const st = it.next();
    if (st.done) return st.value;
  }
}

/**
 * {@link detectDotpadLattice} as a generator: it yields after every scale
 * hypothesis (tens to a few hundred ms of work each at 720p) so a caller can
 * spread one frame's search over several animation ticks; the final
 * `{done: true, value}` is the detection or null. The frame is copied up
 * front, so the caller may reuse its buffer.
 */
export function* latticeSearch(img, options = {}) {
  const o = { ...LATTICE_DEFAULTS, ...options };
  detectDotpadLattice.trace = o.trace ? [] : null;
  const { width: w0, height: h0 } = img;
  const base = new Float32Array(w0 * h0);
  for (let i = 0; i < base.length; i++) base[i] = img.data[i];

  // Pyramid: level L is 2^L × smaller; level −1 (small frames only) is 2× larger.
  const levels = new Map([[0, { data: base, w: w0, h: h0 }]]);
  let top = 0;
  while (Math.min(levels.get(top).w, levels.get(top).h) >= 2 * o.minLevelSide) {
    const l = levels.get(top);
    levels.set(++top, halve(l.data, l.w, l.h));
  }
  const firstLevel = w0 * h0 > o.maxLevel0Pixels ? 1 : 0;
  const upsample = w0 * h0 <= o.upsampleMaxPixels;
  const level = (L) => {
    if (L === -1 && !levels.has(-1)) levels.set(-1, double(base, w0, h0)); // only when needed
    return levels.get(L);
  };

  // Scale hypotheses (level, working pitch), cheapest first; a hint goes first.
  let hyps = [];
  for (let L = top; L >= firstLevel; L--) {
    for (const pw of o.workPitches) hyps.push({ L, pw, px: pw * 2 ** L });
  }
  // Tiny pitches: at 2× on small frames (sub-pixel peaks and the ridge test
  // need a few pixels per dot), else at full resolution.
  if (upsample) hyps.push({ L: -1, pw: 2 * o.minPitch, px: o.minPitch });
  else if (firstLevel === 0) hyps.push({ L: 0, pw: o.minPitch, px: o.minPitch });
  if (o.pitchHint) {
    const d = (hy) => Math.abs(Math.log(hy.px / o.pitchHint));
    hyps = [...hyps].sort((p, q) => d(p) - d(q));
  }

  let reason = 'no-lattice';
  for (const pol of o.polarities) {
    const cache = new Map();
    const levelImg = (L) => {
      if (!cache.has(L)) {
        const l = level(L);
        cache.set(L, pol > 0 ? l.data : l.data.map((v) => 255 - v));
      }
      return cache.get(L);
    };
    const refined = [];
    for (const hy of hyps) {
      yield;
      const l = level(hy.L);
      detectDotpadLattice.trace?.push(`pol ${pol} L${hy.L} pw ${hy.pw}`);
      const A = stageA(levelImg(hy.L), l.w, l.h, hy.pw, o);
      if (!A) { reason = detectDotpadLattice.lastReason || reason; continue; }
      if (A.comp.length < 0.5 * o.minMembers) { reason = 'small-component'; continue; }
      // The coarse hypothesis measured a pitch: re-run with every kernel sized
      // to THAT pitch, on the level where it is 5–10 px (dots resolved, cheap).
      const pFull = A.pitch0 * 2 ** hy.L;
      if (refined.some((p) => Math.abs(Math.log(p / pFull)) < 0.1)) continue;
      refined.push(pFull);
      let L = firstLevel;
      while (L < top && pFull / 2 ** (L + 1) >= 5) L++;
      if (pFull < 4 && upsample) L = -1;
      const pw = pFull / 2 ** L;
      const same = L === hy.L && Math.abs(Math.log(pw / hy.pw)) < 0.1;
      const lr = level(L);
      detectDotpadLattice.trace?.push(`  refine → L${L} pw ${pw.toFixed(2)}`);
      if (!same) yield;
      const A2 = same ? A : stageA(levelImg(L), lr.w, lr.h, pw, o);
      if (!A2 || A2.comp.length < 0.5 * o.minMembers) { reason = detectDotpadLattice.lastReason || 'small-component'; continue; }
      yield;
      const r = stageB(lr.w, lr.h, A2, pol > 0 ? o : { ...o, inverted: true });
      if (r) return finish(r, L, pol);
      reason = detectDotpadLattice.lastReason || reason;
    }
  }
  return fail(reason);

  /** Level-L pixels → full-resolution pixels (box-downsample centres). */
  function finish(r, L, pol) {
    const s = 2 ** L, off = (s - 1) / 2;
    const T = [[s, 0, off], [0, s, off], [0, 0, 1]];
    const H = matMul3(T, r.H);
    detectDotpadLattice.lastReason = null;
    return {
      ...r,
      H,
      pinCorners: r.pinCorners.map(([x, y]) => [x * s + off, y * s + off]),
      pitchPx: r.pitchPx * s,
      rmsPx: r.rmsPx * s,
      level: L,
      polarity: pol,
    };
  }
}

/** Stage A: peaks → pitch → basis → largest lattice component. */
function stageA(f, w, h, pw, o) {
  const pk = dotPeaks(f, w, h, pw, o);
  const { xs, ys, strong } = pk;
  const strongIdx = [];
  for (let k = 0; k < xs.length; k++) if (strong[k]) strongIdx.push(k);
  if (strongIdx.length < 50) return fail('too-few-peaks');
  const grid0 = makeGrid(xs, ys, pw);
  const pitch0 = estimatePitch(xs, ys, strongIdx, grid0, 2.2 * pw);
  // Outside ±40% the hypothesis' kernels are wrong; a neighbouring one covers it.
  if (!pitch0 || pitch0 < 0.6 * pw || pitch0 > 1.6 * pw) return fail('pitch-out-of-range');
  const grid = makeGrid(xs, ys, pitch0);
  const basis = estimateBasis(xs, ys, strongIdx, grid, pitch0);
  if (!basis) return fail('no-basis');
  const comp = largestComponent(xs, ys, strongIdx, grid, basis, pitch0, o.stepTol);
  if (!comp) return fail('no-component');
  detectDotpadLattice.trace?.push(`  peaks ${xs.length} strong ${strongIdx.length} pitch ${pitch0.toFixed(2)} comp ${comp.length}`);
  return { pk, pitch0, basis, comp };
}

/** Stage B: fit, grow, resolve 60 × 40, validation gate, orientation. */
function stageB(w, h, A, o) {
  const { pk, comp } = A;
  const { xs, ys } = pk;
  let fit = robustFit(xs, ys, comp);
  if (!fit) return fail('fit');

  let ext = {
    i0: Math.min(...fit.members.map((m) => m[1])), i1: Math.max(...fit.members.map((m) => m[1])),
    j0: Math.min(...fit.members.map((m) => m[2])), j1: Math.max(...fit.members.map((m) => m[2])),
  };

  // Grow / trim one boundary line per side per round, refitting as we go.
  let map = null;
  for (let round = 0; round < 80; round++) {
    map = reassign(xs, ys, fit.H, ext, o.assignTol);
    if (!map) return fail('reassign');
    const occ = lineOccupancy(map, ext);
    const next = { ...ext };
    if (occ.col(ext.i0 - 1) >= o.growOcc) next.i0 -= 1; else if (occ.col(ext.i0) < o.trimOcc) next.i0 += 1;
    if (occ.col(ext.i1 + 1) >= o.growOcc) next.i1 += 1; else if (occ.col(ext.i1) < o.trimOcc) next.i1 -= 1;
    if (occ.row(ext.j0 - 1) >= o.growOcc) next.j0 -= 1; else if (occ.row(ext.j0) < o.trimOcc) next.j0 += 1;
    if (occ.row(ext.j1 + 1) >= o.growOcc) next.j1 += 1; else if (occ.row(ext.j1) < o.trimOcc) next.j1 -= 1;
    if (next.i1 - next.i0 >= COLS + 4 || next.j1 - next.j0 >= COLS + 4) return fail('lattice-too-large');
    if (next.i1 < next.i0 || next.j1 < next.j0) return fail('lattice-vanished');
    const inside = [...map.values()].filter((m) => m[1] >= next.i0 && m[1] <= next.i1 && m[2] >= next.j0 && m[2] <= next.j1);
    const refit = robustFit(xs, ys, inside);
    if (!refit) return fail('refit');
    fit = refit;
    const same = next.i0 === ext.i0 && next.i1 === ext.i1 && next.j0 === ext.j0 && next.j1 === ext.j1;
    ext = next;
    if (same && round > 0) break;
  }
  if (fit.members.length < o.minMembers) return fail('few-members');

  // Local pitch at the centre, from the fit.
  const ci = (ext.i0 + ext.i1) / 2, cj = (ext.j0 + ext.j1) / 2;
  const pc = applyH(fit.H, [ci, cj]);
  const pa = applyH(fit.H, [ci + 1, cj]), pb = applyH(fit.H, [ci, cj + 1]);
  const pitch = (hypot(pa[0] - pc[0], pa[1] - pc[1]) + hypot(pb[0] - pc[0], pb[1] - pc[1])) / 2;
  if (fit.rmsIdx > o.maxRmsPitch) return fail('rms');

  // ── Extent → exactly 60 × 40 ────────────────────────────────────────
  const nI = ext.i1 - ext.i0 + 1, nJ = ext.j1 - ext.j0 + 1;
  const sides = {
    iLow: { axis: 'i', dir: -1 }, iHigh: { axis: 'i', dir: 1 },
    jLow: { axis: 'j', dir: -1 }, jHigh: { axis: 'j', dir: 1 },
  };
  const hyps = [];
  for (const longIsI of [true, false]) {
    const needI = (longIsI ? COLS : ROWS) - nI;
    const needJ = (longIsI ? ROWS : COLS) - nJ;
    if (needI < 0 || needJ < 0 || needI > o.maxMissing || needJ > o.maxMissing) continue;
    const t = {};
    for (const [k, sd] of Object.entries(sides)) {
      t[k] = windowEdge(pk.bg, w, h, fit.H, ext, sd, sd.axis === 'i' ? needI : needJ, o.minEdgeContrast);
    }
    const si = splitMissing(needI, t.iLow, t.iHigh);
    const sj = splitMissing(needJ, t.jLow, t.jHigh);
    if (!si || !sj) continue;
    // Margins must balance where lines were added — and, in the inverted pass,
    // everywhere: a lattice of the GAPS between bright pins sits half a pitch
    // off, which shows up as margins one pitch apart. (Bright, isolated dots
    // cannot be half a pitch off; there an oblique view's recess wall may
    // legitimately skew one margin.)
    const unbalanced = (sp, need) => (need > 0 || o.inverted) && sp.imbalance > o.maxImbalance;
    if (unbalanced(si, needI) || unbalanced(sj, needJ)) continue;
    // Lines added from evidence: the margins must also look like the template's.
    if ((needI > 0 && si.dev > o.maxMarginDev) || (needJ > 0 && sj.dev > o.maxMarginDev)) continue;
    hyps.push({ longIsI, si, sj, t, cost: needI + needJ + si.imbalance + sj.imbalance });
  }
  if (!hyps.length) return fail(`extent-unresolved ${nI}x${nJ}`);
  hyps.sort((p, q) => p.cost - q.cost);
  const hy = hyps[0];
  const E = { i0: ext.i0 - hy.si.low, i1: ext.i1 + hy.si.high, j0: ext.j0 - hy.sj.low, j1: ext.j1 + hy.sj.high };

  // ── Validation gate ────────────────────────────────────────────────
  // Re-collect every peak against the final extent (± 1 line) once more.
  map = reassign(xs, ys, fit.H, E, o.assignTol);
  const within = [...map.values()].filter((m) => m[1] >= E.i0 && m[1] <= E.i1 && m[2] >= E.j0 && m[2] <= E.j1);
  const coverage = within.length / (COLS * ROWS);
  if (coverage < o.minCoverage) return fail(`coverage ${coverage.toFixed(2)}`);
  // A pad is dotted right into its corners (a hexagonal or ragged texture that
  // happens to index as ~60 × 40 is not), and blank just outside its edge.
  const occE = lineOccupancy(map, E);
  const outside = Math.max(occE.col(E.i0 - 1), occE.col(E.i1 + 1), occE.row(E.j0 - 1), occE.row(E.j1 + 1));
  if (outside > o.maxOutsideOcc) return fail(`outside-occupied ${outside.toFixed(2)}`);
  const blk = 8;
  const has = new Set(within.map((m) => (m[1] + 4096) * 8192 + (m[2] + 4096)));
  const cornerOcc = (ia, ja, di, dj) => {
    let c = 0, t = 0;
    for (let a = 0; a < blk; a++) for (let b = 0; b < blk; b++) {
      const i = ia + di * a, j = ja + dj * b;
      if (i < ext.i0 || i > ext.i1 || j < ext.j0 || j > ext.j1) continue; // added lines excluded
      t++;
      if (has.has((i + 4096) * 8192 + (j + 4096))) c++;
    }
    return t ? c / t : 0;
  };
  const minCorner = Math.min(
    cornerOcc(ext.i0, ext.j0, 1, 1), cornerOcc(ext.i1, ext.j0, -1, 1),
    cornerOcc(ext.i1, ext.j1, -1, -1), cornerOcc(ext.i0, ext.j1, 1, -1),
  );
  if (minCorner < o.minCornerOcc) return fail(`corner-occupancy ${minCorner.toFixed(2)}`);
  const midRatio = midpointRatio(pk.N, w, h, fit.H, ext);
  if (!(midRatio <= o.maxMidRatio)) return fail(`not-isolated-dots ${midRatio.toFixed(2)}`);

  // ── Orientation ────────────────────────────────────────────────────
  // Detection-index corners; the pin frame needs TL→TR along the long axis
  // and TL,TR,BR,BL clockwise on screen. Two candidates survive (0° / 180°).
  const Ac = [E.i0, E.j0], Bc = [E.i1, E.j0], Cc = [E.i1, E.j1], Dc = [E.i0, E.j1];
  const orders = hy.longIsI
    ? [[Ac, Bc, Cc, Dc], [Bc, Ac, Dc, Cc], [Cc, Dc, Ac, Bc], [Dc, Cc, Bc, Ac]]
    : [[Ac, Dc, Cc, Bc], [Dc, Ac, Bc, Cc], [Cc, Bc, Ac, Dc], [Bc, Cc, Dc, Ac]];
  const pinIdx = [[0, 0], [COLS - 1, 0], [COLS - 1, ROWS - 1], [0, ROWS - 1]];
  const clockwise = (q) => {
    for (let k = 0; k < 4; k++) {
      const a = q[k], b = q[(k + 1) % 4], c = q[(k + 2) % 4];
      if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) <= 0) return false;
    }
    return true;
  };
  const cands = orders
    .map((ord) => {
      const M = homography4(pinIdx, ord); // pin (c, r) → detection (i, j), exactly affine
      const Hp = matMul3(fit.H, M);
      return { M, Hp, corners: pinIdx.map((p) => applyH(Hp, p)) };
    })
    .filter((cd) => clockwise(cd.corners));
  if (cands.length !== 2) return fail('handedness');
  // Text band below the bottom edge (±1 row of the template window) vs. its mirror above.
  const band = (cd) => countInBand(pk, w, h, cd.Hp, TEXT_C0, TEXT_C1, TEXT_R0 - 1, TEXT_R1 + 1);
  const below = band(cands[0]);
  const above = band(cands[1]);
  let pick = cands[0];
  let textFound = false;
  if (below >= o.minText && below >= 2 * above + 3) { textFound = true; }
  else if (above >= o.minText && above >= 2 * below + 3) { pick = cands[1]; textFound = true; }
  else {
    // Undecided: a stable default — TL nearest the image's top-left.
    const s = (cd) => cd.corners[0][0] + cd.corners[0][1];
    if (s(cands[1]) < s(cands[0])) pick = cands[1];
  }
  const flipped = pick === cands[1];

  // Final fit in pin coordinates with every member (indices mapped through M⁻¹).
  const Minv = invert3(pick.M); // detection (i, j) → pin (c, r)
  const pinMembers = within.map((m) => { const [c, r] = applyH(Minv, [m[1], m[2]]); return [m[0], Math.round(c), Math.round(r)]; });
  const fin = robustFit(xs, ys, pinMembers) || { H: pick.Hp, members: pinMembers, rms: fit.rms, rmsIdx: fit.rmsIdx };
  const Hpin = fin.H;
  const pinCorners = pinIdx.map((p) => applyH(Hpin, p));

  // Added lines and window margins, reported in the pin frame.
  const addedDet = { iLow: hy.si.low, iHigh: hy.si.high, jLow: hy.sj.low, jHigh: hy.sj.high };
  const sideOfPin = (name) => {
    const probe = { left: [-1, 19.5], right: [COLS, 19.5], top: [29.5, -1], bottom: [29.5, ROWS] }[name];
    const [i, j] = applyH(pick.M, probe);
    if (i < E.i0) return 'iLow';
    if (i > E.i1) return 'iHigh';
    if (j < E.j0) return 'jLow';
    return 'jHigh';
  };
  const added = {}, margins = {};
  for (const nm of ['left', 'right', 'top', 'bottom']) {
    const sd = sideOfPin(nm);
    added[nm] = addedDet[sd];
    margins[nm] = hy.t[sd] == null ? null : +(hy.t[sd] - addedDet[sd]).toFixed(2);
  }

  const nAdded = added.left + added.right + added.top + added.bottom;
  const score = coverage * Math.max(0, 1 - fin.rmsIdx / 0.25) * Math.max(0.3, 1 - 0.04 * nAdded)
    * (textFound ? 1 : 0.9);
  return {
    pinCorners,
    H: Hpin,
    pitchPx: pitch,
    members: fin.members.length,
    coverage,
    rmsPx: fin.rms,
    rmsPitch: fin.rmsIdx,
    detected: { cols: hy.longIsI ? nI : nJ, rows: hy.longIsI ? nJ : nI },
    added,
    margins,
    textFound,
    needsConfirm: !textFound,
    text: { below: flipped ? above : below, above: flipped ? below : above },
    midRatio,
    score,
  };
}

/* ------------------------------------------------------- multi-frame -- */

/**
 * Combine several single-frame detections (hands-off frames of a static pad):
 * align every result's corner order to a reference, take the per-coordinate
 * median, drop results more than `maxDevPitch` pitches off, and decide the
 * orientation by vote among the text-confirmed ones.
 *
 * @param {Array<ReturnType<typeof detectDotpadLattice>>} results  nulls allowed.
 * @param {{minAgree?: number, maxDevPitch?: number}} [options]
 * @returns {null | {pinCorners: number[][], textFound: boolean, needsConfirm: boolean,
 *   frames: number, agreed: number, spreadPx: number, pitchPx: number}}
 */
export function aggregateDetections(results, { minAgree = 2, maxDevPitch = 1.5 } = {}) {
  const ok = (results || []).filter(Boolean);
  if (!ok.length) return null;
  const ref = ok.find((r) => r.textFound) || ok[0];
  const cornerDist = (p, q) => p.reduce((s, c, k) => s + hypot(c[0] - q[k][0], c[1] - q[k][1]), 0) / 4;
  const aligned = ok.map((r) => {
    let bestR = 0, bestD = Infinity;
    for (let k = 0; k < 4; k++) {
      const d = cornerDist(rotateQuad(r.pinCorners, k), ref.pinCorners);
      if (d < bestD) { bestD = d; bestR = k; }
    }
    // A text-confirmed result votes for its own orientation, expressed in the ref's frame.
    const vote = r.textFound ? (bestR === 0 ? 1 : bestR === 2 ? -1 : 0) : 0;
    return { q: rotateQuad(r.pinCorners, bestR), pitch: r.pitchPx, vote };
  });
  const median = (arr) => { const s = [...arr].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const medQuad = (set) => [0, 1, 2, 3].map((k) => [median(set.map((a) => a.q[k][0])), median(set.map((a) => a.q[k][1]))]);
  const pitch = median(aligned.map((a) => a.pitch));
  let m = medQuad(aligned);
  const inl = aligned.filter((a) => Math.max(...a.q.map((c, k) => hypot(c[0] - m[k][0], c[1] - m[k][1]))) <= maxDevPitch * pitch);
  if (inl.length < Math.min(minAgree, ok.length) || inl.length < 1) return null;
  m = medQuad(inl);
  const spread = Math.max(...inl.map((a) => Math.max(...a.q.map((c, k) => hypot(c[0] - m[k][0], c[1] - m[k][1])))));
  const votes = inl.reduce((s, a) => s + a.vote, 0);
  const textFound = votes !== 0;
  return {
    pinCorners: votes < 0 ? rotateQuad(m, 2) : m,
    textFound,
    needsConfirm: !textFound,
    frames: ok.length,
    agreed: inl.length,
    spreadPx: spread,
    pitchPx: pitch,
  };
}

/** Internals, exported for the headless tests and diagnostics only. */
export const _internal = { dotPeaks, estimatePitch, makeGrid, countInBand };
