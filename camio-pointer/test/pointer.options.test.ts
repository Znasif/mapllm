/**
 * The pointer's OpenCV options → the rect tracker's engine (no camera: the
 * core is driven directly). The tracker is prepared by start() / setSurface();
 * here core.tracker.prepare() stands in for it.
 */
import { describe, expect, it } from 'vitest';
import type { AkazeEngine, AkazeEngineOptions } from '../src/akaze';
import type { Point } from '../src/geometry';
import { createCamioPointer } from '../src/pointer';
import { lumaFrame } from '../src/tracker';

const W = 64;
const H = 48;
const frame = () => lumaFrame({ data: new Uint8Array(W * H), width: W, height: H });
const QUAD: Point[] = [
	[10, 8],
	[50, 9],
	[52, 40],
	[9, 38],
];
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const engine = (keypoints: number, log: string[]): AkazeEngine => ({
	setReference: (_g, _w, _h, quad) => {
		log.push(`reference ${quad ? 'masked' : 'whole'}`);
		return Promise.resolve({ keypoints });
	},
	match: () => Promise.resolve({ H: [1, 0, 0, 0, 1, 0, 0, 0, 1], good: 20, inliers: 12 }),
	dispose: () => log.push('dispose'),
});

describe('createCamioPointer OpenCV options', () => {
	it('opencvEngine + akaze options reach the rect tracker; nothing loads until prepare', async () => {
		const seen: AkazeEngineOptions[] = [];
		const log: string[] = [];
		const p = createCamioPointer({
			surface: { kind: 'rect' },
			opencvEngine: (o) => {
				seen.push(o);
				return Promise.resolve(engine(9, log));
			},
			akaze: { minInliers: 10, referenceMask: 'none', ratio: 0.7 },
		});
		expect(seen).toEqual([]);
		p.core.tracker.prepare?.();
		await tick();
		expect(seen).toEqual([{ ratio: 0.7, ransacPx: 8 }]);
		// Registered without a frame: the reference comes from the next hands-off frame.
		p.core.setRegistration(QUAD, { width: W, height: H });
		for (let k = 0; k < 4; k++) p.core.processFrame(frame(), null, 33 * k);
		await tick();
		expect(log).toEqual(['reference whole']);
		p.core.processFrame(frame(), null, 200);
		// 9 reference keypoints < minInliers 10 → blank.
		expect(p.core.tracker.state).toBe('blank');
		p.dispose();
		expect(log.at(-1)).toBe('dispose');
	});

	it('no opencvUrl / opencvEngine: a rect registration still works, then one opencv.load error', async () => {
		const p = createCamioPointer({ surface: { kind: 'rect' } });
		const errors: string[] = [];
		p.on('error', (e) => errors.push(e.code));
		p.core.tracker.prepare?.();
		const reg = p.core.setRegistration(QUAD, { width: W, height: H });
		expect(reg?.surface).toBe('rect');
		const prompts: string[] = [];
		p.on('prompt', (e) => prompts.push(e.code));
		for (let k = 0; k < 120; k++) p.core.processFrame(frame(), null, 33 * k);
		expect(errors).toEqual(['opencv.load']);
		// Not followed: after the blank delay, 'static' and its prompt, once.
		expect(p.status.tracking).toBe('static');
		expect(prompts).toEqual(['tracking.surface.static']);
		p.dispose();
	});

	it("a DOT Pad pointer never asks for OpenCV", () => {
		let calls = 0;
		const p = createCamioPointer({ surface: { kind: 'dotpad' }, opencvEngine: () => (calls++, Promise.reject(new Error('x'))) });
		p.core.tracker.prepare?.();
		expect(calls).toBe(0);
		p.dispose();
	});
});
