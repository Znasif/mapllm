/**
 * Pad-anchored tracking without OpenCV: the LATTICE-FOLLOW tracker.
 *
 * Why: neither the camera nor the pad is guaranteed to stay put. A background
 * feature tracker (the starter's AKAZE) follows camera motion but not the pad
 * sliding on the table, because the background outvotes the pad. Here the pad's
 * own 2,400 pins are the features:
 *
 *   1. predict every pin position from the last pose (constant velocity,
 *      damped), pins c ∈ −1…cols, r ∈ −1…rows (the ring just outside the field
 *      included);
 *   2. compute the illumination-normalised dot response (`dotResponse`, the
 *      lattice detector's own) on the ROI only, at a working scale where the
 *      pitch is ≥ 5 px;
 *   3. look for the dot peak within ±0.45 pitch of each prediction (blob test,
 *      contrast floor from the frame's own noise); pins under a known occluder
 *      (the hand hull from MediaPipe) are not searched;
 *   4. fit a robust homography pin → px from the found pins (outliers rejected
 *      in index space), then repeat 3–4 once at ±0.3 pitch;
 *   5. accept only if enough pins, spread over the field, fit with a small
 *      residual, AND the border lines check out: the line just outside each
 *      side must be empty while the edge line is dotted. A ±1-pin alias (a jump
 *      of more than half a pitch between frames) fills one outside line with the
 *      real edge and empties one edge line, so it is refused, never accepted.
 *
 * Outcomes per frame: `tracking` (pose updated), `occluded` / `blank` (not
 * enough evidence; the last pose is kept and still usable), `lost` (evidence
 * contradicts the prediction; the last pose is kept but must not be used to
 * emit pins). After a contradiction a RELOCK runs on the same frame: dot peaks
 * in an enlarged ROI, mapped into the old pin frame, vote for a sub-pin phase;
 * the integer offset is the one whose 60 × 40 window holds the most dots with
 * empty outside lines, and must beat the runner-up by a clear margin, else no
 * relock (ambiguity is never resolved by guessing). Larger rotations and
 * anything relock cannot settle fall back to the full lattice search (driven by
 * the pointer when hands are off).
 *
 * PURE: typed arrays in, numbers out; frames come through {@link LumaFrame}.
 */

import {
	type Mat3,
	type Point,
	applyH,
	cornersOfPose,
	fitHomography,
	homography4,
	invert3,
	matMul3,
	pinIndexCorners,
} from './geometry';
import {
	type GrayImage,
	type PeakThresholds,
	blobAt,
	dogNoiseGain,
	dotResponse,
	downsample,
	findDotPeaks,
	pixelNoise,
} from './imageops';
import { latticeSearch, type LatticeDetection } from './lattice';
import { compareCorners } from './watchdog';

/** Read access to one camera frame's luma (0…255). */
export interface LumaFrame {
	readonly width: number;
	readonly height: number;
	/** Luma of the integer rectangle [x, x+w) × [y, y+h), row-major, length w·h. */
	read(x: number, y: number, w: number, h: number): ArrayLike<number>;
}

/** A {@link LumaFrame} over an in-memory grey image. */
export function lumaFrame(img: GrayImage): LumaFrame {
	const { data, width, height } = img;
	return {
		width,
		height,
		read(x, y, w, h) {
			if (x === 0 && y === 0 && w === width && h === height) return data;
			const out = new Uint8Array(w * h);
			for (let j = 0; j < h; j++) {
				const o = (y + j) * width + x;
				for (let i = 0; i < w; i++) out[j * w + i] = data[o + i];
			}
			return out;
		},
	};
}

/**
 * idle: no pose. loading: the tracker's engine is not ready yet (the pose given
 * to reset() is used as is). tracking / occluded / blank / lost: see the core.
 */
export type TrackState = 'idle' | 'loading' | 'tracking' | 'occluded' | 'blank' | 'lost';

/** One tracker step. `pose` is the current best pose (the last good one when not updated). */
export interface TrackStep {
	state: TrackState;
	pose: Mat3 | null;
	/** True when this frame updated the pose. */
	accepted: boolean;
	/** True when the pose was re-established by a relock (a jump). */
	relocked: boolean;
	/** Pins found inside the field / inliers of the fit. */
	found: number;
	inliers: number;
	/** Pins searched (not occluded, inside the image). */
	visible: number;
	/** Fit residual in tracker-specific units (lattice: RMS in pins; AKAZE: NaN). */
	residual: number;
	reason: string | null;
	ms: number;
}

/** Hints the host may pass per frame. */
export interface TrackHints {
	/** Convex polygons (image px) known to cover the pad, e.g. hand hulls. */
	occluders?: ArrayLike<number>[][];
	/** A hand is in view (from the hand landmarker). The full re-acquire only runs while false. */
	handsPresent?: boolean;
	/** Clock (ms), for the host's bookkeeping only. */
	now?: number;
	/** The registered surface's image quad (TL, TR, BR, BL px); passed by the core on every reset. */
	region?: ArrayLike<number>[];
}

/**
 * The tracker contract, so a host can plug in another one (e.g. an AKAZE
 * background tracker, or a static one).
 */
export interface Tracker {
	readonly pose: Mat3 | null;
	readonly state: TrackState;
	/** Start from a pose (pin → px). With a frame, the pose is refined/relocked on it. */
	reset(pose: Mat3, frame?: LumaFrame, hints?: TrackHints): TrackStep;
	/** Advance one frame. */
	update(frame: LumaFrame, hints?: TrackHints): TrackStep;
	/** Forget everything (state 'idle'). */
	clear(): void;
	/** Start loading whatever the tracker needs (e.g. OpenCV) ahead of the first reset. Optional. */
	prepare?(): void;
	/** Release everything (workers, engines). The tracker is not used afterwards. Optional. */
	dispose?(): void;
	/** Last step's detections in camera px, for the debug overlay. Optional. */
	readonly debug?: { found: Point[]; missing: Point[] } | null;
}

/** Tunables of {@link createLatticeTracker}. */
export interface LatticeTrackerOptions {
	cols: number;
	rows: number;
	/** +1 pins brighter than the surface (default), −1 darker. */
	polarity: 1 | -1;
	/** First-pass search radius, in pitches. */
	searchRadius: number;
	/** Second-pass search radius, in pitches. */
	refineRadius: number;
	/** Minimum inlier pins for an update. */
	minFound: number;
	/** Inliers must span this fraction of cols and of rows. */
	minSpan: number;
	/** Max fit residual (pins, index space). */
	maxRmsPin: number;
	/** Inliers / found inside the field. */
	minInlierFrac: number;
	/** Damping of the constant-velocity prediction (0 = none). */
	velocity: number;
	/** Occluder polygons are grown by this many pitches. */
	occluderMarginPins: number;
	/** Smallest working pitch (px): the ROI is box-downsampled by 2, 4, 8 while the pitch stays ≥ this. */
	minWorkPitch: number;
	/**
	 * When the alignment cannot be verified (a side hidden), the last pose is
	 * kept and used only while the dots sit within this many pins of it; beyond
	 * that the pad moved by an unknown amount and the state is 'lost'.
	 */
	maxHeldShiftPins: number;
	/** A first pass matching fewer than this × the usual fraction of visible pins means the pad jumped. */
	matchCollapse: number;
	/** After a failed relock, fewer dot peaks than this × the expected count means the pins are blank, not moved. */
	blankPeakFrac: number;
	/** Relock: pins of extra margin searched around the last pose. */
	relockMarginPins: number;
	/**
	 * While lost and no hand is in view, run the full lattice search on the
	 * frame, one scale hypothesis per update (the pad turned, or moved further
	 * than a relock can explain).
	 */
	reacquire: boolean;
	/** Frames to wait after a full search that found nothing. */
	reacquireCooldownFrames: number;
	nWeak: number;
	dWeak: number;
	kWeak: number;
	edgeRatio: number;
	eps: number;
}

export const LATTICE_TRACKER_DEFAULTS: Readonly<LatticeTrackerOptions> = Object.freeze({
	cols: 60,
	rows: 40,
	polarity: 1,
	searchRadius: 0.45,
	refineRadius: 0.3,
	minFound: 150,
	minSpan: 0.35,
	maxRmsPin: 0.15,
	minInlierFrac: 0.6,
	velocity: 0.7,
	occluderMarginPins: 1,
	minWorkPitch: 3.5,
	maxHeldShiftPins: 0.2,
	matchCollapse: 0.35,
	blankPeakFrac: 0.15,
	relockMarginPins: 8,
	reacquire: true,
	reacquireCooldownFrames: 15,
	nWeak: 0.5,
	dWeak: 0.8,
	kWeak: 3,
	edgeRatio: 7.2,
	eps: 1.5,
});

/* ---------------------------------------------------------- polygons -- */

/** Convex hull (monotone chain), counter-clockwise in y-down px. */
export function convexHull(points: ArrayLike<number>[]): Point[] {
	const pts = points.map((p) => [p[0], p[1]] as Point).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	if (pts.length < 3) return pts;
	const cross = (o: Point, a: Point, b: Point) =>
		(a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
	const lower: Point[] = [];
	for (const p of pts) {
		while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
			lower.pop();
		lower.push(p);
	}
	const upper: Point[] = [];
	for (let i = pts.length - 1; i >= 0; i--) {
		const p = pts[i];
		while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
			upper.pop();
		upper.push(p);
	}
	upper.pop();
	lower.pop();
	return lower.concat(upper);
}

/** Signed distance-ish test: is p inside convex polygon `poly` grown by `margin` px? */
function insideConvex(poly: Point[], x: number, y: number, margin: number): boolean {
	const n = poly.length;
	if (n < 3) return false;
	// Orientation of the polygon (hull is consistent; detect anyway).
	let area = 0;
	for (let i = 0; i < n; i++) {
		const a = poly[i];
		const b = poly[(i + 1) % n];
		area += a[0] * b[1] - b[0] * a[1];
	}
	const s = area >= 0 ? 1 : -1;
	for (let i = 0; i < n; i++) {
		const a = poly[i];
		const b = poly[(i + 1) % n];
		const ex = b[0] - a[0];
		const ey = b[1] - a[1];
		const len = Math.hypot(ex, ey) || 1;
		// Outward distance of p from edge a→b.
		const d = (s * -((x - a[0]) * ey - (y - a[1]) * ex)) / len;
		if (-d > margin) return false;
	}
	return true;
}

/* ----------------------------------------------------------- helpers -- */

const hypot = Math.hypot;

function translatePin(H: Mat3, du: number, dv: number): Mat3 {
	return matMul3(H, [
		[1, 0, du],
		[0, 1, dv],
		[0, 0, 1],
	]);
}

/** Per-frame search context: the dot response on one ROI at one working scale. */
interface Response {
	x0: number;
	y0: number;
	s: number;
	w: number;
	h: number;
	N: Float32Array;
	D: Float32Array;
	dWeak: number;
	noise: number;
	pitchW: number;
}

/** Detections of one pass over the (cols+2) × (rows+2) grid, c, r ∈ −1…cols/rows. */
interface Pass {
	/** Full-res px of the found peak per grid cell, NaN when not found. */
	x: Float64Array;
	y: Float64Array;
	/** 1 when the cell was searched (visible), else 0. */
	vis: Uint8Array;
}

/**
 * Normalised DLT over typed arrays (pin (c, r) → px (x, y)); entries with
 * w[j] = 0 are skipped. Same maths as `fitHomography`, without allocations.
 */
function dltFit(
	cs: Float64Array,
	rs: Float64Array,
	xs: Float64Array,
	ys: Float64Array,
	w: Uint8Array,
	n: number,
): Mat3 | null {
	let m = 0;
	let mc = 0;
	let mr = 0;
	let mx = 0;
	let my = 0;
	for (let j = 0; j < n; j++) {
		if (!w[j]) continue;
		m++;
		mc += cs[j];
		mr += rs[j];
		mx += xs[j];
		my += ys[j];
	}
	if (m < 4) return null;
	mc /= m;
	mr /= m;
	mx /= m;
	my /= m;
	let ds = 0;
	let dd = 0;
	for (let j = 0; j < n; j++) {
		if (!w[j]) continue;
		const a = cs[j] - mc;
		const b = rs[j] - mr;
		const c = xs[j] - mx;
		const d = ys[j] - my;
		ds += Math.sqrt(a * a + b * b);
		dd += Math.sqrt(c * c + d * d);
	}
	const ss = Math.SQRT2 / (ds / m || 1);
	const sd = Math.SQRT2 / (dd / m || 1);
	const A = new Float64Array(64);
	const bv = new Float64Array(8);
	const row = new Float64Array(8);
	const acc = (rhs: number) => {
		for (let a = 0; a < 8; a++) {
			const ra = row[a];
			if (ra === 0) continue;
			bv[a] += ra * rhs;
			const o = a * 8;
			for (let b = 0; b < 8; b++) A[o + b] += ra * row[b];
		}
	};
	for (let j = 0; j < n; j++) {
		if (!w[j]) continue;
		const u = (cs[j] - mc) * ss;
		const v = (rs[j] - mr) * ss;
		const x = (xs[j] - mx) * sd;
		const y = (ys[j] - my) * sd;
		row[0] = u;
		row[1] = v;
		row[2] = 1;
		row[3] = 0;
		row[4] = 0;
		row[5] = 0;
		row[6] = -u * x;
		row[7] = -v * x;
		acc(x);
		row[0] = 0;
		row[1] = 0;
		row[2] = 0;
		row[3] = u;
		row[4] = v;
		row[5] = 1;
		row[6] = -u * y;
		row[7] = -v * y;
		acc(y);
	}
	// Gaussian elimination with partial pivoting on the 8 × 8 normal equations.
	for (let c = 0; c < 8; c++) {
		let piv = c;
		for (let r = c + 1; r < 8; r++) if (Math.abs(A[r * 8 + c]) > Math.abs(A[piv * 8 + c])) piv = r;
		if (Math.abs(A[piv * 8 + c]) < 1e-12) return null;
		if (piv !== c) {
			for (let k = 0; k < 8; k++) {
				const t = A[c * 8 + k];
				A[c * 8 + k] = A[piv * 8 + k];
				A[piv * 8 + k] = t;
			}
			const t = bv[c];
			bv[c] = bv[piv];
			bv[piv] = t;
		}
		for (let r = c + 1; r < 8; r++) {
			const f = A[r * 8 + c] / A[c * 8 + c];
			if (f === 0) continue;
			for (let k = c; k < 8; k++) A[r * 8 + k] -= f * A[c * 8 + k];
			bv[r] -= f * bv[c];
		}
	}
	const h = new Float64Array(8);
	for (let r = 7; r >= 0; r--) {
		let t = bv[r];
		for (let k = r + 1; k < 8; k++) t -= A[r * 8 + k] * h[k];
		h[r] = t / A[r * 8 + r];
	}
	if (!h.every(Number.isFinite)) return null;
	const Hn = [
		[h[0], h[1], h[2]],
		[h[3], h[4], h[5]],
		[h[6], h[7], 1],
	];
	// H = Td⁻¹ · Hn · Ts
	const Ts = [
		[ss, 0, -ss * mc],
		[0, ss, -ss * mr],
		[0, 0, 1],
	];
	const TdInv = [
		[1 / sd, 0, mx],
		[0, 1 / sd, my],
		[0, 0, 1],
	];
	const H = matMul3(TdInv, matMul3(Hn, Ts));
	const s = H[2][2];
	return H.map((r) => r.map((x) => x / s));
}

/* ------------------------------------------------------------ tracker -- */

/** Create the lattice-follow tracker. */
export function createLatticeTracker(options: Partial<LatticeTrackerOptions> = {}): Tracker & {
	/** Last pass's detections, for the debug overlay. */
	readonly debug: { found: Point[]; missing: Point[] } | null;
} {
	const o: LatticeTrackerOptions = { ...LATTICE_TRACKER_DEFAULTS, ...options };
	const { cols, rows } = o;
	const GW = cols + 2;
	const GH = rows + 2;
	const cell = (c: number, r: number) => (r + 1) * GW + (c + 1);
	const PIN = pinIndexCorners(cols, rows);

	let pose: Mat3 | null = null;
	let prevCorners: Point[] | null = null; // corners of the pose before `pose`, when consecutive
	let state: TrackState = 'idle';
	let debug: { found: Point[]; missing: Point[] } | null = null;

	const thresholds: PeakThresholds = {
		nWeak: o.nWeak,
		dWeak: o.dWeak,
		kWeak: o.kWeak,
		edgeRatio: o.edgeRatio,
	};

	/** Mean pitch (px) of a pose over the field. */
	const pitchOf = (H: Mat3) => {
		const q = cornersOfPose(H, cols, rows);
		const top = hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]);
		const bot = hypot(q[2][0] - q[3][0], q[2][1] - q[3][1]);
		const lef = hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]);
		const rig = hypot(q[2][0] - q[1][0], q[2][1] - q[1][1]);
		return (top + bot + lef + rig) / (2 * (cols - 1) + 2 * (rows - 1));
	};

	/** Response over the bbox of pins [lo, hi] (pin units, inclusive) under H, plus `padPins`. */
	function respond(frame: LumaFrame, H: Mat3, margin: number): Response | null {
		const pitch = pitchOf(H);
		if (!(pitch > 1)) return null;
		let s = 1;
		while (pitch / (2 * s) >= o.minWorkPitch && s < 8) s *= 2;
		const ring = [
			[-margin, -margin],
			[cols - 1 + margin, -margin],
			[cols - 1 + margin, rows - 1 + margin],
			[-margin, rows - 1 + margin],
		].map((p) => applyH(H, p));
		if (!ring.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))) return null;
		const pad = 1.6 * pitch;
		let x0 = Math.floor(Math.min(...ring.map((p) => p[0])) - pad);
		let y0 = Math.floor(Math.min(...ring.map((p) => p[1])) - pad);
		let x1 = Math.ceil(Math.max(...ring.map((p) => p[0])) + pad);
		let y1 = Math.ceil(Math.max(...ring.map((p) => p[1])) + pad);
		x0 = Math.max(0, x0);
		y0 = Math.max(0, y0);
		x1 = Math.min(frame.width, x1);
		y1 = Math.min(frame.height, y1);
		let w = x1 - x0;
		let h = y1 - y0;
		w -= w % s;
		h -= h % s;
		if (w < 8 * s || h < 8 * s) return null;
		let raw = frame.read(x0, y0, w, h);
		if (o.polarity < 0) {
			const inv = new Float32Array(raw.length);
			for (let i = 0; i < raw.length; i++) inv[i] = 255 - raw[i];
			raw = inv;
		}
		const ds = downsample(raw, w, h, s);
		const pitchW = pitch / s;
		const r = dotResponse(ds.data, ds.w, ds.h, pitchW, o.eps);
		// Noise floor: estimated at FULL resolution (at the working scale a dense
		// dot field reads as high-frequency "noise"), averaged down by s.
		const noise = s > 1 ? (pixelNoise(raw, w, h) / s) * dogNoiseGain(r.sd, r.sb) : r.noise;
		return {
			x0,
			y0,
			s,
			w: ds.w,
			h: ds.h,
			N: r.N,
			D: r.D,
			noise,
			dWeak: Math.max(o.dWeak, o.kWeak * noise),
			pitchW,
		};
	}

	const toW = (R: Response, x: number, y: number): Point => [
		(x - R.x0 - (R.s - 1) / 2) / R.s,
		(y - R.y0 - (R.s - 1) / 2) / R.s,
	];
	const toFull = (R: Response, xw: number, yw: number): Point => [
		R.x0 + R.s * xw + (R.s - 1) / 2,
		R.y0 + R.s * yw + (R.s - 1) / 2,
	];

	/** Search every grid cell for its dot within `radius` pitches of H's prediction. */
	function search(R: Response, H: Mat3, radius: number, occluders: Point[][]): Pass {
		const n = GW * GH;
		const x = new Float64Array(n).fill(Number.NaN);
		const y = new Float64Array(n).fill(Number.NaN);
		const vis = new Uint8Array(n);
		const { N, D, w, h, s: S, x0: X0, y0: Y0 } = R;
		const off = (S - 1) / 2;
		const [[h00, h01, h02], [h10, h11, h12], [h20, h21, h22]] = H;
		const nWeak = o.nWeak;
		const dWeak = R.dWeak;
		const edgeRatio = o.edgeRatio;
		for (let r = -1; r <= rows; r++) {
			for (let c = -1; c <= cols; c++) {
				const zw = h20 * c + h21 * r + h22;
				const px = (h00 * c + h01 * r + h02) / zw;
				const py = (h10 * c + h11 * r + h12) / zw;
				const k = cell(c, r);
				if (occluders.length) {
					let hidden = false;
					for (const poly of occluders) {
						if (insideConvex(poly, px, py, 0)) {
							hidden = true;
							break;
						}
					}
					if (hidden) continue;
				}
				const zq = zw + h20;
				const qx = (h00 * (c + 1) + h01 * r + h02) / zq;
				const qy = (h10 * (c + 1) + h11 * r + h12) / zq;
				const ex = qx - px;
				const ey = qy - py;
				const lp = Math.sqrt(ex * ex + ey * ey) / S; // local pitch, working px
				const rad = Math.max(1, radius * lp);
				const rad2 = rad * rad;
				const cx = (px - X0 - off) / S;
				const cy = (py - Y0 - off) / S;
				const ri = Math.ceil(rad);
				const icx = Math.round(cx);
				const icy = Math.round(cy);
				const xa = icx - ri;
				const xb = icx + ri;
				const ya = icy - ri;
				const yb = icy + ri;
				if (xa < 1 || ya < 1 || xb > w - 2 || yb > h - 2) continue; // not (fully) visible
				vis[k] = 1;
				let best = -1;
				let bv = Number.NEGATIVE_INFINITY;
				for (let yy = ya; yy <= yb; yy++) {
					const dy = yy - cy;
					const dy2 = dy * dy;
					const row = yy * w;
					for (let xx = xa; xx <= xb; xx++) {
						const dx = xx - cx;
						if (dx * dx + dy2 > rad2) continue;
						const v = N[row + xx];
						if (v > bv) {
							bv = v;
							best = row + xx;
						}
					}
				}
				if (best < 0 || bv < nWeak || D[best] < dWeak) continue;
				// The maximum must be a true local peak (not the window clipping a slope).
				if (
					N[best - 1] > bv ||
					N[best + 1] > bv ||
					N[best - w] > bv ||
					N[best + w] > bv ||
					N[best - w - 1] > bv ||
					N[best - w + 1] > bv ||
					N[best + w - 1] > bv ||
					N[best + w + 1] > bv
				)
					continue;
				const sub = blobAt(N, w, best, edgeRatio);
				if (!sub) continue;
				const bx = best % w;
				const by = (best - bx) / w;
				x[k] = X0 + S * (bx + sub[0]) + off;
				y[k] = Y0 + S * (by + sub[1]) + off;
			}
		}
		return { x, y, vis };
	}

	interface FitResult {
		H: Mat3;
		inliers: number;
		found: number;
		rmsPin: number;
		spanC: number;
		spanR: number;
	}

	/** Robust fit pin → px over found cells inside the field (outliers rejected in index space). */
	function fit(P: Pass, maxIter = 4): FitResult | null {
		const nMax = cols * rows;
		const cs = new Float64Array(nMax);
		const rs = new Float64Array(nMax);
		const xs = new Float64Array(nMax);
		const ys = new Float64Array(nMax);
		let found = 0;
		for (let r = 0; r < rows; r++)
			for (let c = 0; c < cols; c++) {
				const k = cell(c, r);
				if (P.x[k] === P.x[k]) {
					cs[found] = c;
					rs[found] = r;
					xs[found] = P.x[k];
					ys[found] = P.y[k];
					found++;
				}
			}
		if (found < 8) return null;
		const wt = new Uint8Array(found).fill(1);
		const res = new Float64Array(found);
		let H: Mat3 | null = null;
		let rmsPin = Number.POSITIVE_INFINITY;
		let kept = found;
		const act = new Float64Array(found);
		for (let it = 0; it < maxIter; it++) {
			H = dltFit(cs, rs, xs, ys, wt, found);
			if (!H) return null;
			let Hi: Mat3;
			try {
				Hi = invert3(H);
			} catch {
				return null;
			}
			const [[a0, a1, a2], [b0, b1, b2], [g0, g1, g2]] = Hi;
			let na = 0;
			for (let j = 0; j < found; j++) {
				const z = g0 * xs[j] + g1 * ys[j] + g2;
				const u = (a0 * xs[j] + a1 * ys[j] + a2) / z - cs[j];
				const v = (b0 * xs[j] + b1 * ys[j] + b2) / z - rs[j];
				res[j] = Math.sqrt(u * u + v * v);
				if (wt[j]) act[na++] = res[j];
			}
			const sorted = act.subarray(0, na).sort();
			const med = sorted[na >> 1];
			const thr = Math.max(0.08, Math.min(0.25, 4 * med));
			let nk = 0;
			let s2 = 0;
			for (let j = 0; j < found; j++) {
				if (wt[j] && res[j] <= thr) {
					nk++;
					s2 += res[j] * res[j];
				}
			}
			rmsPin = Math.sqrt(s2 / Math.max(1, nk));
			kept = nk;
			if (nk < 8) break;
			let changed = false;
			for (let j = 0; j < found; j++) {
				if (wt[j] && res[j] > thr) {
					wt[j] = 0;
					changed = true;
				}
			}
			if (!changed) break;
		}
		if (!H) return null;
		let c0 = cols;
		let c1 = -1;
		let r0 = rows;
		let r1 = -1;
		for (let j = 0; j < found; j++) {
			if (!wt[j]) continue;
			c0 = Math.min(c0, cs[j]);
			c1 = Math.max(c1, cs[j]);
			r0 = Math.min(r0, rs[j]);
			r1 = Math.max(r1, rs[j]);
		}
		return {
			H,
			inliers: kept,
			found,
			rmsPin,
			spanC: (c1 - c0 + 1) / cols,
			spanR: (r1 - r0 + 1) / rows,
		};
	}

	/**
	 * Border lines: per side, the outside line must be (nearly) empty and the
	 * edge line dotted when the next line in is. Returns 'ok', 'fail' (an alias
	 * signature) or 'unverified' (an axis without a visible side).
	 */
	function borderCheck(P: Pass): { verdict: 'ok' | 'fail' | 'unverified'; detail: string } {
		const occ = (line: Array<[number, number]>) => {
			let v = 0;
			let f = 0;
			for (const [c, r] of line) {
				const k = cell(c, r);
				if (!P.vis[k]) continue;
				v++;
				if (Number.isFinite(P.x[k])) f++;
			}
			return { vis: v / line.length, occ: v ? f / v : 0 };
		};
		const col = (c: number) => Array.from({ length: rows }, (_, r) => [c, r] as [number, number]);
		const row = (r: number) => Array.from({ length: cols }, (_, c) => [c, r] as [number, number]);
		const sides = {
			left: [col(-1), col(0), col(1)],
			right: [col(cols), col(cols - 1), col(cols - 2)],
			top: [row(-1), row(0), row(1)],
			bottom: [row(rows), row(rows - 1), row(rows - 2)],
		};
		const res: Record<string, 'ok' | 'fail' | 'skip'> = {};
		const notes: string[] = [];
		for (const [name, [out, edge, inner]] of Object.entries(sides)) {
			const O = occ(out);
			const E = occ(edge);
			const I = occ(inner);
			if (O.vis < 0.3 || E.vis < 0.3) {
				res[name] = 'skip';
				continue;
			}
			const outsideFull = O.occ >= 0.3 && O.occ > 0.5 * E.occ;
			const edgeEmpty = I.vis >= 0.3 && I.occ >= 0.5 && E.occ < 0.25 * I.occ;
			res[name] = outsideFull || edgeEmpty ? 'fail' : 'ok';
			notes.push(`${name} ${O.occ.toFixed(2)}/${E.occ.toFixed(2)}/${I.occ.toFixed(2)}`);
		}
		const detail = notes.join(' ');
		if (Object.values(res).includes('fail')) return { verdict: 'fail', detail };
		const axisOk = (a: string, b: string) => res[a] === 'ok' || res[b] === 'ok';
		if (!axisOk('left', 'right') || !axisOk('top', 'bottom')) return { verdict: 'unverified', detail };
		return { verdict: 'ok', detail };
	}

	type Eval =
		| { kind: 'ok'; fit: FitResult; pass: Pass; visible: number }
		| { kind: 'weak' | 'bad'; reason: string; fit: FitResult | null; pass: Pass; visible: number };

	/** Two passes from a prediction, then the gates. */
	/** Max over the four field corners of the distance between two poses, in pins. */
	function poseShiftPins(A: Mat3, B: Mat3): number {
		const pitch = pitchOf(A);
		let worst = 0;
		for (const p of PIN) {
			const a = applyH(A, p);
			const b = applyH(B, p);
			worst = Math.max(worst, hypot(a[0] - b[0], a[1] - b[1]) / pitch);
		}
		return worst;
	}

	function evaluate(R: Response, Hpred: Mat3, occluders: Point[][]): Eval {
		const P1 = search(R, Hpred, o.searchRadius, occluders);
		const F1 = fit(P1, 2);
		const visibleOf = (P: Pass) => {
			let v = 0;
			for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) v += P.vis[cell(c, r)];
			return v;
		};
		if (!F1 || F1.inliers < o.minFound) {
			// Few matches where many pins are visible and used to match: the dots
			// are not where the pose says (the pad jumped) — a contradiction, not
			// a lack of evidence. (Blank pins are told apart after the relock.)
			const vis1 = visibleOf(P1);
			const frac = (F1?.found ?? 0) / Math.max(1, vis1);
			const collapse = refFrac != null && vis1 >= 2 * o.minFound && frac < o.matchCollapse * refFrac;
			return {
				kind: collapse ? 'bad' : 'weak',
				reason: `few-pins ${F1?.inliers ?? 0}${collapse ? ` of ${vis1} visible (was ${(100 * (refFrac ?? 0)).toFixed(0)}%)` : ''}`,
				fit: F1,
				pass: P1,
				visible: vis1,
			};
		}
		const P2 = search(R, F1.H, o.refineRadius, occluders);
		const F2 = fit(P2);
		const visible = visibleOf(P2);
		if (!F2 || F2.inliers < o.minFound)
			return { kind: 'weak', reason: `few-pins ${F2?.inliers ?? 0}`, fit: F2, pass: P2, visible };
		// How far the dots sit from where the last pose put them (pins, worst field
		// corner). Enough dots to say the pad MOVED but not enough to verify where
		// to (a side hidden): the old pose is wrong — 'lost', never 'held'.
		const shift = poseShiftPins(Hpred, F2.H);
		const moved = shift > o.maxHeldShiftPins;
		const movedNote = moved ? ` moved ${shift.toFixed(2)}` : '';
		if (F2.spanC < o.minSpan || F2.spanR < o.minSpan)
			return {
				kind: moved ? 'bad' : 'weak',
				reason: `span ${F2.spanC.toFixed(2)}x${F2.spanR.toFixed(2)}${movedNote}`,
				fit: F2,
				pass: P2,
				visible,
			};
		if (F2.rmsPin > o.maxRmsPin)
			return { kind: 'bad', reason: `rms ${F2.rmsPin.toFixed(3)}`, fit: F2, pass: P2, visible };
		if (F2.inliers < o.minInlierFrac * F2.found)
			return { kind: 'bad', reason: `inliers ${F2.inliers}/${F2.found}`, fit: F2, pass: P2, visible };
		// Border lines, judged on the second pass (searched at the first fit, ≈ the final pose).
		const b = borderCheck(P2);
		if (b.verdict === 'fail') return { kind: 'bad', reason: `border ${b.detail}`, fit: F2, pass: P2, visible };
		if (b.verdict === 'unverified')
			return { kind: moved ? 'bad' : 'weak', reason: `border-unverified${movedNote} ${b.detail}`, fit: F2, pass: P2, visible };
		return { kind: 'ok', fit: F2, pass: P2, visible };
	}

	/**
	 * Relock around `H`: peaks in an enlarged ROI vote for a sub-pin phase and
	 * an integer offset in H's pin frame. Returns the translated pose, or null
	 * when there is no clear winner.
	 */
	function relock(frame: LumaFrame, H: Mat3, occluders: Point[][]): { H: Mat3; reason: string } | null {
		const K = o.relockMarginPins;
		lastRelockPeaks = 0;
		const R = respond(frame, H, K + 1.5);
		if (!R) return null;
		const pk = findDotPeaks({ D: R.D, N: R.N, bg: R.N, noise: R.noise, sd: 0, sb: 0 }, R.w, R.h, R.pitchW, thresholds);
		let Hi: Mat3;
		try {
			Hi = invert3(H);
		} catch {
			return null;
		}
		const us: number[] = [];
		const vs: number[] = [];
		for (let k = 0; k < pk.xs.length; k++) {
			const f = toFull(R, pk.xs[k], pk.ys[k]);
			if (occluders.some((poly) => insideConvex(poly, f[0], f[1], 0))) continue;
			const [u, v] = applyH(Hi, f);
			if (u < -K - 1.5 || u > cols + K + 0.5 || v < -K - 1.5 || v > rows + K + 0.5) continue;
			us.push(u);
			vs.push(v);
		}
		lastRelockPeaks = us.length;
		if (us.length < o.minFound) return null;
		// Phase: 2-D circular histogram of fractional parts.
		const B = 10;
		const hist = new Float64Array(B * B);
		const frac = (t: number) => t - Math.round(t); // [-0.5, 0.5]
		const bin = (f: number) => Math.min(B - 1, Math.floor((f + 0.5) * B));
		for (let k = 0; k < us.length; k++) hist[bin(frac(us[k])) * B + bin(frac(vs[k]))] += 1;
		let bi = 0;
		let bj = 0;
		let bv = -1;
		for (let i = 0; i < B; i++)
			for (let j = 0; j < B; j++) {
				let s = 0;
				for (let a = -1; a <= 1; a++)
					for (let b = -1; b <= 1; b++) s += hist[((i + a + B) % B) * B + ((j + b + B) % B)];
				if (s > bv) {
					bv = s;
					bi = i;
					bj = j;
				}
			}
		const cu = (bi + 0.5) / B - 0.5;
		const cv = (bj + 0.5) / B - 0.5;
		// Circular mean of the phases near the winning bin.
		let su = 0;
		let sv = 0;
		let n = 0;
		for (let k = 0; k < us.length; k++) {
			const du = frac(frac(us[k]) - cu);
			const dv = frac(frac(vs[k]) - cv);
			if (Math.abs(du) > 0.2 || Math.abs(dv) > 0.2) continue;
			su += du;
			sv += dv;
			n++;
		}
		if (n < o.minFound) return null;
		const pu = cu + su / n;
		const pv = cv + sv / n;
		// Integer occupancy in the phase-shifted frame.
		const lo = -K - 2;
		const GWr = cols + 2 * K + 4;
		const GHr = rows + 2 * K + 4;
		const occ = new Uint8Array(GWr * GHr);
		for (let k = 0; k < us.length; k++) {
			const a = us[k] - pu;
			const b = vs[k] - pv;
			const ia = Math.round(a);
			const ib = Math.round(b);
			if (Math.abs(a - ia) > 0.25 || Math.abs(b - ib) > 0.25) continue;
			const x = ia - lo;
			const y = ib - lo;
			if (x < 0 || y < 0 || x >= GWr || y >= GHr) continue;
			occ[y * GWr + x] = 1;
		}
		// 2-D prefix sums for window counts.
		const S = new Int32Array((GWr + 1) * (GHr + 1));
		for (let y = 0; y < GHr; y++)
			for (let x = 0; x < GWr; x++)
				S[(y + 1) * (GWr + 1) + (x + 1)] =
					occ[y * GWr + x] + S[y * (GWr + 1) + (x + 1)] + S[(y + 1) * (GWr + 1) + x] - S[y * (GWr + 1) + x];
		const box = (xa: number, ya: number, xb: number, yb: number) => {
			// inclusive grid coords in pin units, clipped
			const X0 = Math.max(0, xa - lo);
			const Y0 = Math.max(0, ya - lo);
			const X1 = Math.min(GWr - 1, xb - lo);
			const Y1 = Math.min(GHr - 1, yb - lo);
			if (X1 < X0 || Y1 < Y0) return 0;
			return S[(Y1 + 1) * (GWr + 1) + (X1 + 1)] - S[Y0 * (GWr + 1) + (X1 + 1)] - S[(Y1 + 1) * (GWr + 1) + X0] + S[Y0 * (GWr + 1) + X0];
		};
		// Score each integer offset: dots inside the window, minus 3 × dots on the
		// lines just outside, minus 2 × the deficit of an EDGE line that is empty
		// while the next line in is dotted (the other half of an alias signature).
		const colCount = (x: number, b: number) => box(x, b, x, b + rows - 1);
		const rowCount = (y: number, a: number) => box(a, y, a + cols - 1, y);
		const deficit = (edge: number, inner: number) => Math.max(0, 0.5 * inner - edge);
		const scores: Array<{ a: number; b: number; inside: number; outside: number; score: number }> = [];
		for (let a = -K; a <= K; a++)
			for (let b = -K; b <= K; b++) {
				const inside = box(a, b, a + cols - 1, b + rows - 1);
				const outside = colCount(a - 1, b) + colCount(a + cols, b) + rowCount(b - 1, a) + rowCount(b + rows, a);
				const edges =
					deficit(colCount(a, b), colCount(a + 1, b)) +
					deficit(colCount(a + cols - 1, b), colCount(a + cols - 2, b)) +
					deficit(rowCount(b, a), rowCount(b + 1, a)) +
					deficit(rowCount(b + rows - 1, a), rowCount(b + rows - 2, a));
				scores.push({ a, b, inside, outside, score: inside - 3 * outside - 2 * edges });
			}
		scores.sort((p, q) => q.score - p.score);
		const best = scores[0];
		const second = scores[1];
		const perLine = Math.min(best.inside / cols, best.inside / rows);
		const margin = best.score - second.score;
		const reason = `relock a=${best.a} b=${best.b} phase=${pu.toFixed(2)},${pv.toFixed(2)} inside=${best.inside} out=${best.outside} margin=${margin.toFixed(0)}`;
		if (best.inside < o.minFound) return null;
		// A clear winner only: an off-by-one costs ≥ ~1.5 lines of evidence even when one side is unreadable.
		if (margin < Math.max(12, 0.75 * perLine)) return null;
		if (best.outside > 0.15 * (2 * rows + 2 * cols)) return null;
		return { H: translatePin(H, best.a + pu, best.b + pv), reason };
	}

	function finish(
		t0: number,
		st: TrackState,
		accepted: boolean,
		relocked: boolean,
		ev: Eval | null,
		reason: string | null,
	): TrackStep {
		state = st;
		if (ev) {
			const found: Point[] = [];
			const missing: Point[] = [];
			const P = ev.pass;
			for (let r = -1; r <= rows; r++)
				for (let c = -1; c <= cols; c++) {
					const k = cell(c, r);
					if (!P.vis[k]) continue;
					if (Number.isFinite(P.x[k])) found.push([P.x[k], P.y[k]]);
					else if (c >= 0 && r >= 0 && c < cols && r < rows && pose) missing.push(applyH(pose, [c, r]));
				}
			debug = { found, missing };
		}
		return {
			state: st,
			pose,
			accepted,
			relocked,
			found: ev?.fit?.found ?? 0,
			inliers: ev?.fit?.inliers ?? 0,
			visible: ev?.visible ?? 0,
			residual: ev?.fit?.rmsPin ?? Number.NaN,
			reason,
			ms: now() - t0,
		};
	}

	const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

	function accept(H: Mat3, consecutive: boolean, ev?: Eval) {
		prevCorners = consecutive && pose ? cornersOfPose(pose, cols, rows) : null;
		pose = H;
		if (ev?.fit && ev.visible > 0) {
			const f = Math.min(1, ev.fit.found / ev.visible);
			refFrac = refFrac == null ? f : 0.8 * refFrac + 0.2 * f;
		}
	}

	/** Fraction of visible pins matched in accepted frames (EMA); null until known. */
	let refFrac: number | null = null;

	function prediction(): Mat3 {
		if (!pose) throw new Error('no pose');
		if (!prevCorners || o.velocity <= 0) return pose;
		const cur = cornersOfPose(pose, cols, rows);
		const pred = cur.map((p, k) => [
			p[0] + o.velocity * (p[0] - (prevCorners as Point[])[k][0]),
			p[1] + o.velocity * (p[1] - (prevCorners as Point[])[k][1]),
		]);
		try {
			return homography4(PIN, pred);
		} catch {
			return pose;
		}
	}

	/** Track from a prediction; on contradiction try a relock on the same frame. */
	function step(frame: LumaFrame, Hpred: Mat3, occluders: Point[][], t0: number, forceRelock: boolean): TrackStep {
		if (!forceRelock) {
			const R = respond(frame, Hpred, 2);
			if (!R) return finish(t0, state === 'lost' ? 'lost' : 'blank', false, false, null, 'roi-outside-frame');
			const ev = evaluate(R, Hpred, occluders);
			if (ev.kind === 'ok') {
				accept(ev.fit.H, true, ev);
				return finish(t0, 'tracking', true, false, ev, null);
			}
			if (ev.kind === 'weak') {
				// Not enough evidence either way: keep the pose (still usable) unless already lost.
				if (state === 'lost') return finish(t0, 'lost', false, false, ev, ev.reason);
				return finish(t0, occluders.length ? 'occluded' : 'blank', false, false, ev, ev.reason);
			}
			// 'bad': the evidence contradicts the prediction — fall through to a relock.
			const rl = tryRelock(frame, occluders);
			if (rl) return finish(t0, 'tracking', true, true, rl.ev, rl.reason);
			// No dots anywhere around the pad: the pins went blank (map change,
			// glare), not a jump — keep the pose as for any blank frame.
			if (lastRelockPeaks < o.blankPeakFrac * Math.max(1, ev.visible) * (refFrac ?? 1))
				return finish(t0, occluders.length ? 'occluded' : 'blank', false, false, ev, `${ev.reason}; no dots`);
			prevCorners = null;
			return finish(t0, 'lost', false, false, ev, ev.reason);
		}
		const rl = tryRelock(frame, occluders);
		if (rl) return finish(t0, 'tracking', true, true, rl.ev, rl.reason);
		return finish(t0, 'lost', false, false, null, 'relock-failed');
	}

	/** Dot peaks (outside occluders) the last relock saw around the pad. */
	let lastRelockPeaks = 0;

	/* Full re-acquire: an incremental lattice search while lost and hands are off. */
	let reacq: Generator<void, LatticeDetection | null, void> | null = null;
	let reacqCooldown = 0;

	function reacquireStep(frame: LumaFrame, occluders: Point[][], handsPresent: boolean, t0: number): TrackStep | null {
		if (!o.reacquire || !pose) return null;
		if (handsPresent) {
			reacq = null; // a hand may have covered the frame being searched
			return null;
		}
		if (!reacq) {
			if (reacqCooldown > 0) {
				reacqCooldown--;
				return null;
			}
			const data = frame.read(0, 0, frame.width, frame.height);
			reacq = latticeSearch(
				{ data, width: frame.width, height: frame.height },
				{ pitchHint: pitchOf(pose), polarities: [o.polarity] },
			);
			return finish(t0, 'lost', false, false, null, 'reacquire-started');
		}
		const st = reacq.next();
		if (!st.done) return finish(t0, 'lost', false, false, null, 'reacquiring');
		reacq = null;
		const det = st.value;
		if (!det) {
			reacqCooldown = o.reacquireCooldownFrames;
			return finish(t0, 'lost', false, false, null, 'reacquire-not-found');
		}
		// Keep the tracked orientation unless the braille text line says otherwise.
		const cmp = compareCorners(cornersOfPose(pose, cols, rows), det);
		let Hn: Mat3;
		try {
			Hn = homography4(PIN, cmp.corners);
		} catch {
			return finish(t0, 'lost', false, false, null, 'reacquire-degenerate');
		}
		const R = respond(frame, Hn, 2);
		const ev = R ? evaluate(R, Hn, occluders) : null;
		if (!ev || ev.kind !== 'ok') return finish(t0, 'lost', false, false, ev, `reacquire-refine ${ev?.reason ?? 'roi'}`);
		accept(ev.fit.H, false, ev);
		return finish(t0, 'tracking', true, true, ev, `reacquired (search, ${cmp.pins.toFixed(1)} pins from the last pose)`);
	}

	function tryRelock(frame: LumaFrame, occluders: Point[][]): { ev: Eval; reason: string } | null {
		if (!pose) return null;
		const rl = relock(frame, pose, occluders);
		if (!rl) return null;
		const R = respond(frame, rl.H, 2);
		if (!R) return null;
		const ev = evaluate(R, rl.H, occluders);
		if (ev.kind !== 'ok') return null;
		accept(ev.fit.H, false, ev);
		return { ev, reason: rl.reason };
	}

	const occludersOf = (hints?: TrackHints) => {
		const list = hints?.occluders ?? [];
		if (!list.length || !pose) return [];
		const m = o.occluderMarginPins * pitchOf(pose);
		// Grow each convex polygon by m px (offset every vertex away from the centroid).
		return list
			.filter((p) => p.length >= 3)
			.map((poly) => {
				const hull = convexHull(poly);
				const cx = hull.reduce((s, p) => s + p[0], 0) / hull.length;
				const cy = hull.reduce((s, p) => s + p[1], 0) / hull.length;
				return hull.map(([x, y]) => {
					const d = hypot(x - cx, y - cy) || 1;
					return [x + ((x - cx) / d) * m, y + ((y - cy) / d) * m] as Point;
				});
			});
	};

	return {
		get pose() {
			return pose;
		},
		get state() {
			return state;
		},
		get debug() {
			return debug;
		},
		clear() {
			pose = null;
			prevCorners = null;
			state = 'idle';
			debug = null;
			reacq = null;
			reacqCooldown = 0;
			refFrac = null;
		},
		reset(H, frame, hints) {
			const t0 = now();
			pose = H;
			prevCorners = null;
			state = 'tracking';
			reacq = null;
			reacqCooldown = 0;
			refFrac = null;
			if (!frame) return finish(t0, 'tracking', true, false, null, null);
			const occ = occludersOf(hints);
			// A registration (touched corners, an aggregated detection) can be off
			// by a pin or so: refine, and if the evidence contradicts, relock.
			const out = step(frame, H, occ, t0, false);
			if (out.state === 'blank' || out.state === 'occluded') {
				// Pins not visible (blank map): keep the registered pose as is.
				return { ...out, state: out.state };
			}
			return out;
		},
		update(frame, hints) {
			const t0 = now();
			if (!pose) return finish(t0, 'idle', false, false, null, 'no-pose');
			const occ = occludersOf(hints);
			if (state === 'lost') {
				// A full search in flight takes the frame's budget; otherwise relock first.
				if (reacq) return reacquireStep(frame, occ, !!hints?.handsPresent, t0) ?? step(frame, pose, occ, t0, true);
				const out = step(frame, pose, occ, t0, true);
				if (out.state !== 'lost') return out;
				return reacquireStep(frame, occ, !!hints?.handsPresent, t0) ?? out;
			}
			return step(frame, prediction(), occ, t0, false);
		},
	};
}

/** A tracker that never moves the pose (pins invisible, or tracking disabled). */
export function createStaticTracker(): Tracker {
	let pose: Mat3 | null = null;
	let state: TrackState = 'idle';
	const step = (): TrackStep => ({
		state,
		pose,
		accepted: false,
		relocked: false,
		found: 0,
		inliers: 0,
		visible: 0,
		residual: Number.NaN,
		reason: 'static',
		ms: 0,
	});
	return {
		get pose() {
			return pose;
		},
		get state() {
			return state;
		},
		reset(H) {
			pose = H;
			state = 'blank';
			return step();
		},
		update() {
			return step();
		},
		clear() {
			pose = null;
			state = 'idle';
		},
	};
}
