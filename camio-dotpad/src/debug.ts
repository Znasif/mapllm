/**
 * Optional debug overlay (Canvas 2D only, no OpenCV): the camera frame, the
 * tracked pin field, the border band, found / missing pins from the last
 * tracker step, hands, the fingertip, captured or pending corners and status.
 */

import type { PointerCore } from './core';
import { type Mat3, type Point, applyH } from './geometry';

export interface DebugDrawOptions {
	/** Draw every pin centre of the predicted lattice (default true). */
	pins?: boolean;
	/** Draw found / missing pins of the last tracker step (default true). */
	trackerPins?: boolean;
}

type Ctx = CanvasRenderingContext2D;

function quad(ctx: Ctx, q: Point[], stroke: string, width: number, dash: number[] = []) {
	ctx.beginPath();
	q.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
	ctx.closePath();
	ctx.setLineDash(dash);
	ctx.strokeStyle = stroke;
	ctx.lineWidth = width;
	ctx.stroke();
	ctx.setLineDash([]);
}

const rect = (H: Mat3, c0: number, r0: number, c1: number, r1: number): Point[] => [
	applyH(H, [c0, r0]),
	applyH(H, [c1, r0]),
	applyH(H, [c1, r1]),
	applyH(H, [c0, r1]),
];

/**
 * Draw `source` (the frame the pointer just processed) and the overlay into
 * `canvas`, scaled to the canvas width.
 */
export function drawDebugOverlay(
	canvas: HTMLCanvasElement,
	source: CanvasImageSource | null,
	core: PointerCore,
	opts: DebugDrawOptions = {},
): void {
	const { width: fw, height: fh } = core.view.frame;
	if (!fw || !fh) return;
	const W = canvas.width || fw;
	const Hc = Math.round((W * fh) / fw);
	if (canvas.width !== W) canvas.width = W;
	if (canvas.height !== Hc) canvas.height = Hc;
	const ctx = canvas.getContext('2d');
	if (!ctx) return;
	const k = W / fw;
	ctx.save();
	if (source) ctx.drawImage(source, 0, 0, W, Hc);
	else {
		ctx.fillStyle = '#0f172a';
		ctx.fillRect(0, 0, W, Hc);
	}
	ctx.scale(k, k);
	const lw = 1 / k;
	const { cols, rows, border } = core.options;
	const pose = core.pose;
	const st = core.getStatus();
	if (pose && core.currentPhase === 'ready') {
		const colour = st.tracking === 'lost' ? 'rgba(239,68,68,0.95)' : st.tracking === 'tracking' ? 'rgba(34,197,94,0.95)' : 'rgba(250,204,21,0.95)';
		quad(ctx, rect(pose, -0.5, -0.5, cols - 0.5, rows - 0.5), colour, 2 * lw);
		quad(ctx, rect(pose, border - 0.5, border - 0.5, cols - 1 - border + 0.5, rows - 1 - border + 0.5), 'rgba(234,88,12,0.9)', lw, [4 * lw, 3 * lw]);
		if (opts.pins !== false) {
			ctx.fillStyle = 'rgba(56,189,248,0.55)';
			for (let r = 0; r < rows; r++)
				for (let c = 0; c < cols; c++) {
					const [x, y] = applyH(pose, [c, r]);
					ctx.fillRect(x - 0.6 * lw, y - 0.6 * lw, 1.2 * lw, 1.2 * lw);
				}
		}
		const dbg = (core.tracker as { debug?: { found: Point[]; missing: Point[] } | null }).debug;
		if (opts.trackerPins !== false && dbg) {
			ctx.fillStyle = 'rgba(34,197,94,0.9)';
			for (const [x, y] of dbg.found) ctx.fillRect(x - lw, y - lw, 2 * lw, 2 * lw);
			ctx.fillStyle = 'rgba(239,68,68,0.9)';
			for (const [x, y] of dbg.missing) ctx.fillRect(x - lw, y - lw, 2 * lw, 2 * lw);
		}
		// Top-left marker: which corner the pad's pin (0, 0) is.
		const [tx, ty] = applyH(pose, [0, 0]);
		ctx.beginPath();
		ctx.arc(tx, ty, 6 * lw, 0, Math.PI * 2);
		ctx.strokeStyle = 'rgba(59,130,246,0.95)';
		ctx.lineWidth = 2 * lw;
		ctx.stroke();
		const pin = core.currentPin;
		if (pin) {
			quad(ctx, rect(pose, pin.x - 0.5, pin.y - 0.5, pin.x + 0.5, pin.y + 0.5), pin.inBorder ? 'rgba(234,88,12,1)' : 'rgba(250,204,21,1)', 2 * lw);
		}
	}
	// Corners being captured / pending confirmation.
	const pending = core.pendingCorners;
	if (pending && core.currentPhase !== 'ready') {
		pending.forEach(([x, y], i) => {
			ctx.beginPath();
			ctx.arc(x, y, (i === 0 ? 6 : 4) * lw, 0, Math.PI * 2);
			ctx.fillStyle = i === 0 ? 'rgba(59,130,246,0.95)' : 'rgba(250,204,21,0.9)';
			ctx.fill();
		});
		if (pending.length === 4) quad(ctx, pending, 'rgba(168,85,247,0.9)', lw);
	}
	// Hands and the fingertip.
	ctx.fillStyle = 'rgba(244,114,182,0.8)';
	for (const hand of core.view.hands) for (const [x, y] of hand) ctx.fillRect(x - 1.5 * lw, y - 1.5 * lw, 3 * lw, 3 * lw);
	const tip = core.view.tip;
	if (tip) {
		ctx.beginPath();
		ctx.arc(tip[0], tip[1], 7 * lw, 0, Math.PI * 2);
		ctx.strokeStyle = 'rgba(250,204,21,1)';
		ctx.lineWidth = 2 * lw;
		ctx.stroke();
	}
	ctx.restore();
	// Status text (unscaled).
	const step = core.lastTrackStep;
	const pin = core.currentPin;
	const line = `${st.message}${step ? ` | pins ${step.inliers}/${step.visible} ${step.ms.toFixed(1)} ms` : ''}${pin ? ` | pin ${pin.x},${pin.y}${pin.inBorder ? ' (border)' : ''}` : ''}`;
	ctx.font = '13px system-ui, sans-serif';
	const tw = ctx.measureText(line).width;
	ctx.fillStyle = 'rgba(15,23,42,0.8)';
	ctx.fillRect(4, 4, tw + 12, 20);
	ctx.fillStyle = '#e2e8f0';
	ctx.fillText(line, 10, 18);
}
