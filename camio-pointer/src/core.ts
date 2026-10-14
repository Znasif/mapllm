/**
 * The pointer's state machine, framework-free and DOM-free: frames and hand
 * landmarks in, events out. The browser shell (`pointer.ts`) feeds it from a
 * camera and MediaPipe; tests feed it synthetic frames and fake landmarks.
 *
 * Everything surface-specific comes from the {@link SurfaceProfile}
 * (`surface.ts`): the DOT Pad (pins, lattice auto-find, lattice tracker,
 * watchdog) or any rectangle (four touched corners, acuity grid, AKAZE
 * tracker). The core works in cell space: the pose maps cell (col, row) →
 * camera px with cell centres on integers.
 *
 * Phases (re-implemented from the starter's TactileExplorerGeneric.jsx):
 *   idle      — no registration (or a registration attempt failed).
 *   corners   — dwell on TL → TR → BR → BL corners (createCornerCapture),
 *               then the profile's corner check.
 *   autoFind  — (DOT Pad) hands-off wait, then the multi-frame lattice scan
 *               (one latticeSearch step per frame, aggregateDetections).
 *   confirm   — (DOT Pad) the scan could not tell which way up the pad is: one
 *               dwell on the top-left pin (resolveConfirmTouch), or confirmTopLeft().
 *   handsOff  — a registration is waiting for a hands-off frame.
 *   ready     — tracking (the profile's tracker) + (DOT Pad) drift watchdog;
 *               the pointing fingertip is mapped to a cell and emitted on change.
 */

import { Emitter } from './emitter';
import { type Mat3, type Point, applyH, cellPxOf, homography4, invert3, maxCornerDist, quadAspect, resolveConfirmTouch } from './geometry';
import {
	type AggregatedGesture,
	type GestureHand,
	type GestureStatus,
	type HandResult,
	type HandSide,
	type Landmark,
	INDEX_TIP,
	createCornerCapture,
	createGestureRecognizer,
	createPinQuantizer,
	createSendGate,
	handSideOf,
	isOnPad,
	makeOneEuroFilter,
} from './input';
import { aggregateDetections, latticeSearch, type LatticeDetection } from './lattice';
import { type PromptCode, type PromptEvent, prompt } from './prompts';
import { DOTPAD_GRID, type Grid, type SurfaceKind, type SurfaceProfile, type SurfaceSpec, type TrackerEnv, createSurfaceProfile } from './surface';
import { type LumaFrame, type TrackHints, type TrackState, type TrackStep, type Tracker, convexHull } from './tracker';
import { WATCHDOG_HANDS_OFF_MS, createDriftWatchdog, watchdogDue } from './watchdog';

export type Phase = 'idle' | 'corners' | 'autoFind' | 'confirm' | 'handsOff' | 'ready';

/**
 * How the registered pose is being kept up to date.
 *  - tracking: the surface was seen and the pose follows it;
 *  - occluded: a hand hides too much (DOT Pad), or the last match was too weak
 *              (rect); the last pose is used;
 *  - static:   the tracker cannot see the surface (blank/sparse map, glare,
 *              OpenCV unavailable): the pose is the registered one and (DOT
 *              Pad) only the watchdog can notice a move;
 *  - lost:     (DOT Pad) the camera contradicts the pose; NO points are emitted
 *              until it is re-found (relock, full search when hands are off,
 *              or re-register);
 *  - loading:  (rect) the tracker is still loading OpenCV; the registered pose is used;
 *  - fixed:    frozen by setFixed(true);
 *  - none:     not registered.
 */
export type TrackingStatus = 'none' | 'loading' | 'tracking' | 'occluded' | 'static' | 'lost' | 'fixed';

export interface Registration {
	surface: SurfaceKind;
	/**
	 * TL, TR, BR, BL in camera px: the corner-PIN centres on the DOT Pad (TL is
	 * the pad's top-left with the braille line below); the physical corners on a rect.
	 */
	corners: Point[];
	/** Cell (col, row) → camera px. */
	pose: Mat3;
	grid: Grid;
	/** Mean cell size in px (DOT Pad: the pin pitch). */
	cellPx: number;
	/** Width / height of the registered image quad (quadAspect). */
	aspect: number;
	method: 'auto' | 'corners' | 'watchdog' | 'tracker';
	/** Orientation settled by the braille text line (DOT Pad auto only). */
	textFound: boolean | null;
	frame: { width: number; height: number };
}

/** Payload of the 'point' event: the cell under the pointing fingertip. */
export interface PointEvent {
	surface: SurfaceKind;
	/** Column 0…cols−1, left → right (DOT Pad: the pin). */
	col: number;
	/** Row 0…rows−1, top → bottom (DOT Pad: braille line below the bottom row). */
	row: number;
	/**
	 * The cell's reference point in normalised surface coords, (0,0) = the
	 * registered TL, (1,1) = BR. DOT Pad: col/(cols−1); rect: the cell centre (col+½)/cols.
	 */
	u: number;
	v: number;
	/** Fractional cell coordinates before quantisation. */
	fx: number;
	fy: number;
	/** In the `border` band along the edges (DOT Pad; Audiom pages its viewport there). Rect: always false. */
	inBorder: boolean;
}

export interface PointerStatus {
	surface: SurfaceKind;
	phase: Phase;
	tracking: TrackingStatus;
	registered: boolean;
	fixed: boolean;
	handsInView: number;
	/** The aggregated gesture is POINTING (a fingertip drives the points). */
	pointing: boolean;
	/**
	 * The aggregated (5-frame majority) gesture, CamIO's statuses:
	 * none = no hand; pointing; exploring = hands but none pointing (or no index
	 * tip on the surface); open = an open hand (behaves as exploring for points);
	 * tooMany = more than one visible hand on the same side.
	 */
	gesture: PointerGesture;
	/** Side of the tracked pointing hand (null when not pointing or the handedness is unknown). */
	side: HandSide | null;
	/** Corners locked so far in the corners phase (0–4). */
	cornersLocked: number;
	/** Short English description (debug / sighted helper). */
	message: string;
}

export interface CoreEvents {
	point: PointEvent;
	/** The fingertip left the surface, stopped pointing, or points became unusable. */
	leave: { reason: 'off-surface' | 'not-pointing' | 'unusable' | 'reset' };
	prompt: PromptEvent;
	status: PointerStatus;
	registration: Registration;
	/** (DOT Pad) The tracker lost the pad (points are suppressed until it is re-found). */
	lost: { reason: string };
	/** (DOT Pad) The pad was found somewhere else and the registration followed it. */
	moved: { via: 'watchdog' | 'tracker'; cells: number };
	/** Earcon cue for the host: a corner locked, a confirm, a rejection. */
	cue: { code: 'lock' | 'reject' };
	/**
	 * An open hand (index, middle, ring, pinky extended; nothing pointing) was
	 * shown: once per entry of the aggregated gesture into 'open', ready phase
	 * only. Audiom stops speech on it.
	 */
	openHand: OpenHandEvent;
	error: { code: string; message: string };
}

/** Aggregated gesture as reported in PointerStatus. */
export type PointerGesture = 'none' | 'pointing' | 'exploring' | 'open' | 'tooMany';

/** Payload of the 'openHand' event. */
export interface OpenHandEvent {
	/** Side of the open hand (null when the handedness is unknown). */
	side: HandSide | null;
}

const GESTURE_OF: Record<GestureStatus, PointerGesture> = {
	NOT_FOUND: 'none',
	POINTING: 'pointing',
	EXPLORING: 'exploring',
	OPEN_HAND: 'open',
	MORE_THAN_ONE_HAND: 'tooMany',
};

/** Cell size (px at 1280 wide) assumed for the movement threshold before any registration measured one. */
const NOMINAL_PITCH_PX_AT_1280 = 7;

/** Builds a tracker for a surface profile (called again by setSurface). */
export type TrackerFactory = (profile: SurfaceProfile) => Tracker;

export interface CoreOptions {
	/** The surface (default: the DOT Pad). Change it later with setSurface(). */
	surface: SurfaceSpec;
	/**
	 * Cell quantizer hysteresis (cells beyond the half-cell boundary). Sized to
	 * the finger, not the pin: a fingertip covers about 4 × 4 pins, so the default
	 * 1.5 holds a cell until the estimate is > 2 cells away on an axis — a resting
	 * finger emits nothing, a moving one roughly every 2 cells.
	 */
	hysteresis: number;
	/** Minimum time between two 'point' events (ms); 0 = every change. */
	minIntervalMs: number;
	/** A cell must be held this long before it is emitted (ms). */
	dwellMs: number;
	/** Shift the fingertip along the finger, in cells (negative = toward the knuckle). */
	tipOffsetCells: number;
	/** Corner dwell: hold time (ms) and radius (px at 1280 wide; scaled with the frame). */
	cornerDwellMs: number;
	cornerDwellPx: number;
	/**
	 * Plug in another tracker; default: the profile's (DOT Pad: lattice-follow;
	 * rect: AKAZE). A Tracker instance serves the construction-time surface
	 * only; a factory is called for every surface (setSurface).
	 */
	tracker: Tracker | TrackerFactory | null;
	/** What the profiles need to build their trackers (the pointer passes the AKAZE engine). */
	trackerEnv: TrackerEnv;
	/** Run the tracker every N frames (1 = every frame); 0 = the profile's divider. */
	trackEvery: number;
	/**
	 * Swap MediaPipe's handedness labels, as CamIO does ('Left' = the right
	 * hand; MediaPipe assumes a mirrored image). Only the announced side and
	 * the two-hand tie-break (right before left) depend on it.
	 */
	swapHandedness: boolean;
}

export const CORE_DEFAULTS: Readonly<CoreOptions> = Object.freeze({
	surface: { kind: 'dotpad' } as SurfaceSpec,
	hysteresis: 1.5,
	minIntervalMs: 0,
	dwellMs: 0,
	tipOffsetCells: 0,
	cornerDwellMs: 1500,
	cornerDwellPx: 45,
	tracker: null,
	trackerEnv: {},
	trackEvery: 0,
	swapHandedness: true,
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
	private _profile: SurfaceProfile;
	private _tracker: Tracker;
	/** The grid points are quantised on: the registration's, else the profile's default. */
	private grid: Grid;
	/** Tracker failures already forwarded as 'error' (once each). */
	private reportedErrors = new Set<string>();

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
	/** Resolves the promise of autoRegister() / register(). */
	private flowResolve: ((r: Registration | null) => void) | null = null;

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

	private gesture;
	private lastGesture: AggregatedGesture | null = null;
	private oefX = makeOneEuroFilter();
	private oefY = makeOneEuroFilter();
	private wasPointing = false;
	/** CamIO mapio `last_hand_side` (ready phase only; null outside it). */
	private lastHandSide: HandSide | null = null;
	private openArmed = true;
	private quant;
	private gate;
	private lastPoint: PointEvent | null = null;
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
		this._profile = createSurfaceProfile(this.options.surface);
		const t = this.options.tracker;
		this._tracker = t ? (typeof t === 'function' ? t(this._profile) : t) : this._profile.createTracker(this.options.trackerEnv);
		this.grid = this._profile.gridFor(null);
		this.capture = createCornerCapture({ dwellMs: this.options.cornerDwellMs, dwellR: this.options.cornerDwellPx });
		this.confirm = createCornerCapture({ dwellMs: this.options.cornerDwellMs, dwellR: this.options.cornerDwellPx });
		this.quant = createPinQuantizer({ cols: this.grid.cols, rows: this.grid.rows, hysteresis: this.options.hysteresis });
		this.gesture = createGestureRecognizer({ movementPins: this._profile.movementCells(this.grid) });
		this.gate = createSendGate({ minIntervalMs: this.options.minIntervalMs, dwellMs: this.options.dwellMs });
		this.status = this.computeStatus(0, false, 'none', null);
	}

	/* ------------------------------------------------------- public API -- */

	/** The tracker in use (setSurface replaces it). */
	get tracker(): Tracker {
		return this._tracker;
	}
	/** The surface profile in use. */
	get profile(): SurfaceProfile {
		return this._profile;
	}
	get surface(): SurfaceKind {
		return this._profile.kind;
	}
	/** The grid points are quantised on right now (the registration's, else the profile's default). */
	get currentGrid(): Grid {
		return this.grid;
	}
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
	/** Image corners (TL, TR, BR, BL) of a pose on the current grid. */
	cornersOf(pose: Mat3): Point[] {
		return this._profile.planeCorners(this.grid).map((p) => applyH(pose, p));
	}
	get lastTrackStep(): TrackStep | null {
		return this.lastStep;
	}
	/** The last frame's gesture (aggregated status + this frame's own result), for debugging. */
	get lastGestureResult(): AggregatedGesture | null {
		return this.lastGesture;
	}
	getStatus(): PointerStatus {
		return this.status;
	}

	/** Start the four-corner dwell registration. */
	registerByCorners(): void {
		this.beginFlow();
		this.capture.reset();
		this.phase = 'corners';
		this.say(this._profile.prompts.corners[0]);
		this.pushStatus();
	}

	/**
	 * Start auto-registration (DOT Pad: the pin lattice); resolves with the
	 * registration, or null (not found / cancelled). Other surfaces cannot be
	 * found automatically: resolves null and emits error 'autoRegister.unsupported'.
	 */
	autoRegister(): Promise<Registration | null> {
		if (!this._profile.autoFind) {
			this.emit('error', { code: 'autoRegister.unsupported', message: `autoRegister is not available on the '${this._profile.kind}' surface; use register() or registerByCorners().` });
			return Promise.resolve(null);
		}
		this.beginFlow();
		const p = this.flowPromise();
		this.handsOff = { startedAt: Number.NaN, zeroSince: null, minMs: FIND_HANDS_OFF_MS, maxMs: FIND_HANDS_OFF_MAX_MS, then: 'find' };
		this.phase = 'autoFind';
		this.say('register.handsOff');
		this.pushStatus();
		return p;
	}

	/**
	 * Register the current surface its default way (DOT Pad: autoRegister();
	 * rect: registerByCorners()). Resolves with the registration, or null on
	 * cancel, reset, setSurface or not-found. Rejected corners re-prompt and do
	 * not resolve.
	 */
	register(): Promise<Registration | null> {
		if (this._profile.autoFind) return this.autoRegister();
		this.registerByCorners();
		return this.flowPromise();
	}

	/** In the confirm phase: accept the detected orientation without the touch. */
	confirmTopLeft(): void {
		if (this.phase !== 'confirm' || !this.pending) return;
		this.beginHandsOff(this.pending.corners, this.pending.method, this.pending.textFound, Number.NaN);
	}

	/** Abort a registration flow; the previous registration (if any) is restored. */
	cancel(): void {
		if (this.phase === 'ready' || this.phase === 'idle') return;
		this.resolveFlow(null);
		this.scan = null;
		this.handsOff = null;
		this.pending = null;
		if (this.previous) {
			this.restore(this.previous);
			this.phase = 'ready';
		} else this.phase = 'idle';
		this.previous = null;
		this.say('register.cancelled');
		this.pushStatus();
	}

	/**
	 * Switch to another surface: reset() (any pending register() resolves
	 * null), dispose the old tracker, and rebuild the profile, tracker,
	 * quantiser, corner captures and gesture recogniser. The camera keeps running.
	 */
	setSurface(spec: SurfaceSpec): void {
		const profile = createSurfaceProfile(spec);
		this.reset();
		try {
			this._tracker.dispose?.();
		} catch (e) {
			this.emit('error', { code: 'tracker', message: String(e) });
		}
		this.options.surface = spec;
		this._profile = profile;
		const t = this.options.tracker;
		this._tracker = typeof t === 'function' ? t(profile) : profile.createTracker(this.options.trackerEnv);
		this.grid = profile.gridFor(null);
		this.quant = createPinQuantizer({ cols: this.grid.cols, rows: this.grid.rows, hysteresis: this.options.hysteresis });
		this.capture = createCornerCapture({ dwellMs: this.options.cornerDwellMs, dwellR: this.options.cornerDwellPx });
		this.confirm = createCornerCapture({ dwellMs: this.options.cornerDwellMs, dwellR: this.options.cornerDwellPx });
		this.gesture = createGestureRecognizer({ movementPins: profile.movementCells(this.grid) });
		this.lastGesture = null;
		this.lastHandSide = null;
		this.wasPointing = false;
		this.openArmed = true;
		this.poseInv = null;
		this.trackState = 'idle';
		this.lastStep = null;
		this.reportedErrors.clear();
		this.wd = { zeroSince: null, lastCheckAt: null, search: null, tracked: null, pitchPx: null };
		this.pushStatus();
	}

	/** Release the tracker (workers, engines). The core is not used afterwards. */
	dispose(): void {
		this.reset();
		try {
			this._tracker.dispose?.();
		} catch {
			// Nothing else to release.
		}
	}

	/** Freeze (true) or release the pose. The watchdog keeps running. */
	setFixed(fixed: boolean): void {
		this.fixed = !!fixed;
		this.pushStatus();
	}

	/** Use an externally known registration (e.g. restored from storage). */
	setRegistration(corners: Point[], frame: { width: number; height: number }): Registration {
		const reg = this.makeRegistration(corners, 'corners', null, frame);
		this.useGrid(reg.grid);
		this.registration = reg;
		this.forwardTrackerError(this.tracker.reset(reg.pose, undefined, { region: reg.corners }));
		this.phase = 'ready';
		this.emit('registration', reg);
		this.pushStatus();
		return reg;
	}

	/** Forget everything (no registration). */
	reset(): void {
		this.resolveFlow(null);
		this.phase = 'idle';
		this.registration = null;
		this.previous = null;
		this.pending = null;
		this.scan = null;
		this.handsOff = null;
		this.tracker.clear();
		this.dog.reset();
		this.releasePoint('reset');
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

		// Gesture (CamIO's recognizer + 5-frame majority), then smoothing.
		const g = this.gesture.update(this.gestureHands(hands, W, H), now, this.pxPerCell(W));
		this.lastGesture = g;
		const pointing = g.status === 'POINTING' && !!g.hand;
		if (this.phase === 'ready') {
			// CamIO mapio: a new pointing side clears the position state and is announced.
			if (pointing && g.side !== this.lastHandSide) {
				this.lastHandSide = g.side;
				this.quant.reset();
				this.gate.lift();
				this.wasPointing = false;
				if (g.side) this.say(g.side === 'left' ? 'pointing.hand.left' : 'pointing.hand.right');
			}
		} else this.lastHandSide = null;
		if (g.status !== 'OPEN_HAND') this.openArmed = true;
		else if (this.openArmed) {
			this.openArmed = false;
			if (this.phase === 'ready') this.emit('openHand', { side: g.side });
		}
		let tip: Point | null = null;
		if (pointing && g.hand) {
			if (!this.wasPointing) {
				this.oefX = makeOneEuroFilter();
				this.oefY = makeOneEuroFilter();
			}
			const raw = this.tipPx(g.hand.landmarks, W, H);
			tip = [this.oefX(raw[0], now), this.oefY(raw[1], now)];
		}
		this.wasPointing = pointing;
		this.view.tip = tip;

		switch (this.phase) {
			case 'corners':
				this.stepCorners(tip, now);
				this.releasePoint('unusable');
				break;
			case 'autoFind':
			case 'handsOff':
				if (this.scan) this.stepScan(frame, handCount, now);
				else if (this.handsOffElapsed(handCount, now)) {
					if (this.handsOff?.then === 'find') this.beginScan(now);
					else this.finishRegistration(frame, hints);
				}
				this.releasePoint('unusable');
				break;
			case 'confirm':
				this.stepConfirm(tip, now);
				this.releasePoint('unusable');
				break;
			case 'ready':
				this.stepTracking(frame, hints, now);
				this.stepWatchdog(frame, handCount, now);
				this.stepPoint(tip, now);
				break;
			default:
				this.releasePoint('unusable');
		}
		this.pushStatus(handCount, pointing && !!tip, GESTURE_OF[g.status], pointing ? g.side : null);
	}

	/* --------------------------------------------------------- internals -- */

	/** The MediaPipe hands with their side and index tip; once a pose exists, CamIO's index-visible filter. */
	private gestureHands(hands: HandResult | null, W: number, H: number): GestureHand[] {
		const lms = hands?.landmarks ?? [];
		const pose = this.pose;
		const inv = pose ? this.inversePose(pose) : null;
		const { swapHandedness } = this.options;
		const { cols, rows } = this.grid;
		return lms.map((landmarks, i) => {
			const t = landmarks[INDEX_TIP];
			const px: Point = t ? [t.x * W, t.y * H] : [Number.NaN, Number.NaN];
			const pad = inv ? applyH(inv, px) : null;
			return {
				landmarks,
				side: handSideOf(hands, i, swapHandedness),
				visible: pad ? isOnPad(pad[0], pad[1], cols, rows) : !!t,
				px,
				pad,
			};
		});
	}

	/** Pixels per cell for the movement threshold: the registration's cell size, else a nominal one. */
	private pxPerCell(W: number): number {
		return this.registration?.cellPx || this.previous?.cellPx || this.wd.pitchPx || (NOMINAL_PITCH_PX_AT_1280 * (W || 1280)) / 1280;
	}

	/** Quantise on `g` from now on (a new quantiser only when the dimensions change). */
	private useGrid(g: Grid) {
		if (g.cols === this.grid.cols && g.rows === this.grid.rows) return;
		this.grid = { cols: g.cols, rows: g.rows };
		this.quant = createPinQuantizer({ cols: g.cols, rows: g.rows, hysteresis: this.quant.hysteresis });
		this.gesture = createGestureRecognizer({ movementPins: this._profile.movementCells(this.grid) });
	}

	private inversePose(pose: Mat3): Mat3 | null {
		if (!this.poseInv || this.poseInv.pose !== pose) {
			try {
				this.poseInv = { pose, inv: invert3(pose) };
			} catch {
				return null;
			}
		}
		return this.poseInv.inv;
	}

	private tipPx(lm: Landmark[], W: number, H: number): Point {
		const t = lm[INDEX_TIP];
		let x = t.x * W;
		let y = t.y * H;
		const k = this.options.tipOffsetCells;
		const pose = this.pose;
		if (k && pose && lm[7]) {
			const dx = x - lm[7].x * W;
			const dy = y - lm[7].y * H;
			const len = Math.hypot(dx, dy) || 1;
			const pitch = this.registration?.cellPx ?? 0;
			x += (dx / len) * k * pitch;
			y += (dy / len) * k * pitch;
		}
		return [x, y];
	}

	private say(code: PromptCode, params?: Record<string, string | number>) {
		this.emit('prompt', prompt(code, params));
	}

	private resolveFlow(r: Registration | null) {
		const f = this.flowResolve;
		this.flowResolve = null;
		f?.(r);
	}

	/** The promise of the flow just begun (beginFlow resolved any earlier one with null). */
	private flowPromise(): Promise<Registration | null> {
		return new Promise<Registration | null>((resolve) => {
			this.flowResolve = resolve;
		});
	}

	/** Go back to an earlier registration (cancel, not found): its grid and pose; the tracker re-references on its own. */
	private restore(reg: Registration) {
		this.registration = reg;
		this.useGrid(reg.grid);
		this.forwardTrackerError(this.tracker.reset(reg.pose, undefined, { region: reg.corners }));
	}

	/** Forward a tracker failure (e.g. OpenCV did not load) once as an 'error' event. */
	private forwardTrackerError(step: TrackStep) {
		if (step.reason !== 'opencv-unavailable' || this.reportedErrors.has(step.reason)) return;
		this.reportedErrors.add(step.reason);
		this.emit('error', { code: 'opencv.load', message: 'OpenCV.js could not be loaded; the surface is not followed if it moves.' });
	}

	/** Start a registration flow: remember the current registration for cancel(). */
	private beginFlow() {
		this.resolveFlow(null);
		if (this.registration) this.previous = this.registration;
		this.registration = null;
		this.pending = null;
		this.scan = null;
		this.handsOff = null;
		this.tracker.clear();
		this.dog.reset();
		this.wd = { zeroSince: null, lastCheckAt: null, search: null, tracked: null, pitchPx: this.wd.pitchPx };
		this.releasePoint('reset');
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
		// The grid follows from the given corners (rect: the quad's orientation); a pose only refines them.
		const grid = this._profile.gridFor(corners);
		const plane = this._profile.planeCorners(grid);
		const H = pose ?? homography4(plane, corners);
		const c = pose ? plane.map((p) => applyH(pose, p)) : corners.map((p) => [p[0], p[1]] as Point);
		return {
			surface: this._profile.kind,
			corners: c,
			pose: H,
			grid,
			cellPx: cellPxOf(c, plane),
			aspect: quadAspect(c),
			method,
			textFound,
			frame: { ...frame },
		};
	}

	private finishRegistration(frame: LumaFrame, hints: TrackHints) {
		const p = this.pending;
		this.handsOff = null;
		if (!p) {
			this.phase = this.registration ? 'ready' : 'idle';
			return;
		}
		const size = { width: frame.width, height: frame.height };
		let reg = this.makeRegistration(p.corners, p.method, p.textFound, size);
		this.useGrid(reg.grid);
		// DOT Pad: snap to the lattice the camera actually sees (touched corners can be a pin off).
		// Rect: the tracker takes its reference from this hands-off frame.
		const step = this.tracker.reset(reg.pose, frame, { ...hints, region: reg.corners });
		this.noteStep(step, 0);
		if (step.accepted && step.pose) reg = this.makeRegistration(p.corners, p.method, p.textFound, size, step.pose);
		this.registration = reg;
		this.previous = null;
		this.pending = null;
		this.phase = 'ready';
		this.dog.reset();
		this.wd = { zeroSince: null, lastCheckAt: null, search: null, tracked: null, pitchPx: reg.cellPx };
		this.lostSince = null;
		this.lostPrompted = false;
		this.blankSince = null;
		this.staticPrompted = false;
		this.emit('registration', reg);
		this.say(this._profile.prompts.done);
		this.resolveFlow(reg);
		this.pushStatus();
	}

	private stepCorners(tip: Point | null, now: number) {
		const r = (this.options.cornerDwellPx * (this.view.frame.width || 1280)) / 1280;
		this.capture.setRadius(r);
		const cap = this.capture.update(tip ? tip[0] : null, tip ? tip[1] : null, now);
		if (!cap.locked) return;
		this.emit('cue', { code: 'lock' });
		const prompts = this._profile.prompts;
		if (!cap.complete) {
			this.say(prompts.corners[cap.index]);
			return;
		}
		const check = this._profile.validate(cap.corners, this.view.frame);
		if (!check.ok) {
			this.capture.reset();
			this.emit('cue', { code: 'reject' });
			this.say(prompts.cornersRejected, { reason: check.reason ?? '' });
			this.say(prompts.corners[0]);
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
		const resolved = resolveConfirmTouch(this.pending.corners, cap.corners[0], DOTPAD_GRID);
		if (!resolved) {
			this.say('register.confirmMissed');
			this.resolveFlow(null);
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
			this.resolveFlow(null);
			if (this.previous) {
				this.restore(this.previous);
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

	private stepTracking(frame: LumaFrame, hints: TrackHints & { handsPresent: boolean }, now: number) {
		if (!this.registration) return;
		if (this.fixed) return;
		const every = Math.max(1, this.options.trackEvery || this._profile.trackEvery);
		if (this.frameCount % every !== 0 && this.trackState !== 'lost') return;
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
			const cells = maxCornerDist(this.cornersOf(before), this.cornersOf(step.pose)) / (this.registration.cellPx || 1);
			const size = this.registration.frame;
			this.registration = this.makeRegistration(this.registration.corners, 'tracker', this.registration.textFound, size, step.pose);
			this.emit('moved', { via: 'tracker', cells });
			this.emit('registration', this.registration);
		}
		const prompts = this._profile.prompts;
		// Lost bookkeeping.
		if (step.state === 'lost') {
			if (this.lostSince == null) {
				this.lostSince = now;
				this.emit('lost', { reason: step.reason ?? 'lost' });
				this.releasePoint('unusable');
			} else if (!this.lostPrompted && now - this.lostSince >= LOST_PROMPT_AFTER_MS && now - this.lostPromptAt >= LOST_PROMPT_COOLDOWN_MS) {
				this.lostPrompted = true;
				this.lostPromptAt = now;
				if (prompts.lost) this.say(prompts.lost);
			}
		} else if (this.lostSince != null && step.accepted) {
			this.lostSince = null;
			if (this.lostPrompted && prompts.restored) this.say(prompts.restored);
			this.lostPrompted = false;
		}
		// Surface not visible to the tracker (no hand, no evidence) for a while → static.
		if (step.state === 'blank' && !hints.handsPresent) {
			this.blankSince ??= now;
			if (!this.staticPrompted && now - this.blankSince >= STATIC_AFTER_MS) {
				this.staticPrompted = true;
				this.say(prompts.static);
			}
		} else if (step.accepted) this.blankSince = null;
	}

	private noteStep(step: TrackStep, _now: number) {
		this.lastStep = step;
		this.trackState = step.state;
		this.forwardTrackerError(step);
	}

	private stepWatchdog(frame: LumaFrame, handCount: number, now: number) {
		const reg = this.registration;
		if (!this._profile.watchdog) return;
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
			w.tracked = this.cornersOf(pose);
			const data = frame.read(0, 0, frame.width, frame.height);
			w.search = latticeSearch({ data, width: frame.width, height: frame.height }, { pitchHint: w.pitchPx || reg.cellPx });
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
		const step = this.tracker.reset(next.pose, frame, { handsPresent: handCount > 0, region: next.corners });
		this.noteStep(step, now);
		if (step.accepted && step.pose) next = this.makeRegistration(res.corners, 'watchdog', det?.textFound ?? null, size, step.pose);
		this.registration = next;
		this.lostSince = null;
		this.releasePoint('reset');
		this.emit('moved', { via: 'watchdog', cells: res.pins ?? 0 });
		this.emit('registration', next);
		if (res.announce) this.say('tracking.moved');
	}

	private usable(): boolean {
		if (this.phase !== 'ready' || !this.registration) return false;
		if (this.fixed) return true;
		return this.trackState !== 'lost';
	}

	private stepPoint(tip: Point | null, now: number) {
		if (!this.usable()) {
			this.releasePoint('unusable');
			return;
		}
		if (!tip) {
			this.releasePoint('not-pointing');
			return;
		}
		const inv = this.inversePose(this.pose as Mat3);
		if (!inv) return;
		const [fx, fy] = applyH(inv, tip);
		const cell = this.quant.update(fx, fy);
		if (!cell) {
			this.releasePoint('off-surface');
			return;
		}
		const key = `${cell[0]},${cell[1]}`;
		const sent = this.gate.offer(key, now);
		if (!sent) return;
		const { cols, rows } = this.grid;
		const border = this._profile.border;
		const [col, row] = cell;
		const inBorder = col < border || row < border || col > cols - 1 - border || row > rows - 1 - border;
		const [u, v] = this._profile.toUV(col, row, this.grid);
		this.lastPoint = { surface: this._profile.kind, col, row, u, v, fx, fy, inBorder };
		this.emit('point', this.lastPoint);
	}

	private releasePoint(reason: CoreEvents['leave']['reason']) {
		this.quant.reset();
		this.gate.lift();
		if (this.lastPoint) {
			this.lastPoint = null;
			this.emit('leave', { reason });
		}
	}

	/** The last emitted point, until the fingertip leaves. */
	get currentPoint(): PointEvent | null {
		return this.lastPoint;
	}

	private trackingStatus(): TrackingStatus {
		if (!this.registration || this.phase !== 'ready') return 'none';
		if (this.fixed) return 'fixed';
		switch (this.trackState) {
			case 'loading':
				return 'loading';
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

	private computeStatus(handsInView: number, pointing: boolean, gesture: PointerGesture, side: HandSide | null): PointerStatus {
		const tracking = this.trackingStatus();
		const messages: Record<Phase, string> = {
			idle: this.registration ? 'Registered' : 'Not registered',
			corners: `Registering (${this.capture.index}/4)`,
			autoFind: this.scan ? 'Finding the DOT Pad' : 'Hands off',
			confirm: 'Touch the top-left pin',
			handsOff: 'Lift your hand',
			ready: `Ready, ${tracking}`,
		};
		return {
			surface: this._profile.kind,
			phase: this.phase,
			tracking,
			registered: !!this.registration,
			fixed: this.fixed,
			handsInView,
			pointing,
			gesture,
			side,
			cornersLocked: this.capture.index,
			message: messages[this.phase],
		};
	}

	private pushStatus(
		handsInView = this.status?.handsInView ?? 0,
		pointing = this.status?.pointing ?? false,
		gesture: PointerGesture = this.status?.gesture ?? 'none',
		side: HandSide | null = this.status?.side ?? null,
	) {
		const st = this.computeStatus(handsInView, pointing, gesture, side);
		this.status = st;
		const key = `${st.surface}|${st.phase}|${st.tracking}|${st.registered}|${st.fixed}|${st.cornersLocked}|${st.handsInView > 0}|${st.pointing}|${st.gesture}|${st.side}`;
		if (key === this.lastStatusKey) return;
		this.lastStatusKey = key;
		this.emit('status', st);
	}
}
