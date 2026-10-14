import { worldPosition } from '../../../types/coordinates';
import type {
	CamioPointer,
	PointerStatus,
	SurfaceSpec,
} from '../../../vendor/camio/CamioPointer-0.2.0.js';
import type { TactileTool } from '../TactileTool';
import { tactileWorldBounds } from '../viewport';

export type CamioPointerStatus = PointerStatus | { phase: 'off' | 'starting' };

/** Where the camera points: the DOT Pad's pins, or any other rectangle (a printed map). */
export type CamioSurface = 'dotpad' | 'rect';

export interface CreateCamioControllerOptions {
	tactileTool: TactileTool;
	announce(message: string): void;
	/** Localise a library prompt code, e.g. t(`camio.prompt.${code}`, { defaultValue }). */
	translate(
		code: string,
		defaultValue: string,
		params?: Record<string, string | number>,
	): string;
	/**
	 * Run the app's stop-speech command. Called when an open hand is shown,
	 * the camera equivalent of the DOT Pad's stop-speech chord.
	 */
	stopSpeech(): void;
	onStatusChange(status: CamioPointerStatus): void;
	/** Announced when the map has no extent to put on a rectangle. */
	noExtentMessage: string;
	/** Where public/vendor/mediapipe is served. */
	assetsBase?: string;
	/** Where public/vendor/opencv/opencv.js is served (loaded only for a rect surface). */
	opencvUrl?: string;
}

/**
 * Camera pointer: the cell under a pointing fingertip moves the avatar there,
 * and an open hand stops speech. On the DOT Pad the cell is a pin of the
 * tactile viewport; on any other rectangle (registered by its four corners)
 * the sheet spans the map's extent, its top-left corner the north-west. The
 * vendored library (with the bundled MediaPipe JS) is a lazy chunk, loaded only
 * when the pointer is first started; OpenCV.js is fetched only for a rect
 * surface. All camera processing stays on the device.
 */
export function createCamioController(options: CreateCamioControllerOptions) {
	const { renderer } = options.tactileTool;
	let pointer: CamioPointer | null = null;
	let loadPromise: Promise<CamioPointer> | null = null;
	let deactivate: (() => void) | null = null;
	let disposed = false;
	let surface: CamioSurface = 'dotpad';
	/**
	 * Bumped by every start and stop, so a start still waiting on the chunk
	 * or the camera can tell it was overtaken (switched off, or the DOT Pad
	 * went away) and must not leave the camera running.
	 */
	let attempt = 0;
	/** Whether the latest start or stop asked for the camera to be on. */
	let wanted = false;

	const spec = (kind: CamioSurface): SurfaceSpec =>
		kind === 'dotpad'
			? { kind: 'dotpad', border: renderer.viewport.overlapPins }
			: { kind: 'rect' };

	/** [minX, minY, maxX, maxY] of the map, or null when it has none (or no area). */
	const extent = () => {
		const e = renderer.world.extentBounds;
		if (!e) return null;
		const [minX, minY, maxX, maxY] = e;
		return maxX > minX && maxY > minY ? e : null;
	};

	/** Hold the pin frame live only while the camera drives the avatar on the DOT Pad. */
	const syncActivation = () => {
		const want = wanted && surface === 'dotpad' && !disposed;
		if (want) deactivate ??= renderer.activate();
		else {
			deactivate?.();
			deactivate = null;
		}
	};

	const load = () => {
		loadPromise ??= import(
			/* webpackChunkName: "camio-pointer" */ '../../../vendor/camio/CamioPointer-0.2.0.js'
		).then(({ createCamioPointer }) => {
			if (disposed) throw new Error('Camio pointer was disposed');
			const created = createCamioPointer({
				assetsBase: options.assetsBase ?? '/vendor/mediapipe/',
				opencvUrl: options.opencvUrl ?? '/vendor/opencv/opencv.js',
				surface: spec(surface),
			});
			created.on('prompt', ({ code, text, params }) =>
				options.announce(options.translate(code, text, params)),
			);
			created.on('status', (status) => options.onStatusChange(status));
			created.on('openHand', () => options.stopSpeech());
			created.on('point', (p) => {
				// The event's own surface, so a late event after a switch is safe.
				if (p.surface === 'dotpad') {
					// The overlap band pages the viewport: a finger resting there must not.
					if (p.inBorder) return;
					const { viewport, world } = renderer;
					const bounds = tactileWorldBounds(viewport);
					world.avatar.setPosition(
						worldPosition(
							bounds.left + p.col * viewport.metersPerPin,
							bounds.top - p.row * viewport.metersPerPin,
						),
					);
					return;
				}
				const e = extent();
				if (!e) return;
				const [minX, minY, maxX, maxY] = e;
				renderer.world.avatar.setPosition(
					worldPosition(minX + p.u * (maxX - minX), maxY - p.v * (maxY - minY)),
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
		attempt += 1;
		wanted = false;
		pointer?.stop();
		syncActivation();
		options.onStatusChange({ phase: 'off' });
	};

	const noExtent = () => {
		options.announce(options.noExtentMessage);
		options.onStatusChange({ phase: 'off' });
	};

	return {
		preload: () => {
			if (disposed) return;
			load().catch(() => {
				// A preload failure is silent: start() reports it.
			});
		},
		/** Load, open the camera, and register the surface if not registered yet. */
		start: async () => {
			if (disposed) return;
			if (surface === 'rect' && !extent()) {
				attempt += 1;
				wanted = false;
				noExtent();
				return;
			}
			const current = ++attempt;
			wanted = true;
			const overtaken = () => disposed || current !== attempt;
			options.onStatusChange({ phase: 'starting' });
			try {
				const loaded = await load();
				if (overtaken()) return;
				if (loaded.surface !== surface) loaded.setSurface(spec(surface));
				syncActivation();
				await loaded.start();
				if (overtaken()) {
					// Switched off while the camera was opening: close it again,
					// unless a newer start is already reusing it.
					if (!disposed && !wanted) loaded.stop();
					return;
				}
				options.onStatusChange(loaded.status);
				if (!loaded.registration) void loaded.register();
			} catch (error) {
				if (overtaken()) return;
				stop();
				throw error;
			}
		},
		stop,
		/** Switch surface; while running the new one is registered right away. */
		setSurface: (next: CamioSurface) => {
			if (disposed || next === surface) return;
			surface = next;
			if (!wanted || !pointer?.running) {
				if (pointer && pointer.surface !== next) pointer.setSurface(spec(next));
				return;
			}
			if (next === 'rect' && !extent()) {
				stop();
				options.announce(options.noExtentMessage);
				return;
			}
			pointer.setSurface(spec(next));
			syncActivation();
			void pointer.register();
		},
		get surface() {
			return surface;
		},
		get active() {
			return pointer?.running ?? false;
		},
		register: () => pointer?.register(),
		registerByCorners: () => pointer?.registerByCorners(),
		cancelRegistration: () => pointer?.cancel(),
		dispose: () => {
			disposed = true;
			wanted = false;
			deactivate?.();
			deactivate = null;
			pointer?.dispose();
			pointer = null;
			loadPromise = null;
		},
	};
}
