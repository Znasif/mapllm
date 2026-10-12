# CamioDotPad

A camera fingertip pointer for the DOT Pad (60 × 40 pins), packaged the way
Audiom vendors the DOT Pad SDK: **one ESM file + `.d.ts` + a Vitest smoke
test**, loaded as a lazy chunk.

It registers the pad's pin field from a camera image, follows the pad while
the camera or the pad moves, and emits the pin under a pointing index
fingertip. Framework-free (no React), no OpenCV, no speech or LLM, no Audiom
imports. It never speaks: it emits prompt **codes** with default English text
for the host to localise and announce. All video processing happens in the
browser tab.

```
camio-dotpad/
  src/                 library (TypeScript)
    index.ts           public exports
    pointer.ts         createDotPadPointer: camera + MediaPipe shell around the core
    core.ts            PointerCore: the state machine (DOM-free, unit-tested in Node)
    tracker.ts         lattice-follow tracker (+ Tracker interface, static tracker)
    lattice.ts         lattice auto-find (latticeSearch, aggregateDetections)
    watchdog.ts        drift watchdog decisions
    input.ts           pointing gate, One Euro filter, corner dwell, pin quantizer, send gate
    geometry.ts        homographies, template, registration checks
    imageops.ts        luma, blurs, dot response, peak finder
    mediapipe.ts       default HandLandmarker factory (bundled @mediapipe/tasks-vision, lazy)
    debug.ts           optional Canvas-2D debug overlay
    prompts.ts         prompt codes + default English
  dist/                built by `npm run build` (scripts/build.mjs)
    CamioDotPad-0.1.0.js        single ESM bundle, Biome-formatted with Audiom's config
    CamioDotPad-0.1.0.d.ts      bundled declarations
    CamioDotPad-0.1.0.test.ts   Vitest smoke test to keep next to it (jsdom-safe)
    assets/MANIFEST.json        what the host must self-host (WASM + model; not copied)
  audiom/              ready-to-apply Audiom integration (see AUDIOM_INTEGRATION.md)
  demo/                vite page for a live test with a camera
  test/                Vitest: ported starter tests + tracker sequences + orchestration
  scripts/             build.mjs, copy-assets.mjs, biome.audiom.json (Audiom's Biome config)
```

## API

```ts
import { createDotPadPointer } from './CamioDotPad-0.1.0.js';

const pointer = createDotPadPointer({
  assetsBase: '/vendor/mediapipe/', // wasm/ + hand_landmarker.task, self-hosted
  // cols = 60, rows = 40, border = 2 (inBorder band; Audiom's overlapPins)
  // deviceId?, video?: HTMLVideoElement | MediaStream, width/height (ideal 1280×720)
  // handLandmarker?: (o) => Promise<{ detectForVideo(video, ts), close?() }>  (injection hook)
  // hysteresis = 1.5 (finger-sized: ~4×4 pins), minIntervalMs = 0, dwellMs = 0, tipOffsetPins = 0, trackEvery = 1
  // tracker?: Tracker (plug in another tracker), delegate = 'GPU' (falls back to CPU)
});

pointer.on('pin', ({ x, y, inBorder, fx, fy }) => {/* only on change */});
pointer.on('leave', ({ reason }) => {/* off-pad | not-pointing | unusable | reset */});
pointer.on('prompt', ({ code, text, params }) => announce(t(`camio.prompt.${code}`, { defaultValue: text })));
pointer.on('status', (s) => {/* { phase, tracking, registered, fixed, handsInView, pointing, message } */});
pointer.on('registration', (r) => {/* { corners, pose, pitchPx, method, textFound, frame } */});
pointer.on('lost', ({ reason }) => {/* pins suppressed until re-found */});
pointer.on('moved', ({ via, pins }) => {/* 'tracker' | 'watchdog' */});
pointer.on('cue', ({ code }) => {/* 'lock' | 'reject' — for an earcon */});
pointer.on('error', ({ code, message }) => {});

await pointer.start();                 // opens the camera + hand model; nothing happens before this
await pointer.autoRegister();          // hands off → multi-frame lattice → Registration | null
pointer.registerByCorners();           // dwell TL, TR, BR, BL (prompts guide the user)
pointer.confirmTopLeft();              // accept the auto-found orientation without the touch
pointer.cancel();                      // abort a flow; the previous registration is restored
pointer.setFixed(true);                // freeze the pose (the watchdog still runs)
pointer.drawDebug(canvas);             // optional overlay (Canvas 2D)
pointer.stop();                        // release the camera (registration kept)
pointer.dispose();                     // + close the model, drop listeners
// Advanced: pointer.processFrame(lumaFrame, handResult, now) to feed your own frames;
//           pointer.core (PointerCore), createLatticeTracker(), latticeSearch(), …
```

Coordinates: pin `(x, y)` with x = 0…59 left→right and y = 0…39 top→bottom,
the braille text line **below** row 39 — the same frame as Audiom's
`TactileFrame` rows and `worldToPin`. `inBorder` is true within `border` pins
of an edge.

### Phases and prompts

| phase | what happens | prompt codes |
|---|---|---|
| `autoFind` | wait ≥ 0.5 s with no hand, then up to 5 hands-off frames through `latticeSearch` (one scale hypothesis per frame), `aggregateDetections` | `register.handsOff`, `register.searching`, `register.notFound` |
| `confirm` | the braille line was not seen: dwell on the top-left pin (or `confirmTopLeft()`) | `register.confirmTopLeft`, `register.confirmMissed` |
| `corners` | dwell 1.5 s on each corner pin (radius 45 px at 1280 wide), `checkPinQuad` | `register.corner.topLeft` … `bottomLeft`, `register.cornersRejected`, `register.liftHand` |
| `handsOff` | wait for a hands-off frame, then snap the pose to the lattice the camera sees | `register.done` |
| `ready` | track, watchdog, emit pins | `tracking.lost`, `tracking.restored`, `tracking.moved`, `tracking.pinsNotVisible`, `pointing.oneHand` |

Plus `camera.denied`, `camera.noFrames`, `register.cancelled`. All codes and
English defaults are in `src/prompts.ts` (`PROMPTS`).

## Design

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

### MediaPipe: bundled JS, self-hosted WASM + model

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

* **Bundle**: 198.3 KB minified, 65.8 KB min+gzip (CamioDotPad itself 63.5 KB /
  25.2 KB; the rest is MediaPipe's JS). Formatted source as vendored: 320.3 KB.
  No OpenCV; importing it touches no camera, DOM or network (trapped-globals
  test in Node, spy test in jsdom).
* **Tracker** (16-thread desktop, Node, isolated): 5.3–6.6 ms median per frame
  at 1280 × 720 (pitch 7.1 px; p95 ≈ 9 ms), ≈ 6.7 ms at pitch 5.3 px (no
  downsampling), ≈ 6 ms on a 1024 × 1360 frame; a relock frame ≈ 25 ms; a full
  re-acquire 5–6 frames (worst single step ≈ 100–110 ms).
  `trackEvery: 2` halves the average if needed.
* **Sequences** (`npm run test:tracker`): 51 synthetic sequences from 3 real
  frames — camera pan / tilt+zoom, pad slide / rotate+slide, a 0.45 pin/frame
  slide, bumps of 0.7, 1.0 (exact alias), 2.6 pins + 0.4°, a 4° turn, a
  1.5-pin bump under a resting hand, hands covering 20–50 % of the pins with
  and without the hull hint, and blank pins. **0 aliased frames** (no frame
  accepted ≥ 0.5 pin off) and **0 frames where a usable (non-lost) pose was
  ≥ 0.5 pin off** — except the blank-pins case, where nothing can be seen
  (documented `static` fallback). Median pose error 0.06–0.12 pin (≈ the
  ground truth's own measurement noise); every bump detected; the 0.7 / 1.0 /
  2.6-pin bumps and the bump under the hand relocked in the same frame; the 4°
  turn re-acquired after 4–5 frames once hands were off.
* **Lattice detector** (ported tests): 13 synthetic pads, 9 real frames (all ≤
  0.13 pin, orientation right), 0 false accepts on 28 distractors + erased real
  frames + augmented negatives; augmented held-out set: 0 confident wrong
  answers, ~21 % null, median 0.07 pin.

## Tests

```
npm install
npm test               # everything: 154 tests, ≈ 4 min (real frames from ../starter/scripts/fixtures/dotpad_frames)
npm run test:tracker   # the sequence report table
npm run build          # dist/ (+ size report and bundle checks)
npm run typecheck
npm run demo           # http://localhost:5180  (add ?dist to run the vendored bundle)
```

The real-frame fixtures are referenced, not copied (`CAMIO_DOTPAD_FRAMES` to
override). `CAMIO_AUG`, `CAMIO_DISTRACTORS` scale the augmented / distractor
sets.

## Limitations

* DOT Pad geometry only (60 × 40 with its window margins and braille line);
  `cols`/`rows` options exist but auto-find assumes the DOT Pad template.
* Needs visible pins (raised dots, or lowered pins that still read as holes).
  A blank or very sparse map → `static`: registration holds, but a moved pad is
  noticed only once pins are visible again.
* Relock explains translations plus small rotations (≲ 1°); larger turns wait
  for hands-off and a full search (a few frames). A pad turned 180° in place is
  only resolved if the braille line is visible.
* The fingertip is ~1 cm above the pins; with an oblique camera there is
  parallax. `tipOffsetPins` shifts the point along the finger; tune it live.
* Camera must see the whole pin field plus a pin of margin on each side for the
  border-line checks; a side cut off by the frame edge is "unverified" (holds,
  does not accept from that side alone).
* Pointing is a gesture gate (index extended, others curled); touch vs. hover
  cannot be distinguished by a single camera.
* Measured offline on synthetic sequences built from real frames; motion blur,
  rolling shutter and auto-exposure jumps of a real webcam need the live check
  (see AUDIOM_INTEGRATION.md, "Live check").
