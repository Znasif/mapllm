/**
 * Four-corner touch registration — the "register material" dwell state machine.
 *
 * This is the pure half of the workflow that `TactileExplorerGeneric.jsx`
 * introduced and `TactileExplorer.jsx` now shares: point at each corner of the
 * physical material in turn and hold still; when the fingertip has stayed
 * inside `dwellR` px for longer than `dwellMs`, that corner is committed.
 *
 * DELIBERATELY FRAMEWORK-FREE. No React, no OpenCV, no DOM — the caller owns
 * the fingertip (MediaPipe + One Euro), the audio cue, the speech, and the
 * matrices built from the four corners. All this owns is *when* a corner is
 * locked, which is the only part of the workflow that is testable in Node.
 *
 * Coordinates are whatever space the caller feeds in — both components feed
 * smoothed fingertip positions in snapshot (camera-frame) pixels, so `dwellR`
 * is a pixel radius in that space.
 */

/** Corner order, and the words spoken to ask for each one. */
export const CORNER_PROMPTS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];

/** Hold time before a corner is committed, in ms. */
export const DWELL_MS = 1500;

/** Jitter tolerance while holding, in input-space px. */
export const DWELL_R = 45;

/**
 * @typedef {object} CornerCaptureState
 * @property {boolean} locked True ONLY on the frame a corner was committed.
 * @property {number} index How many corners are committed (0-4).
 * @property {boolean} complete Whether all four corners are in.
 * @property {Array<[number, number]>} corners The committed corners, TL,TR,BR,BL.
 * @property {string|null} nextPrompt The corner still being asked for, or null.
 */

/**
 * @param {{dwellMs?: number, dwellR?: number}} [options]
 * @returns {{
 *   reset: () => void,
 *   update: (x: number|null, y: number|null, now: number) => CornerCaptureState,
 *   corners: Array<[number, number]>,
 *   index: number,
 *   complete: boolean,
 * }}
 */
export function createCornerCapture({ dwellMs = DWELL_MS, dwellR = DWELL_R } = {}) {
  /** @type {Array<[number, number]>} */
  let corners = [];
  let index = 0;
  /** @type {{x: number, y: number, since: number}|null} */
  let dwell = null;

  const snapshot = (locked) => ({
    locked,
    index,
    complete: index >= 4,
    corners,
    nextPrompt: index >= 4 ? null : CORNER_PROMPTS[index],
  });

  function reset() {
    corners = [];
    index = 0;
    dwell = null;
  }

  /**
   * Advance one frame.
   *
   * A null fingertip (not pointing, or the hand left the frame) leaves the
   * state untouched — including the dwell anchor. That is deliberate: dropped
   * detections are common and clearing the anchor on every one would make a
   * corner nearly impossible to lock on a marginal camera. The consequence is
   * that a hold can survive a brief gap, which is the behaviour the material
   * registration has always had.
   */
  function update(x, y, now) {
    if (index >= 4) return snapshot(false);
    if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y)) {
      return snapshot(false);
    }
    if (!dwell || Math.hypot(x - dwell.x, y - dwell.y) > dwellR) {
      dwell = { x, y, since: now };
      return snapshot(false);
    }
    if (now - dwell.since > dwellMs) {
      corners[index] = [x, y];
      index += 1;
      dwell = null;
      return snapshot(true);
    }
    return snapshot(false);
  }

  const api = { reset, update };
  Object.defineProperties(api, {
    corners: { get: () => corners, enumerable: true },
    index: { get: () => index, enumerable: true },
    complete: { get: () => index >= 4, enumerable: true },
  });
  return api;
}
