/**
 * The rect surface's corner check (convex, clockwise, ≥ 1 % of the frame) and
 * the ported shoelace area.
 */
import { describe, expect, it } from 'vitest';
import { cellPxOf, checkSurfaceQuad, pinIndexCorners, pitchFromCorners, type Point, quadArea } from '../src/geometry';

const FRAME = { width: 1280, height: 720 };
const PERSPECTIVE: Point[] = [
	[300, 150],
	[980, 170],
	[1040, 610],
	[250, 580],
];

describe('quadArea (port of starter dotpadTemplate.js)', () => {
	it('is the shoelace area, positive for TL, TR, BR, BL in image space', () => {
		expect(
			quadArea([
				[0, 0],
				[100, 0],
				[100, 50],
				[0, 50],
			]),
		).toBe(5000);
		// Shoelace by two triangles.
		const tri = (a: Point, b: Point, c: Point) => ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
		const [a, b, c, d] = PERSPECTIVE;
		expect(quadArea(PERSPECTIVE)).toBeCloseTo(tri(a, b, c) + tri(a, c, d), 9);
		expect(quadArea([a, d, c, b])).toBeCloseTo(-quadArea(PERSPECTIVE), 9);
	});
});

describe('checkSurfaceQuad', () => {
	it('accepts a perspective rectangle of any aspect', () => {
		expect(checkSurfaceQuad(PERSPECTIVE, FRAME)).toMatchObject({ ok: true, reason: null });
		const tall: Point[] = [
			[600, 50],
			[700, 50],
			[700, 700],
			[600, 700],
		];
		expect(checkSurfaceQuad(tall, FRAME).ok).toBe(true);
	});
	it('rejects the wrong touch order (counter-clockwise), duplicates and collinear corners', () => {
		const [a, b, c, d] = PERSPECTIVE;
		expect(checkSurfaceQuad([a, d, c, b], FRAME).reason).toBe('not-convex-clockwise');
		expect(checkSurfaceQuad([a, b, c, b], FRAME).reason).toBe('not-convex-clockwise');
		expect(checkSurfaceQuad([a, a, c, d], FRAME).reason).toBe('not-convex-clockwise');
		expect(checkSurfaceQuad([a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], b, c], FRAME).reason).toBe('not-convex-clockwise');
		// Crossed (bow-tie) order.
		expect(checkSurfaceQuad([a, b, d, c], FRAME).reason).toBe('not-convex-clockwise');
		expect(checkSurfaceQuad([a, b, c], FRAME).reason).toBe('need-four');
		expect(checkSurfaceQuad(null, FRAME).reason).toBe('need-four');
	});
	it('rejects an area below 1 % of the frame', () => {
		const side = Math.sqrt(0.01 * FRAME.width * FRAME.height);
		const sq = (s: number): Point[] => [
			[100, 100],
			[100 + s, 100],
			[100 + s, 100 + s],
			[100, 100 + s],
		];
		expect(checkSurfaceQuad(sq(side * 0.98), FRAME).reason).toBe('too-small');
		expect(checkSurfaceQuad(sq(side * 1.02), FRAME).ok).toBe(true);
	});
});

describe('cellPxOf', () => {
	it('equals pitchFromCorners for the DOT Pad corner-pin quad', () => {
		expect(cellPxOf(PERSPECTIVE, pinIndexCorners(60, 40))).toBe(pitchFromCorners(PERSPECTIVE, 60, 40));
	});
});
