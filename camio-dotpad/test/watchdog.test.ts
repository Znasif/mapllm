/**
 * Drift watchdog — ported from the starter's scripts/test_dotpad_watchdog.mjs:
 * decision logic on hand-made quads, then a replay on a real frame with
 * synthetic warps (pad not moved / moved / turned 180°, pins blank).
 */
import { describe, expect, it } from 'vitest';
import { type Point, applyH, invert3 } from '../src/geometry';
import { latticeSearch, detectDotpadLattice } from '../src/lattice';
import {
	WATCHDOG_AGREE_PINS,
	WATCHDOG_CONSECUTIVE,
	WATCHDOG_HANDS_OFF_MS,
	WATCHDOG_INTERVAL_MS,
	WATCHDOG_MOVED_PINS,
	compareCorners,
	createDriftWatchdog,
	watchdogDue,
} from '../src/watchdog';
import { pitchFromCorners, rotateQuad } from '../src/geometry';
import { GT, realLuma } from './fixtures/realSet.mjs';
import { erasePinField } from './fixtures/scenes.mjs';

const maxDist = (p: number[][], q: number[][]) => Math.max(...p.map((c, k) => Math.hypot(c[0] - q[k][0], c[1] - q[k][1])));
const PITCH = 7;
const quadAt = (x: number, y: number, pitch = PITCH): Point[] => [
	[x, y],
	[x + 59 * pitch, y],
	[x + 59 * pitch, y + 39 * pitch],
	[x, y + 39 * pitch],
];
const TRACKED = quadAt(300, 200);
const shift = (q: Point[], dx: number, dy: number): Point[] => q.map(([x, y]) => [x + dx, y + dy]);
const det = (q: Point[], extra = {}) => ({ pinCorners: q, pitchPx: PITCH, textFound: false, ...extra });

describe('watchdog decisions', () => {
	it('thresholds leave a hysteresis band and need ≥ 2 checks', () => {
		expect(WATCHDOG_AGREE_PINS).toBeLessThan(WATCHDOG_MOVED_PINS);
		expect(WATCHDOG_CONSECUTIVE).toBeGreaterThanOrEqual(2);
	});
	it('agree / ambiguous', () => {
		const dog = createDriftWatchdog();
		const r = dog.update(TRACKED, det(shift(TRACKED, 0.3 * PITCH, -0.2 * PITCH)), 1000);
		expect(r.verdict).toBe('agree');
		expect(dog.lastVerifiedAt).toBe(1000);
		const u = dog.update(TRACKED, det(shift(TRACKED, 0.85 * PITCH, 0)), 2000);
		expect(u.verdict).toBe('uncertain');
		expect(dog.lastVerifiedAt).toBe(1000);
	});
	it('two consecutive consistent disagreements re-register; an agreeing check in between resets', () => {
		const dog = createDriftWatchdog();
		const moved = det(shift(TRACKED, 3 * PITCH, 1 * PITCH));
		expect(dog.update(TRACKED, moved, 0)).toMatchObject({ verdict: 'disagree', action: 'none', streak: 1 });
		expect(dog.update(TRACKED, det(TRACKED), 1500).verdict).toBe('agree');
		expect(dog.update(TRACKED, moved, 3000)).toMatchObject({ action: 'none', streak: 1 });
		const d = dog.update(TRACKED, det(shift(TRACKED, 3.2 * PITCH, 1.1 * PITCH)), 4500);
		expect(d.action).toBe('reregister');
		expect(maxDist(d.corners as Point[], shift(TRACKED, 3.2 * PITCH, 1.1 * PITCH))).toBeLessThan(1e-9);
		expect(dog.streak).toBe(0);
	});
	it('inconsistent disagreements do not re-register; null detections are ignored', () => {
		const dog = createDriftWatchdog();
		dog.update(TRACKED, det(shift(TRACKED, 3 * PITCH, 0)), 0);
		expect(dog.update(TRACKED, det(shift(TRACKED, -4 * PITCH, 2 * PITCH)), 1500).action).toBe('none');
		expect(dog.update(TRACKED, null, 3000).verdict).toBe('none');
		expect(dog.intervalMs).toBeGreaterThan(WATCHDOG_INTERVAL_MS);
	});
	it('orientation: keeps the tracked order unless the text line says otherwise', () => {
		const flipped = rotateQuad(shift(TRACKED, 0.2 * PITCH, 0), 2);
		expect(compareCorners(TRACKED, det(flipped)).rot).toBe(2);
		const withText = compareCorners(TRACKED, det(flipped, { textFound: true }));
		expect(withText.rot).toBe(0);
		expect(withText.textOverride).toBe(true);
		expect(withText.pins).toBeGreaterThan(30);
	});
	it('pins are px / pitch; pitchFromCorners', () => {
		const off = shift(TRACKED, 8, 0);
		expect(compareCorners(TRACKED, { pinCorners: off, pitchPx: 5 }).pins).toBeCloseTo(1.6, 9);
		expect(compareCorners(TRACKED, { pinCorners: off, pitchPx: 20 }).pins).toBeCloseTo(0.4, 9);
		expect(pitchFromCorners(TRACKED)).toBeCloseTo(PITCH, 9);
		const gt = GT['hue_oblique_00.jpg'];
		expect(Math.abs(pitchFromCorners(gt.corners) / gt.pitchPx - 1)).toBeLessThan(0.1);
	});
	it('scheduling', () => {
		const due = (now: number, zeroSince: number | null, lastCheckAt: number | null) => watchdogDue({ now, zeroSince, lastCheckAt });
		expect(due(10000, null, 0)).toBe(false);
		expect(due(10000, 10000 - WATCHDOG_HANDS_OFF_MS + 1, 0)).toBe(false);
		expect(due(10000, 10000 - WATCHDOG_HANDS_OFF_MS, 0)).toBe(true);
		expect(due(10000, 0, 10000 - WATCHDOG_INTERVAL_MS + 1)).toBe(false);
		expect(due(10000, 0, null)).toBe(true);
	});
});

describe('watchdog replay: hue_oblique_00.jpg + synthetic warps', () => {
	const { full } = realLuma('hue_oblique_00.jpg');
	const { width: W, height: Hh } = full;
	const warp = (img: { data: ArrayLike<number> }, H: number[][]) => {
		const Hi = invert3(H);
		const out = new Uint8Array(W * Hh);
		let mean = 0;
		for (let i = 0; i < img.data.length; i++) mean += img.data[i];
		mean /= img.data.length;
		for (let y = 0; y < Hh; y++)
			for (let x = 0; x < W; x++) {
				const [sx, sy] = applyH(Hi, [x, y]);
				const x0 = Math.floor(sx);
				const y0 = Math.floor(sy);
				if (x0 < 0 || y0 < 0 || x0 >= W - 1 || y0 >= Hh - 1) {
					out[y * W + x] = mean;
					continue;
				}
				const fx = sx - x0;
				const fy = sy - y0;
				const o = y0 * W + x0;
				const d = img.data;
				out[y * W + x] = Math.round((d[o] * (1 - fx) + d[o + 1] * fx) * (1 - fy) + (d[o + W] * (1 - fx) + d[o + W + 1] * fx) * fy);
			}
		return { data: out, width: W, height: Hh };
	};
	const rigid = (deg: number, cx: number, cy: number, dx: number, dy: number) => {
		const a = (deg * Math.PI) / 180;
		const c = Math.cos(a);
		const s = Math.sin(a);
		return [
			[c, -s, cx - c * cx + s * cy + dx],
			[s, c, cy - s * cx - c * cy + dy],
			[0, 0, 1],
		];
	};
	const reg = detectDotpadLattice(full);
	it('registered frame: lattice found with the text line', () => {
		expect(reg?.textFound).toBe(true);
	});
	const tracked = reg ? reg.pinCorners : [];
	const pitchHint = reg?.pitchPx ?? 5;
	const cen = tracked.reduce((s, p) => [s[0] + p[0] / 4, s[1] + p[1] / 4], [0, 0]);
	const runCheck = (img: { data: ArrayLike<number>; width: number; height: number }) => {
		const it = latticeSearch(img, { pitchHint });
		for (;;) {
			const st = it.next();
			if (st.done) return st.value;
		}
	};
	const cases = [
		{ name: 'unmoved', H: rigid(0, 0, 0, 0, 0), expect: 'agree' },
		{ name: 'nudged 0.3 pin', H: rigid(0, 0, 0, 0.3 * pitchHint, 0), expect: 'agree' },
		{ name: 'slid 3 pins right, 1 down', H: rigid(0, 0, 0, 3 * pitchHint, pitchHint), expect: 'moved' },
		{ name: 'rotated 4° + 1.5 pins', H: rigid(4, cen[0], cen[1], 0, 1.5 * pitchHint), expect: 'moved' },
		{ name: 'turned 180° in place', H: rigid(180, cen[0], cen[1], 0, 0), expect: 'moved' },
	];
	for (const cs of cases) {
		it(cs.name, () => {
			const img = warp(full, cs.H);
			const truth = tracked.map((p) => applyH(cs.H, p));
			const dog = createDriftWatchdog();
			const r1 = dog.update(tracked, runCheck(img), 0);
			const d2 = runCheck(img);
			const r2 = dog.update(tracked, d2, WATCHDOG_INTERVAL_MS);
			if (cs.expect === 'agree') {
				expect(r1.verdict).toBe('agree');
				expect(r2.verdict).toBe('agree');
			} else {
				expect(r1.verdict).toBe('disagree');
				expect(r2.action).toBe('reregister');
				expect(maxDist(r2.corners as Point[], truth) / (d2?.pitchPx ?? 1)).toBeLessThan(1);
			}
		});
	}
	it('pin field blank: no detection, no action', () => {
		const blank = erasePinField(full, tracked);
		const d = runCheck(blank);
		expect(d).toBeNull();
		expect(createDriftWatchdog().update(tracked, d, 0).action).toBe('none');
	});
});
