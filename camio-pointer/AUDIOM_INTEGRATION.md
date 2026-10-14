# Integrating CamioPointer 0.2.0 into Audiom

The camera pointer lets a user point at a tactile surface and have the avatar
jump to the point. On a connected **DOT Pad** the point is a pin of the tactile
viewport (unchanged from 0.1.0). On **any other rectangle** (a printed map, a
tactile graphic), registered by its four corners, the sheet spans the map's
extent, top-left = north-west. The library is vendored exactly like the DOT Pad
SDK (one ESM file + `.d.ts` + Vitest smoke test, lazy-loaded), plus
self-hosted MediaPipe assets and, for the rectangle, a self-hosted OpenCV.js.

**Status.** This file describes the 0.2.0 integration on Audiom's
`feature/camio` branch (design: §6 of the generic-surface design). It is applied
there, uncommitted: the vendored files and assets (§1), the controller (§2),
the edits (§3) and the translations (§4). Not done yet: the live check (§7).

`audiom/audiom-integration.patch` holds every Audiom source edit except the
copied files of §1 (vendored bundle, MediaPipe, OpenCV.js). It applies to
`origin/master` (49f03f15). To rebuild it after changing the Audiom working
tree: `bash audiom/tools/regen.sh` (`AUDIOM=…`, `AUDIOM_BASE=origin/master`).
It diffs the working tree against the base (EOL-normalised), checks
`git apply --check` on a `git archive` export of the base in a temp dir, and
copies the controller templates back into `audiom/`; it only reads the Audiom
repo. `audiom/tools/files.sh` lists the files. (The 0.1.0 tools
`make_patched.cjs` / `export-upstream.sh`, which rebuilt the edits from anchors,
are gone: the patch is now cut from the working tree.)

## 1. Files to copy

```
camio-pointer/dist/CamioPointer-0.2.0.js       → src/vendor/camio/CamioPointer-0.2.0.js
camio-pointer/dist/CamioPointer-0.2.0.d.ts     → src/vendor/camio/CamioPointer-0.2.0.d.ts
camio-pointer/dist/CamioPointer-0.2.0.test.ts  → src/vendor/camio/CamioPointer-0.2.0.test.ts
(delete src/vendor/camio/CamioDotPad-0.1.0.*)
MediaPipe assets                                → public/vendor/mediapipe/
OpenCV.js                                       → public/vendor/opencv/opencv.js
```

```
node ../../camio-pointer/scripts/copy-assets.mjs public/vendor/mediapipe --fetch-model --simd-only --opencv public/vendor/opencv
```

* MediaPipe (`dist/assets/MANIFEST.json`): `wasm/vision_wasm_internal.{js,wasm}`
  (0.3 + 11.2 MB), with `--simd-only` no non-SIMD pair (only Safari < 16.4
  needs it), and `hand_landmarker.task` (~7.8 MB). The WASM must be MediaPipe
  **0.10.35**, the version bundled into the `.js`.
* OpenCV.js: `@techstark/opencv-js` **4.12.0-release.1** `dist/opencv.js`,
  10.9 MB, WASM inline (the library's exact-pinned devDependency; not bundled).
  The browser fetches it only when the pointer starts on a non-DOT Pad surface,
  and loads it inside a Web Worker (`importScripts`), so it must be same-origin.
* Like the MediaPipe files, leave them untracked for now; committing them, Git
  LFS, or fetching them in the build is one open decision for all of them.

The `.js` starts with `// biome-ignore-all lint: vendored build output …`, so
`npx biome ci .` stays green with no config change. Audiom's `.editorconfig`
sets `indent_size = 1`, which Biome honours for the line-width count, so the
vendored `.js` (≈ 430 lines) and `.test.ts` (7 lines) need re-wrapping once
copied: `npx biome format --write src/vendor/camio/` (formatting only; on
`feature/camio` this is done). Audiom's `tsc` uses the sibling `.d.ts`.

## 2. New module: `src/modules/tactile/camio/createCamioController.ts`

Template: `camio-pointer/audiom/createCamioController.ts` (+ `.test.ts`); it
replaces `createCamioPointer.ts` and its test.

```ts
createCamioController({
  tactileTool, announce, translate, stopSpeech, onStatusChange,
  noExtentMessage,                      // t('camio.noExtent', { defaultValue })
  assetsBase?: '/vendor/mediapipe/',
  opencvUrl?: '/vendor/opencv/opencv.js',
}) → { preload, start(), stop(), setSurface(kind), surface, active,
       register(), registerByCorners(), cancelRegistration(), dispose() }
```

* **Lazy load**: `import(/* webpackChunkName: "camio-pointer" */ '../../../vendor/camio/CamioPointer-0.2.0.js')`,
  then `createCamioPointer({ assetsBase, opencvUrl, surface })` with
  `{ kind: 'dotpad', border: renderer.viewport.overlapPins }` or `{ kind: 'rect' }`.
* **Events**: `'prompt'` → `announce(translate(code, text, params))`;
  `'status'` → `onStatusChange`; `'openHand'` → `stopSpeech()`; `'point'` →
  switch on the event's own `p.surface` (a late event after a switch is safe):
  * dotpad: the 0.1.0 pin mapping with `p.col` / `p.row`, border skipped:
    `world = (bounds.left + col · metersPerPin, bounds.top − row · metersPerPin)`,
    `bounds = tactileWorldBounds(viewport)`, the exact inverse of `worldToPin`
    (`test/audiomMapping.test.ts` checks all 2,400 pins on four viewports, and
    that no non-border pin pages the viewport while every border pin would);
  * rect: `[minX, minY, maxX, maxY] = renderer.world.extentBounds`,
    `world = (minX + u · (maxX − minX), maxY − v · (maxY − minY))`
    (`starter/src/audiom.js` `uvToEastNorth`). No extent → nothing.
* **Aspect**: the registered corners are the extent's corners, stretched, as
  the starter does; no fit or letterbox.
* **Renderer activation**: `renderer.activate()` only while running on the
  DOT Pad surface.
* **`start()`**: rect with no extent (null or zero area) → announce
  `noExtentMessage`, status `{ phase: 'off' }`, return. Otherwise the 0.1.0
  attempt/wanted race guard: load → `setSurface` if different → activation →
  `await start()` → `if (!registration) void register()`.
* **`setSurface(kind)`**: no-op if unchanged; not running → recorded (and
  forwarded to an existing library pointer); running → rect with no extent
  stops and announces, otherwise `pointer.setSurface(spec)`, activation,
  `void pointer.register()`.
* `CamioPointerStatus = PointerStatus | { phase: 'off' | 'starting' }`;
  `CamioSurface = 'dotpad' | 'rect'`.

## 3. Edits to existing files (the Audiom step)

* **`src/modules/tactile/index.ts`**: export `createCamioController`,
  `CamioPointerStatus`, `CamioSurface`.
* **`MapViewer.tsx`**: field `camioController`, created right after
  `createDotPadController(...)` with `noExtentMessage` and the existing
  `announce` / `translate` / `stopSpeech` (`executeCommand('stopSpeech')`) /
  `onStatusChange`, then `syncCamioSurface()`;
  `syncCamioSurface = () => this.camioController?.setSurface(this.rootStore.mapState.camioSurface)`;
  in `onConnectionChange` after `setDotPadConnection(connection)`: stop if
  the DOT Pad is no longer connected **and** the DOT Pad surface is active,
  then `syncCamioSurface()`; `toggleCamioPointer`: when off,
  `syncCamioSurface()` then `await start()`, else `stop()`; dispose in
  `disposeTactile`.
* **`MapStateStore.ts`** (+ `MapStateStore.tactile.test.ts`): keep
  `camioPointerStatus`, `setCamioPointerStatus`, `toggleCamioPointer`,
  `registerCamioPointerByCorners`; add `camioUseDotPad = true` (observable),
  `toggleCamioUseDotPad()` (flip, then `mapViewer.syncCamioSurface()`), and
  `get camioSurface()` = `camioUseDotPad && dotPadConnection.state === 'connected' ? 'dotpad' : 'rect'`.
* **New `CameraPointerControls.tsx`** (+ `.test.tsx`), its own section in
  `DisplayOptionsMenu.tsx` after `<DotPadControls/>`: title; toggle
  (`menuitemcheckbox`); "Point on the DOT Pad" (`menuitemcheckbox`, only
  while connected); "Register by corners" (`menuitem`, while on; one label for
  both surfaces, since it runs `registerByCorners` on either); a polite status
  line `camio.status.${phase === 'ready' ? tracking : phase}`. Presentational,
  like `DotPadControls` (the menu passes labels and store actions).
* **`DotPadControls.tsx`**: back to upstream except `export` of
  `handleHardwareActionKeyDown` (reused by the new controls);
  `DotPadControls.test.tsx` is upstream.
* **`build-embed-string.ts`** (+ test), **`documentation/embedding.md`**:
  `allow="camera; fullscreen"` as in the 0.1.0 work; the wording now says "the
  camera pointer" (DOT Pad or printed map) instead of "the DOT Pad camera pointer".

## 4. i18n (all 11 `public/locales/*/translation.json`)

The library never speaks; each prompt has a code and an English default, and
`translate` uses `t(\`camio.prompt.${code}\`, { defaultValue, ...params })`.
The English values must equal the library's `PROMPTS` (checked by
`camio-pointer/test/prompts.test.ts` against the patch's `en` hunk).

* **Add** (net +5 per locale over 0.1.0; 41 `camio.*` +
  `cameraPointer.*` keys in all): `camio.prompt.tracking.surface.static` "Too
  plain to follow. Keep it still."; `camio.status.loading` "Loading";
  `camio.noExtent` "No map edges. Use a DOT Pad.";
  `mainMenu.displayOptions.cameraPointer.{title "Camera pointer", toggle "Point with the camera", useDotPad "Point on the DOT Pad", register "Register by corners"}`.
* **Remove**: `mainMenu.displayOptions.dotPad.cameraPointer`,
  `…dotPad.cameraPointerRegister` (never on master).
* **Change** every `camio.prompt.*` value to the terse 0.2.0 defaults (22
  codes; the corner, rejected and done prompts are shared by both surfaces),
  and `camio.status.*` to: off "Off", starting "Starting", idle "Not
  registered", corners "Registering", autoFind "Finding the DOT Pad", confirm
  "Touch the top-left pin", handsOff "Lift your hand", none "Camera on",
  loading "Loading", tracking "Tracking", occluded "Tracking, partly covered",
  static "Not following movement", lost "Lost", fixed "Fixed".

## 5. Bundle budget

`audio-treeshake.budget.json` measures the eager graph of
`src/modules/audio/index.ts`; the pointer is not in it, and the vendored file
is reached only through `import()`. The lazy chunk is **216.6 KB min (72.6 KB
gzip)**: CamioPointer 81.5 KB / 32.0 KB + MediaPipe's JS. Importing it has no
side effects (no camera, DOM, network or Worker; tested). OpenCV.js (10.9 MB)
is a separate static file fetched only for a rect surface.

## 6. Privacy

All processing is on the device: frames go from the camera to a canvas in the
tab, MediaPipe runs in WebAssembly in the tab, AKAZE runs in a same-origin Web
Worker (grey frames are transferred to it, never uploaded), and only the cell
and its (u, v) leave the library (as an event). The WASM, the model and
OpenCV.js are static files from Audiom's own origin. The camera opens only
when the user switches the pointer on and closes when it is switched off, the
DOT Pad disconnects while it is the active surface, or the map unmounts.

## 7. Live check

Use the demo (`cd camio-pointer && npm run demo`, open
`http://localhost:5180/?dist` for the vendored bundle; `?akaze=main` runs AKAZE
on the page thread). The demo serves OpenCV.js from `node_modules` at
`/opencv/opencv.js`, picks the "C200 / PowerConf" camera when listed, and
downloads the model from Google's public bucket unless
`demo/public/mediapipe/hand_landmarker.task` exists.

DOT Pad (surface "DOT Pad"), as in 0.1.0:

1. Start; hands off; **Register** → green outline on the pad, blue ring on the
   top-left pin, "registered dotpad 60×40 (auto, text line)".
2. Point at a few pins: the grid highlights the pin, border pins show
   "(border)". Adjust *Tip offset* until the highlighted pin is under the
   finger pad.
3. Slide the pad slowly: the outline follows. Bump it: it re-locks or shows
   LOST and re-acquires once hands are off. Cover half the pad: "occluded"
   holds the pose.

Printed map (surface "Printed map, A4 (AKAZE)"):

4. Start; **Register**; dwell on TL, TR, BR, BL → "registered rect 118×84
   (corners)"; the overlay shows the quad with a line every 10 cells; status
   "Loading" until OpenCV and the reference are ready, then "Tracking".
5. Point: the cell and (u, v) in the log match the finger; pointing stays
   smooth while matches run (the worker).
6. Slide the sheet a few cm: the outline should follow. **Watch for the 7 s
   lag** measured offline: a fit after a slide is accepted only with at least
   the best inlier count so far (the starter's rule), which a still sheet can
   set too high; then the outline catches up only after 7 s.
7. A blank sheet → "Not following movement" and the static prompt once.

Things only the live check can tell: fingertip parallax (tip offset), motion
blur, auto-exposure jumps, MediaPipe's frame rate, and the worker's AKAZE
latency on the target machine (offline in Node: ≈ 1.1 s per match at
1280 × 720 on a busy frame, ≈ 0.19 s with `akazeScale: 0.5`).
