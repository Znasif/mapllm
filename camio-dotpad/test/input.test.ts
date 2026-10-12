/**
 * Fingertip input — corner dwell (from test_cornerRegistration.mjs), pin
 * quantizer + send gate (from test_dotpad_pins.mjs), pointing gate, and the
 * geometry checks used by registration.
 */
import { describe, expect, it } from 'vitest';
import { checkPinQuad, resolveConfirmTouch, rotateQuad, type Point } from '../src/geometry';
import {
	CORNER_NAMES,
	DWELL_MS,
	DWELL_R,
	createCornerCapture,
	createPinQuantizer,
	createPointingTracker,
	createSendGate,
	isPointingHand,
	recognizePointing,
	type Landmark,
} from '../src/input';

const FRAME_MS = 33;
function hold(cap: ReturnType<typeof createCornerCapture>, x: number, y: number, ms: number, t0: number) {
	const states = [];
	let t = t0;
	for (; t - t0 <= ms; t += FRAME_MS) states.push(cap.update(x, y, t));
	return { states, t, locked: states.filter((s) => s.locked) };
}

describe('corner dwell', () => {
	it('locks once after DWELL_MS, in TL, TR, BR, BL order', () => {
		expect(CORNER_NAMES.join()).toBe('top-left,top-right,bottom-right,bottom-left');
		const cap = createCornerCapture();
		const CORNERS: Point[] = [
			[100, 100],
			[500, 110],
			[495, 380],
			[98, 370],
		];
		let t = 0;
		for (const [x, y] of CORNERS) {
			const r = hold(cap, x, y, DWELL_MS + 100, t);
			expect(r.locked.length).toBe(1);
			t = r.t + 500;
		}
		expect(cap.complete).toBe(true);
		expect(cap.corners).toEqual(CORNERS);
		expect(checkPinQuad(cap.corners).ok).toBe(true);
	});
	it('a move beyond the radius re-anchors; null frames keep the anchor', () => {
		const cap = createCornerCapture();
		cap.update(300, 200, 0);
		expect(cap.update(300 + DWELL_R + 1, 200, DWELL_MS - 100).locked).toBe(false);
		expect(cap.update(300 + DWELL_R + 1, 200, DWELL_MS + 200).locked).toBe(false);
		expect(cap.update(null, null, 2 * DWELL_MS).locked).toBe(false);
		expect(cap.update(300 + DWELL_R + 1, 200, 2 * DWELL_MS + 100).locked).toBe(true);
	});
	it('setRadius scales the jitter tolerance', () => {
		const cap = createCornerCapture();
		cap.setRadius(10);
		cap.update(0, 0, 0);
		cap.update(15, 0, 100);
		expect(cap.update(15, 0, DWELL_MS + 50).locked).toBe(false);
	});
});

describe('registration geometry', () => {
	const Q: Point[] = [
		[100, 100],
		[513, 100],
		[513, 373],
		[100, 373],
	];
	it('checkPinQuad: convex clockwise, aspect in [1.15, 2]', () => {
		expect(checkPinQuad(Q).ok).toBe(true);
		expect(checkPinQuad([Q[0], Q[3], Q[2], Q[1]]).reason).toBe('not-convex-clockwise');
		expect(checkPinQuad([[0, 0], [100, 0], [100, 100], [0, 100]]).reason).toBe('aspect');
	});
	it('resolveConfirmTouch re-orders to the touched corner, rejects far touches', () => {
		expect(resolveConfirmTouch(Q, [512, 372])).toEqual(rotateQuad(Q, 2));
		expect(resolveConfirmTouch(Q, [300, 240])).toBeNull();
	});
});

describe('pin quantizer + send gate', () => {
	it('corner-pin centres map to 0 and cols−1; hysteresis per axis; off-pad → null', () => {
		const q = createPinQuantizer({ hysteresis: 0.35 });
		expect(q.update(0, 0)).toEqual([0, 0]);
		q.reset();
		expect(q.update(59, 39)).toEqual([59, 39]);
		q.reset();
		q.update(10, 10);
		expect(q.update(10.8, 10)).toEqual([10, 10]);
		expect(q.update(10.9, 10)).toEqual([11, 10]);
		expect(q.update(10.2, 10)).toEqual([11, 10]);
		expect(q.update(10.1, 10)).toEqual([10, 10]);
		expect(q.update(-1.5, 20)).toBeNull();
		expect(q.update(30, 40.5)).toBeNull();
		expect(q.update(-0.5, 20)).toEqual([0, 20]);
	});
	it('send gate: no repeats, min interval, dwell, lift re-arms', () => {
		const g = createSendGate({ minIntervalMs: 150, dwellMs: 0 });
		expect(g.offer('1,1', 0)).toBe('1,1');
		expect(g.offer('1,1', 50)).toBeNull();
		expect(g.offer('2,1', 100)).toBeNull();
		expect(g.offer('2,1', 160)).toBe('2,1');
		g.lift();
		expect(g.offer('2,1', 400)).toBe('2,1');
		const d = createSendGate({ dwellMs: 300 });
		expect(d.offer('5,5', 0)).toBeNull();
		expect(d.offer('5,5', 310)).toBe('5,5');
	});
});

describe('pointing gate', () => {
	const hand = (curled: boolean): Landmark[] => {
		const L: Landmark[] = [];
		L[0] = { x: 0.5, y: 0.9 };
		for (let k = 1; k <= 4; k++) L[k] = { x: 0.45 - 0.01 * k, y: 0.85 - 0.02 * k };
		for (let k = 0; k < 4; k++) L[5 + k] = { x: 0.5, y: 0.7 - 0.05 * k };
		for (const [m, dx] of [
			[9, 0.03],
			[13, 0.06],
			[17, 0.09],
		]) {
			L[m] = { x: 0.5 + dx, y: 0.7 };
			L[m + 1] = curled ? { x: 0.5 + dx, y: 0.66 } : { x: 0.5 + dx, y: 0.65 };
			L[m + 2] = curled ? { x: 0.5 + dx + 0.01, y: 0.69 } : { x: 0.5 + dx, y: 0.6 };
			L[m + 3] = curled ? { x: 0.5 + dx + 0.005, y: 0.72 } : { x: 0.5 + dx, y: 0.55 };
		}
		return L;
	};
	it('index extended + others curled = pointing; a flat hand is not', () => {
		expect(isPointingHand(hand(true))).toBe(true);
		expect(isPointingHand(hand(false))).toBe(false);
		expect(recognizePointing({ landmarks: [hand(true)] }).pointing).toBe(true);
		expect(recognizePointing({ landmarks: [hand(true), hand(true)] }).tooManyHandsPointing).toBe(true);
	});
	it('a dropped frame is bridged for graceMs', () => {
		const t = createPointingTracker({ graceMs: 120 });
		expect(t.update({ landmarks: [hand(true)] }, 0).pointing).toBe(true);
		expect(t.update({ landmarks: [] }, 100)).toMatchObject({ pointing: true, held: true });
		expect(t.update({ landmarks: [] }, 300).pointing).toBe(false);
	});
});
