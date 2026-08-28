#!/usr/bin/env node
/**
 * Bounds-probe visualizer geometry.
 *
 *   node starter/scripts/test_probe_geometry.mjs
 *
 * FULLY OFFLINE. `lib/probeGeometry.js` is the pure half of the diagnostic: raw
 * probe telemetry in, normalized drawing coordinates out. Nothing here touches
 * the DOM, so the whole thing is checkable in Node — which matters, because the
 * numbers this produces are the ones a reader will use to decide whether the
 * discovered bounds can be trusted.
 *
 * `simulateEdge` below re-implements `findEdge`'s search EXACTLY (expand
 * 0.5 → 200 by doubling, then 10 bisections) against a synthetic map, so the
 * telemetry fed to the helper has the same shape, ordering and sample count a
 * live probe produces. A hand-written 3-sample fixture would pass while missing
 * everything about how the real traces look.
 */

import { buildProbeGeometry, EDGE_KEYS, DEFAULT_MARGIN } from '../src/lib/probeGeometry.js';
import { mercX, mercY, invMercY, mercAspect } from '../src/audiom.js';

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
const section = (title) => console.log(`\n— ${title} ${'—'.repeat(Math.max(0, 62 - title.length))}`);
const near = (a, b, tol) => Number.isFinite(a) && Math.abs(a - b) <= tol;

/* ------------------------------------------------------------------ harness -- */

/**
 * One edge trace, produced by running the real search shape against a synthetic
 * "map" defined only by where its edge is.
 *
 * `limitDeg` is the true distance (degrees, unsigned) from the seed to the map
 * edge along this axis. `failAt` makes the nth sample answer nothing, which is
 * how a `getState` timeout shows up. `limitDeg = Infinity` reproduces the
 * "never got outside within 200°" failure.
 */
function simulateEdge(seed, axis, dir, probe, limitDeg, { failAt = null } = {}) {
  const from = [seed.lng, seed.lat];
  const at = (d) => (axis === 'lng' ? [from[0] + d, from[1]] : [from[0], from[1] + d]);
  const t = {
    axis: null, dir: null, probe: null,
    samples: [], bracket: { lastInsideDeg: null, firstOutsideDeg: null },
    value: null, resolved: false, reason: null, bisectAborted: false,
  };
  t.axis = axis; t.dir = dir; t.probe = probe;
  let n = 0;
  const ask = (p) => {
    n += 1;
    if (failAt !== null && n === failAt) {
      t.samples.push({ lng: p[0], lat: p[1], inside: null });
      return null;
    }
    const inside = Math.abs(axis === 'lng' ? p[0] - from[0] : p[1] - from[1]) <= limitDeg;
    t.samples.push({ lng: p[0], lat: p[1], inside });
    return inside;
  };

  let inside = 0;
  let outside = null;
  for (let d = 0.5; d <= 200; d *= 2) {
    const ok = ask(at(dir * d));
    if (ok === null) { t.reason = 'probe-failed'; return t; }
    if (ok) inside = dir * d; else { outside = dir * d; break; }
  }
  t.bracket.lastInsideDeg = inside;
  t.bracket.firstOutsideDeg = outside;
  if (outside === null) { t.reason = 'no-outside-within-200deg'; return t; }
  for (let i = 0; i < 10; i++) {
    const mid = (inside + outside) / 2;
    const ok = ask(at(mid));
    if (ok === null) { t.bisectAborted = true; break; }
    if (ok) inside = mid; else outside = mid;
  }
  const edge = at((inside + outside) / 2);
  t.value = axis === 'lng' ? edge[0] : edge[1];
  t.resolved = true;
  return t;
}

/** A whole probe run against a rectangular synthetic map. */
function simulateProbe(seed, extent, overrides = {}) {
  const { west, south, east, north } = extent;
  const spec = {
    west: ['lng', -1, 'up', seed.lng - west],
    east: ['lng', +1, 'up', east - seed.lng],
    south: ['lat', -1, 'left', seed.lat - south],
    north: ['lat', +1, 'left', north - seed.lat],
  };
  const edges = {};
  for (const key of EDGE_KEYS) {
    const [axis, dir, probe, limit] = spec[key];
    const o = overrides[key] || {};
    edges[key] = simulateEdge(seed, axis, dir, probe, o.limitDeg ?? limit, o);
  }
  const v = (k) => edges[k].value;
  const bounds = EDGE_KEYS.every((k) => Number.isFinite(v(k))) && v('east') > v('west') && v('north') > v('south')
    ? [v('west'), v('south'), v('east'), v('north')]
    : null;
  return { seed, edges, bounds, startedAt: 0, finishedAt: 1 };
}

/** Every point the telemetry mentions, projected — used for containment checks. */
const allSamples = (geo) => geo.rays.flatMap((r) => r.samples);

/* ------------------------------------------------------- 1. absent telemetry -- */

section('absent / unusable telemetry renders as a fact, not a default');
for (const [input, label] of [[null, 'null'], [undefined, 'undefined'], ['nope', 'a string']]) {
  const g = buildProbeGeometry(input);
  check(g.ok === false && g.reason === 'no-telemetry' && g.scene === null && g.rect === null,
    `${label} → ok:false reason:no-telemetry, no scene, no rect`, `reason=${g.reason}`);
}
{
  const g = buildProbeGeometry({ edges: {}, seed: { lng: NaN, lat: 3 } });
  check(g.ok === false && g.reason === 'no-seed' && g.rect === null,
    'non-finite seed → reason:no-seed', `reason=${g.reason}`);
  check(g.unresolved.length === 4, 'all four edges reported unresolved when there is nothing to read');
}
{
  // Seed only, nothing probed: there is no extent to draw and none is invented.
  const g = buildProbeGeometry({ seed: { lng: -89, lat: 44 }, edges: {} });
  check(g.ok === false && g.reason === 'degenerate-extent' && g.scene === null,
    'seed with no samples and no edges → reason:degenerate-extent', `reason=${g.reason}`);
}

/* ---------------------------------------------------------- 2. centred seed -- */

section('centred seed — the case where a cross-section IS the bounding box');

const EXTENT = { west: -92, south: 42.5, east: -86, north: 47 };
const CENTER_LNG = (EXTENT.west + EXTENT.east) / 2;
// Mercator-space centre latitude: the rectangle is drawn in Mercator, so this is
// the latitude that actually sits halfway down the drawn box.
const CENTER_LAT = invMercY((mercY(EXTENT.north) + mercY(EXTENT.south)) / 2);

{
  const g = buildProbeGeometry(simulateProbe({ lng: CENTER_LNG, lat: CENTER_LAT }, EXTENT));
  check(g.ok === true && g.reason === null, 'ok:true with all four edges resolved');
  check(g.unresolved.length === 0, 'nothing unresolved');
  check(g.sampleCount > 40, 'every sample retained', `${g.sampleCount} samples`);

  const tol = 0.01; // half the bisection floor (0.5° / 2^10 ≈ 0.0005°) with room to spare
  check(near(g.rect.west, EXTENT.west, tol) && near(g.rect.east, EXTENT.east, tol)
     && near(g.rect.south, EXTENT.south, tol) && near(g.rect.north, EXTENT.north, tol),
    'resolved rect matches the synthetic extent',
    `${g.rect.west.toFixed(4)},${g.rect.south.toFixed(4)},${g.rect.east.toFixed(4)},${g.rect.north.toFixed(4)}`);

  check(near(g.offset.fracX, 0, 1e-3) && near(g.offset.fracY, 0, 1e-3),
    'seed offset ≈ 0 in both axes',
    `fracX=${g.offset.fracX.toExponential(2)} fracY=${g.offset.fracY.toExponential(2)}`);
  check(g.offset.dMeters < 100, 'seed offset ≈ 0 in metres too', `${g.offset.dMeters.toFixed(1)} m`);
  check(near(g.seed.x, g.center.x, 1e-3) && near(g.seed.y, g.center.y, 1e-3),
    'seed and centre land on the same drawing coordinate');

  // The load-bearing projection invariant: a canvas drawn at `scene.aspect`
  // renders the rectangle at exactly `rect.aspect` — the number the app prints
  // the material at. If these two ever disagree, the diagnostic is lying about
  // the shape of the very thing it exists to check.
  const canvasW = 1000;
  const canvasH = canvasW / g.scene.aspect;
  const drawnAspect = ((g.rect.x1 - g.rect.x0) * canvasW) / ((g.rect.y1 - g.rect.y0) * canvasH);
  check(near(drawnAspect, g.rect.aspect, 1e-9),
    'rect drawn at scene.aspect reproduces rect.aspect',
    `drawn=${drawnAspect.toFixed(6)} rect=${g.rect.aspect.toFixed(6)}`);
  check(near(g.rect.aspect, mercAspect([g.rect.west, g.rect.south, g.rect.east, g.rect.north]), 1e-12),
    'rect.aspect is mercAspect — the same convention the app prints at');

  // Padding is relative, so the rect occupies the same share of the scene
  // whatever the map's size. 1 / (1 + 2·margin) along the longer axis.
  const longFrac = Math.max(g.rect.x1 - g.rect.x0, g.rect.y1 - g.rect.y0);
  check(near(longFrac, 1 / (1 + 2 * DEFAULT_MARGIN), 1e-9),
    'scene padding is a fixed fraction of the extent, not an absolute degree count',
    `longest side = ${(longFrac * 100).toFixed(1)}% of scene`);

  check(g.rays.length === 4 && g.rays.map((r) => r.key).join() === EDGE_KEYS.join(),
    'four rays, in probe order W,E,S,N');
  check(g.rays.every((r) => r.resolved && r.edge && near(r.edge.x, r.tip.x, 1e-12)),
    'every ray terminates at its resolved edge');
  check(g.rays.every((r) => Number.isFinite(r.bracket.lastInsideDeg) && Number.isFinite(r.bracket.firstOutsideDeg)),
    'expansion bracket retained on every edge',
    g.rays.map((r) => `${r.key}:${r.bracket.lastInsideDeg}→${r.bracket.firstOutsideDeg}`).join(' '));

  const inside = allSamples(g).filter((s) => s.inside === true);
  check(inside.length > 0 && inside.every((s) => !s.clipped),
    'inside samples are all on-scene', `${inside.length} inside`);
  const clipped = allSamples(g).filter((s) => s.clipped);
  check(clipped.length > 0 && clipped.every((s) => s.inside === false),
    'far outside samples are clipped to the border, never dropped',
    `${clipped.length} clipped of ${g.sampleCount}`);
  check(allSamples(g).every((s) => s.x >= 0 && s.x <= 1 && s.y >= 0 && s.y <= 1),
    'every projected sample is inside the unit square');
}

/* ------------------------------------------------------ 3. off-centre seed --- */

section('strongly off-centre seed — the artefact the panel exists to show');

{
  // Seed 0.25° from the west edge of a 6° span: 91.7% of the way to the edge.
  const seed = { lng: EXTENT.west + 0.25, lat: EXTENT.south + 0.3 };
  const g = buildProbeGeometry(simulateProbe(seed, EXTENT));
  check(g.ok === true, 'ok:true — an off-centre seed still resolves four edges');

  check(g.offset.fracX < -0.8, 'fracX strongly negative (seed west of centre)',
    `fracX=${g.offset.fracX.toFixed(3)}`);
  check(g.offset.fracY < -0.7, 'fracY strongly negative (seed south of centre)',
    `fracY=${g.offset.fracY.toFixed(3)}`);
  // The fractions must agree in SIGN with the degree offsets beside them —
  // +x east, +y north — even though drawing-space y runs the other way.
  check(Math.sign(g.offset.fracX) === Math.sign(g.offset.dLng)
     && Math.sign(g.offset.fracY) === Math.sign(g.offset.dLat),
    'offset fractions are geographic (+east/+north), matching dLng/dLat');
  check(g.offset.dMeters > 100000, 'offset reported in ground metres too',
    `${(g.offset.dMeters / 1000).toFixed(1)} km`);
  check(g.seed.x < g.center.x && g.seed.y > g.center.y,
    'in drawing space the seed is left of and BELOW centre (y grows southward)',
    `seed=(${g.seed.x.toFixed(3)},${g.seed.y.toFixed(3)}) centre=(${g.center.x.toFixed(3)},${g.center.y.toFixed(3)})`);

  // The bounds are still right here — the synthetic map is a true rectangle, so
  // a cross-section through ANY interior point finds the same four edges. What
  // changes is how much the rays sampled: with the seed near a corner the west
  // and south rays are stubs and the east and north rays do all the work. That
  // asymmetry, not a wrong number, is what the drawing surfaces.
  const len = Object.fromEntries(g.rays.map((r) => [r.key, Math.hypot(r.tip.x - g.seed.x, r.tip.y - g.seed.y)]));
  check(len.east > len.west * 5, 'east ray is far longer than west',
    `east=${len.east.toFixed(3)} west=${len.west.toFixed(3)}`);
  check(len.north > len.south * 5, 'north ray is far longer than south',
    `north=${len.north.toFixed(3)} south=${len.south.toFixed(3)}`);

  // Scale independence — the "map-agnostic" requirement, as a number. The same
  // geometry shrunk by 100× (a ~6 km campus rather than a 6° state) must report
  // the same fractions, because every scale in the helper is derived from the
  // telemetry's own extent and none from a constant.
  // Shrunk about the state's OWN centre, not about (0,0): Mercator stretches
  // latitude with |lat|, so relocating the box to the equator would change its
  // aspect for real reasons and the comparison would be meaningless.
  const scaled = (shrink) => {
    const hw = (EXTENT.east - EXTENT.west) / 2 * shrink;
    const hh = (EXTENT.north - EXTENT.south) / 2 * shrink;
    const box = {
      west: CENTER_LNG - hw, east: CENTER_LNG + hw,
      south: CENTER_LAT - hh, north: CENTER_LAT + hh,
    };
    const seedAt = { lng: box.west + 0.25 * shrink, lat: box.south + 0.3 * shrink };
    return buildProbeGeometry(simulateProbe(seedAt, box));
  };

  const gc = scaled(1 / 100); // ~6 km across
  check(gc.ok === true, '6 km campus map resolves');
  check(near(gc.offset.fracX, g.offset.fracX, 0.05) && near(gc.offset.fracY, g.offset.fracY, 0.05),
    'a 6 km map reports the same offset fractions as a 6° map',
    `campus fracX=${gc.offset.fracX.toFixed(3)} vs state ${g.offset.fracX.toFixed(3)}`);
  check(near(gc.scene.aspect, g.scene.aspect, 0.01),
    'and the same scene aspect', `${gc.scene.aspect.toFixed(4)} vs ${g.scene.aspect.toFixed(4)}`);

  // Room scale (~30 m) is BELOW what the probe itself can resolve: expansion
  // starts at 0.5° and bisects 10 times, so the finest edge it can report is
  // 0.5 / 2^10 ≈ 0.0005° ≈ 54 m. Every sample reads outside and the search
  // collapses onto the seed. The helper must report that collapse as-is — a
  // near-zero-span rect centred on the seed — rather than rescale or reject it,
  // because the collapse IS the finding: the probe, not the drawing, is the
  // thing that cannot see a room.
  const gr = scaled(1 / 20000); // ~30 m across
  check(gr.ok === true, 'room-scale telemetry still produces a drawable result');
  const roomSpan = gr.rect.east - gr.rect.west;
  check(roomSpan > 0 && roomSpan < 0.002,
    'room-scale rect collapses to the probe\'s own resolution floor, undisguised',
    `span=${roomSpan.toExponential(2)}° vs true ${((EXTENT.east - EXTENT.west) / 20000).toExponential(2)}°`);
  check(near(gr.offset.fracX, 0, 0.05) && near(gr.offset.fracY, 0, 0.05),
    'and reports the seed at that collapsed centre — no invented offset',
    `fracX=${gr.offset.fracX.toFixed(3)}`);
  check(gr.rays.every((r) => r.samples.every((p) => p.inside !== true)),
    'no sample read inside: visibly, the probe never found the map');
}

/* ------------------------------------------------- 4. an edge that failed ---- */

section('an edge that never resolved is drawn as incomplete, never guessed');

{
  // Ocean case in miniature: the eastward probe times out mid-search.
  const seed = { lng: CENTER_LNG, lat: CENTER_LAT };
  const g = buildProbeGeometry(simulateProbe(seed, EXTENT, { east: { failAt: 2 } }));

  check(g.ok === false && g.reason === 'unresolved-edges', 'ok:false reason:unresolved-edges',
    `reason=${g.reason}`);
  check(g.unresolved.join() === 'east', 'exactly the failed edge is listed', g.unresolved.join());
  check(g.rect === null && g.center === null && g.offset === null,
    'no rect, no centre, no offset — nothing is substituted for the missing edge');
  check(g.scene !== null && Number.isFinite(g.scene.aspect),
    'a scene is still built from what DID resolve, so the other three rays draw');

  const east = g.rays.find((r) => r.key === 'east');
  check(east.resolved === false && east.edge === null && east.value === null,
    'east ray carries no edge');
  check(east.reason === 'probe-failed', 'east ray carries WHY it failed', east.reason);
  check(east.samples.some((s) => s.inside === null),
    'the sample that answered nothing is retained as inside:null');
  check(east.samples.length === 2, 'east stopped at the failing sample', `${east.samples.length} samples`);
  check(east.tip.x > g.seed.x && east.tip.x <= 1,
    'east ray still terminates at the farthest point it reached, marked unresolved',
    `tip.x=${east.tip.x.toFixed(3)}`);

  check(g.rays.filter((r) => r.resolved).length === 3, 'the other three edges still resolved');
  check(g.rays.filter((r) => r.resolved).every((r) => r.edge && Number.isFinite(r.value)),
    'and still carry their coordinates');
}

{
  // "Never got outside within 200°" — an unbounded / always-reachable map.
  const seed = { lng: 0, lat: 0 };
  const g = buildProbeGeometry(simulateProbe(seed, { west: -1, south: -1, east: 1, north: 1 },
    { north: { limitDeg: Infinity } }));
  const north = g.rays.find((r) => r.key === 'north');
  check(g.ok === false && g.unresolved.join() === 'north', 'never-outside edge is unresolved',
    `unresolved=${g.unresolved.join()}`);
  check(north.reason === 'no-outside-within-200deg', 'and says so', north.reason);
  check(north.bracket.lastInsideDeg > 100 && north.bracket.firstOutsideDeg === null,
    'its bracket shows expansion ran out with no outside bound',
    `lastInside=${north.bracket.lastInsideDeg} firstOutside=${north.bracket.firstOutsideDeg}`);
}

{
  // A probe that dies during BISECTION still yields a coordinate — findEdge
  // breaks out and returns the current midpoint. That must read as resolved,
  // with the abort recorded, or the panel would over-report failure.
  const seed = { lng: CENTER_LNG, lat: CENTER_LAT };
  const g = buildProbeGeometry(simulateProbe(seed, EXTENT, { south: { failAt: 6 } }));
  const south = g.rays.find((r) => r.key === 'south');
  check(south.resolved === true && south.bisectAborted === true,
    'bisection abort → resolved edge, flagged',
    `resolved=${south.resolved} aborted=${south.bisectAborted}`);
  check(g.ok === true, 'and the rect is still built');
}

/* ------------------------------------------------------------------ result -- */

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
