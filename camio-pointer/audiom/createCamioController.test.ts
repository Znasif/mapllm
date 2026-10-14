import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TactileTool } from '../TactileTool';
import { tactileWorldBounds, worldToPin } from '../viewport';
import { createCamioController } from './createCamioController';

type Listener = (payload: never) => void;

const mocked = vi.hoisted(() => ({
	listeners: new Map<string, Listener>(),
	start: vi.fn(async () => {}),
	stop: vi.fn(),
	dispose: vi.fn(),
	register: vi.fn(async () => null),
	setSurface: vi.fn(),
	surface: 'dotpad' as string,
	registration: null as unknown,
	options: null as unknown,
}));

vi.mock('../../../vendor/camio/CamioPointer-0.2.0.js', () => ({
	createCamioPointer: (options: { surface: { kind: string } }) => {
		mocked.options = options;
		mocked.surface = options.surface.kind;
		return {
			on: (type: string, listener: Listener) => {
				mocked.listeners.set(type, listener);
				return () => {};
			},
			start: mocked.start,
			stop: mocked.stop,
			dispose: mocked.dispose,
			register: mocked.register,
			setSurface: (spec: { kind: string }) => {
				mocked.surface = spec.kind;
				mocked.setSurface(spec);
			},
			get surface() {
				return mocked.surface;
			},
			registerByCorners: vi.fn(),
			cancel: vi.fn(),
			get registration() {
				return mocked.registration;
			},
			status: { phase: 'idle', tracking: 'none' },
			running: true,
		};
	},
}));

const emit = (type: string, payload: unknown) =>
	(mocked.listeners.get(type) as (p: unknown) => void)(payload);

const makeHarness = (
	extentBounds: number[] | null = [-200, -100, 400, 300],
) => {
	const viewport = {
		center: [100, 50],
		width: 60,
		height: 40,
		metersPerPin: 0.5,
		overlapPins: 2,
	};
	const setPosition = vi.fn();
	const deactivate = vi.fn();
	const activate = vi.fn(() => deactivate);
	const tactileTool = {
		renderer: {
			viewport,
			world: { avatar: { setPosition }, extentBounds },
			activate,
		},
	} as unknown as TactileTool;
	const announce = vi.fn();
	const stopSpeech = vi.fn();
	const onStatusChange = vi.fn();
	const controller = createCamioController({
		tactileTool,
		announce,
		translate: (code, text, params) =>
			`[${code}] ${text}${params ? ` ${JSON.stringify(params)}` : ''}`,
		stopSpeech,
		onStatusChange,
		noExtentMessage: 'No map edges here. Use a DOT Pad.',
	});
	return {
		controller,
		viewport,
		setPosition,
		activate,
		deactivate,
		announce,
		stopSpeech,
		onStatusChange,
	};
};

beforeEach(() => {
	mocked.listeners.clear();
	mocked.registration = null;
	mocked.options = null;
	mocked.surface = 'dotpad';
	vi.clearAllMocks();
});

describe('createCamioController', () => {
	it('loads lazily, starts the camera and registers when unregistered', async () => {
		const { controller } = makeHarness();
		expect(mocked.options).toBeNull();
		await controller.start();
		expect(mocked.options).toMatchObject({
			assetsBase: '/vendor/mediapipe/',
			opencvUrl: '/vendor/opencv/opencv.js',
			surface: { kind: 'dotpad', border: 2 },
		});
		expect(mocked.start).toHaveBeenCalledOnce();
		expect(mocked.register).toHaveBeenCalledOnce();
	});

	it('DOT Pad: moves the avatar onto the pointed pin (inverse of worldToPin), never in the border', async () => {
		const { controller, viewport, setPosition } = makeHarness();
		await controller.start();
		emit('point', {
			surface: 'dotpad',
			col: 17,
			row: 9,
			u: 0,
			v: 0,
			inBorder: false,
		});
		const [position] = setPosition.mock.calls[0];
		const bounds = tactileWorldBounds(viewport as never);
		expect(position).toEqual([bounds.left + 17 * 0.5, bounds.top - 9 * 0.5]);
		expect(worldToPin(position, viewport as never)).toEqual([17, 9]);
		emit('point', {
			surface: 'dotpad',
			col: 1,
			row: 9,
			u: 0,
			v: 0,
			inBorder: true,
		});
		expect(setPosition).toHaveBeenCalledOnce();
	});

	it('rect: (u, v) spans the map extent, top-left = north-west', async () => {
		const { controller, setPosition, activate } = makeHarness();
		controller.setSurface('rect');
		await controller.start();
		expect(mocked.options).toMatchObject({ surface: { kind: 'rect' } });
		expect(activate).not.toHaveBeenCalled();
		emit('point', {
			surface: 'rect',
			col: 0,
			row: 0,
			u: 0,
			v: 0,
			inBorder: false,
		});
		emit('point', {
			surface: 'rect',
			col: 117,
			row: 83,
			u: 1,
			v: 1,
			inBorder: false,
		});
		emit('point', {
			surface: 'rect',
			col: 59,
			row: 42,
			u: 0.25,
			v: 0.5,
			inBorder: false,
		});
		expect(setPosition.mock.calls.map(([p]) => p)).toEqual([
			[-200, 300],
			[400, -100],
			[-50, 100],
		]);
	});

	it('rect without a map extent: start announces and stays off', async () => {
		const { controller, announce, onStatusChange } = makeHarness(null);
		controller.setSurface('rect');
		await controller.start();
		expect(announce).toHaveBeenCalledWith('No map edges here. Use a DOT Pad.');
		expect(onStatusChange).toHaveBeenLastCalledWith({ phase: 'off' });
		expect(mocked.options).toBeNull();
		expect(mocked.start).not.toHaveBeenCalled();
	});

	it('activates the pin frame only while running on the DOT Pad', async () => {
		const { controller, activate, deactivate } = makeHarness();
		await controller.start();
		expect(activate).toHaveBeenCalledOnce();
		controller.setSurface('rect');
		expect(deactivate).toHaveBeenCalledOnce();
		controller.setSurface('dotpad');
		expect(activate).toHaveBeenCalledTimes(2);
	});

	it('setSurface while running switches the library pointer and registers', async () => {
		const { controller } = makeHarness();
		await controller.start();
		mocked.register.mockClear();
		controller.setSurface('rect');
		expect(mocked.setSurface).toHaveBeenCalledWith({ kind: 'rect' });
		expect(mocked.register).toHaveBeenCalledOnce();
		expect(controller.surface).toBe('rect');
		controller.setSurface('rect');
		expect(mocked.setSurface).toHaveBeenCalledOnce();
	});

	it('setSurface to rect while running with no extent stops and announces', async () => {
		const { controller, announce, onStatusChange } = makeHarness(null);
		await controller.start();
		controller.setSurface('rect');
		expect(mocked.stop).toHaveBeenCalled();
		expect(mocked.setSurface).not.toHaveBeenCalled();
		expect(announce).toHaveBeenCalledWith('No map edges here. Use a DOT Pad.');
		expect(onStatusChange).toHaveBeenLastCalledWith({ phase: 'off' });
	});

	it('a late DOT Pad point after switching to rect still maps as a pin', async () => {
		const { controller, viewport, setPosition } = makeHarness();
		await controller.start();
		controller.setSurface('rect');
		emit('point', {
			surface: 'dotpad',
			col: 17,
			row: 9,
			u: 0.3,
			v: 0.2,
			inBorder: false,
		});
		const bounds = tactileWorldBounds(viewport as never);
		expect(setPosition.mock.calls[0][0]).toEqual([
			bounds.left + 8.5,
			bounds.top - 4.5,
		]);
	});

	it('announces localised prompts, including the tracked hand, and forwards status', async () => {
		const { controller, announce, onStatusChange } = makeHarness();
		await controller.start();
		emit('prompt', { code: 'register.done', text: 'Registered.' });
		expect(announce).toHaveBeenCalledWith('[register.done] Registered.');
		emit('prompt', { code: 'pointing.hand.left', text: 'Left hand' });
		expect(announce).toHaveBeenLastCalledWith('[pointing.hand.left] Left hand');
		emit('prompt', { code: 'some.code', text: 'Text', params: { n: 2 } });
		expect(announce).toHaveBeenLastCalledWith('[some.code] Text {"n":2}');
		emit('status', {
			phase: 'ready',
			tracking: 'tracking',
			gesture: 'pointing',
			side: 'right',
		});
		expect(onStatusChange).toHaveBeenLastCalledWith({
			phase: 'ready',
			tracking: 'tracking',
			gesture: 'pointing',
			side: 'right',
		});
	});

	it('stops speech when an open hand is shown, without moving the avatar', async () => {
		const { controller, stopSpeech, setPosition, announce } = makeHarness();
		await controller.start();
		expect(stopSpeech).not.toHaveBeenCalled();
		emit('openHand', { side: 'left' });
		expect(stopSpeech).toHaveBeenCalledOnce();
		emit('openHand', { side: null });
		expect(stopSpeech).toHaveBeenCalledTimes(2);
		expect(setPosition).not.toHaveBeenCalled();
		expect(announce).not.toHaveBeenCalled();
	});

	it('stop and dispose release the camera and the renderer', async () => {
		const { controller, deactivate, onStatusChange } = makeHarness();
		await controller.start();
		controller.stop();
		expect(mocked.stop).toHaveBeenCalled();
		expect(deactivate).toHaveBeenCalledOnce();
		expect(onStatusChange).toHaveBeenLastCalledWith({ phase: 'off' });
		controller.dispose();
		expect(mocked.dispose).toHaveBeenCalledOnce();
	});

	it('reports a failed start as off and lets the next start retry', async () => {
		const { controller, deactivate, onStatusChange } = makeHarness();
		mocked.start.mockRejectedValueOnce(new Error('camera denied'));
		await expect(controller.start()).rejects.toThrow('camera denied');
		expect(onStatusChange).toHaveBeenLastCalledWith({ phase: 'off' });
		expect(deactivate).toHaveBeenCalledOnce();
		await controller.start();
		expect(mocked.start).toHaveBeenCalledTimes(2);
	});

	it('never opens the camera when switched off while the chunk loads', async () => {
		const { controller, onStatusChange, deactivate } = makeHarness();
		const starting = controller.start();
		controller.stop();
		await starting;
		expect(mocked.start).not.toHaveBeenCalled();
		expect(deactivate).not.toHaveBeenCalled();
		expect(onStatusChange).toHaveBeenLastCalledWith({ phase: 'off' });
	});

	it('closes the camera again when switched off while it opens', async () => {
		const { controller, onStatusChange, deactivate } = makeHarness();
		let opened = () => {};
		mocked.start.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					opened = resolve;
				}),
		);
		const starting = controller.start();
		await vi.waitFor(() => expect(mocked.start).toHaveBeenCalledOnce());
		controller.stop();
		opened();
		await starting;
		// Once by stop(), once more for the camera that finished opening late.
		expect(mocked.stop).toHaveBeenCalledTimes(2);
		expect(deactivate).toHaveBeenCalledOnce();
		expect(mocked.register).not.toHaveBeenCalled();
		expect(onStatusChange).toHaveBeenLastCalledWith({ phase: 'off' });
	});

	it('does nothing after dispose', async () => {
		const { controller, onStatusChange } = makeHarness();
		controller.dispose();
		await controller.start();
		expect(mocked.options).toBeNull();
		expect(onStatusChange).not.toHaveBeenCalled();
	});
});
