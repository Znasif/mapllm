import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TactileTool } from '../TactileTool';
import { tactileWorldBounds, worldToPin } from '../viewport';
import { createCamioPointer } from './createCamioPointer';

type Listener = (payload: never) => void;

const mocked = vi.hoisted(() => ({
	listeners: new Map<string, Listener>(),
	start: vi.fn(async () => {}),
	stop: vi.fn(),
	dispose: vi.fn(),
	autoRegister: vi.fn(async () => null),
	registration: null as unknown,
	options: null as unknown,
}));

vi.mock('../../../vendor/camio/CamioDotPad-0.1.0.js', () => ({
	createDotPadPointer: (options: unknown) => {
		mocked.options = options;
		return {
			on: (type: string, listener: Listener) => {
				mocked.listeners.set(type, listener);
				return () => {};
			},
			start: mocked.start,
			stop: mocked.stop,
			dispose: mocked.dispose,
			autoRegister: mocked.autoRegister,
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

const makeHarness = () => {
	const viewport = {
		center: [100, 50],
		width: 60,
		height: 40,
		metersPerPin: 0.5,
		overlapPins: 2,
	};
	const setPosition = vi.fn();
	const deactivate = vi.fn();
	const tactileTool = {
		renderer: {
			viewport,
			world: { avatar: { setPosition } },
			activate: vi.fn(() => deactivate),
		},
	} as unknown as TactileTool;
	const announce = vi.fn();
	const onStatusChange = vi.fn();
	const pointer = createCamioPointer({
		tactileTool,
		announce,
		translate: (code, text) => `[${code}] ${text}`,
		onStatusChange,
	});
	return {
		pointer,
		viewport,
		setPosition,
		deactivate,
		announce,
		onStatusChange,
	};
};

beforeEach(() => {
	mocked.listeners.clear();
	mocked.registration = null;
	vi.clearAllMocks();
});

describe('createCamioPointer', () => {
	it('loads lazily, starts the camera and auto-registers when unregistered', async () => {
		const { pointer } = makeHarness();
		expect(mocked.options).toBeNull();
		await pointer.start();
		expect(mocked.options).toMatchObject({
			assetsBase: '/vendor/mediapipe/',
			border: 2,
		});
		expect(mocked.start).toHaveBeenCalledOnce();
		expect(mocked.autoRegister).toHaveBeenCalledOnce();
	});

	it('moves the avatar onto the pointed pin (inverse of worldToPin), never in the border', async () => {
		const { pointer, viewport, setPosition } = makeHarness();
		await pointer.start();
		emit('pin', { x: 17, y: 9, inBorder: false });
		const [position] = setPosition.mock.calls[0];
		const bounds = tactileWorldBounds(viewport as never);
		expect(position).toEqual([bounds.left + 17 * 0.5, bounds.top - 9 * 0.5]);
		expect(worldToPin(position, viewport as never)).toEqual([17, 9]);
		emit('pin', { x: 1, y: 9, inBorder: true });
		expect(setPosition).toHaveBeenCalledOnce();
	});

	it('announces localised prompts and forwards status', async () => {
		const { pointer, announce, onStatusChange } = makeHarness();
		await pointer.start();
		emit('prompt', { code: 'register.done', text: 'DOT Pad registered.' });
		expect(announce).toHaveBeenCalledWith('[register.done] DOT Pad registered.');
		emit('status', { phase: 'ready', tracking: 'tracking' });
		expect(onStatusChange).toHaveBeenLastCalledWith({
			phase: 'ready',
			tracking: 'tracking',
		});
	});

	it('stop and dispose release the camera and the renderer', async () => {
		const { pointer, deactivate } = makeHarness();
		await pointer.start();
		pointer.stop();
		expect(mocked.stop).toHaveBeenCalled();
		expect(deactivate).toHaveBeenCalledOnce();
		pointer.dispose();
		expect(mocked.dispose).toHaveBeenCalledOnce();
	});
});
