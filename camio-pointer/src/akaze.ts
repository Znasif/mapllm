/**
 * The starter's AKAZE tracking step (TactileExplorer.jsx / TactileExplorerGeneric.jsx),
 * ported as an engine over grey buffers, plus the two ways to run it:
 *
 *   - in a Web Worker (default, `akazeThread: 'worker'`): one starter tick is
 *     about 0.4 s of blocking work at 1280 × 720, which on the main thread would
 *     starve MediaPipe and the gesture buffer;
 *   - inline (`akazeThread: 'main'`, the starter verbatim; also the Node tests).
 *
 * Ported verbatim: AKAZE detectAndCompute (live frames unmasked: "RANSAC handles
 * … the hand"), BFMatcher(NORM_HAMMING, false).knnMatch(k = 2), Lowe's ratio
 * test 0.75, findHomography(RANSAC, 8 px) when ≥ 8 good matches, countNonZero
 * of the inlier mask, and every Mat / vector deleted. The acceptance rule
 * (inliers ≥ 8 and ≥ the best, 7 s staleness) lives in `akazeTracker.ts`.
 *
 * Deviations (design §4.3): D1 the reference is masked to the registered quad
 * (the starter's own fillConvexPoly mask mechanism, polarity inverted; 'none'
 * = verbatim); D2 the worker; optional `scale` (default 1 = full resolution).
 * The grey comes from the core's luma (no imread + cvtColor). Each knnMatch
 * pair vector is deleted too (the starter leaked it).
 *
 * `createAkazeEngine` and `akazeWorkerMain` are SELF-CONTAINED (no imports, no
 * module-scope references): they are serialised into the worker with
 * Function.prototype.toString.
 */

import type { CvLike } from './opencv';

/** One match of a live frame against the reference. `H` (row-major 3×3, reference px → frame px) is null without a homography. */
export interface AkazeMatch {
	H: number[] | null;
	good: number;
	inliers: number;
}

/** Engine options. */
export interface AkazeEngineOptions {
	/** Lowe's ratio (starter 0.75). */
	ratio?: number;
	/** RANSAC reprojection threshold in full-resolution px (starter 8). */
	ransacPx?: number;
	/** Detect on a grey resized by this factor (INTER_AREA); 1 = full resolution (starter). */
	scale?: number;
}

/** The asynchronous engine the tracker drives (inline or worker). */
export interface AkazeEngine {
	/** Take the reference from a grey frame; `quad` (TL, TR, BR, BL flattened, px) masks it (D1), null = whole frame. */
	setReference(gray: Uint8Array, width: number, height: number, quad: number[] | null): Promise<{ keypoints: number }>;
	/** Match a grey frame against the reference. The buffer may be transferred (do not reuse it). */
	match(gray: Uint8Array, width: number, height: number): Promise<AkazeMatch>;
	dispose(): void;
}

/** Builds an engine; the tracker forwards its ratio / RANSAC threshold. */
export type AkazeEngineFactory = (opts: AkazeEngineOptions) => Promise<AkazeEngine>;

/** The synchronous engine over a ready `cv` (what runs inside the worker). */
export interface SyncAkazeEngine {
	setReference(gray: Uint8Array, width: number, height: number, quad: number[] | null): { keypoints: number };
	match(gray: Uint8Array, width: number, height: number): AkazeMatch;
	dispose(): void;
}

/**
 * The starter's AKAZE step over a ready OpenCV.js `cv`. SELF-CONTAINED (serialised
 * into the worker): no imports, no for-of / template literals / spread, so a
 * host transpiler cannot inject helpers the worker would lack.
 */
export function createAkazeEngine(cv: CvLike, opts: AkazeEngineOptions): SyncAkazeEngine {
	const ratio = opts && opts.ratio != null ? opts.ratio : 0.75;
	const ransacPx = opts && opts.ransacPx != null ? opts.ransacPx : 8.0;
	const scale = opts && opts.scale ? opts.scale : 1;
	// The starter runs findHomography only with at least 8 good matches.
	const MIN_GOOD = 8;
	const akaze = new cv.AKAZE();
	// HAMMING norm for AKAZE binary descriptors; crossCheck=false needed for knnMatch
	const bf = new cv.BFMatcher(cv.NORM_HAMMING, false);
	let kpTpl: CvLike = null;
	let descTpl: CvLike = null;

	/** Grey buffer → CV_8UC1 Mat (resized when scale ≠ 1). */
	function grayMat(gray: Uint8Array, w: number, h: number) {
		const full = cv.matFromArray(h, w, cv.CV_8UC1, gray);
		if (scale === 1) return full;
		const small = new cv.Mat();
		cv.resize(full, small, new cv.Size(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))), 0, 0, cv.INTER_AREA);
		full.delete();
		return small;
	}

	return {
		setReference(gray, w, h, quad) {
			const g = grayMat(gray, w, h);
			let mask: CvLike;
			if (quad && quad.length === 8) {
				// D1: the starter's mask mechanism (Generic captureReference), polarity inverted:
				// start from 0 and fill the registered quad with 255.
				mask = new cv.Mat(g.rows, g.cols, cv.CV_8UC1, new cv.Scalar(0));
				const pts = cv.matFromArray(
					4,
					1,
					cv.CV_32SC2,
					quad.map((n) => Math.round(n * scale)),
				);
				cv.fillConvexPoly(mask, pts, new cv.Scalar(255));
				pts.delete();
			} else mask = new cv.Mat();
			if (kpTpl) kpTpl.delete();
			if (descTpl) descTpl.delete();
			kpTpl = new cv.KeyPointVector();
			descTpl = new cv.Mat();
			akaze.detectAndCompute(g, mask, kpTpl, descTpl);
			mask.delete();
			g.delete();
			return { keypoints: kpTpl.size() };
		},

		match(gray, w, h) {
			const out: AkazeMatch = { H: null, good: 0, inliers: 0 };
			if (!descTpl || !(descTpl.rows > 0)) return out;
			const frameGray = grayMat(gray, w, h);
			const kpFrame = new cv.KeyPointVector();
			const descFrame = new cv.Mat();
			// Live frames stay unmasked; RANSAC handles the pins and the hand.
			const mask = new cv.Mat();
			akaze.detectAndCompute(frameGray, mask, kpFrame, descFrame);
			mask.delete();
			frameGray.delete();

			if (descFrame.rows >= 4) {
				// kNN (k=2) + Lowe's ratio test — far more discriminative than a fixed distance
				const knn = new cv.DMatchVectorVector();
				bf.knnMatch(descTpl, descFrame, knn, 2);
				const good: Array<{ q: number; t: number }> = [];
				for (let i = 0; i < knn.size(); i++) {
					const pair = knn.get(i);
					if (pair.size() >= 2 && pair.get(0).distance < ratio * pair.get(1).distance) {
						good.push({ q: pair.get(0).queryIdx, t: pair.get(0).trainIdx });
					}
					pair.delete();
				}
				knn.delete();
				out.good = good.length;

				if (good.length >= MIN_GOOD) {
					const srcArr: number[] = [];
					const dstArr: number[] = [];
					for (let i = 0; i < good.length; i++) {
						const m = good[i];
						const p = kpTpl.get(m.q).pt;
						const r = kpFrame.get(m.t).pt;
						srcArr.push(p.x, p.y);
						dstArr.push(r.x, r.y);
					}
					const srcPts = cv.matFromArray(good.length, 1, cv.CV_32FC2, srcArr);
					const dstPts = cv.matFromArray(good.length, 1, cv.CV_32FC2, dstArr);
					const inlierMask = new cv.Mat();
					const Hm = cv.findHomography(srcPts, dstPts, cv.RANSAC, ransacPx * scale, inlierMask);
					const ok = Hm && !Hm.empty();
					out.inliers = ok ? cv.countNonZero(inlierMask) : 0;
					if (ok) {
						const d = Hm.data64F;
						// Back to full-resolution px: S⁻¹ · H · S with S = diag(scale, scale, 1).
						out.H = [d[0], d[1], d[2] / scale, d[3], d[4], d[5] / scale, d[6] * scale, d[7] * scale, d[8]];
					}
					srcPts.delete();
					dstPts.delete();
					inlierMask.delete();
					if (Hm) Hm.delete();
				}
			}
			descFrame.delete();
			kpFrame.delete();
			return out;
		},

		dispose() {
			if (kpTpl) kpTpl.delete();
			if (descTpl) descTpl.delete();
			kpTpl = null;
			descTpl = null;
			akaze.delete();
			bf.delete();
		},
	};
}

/** What the worker loop needs from its global scope (a fake in tests). */
export interface WorkerScopeLike {
	importScripts(url: string): void;
	postMessage(message: unknown, transfer?: Transferable[]): void;
	onmessage: ((e: { data: AkazeWorkerRequest }) => void) | null;
	close?(): void;
	cv?: CvLike;
}

/** Main → worker messages. */
export type AkazeWorkerRequest =
	| { type: 'reference'; id: number; gray: Uint8Array; width: number; height: number; quad: number[] | null }
	| { type: 'match'; id: number; gray: Uint8Array; width: number; height: number }
	| { type: 'dispose'; id?: number };

/** Worker → main messages. */
export type AkazeWorkerResponse =
	| { type: 'ready' }
	| { type: 'reference'; id: number; keypoints: number }
	| ({ type: 'match'; id: number } & AkazeMatch)
	| { type: 'error'; id?: number; message: string };

/**
 * The worker's message loop. SELF-CONTAINED (serialised into the worker):
 * importScripts(OpenCV), the starter's waitForOpenCV (cv.Mat, else
 * onRuntimeInitialized), then 'reference' / 'match' / 'dispose' requests.
 * Requests that arrive before OpenCV is ready are queued.
 */
export function akazeWorkerMain(
	scope: WorkerScopeLike,
	createEngine: (cv: CvLike, opts: AkazeEngineOptions) => SyncAkazeEngine,
	opencvUrl: string,
	opts: AkazeEngineOptions,
): void {
	let engine: SyncAkazeEngine | null = null;
	let failure: string | null = null;
	let queue: AkazeWorkerRequest[] = [];
	const post = (m: AkazeWorkerResponse) => scope.postMessage(m);
	const handle = (m: AkazeWorkerRequest) => {
		try {
			if (m.type === 'dispose') {
				if (engine) engine.dispose();
				engine = null;
				failure = 'disposed';
				if (scope.close) scope.close();
			} else if (!engine) {
				post({ type: 'error', id: m.id, message: failure || 'not ready' });
			} else if (m.type === 'reference') {
				const r = engine.setReference(m.gray, m.width, m.height, m.quad);
				post({ type: 'reference', id: m.id, keypoints: r.keypoints });
			} else if (m.type === 'match') {
				const r = engine.match(m.gray, m.width, m.height);
				post({ type: 'match', id: m.id, H: r.H, good: r.good, inliers: r.inliers });
			}
		} catch (e) {
			post({ type: 'error', id: m.id, message: String((e && (e as Error).message) || e) });
		}
	};
	const fail = (message: string) => {
		failure = message;
		post({ type: 'error', message });
		const q = queue;
		queue = [];
		for (let i = 0; i < q.length; i++) handle(q[i]);
	};
	const ready = () => {
		try {
			engine = createEngine(scope.cv, opts);
		} catch (e) {
			fail('AKAZE init failed: ' + String((e && (e as Error).message) || e));
			return;
		}
		post({ type: 'ready' });
		const q = queue;
		queue = [];
		for (let i = 0; i < q.length; i++) handle(q[i]);
	};
	scope.onmessage = (e) => {
		const m = e.data;
		if (!engine && !failure && m.type !== 'dispose') queue.push(m);
		else handle(m);
	};
	try {
		scope.importScripts(opencvUrl);
	} catch (e) {
		fail('could not load ' + opencvUrl + ': ' + String((e && (e as Error).message) || e));
		return;
	}
	const cv = scope.cv;
	if (!cv) {
		fail(opencvUrl + ' did not define cv');
		return;
	}
	if (cv.Mat) ready();
	else cv.onRuntimeInitialized = ready;
}

/** The worker's whole source: both self-contained functions plus the call. */
export function akazeWorkerSource(opencvUrl: string, opts: AkazeEngineOptions): string {
	return `"use strict";
var createAkazeEngine = (${createAkazeEngine.toString()});
var akazeWorkerMain = (${akazeWorkerMain.toString()});
akazeWorkerMain(self, createAkazeEngine, ${JSON.stringify(opencvUrl)}, ${JSON.stringify(opts)});
`;
}

/** Wrap a synchronous engine in the async interface. */
function asyncEngine(e: SyncAkazeEngine): AkazeEngine {
	return {
		setReference: (gray, w, h, quad) => {
			try {
				return Promise.resolve(e.setReference(gray, w, h, quad));
			} catch (error) {
				return Promise.reject(error);
			}
		},
		match: (gray, w, h) => {
			try {
				return Promise.resolve(e.match(gray, w, h));
			} catch (error) {
				return Promise.reject(error);
			}
		},
		dispose: () => e.dispose(),
	};
}

/**
 * The starter verbatim: AKAZE on the calling thread. `loadCv` resolves `{ cv }`
 * once the runtime is ready (e.g. loadOpenCvScript, or require + waitForOpenCV in Node).
 */
export function createInlineAkazeEngine(loadCv: () => Promise<{ cv: CvLike }>, opts: AkazeEngineOptions = {}): Promise<AkazeEngine> {
	return loadCv().then(({ cv }) => asyncEngine(createAkazeEngine(cv, opts)));
}

/** Construct a Worker from source (injectable for tests). */
export type WorkerConstructor = (source: string) => Worker;

const blobWorker: WorkerConstructor = (source) => {
	const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
	const w = new Worker(url);
	// Revoke once the worker has surely fetched its script.
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
	return w;
};

/**
 * D2: the same engine in a Blob Web Worker. `opencvUrl` is made absolute
 * against the page (the worker's own URL is a blob:). Resolves once OpenCV is
 * ready in the worker; rejects if it cannot load. Grey buffers are transferred.
 */
export function createAkazeWorkerEngine(opencvUrl: string, opts: AkazeEngineOptions = {}, makeWorker: WorkerConstructor = blobWorker): Promise<AkazeEngine> {
	const abs = typeof location !== 'undefined' ? new URL(opencvUrl, location.href).href : opencvUrl;
	return new Promise<AkazeEngine>((resolve, reject) => {
		let worker: Worker;
		try {
			worker = makeWorker(akazeWorkerSource(abs, opts));
		} catch (error) {
			reject(error);
			return;
		}
		let seq = 0;
		let ready = false;
		let dead: string | null = null;
		const waiting = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>();
		const failAll = (message: string) => {
			dead ??= message;
			for (const w of waiting.values()) w.reject(new Error(message));
			waiting.clear();
		};
		worker.onmessage = (e: MessageEvent<AkazeWorkerResponse>) => {
			const m = e.data;
			if (m.type === 'ready') {
				ready = true;
				resolve(engine);
				return;
			}
			if (m.type === 'error' && m.id == null) {
				failAll(m.message);
				if (!ready) {
					worker.terminate();
					reject(new Error(m.message));
				}
				return;
			}
			const id = (m as { id: number }).id;
			const w = waiting.get(id);
			if (!w) return;
			waiting.delete(id);
			if (m.type === 'error') w.reject(new Error(m.message));
			else if (m.type === 'reference') w.resolve({ keypoints: m.keypoints } as never);
			else if (m.type === 'match') w.resolve({ H: m.H, good: m.good, inliers: m.inliers } as never);
		};
		worker.onerror = (e: ErrorEvent) => {
			const message = `AKAZE worker error: ${e?.message ?? 'unknown'}`;
			failAll(message);
			if (!ready) {
				worker.terminate();
				reject(new Error(message));
			}
		};
		const request = <T>(msg: AkazeWorkerRequest, transfer: Transferable[]): Promise<T> => {
			if (dead) return Promise.reject(new Error(dead));
			return new Promise<T>((res, rej) => {
				waiting.set((msg as { id: number }).id, { resolve: res as (v: never) => void, reject: rej });
				worker.postMessage(msg, transfer);
			});
		};
		const engine: AkazeEngine = {
			setReference: (gray, width, height, quad) => request({ type: 'reference', id: ++seq, gray, width, height, quad }, [gray.buffer]),
			match: (gray, width, height) => request({ type: 'match', id: ++seq, gray, width, height }, [gray.buffer]),
			dispose() {
				if (dead === 'disposed') return;
				try {
					worker.postMessage({ type: 'dispose' });
				} catch {
					// The worker may already be gone.
				}
				worker.terminate();
				failAll('disposed');
			},
		};
	});
}
