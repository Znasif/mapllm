/**
 * Drift watchdog — the pure decision half (ported from the starter's
 * `dotpadWatchdog.js`).
 *
 * While no hand is in view, the pointer re-runs the full lattice detector every
 * so often and hands the result here together with the TRACKED corners. This
 * module says whether they agree, and when to re-register. With the
 * lattice-follow tracker this is the second line of defence: it catches what
 * the per-frame tracker cannot (a pad turned 180° in place, a slide while the
 * pins were blank, a tracker that went static).
 *
 * Decision (distances in PINS = px / measured pitch):
 *   ≤ agreePins          agree → "verified"; any disagreement streak ends.
 *   (agree, moved]       ambiguous band → nothing; the streak ends.
 *   > movedPins          disagree; `consecutive` consistent disagreements in a
 *                        row (each within agreePins of the previous) → re-register.
 *   detection null       no evidence → nothing; the streak is left as it is.
 *
 * Orientation: only 0° and 180° re-orderings are legal; the measured quad takes
 * whichever best matches the tracked order, unless the detection read the
 * braille text line, which is authoritative.
 */

import { type Point, pitchFromCorners, rotateQuad } from './geometry';

export const WATCHDOG_INTERVAL_MS = 1500;
export const WATCHDOG_UNSEEN_INTERVAL_MS = 5000;
export const WATCHDOG_HANDS_OFF_MS = 400;
export const WATCHDOG_AGREE_PINS = 0.75;
export const WATCHDOG_MOVED_PINS = 1.0;
export const WATCHDOG_CONSECUTIVE = 2;
export const WATCHDOG_ANNOUNCE_COOLDOWN_MS = 5000;

const hypot = Math.hypot;
const maxDist = (p: Point[], q: Point[]) =>
	Math.max(...p.map((c, k) => hypot(c[0] - q[k][0], c[1] - q[k][1])));
const meanDist = (p: Point[], q: Point[]) =>
	p.reduce((s, c, k) => s + hypot(c[0] - q[k][0], c[1] - q[k][1]), 0) / 4;

export interface CornerDetection {
	pinCorners: Point[];
	pitchPx?: number;
	textFound?: boolean;
}

export interface CornerComparison {
	corners: Point[];
	rot: 0 | 2;
	pins: number;
	maxPx: number;
	pitchPx: number;
	textOverride: boolean;
}

/** Compare a lattice detection with the tracked corners. */
export function compareCorners(tracked: Point[], det: CornerDetection): CornerComparison {
	const pitchPx = det.pitchPx && det.pitchPx > 0 ? det.pitchPx : pitchFromCorners(det.pinCorners);
	const flip = rotateQuad(det.pinCorners, 2);
	let rot: 0 | 2 = meanDist(flip, tracked) < meanDist(det.pinCorners, tracked) ? 2 : 0;
	const textOverride = !!det.textFound && rot !== 0;
	if (det.textFound) rot = 0;
	const corners = rot ? flip : det.pinCorners.map((p) => [p[0], p[1]] as Point);
	const maxPx = maxDist(corners, tracked);
	return { corners, rot, pins: maxPx / pitchPx, maxPx, pitchPx, textOverride };
}

export type WatchdogVerdict = 'none' | 'agree' | 'uncertain' | 'disagree' | 'moved';

export interface WatchdogResult {
	verdict: WatchdogVerdict;
	action: 'none' | 'reregister';
	corners?: Point[];
	announce: boolean;
	pins?: number;
	streak: number;
	cmp?: CornerComparison;
}

export interface DriftWatchdog {
	readonly streak: number;
	readonly lastVerifiedAt: number | null;
	readonly intervalMs: number;
	reset(): void;
	update(tracked: Point[] | null, det: CornerDetection | null, now: number): WatchdogResult;
}

export function createDriftWatchdog({
	agreePins = WATCHDOG_AGREE_PINS,
	movedPins = WATCHDOG_MOVED_PINS,
	consecutive = WATCHDOG_CONSECUTIVE,
	cooldownMs = WATCHDOG_ANNOUNCE_COOLDOWN_MS,
} = {}): DriftWatchdog {
	let streak = 0;
	let pending: CornerComparison | null = null;
	let lastAnnounceAt = Number.NEGATIVE_INFINITY;
	let lastVerifiedAt: number | null = null;
	let unseen = false;

	return {
		get streak() {
			return streak;
		},
		get lastVerifiedAt() {
			return lastVerifiedAt;
		},
		get intervalMs() {
			return unseen ? WATCHDOG_UNSEEN_INTERVAL_MS : WATCHDOG_INTERVAL_MS;
		},
		reset() {
			streak = 0;
			pending = null;
			lastVerifiedAt = null;
			unseen = false;
		},
		update(tracked, det, now) {
			if (!tracked) return { verdict: 'none', action: 'none', announce: false, streak };
			unseen = !det || !det.pinCorners;
			if (!det || unseen) return { verdict: 'none', action: 'none', announce: false, streak };
			const cmp = compareCorners(tracked, det);
			const base = { pins: cmp.pins, cmp, announce: false };
			if (cmp.pins <= agreePins) {
				streak = 0;
				pending = null;
				lastVerifiedAt = now;
				return { ...base, verdict: 'agree', action: 'none', streak };
			}
			if (cmp.pins <= movedPins) {
				streak = 0;
				pending = null;
				return { ...base, verdict: 'uncertain', action: 'none', streak };
			}
			const consistent =
				pending && maxDist(pending.corners, cmp.corners) / cmp.pitchPx <= agreePins;
			streak = consistent ? streak + 1 : 1;
			pending = cmp;
			if (streak < consecutive) return { ...base, verdict: 'disagree', action: 'none', streak };
			const announce = now - lastAnnounceAt >= cooldownMs;
			if (announce) lastAnnounceAt = now;
			streak = 0;
			pending = null;
			lastVerifiedAt = now;
			return {
				...base,
				verdict: 'moved',
				action: 'reregister',
				corners: cmp.corners,
				announce,
				streak: consecutive,
			};
		},
	};
}

/** Is a check due? No hand for `handsOffMs`, `intervalMs` since the last check ended. */
export function watchdogDue(
	{ now, zeroSince, lastCheckAt }: { now: number; zeroSince: number | null; lastCheckAt: number | null },
	{ intervalMs = WATCHDOG_INTERVAL_MS, handsOffMs = WATCHDOG_HANDS_OFF_MS } = {},
): boolean {
	return (
		zeroSince != null &&
		now - zeroSince >= handsOffMs &&
		now - (lastCheckAt ?? Number.NEGATIVE_INFINITY) >= intervalMs
	);
}
