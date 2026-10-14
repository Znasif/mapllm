/**
 * The rect surface's tracker: the starter's AKAZE tracking (TactileExplorer.jsx /
 * TactileExplorerGeneric.jsx) over an {@link AkazeEngine}, as a {@link Tracker}.
 * Pure: no DOM; the engine (inline or Web Worker) does the OpenCV work.
 *
 * Starter rules kept:
 *  - the reference is one grey snapshot taken from the HANDS-OFF registration
 *    frame (Generic); `Hfwd` is seeded to the identity "so tracking works the
 *    instant registration finishes";
 *  - a match every 6 frames (here: at least `everyFrames` update calls since
 *    the last post, and never while one is in flight);
 *  - accept iff inliers ≥ 8 and ≥ the best so far, the best going stale after
 *    7 s; otherwise keep the last `Hfwd`;
 *  - pose = Hfwd · pose0 (the corners projected through Hfwd).
 *
 * States: loading (engine or reference not ready; the registration pose is
 * used), tracking, occluded (the last completed match was rejected; the last
 * pose is kept), blank ('opencv-unavailable', 'low-texture': reference
 * keypoints < minInliers, so matching can never succeed). Never 'lost': the
 * starter has no lost state, so the core's lost/relock machinery stays DOT Pad-only.
 */

import type { AkazeEngine, AkazeEngineFactory, AkazeMatch } from './akaze';
import { type Mat3, type Point, applyH, matMul3 } from './geometry';
import type { LumaFrame, TrackHints, TrackState, TrackStep, Tracker } from './tracker';

export interface AkazeTrackerOptions {
	/** Builds the engine; null/absent → the tracker reports 'opencv-unavailable'. */
	loadEngine: AkazeEngineFactory | null;
	/** Minimum RANSAC inliers to accept a homography (starter 8; CamIO uses > 24). */
	minInliers: number;
	/** Lowe's ratio (starter 0.75), forwarded to the engine. */
	ratio: number;
	/** RANSAC reprojection threshold px (starter 8), forwarded to the engine. */
	ransacPx: number;
	/** Match every N update calls (starter 6). */
	everyFrames: number;
	/** A best inlier count older than this no longer blocks a weaker fit (starter 7000 ms). */
	staleMs: number;
	/** D1: 'surface' masks the reference to the registered quad (default); 'none' = the starter verbatim (whole frame). */
	referenceMask: 'surface' | 'none';
}

export const AKAZE_TRACKER_DEFAULTS: Readonly<Omit<AkazeTrackerOptions, 'loadEngine'>> = Object.freeze({
	minInliers: 8,
	ratio: 0.75,
	ransacPx: 8,
	everyFrames: 6,
	staleMs: 7000,
	referenceMask: 'surface' as const,
});

const IDENTITY = (): Mat3 => [
	[1, 0, 0],
	[0, 1, 0],
	[0, 0, 1],
];

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Create the AKAZE tracker. */
export function createAkazeTracker(options: Partial<AkazeTrackerOptions> = {}): Tracker & {
	readonly debug: { found: Point[]; missing: Point[] } | null;
} {
	// Options left undefined keep their defaults.
	const given = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined));
	const o: AkazeTrackerOptions = { loadEngine: null, ...AKAZE_TRACKER_DEFAULTS, ...given };

	let engine: AkazeEngine | null = null;
	let engineState: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
	let disposed = false;

	/** Bumped by reset/clear: results of older requests are ignored. */
	let gen = 0;
	let pose0: Mat3 | null = null;
	let Hfwd: Mat3 = IDENTITY();
	let pose: Mat3 | null = null;
	let bestInliers = 0;
	let bestInliersAt = 0;
	let region: number[] | null = null;
	let regionPts: Point[] | null = null;
	/** A reference frame waiting for the engine; or 'next hands-off frame' after a frameless reset. */
	let pendingRef: { gray: Uint8Array; width: number; height: number } | null = null;
	let awaitingHandsOff = false;
	let refState: 'none' | 'building' | 'ready' | 'failed' = 'none';
	let refKeypoints = 0;
	let inFlight = false;
	let result: (AkazeMatch & { failed?: boolean }) | null = null;
	let sincePost = 0;
	let lastMatch: 'none' | 'accepted' | 'rejected' = 'none';
	let last = { good: 0, inliers: 0 };
	let state: TrackState = 'idle';
	let debug: { found: Point[]; missing: Point[] } | null = null;

	const grayOf = (frame: LumaFrame): Uint8Array => new Uint8Array(frame.read(0, 0, frame.width, frame.height));

	function prepare() {
		if (engineState !== 'idle' || disposed) return;
		if (!o.loadEngine) {
			engineState = 'failed';
			return;
		}
		engineState = 'loading';
		let p: Promise<AkazeEngine>;
		try {
			p = o.loadEngine({ ratio: o.ratio, ransacPx: o.ransacPx });
		} catch {
			engineState = 'failed';
			return;
		}
		p.then(
			(e) => {
				if (disposed) {
					e.dispose();
					return;
				}
				engine = e;
				engineState = 'ready';
				sendReference();
			},
			() => {
				engineState = 'failed';
			},
		);
	}

	function sendReference() {
		if (!engine || !pendingRef) return;
		const ref = pendingRef;
		pendingRef = null;
		const g = gen;
		refState = 'building';
		engine.setReference(ref.gray, ref.width, ref.height, o.referenceMask === 'surface' ? region : null).then(
			(r) => {
				if (g !== gen) return;
				refKeypoints = r.keypoints;
				refState = 'ready';
			},
			() => {
				if (g !== gen) return;
				refState = 'failed';
			},
		);
	}

	function postMatch(frame: LumaFrame) {
		if (!engine) return;
		const g = gen;
		inFlight = true;
		sincePost = 0;
		engine.match(grayOf(frame), frame.width, frame.height).then(
			(r) => {
				if (g !== gen) return;
				inFlight = false;
				result = r;
			},
			() => {
				if (g !== gen) return;
				inFlight = false;
				result = { H: null, good: 0, inliers: 0, failed: true };
			},
		);
	}

	/** The starter's acceptance rule. Returns true when a new Hfwd was applied. */
	function apply(r: AkazeMatch, t: number): boolean {
		last = { good: r.good, inliers: r.inliers };
		const stale = t - bestInliersAt > o.staleMs;
		if (stale) bestInliers = 0;
		if (r.H && r.inliers >= o.minInliers && r.inliers >= bestInliers) {
			const d = r.H;
			Hfwd = [
				[d[0], d[1], d[2]],
				[d[3], d[4], d[5]],
				[d[6], d[7], d[8]],
			];
			bestInliers = r.inliers;
			bestInliersAt = t;
			lastMatch = 'accepted';
			updatePose();
			return true;
		}
		lastMatch = 'rejected';
		return false;
	}

	function updatePose() {
		pose = pose0 ? matMul3(Hfwd, pose0) : null;
		debug = pose && regionPts ? { found: regionPts.map((p) => applyH(Hfwd, p)), missing: [] } : null;
	}

	function currentState(): { state: TrackState; reason: string | null } {
		if (!pose0) return { state: 'idle', reason: 'no-pose' };
		if (engineState === 'failed') return { state: 'blank', reason: 'opencv-unavailable' };
		if (engineState !== 'ready') return { state: 'loading', reason: 'loading' };
		if (refState === 'failed') return { state: 'blank', reason: 'reference-failed' };
		if (refState !== 'ready') return { state: 'loading', reason: 'reference' };
		if (refKeypoints < o.minInliers) return { state: 'blank', reason: 'low-texture' };
		if (lastMatch === 'rejected') return { state: 'occluded', reason: 'weak-match' };
		return { state: 'tracking', reason: null };
	}

	function step(t0: number, accepted: boolean): TrackStep {
		const s = currentState();
		state = s.state;
		return {
			state,
			pose,
			accepted,
			relocked: false,
			found: last.good,
			inliers: last.inliers,
			visible: refKeypoints,
			residual: Number.NaN,
			reason: s.reason,
			ms: now() - t0,
		};
	}

	function clearState() {
		gen++;
		pose0 = null;
		pose = null;
		Hfwd = IDENTITY();
		pendingRef = null;
		awaitingHandsOff = false;
		refState = 'none';
		refKeypoints = 0;
		inFlight = false;
		result = null;
		sincePost = 0;
		lastMatch = 'none';
		last = { good: 0, inliers: 0 };
		region = null;
		regionPts = null;
		debug = null;
		state = 'idle';
	}

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
		prepare,
		reset(H: Mat3, frame?: LumaFrame, hints?: TrackHints): TrackStep {
			const t0 = now();
			clearState();
			pose0 = H;
			Hfwd = IDENTITY();
			bestInliers = 0;
			bestInliersAt = hints?.now ?? 0;
			const q = hints?.region;
			regionPts = q && q.length === 4 ? Array.from(q, (p) => [p[0], p[1]] as Point) : null;
			region = regionPts ? regionPts.flat() : null;
			updatePose();
			prepare();
			if (frame) {
				pendingRef = { gray: grayOf(frame), width: frame.width, height: frame.height };
				sendReference();
			} else awaitingHandsOff = true;
			return step(t0, true);
		},
		update(frame: LumaFrame, hints?: TrackHints): TrackStep {
			const t0 = now();
			if (!pose0) return step(t0, false);
			if (awaitingHandsOff && !hints?.handsPresent) {
				awaitingHandsOff = false;
				pendingRef = { gray: grayOf(frame), width: frame.width, height: frame.height };
				sendReference();
			}
			// 1. Apply a finished match.
			let accepted = false;
			if (result) {
				const r = result;
				result = null;
				accepted = apply(r, hints?.now ?? now());
			}
			// 2. Post the next one.
			sincePost++;
			if (engineState === 'ready' && refState === 'ready' && refKeypoints >= o.minInliers && !inFlight && sincePost >= o.everyFrames) postMatch(frame);
			return step(t0, accepted);
		},
		clear() {
			clearState();
		},
		dispose() {
			disposed = true;
			clearState();
			try {
				engine?.dispose();
			} catch {
				// Nothing else to release.
			}
			engine = null;
			engineState = 'failed';
		},
	};
}
