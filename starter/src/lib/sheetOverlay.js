/**
 * Geometry for the camera overlay on audiom.html (CamioSheetOverlay.jsx).
 *
 * After registration the overlay shows the RECTIFIED sheet: the camera frame
 * warped so the registered quad becomes an upright rectangle. There is no
 * OpenCV on the page's thread (the library keeps opencv.js in its worker), so
 * the warp is a Canvas 2D mesh: the destination rectangle is cut into a grid of
 * triangles and each is drawn with the affine transform that maps its source
 * triangle (the corners pushed through the sheet homography) onto it. A
 * homography is not affine, but over one small triangle the error is a
 * fraction of a pixel.
 *
 * Frames used here:
 *  - camera px: the video frame (= the library's processing frame);
 *  - cell (col, row): the library's rect-surface grid; `pose` maps cell →
 *    camera px and the registered corners are the cell-space points
 *    (−½, −½) … (cols − ½, rows − ½) (the rect profile's `planeCorners`);
 *  - (u, v): the sheet, (0, 0) = registered TL, (1, 1) = BR, so
 *    col = u·cols − ½, row = v·rows − ½ (the inverse of the library's rect
 *    `toUV`, `(col + ½) / cols`).
 *
 * PLATFORM-FREE (no DOM): `scripts/test_sheet_overlay.mjs`. The matrix helpers
 * are the camio-pointer library's own (`applyH`, `invert3`).
 */
import { applyH, invert3 } from '../vendor/camio/CamioPointer-0.2.0.js';

/** 3×3 product, row-major. */
export function mul3(a, b) {
  const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
    }
  }
  return out;
}

/**
 * (u, v, 1) → camera px for a rect registration: `pose` (cell → px) after
 * (u, v) → cell.
 *
 * @param {number[][]} pose the library's pose (cell → camera px)
 * @param {{cols: number, rows: number}} grid the registration's grid
 * @returns {number[][]}
 */
export function sheetHomography(pose, grid) {
  const { cols, rows } = grid;
  return mul3(pose, [[cols, 0, -0.5], [0, rows, -0.5], [0, 0, 1]]);
}

/**
 * A camera-px point (the fingertip) → (u, v) on the sheet, through the same
 * inverse pose the library quantises with (before quantisation). Null when
 * the pose is singular or the point is not finite.
 *
 * @param {number[]|null} px
 * @param {number[][]} pose
 * @param {{cols: number, rows: number}} grid
 * @returns {{u: number, v: number}|null}
 */
export function pxToUv(px, pose, grid) {
  if (!px || !Number.isFinite(px[0]) || !Number.isFinite(px[1])) return null;
  let inv;
  try { inv = invert3(pose); } catch { return null; }
  const [fx, fy] = applyH(inv, px);
  const u = (fx + 0.5) / grid.cols;
  const v = (fy + 0.5) / grid.rows;
  return Number.isFinite(u) && Number.isFinite(v) ? { u, v } : null;
}

/**
 * The affine map taking triangle `s` onto triangle `d` (three [x, y] each), as
 * Canvas `setTransform(a, b, c, d, e, f)` arguments:
 * x' = a·x + c·y + e, y' = b·x + d·y + f. Null for a degenerate source.
 *
 * @param {number[][]} s
 * @param {number[][]} d
 * @returns {number[]|null}
 */
export function affineFromTriangles(s, d) {
  const [[x0, y0], [x1, y1], [x2, y2]] = s;
  const det = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (!det || !Number.isFinite(det)) return null;
  // Solve [x' y'] for each output coordinate with Cramer's rule on the
  // differences from vertex 0.
  const solve = (q0, q1, q2) => {
    const p = ((q1 - q0) * (y2 - y0) - (q2 - q0) * (y1 - y0)) / det; // ∂/∂x
    const q = ((x1 - x0) * (q2 - q0) - (x2 - x0) * (q1 - q0)) / det; // ∂/∂y
    return [p, q, q0 - p * x0 - q * y0];
  };
  const [a, c, e] = solve(d[0][0], d[1][0], d[2][0]);
  const [b, dd, f] = solve(d[0][1], d[1][1], d[2][1]);
  return [a, b, c, dd, e, f];
}

/** Apply `setTransform`-order affine `m` to a point. */
export function applyAffine(m, [x, y]) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/**
 * The warp mesh: the destination rectangle `rect` ({ x, y, w, h }, canvas px,
 * (u, v) = (0, 0) at its top-left) cut into `nx × ny` cells of two triangles
 * each. Every triangle carries its destination corners `dst`, its source
 * corners `src` (camera px, through `H`, (u, v) → px) and the affine `m` from
 * source to destination (null when degenerate: the triangle is skipped).
 *
 * @param {number[][]} H (u, v, 1) → camera px (see sheetHomography)
 * @param {{x: number, y: number, w: number, h: number}} rect
 * @param {number} [nx]
 * @param {number} [ny]
 * @returns {{dst: number[][], src: number[][], m: number[]|null}[]}
 */
export function warpMesh(H, rect, nx = 12, ny = 8) {
  const src = [];
  const dst = [];
  for (let j = 0; j <= ny; j += 1) {
    for (let i = 0; i <= nx; i += 1) {
      const u = i / nx, v = j / ny;
      src.push(applyH(H, [u, v]));
      dst.push([rect.x + u * rect.w, rect.y + v * rect.h]);
    }
  }
  const at = (i, j) => j * (nx + 1) + i;
  const tris = [];
  const add = (k0, k1, k2) => {
    const s = [src[k0], src[k1], src[k2]];
    const d = [dst[k0], dst[k1], dst[k2]];
    tris.push({ dst: d, src: s, m: affineFromTriangles(s, d) });
  };
  for (let j = 0; j < ny; j += 1) {
    for (let i = 0; i < nx; i += 1) {
      add(at(i, j), at(i + 1, j), at(i + 1, j + 1));
      add(at(i, j), at(i + 1, j + 1), at(i, j + 1));
    }
  }
  return tris;
}

/**
 * Triangle `t` pushed `by` px outward from its centroid: the clip path, so
 * neighbouring triangles overlap a little and no hairline seams show.
 */
export function expandTriangle(t, by = 0.6) {
  const cx = (t[0][0] + t[1][0] + t[2][0]) / 3;
  const cy = (t[0][1] + t[1][1] + t[2][1]) / 3;
  return t.map(([x, y]) => {
    const dx = x - cx, dy = y - cy;
    const len = Math.hypot(dx, dy) || 1;
    return [x + (dx / len) * by, y + (dy / len) * by];
  });
}

/**
 * The largest `aspect` (w / h) rectangle centred in a box (CSS `contain`).
 *
 * @returns {{x: number, y: number, w: number, h: number}}
 */
export function fitContain(aspect, boxW, boxH) {
  let w = boxW, h = boxW / aspect;
  if (h > boxH) { h = boxH; w = boxH * aspect; }
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}
