/**
 * CamioPointer — camera fingertip pointer for tactile surfaces.
 *
 * DOT Pad (60 × 40 pins): registers the pin field from the camera (auto: the
 * pin lattice itself; or by dwelling on the four corner pins) and follows the
 * pad with a pure-JS lattice-follow tracker (no OpenCV).
 * Any other rectangle (a printed map, a tactile graphic): registered by
 * dwelling on its four corners, quantised at the 2.5 mm fingertip-acuity
 * floor, and followed with the starter's AKAZE tracking (OpenCV.js, loaded
 * on demand, in a Web Worker).
 * Emits the cell under a pointing index fingertip. Framework-free; never speaks
 * (prompt codes + English defaults); all processing on-device.
 */

export { createCamioPointer } from './pointer';
export type { CamioPointer, CamioPointerOptions } from './pointer';
export { PointerCore, CORE_DEFAULTS } from './core';
export type {
	CoreEvents,
	CoreOptions,
	OpenHandEvent,
	Phase,
	PointEvent,
	PointerGesture,
	PointerStatus,
	Registration,
	TrackerFactory,
	TrackingStatus,
} from './core';
export { A4_LANDSCAPE, ACUITY_FLOOR_MM, DOTPAD_GRID, acuityCellCenter, acuityGrid, clampUnit, createSurfaceProfile } from './surface';
export type { Grid, SurfaceKind, SurfacePrompts, SurfaceProfile, SurfaceSpec, TrackerEnv } from './surface';
export { PROMPTS } from './prompts';
export type { PromptCode, PromptEvent } from './prompts';
export { createLatticeTracker, createStaticTracker, lumaFrame, LATTICE_TRACKER_DEFAULTS } from './tracker';
export type { LatticeTrackerOptions, LumaFrame, TrackHints, TrackState, TrackStep, Tracker } from './tracker';
export { AKAZE_TRACKER_DEFAULTS, createAkazeTracker } from './akazeTracker';
export type { AkazeTrackerOptions } from './akazeTracker';
export { akazeWorkerSource, createAkazeEngine, createAkazeWorkerEngine, createInlineAkazeEngine } from './akaze';
export type { AkazeEngine, AkazeEngineFactory, AkazeEngineOptions, AkazeMatch } from './akaze';
export { loadOpenCvScript, OPENCV_VERSION, waitForOpenCV } from './opencv';
export { createMediaPipeHandLandmarker, MEDIAPIPE_VERSION } from './mediapipe';
export type { HandLandmarkerFactory, HandLandmarkerFactoryOptions, HandLandmarkerLike } from './mediapipe';
export type { AggregatedGesture, FrameGesture, GestureHand, GestureStatus, HandCategory, HandResult, HandSide, Landmark } from './input';
export { aggregateDetections, detectDotpadLattice, latticeSearch } from './lattice';
export type { AggregatedDetection, LatticeDetection } from './lattice';
export { applyH, cellPxOf, checkSurfaceQuad, cornersOfPose, invert3, poseFromCorners, quadArea } from './geometry';
export type { Mat3, Point } from './geometry';
export { rgbaToGray } from './imageops';
export type { GrayImage } from './imageops';

/** Library version (matches the vendored file name). */
export const VERSION = '0.2.0';
