/**
 * camio-pointer fingertip → the `(u, v)` that `useDotpadBridge.onUv` takes.
 *
 * The library's pose maps pin (col, row) → camera px with the corner-PIN
 * CENTRES at (0, 0) … (cols−1, rows−1); its 'point' events carry the
 * fingertip's fractional pins (fx, fy) = pose⁻¹(tip). The bridge wants the
 * same point in the unit square with the corner-pin centres at 0 / 1
 * (TactileExplorerGeneric's `HsnapToUv`, lib/dotpadPins.js D5), so
 *   u = fx / (cols − 1), v = fy / (rows − 1).
 *
 * PLATFORM-FREE (the vendored bundle touches no DOM on import). Covered by
 * `scripts/test_camio_uv.mjs`.
 */
import { applyH, invert3 } from '../vendor/camio/CamioPointer-0.2.0.js';

/**
 * @param {number[][]|null} pose 3×3 pin → camera px (CamioPointer `pose`).
 * @param {[number, number]|null} tip Fingertip in camera px (`core.view.tip`).
 * @param {{cols: number, rows: number}} grid
 * @returns {{u: number, v: number}|null}
 */
export function uvFromPose(pose, tip, grid) {
  if (!pose || !tip) return null;
  let f;
  try {
    f = applyH(invert3(pose), tip);
  } catch {
    return null; // singular pose
  }
  const [fx, fy] = f;
  if (!Number.isFinite(fx) || !Number.isFinite(fy)) return null;
  return { u: fx / (grid.cols - 1), v: fy / (grid.rows - 1) };
}
