/**
 * Drawable geometry for the Audiom bounds probe (diagnostic only).
 *
 * `discoverBounds` in `AudiomMap.jsx` finds the map's bounds with FOUR
 * independent 1-D binary searches run from ONE seed — the avatar's start
 * position. West/east sweep along the seed's latitude, south/north along the
 * seed's longitude. That measures a CROSS-SECTION THROUGH THE SEED, not a
 * bounding box, and the two only coincide when the map's data extent is a
 * rectangle whose sides are all reachable from that one line.
 *
 * Measured on map 885 (Wisconsin) against known-good extents:
 *   - east came up 19.8 km SHORT — the eastward ray runs into the Lake Michigan
 *     shoreline long before the map's easternmost data, so the search stops at
 *     the first unreachable point rather than at the data edge;
 *   - north and south each OVERSHOT by ~22 km — the avatar keeps accepting move
 *     commands through empty space past the last feature;
 *   - the resulting aspect was 9.5% wrong, and aspect feeds
 *     `rows = round(cellsAcross / aspect)` and therefore the physical sheet.
 *
 * The seed offset is the signal worth looking at. If the seed sat exactly at the
 * centre of the true extent, the four rays would be symmetric and a
 * cross-section would be indistinguishable from a bounding box. Every degree the
 * seed sits off centre is a degree of asymmetry the four independent searches
 * cannot see, so `offset.fracX/fracY` (seed displacement as a fraction of the
 * resolved half-extent) is a direct, map-agnostic read on how much the
 * cross-section can be trusted. Asymmetric ray termination — one ray stopping
 * far short of its opposite while the seed sits near centre — is the other
 * tell, and it is why the raw sample dots are drawn rather than summarised.
 *
 * This module is PURE: no DOM, no React, no canvas. It takes raw probe
 * telemetry and returns normalized [0..1] drawing coordinates plus the scene
 * aspect the renderer should size its canvas to. Projection is Web Mercator via
 * `mercX`/`mercY` — the same convention `mercAspect` uses for the printed
 * aspect — so the drawn rectangle has the same shape as the window the rest of
 * the app computes. There is deliberately no second projection here.
 *
 * Nothing in here guesses. A missing seed, an unresolved edge or a degenerate
 * extent comes back as `ok: false` with a `reason`, and the caller is expected
 * to render that fact rather than substitute a default.
 */
import { mercX, mercY, invMercY, mercAspect } from '../audiom.js';

/** Edge order is W, E, S, N — the order `discoverBounds` probes them in. */
export const EDGE_KEYS = ['west', 'east', 'south', 'north'];

/**
 * Scene padding, as a fraction of the LARGER of the two base-extent dimensions.
 * Relative, so it is identical for a room-sized indoor diagram and a statewide
 * map; absolute in the sense that both axes get the same pad, which keeps a
 * degenerate (zero-width or zero-height) extent drawable instead of collapsing.
 */
export const DEFAULT_MARGIN = 0.18;

const AXIS_OF = { west: 'lng', east: 'lng', south: 'lat', north: 'lat' };
const DIR_OF = { west: -1, east: 1, south: -1, north: 1 };

const num = (v) => (Number.isFinite(v) ? v : null);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function empty(reason) {
  return {
    ok: false,
    reason,
    scene: null,
    rect: null,
    seed: null,
    center: null,
    offset: null,
    rays: [],
    unresolved: [...EDGE_KEYS],
    sampleCount: 0,
  };
}

/**
 * Ground metres between two lng/lat pairs, using the same flat approximation
 * `AudiomMap.metersBetween` uses. Repeated rather than imported because this
 * module must stay free of anything that touches the DOM; the constant and the
 * cos(lat) term are the same, so the two cannot disagree.
 */
function metersBetween(a, b) {
  const latRad = (a.lat * Math.PI) / 180;
  const dLat = (b.lat - a.lat) * 111320;
  const dLng = (b.lng - a.lng) * 111320 * Math.cos(latRad);
  return Math.hypot(dLat, dLng);
}

/**
 * @param {object|null|undefined} telemetry as emitted by `AudiomMap`'s `onProbe`
 * @param {{ margin?: number }} [options]
 * @returns {object} normalized drawing geometry; see the module comment.
 */
export function buildProbeGeometry(telemetry, { margin = DEFAULT_MARGIN } = {}) {
  if (!telemetry || typeof telemetry !== 'object') return empty('no-telemetry');

  const seedLng = num(telemetry.seed?.lng);
  const seedLat = num(telemetry.seed?.lat);
  if (seedLng === null || seedLat === null) return empty('no-seed');
  const seedPt = { lng: seedLng, lat: seedLat };

  // ---- 1. normalize the raw per-edge traces -------------------------------
  //
  // An edge is "resolved" only when `findEdge` returned a finite coordinate.
  // It returns null when a probe call failed (`getState` timed out) or when the
  // expansion reached 200° without ever landing outside; both are recorded, not
  // repaired.
  const traces = EDGE_KEYS.map((key) => {
    const raw = telemetry.edges?.[key] || null;
    const axis = raw?.axis || AXIS_OF[key];
    const dir = Number.isFinite(raw?.dir) ? raw.dir : DIR_OF[key];
    const value = num(raw?.value);
    const samples = Array.isArray(raw?.samples)
      ? raw.samples
        .filter((s) => Number.isFinite(s?.lng) && Number.isFinite(s?.lat))
        // `inside` is tri-state: true, false, or null when the probe itself
        // failed and the sample answered nothing at all.
        .map((s) => ({ lng: s.lng, lat: s.lat, inside: s.inside === null ? null : !!s.inside }))
      : [];
    const edge = value === null
      ? null
      : (axis === 'lng' ? { lng: value, lat: seedLat } : { lng: seedLng, lat: value });
    return {
      key,
      axis,
      dir,
      probe: raw?.probe ?? null,
      resolved: value !== null,
      reason: raw?.reason ?? null,
      bisectAborted: !!raw?.bisectAborted,
      value,
      edge,
      samples,
      bracket: {
        lastInsideDeg: num(raw?.bracket?.lastInsideDeg),
        firstOutsideDeg: num(raw?.bracket?.firstOutsideDeg),
      },
    };
  });

  const unresolved = traces.filter((t) => !t.resolved).map((t) => t.key);
  const sampleCount = traces.reduce((n, t) => n + t.samples.length, 0);

  // ---- 2. scene extent ----------------------------------------------------
  //
  // Anchors are the seed, every resolved edge point, and every sample that read
  // INSIDE. Outside samples are excluded on purpose: expansion doubles from 0.5°
  // up to 200°, so a single first-outside sample can sit three orders of
  // magnitude beyond the map and would squash the whole diagram to a dot. They
  // are still drawn — clamped to the scene border with `clipped: true` — so the
  // renderer can mark them as off-scale rather than silently drop them.
  //
  // When all four edges resolve, this anchor set is EXACTLY the resolved
  // rectangle: the four edge points are (west, seedLat), (east, seedLat),
  // (seedLng, south), (seedLng, north), whose extent is [west..east] ×
  // [south..north], and every inside sample lies on a ray within it. So one rule
  // covers the complete case and the partial one without branching on either.
  const anchors = [seedPt];
  for (const t of traces) {
    if (t.edge) anchors.push(t.edge);
    for (const s of t.samples) if (s.inside === true) anchors.push(s);
  }

  let mx0 = Infinity; let mx1 = -Infinity; let my0 = Infinity; let my1 = -Infinity;
  for (const p of anchors) {
    const x = mercX(p.lng); const y = mercY(p.lat);
    if (x < mx0) mx0 = x;
    if (x > mx1) mx1 = x;
    if (y < my0) my0 = y;
    if (y > my1) my1 = y;
  }
  const baseW = mx1 - mx0;
  const baseH = my1 - my0;
  const span = Math.max(baseW, baseH);
  if (!Number.isFinite(span) || span <= 0) {
    const bare = empty('degenerate-extent');
    bare.unresolved = unresolved;
    bare.sampleCount = sampleCount;
    return bare;
  }
  const pad = margin * span;
  const scene = { x0: mx0 - pad, x1: mx1 + pad, y0: my0 - pad, y1: my1 + pad };
  const sceneW = scene.x1 - scene.x0;
  const sceneH = scene.y1 - scene.y0;

  // mercY grows southward, so y = 0 is the NORTH edge of the scene — already the
  // orientation a canvas wants, with no extra flip anywhere downstream.
  const project = (lng, lat) => {
    const x = (mercX(lng) - scene.x0) / sceneW;
    const y = (mercY(lat) - scene.y0) / sceneH;
    return { x: clamp01(x), y: clamp01(y), clipped: x < 0 || x > 1 || y < 0 || y > 1 };
  };

  // ---- 3. the resolved rectangle, its centre, and the seed's offset --------
  const byKey = Object.fromEntries(traces.map((t) => [t.key, t]));
  const west = byKey.west.value;
  const east = byKey.east.value;
  const south = byKey.south.value;
  const north = byKey.north.value;
  // Same validity test `discoverBounds` applies before it calls `onBounds`, so
  // the drawing agrees with what the app actually accepted as bounds.
  const rectValid = unresolved.length === 0 && east > west && north > south;

  let rect = null;
  let center = null;
  let offset = null;
  if (rectValid) {
    const tl = project(west, north);
    const br = project(east, south);
    rect = {
      west, south, east, north,
      x0: tl.x, y0: tl.y, x1: br.x, y1: br.y,
      aspect: mercAspect([west, south, east, north]),
    };
    const centerLng = (west + east) / 2;
    // Centre in MERCATOR, not in raw degrees: the rectangle is drawn in
    // Mercator, so a degree-space midpoint would not sit at the middle of the
    // drawn box and the offset arrow would lie about its own length.
    const centerLat = invMercY((mercY(north) + mercY(south)) / 2);
    const c = project(centerLng, centerLat);
    center = { lng: centerLng, lat: centerLat, x: c.x, y: c.y };
    const halfW = (mercX(east) - mercX(west)) / 2;
    const halfH = (mercY(south) - mercY(north)) / 2;
    const sx = mercX(seedLng); const sy = mercY(seedLat);
    offset = {
      dLng: seedLng - centerLng,
      dLat: seedLat - centerLat,
      dMeters: metersBetween({ lng: centerLng, lat: centerLat }, seedPt),
      // Signed, and normalized by the rectangle's own half-extent: 0 = dead
      // centre, ±1 = on an edge. Unit-free, so a 6 km campus and a 500 km state
      // report the same number for the same amount of asymmetry.
      //
      // The signs are GEOGRAPHIC — +x east, +y north — so they agree with
      // `dLng`/`dLat` sitting beside them. Note that this is the opposite of the
      // drawing-space `y`, which grows southward because mercY does; the flip
      // lives here, once, rather than in every reader of the number.
      fracX: halfW > 0 ? (sx - mercX(centerLng)) / halfW : null,
      fracY: halfH > 0 ? (mercY(centerLat) - sy) / halfH : null,
    };
  }

  // ---- 4. project the rays ------------------------------------------------
  const s = project(seedLng, seedLat);
  const seed = { lng: seedLng, lat: seedLat, x: s.x, y: s.y };

  const rays = traces.map((t) => {
    const samples = t.samples.map((p) => ({ ...p, ...project(p.lng, p.lat) }));
    const edge = t.edge ? { ...t.edge, ...project(t.edge.lng, t.edge.lat) } : null;
    // Where the drawn ray stops. Resolved: the edge. Unresolved: the farthest
    // sample that still landed on-scene, so the line shows how far the search
    // actually got before it gave up — an explicit stub, not a stand-in edge.
    let tip = edge ? { x: edge.x, y: edge.y } : null;
    if (!tip) {
      let best = null; let bestD = -1;
      for (const p of samples) {
        if (p.clipped) continue;
        const d = Math.hypot(p.x - seed.x, p.y - seed.y);
        if (d > bestD) { bestD = d; best = p; }
      }
      tip = best ? { x: best.x, y: best.y } : { x: seed.x, y: seed.y };
    }
    return {
      key: t.key,
      axis: t.axis,
      dir: t.dir,
      probe: t.probe,
      resolved: t.resolved,
      reason: t.reason,
      bisectAborted: t.bisectAborted,
      value: t.value,
      bracket: t.bracket,
      samples,
      edge,
      tip,
    };
  });

  return {
    ok: rectValid,
    reason: rectValid ? null : (unresolved.length ? 'unresolved-edges' : 'inverted-bounds'),
    scene: {
      merc: scene,
      // Pixel width : height the renderer must size its canvas to. Because both
      // axes are normalized over the same scene box, drawing at this aspect makes
      // the rectangle inside come out at exactly `rect.aspect` — the number the
      // app prints the material at.
      aspect: sceneW / sceneH,
    },
    rect,
    seed,
    center,
    offset,
    rays,
    unresolved,
    sampleCount,
  };
}
