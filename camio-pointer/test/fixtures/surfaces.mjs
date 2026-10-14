/**
 * Test glue for the optional real-OpenCV AKAZE test: a seeded "map-like" grey
 * texture (rectangles, polylines, glyph blocks), a textured "table"
 * background, and `renderSurface`, which inverse-warps the texture through a
 * homography P (texture px → frame px) with bilinear sampling onto the
 * background and returns the true corners.
 */
import { rng } from './scenes.mjs';

const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

function fillRect(img, w, h, x0, y0, x1, y1, g) {
	for (let y = Math.max(0, y0 | 0); y < Math.min(h, y1 | 0); y++) for (let x = Math.max(0, x0 | 0); x < Math.min(w, x1 | 0); x++) img[y * w + x] = g;
}

function line(img, w, h, x0, y0, x1, y1, thick, g) {
	const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
	for (let i = 0; i <= n; i++) {
		const x = x0 + ((x1 - x0) * i) / n;
		const y = y0 + ((y1 - y0) * i) / n;
		fillRect(img, w, h, x - thick / 2, y - thick / 2, x + thick / 2, y + thick / 2, g);
	}
}

/** A map-like texture: light paper, grey blocks, roads (polylines), and text-like glyph blocks. */
export function mapTexture(width, height, seed = 1, { blank = false } = {}) {
	const r = rng(seed);
	const img = new Uint8Array(width * height).fill(232);
	if (blank) return { data: img, width, height };
	for (let k = 0; k < 40; k++) {
		const x = r.uni(0, width);
		const y = r.uni(0, height);
		fillRect(img, width, height, x, y, x + r.uni(15, 80), y + r.uni(15, 60), r.int(110, 200));
	}
	for (let k = 0; k < 14; k++) {
		let x = r.uni(0, width);
		let y = r.uni(0, height);
		const g = r.int(20, 90);
		for (let s = 0; s < 6; s++) {
			const nx = x + r.uni(-120, 120);
			const ny = y + r.uni(-90, 90);
			line(img, width, height, x, y, nx, ny, r.uni(2, 6), g);
			x = nx;
			y = ny;
		}
	}
	// Glyph blocks: rows of 5 × 7 random dot patterns.
	for (let b = 0; b < 25; b++) {
		const x0 = r.uni(0, width - 80);
		const y0 = r.uni(0, height - 12);
		for (let c = 0; c < 8; c++)
			for (let j = 0; j < 7; j++) for (let i = 0; i < 5; i++) if (r.next() < 0.45) fillRect(img, width, height, x0 + c * 9 + i * 1.4, y0 + j * 1.4, x0 + c * 9 + i * 1.4 + 1.4, y0 + j * 1.4 + 1.4, 30);
	}
	return { data: img, width, height };
}

/**
 * A textured table: wood-like stripes, knots and `clutter` objects (plain: a
 * flat grey `level`).
 */
export function tableBackground(width, height, seed = 2, { plain = false, level = 110, clutter = 220 } = {}) {
	const r = rng(seed);
	const img = new Uint8Array(width * height);
	if (plain) return { data: img.fill(level), width, height };
	const phase = Array.from({ length: 6 }, () => [r.uni(0.01, 0.08), r.uni(0, 6.28), r.uni(4, 14)]);
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++) {
			let v = 120;
			for (const [f, p, a] of phase) v += a * Math.sin(f * (y + 0.15 * x) + p);
			img[y * width + x] = clamp8(v);
		}
	for (let k = 0; k < clutter; k++) {
		const x = r.uni(0, width);
		const y = r.uni(0, height);
		fillRect(img, width, height, x, y, x + r.uni(6, 40), y + r.uni(6, 30), r.int(40, 230));
	}
	for (let k = 0; k < 30; k++) line(img, width, height, r.uni(0, width), r.uni(0, height), r.uni(0, width), r.uni(0, height), r.uni(1, 4), r.int(30, 220));
	return { data: img, width, height };
}

const applyH = (H, x, y) => {
	const w = H[2][0] * x + H[2][1] * y + H[2][2];
	return [(H[0][0] * x + H[0][1] * y + H[0][2]) / w, (H[1][0] * x + H[1][1] * y + H[1][2]) / w];
};

function invert3(m) {
	const [[a, b, c], [d, e, f], [g, h, i]] = m;
	const A = e * i - f * h;
	const B = -(d * i - f * g);
	const C = d * h - e * g;
	const det = a * A + b * B + c * C;
	return [
		[A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
		[B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
		[C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
	];
}

/**
 * The texture warped by P (texture px → frame px) over the background.
 * Texture corners are (0,0), (w,0), (w,h), (0,h) (pixel edges).
 * @returns {{ data: Uint8Array, width: number, height: number, corners: number[][] }}
 */
export function renderSurface(texture, P, background) {
	const { width: W, height: H } = background;
	const out = new Uint8Array(background.data);
	const Pi = invert3(P);
	const { data: t, width: tw, height: th } = texture;
	const corners = [
		[0, 0],
		[tw, 0],
		[tw, th],
		[0, th],
	].map(([x, y]) => applyH(P, x, y));
	const xs = corners.map((c) => c[0]);
	const ys = corners.map((c) => c[1]);
	const x0 = Math.max(0, Math.floor(Math.min(...xs)));
	const x1 = Math.min(W - 1, Math.ceil(Math.max(...xs)));
	const y0 = Math.max(0, Math.floor(Math.min(...ys)));
	const y1 = Math.min(H - 1, Math.ceil(Math.max(...ys)));
	for (let y = y0; y <= y1; y++)
		for (let x = x0; x <= x1; x++) {
			const [u, v] = applyH(Pi, x + 0.5, y + 0.5);
			if (u < 0 || v < 0 || u >= tw || v >= th) continue;
			const fu = Math.min(tw - 1, Math.max(0, u - 0.5));
			const fv = Math.min(th - 1, Math.max(0, v - 0.5));
			const iu = Math.min(tw - 2, Math.floor(fu));
			const iv = Math.min(th - 2, Math.floor(fv));
			const du = fu - iu;
			const dv = fv - iv;
			const k = iv * tw + iu;
			const val = (t[k] * (1 - du) + t[k + 1] * du) * (1 - dv) + (t[k + tw] * (1 - du) + t[k + tw + 1] * du) * dv;
			out[y * W + x] = clamp8(Math.round(val));
		}
	return { data: out, width: W, height: H, corners };
}

/** Texture px → frame px: scale s, rotation deg about the texture centre, then the centre placed at (cx, cy). */
export function placement(texture, s, deg, cx, cy) {
	const a = (deg * Math.PI) / 180;
	const c = Math.cos(a) * s;
	const sn = Math.sin(a) * s;
	const mx = texture.width / 2;
	const my = texture.height / 2;
	return [
		[c, -sn, cx - c * mx + sn * my],
		[sn, c, cy - sn * mx - c * my],
		[0, 0, 1],
	];
}
