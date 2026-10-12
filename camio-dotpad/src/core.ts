/**
 * The pointer's state machine, framework-free and DOM-free: frames and hand
 * landmarks in, events out. The browser shell (`pointer.ts`) feeds it from a
 * camera and MediaPipe; tests feed it synthetic frames and fake landmarks.
 *
 * Phases (re-implemented from the starter's TactileExplorerGeneric.jsx):
 *   idle      — no registration (or a registration attempt failed).
 *   corners   — dwell on TL → TR → BR → BL corner pins (createCornerCapture),
 *               then checkPinQuad.
 *   autoFind  — hands-off wait, then the multi-frame lattice scan (one
 *               latticeSearch step per frame, aggregateDetections).
 *   confirm   — the scan could not tell which way up the pad is: one dwell on
 *               the top-left pin (resolveConfirmTouch), or confirmTopLeft().
 *   handsOff  — a registration is waiting for a hands-off frame.
 *   ready     — tracking (lattice-follow tracker) + drift watchdog; the
 *               pointing fingertip is mapped to a pin and emitted on change.
 */

import { Emitter } from './emitter';
import {
	type Mat3,
	type Point,
	applyH,
	checkPinQuad,
	cornersOfPose,
	invert3,
	maxCornerDist,
	pitchFromCorners,
	poseFromCorners,
	resolveConfirmTouch,
} from './geometry';
import {
	type HandResult,
	type Landmark,
	INDEX_TIP,
	createCornerCapture,
	createPinQuantizer,
	createPointingTracker,
	createSendGate,
	makeOneEuroFilter,
} from './input';
import { aggregateDetections, latticeSearch, type LatticeDetection } from './lattice';
import { CORNER_PROMPT_CODES, type PromptCode, type PromptEvent, prompt } from './prompts';
import {
	type LumaFrame,
	type TrackState,
	type TrackStep,
	type Tracker,
	convexHull,
	createLatticeTracker,
} from './tracker';
import { WATCHDOG_HANDS_OFF_MS, createDriftWatchdog, watchdogDue } from './watchdog';

export type Phase = 'idle' | 'corners' | 'autoFind' | 'confirm' | 'handsOff' | 'ready';

/**
 * How the registered pose is being kept up to date.
 *  - tracking: the pins were seen this frame and the pose follows them;
 *  - occluded: a hand hides too much this frame; the last pose is used;
 *  - static:   the pins are not visible (blank/sparse map, glare): the pose is
 *              the registered one and only the watchdog can notice a move;
 *  - lost:     the camera contradicts the pose; NO pins are emitted until it is
 *              re-found (relock, full search when hands are off, or re-register);
 *  - fixed:    frozen by setFixed(true);
 *  - none:     not registered.
 */
export type TrackingStatus = 'none' | 'tracking' | 'occluded' | 'static' | 'lost' | 'fixed';

export interface Registration {
	/** TL, TR, BR, BL corner-pin centres in camera px. TL is the pad's top-left with the braille line below. */
	corners: Point[];
	/** Pin (c, r) → camera px. */
	pose: Mat3;
	pitchPx: number;
	method: 'auto' | 'corners' | 'watchdog' | 'tracker';
	/** Orientation settled by the braille text line (auto only). */
	textFound: boolean | null;
	frame: { width: number; height: number };
}

/** Payload of the 'pin' event: the pin under the pointing fingertip. */
export interface PinEvent {
	/** Column 0…cols−1, left → right. */
	x: number;
	/** Row 0…rows−1, top → bottom (braille line below the bottom row). */
	y: number;
	/** In the `border`-pin band along the edges (Audiom pages its viewport there). */
	inBorder: boolean;
	/** Fractional pin coordinates before quantisation. */
	fx: number;
	fy: number;
}

export interface PointerStatus {
	phase: Phase;
	tracking: TrackingStatus;
	registered: boolean;
	fixed: boolean;
	handsInView: number;
	pointing: boolean;
	/** Corners locked so far in the corners phase (0–4). */
	cornersLocked: number;
	/** Short English description (debug / sighted helper). */
	message: string;
}

export interface CoreEvents {
	pin: PinEvent;
	/** The fingertip left the pad, stopped pointing, or pins became unusable. */
	leave: { reason: 'off-pad' | 'not-pointing' | 'unusable' | 'reset' };
	prompt: PromptEvent;
	status: PointerStatus;
	registration: Registration;
	/** The tracker lost the pad (pins are suppressed until it is re-found). */
	lost: { reason: string };
	/** The pad was found somewhere else and the registration followed it. */
	moved: { via: 'watchdog' | 'tracker'; pins: number };
	/** Earcon cue for the host: a corner locked, a confirm, a rejection. */
	cue: { code: 'lock' | 'reject' };
	error: { code: string; message: string };
}

export interface CoreOptions {
	cols: number;
	rows: number;
	/** Pins along each edge reported as `inBorder` (Audiom's overlapPins = 2). */
	border: number;
	/**
	 * Pin quantizer hysteresis (pins beyond the half-pin boundary). Sized to the
	 * finger, not the pin: a fingertip covers about 4 × 4 pins, so the default
	 * 1.5 holds a pin until the estimate is > 2 pins away on an axis — a resting
	 * finger emits nothing, a moving one roughly every 2 pins.
	 */
	hysteresis: number;
	/** Minimum time between two 'pin' events (ms); 0 = every change. */
	minIntervalMs: number;
	/** A pin must be held this long before it is emitted (ms). */
	dwellMs: number;
	/** Shift the fingertip along the finger, in pins (negative = toward the knuckle). */
	tipOffsetPins: number;
	/** Corner dwell: hold time (ms) and radius (px at 1280 wide; scaled with the frame). */
	cornerDwellMs: number;
	cornerDwellPx: number;
	/** Plug in another tracker; default: the lattice-follow tracker. */
	tracker: Tracker | null;
	/** Run the tracker every N frames (1 = every frame). */
	trackEvery: number;
}

export const CORE_DEFAULTS: Readonly<CoreOptions> = Object.freeze({
	cols: 60,
	rows: 40,
	border: 2,
	hysteresis: 1.5,
	minIntervalMs: 0,
	dwellMs: 0,
	tipOffsetPins: 0,
	cornerDwellMs: 1500,
	cornerDwellPx: 45,
	tracker: null,
	trackEvery: 1,
});

/* Hands-off windows: how long MediaPipe must see no hand, and the most we wait. */
const REF_HANDS_OFF_MS = 400;
const REF_HANDS_OFF_MAX_MS = 4000;
const FIND_HANDS_OFF_MS = 500;
const FIND_HANDS_OFF_MAX_MS = 8000;
/* Lattice scan budget. */
const FIND_FRAMES = 5;
const FIND_MAX_ATTEMPTS = 10;
const FIND_MAX_MS = 6000;
const FIND_GIVE_UP = 3;
/* Tracking notices. */
const LOST_PROMPT_AFTER_MS = 1500;
const LOST_PROMPT_COOLDOWN_MS = 8000;
const STATIC_AFTER_MS = 2000;
/* Watchdog interval while the tracker sees the pins (it is then a second opinion). */
const WATCHDOG_HEALTHY_INTERVAL_MS = 5000;

type HandsOff = { startedAt: number; zeroSince: number | null; minMs: number; maxMs: number; then: 'reference' | 'find' };

/** The pointer core. */
export class PointerCore extends Emitter<CoreEvents> {
	readonly options: CoreOptions;
	readonly tracker: Tracker;

	private phase: Phase = 'idle';
	private registration: Registration | null = null;
	private previous: Registration | null = null;
	private pending: { corners: Point[]; method: Registration['method']; textFound: boolean | null } | null = null;
	private handsOff: HandsOff | null = null;
	private scan: {
		startedAt: number;
		attempts: number;
		results: LatticeDetection[];
		pitchHint: number | null;
		search: Generator<void, LatticeDetection | null, void> | null;
	} | null = null;
	private capture;
	private confirm;
	private fixed = false;
	private autoResolve: ((r: Registration | null) => void) | null = null;

	private readonly dog = createDriftWatchdog();
	private wd: {
		zeroSince: number | null;
		lastCheckAt: number | null;
		search: Generator<void, LatticeDetection | null, void> | null;
		tracked: Point[] | null;
		pitchPx: number | null;
	} = { zeroSince: null, lastCheckAt: null, search: null, tracked: null, pitchPx: null };

	private trackState: TrackState = 'idle';
	private lastStep: TrackStep | null = null;
	private lostSince: number | null = null;
	private lostPromptAt = Number.NEGATIVE_INFINITY;
	private lostPrompted = false;
	private blankSince: number | null = null;
	private staticPrompted = false;
	private frameCount = 0;

	private pointing = createPointingTracker();
	private oefX = makeOneEuroFilter();
	private oefY = makeOneEuroFilter();
	private wasPointing = false;
	private tooMany = false;
	private quant;
	private gate;
	private lastPin: PinEvent | null = null;
	private poseInv: { pose: Mat3; inv: Mat3 } | null = null;

	/** Debug/overlay state (read by drawDebug). */
	readonly view = {
		tip: null as Point | null,
		hands: [] as Point[][],
		frame: { width: 0, height: 0 },
	};

	private lastStatusKey = '';
	private status: PointerStatus;

	constructor(options: Partial<CoreOptions> = {}) {
		super();
		this.options = { ...CORE_DEFAULTS, ...options };
		const { cols, rows } = this.options;
		this.tracker = this.options.tracker ?? createLatticeTracker({ cols, rows });
		this.capture = createCornerCapture({ dwellMs: this.options.cornerDwellMs, dwellR: this.options.cornerDwellPx });
		this.confirm = createCornerCapture({ dwellMs: this.options.cornerDwellMs, dwellR: this.options.cornerDwellPx });
		this.quant = createPinQuantizer({ cols, rows, hysteresis: this.options.hysteresis });
		this.gate = createSendGate({ minIntervalMs: this.options.minIntervalMs, dwellMs: this.options.dwellMs });
		this.status = this.computeStatus(0, false);
	}

	/* ------------------------------------------------------- public API -- */

	get currentPhase(): Phase {
		return this.phase;
	}
	get currentRegistration(): Registration | null {
		return this.registration;
	}
	/** The pose in use right now (tracked), or null. */
	get pose(): Mat3 | null {
		if (!this.registration) return null;
		return this.tracker.pose ?? this.registration.pose;
	}
	get pendingCorners(): Point[] | null {
		if (this.phase === 'corners') return this.capture.corners;
		return this.pending?.corners ?? this.scan?.results.at(-1)?.pinCorners ?? null;
	}
	get lastTrackStep(): TrackStep | null {
		return this.lastStep;
	}
	getStatus(): PointerStatus {
		return this.status;
	}

	/** Start the four-corner dwell registration. */
	registerByCorners(): void {
		this.beginFlow();
		this.capture.reset();
		this.phase = 'corners';
		this.say(CORNER_PROMPT_CODES[0]);
		this.pushStatus();
	}

	/** Start auto-registration; resolves with the registration, or null (not found / cancelled). */
	autoRegister(): Promise<Registration | null> {
		this.beginFlow();
		const p = new Promise<Registration | null>((resolve) => {
			this.autoResolve = resolve;
		});
		this.handsOff = { startedAt: Number.NaN, zeroSince: null, minMs: FIND_HANDS_OFF_MS, maxMs: FIND_HANDS_OFF_MAX_MS, then: 'find' };
		this.phase = 'autoFind';
		this.say('register.handsOff');
		this.pushStatus();
		return p;
	}

	/** In the confirm phase: accept the detected orientation without the touch. */
	confirmTopLeft(): void {
		if (this.phase !== 'confirm' || !this.pending) return;
		this.beginHandsOff(this.pending.corners, this.pending.method, this.pending.textFound, Number.NaN);
	}

	/** Abort a registration flow; the previous registration (if any) is restored. */
	cancel(): void {
		if (this.phase === 'ready' || this.phase === 'idle') return;
		this.resolveAuto(null);
		this.scan = null;
		this.handsOff = null;
		this.pending = null;
		if (this.previous) {
			this.registration = this.previous;
			this.tracker.reset(this.previous.pose);
			this.phase = 'ready';
		} else this.phase = 'idle';
		this.previous = null;
		this.say('register.cancelled');
		this.pushStatus();
	}

	/** Freeze (true) or release the pose. The watchdog keeps running. */
	setFixed(fixed: boolean): void {
		this.fixed = !!fixed;
		this.pushStatus();
	}

	/** Use an externally known registration (e.g. restored from storage). */
	setRegistration(corners: Point[], frame: { width: number; height: number }): Registration {
		const reg = this.makeRegistration(corners, 'corners', null, frame);
		this.registration = reg;
		this.tracker.reset(reg.pose);
		this.phase = 'ready';
		this.emit('registration', reg);
		this.pushStatus();
		return reg;
	}

	/** Forget everything (no registration). */
	reset(): void {
		this.resolveAuto(null);
		this.phase = 'idle';
		this.registration = null;
		this.previous = null;
		this.pending = null;
		this.scan = null;
		this.handsOff = null;
		this.tracker.clear();
		this.dog.reset();
		this.releasePin('reset');
		this.pushStatus();
	}

	/* -------------------------------------------------------- per frame -- */

	/**
	 * Advance one camera frame. `hands` is a MediaPipe HandLandmarker result
	 * (normalised landmarks) for the same frame, or null.
	 */
	processFrame(frame: LumaFrame, hands: HandResult | null, now: number): void {
		this.frameCount++;
		const { width: W, height: H } = frame;
		this.view.frame = { width: W, height: H };
		const handLms = hands?.landmarks ?? [];
		const handCount = handLms.length;
		this.view.hands = handLms.map((lm) => lm.map((p) => [p.x * W, p.y * H] as Point));
		const hints = {
			occluders: this.view.hands.length ? this.view.hands.map((h) => convexHull(h)) : undefined,
			handsPresent: handCount > 0,
			now,
		};

		// Pointing gate + smoothing.
		const g = this.pointing.update(hands, now);
		let tip: Point | null = null;
		if (g.pointing && g.tip && g.pointingHandLandmarks) {
			if (!this.wasPointing) {
				this.oefX = makeOneEuroFilter();
				this.oefY = makeOneEuroFilter();
			}
			const raw = this.tipPx(g.pointingHandLandmarks, W, H);
			tip = [this.oefX(raw[0], now), this.oefY(raw[1], now)];
		}
		this.wasPointing = g.pointing;
		this.view.tip = tip;
		if (g.tooManyHandsPointing !== this.tooMany) {
			this.tooMany = g.tooManyHandsPointing;
			if (this.tooMany) this.say('pointing.oneHand');
		}

		switch (this.phase) {
			case 'corners':
				this.stepCorners(tip, now);
				this.releasePin('unusable');
				break;
			case 'autoFind':
			case 'handsOff':
				if (this.scan) this.stepScan(frame, handCount, now);
				else if (this.handsOffElapsed(handCount, now)) {
					if (this.handsOff?.then === 'find') this.beginScan(now);
					else this.finishRegistration(frame, hints);
				}
				this.releasePin('unusable');
				break;
			case 'confirm':
				this.stepConfirm(tip, now);
				this.releasePin('unusable');
				break;
			case 'ready':
				this.stepTracking(frame, hints, now);
				this.stepWatchdog(frame, handCount, now);
				this.stepPin(tip, now);
				break;
			default:
				this.releasePin('unusable');
		}
		this.pushStatus(handCount, g.pointing);
	}

	/* --------------------------------------------------------- internals -- */

	private tipPx(lm: Landmark[], W: number, H: number): Point {
		const t = lm[INDEX_TIP];
		let x = t.x * W;
		let y = t.y * H;
		const k = this.options.tipOffsetPins;
		const pose = this.pose;
		if (k && pose && lm[7]) {
			const dx = x - lm[7].x * W;
			const dy = y - lm[7].y * H;
			const len = Math.hypot(dx, dy) || 1;
			const pitch = this.registration?.pitchPx ?? 0;
			x += (dx / len) * k * pitch;
			y += (dy / len) * k * pitch;
		}
		return [x, y];
	}

	private say(code: PromptCode, params?: Record<string, string | number>) {
		this.emit('prompt', prompt(code, params));
	}

	private resolveAuto(r: Registration | null) {
		const f = this.autoResolve;
		this.autoResolve = null;
		f?.(r);
	}

	/** Start a registration flow: remember the current registration for cancel(). */
	private beginFlow() {
		this.resolveAuto(null);
		if (this.registration) this.previous = this.registration;
		this.registration = null;
		this.pending = null;
		this.scan = null;
		this.handsOff = null;
		this.tracker.clear();
		this.dog.reset();
		this.wd = { zeroSince: null, lastCheckAt: null, search: null, tracked: null, pitchPx: this.wd.pitchPx };
		this.releasePin('reset');
	}

	private handsOffElapsed(handCount: number, now: number): boolean {
		const h = this.handsOff;
		if (!h) return true;
		if (Number.isNaN(h.startedAt)) h.startedAt = now;
		if (handCount === 0) h.zeroSince ??= now;
		else h.zeroSince = null;
		return (h.zeroSince !== null && now - h.zeroSince >= h.minMs) || now - h.startedAt >= h.maxMs;
	}

	private beginHandsOff(corners: Point[], method: Registration['method'], textFound: boolean | null, now: number) {
		this.pending = { corners: corners.map((p) => [p[0], p[1]] as Point), method, textFound };
		this.handsOff = { startedAt: now, zeroSince: null, minMs: REF_HANDS_OFF_MS, maxMs: REF_HANDS_OFF_MAX_MS, then: 'reference' };
		this.phase = 'handsOff';
		this.pushStatus();
	}

	private makeRegistration(
		corners: Point[],
		method: Registration['method'],
		textFound: boolean | null,
		frame: { width: number; height: number },
		pose?: Mat3,
	): Registration {
		const { cols, rows } = this.options;
		const H = pose ?? poseFromCorners(corners, cols, rows);
		const c = pose ? cornersOfPose(pose, cols, rows) : corners.map((p) => [p[0], p[1]] as Point);
		return { corners: c, pose: H, pitchPx: pitchFromCorners(c, cols, rows), method, textFound, frame: { ...frame } };
	}

	private finishRegistration(frame: LumaFrame, hints: { occluders?: Point[][]; handsPresent: boolean }) {
		const p = this.pending;
		this.handsOff = null;
		if (!p) {
			this.phase = this.registration ? 'ready' : 'idle';
			return;
		}
		const size = { width: frame.width, height: frame.height };
		let reg = this.makeRegistration(p.corners, p.method, p.textFound, size);
		// Snap to the lattice the camera actually sees (touched corners can be a pin off).
		const step = this.tracker.reset(reg.pose, frame, hints);
		this.noteStep(step, 0);
		if (step.accepted && step.pose) reg = this.makeRegistration(p.corners, p.method, p.textFound, size, step.pose);
		this.registration = reg;
		this.previous = null;
		this.pending = null;
		this.phase = 'ready';
		this.dog.reset();
		this.wd = { zeroSince: null, lastCheckAt: null, search: null, tracked: null, pitchPx: reg.pitchPx };
		this.lostSince = null;
		this.lostPrompted = false;
		this.blankSince = null;
		this.staticPrompted = false;
		this.emit('registration', reg);
		this.say('register.done');
		this.resolveAuto(reg);
		this.pushStatus();
	}

	private stepCorners(tip: Point | null, now: number) {
		const r = (this.options.cornerDwellPx * (this.view.frame.width || 1280)) / 1280;
		this.capture.setRadius(r);
		const cap = this.capture.update(tip ? tip[0] : null, tip ? tip[1] : null, now);
		if (!cap.locked) return;
		this.emit('cue', { code: 'lock' });
		if (!cap.complete) {
			this.say(CORNER_PROMPT_CODES[cap.index]);
			return;
		}
		const check = checkPinQuad(cap.corners);
		if (!check.ok) {
			this.capture.reset();
			this.emit('cue', { code: 'reject' });
			this.say('register.cornersRejected', { reason: check.reason ?? '' });
			this.say(CORNER_PROMPT_CODES[0]);
			return;
		}
		this.say('register.liftHand');
		this.beginHandsOff(cap.corners, 'corners', null, now);
	}

	private stepConfirm(tip: Point | null, now: number) {
		const r = (this.options.cornerDwellPx * (this.view.frame.width || 1280)) / 1280;
		this.confirm.setRadius(r);
		const cap = this.confirm.update(tip ? tip[0] : null, tip ? tip[1] : null, now);
		if (!cap.locked || !this.pending) return;
		this.emit('cue', { code: 'lock' });
		const resolved = resolveConfirmTouch(this.pending.corners, cap.corners[0], this.options);
		if (!resolved) {
			this.say('register.confirmMissed');
			this.resolveAuto(null);
			this.registerByCorners();
			return;
		}
		this.say('register.liftHand');
		this.beginHandsOff(resolved, 'auto', false, now);
	}

	private beginScan(now: number) {
		this.handsOff = null;
		this.scan = { startedAt: now, attempts: 0, results: [], pitchHint: this.wd.pitchPx, search: null };
		this.say('register.searching');
	}

	private stepScan(frame: LumaFrame, handCount: number, now: number) {
		const f = this.scan;
		if (!f) return;
		if (!f.search && handCount === 0) {
			const data = frame.read(0, 0, frame.width, frame.height);
			f.search = latticeSearch({ data, width: frame.width, height: frame.height }, { pitchHint: f.pitchHint });
		} else if (f.search) {
			let st: IteratorResult<void, LatticeDetection | null>;
			try {
				st = f.search.next();
			} catch (e) {
				this.emit('error', { code: 'lattice', message: String(e) });
				st = { done: true, value: null };
			}
			if (st.done) {
				f.search = null;
				f.attempts += 1;
				if (st.value) {
					f.results.push(st.value);
					f.pitchHint = st.value.pitchPx;
				}
			}
		}
		const done =
			!f.search &&
			(f.results.length >= FIND_FRAMES ||
				f.attempts >= FIND_MAX_ATTEMPTS ||
				now - f.startedAt >= FIND_MAX_MS ||
				(f.attempts >= FIND_GIVE_UP && f.results.length === 0));
		if (!done) return;
		this.scan = null;
		const agg = aggregateDetections(f.results);
		if (!agg) {
			this.say('register.notFound');
			this.resolveAuto(null);
			if (this.previous) {
				this.registration = this.previous;
				this.tracker.reset(this.previous.pose);
				this.phase = 'ready';
			} else this.phase = 'idle';
			this.previous = null;
			this.pushStatus();
			return;
		}
		this.wd.pitchPx = agg.pitchPx;
		if (agg.needsConfirm) {
			this.pending = { corners: agg.pinCorners, method: 'auto', textFound: false };
			this.confirm.reset();
			this.phase = 'confirm';
			this.say('register.confirmTopLeft');
			this.pushStatus();
			return;
		}
		// The text line settled the orientation and the hands are already off.
		this.pending = { corners: agg.pinCorners, method: 'auto', textFound: true };
		this.finishRegistration(frame, { handsPresent: handCount > 0 });
	}

	private stepTracking(frame: LumaFrame, hints: { occluders?: Point[][]; handsPresent: boolean; now: number }, now: number) {
		if (!this.registration) return;
		if (this.fixed) return;
		if (this.frameCount % Math.max(1, this.options.trackEvery) !== 0 && this.trackState !== 'lost') return;
		const before = this.tracker.pose;
		let step: TrackStep;
		try {
			step = this.tracker.update(frame, hints);
		} catch (e) {
			this.emit('error', { code: 'tracker', message: String(e) });
			return;
		}
		this.noteStep(step, now);
		if (step.relocked && step.pose && before) {
			const { cols, rows } = this.options;
			const pins = maxCornerDist(cornersOfPose(before, cols, rows), cornersOfPose(step.pose, cols, rows)) / (this.registration.pitchPx || 1);
			const size = this.registration.frame;
			this.registration = this.makeRegistration(this.registration.corners, 'tracker', this.registration.textFound, size, step.pose);
			this.emit('moved', { via: 'tracker', pins });
			this.emit('registration', this.registration);
		}
		// Lost bookkeeping.
		if (step.state === 'lost') {
			if (this.lostSince == null) {
				this.lostSince = now;
				this.emit('lost', { reason: step.reason ?? 'lost' });
				this.releasePin('unusable');
			} else if (!this.lostPrompted && now - this.lostSince >= LOST_PROMPT_AFTER_MS && now - this.lostPromptAt >= LOST_PROMPT_COOLDOWN_MS) {
				this.lostPrompted = true;
				this.lostPromptAt = now;
				this.say('tracking.lost');
			}
		} else if (this.lostSince != null && step.accepted) {
			this.lostSince = null;
			if (this.lostPrompted) this.say('tracking.restored');
			this.lostPrompted = false;
		}
		// Pins not visible (no hand, no evidence) for a while → static.
		if (step.state === 'blank' && !hints.handsPresent) {
			this.blankSince ??= now;
			if (!this.staticPrompted && now - this.blankSince >= STATIC_AFTER_MS) {
				this.staticPrompted = true;
				this.say('tracking.pinsNotVisible');
			}
		} else if (step.accepted) this.blankSince = null;
	}

	private noteStep(step: TrackStep, _now: number) {
		this.lastStep = step;
		this.trackState = step.state;
	}

	private stepWatchdog(frame: LumaFrame, handCount: number, now: number) {
		const reg = this.registration;
		if (!reg || this.trackState === 'lost') {
			this.wd.search = null;
			return;
		}
		const w = this.wd;
		if (handCount === 0) w.zeroSince ??= now;
		else w.zeroSince = null;
		if (w.search && handCount > 0) {
			w.search = null;
			w.tracked = null;
			w.lastCheckAt = now;
			return;
		}
		if (!w.search) {
			const healthy = this.trackState === 'tracking' && !this.fixed;
			const intervalMs = healthy ? WATCHDOG_HEALTHY_INTERVAL_MS : this.dog.intervalMs;
			if (!watchdogDue({ now, zeroSince: w.zeroSince, lastCheckAt: w.lastCheckAt }, { intervalMs, handsOffMs: WATCHDOG_HANDS_OFF_MS })) return;
			const pose = this.pose;
			if (!pose) return;
			w.tracked = cornersOfPose(pose, this.options.cols, this.options.rows);
			const data = frame.read(0, 0, frame.width, frame.height);
			w.search = latticeSearch({ data, width: frame.width, height: frame.height }, { pitchHint: w.pitchPx || reg.pitchPx });
			return;
		}
		let r: IteratorResult<void, LatticeDetection | null>;
		try {
			r = w.search.next();
		} catch (e) {
			this.emit('error', { code: 'lattice', message: String(e) });
			r = { done: true, value: null };
		}
		if (!r.done) return;
		const det = r.value;
		const tracked = w.tracked;
		w.search = null;
		w.tracked = null;
		w.lastCheckAt = now;
		if (det) w.pitchPx = det.pitchPx;
		const res = this.dog.update(tracked, det, now);
		if (res.action !== 'reregister' || !res.corners) return;
		const size = { width: frame.width, height: frame.height };
		let next = this.makeRegistration(res.corners, 'watchdog', det?.textFound ?? null, size);
		const step = this.tracker.reset(next.pose, frame, { handsPresent: handCount > 0 });
		this.noteStep(step, now);
		if (step.accepted && step.pose) next = this.makeRegistration(res.corners, 'watchdog', det?.textFound ?? null, size, step.pose);
		this.registration = next;
		this.lostSince = null;
		this.releasePin('reset');
		this.emit('moved', { via: 'watchdog', pins: res.pins ?? 0 });
		this.emit('registration', next);
		if (res.announce) this.say('tracking.moved');
	}

	private usable(): boolean {
		if (this.phase !== 'ready' || !this.registration) return false;
		if (this.fixed) return true;
		return this.trackState !== 'lost';
	}

	private stepPin(tip: Point | null, now: number) {
		if (!this.usable()) {
			this.releasePin('unusable');
			return;
		}
		if (!tip) {
			this.releasePin('not-pointing');
			return;
		}
		const pose = this.pose as Mat3;
		if (!this.poseInv || this.poseInv.pose !== pose) {
			try {
				this.poseInv = { pose, inv: invert3(pose) };
			} catch {
				return;
			}
		}
		const [fx, fy] = applyH(this.poseInv.inv, tip);
		const pin = this.quant.update(fx, fy);
		if (!pin) {
			this.releasePin('off-pad');
			return;
		}
		const key = `${pin[0]},${pin[1]}`;
		const sent = this.gate.offer(key, now);
		if (!sent) return;
		const { cols, rows, border } = this.options;
		const inBorder = pin[0] < border || pin[1] < border || pin[0] > cols - 1 - border || pin[1] > rows - 1 - border;
		this.lastPin = { x: pin[0], y: pin[1], inBorder, fx, fy };
		this.emit('pin', this.lastPin);
	}

	private releasePin(reason: CoreEvents['leave']['reason']) {
		this.quant.reset();
		this.gate.lift();
		if (this.lastPin) {
			this.lastPin = null;
			this.emit('leave', { reason });
		}
	}

	get currentPin(): PinEvent | null {
		return this.lastPin;
	}

	private trackingStatus(): TrackingStatus {
		if (!this.registration || this.phase !== 'ready') return 'none';
		if (this.fixed) return 'fixed';
		switch (this.trackState) {
			case 'tracking':
				return 'tracking';
			case 'occluded':
				return 'occluded';
			case 'lost':
				return 'lost';
			case 'blank':
				return this.blankSince != null && this.staticPrompted ? 'static' : 'occluded';
			default:
				return 'tracking';
		}
	}

	private computeStatus(handsInView: number, pointing: boolean): PointerStatus {
		const tracking = this.trackingStatus();
		const messages: Record<Phase, string> = {
			idle: this.registration ? 'Registered' : 'Not registered',
			corners: `Registering corners (${this.capture.index}/4)`,
			autoFind: this.scan ? 'Looking for the pins' : 'Waiting for hands off',
			confirm: 'Touch the top-left pin to confirm',
			handsOff: 'Lift your hand',
			ready: `Ready — ${tracking}`,
		};
		return {
			phase: this.phase,
			tracking,
			registered: !!this.registration,
			fixed: this.fixed,
			handsInView,
			pointing,
			cornersLocked: this.capture.index,
			message: messages[this.phase],
		};
	}

	private pushStatus(handsInView = this.status?.handsInView ?? 0, pointing = this.status?.pointing ?? false) {
		const st = this.computeStatus(handsInView, pointing);
		this.status = st;
		const key = `${st.phase}|${st.tracking}|${st.registered}|${st.fixed}|${st.cornersLocked}|${st.handsInView > 0}|${st.pointing}`;
		if (key === this.lastStatusKey) return;
		this.lastStatusKey = key;
		this.emit('status', st);
	}
}
