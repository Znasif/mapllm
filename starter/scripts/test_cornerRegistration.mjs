#!/usr/bin/env node
/**
 * Four-corner touch registration — the dwell state machine.
 *
 *   node starter/scripts/test_cornerRegistration.mjs
 *
 * FULLY OFFLINE. `lib/cornerRegistration.js` is the pure half of the "register
 * material" workflow: fingertip positions and a clock in, corner locks out.
 * Both tactile components drive registration through it, so the timing checked
 * here is the timing a user feels when holding a finger on a physical corner —
 * and it is the ONLY part of that workflow that can be checked without a
 * camera, a hand, and a printed map.
 *
 * `feed` below plays frames at a fixed rate rather than jumping the clock, so
 * the sequences have the same shape the render loop produces (~60 fps, one
 * `update` per frame). A two-sample fixture would pass while missing that the
 * dwell clock is read against a *stream* of near-identical positions.
 */

import {
  createCornerCapture,
  CORNER_PROMPTS,
  DWELL_MS,
  DWELL_R,
} from '../src/lib/cornerRegistration.js';

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
const section = (title) => console.log(`\n— ${title} ${'—'.repeat(Math.max(0, 62 - title.length))}`);

/* ------------------------------------------------------------------ harness -- */

const FRAME_MS = 16;

/**
 * Hold (x, y) for `ms`, one frame every 16 ms, starting at `t0`.
 * `jitter(i)` may return an [x, y] offset so a hold can wobble like a real hand.
 * Returns every frame's state plus the clock the caller should continue from.
 */
function hold(cap, x, y, ms, t0, jitter = null) {
  const states = [];
  let t = t0;
  for (let i = 0; t - t0 <= ms; i++, t += FRAME_MS) {
    const [dx, dy] = jitter ? jitter(i) : [0, 0];
    states.push(cap.update(x + dx, y + dy, t));
  }
  return { states, t, locked: states.filter((s) => s.locked) };
}

/** Frames with no fingertip at all. */
function absent(cap, ms, t0) {
  const states = [];
  let t = t0;
  for (; t - t0 <= ms; t += FRAME_MS) states.push(cap.update(null, null, t));
  return { states, t };
}

/** The four corners of a notional 640x480 snapshot, in TL,TR,BR,BL order. */
const CORNERS = [[80, 60], [560, 60], [560, 420], [80, 420]];

/* ------------------------------------------------------------ 1. fresh state -- */

section('a fresh capture asks for the top-left corner and nothing else');
{
  const cap = createCornerCapture();
  check(cap.index === 0 && cap.corners.length === 0 && cap.complete === false,
    'starts empty', `index=${cap.index}`);
  check(CORNER_PROMPTS.join() === 'top-left,top-right,bottom-right,bottom-left',
    'prompt order is TL,TR,BR,BL', CORNER_PROMPTS.join(' → '));

  const s = cap.update(100, 100, 0);
  check(s.locked === false && s.index === 0 && s.complete === false,
    'the first frame anchors a dwell, it does not lock');
  check(s.nextPrompt === 'top-left', 'and still asks for top-left', s.nextPrompt);
}

/* --------------------------------------------------------------- 2. dwelling -- */

section('a corner locks only after the hold time is strictly exceeded');
{
  const cap = createCornerCapture();
  // Exactly DWELL_MS is NOT enough — the comparison is `>`, so a hold that
  // lands exactly on the threshold must still be waiting.
  cap.update(100, 100, 0);
  const at = cap.update(100, 100, DWELL_MS);
  check(at.locked === false && at.index === 0,
    `holding for exactly ${DWELL_MS} ms does not lock`);
  const past = cap.update(100, 100, DWELL_MS + 1);
  check(past.locked === true && past.index === 1,
    `one millisecond past ${DWELL_MS} ms locks`, `index=${past.index}`);
  check(past.corners.length === 1 && past.corners[0][0] === 100 && past.corners[0][1] === 100,
    'and commits the position held', JSON.stringify(past.corners[0]));
  check(past.nextPrompt === 'top-right', 'the prompt advances to the next corner', past.nextPrompt);
}

{
  const cap = createCornerCapture();
  const { locked, states } = hold(cap, 200, 150, DWELL_MS + 200, 0);
  check(locked.length === 1, 'a continuous hold locks exactly once, not once per frame',
    `${locked.length} locks in ${states.length} frames`);
  check(states.filter((s) => s.locked).length === 1 && cap.index === 1,
    'and leaves the machine on corner 2', `index=${cap.index}`);
}

{
  // Custom timings: the caller owns them, so both must actually be honoured.
  const cap = createCornerCapture({ dwellMs: 300, dwellR: 5 });
  const { locked, t } = hold(cap, 10, 10, 400, 0);
  check(locked.length === 1, 'a shorter dwellMs locks sooner', `locked after ${t} ms of frames`);
  const cap2 = createCornerCapture({ dwellMs: 300, dwellR: 5 });
  const wobble = hold(cap2, 10, 10, 400, 0, (i) => [i % 2 ? 8 : 0, 0]);
  check(wobble.locked.length === 0,
    'a wobble wider than a small dwellR never settles', `${wobble.locked.length} locks`);
}

/* ----------------------------------------------------------------- 3. jitter -- */

section('jitter inside the radius holds; a move beyond it restarts the clock');
{
  const cap = createCornerCapture();
  // Wander around the anchor, always within DWELL_R. A real fingertip does
  // this constantly; if it re-anchored, no corner would ever lock.
  const jitter = (i) => {
    // Amplitude chosen so the WIDEST separation between any two jittered
    // frames (the circle's diameter) still fits inside dwellR — otherwise the
    // wander itself, not the hand moving, would trip the re-anchor.
    const r = DWELL_R * 0.4;
    return [r * Math.cos(i * 0.7), r * Math.sin(i * 0.7)];
  };
  const { locked } = hold(cap, 300, 200, DWELL_MS + 100, 0, jitter);
  check(locked.length === 1, 'jitter inside dwellR does not re-anchor', `${locked.length} locks`);
  const [lx, ly] = cap.corners[0] || [NaN, NaN];
  check(Math.hypot(lx - 300, ly - 200) <= DWELL_R,
    'the committed point is the frame that crossed the threshold, inside the radius',
    `(${lx.toFixed(1)},${ly.toFixed(1)})`);
}

{
  const cap = createCornerCapture();
  // Hold almost long enough, then jump beyond the radius. The clock must
  // restart from the new position, not carry the elapsed time over.
  cap.update(300, 200, 0);
  const nearly = cap.update(300, 200, DWELL_MS - 50);
  check(nearly.locked === false, 'still holding just short of the threshold');

  const jumped = cap.update(300 + DWELL_R + 1, 200, DWELL_MS - 40);
  check(jumped.locked === false && jumped.index === 0,
    'a move beyond dwellR does not lock on the frame it happens');
  const wouldHaveLocked = cap.update(300 + DWELL_R + 1, 200, DWELL_MS + 100);
  check(wouldHaveLocked.locked === false,
    'and the old elapsed time is gone — the original deadline passes with no lock');
  const after = cap.update(300 + DWELL_R + 1, 200, (DWELL_MS - 40) + DWELL_MS + 1);
  check(after.locked === true && after.index === 1,
    'the corner locks a full dwell after the RE-anchor', JSON.stringify(after.corners[0]));
  check(Math.abs(after.corners[0][0] - (300 + DWELL_R + 1)) < 1e-9,
    'committing the new position, not the abandoned one');
}

{
  // The radius is a strict `>`: a move of exactly DWELL_R stays anchored.
  const cap = createCornerCapture();
  cap.update(0, 0, 0);
  const edge = cap.update(DWELL_R, 0, 10);
  check(edge.locked === false, 'a move of exactly dwellR is not yet a re-anchor (setup)');
  const s = cap.update(DWELL_R, 0, DWELL_MS + 1);
  check(s.locked === true,
    'so the clock kept running and the corner locks on the original anchor time');
}

/* ------------------------------------------------------- 4. absent fingertip -- */

section('frames with no fingertip leave the dwell untouched');
{
  const cap = createCornerCapture();
  cap.update(300, 200, 0);
  const gap = absent(cap, 400, FRAME_MS);
  check(gap.states.every((s) => !s.locked && s.index === 0),
    'null frames never lock and never advance', `${gap.states.length} null frames`);
  // The hold resumes: the anchor survived the gap, so the ORIGINAL start time
  // is still what the deadline is measured from.
  const s = cap.update(300, 200, DWELL_MS + 1);
  check(s.locked === true,
    'the anchor survived the gap — the hold completes on its original clock');
}

{
  const cap = createCornerCapture();
  const only = absent(cap, 100, 0);
  check(only.states.every((s) => s.index === 0 && s.nextPrompt === 'top-left'),
    'null frames before any point are harmless');
  const s = cap.update(50, 50, 200);
  check(s.locked === false, 'and the first real frame still has to anchor first');
}

/* --------------------------------------------------------- 5. all four in a row -- */

section('four corners, in order, with the prompts that ask for them');
{
  const cap = createCornerCapture();
  let t = 0;
  const spoken = [];
  const committed = [];

  for (const [x, y] of CORNERS) {
    const run = hold(cap, x, y, DWELL_MS + 100, t);
    t = run.t;
    check(run.locked.length === 1, `corner ${cap.index} locked once`, `at (${x},${y})`);
    const s = run.locked[0];
    committed.push(s.corners[s.index - 1]);
    spoken.push(s.nextPrompt);
    // Move away between corners so the next hold starts from a fresh anchor,
    // exactly as a hand travelling across the material does.
    t = absent(cap, 100, t).t;
  }

  check(JSON.stringify(committed) === JSON.stringify(CORNERS),
    'the four committed points are TL,TR,BR,BL in touch order', JSON.stringify(committed));
  check(JSON.stringify(cap.corners) === JSON.stringify(CORNERS),
    'and the live `corners` getter agrees');
  check(spoken.slice(0, 3).join() === 'top-right,bottom-right,bottom-left',
    'each lock names the corner still wanted', spoken.slice(0, 3).join(' → '));
  check(spoken[3] === null, 'the fourth lock asks for nothing more', String(spoken[3]));
  check(cap.complete === true && cap.index === 4, 'the capture reports complete', `index=${cap.index}`);

  // Past completion the machine is inert: the component switches to 'ready' and
  // stops feeding it, but a stray frame must not corrupt the four corners the
  // homography is about to be built from.
  const extra = hold(cap, 999, 999, DWELL_MS + 100, t);
  check(extra.locked.length === 0 && cap.corners.length === 4,
    'frames after completion cannot add a fifth corner', `${cap.corners.length} corners`);
  check(extra.states.every((s) => s.complete && s.nextPrompt === null),
    'and every such frame still reports complete with no prompt');
}

/* ------------------------------------------------------------------ 6. reset -- */

section('reset clears everything — this is what “re-register” does');
{
  const cap = createCornerCapture();
  let t = 0;
  for (const [x, y] of CORNERS.slice(0, 3)) {
    t = hold(cap, x, y, DWELL_MS + 100, t).t;
    t = absent(cap, 100, t).t;
  }
  check(cap.index === 3, 'three corners in', `index=${cap.index}`);

  // Start a fourth hold but do NOT finish it, so there is a live dwell anchor
  // to survive (or not) the reset. Re-registering mid-hold is exactly what a
  // user does when they realise they touched the wrong corner.
  const partial = hold(cap, 200, 200, DWELL_MS / 2, t);
  check(partial.locked.length === 0, 'a fourth hold is in progress but not locked');
  t = partial.t;

  cap.reset();
  check(cap.index === 0 && cap.corners.length === 0 && cap.complete === false,
    'reset clears the corners and the index');
  // The anchor must go too. Held at the SAME position, past the ORIGINAL
  // deadline: if reset kept the anchor this frame would lock a corner the user
  // never held for — and it would land on whatever they happened to be near.
  const stale = cap.update(200, 200, t + DWELL_MS);
  check(stale.locked === false && stale.index === 0,
    'reset drops the dwell anchor too — a stale hold cannot lock after it');
  const s = cap.update(80, 60, t + 5000);
  check(s.locked === false && s.nextPrompt === 'top-left',
    'and the next frame re-anchors from scratch at top-left');

  const done = hold(cap, 80, 60, DWELL_MS + 100, t + 5000);
  check(done.locked.length === 1 && cap.index === 1,
    'and registration starts over at top-left');

  cap.reset();
  check(cap.reset() === undefined && cap.index === 0, 'reset is idempotent');
}

/* ------------------------------------------------------------------ result -- */

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
