/**
 * CamioDotPad — camera fingertip pointer for the DOT Pad (60 × 40 pins).
 *
 * Registers the pin field from the camera (auto: the pin lattice itself; or by
 * dwelling on the four corner pins), follows the pad with a pure-JS
 * lattice-follow tracker (no OpenCV), and emits the pin under a pointing
 * index fingertip. Framework-free; never speaks (prompt codes + English
 * defaults); all processing on-device.
 */

export { createDotPadPointer } from './pointer';
export type { DotPadPointer, DotPadPointerOptions } from './pointer';
export { PointerCore, CORE_DEFAULTS } from './core';
export type {
	CoreEvents,
	CoreOptions,
	PinEvent,
	Phase,
	PointerStatus,
	Registration,
	TrackingStatus,
} from './core';
export { PROMPTS } from './prompts';
export type { PromptCode, PromptEvent } from './prompts';
export { createLatticeTracker, createStaticTracker, lumaFrame, LATTICE_TRACKER_DEFAULTS } from './tracker';
export type { LatticeTrackerOptions, LumaFrame, TrackHints, TrackState, TrackStep, Tracker } from './tracker';
export { createMediaPipeHandLandmarker, MEDIAPIPE_VERSION } from './mediapipe';
export type { HandLandmarkerFactory, HandLandmarkerFactoryOptions, HandLandmarkerLike } from './mediapipe';
export type { HandResult, Landmark } from './input';
export { aggregateDetections, detectDotpadLattice, latticeSearch } from './lattice';
export type { AggregatedDetection, LatticeDetection } from './lattice';
export { applyH, cornersOfPose, invert3, poseFromCorners } from './geometry';
export type { Mat3, Point } from './geometry';
export { rgbaToGray } from './imageops';
export type { GrayImage } from './imageops';

/** Library version (matches the vendored file name). */
export const VERSION = '0.1.0';
