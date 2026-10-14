/**
 * Surface profiles: the `surface.js` acuity-grid port, the plane corners and
 * cell → (u, v) of both profiles, and the shared movement threshold.
 */
import { describe, expect, it } from 'vitest';
import { applyH, homography4, type Point } from '../src/geometry';
import { MOVEMENT_THRESHOLD_PINS } from '../src/input';
import { A4_LANDSCAPE, ACUITY_FLOOR_MM, acuityCellCenter, acuityGrid, clampUnit, createSurfaceProfile } from '../src/surface';

const LANDSCAPE: Point[] = [
	[300, 150],
	[980, 170],
	[1000, 600],
	[280, 580],
];
const PORTRAIT: Point[] = [
	[500, 80],
	[800, 90],
	[810, 650],
	[490, 640],
];

describe('acuity grid (port of starter lib/surface.js)', () => {
	it('A4 landscape at the 2.5 mm floor is 118 × 84', () => {
		expect(ACUITY_FLOOR_MM).toBe(2.5);
		expect(A4_LANDSCAPE).toEqual({ widthMm: 297, heightMm: 210 });
		expect(acuityGrid({ materialWidthMm: 297, materialHeightMm: 210 })).toEqual({ cellSizeMm: 2.5, cols: 118, rows: 84, count: 118 * 84 });
	});
	it('the floor epsilon keeps a column that floating point would lose (43 × 6.4 mm)', () => {
		expect((43 * 6.4) / 6.4).not.toBe(43);
		expect(acuityGrid({ materialWidthMm: 43 * 6.4, materialHeightMm: 10 * 6.4, devicePinPitchMm: 6.4 })).toMatchObject({ cols: 43, rows: 10 });
		// A pin pitch finer than the floor is quantised at the floor.
		expect(acuityGrid({ materialWidthMm: 100, materialHeightMm: 50, devicePinPitchMm: 1 })).toMatchObject({ cellSizeMm: 2.5, cols: 40, rows: 20 });
		expect(() => acuityGrid({ materialWidthMm: 0, materialHeightMm: 10 })).toThrow(TypeError);
	});
	it('clampUnit and acuityCellCenter', () => {
		expect(clampUnit(-0.2)).toBe(0);
		expect(clampUnit(1)).toBeLessThan(1);
		expect(Math.floor(clampUnit(1) * 118)).toBe(117);
		expect(() => clampUnit(Number.NaN)).toThrow(TypeError);
		expect(acuityCellCenter(0, { cols: 118, rows: 84 })).toEqual({ u: 0.5 / 118, v: 0.5 / 84 });
		expect(acuityCellCenter(118 * 84 - 1, { cols: 118, rows: 84 })).toEqual({ u: 117.5 / 118, v: 83.5 / 84 });
		expect(() => acuityCellCenter(118 * 84, { cols: 118, rows: 84 })).toThrow(RangeError);
	});
});

describe('profiles', () => {
	it('dotpad: 60 × 40, corner-PIN centres, u = col/59, border from the spec', () => {
		const p = createSurfaceProfile({ kind: 'dotpad' });
		const g = p.gridFor(LANDSCAPE);
		expect(g).toEqual({ cols: 60, rows: 40 });
		expect(p.planeCorners(g)).toEqual([
			[0, 0],
			[59, 0],
			[59, 39],
			[0, 39],
		]);
		expect(p.toUV(0, 0, g)).toEqual([0, 0]);
		expect(p.toUV(59, 39, g)).toEqual([1, 1]);
		expect(p.toUV(20, 10, g)).toEqual([20 / 59, 10 / 39]);
		expect(p.border).toBe(2);
		expect(createSurfaceProfile({ kind: 'dotpad', border: 3 }).border).toBe(3);
		expect(p).toMatchObject({ kind: 'dotpad', autoFind: true, watchdog: true, trackEvery: 1 });
		expect(p.prompts.corners[0]).toBe('register.corner.topLeft');
	});

	it('rect: physical corners at (−½, −½) … (cols−½, rows−½), u = (col+½)/cols, oriented like the quad', () => {
		const p = createSurfaceProfile({ kind: 'rect' });
		expect(p).toMatchObject({ kind: 'rect', border: 0, autoFind: false, watchdog: false, trackEvery: 1 });
		const g = p.gridFor(LANDSCAPE);
		expect(g).toEqual({ cols: 118, rows: 84 });
		expect(p.gridFor(null)).toEqual({ cols: 118, rows: 84 });
		expect(p.gridFor(PORTRAIT)).toEqual({ cols: 84, rows: 118 });
		expect(p.planeCorners(g)).toEqual([
			[-0.5, -0.5],
			[117.5, -0.5],
			[117.5, 83.5],
			[-0.5, 83.5],
		]);
		expect(p.toUV(0, 0, g)).toEqual([0.5 / 118, 0.5 / 84]);
		expect(p.toUV(59, 41, g)).toEqual([59.5 / 118, 41.5 / 84]);
		// The plane corners map to the touched corners: (u, v) = (0,0) is TL, (1,1) is BR.
		const H = homography4(p.planeCorners(g), LANDSCAPE);
		const tl = applyH(H, [-0.5, -0.5]);
		expect(tl[0]).toBeCloseTo(300, 9);
		expect(tl[1]).toBeCloseTo(150, 9);
		// A host material.
		const q = createSurfaceProfile({ kind: 'rect', material: { widthMm: 100, heightMm: 200 } });
		expect(q.gridFor(LANDSCAPE)).toEqual({ cols: 80, rows: 40 });
		expect(q.gridFor(PORTRAIT)).toEqual({ cols: 40, rows: 80 });
		expect(p.prompts).toMatchObject({ corners: ['register.corner.topLeft', 'register.corner.topRight', 'register.corner.bottomRight', 'register.corner.bottomLeft'], cornersRejected: 'register.cornersRejected', done: 'register.done', static: 'tracking.surface.static' });
		expect(p.prompts.lost).toBeUndefined();
	});

	it('rect validate: the corner check with the frame-area floor', () => {
		const p = createSurfaceProfile({ kind: 'rect' });
		expect(p.validate(LANDSCAPE, { width: 1280, height: 720 })).toEqual({ ok: true, reason: null });
		expect(p.validate([LANDSCAPE[0], LANDSCAPE[3], LANDSCAPE[2], LANDSCAPE[1]], { width: 1280, height: 720 }).reason).toBe('not-convex-clockwise');
	});

	it('movement threshold: 2.54 cells on both (CamIO 0.25 in at a 2.5 mm cell)', () => {
		expect(MOVEMENT_THRESHOLD_PINS).toBeCloseTo(2.54, 9);
		expect(createSurfaceProfile({ kind: 'dotpad' }).movementCells({ cols: 60, rows: 40 })).toBe(MOVEMENT_THRESHOLD_PINS);
		expect(createSurfaceProfile({ kind: 'rect' }).movementCells({ cols: 118, rows: 84 })).toBe(MOVEMENT_THRESHOLD_PINS);
	});

	it('rejects an unknown surface or a bad material', () => {
		expect(() => createSurfaceProfile({ kind: 'tablet' } as never)).toThrow(TypeError);
		expect(() => createSurfaceProfile({ kind: 'rect', material: { widthMm: 0, heightMm: 10 } })).toThrow(TypeError);
	});
});
