/**
 * Fingertip input: the pointing-gesture gate (MediaPipe hand landmarks), the
 * One Euro filter, the corner dwell state machine, and the pin quantizer /
 * send gate. All pure and clock-free (the caller passes `now`). Ported from the
 * starter's `gestureRecognizer.js`, `cornerRegistration.js`, `dotpadPins.js`.
 */

import type { Point } from './geometry';

/* ------------------------------------------------------------ pointing -- */

/** One MediaPipe hand landmark (normalised image coordinates). */
export interface Landmark {
	x: number;
	y: number;
	z?: number;
}

/** Minimal shape of a MediaPipe HandLandmarker VIDEO result. */
export interface HandResult {
	landmarks?: Landmark[][];
}

export const INDEX_TIP = 8;
const FINGER_MCP = { index: 5, middle: 9, ring: 13, pinky: 17 };
const INDEX_EXTENDED_MIN = 0.7;
const OTHER_CURLED_MAX = 0.95;

export interface PointingState {
	detected: boolean;
	pointing: boolean;
	tooManyHandsPointing: boolean;
	pointingHandLandmarks: Landmark[] | null;
	tip: Landmark | null;
	held?: boolean;
}

const NO_HANDS: PointingState = Object.freeze({
	detected: false,
	pointing: false,
	tooManyHandsPointing: false,
	pointingHandLandmarks: null,
	tip: null,
}) as PointingState;

const TOO_MANY: PointingState = Object.freeze({
	detected: true,
	pointing: false,
	tooManyHandsPointing: true,
	pointingHandLandmarks: null,
	tip: null,
}) as PointingState;

function dist3(a: Landmark, b: Landmark): number {
	const x = a.x - b.x;
	const y = a.y - b.y;
	const z = (a.z ?? 0) - (b.z ?? 0);
	return Math.sqrt(x * x + y * y + z * z);
}

/** |MCP→TIP| / (|MCP→PIP| + |PIP→DIP| + |DIP→TIP|); 0 when landmarks are missing. */
export function fingerStraightness(landmarks: Landmark[], mcpIndex: number): number {
	const p0 = landmarks[mcpIndex];
	const p1 = landmarks[mcpIndex + 1];
	const p2 = landmarks[mcpIndex + 2];
	const p3 = landmarks[mcpIndex + 3];
	if (!p0 || !p1 || !p2 || !p3) return 0;
	const chain = dist3(p0, p1) + dist3(p1, p2) + dist3(p2, p3);
	if (chain <= 0) return 0;
	return dist3(p0, p3) / chain;
}

/** Extended index, other three fingers curled. */
export function isPointingHand(landmarks: Landmark[] | null | undefined): boolean {
	if (!landmarks || landmarks.length < 21) return false;
	if (fingerStraightness(landmarks, FINGER_MCP.index) < INDEX_EXTENDED_MIN) return false;
	if (fingerStraightness(landmarks, FINGER_MCP.middle) > OTHER_CURLED_MAX) return false;
	if (fingerStraightness(landmarks, FINGER_MCP.ring) > OTHER_CURLED_MAX) return false;
	if (fingerStraightness(landmarks, FINGER_MCP.pinky) > OTHER_CURLED_MAX) return false;
	return true;
}

/** Classify a HandLandmarker result (needs `numHands: 2` to see a second pointing hand). */
export function recognizePointing(result: HandResult | null | undefined): PointingState {
	const hands = result?.landmarks;
	if (!hands || hands.length === 0) return NO_HANDS;
	let pointingHandLandmarks: Landmark[] | null = null;
	let count = 0;
	for (const lm of hands) {
		if (!isPointingHand(lm)) continue;
		count += 1;
		if (count > 1) return TOO_MANY;
		pointingHandLandmarks = lm;
	}
	if (count !== 1 || !pointingHandLandmarks) return { ...NO_HANDS, detected: true };
	return {
		detected: true,
		pointing: true,
		tooManyHandsPointing: false,
		pointingHandLandmarks,
		tip: pointingHandLandmarks[INDEX_TIP] ?? null,
	};
}

/** Holds the last good pointing result for `graceMs` (landmark dropouts strobe otherwise). */
export function createPointingTracker({ graceMs = 120 } = {}) {
	let last: PointingState | null = null;
	let lastAt = Number.NEGATIVE_INFINITY;
	return {
		update(result: HandResult | null | undefined, nowMs: number): PointingState {
			const state = recognizePointing(result);
			if (state.pointing) {
				last = state;
				lastAt = nowMs;
				return { ...state, held: false };
			}
			if (!state.tooManyHandsPointing && last && nowMs - lastAt <= graceMs) {
				return { ...last, held: true };
			}
			last = null;
			return { ...state, held: false };
		},
		reset() {
			last = null;
			lastAt = Number.NEGATIVE_INFINITY;
		},
	};
}

/* ----------------------------------------------------------- one euro -- */

/** One Euro filter — speed-adaptive low-pass for a noisy fingertip coordinate. */
export function makeOneEuroFilter(minCutoff = 1.0, beta = 0.007, dCutoff = 1.0) {
	let xFilt = 0;
	let dxFilt = 0;
	let lastT: number | null = null;
	const alpha = (cutoff: number, dt: number) => {
		const tau = 1 / (2 * Math.PI * cutoff);
		return 1 / (1 + tau / dt);
	};
	return (x: number, t: number): number => {
		if (lastT === null) {
			xFilt = x;
			lastT = t;
			return x;
		}
		const dt = Math.max((t - lastT) / 1000, 1e-6);
		lastT = t;
		const dx = (x - xFilt) / dt;
		dxFilt = dxFilt + alpha(dCutoff, dt) * (dx - dxFilt);
		const cutoff = minCutoff + beta * Math.abs(dxFilt);
		xFilt = xFilt + alpha(cutoff, dt) * (x - xFilt);
		return xFilt;
	};
}

/* ------------------------------------------------------ corner dwell -- */

export const CORNER_NAMES = ['top-left', 'top-right', 'bottom-right', 'bottom-left'] as const;
export type CornerName = (typeof CORNER_NAMES)[number];
export const DWELL_MS = 1500;
/** Jitter tolerance while holding, in input-space px (or `dwellPitches` × pitch). */
export const DWELL_R = 45;

export interface CornerCaptureState {
	locked: boolean;
	index: number;
	complete: boolean;
	corners: Point[];
	nextPrompt: CornerName | null;
}

/**
 * Four-corner dwell: when the fingertip has stayed inside `dwellR` px for longer
 * than `dwellMs`, that corner is committed. A null fingertip leaves the state
 * (including the dwell anchor) untouched — dropped detections are common.
 */
export function createCornerCapture({ dwellMs = DWELL_MS, dwellR = DWELL_R } = {}) {
	let corners: Point[] = [];
	let index = 0;
	let dwell: { x: number; y: number; since: number } | null = null;
	let radius = dwellR;
	const snapshot = (locked: boolean): CornerCaptureState => ({
		locked,
		index,
		complete: index >= 4,
		corners,
		nextPrompt: index >= 4 ? null : CORNER_NAMES[index],
	});
	return {
		get corners() {
			return corners;
		},
		get index() {
			return index;
		},
		get complete() {
			return index >= 4;
		},
		reset() {
			corners = [];
			index = 0;
			dwell = null;
		},
		/** Change the jitter radius (px), e.g. when the frame size becomes known. */
		setRadius(r: number) {
			if (Number.isFinite(r) && r > 0) radius = r;
		},
		update(x: number | null, y: number | null, now: number): CornerCaptureState {
			if (index >= 4) return snapshot(false);
			if (x === null || y === null || !Number.isFinite(x) || !Number.isFinite(y))
				return snapshot(false);
			if (!dwell || Math.hypot(x - dwell.x, y - dwell.y) > radius) {
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
		},
	};
}

/* ------------------------------------------------------- quantizer -- */

/**
 * Fractional pin (fx, fy) → integer pin with per-axis hysteresis, and an
 * off-pad cut `offPadMargin` pins beyond the corner-pin centres.
 */
export function createPinQuantizer({ cols = 60, rows = 40, hysteresis = 0.35, offPadMargin = 1 } = {}) {
	let prev: Point | null = null;
	let h = hysteresis;
	const axis = (f: number, prevIdx: number | undefined, n: number) => {
		const idx = Math.max(0, Math.min(n - 1, Math.round(f)));
		if (prevIdx == null) return idx;
		return Math.abs(f - prevIdx) <= 0.5 + h ? prevIdx : idx;
	};
	return {
		get hysteresis() {
			return h;
		},
		setHysteresis(next: number) {
			if (Number.isFinite(next) && next >= 0) h = next;
		},
		reset() {
			prev = null;
		},
		/** Fractional pin coordinates in, integer pin (or null when off the pad) out. */
		update(fx: number, fy: number): Point | null {
			if (
				!Number.isFinite(fx) ||
				!Number.isFinite(fy) ||
				fx < -offPadMargin ||
				fx > cols - 1 + offPadMargin ||
				fy < -offPadMargin ||
				fy > rows - 1 + offPadMargin
			) {
				prev = null;
				return null;
			}
			const pin: Point = [axis(fx, prev?.[0], cols), axis(fy, prev?.[1], rows)];
			prev = pin;
			return pin;
		},
	};
}

/**
 * Decides WHEN a changed pin is emitted: dwell + minimum interval, never the
 * same pin twice in a row; `lift()` (finger gone) lets the same pin re-send.
 */
export function createSendGate({ minIntervalMs = 0, dwellMs = 0 } = {}) {
	let candidate: string | null = null;
	let since = 0;
	let lastSentKey: string | null = null;
	let lastSentAt = Number.NEGATIVE_INFINITY;
	let policy = { minIntervalMs, dwellMs };
	return {
		get lastSentKey() {
			return lastSentKey;
		},
		configure(next: Partial<typeof policy>) {
			policy = { ...policy, ...next };
		},
		offer(key: string | null, now: number): string | null {
			if (key == null) {
				candidate = null;
				return null;
			}
			if (key !== candidate) {
				candidate = key;
				since = now;
			}
			if (key === lastSentKey) return null;
			if (now - since < policy.dwellMs) return null;
			if (now - lastSentAt < policy.minIntervalMs) return null;
			lastSentKey = key;
			lastSentAt = now;
			return key;
		},
		lift() {
			candidate = null;
			lastSentKey = null;
		},
	};
}
