/**
 * Pure image operations on typed arrays (no DOM, no OpenCV): luma conversion,
 * box / Gaussian blur, bilinear sampling, and the illumination-normalised dot
 * response that both the lattice detector and the lattice-follow tracker use.
 * Ported from the starter's `dotpadLattice.js`.
 */

/** 8-bit (or float) single-channel image. */
export interface GrayImage {
	data: ArrayLike<number>;
	width: number;
	height: number;
}

/** RGBA (canvas ImageData) → 8-bit luma. */
export function rgbaToGray(
	rgba: ArrayLike<number>,
	width: number,
	height: number,
): Uint8Array {
	const n = width * height;
	const out = new Uint8Array(n);
	for (let i = 0, k = 0; i < n; i++, k += 4) {
		out[i] = (rgba[k] * 77 + rgba[k + 1] * 150 + rgba[k + 2] * 29) >> 8;
	}
	return out;
}

/** Box radii of three passes approximating a Gaussian of `sigma` (Kovesi). */
export function boxRadii(sigma: number): number[] {
	const n = 3;
	const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
	let wl = Math.floor(wIdeal);
	if (wl % 2 === 0) wl -= 1;
	const wu = wl + 2;
	const m = Math.round(
		(12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4),
	);
	return Array.from({ length: n }, (_, i) => ((i < m ? wl : wu) - 1) / 2);
}

/** One separable box pass of radius r, edges clamped. `src` and `dst` may not alias. */
export function boxBlur(
	src: Float32Array,
	dst: Float32Array,
	w: number,
	h: number,
	r: number,
	tmp: Float32Array,
): void {
	if (r <= 0) {
		dst.set(src);
		return;
	}
	const inv = 1 / (2 * r + 1);
	// Interior columns need no clamping; only the first r and last r + 1 do.
	const xa = Math.min(w, r);
	const xb = Math.max(xa, w - r - 1);
	for (let y = 0; y < h; y++) {
		const o = y * w;
		let acc = (r + 1) * src[o];
		for (let k = 1; k <= r; k++) acc += src[o + Math.min(k, w - 1)];
		let x = 0;
		for (; x < xa; x++) {
			tmp[o + x] = acc * inv;
			acc += src[o + Math.min(x + r + 1, w - 1)] - src[o];
		}
		for (; x < xb; x++) {
			tmp[o + x] = acc * inv;
			acc += src[o + x + r + 1] - src[o + x - r];
		}
		const last = src[o + w - 1];
		for (; x < w; x++) {
			tmp[o + x] = acc * inv;
			acc += last - src[o + Math.max(x - r, 0)];
		}
	}
	const acc = new Float64Array(w);
	for (let x = 0; x < w; x++) {
		let a = (r + 1) * tmp[x];
		for (let k = 1; k <= r; k++) a += tmp[Math.min(k, h - 1) * w + x];
		acc[x] = a;
	}
	for (let y = 0; y < h; y++) {
		const o = y * w;
		const add = Math.min(y + r + 1, h - 1) * w;
		const sub = Math.max(y - r, 0) * w;
		for (let x = 0; x < w; x++) {
			dst[o + x] = acc[x] * inv;
			acc[x] += tmp[add + x] - tmp[sub + x];
		}
	}
}

/** Gaussian blur approximated by three box passes. Returns a new Float32Array. */
export function gaussBlur(
	src: ArrayLike<number>,
	w: number,
	h: number,
	sigma: number,
): Float32Array {
	const a = new Float32Array(src as ArrayLike<number>);
	const b = new Float32Array(w * h);
	const tmp = new Float32Array(w * h);
	let cur = a;
	let nxt = b;
	for (const r of boxRadii(sigma)) {
		boxBlur(cur, nxt, w, h, r, tmp);
		[cur, nxt] = [nxt, cur];
	}
	return cur;
}

/** Bilinear sample; NaN outside the image. */
export function sample(
	img: ArrayLike<number>,
	w: number,
	h: number,
	x: number,
	y: number,
): number {
	if (!(x >= 0 && y >= 0 && x <= w - 1 && y <= h - 1)) return Number.NaN;
	const x0 = Math.min(Math.floor(x), w - 2);
	const y0 = Math.min(Math.floor(y), h - 2);
	const fx = x - x0;
	const fy = y - y0;
	const o = y0 * w + x0;
	return (
		(img[o] * (1 - fx) + img[o + 1] * fx) * (1 - fy) +
		(img[o + w] * (1 - fx) + img[o + w + 1] * fx) * fy
	);
}

/**
 * Pixel noise σ (Immerkær: the 3 × 3 kernel [1 −2 1; −2 4 −2; 1 −2 1] has gain
 * 6 on white noise; median-based so edges and smooth texture do not count).
 */
export function pixelNoise(f: ArrayLike<number>, w: number, h: number): number {
	let n = 0;
	for (let y = 1; y < h - 1; y += 3) for (let x = 1 + (y % 7); x < w - 1; x += 7) n++;
	const smp = new Float64Array(n);
	let k = 0;
	for (let y = 1; y < h - 1; y += 3) {
		for (let x = 1 + (y % 7); x < w - 1; x += 7) {
			const i = y * w + x;
			const v =
				f[i - w - 1] -
				2 * f[i - w] +
				f[i - w + 1] -
				2 * f[i - 1] +
				4 * f[i] -
				2 * f[i + 1] +
				f[i + w - 1] -
				2 * f[i + w] +
				f[i + w + 1];
			smp[k++] = Math.abs(v);
		}
	}
	smp.sort(); // typed arrays sort numerically
	return (1.4826 * (smp[smp.length >> 1] || 0)) / 6;
}

/** Response of the dot DoG (σd, σb) to unit white noise. */
export function dogNoiseGain(sd: number, sb: number): number {
	return Math.sqrt(
		Math.max(
			0,
			1 / (4 * Math.PI * sd * sd) +
				1 / (4 * Math.PI * sb * sb) -
				1 / (Math.PI * (sd * sd + sb * sb)),
		),
	);
}

/** Output of {@link dotResponse}. */
export interface DotResponse {
	/** DoG: positive on a bright dot, ~0 on flat surface (grey levels). */
	D: Float32Array;
	/** D divided by its local RMS (~3 pitches): dim and washed-out parts alike. */
	N: Float32Array;
	/** The background blur G(σb) (used by the window-edge search). */
	bg: Float32Array;
	/** Noise σ of D (grey levels). */
	noise: number;
	sd: number;
	sb: number;
}

/**
 * Illumination-normalised dot response at a pitch hypothesis.
 *
 * D = G(σd) − G(σb) with σd ≈ 0.2 p, σb ≈ 0.55 p; N = D / (local RMS of D over
 * ~3 p + eps). `polarity` −1 looks for dark dots.
 */
export function dotResponse(
	f: ArrayLike<number>,
	w: number,
	h: number,
	pitch: number,
	eps: number,
): DotResponse {
	const n = w * h;
	const sd = Math.max(0.75, 0.2 * pitch);
	const sb = 0.55 * pitch;
	const g1 = gaussBlur(f, w, h, sd);
	const g2 = gaussBlur(f, w, h, sb);
	const D = new Float32Array(n);
	for (let i = 0; i < n; i++) D[i] = g1[i] - g2[i];
	const noise = pixelNoise(f, w, h) * dogNoiseGain(sd, sb);
	const D2 = g1; // reuse
	for (let i = 0; i < n; i++) D2[i] = D[i] * D[i];
	const E = new Float32Array(n);
	boxBlur(D2, E, w, h, Math.max(2, Math.round(1.5 * pitch)), new Float32Array(n));
	const N = D2; // reuse again
	for (let i = 0; i < n; i++) N[i] = D[i] / (Math.sqrt(E[i]) + eps);
	return { D, N, bg: g2, noise, sd, sb };
}

/** 2 × 2 box downsample. */
export function halve(
	src: ArrayLike<number>,
	w: number,
	h: number,
): { data: Float32Array; w: number; h: number } {
	const W = w >> 1;
	const Hh = h >> 1;
	const out = new Float32Array(W * Hh);
	for (let y = 0; y < Hh; y++) {
		const a = 2 * y * w;
		const b = a + w;
		const o = y * W;
		for (let x = 0; x < W; x++)
			out[o + x] =
				0.25 * (src[a + 2 * x] + src[a + 2 * x + 1] + src[b + 2 * x] + src[b + 2 * x + 1]);
	}
	return { data: out, w: W, h: Hh };
}

/** 2× bilinear upsample; level −1 pixel x ↔ full-resolution x / 2 − 0.25. */
export function double(
	src: ArrayLike<number>,
	w: number,
	h: number,
): { data: Float32Array; w: number; h: number } {
	const W = 2 * w;
	const Hh = 2 * h;
	const out = new Float32Array(W * Hh);
	for (let y = 0; y < Hh; y++) {
		const sy = Math.min(h - 1, Math.max(0, y / 2 - 0.25));
		const y0 = Math.min(h - 2, Math.floor(sy));
		const fy = sy - y0;
		for (let x = 0; x < W; x++) {
			const sx = Math.min(w - 1, Math.max(0, x / 2 - 0.25));
			const x0 = Math.min(w - 2, Math.floor(sx));
			const fx = sx - x0;
			const o = y0 * w + x0;
			out[y * W + x] =
				(src[o] * (1 - fx) + src[o + 1] * fx) * (1 - fy) +
				(src[o + w] * (1 - fx) + src[o + w + 1] * fx) * fy;
		}
	}
	return { data: out, w: W, h: Hh };
}

/** Thresholds for {@link findDotPeaks} (same meaning as in the lattice detector). */
export interface PeakThresholds {
	nWeak: number;
	dWeak: number;
	kWeak: number;
	edgeRatio: number;
}

/**
 * Strict local maxima of N in a (2r+1)² window (r ≈ 0.3 pitch) with N ≥ nWeak,
 * D ≥ max(dWeak, kWeak·noise), passing the Hessian blob test (rims, edges and
 * ridges fail), with parabolic sub-pixel refinement. Coordinates are in the
 * response's own pixel frame.
 */
export function findDotPeaks(
	resp: DotResponse,
	w: number,
	h: number,
	pitch: number,
	t: PeakThresholds,
): { xs: number[]; ys: number[]; v: number[] } {
	const { D, N } = resp;
	const dWeak = Math.max(t.dWeak, t.kWeak * resp.noise);
	const r = Math.max(1, Math.round(0.3 * pitch));
	const xs: number[] = [];
	const ys: number[] = [];
	const vs: number[] = [];
	for (let y = Math.max(1, r); y < h - Math.max(1, r); y++) {
		for (let x = Math.max(1, r); x < w - Math.max(1, r); x++) {
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
			const sub = blobAt(N, w, i, t.edgeRatio);
			if (!sub) continue;
			xs.push(x + sub[0]);
			ys.push(y + sub[1]);
			vs.push(v);
		}
	}
	return { xs, ys, v: vs };
}

/**
 * Hessian blob test at pixel index i of N (both curvatures negative, tr²/det
 * below `edgeRatio`) and the parabolic sub-pixel offset, or null.
 */
export function blobAt(
	N: ArrayLike<number>,
	w: number,
	i: number,
	edgeRatio: number,
): [number, number] | null {
	const v = N[i];
	const l = N[i - 1];
	const rr = N[i + 1];
	const u = N[i - w];
	const d = N[i + w];
	const cx = l - 2 * v + rr;
	const cy = u - 2 * v + d;
	const cxy = (N[i - w - 1] + N[i + w + 1] - N[i - w + 1] - N[i + w - 1]) / 4;
	const det = cx * cy - cxy * cxy;
	if (!(cx < 0 && cy < 0 && det > 0) || (cx + cy) ** 2 / det > edgeRatio) return null;
	return [
		Math.max(-0.5, Math.min(0.5, (l - rr) / (2 * cx))),
		Math.max(-0.5, Math.min(0.5, (u - d) / (2 * cy))),
	];
}

/** Integer box downsample by `s` (s = 1 returns a Float32Array copy). */
export function downsample(
	src: ArrayLike<number>,
	w: number,
	h: number,
	s: number,
): { data: Float32Array; w: number; h: number } {
	if (s <= 1) return { data: new Float32Array(src as ArrayLike<number>), w, h };
	const W = Math.floor(w / s);
	const Hh = Math.floor(h / s);
	const out = new Float32Array(W * Hh);
	const inv = 1 / (s * s);
	for (let y = 0; y < Hh; y++) {
		for (let x = 0; x < W; x++) {
			let acc = 0;
			for (let b = 0; b < s; b++) {
				const o = (y * s + b) * w + x * s;
				for (let a = 0; a < s; a++) acc += src[o + a];
			}
			out[y * W + x] = acc * inv;
		}
	}
	return { data: out, w: W, h: Hh };
}
