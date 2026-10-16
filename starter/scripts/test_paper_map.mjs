#!/usr/bin/env node
/**
 * Printed map 885 → avatar positions (src/lib/paperMap.js).
 *
 *   node starter/scripts/test_paper_map.mjs
 *
 * FULLY OFFLINE. The camera pointer's 'point' events carry (u, v) on the
 * registered sheet; audiom.html sends `pointToLngLat(point, BBOX)` to
 * `moveAvatar`. Checked here: the four corners land on the bbox corners, the
 * default bbox is the map-885 constant, and `?bbox=` overrides it only when
 * well-formed.
 */

import { lngLatToUv, uvToLngLat, mercY } from '../src/audiom.js';
import {
  MAP_885_BBOX, PAPER_MAP_ID, bboxFromSearch, lngLatToPoint, parseBboxParam, pointToLngLat,
} from '../src/lib/paperMap.js';

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const nearPos = (p, q) => !!p && near(p[0], q[0]) && near(p[1], q[1]);

const [W, S, E, N] = MAP_885_BBOX;

console.log('\n— constants');
check(PAPER_MAP_ID === '885', 'the page map is 885');
check(MAP_885_BBOX.join(',') === '-92.89,42.49,-86.8,47.08', 'map 885 bbox is the staging layer bbox', MAP_885_BBOX.join(','));
check(Object.isFrozen(MAP_885_BBOX), 'the bbox constant is frozen');

console.log('\n— uvToLngLat corners = bbox corners');
const corners = [
  [0, 0, [W, N], 'top-left'],
  [1, 0, [E, N], 'top-right'],
  [1, 1, [E, S], 'bottom-right'],
  [0, 1, [W, S], 'bottom-left'],
];
for (const [u, v, want, name] of corners) {
  const { lng, lat } = uvToLngLat(u, v, MAP_885_BBOX);
  check(near(lng, want[0]) && near(lat, want[1]), `uvToLngLat ${name}`, `${lng},${lat}`);
  check(nearPos(pointToLngLat({ u, v }), want), `pointToLngLat ${name} (default bbox)`);
}

console.log('\n— the point path uses the constant');
const p = { u: 0.3, v: 0.6, col: 35, row: 50 };
const viaLib = pointToLngLat(p);
const viaConst = uvToLngLat(p.u, p.v, MAP_885_BBOX);
check(nearPos(viaLib, [viaConst.lng, viaConst.lat]), 'a point event maps through MAP_885_BBOX');
check(nearPos(pointToLngLat(p, bboxFromSearch('')), viaLib), 'no ?bbox= → the page bbox is MAP_885_BBOX');
check(bboxFromSearch('?map=1') === MAP_885_BBOX, 'unrelated params keep the constant');
const mid = pointToLngLat({ u: 0.5, v: 0.5 });
check(near(mid[0], (W + E) / 2), 'centre lng is the linear midpoint');
check(near(mercY(mid[1]), (mercY(N) + mercY(S)) / 2), 'centre lat is the Mercator midpoint (not linear)',
  `${mid[1]} vs linear ${(N + S) / 2}`);
check(pointToLngLat({ u: NaN, v: 0 }) === null && pointToLngLat(null) === null, 'non-finite input → null');

console.log('\n— ?bbox= override');
const custom = bboxFromSearch('?bbox=-90,43,-88,45');
check(custom.join(',') === '-90,43,-88,45', 'well-formed ?bbox= is used', custom.join(','));
check(nearPos(pointToLngLat({ u: 1, v: 1 }, custom), [-88, 43]), 'and its corners map through');
check(parseBboxParam('1,2,3') === null, 'three numbers rejected');
check(parseBboxParam('-88,43,-90,45') === null, 'west ≥ east rejected');
check(parseBboxParam('a,b,c,d') === null, 'non-numbers rejected');
check(bboxFromSearch('?bbox=junk') === MAP_885_BBOX, 'malformed ?bbox= falls back to the constant');

console.log('\n— lngLatToUv / lngLatToPoint: the exact inverse (camera overlay avatar)');
for (const bbox of [MAP_885_BBOX, custom, [-180, -80, 180, 80]]) {
  let worst = 0;
  for (let i = 0; i <= 10; i += 1) {
    for (let j = 0; j <= 10; j += 1) {
      const u = i / 10, v = j / 10;
      const { lng, lat } = uvToLngLat(u, v, bbox);
      const back = lngLatToUv(lng, lat, bbox);
      worst = Math.max(worst, Math.abs(back.u - u), Math.abs(back.v - v));
    }
  }
  check(worst < 1e-9, `uv → lng/lat → uv round-trips on ${bbox.join(',')}`, `max err ${worst.toExponential(2)}`);
}
for (const [u, v, want, name] of corners) {
  const q = lngLatToPoint(want);
  check(!!q && near(q.u, u) && near(q.v, v), `lngLatToPoint ${name} corner`, q && `${q.u},${q.v}`);
}
const there = pointToLngLat({ u: 0.25, v: 0.7 });
const backPt = lngLatToPoint({ lng: there[0], lat: there[1] });
check(!!backPt && near(backPt.u, 0.25) && near(backPt.v, 0.7), 'lngLatToPoint accepts { lng, lat } and inverts pointToLngLat');
const midLatLinear = lngLatToPoint([(W + E) / 2, (N + S) / 2]);
check(midLatLinear.v > 0.5, 'the linear-mid latitude is below the sheet centre (Mercator)', `${midLatLinear.v}`);
const off = lngLatToPoint([E + 1, N + 1]);
check(off.u > 1 && off.v < 0, 'off-print positions are not clamped');
check(lngLatToPoint(null) === null && lngLatToPoint([NaN, 1]) === null, 'non-finite input → null');

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
