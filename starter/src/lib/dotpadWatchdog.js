/**
 * DOT Pad drift watchdog — the pure decision half.
 *
 * Why: after registration, tracking follows an AKAZE homography snapshot →
 * live, and most AKAZE features come from the BACKGROUND (keyboard, table,
 * mat). Slide the pad while the scene stays put and the homography stays ≈
 * identity, so the fingertip silently maps to where the pad USED to be. The
 * corners are never re-measured — except by this watchdog: while no hand is in
 * view, the component re-runs the lattice detector every so often and hands
 * the result here together with the TRACKED corners (registered corners mapped
 * through the current homography into live px). This module says whether they
 * agree, and when to re-register.
 *
 * Decision (all distances in PINS — px / measured pitch — so it is the same
 * rule at any camera distance):
 *   ≤ WATCHDOG_AGREE_PINS        agree → "verified"; any disagreement streak ends.
 *   (AGREE, MOVED]               ambiguous band → nothing; the streak ends.
 *   > WATCHDOG_MOVED_PINS        disagree. WATCHDOG_CONSECUTIVE consistent
 *                                disagreements in a row (each within AGREE of
 *                                the previous measurement) → re-register.
 *   detection null               no evidence (pins blank / washed out) → nothing,
 *                                the streak is left as it is.
 *
 * Orientation: the detector's TL→TR is always the long (60-pin) edge, so only
 * 0° and 180° re-orderings are legal. The measured quad takes whichever of the
 * two best matches the tracked order (the tracked orientation is kept) — unless
 * the detection read the braille text line, which is authoritative: then its
 * own order is used even if that contradicts the tracked one (a pad turned
 * 180° in place shows up as a full-diagonal disagreement and re-registers).
 *
 * PLATFORM-FREE: plain arrays, no OpenCV, no DOM — tested headlessly by
 * `scripts/test_dotpad_watchdog.mjs`. Corner order TL, TR, BR, BL, corner-PIN
 * centres, as everywhere else (`dotpadTemplate.js`).
 */

import { rotateQuad } from './dotpadTemplate.js';

// ── Tunables ─────────────────────────────────────────────────────────────
/** Between checks (ms, from the END of the previous one): with two checks needed, a slid pad is re-registered ~2–4 s after the hand leaves; a successful check is ~4 ticks of < 0.1 s, so the load stays small. */
export const WATCHDOG_INTERVAL_MS = 1500;
/** Interval after a check that saw no lattice (pins blank / washed out): a failed search walks every scale hypothesis (~15 ticks, up to ~0.3 s each offline), so don't burn that every 1.5 s. */
export const WATCHDOG_UNSEEN_INTERVAL_MS = 5000;
/** No hand in view for this long before a check starts: same settle time as the registration reference (a hand just lifted may still be in the frame edge). */
export const WATCHDOG_HANDS_OFF_MS = 400;
/** Max corner error (pins) still called "same place": single-frame lattice corners wobble ~0.1–0.3 pin, AKAZE adds a little more. */
export const WATCHDOG_AGREE_PINS = 0.75;
/** Max corner error (pins) above which the pad has moved: at 1 pin the fingertip is reported on the NEIGHBOURING pin — the error users notice. */
export const WATCHDOG_MOVED_PINS = 1.0;
/** Consecutive consistent disagreements before re-registering: one bad frame (glare, a half-detected lattice) must never move the registration. */
export const WATCHDOG_CONSECUTIVE = 2;
/** Minimum gap between spoken "pad moved" announcements (ms): re-registering is silent-safe, repeating speech is not. */
export const WATCHDOG_ANNOUNCE_COOLDOWN_MS = 5000;

const hypot = Math.hypot;
const maxDist = (p, q) => Math.max(...p.map((c, k) => hypot(c[0] - q[k][0], c[1] - q[k][1])));
const meanDist = (p, q) => p.reduce((s, c, k) => s + hypot(c[0] - q[k][0], c[1] - q[k][1]), 0) / 4;

/** Pin pitch (px) implied by a TL,TR,BR,BL corner-pin quad: mean edge length per pin step. */
export function pitchFromCorners(q, cols = 60, rows = 40) {
  const top = hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]);
  const bot = hypot(q[2][0] - q[3][0], q[2][1] - q[3][1]);
  const lef = hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]);
  const rig = hypot(q[2][0] - q[1][0], q[2][1] - q[1][1]);
  return (top + bot + lef + rig) / (2 * (cols - 1) + 2 * (rows - 1));
}

/**
 * Compare a lattice detection with the tracked corners.
 *
 * @param {number[][]} tracked  TL,TR,BR,BL in live px (registered corners through the current homography).
 * @param {{pinCorners: number[][], pitchPx?: number, textFound?: boolean}} det
 * @returns {{corners: number[][], rot: 0|2, pins: number, maxPx: number, pitchPx: number, textOverride: boolean}}
 *   `corners` = the measured quad in the order to register with; `pins` = max corner distance to `tracked`.
 */
export function compareCorners(tracked, det) {
  const pitchPx = det.pitchPx > 0 ? det.pitchPx : pitchFromCorners(det.pinCorners);
  const flip = rotateQuad(det.pinCorners, 2);
  // Best match to the tracked order (mean, as aggregateDetections), 0° or 180° only.
  let rot = meanDist(flip, tracked) < meanDist(det.pinCorners, tracked) ? 2 : 0;
  // The text line settles orientation outright; it overrides the tracked guess.
  const textOverride = !!det.textFound && rot !== 0;
  if (det.textFound) rot = 0;
  const corners = rot ? flip : det.pinCorners.map((p) => [...p]);
  const maxPx = maxDist(corners, tracked);
  return { corners, rot, pins: maxPx / pitchPx, maxPx, pitchPx, textOverride };
}

/**
 * The watchdog's memory: streak, pending measurement, announcement cooldown.
 *
 * `update(tracked, detection, now)` → {
 *   verdict: 'none' | 'agree' | 'uncertain' | 'disagree' | 'moved',
 *   action:  'none' | 'reregister',
 *   corners?  (re-register with these; 'moved' only), announce (speak now?),
 *   pins? (disagreement), streak, cmp? (full comparison)
 * }
 */
export function createDriftWatchdog({
  agreePins = WATCHDOG_AGREE_PINS,
  movedPins = WATCHDOG_MOVED_PINS,
  consecutive = WATCHDOG_CONSECUTIVE,
  cooldownMs = WATCHDOG_ANNOUNCE_COOLDOWN_MS,
} = {}) {
  let streak = 0;
  let pending = null;
  let lastAnnounceAt = -Infinity;
  let lastVerifiedAt = null;
  let unseen = false;

  return {
    get streak() { return streak; },
    get lastVerifiedAt() { return lastVerifiedAt; },
    /** Wait before the next check: longer after one that saw no lattice. */
    get intervalMs() { return unseen ? WATCHDOG_UNSEEN_INTERVAL_MS : WATCHDOG_INTERVAL_MS; },

    /** Forget the streak (new registration). The announcement cooldown survives. */
    reset() { streak = 0; pending = null; lastVerifiedAt = null; unseen = false; },

    update(tracked, det, now) {
      if (!tracked) return { verdict: 'none', action: 'none', announce: false, streak };
      unseen = !det || !det.pinCorners;
      if (unseen) return { verdict: 'none', action: 'none', announce: false, streak };
      const cmp = compareCorners(tracked, det);
      const base = { pins: cmp.pins, cmp, announce: false };
      if (cmp.pins <= agreePins) {
        streak = 0; pending = null; lastVerifiedAt = now;
        return { ...base, verdict: 'agree', action: 'none', streak };
      }
      if (cmp.pins <= movedPins) {
        streak = 0; pending = null;
        return { ...base, verdict: 'uncertain', action: 'none', streak };
      }
      // Disagree: count it only if it agrees with the previous disagreement
      // (the pad is somewhere ELSE, consistently), else start a new streak.
      const consistent = pending && maxDist(pending.corners, cmp.corners) / cmp.pitchPx <= agreePins;
      streak = consistent ? streak + 1 : 1;
      pending = cmp;
      if (streak < consecutive) return { ...base, verdict: 'disagree', action: 'none', streak };
      const announce = now - lastAnnounceAt >= cooldownMs;
      if (announce) lastAnnounceAt = now;
      streak = 0; pending = null; lastVerifiedAt = now;
      return { ...base, verdict: 'moved', action: 'reregister', corners: cmp.corners, announce, streak: consecutive };
    },
  };
}

/** Is a check due? Pure scheduling: phase ready, no hand for `handsOffMs`, `intervalMs` since the last check ended. */
export function watchdogDue({ now, zeroSince, lastCheckAt }, {
  intervalMs = WATCHDOG_INTERVAL_MS, handsOffMs = WATCHDOG_HANDS_OFF_MS,
} = {}) {
  return zeroSince != null && now - zeroSince >= handsOffMs && now - (lastCheckAt ?? -Infinity) >= intervalMs;
}
