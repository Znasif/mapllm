/**
 * Prompt CODES with default English text. The library never speaks: it emits
 * `{code, text, params}` on the 'prompt' event and the host localises the code
 * (Audiom: `t('camio.prompt.' + code, {defaultValue: text, ...params})`) and
 * announces it through its own speech/live region.
 */

export const PROMPTS = Object.freeze({
	'register.handsOff': 'Hands off the DOT Pad.',
	'register.searching': 'Finding the DOT Pad.',
	/* Corner dwell: shared by the DOT Pad and any other rectangle. */
	'register.corner.topLeft': 'Point at the top-left corner and hold.',
	'register.corner.topRight': 'Top-right corner.',
	'register.corner.bottomRight': 'Bottom-right corner.',
	'register.corner.bottomLeft': 'Bottom-left corner.',
	'register.cornersRejected': 'Corners not usable. Try again.',
	'register.liftHand': 'Got it. Lift your hand.',
	'register.confirmTopLeft': 'Found it. Touch the top-left pin.',
	'register.confirmMissed': 'Not a corner. Use the corners instead.',
	'register.notFound': 'DOT Pad not found. Register by corners.',
	'register.done': 'Registered.',
	'register.cancelled': 'Cancelled.',
	/** The tracked pointing hand changed (CamIO res["hand_side"]). */
	'pointing.hand.left': 'Left hand',
	'pointing.hand.right': 'Right hand',
	'tracking.lost': 'Lost the DOT Pad. Hands off for a moment.',
	'tracking.restored': 'Found it again.',
	'tracking.moved': 'DOT Pad moved. Re-registered.',
	'tracking.pinsNotVisible': "Can't see the pins. Keep the DOT Pad still.",
	/** Rect surface: the tracker cannot follow it (too few features, or OpenCV failed to load). */
	'tracking.surface.static': 'Too plain to follow. Keep it still.',
	'camera.noFrames': 'No camera picture. Close other apps using the camera.',
	'camera.denied': 'Camera blocked. Allow it for this page.',
});

export type PromptCode = keyof typeof PROMPTS;

/** Payload of the 'prompt' event. */
export interface PromptEvent {
	code: PromptCode;
	/** Default English text; localise by `code`. */
	text: string;
	/** Interpolation values, if any. */
	params?: Record<string, string | number>;
}

/** The corner prompts, TL, TR, BR, BL (both surfaces). */
export const CORNER_PROMPT_CODES: PromptCode[] = [
	'register.corner.topLeft',
	'register.corner.topRight',
	'register.corner.bottomRight',
	'register.corner.bottomLeft',
];

export const prompt = (code: PromptCode, params?: Record<string, string | number>): PromptEvent =>
	params ? { code, text: PROMPTS[code], params } : { code, text: PROMPTS[code] };
