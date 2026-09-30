#!/usr/bin/env node
/**
 * DOT Pad viewport mirror — pin arithmetic, parity with Audiom, the tracker.
 *
 *   node starter/scripts/test_dotpad_viewport.mjs
 *
 * FULLY OFFLINE, seeded. `lib/dotpadViewport.js` replays Audiom's
 * `panViewportToKeepAvatar` in pin units (docs/dotpad-camio-design.md §3). The
 * parity group checks it against the verbatim METRE port in
 * `fixtures/fakeAudiom.mjs` on 10k random inputs, so a unit slip, a loop-order
 * change or a different rounding rule shows up here rather than as a finger
 * that lands one pin off on a real pad.
 */

import {
  DOTPAD_GEOMETRY,
  worldToPin,
  pinToWorld,
  panToKeep,
  isInnerPin,
  createModel,
  toQ,
  toLngLat,
  createViewportTracker,
  headingAxisOf,
} from '../src/lib/dotpadViewport.js';
import { enuForward, enuInverse } from '../src/lib/enu.js';
import { worldToPinMetres, panViewportToKeepAvatar, mulberry32 } from './fixtures/fakeAudiom.mjs';

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
const section = (title) => console.log(`\n— ${title} ${'—'.repeat(Math.max(0, 62 - title.length))}`);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ------------------------------------------------------------ geometry -- */

section('geometry is Audiom\'s (F1), centre pin is (30, 20)');
check(eq({ ...DOTPAD_GEOMETRY }, { W: 60, H: 40, o: 2 }), 'DOTPAD_GEOMETRY = {60, 40, 2}');
check(Object.isFrozen(DOTPAD_GEOMETRY), 'and frozen');
check(eq(worldToPin([0, 0], [0, 0]), [30, 20]), 'the anchor sits on pin (30, 20)');
check(eq(worldToPin([5, 3], [0, 0]), [35, 17]), '+x is right, +y is UP (pin y counts down)');

/* ------------------------------------------------------- port parity -- */

section('parity with the metre port of viewport.ts — 10k random inputs');
{
  const rng = mulberry32(20260930);
  const MPP = [0.01, 0.25, 0.3048, 1, 20, 100, 1609.344, 25000];
  let pinMismatch = 0;
  let panMismatch = 0;
  let firstBad = '';
  for (let i = 0; i < 10000; i++) {
    const mpp = MPP[Math.floor(rng() * MPP.length)];
    const anchor = [(rng() - 0.5) * 2e4, (rng() - 0.5) * 2e4];
    const c = [Math.round((rng() - 0.5) * 10) * 56, Math.round((rng() - 0.5) * 10) * 36];
    // Lattice points mostly (what finger targets and grid steps produce), and
    // off-lattice points kept clear of the x.5 ties float noise could flip.
    const lattice = rng() < 0.7;
    const frac = () => (lattice ? 0 : (rng() - 0.5) * 0.98);
    const q = [c[0] + Math.round((rng() - 0.5) * 200) + frac(), c[1] + Math.round((rng() - 0.5) * 140) + frac()];
    const viewport = {
      center: [anchor[0] + c[0] * mpp, anchor[1] + c[1] * mpp], width: 60, height: 40, metersPerPin: mpp, overlapPins: 2,
    };
    const pos = [anchor[0] + q[0] * mpp, anchor[1] + q[1] * mpp];
    const a = worldToPin(q, c);
    const b = worldToPinMetres(pos, viewport);
    if (!eq(a, b)) { pinMismatch += 1; if (!firstBad) firstBad = `pin ${a} vs ${b} q=${q} c=${c} mpp=${mpp}`; }
    const pc = panToKeep(c, q);
    const pv = panViewportToKeepAvatar(viewport, pos);
    const pvPins = [Math.round((pv.center[0] - anchor[0]) / mpp), Math.round((pv.center[1] - anchor[1]) / mpp)];
    if (!eq(pc, pvPins)) { panMismatch += 1; if (!firstBad) firstBad = `pan ${pc} vs ${pvPins} q=${q} c=${c} mpp=${mpp}`; }
  }
  check(pinMismatch === 0, 'worldToPin (pins) === worldToPin (metres)', `${pinMismatch} mismatches ${firstBad}`);
  check(panMismatch === 0, 'panToKeep (pins) === panViewportToKeepAvatar (metres)', `${panMismatch} mismatches ${firstBad}`);
}

/* ------------------------------------------------------- inner band -- */

section('inner band edges: [2..57] × [2..37]');
check(!isInnerPin([1, 20]) && isInnerPin([2, 20]) && isInnerPin([57, 20]) && !isInnerPin([58, 20]),
  'x: 1 out, 2 in, 57 in, 58 out');
check(!isInnerPin([30, 1]) && isInnerPin([30, 2]) && isInnerPin([30, 37]) && !isInnerPin([30, 38]),
  'y: 1 out, 2 in, 37 in, 38 out');
check(!isInnerPin(null), 'null is not inner');

section('worldToPin(pinToWorld(p)) = p for every pin, several centres');
{
  let bad = 0;
  for (const c of [[0, 0], [56, -36], [-112, 72]]) {
    for (let x = 0; x < 60; x++) for (let y = 0; y < 40; y++) {
      if (!eq(worldToPin(pinToWorld([x, y], c), c), [x, y])) bad += 1;
    }
  }
  check(bad === 0, 'all 3 × 2400 pins round-trip', `${bad} bad`);
}

section('walking from the centre pages at the border band');
{
  let c = [0, 0];
  let q = [0, 0];
  let pagedAt = null;
  for (let n = 1; n <= 28; n++) {
    q = [n, 0];
    const next = panToKeep(c, q);
    if (next !== c && pagedAt === null) pagedAt = n;
    c = next;
  }
  check(pagedAt === 28, 'right: no page until the avatar would be on pin 58', `paged at step ${pagedAt}`);
  check(eq(c, [56, 0]), 'centre moves by +56 pins', JSON.stringify(c));
  check(eq(worldToPin(q, c), [2, 20]), 'avatar lands on pin 2', JSON.stringify(worldToPin(q, c)));
  check(eq(panToKeep([0, 0], [27, 0]), [0, 0]), 'pin 57 does not page');

  c = [0, 0];
  pagedAt = null;
  for (let n = 1; n <= 18; n++) {
    q = [0, -n];
    const next = panToKeep(c, q);
    if (next !== c && pagedAt === null) pagedAt = n;
    c = next;
  }
  check(pagedAt === 18, 'down: pages when the avatar would be on pin row 38', `paged at step ${pagedAt}`);
  check(eq(c, [0, -36]) && eq(worldToPin(q, c), [30, 2]), 'centre −36, avatar lands on row 2',
    `${JSON.stringify(c)} ${JSON.stringify(worldToPin(q, c))}`);

  c = panToKeep([0, 0], [0, 19]);
  check(eq(c, [0, 36]) && eq(worldToPin([0, 19], c), [30, 37]), 'up: row 1 pages +36 onto row 37');
  check(eq(panToKeep([0, 0], [200, 0]), [224, 0]), 'a long jump pages repeatedly, like the upstream while-loop');
}

/* ---------------------------------------------------------------- ENU -- */

section('ENU port round trip');
{
  let worst = 0;
  const rng = mulberry32(7);
  for (let i = 0; i < 200; i++) {
    const origin = [(rng() - 0.5) * 340, (rng() - 0.5) * 160];
    const L = [origin[0] + (rng() - 0.5) * 0.4, origin[1] + (rng() - 0.5) * 0.4];
    const back = enuInverse(enuForward(L, origin), origin);
    worst = Math.max(worst, Math.abs(back[0] - L[0]), Math.abs(back[1] - L[1]));
  }
  check(worst < 1e-9, 'enuInverse(enuForward(L)) ≈ L to 1e-9°', `worst ${worst.toExponential(2)}`);
  const en = enuForward([-73.99 + 0.001, 40.7], [-73.99, 40.7]);
  check(Math.abs(en[0] - 84.4) < 0.5 && Math.abs(en[1]) < 0.01, '0.001° of longitude at 40.7°N ≈ 84 m east', JSON.stringify(en));
}

/* --------------------------------------------------------------- model -- */

section('model: lng/lat ↔ world pins');
{
  const p0 = [-73.98, 40.75];
  const A = [[20, 0], [0, 20]]; // 20 m pins, heading 0
  const model = createModel({ plane: 'enu', planeOrigin: [-73.981, 40.749], p0, A, metresPerPin: 20 });
  const q = toQ(model, p0);
  check(Math.hypot(q[0], q[1]) < 1e-9, 'p0 is the origin of world pins');
  const L = toLngLat(model, [3, -2]);
  const back = toQ(model, L);
  check(Math.abs(back[0] - 3) < 1e-9 && Math.abs(back[1] + 2) < 1e-9, 'toQ(toLngLat(q)) = q', JSON.stringify(back));
  check(headingAxisOf(0) === 0 && headingAxisOf(90) === 0 && Math.abs(headingAxisOf(37) - 53) < 1e-12,
    'headingAxisOf: cardinal headings share axis 0; 37° → 53°');
}

/* ------------------------------------------------------------- tracker -- */

const IDENT = () => createModel({ plane: 'identity', planeOrigin: [0, 0], p0: [0, 0], A: [[1, 0], [0, 1]] });
const at = (x, y) => [x, y]; // identity model with unit A: lng/lat IS world pins

function syncedTracker() {
  const t = createViewportTracker();
  t.beginSync();
  t.completeSync(IDENT(), at(0, 0));
  return t;
}

section('tracker: states and targets');
{
  const t = createViewportTracker();
  check(t.state === 'unsynced' && t.avatarPin() === null, 'starts unsynced with no avatar pin');
  check(t.targetForPin([30, 20]) === null, 'no target before a sync');
  check(t.observe(at(1, 1)).kind === 'ignored', 'observations are ignored without a model');
  t.beginSync();
  check(t.state === 'syncing', 'beginSync → syncing');
  t.completeSync(IDENT(), at(0, 0));
  check(t.state === 'synced' && eq(t.avatarPin(), [30, 20]), 'completeSync → synced, avatar on (30, 20)');
  check(eq(t.targetForPin([35, 18]), [5, 2]), 'targetForPin(35, 18) = world (5, 2)');
  check(t.targetForPin([1, 20]) === null && t.targetForPin([58, 20]) === null
    && t.targetForPin([30, 1]) === null && t.targetForPin([30, 38]) === null,
  'border-band pins give no target');
  check(t.targetForPin([2, 2]) !== null && t.targetForPin([57, 37]) !== null, 'inner-band corners do');
  t.beginSync();
  check(t.targetForPin([30, 20]) === null, 'no target while syncing');
  check(t.observe(at(9, 9)).kind === 'ignored', 'the sync owns observation');
  t.failSync();
  check(t.state === 'stale', 'failSync with a model → stale');
  check(t.targetForPin([30, 20]) === null, 'no target while stale');
  t.invalidate('ready');
  check(t.state === 'unsynced' && t.model === null, 'invalidate → unsynced, model dropped');
  const u = createViewportTracker();
  u.beginSync(); u.failSync();
  check(u.state === 'unsynced', 'failSync with no model → unsynced');
}

section('tracker: echo matching');
{
  const t = syncedTracker();
  const target = t.targetForPin([40, 10]);
  t.noteSent(target);
  check(eq(t.pendingPin(), [40, 10]), 'pendingPin reports the in-flight target');
  const r = t.observe(target);
  check(r.kind === 'echo' && eq(r.avatarPin, [40, 10]) && !r.paged, 'the target coming back is an echo on pin (40, 10)');
  check(t.pendingPin() === null, 'and the FIFO is drained');
  // Two in flight, the second echo drops the first too (events are ordered).
  t.noteSent(t.targetForPin([41, 10]));
  t.noteSent(t.targetForPin([42, 10]));
  const r2 = t.observe(t.targetForPin([42, 10]));
  check(r2.kind === 'echo' && t.pendingPin() === null, 'a later echo drops earlier entries');
  for (let i = 0; i < 12; i++) t.noteSent(t.targetForPin([10 + i, 10]));
  check(eq(t.pendingPin(), [21, 10]), 'the FIFO holds the newest 8');
}

section('tracker: grid, offgrid and the stale signature');
{
  const t = syncedTracker();
  const r = t.observe(at(1, 0));
  check(r.kind === 'grid' && t.state === 'synced', 'a one-pin grid step is not flagged');
  t.observe(at(3, 0));
  const r2 = t.observe(at(5, 0));
  check(r2.becameStale && t.state === 'stale' && r2.staleReason === 'scale-changed',
    'two equal axis-aligned 2-pin steps → stale (scale changed)');

  const j = syncedTracker();
  const rj = j.observe(at(0, 7.3));
  check(rj.kind === 'offgrid' && j.state === 'synced', 'a single nextForward jump → offgrid, not stale');
  j.observe(at(0, 8.3));
  j.observe(at(0, 15.6));
  check(j.state === 'synced', 'a jump, a grid step, a jump of the same length → not stale');

  const e = syncedTracker();
  e.observe(at(2, 0));
  e.noteSent(e.targetForPin([40, 20]));
  e.observe(e.targetForPin([40, 20]));
  e.observe(at(12, 0));
  check(e.state === 'synced', 'an echo between two offgrid steps → not stale', e.state);

  const d = syncedTracker();
  d.observe(at(2, 2));
  d.observe(at(4, 4));
  check(d.state === 'synced', 'diagonal equal jumps are not heading-aligned → not stale');

  const p = syncedTracker();
  for (let n = 1; n <= 28; n++) p.observe(at(n, 0));
  check(eq(p.center, [56, 0]) && eq(p.avatarPin(), [2, 20]), 'the tracker pages the mirror on grid walks');
  const pg = p.pages();
  check(eq(pg, [1, 0]), 'pages() counts whole pages from the anchor', JSON.stringify(pg));
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
