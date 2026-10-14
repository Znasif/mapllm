#!/usr/bin/env node
/**
 * camio-pointer → useDotpadBridge: the (u, v) convention of lib/camioUv.js.
 *
 *   node starter/scripts/test_camio_uv.mjs
 *
 * FULLY OFFLINE. `CamioPointerPanel.jsx` (audiom.html?pointer=camio) feeds the
 * bridge every frame with uvFromPose(pose, core.view.tip), because the
 * library's 'point' event fires only on a pin change. Checked here:
 *   - the mapping is TactileExplorerGeneric's corner-pin-centre homography;
 *   - on every frame a 'point' fires, uvFromPose gives exactly its fx / fy, and
 *     the bridge's quantizer at h = 0 lands on the library's pin;
 *   - the vendored bundle imports in Node.
 */

import {
  PointerCore, createStaticTracker, lumaFrame, poseFromCorners, DOTPAD_GRID,
} from '../src/vendor/camio/CamioPointer-0.2.0.js';
import { uvFromPose } from '../src/lib/camioUv.js';
import { homography4, applyH } from '../src/lib/dotpadTemplate.js';
import { createPinQuantizer } from '../src/lib/dotpadPins.js';

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
const section = (title) => console.log(`\n— ${title} ${'—'.repeat(Math.max(0, 62 - title.length))}`);
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

const W = 1280, H = 720;
// Corner-PIN centres (TL, TR, BR, BL) in camera px: a pad seen in perspective.
const CORNERS = [[300, 150], [980, 170], [960, 600], [320, 580]];
const GRID = { cols: DOTPAD_GRID.cols, rows: DOTPAD_GRID.rows };

section('convention: corner-pin centres are (0, 0) … (1, 1)');
{
  check(GRID.cols === 60 && GRID.rows === 40, 'library grid is the 60 × 40 pin field');
  const pose = poseFromCorners(CORNERS);
  const unit = [[0, 0], [1, 0], [1, 1], [0, 1]];
  check(CORNERS.every((c, i) => {
    const uv = uvFromPose(pose, c, GRID);
    return near(uv.u, unit[i][0]) && near(uv.v, unit[i][1]);
  }), 'each registered corner maps to its unit-square corner');

  // TactileExplorerGeneric: HsnapToUv = getPerspectiveTransform(corners → unit square).
  const HsnapToUv = homography4(CORNERS, unit);
  let worst = 0;
  for (let i = 0; i < 200; i++) {
    const tip = [250 + ((i * 37) % 800), 120 + ((i * 53) % 520)];
    const a = uvFromPose(pose, tip, GRID);
    const [u, v] = applyH(HsnapToUv, tip);
    worst = Math.max(worst, Math.abs(a.u - u), Math.abs(a.v - v));
  }
  check(worst < 1e-9, 'same (u, v) as TactileExplorerGeneric’s HsnapToUv', `max diff ${worst.toExponential(1)}`);
  check(uvFromPose(null, [1, 2], GRID) === null && uvFromPose(pose, null, GRID) === null, 'no pose / no tip → null');
}

/** A right-hand pointing pose (index straight up, others curled), tip at normalised (x, y). */
function pointingHand(x, y) {
  const lm = (dx, dy) => ({ x: x + dx, y: y + dy, z: 0 });
  return [
    lm(0, 0.30),                                                    // 0 wrist
    lm(-0.05, 0.25), lm(-0.07, 0.20), lm(-0.08, 0.16), lm(-0.08, 0.13), // thumb
    lm(0, 0.10), lm(0, 0.0667), lm(0, 0.0333), lm(0, 0),            // index 5-8
    lm(0.02, 0.11), lm(0.025, 0.085), lm(0.03, 0.11), lm(0.028, 0.13), // middle, curled
    lm(0.04, 0.12), lm(0.045, 0.095), lm(0.05, 0.12), lm(0.048, 0.14), // ring, curled
    lm(0.06, 0.14), lm(0.063, 0.12), lm(0.066, 0.14), lm(0.064, 0.155), // pinky, curled
  ];
}

section('per frame: uvFromPose(pose, view.tip) is the point event’s fx / fy');
{
  const core = new PointerCore({ surface: { kind: 'dotpad' }, hysteresis: 0, tracker: createStaticTracker() });
  core.setRegistration(CORNERS, { width: W, height: H });
  const frame = lumaFrame({ data: new Uint8Array(W * H), width: W, height: H });
  const q = createPinQuantizer({ hysteresis: 0 });
  let fired = null;
  core.on('point', (p) => { fired = p; });

  let points = 0, uvMismatch = 0, pinMismatch = 0, framesWithUv = 0, uvWithoutPoint = 0;
  let t = 1000;
  // Hold still, then sweep the tip diagonally across the pad.
  const path = [];
  for (let i = 0; i < 8; i++) path.push([0.45, 0.45]);
  for (let i = 0; i <= 120; i++) path.push([0.28 + 0.45 * (i / 120), 0.25 + 0.5 * (i / 120)]);
  for (const [x, y] of path) {
    fired = null;
    core.processFrame(frame, { landmarks: [pointingHand(x, y)], handedness: [[{ categoryName: 'Left', score: 0.9 }]] }, t);
    t += 33;
    const uv = core.currentPoint ? uvFromPose(core.pose, core.view.tip, core.currentGrid) : null;
    if (uv) framesWithUv += 1;
    if (uv && !core.view.tip) uvWithoutPoint += 1;
    if (!fired) continue;
    points += 1;
    if (!uv || !near(uv.u * (GRID.cols - 1), fired.fx) || !near(uv.v * (GRID.rows - 1), fired.fy)) uvMismatch += 1;
    const pin = uv && q.update(uv.u, uv.v).pin;
    if (!pin || pin[0] !== fired.col || pin[1] !== fired.row) pinMismatch += 1;
  }
  check(points >= 10, 'the sweep emits point events', `${points} points`);
  check(framesWithUv > points, 'the bridge gets a sample on frames without a point event too', `${framesWithUv} frames with (u, v)`);
  check(uvMismatch === 0, 'every point event: uvFromPose × (cols − 1, rows − 1) = (fx, fy)', `${uvMismatch} mismatches`);
  check(pinMismatch === 0, 'every point event: bridge quantizer (h = 0) = library pin', `${pinMismatch} mismatches`);
  check(uvWithoutPoint === 0, 'no (u, v) without a tracked fingertip');

  // Hand gone → the library releases its point → the panel sends null.
  for (let i = 0; i < 8; i++) { core.processFrame(frame, { landmarks: [] }, t); t += 33; }
  check(core.currentPoint === null, 'no hand → no current point (the panel sends onUv(null))');
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
