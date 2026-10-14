/**
 * Fingertip input — corner dwell (from test_cornerRegistration.mjs), pin
 * quantizer + send gate (from test_dotpad_pins.mjs), the CamIO gesture
 * recognizer (pointing parity with CamIO's numpy code, open hand, handedness,
 * movement, majority vote), and the geometry checks used by registration.
 */
import { describe, expect, it } from 'vitest';
import { checkPinQuad, resolveConfirmTouch, rotateQuad, type Point } from '../src/geometry';
import {
	type AggregatedGesture,
	CORNER_NAMES,
	DWELL_MS,
	DWELL_R,
	GESTURE_TIE_PRIORITY,
	type GestureHand,
	type GestureStatus,
	type HandResult,
	type HandSide,
	type Landmark,
	MOVEMENT_THRESHOLD_PINS,
	OPEN_FINGER_MIN,
	createCornerCapture,
	createGestureRecognizer,
	createPinQuantizer,
	createSendGate,
	createTimedBuffer,
	fingerStraightness,
	handSideOf,
	isOnPad,
	isOpenHand,
	isPointingHand,
	pointingEvidence,
} from '../src/input';
import { CAMIO_CASES, pose, toLandmarks } from './fixtures/hands';

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

describe('pointing classifier = CamIO Hand.__compute_is_pointing', () => {
	it(`matches CamIO's numpy verdicts on ${CAMIO_CASES.length} hands (named poses × 4 rotations + random)`, () => {
		let pointing = 0;
		for (const c of CAMIO_CASES) {
			const ev = pointingEvidence(toLandmarks(c.landmarks));
			expect(ev, c.name).not.toBeNull();
			if (!ev) continue;
			for (const k of ['ratioIndex', 'ratioMiddle', 'ratioRing', 'ratioPinky', 'overall'] as const)
				expect(Math.abs(ev[k] - c.expected[k]), `${c.name} ${k}`).toBeLessThan(1e-12);
			expect(ev.projectionPass, `${c.name} projection`).toBe(c.expected.projectionPass);
			expect(ev.pointing, `${c.name} pointing`).toBe(c.expected.pointing);
			expect(isPointingHand(toLandmarks(c.landmarks))).toBe(c.expected.pointing);
			if (ev.pointing) pointing++;
		}
		// Both verdicts are well represented.
		expect(pointing).toBeGreaterThan(20);
		expect(CAMIO_CASES.length - pointing).toBeGreaterThan(20);
	});
	it('classic point → pointing; open hand, fist, claw → not; a V sign points (as in CamIO)', () => {
		expect(isPointingHand(pose('point'))).toBe(true);
		expect(isPointingHand(pose('point-relaxed-index'))).toBe(true);
		expect(pointingEvidence(pose('point'))?.projectionPass).toBe(true);
		for (const p of ['open', 'open-relaxed', 'flat-on-table', 'fist', 'claw']) expect(isPointingHand(pose(p)), p).toBe(false);
		// Middle finger straight too: the projection test fails, but overall = 1 − (1 + 0.36 + 0.35) / 3 > 0.1.
		expect(pointingEvidence(pose('peace'))).toMatchObject({ projectionPass: false, pointing: true });
		expect(isPointingHand(pose('point').slice(0, 20))).toBe(false);
	});
	it('the old 3-finger straightness helper still guards missing landmarks', () => {
		expect(fingerStraightness([], 5)).toBe(0);
		expect(fingerStraightness(pose('open'), 9)).toBeCloseTo(1, 6);
	});
});

describe('open hand (not in CamIO)', () => {
	/** A 3-segment finger whose PIP and DIP each bend by `deg` (MCP straight). */
	const finger = (deg: number): Landmark[] => {
		const L: Landmark[] = [];
		let p = { x: 0.5, y: 0.5, z: 0 };
		let a = 0;
		L[5] = p;
		for (let k = 0; k < 3; k++) {
			p = { x: p.x, y: p.y - 0.03 * Math.cos(a), z: (p.z ?? 0) + 0.03 * Math.sin(a) };
			L[6 + k] = p;
			a += (deg * Math.PI) / 180;
		}
		return L;
	};
	it(`threshold ${OPEN_FINGER_MIN}: ratio = sin(3θ/2) / (3 sin(θ/2)); passes up to ≈ 31° per joint`, () => {
		for (const deg of [0, 10, 20, 30, 31, 32, 45, 90]) {
			const t = (deg * Math.PI) / 180;
			const expected = deg === 0 ? 1 : Math.sin(1.5 * t) / (3 * Math.sin(0.5 * t));
			expect(fingerStraightness(finger(deg), 5)).toBeCloseTo(expected, 9);
		}
		expect(fingerStraightness(finger(30), 5)).toBeGreaterThan(OPEN_FINGER_MIN);
		expect(fingerStraightness(finger(32), 5)).toBeLessThan(OPEN_FINGER_MIN);
	});
	it('open, relaxed-open and flat hands are open at every rotation; fist, claw, point and V sign are not', () => {
		for (const c of CAMIO_CASES.filter((k) => k.pose !== 'random')) {
			const open = ['open', 'open-relaxed', 'flat-on-table'].includes(c.pose);
			expect(isOpenHand(toLandmarks(c.landmarks)), c.name).toBe(open);
			if (open) expect(c.expected.pointing, c.name).toBe(false);
		}
		// The thumb is ignored: a fist's thumb or an open hand's tucked thumb changes nothing.
		const tucked = pose('open').map((p, i) => (i >= 1 && i <= 4 ? { ...pose('fist')[i] } : p));
		expect(isOpenHand(tucked)).toBe(true);
	});
});

describe('handedness, on-pad test', () => {
	it("MediaPipe 'Left' is the right hand (CamIO's Side mapping) unless swap = false; absent → null", () => {
		const r: HandResult = { landmarks: [pose('point'), pose('open')], handedness: [[{ categoryName: 'Left' }], [{ categoryName: 'Right' }]] };
		expect(handSideOf(r, 0)).toBe('right');
		expect(handSideOf(r, 1)).toBe('left');
		expect(handSideOf(r, 0, false)).toBe('left');
		expect(handSideOf({ landmarks: r.landmarks, handednesses: r.handedness }, 1)).toBe('left');
		expect(handSideOf({ landmarks: r.landmarks }, 0)).toBeNull();
		expect(handSideOf({ landmarks: r.landmarks, handedness: [[], []] }, 0)).toBeNull();
	});
	it('isOnPad uses the quantizer bound (1 pin beyond the corner-pin centres)', () => {
		expect(isOnPad(-1, -1, 60, 40)).toBe(true);
		expect(isOnPad(60, 40, 60, 40)).toBe(true);
		expect(isOnPad(-1.01, 20, 60, 40)).toBe(false);
		expect(isOnPad(30, 40.01, 60, 40)).toBe(false);
		expect(isOnPad(Number.NaN, 0, 60, 40)).toBe(false);
	});
});

describe('timed buffer (CamIO utils.Buffer)', () => {
	it('keeps the last maxSize values, each for at most maxLifeMs', () => {
		const b = createTimedBuffer<number>(3, 1000);
		for (let k = 0; k < 5; k++) b.add(k, k * 100);
		expect(b.items(400)).toEqual([2, 3, 4]);
		expect(b.first(1250)).toBe(3);
		expect(b.last(1250)).toBe(4);
		expect(b.items(1401)).toEqual([]);
		expect(b.mode(1401)).toBeNull();
	});
	it('mode: most common; ties by the given priority (CamIO: set order, i.e. hash-seed dependent)', () => {
		const b = createTimedBuffer<GestureStatus>(5, 1000);
		for (const s of ['EXPLORING', 'POINTING', 'EXPLORING', 'POINTING'] as const) b.add(s, 0);
		expect(b.mode(0, GESTURE_TIE_PRIORITY)).toBe('POINTING');
		b.add('EXPLORING', 0);
		expect(b.mode(0, GESTURE_TIE_PRIORITY)).toBe('EXPLORING');
		const c = createTimedBuffer<GestureStatus>(5, 1000);
		for (const s of ['OPEN_HAND', 'OPEN_HAND', 'EXPLORING', 'EXPLORING', 'NOT_FOUND'] as const) c.add(s, 0);
		expect(c.mode(0, GESTURE_TIE_PRIORITY)).toBe('EXPLORING');
	});
});

describe('gesture recognizer (CamIO GestureRecognizer + GestureBuffer)', () => {
	const PX = 10; // px per pin of the fake pose
	const gh = (lm: Landmark[], side: HandSide | null, c = 30, r = 20, visible = true): GestureHand => ({
		landmarks: lm,
		side,
		visible,
		px: [c * PX, r * PX],
		pad: [c, r],
	});
	const T = 33;

	it('no hands → NOT_FOUND; hands without a visible index tip → EXPLORING', () => {
		const g = createGestureRecognizer();
		expect(g.update([], 0, PX).status).toBe('NOT_FOUND');
		const r = g.update([gh(pose('point'), 'right', 70, 20, false)], T, PX);
		expect(r.frame.status).toBe('EXPLORING');
	});

	it('classic point → POINTING with the tip; fist → EXPLORING; open hand → OPEN_HAND (with its side)', () => {
		const frames = (lm: Landmark[], side: HandSide | null) => {
			const g = createGestureRecognizer();
			let r: AggregatedGesture | null = null;
			for (let k = 0; k < 5; k++) r = g.update([gh(lm, side)], k * T, PX);
			return r as AggregatedGesture;
		};
		expect(frames(pose('point'), 'right')).toMatchObject({ status: 'POINTING', side: 'right', hand: { pad: [30, 20] } });
		expect(frames(pose('fist'), 'right')).toMatchObject({ status: 'EXPLORING', hand: null, side: null });
		expect(frames(pose('claw'), 'left').status).toBe('EXPLORING');
		expect(frames(pose('open'), 'left')).toMatchObject({ status: 'OPEN_HAND', side: 'left' });
		expect(frames(pose('open-relaxed'), null)).toMatchObject({ status: 'OPEN_HAND', side: null });
	});

	it('a pointing hand beats an open one (OPEN_HAND only when nothing points)', () => {
		const g = createGestureRecognizer();
		const r = g.update([gh(pose('open'), 'left', 10, 10), gh(pose('point'), 'right')], 0, PX);
		expect(r.frame).toMatchObject({ status: 'POINTING', side: 'right' });
	});

	it('two visible hands on the same side → MORE_THAN_ONE_HAND; an off-pad duplicate is ignored', () => {
		const g = createGestureRecognizer();
		expect(g.update([gh(pose('point'), 'right'), gh(pose('fist'), 'right', 10, 10)], 0, PX).frame.status).toBe('MORE_THAN_ONE_HAND');
		expect(g.update([gh(pose('point'), 'right'), gh(pose('fist'), 'right', 90, 10, false)], T, PX).frame.status).toBe('POINTING');
		// Without handedness all hands share one (unknown) side.
		const u = createGestureRecognizer();
		expect(u.update([gh(pose('point'), null), gh(pose('fist'), null, 10, 10)], 0, PX).frame.status).toBe('MORE_THAN_ONE_HAND');
		expect(u.update([gh(pose('point'), null)], T, PX).frame).toMatchObject({ status: 'POINTING', side: null });
	});

	it('two pointing hands: the moving one is chosen (right first), else the last side, else EXPLORING', () => {
		const g = createGestureRecognizer();
		const step = (lc: number, rc: number, t: number) => g.update([gh(pose('point'), 'left', lc, 10), gh(pose('point'), 'right', rc, 30)], t, PX).frame;
		// First frame: nothing has moved yet and there is no last side.
		expect(step(10, 40, 0).status).toBe('EXPLORING');
		// Left slides 1 pin per frame; it is "moving" once > 2.54 pins (0.25 in) from its oldest sample.
		expect(MOVEMENT_THRESHOLD_PINS).toBeCloseTo(2.54, 9);
		expect(step(11, 40, T).status).toBe('EXPLORING');
		expect(step(12, 40, 2 * T).status).toBe('EXPLORING');
		expect(step(13, 40, 3 * T)).toMatchObject({ status: 'POINTING', side: 'left', hand: { pad: [13, 10] } });
		// Left stops: it stays "moving" while the motion is in its 15-sample window, then the last side holds.
		let t = 3 * T;
		for (let k = 0; k < 20; k++) expect(step(13, 40, (t += T)).side).toBe('left');
		// Both move: right wins (CamIO checks RIGHT first).
		for (let k = 1; k <= 3; k++) step(13 + k, 40 + k, (t += T));
		expect(step(17, 44, (t += T)).side).toBe('right');
		// One hand stops pointing: the other one, whatever moved.
		expect(g.update([gh(pose('fist'), 'left', 17, 10), gh(pose('point'), 'right', 44, 30)], (t += T), PX).frame.side).toBe('right');
		expect(g.update([gh(pose('point'), 'left', 17, 10), gh(pose('fist'), 'right', 44, 30)], (t += T), PX).frame.side).toBe('left');
	});

	it('movement falls back to camera px × pxPerPin without a pose', () => {
		const g = createGestureRecognizer();
		const h = (side: HandSide, x: number): GestureHand => ({ landmarks: pose('point'), side, visible: true, px: [x, 100], pad: null });
		g.update([h('left', 100), h('right', 400)], 0, 7);
		expect(g.update([h('left', 117), h('right', 400)], T, 7).frame.status).toBe('EXPLORING'); // 17 px < 2.54 × 7
		expect(g.update([h('left', 118), h('right', 400)], 2 * T, 7).frame.side).toBe('left'); // 18 px > 17.78
	});

	it('majority of the last 5 frames (1 s life): short dropouts keep POINTING at the last tip', () => {
		const g = createGestureRecognizer();
		let t = 0;
		for (let k = 0; k < 3; k++) g.update([gh(pose('point'), 'right', 30 + k, 20)], (t += T), PX);
		// Two frames without a hand: still POINTING (3 of 5), at the last known tip.
		for (let k = 0; k < 2; k++) {
			const r = g.update([], (t += T), PX);
			expect(r.frame.status).toBe('NOT_FOUND');
			expect(r).toMatchObject({ status: 'POINTING', side: 'right', hand: { pad: [32, 20] } });
		}
		// The third one tips the vote.
		expect(g.update([], (t += T), PX).status).toBe('NOT_FOUND');
		// Entries expire after 1 s: one fist frame after a long gap is the whole vote.
		for (let k = 0; k < 5; k++) g.update([gh(pose('point'), 'right')], (t += T), PX);
		expect(g.update([gh(pose('fist'), 'right')], t + 1100, PX).status).toBe('EXPLORING');
	});

	it('one stray open-hand frame does not flip the vote; three do', () => {
		const g = createGestureRecognizer();
		let t = 0;
		for (let k = 0; k < 5; k++) g.update([gh(pose('fist'), 'left')], (t += T), PX);
		expect(g.update([gh(pose('open'), 'left')], (t += T), PX).status).toBe('EXPLORING');
		expect(g.update([gh(pose('open'), 'left')], (t += T), PX).status).toBe('EXPLORING');
		expect(g.update([gh(pose('open'), 'left')], (t += T), PX)).toMatchObject({ status: 'OPEN_HAND', side: 'left' });
	});
});
