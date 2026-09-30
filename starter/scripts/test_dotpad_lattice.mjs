#!/usr/bin/env node
/**
 * DOT Pad auto-find from the pin lattice (`src/lib/dotpadLattice.js`).
 *
 *   node starter/scripts/test_dotpad_lattice.mjs
 *
 * Knobs (env): DOTPAD_SPLIT=report|tune|both (augmented split, default report),
 * DOTPAD_AUG=<cases per split> (default 32), DOTPAD_DISTRACTORS=<per kind>
 * (default 6), DOTPAD_NATIVE=1 (also run the 12 MP phone stills at native
 * resolution — slow).
 *
 * OFFLINE and seeded. Sections:
 *   1. maths: least-squares homography, inverse.
 *   2. synthetic pads (dotpadScenes.renderPad): rotations 0/90/180/270 and
 *      arbitrary, 35° tilt, gradient + saturated side (missing columns),
 *      pitch 3 px at 640 × 480 and 20 px at 1920 × 1080, low light, a display
 *      darker than the body, a sparse map, no text line; plus fail-safe cases.
 *   3. distractors with NO pad (pop-it grids, wrong-sized / hexagonal dot
 *      grids, braille text, checkerboards) and real frames with the pin field
 *      erased: every one must return null (false-accept rate).
 *   4. real frames (fixtures/dotpad_frames + ground_truth.json): per-fixture
 *      corner error in px and pins, orientation. Split: hue_handsoff_* were
 *      used while setting parameters; hue_oblique_* and PXL_* are held out.
 *   5. augmented held-out set: the real frames + ground truth re-projected
 *      through random views (rotation, tilt ≤ 40°, pitch 3–20 px, 640 × 480 …
 *      1920 × 1080), colour cast, gamma, an exposure ramp clipping one side,
 *      blur, noise, JPEG round trip. Seeds split in two: the TUNE half draws
 *      only from hue_handsoff_*; the REPORT half (asserted here) draws from
 *      all nine frames with different seeds.
 *   6. multi-frame aggregation.
 */

import {
  aggregateDetections, detectDotpadLattice, fitHomography, invert3,
} from '../src/lib/dotpadLattice.js';
import { applyH, rotateQuad } from '../src/lib/dotpadTemplate.js';
import {
  cornersOf, erasePinField, renderDistractor, renderPad, rng, viewHomography,
} from './fixtures/dotpadScenes.mjs';
import {
  GT, augCase, fmt, pct, realLuma, score, unmap,
} from './fixtures/dotpadRealSet.mjs';

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
const section = (title) => console.log(`\n— ${title} ${'—'.repeat(Math.max(0, 62 - title.length))}`);
const SPLIT = process.env.DOTPAD_SPLIT || 'report';
const N_AUG = +(process.env.DOTPAD_AUG || 32);
const N_DIS = +(process.env.DOTPAD_DISTRACTORS || 6);

/* --------------------------------------------------------------- helpers -- */

const time = (fn) => { const t0 = performance.now(); const r = fn(); return [r, performance.now() - t0]; };

/* ------------------------------------------------------------------ maths -- */

section('maths');
{
  const H = [[1.3, 0.2, 100], [-0.1, 0.9, 50], [0.0004, -0.0002, 1]];
  const rand = rng(7);
  const src = [], dst = [];
  for (let k = 0; k < 300; k++) {
    const p = [rand.uni(0, 60), rand.uni(0, 40)];
    const q = applyH(H, p);
    src.push(p); dst.push([q[0] + 0.05 * rand.gauss(), q[1] + 0.05 * rand.gauss()]);
  }
  const F = fitHomography(src, dst);
  const worst = Math.max(...[[0, 0], [59, 0], [59, 39], [0, 39]].map((p) => {
    const a = applyH(H, p), b = applyH(F, p);
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
  }));
  check(worst < 0.05, 'fitHomography recovers a projective map from 300 noisy points', `worst corner ${worst.toFixed(4)} px`);
  const I = invert3(H);
  const p = applyH(I, applyH(H, [12.5, -3]));
  check(Math.hypot(p[0] - 12.5, p[1] + 3) < 1e-9, 'invert3 round-trips');
  check(fitHomography(src.slice(0, 3), dst.slice(0, 3)) === null, 'fitHomography needs ≥ 4 pairs');
}

/* -------------------------------------------------------------- synthetic -- */

section('synthetic pads');
{
  const cases = [
    { name: 'frontal 0°', rot: 0, pitch: 7 },
    { name: 'rotated 90°', rot: 90, pitch: 6.5 },
    { name: 'rotated 180°', rot: 180, pitch: 6.5 },
    { name: 'rotated 270°', rot: 270, pitch: 6.5 },
    { name: 'rotated 33°, tilt 25°', rot: 33, tilt: 25, ax: 60, pitch: 6 },
    { name: 'tilt 35° (strong perspective)', rot: 0, tilt: 35, ax: 0, pitch: 8 },
    { name: 'gradient + left 4 columns washed out', rot: 0, pitch: 7, hideCols: 4, gain: [0.6, 1.4] },
    { name: 'pitch 3.2 px at 640 × 480, tilt 20°', rot: 30, tilt: 20, pitch: 3.2, W: 640, H: 480 },
    { name: 'pitch 20 px at 1920 × 1080', rot: 4, tilt: 10, pitch: 20, W: 1920, H: 1080, text: false },
    { name: 'low light + noise', rot: 12, pitch: 7, gain: [0.3, 0.35], noise: 5 },
    { name: 'display darker than the body', rot: 0, pitch: 7, windowGrey: 60, bodyGrey: 190, pinGrey: 170 },
    { name: 'sparse map, lowered pins still visible', rot: 8, tilt: 10, pitch: 8, raisedFrac: 0.3, holeGrey: 190 },
    { name: 'no text line → needsConfirm', rot: 0, pitch: 7, text: false, expectConfirm: true },
  ];
  for (const c of cases) {
    const W = c.W || 1280, H = c.H || 720;
    const Hpin = viewHomography({ width: W, height: H, pitchPx: c.pitch, rotDeg: c.rot, tiltDeg: c.tilt || 0, tiltAxisDeg: c.ax || 0, rand: rng(11), marginPins: 26 })
      || viewHomography({ width: W, height: H, pitchPx: c.pitch, rotDeg: c.rot, tiltDeg: c.tilt || 0, tiltAxisDeg: c.ax || 0, rand: rng(11) });
    const img = renderPad({
      width: W, height: H, Hpin, seed: 5, hideCols: c.hideCols, gain: c.gain, noise: c.noise ?? 2,
      windowGrey: c.windowGrey, bodyGrey: c.bodyGrey, pinGrey: c.pinGrey, raisedFrac: c.raisedFrac, holeGrey: c.holeGrey,
      text: c.text,
    });
    const gt = cornersOf(Hpin);
    const [r, ms] = time(() => detectDotpadLattice(img));
    const s = score(r, gt);
    check(s.found && s.maxPins < 0.5, c.name,
      s.found ? `max ${s.maxPins.toFixed(2)} pin, text ${r.textFound}, added ${JSON.stringify(r.added)}, ${ms.toFixed(0)} ms` : `null (${detectDotpadLattice.lastReason})`);
    if (s.found && c.expectConfirm) check(r.needsConfirm, `  ${c.name}: needsConfirm`);
    if (s.found && c.rot % 90 === 0 && !c.expectConfirm && c.text !== false && !c.tilt) {
      check(r.textFound && s.orientationOk, `  ${c.name}: text line resolves the orientation`);
    }
    if (s.found && c.hideCols) check(r.added.left === c.hideCols && r.added.right === 0, `  ${c.name}: added on the washed-out side`, JSON.stringify(r.added));
  }

  // Fail-safe: when the evidence is not there the answer is null, not a guess.
  const Hpin = viewHomography({ width: 1280, height: 720, pitchPx: 7, rotDeg: 5, rand: rng(3) });
  const gt = cornersOf(Hpin);
  for (const [name, o] of [
    ['12 columns washed out (beyond maxMissing)', { hideCols: 12 }],
    ['sparse map, lowered pins invisible', { raisedFrac: 0.3, holesVisible: false }],
  ]) {
    const r = detectDotpadLattice(renderPad({ width: 1280, height: 720, Hpin, seed: 9, ...o }));
    const s = score(r, gt);
    check(!r || s.correct, `fail-safe: ${name}`, r ? `returned, max ${s.maxPins.toFixed(2)} pin` : `null (${detectDotpadLattice.lastReason})`);
  }
  // The dark GAPS between densely packed bright pins form a lattice too, half a
  // pitch off. Forcing the inverted pass alone must never return that lattice.
  for (const [W, H, pitch] of [[640, 480, 3.2], [1280, 720, 7]]) {
    const Hp = viewHomography({ width: W, height: H, pitchPx: pitch, rotDeg: 30, tiltDeg: 20, rand: rng(3) });
    const r = detectDotpadLattice(renderPad({ width: W, height: H, Hpin: Hp, seed: 5, gain: [0.8, 1.3], noise: 3 }), { polarities: [-1] });
    const s = score(r, cornersOf(Hp));
    check(!r || s.correct, `fail-safe: inverted pass on bright pins (gap lattice), pitch ${pitch}`,
      r ? `returned, max ${s.maxPins.toFixed(2)} pin` : `null (${detectDotpadLattice.lastReason})`);
  }
}

/* ------------------------------------------------------------ distractors -- */

section('distractors (no pad): every one must be null');
let distractorFA = 0, distractorN = 0;
{
  const kinds = ['popit', 'grid-small', 'grid-large', 'grid-near', 'hex', 'braille', 'checker'];
  for (const kind of kinds) {
    let fa = 0;
    const n = N_DIS;
    for (let k = 0; k < n; k++) {
      const [W, H] = k % 2 ? [1280, 720] : [640, 480];
      const r = detectDotpadLattice(renderDistractor(kind, { width: W, height: H, seed: 100 + 17 * k + kind.length }));
      if (r) fa++;
    }
    distractorFA += fa; distractorN += n;
    check(fa === 0, `synthetic ${kind} × ${n}`, fa ? `${fa} accepted` : '');
  }
}

/* ---------------------------------------------------------------- real -- */

section('real frames');
{
  for (const [file, g] of Object.entries(GT)) {
    const { img, f } = realLuma(file);
    const [r, ms] = time(() => detectDotpadLattice(img));
    const corners = r ? r.pinCorners.map(unmap(f)) : null;
    const s = score(r && { ...r, pinCorners: corners }, g.corners);
    const tag = `${file} [${g.split}] ${img.width}×${img.height}${f > 1 ? ` (1/${f})` : ''}`;
    check(s.found && s.maxPins <= 1 && s.orientationOk === true, tag, s.found
      ? `px ${fmt(s.px, 1)} | pins ${fmt(s.pins)} | text ${r.textFound ? 'found' : 'no'} orientation ${s.orientationOk ? 'ok' : 'WRONG/unknown'} | ${ms.toFixed(0)} ms`
      : `null (${detectDotpadLattice.lastReason})`);
    if (process.env.DOTPAD_NATIVE && f > 1) {
      const [rn, msn] = time(() => detectDotpadLattice(realLuma(file).full));
      const sn = score(rn, g.corners);
      check(sn.found && sn.maxPins <= 1 && sn.orientationOk === true, `  native ${realLuma(file).full.width}×${realLuma(file).full.height}`,
        sn.found ? `px ${fmt(sn.px, 1)} | pins ${fmt(sn.pins)} | ${msn.toFixed(0)} ms` : `null (${detectDotpadLattice.lastReason})`);
    }
  }

  // Real negatives: the same frames with the pin field painted over.
  let fa = 0;
  for (const [file, g] of Object.entries(GT)) {
    const { img, map } = realLuma(file);
    const r = detectDotpadLattice(erasePinField(img, g.corners.map(map)));
    if (r) fa++;
  }
  distractorFA += fa; distractorN += Object.keys(GT).length;
  check(fa === 0, `real frames with the pin field erased × ${Object.keys(GT).length} → null`, fa ? `${fa} accepted` : '');
}

/* -------------------------------------------------------------- augmented -- */

function runAugmented(split) {
  section(`augmented (${split} split, ${N_AUG} cases)`);
  const rows = [];
  const negatives = { n: 0, fa: 0 };
  for (let s = 0; s < N_AUG; s++) {
    const c = augCase(s, split);
    if (!c) continue;
    const [r, ms] = time(() => detectDotpadLattice(c.img));
    const sc = score(r, c.gt);
    rows.push({ ...sc, ms, desc: c.desc, reason: r ? null : detectDotpadLattice.lastReason });
    const tag = !sc.found ? 'null' : sc.falseAccept ? 'FALSE-ACCEPT' : sc.correct ? 'ok' : 'inaccurate';
    console.log(`  ${String(s).padStart(2)} ${tag.padEnd(12)} ${sc.found ? `max ${sc.maxPins.toFixed(2)} pin text ${sc.textFound ? 'Y' : 'n'}` : `(${rows.at(-1).reason})`.padEnd(22)}  ${ms.toFixed(0).padStart(5)} ms  ${c.desc}`);
    // Every other case also as a NEGATIVE: same view, pin field painted over.
    if (s % 2 === 0) {
      const neg = detectDotpadLattice(erasePinField(c.img, c.gt));
      negatives.n += 1;
      if (neg) { negatives.fa += 1; console.log(`     ↳ erased-field negative ACCEPTED (${c.desc})`); }
    }
  }
  const found = rows.filter((r) => r.found);
  const allPins = found.flatMap((r) => r.pins);
  const maxes = found.map((r) => r.maxPins);
  const stats = {
    n: rows.length,
    failRate: 1 - found.length / rows.length,
    falseAccept: rows.filter((r) => r.found && r.falseAccept).length / rows.length,
    inaccurate: found.filter((r) => !r.correct && !r.falseAccept).length / rows.length,
    medianPins: pct(allPins, 0.5), p95Pins: pct(allPins, 0.95), p95MaxPins: pct(maxes, 0.95),
    textRate: found.filter((r) => r.textFound).length / Math.max(1, found.length),
    orientWrong: found.filter((r) => r.textFound && !r.orientationOk).length,
    medianMs: pct(rows.map((r) => r.ms), 0.5), p95Ms: pct(rows.map((r) => r.ms), 0.95),
    negatives,
  };
  distractorFA += negatives.fa; distractorN += negatives.n;
  console.log(`  → n ${stats.n} | fail ${(100 * stats.failRate).toFixed(0)}% | false-accept ${(100 * stats.falseAccept).toFixed(1)}% | inaccurate(1–2 pin) ${(100 * stats.inaccurate).toFixed(0)}%`
    + ` | corner err median ${stats.medianPins.toFixed(3)} pin, p95 ${stats.p95Pins.toFixed(3)} pin (per-case max p95 ${stats.p95MaxPins.toFixed(3)})`
    + ` | text found ${(100 * stats.textRate).toFixed(0)}%, orientation wrong ${stats.orientWrong} | ${stats.medianMs.toFixed(0)} ms median, ${stats.p95Ms.toFixed(0)} ms p95`
    + ` | erased-field negatives accepted ${negatives.fa}/${negatives.n}`);
  return stats;
}

if (SPLIT === 'tune' || SPLIT === 'both') runAugmented('tune');
if (SPLIT === 'report' || SPLIT === 'both') {
  const st = runAugmented('report');
  check(st.falseAccept === 0, 'augmented: no confident wrong answers', `${(100 * st.falseAccept).toFixed(1)}%`);
  check(st.negatives.fa === 0, 'augmented: erased-field negatives all null', `${st.negatives.fa}/${st.negatives.n}`);
  check(st.failRate <= 0.25, 'augmented: fail (null) rate ≤ 25%', `${(100 * st.failRate).toFixed(0)}%`);
  check(st.medianPins < 0.2 && st.p95Pins < 1, 'augmented: corner error median < 0.2 pin, p95 < 1 pin',
    `${st.medianPins.toFixed(3)} / ${st.p95Pins.toFixed(3)}`);
}
console.log(`\n  distractor false-accepts (synthetic + erased real + erased augmented): ${distractorFA} / ${distractorN}`);

/* ------------------------------------------------------------ aggregation -- */

section('aggregateDetections');
{
  const base = [[100, 100], [400, 110], [395, 300], [98, 290]];
  const jit = (q, d) => q.map(([x, y], k) => [x + d * Math.cos(k), y + d * Math.sin(k)]);
  const det = (q, textFound) => ({ pinCorners: q, textFound, needsConfirm: !textFound, pitchPx: 5 });
  const results = [
    det(jit(base, 0.5), true),
    det(rotateQuad(jit(base, -0.4), 2), false), // same pad, 180° order, no text
    null,
    det(jit(base, 0.3), true),
    det(jit(base, 40), true),                   // an outlier frame
    det(jit(base, -0.2), false),
  ];
  const a = aggregateDetections(results);
  check(a && a.agreed === 4 && a.frames === 5, 'outlier dropped, nulls ignored', a && `agreed ${a.agreed}/${a.frames}`);
  check(a && a.pinCorners.every((p, k) => Math.hypot(p[0] - base[k][0], p[1] - base[k][1]) < 1), 'median corners, in the text-confirmed order');
  check(a && a.textFound && !a.needsConfirm, 'text votes settle the orientation');
  const b = aggregateDetections([det(base, false), det(rotateQuad(base, 2), false)]);
  check(b && b.needsConfirm, 'no text votes → needsConfirm');
  const c = aggregateDetections([det(base, true), det(rotateQuad(base, 2), true)]);
  check(c && c.needsConfirm, 'contradicting text votes → needsConfirm');
  check(aggregateDetections([null, null]) === null, 'all null → null');
}

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);
