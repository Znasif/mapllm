# Integrating CamioDotPad into Audiom

The camera pointer lets a DOT Pad user point at a pin and have the avatar jump
there. It is vendored exactly like the DOT Pad SDK (one ESM file + `.d.ts` +
Vitest smoke test, lazy-loaded), plus self-hosted MediaPipe assets. Everything
below was checked against `origin/master` @ `14e2c790` without touching the
Audiom checkout: the patch applies cleanly (`git apply --check`), the changed
and new files pass Audiom's `biome ci`, the new module type-checks with
Audiom's compiler options against the real `TactileTool` / `TactileRenderer` /
`viewport.ts`, and both test files pass under Vitest + jsdom.

**One-shot:** copy the files (§1), then
`git apply ../camio-dotpad/audiom/audiom-integration.patch` from the Audiom
root. The sections below explain each hunk.

## 1. Files to copy

```
camio-dotpad/dist/CamioDotPad-0.1.0.js       → src/vendor/camio/CamioDotPad-0.1.0.js
camio-dotpad/dist/CamioDotPad-0.1.0.d.ts     → src/vendor/camio/CamioDotPad-0.1.0.d.ts
camio-dotpad/dist/CamioDotPad-0.1.0.test.ts  → src/vendor/camio/CamioDotPad-0.1.0.test.ts
MediaPipe assets (see below)                 → public/vendor/mediapipe/
```

The `.js` is Biome-formatted with Audiom's own `biome.json` and starts with
`// biome-ignore-all lint: vendored build output …`, so `npx biome ci .` stays
green with no config change. Audiom's `tsc` uses the sibling `.d.ts` and does
not parse the `.js`.

MediaPipe assets (`dist/assets/MANIFEST.json`), served same-origin:

```
public/vendor/mediapipe/wasm/vision_wasm_internal.js          0.3 MB
public/vendor/mediapipe/wasm/vision_wasm_internal.wasm       11.2 MB
public/vendor/mediapipe/wasm/vision_wasm_nosimd_internal.js   0.3 MB   (fallback for
public/vendor/mediapipe/wasm/vision_wasm_nosimd_internal.wasm 10.5 MB    browsers without WASM SIMD)
public/vendor/mediapipe/hand_landmarker.task                  ~7.8 MB
```

```
node ../camio-dotpad/scripts/copy-assets.mjs public/vendor/mediapipe --fetch-model
#   --simd-only drops the non-SIMD pair (−10.8 MB; only Safari < 16.4 needs it)
```

The WASM must be MediaPipe **0.10.35**, the version bundled into the `.js`.
These are ~30 MB of binaries; use Git LFS or fetch them in the build if you
would rather not commit them. They are downloaded by the browser only when a
user switches the pointer on.

## 2. New module: `src/modules/tactile/camio/createCamioPointer.ts`

Mirrors `createDotPadController`: lazy `import()` with a webpack chunk name, a
failed chunk load is not cached, `dispose()` drops every reference, and
announcements go through Audiom's `announce`. The library emits prompt codes;
Audiom localises them.

```ts
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
```

A spec in Audiom's style ships with it:
`camio-dotpad/audiom/createCamioPointer.test.ts` → `src/modules/tactile/camio/`
(mocks the vendored module; checks lazy load, the pin → avatar mapping against
the real `worldToPin`, border skipping, prompt localisation, stop/dispose).

### Pin → world: the exact inverse of `worldToPin`

```
bounds = tactileWorldBounds(renderer.viewport)
world  = (bounds.left + x · metersPerPin, bounds.top − y · metersPerPin)
```

`worldToPin(world) = (round((world.x − left)/mpp), round((top − world.y)/mpp))
= (x, y)`. `camio-dotpad/test/audiomMapping.test.ts` checks this for all
2,400 pins on four viewports (including |coordinates| ~ 10⁶ m) against a
verbatim copy of `viewport.ts`, and that **no** non-border pin makes
`panViewportToKeepAvatar` page while **every** border pin would — hence
`border: renderer.viewport.overlapPins` and the `inBorder` skip.
`renderer.activate()` keeps the viewport following the avatar while the camera
drives it (released on stop).

## 3. Edits to existing files (all in `audiom/audiom-integration.patch`)

**`src/modules/tactile/index.ts`** (+4)

```ts
export {
	type CamioPointerStatus,
	createCamioPointer,
} from './camio/createCamioPointer';
```

**`src/components/MapViewer/MapViewer.tsx`** (+23): import `createCamioPointer`
next to `createDotPadController`, a field, the creation right after
`createDotPadController({...})`, dispose, stop on DOT Pad disconnect, and two
public methods for the store:

```ts
	camioPointer: ReturnType<typeof createCamioPointer> | null = null;
…
		this.camioPointer = createCamioPointer({
			tactileTool: this.tactileTool,
			announce: (message) => this.speak(message),
			translate: (code, defaultValue) =>
				this.props.t(`camio.prompt.${code}`, { defaultValue }),
			onStatusChange: (status) => mapState.setCamioPointerStatus(status),
		});
…   // in onConnectionChange:
				// The camera pointer is only offered while a DOT Pad is connected.
				if (connection.state === 'disconnected') this.camioPointer?.stop();
…   // in disposeTactile():
		this.camioPointer?.dispose();
		this.camioPointer = null;
…
	public toggleCamioPointer = async (): Promise<void> => {
		if (this.rootStore.mapState.camioPointerStatus.phase === 'off') {
			await this.camioPointer?.start();
		} else this.camioPointer?.stop();
	};

	public registerCamioPointerByCorners = (): void => {
		this.camioPointer?.registerByCorners();
	};
```

**`src/stores/MapStateStore.ts`** (+16 −1): `camioPointerStatus`
(`observable.ref`, default `{ phase: 'off' }`), `setCamioPointerStatus`
(action), and `toggleCamioPointer()` / `registerCamioPointerByCorners()`
forwarding to the MapViewer — the same pattern as `connectDotPadUsb`.

**`src/components/MapMenu/DotPadControls.tsx`** (+42): an optional
`cameraPointer` prop; while a DOT Pad is connected it renders a
`menuitemcheckbox` "Camera pointer" (with `aria-checked`), a "Register DOT Pad
by its corners" item while on, and a `role="status"` line. Uses the existing
`handleHardwareActionKeyDown` / `reportActionError`; existing tests are
unaffected (the prop is optional).

**`src/components/MapMenu/DisplayOptionsMenu.tsx`** (+12): builds the
`cameraPointer` prop from `mapState.camioPointerStatus` and passes it.

**`src/lib/build-embed-string.ts`** (+1 −1) and **`documentation/embedding.md`**
(+5): the generated iframe snippet becomes
`<iframe … allow="camera; fullscreen" allowfullscreen>` — without `camera` the
browser refuses the camera inside an embed (Audiom then announces
`camio.prompt.camera.denied`; nothing else changes). Existing embeds keep
working without the pointer. The existing test only checks for
`allowfullscreen`, which stays.

## 4. i18n (`public/locales/en/translation.json`, +52 −1)

The library never speaks; each prompt has a code and an English default.
`translate` above uses `t(\`camio.prompt.${code}\`, { defaultValue })`, so
missing locales fall back to the library's English. Added keys:

* `mainMenu.displayOptions.dotPad.cameraPointer`, `…cameraPointerRegister`
* `camio.prompt.*` (codes contain dots, so they nest):
  `register.{handsOff, searching, corner.{topLeft, topRight, bottomRight, bottomLeft}, cornersRejected, liftHand, confirmTopLeft, confirmMissed, notFound, done, cancelled}`,
  `pointing.oneHand`, `tracking.{lost, restored, moved, pinsNotVisible}`,
  `camera.{noFrames, denied}`
* `camio.status.{off, starting, idle, corners, autoFind, confirm, handsOff, none, tracking, occluded, static, lost, fixed}`

Other locales: add the same keys when translating (`npm run
translations:check` will list them).

## 5. Bundle budget

`audio-treeshake.budget.json` measures the eager graph of
`src/modules/audio/index.ts`; the pointer is not in it, and the vendored file
is reached only through `import()`, which that walk excludes. Measured with
the same walk on `createCamioPointer.ts`: **eager 1,565 B min (832 B gzip)**;
lazy chunk **201.5 KB min (67.2 KB gzip)** — CamioDotPad 63.5 KB + MediaPipe's
JS. Importing the chunk has no side effects (no camera, DOM or network; tested).

## 6. Privacy

All processing is on the device: frames go from the camera to a canvas in the
tab, MediaPipe runs in WebAssembly in the tab, and only the pin number leaves
the library (as an event). Nothing is uploaded; the WASM and the model are
static files from Audiom's own origin (no third-party CDN). The camera opens
only when the user switches the pointer on and closes when it is switched off,
the DOT Pad disconnects, or the map unmounts.

## 7. Live check (Anker PowerConf C200 aimed at the pad)

Use the demo (`cd camio-dotpad && npm run demo`, open
`http://localhost:5180/?dist` to run the vendored bundle). The demo picks the
"C200 / PowerConf" camera when listed; the first run downloads the model from
Google's public model bucket unless `demo/public/mediapipe/hand_landmarker.task`
exists (`node scripts/copy-assets.mjs demo/public/mediapipe --fetch-model`).

1. Start; hands off; **Auto-register** → green field outline on the pad, blue
   ring on the pad's top-left pin (braille line at the bottom), "registered
   (auto, text line)".
2. Point at a few pins (index extended, others curled): the grid highlights
   the pin, border pins show "(border)". Adjust *Tip offset* until the
   highlighted pin is the one under the finger pad.
3. Slide the pad a few cm by hand, slowly: the outline follows (status
   "tracking"; pins in the overlay stay green).
4. Bump it sharply: either it re-locks at once ("moved via tracker") or shows
   "LOST"; take your hands off → it re-acquires within a second.
5. Move the camera; cover half the pad with a hand; check "occluded" holds the
   pose and pins stay right.
6. **Register by corners** with imprecise touches → the outline still lands on
   the pins.

Things only the live check can tell: fingertip parallax on the C200's angle
(tip offset), motion blur during fast slides, auto-exposure jumps, and
MediaPipe's frame rate on the target machine.

## Lines touched

| file | lines |
|---|---|
| `src/components/MapViewer/MapViewer.tsx` | +23 |
| `src/stores/MapStateStore.ts` | +16 −1 |
| `src/modules/tactile/index.ts` | +4 |
| `src/components/MapMenu/DotPadControls.tsx` | +42 |
| `src/components/MapMenu/DisplayOptionsMenu.tsx` | +12 |
| `src/lib/build-embed-string.ts` | +1 −1 |
| `public/locales/en/translation.json` | +52 −1 |
| `documentation/embedding.md` | +5 |
| new `src/modules/tactile/camio/createCamioPointer.ts` (+ `.test.ts`) | 116 (+131) |
| vendored `src/vendor/camio/*` (3 files), `public/vendor/mediapipe/*` (5 files) | copied |
