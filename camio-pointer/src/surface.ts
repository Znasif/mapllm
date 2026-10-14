/**
 * Surface profiles: everything that differs between pointing on a DOT Pad and
 * pointing on any other rectangle (a printed map, a tactile graphic). The core
 * works in one "cell space" for both — the pose maps cell (col, row) → camera
 * px with cell centres on integers — and asks the profile only for what
 * differs: the grid, the plane corners a registration pins down, cell → (u, v),
 * the corner check, the tracker and the prompt codes.
 *
 *   dotpad — the 60 × 40 pin field; corners are the corner-PIN centres. Lattice
 *            auto-find, lattice-follow tracker, drift watchdog. No OpenCV.
 *   rect   — any rectangle, registered by touching its four physical corners;
 *            quantised at the 2.5 mm fingertip-acuity floor (a port of the
 *            starter's `lib/surface.js`), followed by the starter's AKAZE
 *            tracking (or a static pose).
 */

import type { AkazeEngineFactory } from './akaze';
import { type AkazeTrackerOptions, createAkazeTracker } from './akazeTracker';
import { type Point, checkPinQuad, checkSurfaceQuad, pinIndexCorners, quadAspect } from './geometry';
import { MOVEMENT_THRESHOLD_PINS } from './input';
import { CORNER_PROMPT_CODES, type PromptCode } from './prompts';
import { type Tracker, createLatticeTracker, createStaticTracker } from './tracker';

/* ------------------------------------------------------------- specs -- */

/** Which surface the pointer is used on. */
export type SurfaceSpec =
	| {
			kind: 'dotpad';
			/** Pins along each edge reported as `inBorder` (Audiom passes viewport.overlapPins). Default 2. */
			border?: number;
	  }
	| {
			kind: 'rect';
			/** Physical size of the rectangle; default A4 landscape (297 × 210 mm). Oriented like the registered quad. */
			material?: { widthMm: number; heightMm: number };
			/** 'akaze' (default): follow the surface with the starter's AKAZE tracking; 'static': keep the registered pose. */
			tracking?: 'akaze' | 'static';
	  };

export type SurfaceKind = SurfaceSpec['kind'];

/** A cell grid: cols × rows cells, cell centres at integer (col, row). */
export interface Grid {
	cols: number;
	rows: number;
}

/* ------------------------------------------------ port of surface.js -- */

/**
 * Two-point discrimination at the fingertip is roughly 2–3 mm, so no useful
 * quantization is finer than this regardless of what the device can render.
 * (starter `lib/surface.js`)
 */
export const ACUITY_FLOOR_MM = 2.5;

/**
 * Largest double strictly below 1. `(u, v)` are clamped to `[0, 1)` — closed at
 * 0, open at 1 — so `floor(u * cols)` can never produce `cols`.
 */
export const ONE_MINUS_EPSILON = 1 - Number.EPSILON / 2;

/**
 * Tolerance for the grid floor: `material / cellSize` can land a hair below an
 * integer in binary floating point (43 × 6.4 mm / 6.4 mm), so a material sized
 * from its own pin count could lose a row or column. Grid sizing only.
 */
const FLOOR_EPSILON = 1e-9;

/** Pre-printed A4 in landscape, full sheet — 297 × 210 mm: 118 × 84 cells at the acuity floor. (starter `A4_LANDSCAPE`) */
export const A4_LANDSCAPE = Object.freeze({ widthMm: 297, heightMm: 210 });

/**
 * The acuity grid of a material (starter `acuityGrid`):
 *   cellSizeMm = max(devicePinPitchMm, ACUITY_FLOOR_MM)
 *   cols = floor(materialWidthMm / cellSizeMm), rows = floor(materialHeightMm / cellSizeMm)
 */
export function acuityGrid({
	materialWidthMm,
	materialHeightMm,
	devicePinPitchMm,
}: {
	materialWidthMm: number;
	materialHeightMm: number;
	devicePinPitchMm?: number | null;
}): { cellSizeMm: number; cols: number; rows: number; count: number } {
	if (!(materialWidthMm > 0) || !(materialHeightMm > 0)) {
		throw new TypeError(`acuityGrid: materialWidthMm/materialHeightMm must be positive, got ${materialWidthMm}×${materialHeightMm}`);
	}
	const cellSizeMm = Math.max(devicePinPitchMm ?? 0, ACUITY_FLOOR_MM);
	const cols = Math.max(1, Math.floor(materialWidthMm / cellSizeMm + FLOOR_EPSILON));
	const rows = Math.max(1, Math.floor(materialHeightMm / cellSizeMm + FLOOR_EPSILON));
	return { cellSizeMm, cols, rows, count: cols * rows };
}

/** Clamp a normalized material coordinate into `[0, 1)` (starter `clampUnit`). */
export function clampUnit(t: number): number {
	if (!Number.isFinite(t)) {
		throw new TypeError(`clampUnit: expected a finite number, got ${t}`);
	}
	if (t <= 0) return 0;
	return t < ONE_MINUS_EPSILON ? t : ONE_MINUS_EPSILON;
}

/** Centre of an acuity cell (row-major index) in `(u, v)` (starter `acuityCellCenter`). */
export function acuityCellCenter(cell: number, grid: Grid): { u: number; v: number } {
	const { cols, rows } = grid;
	const n = cols * rows;
	if (!Number.isInteger(cell) || cell < 0 || cell >= n) {
		throw new RangeError(`acuityCellCenter: cell ${cell} outside [0, ${n})`);
	}
	const col = cell % cols;
	const row = (cell - col) / cols;
	return { u: (col + 0.5) / cols, v: (row + 0.5) / rows };
}

/* ---------------------------------------------------------- profiles -- */

/** Prompt codes a profile speaks. */
export interface SurfacePrompts {
	corners: [PromptCode, PromptCode, PromptCode, PromptCode];
	cornersRejected: PromptCode;
	done: PromptCode;
	/** The tracker cannot see the surface (state 'blank' with no hands for 2 s). */
	static: PromptCode;
	/** DOT Pad only (the AKAZE port has no lost state). */
	lost?: PromptCode;
	restored?: PromptCode;
}

/** What a profile needs from the host to build its tracker. */
export interface TrackerEnv {
	/** Builds the AKAZE engine for the rect surface (the pointer passes the worker or inline engine). Absent: the tracker reports 'opencv-unavailable'. */
	loadEngine?: AkazeEngineFactory | null;
	/** AKAZE tracker tunables (minInliers, referenceMask, …). */
	akaze?: Partial<Omit<AkazeTrackerOptions, 'loadEngine'>>;
}

/** Everything the core asks of a surface. */
export interface SurfaceProfile {
	readonly kind: SurfaceKind;
	readonly spec: Readonly<SurfaceSpec>;
	/** Cells along each edge reported as `inBorder` (dotpad spec.border ?? 2; rect 0). */
	readonly border: number;
	/** Lattice auto-registration is available (dotpad). */
	readonly autoFind: boolean;
	/** The drift watchdog runs (dotpad). */
	readonly watchdog: boolean;
	/** Core frame divider for the tracker (1 for both; the AKAZE tracker paces itself). */
	readonly trackEvery: number;
	/** The grid of a registration from its image corners (null: before any registration). */
	gridFor(corners: ArrayLike<number>[] | null): Grid;
	/** The plane points (cell space) the four registered image corners are, TL, TR, BR, BL. */
	planeCorners(g: Grid): Point[];
	/** Normalised surface coords of a cell's reference point; (0,0) = registered TL, (1,1) = BR. */
	toUV(col: number, row: number, g: Grid): Point;
	/** Check four touched image corners. */
	validate(corners: ArrayLike<number>[], frame: { width: number; height: number }): { ok: boolean; reason: string | null };
	/** CamIO's movement threshold (0.25 in) in cells. */
	movementCells(g: Grid): number;
	createTracker(env: TrackerEnv): Tracker;
	readonly prompts: Readonly<SurfacePrompts>;
}

/** The DOT Pad pin field. */
export const DOTPAD_GRID: Readonly<Grid> = Object.freeze({ cols: 60, rows: 40 });

function dotpadProfile(spec: Extract<SurfaceSpec, { kind: 'dotpad' }>): SurfaceProfile {
	const grid = DOTPAD_GRID;
	return {
		kind: 'dotpad',
		spec,
		border: spec.border ?? 2,
		autoFind: true,
		watchdog: true,
		trackEvery: 1,
		gridFor: () => ({ ...grid }),
		planeCorners: (g) => pinIndexCorners(g.cols, g.rows),
		toUV: (c, r, g) => [c / (g.cols - 1), r / (g.rows - 1)],
		validate: (corners) => {
			const c = checkPinQuad(corners);
			return { ok: c.ok, reason: c.reason };
		},
		movementCells: () => MOVEMENT_THRESHOLD_PINS,
		createTracker: () => createLatticeTracker({ cols: grid.cols, rows: grid.rows }),
		prompts: {
			corners: CORNER_PROMPT_CODES as SurfacePrompts['corners'],
			cornersRejected: 'register.cornersRejected',
			done: 'register.done',
			static: 'tracking.pinsNotVisible',
			lost: 'tracking.lost',
			restored: 'tracking.restored',
		},
	};
}

/**
 * Any rectangle: the four touched PHYSICAL corners are the plane points
 * (−½, −½) … (cols−½, rows−½), so cell (c, r) covers u ∈ [c/cols, (c+1)/cols]
 * as in `surface.js` `acuityCellIndex`, and its reference point is the cell
 * centre (`acuityCellCenter`).
 */
function rectProfile(spec: Extract<SurfaceSpec, { kind: 'rect' }>): SurfaceProfile {
	const material = spec.material ?? A4_LANDSCAPE;
	const long = Math.max(material.widthMm, material.heightMm);
	const short = Math.min(material.widthMm, material.heightMm);
	return {
		kind: 'rect',
		spec,
		border: 0,
		autoFind: false,
		watchdog: false,
		trackEvery: 1,
		gridFor(corners) {
			// The material oriented like the registered quad (portrait: quadAspect < 1).
			const portrait = !!corners && quadAspect(corners) < 1;
			const g = acuityGrid(portrait ? { materialWidthMm: short, materialHeightMm: long } : { materialWidthMm: long, materialHeightMm: short });
			return { cols: g.cols, rows: g.rows };
		},
		planeCorners: (g) => [
			[-0.5, -0.5],
			[g.cols - 0.5, -0.5],
			[g.cols - 0.5, g.rows - 0.5],
			[-0.5, g.rows - 0.5],
		],
		toUV(c, r, g) {
			const { u, v } = acuityCellCenter(r * g.cols + c, g);
			return [u, v];
		},
		validate: (corners, frame) => {
			const c = checkSurfaceQuad(corners, frame);
			return { ok: c.ok, reason: c.reason };
		},
		movementCells: () => MOVEMENT_THRESHOLD_PINS,
		createTracker: (env) => (spec.tracking === 'static' ? createStaticTracker() : createAkazeTracker({ ...env.akaze, loadEngine: env.loadEngine ?? null })),
		prompts: {
			corners: CORNER_PROMPT_CODES as SurfacePrompts['corners'],
			cornersRejected: 'register.cornersRejected',
			done: 'register.done',
			static: 'tracking.surface.static',
		},
	};
}

/** Build the profile for a surface spec. */
export function createSurfaceProfile(spec: SurfaceSpec): SurfaceProfile {
	if (spec?.kind === 'dotpad') return dotpadProfile(spec);
	if (spec?.kind === 'rect') {
		const m = spec.material;
		if (m && !(m.widthMm > 0 && m.heightMm > 0)) throw new TypeError(`CamioPointer: surface.material must have positive widthMm and heightMm, got ${JSON.stringify(m)}`);
		return rectProfile(spec);
	}
	throw new TypeError(`CamioPointer: unknown surface ${JSON.stringify(spec)}`);
}
