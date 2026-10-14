/**
 * Optional: the AKAZE engine + tracker on the REAL OpenCV.js
 * (@techstark/opencv-js 4.12.0-release.1) in Node, on synthetic frames
 * (test/fixtures/surfaces.mjs). Skipped when opencv.js is not installed.
 *
 *   1. a static surface stays at the identity;
 *   2. the surface slides 40 px and turns 5° on a still background, reference
 *      masked to the surface (D1, default): the corners follow (immediately or
 *      after the starter's 7 s staleness — logged);
 *   3. the same with referenceMask 'none' (the starter verbatim): the background
 *      outvotes the surface and Hfwd stays about the identity — why D1 exists;
 *   4. a blank sheet on a plain table: blank / low-texture.
 *
 * Loading: require() + waitForOpenCV — NEVER `await cv` (the Emscripten module
 * is a thenable that never settles).
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { type AkazeEngine, createAkazeEngine, createInlineAkazeEngine } from '../src/akaze';
import { createAkazeTracker } from '../src/akazeTracker';
import { type Mat3, type Point, applyH, homography4, maxCornerDist } from '../src/geometry';
import { type CvLike, waitForOpenCV } from '../src/opencv';
import { type LumaFrame, lumaFrame } from '../src/tracker';
// @ts-ignore — plain JS fixture
import { mapTexture, placement, renderSurface, tableBackground } from './fixtures/surfaces.mjs';

const candidates = [
	process.env.CAMIO_OPENCV_JS,
	fileURLToPath(new URL('../node_modules/@techstark/opencv-js/dist/opencv.js', import.meta.url)),
	fileURLToPath(new URL('../../starter/node_modules/@techstark/opencv-js/dist/opencv.js', import.meta.url)),
].filter(Boolean) as string[];
const OPENCV_JS = candidates.find((p) => existsSync(p));

const W = 1280;
const H = 720;
const COLS = 118;
const ROWS = 84;
const PLANE: Point[] = [
	[-0.5, -0.5],
	[COLS - 0.5, -0.5],
	[COLS - 0.5, ROWS - 0.5],
	[-0.5, ROWS - 0.5],
];
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
type Img = { data: Uint8Array; width: number; height: number; corners: number[][] };

describe.skipIf(!OPENCV_JS)('AKAZE engine on real OpenCV.js (optional)', () => {
	let cv: CvLike;
	beforeAll(async () => {
		const t0 = performance.now();
		cv = createRequire(import.meta.url)(OPENCV_JS as string);
		await waitForOpenCV(cv);
		console.log(`opencv.js ready in ${(performance.now() - t0).toFixed(0)} ms (${OPENCV_JS})`);
	});

	const texture = mapTexture(594, 420, 11);
	// A cluttered table: more features off the sheet than on it (≈ 3,000 vs 2,600), as a real desk/room view.
	const table = tableBackground(W, H, 5, { clutter: 1500 });
	const P0 = placement(texture, 1.1, 0, 640, 360);
	const frame0 = renderSurface(texture, P0, table) as Img;
	// Slide 40 px (30 right, 26 down) and turn 5° about the sheet centre.
	const P1 = placement(texture, 1.1, 5, 670, 386);
	const frame1 = renderSurface(texture, P1, table) as Img;

	const engineFor = () => () => createInlineAkazeEngine(() => Promise.resolve({ cv }), {});
	const lf = (img: Img): LumaFrame => lumaFrame(img);
	const projected = (pose: Mat3) => PLANE.map((p) => applyH(pose, p));

	async function start(referenceMask: 'surface' | 'none', img: Img) {
		const tracker = createAkazeTracker({ loadEngine: engineFor(), referenceMask });
		tracker.prepare?.();
		await tick();
		await tick();
		const pose0 = homography4(PLANE, img.corners as Point[]);
		const t0 = performance.now();
		tracker.reset(pose0, lf(img), { handsPresent: false, now: 0, region: img.corners as Point[] });
		const refMs = performance.now() - t0;
		await tick();
		return { tracker, refMs };
	}

	/** Run update calls `dt` ms apart; stop early when `until` holds. Returns the virtual time and the last step. */
	async function drive(tracker: ReturnType<typeof createAkazeTracker>, img: Img, from: number, n: number, dt: number, until: () => boolean = () => false) {
		let t = from;
		let step = tracker.update(lf(img), { handsPresent: false, now: t });
		for (let k = 1; k < n && !until(); k++) {
			t += dt;
			step = tracker.update(lf(img), { handsPresent: false, now: t });
			await tick();
		}
		return { t, step };
	}

	it('timing (logged, no assertion): detectAndCompute and knnMatch at 1280 × 720', () => {
		const ak = new cv.AKAZE();
		const bf = new cv.BFMatcher(cv.NORM_HAMMING, false);
		const g = cv.matFromArray(H, W, cv.CV_8UC1, frame0.data);
		const none = new cv.Mat();
		const kp1 = new cv.KeyPointVector();
		const d1 = new cv.Mat();
		let t = performance.now();
		ak.detectAndCompute(g, none, kp1, d1);
		const tDetect = performance.now() - t;
		const g2 = cv.matFromArray(H, W, cv.CV_8UC1, frame1.data);
		const kp2 = new cv.KeyPointVector();
		const d2 = new cv.Mat();
		ak.detectAndCompute(g2, none, kp2, d2);
		const knn = new cv.DMatchVectorVector();
		t = performance.now();
		bf.knnMatch(d1, d2, knn, 2);
		const tKnn = performance.now() - t;
		console.log(`detectAndCompute ${tDetect.toFixed(0)} ms (${kp1.size()} keypoints); knnMatch ${kp1.size()} × ${kp2.size()} ${tKnn.toFixed(0)} ms`);
		for (const m of [g, none, kp1, d1, g2, kp2, d2, knn, ak, bf]) m.delete();
		// One engine match (masked reference, as the tracker runs it) at full and half resolution.
		for (const scale of [1, 0.5]) {
			const e = createAkazeEngine(cv, { scale });
			e.setReference(new Uint8Array(frame0.data), W, H, (frame0.corners as Point[]).flat());
			const t0 = performance.now();
			const m = e.match(new Uint8Array(frame1.data), W, H);
			console.log(`engine match, masked reference, scale ${scale}: ${(performance.now() - t0).toFixed(0)} ms (good ${m.good}, inliers ${m.inliers})`);
			e.dispose();
		}
	});

	it('1. a static surface stays at the identity (corner error < 2 px)', async () => {
		const { tracker, refMs } = await start('surface', frame0);
		const t0 = performance.now();
		const { step } = await drive(tracker, frame0, 33, 13, 33);
		console.log(`reference (masked) ${refMs.toFixed(0)} ms, ${step.visible} keypoints; 2 matches ${(performance.now() - t0).toFixed(0)} ms; last: good ${step.found}, inliers ${step.inliers}`);
		expect(step.state).toBe('tracking');
		expect(step.inliers).toBeGreaterThanOrEqual(8);
		expect(maxCornerDist(projected(tracker.pose as Mat3), frame0.corners)).toBeLessThan(2);
		tracker.dispose?.();
	});

	it("2. slide 40 px + turn 5° on a still background, referenceMask 'surface': the corners follow (< 6 px)", async () => {
		const { tracker } = await start('surface', frame0);
		const s = await drive(tracker, frame0, 33, 13, 33);
		const moveAt = s.t;
		const err = () => maxCornerDist(projected(tracker.pose as Mat3), frame1.corners);
		const m = await drive(tracker, frame1, moveAt + 200, 70, 200, () => err() < 6);
		const after = m.t - moveAt;
		console.log(`masked reference: followed ${after <= 7000 ? 'IMMEDIATELY (< 7 s)' : 'AFTER the 7 s staleness'} — ${(after / 1000).toFixed(1)} s virtual after the move; error ${err().toFixed(2)} px; last good ${m.step.found}, inliers ${m.step.inliers}`);
		expect(err()).toBeLessThan(6);
		tracker.dispose?.();
	});

	it("3. the same with referenceMask 'none' (starter verbatim): the background outvotes the surface, Hfwd stays ≈ identity", async () => {
		const { tracker } = await start('none', frame0);
		const s = await drive(tracker, frame0, 33, 13, 33);
		const m = await drive(tracker, frame1, s.t + 200, 70, 200);
		const toOld = maxCornerDist(projected(tracker.pose as Mat3), frame0.corners);
		const toNew = maxCornerDist(projected(tracker.pose as Mat3), frame1.corners);
		console.log(`unmasked reference: ${((m.t - s.t) / 1000).toFixed(1)} s after the move the corners are ${toOld.toFixed(2)} px from the OLD place, ${toNew.toFixed(1)} px from the true one; last good ${m.step.found}, inliers ${m.step.inliers}`);
		expect(toOld).toBeLessThan(4);
		expect(toNew).toBeGreaterThan(30);
		tracker.dispose?.();
	});

	it('4. a blank sheet on a table of the same grey → blank / low-texture', async () => {
		const sheet = mapTexture(594, 420, 1, { blank: true });
		const blank = renderSurface(sheet, P0, tableBackground(W, H, 1, { plain: true, level: 232 })) as Img;
		const { tracker } = await start('surface', blank);
		const { step } = await drive(tracker, blank, 33, 8, 33);
		expect(step).toMatchObject({ state: 'blank', reason: 'low-texture' });
		tracker.dispose?.();
		// For the record: a blank sheet on a darker plain table keeps its outline's keypoints (not blank).
		const outlined = renderSurface(sheet, P0, tableBackground(W, H, 1, { plain: true, level: 110 })) as Img;
		const o = await start('surface', outlined);
		const s2 = await drive(o.tracker, outlined, 33, 8, 33);
		console.log(`blank sheet: ${step.visible} reference keypoints on a same-grey table; ${s2.step.visible} on a darker table (state ${s2.step.state}, inliers ${s2.step.inliers})`);
		o.tracker.dispose?.();
	});

	it('engine: a masked reference only finds keypoints on the surface', async () => {
		const engine: AkazeEngine = await engineFor()();
		const masked = await engine.setReference(new Uint8Array(frame0.data), W, H, (frame0.corners as Point[]).flat());
		const whole = await engine.setReference(new Uint8Array(frame0.data), W, H, null);
		console.log(`reference keypoints: masked ${masked.keypoints}, whole frame ${whole.keypoints}`);
		expect(masked.keypoints).toBeGreaterThan(50);
		expect(masked.keypoints).toBeLessThan(whole.keypoints);
		engine.dispose();
	});
});
