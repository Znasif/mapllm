/**
 * The printed paper map of Audiom map 885 → Audiom avatar positions.
 *
 * audiom.html shows ONE map (885, the Wisconsin map on staging) and a camera
 * pointer for a printed copy of it. The camio-pointer library reports the
 * fingertip as `(u, v)` on the registered sheet, (0, 0) = top-left corner mark,
 * (1, 1) = bottom-right; this module turns that into the `[lng, lat]` that
 * `channel.moveAvatar` takes, through `uvToLngLat` (audiom.js: linear lng,
 * Web-Mercator lat — what a print of Audiom's map depicts).
 *
 * PLATFORM-FREE (no DOM, no import.meta.env) so it runs in Node:
 * `scripts/test_paper_map.mjs`.
 */
import { lngLatToUv, uvToLngLat } from '../audiom.js';

/** The Audiom map the page embeds when VITE_AUDIOM_DEFAULT_MAP is not set. */
export const PAPER_MAP_ID = '885';

/**
 * [west, south, east, north] of map 885: the layer bbox Audiom logs for it on
 * staging. It MUST equal the printed frame's corners — the four corner marks the
 * user registers are mapped exactly onto these four corners. Re-print or change
 * this (or calibrate with `?bbox=w,s,e,n`) if they differ.
 */
export const MAP_885_BBOX = Object.freeze([-92.89, 42.49, -86.80, 47.08]);

/**
 * `?bbox=w,s,e,n` → a bbox, or null when absent or malformed (four finite
 * numbers with w < e and s < n).
 *
 * @param {string|null|undefined} value
 * @returns {number[]|null}
 */
export function parseBboxParam(value) {
  if (!value) return null;
  const n = String(value).split(',').map((s) => Number(s.trim()));
  if (n.length !== 4 || !n.every(Number.isFinite)) return null;
  const [w, s, e, nn] = n;
  return w < e && s < nn ? n : null;
}

/**
 * The bbox the page uses: `?bbox=` from a location search string, else 885's.
 *
 * @param {string} [search] e.g. `window.location.search`
 * @returns {number[]}
 */
export function bboxFromSearch(search = '') {
  let param = null;
  try { param = new URLSearchParams(search).get('bbox'); } catch { /* noop */ }
  return parseBboxParam(param) || MAP_885_BBOX;
}

/**
 * A camio-pointer 'point' event (or any `{ u, v }`) → `[lng, lat]` for
 * `moveAvatar`, or null when (u, v) is not finite.
 *
 * @param {{u: number, v: number}} point
 * @param {number[]} [bbox] defaults to MAP_885_BBOX
 * @returns {number[]|null}
 */
export function pointToLngLat(point, bbox = MAP_885_BBOX) {
  const u = point?.u;
  const v = point?.v;
  if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
  const { lng, lat } = uvToLngLat(u, v, bbox);
  return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
}

/**
 * The inverse of `pointToLngLat`: an avatar `[lng, lat]` (or `{ lng, lat }`)
 * → `{ u, v }` on the printed sheet (lngLatToUv in audiom.js), or null when not
 * finite. Not clamped: a position off the print gives u or v outside [0, 1].
 * The camera overlay draws Audiom's avatar on the rectified sheet with it.
 *
 * @param {number[]|{lng: number, lat: number}} position
 * @param {number[]} [bbox] defaults to MAP_885_BBOX
 * @returns {{u: number, v: number}|null}
 */
export function lngLatToPoint(position, bbox = MAP_885_BBOX) {
  const lng = Array.isArray(position) ? position[0] : position?.lng;
  const lat = Array.isArray(position) ? position[1] : position?.lat;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  const { u, v } = lngLatToUv(lng, lat, bbox);
  return Number.isFinite(u) && Number.isFinite(v) ? { u, v } : null;
}
