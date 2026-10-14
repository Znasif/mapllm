/**
 * The Audiom integration maps a DOT Pad 'point' event (surface 'dotpad') to a
 * world position with
 *
 *   world = (bounds.left + col·metersPerPin, bounds.top − row·metersPerPin),
 *   bounds = tactileWorldBounds(renderer.viewport)
 *
 * and skips pins in the `overlapPins` border. This checks, against a verbatim
 * copy of Audiom's src/modules/tactile/viewport.ts (origin/master), that the
 * mapping is the exact inverse of worldToPin for every pin, and that a
 * non-border pin never makes panViewportToKeepAvatar page the viewport (a
 * border pin would — the page would jump under the finger).
 */
import { describe, expect, it } from 'vitest';

/* ---- copied from Audiom src/modules/tactile/viewport.ts (types simplified) ---- */
type WorldPosition = [number, number];
interface TactileViewport {
	center: WorldPosition;
	width: number;
	height: number;
	metersPerPin: number;
	overlapPins: number;
}
const worldPosition = (x: number, y: number): WorldPosition => [x, y];
function tactileWorldBounds(viewport: TactileViewport) {
	const left = viewport.center[0] - Math.floor(viewport.width / 2) * viewport.metersPerPin;
	const top = viewport.center[1] + Math.floor(viewport.height / 2) * viewport.metersPerPin;
	return {
		left,
		right: left + (viewport.width - 1) * viewport.metersPerPin,
		top,
		bottom: top - (viewport.height - 1) * viewport.metersPerPin,
	};
}
function worldToPin(position: WorldPosition, viewport: TactileViewport): [number, number] {
	const bounds = tactileWorldBounds(viewport);
	return [
		Math.round((position[0] - bounds.left) / viewport.metersPerPin),
		Math.round((bounds.top - position[1]) / viewport.metersPerPin),
	];
}
function panViewportToKeepAvatar(viewport: TactileViewport, avatarPosition: WorldPosition): TactileViewport {
	const horizontalPage = viewport.width - 2 * viewport.overlapPins;
	const verticalPage = viewport.height - 2 * viewport.overlapPins;
	let centerX = viewport.center[0];
	let centerY = viewport.center[1];
	let candidate = viewport;
	let [pinX, pinY] = worldToPin(avatarPosition, candidate);
	const maxX = viewport.width - 1 - viewport.overlapPins;
	const maxY = viewport.height - 1 - viewport.overlapPins;
	while (pinX < viewport.overlapPins) {
		centerX -= horizontalPage * viewport.metersPerPin;
		candidate = { ...viewport, center: worldPosition(centerX, centerY) };
		[pinX, pinY] = worldToPin(avatarPosition, candidate);
	}
	while (pinX > maxX) {
		centerX += horizontalPage * viewport.metersPerPin;
		candidate = { ...viewport, center: worldPosition(centerX, centerY) };
		[pinX, pinY] = worldToPin(avatarPosition, candidate);
	}
	while (pinY < viewport.overlapPins) {
		centerY += verticalPage * viewport.metersPerPin;
		candidate = { ...viewport, center: worldPosition(centerX, centerY) };
		[pinX, pinY] = worldToPin(avatarPosition, candidate);
	}
	while (pinY > maxY) {
		centerY -= verticalPage * viewport.metersPerPin;
		candidate = { ...viewport, center: worldPosition(centerX, centerY) };
		[pinX, pinY] = worldToPin(avatarPosition, candidate);
	}
	if (centerX === viewport.center[0] && centerY === viewport.center[1]) return viewport;
	return candidate;
}
/* ---- end of copy ---- */

/** The mapping used in AUDIOM_INTEGRATION.md's createCamioController.ts (DOT Pad surface). */
function pinToWorld(viewport: TactileViewport, col: number, row: number): WorldPosition {
	const bounds = tactileWorldBounds(viewport);
	return worldPosition(bounds.left + col * viewport.metersPerPin, bounds.top - row * viewport.metersPerPin);
}

describe('pin → world is the exact inverse of Audiom worldToPin', () => {
	const viewports: TactileViewport[] = [
		{ center: [0, 0], width: 60, height: 40, metersPerPin: 1, overlapPins: 2 },
		{ center: [1234.567, -89.01], width: 60, height: 40, metersPerPin: 0.3048, overlapPins: 2 },
		{ center: [-5e5 + 0.1, 3e6 - 0.7], width: 60, height: 40, metersPerPin: 1.37, overlapPins: 2 },
		{ center: [17.25, 42.5], width: 60, height: 40, metersPerPin: 3, overlapPins: 2 },
	];
	for (const vp of viewports) {
		it(`center ${vp.center}, ${vp.metersPerPin} m/pin`, () => {
			let wrong = 0;
			let pagedInner = 0;
			let pagedBorder = 0;
			for (let row = 0; row < vp.height; row++)
				for (let col = 0; col < vp.width; col++) {
					const w = pinToWorld(vp, col, row);
					const [px, py] = worldToPin(w, vp);
					if (px !== col || py !== row) wrong++;
					const inBorder = col < vp.overlapPins || row < vp.overlapPins || col > vp.width - 1 - vp.overlapPins || row > vp.height - 1 - vp.overlapPins;
					const paged = panViewportToKeepAvatar(vp, w) !== vp;
					if (paged && !inBorder) pagedInner++;
					if (paged && inBorder) pagedBorder++;
				}
			expect(wrong).toBe(0);
			expect(pagedInner).toBe(0);
			// Every border pin pages the viewport: that is why the integration skips them.
			expect(pagedBorder).toBe(2 * vp.overlapPins * (vp.width + vp.height) - 4 * vp.overlapPins * vp.overlapPins);
		});
	}
});
