/**
 * The pointer state machine end to end on real frames with fake MediaPipe
 * landmarks: auto-register, corners (snapped to the lattice), confirm, cancel,
 * pins + border + leave, tracker loss → no pins → re-acquire, watchdog
 * re-registration while Fixed, and the static (pins not visible) fallback.
 */
import { describe, expect, it } from 'vitest';
import { PointerCore, type CoreEvents } from '../src/core';
import { type Mat3, applyH, maxCornerDist, poseFromCorners } from '../src/geometry';
import type { HandResult } from '../src/input';
import { lumaFrame } from '../src/tracker';
import { GT } from './fixtures/realSet.mjs';
import * as scenes from './fixtures/scenes.mjs';
import { IDENTITY, pitchOfPose, renderFrame, rigid, source } from './fixtures/sequences.mjs';

type Img = { data: Uint8Array; width: number; height: number };
const { erasePinField, renderPad, rng, viewHomography } = scenes as any;

/** 21 landmarks of a pointing hand with the index tip at (x, y) px. */
function pointingHand(x: number, y: number, W: number, H: number): HandResult {
	const L: Array<{ x: number; y: number; z: number }> = [];
	const p = (px: number, py: number) => ({ x: px / W, y: py / H, z: 0 });
	L[0] = p(x + 10, y + 110);
	for (let k = 1; k <= 4; k++) L[k] = p(x - 30 + 4 * k, y + 90 - 8 * k);
	for (let k = 0; k < 4; k++) L[5 + k] = p(x, y + 60 - 20 * k);
	const curled = (m: number, dx: number) => {
		L[m] = p(x + dx, y + 62);
		L[m + 1] = p(x + dx, y + 47);
		L[m + 2] = p(x + dx + 4, y + 55);
		L[m + 3] = p(x + dx + 2, y + 64);
	};
	curled(9, 14);
	curled(13, 26);
	curled(17, 37);
	return { landmarks: [L] };
}

function record(core: PointerCore) {
	const ev: { [K in keyof CoreEvents]: CoreEvents[K][] } = {
		pin: [],
		leave: [],
		prompt: [],
		status: [],
		registration: [],
		lost: [],
		moved: [],
		cue: [],
		error: [],
	};
	for (const k of Object.keys(ev) as Array<keyof CoreEvents>) core.on(k, (p) => (ev[k] as unknown[]).push(p));
	return ev;
}

class Clock {
	t = 0;
	next(ms = 33) {
		this.t += ms;
		return this.t;
	}
}

/** Run frames until `until()` or `max` frames. */
function run(core: PointerCore, img: Img, hands: HandResult | null, clock: Clock, max: number, until: () => boolean = () => false) {
	const f = lumaFrame(img);
	for (let k = 0; k < max && !until(); k++) core.processFrame(f, hands, clock.next());
}

const pinsErr = (corners: number[][], gt: number[][], pitch: number) => maxCornerDist(corners, gt) / pitch;

describe('PointerCore on hue_handsoff_00.jpg', () => {
	const s = source('hue_handsoff_00.jpg');
	const img = s.img as Img;
	const gt = GT['hue_handsoff_00.jpg'].corners as number[][];
	const pitch = pitchOfPose(s.H0);
	const W = img.width;
	const H = img.height;
	const at = (pose: Mat3, c: number, r: number) => applyH(pose, [c, r]);

	it('autoRegister: lattice scan → registration with the text line, ready', async () => {
		const core = new PointerCore();
		const ev = record(core);
		const clock = new Clock();
		let reg: unknown;
		const p = core.autoRegister().then((r) => {
			reg = r;
		});
		run(core, img, null, clock, 400, () => core.currentPhase === 'ready' || core.currentPhase === 'idle');
		await p;
		expect(reg).toBeTruthy();
		const r = core.currentRegistration;
		expect(r?.method).toBe('auto');
		expect(r?.textFound).toBe(true);
		expect(pinsErr(r?.corners ?? [], gt, pitch)).toBeLessThan(0.5);
		expect(ev.prompt.map((e) => e.code)).toEqual(['register.handsOff', 'register.searching', 'register.done']);
		expect(core.getStatus()).toMatchObject({ phase: 'ready', registered: true });
	});

	it('registerByCorners: imprecise touches are snapped to the lattice; then pins, border, leave', () => {
		// Precise pins on purpose (this checks registration and the border band);
		// the finger-sized default hysteresis has its own test below.
		const core = new PointerCore({ hysteresis: 0.35 });
		const ev = record(core);
		const clock = new Clock();
		core.registerByCorners();
		// Touch each corner ~0.6 pin off, as a fingertip would be.
		const off = [
			[0.6, 0.4],
			[-0.5, 0.6],
			[-0.6, -0.4],
			[0.4, -0.6],
		];
		gt.forEach(([x, y], k) => {
			const tip = [x + off[k][0] * pitch, y + off[k][1] * pitch];
			run(core, img, pointingHand(tip[0], tip[1], W, H), clock, 60, () => core.getStatus().cornersLocked > k || core.currentPhase !== 'corners');
		});
		expect(ev.cue.filter((c) => c.code === 'lock').length).toBe(4);
		run(core, img, null, clock, 40, () => core.currentPhase === 'ready');
		const r = core.currentRegistration;
		expect(r?.method).toBe('corners');
		expect(pinsErr(r?.corners ?? [], gt, pitch)).toBeLessThan(0.3);
		expect(ev.prompt.map((e) => e.code)).toEqual([
			'register.corner.topLeft',
			'register.corner.topRight',
			'register.corner.bottomRight',
			'register.corner.bottomLeft',
			'register.liftHand',
			'register.done',
		]);
		// Point at pins: (20, 10) inside, then (59, 39) in the border band, then lift.
		const pose = core.pose as Mat3;
		for (const [c, rr] of [
			[20, 10],
			[59, 39],
		]) {
			const [x, y] = at(pose, c, rr);
			run(core, img, pointingHand(x, y, W, H), clock, 20);
		}
		expect(ev.pin[0]).toMatchObject({ x: 20, y: 10, inBorder: false });
		expect(ev.pin.at(-1)).toMatchObject({ x: 59, y: 39, inBorder: true });
		run(core, img, null, clock, 10);
		expect(ev.leave.at(-1)?.reason).toBe('not-pointing');
	});

	it('cancel() during a new registration restores the previous one', () => {
		const core = new PointerCore();
		const clock = new Clock();
		core.setRegistration(gt.map((p) => [p[0], p[1]] as [number, number]), { width: W, height: H });
		const before = core.currentRegistration;
		core.registerByCorners();
		run(core, img, null, clock, 3);
		core.cancel();
		expect(core.currentPhase).toBe('ready');
		expect(core.currentRegistration).toBe(before);
	});

	it('default hysteresis is finger-sized: a resting, wobbling fingertip emits one pin; a 2-pin move emits again', () => {
		const core = new PointerCore();
		expect(core.options.hysteresis).toBe(1.5);
		const ev = record(core);
		const clock = new Clock();
		core.setRegistration(gt.map((p) => [p[0], p[1]] as [number, number]), { width: W, height: H });
		run(core, img, null, clock, 3);
		const pose = core.pose as Mat3;
		// Rest on (30, 20) with the tip wandering up to ±1.5 pins (a 4 × 4-pin fingertip).
		const wobble = [[0, 0], [1.4, 0.3], [-1.2, 1.1], [0.6, -1.5], [-1.5, -0.4], [0.2, 1.3], [1.1, -1.0], [0, 0]];
		for (const [dx, dy] of wobble) {
			const [x, y] = at(pose, 30 + dx, 20 + dy);
			run(core, img, pointingHand(x, y, W, H), clock, 6);
		}
		expect(ev.pin.length).toBe(1);
		expect(ev.pin[0]).toMatchObject({ x: 30, y: 20 });
		// A deliberate move of 4 pins emits again.
		const [x, y] = at(pose, 34, 20);
		run(core, img, pointingHand(x, y, W, H), clock, 20);
		expect(ev.pin.length).toBeGreaterThan(1);
		expect(Math.abs((ev.pin.at(-1)?.x ?? 0) - 34)).toBeLessThanOrEqual(2);
	});

	it('a bump the relock cannot explain: lost → no pins → re-acquired → pins again', () => {
		const core = new PointerCore();
		const ev = record(core);
		const clock = new Clock();
		core.setRegistration(gt.map((p) => [p[0], p[1]] as [number, number]), { width: W, height: H });
		run(core, img, null, clock, 3);
		const c = applyH(s.H0, [29.5, 19.5]);
		const turned = renderFrame(s, IDENTITY, rigid(4, c[0], c[1], 0, 0), null, 3);
		const [x, y] = applyH(turned.truth, [30, 20]);
		// Hand on the pad right after the bump: lost, and no pins while lost.
		run(core, turned.img, pointingHand(x, y, W, H), clock, 10);
		expect(ev.lost.length).toBe(1);
		expect(ev.pin.length).toBe(0);
		expect(core.getStatus().tracking).toBe('lost');
		// Hands off: the full search re-acquires.
		run(core, turned.img, null, clock, 60, () => core.getStatus().tracking === 'tracking');
		expect(ev.moved.at(-1)?.via).toBe('tracker');
		expect(pinsErr(core.currentRegistration?.corners ?? [], gt.map((p) => applyH(turned.truth, applyH(poseInv(s.H0), p))), pitch)).toBeLessThan(0.5);
		run(core, turned.img, pointingHand(x, y, W, H), clock, 15);
		expect(ev.pin.at(-1)).toMatchObject({ x: 30, y: 20 });
	});

	it('Fixed: the tracker is frozen, but the watchdog re-registers a slid pad', () => {
		const core = new PointerCore();
		const ev = record(core);
		const clock = new Clock();
		core.setRegistration(gt.map((p) => [p[0], p[1]] as [number, number]), { width: W, height: H });
		core.setFixed(true);
		const slid = renderFrame(s, IDENTITY, rigid(0, 0, 0, 3 * pitch, 1 * pitch), null, 4);
		run(core, slid.img, null, clock, 400, () => ev.moved.length > 0);
		expect(ev.moved[0]?.via).toBe('watchdog');
		expect(ev.prompt.map((e) => e.code)).toContain('tracking.moved');
		const truthCorners = [
			[0, 0],
			[59, 0],
			[59, 39],
			[0, 39],
		].map((p) => applyH(slid.truth, p));
		expect(pinsErr(core.currentRegistration?.corners ?? [], truthCorners, pitch)).toBeLessThan(0.5);
	});

	it('pins not visible: registration stays static and says so once', () => {
		const core = new PointerCore();
		const ev = record(core);
		const clock = new Clock();
		const blank = erasePinField(img, gt) as Img;
		core.setRegistration(gt.map((p) => [p[0], p[1]] as [number, number]), { width: W, height: H });
		run(core, blank, null, clock, 90);
		expect(core.getStatus().tracking).toBe('static');
		expect(ev.prompt.filter((p) => p.code === 'tracking.pinsNotVisible').length).toBe(1);
		const [x, y] = applyH(s.H0, [12, 30]);
		run(core, blank, pointingHand(x, y, W, H), clock, 15);
		expect(ev.pin.at(-1)).toMatchObject({ x: 12, y: 30 });
	});
});

describe('PointerCore confirm flow (no braille line visible)', () => {
	const W = 1280;
	const H = 720;
	const Hpin = viewHomography({ width: W, height: H, pitchPx: 7, rotDeg: 3, rand: rng(5) });
	const img = renderPad({ width: W, height: H, Hpin, seed: 3, text: false }) as Img;
	const corners = [
		[0, 0],
		[59, 0],
		[59, 39],
		[0, 39],
	].map((p) => applyH(Hpin, p));

	for (const how of ['touch', 'confirmTopLeft()'] as const) {
		it(`needsConfirm → ${how} → registered`, async () => {
			const core = new PointerCore();
			const ev = record(core);
			const clock = new Clock();
			const done = core.autoRegister();
			run(core, img, null, clock, 400, () => core.currentPhase === 'confirm' || core.currentPhase === 'idle');
			expect(core.currentPhase).toBe('confirm');
			expect(ev.prompt.at(-1)?.code).toBe('register.confirmTopLeft');
			// The detector's default guess may be either way up; touch the TRUE top-left pin.
			if (how === 'touch') run(core, img, pointingHand(corners[0][0], corners[0][1], W, H), clock, 80, () => core.currentPhase !== 'confirm');
			else core.confirmTopLeft();
			run(core, img, null, clock, 40, () => core.currentPhase === 'ready');
			const reg = await done;
			expect(reg).toBeTruthy();
			if (how === 'touch') expect(maxCornerDist(reg?.corners ?? [], corners)).toBeLessThan(3.5);
		});
	}
});

function poseInv(H: Mat3): Mat3 {
	// pin → px inverse, used to carry GT corners through a pad motion.
	const P = poseFromCorners(
		[
			[0, 0],
			[59, 0],
			[59, 39],
			[0, 39],
		].map((p) => applyH(H, p)),
	);
	const [[a, b, c], [d, e, f], [g, h, i]] = P;
	const A = e * i - f * h;
	const B = -(d * i - f * g);
	const C = d * h - e * g;
	const det = a * A + b * B + c * C;
	return [
		[A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
		[B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
		[C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
	];
}
