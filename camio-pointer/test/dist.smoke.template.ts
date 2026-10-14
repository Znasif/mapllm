import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Smoke test for the vendored CamioPointer __CAMIO_VERSION__ bundle. Self-contained:
// it draws its own synthetic DOT Pad, so it needs no fixtures or camera.

const FILE = '__CAMIO_FILE__';
type Lib = typeof import('__CAMIO_FILE__');
type Pt = [number, number];

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

/** Pin (c, r) → px for a frontal pad with a slight rotation. */
function padPose(pitch: number, ox: number, oy: number, deg: number) {
	const a = (deg * Math.PI) / 180;
	const c = Math.cos(a) * pitch;
	const s = Math.sin(a) * pitch;
	return [
		[c, -s, ox],
		[s, c, oy],
		[0, 0, 1],
	];
}

/**
 * A synthetic DOT Pad: dark body, light display window ~4.5 pitches around
 * the 60 × 40 bright pins, and a braille-like text line below (so the
 * orientation is decidable without a confirm touch).
 */
function renderPad(W: number, H: number, pose: number[][]) {
	const [[a, b, tx], [c, d, ty]] = pose;
	const det = a * d - b * c;
	const out = new Uint8Array(W * H);
	const textDots = new Set<string>();
	let seed = 7;
	const rnd = () => {
		seed = (seed * 16807) % 2147483647;
		return seed / 2147483647;
	};
	for (let cell = 0; cell < 17; cell++)
		for (let i = 0; i < 2; i++)
			for (let j = 0; j < 4; j++)
				if (rnd() < 0.6) textDots.add(`${2 + Math.round(cell * 3.3) + i},${58 + j}`);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const u = (d * (x - tx) - b * (y - ty)) / det;
			const v = (-c * (x - tx) + a * (y - ty)) / det;
			let g = 90;
			if (u > -8 && u < 67 && v > -8 && v < 66) g = 45; // body
			const inWindow = u > -4.5 && u < 63.5 && v > -4.5 && v < 43.5;
			const inText = u > -4.5 && u < 63.5 && v > 56.5 && v < 62.5;
			if (inWindow || inText) {
				g = 150;
				const ci = Math.round(u);
				const ri = Math.round(v);
				const dd = Math.hypot(u - ci, v - ri);
				const pin = inWindow && ci >= 0 && ci < 60 && ri >= 0 && ri < 40;
				if ((pin || (inText && textDots.has(`${ci},${ri}`))) && dd < 0.3) g = 235;
			}
			out[y * W + x] = g;
		}
	return { data: out, width: W, height: H };
}

/** 21 MediaPipe landmarks of a pointing hand whose index tip is at (x, y) px. */
function pointingHand(x: number, y: number, W: number, H: number) {
	const L: Array<{ x: number; y: number; z: number }> = [];
	const p = (px: number, py: number) => ({ x: px / W, y: py / H, z: 0 });
	L[0] = p(x + 10, y + 110);
	for (let k = 1; k <= 4; k++) L[k] = p(x - 30 + 4 * k, y + 90 - 8 * k); // thumb
	for (let k = 0; k < 4; k++) L[5 + k] = p(x, y + 60 - 20 * k); // index: straight, tip at (x, y)
	const curled = (mcp: number, dx: number) => {
		L[mcp] = p(x + dx, y + 62);
		L[mcp + 1] = p(x + dx, y + 47);
		L[mcp + 2] = p(x + dx + 4, y + 55);
		L[mcp + 3] = p(x + dx + 2, y + 64);
	};
	curled(9, 14);
	curled(13, 26);
	curled(17, 37);
	return { landmarks: [L] };
}

describe('vendored CamioPointer __CAMIO_VERSION__', () => {
	it('touches no camera, DOM or network on import and construction', async () => {
		const getUserMedia = vi.fn();
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
		const createElement = typeof document !== 'undefined' ? vi.spyOn(document, 'createElement') : null;
		const lib: Lib = await import('__CAMIO_FILE__');
		const pointer = lib.createCamioPointer({ assetsBase: '/vendor/mediapipe/', surface: { kind: 'dotpad' } });
		expect(pointer.running).toBe(false);
		expect(getUserMedia).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
		if (createElement) expect(createElement).not.toHaveBeenCalled();
		pointer.dispose();
	});

	it('keeps MediaPipe’s WASM loader out of the bundler graph and ships no OpenCV', () => {
		const source = readFileSync(fileURLToPath(new URL(FILE, import.meta.url)), 'utf8');
		expect(source).toContain('/* webpackIgnore: true */');
		// OpenCV.js is loaded at run time (opencvUrl), never bundled: its UMD wrapper must be absent.
		expect(/root\.cv\s*=\s*factory\(\)/.test(source)).toBe(false);
	});

	it('switches surfaces: register() on a rect resolves null on setSurface; grids follow', async () => {
		const lib: Lib = await import('__CAMIO_FILE__');
		const pointer = lib.createCamioPointer({ surface: { kind: 'rect' }, opencvUrl: '/vendor/opencv/opencv.js', handLandmarker: async () => ({ detectForVideo: () => ({ landmarks: [] }) }) });
		expect(pointer.surface).toBe('rect');
		const pending = pointer.register();
		pointer.setSurface({ kind: 'dotpad' });
		expect(await pending).toBeNull();
		expect(pointer.surface).toBe('dotpad');
		expect(pointer.core.currentGrid).toEqual({ cols: 60, rows: 40 });
		pointer.dispose();
	});

	it('auto-registers a synthetic pad and reports the pointed pin', async () => {
		const lib: Lib = await import('__CAMIO_FILE__');
		const W = 640;
		const H = 480;
		const pose = padPose(6, 140, 110, 2);
		const img = renderPad(W, H, pose);
		const frame = lib.lumaFrame(img);
		const pointer = lib.createCamioPointer({ surface: { kind: 'dotpad' }, hysteresis: 0.35, handLandmarker: async () => ({ detectForVideo: () => ({ landmarks: [] }) }) });
		const pins: Array<{ col: number; row: number; inBorder: boolean }> = [];
		pointer.on('point', (e) => pins.push({ col: e.col, row: e.row, inBorder: e.inBorder }));
		const done = pointer.autoRegister();
		let now = 0;
		let registration: Awaited<typeof done> | undefined;
		void done.then((r) => {
			registration = r;
		});
		for (let k = 0; k < 400 && registration === undefined; k++) {
			pointer.processFrame(frame, null, (now += 33));
			await Promise.resolve();
		}
		expect(registration).toBeTruthy();
		expect(registration?.textFound).toBe(true);
		const at = (c: number, r: number): Pt => {
			const w = pose[2][0] * c + pose[2][1] * r + pose[2][2];
			return [(pose[0][0] * c + pose[0][1] * r + pose[0][2]) / w, (pose[1][0] * c + pose[1][1] * r + pose[1][2]) / w];
		};
		for (const [c, r] of [
			[10, 5],
			[1, 1],
		]) {
			const [x, y] = at(c, r);
			for (let k = 0; k < 15; k++) pointer.processFrame(frame, pointingHand(x, y, W, H), (now += 33));
		}
		expect(pins[0]).toEqual({ col: 10, row: 5, inBorder: false });
		expect(pins.at(-1)).toEqual({ col: 1, row: 1, inBorder: true });
		pointer.dispose();
	});
});
