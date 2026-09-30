/**
 * DOT Pad viewport mirror — the host's copy of Audiom's tactile window.
 *
 * Design: `docs/dotpad-camio-design.md` §3 (D1, D4, D7). Audiom renders a fixed
 * 60×40 pin window onto the DOT Pad and pages it whenever the avatar leaves the
 * inner band, but the embed never tells the host where that window is (F8). The
 * only thing we can observe is `positionChanged` (F9), which fires for EVERY
 * avatar move, and paging is a pure function of those moves (F5, F6). So the
 * host replays Audiom's `panViewportToKeepAvatar` on each position, in pin units,
 * and the mirror is exact for every page.
 *
 * Units (§3.1): everything here is in WORLD PINS relative to the sync anchor
 * `p0`. A world pin is one `metersPerPin` step along world +x (east/right) or +y
 * (north/up). Audiom's viewport centre only ever moves by whole multiples of 56
 * or 36 pins from the last re-centre, so the mirrored centre is integer and the
 * integer arithmetic below is exact.
 *
 * The lng/lat ↔ world-pin map is an affine `A` in a local plane (§3.2-3.3): the
 * ENU tangent plane at the sync point for geographic maps, or identity for
 * custom-coordinate maps. `lib/dotpadSync.js` measures `A`; this module only
 * applies it.
 *
 * PLATFORM-FREE: no DOM, no React. Imports only `enu.js`. Covered by
 * `scripts/test_dotpad_viewport.mjs` (including a parity check against a
 * verbatim metre port of Audiom's `viewport.ts`) and `scripts/test_dotpad_sync.mjs`.
 */

import { enuForward, enuInverse } from './enu.js';

/**
 * Audiom's tactile geometry — NOT the device's. `MapViewer.tsx:515-520` at
 * 87121f55 hard-codes `width 60, height 40, overlapPins 2` (F1). If upstream
 * changes these, the mirror silently drifts: re-check on every Audiom upgrade.
 */
export const DOTPAD_GEOMETRY = Object.freeze({ W: 60, H: 40, o: 2 });

const derived = (g) => ({
  HW: Math.floor(g.W / 2),   // 30 — centre is pin (30, 20)
  HH: Math.floor(g.H / 2),   // 20
  PW: g.W - 2 * g.o,         // 56 — horizontal page
  PH: g.H - 2 * g.o,         // 36 — vertical page
  maxX: g.W - 1 - g.o,       // 57
  maxY: g.H - 1 - g.o,       // 37
});

/* ------------------------------------------------------ pin arithmetic -- */

/**
 * Audiom's `worldToPin` in pin units: `left = cx − HW`, `top = cy + HH`. JS
 * `Math.round` exactly like upstream, so `x.5` ties break the same way.
 *
 * @param {number[]} q World pins [x, y].
 * @param {number[]} c Viewport centre, world pins [cx, cy].
 * @returns {number[]} Pin [px, py], py counted DOWN from the top row.
 */
export function worldToPin(q, c, g = DOTPAD_GEOMETRY) {
  const { HW, HH } = derived(g);
  return [Math.round(q[0] - (c[0] - HW)), Math.round((c[1] + HH) - q[1])];
}

/** Inverse of {@link worldToPin} for a pin centre. @returns {number[]} world pins */
export function pinToWorld(p, c, g = DOTPAD_GEOMETRY) {
  const { HW, HH } = derived(g);
  return [(c[0] - HW) + p[0], (c[1] + HH) - p[1]];
}

/** Inside the band Audiom never pages from: `[o, W−1−o] × [o, H−1−o]` = [2..57]×[2..37]. */
export function isInnerPin(p, g = DOTPAD_GEOMETRY) {
  if (!p) return false;
  const { maxX, maxY } = derived(g);
  return p[0] >= g.o && p[0] <= maxX && p[1] >= g.o && p[1] <= maxY;
}

/**
 * `panViewportToKeepAvatar` in pin units — same loop order as
 * `viewport.ts:76-95` (x first, then y; each while-loop recomputes the pin).
 *
 * @param {number[]} c Current centre (world pins).
 * @param {number[]} q Avatar (world pins).
 * @returns {number[]} New centre; the SAME array when nothing paged.
 */
export function panToKeep(c, q, g = DOTPAD_GEOMETRY) {
  const { PW, PH, maxX, maxY } = derived(g);
  let cx = c[0];
  let cy = c[1];
  let [px, py] = worldToPin(q, [cx, cy], g);
  while (px < g.o) { cx -= PW; [px, py] = worldToPin(q, [cx, cy], g); }
  while (px > maxX) { cx += PW; [px, py] = worldToPin(q, [cx, cy], g); }
  while (py < g.o) { cy += PH; [px, py] = worldToPin(q, [cx, cy], g); }
  while (py > maxY) { cy -= PH; [px, py] = worldToPin(q, [cx, cy], g); }
  if (cx === c[0] && cy === c[1]) return c;
  return [cx, cy];
}

/* ---------------------------------------------------------------- planes -- */

/**
 * Project lng/lat into a local plane.
 *   - `enu`      — ENU metres at `origin` (§3.3).
 *   - `identity` — raw coordinate differences from `origin` (custom-coordinate
 *                  maps, where Audiom's internal = external, F12).
 *
 * @param {'enu'|'identity'} plane
 * @param {number[]} origin [lng, lat]
 * @param {number[]} L [lng, lat]
 * @returns {number[]}
 */
export function toPlane(plane, origin, L) {
  if (plane === 'enu') return enuForward(L, origin);
  return [L[0] - origin[0], L[1] - origin[1]];
}

/** Inverse of {@link toPlane}. */
export function fromPlane(plane, origin, xy) {
  if (plane === 'enu') return enuInverse(xy, origin);
  return [xy[0] + origin[0], xy[1] + origin[1]];
}

const inv2 = (A) => {
  const det = A[0][0] * A[1][1] - A[0][1] * A[1][0];
  if (!Number.isFinite(det) || det === 0) throw new RangeError('dotpadViewport: singular A');
  return [[A[1][1] / det, -A[0][1] / det], [-A[1][0] / det, A[0][0] / det]];
};
const mul2 = (M, v) => [M[0][0] * v[0] + M[0][1] * v[1], M[1][0] * v[0] + M[1][1] * v[1]];

/**
 * @typedef {object} DotpadModel
 * @property {'enu'|'identity'} plane
 * @property {number[]} planeOrigin  P_start of the sync — the ENU tangent point.
 * @property {number[]} p0           Avatar lng/lat when Audiom last re-centred.
 * @property {number[][]} A          Plane units per world pin; column 0 = +x pin, column 1 = +y pin.
 * @property {number[][]} Ainv
 * @property {number[]} planeP0      `toPlane(p0)`, cached.
 * @property {number[]} center       [0, 0] — the tracker owns the live centre.
 * @property {number} headingDeg     From the probe (compass, clockwise from north).
 * @property {number|null} metresPerPin ENU only; for speech.
 * @property {{W: number, H: number, o: number}} geometry
 */

/**
 * @param {object} spec
 * @returns {DotpadModel}
 */
export function createModel({
  plane, planeOrigin, p0, A, headingDeg = 0, metresPerPin = null, geometry = DOTPAD_GEOMETRY,
}) {
  if (plane !== 'enu' && plane !== 'identity') throw new RangeError(`createModel: bad plane ${plane}`);
  const Ainv = inv2(A);
  return Object.freeze({
    plane,
    planeOrigin: [...planeOrigin],
    p0: [...p0],
    A: A.map((r) => [...r]),
    Ainv,
    planeP0: toPlane(plane, planeOrigin, p0),
    center: [0, 0],
    headingDeg,
    metresPerPin,
    geometry,
  });
}

/** lng/lat → world pins relative to `p0`: `Ainv · (plane(L) − plane(p0))`. */
export function toQ(model, L) {
  const xy = toPlane(model.plane, model.planeOrigin, L);
  return mul2(model.Ainv, [xy[0] - model.planeP0[0], xy[1] - model.planeP0[1]]);
}

/** World pins → lng/lat: `planeInverse(plane(p0) + A · q)`. */
export function toLngLat(model, q) {
  const d = mul2(model.A, q);
  return fromPlane(model.plane, model.planeOrigin, [model.planeP0[0] + d[0], model.planeP0[1] + d[1]]);
}

/* --------------------------------------------------------------- tracker -- */

const mod = (a, n) => ((a % n) + n) % n;
/** Smallest distance between two angles on a circle of period `n` degrees. */
const circDist = (a, b, n) => { const d = mod(a - b, n); return Math.min(d, n - d); };

/**
 * Heading-axis angle in pin space, mod 90°. A grid move at compass heading θ is
 * `(sin θ, cos θ)` (forward) or `(cos θ, −sin θ)` (right), and both have
 * `atan2` ≡ −θ (mod 90°) — see F13.
 */
export const headingAxisOf = (headingDeg) => mod(-headingDeg, 90);

/** Echo FIFO bound (§3.5). */
export const ECHO_FIFO_MAX = 8;

/**
 * The stateful half (§3.5). Clock-free: the caller owns time (auto-resync timer,
 * send rate) so this stays deterministic under test.
 *
 * States: `unsynced` (no model) → `syncing` → `synced` ⇄ `stale`.
 *
 * @param {object} [options]
 * @param {{W: number, H: number, o: number}} [options.geometry]
 * @param {number} [options.echoTolPins]  A position within this (∞-norm, pins) of a sent target is our echo.
 * @param {number} [options.gridTol]      |m − 1| ≤ this is a one-pin grid step.
 * @param {number} [options.axisTolDeg]   Heading-axis alignment tolerance for the stale signature.
 */
export function createViewportTracker({
  geometry = DOTPAD_GEOMETRY, echoTolPins = 1e-3, gridTol = 0.02, axisTolDeg = 2,
} = {}) {
  let state = 'unsynced';
  /** @type {DotpadModel|null} */
  let model = null;
  let center = [0, 0];
  let lastQ = null;
  let lastL = null;
  let headingAxis = null;
  /** @type {Array<{q: number[]}>} */
  let fifo = [];
  /** The previous observed event, for the two-step stale signature. */
  let prev = null;
  let staleReason = null;
  let invalidReason = null;

  const pinOf = (q) => (q ? worldToPin(q, center, geometry) : null);

  const api = {
    get state() { return state; },
    get model() { return model; },
    get center() { return center; },
    get staleReason() { return staleReason; },
    get invalidReason() { return invalidReason; },
    get lastLngLat() { return lastL; },

    /** Mirror of Audiom's pin for the avatar, or null before the first sync. */
    avatarPin() { return model ? pinOf(lastQ) : null; },

    /** The pin of the newest unacknowledged send, or null. */
    pendingPin() {
      if (!model || !fifo.length) return null;
      return pinOf(fifo[fifo.length - 1].q);
    },

    /** Pages from the anchor, as whole pages on each axis. */
    pages() {
      const { PW, PH } = derived(geometry);
      return [center[0] / PW, center[1] / PH];
    },

    /** PREP: finger sends pause and observation is left to the sync. */
    beginSync() {
      state = 'syncing';
    },

    /**
     * DONE: install a fresh model. The avatar is at `p0` (Audiom re-centred on
     * it, F3), so this normally yields pin (30, 20).
     */
    completeSync(nextModel, avatarLngLat) {
      model = nextModel;
      center = [0, 0];
      fifo = [];
      prev = null;
      staleReason = null;
      invalidReason = null;
      headingAxis = headingAxisOf(nextModel.headingDeg ?? 0);
      const L = avatarLngLat || nextModel.p0;
      lastL = [...L];
      lastQ = toQ(model, L);
      center = panToKeep(center, lastQ, geometry);
      state = 'synced';
    },

    /** FAIL: back to `stale` if a model survives, else `unsynced`. */
    failSync() {
      state = model ? 'stale' : 'unsynced';
    },

    /** Drop the model outright (embed reload, `ready`). */
    invalidate(reason = 'invalidated') {
      model = null;
      state = 'unsynced';
      fifo = [];
      prev = null;
      lastQ = null;
      invalidReason = reason;
    },

    /**
     * Target lng/lat for a finger pin, or null for the 2-pin border band and
     * whenever the model is not trusted. A target for an inner pin never pages
     * Audiom, because `worldToPin(pinToWorld(p)) = p`.
     */
    targetForPin(p) {
      if (state !== 'synced' || !model || !isInnerPin(p, geometry)) return null;
      return toLngLat(model, pinToWorld(p, center, geometry));
    },

    /** Record a `moveAvatar` we are about to send, so its echo is recognised. */
    noteSent(lngLat) {
      if (!model) return;
      fifo.push({ q: toQ(model, lngLat) });
      if (fifo.length > ECHO_FIFO_MAX) fifo.shift();
    },

    /**
     * One `positionChanged`. Classifies the move, advances the mirror, and
     * detects the two-step scale-change signature (D4).
     *
     * @param {number[]} L [lng, lat]
     */
    observe(L) {
      const none = { kind: 'ignored', paged: false, avatarPin: api.avatarPin(), becameStale: false, staleReason };
      if (!model || state === 'syncing') { lastL = L ? [...L] : lastL; return none; }
      lastL = [...L];
      const q = toQ(model, L);

      let kind;
      let event;
      const echoAt = fifo.findIndex((e) => Math.max(Math.abs(e.q[0] - q[0]), Math.abs(e.q[1] - q[1])) < echoTolPins);
      let becameStale = false;
      if (echoAt >= 0) {
        // Events are ordered, so everything sent before this one is resolved too.
        fifo.splice(0, echoAt + 1);
        kind = 'echo';
        event = { kind };
      } else {
        const d = lastQ ? [q[0] - lastQ[0], q[1] - lastQ[1]] : [0, 0];
        const m = Math.hypot(d[0], d[1]);
        const ang = (Math.atan2(d[1], d[0]) * 180) / Math.PI;
        if (Math.abs(m - 1) <= gridTol) {
          kind = 'grid';
          headingAxis = mod(ang, 90);
          event = { kind, m };
        } else {
          kind = 'offgrid';
          const aligned = m > 0 && headingAxis !== null && circDist(mod(ang, 90), headingAxis, 90) <= axisTolDeg;
          event = { kind, m, aligned };
          if (aligned && prev && prev.kind === 'offgrid' && prev.aligned
              && Math.abs(m - prev.m) / m <= 0.01 && state === 'synced') {
            state = 'stale';
            staleReason = 'scale-changed';
            becameStale = true;
          }
        }
      }
      prev = event;

      // Always mirror the page, even when stale — the debug view keeps moving.
      const next = panToKeep(center, q, geometry);
      const paged = next !== center;
      center = next;
      lastQ = q;
      return { kind, paged, avatarPin: pinOf(q), becameStale, staleReason };
    },
  };
  return api;
}
