#!/usr/bin/env node
/**
 * DOT Pad drift watchdog (`src/lib/dotpadWatchdog.js`).
 *
 *   node starter/scripts/test_dotpad_watchdog.mjs
 *
 * OFFLINE. Sections:
 *   1. decision logic on hand-made quads: agree, ambiguous band, a single
 *      outlier ignored, two consistent disagreements → re-register, two
 *      INconsistent ones do not, null detections ignored, orientation kept
 *      (and overridden only by the text line), announcement cooldown, pitch
 *      normalisation, scheduling.
 *   2. replay on a real frame: hue_oblique_00.jpg is the "registered" frame
 *      (corners from the lattice detector, as auto-find would get them);
 *      synthetic warps of it play "pad not moved" and "pad moved", and the
 *      tracked corners stay at the registered ones (AKAZE ≈ identity, which is
 *      the bug being fixed).
 */

import {
  WATCHDOG_AGREE_PINS, WATCHDOG_ANNOUNCE_COOLDOWN_MS, WATCHDOG_CONSECUTIVE, WATCHDOG_HANDS_OFF_MS,
  WATCHDOG_INTERVAL_MS, WATCHDOG_MOVED_PINS, WATCHDOG_UNSEEN_INTERVAL_MS,
  compareCorners, createDriftWatchdog, pitchFromCorners, watchdogDue,
} from '../src/lib/dotpadWatchdog.js';
import { detectDotpadLattice, invert3, latticeSearch } from '../src/lib/dotpadLattice.js';
import { applyH, rotateQuad } from '../src/lib/dotpadTemplate.js';
import { erasePinField } from './fixtures/dotpadScenes.mjs';
import { GT, realLuma } from './fixtures/dotpadRealSet.mjs';

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
const section = (title) => console.log(`\n— ${title} ${'—'.repeat(Math.max(0, 62 - title.length))}`);
const maxDist = (p, q) => Math.max(...p.map((c, k) => Math.hypot(c[0] - q[k][0], c[1] - q[k][1])));

/* --------------------------------------------------------------- helpers -- */

// A fronto-parallel pad: pitch 7 px, TL at (300, 200) → 59 × 39 pitches.
const PITCH = 7;
const quadAt = (x, y, pitch = PITCH) => [[x, y], [x + 59 * pitch, y], [x + 59 * pitch, y + 39 * pitch], [x, y + 39 * pitch]];
const TRACKED = quadAt(300, 200);
const shift = (q, dx, dy) => q.map(([x, y]) => [x + dx, y + dy]);
const det = (q, extra = {}) => ({ pinCorners: q, pitchPx: PITCH, textFound: false, ...extra });

/* ------------------------------------------------------------ decisions -- */

section('constants');
check(WATCHDOG_AGREE_PINS < WATCHDOG_MOVED_PINS, 'agree threshold below moved threshold (hysteresis band)',
  `${WATCHDOG_AGREE_PINS} < ${WATCHDOG_MOVED_PINS}`);
check(WATCHDOG_CONSECUTIVE >= 2, 'at least two consecutive disagreements before re-registering');
console.log(`     interval ${WATCHDOG_INTERVAL_MS} ms, hands-off ${WATCHDOG_HANDS_OFF_MS} ms, cooldown ${WATCHDOG_ANNOUNCE_COOLDOWN_MS} ms`);

section('agree / ambiguous');
{
  const dog = createDriftWatchdog();
  const r = dog.update(TRACKED, det(shift(TRACKED, 0.3 * PITCH, -0.2 * PITCH)), 1000);
  check(r.verdict === 'agree' && r.action === 'none', 'small offset (0.3 pin) agrees', `${r.pins.toFixed(2)} pin`);
  check(dog.lastVerifiedAt === 1000, 'agreement refreshes lastVerifiedAt');
  const u = dog.update(TRACKED, det(shift(TRACKED, 0.85 * PITCH, 0)), 2000);
  check(u.verdict === 'uncertain' && u.action === 'none', '0.85 pin is the ambiguous band — no action', `${u.pins.toFixed(2)} pin`);
  check(dog.lastVerifiedAt === 1000, 'ambiguous result does not count as verified');
}

section('hysteresis');
{
  const dog = createDriftWatchdog();
  const moved = det(shift(TRACKED, 3 * PITCH, 1 * PITCH));
  const a = dog.update(TRACKED, moved, 0);
  check(a.verdict === 'disagree' && a.action === 'none' && a.streak === 1, 'first disagreement alone does nothing', `${a.pins.toFixed(2)} pin`);
  const b = dog.update(TRACKED, det(TRACKED), 1500);
  check(b.verdict === 'agree' && dog.streak === 0, 'an agreeing check in between ends the streak (single outlier ignored)');
  const c = dog.update(TRACKED, moved, 3000);
  check(c.action === 'none' && c.streak === 1, 'the next disagreement starts over at 1');
  const d = dog.update(TRACKED, det(shift(TRACKED, 3.2 * PITCH, 1.1 * PITCH)), 4500);
  check(d.action === 'reregister' && d.verdict === 'moved', 'two consecutive consistent disagreements → re-register', `${d.pins.toFixed(2)} pin`);
  check(maxDist(d.corners, shift(TRACKED, 3.2 * PITCH, 1.1 * PITCH)) < 1e-9, 're-registers with the LATEST measured corners');
  check(dog.streak === 0, 'streak cleared after re-registering');
}
{
  const dog = createDriftWatchdog();
  dog.update(TRACKED, det(shift(TRACKED, 4 * PITCH, 0)), 0);
  const b = dog.update(TRACKED, det(shift(TRACKED, -5 * PITCH, 2 * PITCH)), 1500);
  check(b.action === 'none' && b.streak === 1, 'two disagreements at DIFFERENT places do not re-register');
  const c = dog.update(TRACKED, det(shift(TRACKED, -5.2 * PITCH, 2 * PITCH)), 3000);
  check(c.action === 'reregister', '… a third consistent with the second does');
}
{
  const dog = createDriftWatchdog();
  dog.update(TRACKED, det(shift(TRACKED, 3 * PITCH, 0)), 0);
  const u = dog.update(TRACKED, det(shift(TRACKED, 0.9 * PITCH, 0)), 1500);
  check(u.verdict === 'uncertain' && dog.streak === 0, 'an ambiguous-band check also ends the streak');
}

section('null detections');
{
  const dog = createDriftWatchdog();
  const n0 = dog.update(TRACKED, null, 0);
  check(n0.verdict === 'none' && n0.action === 'none', 'null detection → no action');
  check(dog.lastVerifiedAt === null, 'null detection is not a verification');
  check(dog.intervalMs === WATCHDOG_UNSEEN_INTERVAL_MS && WATCHDOG_UNSEEN_INTERVAL_MS > WATCHDOG_INTERVAL_MS,
    'after a check that saw no lattice, the next waits longer (a failed search is the expensive one)');
  dog.update(TRACKED, det(shift(TRACKED, 3 * PITCH, 0)), 1500);
  check(dog.intervalMs === WATCHDOG_INTERVAL_MS, '… and a detection restores the normal interval');
  const n1 = dog.update(TRACKED, null, 3000);
  check(n1.action === 'none' && dog.streak === 1, 'null between disagreements leaves the streak alone (no evidence either way)');
  const r = dog.update(TRACKED, det(shift(TRACKED, 3 * PITCH, 0)), 4500);
  check(r.action === 'reregister', '… so the next consistent disagreement re-registers');
  check(dog.update(null, det(TRACKED), 6000).action === 'none', 'no tracked corners → no action');
}

section('orientation');
{
  // The detector without text evidence may hand back the 180° order.
  const flipped = rotateQuad(shift(TRACKED, 0.2 * PITCH, 0.1 * PITCH), 2);
  const cmp = compareCorners(TRACKED, det(flipped));
  check(cmp.rot === 2 && cmp.pins < WATCHDOG_AGREE_PINS, 'no text: 180°-ordered detection is re-ordered to the tracked orientation',
    `rot ${cmp.rot}, ${cmp.pins.toFixed(2)} pin`);
  check(maxDist(cmp.corners, TRACKED) < 0.3 * PITCH, 'aligned corners sit on the tracked ones');

  const dog = createDriftWatchdog();
  const moved = rotateQuad(shift(TRACKED, 4 * PITCH, 2 * PITCH), 2);
  dog.update(TRACKED, det(moved), 0);
  const r = dog.update(TRACKED, det(moved), 1500);
  check(r.action === 'reregister' && maxDist(r.corners, shift(TRACKED, 4 * PITCH, 2 * PITCH)) < 1e-9,
    'a moved pad (no text) re-registers with the TRACKED orientation preserved');

  const agreeText = compareCorners(TRACKED, det(TRACKED, { textFound: true }));
  check(agreeText.rot === 0 && !agreeText.textOverride && agreeText.pins < 1e-9, 'text agreeing with the tracked order: no override');

  // Text line read, and it says TL is the opposite corner: the pad was turned 180° in place.
  const turned = compareCorners(TRACKED, det(rotateQuad(TRACKED, 2), { textFound: true }));
  check(turned.textOverride && turned.rot === 0 && turned.pins > 30, 'text contradicting the tracked order wins (pad turned 180°)',
    `${turned.pins.toFixed(1)} pin`);
  const dog2 = createDriftWatchdog();
  dog2.update(TRACKED, det(rotateQuad(TRACKED, 2), { textFound: true }), 0);
  const t2 = dog2.update(TRACKED, det(rotateQuad(TRACKED, 2), { textFound: true }), 1500);
  check(t2.action === 'reregister' && maxDist(t2.corners, rotateQuad(TRACKED, 2)) < 1e-9,
    '… and twice in a row re-registers in the text-line orientation');
}

section('announcement cooldown');
{
  const dog = createDriftWatchdog();
  const moveAt = (q, t0) => { dog.update(TRACKED, det(q), t0); return dog.update(TRACKED, det(q), t0 + 1500); };
  const a = moveAt(shift(TRACKED, 3 * PITCH, 0), 0);
  check(a.action === 'reregister' && a.announce, 'first re-registration is announced');
  const b = moveAt(shift(TRACKED, -3 * PITCH, 0), 1600);
  check(b.action === 'reregister' && !b.announce, `a second within ${WATCHDOG_ANNOUNCE_COOLDOWN_MS} ms re-registers silently`);
  const c = moveAt(shift(TRACKED, 3 * PITCH, 0), 1500 + WATCHDOG_ANNOUNCE_COOLDOWN_MS);
  check(c.action === 'reregister' && c.announce, 'after the cooldown it is announced again');
  dog.reset();
  const d = moveAt(shift(TRACKED, -3 * PITCH, 0), 1500 + WATCHDOG_ANNOUNCE_COOLDOWN_MS + 2000);
  check(d.action === 'reregister' && !d.announce, 'reset() (new manual registration) does not clear the cooldown');
}

section('pitch normalisation');
{
  const off = shift(TRACKED, 8, 0); // 8 px
  const small = compareCorners(TRACKED, { pinCorners: off, pitchPx: 5 });
  const large = compareCorners(TRACKED, { pinCorners: off, pitchPx: 20 });
  check(Math.abs(small.pins - 1.6) < 1e-9 && Math.abs(large.pins - 0.4) < 1e-9, 'same 8 px → 1.6 pin at pitch 5, 0.4 pin at pitch 20');
  const dog = createDriftWatchdog();
  check(dog.update(TRACKED, { pinCorners: off, pitchPx: 20 }, 0).verdict === 'agree', '8 px at pitch 20 agrees');
  check(dog.update(TRACKED, { pinCorners: off, pitchPx: 5 }, 1500).verdict === 'disagree', '8 px at pitch 5 disagrees');
  check(Math.abs(pitchFromCorners(TRACKED) - PITCH) < 1e-9, 'pitchFromCorners recovers the pitch of a square lattice');
  const noPitch = compareCorners(TRACKED, { pinCorners: off });
  check(Math.abs(noPitch.pins - 8 / PITCH) < 1e-9, 'missing pitchPx falls back to the pitch implied by the corners');
  const gt = GT['hue_oblique_00.jpg'];
  const p = pitchFromCorners(gt.corners);
  check(Math.abs(p / gt.pitchPx - 1) < 0.1, 'pitchFromCorners on the real oblique frame ≈ its measured pitch', `${p.toFixed(2)} vs ${gt.pitchPx}`);
}

section('scheduling');
{
  const due = (now, zeroSince, lastCheckAt) => watchdogDue({ now, zeroSince, lastCheckAt });
  check(!due(10000, null, 0), 'hand in view → not due');
  check(!due(10000, 10000 - WATCHDOG_HANDS_OFF_MS + 1, 0), 'hand just left → not due yet');
  check(due(10000, 10000 - WATCHDOG_HANDS_OFF_MS, 0), 'hands off long enough, interval passed → due');
  check(!due(10000, 0, 10000 - WATCHDOG_INTERVAL_MS + 1), 'within the interval of the last check → not due');
  check(due(10000, 0, null), 'never checked → due');
}

/* -------------------------------------------------------- replay (real) -- */

section('replay: hue_oblique_00.jpg + synthetic warps');
{
  const { full } = realLuma('hue_oblique_00.jpg');
  const { width: W, height: Hh } = full;

  /** Inverse-mapped bilinear warp: out(x) = src(Hinv · x); outside → mean grey. */
  const warp = (img, H) => {
    const Hi = invert3(H);
    const out = new Uint8Array(W * Hh);
    let mean = 0; for (let i = 0; i < img.data.length; i++) mean += img.data[i]; mean /= img.data.length;
    for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
      const [sx, sy] = applyH(Hi, [x, y]);
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      if (x0 < 0 || y0 < 0 || x0 >= W - 1 || y0 >= Hh - 1) { out[y * W + x] = mean; continue; }
      const fx = sx - x0, fy = sy - y0, o = y0 * W + x0, d = img.data;
      out[y * W + x] = Math.round((d[o] * (1 - fx) + d[o + 1] * fx) * (1 - fy) + (d[o + W] * (1 - fx) + d[o + W + 1] * fx) * fy);
    }
    return { data: out, width: W, height: Hh };
  };
  /** Rotation by `deg` about (cx, cy), then a translation. */
  const rigid = (deg, cx, cy, dx, dy) => {
    const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    return [[c, -s, cx - c * cx + s * cy + dx], [s, c, cy - s * cx - c * cy + dy], [0, 0, 1]];
  };
  const time = (fn) => { const t0 = performance.now(); const r = fn(); return [r, performance.now() - t0]; };

  // "Registration": the detector on the original frame, as auto-find would see it.
  const [reg, tReg] = time(() => detectDotpadLattice(full));
  check(!!reg && reg.textFound, 'registered frame: lattice found with text line', reg
    ? `pitch ${reg.pitchPx.toFixed(2)} px, ${maxDist(reg.pinCorners, GT['hue_oblique_00.jpg'].corners).toFixed(2)} px from GT, ${tReg.toFixed(0)} ms` : 'null');
  if (reg) {
    const tracked = reg.pinCorners; // AKAZE ≈ identity: background did not move
    const pitchHint = reg.pitchPx;
    const cen = tracked.reduce((s, p) => [s[0] + p[0] / 4, s[1] + p[1] / 4], [0, 0]);

    /** One watchdog check: the generator stepped like the render loop, counting ticks. */
    const runCheck = (img) => {
      const it = latticeSearch(img, { pitchHint });
      let ticks = 0, worst = 0, st;
      for (;;) {
        const t0 = performance.now();
        st = it.next();
        worst = Math.max(worst, performance.now() - t0);
        ticks += 1;
        if (st.done) break;
      }
      return { det: st.value, ticks, worst };
    };

    const cases = [
      { name: 'unmoved (identity)', H: rigid(0, 0, 0, 0, 0), expect: 'agree' },
      { name: 'nudged 0.3 pin', H: rigid(0, 0, 0, 0.3 * pitchHint, 0), expect: 'agree' },
      { name: 'slid 3 pins right, 1 down', H: rigid(0, 0, 0, 3 * pitchHint, 1 * pitchHint), expect: 'moved' },
      { name: 'rotated 4° about the pad + 1.5 pins', H: rigid(4, cen[0], cen[1], 0, 1.5 * pitchHint), expect: 'moved' },
      { name: 'turned 180° in place', H: rigid(180, cen[0], cen[1], 0, 0), expect: 'moved' },
    ];
    for (const cs of cases) {
      const img = warp(full, cs.H);
      const truth = tracked.map((p) => applyH(cs.H, p));
      const dog = createDriftWatchdog();
      const c1 = runCheck(img);
      const r1 = dog.update(tracked, c1.det, 0);
      const c2 = runCheck(img);
      const r2 = dog.update(tracked, c2.det, WATCHDOG_INTERVAL_MS);
      const info = `check 1: ${r1.verdict} ${r1.pins?.toFixed(2)} pin (${c1.ticks} ticks, worst ${c1.worst.toFixed(0)} ms); `
        + `check 2: ${r2.verdict}`;
      if (cs.expect === 'agree') {
        check(r1.verdict === 'agree' && r2.verdict === 'agree', `${cs.name}: agrees, no re-registration`, info);
      } else {
        check(r1.verdict === 'disagree' && r2.action === 'reregister', `${cs.name}: flagged once, re-registered on the second check`, info);
        if (r2.action === 'reregister') {
          // `truth` follows the pad's own pins through the warp, so it is in the
          // PAD's order even when turned 180° (its TL now sits where BR was).
          const err = maxDist(r2.corners, truth) / c2.det.pitchPx;
          check(err < 1, `${cs.name}: new corners on the moved pad, in the pad's own orientation`, `${err.toFixed(2)} pin`);
        }
      }
    }

    // Pins invisible: the field painted over → null → no action, and its cost.
    const blank = erasePinField(full, tracked);
    const cb = runCheck(blank);
    const dog = createDriftWatchdog();
    const rb = dog.update(tracked, cb.det, 0);
    check(cb.det === null && rb.action === 'none', 'pin field blank: no detection, no action',
      `${cb.ticks} ticks, worst tick ${cb.worst.toFixed(0)} ms (${detectDotpadLattice.lastReason})`);
  }
}

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);
