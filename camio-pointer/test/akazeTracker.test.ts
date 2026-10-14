/**
 * The AKAZE tracker's logic over a scripted fake engine (no OpenCV): loading,
 * the reference hand-off, the 6-frame cadence, the starter's acceptance rule
 * with 7 s staleness, pose composition, the blank / occluded states, clear()
 * and dispose(). Then the worker protocol over a fake `self` and a fake `cv`
 * that records every Mat / vector: everything allocated is deleted.
 */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type AkazeEngine, type AkazeEngineOptions, type AkazeMatch, akazeWorkerMain, akazeWorkerSource, createAkazeEngine, createAkazeWorkerEngine } from '../src/akaze';
import { createAkazeTracker } from '../src/akazeTracker';
import { PointerCore } from '../src/core';
import { type Mat3, type Point, applyH, homography4 } from '../src/geometry';
import { type LumaFrame, lumaFrame } from '../src/tracker';
import { createFakeCv } from './fixtures/fakeCv';

const W = 64;
const H = 48;
const frame = (v = 0): LumaFrame => lumaFrame({ data: new Uint8Array(W * H).fill(v), width: W, height: H });
const REGION: Point[] = [
	[10, 8],
	[50, 9],
	[52, 40],
	[9, 38],
];
const POSE0: Mat3 = homography4(
	[
		[-0.5, -0.5],
		[9.5, -0.5],
		[9.5, 7.5],
		[-0.5, 7.5],
	],
	REGION,
);
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** A scripted engine: setReference answers `keypoints`; each match waits for the test to answer it. */
function fakeEngine(keypoints = 100) {
	const calls = { refs: [] as Array<{ width: number; height: number; quad: number[] | null; first: number }>, matches: 0, dispose: 0 };
	const pending: Array<ReturnType<typeof deferred<AkazeMatch>>> = [];
	const engine: AkazeEngine = {
		setReference(gray, width, height, quad) {
			calls.refs.push({ width, height, quad, first: gray[0] });
			return Promise.resolve({ keypoints });
		},
		match() {
			calls.matches++;
			const d = deferred<AkazeMatch>();
			pending.push(d);
			return d.promise;
		},
		dispose() {
			calls.dispose++;
		},
	};
	/** Answer the oldest pending match. */
	const answer = (m: AkazeMatch) => {
		const d = pending.shift();
		if (!d) throw new Error('no match in flight');
		d.resolve(m);
	};
	return { engine, calls, pending, answer };
}

const shift = (dx: number, dy: number): number[] => [1, 0, dx, 0, 1, dy, 0, 0, 1];

function setup(opts: { keypoints?: number; referenceMask?: 'surface' | 'none' } = {}) {
	const fe = fakeEngine(opts.keypoints);
	const load = deferred<AkazeEngine>();
	const seen: AkazeEngineOptions[] = [];
	const tracker = createAkazeTracker({
		loadEngine: (o) => {
			seen.push(o);
			return load.promise;
		},
		referenceMask: opts.referenceMask,
	});
	let t = 0;
	const update = (handsPresent = false, f = frame()) => tracker.update(f, { handsPresent, now: (t += 33) });
	return { tracker, fe, load, seen, update, at: (ms: number) => (t = ms) };
}

describe('createAkazeTracker (fake engine)', () => {
	it('loading until the engine is ready; the reference taken while loading is sent on ready; then tracking', async () => {
		const { tracker, fe, load, seen, update } = setup();
		tracker.prepare?.();
		const s0 = tracker.reset(POSE0, frame(7), { handsPresent: false, now: 0, region: REGION });
		expect(s0).toMatchObject({ state: 'loading', accepted: true, pose: POSE0 });
		expect(update().state).toBe('loading');
		expect(fe.calls.refs.length).toBe(0);
		load.resolve(fe.engine);
		await tick();
		expect(seen).toEqual([{ ratio: 0.75, ransacPx: 8 }]);
		expect(fe.calls.refs).toEqual([{ width: W, height: H, quad: REGION.flat(), first: 7 }]);
		const s = update();
		expect(s.state).toBe('tracking');
		expect(s.visible).toBe(100);
		expect(tracker.pose).toEqual(POSE0);
	});

	it("referenceMask 'none' (starter verbatim) sends no quad", async () => {
		const { tracker, fe, load } = setup({ referenceMask: 'none' });
		load.resolve(fe.engine);
		tracker.reset(POSE0, frame(), { region: REGION });
		await tick();
		expect(fe.calls.refs[0].quad).toBeNull();
	});

	it('a match is posted every 6 update calls, never while one is in flight', async () => {
		const { tracker, fe, load, update } = setup();
		load.resolve(fe.engine);
		tracker.reset(POSE0, frame(), { region: REGION, now: 0 });
		await tick();
		for (let k = 0; k < 5; k++) update();
		expect(fe.calls.matches).toBe(0);
		update();
		expect(fe.calls.matches).toBe(1);
		for (let k = 0; k < 20; k++) update();
		expect(fe.calls.matches).toBe(1);
		fe.answer({ H: shift(1, 0), good: 30, inliers: 20 });
		await tick();
		update(); // applies the result and, 21 calls after the last post, posts the next
		expect(fe.calls.matches).toBe(2);
	});

	it("acceptance: 7 inliers rejected; ≥ 8 and ≥ best accepted; a weaker fit waits until the best is 7 s stale", async () => {
		const { tracker, fe, load, update, at } = setup();
		load.resolve(fe.engine);
		tracker.reset(POSE0, frame(), { region: REGION, now: 0 });
		await tick();
		const cycle = async (m: AkazeMatch, t: number) => {
			while (fe.pending.length === 0) update();
			fe.answer(m);
			await tick();
			at(t - 33);
			return update();
		};
		let s = await cycle({ H: shift(5, 0), good: 20, inliers: 7 }, 1000);
		expect(s).toMatchObject({ state: 'occluded', accepted: false, inliers: 7, found: 20 });
		expect(tracker.pose).toEqual(POSE0);
		s = await cycle({ H: shift(5, 0), good: 40, inliers: 30 }, 2000);
		expect(s).toMatchObject({ state: 'tracking', accepted: true });
		s = await cycle({ H: shift(9, 0), good: 30, inliers: 20 }, 5000);
		expect(s).toMatchObject({ state: 'occluded', accepted: false });
		s = await cycle({ H: shift(9, 0), good: 30, inliers: 20 }, 8999);
		expect(s.accepted).toBe(false);
		s = await cycle({ H: shift(9, 0), good: 30, inliers: 20 }, 9001);
		expect(s).toMatchObject({ state: 'tracking', accepted: true, relocked: false });
		// pose = Hfwd · pose0: the registered corners projected through Hfwd.
		const P = tracker.pose as Mat3;
		const c = applyH(P, [-0.5, -0.5]);
		expect(c[0]).toBeCloseTo(REGION[0][0] + 9, 9);
		expect(c[1]).toBeCloseTo(REGION[0][1], 9);
		expect(tracker.debug?.found[2][0]).toBeCloseTo(REGION[2][0] + 9, 9);
		// No homography at all (too few good matches): rejected, pose held.
		s = await cycle({ H: null, good: 3, inliers: 0 }, 9500);
		expect(s.state).toBe('occluded');
		expect(tracker.pose).toBe(P);
	});

	it('reference keypoints < 8 → blank / low-texture, and no matching', async () => {
		const { tracker, fe, load, update } = setup({ keypoints: 7 });
		load.resolve(fe.engine);
		tracker.reset(POSE0, frame(), { region: REGION });
		await tick();
		let s = update();
		for (let k = 0; k < 12; k++) s = update();
		expect(s).toMatchObject({ state: 'blank', reason: 'low-texture' });
		expect(fe.calls.matches).toBe(0);
		expect(tracker.pose).toEqual(POSE0);
	});

	it('engine load failure → blank / opencv-unavailable; the core forwards one opencv.load error', async () => {
		const tracker = createAkazeTracker({ loadEngine: () => Promise.reject(new Error('no wasm')) });
		tracker.reset(POSE0, frame(), { region: REGION });
		await tick();
		expect(tracker.update(frame(), {}).state).toBe('blank');
		expect(tracker.update(frame(), {}).reason).toBe('opencv-unavailable');
		expect(createAkazeTracker({}).reset(POSE0).reason).toBe('opencv-unavailable');

		const core = new PointerCore({ surface: { kind: 'rect' }, trackerEnv: { loadEngine: () => Promise.reject(new Error('no wasm')) } });
		const errors: string[] = [];
		core.on('error', (e) => errors.push(e.code));
		core.tracker.prepare?.();
		await tick();
		core.setRegistration(REGION, { width: W, height: H });
		for (let k = 0; k < 10; k++) core.processFrame(frame(), null, 33 * k);
		expect(errors).toEqual(['opencv.load']);
	});

	it('a frameless reset takes the reference from the first hands-off frame', async () => {
		const { tracker, fe, load, update } = setup();
		load.resolve(fe.engine);
		await tick();
		tracker.reset(POSE0, undefined, { region: REGION });
		await tick();
		expect(fe.calls.refs.length).toBe(0);
		update(true, frame(3));
		expect(fe.calls.refs.length).toBe(0);
		expect(update(false, frame(9)).state).toBe('loading');
		await tick();
		expect(fe.calls.refs.map((r) => r.first)).toEqual([9]);
		expect(update().state).toBe('tracking');
	});

	it('clear() (and a new reset) ignores stale in-flight results', async () => {
		const { tracker, fe, load, update } = setup();
		load.resolve(fe.engine);
		tracker.reset(POSE0, frame(), { region: REGION, now: 0 });
		await tick();
		while (fe.pending.length === 0) update();
		tracker.clear();
		expect(tracker.pose).toBeNull();
		tracker.reset(POSE0, frame(), { region: REGION, now: 0 });
		fe.answer({ H: shift(20, 0), good: 50, inliers: 40 });
		await tick();
		const s = update();
		expect(s.accepted).toBe(false);
		expect(tracker.pose).toEqual(POSE0);
	});

	it('dispose() disposes the engine (also one that arrives after dispose)', async () => {
		const a = setup();
		a.load.resolve(a.fe.engine);
		a.tracker.prepare?.();
		await tick();
		a.tracker.dispose?.();
		expect(a.fe.calls.dispose).toBe(1);
		const b = setup();
		b.tracker.prepare?.();
		b.tracker.dispose?.();
		b.load.resolve(b.fe.engine);
		await tick();
		expect(b.fe.calls.dispose).toBe(1);
	});
});

/* ------------------------------------------------- worker protocol -- */

function fakeScope(cvOpts: Parameters<typeof createFakeCv> = [], { importFails = false, noCv = false } = {}) {
	const fake = createFakeCv(...cvOpts);
	const posted: Array<{ msg: { type: string; [k: string]: unknown }; transfer?: unknown[] }> = [];
	const scope = {
		cv: undefined as unknown,
		imported: [] as string[],
		closed: false,
		onmessage: null as null | ((e: { data: unknown }) => void),
		importScripts(url: string) {
			if (importFails) throw new Error('404');
			this.imported.push(url);
			if (!noCv) this.cv = fake.cv;
		},
		postMessage(msg: { type: string }, transfer?: unknown[]) {
			posted.push({ msg, transfer });
		},
		close() {
			this.closed = true;
		},
	};
	const send = (data: unknown) => scope.onmessage?.({ data });
	return { fake, scope, posted, send };
}

describe('AKAZE worker protocol (fake self + fake cv)', () => {
	const DIST = new URL('../dist/CamioPointer-0.2.0.js', import.meta.url);
	for (const how of ['akazeWorkerMain', 'serialised source', 'serialised source of the built bundle'] as const) {
		it.skipIf(how.endsWith('bundle') && !existsSync(DIST))(`${how}: queues until OpenCV is ready, answers reference / match, deletes every Mat`, async () => {
			const { fake, scope, posted, send } = fakeScope([{}, { ready: false }]);
			const opts = { ratio: 0.75, ransacPx: 8 };
			if (how === 'akazeWorkerMain') akazeWorkerMain(scope as never, createAkazeEngine, '/vendor/opencv/opencv.js', opts);
			else if (how === 'serialised source') new Function('self', akazeWorkerSource('/vendor/opencv/opencv.js', opts))(scope);
			else {
				const lib = (await import(/* @vite-ignore */ DIST.href)) as { akazeWorkerSource: typeof akazeWorkerSource };
				new Function('self', lib.akazeWorkerSource('/vendor/opencv/opencv.js', opts))(scope);
			}
			expect(scope.imported).toEqual(['/vendor/opencv/opencv.js']);
			// Not ready yet: the reference request is queued.
			send({ type: 'reference', id: 1, gray: new Uint8Array(W * H), width: W, height: H, quad: REGION.flat() });
			expect(posted).toEqual([]);
			fake.cv.finishLoading();
			expect(posted.map((p) => p.msg)).toEqual([{ type: 'ready' }, { type: 'reference', id: 1, keypoints: 50 }]);
			// D1 mask: zeros, the quad filled with 255.
			expect(fake.log).toContain('fillConvexPoly 255 on 0');
			send({ type: 'match', id: 2, gray: new Uint8Array(W * H), width: W, height: H });
			expect(posted.at(-1)?.msg).toEqual({ type: 'match', id: 2, H: [1, 0, 3, 0, 1, -2, 0, 0, 1], good: 20, inliers: 15 });
			expect(fake.log).toContain('findHomography 8 8');
			// Only the AKAZE detector, the matcher and the reference stay alive; dispose frees them.
			expect([...fake.live].map((o) => (o as { name: string }).name).sort()).toEqual(['AKAZE', 'BFMatcher', 'KeyPointVector', 'Mat']);
			send({ type: 'dispose' });
			expect(fake.live.size).toBe(0);
			expect(scope.closed).toBe(true);
			expect(fake.allocated()).toBeGreaterThan(10);
		});
	}

	it('too few good matches: no findHomography, H null; an empty reference answers without matching', () => {
		const { fake, scope, posted, send } = fakeScope([{ good: 7, bad: 3 }]);
		akazeWorkerMain(scope as never, createAkazeEngine, 'x', {});
		send({ type: 'match', id: 1, gray: new Uint8Array(W * H), width: W, height: H });
		expect(posted.at(-1)?.msg).toEqual({ type: 'match', id: 1, H: null, good: 0, inliers: 0 });
		send({ type: 'reference', id: 2, gray: new Uint8Array(W * H), width: W, height: H, quad: null });
		expect(fake.log.at(-1)).toBe(`detect ${W}x${H} mask none`);
		send({ type: 'match', id: 3, gray: new Uint8Array(W * H), width: W, height: H });
		expect(posted.at(-1)?.msg).toEqual({ type: 'match', id: 3, H: null, good: 7, inliers: 0 });
		expect(fake.log.some((l) => l.startsWith('findHomography'))).toBe(false);
		send({ type: 'dispose' });
		expect(fake.live.size).toBe(0);
	});

	it('scale 0.5: detects on the half-size grey, RANSAC at 4 px, H back in full-resolution px', () => {
		const { fake, scope, posted, send } = fakeScope([{ H: [1, 0, 3, 0, 1, -2, 0, 0, 1] }]);
		akazeWorkerMain(scope as never, createAkazeEngine, 'x', { scale: 0.5 });
		send({ type: 'reference', id: 1, gray: new Uint8Array(W * H), width: W, height: H, quad: REGION.flat() });
		send({ type: 'match', id: 2, gray: new Uint8Array(W * H), width: W, height: H });
		expect(fake.log).toContain(`detect ${W / 2}x${H / 2} mask ${W / 2}x${H / 2} fill 0`);
		expect(fake.log).toContain('findHomography 8 4');
		expect(posted.at(-1)?.msg).toMatchObject({ H: [1, 0, 6, 0, 1, -4, 0, 0, 1] });
		send({ type: 'dispose' });
		expect(fake.live.size).toBe(0);
	});

	it('importScripts failure or no cv → an error without id, later requests answered with errors', () => {
		for (const opt of [{ importFails: true }, { noCv: true }]) {
			const { scope, posted, send } = fakeScope([], opt);
			akazeWorkerMain(scope as never, createAkazeEngine, '/x.js', {});
			expect(posted[0].msg.type).toBe('error');
			expect(posted[0].msg.id).toBeUndefined();
			send({ type: 'match', id: 5, gray: new Uint8Array(4), width: 2, height: 2 });
			expect(posted.at(-1)?.msg).toMatchObject({ type: 'error', id: 5 });
		}
	});

	it('createAkazeWorkerEngine: transfers the grey buffers, resolves requests by id, rejects when loading fails', async () => {
		const transfers: unknown[][] = [];
		let scopeRef: ReturnType<typeof fakeScope> | null = null;
		const makeWorker = (source: string) => {
			const fs = fakeScope();
			scopeRef = fs;
			const worker = {
				onmessage: null as null | ((e: { data: unknown }) => void),
				onerror: null,
				terminated: false,
				postMessage(msg: unknown, transfer: unknown[] = []) {
					transfers.push(transfer);
					queueMicrotask(() => fs.send(msg));
				},
				terminate() {
					this.terminated = true;
				},
			};
			fs.scope.postMessage = (msg: { type: string }) => queueMicrotask(() => worker.onmessage?.({ data: msg }));
			queueMicrotask(() => new Function('self', source)(fs.scope));
			return worker as unknown as Worker;
		};
		const engine = await createAkazeWorkerEngine('/vendor/opencv/opencv.js', { ratio: 0.75, ransacPx: 8 }, makeWorker);
		const g1 = new Uint8Array(W * H);
		expect(await engine.setReference(g1, W, H, REGION.flat())).toEqual({ keypoints: 50 });
		const g2 = new Uint8Array(W * H);
		expect(await engine.match(g2, W, H)).toEqual({ H: [1, 0, 3, 0, 1, -2, 0, 0, 1], good: 20, inliers: 15 });
		expect(transfers).toEqual([[g1.buffer], [g2.buffer]]);
		engine.dispose();
		await tick();
		expect((scopeRef as unknown as ReturnType<typeof fakeScope>).fake.live.size).toBe(0);
		await expect(engine.match(new Uint8Array(4), 2, 2)).rejects.toThrow('disposed');

		const failing = (source: string) => {
			const fs = fakeScope([], { importFails: true });
			const worker = { onmessage: null as null | ((e: { data: unknown }) => void), onerror: null, postMessage() {}, terminate() {} };
			fs.scope.postMessage = (msg: { type: string }) => queueMicrotask(() => worker.onmessage?.({ data: msg }));
			queueMicrotask(() => new Function('self', source)(fs.scope));
			return worker as unknown as Worker;
		};
		await expect(createAkazeWorkerEngine('/missing.js', {}, failing)).rejects.toThrow('could not load /missing.js');
	});
});
