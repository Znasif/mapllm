# Audiom I/O — making `starter` the browser CamIO-LLM for custom *and* OSM maps

**Status:** plan. Written 2026-08-27, after the command-vocabulary work landed.
**Companion docs:** `docs/browser-voice-exploration-plan.md` (milestones 1–15),
`docs/local-llm-tooling-design.md` (tool tiers). This document does not restate
them; it covers the one thing neither does — **how the two front doors become one
system, with Audiom as the substrate underneath both.**

---

## 0. The thesis, and what would falsify it

`simple_camio_llm` answers questions about a *printed map* a finger is touching. It
does this with a fixed pipeline: camera → registration → (u,v) → a world model →
tools → an LLM → speech. `starter` already has every one of those stages in the
browser. What it does not have is **one** of them; it has two of several, wired
into two tabs that share libraries but not a world.

The claim of this document is that Audiom is the right substrate to collapse that,
for both custom maps and OSM areas, because Audiom already solves the two problems
that otherwise have to be solved twice:

1. **Data.** `GET /map-definitions/:id/layers` returns resolved geometry with
   attributes, provenance and derived names, for *any* source the backend's
   layerloader understands — including OSM extracts. One request, then offline.
2. **Actuation.** 108 commands over `postMessage`, covering movement, orientation,
   scanning and narration, with Audiom's own spatial audio doing the output.

The first is **already demonstrated, not assumed**: `osm` is one of Audiom's four
source types and takes a bbox (§1.2). That is the same path that loads any Audiom
map with an avatar, so "OSM through Audiom" is not a new capability we are
proposing — it is a capability the OSM tab is currently bypassing.

What could still falsify the plan is narrower, and it is not technical: if minting
a `map_definitions` row per door-to-door area is not an acceptable use of Audiom's
backend, the substrate is unavailable in practice however well it works. That is
§2.2, and it is a question to ask rather than an experiment to run.

---

## 1. Where we actually are

Being precise about this matters, because the gap is not where it looks.

### 1.1 The Audiom pathway (`audiom.html` → `AudiomTactileApp`)

Genuinely end-to-end. `AudiomWorldAdapter` (Tier A) pulls real geometry from
`/map-definitions/:id/layers` and caches it; `audiomChannel` drives the embed;
four-corner touch registers the physical material; the six core tools answer from
cached geometry. Live-passed on map 885 (2,971 places, warm cache = 0 fetches).

### 1.2 The OSM pathway (`index.html` → `App`) — **redundant, not broken**

Two facts, and the second one dissolves the first.

**It has no world.** The tactile half is live OSM — `usePinGrid` calls
`queryRoadFeatures` on the Mapbox canvas and rasterises whatever you have panned
to, anywhere on Earth. The language half is not OSM at all: `useMapioDispatcher`
loads a static MapIO model (`MAPIO_MAPS` = `new_york`, `detroit_conant`) and
builds a `MapioWorldAdapter` from it. So you can point at a pin in Nairobi and be
told about Midtown Manhattan, fluently, and nothing errors because nothing checks.

**But Audiom already does OSM,** so the fix is deletion, not construction:

```js
// Audiom-Backend/src/services/dataset-attributes/dataset-attributes.class.js
const VALID_SOURCE_TYPES = new Set(['esri', 'geojson', 'osm', 'datasource']);
// "or { name: 'osm', center, bbox, size }."                        (line 471)
import { SOURCE_REGISTRY } from '@coughlan-lab/layerloader';
```

`osm` is a first-class source type taking a bbox, resolved through layerloader
like any other, and `map-definitions.class.js:69` is a plain Feathers `create()`
(with API-key cross-org write tests beside it) — so a definition can be POSTed
rather than hand-authored. **This is the same mechanism that loads an Audiom map
with an avatar in the first place.**

So M4 (`OsmWorldAdapter`) should not be built, and the MapIO stand-in should not
be repaired. The OSM tab is a second data path for a source Audiom already
serves.

### 1.3 What the two pathways now share

| | shared | notes |
|---|---|---|
| Registration | ✅ `lib/cornerRegistration.js` | four-corner touch, both tabs, 44 checks |
| Camera / pointing | ✅ `cameraDevices`, `gestureRecognizer` | one-euro + pointing gate |
| Tools | ✅ `toolRegistry` + `tools/` | six tools = the intersection of all five profiles |
| Adapters | ✅ `WorldAdapter` interface | audiom / camio / mapio implement it |
| LLM | ✅ `lib/llm` | wllama in-tab, l1 + l3, HTTP router behind the same seam |
| Speech | ✅ `lib/speech` | on-device STT, `speak.js` out |
| **World** | ❌ | audiom = real; osm = MapIO stand-in |
| **Actuation** | ❌ | `AudiomMap` has a channel; `AudiomAvatar` does raw `postMessage` |

---

## 2. Audiom as substrate: delete the second data path

A door-to-door OSM area *is* an Audiom map definition with an `osm` source. There
is no second data path to build, and the one that exists should go.

```
                      ┌─ custom map (885, campus, museum) ─┐
map_definitions row ──┤                                     ├─→ /layers → AudiomWorldAdapter
                      └─ OSM area (a few blocks, by bbox) ──┘        (one adapter, one cache)
                                                                             │
   physical material ── camera ── 4-corner touch ── (u,v) ── Surface ─────────┤
                                                                             ▼
                                                            ToolRegistry ── l3 ── speech
                                                                             │
                                                       audiomChannel ────────┘
                                                    (moveAvatar / executeCommand)
```

### 2.1 What the Mapbox side actually provides

Worth being exact, because only one item is a real capability:

| | keep? | why |
|---|---|---|
| `rasterizeRoads(features, bbox, cols, rows)` → 31×43 pin array | **yes** | Audiom returns geometry, not a pin raster. Already source-agnostic — takes plain features and a lng/lat bbox. Only `queryRoadFeatures(map, bbox)` is Mapbox-bound (`queryRenderedFeatures`), ~40 lines to re-feed from `/layers`. |
| sighted basemap + ground-truth probe marker | optional | debugging convenience; the Audiom embed renders its own MapLibre map |
| **pan anywhere with zero setup** | **the real question** | Mapbox needs no server state. Audiom needs a `map_definitions` row to exist, so panning would write rows into Audiom's database. See §2.2. |

### 2.2 Invert the causality: Audiom drives the renderer

Today Mapbox is the source of truth. `computeScaleBBox(map, ...)` turns the
current Mapbox view into `pinBbox`; the pin grid, the tactile registration and
the avatar all follow from it. Pan the map and everything downstream moves —
**including the requirement for data under it.** That is what made "pan anywhere"
look like it needed a `map_definitions` row per pan.

Turn it around and the problem mostly dissolves:

```
  NOW    Mapbox view ──→ pinBbox ──→ pin grid ──→ (u,v) ──→ moveAvatar ──→ Audiom
                  ↑                                                          │
              user pans                          Audiom's own navigation ────┘
                                                 (goes nowhere — invisible to us)

  PROPOSED   Audiom avatar ──→ getState ──→ window centre ──→ Mapbox easeTo
                  ↑                                     └──→ pin grid ──→ material
                  │
        fingertip (moveAvatar)  +  followRoad / nextForward / arrow keys
```

The avatar becomes the camera. Mapbox becomes a presentation layer that follows
it, and the tactile window's *extent* stays our own math — correctly, because
extent is a property of the physical device (43x31 pins at a chosen scale), not
of Audiom.

Four things fall out of this, and the last one is the answer to the pan question:

1. **No view-control API needed.** We only ever read `getState`. The missing
   `setView` message stops being a blocker because we stopped wanting it.
2. **Audiom's navigation finally reaches the material.** Today `followRoad` and
   `nextForward` move Audiom's avatar and the tactile window does not follow —
   the user's own arrow keys are invisible to the pins under their hand (D10).
   Under the inversion every one of the 27 `navigation` commands drags the window
   with it, which is what makes the A2 actuator tool worth building at all.
3. **One registration survives navigation.** The material is registered once; the
   window moves within the world instead of the world moving under the window.
4. **Pan stops meaning "mint a row".** Moving inside an already-loaded definition
   is avatar movement, not a new map. The row count collapses from *per pan* to
   *per area*.

### 2.3 What the inversion does not solve

The avatar is fenced to the definition's extent (`Avatar.attemptMove`, issue
#1377), so panning is bounded by **how big we mint**. O0 survives — but it shrinks
from "is a row-per-pan acceptable?" to "how large and how long-lived should one
row be?", which is a far easier conversation to have with the Audiom team.

⚠️ One asymmetry to respect: **`moveAvatar` bypasses that fence.** The embed
handler calls `world.avatar.setPosition()` directly, not `attemptMove`, so a
fingertip stream or a bounds probe can place the avatar outside the world where
the user's own keys cannot go. This is the most likely source of the
`RangeError: lng out of range` storm (§5, D11) — our outward-expanding probe
deliberately walks off the map, and nothing stops it.

### 2.3 Why the substrate is the right call

Three consequences:

1. **One world, one cache, one offline story.** The "load once, then offline"
   property (`audiomWorldAdapter.js:22`) becomes true for OSM too, instead of
   needing a second tiling/caching design. It also kills M10's 209 MB problem for
   the door-to-door case, because the backend does the extraction.
2. **Names and rulesets for free.** OSM tags are not feature names. Audiom's
   ruleset already turns a source into named, categorised features with
   `sourceName` provenance — which is exactly what `whats_here` and `PlaceIndex`
   need and what a raw OSM adapter would have to reinvent.
3. **Actuation comes with it.** `followRoad`, `nextForward`, `nearbyScan`,
   `aroundMe` work on any Audiom map. A hand-rolled OSM adapter would give us data
   and no verbs.

**The cost, stated plainly:** door-to-door becomes dependent on an Audiom backend
being reachable to mint a definition, where Mapbox needed only a token. That is a
real availability trade and it is the price of not maintaining two worlds.

---

## 3. The Audiom I/O contract

### 3.1 Reads — HTTP, iframe-free

`GET /map-definitions/:id/layers` → `AudiomWorldAdapter`. Independent of the
embed: **the iframe can be unmounted and every tool still answers.** This is what
makes "load with Audiom, then explore with the LLM alone" work, and it is already
true today, not a plan.

#### 3.1a Auth — measured 2026-08-29, both environments

Assumed wrong for most of this project's life, then tested:

| request, **no key at all** | staging | production |
|---|---|---|
| `GET /map-definitions` (listing) | 200 | 200 |
| `GET /map-definitions/:id/layers` | 200 (885, 27.3 MB) | 200 (133 → 2.9 MB, 430 → 884 KB) |
| `GET /dataset-attributes?sourceType=osm&bbox=…` | **401** | **401** |

**Map layers are public.** That is why audiom.net can be browsed without logging
in, and it means the tier-A read path needs no credential at all. Only the
arbitrary-bbox OSM extraction is gated — reasonably, since it runs an unbounded
query over any rectangle you name.

⚠️ **A wrong key is worse than no key.** `audiomWorldAdapter.js:329`: a
publishable key pinned to another org "loses org-1 rows to
`restrictAccessToOrganization`". Anonymous gets the public rows; an org-scoped
key scopes you to *that* org and silently drops the ones you wanted. So "send a
key to be safe" is not the safe default here — it is a way to see less.

⚠️ **The production backend host is not in this repo.** `audiomWorldAdapter.js:63`
defines only `AUDIOM_BACKEND_STAGING`. Production is
`https://audiom-backend.herokuapp.com`, found by probing. Nothing can run against
production until that constant exists.

**Consequences for anything that reads Audiom:**

- A map-id read needs no proxy and no key — construct `AudiomWorldAdapter` and
  call `loadMapDefinition(id)`, exactly as `audiom.html` does.
- An OSM-bbox read needs the key, so it needs a server to hold it. A browser page
  must never carry one.

**Unrelated finding, worth reporting upstream:** production
`/map-definitions/266/layers` (the Wisconsin Quaternary map, staging's 885) is
**broken** — `GeneralError: Rule "rule-86" (index 86) has no filter (filter is
absent); every feature would be dropped.` Auth succeeds and rule evaluation
fails, so anyone loading that map in production today gets nothing.

### 3.2 Writes — `postMessage` only

| message | use |
|---|---|
| `getState` | avatar position; returns lng/lat **degrees**, even on projected-CRS maps |
| `moveAvatar {position}` | `route_to` mode `fly_me_there`; also the fingertip stream |
| `executeCommand {command}` | the 108-command vocabulary |
| `getEnclosingFeatures` | **the one true sensor** — replies `featureSelected` with real features. Unused today; matters most on Tier C, where the adapter has nothing |
| `setFilters` | `{global, scan}` — narrows what the map reports |
| ← `featureEntered` / `featureSelected` | live feature-under-cursor stream |
| ← `error` | **rejection oracle** — unknown commands error, valid ones don't |

### 3.3 The command table — `src/lib/audiomCommands.js`

Generated from `explore/Audiom-Front-End/src/modules/commands.ts` +
`src/keymap.ts`. 108 commands, categorised: navigation 27, session 25, inform 19,
destructive 16, ui 13, movement 8. Cross-checked against a live embed — the 22
names in `PROBE_CONFIRMED` were accepted by map 885, and a test asserts every one
exists in the source table, which is how we detect the checkout drifting from the
deployed build.

**Commands are actuators, not sensors.** `executeCommand` returns no payload, so
`nearbyScan` narrates *to the user* and hands the model nothing. Anything the
model needs to *know* comes from the adapter — with exactly one exception,
`getEnclosingFeatures`, which is a genuine read and the only structured data the
embed will volunteer. This splits the tool design in two and is the single most
important consequence of the whole I/O contract.

**⚠️ `holdsUntilRelease`.** `up`/`down`/`left`/`right` are press events with
`_release` partners. In `InteractionParadigms.FirstPerson` the avatar walks on a
`setInterval` until the release arrives (`Avatar.ts:293`); in Grid — the default
(`Avatar.ts:93`) — it takes one discrete step. Use `releaseFor(name)` and always
send the pair. See §5.

---

## 4. The design that follows

### 4.1 Two tool families, not one

| family | mechanism | returns | examples |
|---|---|---|---|
| **Sensors** | `WorldAdapter` over cached geometry | data the model reasons over | the six core tools, `route_to` |
| **Actuators** | `audiomChannel.executeCommand` | "done" | `nearbyScan`, `aroundMe`, `followRoad`, `nextForward`, `announceDirections` |

Actuators are new territory: they fall **outside** the six-tool intersection that
`toolRegistry` currently relies on, so they need a real capability
(`audiomActuators`) on the `audiom_tier_a` / `audiom_tier_c` profiles — the first
capability-conditional handler in the registry. `commandNames()` already excludes
the 16 destructive commands by default; the servable set is `navigation` + `inform`
≈ 46, and session-altering commands should stay out of the model's reach entirely.

### 4.2a The benchmark's interface should be Audiom's, not MapIO's

Picking "the 50 POIs of the New York MapIO model" as the L1 corpus is fine for a
first number and wrong as an architecture: in production the index is built from
whatever Audiom hands over, so the benchmark should consume **what Audiom emits**
and let every layer translate to it — not the reverse.

Concretely that is NOT "materialise a MapIO `unified.json` from Audiom data".
Making a second file format the pivot buys a lossy round trip. The pivot should
be the **place record**, which already exists on both sides:

```
  audiom /layers ─→ AudiomWorldAdapter ─┐
                                        ├─→ normalisePlaces() ─→ placeDocument() ─→ L1
  mapio unified.json ─→ MapioWorldAdapter ┘        (routes on provenance)
```

`normalisePlaces` picks the normaliser off `provenance.source`, so a new adapter
that already emits the canonical shape needs no entry at all.

**Two real defects this exposed, both now fixed or recorded:**

1. `placeDocument()` reads `name`, `category`, `locationDescription`,
   `accessibility`, `context`. An Audiom record has none of the last three, and
   `props` — where the adapter parks every source attribute — was **never read**.
   An Audiom-fed index embedded `"Name. category."` and retrieved accordingly.
   `audiomWorldAdapter.js:235` had deferred this explicitly: *"That re-derivation
   is M8's, not M5a's; `props` carries everything so the decision can be made
   downstream."* `fromAudiomPlace` is that decision. **Done.**
2. **`places` is not on the `WorldAdapter` interface.** `mapio` and `camio`
   expose a method; `audiom` exposes a *field*, so it cannot gain a method of the
   same name without renaming ~14 call sites. `placesOf(adapter)` isolates the
   inconsistency in one place; unifying it properly is **D12**.

### 4.2 One surface, two materials

`Surface` already negotiates (u,v) ↔ material aspect. Nothing new is needed: a
BrailleDoodle sheet and a printed Audiom map are both "a rectangle with an aspect
and a pin pitch". The four-corner registration made this real by removing the last
material-specific asset (`brailledoodle_corners.json`) from the camera path.

**Unresolved and blocking a truly shared workflow:** the two tabs disagree about
*which* rectangle the user touches. Audiom expects the **sheet** corners and
letterboxes inside them (`fitRef`); OSM expects the **artwork** corners because
`pinBbox` is already shrunk by `cornerFractionsRef`. Same four spoken prompts, two
different referents. Fix before the first user-facing build (§6, M-U1).

---

## 5. Open defects

These are all measured, not suspected. None is map-specific.

| # | Defect | Where | Consequence |
|---|---|---|---|
| D1 | Bounds probe measures a **cross-section**, not a bbox — four rays from one seed | `AudiomMap.discoverBounds` | aspect off by −9.5% on 885 (0.858 vs 0.948 truth) |
| D2 | Probe is **blind below ~54 m** and fails silently: expansion starts at 0.5°, bisects 10× | `findEdge` | small/indoor maps get a plausible fabricated box |
| D3 | Overlay drawn at the `1.387` aspect fallback, behind a **width-only** guard | `TactileExplorerGeneric:460,570` | overlay stays wrong after the aspect is known |
| D4 | Window centre uses the **degree** midpoint on a Mercator box | `AudiomTactileApp:104` | centre disagrees with the drawn centre on tall maps |
| D5 | `up`/`left` sent with **no `_release`** | `discoverBounds` | safe only because Grid is the default; first-person → runaway + `left` turns instead of moving, silently breaking the oracle |
| D6 | Registration referent differs between tabs | §4.2 | ~22% scale error if the wrong rectangle is touched |
| D7 | `r` = re-register collides with Audiom's **Toggle Beacon** | both explorers | keypress silently goes to whichever has focus |
| D13 | Generated cases name their place **verbatim**, so L1 is never exercised | `caseGen.js` templates | recall 0/15 alongside 70% accuracy; the benchmark cannot judge retrieval — §7a.3 |
| D14 | Tool schemas are **80% of every prompt** (1,118 of ~1,390 tokens) | `toolRegistry.serve()` | sent every turn, every round; the largest single lever on latency — §7a.4 |
| D15 | No production backend constant; only `AUDIOM_BACKEND_STAGING` exists | `audiomWorldAdapter.js:63` | nothing can run against production — §3.1a |
| D16 | ~10 assertions in `test_wllama_backend.mjs` are **oracles**, encoding belief about wllama | that file | they cannot detect a misunderstanding of the dependency — §7a.2 |
| D8 | OSM tab answers from MapIO data while rendering live OSM pins | §1.2 | confidently wrong answers anywhere outside NY/Detroit, no error |
| D9 | `audiomChannel.js:222` contains a literal NUL byte | — | plain `grep` silently finds nothing in that file |
| D10 | Audiom's own navigation never reaches the tactile window | `App`/`AudiomAvatar` | user presses `followRoad`, avatar moves, pins under their hand do not — fixed by §2.2 |
| D12 | `places` is a method on mapio/camio and a field on audiom; not on the `WorldAdapter` interface at all | `worldAdapter.js` | every caller must know which; `placesOf()` hides it for now |
| D11 | `moveAvatar` bypasses the bounds fence (`setPosition`, not `attemptMove`) | Audiom embed handler | we can strand the avatar off-map; strongly suspected cause of the `lng out of range` storm during bounds probing |

D8 is the one that makes the product wrong rather than imprecise. D5 is the one
most likely to waste a day when it fires.

---

## 6. Milestones

Continuing the numbering in `browser-voice-exploration-plan.md` §5. Gates are hard.

| # | Milestone | Gates | Est. | Status |
|---|---|---|---|---|
| **G1** | **Self-scoring tool-selection benchmark** — `lib/parity/toolEval.js` + `scripts/eval_tools.mjs`, grading rules copied from `eval_tools.py` | 7 | — | **done 2026-08-28** — 52 checks, 6 mutations caught, `--dry-run` needs no server |
| **G2** | Run G1 on the wllama arm — **the first automatic number this stack has ever produced** | G1 | — | **done 2026-08-29** — 16/23, L1 recall 0/15; see §7a |
| **G2b** | Build the benchmark's L1 corpus from a **live** Audiom read rather than a snapshot | G2 | — | **done 2026-08-29** — `tooleval.html` fetches at the start of every run |
| **G2c** | Rewire the map-id arm onto `AudiomWorldAdapter.loadMapDefinition()` — no key, no proxy, the same object the app uses (§7a.5) | G2b | 0.5 d | next |
| **G3** | **Indirect-reference cases** — generate *"the Korean place"* from Audiom's own props (`amenity`, `cuisine`, `shop`) with the feature's name as the expected answer. Without these nothing measures L1 (D13) | G2c | 2 d | blocks every retrieval question |
| **G5** | Settle candidate-injection vs retrieval-as-a-tool on G3's cases, with `swa_full` on — the prior measurement is uninspectable and predates a 40× change in re-prefill cost (§7a.4) | G3 | 2 d | |
| **G6** | Shrink the 1,118-token tool block (D14) — shorter descriptions, or fewer tools per turn | G3 | 2 d | measure before and after on G3 |
| **G4** | Actuator cases (`nearbyScan`, `followRoad`, …) once A2 exists; grade tool choice, not prose | A2, G3 | 1 d | |
| **A1** | Audiom command table from source, categorised, cross-checked against a live embed | 5b | — | **done 2026-08-27** — `lib/audiomCommands.js` (108) + `audiomCommandProbe.js`, 128 checks |
| **A2** | `audiomActuators` capability + `audiom_command` tool; `navigation`+`inform` only; destructive and session commands unreachable | A1, 7 | 3 d | next |
| **A3** | Hold/release correctness — `releaseFor()` used everywhere; `discoverBounds` sends the pair; assert Grid paradigm before probing | A1 | 1 d | fixes D5 |
| **U1** | One registration referent across both tabs; prompts name it explicitly; re-register key moved off `r` | — | 1 d | fixes D6, D7 |
| **B1** | Bounds from the **map definition** (`center`/`zoom`/`extent`/`anchors`) instead of avatar probing; probe becomes the fallback and says so | 5a | 3 d | fixes D1, D2 |
| **I1** | **Invert causality — Audiom's avatar drives the Mapbox view and the pin window, not the reverse** (§2.2) | 5b, O3 | 3 d | fixes D10; collapses the pan problem |
| **O0** | **Agree with the Audiom team how large and how long-lived one minted definition should be** — post-inversion this is a sizing question, not a rate question | — | a conversation | gates the OSM area work |
| **O1** | Mint a definition from a bbox: `POST /map-definitions` with `sources: [{name:'osm', bbox}]`, read it back through `/layers` | O0 | 2 d | source type already exists; this is plumbing |
| **O2** | Re-feed `rasterizeRoads` from `/layers` instead of `queryRenderedFeatures`; retire `queryRoadFeatures` and the MapIO stand-in | O1, 5a | 3 d | fixes D8; **deletes** code |
| **O3** | `AudiomAvatar` gets a real `audiomChannel` so the OSM tab has actuation and the probe | O2 | 2 d | |
| **O4** | Retire the Mapbox basemap, or keep it explicitly as a sighted-debug affordance | O2 | 1 d | decision, then deletion |
| **E1** | l1/EmbeddingGemma `PlaceIndex` over Audiom-derived places, both map kinds | 8, O2 | 3 d | |
| **V1** | Parity harness extended to the Audiom route, graded like `P-eval` | A2, O2 | 1 w | |

**Critical path:** ~~G1 → G2 → G2b~~ → G2c → **G3** → O0 → O1 → O2 → I1 → A2 → V1.

**The benchmark comes first, deliberately.** It is the cheapest instrument that
tells us *what data and tools actually need exposing*, and unlike the parity
harness it costs nothing to interpret, so it can run on every change. That was
borne out on the first run: G2 produced a number in minutes and the number
immediately exposed a silent embedding bug, a blind spot in the dataset, and the
fact that 80% of every prompt is tool schema (§7a).

**G3 is now the gate, not G2.** A benchmark whose every question already contains
its own answer cannot measure retrieval, so G5 and G6 — and any argument about
how much context to send — are unanswerable until the indirect-reference cases
exist.

**I1 is what makes A2 worth building.** An actuator tool that moves an avatar
nobody can feel is a demo; one that drags the tactile window under the user's
hand is the product.

**O0 is a question, not a build**, and the inversion shrinks it. Audiom's `osm`
source type and the `map-definitions` create endpoint both already exist, so
nothing here is a feasibility risk. Before §2.2 the worry was minting a row per
pan; after it, panning happens inside one definition and the only open question is
how big to mint and how long to keep it. Ask before building.

**M4 (`OsmWorldAdapter`) is cancelled.** It was scoped when we assumed OSM needed
its own data path. It does not.

---

## 7. Verification

The house rule holds: **platform-free modules, exercised from Node.** Everything
in `lib/` that this plan adds must be importable without `window`, `document` or
`import.meta.env`, with the transport injected — as `audiomChannel`,
`audiomWorldAdapter` and `audiomCommandProbe` already are.

Three things need a browser and cannot be faked, and should be the *only* things
that do: the camera, the live `executeCommand` round trip, and speech.

| Question | How it gets answered |
|---|---|
| Does the source command table match the deployed build? | `PROBE_CONFIRMED` ⊆ `COMMANDS`, asserted; re-run `audiomProbe()` after any Audiom deploy |
| Is the minted definition equivalent to a hand-authored one? | O1, against ≥3 areas of different density |
| Does the model pick the right tool? | G1/G2 — mechanical, self-scoring, no human. Run it on every change |
| Is the Audiom route as good as MapIO? | V1, same 28-turn runner and grading as `P-eval` |
| Does registration land where it should? | the derived-edge visualiser (`AudiomProbePanel`), seed offset as % of half-extent |

**Sweeps must never fire session-altering commands.** The 2026-08-27 sweep toggled
sonar, the beacon and ambient sounds on a live session because the exclusion rule
said "destructive" and these read as harmless. They are excluded now; the rule is
*"anything that leaves the session changed"*, and there is a test for it.

---

## 7a. What the first benchmark run taught us — 2026-08-29

The first `tooleval.html` run against live Audiom data. The headline number is
the least interesting thing in it.

```
CORRECT      16/23 (70%)     tool 16/23     args 16/23
L1 recall     0/15            false pos 0    refusals held 4/4
```

### 7a.1 wllama does not batch embeddings

`createEmbedding` types its parameter `input: string | string[]` and returns
**exactly one embedding** however many inputs it is given. `LocalLLMClient.embed`
was written against the HTTP router, which returns one per input, so it wrote a
single vector into a 2,410-slot array and left 2,409 holes. **Nothing threw.**
The index reported 2,410 places; every count looked healthy; retrieval silently
degraded to "whatever came first in the corpus" — the same five names returned
for all 23 queries, in file order.

Fixed in `WllamaTransport.embeddings()`, which loops one call per input. It is
difference 4a in that file's header. Sequential on purpose: the instance is
`n_parallel: 1`, so concurrency would queue inside the worker.

**Cost of the fix:** indexing 2,410 places is now 2,410 sequential inference
calls, minutes rather than seconds. `PlaceIndex` must therefore use a persistent
store (`defaultStore()` → IndexedDB); pinning it to `MemoryStore` re-embeds the
whole corpus on every run.

### 7a.2 A fake is safe as a spy and dangerous as an oracle

Eighteen green suites missed the above because `FakeWllama.createEmbedding`
returned one vector per input — it modelled the OpenAI **contract**, which is
what we believed, rather than the wllama **implementation**, which is what runs.

Of 100 checks in `test_wllama_backend.mjs`, ~23 read what we *sent* (tier
routing, load params, prefixes, clamping) and ~10 read what the fake *returned*.
The first kind tests our own decisions and is worth having. The second kind
encodes a belief about the dependency, and **a fake can never discover that the
belief is wrong.** Batching sat squarely in the second kind.

What actually caught it: `checkEmbeddings()` running against real wllama in the
browser, plus grading L1 recall separately from L3 selection so `0/15` could not
hide under a plausible `70%`. Neither is a fake. Every remaining oracle assertion
wants a dated contract measurement behind it rather than an assumption.

### 7a.3 The dataset cannot measure L1 — a flaw in the generator

Every place-bearing utterance `caseGen.js` emits names its place **verbatim**:
*"Describe Valley Bank"*, *"How far is Acronym?"*. The model reads the name off
the question, so L1 has nothing to resolve. That is the real reason recall could
be 0/15 while accuracy held at 70%, and fixing the batching bug will barely move
this dataset.

What L1 exists for is the **indirect reference** — *"the Korean place"*,
*"somewhere for coffee"* — and none of the 23 cases contain one. The material to
generate them is already in hand: 594 distinct property keys on the Empire State
bbox, including `amenity`, `cuisine`, `shop`. A case built from `cuisine=korean`
whose expected answer is the feature's name is a real retrieval test. **Until
those exist, no measurement can say whether the candidate block earns its
tokens**, so no argument about prompt-stuffing versus retrieval-as-a-tool can be
settled.

### 7a.4 What we actually send, and who sends it

Measured on one case: **~1,390 tokens to ask a 6-token question.**

| | tokens | share |
|---|---|---|
| tool schemas (7 tools, already capability-filtered from 12) | 1,118 | 80% |
| system prompt | 243 | 17% |
| user turn (L1 candidate block + the question) | 29 | 2% |

The candidate block is not the cost. **The tool schemas are**, and they are sent
every turn.

The orchestration is four modules in one browser tab — no server, no daemon:

```
Dispatcher.handle()                                    dispatcher.js
  ├─ L0  control / whats_here off the featureEntered stream   (no model)
  ├─ L1  placeIndex.resolve() → buildUserTurn()               (no model)
  └─ L3  runToolLoop()                               toolLoop.js
        ├─ client.chatCompletion() → WllamaTransport → WASM worker
        └─ on tool_call → executeTool()              dispatcher.js:215
              └─ registry.dispatch() → AudiomWorldAdapter
                    reads an in-memory array, filled once at map load
```

So a tool round-trip costs **no network and no I/O** — the data is already in
memory. Its entire cost is one more model decode plus a re-prefill. Pre-emptive
versus on-demand is a token/latency question against a local model, nothing else.

⚠️ `dispatcher.js:11` says candidate injection "was measured as strictly better
*unconditional* than gated". Two caveats now attach to that: **the measurement
cannot be inspected** — it survives only as that sentence, and the parity harness
that produced it was deleted on 2026-08-28 — and **the condition it was made
under has changed**, since `swa_full` cut mid-prompt prefix reuse from 38.5 s to
0.91 s. A second round trip may simply cost 40× less than it did when that call
was made.

### 7a.5 Reuse the adapter; do not re-implement it

`tooleval.html` originally hand-rolled `fetch` → flatten layers → build place
records. That is `loadMapDefinition()` → `#flatten()` → the adapter's own place
construction, written worse. `AudiomWorldAdapter` takes `baseUrl`, `apiKey`,
`fetchImpl` and `store` as injectable options and reads no `import.meta.env`; it
was built to be used outside the app. A map-id read in any page should be
`new AudiomWorldAdapter({ baseUrl }).loadMapDefinition(id)`.

The one genuine gap: the adapter's only entry point is
`/map-definitions/:id/layers`. It cannot read `/dataset-attributes`, so an
arbitrary OSM bbox has no adapter path — that is **O1**.

---

## 8. What this does not solve

- **Routing on non-walkable maps.** 885 correctly refuses to build a graph — its
  lines are geological contacts, not a network. M12b still has no real-data
  validation and needs a walkable Tier-A map.
- **Tier C.** Everything above assumes a readable `map_definitions` row. A
  third-party embed we cannot query stays name-only, answered from
  `featureEntered` at L0, and the actuator family is *more* valuable there, not
  less — it is the only thing that works.
- **Indoor / small maps.** D2 says the probe is blind below ~54 m. B1 removes the
  probe from the happy path but not from the fallback.
- **Non-Chromium browsers.** The whole stack is Chrome-only by construction:
  `credentialless` iframes for COEP, on-device `SpeechRecognition`, and
  `SharedArrayBuffer` for multithreaded wllama.
