#!/usr/bin/env node
/**
 * DOT Pad template geometry — the JSON asset, the homography, auto-find
 * selection and the four-corner sanity check.
 *
 *   node starter/scripts/test_dotpad_template.mjs
 *
 * FULLY OFFLINE, seeded, no OpenCV. `lib/dotpadTemplate.js` is the pure half of
 * registration (docs/dotpad-camio-design.md §6): the component finds candidate
 * quads with OpenCV and this module decides which one is the pad and which way
 * up it is. Here the "camera" is a synthetic projective map of the template, so
 * the right answer is known exactly.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  DOTPAD_TEMPLATE, DISPLAY_ASPECT, homography4, applyH, checkPinQuad, selectDevice,
  resolveConfirmTouch, maskPolygons, orderQuad, quadAspect,
} from '../src/lib/dotpadTemplate.js';
import { mulberry32 } from './fixtures/fakeAudiom.mjs';

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
const section = (title) => console.log(`\n— ${title} ${'—'.repeat(Math.max(0, 62 - title.length))}`);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const tpl = DOTPAD_TEMPLATE;

/** Point inside a convex TL,TR,BR,BL quad (y down). */
function inside(q, p) {
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    if ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) < 0) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ asset -- */

section('resources/dotpad_corners.json === DOTPAD_TEMPLATE');
{
  const here = dirname(fileURLToPath(import.meta.url));
  const json = JSON.parse(readFileSync(join(here, '..', 'resources', 'dotpad_corners.json'), 'utf8'));
  const keys = Object.keys(json).sort();
  check(eq(keys, Object.keys(tpl).sort()), 'same fields', keys.join(','));
  check(keys.every((k) => eq(json[k], tpl[k])), 'same values, field by field');
  check(json.imageSize[0] === 352 && json.imageSize[1] === 292, 'measured on the 352 × 292 render');
  const c = tpl.pinCorners;
  const px = (c[1][0] - c[0][0]) / (tpl.cols - 1);
  const py = (c[3][1] - c[0][1]) / (tpl.rows - 1);
  check(Math.abs(px - tpl.pinPitchPx) < 1e-3 && Math.abs(py - tpl.pinPitchPx) < 1e-3,
    'corner-pin spans are pitch × 59 and pitch × 39', `${px.toFixed(4)} × ${py.toFixed(4)}`);
  check(Math.abs(quadAspect(c) - 59 / 39) < 1e-3, 'centre-span aspect is 59/39 = 1.5128', quadAspect(c).toFixed(4));
  check(Math.abs(DISPLAY_ASPECT - 226.5 / 160) < 1e-12, 'display-window aspect 1.416');
  check(c.every((p) => inside(tpl.maskPinField, p)), 'the pin-field mask contains every corner pin');
  check(c.every((p) => inside(tpl.displayWindow, p)), 'the display window contains every corner pin');
}

/* ------------------------------------------------------------ homography -- */

section('homography4 round trip');
{
  const rng = mulberry32(42);
  let worst = 0;
  for (let i = 0; i < 200; i++) {
    const src = [[0, 0], [100, 0], [100, 60], [0, 60]].map(([x, y]) => [x + rng() * 10, y + rng() * 10]);
    const dst = src.map(([x, y]) => [x * (1 + rng()) + rng() * 300, y * (1 + rng()) + rng() * 300 + x * 0.1 * rng()]);
    const H = homography4(src, dst);
    for (let k = 0; k < 4; k++) worst = Math.max(worst, dist(applyH(H, src[k]), dst[k]));
  }
  check(worst < 1e-6, 'H·src = dst for 200 random quads', worst.toExponential(2));
  const I = homography4(tpl.pinCorners, tpl.pinCorners);
  check(Math.abs(I[0][0] - 1) < 1e-9 && Math.abs(I[1][1] - 1) < 1e-9 && Math.abs(I[0][2]) < 1e-6, 'identity for identical quads');
  let threw = false;
  try { homography4([[0, 0], [1, 1], [2, 2], [3, 3]], tpl.pinCorners); } catch { threw = true; }
  check(threw, 'a degenerate (collinear) quad throws');
}

/* --------------------------------------------------------- checkPinQuad -- */

section('checkPinQuad (§6.3 sanity check)');
{
  const persp = [[100, 80], [520, 95], [540, 380], [85, 360]];
  const r = checkPinQuad(persp);
  check(r.ok, 'a perspective-distorted 59:39 quad passes', `ratio ${r.ratio.toFixed(3)}`);
  check(checkPinQuad(tpl.pinCorners).ok, 'the template pin corners pass');
  check(!checkPinQuad([[0, 0], [100, 0], [100, 100], [0, 100]]).ok, '1:1 is rejected');
  check(checkPinQuad([[0, 0], [100, 0], [0, 66], [100, 66]]).reason === 'not-convex-clockwise', 'a crossed quad is rejected');
  check(!checkPinQuad([[0, 0], [0, 66], [100, 66], [100, 0]]).ok, 'counter-clockwise (TL,BL,BR,TR) is rejected');
  check(!checkPinQuad([[0, 0], [300, 0], [300, 66], [0, 66]]).ok, 'too wide (4.5:1) is rejected');
  check(!checkPinQuad([[0, 0], [1, 1]]).ok, 'fewer than four corners is rejected');
}

/* --------------------------------------------------------- selectDevice -- */

/** Template → image: scale, rotation, translation and a little perspective. */
function camera({ scale = 1.6, rotDeg = 0, tx = 320, ty = 240, p = [0, 0] }) {
  const t = (rotDeg * Math.PI) / 180;
  const cx = 176;
  const cy = 146; // rotate about the template centre
  const c = Math.cos(t) * scale;
  const s = Math.sin(t) * scale;
  const H = [
    [c, -s, tx - c * cx + s * cy],
    [s, c, ty - s * cx - c * cy],
    [p[0], p[1], 1],
  ];
  return (pt) => applyH(H, pt);
}

const shuffle = (q, rng) => {
  const a = [...q];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};

section('selectDevice: orientation from the text window, pin corners within 0.3 pitch');
{
  const rng = mulberry32(9);
  let worstErr = 0;
  let wrong = 0;
  let cases = 0;
  for (const rotDeg of [0, 90, 180, 270, 8, -12, 185]) {
    for (const p of [[0, 0], [2e-4, 0], [0, -3e-4], [1.5e-4, 1.5e-4]]) {
      for (const scale of [1.2, 2.0]) {
        const G = camera({ scale, rotDeg, tx: 640, ty: 400, p });
        const quads = [
          shuffle(tpl.displayWindow.map(G), rng),
          shuffle(tpl.textWindow.map(G), rng),
          shuffle(tpl.bezel.map(G), rng),
          // distractors: the table edge, a sheet of paper, a phone
          [[10, 10], [1270, 10], [1270, 790], [10, 790]],
          [[900, 600], [1200, 620], [1190, 780], [890, 760]],
          [[50, 600], [120, 600], [120, 740], [50, 740]],
        ];
        const res = selectDevice(shuffle(quads, rng), { width: 1280, height: 800 });
        cases += 1;
        const truth = tpl.pinCorners.map(G);
        const pitch = scale * tpl.pinPitchPx;
        if (!res || !res.textFound || res.needsConfirm) { wrong += 1; continue; }
        const err = Math.max(...res.pinCorners.map((q, i) => dist(q, truth[i]))) / pitch;
        worstErr = Math.max(worstErr, err);
        if (err > 0.3) wrong += 1;
      }
    }
  }
  check(wrong === 0, `${cases} synthetic views (0/90/180/270/tilted, perspective, distractors): right quad and rotation`,
    `${wrong} wrong`);
  check(worstErr <= 0.3, 'pin corners within 0.3 pitch, in TL,TR,BR,BL device order', `worst ${worstErr.toFixed(4)} pitch`);
}

section('selectDevice: rejection and needsConfirm');
{
  check(selectDevice([[[0, 0], [300, 0], [300, 300], [0, 300]]]) === null, 'a square quad is rejected (aspect)');
  check(selectDevice([[[0, 0], [600, 0], [600, 100], [0, 100]]]) === null, 'a 6:1 quad is rejected');
  check(selectDevice([]) === null && selectDevice(null) === null, 'no quads → null');
  const G = camera({ scale: 1.5 });
  const only = selectDevice([tpl.displayWindow.map(G)]);
  check(only && only.needsConfirm && !only.textFound, 'display window alone → found, needsConfirm');
  const truth = tpl.pinCorners.map(G);
  // Whatever rotation it guessed, one touch on the real top-left pin fixes it.
  const fixed = resolveConfirmTouch(only.pinCorners, [truth[0][0] + 2, truth[0][1] - 1]);
  const err = fixed ? Math.max(...fixed.map((q, i) => dist(q, truth[i]))) : Infinity;
  check(err < 0.3 * 1.5 * tpl.pinPitchPx, 'the confirm touch on the true TL pin re-orders the corners', err.toFixed(3));
  check(resolveConfirmTouch(only.pinCorners, [0, 0]) === null, 'a touch near no corner → null (fall back to four corners)');
  const tiny = selectDevice([tpl.displayWindow.map(camera({ scale: 0.05 }))], { width: 1280, height: 800 });
  check(tiny === null, 'quads under 1% of the frame are ignored');
}

section('resolveConfirmTouch rotates the order');
{
  const c = tpl.pinCorners;
  const upsideDown = [c[2], c[3], c[0], c[1]]; // the guess had the pad 180° wrong
  const r = resolveConfirmTouch(upsideDown, [c[0][0] + 3, c[0][1] + 3]);
  check(eq(r, c), 'touching the real TL (predicted BR) rotates by 2');
  check(eq(resolveConfirmTouch(c, c[0]), c), 'touching the predicted TL keeps the order');
  check(resolveConfirmTouch(c, [c[0][0] + 11, c[0][1]]) === null, '3.3 pitches away is too far');
}

section('orderQuad and maskPolygons');
{
  const q = orderQuad([[10, 90], [100, 10], [10, 10], [100, 90]]);
  check(eq(q, [[10, 10], [100, 10], [100, 90], [10, 90]]), 'orderQuad → TL, TR, BR, BL');
  const H = homography4(tpl.pinCorners, [[100, 100], [500, 110], [510, 380], [95, 370]]);
  const m = maskPolygons(H);
  const pins = tpl.pinCorners.map((p) => applyH(H, p));
  check(pins.every((p) => inside(m.pinField, p)), 'the mapped pin-field mask contains the mapped corner pins');
  const text = tpl.textWindow.map((p) => applyH(H, p));
  check(text.every((p) => inside(m.textWindow, p)), 'the text mask contains the text window');
  const grown = m.textWindow.map((p, i) => dist(p, text[i]));
  check(grown.every((d) => Math.abs(d - 4 * Math.SQRT2) < 1e-9), 'grown by 4 px per edge (4√2 along the diagonal)');
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
