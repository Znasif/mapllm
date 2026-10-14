/**
 * The core on the generic ("rect") surface, with a scripted fake tracker on
 * blank frames and fake MediaPipe hands: the four-corner dwell (starter
 * wording), the hands-off reference, the acuity grid, points with u/v,
 * rejected corners, autoRegister being unsupported, 'loading' / 'blank'
 * tracker states, a moving pose, and setSurface.
 */
import { describe, expect, it } from 'vitest';
import { type CoreEvents, PointerCore } from '../src/core';
import { type Mat3, type Point, applyH, homography4 } from '../src/geometry';
import type { HandResult } from '../src/input';
import type { SurfaceProfile } from '../src/surface';
import { type LumaFrame, type TrackHints, type TrackState, type TrackStep, type Tracker, lumaFrame } from '../src/tracker';
import { handAt, handResult } from './fixtures/hands';

const W = 1280;
const H = 720;
const FRAME = lumaFrame({ data: new Uint8Array(W * H), width: W, height: H });
/** A perspective landscape sheet, TL, TR, BR, BL. */
const SHEET: Point[] = [
	[300, 150],
	[980, 170],
	[1040, 610],
	[250, 580],
];
const RECT_PLANE = (cols: number, rows: number): Point[] => [
	[-0.5, -0.5],
	[cols - 0.5, -0.5],
	[cols - 0.5, rows - 0.5],
	[-0.5, rows - 0.5],
];

/** A tracker whose state and motion the test scripts. */
function fakeTracker(initial: TrackState = 'tracking') {
	let pose: Mat3 | null = null;
	let state: TrackState = 'idle';
	const script = { state: initial, move: null as ((H: Mat3) => Mat3) | null, reason: null as string | null };
	const calls = { reset: [] as Array<{ pose: Mat3; frame: boolean; hints?: TrackHints }>, update: 0, clear: 0, dispose: 0, prepare: 0 };
	const step = (accepted: boolean): TrackStep => ({ state, pose, accepted, relocked: false, found: 0, inliers: 0, visible: 0, residual: Number.NaN, reason: script.reason, ms: 0 });
	const tracker: Tracker = {
		get pose() {
			return pose;
		},
		get state() {
			return state;
		},
		reset(H0: Mat3, frame?: LumaFrame, hints?: TrackHints) {
			calls.reset.push({ pose: H0, frame: !!frame, hints });
			pose = H0;
			state = script.state;
			return step(true);
		},
		update() {
			calls.update++;
			state = script.state;
			let moved = false;
			if (script.move && pose) {
				pose = script.move(pose);
				script.move = null;
				moved = true;
			}
			return step(moved);
		},
		clear() {
			calls.clear++;
			pose = null;
			state = 'idle';
		},
		prepare() {
			calls.prepare++;
		},
		dispose() {
			calls.dispose++;
		},
	};
	return { tracker, script, calls };
}

function record(core: PointerCore) {
	const ev: { [K in keyof CoreEvents]: CoreEvents[K][] } = {
		point: [],
		leave: [],
		prompt: [],
		status: [],
		registration: [],
		lost: [],
		moved: [],
		cue: [],
		openHand: [],
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

const pointAt = (x: number, y: number): HandResult => handResult({ lm: handAt('point', x, y, W, H) });

function run(core: PointerCore, hands: HandResult | null, clock: Clock, max: number, until: () => boolean = () => false) {
	for (let k = 0; k < max && !until(); k++) core.processFrame(FRAME, hands, clock.next());
}

/** Dwell on each corner in turn, then take the hand away until ready (or `max` frames). */
function touchCorners(core: PointerCore, corners: Point[], clock: Clock) {
	let locks = 0;
	const off = core.on('cue', (c) => {
		if (c.code === 'lock') locks++;
	});
	corners.forEach(([x, y], k) => {
		run(core, pointAt(x, y), clock, 120, () => locks > k || core.currentPhase !== 'corners');
	});
	off();
	run(core, null, clock, 60, () => core.currentPhase === 'ready' || core.currentPhase === 'corners');
}

function registered(state: TrackState = 'tracking', opts: { hysteresis?: number } = {}) {
	const fake = fakeTracker(state);
	const core = new PointerCore({ surface: { kind: 'rect' }, tracker: fake.tracker, ...opts });
	const ev = record(core);
	const clock = new Clock();
	core.registerByCorners();
	touchCorners(core, SHEET, clock);
	return { core, ev, clock, fake };
}

describe('PointerCore on a rect surface', () => {
	it('four corner dwells (shared corner prompts) → lift hand → hands-off reference → registration 118 × 84', async () => {
		const fake = fakeTracker();
		const core = new PointerCore({ surface: { kind: 'rect' }, tracker: fake.tracker });
		const ev = record(core);
		const clock = new Clock();
		expect(core.getStatus()).toMatchObject({ surface: 'rect', phase: 'idle' });
		const done = core.register();
		expect(core.currentPhase).toBe('corners');
		touchCorners(core, SHEET, clock);
		const reg = await done;
		expect(ev.prompt.map((p) => p.code)).toEqual([
			'register.corner.topLeft',
			'register.corner.topRight',
			'register.corner.bottomRight',
			'register.corner.bottomLeft',
			'register.liftHand',
			'register.done',
		]);
		expect(ev.prompt[0].text).toBe('Point at the top-left corner and hold.');
		expect(ev.prompt[1].text).toBe('Top-right corner.');
		expect(ev.prompt.at(-1)?.text).toBe('Registered.');
		expect(ev.cue.filter((c) => c.code === 'lock').length).toBe(4);
		expect(reg).toBe(core.currentRegistration);
		expect(reg).toMatchObject({ surface: 'rect', method: 'corners', grid: { cols: 118, rows: 84 }, textFound: null, frame: { width: W, height: H } });
		reg?.corners.forEach((c, k) => {
			expect(c[0]).toBeCloseTo(SHEET[k][0], 2);
			expect(c[1]).toBeCloseTo(SHEET[k][1], 2);
		});
		expect(reg?.aspect).toBeGreaterThan(1);
		expect(reg?.cellPx).toBeGreaterThan(5);
		// The reference is taken from a hands-off frame, with the image quad as the region.
		expect(fake.calls.reset.length).toBe(1);
		expect(fake.calls.reset[0].frame).toBe(true);
		expect(fake.calls.reset[0].hints?.handsPresent).toBe(false);
		const region = fake.calls.reset[0].hints?.region as Point[];
		expect(region[2][0]).toBeCloseTo(SHEET[2][0], 2);
		expect(region[2][1]).toBeCloseTo(SHEET[2][1], 2);
		expect(core.getStatus()).toMatchObject({ surface: 'rect', phase: 'ready', registered: true, tracking: 'tracking' });
	});

	it('a portrait sheet gets the 84 × 118 grid', () => {
		const fake = fakeTracker();
		const core = new PointerCore({ surface: { kind: 'rect' }, tracker: fake.tracker });
		const clock = new Clock();
		core.registerByCorners();
		touchCorners(
			core,
			[
				[500, 80],
				[800, 90],
				[810, 650],
				[490, 640],
			],
			clock,
		);
		expect(core.currentRegistration?.grid).toEqual({ cols: 84, rows: 118 });
		expect(core.currentGrid).toEqual({ cols: 84, rows: 118 });
	});

	it('points: col/row/u/v of the cell under the fingertip, surface rect, never inBorder', () => {
		const { core, ev, clock } = registered();
		const P = homography4(RECT_PLANE(118, 84), SHEET);
		for (const [c, r] of [
			[59, 41],
			[0, 0],
			[117, 83],
		]) {
			const [x, y] = applyH(P, [c, r]);
			run(core, pointAt(x, y), clock, 10);
			expect(ev.point.at(-1)).toMatchObject({ surface: 'rect', col: c, row: r, inBorder: false });
			expect(ev.point.at(-1)?.u).toBeCloseTo((c + 0.5) / 118, 12);
			expect(ev.point.at(-1)?.v).toBeCloseTo((r + 0.5) / 84, 12);
			run(core, null, clock, 8);
		}
		expect(ev.leave.at(-1)?.reason).toBe('not-pointing');
		// Off the sheet: CamIO's index-visible filter drops the hand (exploring), so the point is left.
		const [x0, y0] = applyH(P, [59, 41]);
		run(core, pointAt(x0, y0), clock, 10);
		const [x1, y1] = applyH(P, [140, 41]);
		run(core, pointAt(x1, y1), clock, 10);
		expect(ev.leave.at(-1)?.reason).toBe('not-pointing');
		expect(core.getStatus()).toMatchObject({ gesture: 'exploring', pointing: false });
	});

	it('corners in the wrong order → cornersRejected, then a restart from the top-left', () => {
		const fake = fakeTracker();
		const core = new PointerCore({ surface: { kind: 'rect' }, tracker: fake.tracker });
		const ev = record(core);
		const clock = new Clock();
		core.registerByCorners();
		const [a, b, c, d] = SHEET;
		touchCorners(core, [a, d, c, b], clock);
		expect(core.currentPhase).toBe('corners');
		expect(core.getStatus().cornersLocked).toBe(0);
		expect(ev.cue.at(-1)?.code).toBe('reject');
		const rej = ev.prompt.find((p) => p.code === 'register.cornersRejected');
		expect(rej?.params).toEqual({ reason: 'not-convex-clockwise' });
		expect(rej?.text).toBe('Corners not usable. Try again.');
		expect(ev.prompt.at(-1)?.code).toBe('register.corner.topLeft');
		// A tiny quad (< 1 % of the frame) is rejected too.
		ev.prompt.length = 0;
		touchCorners(
			core,
			[
				[600, 300],
				[680, 300],
				[680, 380],
				[600, 380],
			],
			clock,
		);
		expect(ev.prompt.find((p) => p.code === 'register.cornersRejected')?.params).toEqual({ reason: 'too-small' });
		expect(core.currentRegistration).toBeNull();
	});

	it('autoRegister() is unsupported: null + an error; confirmTopLeft() is a no-op', async () => {
		const core = new PointerCore({ surface: { kind: 'rect' }, tracker: fakeTracker().tracker });
		const ev = record(core);
		expect(await core.autoRegister()).toBeNull();
		expect(ev.error).toEqual([expect.objectContaining({ code: 'autoRegister.unsupported' })]);
		expect(core.currentPhase).toBe('idle');
		core.confirmTopLeft();
		expect(core.currentPhase).toBe('idle');
	});

	it("tracker 'loading': status tracking 'loading', points still emitted with the registration pose", () => {
		const { core, ev, clock } = registered('loading');
		expect(core.getStatus().tracking).toBe('loading');
		const P = homography4(RECT_PLANE(118, 84), SHEET);
		const [x, y] = applyH(P, [30, 20]);
		run(core, pointAt(x, y), clock, 10);
		expect(core.getStatus().tracking).toBe('loading');
		expect(ev.point.at(-1)).toMatchObject({ col: 30, row: 20 });
	});

	it("tracker 'blank' with no hands for 2 s → tracking.surface.static once; points still emitted", () => {
		const { core, ev, clock, fake } = registered('blank');
		fake.script.reason = 'low-texture';
		run(core, null, clock, 90);
		expect(ev.prompt.filter((p) => p.code === 'tracking.surface.static').length).toBe(1);
		expect(ev.prompt.find((p) => p.code === 'tracking.surface.static')?.text).toBe('Too plain to follow. Keep it still.');
		expect(core.getStatus().tracking).toBe('static');
		const P = homography4(RECT_PLANE(118, 84), SHEET);
		const [x, y] = applyH(P, [10, 70]);
		run(core, pointAt(x, y), clock, 10);
		expect(ev.point.at(-1)).toMatchObject({ col: 10, row: 70 });
	});

	it('an OpenCV failure reported by the tracker is forwarded once as an error', () => {
		const { core, ev, clock, fake } = registered('blank');
		fake.script.reason = 'opencv-unavailable';
		run(core, null, clock, 20);
		expect(ev.error.filter((e) => e.code === 'opencv.load').length).toBe(1);
	});

	it('the tracker moves the pose → points follow the moved sheet', () => {
		const { core, ev, clock, fake } = registered('tracking');
		const shift: Mat3 = [
			[1, 0, 40],
			[0, 1, -25],
			[0, 0, 1],
		];
		const mul = (A: Mat3, B: Mat3): Mat3 => A.map((row) => [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));
		fake.script.move = (Hp) => mul(shift, Hp);
		run(core, null, clock, 3);
		const P = mul(shift, homography4(RECT_PLANE(118, 84), SHEET));
		const [x, y] = applyH(P, [80, 12]);
		run(core, pointAt(x, y), clock, 10);
		expect(ev.point.at(-1)).toMatchObject({ col: 80, row: 12 });
		expect(ev.moved.length).toBe(0);
		expect(core.getStatus().tracking).toBe('tracking');
	});

	it('setSurface: resets, resolves a pending register() with null, disposes the old tracker, pushes the new surface', async () => {
		const made: ReturnType<typeof fakeTracker>[] = [];
		const factory = (_p: SurfaceProfile) => {
			const f = fakeTracker();
			made.push(f);
			return f.tracker;
		};
		const core = new PointerCore({ surface: { kind: 'rect' }, tracker: factory });
		const ev = record(core);
		const clock = new Clock();
		const p = core.register();
		run(core, pointAt(SHEET[0][0], SHEET[0][1]), clock, 60, () => core.getStatus().cornersLocked > 0);
		expect(core.getStatus().cornersLocked).toBe(1);
		core.setSurface({ kind: 'dotpad' });
		expect(await p).toBeNull();
		expect(made.length).toBe(2);
		expect(made[0].calls.dispose).toBe(1);
		expect(core.tracker).toBe(made[1].tracker);
		expect(core.surface).toBe('dotpad');
		expect(core.currentGrid).toEqual({ cols: 60, rows: 40 });
		expect(ev.status.at(-1)).toMatchObject({ surface: 'dotpad', phase: 'idle', registered: false, cornersLocked: 0 });
		// And back: a rect registration again works end to end.
		core.setSurface({ kind: 'rect' });
		expect(made[1].calls.dispose).toBe(1);
		const again = core.register();
		touchCorners(core, SHEET, clock);
		expect((await again)?.surface).toBe('rect');
	});

	it('a static tracking spec uses the static tracker (blank) without a tracker override', () => {
		const core = new PointerCore({ surface: { kind: 'rect', tracking: 'static' } });
		const ev = record(core);
		const clock = new Clock();
		core.registerByCorners();
		touchCorners(core, SHEET, clock);
		expect(core.currentPhase).toBe('ready');
		run(core, null, clock, 90);
		expect(ev.prompt.filter((p) => p.code === 'tracking.surface.static').length).toBe(1);
	});
});
