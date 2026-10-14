/**
 * Importing the vendored bundle must not touch the camera, the DOM or the
 * network: every such global is trapped (recorded, not thrown) during import.
 */
import { afterAll, expect, it } from 'vitest';

const TRAPPED = ['document', 'window', 'navigator', 'fetch', 'XMLHttpRequest', 'WebSocket', 'Worker', 'location', 'OffscreenCanvas', 'requestAnimationFrame', 'WebAssembly', 'importScripts'];
const touched: string[] = [];
const saved = new Map<string, PropertyDescriptor | undefined>();

afterAll(() => {
	for (const [k, d] of saved) {
		if (d) Object.defineProperty(globalThis, k, d);
		else delete (globalThis as Record<string, unknown>)[k];
	}
});

it('import has no side effects on camera / DOM / network globals', async () => {
	for (const k of TRAPPED) {
		saved.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
		Object.defineProperty(globalThis, k, {
			configurable: true,
			get() {
				touched.push(k);
				return undefined;
			},
		});
	}
	const lib = await import('../dist/CamioPointer-0.2.0.js');
	const pointer = lib.createCamioPointer({ assetsBase: '/vendor/mediapipe/', surface: { kind: 'dotpad' } });
	pointer.setSurface({ kind: 'rect' });
	pointer.dispose();
	const rect = lib.createCamioPointer({ assetsBase: '/vendor/mediapipe/', opencvUrl: '/vendor/opencv/opencv.js', surface: { kind: 'rect' } });
	rect.dispose();
	for (const [k, d] of saved) {
		if (d) Object.defineProperty(globalThis, k, d);
		else delete (globalThis as Record<string, unknown>)[k];
	}
	saved.clear();
	expect(touched).toEqual([]);
	expect(typeof lib.createCamioPointer).toBe('function');
	expect(lib.VERSION).toBe('0.2.0');
});
