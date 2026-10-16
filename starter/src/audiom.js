/**
 * Audiom integration helpers for the generalized tactile explorer.
 *
 * Not beholden to OSM: loads any saved Audiom map by id and maps a pre-made
 * physical tactile material onto it via four corners. See audiom-tactile-guide.md.
 */

// ---- config (works with the existing .env; VITE_AUDIOM_ORIGIN is optional) ----

/**
 * Read one `import.meta.env` key without assuming a bundler is present.
 *
 * DEBT DISCHARGED (plan §5.1, "Known debts"): this module used to dereference
 * `import.meta.env` at *module scope*. In Node `import.meta` exists but
 * `import.meta.env` does not, so the very first statement of the file threw
 * `TypeError: Cannot read properties of undefined` and nothing outside Vite
 * could import it — which is why `lib/adapters/audiomWorldAdapter.js` carried
 * its own copies of `uvToLngLat` / `uvToEastNorth` instead of importing them.
 *
 * The read is now inside a function, and the *shape* Vite statically replaces
 * (`import.meta.env.VITE_FOO`, spelled out literally) is preserved at each call
 * site — `envValue(() => import.meta.env.VITE_X)`. Under Vite the thunk body is
 * rewritten to a literal before it ever runs; under Node it throws on the first
 * dereference and the `catch` supplies `''`. So the browser build is byte-for-
 * byte what it was, and `node -e "import('./src/audiom.js')"` now works.
 *
 * @param {() => unknown} read A thunk containing exactly one `import.meta.env.X`.
 * @returns {string} The trimmed value, or `''` when it is absent or unreadable.
 */
function envValue(read) {
  try {
    const v = read();
    return typeof v === 'string' ? v.trim() : '';
  } catch {
    return '';
  }
}

const EMBED_URL = envValue(() => import.meta.env.VITE_AUDIOM_EMBED_URL);
export const AUDIOM_ORIGIN = (() => {
  const explicit = envValue(() => import.meta.env.VITE_AUDIOM_ORIGIN);
  if (explicit) return explicit.replace(/\/$/, '');
  try { return new URL(EMBED_URL).origin; } catch { /* noop */ }
  // Production, not staging. Verified 2026-08-13: both hosts answer in <0.6s and
  // both accept the same full-access key, but staging is a dyno that has been
  // failing to finish its client-side load, while audiom.net completes an OSM
  // load in ~15s.
  return 'https://www.audiom.net';
})();
// Prefer the full-access key: it resolves pre-configured embeds (e.g. /embed/570,
// the human skeleton). The standard key only works for dynamic `sources`.
export const AUDIOM_KEY =
  envValue(() => import.meta.env.VITE_AUDIOM_FULL_ACCESS_KEY) ||
  envValue(() => import.meta.env.VITE_AUDIOM_KEY);

// HARD-CODED DEFAULT MAP (Pages): when set, audiom.html opens this map on load
// with no Load click. Anything `parseAudiomId` accepts: "885", "/maps/885", a
// slug URL. Its host is ignored — the embed host is AUDIOM_ORIGIN, so pair it
// with VITE_AUDIOM_ORIGIN when the map lives on staging. Empty = old behaviour.
export const AUDIOM_DEFAULT_MAP = envValue(() => import.meta.env.VITE_AUDIOM_DEFAULT_MAP);

// ---- 1. parse a map id from a pasted Audiom URL or bare id ----
//
// ⚠️ THE `/d/` ROUTE IS GONE. Verified by HTTP 2026-08-13 on BOTH hosts:
//
//     /maps/885      200        /maps/d/885    404
//     /embed/885     200        /embed/d/885   404
//
// This module used to carry three parsers and a two-namespace model: a
// "pre-configured embed id" at `/embed/<id>` versus a "map-editor id" at
// `/maps/d/<id>`, which embedded through `/embed/d/<id>`. That distinction no
// longer exists in the URL, so the three collapse into one. `buildEmbedSrc`
// lost its `embedId` branch with them.
//
// Accepted, all resolving to the same id:
//   "885"                                          bare
//   .../maps/885            .../embed/885          numeric
//   .../maps/wisconsin-...-2-885                   slug + trailing id
//   .../embed/wisconsin-...-2-885
//   .../map/885                                    older viewer path
//   .../maps/d/885          .../embed/d/885        LEGACY, dead server-side,
//                                                  still parsed so an old
//                                                  bookmark degrades to a
//                                                  working embed
export function parseAudiomId(input) {
  const s = String(input || '').trim();
  if (/^\d+$/.test(s)) return s;
  // The id is the trailing number: a slug like `...-quaternary-map-2-885` has
  // digits inside it, so anchor on the end of the path segment, not the first
  // number found.
  const m = s.match(/\/(?:maps|embed|map)\/(?:d\/)?(?:[A-Za-z0-9-]*?-)?(\d+)(?:[/?#]|$)/);
  return m ? m[1] : null;
}

/** Largest place extent loaded as a bbox; bigger ones (a city) load around their centre. */
export const MAX_PLACE_BBOX_METERS = 3000;

/**
 * A geocoded place → the same view shape `parseAudiomView` returns, in Audiom's
 * AOI contract. A point (an address) gets the embed's default `hull:360`. An
 * area small enough to load whole (a park, a campus) gets `extent=bbox` over
 * its corners; the centre goes first because Audiom starts the avatar on the
 * first anchor. Larger areas fall back to their centre.
 *
 * @param {{lng: number, lat: number}} point
 * @param {number[]|null} [bbox] [west, south, east, north]
 */
export function viewForPlace(point, bbox = null) {
  const c = `${point.lng},${point.lat}`;
  const out = { centerLng: point.lng, centerLat: point.lat, anchors: c, extent: 'hull:360' };
  if (!bbox) return out;
  const [w, s, e, n] = bbox;
  const R = 6371008.8, rad = Math.PI / 180;
  const dx = (e - w) * rad * Math.cos(((s + n) / 2) * rad) * R;
  const dy = (n - s) * rad * R;
  if (Math.hypot(dx, dy) > MAX_PLACE_BBOX_METERS) return out;
  return { ...out, anchors: `${c};${w},${s};${e},${n}`, extent: 'bbox' };
}

// Pull center/zoom out of a pasted URL if present (e.g. a /map?center=..&zoom=.. link).
export function parseAudiomView(input) {
  const out = {};
  try {
    const u = new URL(String(input), window.location.origin);
    const center = u.searchParams.get('center');
    if (center) {
      const [lng, lat] = center.replace(/['"]/g, '').split(',').map(Number);
      if (Number.isFinite(lng) && Number.isFinite(lat)) { out.centerLng = lng; out.centerLat = lat; }
    }
    const zoom = Number(u.searchParams.get('zoom'));
    if (Number.isFinite(zoom) && zoom > 0) out.zoom = zoom;
    // Audiom's area-of-interest contract (Audiom-Front-End src/lib/aoiUrl.ts):
    // `anchors=lng,lat;lng,lat…` + `extent=hull:<m>|bbox[:<m>]`. An OSM source
    // needs an area, so a bare `center` is sent as a one-anchor hull at the
    // embed's own default (hull:360) — some deploys no longer derive it.
    const anchors = u.searchParams.get('anchors');
    const extent = u.searchParams.get('extent');
    if (anchors) {
      out.anchors = anchors;
      const [lng, lat] = anchors.split(';')[0].split(',').map(Number);
      if (out.centerLng == null && Number.isFinite(lng) && Number.isFinite(lat)) { out.centerLng = lng; out.centerLat = lat; }
    } else if (out.centerLng != null) {
      out.anchors = `${out.centerLng},${out.centerLat}`;
    }
    if (out.anchors) out.extent = extent || 'hull:360';
  } catch { /* not a URL */ }
  return out;
}

// Predefined embeddable sources. Anything other than "osm" fulfils the
// "not beholden to OSM" goal. A direct GeoJSON URL also works as a source.
export const PREDEFINED_SOURCES = [
  'osm', 'TDEI', 'covid_daily', 'goodmaps', 'coon', 'IMDF', 'presidential_election',
];

// ---- 2. build the embed src ----
//
// ⚠️ UNVERIFIED IN A BROWSER, AND THE PRIOR FINDING SAID THE OPPOSITE.
//
// This block used to read: "IMPORTANT (verified against staging): the embed
// loads DATA from `sources`, not from a saved-map id. `/embed/885` sends no
// sources -> 'Map not ready' forever." That was measured against the OLD
// staging deployment, when a saved map embedded through `/embed/d/<id>`.
//
// `/embed/d/<id>` now 404s on both hosts, so `/embed/<id>` is the ONLY route a
// saved map has. Either the backend changed to serve a saved map's data on that
// route, or saved maps still need `sources` and the id alone will hang on
// "Map not ready" exactly as before. HTTP alone cannot tell these apart: with a
// key, `/embed/885` returns 200 and a clean `pageProps` — whether the map DATA
// then arrives is client-side and needs a real browser.
//
// If it hangs, the fallback is unchanged: drive `/embed/dynamic` with an
// explicit source (a `PREDEFINED_SOURCES` id or a direct GeoJSON URL).
// `center`+`zoom` pin the view to the printed material.
export function buildEmbedSrc({ mapId, sources, center, zoom, anchors, extent } = {}) {
  const p = new URLSearchParams();
  if (AUDIOM_KEY) p.set('apiKey', AUDIOM_KEY);
  p.set('allowedOrigins', window.location.origin); // required to enable postMessage
  p.set('showVisualMap', 'true');
  p.set('showHeading', 'false');
  // A saved map (/embed/<id>) carries its own data + view, so we don't pass
  // sources/center/zoom. A dynamic source needs them.
  if (!mapId) {
    if (sources) p.set('sources', sources);
    if (center && Number.isFinite(center.lng) && Number.isFinite(center.lat)) {
      p.set('center', `${center.lng.toFixed(6)},${center.lat.toFixed(6)}`);
    }
    if (zoom != null && Number.isFinite(zoom)) p.set('zoom', Number(zoom).toFixed(3));
    if (anchors) { p.set('anchors', anchors); p.set('extent', extent || 'hull:360'); }
  }
  const path = mapId ? `/embed/${mapId}` : '/embed/dynamic';
  return `${AUDIOM_ORIGIN}${path}?${p.toString()}`;
}

// Extract a `sources`/`source` value from a pasted Audiom /map?… URL, if present.
export function parseAudiomSources(input) {
  try {
    const u = new URL(String(input), window.location.origin);
    return u.searchParams.get('sources') || u.searchParams.get('source') || '';
  } catch { return ''; }
}

// ---- 3. Web-Mercator helpers ----
// Exported because they are the single source of truth for the (u,v) ↔ map
// mapping: `lib/adapters/audiomWorldAdapter.js` imports them rather than
// re-deriving them, so a material calibrated through `uvToLngLat` and queried
// through the adapter cannot drift apart. Every expression below is byte-for-
// byte the one this file has always used — `(lat * Math.PI) / 180` and
// `(… * 180) / Math.PI` are NOT interchangeable with `lat * DEG` and `… / DEG`
// at the last bit, and the adapter's deleted copies used the latter spelling.
const TILE = 512;

/** Web-Mercator is undefined at the poles; this is where the projection is cut. */
export const MAX_MERC_LAT = 85.05112878;

/** @param {number} lat @returns {number} `lat` clamped into the Mercator domain. */
export const clampMercLat = (lat) => Math.min(MAX_MERC_LAT, Math.max(-MAX_MERC_LAT, lat));

export const mercX = (lng) => (lng + 180) / 360;
export const mercY = (lat) => {
  // The clamp is a domain guard, not a change of numbers: it is the identity on
  // |lat| <= MAX_MERC_LAT, which is every latitude Audiom can render, and it
  // replaces the `Infinity` this returned at |lat| = 90.
  const s = Math.sin((clampMercLat(lat) * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};
export const invMercX = (x) => x * 360 - 180;
export const invMercY = (y) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;

// ---- 4. center+zoom+pixel-size -> geographic bbox [minLng,minLat,maxLng,maxLat] ----
// width/height are the iframe pixel size; use the physical material's aspect ratio.
export function viewToBbox({ centerLng, centerLat, zoom, width, height }) {
  const scale = TILE * 2 ** zoom;
  const cx = mercX(centerLng), cy = mercY(centerLat);
  const hx = width / 2 / scale, hy = height / 2 / scale;
  return [
    invMercX(cx - hx),   // minLng (left)
    invMercY(cy + hy),   // minLat (bottom -> larger mercY)
    invMercX(cx + hx),   // maxLng (right)
    invMercY(cy - hy),   // maxLat (top    -> smaller mercY)
  ];
}

// ---- Window model -------------------------------------------------------
// The material is printed at the aspect ratio of the FULL map bbox, so every
// window (whole map, or any sub-region at any scale) keeps that same aspect and
// the four touched corners always map to the four bbox corners.
//
// Aspect is measured in Web-Mercator, because that is what Audiom renders and
// therefore what a print of it depicts — not in ground metres.

export function bboxToMerc(bbox) {
  const [w, s, e, n] = bbox;
  return { x0: mercX(w), x1: mercX(e), y0: mercY(n), y1: mercY(s) }; // y0 = top
}

/** Aspect (width/height) of a bbox as rendered — this is the aspect to print at. */
export function mercAspect(bbox) {
  const m = bboxToMerc(bbox);
  return (m.x1 - m.x0) / (m.y1 - m.y0);
}

/**
 * A sub-window of `bboxFull` at `fraction` of its size (1 = whole map),
 * centred on {centerLng, centerLat} and clamped to stay inside the map.
 * Aspect is inherited from bboxFull by construction.
 */
export function subWindow(bboxFull, { fraction = 1, centerLng, centerLat } = {}) {
  const m = bboxToMerc(bboxFull);
  const f = Math.max(0.001, Math.min(1, fraction));
  const w = (m.x1 - m.x0) * f;
  const h = (m.y1 - m.y0) * f;
  let cx = Number.isFinite(centerLng) ? mercX(centerLng) : (m.x0 + m.x1) / 2;
  let cy = Number.isFinite(centerLat) ? mercY(centerLat) : (m.y0 + m.y1) / 2;
  cx = Math.min(Math.max(cx, m.x0 + w / 2), m.x1 - w / 2);
  cy = Math.min(Math.max(cy, m.y0 + h / 2), m.y1 - h / 2);
  return [
    invMercX(cx - w / 2), invMercY(cy + h / 2),
    invMercX(cx + w / 2), invMercY(cy - h / 2),
  ];
}

/** Zoom that renders a bbox at `widthPx` pixels wide (for the debug view). */
export function zoomForBbox(bbox, widthPx) {
  const m = bboxToMerc(bbox);
  return Math.max(1, Math.min(22, Math.log2(widthPx / (TILE * (m.x1 - m.x0)))));
}

// Zoom that makes `spanMeters` of ground fill `widthPx` pixels at this latitude.
// Inverse of viewToBbox, so the two stay consistent (both Web-Mercator).
export function zoomForSpan({ centerLat, spanMeters, widthPx }) {
  const R = 6378137; // WGS84 equatorial radius
  const worldMetres = 2 * Math.PI * R * Math.cos((centerLat * Math.PI) / 180);
  const z = Math.log2((worldMetres * widthPx) / (TILE * spanMeters));
  return Math.max(1, Math.min(22, z));
}

// Approx span in metres of a bbox (used to derive a step-matched deadband).
export function bboxSpanMeters(bbox) {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const midLat = (minLat + maxLat) / 2;
  const w = Math.abs(maxLng - minLng) * 111320 * Math.cos((midLat * Math.PI) / 180);
  const h = Math.abs(maxLat - minLat) * 111320;
  return Math.max(w, h);
}

// ---- 5. normalized (u,v) in the 4 corners -> a point in the MAP'S space ----
// u=0 left, u=1 right ; v=0 top, v=1 bottom.
//
// Geographic map: interpolate lng linearly, lat in mercator-Y (matches a print of
// Audiom's Web-Mercator visual). Returns { lng, lat } for moveAvatar.
export function uvToLngLat(u, v, bbox) {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const lng = minLng + u * (maxLng - minLng);
  const yTop = mercY(maxLat), yBot = mercY(minLat);
  const lat = invMercY(yTop + v * (yBot - yTop));
  return { lng, lat };
}

/**
 * The exact inverse of `uvToLngLat`: a map point → (u, v) in the same frame
 * (u linear in lng, v linear in Mercator-Y; 0 = left/top, 1 = right/bottom).
 * Not clamped: a point outside the bbox gives u or v outside [0, 1].
 */
export function lngLatToUv(lng, lat, bbox) {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const u = (lng - minLng) / (maxLng - minLng);
  const yTop = mercY(maxLat), yBot = mercY(minLat);
  const v = (mercY(lat) - yTop) / (yBot - yTop);
  return { u, v };
}

// Spatial diagram / ENU map: East/North metres only, interpolate LINEARLY.
// enBox = { e0, n0, e1, n1 } from the map's announced dimensions.
// NOTE: moveAvatar is lat/lng-only per the docs, so a pure diagram needs Audiom
// to accept E/N — see §9 of the guide (open item).
export function uvToEastNorth(u, v, enBox) {
  const { e0, n0, e1, n1 } = enBox;
  return { e: e0 + u * (e1 - e0), n: n1 - v * (n1 - n0) };
}
