#!/usr/bin/env node
/**
 * Camera-overlay geometry (src/lib/sheetOverlay.js).
 *
 *   node starter/scripts/test_sheet_overlay.mjs
 *
 * FULLY OFFLINE. The pose comes from the camio-pointer library itself
 * (PointerCore.setRegistration on a static rect surface), so the (u, v) frame
 * checked here is the one the library's 'point' events use.
 */

import { PointerCore, applyH } from '../src/vendor/camio/CamioPointer-0.2.0.js';
import {
  affineFromTriangles, applyAffine, expandTriangle, fitContain, mul3, pxToUv, sheetHomography, warpMesh,
} from '../src/lib/sheetOverlay.js';

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const nearPt = (p, q, eps = 1e-6) => !!p && near(p[0], q[0], eps) && near(p[1], q[1], eps);

// A plausible perspective view of a landscape sheet in a 640×480 frame.
const FRAME = { width: 640, height: 480 };
const QUAD = [[118, 92], [530, 70], [596, 404], [64, 420]]; // TL, TR, BR, BL

const core = new PointerCore({ surface: { kind: 'rect', tracking: 'static' } });
const reg = core.setRegistration(QUAD, FRAME);
const { pose, grid } = reg;
core.dispose();

console.log('\n— mul3');
check(nearPt(mul3([[1, 2, 0], [0, 1, 0], [0, 0, 1]], [[1, 0, 3], [0, 1, 4], [0, 0, 1]])[0], [1, 2]),
  'row 0 of a product');

console.log('\n— sheetHomography: (u, v) corners → the registered corners');
const H = sheetHomography(pose, grid);
const uvCorners = [[0, 0], [1, 0], [1, 1], [0, 1]];
uvCorners.forEach((uv, k) => {
  const px = applyH(H, uv);
  check(nearPt(px, QUAD[k], 1e-6), `(${uv}) → corner ${k}`, px.map((n) => n.toFixed(3)).join(','));
});

console.log('\n— pxToUv: the library inverse, before quantisation');
QUAD.forEach((px, k) => {
  const q = pxToUv(px, pose, grid);
  check(!!q && near(q.u, uvCorners[k][0]) && near(q.v, uvCorners[k][1]), `corner ${k} → (${uvCorners[k]})`,
    q && `${q.u.toFixed(6)},${q.v.toFixed(6)}`);
});
const cellCentre = applyH(pose, [10, 7]);
const qc = pxToUv(cellCentre, pose, grid);
check(!!qc && near(qc.u, (10 + 0.5) / grid.cols) && near(qc.v, (7 + 0.5) / grid.rows),
  'a cell centre → the library\'s rect toUV ((col + ½) / cols)', `grid ${grid.cols}×${grid.rows}`);
check(pxToUv(null, pose, grid) === null && pxToUv([NaN, 1], pose, grid) === null, 'no tip → null');

console.log('\n— affineFromTriangles');
const s = [[3, 4], [50, 9], [12, 70]];
const d = [[100, 100], [140, 95], [90, 160]];
const m = affineFromTriangles(s, d);
check(!!m && s.every((p, i) => nearPt(applyAffine(m, p), d[i], 1e-9)), 'maps each source vertex onto its destination');
check(affineFromTriangles([[0, 0], [1, 1], [2, 2]], d) === null, 'collinear source → null');
const id = affineFromTriangles(s, s);
check(nearPt([id[0], id[3]], [1, 1], 1e-12) && nearPt([id[1], id[2]], [0, 0], 1e-12), 'same triangle → identity');

console.log('\n— warpMesh');
const rect = fitContain(1.6, 800, 600);
const tris = warpMesh(H, rect, 12, 8);
check(tris.length === 12 * 8 * 2, '12×8 cells → 192 triangles', `${tris.length}`);
check(tris.every((t) => t.m), 'no degenerate triangles for a plausible quad');
// Each triangle's affine is exact at its vertices …
check(tris.every((t) => t.src.every((p, i) => nearPt(applyAffine(t.m, p), t.dst[i], 1e-6))),
  'every affine maps its source vertices exactly');
// … and within a pixel of the true homography inside it (destination px).
const toUv = [[1 / rect.w, 0, -rect.x / rect.w], [0, 1 / rect.h, -rect.y / rect.h], [0, 0, 1]]; // dst px → (u, v)
let worst = 0;
for (const t of tris) {
  const c = [(t.dst[0][0] + t.dst[1][0] + t.dst[2][0]) / 3, (t.dst[0][1] + t.dst[1][1] + t.dst[2][1]) / 3];
  const uv = applyH(toUv, c);
  const camPx = applyH(H, uv);
  const back = applyAffine(t.m, camPx);
  worst = Math.max(worst, Math.hypot(back[0] - c[0], back[1] - c[1]));
}
check(worst < 1, 'centroid error vs the exact homography < 1 px', `${worst.toFixed(3)} px`);
const area = tris.reduce((sum, t) => {
  const [[a0, a1], [b0, b1], [c0, c1]] = t.dst;
  return sum + Math.abs((b0 - a0) * (c1 - a1) - (c0 - a0) * (b1 - a1)) / 2;
}, 0);
check(near(area, rect.w * rect.h, 1e-6), 'the triangles tile the destination rectangle exactly');

console.log('\n— expandTriangle / fitContain');
const t0 = [[0, 0], [10, 0], [0, 10]];
const big = expandTriangle(t0, 1);
check(big.every((p, i) => Math.hypot(p[0] - t0[i][0], p[1] - t0[i][1]) > 0.99), 'every vertex moves out by `by`');
check(big[0][0] < 0 && big[0][1] < 0, 'outward (away from the centroid)');
const wide = fitContain(2, 800, 600);
check(near(wide.w, 800) && near(wide.h, 400) && near(wide.y, 100) && near(wide.x, 0), 'wide aspect: full width, centred');
const tall = fitContain(0.5, 800, 600);
check(near(tall.h, 600) && near(tall.w, 300) && near(tall.x, 250), 'tall aspect: full height, centred');

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
