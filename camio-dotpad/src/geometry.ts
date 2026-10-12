/**
 * Plane geometry shared by every module: the DOT Pad template, homographies
 * (4-point exact and least-squares), quad helpers and the registration sanity
 * checks. Ported from the starter's `dotpadTemplate.js` / `dotpadLattice.js`.
 *
 * Conventions used everywhere in this library:
 *  - Image pixels: x right, y down, pixel centres at integers.
 *  - Pin coordinates (c, r): c = 0 … cols−1 left → right, r = 0 … rows−1 top →
 *    bottom, with the braille text line BELOW row rows−1 (Audiom's frame).
 *  - Corner quads are TL, TR, BR, BL corner-PIN CENTRES (not the window edge).
 *  - A pose `H` maps pin (c, r, 1) → image px.
 */

/** A 2-D point. Internally plain arrays are used; this alias documents intent. */
export type Point = [number, number];
/** 3×3 row-major matrix. */
export type Mat3 = number[][];
/** TL, TR, BR, BL. */
export type Quad = Point[];

/**
 * DOT Pad template geometry, measured from a 352 × 292 product render (comb fit
 * of 60 and 40 teeth: square pitch 3.3335 template px). Used geometrically only:
 * the window margin around the pin field and the braille text line position.
 */
export const DOTPAD_TEMPLATE = Object.freeze({
	cols: 60,
	rows: 40,
	pinPitchPx: 3.3335,
	pinCorners: [
		[77.0, 57.34],
		[273.68, 57.34],
		[273.68, 187.35],
		[77.0, 187.35],
	] as Point[],
	displayWindow: [
		[62.0, 42.5],
		[288.5, 42.5],
		[288.5, 202.5],
		[62.0, 202.5],
	] as Point[],
	textWindow: [
		[62.0, 248.5],
		[288.5, 248.5],
		[288.5, 269.5],
		[62.0, 269.5],
	] as Point[],
	bezel: [
		[50.0, 30.5],
		[300.5, 30.5],
		[300.5, 214.0],
		[50.0, 214.0],
	] as Point[],
});

/** Corner-pin indices TL, TR, BR, BL for a cols × rows field. */
export const pinIndexCorners = (cols = 60, rows = 40): Point[] => [
	[0, 0],
	[cols - 1, 0],
	[cols - 1, rows - 1],
	[0, rows - 1],
];

const hypot = Math.hypot;

export function matMul3(A: Mat3, B: Mat3): Mat3 {
	const C = [
		[0, 0, 0],
		[0, 0, 0],
		[0, 0, 0],
	];
	for (let r = 0; r < 3; r++)
		for (let c = 0; c < 3; c++) {
			C[r][c] = A[r][0] * B[0][c] + A[r][1] * B[1][c] + A[r][2] * B[2][c];
		}
	return C;
}

/** 3×3 inverse (adjugate / determinant). Throws RangeError when singular. */
export function invert3(m: Mat3): Mat3 {
	const [[a, b, c], [d, e, f], [g, h, i]] = m;
	const A = e * i - f * h;
	const B = -(d * i - f * g);
	const C = d * h - e * g;
	const det = a * A + b * B + c * C;
	if (!Number.isFinite(det) || Math.abs(det) < 1e-18)
		throw new RangeError('invert3: singular');
	const s = 1 / det;
	return [
		[A * s, -(b * i - c * h) * s, (b * f - c * e) * s],
		[B * s, (a * i - c * g) * s, -(a * f - c * d) * s],
		[C * s, -(a * h - b * g) * s, (a * e - b * d) * s],
	];
}

/** Apply a 3×3 homography to one point. */
export function applyH(H: Mat3, p: ArrayLike<number>): Point {
	const w = H[2][0] * p[0] + H[2][1] * p[1] + H[2][2];
	return [
		(H[0][0] * p[0] + H[0][1] * p[1] + H[0][2]) / w,
		(H[1][0] * p[0] + H[1][1] * p[1] + H[1][2]) / w,
	];
}

/** Solve the n×n system A·x = b in place (partial pivoting); null if singular. */
function solve(A: number[][], b: number[]): number[] | null {
	const n = b.length;
	for (let c = 0; c < n; c++) {
		let piv = c;
		for (let r = c + 1; r < n; r++)
			if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
		if (Math.abs(A[piv][c]) < 1e-12) return null;
		[A[c], A[piv]] = [A[piv], A[c]];
		[b[c], b[piv]] = [b[piv], b[c]];
		for (let r = c + 1; r < n; r++) {
			const f = A[r][c] / A[c][c];
			if (f === 0) continue;
			for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
			b[r] -= f * b[c];
		}
	}
	const x = new Array<number>(n).fill(0);
	for (let r = n - 1; r >= 0; r--) {
		let s = b[r];
		for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
		x[r] = s / A[r][r];
	}
	return x;
}

/**
 * 4-point DLT: the 3×3 `H` (h33 = 1) with `H·src[i] ∝ dst[i]`.
 * Throws RangeError on a degenerate quad.
 */
export function homography4(
	src: ArrayLike<number>[],
	dst: ArrayLike<number>[],
): Mat3 {
	const A: number[][] = [];
	const b: number[] = [];
	for (let i = 0; i < 4; i++) {
		const x = src[i][0];
		const y = src[i][1];
		const X = dst[i][0];
		const Y = dst[i][1];
		A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]);
		b.push(X);
		A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]);
		b.push(Y);
	}
	const h = solve(A, b);
	if (!h || !h.every(Number.isFinite))
		throw new RangeError('homography4: degenerate quad');
	return [
		[h[0], h[1], h[2]],
		[h[3], h[4], h[5]],
		[h[6], h[7], 1],
	];
}

/** Similarity that moves the centroid to 0 and the mean distance to √2 (Hartley). */
function normaliser(pts: ArrayLike<number>[]): Mat3 {
	let cx = 0;
	let cy = 0;
	for (const p of pts) {
		cx += p[0];
		cy += p[1];
	}
	cx /= pts.length;
	cy /= pts.length;
	let d = 0;
	for (const p of pts) d += hypot(p[0] - cx, p[1] - cy);
	const s = Math.SQRT2 / (d / pts.length || 1);
	return [
		[s, 0, -s * cx],
		[0, s, -s * cy],
		[0, 0, 1],
	];
}

/**
 * Least-squares homography `H·src[k] ∝ dst[k]` over N ≥ 4 pairs (normalised
 * DLT with h33 = 1, normal equations). Optional per-pair weights. Returns null
 * when degenerate.
 */
export function fitHomography(
	src: ArrayLike<number>[],
	dst: ArrayLike<number>[],
	weights?: ArrayLike<number>,
): Mat3 | null {
	if (src.length < 4) return null;
	const Ts = normaliser(src);
	const Td = normaliser(dst);
	const AtA = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
	const Atb = new Array<number>(8).fill(0);
	const row = new Array<number>(8);
	const acc = (r: number[], rhs: number, w: number) => {
		for (let a = 0; a < 8; a++) {
			if (r[a] === 0) continue;
			Atb[a] += w * r[a] * rhs;
			for (let b = 0; b < 8; b++) AtA[a][b] += w * r[a] * r[b];
		}
	};
	for (let k = 0; k < src.length; k++) {
		const w = weights ? weights[k] : 1;
		if (!(w > 0)) continue;
		const [u, v] = applyH(Ts, src[k]);
		const [x, y] = applyH(Td, dst[k]);
		row[0] = u;
		row[1] = v;
		row[2] = 1;
		row[3] = 0;
		row[4] = 0;
		row[5] = 0;
		row[6] = -u * x;
		row[7] = -v * x;
		acc(row, x, w);
		row[0] = 0;
		row[1] = 0;
		row[2] = 0;
		row[3] = u;
		row[4] = v;
		row[5] = 1;
		row[6] = -u * y;
		row[7] = -v * y;
		acc(row, y, w);
	}
	const h = solve(AtA, Atb);
	if (!h || !h.every(Number.isFinite)) return null;
	const Hn = [
		[h[0], h[1], h[2]],
		[h[3], h[4], h[5]],
		[h[6], h[7], 1],
	];
	let H: Mat3;
	try {
		H = matMul3(invert3(Td), matMul3(Hn, Ts));
	} catch {
		return null;
	}
	const s = H[2][2];
	return H.map((r) => r.map((x) => x / s));
}

/** Cyclic shift: `rotateQuad(q, r)[i] = q[(i + r) % 4]`. */
export const rotateQuad = <T>(q: T[], r: number): T[] =>
	q.map((_, i) => q[(i + r) % 4]);

const dist = (a: ArrayLike<number>, b: ArrayLike<number>) =>
	hypot(a[0] - b[0], a[1] - b[1]);
const mean = (a: number, b: number) => (a + b) / 2;

/** Width / height of a TL,TR,BR,BL quad, from mean opposite edges. */
export function quadAspect(q: ArrayLike<number>[]): number {
	return (
		mean(dist(q[0], q[1]), dist(q[3], q[2])) /
		mean(dist(q[0], q[3]), dist(q[1], q[2]))
	);
}

/** Pin pitch (px) implied by a TL,TR,BR,BL corner-pin quad: mean edge length per pin step. */
export function pitchFromCorners(
	q: ArrayLike<number>[],
	cols = 60,
	rows = 40,
): number {
	const top = dist(q[1], q[0]);
	const bot = dist(q[2], q[3]);
	const lef = dist(q[3], q[0]);
	const rig = dist(q[2], q[1]);
	return (top + bot + lef + rig) / (2 * (cols - 1) + 2 * (rows - 1));
}

/**
 * Sanity check on four corner-pin centres: convex and clockwise on screen, and
 * mean(top, bottom) / mean(left, right) in [1.15, 2.0] (59/39 = 1.51, with room
 * for perspective).
 */
export function checkPinQuad(
	corners: ArrayLike<number>[] | null | undefined,
	{ minRatio = 1.15, maxRatio = 2.0 } = {},
): { ok: boolean; reason: string | null; ratio: number } {
	if (!Array.isArray(corners) || corners.length !== 4)
		return { ok: false, reason: 'need-four', ratio: Number.NaN };
	for (let i = 0; i < 4; i++) {
		const a = corners[i];
		const b = corners[(i + 1) % 4];
		const c = corners[(i + 2) % 4];
		const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
		if (!(cross > 0))
			return {
				ok: false,
				reason: 'not-convex-clockwise',
				ratio: quadAspect(corners),
			};
	}
	const ratio = quadAspect(corners);
	if (!(ratio >= minRatio && ratio <= maxRatio))
		return { ok: false, reason: 'aspect', ratio };
	return { ok: true, reason: null, ratio };
}

/**
 * One touch on the top-left pin fixes the orientation: the corners re-ordered
 * so the touched one is TL, or null when the touch is not within `pitches`
 * pin pitches of any corner.
 */
export function resolveConfirmTouch(
	pinCorners: Point[],
	touch: ArrayLike<number>,
	{ pitches = 3, cols = 60, rows = 40 } = {},
): Point[] | null {
	const pitch = mean(
		mean(dist(pinCorners[0], pinCorners[1]), dist(pinCorners[3], pinCorners[2])) /
			(cols - 1),
		mean(dist(pinCorners[0], pinCorners[3]), dist(pinCorners[1], pinCorners[2])) /
			(rows - 1),
	);
	let bestI = -1;
	let bestD = Number.POSITIVE_INFINITY;
	pinCorners.forEach((c, i) => {
		const d = dist(c, touch);
		if (d < bestD) {
			bestD = d;
			bestI = i;
		}
	});
	if (bestI < 0 || bestD > pitches * pitch) return null;
	return rotateQuad(pinCorners, bestI);
}

/** Pose (pin → px) from four corner-pin centres. */
export function poseFromCorners(corners: ArrayLike<number>[], cols = 60, rows = 40): Mat3 {
	return homography4(pinIndexCorners(cols, rows), corners);
}

/** Corner-pin centres of a pose. */
export function cornersOfPose(H: Mat3, cols = 60, rows = 40): Point[] {
	return pinIndexCorners(cols, rows).map((p) => applyH(H, p));
}

/** Max over the four corners of the distance between two quads (px). */
export const maxCornerDist = (p: ArrayLike<number>[], q: ArrayLike<number>[]): number =>
	Math.max(...p.map((c, k) => dist(c, q[k])));

/** Local pin pitch (px) of a pose at pin (c, r): mean of the two unit steps. */
export function localPitch(H: Mat3, c: number, r: number): number {
	const p = applyH(H, [c, r]);
	const a = applyH(H, [c + 1, r]);
	const b = applyH(H, [c, r + 1]);
	return (dist(a, p) + dist(b, p)) / 2;
}
