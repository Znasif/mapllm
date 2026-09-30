/**
 * fakeAudiom — an offline oracle for the DOT Pad bridge.
 *
 * Design: `docs/dotpad-camio-design.md` §9.1. A faithful port of the parts of
 * Audiom that the viewport mirror and the sync protocol depend on, taken from
 * `explore/Audiom-Front-End` at `origin/master` 87121f55 (re-diff on upgrade):
 *
 *   - `modules/tactile/viewport.ts` VERBATIM, in metres (tactileWorldBounds,
 *     worldToPin, panTactileViewport, panViewportToKeepAvatar);
 *   - `TactileRenderer` semantics: activeConsumers, activate() re-centring on
 *     0→1, the moveDistance reaction (fires only on change, and ALSO while
 *     inactive), handlePositionUpdated (only when active), pan();
 *   - `MovementTiers` — both tables, stepUp/stepDown/tierUp/tierDown, and the
 *     ×2 extension of the largest tier;
 *   - `Avatar`: heading-relative grid moves via angleToVector, first-person
 *     `up` walking until `up_release` (one step per subsequent message) and
 *     left/right turning 15°, snapTurn*, rotate180, nextForward (random-length
 *     jump along the heading), a wall predicate and the bounds fence, and the
 *     exact-equality no-op in setPosition;
 *   - projection: ENU at origin O via `src/lib/enu.js`, or identity
 *     (customCoordinateSystem);
 *   - the embed protocol: moveAvatar / getState / executeCommand in,
 *     positionChanged / stateChanged / error out. Inbound handling is
 *     synchronous (F11); delivery each way is a microtask, like postMessage.
 *
 * The transport plugs straight into `createAudiomChannel({ post, subscribe })`.
 *
 * Oracles for tests: `rendererPinOfAvatar()`, `centerWorld()`, `moveDistance`,
 * `spoken[]`, `firstPersonSteps`.
 */

import { enuForward, enuInverse } from '../../src/lib/enu.js';

export const FAKE_ORIGIN = 'https://fake.audiom.test';

/* ---------------------------------------------- viewport.ts (verbatim) -- */

export function tactileWorldBounds(viewport) {
  const left = viewport.center[0] - Math.floor(viewport.width / 2) * viewport.metersPerPin;
  const top = viewport.center[1] + Math.floor(viewport.height / 2) * viewport.metersPerPin;
  return {
    left,
    right: left + (viewport.width - 1) * viewport.metersPerPin,
    top,
    bottom: top - (viewport.height - 1) * viewport.metersPerPin,
  };
}

export function worldToPinMetres(position, viewport) {
  const bounds = tactileWorldBounds(viewport);
  return [
    Math.round((position[0] - bounds.left) / viewport.metersPerPin),
    Math.round((bounds.top - position[1]) / viewport.metersPerPin),
  ];
}

export function panTactileViewport(viewport, direction) {
  const horizontalPage = viewport.width - 2 * viewport.overlapPins;
  if (horizontalPage <= 0) throw new Error('Tactile viewport overlap must leave a positive page size');
  const directionMultiplier = direction === 'left' ? -1 : 1;
  return {
    ...viewport,
    center: [viewport.center[0] + directionMultiplier * horizontalPage * viewport.metersPerPin, viewport.center[1]],
  };
}

export function panViewportToKeepAvatar(viewport, avatarPosition) {
  const horizontalPage = viewport.width - 2 * viewport.overlapPins;
  const verticalPage = viewport.height - 2 * viewport.overlapPins;
  if (horizontalPage <= 0 || verticalPage <= 0) {
    throw new Error('Tactile viewport overlap must leave a positive page size');
  }
  let centerX = viewport.center[0];
  let centerY = viewport.center[1];
  let candidate = viewport;
  let [pinX, pinY] = worldToPinMetres(avatarPosition, candidate);
  const maxX = viewport.width - 1 - viewport.overlapPins;
  const maxY = viewport.height - 1 - viewport.overlapPins;

  while (pinX < viewport.overlapPins) {
    centerX -= horizontalPage * viewport.metersPerPin;
    candidate = { ...viewport, center: [centerX, centerY] };
    [pinX, pinY] = worldToPinMetres(avatarPosition, candidate);
  }
  while (pinX > maxX) {
    centerX += horizontalPage * viewport.metersPerPin;
    candidate = { ...viewport, center: [centerX, centerY] };
    [pinX, pinY] = worldToPinMetres(avatarPosition, candidate);
  }
  while (pinY < viewport.overlapPins) {
    centerY += verticalPage * viewport.metersPerPin;
    candidate = { ...viewport, center: [centerX, centerY] };
    [pinX, pinY] = worldToPinMetres(avatarPosition, candidate);
  }
  while (pinY > maxY) {
    centerY -= verticalPage * viewport.metersPerPin;
    candidate = { ...viewport, center: [centerX, centerY] };
    [pinX, pinY] = worldToPinMetres(avatarPosition, candidate);
  }
  if (centerX === viewport.center[0] && centerY === viewport.center[1]) return viewport;
  return candidate;
}

/* ------------------------------------------------------- MovementTiers -- */

const IMPERIAL_TIERS = () => [
  [0.0254, 0.0762, 0.1524, 0.3048, 0.6096],
  [0.3048, 0.6096, 0.9144, 1.524, 3.048, 4.572],
  [6.096, 15.24, 30.48, 60.96, 91.44],
  [160.934, 402.336, 804.672, 1609.344, 3218.688],
  [16093.44, 40233.6, 80467.2, 160934.4, 321868.8, 804672, 1609344],
];
const METRIC_TIERS = () => [
  [0.01, 0.025, 0.05, 0.1, 0.25],
  [0.25, 0.5, 1, 2, 3, 5],
  [5, 10, 20, 50, 100],
  [100, 250, 500, 1000, 2000],
  [10000, 25000, 50000, 100000, 200000, 500000, 1000000],
];

export function createMovementTiers({ unitSystem = 'metric', tier = 1, stepIndex = 2 } = {}) {
  // Per instance: the largest tier's ×2 extension mutates its table.
  const tables = { metric: METRIC_TIERS(), imperial: IMPERIAL_TIERS() };
  let system = unitSystem;
  let currentTier = Math.max(0, Math.min(4, tier));
  let currentStepIndex = stepIndex;
  const tiers = () => tables[system];
  const t = {
    get tier() { return currentTier; },
    get stepIndex() { return currentStepIndex; },
    get unitSystem() { return system; },
    getCurrentDistance() {
      const steps = tiers()[currentTier];
      return steps[Math.min(currentStepIndex, steps.length - 1)];
    },
    stepUp() {
      const steps = tiers()[currentTier];
      const isLargestTier = currentTier === tiers().length - 1;
      if (currentStepIndex < steps.length - 1) { currentStepIndex++; return true; }
      if (isLargestTier) {
        steps.push(t.getCurrentDistance() * 2);
        currentStepIndex++;
        return true;
      }
      return false;
    },
    stepDown() {
      if (currentStepIndex > 0) { currentStepIndex--; return true; }
      return false;
    },
    tierUp() {
      if (currentTier < tiers().length - 1) { currentTier++; currentStepIndex = 0; return true; }
      return false;
    },
    tierDown() {
      if (currentTier > 0) {
        currentTier--;
        currentStepIndex = Math.min(currentStepIndex, tiers()[currentTier].length - 1);
        return true;
      }
      return false;
    },
    toggleUnits() { system = system === 'metric' ? 'imperial' : 'metric'; },
  };
  return t;
}

/* ------------------------------------------------------------- geometry -- */

export function angleToVector(degrees) {
  degrees %= 360;
  if (degrees < 0) degrees += 360;
  const radians = (degrees * Math.PI) / 180;
  return [Math.sin(radians), Math.cos(radians)];
}

const normalizeAngle = (a) => ((a % 360) + 360) % 360;

/** Seeded PRNG (mulberry32). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* --------------------------------------------------------------- Audiom -- */

const KNOWN_COMMANDS = new Set([
  'up', 'down', 'left', 'right', 'up_release', 'down_release', 'left_release', 'right_release',
  'activateGridView', 'activateFirstPersonView', 'smallerStep', 'largerStep', 'tierUp', 'tierDown',
  'toggleUnits', 'snapTurnLeft', 'snapTurnRight', 'rotate180', 'nextForward', 'stopSpeech',
]);

/**
 * @param {object} [options]
 * @param {'enu'|'identity'} [options.projection]
 * @param {number[]} [options.origin]      ENU origin O (Audiom's minPoint) — external coords.
 * @param {number[]} [options.start]       Avatar start — external coords.
 * @param {string} [options.unitSystem]
 * @param {number} [options.tier]
 * @param {number} [options.stepIndex]
 * @param {number} [options.heading]       Compass degrees.
 * @param {'grid'|'firstPerson'} [options.paradigm]
 * @param {boolean} [options.rendererActive] A DOT Pad / TactilePinView is subscribed.
 * @param {(from: number[], to: number[]) => boolean} [options.wall] Internal coords; true blocks.
 * @param {number[]|null} [options.bounds] Internal [minX, minY, maxX, maxY] fence.
 * @param {() => number} [options.rng]
 * @param {number} [options.turnAngle]
 */
export function createFakeAudiom({
  projection = 'enu', origin = [-73.99, 40.7], start = null,
  unitSystem = 'metric', tier = 1, stepIndex = 2, heading = 0,
  paradigm = 'grid', rendererActive = true, wall = null, bounds = null,
  rng = mulberry32(1), turnAngle = 15,
} = {}) {
  const toInternal = (L) => (projection === 'enu' ? enuForward(L, origin) : [L[0], L[1]]);
  const toExternal = (P) => (projection === 'enu' ? enuInverse(P, origin) : [P[0], P[1]]);

  const tiers = createMovementTiers({ unitSystem, tier, stepIndex });
  const avatar = {
    position: toInternal(start ?? origin),
    orientation: normalizeAngle(heading),
    moveDistance: tiers.getCurrentDistance(),
  };
  let mode = paradigm;
  let activeConsumers = rendererActive ? 1 : 0;
  let viewport = {
    center: [...avatar.position], width: 60, height: 40, metersPerPin: avatar.moveDistance, overlapPins: 2,
  };
  let walking = null;
  const spoken = [];
  const inbound = [];
  let firstPersonSteps = 0;
  let handler = null;
  let onInbound = null;

  /* -- outbound: postMessage to the parent, one microtask later -- */
  const postOut = (data) => {
    queueMicrotask(() => handler?.({ origin: FAKE_ORIGIN, data }));
  };
  const externalPosition = () => toExternal(avatar.position);

  /* -- TactileRenderer -- */
  function handlePositionUpdated() {
    if (activeConsumers === 0) return;
    viewport = panViewportToKeepAvatar(viewport, avatar.position);
  }
  function setMoveDistance(next) {
    if (next === avatar.moveDistance) return; // MobX: only on change
    avatar.moveDistance = next;
    // The reaction is registered unconditionally, so it fires while inactive too (F3).
    viewport = { ...viewport, center: [...avatar.position], metersPerPin: next };
  }

  /* -- Avatar -- */
  function setPosition(next) {
    if (avatar.position[0] === next[0] && avatar.position[1] === next[1]) return; // exact no-op
    avatar.position = [next[0], next[1]];
    handlePositionUpdated();
    postOut({ type: 'positionChanged', payload: { position: externalPosition() } });
  }
  function attemptMove(next, bypassBounds = false) {
    if (!bypassBounds && bounds) {
      if (next[0] < bounds[0] || next[0] > bounds[2] || next[1] < bounds[1] || next[1] > bounds[3]) return false;
    }
    if (wall && wall(avatar.position, next)) return false;
    return true;
  }
  function move(next) {
    if (attemptMove(next)) setPosition(next);
  }
  function positionFromDirection(direction) {
    const o = angleToVector(avatar.orientation);
    let v = [0, 0];
    if (direction === 'up') v = o;
    else if (direction === 'down') v = [-o[0], -o[1]];
    else if (direction === 'left') v = [-o[1], o[0]];
    else if (direction === 'right') v = [o[1], -o[0]];
    return [avatar.position[0] + v[0] * avatar.moveDistance, avatar.position[1] + v[1] * avatar.moveDistance];
  }
  function firstPersonStep(direction) {
    if (direction === 'left') { avatar.orientation = normalizeAngle(avatar.orientation - turnAngle); return; }
    if (direction === 'right') { avatar.orientation = normalizeAngle(avatar.orientation + turnAngle); return; }
    const v = angleToVector(avatar.orientation);
    const s = direction === 'down' ? -1 : 1;
    firstPersonSteps += 1;
    move([avatar.position[0] + s * v[0] * avatar.moveDistance, avatar.position[1] + s * v[1] * avatar.moveDistance]);
  }
  function speakStep(ok, which) {
    if (ok) spoken.push(`Step size set to ${avatar.moveDistance}`);
    else spoken.push(which === 'up' ? 'Largest step reached' : 'Smallest step reached');
  }

  /** Run one Audiom command synchronously (keyboard, pad chord or embed). */
  function execute(command) {
    // First-person walk: one more step per subsequent message until release.
    if (walking && command !== `${walking}_release`) firstPersonStep(walking);
    switch (command) {
      case 'up': case 'down': case 'left': case 'right':
        if (mode === 'grid') move(positionFromDirection(command));
        else { firstPersonStep(command); walking = command; }
        break;
      case 'up_release': case 'down_release': case 'left_release': case 'right_release':
        if (walking && command === `${walking}_release`) walking = null;
        break;
      case 'activateGridView': mode = 'grid'; walking = null; spoken.push('Grid mode active'); break;
      case 'activateFirstPersonView': mode = 'firstPerson'; break;
      case 'smallerStep': { const ok = tiers.stepDown(); if (ok) setMoveDistance(tiers.getCurrentDistance()); speakStep(ok, 'down'); break; }
      case 'largerStep': { const ok = tiers.stepUp(); if (ok) setMoveDistance(tiers.getCurrentDistance()); speakStep(ok, 'up'); break; }
      case 'tierUp': if (tiers.tierUp()) setMoveDistance(tiers.getCurrentDistance()); break;
      case 'tierDown': if (tiers.tierDown()) setMoveDistance(tiers.getCurrentDistance()); break;
      case 'toggleUnits': tiers.toggleUnits(); setMoveDistance(tiers.getCurrentDistance()); break;
      case 'snapTurnLeft': avatar.orientation = normalizeAngle(Math.ceil(avatar.orientation / 90) * 90 - 90); break;
      case 'snapTurnRight': avatar.orientation = normalizeAngle(Math.floor(avatar.orientation / 90) * 90 + 90); break;
      case 'rotate180': avatar.orientation = normalizeAngle(avatar.orientation + 180); break;
      case 'nextForward': {
        // moveToNext: arbitrary length along the heading, bounds bypassed.
        const v = angleToVector(avatar.orientation);
        const d = avatar.moveDistance * (1.5 + rng() * 20);
        setPosition([avatar.position[0] + v[0] * d, avatar.position[1] + v[1] * d]);
        break;
      }
      case 'stopSpeech': break;
      default: break;
    }
  }

  /* -- embed inbound (AudiomClient.handleInbound + useAudiomClient) -- */
  function handleInbound(message) {
    inbound.push(message);
    onInbound?.(message, api);
    switch (message?.type) {
      case 'moveAvatar': setPosition(toInternal(message.payload.position)); break;
      case 'getState': postOut({ type: 'stateChanged', payload: { position: externalPosition() } }); break;
      case 'executeCommand': {
        const c = message.payload?.command;
        if (!KNOWN_COMMANDS.has(c)) { postOut({ type: 'error', payload: { code: 'UNKNOWN_COMMAND', message: `Unknown command: ${c}` } }); break; }
        execute(c);
        break;
      }
      default: postOut({ type: 'error', payload: { code: 'INVALID_MESSAGE', message: 'Invalid inbound message' } });
    }
  }

  const api = {
    /** `createAudiomChannel` transport. */
    transport: {
      origin: FAKE_ORIGIN,
      post(message) { queueMicrotask(() => handleInbound(message)); return true; },
      subscribe(h) { handler = h; return () => { handler = null; }; },
    },
    /** Simulate the user: a keyboard key or pad chord, handled synchronously. */
    key(command) { execute(command); },
    /** Post a `ready` (embed reload). */
    ready() { postOut({ type: 'ready', payload: { version: 'fake' } }); },
    /** TactileRenderer.activate(): a pad or TactilePinView subscribes. */
    activate() {
      const wasInactive = activeConsumers === 0;
      activeConsumers += 1;
      if (wasInactive) viewport = { ...viewport, center: [...avatar.position], metersPerPin: avatar.moveDistance };
      return () => { activeConsumers = Math.max(0, activeConsumers - 1); };
    },
    /** TactileRenderer.pan() — the pad pan keys (F7). */
    pan(direction) { if (activeConsumers > 0) viewport = panTactileViewport(viewport, direction); },
    set onInbound(fn) { onInbound = fn; },

    // Oracles
    rendererPinOfAvatar() { return worldToPinMetres(avatar.position, viewport); },
    centerWorld() { return [...viewport.center]; },
    get viewport() { return viewport; },
    get moveDistance() { return avatar.moveDistance; },
    get orientation() { return avatar.orientation; },
    get position() { return [...avatar.position]; },
    get externalPosition() { return externalPosition(); },
    get mode() { return mode; },
    get tiers() { return tiers; },
    get active() { return activeConsumers > 0; },
    spoken,
    inbound,
    get firstPersonSteps() { return firstPersonSteps; },
    toInternal,
    toExternal,
  };
  return api;
}
