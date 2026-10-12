/**
 * Lattice-follow tracker on synthetic SEQUENCES built from the real frames.
 *
 * Per sequence: per-frame pose error (max corner error, pins), ALIASING (frames
 * whose pose was ACCEPTED while ≥ 1 pin wrong — must be 0), wrong-pin risk
 * (accepted while ≥ 0.5 pin wrong), loss detection and re-acquire latency for
 * bumps, and ms/frame. Run: `npm run test:tracker` (prints a table).
 */
import { describe, expect, it } from 'vitest';
import { applyH, type Mat3 } from '../src/geometry';
import { createLatticeTracker, lumaFrame } from '../src/tracker';
import { erasePinField } from './fixtures/scenes.mjs';
import {
	IDENTITY,
	cameraMotion,
	pitchOfPose,
	poseError,
	renderFrame,
	rigid,
	source,
} from './fixtures/sequences.mjs';

type Hand = { c: number; r: number; size: number; angle?: number } | null;
interface Spec {
	name: string;
	frames: number;
	/** Camera motion at frame t (whole image). */
	G?: (t: number, s: Src) => Mat3;
	/** Pad motion at frame t (pad only). */
	M?: (t: number, s: Src) => Mat3;
	hand?: (t: number) => Hand;
	/** Pass the hand hull as an occluder hint. */
	hint?: boolean;
	/** Frame of a sudden bump (for latency). */
	bumpAt?: number;
	blank?: boolean;
}
type Src = ReturnType<typeof source> & { pitch: number; cx: number; cy: number };

interface Row {
	src: string;
	seq: string;
	frames: number;
	accepted: number;
	held: number;
	lost: number;
	medianErr: number;
	maxAcceptedErr: number;
	aliasing: number;
	wrongPin: number;
	/** Frames whose pose was still USABLE for pins (not lost) while ≥ 0.5 pin wrong. */
	usableWrong: number;
	lossDetected: boolean | null;
	reacquire: number | null;
	msMean: number;
	msP95: number;
	coverage: string;
}

const median = (a: number[]) => {
	if (!a.length) return Number.NaN;
	const s = [...a].sort((x, y) => x - y);
	return s[s.length >> 1];
};
const pct = (a: number[], q: number) => {
	if (!a.length) return Number.NaN;
	const s = [...a].sort((x, y) => x - y);
	return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))];
};

function prepare(file: string): Src {
	const s = source(file) as ReturnType<typeof source>;
	const pitch = pitchOfPose(s.H0);
	const c = applyH(s.H0, [29.5, 19.5]);
	return { ...s, pitch, cx: c[0], cy: c[1] };
}

function run(file: string, spec: Spec): Row {
	let s = prepare(file);
	if (spec.blank) {
		const corners = [
			[0, 0],
			[59, 0],
			[59, 39],
			[0, 39],
		].map((p) => applyH(s.H0, p));
		s = { ...s, img: erasePinField(s.img, corners) };
	}
	const tracker = createLatticeTracker();
	const errs: number[] = [];
	const ms: number[] = [];
	let accepted = 0;
	let held = 0;
	let lost = 0;
	let aliasing = 0;
	let wrongPin = 0;
	let usableWrong = 0;
	let maxAcc = 0;
	let lossDetected: boolean | null = spec.bumpAt == null ? null : false;
	let reacquire: number | null = null;
	const covs: number[] = [];
	for (let t = 0; t < spec.frames; t++) {
		const G = spec.G ? spec.G(t, s) : IDENTITY;
		const M = spec.M ? spec.M(t, s) : IDENTITY;
		const hand = spec.hand ? spec.hand(t) : null;
		const fr = renderFrame(s, G, M, hand, 1000 + t);
		if (fr.hand) covs.push(fr.hand.coverage);
		const hints = { occluders: spec.hint && fr.hand ? [fr.hand.hull] : undefined, handsPresent: !!fr.hand };
		const step = t === 0 ? tracker.reset(fr.truth, lumaFrame(fr.img), hints) : tracker.update(lumaFrame(fr.img), hints);
		if (t > 0) ms.push(step.ms);
		const err = poseError(step.pose, fr.truth);
		errs.push(err);
		if (step.accepted) {
			accepted++;
			maxAcc = Math.max(maxAcc, err);
			if (err >= 1) aliasing++;
			if (err >= 0.5) wrongPin++;
		} else if (step.state === 'lost') lost++;
		else held++;
		if (step.state !== 'lost' && err >= 0.5) usableWrong++;
		if (spec.bumpAt != null && t >= spec.bumpAt) {
			if (t === spec.bumpAt && (!step.accepted || err < 0.5)) lossDetected = true;
			if (reacquire == null && step.accepted && err < 0.5) reacquire = t - spec.bumpAt;
		}
		if (process.env.CAMIO_TRACE)
			console.log(`  ${spec.name} t${t} ${step.state}${step.accepted ? ' acc' : ''}${step.relocked ? ' RELOCK' : ''} err ${err.toFixed(2)} inl ${step.inliers}/${step.found} ${step.ms.toFixed(1)}ms ${step.reason ?? ''}`);
	}
	return {
		src: file.replace('.jpg', '').replace('PXL_20260930_', 'PXL_'),
		seq: spec.name + (spec.hint ? ' +hint' : ''),
		frames: spec.frames,
		accepted,
		held,
		lost,
		medianErr: median(errs),
		maxAcceptedErr: maxAcc,
		aliasing,
		wrongPin,
		usableWrong,
		lossDetected,
		reacquire,
		msMean: ms.reduce((a, b) => a + b, 0) / Math.max(1, ms.length),
		msP95: pct(ms, 0.95),
		coverage: covs.length ? `${(100 * Math.min(...covs)).toFixed(0)}-${(100 * Math.max(...covs)).toFixed(0)}%` : '',
	};
}

const SOURCES = ['hue_handsoff_00.jpg', 'hue_oblique_00.jpg', 'PXL_20260930_222009160.jpg'];

const padRot = (deg: number, s: Src, dx = 0, dy = 0) => rigid(deg, s.cx, s.cy, dx, dy);

const SPECS: Spec[] = [
	{
		name: 'camera pan',
		frames: 30,
		G: (t, s) => cameraMotion({ cx: s.cx, cy: s.cy, dx: 0.3 * s.pitch * t, dy: -0.15 * s.pitch * t, deg: 0.04 * t }),
	},
	{
		name: 'camera tilt+zoom',
		frames: 30,
		G: (t, s) =>
			cameraMotion({ cx: s.cx, cy: s.cy, scale: 1 + 0.005 * t, deg: -0.08 * t, px: 0.000012 * t, py: -0.00001 * t, dx: 0.1 * s.pitch * t }),
	},
	{
		name: 'pad slide',
		frames: 30,
		M: (t, s) => padRot(0, s, 0.3 * s.pitch * t, 0.12 * s.pitch * t),
	},
	{
		name: 'pad rotate+slide',
		frames: 30,
		M: (t, s) => padRot(0.2 * t, s, 0.08 * s.pitch * t, 0),
	},
	{
		name: 'bump 0.7 pin',
		frames: 16,
		bumpAt: 6,
		M: (t, s) => padRot(0, s, t >= 6 ? 0.7 * s.pitch : 0, 0),
	},
	{
		name: 'bump 1.0 pin (exact alias)',
		frames: 16,
		bumpAt: 6,
		M: (t, s) => padRot(0, s, 0, t >= 6 ? 1.0 * s.pitch : 0),
	},
	{
		name: 'bump 2.6 pin + 0.4°',
		frames: 16,
		bumpAt: 6,
		M: (t, s) => padRot(t >= 6 ? 0.4 : 0, s, t >= 6 ? 2.0 * s.pitch : 0, t >= 6 ? -1.6 * s.pitch : 0),
	},
	{
		name: 'bump 4° turn',
		frames: 16,
		bumpAt: 6,
		M: (t, s) => padRot(t >= 6 ? 4 : 0, s, 0, 0),
	},
	{
		name: 'fast slide 0.45 pin/frame',
		frames: 24,
		M: (t, s) => padRot(0.03 * t, s, 0.45 * s.pitch * t, 0.1 * s.pitch * t),
	},
	{
		name: 'bump 1.5 pin under a hand',
		frames: 18,
		bumpAt: 8,
		hint: true,
		M: (t, s) => padRot(t >= 8 ? 0.2 : 0, s, t >= 8 ? 1.5 * s.pitch : 0, t >= 8 ? 0.6 * s.pitch : 0),
		hand: (t) => ({ c: 40, r: 22, size: 12, angle: 20 }),
	},
	...[true, false].flatMap((hint) => [
		{
			name: 'hand ~20% sweep',
			frames: 24,
			hint,
			hand: (t: number) => ({ c: 8 + 1.5 * t, r: 22, size: 10, angle: -20 }),
		},
		{
			name: 'hand ~35% + camera pan',
			frames: 24,
			hint,
			G: (t: number, s: Src) => cameraMotion({ cx: s.cx, cy: s.cy, dx: 0.2 * s.pitch * t, dy: 0.05 * s.pitch * t }),
			hand: (t: number) => ({ c: 18 + 0.8 * t, r: 24, size: 13.5, angle: -10 }),
		},
		{
			name: 'hand ~50% + pad slide',
			frames: 24,
			hint,
			M: (t: number, s: Src) => padRot(0, s, 0.15 * s.pitch * t, 0),
			hand: (t: number) => ({ c: 25 + 0.3 * t, r: 25, size: 19.5, angle: 0 }),
		},
	]),
	{ name: 'pins blank (erased)', frames: 10, blank: true, M: (t, s) => padRot(0, s, 0.2 * s.pitch * t, 0) },
];

describe('lattice-follow tracker on real-frame sequences', () => {
	const rows: Row[] = [];
	for (const file of SOURCES) {
		for (const spec of SPECS) {
			it(`${file} — ${spec.name}${spec.hint ? ' (+hint)' : ''}`, () => {
				const row = run(file, spec);
				rows.push(row);
				// Hard requirement: never ACCEPT a pose that is a pin (or more) off.
				expect(row.aliasing).toBe(0);
				expect(row.wrongPin).toBe(0);
				// Pins are emitted from any non-lost pose: it must never be a pin off,
				// except when the pins are invisible (documented static fallback).
				if (!spec.blank) expect(row.usableWrong).toBe(0);
				if (spec.bumpAt != null) expect(row.lossDetected).toBe(true);
				if (spec.blank) expect(row.accepted).toBeLessThanOrEqual(1);
				if (!spec.hand && !spec.blank && spec.bumpAt == null) {
					expect(row.accepted).toBeGreaterThanOrEqual(spec.frames - 1);
					expect(row.medianErr).toBeLessThan(0.2);
				}
			});
		}
	}
	it('report', () => {
		const f = (v: number | null, d = 2) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d));
		console.log(
			'\nsource            | sequence                     | n  | acc | held | lost | med err | max acc err | alias | ≥0.5 | usable≥0.5 | loss? | reacq | ms mean | ms p95 | hand cov',
		);
		for (const r of rows) {
			console.log(
				`${r.src.padEnd(17)} | ${r.seq.padEnd(28)} | ${String(r.frames).padStart(2)} | ${String(r.accepted).padStart(3)} | ${String(r.held).padStart(4)} | ${String(r.lost).padStart(4)} | ${f(r.medianErr).padStart(7)} | ${f(r.maxAcceptedErr).padStart(11)} | ${String(r.aliasing).padStart(5)} | ${String(r.wrongPin).padStart(4)} | ${String(r.usableWrong).padStart(10)} | ${String(r.lossDetected ?? '').padStart(5)} | ${String(r.reacquire ?? (r.lossDetected == null ? '' : 'none')).padStart(5)} | ${f(r.msMean, 1).padStart(7)} | ${f(r.msP95, 1).padStart(6)} | ${r.coverage}`,
			);
		}
	});
});
