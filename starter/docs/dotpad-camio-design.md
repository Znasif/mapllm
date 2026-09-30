# CamIO finger tracking × Audiom's DOT Pad rendering — design

Status: design only, for the `coder` agent. Branch `dotpad`. Hard constraint: **no Audiom changes**.
Every upstream claim cites `explore/Audiom-Front-End` at `origin/master` = `87121f55` (read with
`git show origin/master:<path>`; the local checkout is stale and must not be touched).

---

## 0. Decisions at a glance

| # | Decision | Why |
|---|---|---|
| D1 | The host keeps a **mirror of Audiom's tactile viewport in pin units** (`lib/dotpadViewport.js`), advanced on every `positionChanged` with a port of `panViewportToKeepAvatar`. | Paging is the only viewport change the embed lets us observe (indirectly). The mirror is exact for it. |
| D2 | **Sync = force grid mode, two-axis step probe, then a `smallerStep`→`largerStep` bounce, then a verify probe** (6 grid moves). | The probe measures the pin → lng/lat Jacobian directly (no metres, no projection origin, works for custom-coordinate maps, robust to heading). The bounce is the only re-anchor the embed offers; smaller→larger fails only at step index 0, and that failure is detectable (verify probe) and repairable (one more `smallerStep`). |
| D3 | The model works in a **local plane**: host-side ENU tangent plane at the sync point for geographic maps, identity for custom-coordinate maps, chosen automatically from the probe. | Linear-in-lng/lat drifts by up to about 1 pin after roughly 10 pages at 20 m steps (§3.3). ENU-at-P0 is affine to Audiom's ENU plane to within millimetres over a city or region. |
| D4 | Drift policy: pages are mirrored exactly. Scale changes are not observable, so a **two-step signature** (two consecutive axis-aligned foreign moves of equal length ≠ 1 pin) marks the model **stale**. The model then auto-re-syncs after 1.5 s of quiet. Manual Sync covers everything else. The blinking avatar under the finger is the user's ground truth. | Exact passive rescale inference is ambiguous with `nextForward`/`nextLeft`… jumps (axis-aligned, arbitrary length). |
| D5 | Registration corners are the **centres of the four corner pins** (TL, TR, BR, BL). `(u,v)` in the unit square maps to pin `(u·59, v·39)` with `Math.round`, which matches Audiom's `worldToPin`. | A blind user can find the corner pin by touch. The convention is the same as the old Braille Doodle path (`u = col/(cols-1)`). |
| D6 | Primary registration stays **four-corner pointing plus AKAZE against a live hands-off snapshot**, with the pin field and braille text line **masked out** of the reference. Template mode is **geometric**: find the display window as a quad, map it through template ratios, then confirm orientation with one touch on the top-left pin. The template is *not* used for AKAZE descriptors. | The render is flat grey, with two periodic dot lattices and button outlines at about 39–50 grey on a 55 grey body. That gives almost no distinctive descriptors. The pins change state and hands occlude them. |
| D7 | Finger → avatar goes out only when **synced** and only to **inner-band pin centres** `[2..57]×[2..37]`. Sends are limited per device preset (DOT Pad X: 150 ms, Gen-1: dwell 600 ms and 2.5 s). | Decision 3. Gen-1 speaks "Lift your hands…" on every frame (§2, F14). |
| D8 | iframe `allow="autoplay; fullscreen; bluetooth; serial"`. | The SDK uses Web Bluetooth and Web Serial only (F15). |

---

## 1. Goals / non-goals

**Goals.** MediaPipe drives Audiom's avatar through `moveAvatar`. The finger's domain is exactly
Audiom's current 60×40 DOT Pad window, and fingertip position maps to the pin under it. The window
moves only when Audiom pages it (keyboard walking). The host mirrors this and re-syncs on demand or
when it detects drift. The device can be registered by four-corner pointing or by auto-finding it
from the template. DOT Pad mode replaces the printed-material UI in `AudiomTactileApp`.

**Non-goals.** No Audiom changes. DOT Pad pan keys are not tracked (Sync recovers from them). Paged
braille messages on the pin area are a known limitation. Maps that Audiom promotes to Web Mercator
(extent > 30°, `processLayers.ts:265-279`) are not supported: the plane model would need a
`mercator` plane (§3.3). There is no host keyboard proxy.

---

## 2. Verified Audiom facts (`origin/master` 87121f55)

| F | Fact | Where |
|---|---|---|
| F1 | Tactile tool geometry is fixed: `width 60, height 40, overlapPins 2, active:false`. | `components/MapViewer/MapViewer.tsx:515-520` |
| F2 | The viewport is `{center (world), width, height, metersPerPin = avatar.moveDistance, overlapPins}`. **All writers of `this.viewport`**: constructor `:56`, moveDistance reaction `:87`, `handlePositionUpdated` `:122`, `pan()` `:131`, `activate()` `:169`. No other module writes it (`git grep "\.viewport\s*="`). | `modules/tactile/TactileRenderer.ts` |
| F3 | Reaction on `world.avatar.moveDistance` sets `center := avatar.position, metersPerPin := new`. It is registered unconditionally, so it **fires while inactive too**. `render()` no-ops when inactive. MobX fires it only when the value actually changes. | `TactileRenderer.ts:83-94, 223-224` |
| F4 | `activate()` on 0→1 consumers sets `center := avatar.position, metersPerPin := moveDistance`. Consumers are the DOT Pad (`markConnected` → `renderer.subscribe`) and Audiom's on-screen **TactilePinView**. The latter lets us test end to end without hardware. | `TactileRenderer.ts:163-184, 186-205`; `dotPad/DotPadController.ts:609-617`; `components/TactilePinView/TactilePinView.tsx:21` |
| F5 | `handlePositionUpdated` runs on `positionUpdated` and `positionOverriden`, returns early when inactive, and otherwise applies `panViewportToKeepAvatar`. | `TactileRenderer.ts:78-79, 119-127` |
| F6 | `tactileWorldBounds`: `left = cx − floor(W/2)·m`, `top = cy + floor(H/2)·m`. `worldToPin = [round((x−left)/m), round((top−y)/m)]`. So the centre is pin (30,20). `panViewportToKeepAvatar` pages by `W−2o = 56` / `H−2o = 36` while the pin is outside `[o, W−1−o]` = `[2,57]` / `[2,37]`. | `modules/tactile/viewport.ts:12-36, 59-101` |
| F7 | Pad pan keys (chords dot 1 / dot 4) call `renderer.pan()`, which the host cannot see. | `input/tactileKeymap.ts:100-111`; `dotPad/createDotPadController.ts:40` |
| F8 | Embed outbound is only `ready`, `positionChanged`, `feature*`, `stateChanged` and `error`. **Nothing tactile, and moveDistance is never exposed**. The step size is only spoken (`stepSizeSet`). | `modules/embed/types.ts:111-118`; `components/tools/MovementTool.tsx:400-404` |
| F9 | `positionChanged` is a MobX reaction on `avatar.externalPosition`. It fires for **every** position change: keyboard, pad, our `moveAvatar`, jumps, marker drag (`overridePosition`). It does not fire for a no-op `setPosition` (exact equality). | `modules/embed/hooks/useAudiomClient.ts:115-121`; `modules/Avatar.ts:641-644, 667-673` |
| F10 | `moveAvatar` → `world.toInternalCoordinates(lngLat)` → `avatar.setPosition` directly. **There is no snapping, wall check or bounds fence.** | `useAudiomClient.ts:173-178`; `Avatar.ts:623-665` |
| F11 | Inbound handling is synchronous (`AudiomClient.handleInbound` → emit → handler). So `executeCommand(x)` followed by `getState` returns the post-command state, and `positionChanged` for a move is posted before that `stateChanged`. | `modules/embed/AudiomClient.ts:125-166`; `useAudiomClient.ts:180-213`; `MapViewer.tsx:844-873` |
| F12 | Coordinates: ENU tangent plane (orthographic, `U` dropped) anchored at `metadata.minPoint ?? originalBbox SW`. Web Mercator is chosen when the extent is > 30°. `customCoordinateSystem` maps are identity (internal = external). E/N axes are world +x/+y. | `modules/world/MapWorld.ts:192-195, 439-476`; `projections/EnuProjection.ts:121-177`; `processLayers.ts:265-279` |
| F13 | Grid movement is **heading-relative**: `positionFromDirection` uses `angleToVector(orientation) = (sin θ, cos θ)`, so up = forward and right = `(fwd.y, −fwd.x)`. First-person `up` starts a **repeating walk until `up_release`**, and left/right **turn** (default 15°). Movement is fenced by `world.internalBounds`. | `Avatar.ts:330-337, 339-380, 434-440, 442-475, 761-776`; `geometry.ts:63-74`; `SettingsStore.ts:150` |
| F14 | `largerStep`/`smallerStep` → `MovementTiers.stepUp/stepDown`, then `avatar.moveDistance = …` (the F3 reaction fires), then speak "Step size set to X". `stepDown` fails only at index 0. `stepUp` fails only at the last index of a non-largest tier, and the largest tier appends ×2. On failure nothing changes and it says "smallest/largest step reached". Each success also persists prefs and clears the map's sticky default step (#1580). | `modules/movementTiers.ts:207-235`; `MovementTool.tsx:380-452` |
| F15 | The DOT Pad SDK uses **Web Bluetooth** (`navigator.bluetooth.requestDevice`, `namePrefix 'DotPad'`) and **Web Serial** (`navigator.serial.requestPort`, FTDI 0x0403:0x6010/0x6015). It does not use WebUSB or WebHID. | `vendor/dotpad/DotPadSDK-3.0.2.js:1458-1484` |
| F16 | On Gen-1 pads **every frame** calls `announce("Lift your hands while the DOT Pad updates.")` and waits `refreshTimeMs`. Message boxes hold map frames back until dismissed. | `DotPadController.ts:641-660, 542-575, 609-614` |
| F17 | Embed messages are accepted **only from `window.parent`** and sent to `window.parent`. A popup window cannot be used as a fallback host. | `modules/embed/adapters/PostMessageAdapter.ts:43, 73` |
| F18 | Commands we use exist in `KEYMAP_COMMANDS`: `up/down/left/right(+_release)`, `activateGridView`, `smallerStep`, `largerStep`, `stopSpeech`. Unknown commands post an `error` message. | `modules/commands.ts`; `AudiomClient.ts:155-161` |

Other relevant facts: `recall`, `nextForward/Left/Right/Backward`, `jumpToLandmarkN` and road following all
move by arbitrary vectors. `nextX` jumps move *along the heading axes* by arbitrary distances (`Avatar.moveToNext`),
which is why exact passive rescale inference is unsafe.

---

## 3. Coordinate model and viewport mirror

### 3.1 Units

Everything in the mirror is in **world pins**. A world pin is a displacement of `metersPerPin` along world
+x (east/right) or +y (north/up). Audiom's viewport centre only ever moves by whole multiples of 56 or 36 pins
from the last anchor (F2, F3, F4, F6), so in world-pin units relative to the anchor the centre is
**integer**. Integer arithmetic here is exact.

### 3.2 Model

```
Model = {
  plane: 'enu' | 'identity',
  planeOrigin: [lng,lat],   // P_start of the sync (ENU tangent point); unused for identity
  p0: [lng,lat],            // avatar position when Audiom last re-centred (sync anchor)
  A: [[a00,a01],[a10,a11]], // plane units per world pin: column 0 = +x pin, column 1 = +y pin
  Ainv,                     // precomputed
  center: [cx, cy],         // integers, world pins relative to p0; (0,0) right after sync
  headingDeg,               // from the probe (info + axis test)
  metresPerPin | null,      // enu plane only (for speech)
  geometry: { W:60, H:40, o:2 }  // Audiom's, F1 — not the device's
}
plane(L)   = plane==='enu' ? enuForward(L, planeOrigin) : [L.lng − planeOrigin.lng, L.lat − planeOrigin.lat]
toQ(L)     = Ainv · (plane(L) − plane(p0))                 // world pins
toLngLat(q)= planeInverse(plane(p0) + A · q)
```

### 3.3 Why a plane, and which one

Audiom's pin lattice is regular in its internal plane. For ENU maps that plane is the tangent plane at
the map's SW corner O, which we do not know. The ENU plane at our sync point P relates to O's plane by an
**affine map plus a residual of about D²·S/(2R²)**, where D = distance from P and S = |O−P|. For S = 20 km
and D = 5 km the residual is about 6 mm. Plain lng/lat instead has curvature error of about D²·tanφ/(2R). At
40°N with 20 m pins that is about 0.4 pin after 10 pages, and more at larger steps. So:

- `lib/enu.js` (new, pure) is a port of `EnuProjection.ts:17-177`: `geodeticToEcef`, `ecefToEnu`, `enuToEcef`,
  `ecefToGeodetic`, plus `enuForward(L, origin)` and `enuInverse([E,N], origin)`, with the same 6-iteration
  `U` adjust Audiom uses. Porting Audiom's algorithm into the starter is fine; we do not modify Audiom.
- **Plane choice (automatic, in sync)**. Build the probe matrix M (§4.3) in both planes. Let `a,b` be the row
  norms of M.
  - Choose `enu` iff `P_start` is a valid lng/lat (|lng| ≤ 180, |lat| ≤ 85), `|a/b − 1| < 0.005` in the ENU
    plane, and **not** `|a/b − 1| < 0.005` in the identity plane.
  - Otherwise choose `identity`. That covers custom-coordinate maps (J = I) and the equator band, where both
    planes agree to first order.
- A `mercator` plane (`(mercX(lng), mercY(lat))`, exact for Audiom's Web Mercator maps) is a
  one-line addition if large-extent maps ever matter. It is out of scope (§1).

### 3.4 Mirror functions (pure, `lib/dotpadViewport.js`) — exact ports of F6 in pin units

```
HW = floor(W/2) = 30; HH = floor(H/2) = 20; PW = W − 2o = 56; PH = H − 2o = 36
left(c) = c.x − HW;   top(c) = c.y + HH
worldToPin(q, c)  = [ Math.round(q.x − left(c)), Math.round(top(c) − q.y) ]   // JS Math.round, like Audiom
pinToWorld(p, c)  = [ left(c) + p.x, top(c) − p.y ]
isInnerPin(p)     = o ≤ p.x ≤ W−1−o  &&  o ≤ p.y ≤ H−1−o                        // [2..57]×[2..37]
panToKeep(c, q):  (same loop order as viewport.ts:76-95)
   while px < o     : cx −= PW ; recompute
   while px > W−1−o : cx += PW ; …
   while py < o     : cy += PH ; …
   while py > H−1−o : cy −= PH ; …
targetForPin(model, p) = isInnerPin(p) ? toLngLat(pinToWorld(p, model.center)) : null
```

A target for an inner pin never pages Audiom, because `worldToPin(pinToWorld(p)) = p`. The round-trip error
through lng/lat → Audiom internal is about 1e-9 m. The only way to have `x.5` ties is a non-lattice move
(a jump). Finger targets and keyboard steps from them stay on the lattice, because `moveAvatar` does not snap
(F10) and steps add exactly ±moveDistance.

### 3.5 Tracker (pure, stateful, clock-free — also in `dotpadViewport.js`)

```js
createViewportTracker({ geometry, echoTolPins = 1e-3, gridTol = 0.02, axisTolDeg = 2 }) → {
  state,                 // 'unsynced' | 'syncing' | 'synced' | 'stale'
  model, avatarPin(),    // mirror of Audiom's pin for the avatar
  beginSync(), completeSync(model, avatarLngLat), failSync(), invalidate(reason),
  targetForPin(p) → [lng,lat] | null     // null unless state==='synced'
  noteSent(lngLat)                        // echo FIFO (max 8)
  observe(lngLat) → { kind: 'echo'|'grid'|'offgrid'|'ignored', paged, avatarPin, becameStale, staleReason }
}
```

`observe(L)`:

1. If there is no model, or `state === 'syncing'`, store `lastL` and return `'ignored'`. The sync owns inference.
2. `q = toQ(L)`. If any FIFO entry satisfies `|e.q − q|∞ < echoTolPins`, the move is an **echo**: drop the FIFO
   up to and including that entry, since events are ordered.
3. Otherwise the move is **foreign**. Compute `Δ = q − lastQ` and `m = |Δ|`.
   - `|m − 1| ≤ gridTol` → `'grid'`. Update `headingAxis = atan2(Δ) mod 90°`.
   - Otherwise → `'offgrid'`, and record `aligned = angle(Δ) ≡ headingAxis (mod 90°) within axisTolDeg`.
   - **Stale signature**: this foreign move and the previous event are both offgrid-aligned, there was no echo
     between them, and `|m − m_prev|/m ≤ 0.01`. Then `state = 'stale'`, `staleReason = 'scale-changed'`,
     `becameStale = true`.
4. Always: `center = panToKeep(center, q)`, `paged = center changed`, `lastQ = q`. Even in `stale` the
   mirror keeps panning for the debug view.

Consequences, stated honestly:

- **Exact:** every page caused by keyboard, pad chords, jumps, recall or our own moves (F5 and F9 cover every
  position change).
- **Detected:** scale change followed by at least two keyboard steps.
- **Not detected:** a user bounce (−/= net zero), DOT Pad reconnect (re-activation re-centres, F4), pad pan
  keys (F7), a scale change followed by finger use only, and TactilePinView toggled with no pad. These are
  covered by manual Sync and by the tactile cue: the avatar blinks under the finger when aligned
  (`DotPadController` cursor blink).

---

## 4. Sync protocol (`lib/dotpadSync.js`, pure async with injected channel)

### 4.1 API

```js
runDotpadSync({ channel, tracker, sleep, settleMs = 40, onPhase }) →
  Promise<{ ok:true, model, stepRepaired:boolean, headingDeg, metresPerPin|null, commands:string[] }
        | { ok:false, reason:'no-response'|'blocked'|'invalid-probe'|'interrupted'|'embed-error'|'unexpected-scale', detail }>
```

- `channel` needs `executeCommand`, `getState`, `moveAvatar` and `onMessage`.
- `cmd(x)` means `executeCommand(x)` then `executeCommand(releaseFor(x))` for direction commands. The release is
  a no-op in grid mode (F13) and stops a first-person walk if grid switching was refused.

### 4.2 State machine

```
IDLE ─S/voice/auto─▶ PREP ──▶ GRID ──▶ START ──▶ PROBE_X ──▶ PROBE_Y ──▶ SOLVE
 ▲                                                                          │ invalid → FAIL
 │   ┌──────────────────────────────────────────────────────────────────────┘
 │   ▼
 │ ANCHOR_1 ─▶ BOUNCE ─▶ VERIFY ─┬─ k≈1 ───────────────────────────▶ DONE
 │                               ├─ k>1.05 ─▶ ANCHOR_2 ─▶ REPAIR ─▶ DONE
 │                               └─ k<0.95 / blocked ─────────────▶ FAIL
 └──────────────────────────── DONE / FAIL ◀─────────────────────────────────
```

| Phase | Action | Notes |
|---|---|---|
| PREP | `tracker.beginSync()`, which pauses finger sends. Subscribe `onMessage` for interference and errors. Host speaks "Syncing the DOT Pad. Hands off the keys." | |
| GRID | `executeCommand('activateGridView')` | Required. First-person `up` would walk until release, and left/right would turn (F13). Audiom says "Grid mode active…". |
| START | `P_start = getState()` | `null` → FAIL `no-response`. |
| PROBE_X | `r = probeAxis('right','left')` | See 4.3. Returns the plane displacement for one step **right**. The avatar is back at `P_start`. |
| PROBE_Y | `u = probeAxis('up','down')` | |
| SOLVE | Decompose `M = [r u]`, choose the plane (§3.3), validate, build `A₁` | 4.4 |
| ANCHOR_1 | `P0 = getState()` | Audiom's centre will be exactly this position after the bounce (F3). |
| BOUNCE | `executeCommand('smallerStep')`, `executeCommand('largerStep')` | Either both fire and restore the step, or (index 0) only `largerStep` fires and ends one notch up. The last spoken step is "Step size set to …". |
| VERIFY | `r₂ = probeAxis('right','left')` (fallback `up/down`), `k = ‖A₁⁻¹ r₂‖` | The avatar is at the centre, so ±1 pin never pages. |
| ANCHOR_2 / REPAIR | If `k > 1.05`: `P0 = getState()`, then `executeCommand('smallerStep')` | Restores index 0 and re-centres at P0 (F3). The scale is `A₁` again. |
| DONE | `model = {plane, planeOrigin: P_start, p0: P0, A: A₁, center: [0,0], …}`. `tracker.completeSync(model, getState())` → avatar pin (30,20). Host speaks "DOT Pad synced." plus "One pin is about X metres." when the plane is ENU (4.5). | |
| FAIL | If displaced, `moveAvatar(P_start)`. `tracker.failSync()` → `stale` if it had a model, else `unsynced`. Speak the reason. | |

**Interference guard (whole run).** Count `positionChanged` events. Each probe command is allowed exactly one
if `getState` shows it moved, otherwise zero. `moveAvatar(restore)` is allowed one. Any surplus event, any
`error` message, or a `getState` timeout aborts with `interrupted`, `embed-error` or `no-response`.
`settleMs` sleeps between messages are only for audio pacing. Correctness relies on F11 ordering.

Happy-path wire trace (golden list for tests):
`activateGridView, getState, right, right_release, getState, left, left_release, getState, up, up_release, getState, down, down_release, getState, getState, smallerStep, largerStep, right, right_release, getState, left, left_release, getState, getState`.
That is 6 grid moves and 2 step commands. The index-0 path adds `getState, smallerStep`.

### 4.3 `probeAxis(primary, opposite)`

```
s = getState()
cmd(primary);  a = getState()
if moved(a,s):  cmd(opposite); back = getState(); ensureAt(s, back); return plane(a) − plane(s)
cmd(opposite); b = getState()
if moved(b,s):  cmd(primary);  back = getState(); ensureAt(s, back); return plane(s) − plane(b)
throw blocked
moved(x,y)   = x[0] !== y[0] || x[1] !== y[1]              // exact, as AudiomMap.isInside does (1e-9 ok)
ensureAt(s,x): if ‖plane(x) − plane(s)‖ > 1e-6·‖step‖ → moveAvatar(s); getState()
```

Walls or the bounds fence (F13) block one direction, which is handled by stepping the other way. Wall sliding
produces a skewed vector, which SOLVE rejects. If both directions are blocked the result is FAIL `blocked` with
the message "Can't sync here — walls or the map edge block movement. Move somewhere open and sync again."

### 4.4 SOLVE (heading-robust)

With heading θ (F13): `fwd = (sin θ, cos θ)` and `right = (cos θ, −sin θ)`, so `Q(θ) = [[cosθ, sinθ],[−sinθ, cosθ]]`
and `M = A·Q(θ)`. For a diagonal-ish `A = diag(a,b)`: `M = [[a cosθ, a sinθ],[−b sinθ, b cosθ]]`.

```
a = ‖M row0‖, b = ‖M row1‖
θ₀ = atan2(M01, M00);  θ₁ = atan2(−M10, M11);  require circDiff(θ₀,θ₁) < 1°
R' = diag(1/a,1/b)·M;   require ‖R'ᵀR' − I‖max < 0.02 and det(M) > 0      → else FAIL invalid-probe
θ = circMean(θ₀,θ₁);   θs = 90°·round(θ/90°)
A₁ = |θ − θs| < 3°  ?  M · Q(θs)ᵀ      // cardinal heading: exact, keeps the plane rotation ε
                    :  diag(a,b)        // non-cardinal heading: ε ≈ 0 assumed (log it)
```

The 3° tolerance is safe because Audiom's turn angle defaults to 15° (F13). ε is tiny for city maps; this
branch only loses accuracy on regional maps with non-cardinal headings.

### 4.5 Scale for speech

For the ENU plane, `metresPerPin = √|det A₁|`. Snap it to the MovementTiers value list (metric and imperial,
`movementTiers.ts:11-66`, copied as a constant) if it is within 1%. Speak it with the same wording style as
Audiom ("1 metre", "50 cm", "0.25 miles"). For the identity plane, say nothing about scale.

### 4.6 Why this and not the alternatives

- **Right/left only (the original proposal).** One column cannot separate heading from axis scale, so it has to
  assume the user faces north. The two-axis probe costs two moves and removes that assumption.
- **Metres from geodesy plus tier snapping instead of probing.** Breaks custom-coordinate maps, needs Audiom's
  ENU origin, and still needs the bounce. Rejected.
- **`largerStep`→`smallerStep` bounce.** Not neutral at the top of a non-largest tier. Without a
  pre-measurement that looks exactly like "the user changed scale". smaller→larger fails only at index 0,
  where VERIFY sees k ∈ {2, 2.5, 3, …} and one `smallerStep` repairs it. Bonus: Audiom's **last** spoken
  step size is the true one.
- **`tierUp`/`tierDown`** reset the index, so they are not reversible. **No other re-anchor exists**: no
  tactile command is in `commands.ts`, and TactilePinView toggling does not re-activate a connected pad.
- **Probe before the bounce but no VERIFY.** Cannot tell index 0 from success.
- **Host keyboard proxy** (host keeps focus and forwards keys). It would reveal step changes, but it means
  re-implementing about 70 Audiom bindings and breaks Audiom's focus-dependent menus. Out of scope.

**Side effects of a sync (accepted).** Grid mode is forced and persisted in Audiom settings. There are 2–3
step-size announcements plus "Grid mode active". There are six step sounds and feature announcements, with
matching pad refreshes (on Gen-1, "Lift your hands" each time). The map's sticky default step is cleared
(F14). Prefs are written into ephemeral storage, since the iframe is `credentialless`.

---

## 5. When to sync — policy and UX

- **Connection is invisible to the host.** The user connects the pad inside Audiom (Display options → DOT Pad
  → Bluetooth/USB; the iframe must hold user activation, F15). Then the user presses **S** (host focused),
  the **Sync DOT Pad** button, or says "sync" (add to L0 lexicon, §8).
  - Sync before connecting is harmless. It stays valid only if the avatar does not move before the pad
    activates (F4), so the prompt says to connect first.
- **Bridge states:** `UNSYNCED → SYNCING → SYNCED ⇄ STALE → SYNCING`. Any `ready` from the embed (reload)
  goes to `UNSYNCED`.
- **Auto-resync:** only from `STALE` (signature, §3.5). It waits until 1.5 s pass with no foreign
  `positionChanged`, and the timer restarts on each foreign move. It aborts on interference (§4.2). There is
  no periodic sync, because of the side effects.
- **Finger sends** happen only in `SYNCED`. In `UNSYNCED` or `STALE`, pointing triggers a speech prompt at
  most every 10 s: "DOT Pad not synced — press S."
- **Speech (host `speak`)**:
  - On `ready`: "Map loaded. Connect the DOT Pad in Audiom's display options, then press S to sync."
  - Sync start and done messages as in §4.2.
  - Failure: the reason sentence.
  - Stale: "DOT Pad scale changed — re-syncing." (auto) or "…press S." (manual mode).
  - After a DOT Pad reconnect (the welcome text reappears on the pad), the user should press S. This is in
    the help text.
- **Keys** (window listener; they do nothing while focus is inside the iframe, which is documented in the
  UI): `S` sync, `R` register by corners, `A` auto-find pad, `;` fix/unfix homography.

---

## 6. Tracking and registration

### 6.1 Template asset `resources/dotpad_corners.json` (create with exactly this content)

Measured from `resources/dotpad.png`, which decodes to **352×292** RGBA. A comb fit of 60 and 40 teeth to
the mean column and row profiles gave period **3.3335 px on both axes** (square pitch). A 61st column or 41st
row lands on flat surround. Pin centres:

```json
{
  "image": "dotpad.png",
  "imageSize": [352, 292],
  "cols": 60, "rows": 40, "pinPitchPx": 3.3335,
  "pinCorners":    [[77.0, 57.34], [273.68, 57.34], [273.68, 187.35], [77.0, 187.35]],
  "displayWindow": [[62.0, 42.5], [288.5, 42.5], [288.5, 202.5], [62.0, 202.5]],
  "textWindow":    [[62.0, 248.5], [288.5, 248.5], [288.5, 269.5], [62.0, 269.5]],
  "bezel":         [[50.0, 30.5], [300.5, 30.5], [300.5, 214.0], [50.0, 214.0]],
  "maskPinField":  [[72.0, 52.3], [278.7, 52.3], [278.7, 192.4], [72.0, 192.4]],
  "note": "Corner order TL,TR,BR,BL. pinCorners are corner-PIN CENTRES. maskPinField = pin field ± 1.5 pitch."
}
```

The centre span aspect is 196.68/130.01 = 1.5128 = 59/39. The display window aspect is 226.5/160 = 1.416.
`lib/dotpadTemplate.js` exports the same numbers as `DOTPAD_TEMPLATE`, and a test asserts they equal the JSON.

### 6.2 Surface descriptor (`lib/surface.js`)

```js
export const DOTPAD = Object.freeze({ id: 'dotpad', label: 'DOT Pad (60 × 40 graphic area)',
  kind: 'refreshable', cols: 60, rows: 40, pinPitchMm: 2.5 });
```

- The pitch is **assumed nominal and unverified**. Measure a real pad with calipers. The render proves only
  that the pitch is square.
- Mapping depends only on the 59:39 centre-span aspect.
- `acuityGrid` uses `max(pitch, 2.5)`, so a 2.4 mm pitch would quietly shrink the grid to 57×38. The DOT Pad
  path **must use `cols`/`rows` directly** and never `acuityGrid`. Put this in the JSDoc.
- Add `DOTPAD` to `SURFACE_DESCRIPTORS`.

### 6.3 Four-corner mode (primary; existing flow, retargeted)

- Prompts: "Point at the {top-left…} corner pin of the DOT Pad and hold." `createCornerCapture` is unchanged.
- **Sanity check** after the 4th lock, pure `checkPinQuad(corners)` in `dotpadTemplate.js`:
  - The quad is convex and clockwise.
  - mean(top, bottom) / mean(left, right) is in [1.15, 2.0] (59/39 = 1.51, with room for perspective).
  - If either fails, say "Those corners don't look like the pin area — let's try again" and restart.
- **Hands-off reference.** Say "Registered. Lift your hand for a moment." Capture the AKAZE reference on the
  first frame where MediaPipe sees 0 hands for 400 ms, or after 4 s. The corners stay in snapshot pixels
  (the camera is static in that gap).
- **Reference mask.** `H_tpl→snap = homography(pinCorners_tpl → corners)`.
  - Mask = 255, then `fillConvexPoly(0)` over `H(maskPinField)` and over `H(textWindow)` expanded by 4 px.
  - Pass it to `detectAndCompute` instead of the empty `noMask` (`TactileExplorerGeneric.jsx:176-178`).
  - Live frames stay unmasked; RANSAC handles them.
- `HsnapToUv` is the existing `getPerspectiveTransform(corners → unit square)`, now meaning corner-pin centres.

### 6.4 Auto-find ("template") mode — geometric primary, pointing confirm

The user presses A. The host says "Take your hands off the DOT Pad" and waits until 0 hands are seen for 500 ms.

1. **OpenCV (in the component).**
   - Preprocess: gray → GaussianBlur 5×5 → Canny(40,120) → dilate 3×3, then `findContours(RETR_LIST)`.
   - Also run Otsu thresholding in both polarities, because the real pad's colours are unknown.
   - For each contour: `approxPolyDP(0.02·perimeter)`. Keep it if it has 4 vertices, is convex, and its
     area is ≥ 1% of the frame. Order the corners TL, TR, BR, BL.
2. **Pure selection** (`dotpadTemplate.selectDevice(quads, frameSize)`). For each quad Q taken as the
   display window, try 4 cyclic corner orders (device rotated 0/90/180/270):
   - Compute `H = homography(displayWindow_tpl → Q)`.
   - Score +1 if some other quad matches `H(textWindow)`, meaning its mean corner distance is < 8% of the
     display width. This resolves the rotation.
   - Penalise side-ratio disagreement with 1.416 beyond ±25%.
   - The best hypothesis gives `pinCorners = H(pinCorners_tpl)`.
3. **Confirmation (always when the text window was not found, optional otherwise).**
   - Say "Found the DOT Pad. Touch the top-left pin and hold."
   - One dwell lock using `createCornerCapture({})`, first corner only.
   - If the lock lands within 3 pitches of predicted corner i ≠ 0, rotate the order so that i becomes TL.
   - If it is near no corner, fail and fall back to four-corner mode.
4. Hand the result to the same path as §6.3: hands-off reference plus mask.
5. *(v2)* Lattice refinement: rectify the pin area and comb-fit period and phase as in §6.1, to correct any
   render-versus-hardware ratio error.

Rejected: AKAZE matching against `dotpad.png`. The only structure in it is two light rectangles on a dark
body plus periodic dots, which is exactly the phantom-homography problem the old `braille.png` border mask
fought (`git show 867d37f:starter/src/TactileExplorer.jsx` ~L195). The render is also not a photo.

### 6.5 Fingertip → pin → target (pure, `lib/dotpadPins.js`)

```js
createPinQuantizer({ cols:60, rows:40, hysteresis:0.35, offPadMargin:1 })
  .update(u, v) → { pin:[x,y] | null, f:[fx,fy] }
    fx = u·(cols−1), fy = v·(rows−1)
    off-pad if fx < −margin || fx > cols−1+margin || fy (same) → pin null, reset
    per axis: idx = clamp(Math.round(f), 0, n−1); keep prev if |f − prev| ≤ 0.5 + hysteresis
createSendGate({ minIntervalMs, dwellMs })
  .offer(key|null, now) → key to send now, or null
    null (border band / not synced) → reset candidate only
  .lift()  → reset candidate AND lastSentKey (finger gone: re-touching the same pin re-sends)
    key ≠ candidate → candidate = key, since = now
    send iff now−since ≥ dwellMs && now−lastSentAt ≥ minIntervalMs && key ≠ lastSentKey
PRESETS = { 'dotpad-x':    { minIntervalMs:150,  dwellMs:0,   hysteresis:0.35 },
            'dotpad-gen1': { minIntervalMs:2500, dwellMs:600, hysteresis:0.5  } }
```

Bridge per frame (`onUv`):

1. If `uv` is null (no pointing hand) or the quantizer returns an off-pad null pin, call `gate.lift()` and stop.
   Otherwise `pin = quantizer.update(u,v).pin`.
2. `target = tracker.targetForPin(pin)`. This is null for the border band or when not synced. In that case
   call `gate.offer(null, now)` and stop. Suppression is silent (decision 3).
3. Skip if `pin` equals `tracker.avatarPin()` or the pending echo pin.
4. Otherwise, when `gate.offer(key)` fires: `tracker.noteSent(target)` then `channel.moveAvatar(target)`.
5. After a page there is no automatic re-send. The same key is still `lastSentKey`, so the next finger
   movement sends.

**Optional (v1.1):** a contact-point offset, `tip − α·(tip − DIP)`. This needs `gestureRecognizer` to expose
landmark 7. Use α = 0 in corner mode, where the bias partly cancels because corners are pointed the same
way, and about 0.3 in auto-find mode. Expose it as a debug slider.

---

## 7. UI changes — `AudiomTactileApp.jsx` (DOT Pad mode replaces print mode)

- **Remove:** `fraction`, pan buttons, `cellsAcross`, `matW`/`matH`/letterbox, print aspect, `syncView`/`syncKey`,
  camera overlay on the map, `onBounds`/`onProbe` wiring (bounds discovery would push about 90 avatar moves,
  and pad frames, through the pad), and the `AudiomProbePanel` section. Leave that file unused.
- **Keep:** the map loader and predefined sources, AudiomMap's "What's here" and Mic, the camera debug panel,
  and the rectified side panel.
- **New "DOT Pad" section** (`aria-live="polite"` status line):
  - State: Not synced / Syncing… / Synced · 1 pin ≈ X · heading · pages from anchor / Out of sync.
  - Buttons: **Sync DOT Pad [S]**, **Register corners [R]**, **Auto-find pad [A]**, **Fix [;]**.
  - Controls: model preset (DOT Pad X / DOT Pad Gen-1), hysteresis slider, auto-resync checkbox (default on).
  - Short help: "connect in Audiom first; press S after connecting or reconnecting; host keys work only when
    focus is outside the map (Shift+Tab)".
- **Rectified panel.** Aspect 60:40. Draw the 60×40 pin dots, shade the 2-pin border band, show the finger pin
  in yellow and the mirrored avatar pin in blue, plus the page offset. Compare it with Audiom's own
  TactilePinView (Display options) during development.

`AudiomMap.jsx`:

- `allow="autoplay; fullscreen; bluetooth; serial"`.
- New prop `autoDrive = true`. When false, skip the throttled `coordRef` interval (`:343-356`); DOT Pad mode
  passes `false`.
- `onChannel` already exposes the channel.
- Leave `onBounds` undefined so discovery never runs (`:321`).

---

## 8. File-by-file change list

| File | Change |
|---|---|
| `src/lib/enu.js` **new** | ENU port (§3.3). Pure. |
| `src/lib/dotpadViewport.js` **new** | `DOTPAD_GEOMETRY` {60,40,2} with a comment citing F1; `worldToPin`, `pinToWorld`, `panToKeep`, `isInnerPin`, `createModel`, `toQ`, `toLngLat`, `createViewportTracker` (§3.4–3.5). Pure, no imports except `enu.js`. |
| `src/lib/dotpadSync.js` **new** | `runDotpadSync`, `probeAxis`, `solveProbe` (exported for tests), `choosePlane`, `TIER_VALUES_M`, `describeScale`. Pure async; `sleep` injected. |
| `src/lib/dotpadPins.js` **new** | `createPinQuantizer`, `createSendGate`, `PRESETS`. |
| `src/lib/dotpadTemplate.js` **new** | `DOTPAD_TEMPLATE` constants; 4-point DLT `homography4`, `applyH`, `checkPinQuad`, `selectDevice`, `maskPolygons(H)`. Pure; no OpenCV. |
| `resources/dotpad_corners.json` **new** | §6.1 verbatim. |
| `src/hooks/useDotpadBridge.js` **new** | Owns the tracker, quantizer, gate, sync runner, auto-resync timer, and speech prompts. It subscribes to `channel.onPosition` and `'ready'`. Returns `{ syncState, statusText, avatarPin, fingerPin, model, requestSync, onUv, preset, setPreset }`. |
| `src/lib/audiomChannel.js` | `INBOUND.POSITION_CHANGED = 'positionChanged'`; `onPosition(handler)` calls `handler([lng,lat])` via `toPosition(payload.position)`. |
| `src/AudiomMap.jsx` | `allow` attribute; `autoDrive` prop. |
| `src/TactileExplorerGeneric.jsx` | Output raw `onUv({u,v}\|null)`. Remove `bbox`/`onCoord`/letterbox/cell quantization. Corner prompts become pin prompts. `checkPinQuad` after capture. Hands-off reference capture. Reference mask (§6.3). `A` auto-find (§6.4) via OpenCV contours + `selectDevice` + 1-touch confirm. Rectified panel draws the pin grid from props `avatarPin`/`fingerPin`. Keys `r`, `a`, `;` keep the existing input-field guard. Only `AudiomTactileApp` imports it. |
| `src/AudiomTactileApp.jsx` | §7. Adds the `S` key. |
| `src/lib/surface.js` | `DOTPAD` descriptor and the acuity note (§6.2). |
| `src/lib/l0.js` | Optional: `sync`/`sync dot pad` → intent `dotpad_sync`, handled by the bridge via `onUtterance`. |
| `scripts/fixtures/fakeAudiom.mjs` **new** | Simulator (§9.1). |
| `scripts/test_dotpad_*.mjs` **new** | §9. |
| `audiom_io.md` | One paragraph linking this doc. |

---

## 9. Test plan

All tests are Node, in the `check()` style of `test_cornerRegistration.mjs`, fully offline, and use seeded
randomness.

### 9.1 `scripts/fixtures/fakeAudiom.mjs` — the oracle

A faithful port of the parts that matter:

- `viewport.ts` **verbatim**, in metres.
- `TactileRenderer` semantics: `activeConsumers`, `activate()`, the moveDistance reaction that fires only on
  change and also while inactive, `handlePositionUpdated` (only when active), and `pan()`.
- `MovementTiers`, both tables plus the ×2 extension.
- `smallerStep`/`largerStep`/`tierUp`/`tierDown`/`toggleUnits`.
- Grid moves via `angleToVector`. First-person mode: `up` walks one step per subsequent message until
  `up_release`, and `left`/`right` turn 15°.
- `activateGridView`, `snapTurn*`, `rotate180`, and `nextForward` (a random-length jump along the heading).
- A wall predicate and the bounds fence.
- `setPosition` exact-equality no-op.
- ENU (via `lib/enu.js` origin O) or identity projection.
- Embed protocol: `moveAvatar`/`getState`/`executeCommand` → `positionChanged`/`stateChanged`/`error`,
  delivered asynchronously (microtask) through a transport compatible with `createAudiomChannel`.
- Oracles: `rendererPinOfAvatar()`, `centerWorld()`, `moveDistance`, and `spoken[]`.

### 9.2 `test_dotpad_viewport.mjs`

- **Port parity.** For 10k random (centre, mpp, avatar) inputs, pin-unit `worldToPin`/`panToKeep` must equal
  the metre port.
- Inner-band edges: 1/2/57/58 and 1/2/37/38.
- `worldToPin(pinToWorld(p)) = p`.
- Walking right from the centre: the page happens at pin 58, the avatar lands on pin 2, and the centre
  becomes +56. Same vertically with 38 → 2 and 36.
- Tracker:
  - Echo matching.
  - A grid step is not flagged.
  - Two equal axis-aligned offgrid steps → stale.
  - A single `nextForward` jump → not stale.
  - An echo between offgrid steps → not stale.
  - `targetForPin` is null for border pins and when not synced.

### 9.3 `test_dotpad_sync.mjs` (fake Audiom + real `createAudiomChannel`)

1. Default (metric tier 1, index 2 = 1 m, heading 0, 40°N): the golden command list, `stepRepaired=false`,
   the final moveDistance is unchanged, and `tracker.avatarPin()` = (30,20) = oracle.
2. **Differential soak.** Per config, 500 random ops: finger `moveAvatar` to a random inner pin via
   `targetForPin`, keyboard grid steps, and occasional jumps. After every op the mirror avatar pin must equal
   the oracle pin, and the mirror centre must equal the oracle centre.
   - Configs: lat {0, 40, 60}, d ∈ {0.25, 1, 20, 100, 1000} m, heading {0, 90, 180, 270}, identity map.
   - Include a 20-page walk at 60°N with d = 20 m. **Negative control:** the identity plane on a geographic
     map must fail it, which proves §3.3 matters.
3. Index-0 (0.25 m tier 1): VERIFY k = 2 → REPAIR → moveDistance restored, and pins match.
4. Top of tier (5 m tier 1): neutral. Largest tier with doubling: neutral.
5. Heading 37°: sync succeeds with `A = diag` and pins match within the documented tolerance on a city map.
6. First-person paradigm at start: `activateGridView` is sent first, and no multi-step walk occurs.
7. Wall to the right: uses left. Both sides walled: `blocked`, and the position is restored.
8. Interference: inject a keyboard `right` mid-probe → `interrupted`.
9. Renderer inactive during sync, then `activate()` at the same position → still matching.
10. After sync: user `largerStep` + 2 × `right` → tracker stale. Auto-resync runs (fake clock) and pins
    match again.
11. Side-effect budget: ≤ 6 grid moves (≤ 8 on the index-0 path) and ≤ 3 step announcements.

### 9.4 `test_dotpad_pins.mjs`

- uv → pin at corners and centre.
- Hysteresis holds within 0.5 + h.
- Off-pad → null.
- Gate: min interval, dwell, the same key is not resent, lift resets, the border band does not reset
  `lastSentKey`.
- Presets.

### 9.5 `test_dotpad_template.mjs`

- JSON equals `DOTPAD_TEMPLATE`. Pin corners are consistent with pitch × 59/39. The masks contain the pin
  corners.
- `homography4` round trip.
- `selectDevice`: synthetic homographies (scale, rotation 0/90/180/270, perspective, plus distractor quads)
  of the template's display and text quads → the correct orientation, with pin corners within 0.3 pitch.
- A wrong-aspect quad is rejected. With no text window the result has `needsConfirm`.
- `checkPinQuad` accepts a perspective-distorted 59:39 quad and rejects 1:1 or a crossed quad.

Also extend `test_audiom_channel.mjs` (`onPosition`) and `test_surface.mjs` (DOTPAD present, 60×40, pitch
note).

### 9.6 Manual / hardware (Chrome)

1. **No hardware:** enable Audiom Display options → "tactile pin view" (activates the renderer, F4). Sync,
   point, walk with arrows, and compare Audiom's pin view with our rectified grid.
2. The `credentialless` iframe connects over **BLE and USB** with the new `allow` value (R1).
3. Gen-1 versus DOT Pad X: frame latency and the effect of the "Lift your hands" speech. Tune the presets.
4. Real pad: are the corner pins findable by touch? What pin-area colours does auto-find see? Measure the
   pitch.
5. Fingertip bias at the pin scale; decide α.

---

## 10. Risks and open questions

| R | Risk | Mitigation / status |
|---|---|---|
| R1 | Unverified: whether Web Bluetooth and Web Serial work inside a **`credentialless`** cross-origin iframe, even with `allow="bluetooth; serial"`. A popup cannot be used instead (F17). | Hardware test first. Fallback: for `audiom.html` in DOT Pad mode, skip `coi-serviceworker.js` and drop `credentialless`. That loses multithreaded wllama on that page only. |
| R2 | **Gen-1** re-renders and speaks "Lift your hands…" (interrupting speech) on every avatar pin change (F16). Pins move under the finger. | Gen-1 preset (dwell + 2.5 s). Recommend DOT Pad X. The host cannot see the generation, so the user picks the preset. |
| R3 | Undetectable re-centres: pad pan keys, reconnect (F4), a net-zero user bounce, the settings wizard unit change, and TactilePinView activation with no pad. | Manual S or voice. The blink-under-finger cue. Help text: "press S after reconnecting". |
| R4 | Sync side effects: grid mode is forced, 2–3 announcements, six steps with sounds and pad refreshes, the sticky default step is cleared. | Accepted. Host "Syncing…/Synced" framing. No periodic sync. |
| R5 | Finger targets outside `world.internalBounds` put the avatar where keyboard steps are fenced (F13), and a sync there fails `blocked`. | Accepted for v1. The failure message tells the user to move. v2: run bounds discovery *before* the pad is connected and clip targets. |
| R6 | Model envelope. Exact for identity maps. ENU residual is about D²S/2R² (mm across a city). Non-cardinal heading drops ε (about 30·ε pins). Web Mercator maps are unsupported. | Tests §9.3-2/5. The `mercator` plane is a future addition. |
| R7 | Fingertip landmark versus contact point: about 1–2 pins at 2.5 mm pitch. MediaPipe jitter is ±1 pin at 640 px. | Hysteresis 0.35. Recommend 1280×720 with the camera framing the pad. α offset in v1.1. |
| R8 | The render may not match the real pad (colours, frame, text window). | Auto-find needs a 1-touch confirmation. Four-corner mode stays primary. v2 lattice refinement. |
| R9 | Host keys are dead while focus is in the iframe; blind users must Shift+Tab out. | Voice "sync". Auto-resync on the stale signature. Keep the Sync button as the first focusable element after the iframe. |
| R10 | Upstream drift: the mirror hard-codes 60/40/2, `Math.round`, and the page loop order. | Constants cite F1/F6. The fixture's `viewport.ts` port has a header noting commit `87121f55`; re-diff on upgrade. |
| R11 | Host and Audiom speech collide (two synth sources). | Keep host utterances short and sparse. |
| R12 | Paged braille messages hold map frames (F16), e.g. the welcome shown on connect. | Accepted (decision 4). The user dismisses it with the pad chord. The renderer keeps paging, so the mirror stays valid. |

**Open questions for the user:**

1. DOT Pad model(s) in use (Gen-1 versus X) and the real pin pitch.
2. Is forcing grid mode on every sync acceptable, or should Sync refuse and ask the user to press G?
3. Auto-resync on by default (§5)?
4. Should an optional soft tick play when the finger enters the border band? Decision 3 says silent; this
   design leaves it off.
