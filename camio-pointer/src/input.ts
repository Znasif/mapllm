/**
 * Fingertip input: the hand-gesture recognizer (MediaPipe hand landmarks; a
 * port of CamIO's `gesture_recognizer.py`), the One Euro filter, the corner
 * dwell state machine, and the pin quantizer / send gate. All pure and
 * clock-free (the caller passes `now`). The filter, dwell and quantizer are
 * ported from the starter's `cornerRegistration.js` and `dotpadPins.js`.
 */

import type { Point } from './geometry';

/* ------------------------------------------------------------ pointing -- */

/** One MediaPipe hand landmark (normalised image coordinates). */
export interface Landmark {
	x: number;
	y: number;
	z?: number;
}

/** One MediaPipe classification category (handedness: categoryName 'Left' | 'Right'). */
export interface HandCategory {
	categoryName?: string;
	displayName?: string;
	index?: number;
	score?: number;
}

/** Minimal shape of a MediaPipe HandLandmarker VIDEO result. */
export interface HandResult {
	landmarks?: Landmark[][];
	/** Per hand, its handedness categories (best first). Optional: without it every hand has an unknown side. */
	handedness?: HandCategory[][];
	/** Deprecated MediaPipe alias of `handedness`. */
	handednesses?: HandCategory[][];
}

export type HandSide = 'left' | 'right';

export const INDEX_TIP = 8;

/** CamIO `Hand.POINTING_THRESHOLD`. */
export const POINTING_THRESHOLD = 0.1;

/**
 * Open hand (not in CamIO): index, middle, ring and pinky each at least this
 * straight (CamIO's `ratio`, |MCP→TIP| / joint chain). A finger whose PIP and
 * DIP each bend by θ has ratio ≈ sin(3θ/2) / (3 sin(θ/2)): 0.997 at 8–12°
 * (a relaxed open hand), 0.91 at 30°, 0.90 at ≈ 31°, 0.75 for a claw, ≈ 0.35
 * for a fist. 0.9 accepts a relaxed or slightly cupped hand and rejects a claw
 * or any curled finger.
 */
export const OPEN_FINGER_MIN = 0.9;

/** DOT Pad pin pitch assumed when converting physical distances to pins (nominal, unverified). */
export const DOTPAD_PIN_PITCH_MM = 2.5;

/** CamIO `GestureRecognizer.MOVEMENT_THRESHOLD` (0.25 inch on the map) in DOT Pad pins: 6.35 mm / 2.5 mm = 2.54. */
export const MOVEMENT_THRESHOLD_PINS = (0.25 * 25.4) / DOTPAD_PIN_PITCH_MM;

/** CamIO: per-side fingertip buffers `Buffer[Coords](15)` (default max_life 1 s). */
export const TIP_BUFFER_SIZE = 15;
export const TIP_BUFFER_LIFE_MS = 1000;
/** CamIO `GestureBuffer.MAX_SIZE` / `MAX_LIFE`. */
export const GESTURE_BUFFER_SIZE = 5;
export const GESTURE_BUFFER_LIFE_MS = 1000;

/** Pins beyond the corner-pin centres that still count as on the pad (quantizer and index-visible filter). */
export const OFF_PAD_MARGIN = 1;

/** True when fractional pin (fx, fy) is on the pad (within `margin` pins of the corner-pin centres). */
export function isOnPad(fx: number, fy: number, cols: number, rows: number, margin = OFF_PAD_MARGIN): boolean {
	return (
		Number.isFinite(fx) &&
		Number.isFinite(fy) &&
		fx >= -margin &&
		fx <= cols - 1 + margin &&
		fy >= -margin &&
		fy <= rows - 1 + margin
	);
}

function dist3(a: Landmark, b: Landmark): number {
	const x = a.x - b.x;
	const y = a.y - b.y;
	const z = (a.z ?? 0) - (b.z ?? 0);
	return Math.sqrt(x * x + y * y + z * z);
}

/** CamIO `ratio()` on four landmarks: |p0→p3| / (|p0→p1| + |p1→p2| + |p2→p3|); NaN when degenerate (as numpy). */
function ratio4(p0: Landmark, p1: Landmark, p2: Landmark, p3: Landmark): number {
	return dist3(p0, p3) / (dist3(p0, p1) + dist3(p1, p2) + dist3(p2, p3));
}

/** |MCP→TIP| / (|MCP→PIP| + |PIP→DIP| + |DIP→TIP|); 0 when landmarks are missing or degenerate. */
export function fingerStraightness(landmarks: Landmark[], mcpIndex: number): number {
	const p0 = landmarks[mcpIndex];
	const p1 = landmarks[mcpIndex + 1];
	const p2 = landmarks[mcpIndex + 2];
	const p3 = landmarks[mcpIndex + 3];
	if (!p0 || !p1 || !p2 || !p3) return 0;
	const r = ratio4(p0, p1, p2, p3);
	return Number.isFinite(r) ? r : 0;
}

/** The intermediate values of CamIO's pointing test (for tests and debugging). */
export interface PointingEvidence {
	ratioIndex: number;
	ratioMiddle: number;
	ratioRing: number;
	ratioPinky: number;
	/** No middle/ring/pinky joint projects past half the index finger (MCP→TIP). */
	projectionPass: boolean;
	/** ratioIndex − mean(ratioMiddle, ratioRing, ratioPinky). */
	overall: number;
	pointing: boolean;
}

/**
 * CamIO `Hand.__compute_is_pointing`, on the landmarks exactly as MediaPipe
 * gives them (normalised x, y and z). Null when the hand has < 21 landmarks.
 */
export function pointingEvidence(landmarks: Landmark[] | null | undefined): PointingEvidence | null {
	if (!landmarks || landmarks.length < 21) return null;
	const L = landmarks;
	const z = (p: Landmark) => p.z ?? 0;
	const ratioIndex = ratio4(L[5], L[6], L[7], L[8]);
	const a = L[5];
	const ab = [L[8].x - a.x, L[8].y - a.y, z(L[8]) - z(a)];
	const abab = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
	let projectionPass = true;
	const r: number[] = [];
	for (const base of [9, 13, 17]) {
		r.push(ratio4(L[base], L[base + 1], L[base + 2], L[base + 3]));
		for (let i = 0; i < 4; i++) {
			const p = L[base + i];
			const t = ((p.x - a.x) * ab[0] + (p.y - a.y) * ab[1] + (z(p) - z(a)) * ab[2]) / abab;
			if (t > 0.5) projectionPass = false;
		}
	}
	const [ratioMiddle, ratioRing, ratioPinky] = r;
	const overall = ratioIndex - (ratioMiddle + ratioRing + ratioPinky) / 3;
	return {
		ratioIndex,
		ratioMiddle,
		ratioRing,
		ratioPinky,
		projectionPass,
		overall,
		pointing: projectionPass || overall > POINTING_THRESHOLD,
	};
}

/** CamIO's pointing classifier: the projection test passes, or the index is clearly straighter than the others. */
export function isPointingHand(landmarks: Landmark[] | null | undefined): boolean {
	return pointingEvidence(landmarks)?.pointing ?? false;
}

/** Index, middle, ring and pinky all extended (thumb ignored). Not in CamIO. */
export function isOpenHand(landmarks: Landmark[] | null | undefined, minStraightness = OPEN_FINGER_MIN): boolean {
	if (!landmarks || landmarks.length < 21) return false;
	for (const mcp of [5, 9, 13, 17]) if (!(fingerStraightness(landmarks, mcp) >= minStraightness)) return false;
	return true;
}

/**
 * Side of hand `i` from the MediaPipe handedness, or null when unknown.
 * MediaPipe labels assume a mirrored (selfie) image; CamIO maps the label
 * index (0 = 'Left', 1 = 'Right' in MediaPipe's handedness.txt) through
 * `Hand.Side` (RIGHT = 0, LEFT = 1), i.e. it swaps them. `swap` (default true)
 * does the same; pass false to take the label literally.
 */
export function handSideOf(result: HandResult | null | undefined, i: number, swap = true): HandSide | null {
	const cats = result?.handedness ?? result?.handednesses;
	const best = cats?.[i]?.[0];
	const name = (best?.categoryName ?? best?.displayName ?? '').toLowerCase();
	let side: HandSide | null = name === 'left' ? 'left' : name === 'right' ? 'right' : null;
	if (side && swap) side = side === 'left' ? 'right' : 'left';
	return side;
}

/* ---------------------------------------------------- gesture buffers -- */

/**
 * CamIO `utils.Buffer`: the last `maxSize` values, each dropped `maxLifeMs`
 * after it was added (checked lazily on read, as in Python).
 */
export function createTimedBuffer<T>(maxSize: number, maxLifeMs: number) {
	let values: T[] = [];
	let stamps: number[] = [];
	const items = (now: number): T[] => {
		while (values.length > 0 && now - stamps[0] > maxLifeMs) {
			values.shift();
			stamps.shift();
		}
		return values;
	};
	return {
		add(value: T, now: number) {
			values.push(value);
			stamps.push(now);
			if (values.length > maxSize) {
				values.shift();
				stamps.shift();
			}
		},
		items,
		first(now: number): T | null {
			const it = items(now);
			return it.length ? it[0] : null;
		},
		last(now: number): T | null {
			const it = items(now);
			return it.length ? it[it.length - 1] : null;
		},
		clear() {
			values = [];
			stamps = [];
		},
		/**
		 * Most common value; ties go to the value listed first in `priority`
		 * (values not listed lose ties to listed ones, then first seen wins).
		 */
		mode(now: number, priority: readonly T[] = []): T | null {
			const it = items(now);
			if (!it.length) return null;
			const counts = new Map<T, number>();
			for (const v of it) counts.set(v, (counts.get(v) ?? 0) + 1);
			const rank = (v: T) => {
				const k = priority.indexOf(v);
				return k < 0 ? priority.length : k;
			};
			let best: T | null = null;
			let bestN = -1;
			for (const [v, n] of counts) {
				if (n > bestN || (n === bestN && best !== null && rank(v) < rank(best))) {
					best = v;
					bestN = n;
				}
			}
			return best;
		},
	};
}

/**
 * Per-frame / aggregated gesture status: CamIO's `GestureResult.Status` plus
 * OPEN_HAND (no hand pointing, at least one visible hand open).
 */
export type GestureStatus = 'NOT_FOUND' | 'MORE_THAN_ONE_HAND' | 'POINTING' | 'EXPLORING' | 'OPEN_HAND';

/**
 * Tie-break of the 5-frame majority vote. CamIO's `max(set(items),
 * key=items.count)` breaks ties by set iteration order, which follows
 * `hash(member.name)` and so changes with PYTHONHASHSEED (random per run):
 * every run has SOME fixed priority order, but not a reproducible one. This
 * fixes one: pointing wins ties (keeps the pin under the finger), and an open
 * hand needs a strict plurality before it can stop speech.
 */
export const GESTURE_TIE_PRIORITY: readonly GestureStatus[] = Object.freeze([
	'POINTING',
	'EXPLORING',
	'OPEN_HAND',
	'MORE_THAN_ONE_HAND',
	'NOT_FOUND',
]);

/** One detected hand, prepared by the caller. */
export interface GestureHand {
	landmarks: Landmark[];
	side: HandSide | null;
	/** CamIO `is_index_visible`: the index tip is on the pad (always true before registration). */
	visible: boolean;
	/** Index tip in camera px. */
	px: Point;
	/** Index tip in fractional pins when a pose exists, else null. */
	pad: Point | null;
}

/** CamIO `detection()` for one frame. */
export interface FrameGesture {
	status: GestureStatus;
	/** POINTING: the selected hand; OPEN_HAND: the (first) open hand; else null. */
	hand: GestureHand | null;
	side: HandSide | null;
}

/** CamIO `GestureBuffer.aggregate()`: the majority status of the last frames. */
export interface AggregatedGesture {
	status: GestureStatus;
	/** POINTING: this frame's pointing hand, else the last one. OPEN_HAND: this frame's open hand, else the last one. */
	hand: GestureHand | null;
	/** Side of `hand`. */
	side: HandSide | null;
	/** This frame's own result. */
	frame: FrameGesture;
}

type SideKey = HandSide | 'unknown';
const SIDE_ORDER: SideKey[] = ['right', 'left', 'unknown'];
const keyOf = (s: HandSide | null): SideKey => s ?? 'unknown';
const sideOf = (k: SideKey): HandSide | null => (k === 'unknown' ? null : k);

export interface GestureRecognizerOptions {
	/** CamIO `is_moving` threshold in pins (0.25 inch). */
	movementPins?: number;
}

/**
 * CamIO's `GestureRecognizer.detect` + `GestureBuffer`, with OPEN_HAND added.
 * Hands with an unknown side (no handedness) share one 'unknown' side, so
 * without handedness two visible hands are MORE_THAN_ONE_HAND, as two hands
 * on the same side are in CamIO.
 */
export function createGestureRecognizer({ movementPins = MOVEMENT_THRESHOLD_PINS }: GestureRecognizerOptions = {}) {
	const tips = new Map<SideKey, ReturnType<typeof createTimedBuffer<GestureHand>>>();
	const tipBuffer = (k: SideKey) => {
		let b = tips.get(k);
		if (!b) {
			b = createTimedBuffer<GestureHand>(TIP_BUFFER_SIZE, TIP_BUFFER_LIFE_MS);
			tips.set(k, b);
		}
		return b;
	};
	const statuses = createTimedBuffer<GestureStatus>(GESTURE_BUFFER_SIZE, GESTURE_BUFFER_LIFE_MS);
	let lastSidePointing: SideKey | null = null;
	let lastPointing: GestureHand | null = null;
	let lastOpen: GestureHand | null = null;

	/** CamIO `is_moving`: |last − first| of the side's tip buffer, in pins (pad) or pins × pxPerPin (camera px). */
	const isMoving = (k: SideKey, now: number, pxPerPin: number): boolean => {
		const b = tips.get(k);
		const first = b?.first(now);
		const last = b?.last(now);
		if (!first || !last) return false;
		if (first.pad && last.pad) return Math.hypot(last.pad[0] - first.pad[0], last.pad[1] - first.pad[1]) > movementPins;
		return Math.hypot(last.px[0] - first.px[0], last.px[1] - first.px[1]) > movementPins * pxPerPin;
	};

	const detection = (all: GestureHand[], now: number, pxPerPin: number): FrameGesture => {
		const none = (status: GestureStatus): FrameGesture => ({ status, hand: null, side: null });
		if (all.length === 0) return none('NOT_FOUND');
		const hands = all.filter((h) => h.visible);
		if (hands.length === 0) return none('EXPLORING');
		const perSide = new Map<SideKey, number>();
		for (const h of hands) perSide.set(keyOf(h.side), (perSide.get(keyOf(h.side)) ?? 0) + 1);
		for (const n of perSide.values()) if (n > 1) return none('MORE_THAN_ONE_HAND');
		for (const h of hands) tipBuffer(keyOf(h.side)).add(h, now);
		const pointing = hands.filter((h) => isPointingHand(h.landmarks));
		if (pointing.length === 0) {
			const open = hands.find((h) => isOpenHand(h.landmarks));
			return open ? { status: 'OPEN_HAND', hand: open, side: open.side } : none('EXPLORING');
		}
		const pointingSides = pointing.map((h) => keyOf(h.side));
		// The last side only counts while that side is still pointing (always true in CamIO, which has two sides).
		let side: SideKey | null = lastSidePointing && pointingSides.includes(lastSidePointing) ? lastSidePointing : null;
		if (pointing.length === 1) side = pointingSides[0];
		else {
			const moving = SIDE_ORDER.find((k) => pointingSides.includes(k) && isMoving(k, now, pxPerPin));
			if (moving) side = moving;
		}
		if (side === null) return none('EXPLORING');
		const hand = pointing[pointingSides.indexOf(side)];
		return { status: 'POINTING', hand, side: sideOf(side) };
	};

	return {
		/** One frame: CamIO `detect()` (frame result + 5-frame majority). `pxPerPin` scales the movement threshold when no pose exists. */
		update(hands: GestureHand[], now: number, pxPerPin: number): AggregatedGesture {
			const frame = detection(hands, now, pxPerPin);
			lastSidePointing = frame.status === 'POINTING' && frame.hand ? keyOf(frame.side) : null;
			statuses.add(frame.status, now);
			const status = statuses.mode(now, GESTURE_TIE_PRIORITY) ?? 'NOT_FOUND';
			if (frame.status === 'POINTING') lastPointing = frame.hand;
			if (frame.status === 'OPEN_HAND') lastOpen = frame.hand;
			let hand: GestureHand | null = null;
			if (status === 'POINTING') hand = frame.status === 'POINTING' ? frame.hand : lastPointing;
			else if (status === 'OPEN_HAND') hand = frame.status === 'OPEN_HAND' ? frame.hand : lastOpen;
			return { status, hand, side: hand?.side ?? null, frame };
		},
		reset() {
			tips.clear();
			statuses.clear();
			lastSidePointing = null;
			lastPointing = null;
			lastOpen = null;
		},
	};
}

export type GestureRecognizer = ReturnType<typeof createGestureRecognizer>;

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
export function createPinQuantizer({ cols = 60, rows = 40, hysteresis = 0.35, offPadMargin = OFF_PAD_MARGIN } = {}) {
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
			if (!isOnPad(fx, fy, cols, rows, offPadMargin)) {
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
