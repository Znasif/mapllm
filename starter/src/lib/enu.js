/**
 * ENU tangent-plane projection — a port of Audiom's `EnuProjection.ts`.
 *
 * Design: `docs/dotpad-camio-design.md` §3.3. Audiom's internal plane for a
 * geographic map is the ENU tangent plane at the map's SW corner (F12), and its
 * tactile pin lattice is regular in that plane. We do not know that origin, but
 * the ENU plane at OUR sync point is affine to Audiom's to within millimetres
 * over a city, which plain lng/lat is not (curvature error ≈ 0.4 pin after ten
 * pages at 40°N). So the DOT Pad mirror works in this plane.
 *
 * Ported from `explore/Audiom-Front-End` `src/modules/projections/EnuProjection.ts`
 * at `origin/master` 87121f55 (lines 17-177), including the 6-iteration `U`
 * adjustment in the inverse. Porting the algorithm is fine; Audiom itself is
 * never modified. Re-diff on upgrade.
 *
 * PLATFORM-FREE: no imports, no DOM. Exercised from Node by
 * `scripts/test_dotpad_viewport.mjs` and `scripts/test_dotpad_sync.mjs`.
 */

// WGS84 ellipsoid constants — identical to Audiom's.
export const WGS84_A = 6378137.0;
export const WGS84_F = 1 / 298.257223563;
export const WGS84_E2 = WGS84_F * (2 - WGS84_F);

const degToRad = (d) => (d * Math.PI) / 180.0;
const radToDeg = (r) => (r * 180.0) / Math.PI;

/** @returns {{X: number, Y: number, Z: number}} */
export function geodeticToEcef(lonDeg, latDeg, h = 0) {
  const lon = degToRad(lonDeg);
  const lat = degToRad(latDeg);
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  return {
    X: (N + h) * cosLat * Math.cos(lon),
    Y: (N + h) * cosLat * Math.sin(lon),
    Z: (N * (1 - WGS84_E2) + h) * sinLat,
  };
}

/** @returns {{lon: number, lat: number, h: number}} */
export function ecefToGeodetic(X, Y, Z) {
  const lon = Math.atan2(Y, X);
  const p = Math.hypot(X, Y);
  let lat = Math.atan2(Z, p * (1 - WGS84_E2));
  let latPrev = lat;
  for (let i = 0; i < 10; i++) {
    const sinLat = Math.sin(lat);
    const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
    const h = p / Math.cos(lat) - N;
    const newLat = Math.atan2(Z, p * (1 - WGS84_E2 * (N / (N + h))));
    if (Math.abs(newLat - latPrev) < 1e-14) { lat = newLat; break; }
    latPrev = lat;
    lat = newLat;
  }
  const sinLat = Math.sin(lat);
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  const h = p / Math.cos(lat) - N;
  return { lon: radToDeg(lon), lat: radToDeg(lat), h };
}

/** @returns {{E: number, N: number, U: number}} */
export function ecefToEnu(X, Y, Z, originLonDeg, originLatDeg, X0, Y0, Z0) {
  const lon0 = degToRad(originLonDeg);
  const lat0 = degToRad(originLatDeg);
  const sinLat0 = Math.sin(lat0);
  const cosLat0 = Math.cos(lat0);
  const sinLon0 = Math.sin(lon0);
  const cosLon0 = Math.cos(lon0);
  const dX = X - X0;
  const dY = Y - Y0;
  const dZ = Z - Z0;
  return {
    E: -sinLon0 * dX + cosLon0 * dY,
    N: -sinLat0 * cosLon0 * dX - sinLat0 * sinLon0 * dY + cosLat0 * dZ,
    U: cosLat0 * cosLon0 * dX + cosLat0 * sinLon0 * dY + sinLat0 * dZ,
  };
}

/** @returns {{X: number, Y: number, Z: number}} */
export function enuToEcef(E, N, U, originLonDeg, originLatDeg, X0, Y0, Z0) {
  const lon0 = degToRad(originLonDeg);
  const lat0 = degToRad(originLatDeg);
  const sinLat0 = Math.sin(lat0);
  const cosLat0 = Math.cos(lat0);
  const sinLon0 = Math.sin(lon0);
  const cosLon0 = Math.cos(lon0);
  // transpose of the ECEF->ENU rotation applied to [E,N,U]
  const dX = -sinLon0 * E - sinLat0 * cosLon0 * N + cosLat0 * cosLon0 * U;
  const dY = cosLon0 * E - sinLat0 * sinLon0 * N + cosLat0 * sinLon0 * U;
  const dZ = cosLat0 * N + sinLat0 * U;
  return { X: X0 + dX, Y: Y0 + dY, Z: Z0 + dZ };
}

/**
 * `EnuProjection.toInternal`: lng/lat → [E, N] metres in the tangent plane at
 * `origin` (`U` dropped — orthographic, exactly as Audiom does).
 *
 * @param {number[]} lngLat [lng, lat]
 * @param {number[]} origin [lng, lat]
 * @returns {number[]} [E, N]
 */
export function enuForward(lngLat, origin) {
  const { X: X0, Y: Y0, Z: Z0 } = geodeticToEcef(origin[0], origin[1], 0);
  const { X, Y, Z } = geodeticToEcef(lngLat[0], lngLat[1], 0);
  const { E, N } = ecefToEnu(X, Y, Z, origin[0], origin[1], X0, Y0, Z0);
  return [E, N];
}

/**
 * `EnuProjection.toExternal`: [E, N] → lng/lat, with the same 6-iteration `U`
 * adjustment so the result lands on the ellipsoid surface.
 *
 * @param {number[]} en [E, N]
 * @param {number[]} origin [lng, lat]
 * @returns {number[]} [lng, lat]
 */
export function enuInverse(en, origin) {
  const { X: X0, Y: Y0, Z: Z0 } = geodeticToEcef(origin[0], origin[1], 0);
  const [E, N] = en;
  let Uadj = 0;
  for (let i = 0; i < 6; i++) {
    const { X, Y, Z } = enuToEcef(E, N, Uadj, origin[0], origin[1], X0, Y0, Z0);
    const { h } = ecefToGeodetic(X, Y, Z);
    if (Math.abs(h) < 1e-6) break;
    Uadj -= h; // move along Up roughly equals changing ellipsoidal height
  }
  const { X, Y, Z } = enuToEcef(E, N, Uadj, origin[0], origin[1], X0, Y0, Z0);
  const { lon, lat } = ecefToGeodetic(X, Y, Z);
  return [lon, lat];
}
