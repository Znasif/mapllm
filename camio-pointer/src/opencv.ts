/**
 * OpenCV.js loading (browser main thread, like `mediapipe.ts`). Only the rect
 * surface's AKAZE tracker in `akazeThread: 'main'` mode uses this; the default
 * Web Worker loads OpenCV itself with importScripts. OpenCV.js is NOT bundled:
 * the host self-hosts `@techstark/opencv-js@OPENCV_VERSION` `dist/opencv.js`
 * (WASM inline) and passes its URL as `opencvUrl`.
 *
 * NEVER `await cv` or resolve a promise with it: the Emscripten Module object
 * has a `then` method that never settles (verified in Node: `await` hangs).
 * Readiness is the starter's `waitForOpenCV()` check — `cv.Mat` exists, else
 * wait for `cv.onRuntimeInitialized` — and the loader resolves `{ cv }`.
 */

/** The OpenCV.js build the AKAZE port was measured with; self-host this one. */
export const OPENCV_VERSION = '4.12.0-release.1';

/** The OpenCV.js module (untyped: only the calls in `akaze.ts` are used). */
// biome-ignore lint/suspicious/noExplicitAny: the OpenCV.js API is untyped here
export type CvLike = any;

/** Starter `waitForOpenCV()`: resolves once `cv.Mat` exists. Resolves void, never `cv` (see above). */
export function waitForOpenCV(cv: CvLike): Promise<void> {
	return new Promise<void>((resolve) => {
		if (cv.Mat) {
			resolve();
			return;
		}
		cv.onRuntimeInitialized = () => resolve();
	});
}

let loading: Promise<{ cv: CvLike }> | null = null;

/**
 * Inject `<script src=url>` once and wait for the runtime. Rejects when the
 * script fails to load, or when it loads but does not define `window.cv` (the
 * UMD wrapper meets an AMD `define` on the page).
 */
export function loadOpenCvScript(url: string): Promise<{ cv: CvLike }> {
	const g = globalThis as { cv?: CvLike };
	if (g.cv) {
		const cv = g.cv;
		return waitForOpenCV(cv).then(() => ({ cv }));
	}
	if (loading) return loading;
	const p = new Promise<{ cv: CvLike }>((resolve, reject) => {
		const s = document.createElement('script');
		s.src = url;
		s.async = true;
		s.onload = () => {
			const cv = g.cv;
			if (!cv) {
				reject(new Error(`${url} loaded but did not define window.cv (an AMD loader on the page?)`));
				return;
			}
			waitForOpenCV(cv).then(() => resolve({ cv }));
		};
		s.onerror = () => reject(new Error(`could not load ${url}`));
		document.head.appendChild(s);
	});
	loading = p;
	p.catch(() => {
		if (loading === p) loading = null;
	});
	return p;
}
