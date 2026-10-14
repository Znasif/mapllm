# CamioPointer

A camera fingertip pointer for tactile surfaces, packaged the way Audiom
vendors the DOT Pad SDK: **one ESM file + `.d.ts` + a Vitest smoke test**,
loaded as a lazy chunk.

Two surfaces:

* **DOT Pad** (`{ kind: 'dotpad' }`, 60 × 40 pins): registers the pin field
  from the camera (auto-find on the pin lattice, or dwell on the four corner
  pins) and follows the pad with a pure-JS lattice-follow tracker (no OpenCV).
* **Any rectangle** (`{ kind: 'rect' }`: a printed map, a tactile graphic):
  registered by dwelling on its four corners, quantised at the 2.5 mm
  fingertip-acuity floor (A4 landscape → 118 × 84 cells), and followed with
  the starter's AKAZE tracking (OpenCV.js, self-hosted, loaded only for this
  surface, in a Web Worker by default).

It emits the cell under a pointing index fingertip, plus its position on the
surface as `(u, v)` in [0, 1]². Framework-free (no React), no speech or LLM, no
Audiom imports. It never speaks: it emits prompt **codes** with default English
text for the host to localise and announce. All video processing happens in the
browser tab.

```
camio-pointer/
  src/                 library (TypeScript)
    index.ts           public exports
    pointer.ts         createCamioPointer: camera + MediaPipe shell around the core; OpenCV options
    core.ts            PointerCore: the state machine (DOM-free, unit-tested in Node)
    surface.ts         surface specs and profiles (DOT Pad, rect), acuity grid (starter surface.js ports)
    tracker.ts         lattice-follow tracker (+ Tracker interface, static tracker)
    akaze.ts           AKAZE engine (starter port), worker source, worker / inline engines
    akazeTracker.ts    the rect surface's Tracker over an AKAZE engine
    opencv.ts          OpenCV.js loader, waitForOpenCV
    lattice.ts         lattice auto-find (latticeSearch, aggregateDetections)
    watchdog.ts        drift watchdog decisions (DOT Pad)
    input.ts           gesture recognizer (CamIO port + open hand), One Euro filter, corner dwell, cell quantizer, send gate
    geometry.ts        homographies, template, registration checks
    imageops.ts        luma, blurs, dot response, peak finder
    mediapipe.ts       default HandLandmarker factory (bundled @mediapipe/tasks-vision, lazy)
    debug.ts           optional Canvas-2D debug overlay
    prompts.ts         prompt codes + default English
  dist/                built by `npm run build` (scripts/build.mjs)
    CamioPointer-0.2.0.js        single ESM bundle, Biome-formatted with Audiom's config
    CamioPointer-0.2.0.d.ts      bundled declarations
    CamioPointer-0.2.0.test.ts   Vitest smoke test to keep next to it (jsdom-safe)
    assets/MANIFEST.json         what the host must self-host (MediaPipe WASM + model, opencv.js; not copied)
  audiom/              Audiom wrapper template (createCamioController) + patch tools (see AUDIOM_INTEGRATION.md)
  demo/                vite page for a live test with a camera
  test/                Vitest: ported starter tests, tracker sequences, orchestration, AKAZE (fake + optional real OpenCV)
  scripts/             build.mjs, copy-assets.mjs, biome.audiom.json (Audiom's Biome config)
```

## API

```ts
import { createCamioPointer } from './CamioPointer-0.2.0.js';

const pointer = createCamioPointer({
  surface: { kind: 'dotpad', border: 2 },  // required; or { kind: 'rect', material?: { widthMm, heightMm }, tracking?: 'akaze' | 'static' }
  assetsBase: '/vendor/mediapipe/',        // wasm/ + hand_landmarker.task, self-hosted
  opencvUrl: '/vendor/opencv/opencv.js',   // rect only: fetched on start() when the surface is rect
  // akazeThread = 'worker' ('main' = the starter verbatim), akazeScale = 1, opencvEngine?: (opts) => Promise<AkazeEngine>
  // akaze?: { minInliers = 8, referenceMask = 'surface' ('none' = starter verbatim), everyFrames = 6, staleMs = 7000, ratio = 0.75, ransacPx = 8 }
  // deviceId?, video?: HTMLVideoElement | MediaStream, width/height (ideal 1280×720)
  // handLandmarker?: (o) => Promise<{ detectForVideo(video, ts), close?() }>  (injection hook)
  // hysteresis = 1.5 cells, minIntervalMs = 0, dwellMs = 0, tipOffsetCells = 0, trackEvery = 0 (the surface's default)
  // tracker?: Tracker | (profile) => Tracker (plug in another tracker), delegate = 'GPU' (falls back to CPU)
  // swapHandedness = true (CamIO: MediaPipe 'Left' is the right hand; false = take the label literally)
});

pointer.on('point', ({ surface, col, row, u, v, inBorder, fx, fy }) => {/* only on change */});
pointer.on('leave', ({ reason }) => {/* off-surface | not-pointing | unusable | reset */});
pointer.on('prompt', ({ code, text, params }) => announce(t(`camio.prompt.${code}`, { defaultValue: text })));
pointer.on('status', (s) => {/* { surface, phase, tracking, registered, fixed, handsInView, pointing, gesture, side, message } */});
pointer.on('openHand', ({ side }) => stopSpeech()); // open hand shown (ready phase, once per entry)
pointer.on('registration', (r) => {/* { surface, corners, pose, grid, cellPx, aspect, method, textFound, frame } */});
pointer.on('lost', ({ reason }) => {/* (DOT Pad) points suppressed until re-found */});
pointer.on('moved', ({ via, cells }) => {/* (DOT Pad) 'tracker' | 'watchdog' */});
pointer.on('cue', ({ code }) => {/* 'lock' | 'reject' — for an earcon */});
pointer.on('error', ({ code, message }) => {/* e.g. 'opencv.load' (once), 'autoRegister.unsupported' */});

await pointer.start();                 // camera + hand model (+ OpenCV for rect); nothing happens before this
await pointer.register();              // the surface's default: DOT Pad autoRegister(), rect corner dwell → Registration | null
await pointer.autoRegister();          // (DOT Pad) hands off → multi-frame lattice → Registration | null
pointer.registerByCorners();           // dwell TL, TR, BR, BL (prompts guide the user)
pointer.confirmTopLeft();              // (DOT Pad) accept the auto-found orientation without the touch
pointer.setSurface({ kind: 'rect' });  // switch: registration dropped, a pending register() resolves null
pointer.cancel();                      // abort a flow; the previous registration is restored
pointer.setFixed(true);                // freeze the pose
pointer.drawDebug(canvas);             // optional overlay (Canvas 2D)
pointer.stop();                        // release the camera (registration kept)
pointer.dispose();                     // + close the model and the AKAZE worker, drop listeners
// Advanced: pointer.processFrame(lumaFrame, handResult, now) to feed your own frames;
//           pointer.core (PointerCore), createLatticeTracker(), createAkazeTracker(), latticeSearch(), …
```

Coordinates: cell `(col, row)` counts left→right and top→bottom from the
registered top-left corner; `(u, v)` is the same point as a fraction of the
surface, (0, 0) = top-left, (1, 1) = bottom-right. On the DOT Pad col = 0…59
and row = 0…39 with the braille text line **below** row 39 — the same frame as
Audiom's `TactileFrame` rows and `worldToPin` — and `inBorder` is true within
`border` pins of an edge (always false on a rect).

### Phases and prompts

| phase | what happens | prompt codes |
|---|---|---|
| `autoFind` | (DOT Pad) wait ≥ 0.5 s with no hand, then up to 5 hands-off frames through `latticeSearch`, `aggregateDetections` | `register.handsOff`, `register.searching`, `register.notFound` |
| `confirm` | (DOT Pad) the braille line was not seen: dwell on the top-left pin (or `confirmTopLeft()`) | `register.confirmTopLeft`, `register.confirmMissed` |
| `corners` | dwell 1.5 s on each corner (radius 45 px at 1280 wide); DOT Pad `checkPinQuad`, rect `checkSurfaceQuad` (convex, clockwise, ≥ 1 % of the frame) | `register.corner.topLeft` … `bottomLeft`, `register.cornersRejected`, `register.liftHand` |
| `handsOff` | wait for a hands-off frame (DOT Pad: snap the pose to the lattice; rect: the AKAZE reference frame) | `register.done` |
| `ready` | track, (DOT Pad) watchdog, emit points | DOT Pad: `tracking.lost`, `tracking.restored`, `tracking.moved`, `tracking.pinsNotVisible`; rect: `tracking.surface.static`; both: `pointing.hand.left`, `pointing.hand.right` |

Plus `camera.denied`, `camera.noFrames`, `register.cancelled`. The corner,
rejected and done prompts are shared by both surfaces. All codes and English
defaults are in `src/prompts.ts` (`PROMPTS`).

### Hand gestures (CamIO's recognizer)

`input.ts` ports `simple_camio_llm`'s `gesture_recognizer.py` (CamIO is the
reference; `test/input.test.ts` checks the classifier against CamIO's own numpy
code on 152 landmark sets in `test/fixtures/camioPointing.json`):

* **Pointing** (`Hand.__compute_is_pointing`), on MediaPipe's normalised x, y, z:
  `ratio` = |MCP→TIP| / joint chain per finger; projection test with
  a = landmark 5, ab = landmark 8 − 5: it fails if any middle/ring/pinky joint
  has (p − a)·ab / ab·ab > 0.5; pointing = projection passes **or**
  ratio(index) − mean(ratio(middle, ring, pinky)) > 0.10.
* **Index visible**: once a pose exists, hands whose index tip maps more than
  1 cell outside the corner cells (the quantizer's off-surface bound) are
  dropped first. No hands → `none`; hands but none visible → `exploring`.
  Before registration nothing is filtered.
* **Sides** come from MediaPipe's `handedness`; like CamIO, the label is
  swapped (`'Left'` = the right hand; `swapHandedness: false` disables that).
  More than one visible hand on a side → `tooMany` (silent, as in CamIO).
  Without handedness all hands share one unknown side.
* **Two pointing hands**: per side, a 15-sample / 1 s fingertip buffer; a side
  is moving when |last − first| > 0.25 inch = 2.54 cells (2.5 mm: the DOT Pad pitch and the rect acuity floor,
  `MOVEMENT_THRESHOLD_PINS`; before registration in camera px via a nominal
  7 px pitch at 1280 wide). One pointing hand → it; else right moving → right;
  else left moving → left; else the last side; else `exploring`.
* **Majority vote** (`GestureBuffer`): the status is the mode of the last 5
  frame statuses (1 s life). Ties: CamIO's depend on Python's hash seed; here
  pointing > exploring > open > tooMany > none. While the vote is `pointing`,
  the current fingertip (or the last one) drives the points; nothing else does.
* **Side change** (ready phase): a new pointing side resets the quantizer, the
  One Euro filters and the send gate and prompts `pointing.hand.left` /
  `pointing.hand.right` ("Left hand" / "Right hand").
* **Open hand** (not in CamIO): no hand pointing and a visible hand with index,
  middle, ring and pinky each at ratio ≥ 0.9 (`OPEN_FINGER_MIN`; ≈ 31° bend at
  both PIP and DIP; thumb ignored). For points it is `exploring`. When the vote
  enters `open` in the ready phase, `'openHand'` `{ side }` fires once; it
  re-arms when the vote leaves `open`. Audiom stops speech on it.

## Design: the DOT Pad surface

### Registration (ported from the starter)

* **Auto**: `latticeSearch` finds the 60 × 40 dot lattice itself (pyramid,
  illumination-normalised DoG peaks, nearest-neighbour basis, BFS indexing,
  robust homography, extent resolved from the display-window margins, a
  validation gate, and the braille line for 180°). Several hands-off frames are
  aggregated; without the text line a single confirm touch settles orientation.
* **Corners**: dwell on the four corner pins. The touched pose is then refined
  on the lattice the camera sees (relock), so a fingertip that was a pin off
  still yields a pin-accurate registration (tested: 0.6-pin-off touches →
  < 0.3 pin).

### Tracking without OpenCV: the lattice-follow tracker

The starter's AKAZE homography follows camera motion but not the pad sliding
on the table (the background outvotes the pad). Here the pad's own 2,400 pins
are the features (`src/tracker.ts`):

1. Predict every pin position from the last pose (damped constant velocity),
   including the ring of lines just outside the 60 × 40.
2. Compute the dot response on the ROI only, box-downsampled so the pitch is
   ≥ 3.5 px (noise floor estimated at full resolution).
3. For each pin, take the dot peak within ±0.45 pitch of the prediction (local
   maximum, blob test, contrast floor). Pins under the MediaPipe hand hull
   (grown by a pin) are not searched.
4. Robust homography from the found pins (outliers rejected in index space);
   repeat 3–4 at ±0.3 pitch.
5. Accept only if ≥ 150 inliers spanning ≥ 35 % of each axis, residual ≤ 0.15
   pin, ≥ 60 % inliers, **and the border lines check out**: the line just
   outside each visible side must be empty while the edge line is dotted. A
   jump of more than half a pitch between frames would alias the lattice by
   one pin, which fills an outside line with the real edge and empties an edge
   line — so it is refused, never accepted.

Outcomes: `tracking` (pose updated), `occluded`/`blank` (not enough evidence;
last pose kept and used), `lost` (evidence contradicts the pose; **no pins are
emitted**). "Not enough evidence" is narrow on purpose, because a held pose
still drives pins: if the first pass matches far fewer of the visible pins
than usual (< 35 % of the running match rate), or a good fit lands > 0.2 pin
away from the last pose while a side is hidden (so the integer alignment
cannot be verified), the pad has moved by an unknown amount and the state is
`lost`, not held. Only when there are hardly any dots around the pad at all is
it `blank` (pins not visible). On a contradiction a **relock** runs on the same frame: dot peaks
in an enlarged ROI are mapped into the old pin frame, vote for a sub-pin phase,
and the integer offset whose window holds the most dots with empty outside
lines and dotted edges wins — only with a clear margin over the runner-up. If
that fails and no hand is in view, a **full re-acquire** (`latticeSearch`, one
step per frame, orientation kept unless the braille line says otherwise) runs.
The **drift watchdog** (full lattice search while hands are off; two
consistent disagreements > 1 pin → re-register) remains as a second opinion
every 5 s while tracking (every 1.5 s when static/fixed). If the pins are not
visible (blank map, glare), the pose stays as registered, status becomes
`static`, and the host is told once (`tracking.pinsNotVisible`).

The `Tracker` interface (`reset(pose, frame?)`, `update(frame, hints)`,
`clear()`, `pose`, `state`) lets a host plug in another tracker; frames arrive
as `LumaFrame` (`read(x, y, w, h)` → luma), so the tracker reads only its ROI.

## Design: the rect surface (any rectangle)

Ported from `starter/` (`TactileExplorerGeneric.jsx`, `TactileExplorer.jsx`,
`surface.js`); nothing is new where the starter already has it.

* **Registration**: dwell on the four corners (TL, TR, BR, BL): the same flow
  and prompts as the DOT Pad corners. `checkSurfaceQuad`: four points, convex
  and clockwise, area ≥ 1 % of the frame (`quadArea` is the starter's).
  `autoRegister()` is DOT Pad-only (null + error `autoRegister.unsupported`).
* **Grid**: `acuityGrid(material)` at the 2.5 mm floor (`ACUITY_FLOOR_MM`);
  default material A4 landscape 297 × 210 mm → 118 × 84 cells, oriented like
  the registered quad (a portrait quad → 84 × 118). Cell centres and `(u, v)`
  follow `acuityCellCenter`. Cells span `−½ … cols − ½` in the plane, as on
  the DOT Pad, so the core, quantiser and gestures are shared.
* **Tracking** (`akazeTracker.ts` over `akaze.ts`, the starter's AKAZE step):
  the reference is one grey snapshot from the **hands-off** registration
  frame; `Hfwd` starts at the identity; a match every 6 frames (never two in
  flight); Lowe ratio 0.75; `findHomography(RANSAC, 8 px)` with ≥ 8 good
  matches; accept iff inliers ≥ 8 and ≥ the best so far, the best going stale
  after 7 s; pose = `Hfwd · pose0`. States: `loading` (OpenCV or the reference
  not ready; the registered pose is used), `tracking`, `occluded` (last match
  rejected; pose held), `blank` (`low-texture`: < 8 reference keypoints, or
  `opencv-unavailable`) → after 2 s hands-off the status is `static` and
  `tracking.surface.static` is said once. There is no `lost` on a rect.
* **Deviations from the starter (signed off)**: D1 the reference keypoints are
  masked to the registered quad (`referenceMask: 'surface'`; `'none'` is the
  starter verbatim), because without it the background outvotes a sliding
  sheet (see the numbers). D2 AKAZE runs in a Blob Web Worker
  (`akazeThread: 'worker'`; `'main'` is the starter verbatim) so pointing is
  not stalled by a match. The engine deletes every Mat and vector it allocates
  (the starter leaks the knnMatch pair vectors).
* **OpenCV.js**: `@techstark/opencv-js` 4.12.0-release.1 `dist/opencv.js`
  (10.9 MB, WASM inline), self-hosted at `opencvUrl`, fetched only when a rect
  surface starts. Never bundled (build check). Never `await cv` (the module is
  a thenable that never settles); `waitForOpenCV` waits on `cv.Mat` /
  `onRuntimeInitialized`. No `opencvUrl` → the sheet is registered but not
  followed (`static`, error `opencv.load` once).
* The worker's code is the engine's own functions serialised with
  `toString()`; they are written without imports, for-of, template literals or
  spread so a host transpiler cannot inject helpers the worker lacks.

## MediaPipe: bundled JS, self-hosted WASM + model

The hand landmarker is `@mediapipe/tasks-vision` 0.10.35. **Decision: its JS is
bundled into the vendored file; its WASM and the hand model are self-hosted by
the host** (`assetsBase`). Why this is the smaller change for Audiom:

* No `package.json`/lockfile change and no new dependency to audit or keep in
  sync; one vendored file, exactly like the DOT Pad SDK.
* The JS glue and the WASM must be the **same version**; bundling pins the JS
  to the WASM listed in `dist/assets/MANIFEST.json`. With an npm dependency a
  semver-range bump could silently mismatch the self-hosted WASM.
* It costs nothing eagerly: the bundled MediaPipe module is wrapped lazily
  (esbuild `__esm`), so it is not even evaluated until the first landmarker is
  created, and the whole file is a dynamic-import chunk in Audiom.
* Its one `import(url)` (worker path for the WASM glue) is marked
  `/* webpackIgnore: true */` at build time, the same treatment the SDK got.

Injection hook: `handLandmarker` (factory) replaces MediaPipe entirely (tests
use it; a host that already ships MediaPipe can pass its own).

## Numbers (this machine, Node 24)

* **Bundle**: 216.6 KB minified, 72.6 KB min+gzip (CamioPointer itself 81.5 KB
  / 32.0 KB; the rest is MediaPipe's JS). Formatted source as vendored:
  355.4 KB. OpenCV.js is not in it; importing it touches no camera, DOM or
  network (trapped-globals test in Node, spy test in jsdom).
* **DOT Pad tracker** (16-thread desktop, Node, isolated): 5.3–6.6 ms median
  per frame at 1280 × 720 (pitch 7.1 px; p95 ≈ 9 ms), ≈ 6.7 ms at pitch 5.3 px
  (no downsampling), ≈ 6 ms on a 1024 × 1360 frame; a relock frame ≈ 25 ms; a
  full re-acquire 5–6 frames (worst single step ≈ 100–110 ms).
  `trackEvery: 2` halves the average if needed.
* **AKAZE** (real OpenCV.js 4.12.0 in Node, `test/akazeEngine.opencv.test.ts`;
  synthetic 1280 × 720 frames: a map-like sheet ≈ 650 × 460 px on a cluttered
  table): detectAndCompute ≈ 0.38 s on the whole
  frame (5,600 keypoints) and knnMatch ≈ 1.2 s for 5,600 × 5,650; one engine
  match against the masked reference (2,600 keypoints) ≈ 1.1 s at full
  resolution, ≈ 0.19 s with `akazeScale: 0.5` (still 666 inliers). Hence the
  worker (D2). A still sheet stays within 2 px. A 40 px slide + 5° turn on a
  still table is followed to 0.2 px **only after the 7 s staleness**: the
  starter's rule accepts a fit only with at least the best inlier count so
  far, and the still frames set that bar (2,577) above what the moved sheet
  matches (2,000). With `referenceMask: 'none'` (the starter verbatim) the
  table outvotes the sheet and the pose stays at the old place (74 px off
  after 14 s). A blank sheet on a table of the same grey has 0 keypoints →
  `static`; on a darker table its outline alone gives 16 keypoints and it
  "tracks" on them.
* **DOT Pad sequences** (`npm run test:tracker`): 51 synthetic sequences from 3
  real frames — camera pan / tilt+zoom, pad slide / rotate+slide, a 0.45
  pin/frame slide, bumps of 0.7, 1.0 (exact alias), 2.6 pins + 0.4°, a 4°
  turn, a 1.5-pin bump under a resting hand, hands covering 20–50 % of the
  pins with and without the hull hint, and blank pins. **0 aliased frames**
  and **0 frames where a usable (non-lost) pose was ≥ 0.5 pin off**, except
  the blank-pins case (documented `static` fallback). Median pose error
  0.06–0.12 pin; every bump detected.
* **Lattice detector** (ported tests): 13 synthetic pads, 9 real frames (all ≤
  0.13 pin, orientation right), 0 false accepts on 28 distractors + erased real
  frames + augmented negatives; augmented held-out set: 0 confident wrong
  answers, ~21 % null, median 0.07 pin.

## Tests

```
npm install
npm test               # everything: 226 tests in 16 files, ≈ 4–5 min (real DOT Pad frames from ../starter/scripts/fixtures/dotpad_frames)
npm run test:tracker   # the DOT Pad sequence report table
npm run build          # dist/ (+ size report and bundle checks)
npm run typecheck
npm run demo           # http://localhost:5180  (?dist = the vendored bundle, ?akaze=main = AKAZE on the page thread)
```

The real-frame fixtures are referenced, not copied (`CAMIO_DOTPAD_FRAMES` to
override). `CAMIO_AUG`, `CAMIO_DISTRACTORS` scale the augmented / distractor
sets. The real-OpenCV AKAZE test runs when `@techstark/opencv-js` is installed
(devDependency; `CAMIO_OPENCV_JS` overrides the path) and is skipped otherwise.

## Limitations

* Rect: the sheet needs texture (≥ 8 AKAZE keypoints inside the quad); a blank
  sheet is registered but not followed (`static`). A slide is followed once a
  match with at least the best inlier count so far arrives, or after the 7 s
  staleness (the starter's rule; see the numbers). No auto-find: corners only.
* Rect: the cells are the 2.5 mm acuity grid of the declared material (A4
  landscape by default); another sheet size needs `material`.

* DOT Pad: geometry fixed at 60 × 40 with its window margins and braille line.
* Needs visible pins (raised dots, or lowered pins that still read as holes).
  A blank or very sparse map → `static`: registration holds, but a moved pad is
  noticed only once pins are visible again.
* Relock explains translations plus small rotations (≲ 1°); larger turns wait
  for hands-off and a full search (a few frames). A pad turned 180° in place is
  only resolved if the braille line is visible.
* The fingertip is ~1 cm above the pins; with an oblique camera there is
  parallax. `tipOffsetCells` shifts the point along the finger; tune it live.
* Camera must see the whole pin field plus a pin of margin on each side for the
  border-line checks; a side cut off by the frame edge is "unverified" (holds,
  does not accept from that side alone).
* Pointing is a gesture gate (index extended, others curled); touch vs. hover
  cannot be distinguished by a single camera.
* Measured offline on synthetic sequences built from real frames; motion blur,
  rolling shutter and auto-exposure jumps of a real webcam need the live check
  (see AUDIOM_INTEGRATION.md, "Live check").
