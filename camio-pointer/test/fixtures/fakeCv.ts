/**
 * A fake OpenCV.js `cv` for the worker-protocol tests: just the calls the
 * AKAZE engine makes, with every allocated Mat / vector recorded so a test can
 * assert that each one is deleted. Matching is scripted: the reference gets
 * `refKeypoints` keypoints, a frame `frameKeypoints`, knnMatch returns `good`
 * pairs that pass the ratio test (plus `bad` that fail it), and findHomography
 * returns `H` with `inliers` non-zero mask entries.
 */
export interface FakeCvScript {
	refKeypoints: number;
	frameKeypoints: number;
	good: number;
	bad: number;
	inliers: number;
	H: number[];
}

export function createFakeCv(script: Partial<FakeCvScript> = {}, { ready = true } = {}) {
	const s: FakeCvScript = { refKeypoints: 50, frameKeypoints: 60, good: 20, bad: 5, inliers: 15, H: [1, 0, 3, 0, 1, -2, 0, 0, 1], ...script };
	const live = new Set<object>();
	const log: string[] = [];
	let allocated = 0;
	const track = <T extends object>(o: T, name: string): T & { delete(): void } => {
		allocated++;
		live.add(o);
		const t = o as T & { delete(): void; deleted?: boolean };
		t.delete = () => {
			if (t.deleted) throw new Error(`double delete of ${name}`);
			t.deleted = true;
			live.delete(o);
		};
		(t as unknown as { name: string }).name = name;
		return t;
	};

	class Mat {
		rows = 0;
		cols = 0;
		data64F: Float64Array = new Float64Array(0);
		filled: number | null = null;
		constructor(rows?: number, cols?: number, _type?: number, scalar?: { v: number }) {
			this.rows = rows ?? 0;
			this.cols = cols ?? 0;
			if (scalar) this.filled = scalar.v;
			track(this, 'Mat');
		}
		empty() {
			return this.rows === 0;
		}
		delete() {}
	}
	class KeyPointVector {
		n = 0;
		constructor() {
			track(this, 'KeyPointVector');
		}
		size() {
			return this.n;
		}
		get(i: number) {
			return { pt: { x: i, y: 2 * i } };
		}
		delete() {}
	}
	class DMatchVector {
		items: Array<{ distance: number; queryIdx: number; trainIdx: number }> = [];
		constructor() {
			track(this, 'DMatchVector');
		}
		size() {
			return this.items.length;
		}
		get(i: number) {
			return this.items[i];
		}
		delete() {}
	}
	type DMatch = { distance: number; queryIdx: number; trainIdx: number };
	class DMatchVectorVector {
		/** Inner storage (freed with the outer vector, as in embind). */
		items: DMatch[][] = [];
		constructor() {
			track(this, 'DMatchVectorVector');
		}
		size() {
			return this.items.length;
		}
		/** Like embind: a fresh copy the caller must delete. */
		get(i: number) {
			const c = new DMatchVector();
			c.items = this.items[i].slice();
			return c;
		}
		delete() {}
	}
	let refDone = false;
	class AKAZE {
		constructor() {
			track(this, 'AKAZE');
		}
		detectAndCompute(img: Mat, mask: Mat, kp: KeyPointVector, desc: Mat) {
			log.push(`detect ${img.cols}x${img.rows} mask ${mask.rows > 0 ? `${mask.cols}x${mask.rows} fill ${mask.filled}` : 'none'}`);
			kp.n = refDone ? s.frameKeypoints : s.refKeypoints;
			desc.rows = kp.n;
			refDone = true;
		}
		delete() {}
	}
	class BFMatcher {
		constructor(_norm: number, _cross: boolean) {
			track(this, 'BFMatcher');
		}
		knnMatch(_q: Mat, _t: Mat, out: DMatchVectorVector, _k: number) {
			for (let i = 0; i < s.good + s.bad; i++) {
				const pass = i < s.good;
				out.items.push([
					{ distance: pass ? 10 : 30, queryIdx: i, trainIdx: i },
					{ distance: 32, queryIdx: i, trainIdx: i + 1 },
				]);
			}
		}
		delete() {}
	}
	const cv = {
		CV_8UC1: 0,
		CV_32SC2: 12,
		CV_32FC2: 13,
		CV_64F: 6,
		NORM_HAMMING: 6,
		RANSAC: 8,
		INTER_AREA: 3,
		Mat: ready ? Mat : undefined,
		KeyPointVector,
		DMatchVectorVector,
		AKAZE,
		BFMatcher,
		Scalar: class {
			v: number;
			constructor(v: number) {
				this.v = v;
			}
		},
		Size: class {
			constructor(
				public width: number,
				public height: number,
			) {}
		},
		onRuntimeInitialized: undefined as undefined | (() => void),
		matFromArray(rows: number, cols: number, _type: number, arr: ArrayLike<number>) {
			log.push(`matFromArray ${rows}x${cols} (${arr.length})`);
			return new Mat(rows, cols);
		},
		fillConvexPoly(mask: Mat, _pts: Mat, scalar: { v: number }) {
			log.push(`fillConvexPoly ${scalar.v} on ${mask.filled}`);
		},
		resize(_src: Mat, dst: Mat, size: { width: number; height: number }) {
			dst.cols = size.width;
			dst.rows = size.height;
		},
		findHomography(_src: Mat, _dst: Mat, method: number, thr: number, mask: Mat) {
			log.push(`findHomography ${method} ${thr}`);
			mask.rows = s.good;
			mask.cols = 1;
			const H = new Mat(3, 3);
			H.data64F = Float64Array.from(s.H);
			return H;
		},
		countNonZero(_m: Mat) {
			return s.inliers;
		},
		/** Finish "loading" (when created with ready: false). */
		finishLoading() {
			(cv as { Mat: unknown }).Mat = Mat;
			cv.onRuntimeInitialized?.();
		},
	};
	return { cv, live, log, script: s, allocated: () => allocated };
}
