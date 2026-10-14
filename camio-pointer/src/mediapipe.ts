/**
 * Default hand landmarker: MediaPipe Tasks Vision (Apache-2.0), bundled into
 * the vendored file and evaluated only when this factory first runs (the
 * dynamic import below is inlined by the bundler as a lazy module, so merely
 * importing CamioPointer does not run any MediaPipe code).
 *
 * The WASM runtime and the hand model are NOT bundled: they are fetched from
 * `wasmBase` / `modelUrl` (self-hosted by the host app, same origin, so nothing
 * leaves the device and no third-party CDN is contacted).
 */

import type { HandResult } from './input';

/** What the pointer needs from a hand landmarker (MediaPipe's HandLandmarker satisfies it). */
export interface HandLandmarkerLike {
	detectForVideo(video: HTMLVideoElement, timestampMs: number): HandResult;
	close?(): void;
}

export interface HandLandmarkerFactoryOptions {
	/** Folder holding vision_wasm_internal.{js,wasm} and the nosimd variants. */
	wasmBase: string;
	/** URL of hand_landmarker.task. */
	modelUrl: string;
	/**
	 * 2: a second hand (other side, or a same-side duplicate → 'tooMany') is
	 * seen. CamIO uses 4; 2 keeps palm detection off while two hands are tracked.
	 * The result's `handedness` is passed through as is (see HandResult).
	 */
	numHands: number;
	delegate: 'GPU' | 'CPU';
}

/** Injectable factory (tests, or a host that already has MediaPipe). */
export type HandLandmarkerFactory = (o: HandLandmarkerFactoryOptions) => Promise<HandLandmarkerLike>;

/** The MediaPipe version bundled into this build; the self-hosted WASM must match it. */
export const MEDIAPIPE_VERSION = '0.10.35';

export const createMediaPipeHandLandmarker: HandLandmarkerFactory = async (o) => {
	const { FilesetResolver, HandLandmarker } = await import('@mediapipe/tasks-vision');
	const fileset = await FilesetResolver.forVisionTasks(o.wasmBase.replace(/\/+$/, ''));
	const make = (delegate: 'GPU' | 'CPU') =>
		HandLandmarker.createFromOptions(fileset, {
			baseOptions: { modelAssetPath: o.modelUrl, delegate },
			runningMode: 'VIDEO',
			numHands: o.numHands,
		});
	try {
		return (await make(o.delegate)) as unknown as HandLandmarkerLike;
	} catch (error) {
		// No WebGL2 / GPU delegate unavailable: the CPU delegate is slower but works.
		if (o.delegate === 'GPU') return (await make('CPU')) as unknown as HandLandmarkerLike;
		throw error;
	}
};
