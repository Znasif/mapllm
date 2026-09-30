#!/usr/bin/env node
/**
 * DOT Pad sync — end to end against a simulated Audiom.
 *
 *   node starter/scripts/test_dotpad_sync.mjs
 *
 * FULLY OFFLINE, seeded. `fixtures/fakeAudiom.mjs` is a port of the Audiom
 * pieces the protocol depends on (viewport.ts verbatim, TactileRenderer's
 * reactions, MovementTiers, grid/first-person movement, the embed messages),
 * wired to the REAL `createAudiomChannel`. The oracle is Audiom's own pin for
 * the avatar; after every operation the host mirror must agree with it.
 *
 * Groups follow docs/dotpad-camio-design.md §9.3 (numbered 1-11 there).
 */

import { createAudiomChannel } from '../src/lib/audiomChannel.js';
import { createViewportTracker, toQ } from '../src/lib/dotpadViewport.js';
import {
  runDotpadSync, solveProbe, choosePlane, describeScale, formatDistance,
  createResyncScheduler, AUTO_RESYNC_QUIET_MS, headingMatrix,
} from '../src/lib/dotpadSync.js';
import { createFakeAudiom, FAKE_ORIGIN, mulberry32, tactileWorldBounds } from './fixtures/fakeAudiom.mjs';

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
const section = (title) => console.log(`\n— ${title} ${'—'.repeat(Math.max(0, 62 - title.length))}`);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ------------------------------------------------------------------ harness -- */

/** Let every in-flight postMessage (both directions) land. */
const flush = () => new Promise((r) => setImmediate(r));

/**
 * A fake Audiom, the real channel over its transport, and a tracker fed by
 * `onPosition` exactly as `useDotpadBridge` feeds it.
 */
function setup(fakeOptions = {}) {
  const fake = createFakeAudiom(fakeOptions);
  const channel = createAudiomChannel({
    origin: FAKE_ORIGIN,
    post: fake.transport.post,
    subscribe: fake.transport.subscribe,
    onHandlerError: (e) => { throw e; },
  });
  const tracker = createViewportTracker();
  const env = { fake, channel, tracker, lastObserve: null, onObserve: null };
  channel.onPosition((L) => {
    env.lastObserve = tracker.observe(L);
    env.onObserve?.(env.lastObserve);
  });
  return env;
}

const sync = (env, extra = {}) => runDotpadSync({
  channel: env.channel, tracker: env.tracker, sleep: async () => {}, settleMs: 0, ...extra,
});

/**
 * Distance of the oracle's continuous pin coordinate from a rounding tie. When
 * the avatar sits within `tol` of an x.5 boundary (only off-lattice moves —
 * jumps, non-cardinal headings — can put it there, §3.4) a model error smaller
 * than `tol` may legitimately round the other way.
 */
function tieMargin(fake) {
  const vp = fake.viewport;
  const b = tactileWorldBounds(vp);
  const p = fake.position;
  const fx = (p[0] - b.left) / vp.metersPerPin;
  const fy = (b.top - p[1]) / vp.metersPerPin;
  const m = (f) => Math.abs(Math.abs(f - Math.floor(f)) - 0.5);
  return Math.min(m(fx), m(fy));
}

/** Mirror vs oracle: the avatar pin and the viewport centre. */
function compare(env, tol = 1e-3) {
  const { fake, tracker } = env;
  const pinOk = eq(tracker.avatarPin(), fake.rendererPinOfAvatar()) || tieMargin(fake) < tol;
  const m = tracker.model;
  let centreOk = false;
  if (m) {
    // Oracle centre in world pins from the anchor (Audiom's metres → pins).
    const p0i = fake.toInternal(m.p0);
    const cw = fake.centerWorld();
    const mpp = fake.viewport.metersPerPin;
    const oc = [(cw[0] - p0i[0]) / mpp, (cw[1] - p0i[1]) / mpp];
    centreOk = Math.abs(oc[0] - tracker.center[0]) < 1e-6 && Math.abs(oc[1] - tracker.center[1]) < 1e-6;
  }
  return { pinOk, centreOk, ok: pinOk && centreOk };
}

const DIRS = ['up', 'down', 'left', 'right'];

/**
 * 500 random operations. Finger moves go through `targetForPin` + `noteSent`
 * exactly as the bridge sends them; keyboard steps and jumps come from "the
 * user" via `fake.key`. Returns the first failing op, if any.
 */
async function soak(env, { ops = 500, seed = 1, jumpRate = 0.1, tol = 1e-3 } = {}) {
  const rng = mulberry32(seed);
  let bad = 0;
  let firstBad = null;
  let pages = 0;
  let resyncs = 0;
  for (let i = 0; i < ops; i++) {
    // Two consecutive jumps of equal length (±1%) ARE the stale signature
    // (D4), so a long random run trips it now and then. That is the designed
    // false positive; the bridge answers it with an auto-resync, and so do we.
    if (env.tracker.state === 'stale') {
      const again = await runDotpadSync({ channel: env.channel, tracker: env.tracker, sleep: async () => {}, settleMs: 0 });
      resyncs += 1;
      if (!again.ok) { bad += 1; firstBad ??= `op ${i}: resync failed ${again.reason}`; break; }
    }
    const r = rng();
    if (r < 0.45) {
      const p = [2 + Math.floor(rng() * 56), 2 + Math.floor(rng() * 36)];
      if (eq(p, env.tracker.avatarPin())) continue;
      const target = env.tracker.targetForPin(p);
      if (!target) { bad += 1; firstBad ??= `op ${i}: no target (state ${env.tracker.state})`; continue; }
      env.tracker.noteSent(target);
      env.channel.moveAvatar(target);
    } else if (r < 1 - jumpRate) {
      env.fake.key(DIRS[Math.floor(rng() * 4)]);
    } else {
      // A jump along the heading. Half the time the user turns round first, so
      // jumps random-walk instead of marching the avatar off the map: the model
      // is local by design (R6), and 500 same-direction jumps at 1 km pins is a
      // 700 km trip, well outside its envelope.
      if (rng() < 0.5) env.fake.key('rotate180');
      env.fake.key('nextForward');
    }
    await flush();
    if (env.lastObserve?.paged) pages += 1;
    const c = compare(env, tol);
    if (!c.ok) {
      bad += 1;
      firstBad ??= `op ${i}: mirror ${JSON.stringify(env.tracker.avatarPin())} c=${JSON.stringify(env.tracker.center)}`
        + ` vs oracle ${JSON.stringify(env.fake.rendererPinOfAvatar())} (pin ${c.pinOk}, centre ${c.centreOk})`;
    }
  }
  return { bad, firstBad, pages, resyncs, state: env.tracker.state };
}

const GOLDEN = [
  'activateGridView', 'getState', 'right', 'right_release', 'getState', 'left', 'left_release', 'getState',
  'up', 'up_release', 'getState', 'down', 'down_release', 'getState', 'getState', 'smallerStep', 'largerStep',
  'right', 'right_release', 'getState', 'left', 'left_release', 'getState', 'getState',
];

/** A geographic map whose ENU origin O is ~5 km SW of the start. */
const geo = (lat, extra = {}) => ({ projection: 'enu', origin: [10 - 0.05, lat - 0.04], start: [10, lat], ...extra });
/** A custom-coordinate map (identity projection). */
const custom = (extra = {}) => ({ projection: 'identity', origin: [0, 0], start: [5000, 5000], ...extra });

/** tier / stepIndex giving a step of `d` metres on a NON-index-0 slot. */
const STEP = {
  0.25: { tier: 0, stepIndex: 4 },
  1: { tier: 1, stepIndex: 2 },
  20: { tier: 2, stepIndex: 2 },
  100: { tier: 2, stepIndex: 4 },
  1000: { tier: 3, stepIndex: 3 },
};

/* ---------------------------------------------------------- pure pieces -- */

section('solveProbe / choosePlane / describeScale');
{
  const Q = headingMatrix(0);
  check(eq(Q, [[1, 0], [-0, 1]]) || (Q[0][0] === 1 && Q[1][1] === 1), 'Q(0) = I');
  const s0 = solveProbe([20, 0], [0, 20]);
  check(s0.ok && s0.cardinal && s0.headingDeg === 0 && Math.abs(s0.A[0][0] - 20) < 1e-12, 'heading 0: A = 20·I');
  const s90 = solveProbe([0, -5], [5, 0]);
  check(s90.ok && s90.headingDeg === 90 && Math.abs(s90.A[0][0] - 5) < 1e-12 && Math.abs(s90.A[1][1] - 5) < 1e-12,
    'heading 90: right is south, up is east; A = 5·I', JSON.stringify(s90));
  const t = 37 * Math.PI / 180;
  const s37 = solveProbe([Math.cos(t), -Math.sin(t)], [Math.sin(t), Math.cos(t)]);
  check(s37.ok && !s37.cardinal && Math.abs(s37.headingDeg - 37) < 1e-9 && eq(s37.A, [[1, 0], [0, 1]]),
    'heading 37: non-cardinal → A = diag(a, b)', JSON.stringify(s37));
  check(!solveProbe([1, 0], [0.3, 1]).ok, 'a skewed (wall-slid) probe is rejected');
  check(!solveProbe([1, 0], [0, -1]).ok, 'a reflected probe (det < 0) is rejected');
  check(choosePlane([10, 40], { enu: { a: 1, b: 1 }, identity: { a: 1.3, b: 1 } }) === 'enu', 'square in ENU only → enu');
  check(choosePlane([5000, 5000], { enu: { a: 1, b: 1 }, identity: { a: 1, b: 1 } }) === 'identity', 'not a lng/lat → identity');
  check(choosePlane([10, 0.1], { enu: { a: 1, b: 1 }, identity: { a: 1.001, b: 1 } }) === 'identity', 'square in both → identity');
  check(describeScale(1).text === '1 metre' && describeScale(0.5).text === '50 cm', '1 metre · 50 cm');
  check(describeScale(20.1).text === '20 metres' && describeScale(20.1).snapped === 20, 'snaps within 1%');
  // Audiom's own formatter says feet below a mile (movementTiers.ts:171-184),
  // so 0.25 mi is "1320 feet" in its "Step size set to …" too.
  check(describeScale(402.336).text === '1320 feet' && describeScale(0.3048).text === '1 foot'
    && describeScale(0.0762).text === '3 inches', 'imperial values speak imperial, worded like Audiom');
  check(describeScale(1000).text === '1 kilometre' && describeScale(1609.344).text === '1 mile', '1 kilometre · 1 mile');
  check(formatDistance(7.123) === '7.12 metres' && describeScale(null) === null, 'unsnapped metric; null for identity');
}

/* ------------------------------------------------------------ 1. golden -- */

section('1. default map: golden wire trace, scale unchanged, avatar on (30, 20)');
{
  const env = setup(geo(40, { tier: 1, stepIndex: 2 }));
  const phases = [];
  const res = await sync(env, { onPhase: (p) => phases.push(p) });
  check(res.ok, 'sync succeeds', res.reason);
  check(eq(res.commands, GOLDEN), 'the wire trace is the golden list', res.commands.join(','));
  check(res.stepRepaired === false && env.fake.moveDistance === 1, 'stepRepaired=false, moveDistance still 1 m');
  check(res.model.plane === 'enu', 'a geographic map picks the ENU plane', res.model.plane);
  check(Math.abs(res.metresPerPin - 1) < 1e-6, '1 pin = 1 m measured', String(res.metresPerPin));
  check(eq(env.tracker.avatarPin(), [30, 20]) && eq(env.fake.rendererPinOfAvatar(), [30, 20]),
    'mirror and oracle both put the avatar on (30, 20)');
  check(env.tracker.state === 'synced', 'tracker synced');
  check(phases[0] === 'prep' && phases.at(-1) === 'done', 'phases run prep … done', phases.join(' → '));
  check(env.fake.mode === 'grid', 'grid mode is active afterwards');
}

/* ------------------------------------------------------------- 2. soak -- */

section('2. differential soak: 500 random ops per config');
{
  let configs = 0;
  let worst = null;
  let totalPages = 0;
  let totalResyncs = 0;
  for (const lat of [0, 40, 60]) {
    for (const d of [0.25, 1, 20, 100, 1000]) {
      for (const heading of [0, 90, 180, 270]) {
        const env = setup(geo(lat, { ...STEP[d], heading, rng: mulberry32(configs + 11) }));
        const res = await sync(env);
        const s = res.ok ? await soak(env, { seed: 1000 + configs }) : { bad: 1, firstBad: `sync ${res.reason}` };
        configs += 1;
        totalPages += s.pages || 0;
        totalResyncs += s.resyncs || 0;
        if (s.bad && !worst) worst = `lat ${lat} d ${d} heading ${heading}: ${s.bad} bad; ${s.firstBad}`;
      }
    }
  }
  check(!worst, `${configs} geographic configs × 500 ops: mirror = oracle after every op`, worst || `${totalPages} pages mirrored, ${totalResyncs} false-stale resyncs`);

  let customBad = null;
  for (const d of [0.25, 1, 20, 100, 1000]) {
    for (const heading of [0, 90, 180, 270]) {
      const env = setup(custom({ ...STEP[d], heading }));
      const res = await sync(env);
      if (res.ok && res.model.plane !== 'identity') customBad ??= `plane ${res.model.plane}`;
      const s = res.ok ? await soak(env, { seed: 77 + d + heading }) : { bad: 1, firstBad: `sync ${res.reason}` };
      if (s.bad) customBad ??= `d ${d} heading ${heading}: ${s.firstBad}`;
    }
  }
  check(!customBad, 'identity (custom-coordinate) maps: identity plane, mirror = oracle', customBad || '');
}

section('2b. 20-page walk at 60°N, 20 m — and the identity-plane negative control');
{
  async function walk(env) {
    let bad = 0;
    let first = null;
    const steps = [...Array(20 * 56).fill('right'), ...Array(10 * 36).fill('up')];
    for (const k of steps) {
      env.fake.key(k);
      await flush();
      const c = compare(env, 0);
      if (!c.pinOk) { bad += 1; first ??= `${JSON.stringify(env.tracker.avatarPin())} vs ${JSON.stringify(env.fake.rendererPinOfAvatar())}`; }
    }
    // Finger targets at the far end must land where the mirror says.
    for (const p of [[2, 2], [57, 37], [30, 20], [10, 30]]) {
      if (eq(p, env.tracker.avatarPin())) continue;
      const target = env.tracker.targetForPin(p);
      if (!target) { bad += 1; continue; }
      env.tracker.noteSent(target);
      env.channel.moveAvatar(target);
      await flush();
      if (!eq(env.fake.rendererPinOfAvatar(), p)) { bad += 1; first ??= `finger ${p} landed on ${env.fake.rendererPinOfAvatar()}`; }
    }
    return { bad, first };
  }
  const enu = setup(geo(60, STEP[20]));
  const r1 = await sync(enu);
  const w1 = await walk(enu);
  check(r1.ok && r1.model.plane === 'enu' && w1.bad === 0, 'ENU plane: 30 pages, every pin and finger target exact', w1.first || '');

  const ident = setup(geo(60, STEP[20]));
  const r2 = await sync(ident, { forcePlane: 'identity' });
  const w2 = await walk(ident);
  check(r2.ok && w2.bad > 0, 'identity plane on the same geographic map drifts (proves §3.3 matters)',
    `${w2.bad} mismatches, first ${w2.first}`);
}

/* ------------------------------------------------------------ 3. index 0 -- */

section('3. step index 0 (0.25 m, tier 1): VERIFY k = 2 → REPAIR');
{
  const env = setup(geo(40, { tier: 1, stepIndex: 0 }));
  const res = await sync(env);
  const expected = [...GOLDEN.slice(0, -1), 'getState', 'smallerStep', 'getState'];
  check(res.ok && res.stepRepaired, 'sync succeeds with stepRepaired', res.reason);
  check(Math.abs(res.k - 2) < 1e-6, 'VERIFY measured k = 2', String(res.k));
  check(eq(res.commands, expected), 'the index-0 path adds exactly getState, smallerStep', res.commands.join(','));
  check(env.fake.moveDistance === 0.25 && env.fake.tiers.stepIndex === 0, 'moveDistance restored to 0.25 m at index 0');
  check(eq(env.tracker.avatarPin(), env.fake.rendererPinOfAvatar()), 'pins match');
  const s = await soak(env, { seed: 3 });
  check(s.bad === 0, 'and keep matching through a 500-op soak', s.firstBad || '');
  const imp = setup(geo(40, { unitSystem: 'imperial', tier: 0, stepIndex: 0 }));
  const ri = await sync(imp);
  check(ri.ok && ri.stepRepaired && Math.abs(ri.k - 3) < 1e-6 && imp.fake.moveDistance === 0.0254,
    'imperial 1 inch (k = 3) is repaired too', `k=${ri.k}`);
}

/* ------------------------------------------------------- 4. top of tier -- */

section('4. top of a tier, and the largest tier with doubling: neutral');
{
  const env = setup(geo(40, { tier: 1, stepIndex: 5 }));
  const res = await sync(env);
  check(res.ok && !res.stepRepaired && env.fake.moveDistance === 5 && eq(res.commands, GOLDEN),
    '5 m (last of tier 1): smaller→larger is neutral, golden trace');
  check(eq(env.tracker.avatarPin(), env.fake.rendererPinOfAvatar()), 'pins match');

  const big = setup(custom({ tier: 4, stepIndex: 6 }));
  big.fake.key('largerStep'); // 1000 km → 2000 km, appended by the ×2 extension
  await flush();
  const rb = await sync(big);
  check(rb.ok && !rb.stepRepaired && big.fake.moveDistance === 2000000, 'largest tier past its table: neutral',
    `${rb.reason ?? ''} d=${big.fake.moveDistance}`);
  const sb = await soak(big, { ops: 200, seed: 4 });
  check(sb.bad === 0, 'pins match', sb.firstBad || '');
}

/* ----------------------------------------------------- 5. heading 37° -- */

section('5. heading 37° (non-cardinal): A = diag, pins match within tolerance');
{
  const env = setup(geo(40, { ...STEP[1], heading: 37 }));
  const res = await sync(env);
  // Measured in OUR ENU plane, which is rotated by ε ≈ 0.03° from Audiom's at 5 km.
  check(res.ok && Math.abs(res.headingDeg - 37) < 0.1, 'sync succeeds and measures the heading (±ε)', `${res.reason ?? ''} ${res.headingDeg}`);
  check(res.ok && res.model.A[0][1] === 0 && res.model.A[1][0] === 0, 'A is diagonal (ε dropped, R6)');
  // Keyboard steps at 37° are off-lattice, so ties are possible; the plane
  // rotation between our ENU and Audiom's is ~1e-3 rad at 5 km, so 0.05 pin
  // covers a window's worth of it.
  const s = await soak(env, { seed: 5, jumpRate: 0.05, tol: 0.05 });
  check(s.bad === 0 && s.state === 'synced', 'mirror = oracle outside a 0.05-pin tie band', s.firstBad || s.state);
}

/* ------------------------------------------------------ 6. first person -- */

section('6. first-person paradigm at start: grid forced first, no walk');
{
  const env = setup(geo(40, { ...STEP[1], paradigm: 'firstPerson' }));
  const res = await sync(env);
  check(res.ok && res.commands[0] === 'activateGridView', 'activateGridView is the first command');
  check(env.fake.firstPersonSteps === 0 && env.fake.mode === 'grid', 'no first-person step was ever taken');
  check(eq(env.tracker.avatarPin(), env.fake.rendererPinOfAvatar()), 'pins match');
}

/* ------------------------------------------------------------- 7. walls -- */

section('7. walls: one side walled uses the other; both walled fails and restores');
{
  const x0 = setup(geo(40, STEP[1])).fake.position[0];
  // A wall just east of the start: any move to x > x0 is blocked.
  const wenv = setup(geo(40, { ...STEP[1], wall: (from, to) => to[0] > x0 + 1e-9 }));
  const res = await sync(wenv);
  check(res.ok, 'sync succeeds with a wall to the right', res.reason);
  check(res.commands.slice(1, 11).join(',') === 'getState,right,right_release,getState,left,left_release,getState,right,right_release,getState',
    'PROBE_X tried right, was blocked, stepped left and back', res.commands.slice(0, 12).join(','));
  check(eq(wenv.tracker.avatarPin(), wenv.fake.rendererPinOfAvatar()), 'pins match');

  const both = setup(geo(40, { ...STEP[1], wall: (from, to) => Math.abs(to[0] - x0) > 1e-9 }));
  const start = both.fake.externalPosition;
  const rb = await sync(both);
  await flush();
  check(!rb.ok && rb.reason === 'blocked', 'both sides walled → blocked', rb.reason);
  check(eq(both.fake.externalPosition, start), 'the avatar is where the user left it');
  check(both.tracker.state === 'unsynced', 'tracker unsynced');
}

/* ------------------------------------------------------ 8. interference -- */

section('8. interference: a keyboard step mid-probe aborts');
{
  const env = setup(geo(40, STEP[1]));
  let injected = false;
  env.fake.onInbound = (msg, fake) => {
    if (!injected && msg.type === 'executeCommand' && msg.payload.command === 'up') {
      injected = true;
      fake.key('right'); // the user presses → during our probe
    }
  };
  const res = await sync(env);
  check(!res.ok && res.reason === 'interrupted', 'sync fails with interrupted', res.reason);
  check(env.tracker.state === 'unsynced', 'tracker unsynced (no model before)');

  // An embed `error` mid-run aborts with embed-error: rewrite our first
  // command into one Audiom does not know, so it answers UNKNOWN_COMMAND.
  const err = setup(geo(40, STEP[1]));
  const origPost = err.fake.transport.post;
  const errChannel = createAudiomChannel({
    origin: FAKE_ORIGIN,
    post: (m) => {
      if (m.type === 'executeCommand' && m.payload.command === 'activateGridView') {
        return origPost({ type: 'executeCommand', payload: { command: 'noSuchCommand' } });
      }
      return origPost(m);
    },
    subscribe: err.fake.transport.subscribe,
  });
  const re = await runDotpadSync({ channel: errChannel, tracker: createViewportTracker(), sleep: async () => {}, settleMs: 1 });
  check(!re.ok && re.reason === 'embed-error', 'an embed error message aborts with embed-error', re.reason);

  const silent = setup(geo(40, STEP[1]));
  const deadChannel = createAudiomChannel({
    origin: FAKE_ORIGIN, post: () => true, subscribe: silent.fake.transport.subscribe, timeoutMs: 5,
  });
  const rn = await runDotpadSync({ channel: deadChannel, tracker: createViewportTracker(), sleep: async () => {}, settleMs: 0 });
  check(!rn.ok && rn.reason === 'no-response', 'no stateChanged → no-response', rn.reason);
}

/* ------------------------------------------------- 9. inactive renderer -- */

section('9. renderer inactive during sync, then activated in place');
{
  const env = setup(geo(40, { ...STEP[1], rendererActive: false }));
  const res = await sync(env);
  check(res.ok, 'sync succeeds with no tactile consumer', res.reason);
  env.fake.activate(); // the pad connects (markConnected → subscribe → activate)
  check(eq(env.tracker.avatarPin(), env.fake.rendererPinOfAvatar()) && compare(env).ok,
    'activate() at the same position re-centres exactly where the mirror is');
  const s = await soak(env, { seed: 9 });
  check(s.bad === 0, 'and they stay matched', s.firstBad || '');
}

/* ------------------------------------------------------ 10. auto-resync -- */

section('10. user largerStep + 2 steps → stale → auto-resync (fake clock) → matched');
{
  const env = setup(geo(40, STEP[1]));
  const res = await sync(env);
  check(res.ok, 'initial sync');

  const timers = new Map();
  let nextId = 1;
  let fired = 0;
  const scheduler = createResyncScheduler({
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms }); return id; },
    clearTimer: (id) => timers.delete(id),
    onFire: () => { fired += 1; },
  });
  // The bridge's wiring: arm on becoming stale, restart on every foreign move while stale.
  env.onObserve = (r) => {
    if (r.becameStale || (env.tracker.state === 'stale' && (r.kind === 'grid' || r.kind === 'offgrid'))) scheduler.poke();
  };

  env.fake.key('largerStep'); // 1 m → 2 m; Audiom re-centres, invisibly (F8)
  env.fake.key('right');
  await flush();
  check(env.tracker.state === 'synced', 'one 2-pin step alone is not enough evidence');
  env.fake.key('right');
  await flush();
  check(env.tracker.state === 'stale' && env.tracker.staleReason === 'scale-changed', 'the second one flags stale');
  check(scheduler.pending && [...timers.values()][0].ms === AUTO_RESYNC_QUIET_MS, `auto-resync armed for ${AUTO_RESYNC_QUIET_MS} ms`);
  env.fake.key('up');
  await flush();
  check(timers.size === 1, 'a further foreign move restarts (not stacks) the quiet timer');
  for (const [id, t] of [...timers]) { timers.delete(id); t.fn(); }
  check(fired === 1, 'the quiet period elapses and the resync fires');
  const again = await sync(env);
  check(again.ok && Math.abs(again.metresPerPin - 2) < 1e-6, 'the resync measures the new 2 m scale', String(again.metresPerPin));
  check(env.tracker.state === 'synced' && eq(env.tracker.avatarPin(), env.fake.rendererPinOfAvatar()), 'synced and matched');
  env.onObserve = null;
  const s = await soak(env, { seed: 10 });
  check(s.bad === 0, 'soak after resync', s.firstBad || '');
}

/* ------------------------------------------------ 11. side-effect budget -- */

section('11. side-effect budget');
{
  const count = (res) => res.commands.filter((c) => ['up', 'down', 'left', 'right'].includes(c)).length;
  const a = setup(geo(40, STEP[1]));
  const ra = await sync(a);
  const steps = (f) => f.spoken.filter((s) => /^Step size set/.test(s)).length;
  check(count(ra) <= 6 && steps(a.fake) <= 3, '≤ 6 grid moves and ≤ 3 step announcements', `${count(ra)} moves, ${steps(a.fake)} announcements`);
  const b = setup(geo(40, { tier: 1, stepIndex: 0 }));
  const rb = await sync(b);
  check(count(rb) <= 8 && steps(b.fake) <= 3, 'index-0 path: ≤ 8 grid moves, ≤ 3 announcements',
    `${count(rb)} moves, ${steps(b.fake)} announcements`);
  check(a.fake.inbound.every((m) => m.type !== 'moveAvatar'), 'the happy path never teleports the avatar');
}

/* ------------------------------------------------------- misc: reload -- */

section('misc: a ready (embed reload) mid-sync aborts; after sync the echo path works');
{
  const env = setup(geo(40, STEP[1]));
  env.fake.onInbound = (msg, fake) => {
    if (msg.type === 'executeCommand' && msg.payload.command === 'largerStep') fake.ready();
  };
  const res = await sync(env);
  check(!res.ok && res.reason === 'interrupted', 'ready mid-sync → interrupted', res.reason);

  const ok = setup(geo(40, STEP[1]));
  await sync(ok);
  const target = ok.tracker.targetForPin([45, 12]);
  ok.tracker.noteSent(target);
  ok.channel.moveAvatar(target);
  await flush();
  check(ok.lastObserve.kind === 'echo' && eq(ok.fake.rendererPinOfAvatar(), [45, 12]), 'a finger send echoes and lands on its pin');
  const q = toQ(ok.tracker.model, ok.fake.externalPosition);
  check(Math.abs(q[0] - 15) < 1e-6 && Math.abs(q[1] - 8) < 1e-6, 'at world pins (15, 8) from the anchor', JSON.stringify(q));
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
