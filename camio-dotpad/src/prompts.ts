/**
 * Prompt CODES with default English text. The library never speaks: it emits
 * `{code, text, params}` on the 'prompt' event and the host localises the code
 * (Audiom: `t('camio.prompt.' + code, {defaultValue: text, ...params})`) and
 * announces it through its own speech/live region.
 */

export const PROMPTS = Object.freeze({
	'register.handsOff': 'Take your hands off the DOT Pad.',
	'register.searching': 'Looking for the DOT Pad pins.',
	'register.corner.topLeft': 'Point at the top-left corner pin of the DOT Pad and hold.',
	'register.corner.topRight': 'Point at the top-right corner pin and hold.',
	'register.corner.bottomRight': 'Point at the bottom-right corner pin and hold.',
	'register.corner.bottomLeft': 'Point at the bottom-left corner pin and hold.',
	'register.cornersRejected': "Those corners don't look like the pin area. Let's try again.",
	'register.liftHand': 'Got it. Lift your hand for a moment.',
	'register.confirmTopLeft': 'Found the DOT Pad. Touch the top-left pin and hold.',
	'register.confirmMissed': "That wasn't near a corner pin. Let's register by the corners instead.",
	'register.notFound': "I couldn't find the DOT Pad. Try registering it by its corners.",
	'register.done': 'DOT Pad registered. Point at the pins.',
	'register.cancelled': 'Registration cancelled.',
	'pointing.oneHand': 'Point with only one hand.',
	'tracking.lost': 'Lost track of the DOT Pad. Take your hands off it for a moment.',
	'tracking.restored': 'Found the DOT Pad again.',
	'tracking.moved': 'The DOT Pad moved. Re-registered.',
	'tracking.pinsNotVisible': "I can't see the pins, so moving the DOT Pad won't be noticed until they are visible.",
	'camera.noFrames': 'The camera opened but sent no pictures. Close other apps using it and try again.',
	'camera.denied': 'Camera access was blocked. Allow the camera for this page to use the pointer.',
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

export const CORNER_PROMPT_CODES: PromptCode[] = [
	'register.corner.topLeft',
	'register.corner.topRight',
	'register.corner.bottomRight',
	'register.corner.bottomLeft',
];

export const prompt = (code: PromptCode, params?: Record<string, string | number>): PromptEvent =>
	params ? { code, text: PROMPTS[code], params } : { code, text: PROMPTS[code] };
