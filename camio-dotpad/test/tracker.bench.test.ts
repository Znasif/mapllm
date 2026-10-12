/**
 * Tracker cost per frame, isolated from frame synthesis: 12 pre-rendered frames
 * of a slow camera pan per source, tracked 4 times over (44 timed updates).
 * Also the cost of one relock (a 1-pin bump) and of the full re-acquire steps.
 */
import { describe, expect, it } from 'vitest';
import { applyH } from '../src/geometry';
import { createLatticeTracker, lumaFrame } from '../src/tracker';
import { IDENTITY, cameraMotion, pitchOfPose, renderFrame, rigid, source } from './fixtures/sequences.mjs';

const pct = (a: number[], q: number) => {
	const s = [...a].sort((x, y) => x - y);
	return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))];
};

describe('tracker cost', () => {
	for (const file of ['hue_handsoff_00.jpg', 'hue_oblique_00.jpg', 'PXL_20260930_222009160.jpg']) {
		it(file, () => {
			const s = source(file);
			const p = pitchOfPose(s.H0);
			const c = applyH(s.H0, [29.5, 19.5]);
			const frames = Array.from({ length: 12 }, (_, t) => renderFrame(s, cameraMotion({ cx: c[0], cy: c[1], dx: 0.2 * p * t }), IDENTITY, null, t));
			const tr = createLatticeTracker();
			tr.reset(frames[0].truth, lumaFrame(frames[0].img));
			const ms: number[] = [];
			for (let k = 0; k < 4; k++) {
				tr.reset(frames[0].truth, lumaFrame(frames[0].img));
				for (let t = 1; t < frames.length; t++) ms.push(tr.update(lumaFrame(frames[t].img)).ms);
			}
			// One relock: a 1-pin bump.
			const bumped = renderFrame(s, IDENTITY, rigid(0, 0, 0, p, 0), null, 99);
			tr.reset(frames[0].truth, lumaFrame(frames[0].img));
			const rl = tr.update(lumaFrame(bumped.img));
			// Full re-acquire: a 4° turn, hands off, steps until tracking again.
			const turned = renderFrame(s, IDENTITY, rigid(4, c[0], c[1], 0, 0), null, 98);
			tr.reset(frames[0].truth, lumaFrame(frames[0].img));
			const steps: number[] = [];
			for (let k = 0; k < 40; k++) {
				const st = tr.update(lumaFrame(turned.img), { handsPresent: false });
				steps.push(st.ms);
				if (st.state === 'tracking') break;
			}
			const { width, height } = s.img;
			console.log(
				`${file} ${width}×${height} pitch ${p.toFixed(1)} px: track median ${pct(ms, 0.5).toFixed(2)} ms, p95 ${pct(ms, 0.95).toFixed(2)} ms | relock frame ${rl.ms.toFixed(1)} ms (${rl.relocked ? 'relocked' : rl.state}) | re-acquire ${steps.length} frames, worst step ${Math.max(...steps).toFixed(0)} ms, total ${steps.reduce((a, b) => a + b, 0).toFixed(0)} ms`,
			);
			expect(rl.relocked).toBe(true);
			expect(pct(ms, 0.5)).toBeLessThan(40);
		});
	}
});
