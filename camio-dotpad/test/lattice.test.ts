/**
 * Lattice auto-find — ported from the starter's scripts/test_dotpad_lattice.mjs
 * (same cases and thresholds). Real frames are read from
 * starter/scripts/fixtures/dotpad_frames (override: CAMIO_DOTPAD_FRAMES).
 * Knobs: CAMIO_AUG=<augmented cases> (default 24), CAMIO_DISTRACTORS=<per kind> (default 4).
 */
import { describe, expect, it } from 'vitest';
import { applyH, fitHomography, invert3, rotateQuad } from '../src/geometry';
import { aggregateDetections, detectDotpadLattice, latticeDiagnostics } from '../src/lattice';
import * as realSet from './fixtures/realSet.mjs';
import * as scenes from './fixtures/scenes.mjs';

// The fixtures are plain JS; their inferred types are too narrow for these tests.
const { GT, augCase, pct, realLuma, score, unmap } = realSet as any;
const { cornersOf, erasePinField, renderDistractor, renderPad, rng, viewHomography } = scenes as any;

const N_AUG = +(process.env.CAMIO_AUG || 24);
const N_DIS = +(process.env.CAMIO_DISTRACTORS || 4);
const time = <T>(fn: () => T): [T, number] => {
	const t0 = performance.now();
	const r = fn();
	return [r, performance.now() - t0];
};

describe('maths', () => {
	it('fitHomography recovers a projective map from 300 noisy points', () => {
		const H = [
			[1.3, 0.2, 100],
			[-0.1, 0.9, 50],
			[0.0004, -0.0002, 1],
		];
		const rand = rng(7);
		const src: number[][] = [];
		const dst: number[][] = [];
		for (let k = 0; k < 300; k++) {
			const p = [rand.uni(0, 60), rand.uni(0, 40)];
			const q = applyH(H, p);
			src.push(p);
			dst.push([q[0] + 0.05 * rand.gauss(), q[1] + 0.05 * rand.gauss()]);
		}
		const F = fitHomography(src, dst) as number[][];
		const worst = Math.max(
			...[
				[0, 0],
				[59, 0],
				[59, 39],
				[0, 39],
			].map((p) => {
				const a = applyH(H, p);
				const b = applyH(F, p);
				return Math.hypot(a[0] - b[0], a[1] - b[1]);
			}),
		);
		expect(worst).toBeLessThan(0.05);
		const I = invert3(H);
		const p = applyH(I, applyH(H, [12.5, -3]));
		expect(Math.hypot(p[0] - 12.5, p[1] + 3)).toBeLessThan(1e-9);
		expect(fitHomography(src.slice(0, 3), dst.slice(0, 3))).toBeNull();
	});
});

describe('synthetic pads', () => {
	const cases = [
		{ name: 'frontal 0°', rot: 0, pitch: 7 },
		{ name: 'rotated 90°', rot: 90, pitch: 6.5 },
		{ name: 'rotated 180°', rot: 180, pitch: 6.5 },
		{ name: 'rotated 270°', rot: 270, pitch: 6.5 },
		{ name: 'rotated 33°, tilt 25°', rot: 33, tilt: 25, ax: 60, pitch: 6 },
		{ name: 'tilt 35° (strong perspective)', rot: 0, tilt: 35, ax: 0, pitch: 8 },
		{ name: 'gradient + left 4 columns washed out', rot: 0, pitch: 7, hideCols: 4, gain: [0.6, 1.4] },
		{ name: 'pitch 3.2 px at 640 × 480, tilt 20°', rot: 30, tilt: 20, pitch: 3.2, W: 640, H: 480 },
		{ name: 'pitch 20 px at 1920 × 1080', rot: 4, tilt: 10, pitch: 20, W: 1920, H: 1080, text: false },
		{ name: 'low light + noise', rot: 12, pitch: 7, gain: [0.3, 0.35], noise: 5 },
		{ name: 'display darker than the body', rot: 0, pitch: 7, windowGrey: 60, bodyGrey: 190, pinGrey: 170 },
		{ name: 'sparse map, lowered pins still visible', rot: 8, tilt: 10, pitch: 8, raisedFrac: 0.3, holeGrey: 190 },
		{ name: 'no text line → needsConfirm', rot: 0, pitch: 7, text: false, expectConfirm: true },
	];
	for (const c of cases as Array<Record<string, any>>) {
		it(c.name, () => {
			const W = c.W || 1280;
			const H = c.H || 720;
			const v = { width: W, height: H, pitchPx: c.pitch, rotDeg: c.rot, tiltDeg: c.tilt || 0, tiltAxisDeg: c.ax || 0, rand: rng(11) };
			const Hpin = viewHomography({ ...v, marginPins: 26 }) || viewHomography({ ...v, rand: rng(11) });
			const img = renderPad({
				width: W,
				height: H,
				Hpin,
				seed: 5,
				hideCols: c.hideCols,
				gain: c.gain,
				noise: c.noise ?? 2,
				windowGrey: c.windowGrey,
				bodyGrey: c.bodyGrey,
				pinGrey: c.pinGrey,
				raisedFrac: c.raisedFrac,
				holeGrey: c.holeGrey,
				text: c.text,
			});
			const [r, ms] = time(() => detectDotpadLattice(img));
			const s = score(r, cornersOf(Hpin));
			console.log(`${c.name}: ${s.found ? `max ${s.maxPins.toFixed(2)} pin, text ${r?.textFound}, ${ms.toFixed(0)} ms` : `null (${latticeDiagnostics.lastReason})`}`);
			expect(s.found).toBe(true);
			expect(s.maxPins).toBeLessThan(0.5);
			if (c.expectConfirm) expect(r?.needsConfirm).toBe(true);
			if (c.rot % 90 === 0 && !c.expectConfirm && c.text !== false && !c.tilt) {
				expect(r?.textFound).toBe(true);
				expect(s.orientationOk).toBe(true);
			}
			if (c.hideCols) expect(r?.added).toMatchObject({ left: c.hideCols, right: 0 });
		});
	}

	it('fail-safe: no guess when the evidence is not there', () => {
		const Hpin = viewHomography({ width: 1280, height: 720, pitchPx: 7, rotDeg: 5, rand: rng(3) });
		const gt = cornersOf(Hpin);
		for (const o of [{ hideCols: 12 }, { raisedFrac: 0.3, holesVisible: false }]) {
			const r = detectDotpadLattice(renderPad({ width: 1280, height: 720, Hpin, seed: 9, ...o }));
			expect(!r || score(r, gt).correct).toBe(true);
		}
		for (const [W, H, pitch] of [
			[640, 480, 3.2],
			[1280, 720, 7],
		]) {
			const Hp = viewHomography({ width: W, height: H, pitchPx: pitch, rotDeg: 30, tiltDeg: 20, rand: rng(3) });
			const r = detectDotpadLattice(renderPad({ width: W, height: H, Hpin: Hp, seed: 5, gain: [0.8, 1.3], noise: 3 }), { polarities: [-1] });
			expect(!r || score(r, cornersOf(Hp)).correct).toBe(true);
		}
	});
});

describe('distractors (no pad) are all rejected', () => {
	for (const kind of ['popit', 'grid-small', 'grid-large', 'grid-near', 'hex', 'braille', 'checker']) {
		it(`${kind} × ${N_DIS}`, () => {
			let fa = 0;
			for (let k = 0; k < N_DIS; k++) {
				const [W, H] = k % 2 ? [1280, 720] : [640, 480];
				if (detectDotpadLattice(renderDistractor(kind, { width: W, height: H, seed: 100 + 17 * k + kind.length }))) fa++;
			}
			expect(fa).toBe(0);
		});
	}
});

describe('real frames (ground_truth.json)', () => {
	for (const [file, g] of Object.entries(GT) as Array<[string, any]>) {
		it(`${file} [${g.split}]`, () => {
			const { img, f } = realLuma(file);
			const [r, ms] = time(() => detectDotpadLattice(img));
			const corners = r ? r.pinCorners.map(unmap(f)) : null;
			const s = score(r && { ...r, pinCorners: corners }, g.corners);
			console.log(`${file}: ${s.found ? `max ${s.maxPins.toFixed(2)} pin, text ${r?.textFound}, ${ms.toFixed(0)} ms` : `null (${latticeDiagnostics.lastReason})`}`);
			expect(s.found).toBe(true);
			expect(s.maxPins).toBeLessThanOrEqual(1);
			expect(s.orientationOk).toBe(true);
		});
	}
	it('the same frames with the pin field erased → null', () => {
		let fa = 0;
		for (const [file, g] of Object.entries(GT) as Array<[string, any]>) {
			const { img, map } = realLuma(file);
			if (detectDotpadLattice(erasePinField(img, g.corners.map(map)))) fa++;
		}
		expect(fa).toBe(0);
	});
});

describe(`augmented held-out set (report split, ${N_AUG} cases)`, () => {
	// One test per case (each a few seconds) so the worker never blocks for a minute.
	const rows: Array<Record<string, any>> = [];
	let negN = 0;
	let negFA = 0;
	for (let s = 0; s < N_AUG; s++) {
		it(`case ${s}`, () => {
			const c = augCase(s, 'report');
			if (!c) return;
			const [r, ms] = time(() => detectDotpadLattice(c.img));
			const sc = score(r, c.gt);
			rows.push({ ...sc, ms });
			// Per case: never a confident wrong answer.
			expect(sc.found && sc.falseAccept).toBeFalsy();
			if (s % 2 === 0) {
				negN++;
				if (detectDotpadLattice(erasePinField(c.img, c.gt))) negFA++;
			}
		});
	}
	it('summary: no confident wrong answers; fail ≤ 25%; median < 0.2 pin, p95 < 1 pin', () => {
		const found = rows.filter((r) => r.found);
		const allPins = found.flatMap((r) => r.pins);
		const st = {
			n: rows.length,
			failRate: 1 - found.length / rows.length,
			falseAccept: rows.filter((r) => r.found && r.falseAccept).length,
			medianPins: pct(allPins, 0.5),
			p95Pins: pct(allPins, 0.95),
			medianMs: pct(rows.map((r) => r.ms), 0.5),
			negFA,
			negN,
		};
		console.log('augmented:', JSON.stringify(st));
		expect(st.n).toBeGreaterThan(0);
		expect(st.falseAccept).toBe(0);
		expect(st.negFA).toBe(0);
		expect(st.failRate).toBeLessThanOrEqual(0.25);
		expect(st.medianPins).toBeLessThan(0.2);
		expect(st.p95Pins).toBeLessThan(1);
	});
});

describe('aggregateDetections', () => {
	it('median corners, outliers dropped, text votes settle orientation', () => {
		const base = [
			[100, 100],
			[400, 110],
			[395, 300],
			[98, 290],
		];
		const jit = (q: number[][], d: number) => q.map(([x, y], k) => [x + d * Math.cos(k), y + d * Math.sin(k)]);
		const det = (q: number[][], textFound: boolean) => ({ pinCorners: q as [number, number][], textFound, needsConfirm: !textFound, pitchPx: 5 });
		const a = aggregateDetections([
			det(jit(base, 0.5), true),
			det(rotateQuad(jit(base, -0.4), 2), false),
			null,
			det(jit(base, 0.3), true),
			det(jit(base, 40), true),
			det(jit(base, -0.2), false),
		]);
		expect(a?.agreed).toBe(4);
		expect(a?.frames).toBe(5);
		expect(a?.pinCorners.every((p, k) => Math.hypot(p[0] - base[k][0], p[1] - base[k][1]) < 1)).toBe(true);
		expect(a?.textFound).toBe(true);
		expect(aggregateDetections([det(base, false), det(rotateQuad(base, 2), false)])?.needsConfirm).toBe(true);
		expect(aggregateDetections([det(base, true), det(rotateQuad(base, 2), true)])?.needsConfirm).toBe(true);
		expect(aggregateDetections([null, null])).toBeNull();
	});
});
