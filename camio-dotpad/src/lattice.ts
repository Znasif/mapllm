/**
 * DOT Pad auto-find from the PIN LATTICE itself — ported from the starter's
 * `dotpadLattice.js` with the numerics unchanged (its headless tests are
 * ported in `test/lattice.test.ts`).
 *
 * The 60 × 40 dot lattice is the most distinctive thing in a camera frame of a
 * DOT Pad. This module finds that grid, indexes it, fits a homography pin-index
 * → pixel with every dot, and uses the KNOWN geometry (exactly 60 × 40, the
 * braille text line below the long edge) to settle the extent and which corner
 * is top-left.
 *
 *   0. Scale: a pyramid (2× down; 2× up on small frames) and two working-pitch
 *      hypotheses per level; the first lattice found MEASURES the pitch and
 *      everything is re-run with kernels sized to it (pitch ≈ 3 … 50 px).
 *   1. Dot response, illumination-normalised (DoG / local RMS); peaks are
 *      strict local maxima that pass a Hessian blob test.
 *   2. Lattice basis from the 4 nearest neighbours of every dot.
 *   3. BFS over unit lattice steps → integer (i, j) per dot; largest component.
 *   4. Homography (i, j) → px with outlier rejection in index space; grow/trim.
 *   5. Extent → exactly 60 × 40, missing lines added only from window-margin
 *      evidence; no usable evidence → null, never a guess.
 *   6. Validation gate (members, coverage, residual, dotted corners, blank lines
 *      just outside, isolated blobs).
 *   7. Orientation: long axis = 60 pins; braille text band below vs above
 *      resolves 180°. Undecided → `needsConfirm`.
 */

import {
	DOTPAD_TEMPLATE,
	type Mat3,
	type Point,
	applyH,
	fitHomography,
	homography4,
	invert3,
	matMul3,
	rotateQuad,
} from './geometry';
import {
	type GrayImage,
	dotResponse,
	double,
	halve,
	sample,
} from './imageops';

const COLS = DOTPAD_TEMPLATE.cols;
const ROWS = DOTPAD_TEMPLATE.rows;

const TPL = DOTPAD_TEMPLATE;
const PITCH_T = TPL.pinPitchPx;
/** Corner-pin centre → display-window edge, mean over the four sides (≈ 4.5 pitches). */
export const WINDOW_MARGIN =
	(TPL.pinCorners[0][0] -
		TPL.displayWindow[0][0] +
		(TPL.displayWindow[1][0] - TPL.pinCorners[1][0]) +
		(TPL.pinCorners[0][1] - TPL.displayWindow[0][1]) +
		(TPL.displayWindow[2][1] - TPL.pinCorners[2][1])) /
	4 /
	PITCH_T;
const TEXT_R0 = (TPL.textWindow[0][1] - TPL.pinCorners[0][1]) / PITCH_T;
const TEXT_R1 = (TPL.textWindow[2][1] - TPL.pinCorners[0][1]) / PITCH_T;
const TEXT_C0 = (TPL.textWindow[0][0] - TPL.pinCorners[0][0]) / PITCH_T;
const TEXT_C1 = (TPL.textWindow[1][0] - TPL.pinCorners[0][0]) / PITCH_T;

const hypot = Math.hypot;

/** A single-frame lattice detection. */
export interface LatticeDetection {
	/** TL, TR, BR, BL corner-pin centres in full-resolution px. */
	pinCorners: Point[];
	/** Pin (c, r) → px. */
	H: Mat3;
	pitchPx: number;
	members: number;
	coverage: number;
	rmsPx: number;
	rmsPitch: number;
	detected: { cols: number; rows: number };
	added: { left: number; right: number; top: number; bottom: number };
	margins: Record<'left' | 'right' | 'top' | 'bottom', number | null>;
	textFound: boolean;
	needsConfirm: boolean;
	text: { below: number; above: number };
	midRatio: number;
	score: number;
	level: number;
	polarity: number;
}

/** Detector tunables (see the starter's dotpadLattice.js for the rationale of each). */
export interface LatticeOptions {
	workPitches: number[];
	minPitch: number;
	upsampleMaxPixels: number;
	minLevelSide: number;
	maxLevel0Pixels: number;
	/** px at full res: try this scale first (previous success). */
	pitchHint: number | null;
	/** +1 pins brighter than the surface; −1 only if +1 finds nothing. */
	polarities: number[];
	nStrong: number;
	dStrong: number;
	nWeak: number;
	dWeak: number;
	kStrong: number;
	kWeak: number;
	edgeRatio: number;
	eps: number;
	stepTol: number;
	assignTol: number;
	growOcc: number;
	trimOcc: number;
	maxMissing: number;
	maxImbalance: number;
	maxMarginDev: number;
	minEdgeContrast: number;
	minText: number;
	minMembers: number;
	minCoverage: number;
	minCornerOcc: number;
	maxOutsideOcc: number;
	maxRmsPitch: number;
	maxMidRatio: number;
	trace: boolean;
	inverted: boolean;
}

export const LATTICE_DEFAULTS: Readonly<LatticeOptions> = Object.freeze({
	workPitches: [4.5, 6.4],
	minPitch: 3.2,
	upsampleMaxPixels: 1.2e6,
	minLevelSide: 96,
	maxLevel0Pixels: 4.2e6,
	pitchHint: null,
	polarities: [1, -1],
	nStrong: 1.0,
	dStrong: 3,
	nWeak: 0.5,
	dWeak: 0.8,
	kStrong: 5,
	kWeak: 3,
	edgeRatio: 7.2,
	eps: 1.5,
	stepTol: 0.28,
	assignTol: 0.3,
	growOcc: 0.35,
	trimOcc: 0.15,
	maxMissing: 10,
	maxImbalance: 0.75,
	maxMarginDev: 0.6,
	minEdgeContrast: 10,
	minText: 12,
	minMembers: 400,
	minCoverage: 0.4,
	minCornerOcc: 0.3,
	maxOutsideOcc: 0.25,
	maxRmsPitch: 0.18,
	maxMidRatio: 0.3,
	trace: false,
	inverted: false,
});


/** Diagnostics: why the last search returned null (null after a success). */
export const latticeDiagnostics: { lastReason: string | null; trace: string[] | null } = {
	lastReason: null,
	trace: null,
};

function fail(reason: string): null {
	latticeDiagnostics.lastReason = reason;
	latticeDiagnostics.trace?.push(reason);
	return null;
}

/* -------------------------------------------------------------- peaks -- */

interface Peaks {
	xs: number[];
	ys: number[];
	strong: number[];
	N: Float32Array;
	bg: Float32Array;
	noise: number;
}

function dotPeaks(
	f: ArrayLike<number>,
	w: number,
	h: number,
	pitchHint: number,
	t: LatticeOptions,
): Peaks {
	const { D, N, bg, noise: sigma } = dotResponse(f, w, h, pitchHint, t.eps);
	const dWeak = Math.max(t.dWeak, t.kWeak * sigma);
	const dStrong = Math.max(t.dStrong, t.kStrong * sigma);
	const r = Math.max(1, Math.round(0.3 * pitchHint));
	const xs: number[] = [];
	const ys: number[] = [];
	const strong: number[] = [];
	for (let y = r; y < h - r; y++) {
		for (let x = r; x < w - r; x++) {
			const i = y * w + x;
			const v = N[i];
			if (v < t.nWeak || D[i] < dWeak) continue;
			let isMax = true;
			for (let dy = -r; dy <= r && isMax; dy++) {
				const o = i + dy * w;
				for (let dx = -r; dx <= r; dx++) {
					if (dx === 0 && dy === 0) continue;
					const u = N[o + dx];
					if (u > v || (u === v && (dy < 0 || (dy === 0 && dx < 0)))) {
						isMax = false;
						break;
					}
				}
			}
			if (!isMax) continue;
			const l = N[i - 1];
			const rr = N[i + 1];
			const u = N[i - w];
			const d = N[i + w];
			const cx = l - 2 * v + rr;
			const cy = u - 2 * v + d;
			const cxy = (N[i - w - 1] + N[i + w + 1] - N[i - w + 1] - N[i + w - 1]) / 4;
			const det = cx * cy - cxy * cxy;
			if (!(cx < 0 && cy < 0 && det > 0) || (cx + cy) ** 2 / det > t.edgeRatio)
				continue;
			const ox = cx < 0 ? Math.max(-0.5, Math.min(0.5, (l - rr) / (2 * cx))) : 0;
			const oy = cy < 0 ? Math.max(-0.5, Math.min(0.5, (u - d) / (2 * cy))) : 0;
			xs.push(x + ox);
			ys.push(y + oy);
			strong.push(v >= t.nStrong && D[i] >= dStrong ? 1 : 0);
		}
	}
	return { xs, ys, strong, N, bg, noise: sigma };
}

interface Ext {
	i0: number;
	i1: number;
	j0: number;
	j1: number;
}

function midpointRatio(N: Float32Array, w: number, h: number, H: Mat3, ext: Ext): number {
	const pin: number[] = [];
	const mid: number[] = [];
	for (let i = ext.i0; i <= ext.i1; i++) {
		for (let j = ext.j0; j <= ext.j1; j++) {
			const p = applyH(H, [i, j]);
			const v = sample(N, w, h, p[0], p[1]);
			if (Number.isFinite(v)) pin.push(v);
			if (i < ext.i1) {
				const q = applyH(H, [i + 0.5, j]);
				const m = sample(N, w, h, q[0], q[1]);
				if (Number.isFinite(m)) mid.push(m);
			}
			if (j < ext.j1) {
				const q = applyH(H, [i, j + 0.5]);
				const m = sample(N, w, h, q[0], q[1]);
				if (Number.isFinite(m)) mid.push(m);
			}
		}
	}
	const med = (a: number[]) => {
		const s = [...a].sort((x, y) => x - y);
		return s.length ? s[s.length >> 1] : Number.NaN;
	};
	const mp = med(pin);
	return mp > 0 ? med(mid) / mp : Number.POSITIVE_INFINITY;
}

/* --------------------------------------------------------- spatial grid -- */

interface Grid {
	near(x: number, y: number, rad: number, self?: number): number[];
}

function makeGrid(xs: number[], ys: number[], cell: number): Grid {
	const map = new Map<number, number[]>();
	for (let k = 0; k < xs.length; k++) {
		const key = Math.floor(xs[k] / cell) * 65536 + Math.floor(ys[k] / cell);
		let arr = map.get(key);
		if (!arr) {
			arr = [];
			map.set(key, arr);
		}
		arr.push(k);
	}
	return {
		near(x, y, rad, self = -1) {
			const out: number[] = [];
			const cx0 = Math.floor((x - rad) / cell);
			const cx1 = Math.floor((x + rad) / cell);
			const cy0 = Math.floor((y - rad) / cell);
			const cy1 = Math.floor((y + rad) / cell);
			for (let cx = cx0; cx <= cx1; cx++)
				for (let cy = cy0; cy <= cy1; cy++) {
					const arr = map.get(cx * 65536 + cy);
					if (!arr) continue;
					for (const k of arr) {
						if (k !== self && hypot(xs[k] - x, ys[k] - y) <= rad) out.push(k);
					}
				}
			return out;
		},
	};
}

/* ------------------------------------------------------ lattice structure -- */

function estimatePitch(
	xs: number[],
	ys: number[],
	idx: number[],
	grid: Grid,
	maxR: number,
): number | null {
	const d1: number[] = [];
	for (const k of idx) {
		let best = Number.POSITIVE_INFINITY;
		for (const q of grid.near(xs[k], ys[k], maxR, k)) {
			const d = hypot(xs[q] - xs[k], ys[q] - ys[k]);
			if (d < best) best = d;
		}
		if (best < Number.POSITIVE_INFINITY && best >= 2) d1.push(best);
	}
	if (d1.length < 20) return null;
	const bin = 0.25;
	const hist = new Float64Array(Math.ceil(maxR / bin) + 2);
	for (const d of d1) hist[Math.floor(d / bin)] += 1;
	let bestB = 0;
	let bestV = -1;
	for (let b = 1; b < hist.length - 1; b++) {
		const v = hist[b - 1] + hist[b] + hist[b + 1];
		if (v > bestV) {
			bestV = v;
			bestB = b;
		}
	}
	const mode = (bestB + 0.5) * bin;
	const near = d1.filter((d) => d > 0.8 * mode && d < 1.25 * mode).sort((a, b) => a - b);
	return near.length ? near[near.length >> 1] : mode;
}

interface Basis {
	a: number[];
	b: number[];
}

function estimateBasis(
	xs: number[],
	ys: number[],
	idx: number[],
	grid: Grid,
	pitch: number,
): Basis | null {
	const bins = 180;
	const hist = new Float64Array(bins);
	const vecs: number[][] = [];
	for (const k of idx) {
		const nb = grid
			.near(xs[k], ys[k], 1.7 * pitch, k)
			.map((q) => [q, hypot(xs[q] - xs[k], ys[q] - ys[k])])
			.sort((p, q) => p[1] - q[1])
			.slice(0, 4);
		for (const [q, len] of nb) {
			const dx = xs[q] - xs[k];
			const dy = ys[q] - ys[k];
			if (len < 0.7 * pitch || len > 1.6 * pitch) continue;
			let th = Math.atan2(dy, dx);
			if (th < 0) th += Math.PI;
			if (th >= Math.PI) th -= Math.PI;
			hist[Math.floor((th / Math.PI) * bins) % bins] += 1;
			vecs.push([dx, dy, th, len]);
		}
	}
	if (vecs.length < 40) return null;
	const smooth = (b: number) => {
		let s = 0;
		for (let o = -2; o <= 2; o++) s += hist[(b + o + bins) % bins];
		return s;
	};
	let b1 = 0;
	for (let b = 1; b < bins; b++) if (smooth(b) > smooth(b1)) b1 = b;
	let b2 = -1;
	for (let b = 0; b < bins; b++) {
		const sep = Math.min(Math.abs(b - b1), bins - Math.abs(b - b1));
		if (sep < 35) continue;
		if (b2 < 0 || smooth(b) > smooth(b2)) b2 = b;
	}
	if (b2 < 0 || smooth(b2) < 0.15 * smooth(b1)) return null;

	const refine = (bin: number): number[] | null => {
		const th0 = ((bin + 0.5) / bins) * Math.PI;
		const ux = Math.cos(th0);
		const uy = Math.sin(th0);
		let sx = 0;
		let sy = 0;
		const lens: number[] = [];
		for (const [dx, dy, th, len] of vecs) {
			let dth = Math.abs(th - th0);
			dth = Math.min(dth, Math.PI - dth);
			if (dth > (10 * Math.PI) / 180) continue;
			const sgn = dx * ux + dy * uy >= 0 ? 1 : -1;
			sx += (sgn * dx) / len;
			sy += (sgn * dy) / len;
			lens.push(len);
		}
		if (lens.length < 10) return null;
		lens.sort((p, q) => p - q);
		const L = lens[lens.length >> 1];
		const n = hypot(sx, sy);
		return [(sx / n) * L, (sy / n) * L];
	};
	let a = refine(b1);
	let b = refine(b2);
	if (!a || !b) return null;
	if (Math.abs(b[0]) > Math.abs(a[0])) [a, b] = [b, a];
	if (a[0] < 0) a = [-a[0], -a[1]];
	if (a[0] * b[1] - a[1] * b[0] < 0) b = [-b[0], -b[1]];
	return { a, b };
}

/** [pointIndex, i, j] */
type Member = number[];

function largestComponent(
	xs: number[],
	ys: number[],
	idx: number[],
	grid: Grid,
	basis: Basis,
	_pitch: number,
	tol: number,
): Member[] | null {
	const n = xs.length;
	const comp = new Int32Array(n).fill(-1);
	const I = new Int32Array(n);
	const J = new Int32Array(n);
	const LB = new Float64Array(n * 4);
	const isCand = new Uint8Array(n);
	for (const k of idx) isCand[k] = 1;

	const stepOf = (ax: number, ay: number, bx: number, by: number, dx: number, dy: number) => {
		const det = ax * by - ay * bx;
		if (Math.abs(det) < 1e-9) return null;
		const al = (dx * by - dy * bx) / det;
		const be = (ax * dy - ay * dx) / det;
		const ra = Math.round(al);
		const rb = Math.round(be);
		if (Math.abs(ra) + Math.abs(rb) !== 1) return null;
		if (Math.abs(al - ra) > tol || Math.abs(be - rb) > tol) return null;
		return [ra, rb];
	};

	const { a, b } = basis;
	const rad = 1.35 * Math.max(hypot(a[0], a[1]), hypot(b[0], b[1]));
	const seeds: number[] = [];
	for (const k of idx) {
		let c = 0;
		for (const q of grid.near(xs[k], ys[k], rad, k)) {
			if (isCand[q] && stepOf(a[0], a[1], b[0], b[1], xs[q] - xs[k], ys[q] - ys[k])) c++;
		}
		if (c >= 3) seeds.push(k);
	}

	let best: number[] | null = null;
	let cid = 0;
	for (const s of seeds) {
		if (comp[s] >= 0) continue;
		const members = [s];
		const keys = new Set([0]);
		comp[s] = cid;
		I[s] = 0;
		J[s] = 0;
		LB.set([a[0], a[1], b[0], b[1]], s * 4);
		for (let hh = 0; hh < members.length; hh++) {
			const p = members[hh];
			const pax = LB[p * 4];
			const pay = LB[p * 4 + 1];
			const pbx = LB[p * 4 + 2];
			const pby = LB[p * 4 + 3];
			const r = 1.35 * Math.max(hypot(pax, pay), hypot(pbx, pby));
			for (const q of grid.near(xs[p], ys[p], r, p)) {
				if (!isCand[q] || comp[q] >= 0) continue;
				const dx = xs[q] - xs[p];
				const dy = ys[q] - ys[p];
				const st = stepOf(pax, pay, pbx, pby, dx, dy);
				if (!st) continue;
				const qi = I[p] + st[0];
				const qj = J[p] + st[1];
				const key = (qi + 4096) * 8192 + (qj + 4096);
				if (keys.has(key)) continue;
				keys.add(key);
				comp[q] = cid;
				I[q] = qi;
				J[q] = qj;
				if (st[0] !== 0)
					LB.set([0.5 * pax + 0.5 * st[0] * dx, 0.5 * pay + 0.5 * st[0] * dy, pbx, pby], q * 4);
				else LB.set([pax, pay, 0.5 * pbx + 0.5 * st[1] * dx, 0.5 * pby + 0.5 * st[1] * dy], q * 4);
				members.push(q);
			}
		}
		if (!best || members.length > best.length) best = members;
		cid++;
	}
	if (!best) return null;
	return best.map((k) => [k, I[k], J[k]]);
}

/* --------------------------------------------------------- lattice fit -- */

interface Fit {
	H: Mat3;
	members: Member[];
	rms: number;
	rmsIdx: number;
}

function robustFit(xs: number[], ys: number[], members: Member[]): Fit | null {
	let cur = members;
	let H: Mat3 | null = null;
	let rms = Number.POSITIVE_INFINITY;
	let rmsIdx = Number.POSITIVE_INFINITY;
	for (let it = 0; it < 4; it++) {
		H = fitHomography(
			cur.map((m) => [m[1], m[2]]),
			cur.map((m) => [xs[m[0]], ys[m[0]]]),
		);
		if (!H) return null;
		let Hinv: Mat3;
		try {
			Hinv = invert3(H);
		} catch {
			return null;
		}
		const res = cur.map((m) => {
			const q = applyH(Hinv, [xs[m[0]], ys[m[0]]]);
			return hypot(q[0] - m[1], q[1] - m[2]);
		});
		const sorted = [...res].sort((p, q) => p - q);
		const med = sorted[sorted.length >> 1];
		const thr = Math.max(0.08, Math.min(0.3, 4 * med));
		const keep = cur.filter((_, k) => res[k] <= thr);
		let s = 0;
		let sp = 0;
		for (let k = 0; k < cur.length; k++) {
			if (res[k] > thr) continue;
			s += res[k] * res[k];
			const p = applyH(H, [cur[k][1], cur[k][2]]);
			sp += (p[0] - xs[cur[k][0]]) ** 2 + (p[1] - ys[cur[k][0]]) ** 2;
		}
		rmsIdx = Math.sqrt(s / Math.max(1, keep.length));
		rms = Math.sqrt(sp / Math.max(1, keep.length));
		if (keep.length === cur.length || keep.length < 8) break;
		cur = keep;
	}
	return H ? { H, members: cur, rms, rmsIdx } : null;
}

/** [pointIndex, i, j, err] */
type Assigned = number[];

function reassign(
	xs: number[],
	ys: number[],
	H: Mat3,
	ext: Ext,
	maxErr: number,
): Map<number, Assigned> | null {
	let Hinv: Mat3;
	try {
		Hinv = invert3(H);
	} catch {
		return null;
	}
	const map = new Map<number, Assigned>();
	for (let k = 0; k < xs.length; k++) {
		const [u, v] = applyH(Hinv, [xs[k], ys[k]]);
		const i = Math.round(u);
		const j = Math.round(v);
		if (i < ext.i0 - 1 || i > ext.i1 + 1 || j < ext.j0 - 1 || j > ext.j1 + 1) continue;
		const e = hypot(u - i, v - j);
		if (e > maxErr) continue;
		const key = (i + 4096) * 8192 + (j + 4096);
		const prev = map.get(key);
		if (!prev || e < prev[3]) map.set(key, [k, i, j, e]);
	}
	return map;
}

function lineOccupancy(map: Map<number, Assigned>, ext: Ext) {
	const colCount = new Map<number, number>();
	const rowCount = new Map<number, number>();
	for (const [, i, j] of map.values()) {
		if (j >= ext.j0 && j <= ext.j1) colCount.set(i, (colCount.get(i) || 0) + 1);
		if (i >= ext.i0 && i <= ext.i1) rowCount.set(j, (rowCount.get(j) || 0) + 1);
	}
	const nJ = ext.j1 - ext.j0 + 1;
	const nI = ext.i1 - ext.i0 + 1;
	return {
		col: (i: number) => (colCount.get(i) || 0) / nJ,
		row: (j: number) => (rowCount.get(j) || 0) / nI,
	};
}

/* --------------------------------------------------- extent & orientation -- */

interface Side {
	axis: 'i' | 'j';
	dir: -1 | 1;
}

function windowEdge(
	bg: Float32Array,
	w: number,
	h: number,
	H: Mat3,
	ext: Ext,
	side: Side,
	need: number,
	minContrast: number,
): number | null {
	const { axis, dir } = side;
	const base = axis === 'i' ? (dir < 0 ? ext.i0 : ext.i1) : dir < 0 ? ext.j0 : ext.j1;
	const lo = axis === 'i' ? ext.j0 + 2 : ext.i0 + 2;
	const hi = axis === 'i' ? ext.j1 - 2 : ext.i1 - 2;
	if (hi <= lo) return null;
	const prof = (t: number) => {
		let s = 0;
		let c = 0;
		let tot = 0;
		for (let o = lo; o <= hi; o++) {
			const ij = axis === 'i' ? [base + dir * t, o] : [o, base + dir * t];
			const p = applyH(H, ij);
			const v = sample(bg, w, h, p[0], p[1]);
			tot++;
			if (Number.isFinite(v)) {
				s += v;
				c++;
			}
		}
		return c >= 0.5 * tot ? s / c : Number.NaN;
	};
	const step = 0.25;
	const tMax = need + WINDOW_MARGIN + 3.2;
	const P: number[] = [];
	for (let t = 0.5; t <= tMax + 1e-9; t += step) P.push(prof(t));
	if (P.some((v) => !Number.isFinite(v))) return null;
	const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
	const F = mean(P.slice(0, 5));
	const B = mean(P.slice(-5));
	if (Math.abs(F - B) < minContrast) return null;
	for (let k = 1; k < P.length; k++) {
		const a0 = (P[k - 1] - B) / (F - B);
		const a1 = (P[k] - B) / (F - B);
		if (a0 >= 0.5 && a1 < 0.5) return 0.5 + step * (k - 1 + (a0 - 0.5) / (a0 - a1));
	}
	return null;
}

interface Split {
	low: number;
	high: number;
	imbalance: number;
	dev: number;
}

function splitMissing(need: number, tLow: number | null, tHigh: number | null): Split | null {
	if (need === 0)
		return {
			low: 0,
			high: 0,
			imbalance: tLow != null && tHigh != null ? Math.abs(tLow - tHigh) : 0,
			dev: 0,
		};
	let best: { low: number; high: number; cost: number } | null = null;
	for (let k = 0; k <= need; k++) {
		let cost: number;
		if (tLow != null && tHigh != null) {
			const mL = tLow - k;
			const mH = tHigh - (need - k);
			cost =
				Math.abs(mL - mH) +
				0.25 * (Math.abs(mL - WINDOW_MARGIN) + Math.abs(mH - WINDOW_MARGIN));
		} else if (tLow != null) {
			cost = Math.abs(tLow - k - WINDOW_MARGIN);
		} else if (tHigh != null) {
			cost = Math.abs(tHigh - (need - k) - WINDOW_MARGIN);
		} else {
			return null;
		}
		if (!best || cost < best.cost) best = { low: k, high: need - k, cost };
	}
	if (!best) return null;
	const imbalance =
		tLow != null && tHigh != null
			? Math.abs(tLow - best.low - (tHigh - best.high))
			: Math.abs(
					((tLow ?? tHigh) as number) - (tLow != null ? best.low : best.high) - WINDOW_MARGIN,
				);
	const dev = Math.max(
		tLow != null && best.low > 0 ? Math.abs(tLow - best.low - WINDOW_MARGIN) : 0,
		tHigh != null && best.high > 0 ? Math.abs(tHigh - best.high - WINDOW_MARGIN) : 0,
	);
	return { low: best.low, high: best.high, imbalance, dev };
}

function countInBand(
	pk: Peaks,
	w: number,
	h: number,
	Hp: Mat3,
	c0: number,
	c1: number,
	r0: number,
	r1: number,
): number {
	const { xs, ys, strong, N } = pk;
	const Hinv = invert3(Hp);
	const pts: number[][] = [];
	for (let k = 0; k < xs.length; k++) {
		if (!strong[k]) continue;
		const [c, r] = applyH(Hinv, [xs[k], ys[k]]);
		if (!(c >= c0 && c <= c1 && r >= r0 && r <= r1)) continue;
		const v = sample(N, w, h, xs[k], ys[k]);
		let isolated = v > 0;
		for (const [dc, dr] of [
			[0.5, 0],
			[-0.5, 0],
			[0, 0.5],
			[0, -0.5],
		]) {
			if (!isolated) break;
			const q = applyH(Hp, [c + dc, r + dr]);
			const m = sample(N, w, h, q[0], q[1]);
			if (!(m < 0.5 * v)) isolated = false;
		}
		if (isolated) pts.push([c, r]);
	}
	if (pts.length > 4000) return 0;
	let n = 0;
	for (const [c, r] of pts) {
		let nb = 0;
		for (const [c2, r2] of pts) {
			const dc = Math.abs(c2 - c);
			const dr = Math.abs(r2 - r);
			if ((Math.abs(dc - 1) < 0.3 && dr < 0.3) || (Math.abs(dr - 1) < 0.3 && dc < 0.3)) nb++;
		}
		if (nb >= 2) n++;
	}
	return n;
}

/* ------------------------------------------------------------- detector -- */

/**
 * Find the DOT Pad pin lattice in a grayscale frame (blocking).
 * See {@link latticeSearch} for the incremental form.
 */
export function detectDotpadLattice(
	img: GrayImage,
	options: Partial<LatticeOptions> = {},
): LatticeDetection | null {
	const it = latticeSearch(img, options);
	for (;;) {
		const st = it.next();
		if (st.done) return st.value;
	}
}

/**
 * {@link detectDotpadLattice} as a generator: it yields after every scale
 * hypothesis (tens to a few hundred ms each at 720p) so a caller can spread one
 * frame's search over several animation ticks; the final `{done: true, value}`
 * is the detection or null. The frame is copied up front, so the caller may
 * reuse its buffer.
 */
export function* latticeSearch(
	img: GrayImage,
	options: Partial<LatticeOptions> = {},
): Generator<void, LatticeDetection | null, void> {
	const o: LatticeOptions = { ...LATTICE_DEFAULTS, ...options };
	latticeDiagnostics.trace = o.trace ? [] : null;
	const { width: w0, height: h0 } = img;
	const base = new Float32Array(w0 * h0);
	for (let i = 0; i < base.length; i++) base[i] = img.data[i];

	type Level = { data: Float32Array; w: number; h: number };
	const levels = new Map<number, Level>([[0, { data: base, w: w0, h: h0 }]]);
	let top = 0;
	while (Math.min((levels.get(top) as Level).w, (levels.get(top) as Level).h) >= 2 * o.minLevelSide) {
		const l = levels.get(top) as Level;
		levels.set(++top, halve(l.data, l.w, l.h));
	}
	const firstLevel = w0 * h0 > o.maxLevel0Pixels ? 1 : 0;
	const upsample = w0 * h0 <= o.upsampleMaxPixels;
	const level = (L: number): Level => {
		if (L === -1 && !levels.has(-1)) levels.set(-1, double(base, w0, h0));
		return levels.get(L) as Level;
	};

	type Hyp = { L: number; pw: number; px: number };
	let hyps: Hyp[] = [];
	for (let L = top; L >= firstLevel; L--) {
		for (const pw of o.workPitches) hyps.push({ L, pw, px: pw * 2 ** L });
	}
	if (upsample) hyps.push({ L: -1, pw: 2 * o.minPitch, px: o.minPitch });
	else if (firstLevel === 0) hyps.push({ L: 0, pw: o.minPitch, px: o.minPitch });
	if (o.pitchHint) {
		const hint = o.pitchHint;
		const d = (hy: Hyp) => Math.abs(Math.log(hy.px / hint));
		hyps = [...hyps].sort((p, q) => d(p) - d(q));
	}

	let reason = 'no-lattice';
	for (const pol of o.polarities) {
		const cache = new Map<number, Float32Array>();
		const levelImg = (L: number): Float32Array => {
			let c = cache.get(L);
			if (!c) {
				const l = level(L);
				c = pol > 0 ? l.data : l.data.map((v) => 255 - v);
				cache.set(L, c);
			}
			return c;
		};
		const refined: number[] = [];
		for (const hy of hyps) {
			yield;
			const l = level(hy.L);
			latticeDiagnostics.trace?.push(`pol ${pol} L${hy.L} pw ${hy.pw}`);
			const A = stageA(levelImg(hy.L), l.w, l.h, hy.pw, o);
			if (!A) {
				reason = latticeDiagnostics.lastReason || reason;
				continue;
			}
			if (A.comp.length < 0.5 * o.minMembers) {
				reason = 'small-component';
				continue;
			}
			const pFull = A.pitch0 * 2 ** hy.L;
			if (refined.some((p) => Math.abs(Math.log(p / pFull)) < 0.1)) continue;
			refined.push(pFull);
			let L = firstLevel;
			while (L < top && pFull / 2 ** (L + 1) >= 5) L++;
			if (pFull < 4 && upsample) L = -1;
			const pw = pFull / 2 ** L;
			const same = L === hy.L && Math.abs(Math.log(pw / hy.pw)) < 0.1;
			const lr = level(L);
			latticeDiagnostics.trace?.push(`  refine → L${L} pw ${pw.toFixed(2)}`);
			if (!same) yield;
			const A2 = same ? A : stageA(levelImg(L), lr.w, lr.h, pw, o);
			if (!A2 || A2.comp.length < 0.5 * o.minMembers) {
				reason = latticeDiagnostics.lastReason || 'small-component';
				continue;
			}
			yield;
			const r = stageB(lr.w, lr.h, A2, pol > 0 ? o : { ...o, inverted: true });
			if (r) return finish(r, L, pol);
			reason = latticeDiagnostics.lastReason || reason;
		}
	}
	return fail(reason);

	function finish(r: StageBResult, L: number, pol: number): LatticeDetection {
		const s = 2 ** L;
		const off = (s - 1) / 2;
		const T = [
			[s, 0, off],
			[0, s, off],
			[0, 0, 1],
		];
		const H = matMul3(T, r.H);
		latticeDiagnostics.lastReason = null;
		return {
			...r,
			H,
			pinCorners: r.pinCorners.map(([x, y]) => [x * s + off, y * s + off] as Point),
			pitchPx: r.pitchPx * s,
			rmsPx: r.rmsPx * s,
			level: L,
			polarity: pol,
		};
	}
}

interface StageA {
	pk: Peaks;
	pitch0: number;
	basis: Basis;
	comp: Member[];
}

function stageA(f: Float32Array, w: number, h: number, pw: number, o: LatticeOptions): StageA | null {
	const pk = dotPeaks(f, w, h, pw, o);
	const { xs, ys, strong } = pk;
	const strongIdx: number[] = [];
	for (let k = 0; k < xs.length; k++) if (strong[k]) strongIdx.push(k);
	if (strongIdx.length < 50) return fail('too-few-peaks');
	const grid0 = makeGrid(xs, ys, pw);
	const pitch0 = estimatePitch(xs, ys, strongIdx, grid0, 2.2 * pw);
	if (!pitch0 || pitch0 < 0.6 * pw || pitch0 > 1.6 * pw) return fail('pitch-out-of-range');
	const grid = makeGrid(xs, ys, pitch0);
	const basis = estimateBasis(xs, ys, strongIdx, grid, pitch0);
	if (!basis) return fail('no-basis');
	const comp = largestComponent(xs, ys, strongIdx, grid, basis, pitch0, o.stepTol);
	if (!comp) return fail('no-component');
	latticeDiagnostics.trace?.push(
		`  peaks ${xs.length} strong ${strongIdx.length} pitch ${pitch0.toFixed(2)} comp ${comp.length}`,
	);
	return { pk, pitch0, basis, comp };
}

type StageBResult = Omit<LatticeDetection, 'level' | 'polarity'>;

function stageB(w: number, h: number, A: StageA, o: LatticeOptions): StageBResult | null {
	const { pk, comp } = A;
	const { xs, ys } = pk;
	let fit = robustFit(xs, ys, comp);
	if (!fit) return fail('fit');

	let ext: Ext = {
		i0: Math.min(...fit.members.map((m) => m[1])),
		i1: Math.max(...fit.members.map((m) => m[1])),
		j0: Math.min(...fit.members.map((m) => m[2])),
		j1: Math.max(...fit.members.map((m) => m[2])),
	};

	let map: Map<number, Assigned> | null = null;
	for (let round = 0; round < 80; round++) {
		map = reassign(xs, ys, fit.H, ext, o.assignTol);
		if (!map) return fail('reassign');
		const occ = lineOccupancy(map, ext);
		const next = { ...ext };
		if (occ.col(ext.i0 - 1) >= o.growOcc) next.i0 -= 1;
		else if (occ.col(ext.i0) < o.trimOcc) next.i0 += 1;
		if (occ.col(ext.i1 + 1) >= o.growOcc) next.i1 += 1;
		else if (occ.col(ext.i1) < o.trimOcc) next.i1 -= 1;
		if (occ.row(ext.j0 - 1) >= o.growOcc) next.j0 -= 1;
		else if (occ.row(ext.j0) < o.trimOcc) next.j0 += 1;
		if (occ.row(ext.j1 + 1) >= o.growOcc) next.j1 += 1;
		else if (occ.row(ext.j1) < o.trimOcc) next.j1 -= 1;
		if (next.i1 - next.i0 >= COLS + 4 || next.j1 - next.j0 >= COLS + 4)
			return fail('lattice-too-large');
		if (next.i1 < next.i0 || next.j1 < next.j0) return fail('lattice-vanished');
		const inside = [...map.values()].filter(
			(m) => m[1] >= next.i0 && m[1] <= next.i1 && m[2] >= next.j0 && m[2] <= next.j1,
		);
		const refit = robustFit(xs, ys, inside);
		if (!refit) return fail('refit');
		fit = refit;
		const same =
			next.i0 === ext.i0 && next.i1 === ext.i1 && next.j0 === ext.j0 && next.j1 === ext.j1;
		ext = next;
		if (same && round > 0) break;
	}
	if (fit.members.length < o.minMembers) return fail('few-members');

	const ci = (ext.i0 + ext.i1) / 2;
	const cj = (ext.j0 + ext.j1) / 2;
	const pc = applyH(fit.H, [ci, cj]);
	const pa = applyH(fit.H, [ci + 1, cj]);
	const pb = applyH(fit.H, [ci, cj + 1]);
	const pitch = (hypot(pa[0] - pc[0], pa[1] - pc[1]) + hypot(pb[0] - pc[0], pb[1] - pc[1])) / 2;
	if (fit.rmsIdx > o.maxRmsPitch) return fail('rms');

	const nI = ext.i1 - ext.i0 + 1;
	const nJ = ext.j1 - ext.j0 + 1;
	const sides: Record<'iLow' | 'iHigh' | 'jLow' | 'jHigh', Side> = {
		iLow: { axis: 'i', dir: -1 },
		iHigh: { axis: 'i', dir: 1 },
		jLow: { axis: 'j', dir: -1 },
		jHigh: { axis: 'j', dir: 1 },
	};
	type ExtHyp = {
		longIsI: boolean;
		si: Split;
		sj: Split;
		t: Record<string, number | null>;
		cost: number;
	};
	const hyps: ExtHyp[] = [];
	for (const longIsI of [true, false]) {
		const needI = (longIsI ? COLS : ROWS) - nI;
		const needJ = (longIsI ? ROWS : COLS) - nJ;
		if (needI < 0 || needJ < 0 || needI > o.maxMissing || needJ > o.maxMissing) continue;
		const t: Record<string, number | null> = {};
		for (const [k, sd] of Object.entries(sides)) {
			t[k] = windowEdge(
				pk.bg,
				w,
				h,
				fit.H,
				ext,
				sd,
				sd.axis === 'i' ? needI : needJ,
				o.minEdgeContrast,
			);
		}
		const si = splitMissing(needI, t.iLow, t.iHigh);
		const sj = splitMissing(needJ, t.jLow, t.jHigh);
		if (!si || !sj) continue;
		const unbalanced = (sp: Split, need: number) =>
			(need > 0 || o.inverted) && sp.imbalance > o.maxImbalance;
		if (unbalanced(si, needI) || unbalanced(sj, needJ)) continue;
		if ((needI > 0 && si.dev > o.maxMarginDev) || (needJ > 0 && sj.dev > o.maxMarginDev))
			continue;
		hyps.push({ longIsI, si, sj, t, cost: needI + needJ + si.imbalance + sj.imbalance });
	}
	if (!hyps.length) return fail(`extent-unresolved ${nI}x${nJ}`);
	hyps.sort((p, q) => p.cost - q.cost);
	const hy = hyps[0];
	const E: Ext = {
		i0: ext.i0 - hy.si.low,
		i1: ext.i1 + hy.si.high,
		j0: ext.j0 - hy.sj.low,
		j1: ext.j1 + hy.sj.high,
	};

	map = reassign(xs, ys, fit.H, E, o.assignTol);
	if (!map) return fail('reassign');
	const within = [...map.values()].filter(
		(m) => m[1] >= E.i0 && m[1] <= E.i1 && m[2] >= E.j0 && m[2] <= E.j1,
	);
	const coverage = within.length / (COLS * ROWS);
	if (coverage < o.minCoverage) return fail(`coverage ${coverage.toFixed(2)}`);
	const occE = lineOccupancy(map, E);
	const outside = Math.max(
		occE.col(E.i0 - 1),
		occE.col(E.i1 + 1),
		occE.row(E.j0 - 1),
		occE.row(E.j1 + 1),
	);
	if (outside > o.maxOutsideOcc) return fail(`outside-occupied ${outside.toFixed(2)}`);
	const blk = 8;
	const has = new Set(within.map((m) => (m[1] + 4096) * 8192 + (m[2] + 4096)));
	const cornerOcc = (ia: number, ja: number, di: number, dj: number) => {
		let c = 0;
		let t = 0;
		for (let a = 0; a < blk; a++)
			for (let b = 0; b < blk; b++) {
				const i = ia + di * a;
				const j = ja + dj * b;
				if (i < ext.i0 || i > ext.i1 || j < ext.j0 || j > ext.j1) continue;
				t++;
				if (has.has((i + 4096) * 8192 + (j + 4096))) c++;
			}
		return t ? c / t : 0;
	};
	const minCorner = Math.min(
		cornerOcc(ext.i0, ext.j0, 1, 1),
		cornerOcc(ext.i1, ext.j0, -1, 1),
		cornerOcc(ext.i1, ext.j1, -1, -1),
		cornerOcc(ext.i0, ext.j1, 1, -1),
	);
	if (minCorner < o.minCornerOcc) return fail(`corner-occupancy ${minCorner.toFixed(2)}`);
	const midRatio = midpointRatio(pk.N, w, h, fit.H, ext);
	if (!(midRatio <= o.maxMidRatio)) return fail(`not-isolated-dots ${midRatio.toFixed(2)}`);

	const Ac = [E.i0, E.j0];
	const Bc = [E.i1, E.j0];
	const Cc = [E.i1, E.j1];
	const Dc = [E.i0, E.j1];
	const orders = hy.longIsI
		? [
				[Ac, Bc, Cc, Dc],
				[Bc, Ac, Dc, Cc],
				[Cc, Dc, Ac, Bc],
				[Dc, Cc, Bc, Ac],
			]
		: [
				[Ac, Dc, Cc, Bc],
				[Dc, Ac, Bc, Cc],
				[Cc, Bc, Ac, Dc],
				[Bc, Cc, Dc, Ac],
			];
	const pinIdx: Point[] = [
		[0, 0],
		[COLS - 1, 0],
		[COLS - 1, ROWS - 1],
		[0, ROWS - 1],
	];
	const clockwise = (q: Point[]) => {
		for (let k = 0; k < 4; k++) {
			const a = q[k];
			const b = q[(k + 1) % 4];
			const c = q[(k + 2) % 4];
			if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) <= 0) return false;
		}
		return true;
	};
	const cands = orders
		.map((ord) => {
			const M = homography4(pinIdx, ord);
			const Hp = matMul3(fit.H, M);
			return { M, Hp, corners: pinIdx.map((p) => applyH(Hp, p)) };
		})
		.filter((cd) => clockwise(cd.corners));
	if (cands.length !== 2) return fail('handedness');
	const band = (cd: { Hp: Mat3 }) =>
		countInBand(pk, w, h, cd.Hp, TEXT_C0, TEXT_C1, TEXT_R0 - 1, TEXT_R1 + 1);
	const below = band(cands[0]);
	const above = band(cands[1]);
	let pick = cands[0];
	let textFound = false;
	if (below >= o.minText && below >= 2 * above + 3) {
		textFound = true;
	} else if (above >= o.minText && above >= 2 * below + 3) {
		pick = cands[1];
		textFound = true;
	} else {
		const s = (cd: { corners: Point[] }) => cd.corners[0][0] + cd.corners[0][1];
		if (s(cands[1]) < s(cands[0])) pick = cands[1];
	}
	const flipped = pick === cands[1];

	const Minv = invert3(pick.M);
	const pinMembers = within.map((m) => {
		const [c, r] = applyH(Minv, [m[1], m[2]]);
		return [m[0], Math.round(c), Math.round(r)];
	});
	const fin = robustFit(xs, ys, pinMembers) || {
		H: pick.Hp,
		members: pinMembers,
		rms: fit.rms,
		rmsIdx: fit.rmsIdx,
	};
	const Hpin = fin.H;
	const pinCorners = pinIdx.map((p) => applyH(Hpin, p));

	const addedDet: Record<string, number> = {
		iLow: hy.si.low,
		iHigh: hy.si.high,
		jLow: hy.sj.low,
		jHigh: hy.sj.high,
	};
	const sideOfPin = (name: 'left' | 'right' | 'top' | 'bottom') => {
		const probe = {
			left: [-1, 19.5],
			right: [COLS, 19.5],
			top: [29.5, -1],
			bottom: [29.5, ROWS],
		}[name];
		const [i, j] = applyH(pick.M, probe);
		if (i < E.i0) return 'iLow';
		if (i > E.i1) return 'iHigh';
		if (j < E.j0) return 'jLow';
		return 'jHigh';
	};
	const added = { left: 0, right: 0, top: 0, bottom: 0 };
	const margins: Record<'left' | 'right' | 'top' | 'bottom', number | null> = {
		left: null,
		right: null,
		top: null,
		bottom: null,
	};
	for (const nm of ['left', 'right', 'top', 'bottom'] as const) {
		const sd = sideOfPin(nm);
		added[nm] = addedDet[sd];
		const tv = hy.t[sd];
		margins[nm] = tv == null ? null : +(tv - addedDet[sd]).toFixed(2);
	}

	const nAdded = added.left + added.right + added.top + added.bottom;
	const score =
		coverage *
		Math.max(0, 1 - fin.rmsIdx / 0.25) *
		Math.max(0.3, 1 - 0.04 * nAdded) *
		(textFound ? 1 : 0.9);
	return {
		pinCorners,
		H: Hpin,
		pitchPx: pitch,
		members: fin.members.length,
		coverage,
		rmsPx: fin.rms,
		rmsPitch: fin.rmsIdx,
		detected: { cols: hy.longIsI ? nI : nJ, rows: hy.longIsI ? nJ : nI },
		added,
		margins,
		textFound,
		needsConfirm: !textFound,
		text: { below: flipped ? above : below, above: flipped ? below : above },
		midRatio,
		score,
	};
}

/* ------------------------------------------------------- multi-frame -- */

/** Result of {@link aggregateDetections}. */
export interface AggregatedDetection {
	pinCorners: Point[];
	textFound: boolean;
	needsConfirm: boolean;
	frames: number;
	agreed: number;
	spreadPx: number;
	pitchPx: number;
}

/**
 * Combine several single-frame detections (hands-off frames of a static pad):
 * align every result's corner order to a reference, take the per-coordinate
 * median, drop results more than `maxDevPitch` pitches off, and decide the
 * orientation by vote among the text-confirmed ones.
 */
export function aggregateDetections(
	results: Array<Pick<LatticeDetection, 'pinCorners' | 'textFound' | 'pitchPx'> | null>,
	{ minAgree = 2, maxDevPitch = 1.5 } = {},
): AggregatedDetection | null {
	const ok = (results || []).filter(
		(r): r is Pick<LatticeDetection, 'pinCorners' | 'textFound' | 'pitchPx'> => !!r,
	);
	if (!ok.length) return null;
	const ref = ok.find((r) => r.textFound) || ok[0];
	const cornerDist = (p: Point[], q: Point[]) =>
		p.reduce((s, c, k) => s + hypot(c[0] - q[k][0], c[1] - q[k][1]), 0) / 4;
	const aligned = ok.map((r) => {
		let bestR = 0;
		let bestD = Number.POSITIVE_INFINITY;
		for (let k = 0; k < 4; k++) {
			const d = cornerDist(rotateQuad(r.pinCorners, k), ref.pinCorners);
			if (d < bestD) {
				bestD = d;
				bestR = k;
			}
		}
		const vote = r.textFound ? (bestR === 0 ? 1 : bestR === 2 ? -1 : 0) : 0;
		return { q: rotateQuad(r.pinCorners, bestR), pitch: r.pitchPx, vote };
	});
	const median = (arr: number[]) => {
		const s = [...arr].sort((a, b) => a - b);
		const m = s.length >> 1;
		return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
	};
	const medQuad = (set: typeof aligned): Point[] =>
		[0, 1, 2, 3].map((k) => [median(set.map((a) => a.q[k][0])), median(set.map((a) => a.q[k][1]))]);
	const pitch = median(aligned.map((a) => a.pitch));
	let m = medQuad(aligned);
	const inl = aligned.filter(
		(a) => Math.max(...a.q.map((c, k) => hypot(c[0] - m[k][0], c[1] - m[k][1]))) <= maxDevPitch * pitch,
	);
	if (inl.length < Math.min(minAgree, ok.length) || inl.length < 1) return null;
	m = medQuad(inl);
	const spread = Math.max(
		...inl.map((a) => Math.max(...a.q.map((c, k) => hypot(c[0] - m[k][0], c[1] - m[k][1])))),
	);
	const votes = inl.reduce((s, a) => s + a.vote, 0);
	const textFound = votes !== 0;
	return {
		pinCorners: votes < 0 ? rotateQuad(m, 2) : m,
		textFound,
		needsConfirm: !textFound,
		frames: ok.length,
		agreed: inl.length,
		spreadPx: spread,
		pitchPx: pitch,
	};
}
