/**
 * Synthetic tracking SEQUENCES built from the real DOT Pad frames.
 *
 * Every sequence is a list of frames with a known pin → px pose per frame:
 *   - camera motion: the WHOLE frame is warped by a progressive homography G_t
 *     (pan, tilt, zoom); truth H_t = G_t · H_0.
 *   - pad-only motion: the pad's body is cut out, the hole filled with the
 *     surrounding grey, and the pad pasted back through M_t while the
 *     background stays fixed; truth H_t = M_t · H_0.
 *   - sudden bump: a pad-only jump of more than half a pin in one frame.
 *   - hand occluder: a hand-shaped mask (palm, curled fingers, an extended
 *     index finger, a forearm to the frame edge) with skin texture, creases and
 *     a few bright specks, covering a chosen fraction of the pins.
 *
 * H_0 comes from the hand-measured ground truth (`ground_truth.json`).
 */

import { DOTPAD_TEMPLATE, applyH, homography4, invert3, matMul3 } from '../../src/geometry';
import { GT, realLuma } from './realSet.mjs';
import { PIN_IDX, rng } from './scenes.mjs';

const T = DOTPAD_TEMPLATE;
const P = T.pinPitchPx;
const [PX0, PY0] = T.pinCorners[0];

/** Source frame: luma (PXL stills downscaled ×3) and its pose pin → px. */
export function source(file) {
	const { img, f, map } = realLuma(file);
	const corners = GT[file].corners.map(map);
	return { img, H0: homography4(PIN_IDX, corners), f };
}

/** Pin pitch (px) of a pose near the field centre. */
export function pitchOfPose(H) {
	const p = applyH(H, [29.5, 19.5]);
	const a = applyH(H, [30.5, 19.5]);
	const b = applyH(H, [29.5, 20.5]);
	return (Math.hypot(a[0] - p[0], a[1] - p[1]) + Math.hypot(b[0] - p[0], b[1] - p[1])) / 2;
}

/** Rigid motion (deg about (cx, cy)) then translation, as a 3×3. */
export function rigid(deg, cx, cy, dx, dy) {
	const a = (deg * Math.PI) / 180;
	const c = Math.cos(a);
	const s = Math.sin(a);
	return [
		[c, -s, cx - c * cx + s * cy + dx],
		[s, c, cy - s * cx - c * cy + dy],
		[0, 0, 1],
	];
}

/** Similarity about (cx, cy): scale k, rotation deg, then translation, plus a perspective term. */
export function cameraMotion({ cx, cy, scale = 1, deg = 0, dx = 0, dy = 0, px = 0, py = 0 }) {
	const R = rigid(deg, cx, cy, dx, dy);
	const S = [
		[scale, 0, cx * (1 - scale)],
		[0, scale, cy * (1 - scale)],
		[0, 0, 1],
	];
	// Perspective about the centre (the centre stays fixed).
	const C = [
		[1, 0, -cx],
		[0, 1, -cy],
		[0, 0, 1],
	];
	const Ci = [
		[1, 0, cx],
		[0, 1, cy],
		[0, 0, 1],
	];
	const Pc = matMul3(Ci, matMul3([[1, 0, 0], [0, 1, 0], [px, py, 1]], C));
	return matMul3(R, matMul3(S, Pc));
}

/** out(x) = src(Minv · x) (bilinear); `fill(x, y)` where the source is outside. */
function warpInto(out, W, H, src, Minv, fill) {
	const { data, width: sw, height: sh } = src;
	for (let y = 0; y < H; y++) {
		let X = Minv[0][1] * y + Minv[0][2];
		let Y = Minv[1][1] * y + Minv[1][2];
		let Z = Minv[2][1] * y + Minv[2][2];
		for (let x = 0; x < W; x++, X += Minv[0][0], Y += Minv[1][0], Z += Minv[2][0]) {
			const sx = X / Z;
			const sy = Y / Z;
			const x0 = Math.floor(sx);
			const y0 = Math.floor(sy);
			if (x0 < 0 || y0 < 0 || x0 >= sw - 1 || y0 >= sh - 1) {
				out[y * W + x] = fill(x, y);
				continue;
			}
			const fx = sx - x0;
			const fy = sy - y0;
			const o = y0 * sw + x0;
			out[y * W + x] = Math.round(
				(data[o] * (1 - fx) + data[o + 1] * fx) * (1 - fy) + (data[o + sw] * (1 - fx) + data[o + sw + 1] * fx) * fy,
			);
		}
	}
}

/** Template px → pin units. */
const tplToPinH = [
	[1 / P, 0, -PX0 / P],
	[0, 1 / P, -PY0 / P],
	[0, 0, 1],
];

/** The pad body in pin units (template body ± a bit), TL, TR, BR, BL. */
function bodyPinQuad() {
	const bez = T.bezel;
	const body = [bez[0][0] - 25, bez[0][1] - 18, bez[1][0] + 25, T.textWindow[2][1] + 18];
	return [
		[body[0], body[1]],
		[body[2], body[1]],
		[body[2], body[3]],
		[body[0], body[3]],
	].map((p) => applyH(tplToPinH, p));
}

/** Point-in-convex-quad (any orientation). */
function inQuad(q, x, y) {
	let sign = 0;
	for (let i = 0; i < 4; i++) {
		const a = q[i];
		const b = q[(i + 1) % 4];
		const c = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
		const s = c > 0 ? 1 : c < 0 ? -1 : 0;
		if (s === 0) continue;
		if (sign === 0) sign = s;
		else if (s !== sign) return false;
	}
	return true;
}

/** Median grey of a ring just outside the pad body: the fill for the vacated table. */
function tableGrey(img, H0) {
	const q = bodyPinQuad();
	const vals = [];
	for (let k = 0; k < 600; k++) {
		const t = k / 600;
		const side = k % 4;
		const grow = 4 + (k % 5);
		const p =
			side === 0
				? [q[0][0] + t * (q[1][0] - q[0][0]), q[0][1] - grow]
				: side === 1
					? [q[1][0] + grow, q[1][1] + t * (q[2][1] - q[1][1])]
					: side === 2
						? [q[0][0] + t * (q[1][0] - q[0][0]), q[2][1] + grow]
						: [q[0][0] - grow, q[1][1] + t * (q[2][1] - q[1][1])];
		const [x, y] = applyH(H0, p).map(Math.round);
		if (x >= 0 && y >= 0 && x < img.width && y < img.height) vals.push(img.data[y * img.width + x]);
	}
	vals.sort((a, b) => a - b);
	return vals.length ? vals[vals.length >> 1] : 128;
}

/**
 * Render one frame.
 * @param {object} s   source() result.
 * @param {number[][]} G  camera motion (whole frame).
 * @param {number[][]} M  pad motion (applied before G, in source px).
 * @param {object|null} hand  hand description (see `drawHand`).
 * @param {number} seed
 */
export function renderFrame(s, G, M, hand, seed = 1) {
	const { img, H0 } = s;
	const W = img.width;
	const Hh = img.height;
	const out = new Uint8Array(W * Hh);
	const rand = rng(seed);
	const table = s.table ?? (s.table = tableGrey(img, H0));
	const bodyPx = bodyPinQuad().map((p) => applyH(H0, p));
	// 1. Background: the source, with the pad body painted table grey (only when the pad moves on its own).
	const padMoves = M && M.some((row, i) => row.some((v, j) => Math.abs(v - (i === j ? 1 : 0)) > 1e-12));
	let bg = img;
	if (padMoves) {
		const d = new Uint8Array(img.data);
		const xs = bodyPx.map((p) => p[0]);
		const ys = bodyPx.map((p) => p[1]);
		const xa = Math.max(0, Math.floor(Math.min(...xs)));
		const xb = Math.min(W - 1, Math.ceil(Math.max(...xs)));
		const ya = Math.max(0, Math.floor(Math.min(...ys)));
		const yb = Math.min(Hh - 1, Math.ceil(Math.max(...ys)));
		for (let y = ya; y <= yb; y++)
			for (let x = xa; x <= xb; x++) if (inQuad(bodyPx, x, y)) d[y * W + x] = table;
		bg = { data: d, width: W, height: Hh };
	}
	// 2. Camera: out(x) = composite(G⁻¹ x); composite(y) = pad(M⁻¹ y) inside the moved body, else bg(y).
	const Gi = invert3(G);
	const mean = table;
	warpInto(out, W, Hh, bg, Gi, () => mean);
	if (padMoves) {
		const movedBody = bodyPx.map((p) => applyH(matMul3(G, M), p));
		const padImg = new Uint8Array(W * Hh);
		const Mi = invert3(matMul3(G, M));
		warpInto(padImg, W, Hh, img, Mi, () => mean);
		const xs = movedBody.map((p) => p[0]);
		const ys = movedBody.map((p) => p[1]);
		const xa = Math.max(0, Math.floor(Math.min(...xs)));
		const xb = Math.min(W - 1, Math.ceil(Math.max(...xs)));
		const ya = Math.max(0, Math.floor(Math.min(...ys)));
		const yb = Math.min(Hh - 1, Math.ceil(Math.max(...ys)));
		for (let y = ya; y <= yb; y++)
			for (let x = xa; x <= xb; x++) if (inQuad(movedBody, x, y)) out[y * W + x] = padImg[y * W + x];
	}
	// Sensor noise, so consecutive frames are not identical.
	for (let i = 0; i < out.length; i += 1) {
		const v = out[i] + 1.5 * rand.gauss();
		out[i] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
	}
	let handInfo = null;
	if (hand) handInfo = drawHand(out, W, Hh, hand, matMul3(G, matMul3(M, H0)), rand);
	return { img: { data: out, width: W, height: Hh }, truth: matMul3(G, matMul3(M, H0)), hand: handInfo };
}

/**
 * A hand over the pad, positioned in PIN units of the current pose.
 * @param {{c: number, r: number, size: number, angle?: number}} hand
 *   (c, r): palm centre in pins; size: palm radius in pins; angle: finger direction (deg, 0 = up).
 * @returns {{coverage: number, hull: number[][]}} fraction of the 2,400 pin centres covered,
 *   and a MediaPipe-like hull (wrist to fingertips; no forearm).
 */
export function drawHand(out, W, Hh, hand, Hpin, rand) {
	const pitch = pitchOfPose(Hpin);
	const centre = applyH(Hpin, [hand.c, hand.r]);
	const R = hand.size * pitch;
	const ang = (((hand.angle ?? 0) - 90) * Math.PI) / 180; // finger direction in image space
	const ux = Math.cos(ang);
	const uy = Math.sin(ang);
	const vx = -uy;
	const vy = ux;
	const at = (a, b) => [centre[0] + a * ux * R + b * vx * R, centre[1] + a * uy * R + b * vy * R];
	// Shapes in the hand frame (a along the fingers, b across), in palm radii.
	const ellipses = [
		{ c: at(0, 0), ra: 1.0, rb: 0.85 }, // palm
		{ c: at(0.95, -0.55), ra: 0.32, rb: 0.22 }, // curled fingers
		{ c: at(1.0, -0.15), ra: 0.32, rb: 0.22 },
		{ c: at(0.95, 0.25), ra: 0.3, rb: 0.2 },
		{ c: at(0.3, 0.95), ra: 0.45, rb: 0.2 }, // thumb
	];
	const finger = { from: at(0.7, -0.55), to: at(2.6, -0.62), half: 0.17 * R }; // index finger
	const arm = { from: at(-0.6, 0), to: at(-8, 0), half: 0.75 * R }; // forearm to the frame edge
	const inEllipse = (e, x, y) => {
		const dx = x - e.c[0];
		const dy = y - e.c[1];
		const a = (dx * ux + dy * uy) / (e.ra * R);
		const b = (dx * vx + dy * vy) / (e.rb * R);
		return a * a + b * b <= 1;
	};
	const inCapsule = (s, x, y) => {
		const ex = s.to[0] - s.from[0];
		const ey = s.to[1] - s.from[1];
		const L2 = ex * ex + ey * ey;
		const t = Math.max(0, Math.min(1, ((x - s.from[0]) * ex + (y - s.from[1]) * ey) / L2));
		const px = s.from[0] + t * ex - x;
		const py = s.from[1] + t * ey - y;
		return px * px + py * py <= s.half * s.half;
	};
	const inHand = (x, y) => ellipses.some((e) => inEllipse(e, x, y)) || inCapsule(finger, x, y) || inCapsule(arm, x, y);
	// Creases and specks (a ring, a watch face): things that could look like dots.
	const creases = Array.from({ length: 6 }, () => [at(rand.uni(-0.6, 0.6), rand.uni(-0.7, 0.7)), rand.uni(0, Math.PI)]);
	const specks = Array.from({ length: 25 }, () => at(rand.uni(-1, 1.5), rand.uni(-0.9, 0.9)));
	const shadeA = rand.uni(0, Math.PI * 2);
	// Bounding box of every shape (the forearm is clipped by the frame).
	const ext = [...ellipses.map((e) => e.c), finger.from, finger.to, arm.from, arm.to];
	const bx0 = Math.max(0, Math.floor(Math.min(...ext.map((p) => p[0])) - 1.2 * R));
	const bx1 = Math.min(W - 1, Math.ceil(Math.max(...ext.map((p) => p[0])) + 1.2 * R));
	const by0 = Math.max(0, Math.floor(Math.min(...ext.map((p) => p[1])) - 1.2 * R));
	const by1 = Math.min(Hh - 1, Math.ceil(Math.max(...ext.map((p) => p[1])) + 1.2 * R));
	for (let y = by0; y <= by1; y++) {
		for (let x = bx0; x <= bx1; x++) {
			if (!inHand(x, y)) continue;
			let g = 175 + 20 * Math.cos((x * Math.cos(shadeA) + y * Math.sin(shadeA)) / (3 * R)) + 4 * rand.gauss();
			for (const [c, th] of creases) {
				const d = Math.abs((x - c[0]) * Math.sin(th) - (y - c[1]) * Math.cos(th));
				const along = Math.abs((x - c[0]) * Math.cos(th) + (y - c[1]) * Math.sin(th));
				if (d < 0.08 * pitch + 0.6 && along < 0.4 * R) g -= 30;
			}
			for (const s of specks) {
				const d = Math.hypot(x - s[0], y - s[1]);
				if (d < 0.25 * pitch) g += 50 * (1 - d / (0.25 * pitch));
			}
			out[y * W + x] = Math.max(0, Math.min(255, Math.round(g)));
		}
	}
	let covered = 0;
	for (let r = 0; r < 40; r++)
		for (let c = 0; c < 60; c++) {
			const p = applyH(Hpin, [c, r]);
			if (inHand(p[0], p[1])) covered++;
		}
	// MediaPipe-like landmarks: wrist, palm rim, fingertips.
	const lm = [at(-0.9, 0), at(-0.5, -0.8), at(-0.5, 0.8), at(0.9, -0.85), at(1.25, -0.15), at(1.2, 0.45), at(0.5, 1.4), finger.to];
	return { coverage: covered / 2400, hull: lm };
}

/** Error of a pose against the truth: max over the four corners, in pins. */
export function poseError(H, truth) {
	if (!H) return Number.POSITIVE_INFINITY;
	const pitch = pitchOfPose(truth);
	let worst = 0;
	for (const p of PIN_IDX) {
		const a = applyH(H, p);
		const b = applyH(truth, p);
		worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1]) / pitch);
	}
	return worst;
}

export const IDENTITY = [
	[1, 0, 0],
	[0, 1, 0],
	[0, 0, 1],
];
