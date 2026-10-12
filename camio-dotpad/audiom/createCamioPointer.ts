import { worldPosition } from '../../../types/coordinates';
import type {
	DotPadPointer,
	PointerStatus,
} from '../../../vendor/camio/CamioDotPad-0.1.0.js';
import type { TactileTool } from '../TactileTool';
import { tactileWorldBounds } from '../viewport';

export type CamioPointerStatus = PointerStatus | { phase: 'off' | 'starting' };

export interface CreateCamioPointerOptions {
	tactileTool: TactileTool;
	announce(message: string): void;
	/** Localise a library prompt code, e.g. t(`camio.prompt.${code}`, { defaultValue }). */
	translate(code: string, defaultValue: string): string;
	onStatusChange(status: CamioPointerStatus): void;
	/** Where public/vendor/mediapipe is served. */
	assetsBase?: string;
}

/**
 * Camera pointer for the DOT Pad: the pin under a pointing fingertip moves the
 * avatar there. The vendored library (and the bundled MediaPipe JS in it) is a
 * lazy chunk, loaded only when the pointer is first started; all camera
 * processing stays on the device.
 */
export function createCamioPointer(options: CreateCamioPointerOptions) {
	const { renderer } = options.tactileTool;
	let pointer: DotPadPointer | null = null;
	let loadPromise: Promise<DotPadPointer> | null = null;
	let deactivate: (() => void) | null = null;
	let disposed = false;

	const load = () => {
		loadPromise ??= import(
			/* webpackChunkName: "camio-dotpad" */ '../../../vendor/camio/CamioDotPad-0.1.0.js'
		).then(({ createDotPadPointer }) => {
			if (disposed) throw new Error('Camio pointer was disposed');
			const created = createDotPadPointer({
				assetsBase: options.assetsBase ?? '/vendor/mediapipe/',
				border: renderer.viewport.overlapPins,
			});
			created.on('prompt', ({ code, text }) =>
				options.announce(options.translate(code, text)),
			);
			created.on('status', (status) => options.onStatusChange(status));
			created.on('pin', ({ x, y, inBorder }) => {
				// The overlap band pages the viewport: a finger resting there must not.
				if (inBorder) return;
				const { viewport, world } = renderer;
				const bounds = tactileWorldBounds(viewport);
				world.avatar.setPosition(
					worldPosition(
						bounds.left + x * viewport.metersPerPin,
						bounds.top - y * viewport.metersPerPin,
					),
				);
			});
			pointer = created;
			return created;
		});
		const pending = loadPromise;
		// A failed chunk load must not stay cached (same as the DOT Pad SDK).
		pending.catch(() => {
			if (loadPromise === pending) loadPromise = null;
		});
		return pending;
	};

	const stop = () => {
		pointer?.stop();
		deactivate?.();
		deactivate = null;
		options.onStatusChange({ phase: 'off' });
	};

	return {
		preload: () => {
			if (disposed) return;
			load().catch(() => {
				// A preload failure is silent: start() reports it.
			});
		},
		/** Load, open the camera, and auto-register if not registered yet. */
		start: async () => {
			if (disposed) return;
			options.onStatusChange({ phase: 'starting' });
			try {
				const loaded = await load();
				// Keep the pin frame live while the camera drives the avatar.
				deactivate ??= renderer.activate();
				await loaded.start();
				options.onStatusChange(loaded.status);
				if (!loaded.registration) void loaded.autoRegister();
			} catch (error) {
				stop();
				throw error;
			}
		},
		stop,
		get active() {
			return pointer?.running ?? false;
		},
		autoRegister: () => pointer?.autoRegister(),
		registerByCorners: () => pointer?.registerByCorners(),
		cancelRegistration: () => pointer?.cancel(),
		dispose: () => {
			disposed = true;
			deactivate?.();
			deactivate = null;
			pointer?.dispose();
			pointer = null;
			loadPromise = null;
		},
	};
}
