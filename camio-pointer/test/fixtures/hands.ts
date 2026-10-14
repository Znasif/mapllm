/**
 * Hand landmark fixtures for the gesture tests. `camioPointing.json` holds
 * MediaPipe-like hands from a small kinematic model (wrist, thumb, four
 * fingers with flexion angles per joint) together with the verdicts of CamIO's
 * own `ratio()` / `Hand.__compute_is_pointing` run on exactly those numbers
 * (numpy; generator: gen_camio_pointing.py, kept out of the repo). Landmarks
 * are normalised for a 1280 × 720 image (x / W, y / H, z / W).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { HandResult, Landmark } from '../../src/input';

export interface CamioCase {
	name: string;
	pose: string;
	landmarks: [number, number, number][];
	expected: {
		ratioIndex: number;
		ratioMiddle: number;
		ratioRing: number;
		ratioPinky: number;
		projectionPass: boolean;
		overall: number;
		pointing: boolean;
	};
}

export const CAMIO_CASES: CamioCase[] = JSON.parse(readFileSync(fileURLToPath(new URL('./camioPointing.json', import.meta.url)), 'utf8')).cases;

const FW = 1280;
const FH = 720;

export const toLandmarks = (pts: [number, number, number][]): Landmark[] => pts.map(([x, y, z]) => ({ x, y, z }));

/** A named pose ('point', 'open', 'open-relaxed', 'fist', 'claw', 'peace', 'flat-on-table'), rotation 0. */
export function pose(name: string): Landmark[] {
	const c = CAMIO_CASES.find((k) => k.name === `${name}@0`);
	if (!c) throw new Error(`no pose ${name}`);
	return toLandmarks(c.landmarks);
}

/** The pose moved so its index tip is at (x, y) px in a W × H image (shape kept in px). */
export function handAt(name: string, x: number, y: number, W = FW, H = FH): Landmark[] {
	const L = pose(name);
	const tx = L[8].x * FW;
	const ty = L[8].y * FH;
	return L.map((p) => ({ x: (p.x * FW - tx + x) / W, y: (p.y * FH - ty + y) / H, z: ((p.z ?? 0) * FW) / W }));
}

/** A HandLandmarker result; `label` is MediaPipe's categoryName ('Left' | 'Right'), omitted = no handedness. */
export function handResult(...hands: Array<{ lm: Landmark[]; label?: 'Left' | 'Right' }>): HandResult {
	const r: HandResult = { landmarks: hands.map((h) => h.lm) };
	if (hands.some((h) => h.label)) r.handedness = hands.map((h) => (h.label ? [{ categoryName: h.label, index: h.label === 'Left' ? 0 : 1, score: 0.97 }] : []));
	return r;
}
