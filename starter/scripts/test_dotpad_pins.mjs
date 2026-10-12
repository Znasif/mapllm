#!/usr/bin/env node
/**
 * DOT Pad fingertip → pin quantizer and the send gate.
 *
 *   node starter/scripts/test_dotpad_pins.mjs
 *
 * FULLY OFFLINE. `lib/dotpadPins.js` decides which pin a fingertip is on and
 * when that pin becomes a `moveAvatar` (docs/dotpad-camio-design.md §6.5). The
 * clock is passed in, so the dwell and rate limits are checked frame by frame.
 */

import { createPinQuantizer, createSendGate, PRESETS, DEFAULT_PRESET, pinKey, FINGER_HYSTERESIS } from '../src/lib/dotpadPins.js';

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
const section = (title) => console.log(`\n— ${title} ${'—'.repeat(Math.max(0, 62 - title.length))}`);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

section('uv → pin: corners are corner-PIN CENTRES (D5)');
{
  const q = createPinQuantizer();
  check(eq(q.update(0, 0).pin, [0, 0]), '(0, 0) → pin (0, 0)');
  q.reset();
  check(eq(q.update(1, 0).pin, [59, 0]), '(1, 0) → pin (59, 0)');
  q.reset();
  check(eq(q.update(1, 1).pin, [59, 39]), '(1, 1) → pin (59, 39)');
  q.reset();
  check(eq(q.update(0.5, 0.5).pin, [30, 20]), '(0.5, 0.5) → pin (30, 20) — 29.5 and 19.5 round up like Math.round');
  q.reset();
  const r = q.update(10 / 59, 7 / 39);
  check(eq(r.pin, [10, 7]) && Math.abs(r.f[0] - 10) < 1e-12, 'u = col/(cols−1) lands exactly on the column');
}

section('hysteresis holds within 0.5 + h');
{
  const q = createPinQuantizer({ hysteresis: 0.35 });
  q.update(10 / 59, 10 / 39);
  check(eq(q.update(10.8 / 59, 10 / 39).pin, [10, 10]), 'f = 10.8 stays on 10 (|Δ| 0.8 ≤ 0.85)');
  check(eq(q.update(10.9 / 59, 10 / 39).pin, [11, 10]), 'f = 10.9 switches to 11');
  check(eq(q.update(10.2 / 59, 10 / 39).pin, [11, 10]), 'and coming back to 10.2 stays on 11 (|Δ| 0.8)');
  check(eq(q.update(10.1 / 59, 10 / 39).pin, [10, 10]), '10.1 is past the band → 10');
  q.setHysteresis(0);
  check(q.hysteresis === 0 && eq(q.update(10.6 / 59, 10 / 39).pin, [11, 10]), 'setHysteresis(0) → plain rounding');
  const y = createPinQuantizer({ hysteresis: 0.35 });
  y.update(0.5, 20 / 39);
  check(eq(y.update(0.5, 20.8 / 39).pin, [30, 20]) && eq(y.update(0.5, 20.9 / 39).pin, [30, 21]),
    'the y axis has its own, independent hysteresis');
}

section('off-pad → null, and a reset');
{
  const q = createPinQuantizer({ offPadMargin: 1 });
  check(eq(q.update(-0.5 / 59, 0.5).pin, [0, 20]), 'half a pin outside the corner pin is still pin 0');
  check(q.update(-1.5 / 59, 0.5).pin === null, '1.5 pins outside → off the pad');
  check(q.update(0.5, 40.5 / 39).pin === null, 'below the bottom row by 1.5 → off');
  check(q.update(NaN, 0.5).pin === null, 'NaN → off');
  q.update(10.8 / 59, 0.5); // fresh after reset: 10.8 rounds to 11
  check(eq(q.update(10.8 / 59, 0.5).pin, [11, 20]), 'off-pad resets hysteresis (10.8 rounds fresh to 11)');
}

section('send gate: interval, dwell, no resend, lift, border band');
{
  const g = createSendGate({ minIntervalMs: 150, dwellMs: 0 });
  check(g.offer('10,10', 0) === '10,10', 'the first pin goes immediately (no dwell)');
  check(g.offer('10,10', 16) === null, 'the same pin is not resent');
  check(g.offer('11,10', 32) === null, 'a new pin within 150 ms waits');
  check(g.offer('11,10', 160) === '11,10', 'and goes once the interval passes');
  check(g.offer(null, 200) === null && g.lastSentKey === '11,10', 'the border band (null) does NOT reset lastSentKey');
  check(g.offer('11,10', 400) === null, 'so coming back from the band to the same pin does not resend');
  g.lift();
  check(g.lastSentKey === null && g.offer('11,10', 420) === '11,10', 'lift() resets it: re-touching the same pin re-sends');
  g.acknowledge('20,20');
  check(g.lastSentKey === '20,20' && g.offer('20,20', 900) === null, 'acknowledge(): the avatar is already there, nothing sent');
  check(g.offer('11,10', 1000) === '11,10', 'and moving back to the old pin sends again');

  const d = createSendGate({ minIntervalMs: 2500, dwellMs: 600 });
  check(d.offer('5,5', 0) === null && d.offer('5,5', 599) === null, 'dwell: nothing before 600 ms');
  check(d.offer('5,5', 600) === '5,5', 'sent at 600 ms');
  check(d.offer('6,5', 700) === null && d.offer('7,5', 1400) === null, 'a moving finger restarts the dwell');
  check(d.offer('7,5', 2000) === null && d.offer('7,5', 3099) === null, 'dwelled, but still inside 2.5 s of the last send');
  check(d.offer('7,5', 3100) === '7,5', 'sent when both have elapsed');
  check(d.offer(null, 3200) === null && d.candidate === null, 'the band resets the candidate');
  check(d.offer('8,5', 5000) === null && d.offer('8,5', 5599) === null && d.offer('8,5', 5600) === '8,5',
    'dwell restarts after the band (5000 + 600); interval measured from the last send (3100 + 2500)');
  d.configure({ dwellMs: 0, minIntervalMs: 0 });
  check(d.offer('9,5', 5601) === '9,5', 'configure() switches presets live');
}

section('finger-sized hysteresis (a fingertip covers ~4 × 4 pins)');
{
  const q = createPinQuantizer({ hysteresis: FINGER_HYSTERESIS });
  const at = (x, y) => q.update(x / 59, y / 39).pin;
  check(eq(at(30, 20), [30, 20]), 'first touch rounds to the nearest pin');
  const wobble = [[31.9, 20], [28.1, 21.9], [30, 18.1], [31.5, 21.5], [28.6, 18.6], [30.4, 20.2]];
  check(wobble.every(([x, y]) => eq(at(x, y), [30, 20])), 'a resting finger wobbling up to ±1.9 pins keeps the same pin');
  check(eq(at(32.2, 20), [32, 20]), 'moving past 2 pins switches, to the nearest pin');
  check(eq(at(30.3, 20), [32, 20]), 'and moving back needs another 2 pins');
  const slide = [];
  for (let x = 10; x <= 50; x += 0.25) { const p = at(x, 20); if (!slide.length || !eq(slide.at(-1), p)) slide.push(p); }
  check(slide.length <= 21, `a 40-pin slide sends about every 2 pins (${slide.length - 1} changes)`);
}

section('presets');
{
  check(DEFAULT_PRESET === 'dotpad-x', 'DOT Pad X is the default');
  check(PRESETS['dotpad-x'].minIntervalMs === 150 && PRESETS['dotpad-x'].dwellMs === 0 && PRESETS['dotpad-x'].hysteresis === 1.5,
    'DOT Pad X: 150 ms, no dwell, finger-sized h 1.5');
  check(PRESETS['dotpad-gen1'].minIntervalMs === 2500 && PRESETS['dotpad-gen1'].dwellMs === 600 && PRESETS['dotpad-gen1'].hysteresis === 1.5,
    'Gen-1: 2.5 s, 600 ms dwell, finger-sized h 1.5');
  check(Object.isFrozen(PRESETS) && Object.isFrozen(PRESETS['dotpad-x']), 'frozen');
  check(pinKey([3, 4]) === '3,4' && pinKey(null) === null, 'pinKey');
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
