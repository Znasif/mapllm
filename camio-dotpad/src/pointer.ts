/**
 * `createDotPadPointer` — the browser shell around {@link PointerCore}: opens
 * (or adopts) a camera, runs the hand landmarker on each new camera frame,
 * exposes the frame's luma to the core, and forwards the core's events.
 *
 * Nothing happens at import or construction time: the camera, the DOM and the
 * network are touched only by `start()`.
 */

import { type CoreEvents, type CoreOptions, PointerCore, type PointerStatus, type Registration } from './core';
import { type DebugDrawOptions, drawDebugOverlay } from './debug';
import type { Mat3 } from './geometry';
import { rgbaToGray } from './imageops';
import type { HandResult } from './input';
import { type HandLandmarkerFactory, type HandLandmarkerLike, createMediaPipeHandLandmarker } from './mediapipe';
import { prompt } from './prompts';
import type { LumaFrame } from './tracker';

export interface DotPadPointerOptions extends Partial<CoreOptions> {
	/**
	 * Base URL of the self-hosted MediaPipe assets, e.g. '/vendor/mediapipe/':
	 * `${assetsBase}wasm/` (vision_wasm_internal.*, vision_wasm_nosimd_internal.*)
	 * and `${assetsBase}hand_landmarker.task`. Required unless `handLandmarker`
	 * is injected or `wasmBase` and `modelUrl` are both given.
	 */
	assetsBase?: string;
	wasmBase?: string;
	modelUrl?: string;
	/** Camera to open (MediaDeviceInfo.deviceId). Ignored when `video` is given. */
	deviceId?: string;
	/** Use this video element or stream instead of opening a camera (not stopped by stop()). */
	video?: HTMLVideoElement | MediaStream;
	/** Requested capture size (ideal). */
	width?: number;
	height?: number;
	/** Injectable hand-landmarker factory (default: bundled MediaPipe). */
	handLandmarker?: HandLandmarkerFactory;
	delegate?: 'GPU' | 'CPU';
	/** ms to wait for the first camera frame before failing. */
	firstFrameTimeoutMs?: number;
}

export interface DotPadPointer {
	/** Open the camera and the hand model, then run. Resolves once frames are flowing. */
	start(): Promise<void>;
	/** Stop the loop and release a camera this pointer opened. The registration is kept. */
	stop(): void;
	/** stop(), close the hand model, drop listeners. The pointer cannot be restarted. */
	dispose(): void;
	/** Find the pad from the pin lattice (hands off). Resolves with the registration or null. */
	autoRegister(): Promise<Registration | null>;
	/** Dwell on the TL, TR, BR, BL corner pins; progress via 'prompt' events. */
	registerByCorners(): void;
	/** Accept the auto-found orientation without the confirm touch. */
	confirmTopLeft(): void;
	/** Abort a registration flow (the previous registration is restored). */
	cancel(): void;
	/** Freeze the pose (ignore camera/pad motion) or release it. */
	setFixed(fixed: boolean): void;
	on<K extends keyof CoreEvents>(type: K, listener: (payload: CoreEvents[K]) => void): () => void;
	off<K extends keyof CoreEvents>(type: K, listener: (payload: CoreEvents[K]) => void): void;
	/** Draw the last processed frame and the overlay into a canvas (debug / sighted helper). */
	drawDebug(canvas: HTMLCanvasElement, opts?: DebugDrawOptions): void;
	readonly status: PointerStatus;
	readonly registration: Registration | null;
	/** Pin (c, r) → camera px, as tracked right now. */
	readonly pose: Mat3 | null;
	readonly running: boolean;
	/** The video element frames are read from (after start()). */
	readonly videoElement: HTMLVideoElement | null;
	/** Advanced: feed your own frames (when not using start()). */
	processFrame(frame: LumaFrame, hands: HandResult | null, now: number): void;
	/** Advanced: the state machine. */
	readonly core: PointerCore;
}

type FrameCanvas = OffscreenCanvas | HTMLCanvasElement;
type FrameCtx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

/** Create a pointer. Pure construction: no camera, DOM or network access until start(). */
export function createDotPadPointer(options: DotPadPointerOptions = {}): DotPadPointer {
	const core = new PointerCore(options);
	const base = options.assetsBase ? options.assetsBase.replace(/\/?$/, '/') : '';
	const wasmBase = options.wasmBase ?? (base ? `${base}wasm` : '');
	const modelUrl = options.modelUrl ?? (base ? `${base}hand_landmarker.task` : '');

	let landmarker: HandLandmarkerLike | null = null;
	let video: HTMLVideoElement | null = null;
	let ownedStream: MediaStream | null = null;
	let ownedVideo = false;
	let running = false;
	let disposed = false;
	let starting: Promise<void> | null = null;
	let rafId = 0;
	let vfcId = 0;
	let lastVideoTime = -1;
	let lastTs = 0;
	let canvas: FrameCanvas | null = null;
	let ctx: FrameCtx | null = null;

	const fail = (code: string, message: string): never => {
		core.emit('error', { code, message });
		throw new Error(`CamioDotPad: ${message}`);
	};

	async function openVideo(): Promise<HTMLVideoElement> {
		const given = options.video;
		if (typeof HTMLVideoElement !== 'undefined' && given instanceof HTMLVideoElement) return given;
		const v = document.createElement('video');
		v.muted = true;
		v.playsInline = true;
		v.setAttribute('playsinline', '');
		v.setAttribute('aria-hidden', 'true');
		ownedVideo = true;
		if (given) v.srcObject = given as MediaStream;
		else {
			if (!navigator.mediaDevices?.getUserMedia) fail('camera.unavailable', 'navigator.mediaDevices.getUserMedia is unavailable (insecure context or no camera API).');
			const constraints: MediaStreamConstraints = {
				audio: false,
				video: {
					width: { ideal: options.width ?? 1280 },
					height: { ideal: options.height ?? 720 },
					...(options.deviceId ? { deviceId: { exact: options.deviceId } } : {}),
				},
			};
			try {
				ownedStream = await navigator.mediaDevices.getUserMedia(constraints);
			} catch (error) {
				const name = (error as { name?: string })?.name;
				if (name === 'NotAllowedError' || name === 'SecurityError') {
					core.emit('prompt', prompt('camera.denied'));
					fail('camera.denied', 'Camera permission denied.');
				}
				fail('camera.open', `Could not open the camera: ${String((error as Error)?.message ?? error)}`);
			}
			v.srcObject = ownedStream;
		}
		await v.play().catch(() => undefined);
		return v;
	}

	function waitFrames(v: HTMLVideoElement, ms: number): Promise<boolean> {
		return new Promise((resolve) => {
			const t0 = performance.now();
			const check = () => {
				if (disposed) return resolve(false);
				if (v.videoWidth > 0 && v.videoHeight > 0 && v.readyState >= 2) return resolve(true);
				if (performance.now() - t0 > ms) return resolve(false);
				setTimeout(check, 50);
			};
			check();
		});
	}

	/** A LumaFrame over the current canvas contents; the full frame is read once per tick at most. */
	function frameFromCanvas(w: number, h: number): LumaFrame {
		let full: Uint8Array | null = null;
		return {
			width: w,
			height: h,
			read(x, y, rw, rh) {
				const c = ctx as FrameCtx;
				if (x === 0 && y === 0 && rw === w && rh === h) {
					full ??= rgbaToGray(c.getImageData(0, 0, w, h).data, w, h);
					return full;
				}
				return rgbaToGray(c.getImageData(x, y, rw, rh).data, rw, rh);
			},
		};
	}

	function tick() {
		if (!running || !video) return;
		try {
			const v = video;
			const w = v.videoWidth;
			const h = v.videoHeight;
			if (w && h && v.currentTime !== lastVideoTime) {
				lastVideoTime = v.currentTime;
				if (!canvas) {
					canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : document.createElement('canvas');
					ctx = canvas.getContext('2d', { willReadFrequently: true }) as FrameCtx | null;
				}
				if (canvas.width !== w || canvas.height !== h) {
					canvas.width = w;
					canvas.height = h;
				}
				(ctx as FrameCtx).drawImage(v, 0, 0, w, h);
				let ts = performance.now();
				if (ts <= lastTs) ts = lastTs + 0.001; // MediaPipe needs strictly increasing timestamps
				lastTs = ts;
				let hands: HandResult | null = null;
				try {
					hands = landmarker ? landmarker.detectForVideo(v, ts) : null;
				} catch (error) {
					core.emit('error', { code: 'landmarker', message: String(error) });
				}
				core.processFrame(frameFromCanvas(w, h), hands, ts);
			}
		} catch (error) {
			// Never let one bad frame end the loop silently.
			core.emit('error', { code: 'frame', message: String(error) });
		}
		schedule();
	}

	function schedule() {
		if (!running || !video) return;
		const v = video as HTMLVideoElement & {
			requestVideoFrameCallback?: (cb: () => void) => number;
		};
		if (typeof v.requestVideoFrameCallback === 'function') vfcId = v.requestVideoFrameCallback(tick);
		else rafId = requestAnimationFrame(tick);
	}

	function stop() {
		running = false;
		const v = video as (HTMLVideoElement & { cancelVideoFrameCallback?: (id: number) => void }) | null;
		if (vfcId && v?.cancelVideoFrameCallback) v.cancelVideoFrameCallback(vfcId);
		if (rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
		vfcId = 0;
		rafId = 0;
		if (ownedStream) {
			for (const t of ownedStream.getTracks()) t.stop();
			ownedStream = null;
		}
		if (video && ownedVideo) {
			video.pause();
			video.srcObject = null;
			video = null;
			ownedVideo = false;
		}
		starting = null;
	}

	const api: DotPadPointer = {
		start() {
			if (disposed) return Promise.reject(new Error('CamioDotPad: disposed'));
			if (running) return Promise.resolve();
			if (starting) return starting;
			const run = async () => {
				const factory = options.handLandmarker ?? createMediaPipeHandLandmarker;
				if (!options.handLandmarker && (!wasmBase || !modelUrl))
					fail('config', 'assetsBase (or wasmBase + modelUrl) is required for the bundled MediaPipe hand landmarker.');
				const [lm, v] = await Promise.all([
					landmarker ? Promise.resolve(landmarker) : factory({ wasmBase, modelUrl, numHands: 2, delegate: options.delegate ?? 'GPU' }),
					openVideo(),
				]);
				landmarker = lm;
				video = v;
				if (disposed) return stop();
				const ok = await waitFrames(v, options.firstFrameTimeoutMs ?? 6000);
				if (!ok) {
					core.emit('prompt', prompt('camera.noFrames'));
					stop();
					fail('camera.noFrames', 'The camera opened but delivered no frames.');
				}
				running = true;
				schedule();
			};
			const p = run();
			starting = p;
			p.catch(() => {
				if (starting === p) starting = null;
			});
			return p;
		},
		stop,
		dispose() {
			stop();
			disposed = true;
			try {
				landmarker?.close?.();
			} catch {
				// The model may already be gone; nothing else to release.
			}
			landmarker = null;
			canvas = null;
			ctx = null;
			core.reset();
			core.clear();
		},
		autoRegister: () => core.autoRegister(),
		registerByCorners: () => core.registerByCorners(),
		confirmTopLeft: () => core.confirmTopLeft(),
		cancel: () => core.cancel(),
		setFixed: (b) => core.setFixed(b),
		on: (type, listener) => core.on(type, listener),
		off: (type, listener) => core.off(type, listener),
		drawDebug(target, opts) {
			drawDebugOverlay(target, canvas as CanvasImageSource | null, core, opts);
		},
		get status() {
			return core.getStatus();
		},
		get registration() {
			return core.currentRegistration;
		},
		get pose() {
			return core.pose;
		},
		get running() {
			return running;
		},
		get videoElement() {
			return video;
		},
		processFrame: (frame, hands, now) => core.processFrame(frame, hands, now),
		core,
	};
	return api;
}
