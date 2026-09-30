/**
 * DOT Pad sync — measure Audiom's pin lattice and re-anchor its tactile window.
 *
 * Design: `docs/dotpad-camio-design.md` §4 (D2, D3). The embed exposes neither
 * the tactile viewport nor the step size (F8), so the host MEASURES them:
 *
 *   PREP → GRID → START → PROBE_X → PROBE_Y → SOLVE → ANCHOR_1 → BOUNCE → VERIFY
 *        → (ANCHOR_2 → REPAIR) → DONE            any failure → FAIL
 *
 *   - GRID forces `activateGridView`: first-person `up` walks until release and
 *     left/right turn (F13).
 *   - The two-axis probe measures the pin → plane Jacobian directly, so it works
 *     for any heading and for custom-coordinate maps, with no metres and no
 *     projection origin (§4.4).
 *   - The `smallerStep` → `largerStep` bounce is the only re-anchor the embed
 *     offers: every successful step change re-centres the viewport on the avatar
 *     (F3). It fails only at step index 0, where VERIFY sees k ≈ 2–3 and one more
 *     `smallerStep` repairs it (F14).
 *
 * Correctness relies on F11 (inbound handling is synchronous, so the
 * `positionChanged` for a move is posted before the `stateChanged` that answers
 * the next `getState`). `settleMs` sleeps are for audio pacing only.
 *
 * PLATFORM-FREE: pure async, channel and `sleep` injected. Covered end to end by
 * `scripts/test_dotpad_sync.mjs` against `scripts/fixtures/fakeAudiom.mjs`.
 */

import { toPlane, createModel, DOTPAD_GEOMETRY } from './dotpadViewport.js';

/** Direction commands get a matching `_release` (a no-op in grid mode, F13). */
const DIRECTIONS = new Set(['up', 'down', 'left', 'right']);

/**
 * Every MovementTiers step, metric and imperial, in metres —
 * `movementTiers.ts:11-66` at 87121f55. Used only to snap the spoken scale.
 */
export const TIER_VALUES_M = Object.freeze({
  metric: Object.freeze([
    0.01, 0.025, 0.05, 0.1, 0.25,
    0.25, 0.5, 1, 2, 3, 5,
    5, 10, 20, 50, 100,
    100, 250, 500, 1000, 2000,
    10000, 25000, 50000, 100000, 200000, 500000, 1000000,
  ]),
  imperial: Object.freeze([
    0.0254, 0.0762, 0.1524, 0.3048, 0.6096,
    0.3048, 0.6096, 0.9144, 1.524, 3.048, 4.572,
    6.096, 15.24, 30.48, 60.96, 91.44,
    160.934, 402.336, 804.672, 1609.344, 3218.688,
    16093.44, 40233.6, 80467.2, 160934.4, 321868.8, 804672, 1609344,
  ]),
});

/** User-facing sentence per failure reason. */
export const SYNC_FAILURE_TEXT = Object.freeze({
  'no-response': 'DOT Pad sync failed — the map did not answer. Press S to try again.',
  blocked: "Can't sync here — walls or the map edge block movement. Move somewhere open and sync again.",
  'invalid-probe': "Can't sync here — the steps were not a clean grid. Move somewhere open and sync again.",
  interrupted: 'Sync interrupted. Keep your hands off the keys and press S again.',
  'embed-error': 'DOT Pad sync failed — the map reported an error.',
  'unexpected-scale': 'DOT Pad sync failed — the step size changed unexpectedly. Press S to try again.',
});

const trimNum = (s) => s.replace(/\.?0+$/, '');
const plural = (n, one, many) => (Number(n) === 1 ? one : many);

/**
 * Speak a distance the way Audiom's `formatDistanceForDisplay` does
 * (`movementTiers.ts:171-203`), in the stated unit system.
 */
export function formatDistance(metres, system = 'metric') {
  if (system === 'imperial') {
    if (metres < 0.3048) { const n = Math.round(metres / 0.0254); return `${n} ${plural(n, 'inch', 'inches')}`; }
    if (metres < 1609.344) { const n = Math.round(metres / 0.3048); return `${n} ${plural(n, 'foot', 'feet')}`; }
    const n = trimNum((metres / 1609.344).toFixed(2));
    return `${n} ${plural(n, 'mile', 'miles')}`;
  }
  if (metres < 1) { const n = Math.round(metres * 100); return `${n} cm`; }
  if (metres < 1000) { const n = trimNum(metres.toFixed(2)); return `${n} ${plural(n, 'metre', 'metres')}`; }
  const n = trimNum((metres / 1000).toFixed(2));
  return `${n} ${plural(n, 'kilometre', 'kilometres')}`;
}

/**
 * §4.5: snap to a MovementTiers value if within 1%, and pick the unit system
 * that value came from. Non-snapped values are spoken in metric.
 *
 * @param {number|null} metresPerPin
 * @returns {{text: string, snapped: number|null, system: 'metric'|'imperial'}|null}
 */
export function describeScale(metresPerPin) {
  if (!(metresPerPin > 0)) return null;
  let best = null;
  for (const system of ['metric', 'imperial']) {
    for (const v of TIER_VALUES_M[system]) {
      const rel = Math.abs(metresPerPin / v - 1);
      if (rel <= 0.01 && (!best || rel < best.rel)) best = { v, system, rel };
    }
  }
  if (best) return { text: formatDistance(best.v, best.system), snapped: best.v, system: best.system };
  return { text: formatDistance(metresPerPin, 'metric'), snapped: null, system: 'metric' };
}

/* ------------------------------------------------------------------ SOLVE -- */

const DEG = 180 / Math.PI;
const mod = (a, n) => ((a % n) + n) % n;
const circDiffDeg = (a, b) => { const d = mod(a - b, 360); return Math.min(d, 360 - d); };
const circMeanDeg = (a, b) => mod(Math.atan2(Math.sin(a / DEG) + Math.sin(b / DEG), Math.cos(a / DEG) + Math.cos(b / DEG)) * DEG, 360);

/** Q(θ) = [[cosθ, sinθ], [−sinθ, cosθ]] — columns are one step right and one step up at heading θ. */
export function headingMatrix(thetaDeg) {
  const t = thetaDeg / DEG;
  return [[Math.cos(t), Math.sin(t)], [-Math.sin(t), Math.cos(t)]];
}

/**
 * §4.4: decompose the probe matrix `M = [r u]` (plane displacement for one step
 * right, one step up) as `M = A·Q(θ)`.
 *
 * @param {number[]} r
 * @param {number[]} u
 * @returns {{ok: true, A: number[][], a: number, b: number, headingDeg: number, cardinal: boolean}
 *         | {ok: false, reason: string, detail?: object}}
 */
export function solveProbe(r, u) {
  const M = [[r[0], u[0]], [r[1], u[1]]];
  const a = Math.hypot(M[0][0], M[0][1]);
  const b = Math.hypot(M[1][0], M[1][1]);
  if (!(a > 0) || !(b > 0) || !Number.isFinite(a) || !Number.isFinite(b)) {
    return { ok: false, reason: 'degenerate', detail: { a, b } };
  }
  const t0 = mod(Math.atan2(M[0][1], M[0][0]) * DEG, 360);
  const t1 = mod(Math.atan2(-M[1][0], M[1][1]) * DEG, 360);
  if (circDiffDeg(t0, t1) >= 1) return { ok: false, reason: 'skewed', detail: { t0, t1 } };
  // R' = diag(1/a, 1/b)·M must be a rotation.
  const R = [[M[0][0] / a, M[0][1] / a], [M[1][0] / b, M[1][1] / b]];
  const RtR = [
    [R[0][0] * R[0][0] + R[1][0] * R[1][0], R[0][0] * R[0][1] + R[1][0] * R[1][1]],
    [R[0][1] * R[0][0] + R[1][1] * R[1][0], R[0][1] * R[0][1] + R[1][1] * R[1][1]],
  ];
  const off = Math.max(Math.abs(RtR[0][0] - 1), Math.abs(RtR[1][1] - 1), Math.abs(RtR[0][1]), Math.abs(RtR[1][0]));
  const det = M[0][0] * M[1][1] - M[0][1] * M[1][0];
  if (!(off < 0.02) || !(det > 0)) return { ok: false, reason: 'not-a-rotation', detail: { off, det } };

  const theta = circMeanDeg(t0, t1);
  const thetaS = mod(90 * Math.round(theta / 90), 360);
  const cardinal = circDiffDeg(theta, thetaS) < 3;
  let A;
  if (cardinal) {
    // A = M·Q(θs)ᵀ — exact, and keeps the small plane rotation ε.
    const Q = headingMatrix(thetaS);
    A = [
      [M[0][0] * Q[0][0] + M[0][1] * Q[0][1], M[0][0] * Q[1][0] + M[0][1] * Q[1][1]],
      [M[1][0] * Q[0][0] + M[1][1] * Q[0][1], M[1][0] * Q[1][0] + M[1][1] * Q[1][1]],
    ];
  } else {
    // Non-cardinal heading: assume ε ≈ 0 (R6).
    A = [[a, 0], [0, b]];
  }
  return { ok: true, A, a, b, headingDeg: cardinal ? thetaS : theta, cardinal };
}

/**
 * §3.3 plane choice. `enu` iff P_start is a plausible lng/lat, the lattice is
 * square in the ENU plane, and NOT square in raw lng/lat. Otherwise identity
 * (custom-coordinate maps, and the equator band where both agree).
 *
 * @param {number[]} pStart
 * @param {{enu: {a: number, b: number}|null, identity: {a: number, b: number}|null}} norms Row norms per plane.
 * @returns {'enu'|'identity'}
 */
export function choosePlane(pStart, norms) {
  const validLngLat = Math.abs(pStart[0]) <= 180 && Math.abs(pStart[1]) <= 85;
  const square = (n) => !!n && Math.abs(n.a / n.b - 1) < 0.005;
  return validLngLat && square(norms.enu) && !square(norms.identity) ? 'enu' : 'identity';
}

/* ----------------------------------------------------------- auto-resync -- */

/** §5: auto-resync waits this long after the last foreign `positionChanged`. */
export const AUTO_RESYNC_QUIET_MS = 1500;

/**
 * The auto-resync timer, clock injected so the policy is testable. Only the
 * STALE state arms it (§5); every foreign move while stale calls `poke()`,
 * which restarts the quiet period. There is no periodic sync, by design (R4).
 *
 * @param {object} options
 * @param {() => void} options.onFire
 * @param {number} [options.quietMs]
 * @param {(fn: () => void, ms: number) => any} [options.setTimer]
 * @param {(id: any) => void} [options.clearTimer]
 */
export function createResyncScheduler({
  onFire, quietMs = AUTO_RESYNC_QUIET_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id),
}) {
  let timer = null;
  const cancel = () => { if (timer !== null) { clearTimer(timer); timer = null; } };
  return {
    get pending() { return timer !== null; },
    poke() {
      cancel();
      timer = setTimer(() => { timer = null; onFire(); }, quietMs);
    },
    cancel,
  };
}

/* ------------------------------------------------------------------- run -- */

class SyncFailure extends Error {
  constructor(reason, detail) { super(reason); this.reason = reason; this.detail = detail; }
}

const moved = (x, y) => x[0] !== y[0] || x[1] !== y[1];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];

/**
 * Run one sync.
 *
 * @param {object} options
 * @param {{executeCommand: Function, getState: Function, moveAvatar: Function, onMessage: Function}} options.channel
 * @param {ReturnType<import('./dotpadViewport.js').createViewportTracker>} options.tracker
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {number} [options.settleMs]
 * @param {(phase: string, info?: object) => void} [options.onPhase]
 * @param {object} [options.geometry]
 * @param {'enu'|'identity'} [options.forcePlane] Diagnostics/tests only: skip the §3.3 choice.
 * @returns {Promise<{ok: true, model: object, stepRepaired: boolean, headingDeg: number, metresPerPin: number|null, commands: string[], k: number}
 *                 | {ok: false, reason: string, detail: any, commands: string[]}>}
 */
export async function runDotpadSync({
  channel, tracker,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  settleMs = 40, onPhase, geometry = DOTPAD_GEOMETRY, forcePlane = null,
}) {
  const commands = [];
  const phase = (name, info) => { try { onPhase?.(name, info); } catch { /* observer only */ } };

  // Interference guard (§4.2). Every positionChanged must be explained by one of
  // OUR move-capable messages since the previous getState.
  let positionEvents = 0;
  let allowed = 0;
  let pendingMoves = 0;
  let aborted = null;
  const unsubscribe = channel.onMessage((type, payload) => {
    if (type === 'positionChanged') positionEvents += 1;
    else if (type === 'error') aborted ??= new SyncFailure('embed-error', payload);
    else if (type === 'ready') aborted ??= new SyncFailure('interrupted', 'embed reloaded');
  });
  const checkAbort = () => { if (aborted) throw aborted; };

  const settle = async () => { if (settleMs > 0) await sleep(settleMs); checkAbort(); };
  const exec = async (c) => {
    checkAbort();
    commands.push(c);
    channel.executeCommand(c);
    await settle();
  };
  /** A direction command plus its release, back to back (no walk can start between them). */
  const cmd = async (c) => {
    checkAbort();
    commands.push(c);
    channel.executeCommand(c);
    if (DIRECTIONS.has(c)) {
      commands.push(`${c}_release`);
      channel.executeCommand(`${c}_release`);
      pendingMoves += 1;
    }
    await settle();
  };

  let known = null;
  const state = async () => {
    checkAbort();
    commands.push('getState');
    const p = await channel.getState();
    checkAbort();
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) throw new SyncFailure('no-response');
    const pos = [p[0], p[1]];
    if (known && moved(pos, known)) {
      if (pendingMoves === 0) throw new SyncFailure('interrupted', 'unexpected move');
      allowed += 1;
    }
    pendingMoves = 0;
    if (positionEvents > allowed) throw new SyncFailure('interrupted', { positionEvents, allowed });
    known = pos;
    return pos;
  };
  const moveTo = async (target) => {
    checkAbort();
    commands.push('moveAvatar');
    channel.moveAvatar(target);
    pendingMoves += 1;
    await settle();
  };

  /** If `x` is not back at `s`, put it there. */
  const ensureAt = async (s, x, stepTo) => {
    const step = Math.hypot(...sub(stepTo, s));
    if (Math.hypot(...sub(x, s)) > 1e-6 * step) {
      await moveTo(s);
      await state();
    }
  };

  /** §4.3: one step in `primary` as a {from, to} pair; the avatar ends back at `s`. */
  const probeAxis = async (primary, opposite, s) => {
    await cmd(primary);
    const a = await state();
    if (moved(a, s)) {
      await cmd(opposite);
      const back = await state();
      await ensureAt(s, back, a);
      return { from: s, to: a };
    }
    await cmd(opposite);
    const b = await state();
    if (moved(b, s)) {
      await cmd(primary);
      const back = await state();
      await ensureAt(s, back, b);
      return { from: b, to: s };
    }
    throw new SyncFailure('blocked', { axis: primary });
  };

  let pStart = null;
  try {
    phase('prep');
    tracker.beginSync();

    phase('grid');
    await exec('activateGridView');

    phase('start');
    pStart = await state();

    phase('probe-x');
    const px = await probeAxis('right', 'left', pStart);
    phase('probe-y');
    const py = await probeAxis('up', 'down', known);

    phase('solve');
    const disp = (plane, pr) => sub(toPlane(plane, pStart, pr.to), toPlane(plane, pStart, pr.from));
    const tryPlane = (plane) => {
      try {
        const r = disp(plane, px);
        const u = disp(plane, py);
        if (![...r, ...u].every(Number.isFinite)) return null;
        return { r, u, solved: solveProbe(r, u) };
      } catch { return null; }
    };
    const validLngLat = Math.abs(pStart[0]) <= 180 && Math.abs(pStart[1]) <= 85;
    const enuTry = validLngLat ? tryPlane('enu') : null;
    const idTry = tryPlane('identity');
    // Row norms of M = [r u] in each plane.
    const rowNorms = (t) => (t ? { a: Math.hypot(t.r[0], t.u[0]), b: Math.hypot(t.r[1], t.u[1]) } : null);
    const norms = { enu: rowNorms(enuTry), identity: rowNorms(idTry) };
    const plane = forcePlane ?? choosePlane(pStart, norms);
    const chosen = plane === 'enu' ? enuTry : idTry;
    if (!chosen || !chosen.solved.ok) {
      throw new SyncFailure('invalid-probe', chosen?.solved ?? 'no plane');
    }
    const solved = chosen.solved;

    phase('anchor');
    let p0 = await state();

    phase('bounce');
    await exec('smallerStep');
    await exec('largerStep');

    phase('verify');
    let pv;
    try {
      pv = await probeAxis('right', 'left', p0);
    } catch (e) {
      if (!(e instanceof SyncFailure) || e.reason !== 'blocked') throw e;
      pv = await probeAxis('up', 'down', p0);
    }
    const r2 = disp(plane, pv);
    const probeModel = createModel({ plane, planeOrigin: pStart, p0, A: solved.A, headingDeg: solved.headingDeg, geometry });
    const q2 = [
      probeModel.Ainv[0][0] * r2[0] + probeModel.Ainv[0][1] * r2[1],
      probeModel.Ainv[1][0] * r2[0] + probeModel.Ainv[1][1] * r2[1],
    ];
    const k = Math.hypot(q2[0], q2[1]);
    let stepRepaired = false;
    if (k < 0.95) throw new SyncFailure('unexpected-scale', { k });
    if (k > 1.05) {
      // Index 0: only `largerStep` fired. Put the step back, which also
      // re-centres Audiom on the avatar (F3) with the original scale A₁.
      phase('repair', { k });
      p0 = await state();
      await exec('smallerStep');
      stepRepaired = true;
    }

    const metresPerPin = plane === 'enu' ? Math.sqrt(Math.abs(solved.A[0][0] * solved.A[1][1] - solved.A[0][1] * solved.A[1][0])) : null;
    const model = createModel({
      plane, planeOrigin: pStart, p0, A: solved.A, headingDeg: solved.headingDeg, metresPerPin, geometry,
    });
    const finalPos = await state();
    tracker.completeSync(model, finalPos);
    phase('done', { model, k, stepRepaired });
    return { ok: true, model, stepRepaired, headingDeg: solved.headingDeg, metresPerPin, commands, k };
  } catch (e) {
    const failure = e instanceof SyncFailure ? e : new SyncFailure('embed-error', e?.message ?? String(e));
    // Put the avatar back where the user left it — unless the user took over.
    if (pStart && known && moved(known, pStart) && failure.reason !== 'interrupted') {
      commands.push('moveAvatar');
      try { channel.moveAvatar(pStart); } catch { /* best effort */ }
    }
    tracker.failSync();
    phase('fail', { reason: failure.reason, detail: failure.detail });
    return { ok: false, reason: failure.reason, detail: failure.detail, commands };
  } finally {
    unsubscribe?.();
  }
}
