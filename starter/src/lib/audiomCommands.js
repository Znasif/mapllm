/**
 * Audiom's `executeCommand` vocabulary — GENERATED FROM AUDIOM'S SOURCE.
 *
 * Extracted from `explore/Audiom-Front-End/src/modules/commands.ts`
 * (`KEYMAP_COMMANDS` + `UI_ONLY_COMMANDS`) with keys and descriptions joined in
 * from `src/keymap.ts`. This supersedes the probe-derived table: the probe could
 * only confirm names it thought to guess, and 17 of its 37 labels were named
 * something the help screen never showed (Scan is `nearbyScan`, Announce
 * Surroundings is `aroundMe`, Get Coordinates is `announceCoordinates`).
 *
 * The probe is not wasted and should not be deleted — it is how we VERIFY this
 * table against a running embed. All 22 commands in `PROBE_CONFIRMED` were
 * independently accepted by a live map on 2026-08-27, and every one of them
 * appears here, which is the cross-check that this file describes the deployed
 * build and not just the checkout in `explore/`.
 *
 * ── `holdsUntilRelease` IS THE DANGEROUS ONE ──────────────────────────────
 *
 * `up`/`down`/`left`/`right` are PRESS events with matching `_release` events.
 * In `InteractionParadigms.FirstPerson`, `Avatar.firstPersonMovement` starts a
 * `setInterval` that keeps stepping until the `_release` arrives
 * (`Avatar.ts:293-335`) — send `up` and never send `up_release` and the avatar
 * walks forever. In `InteractionParadigms.Grid`, which is the DEFAULT
 * (`Avatar.ts:93`), `gridMovement` takes exactly one discrete step and there is
 * nothing to release.
 *
 * `AudiomMap.discoverBounds` sends bare `up`/`left` and never releases. That is
 * correct today only because Grid is the default. Anything that puts the avatar
 * in first-person (`activateFirstPersonView`) makes the bounds probe both
 * runaway and wrong — and in first person `left`/`right` TURN rather than move
 * (`Avatar.ts:114`), which silently destroys the "did it move" oracle the
 * binary search depends on.
 *
 * `category` is derived, not from Audiom: destructive = mutates the user's map
 * or session irreversibly; session = changes settings; inform = speaks or
 * reads; navigation = moves or reorients; movement = the raw press/release
 * pairs; ui = opens something.
 */

/* eslint-disable max-len */
export const COMMANDS = Object.freeze({
  up: { category: 'movement', holdsUntilRelease: true },
  up_release: { category: 'movement' },
  down: { category: 'movement', holdsUntilRelease: true },
  down_release: { category: 'movement' },
  left: { category: 'movement', holdsUntilRelease: true },
  left_release: { category: 'movement' },
  right: { category: 'movement', holdsUntilRelease: true },
  right_release: { category: 'movement' },
  openDataGrid: { category: 'ui', key: 't', description: 'Displays a tabular view of any data on the map' },
  reportSort: { category: 'inform', key: 'x', description: 'For chloropleth maps, describes the criteria by which the map is currently sorted' },
  playContextCue: { category: 'inform', key: 'q', description: 'Plays a pitch representing the lowest value in the range, a pitch representing the value of the current feature, and a pitch representing the highest value in the range. Press shift+q to get a textual representation  of this command.' },
  speakContextCue: { category: 'inform', key: 'Shift + q', description: 'Provides a textual message including the minimum value in the range, the value of the current feature, and the maximum  value in the range. Press q to hear an audio representation of this information.' },
  nextForward: { category: 'navigation', key: 'Control + ArrowUp', description: 'Moves forward to the next closest feature' },
  nextBackward: { category: 'navigation', key: 'Control + ArrowDown', description: 'Moves backward to the next closest feature' },
  nextLeft: { category: 'navigation', key: 'Control + ArrowLeft', description: 'Moves left to the next feature' },
  nextRight: { category: 'navigation', key: 'Control + ArrowRight', description: 'Moves right to the next feature' },
  followRoad: { category: 'navigation', key: 'Shift + f', description: 'Engages road following mode if activated while on a road' },
  followRoadLeft: { category: 'navigation', key: 'Alt + Shift + ArrowLeft', description: 'If road following is active, turns to the next road to the left, or continues following a road which curves to the left.' },
  followRoadRight: { category: 'navigation', key: 'Alt + Shift + ArrowRight', description: 'If road following is active, turns to the next road to the right, or continues following a road which curves to the right.' },
  followRoadAhead: { category: 'navigation', key: 'Alt + Shift + ArrowUp', description: 'If road following is active, continues following the current road.' },
  reviewRoute: { category: 'inform', key: 'Shift + R', description: 'Displays a menu of all route sections' },
  focusNextRouteFeature: { category: 'navigation', key: 'Shift + N', description: 'Moves to the next feature along the route in Route mode' },
  speechHistoryPreviousMessage: { category: 'inform', key: '[', description: 'Reads the previous message in the speech history' },
  speechHistoryNextMessage: { category: 'inform', key: ']', description: 'Reads the next message in the speech history' },
  speechHistoryFirstMessage: { category: 'inform', key: 'Shift + {', description: 'Reads the first message in the speech history' },
  speechHistoryLastMessage: { category: 'inform', key: 'Shift + }', description: 'Reads the last message in the speech history' },
  onBuildShape: { category: 'destructive', key: 'Shift + b', description: 'Invokes shape building mode' },
  dropPoint: { category: 'destructive', key: 'Shift + d', description: 'Drops a point in shape-building mode' },
  saveCustomLayer: { category: 'destructive', key: 'Shift + l', description: 'Saves a layer in shape-building mode' },
  saveMapWithAnnouncement: { category: 'destructive', key: 'Shift + s', description: 'Saves the map' },
  deleteUserObject: { category: 'destructive', key: 'Delete', description: 'Deletes the feature on which you are standing if you created it' },
  onCompoundMenu: { category: 'ui', key: 'Shift + c', description: 'Open the compound menu for shape-creation mode' },
  switchView: { category: 'session', key: 'Shift + v', description: 'Switches between line, point, and polygon views in shape-creation mode' },
  ambientVolumeUp: { category: 'session', key: 'k', description: 'Increases the volume of ambient sounds' },
  ambientVolumeDown: { category: 'session', key: 'Shift + k', description: 'Decreases the volume of ambient sounds' },
  encounterVolumeUp: { category: 'session', key: 'j', description: 'Increases the volume of encounter sounds' },
  encounterVolumeDown: { category: 'session', key: 'Shift + j', description: 'Decreases the volume of encounter sounds' },
  snapTurnLeft: { category: 'navigation', key: 'Shift + ArrowLeft', description: 'Turns left to the next 90 degree angle' },
  snapTurnRight: { category: 'navigation', key: 'Shift + ArrowRight', description: 'Turns right to the next 90 degree angle' },
  turnLeft: { category: 'navigation', key: 'Control + Shift + ArrowLeft', description: 'Turns the avatar left in Grid mode' },
  turnRight: { category: 'navigation', key: 'Control + Shift + ArrowRight', description: 'Turns the avatar right in Grid mode' },
  rotate180: { category: 'navigation', key: 'Shift + ArrowDown', description: 'Rotates 180 degrees to face the opposite direction' },
  orientFeatureSelection: { category: 'navigation', key: 'O', description: 'Orients the avatar to the current feature, or opens a menu of surrounding features to orient to if more than one is present' },
  openOrientationDialog: { category: 'ui', key: 'Shift + O', description: 'Opens a dialog to type in a specific orientation angle (0-360 degrees)' },
  nearbyScan: { category: 'inform', key: 's', description: 'Scans the nearby area and announces surrounding features' },
  openFeaturePicker: { category: 'ui', key: 'm', description: 'Displays a menu of all features on the map' },
  openNearbyFeaturePicker: { category: 'ui', key: 'Shift + m', description: 'Displays a menu of nearby features' },
  openCoordinateDialog: { category: 'ui', key: 'Shift + g', description: 'Move to a specific location by entering coordinates or picking a feature' },
  toggleAmbientSounds: { category: 'session', key: 'p', description: 'Plays or pauses ambient sounds' },
  aroundMe: { category: 'inform', key: 'a', description: 'Announce all features at the current location' },
  announceLineDirectionality: { category: 'inform', key: 'Shift + a', description: 'Announce the directionality of any line you are standing on' },
  announceOrientation: { category: 'inform', key: 'w', description: 'Announce what direction you are currently facing' },
  replayOrientationBriefing: { category: 'inform', key: 'i', description: 'Replays the full orientation briefing describing the map type, dimensions, and your starting position and facing' },
  activateGridView: { category: 'session', key: 'g', description: 'When activated, Grid Mode provides both auditory and textual feedback after every movement. It announces the name and details of the features at the current location through a text message and plays a short sound related to those features. This mode is ideal for users who prefer full text feedback' },
  activateFirstPersonView: { category: 'session', key: 'f', description: 'In the first-person mode verbosity setting, moving will play short sounds of the features at that location. Text messages will trigger whenever the user enters or exits a feature. The text message will describe the feature and important information about that feature. This mode only has audio feedback for movement, grid mode should be used for text feedback every move' },
  smallerStep: { category: 'session', key: '-', description: 'Decreases the size of movement' },
  largerStep: { category: 'session', key: '=', description: 'Increases the size of movement' },
  tierUp: { category: 'session', key: 'Control + =', description: 'Switches to the next movement tier (larger scale)' },
  tierDown: { category: 'session', key: 'Control + -', description: 'Switches to the previous movement tier (smaller scale)' },
  toggleUnits: { category: 'session', key: 'u', description: 'Toggles between metric and imperial units' },
  increaseStepSpeed: { category: 'session', key: 'Shift + +', description: 'In First-person view, increases step speed while moving.' },
  decreaseStepSpeed: { category: 'session', key: 'Shift + _', description: 'In First-person view, decreases step speed while moving.' },
  announceDirections: { category: 'inform', key: 'd', description: 'Speaks current directions to a previously-chosen feature' },
  announceCoordinates: { category: 'inform', key: 'c', description: 'Reports your current coordinates' },
  announceExternalCoordinates: { category: 'inform', key: 'Alt + c', description: 'Reports latitude and longitude of your current location' },
  toggleBorderMode: { category: 'session', key: 'b', description: 'Restricts movement to within the boundaries of a surrounding feature, allowing you to explore the feature in detail' },
  toggleSonar: { category: 'session', key: 'Shift + e', description: 'Enables or disables the feature detection sonar' },
  sonarScanDistanceUp: { category: 'session', key: 'Alt + =', description: 'Increases sonar scan distance' },
  sonarScanDistanceDown: { category: 'session', key: 'Alt + -', description: 'Decreases sonar scan distance' },
  changeBuildingLevel: { category: 'session', key: 'l', description: 'For maps with multiple levels, moves to the building level selector. Press "Escape" to exit.' },
  showLayerSelector: { category: 'session', key: 'y', description: 'Opens the layer selector to toggle data source visibility. Press "Escape" to exit.' },
  keyboardHelp: { category: 'inform', key: 'h', description: 'Displays keyboard help and the tutorial' },
  speakerTest: { category: 'inform', key: 'Shift + t', description: 'Test speakers' },
  openCommandMenu: { category: 'ui', key: 'f2', description: 'Open the command menu' },
  openMainMenu: { category: 'ui', key: 'Enter', description: 'Invokes the main menu' },
  toggleBeacon: { category: 'session', key: 'r', description: 'Toggles the destination beacon on and off' },
  recall: { category: 'navigation', key: 'Control + /', description: 'Moves you back to the starting location of the map' },
  jumpToGPSLocation: { category: 'navigation', key: '/', description: 'Jump to your current GPS Location' },
  openSettings: { category: 'ui', key: 'Control + ,', description: 'Open audio and visual settings' },
  openFeatureCard: { category: 'ui', key: ' ', description: 'Open feature card' },
  resetDemo: { category: 'destructive', key: 'f4', description: 'Reset the demo if in demo mode' },
  toggleSpeech: { category: 'session', key: '\\', description: 'Toggles between screen reader and self-voicing modes' },
  toggleFullscreen: { category: 'session', key: 'z', description: 'Toggle fullscreen mode' },
  stopSpeech: { category: 'inform', key: 'Control + Control', description: 'Stop speech' },
  toggleDebugDialog: { category: 'session', key: 'Control + Shift + D', description: 'Toggle the feature debug dialog' },
  jumpToLandmark0: { category: 'navigation' },
  jumpToLandmark1: { category: 'navigation' },
  jumpToLandmark2: { category: 'navigation' },
  jumpToLandmark3: { category: 'navigation' },
  jumpToLandmark4: { category: 'navigation' },
  jumpToLandmark5: { category: 'navigation' },
  jumpToLandmark6: { category: 'navigation' },
  jumpToLandmark7: { category: 'navigation' },
  jumpToLandmark8: { category: 'navigation' },
  jumpToLandmark9: { category: 'navigation' },
  setLandmark1: { category: 'destructive' },
  setLandmark2: { category: 'destructive' },
  setLandmark3: { category: 'destructive' },
  setLandmark4: { category: 'destructive' },
  setLandmark5: { category: 'destructive' },
  setLandmark6: { category: 'destructive' },
  setLandmark7: { category: 'destructive' },
  setLandmark8: { category: 'destructive' },
  setLandmark9: { category: 'destructive' },
  setLandmark0: { category: 'destructive' },
  endDemoMode: { category: 'ui' },
  openMapsMenu: { category: 'ui' },
  enableGeolocation: { category: 'ui' },
});

/**
 * Confirmed against a LIVE embed by `audiomProbe({ full: true })` on
 * 2026-08-27 (map 885, audiom-staging). Every entry must also exist in
 * `COMMANDS`; the test asserts it, which is what detects this file drifting
 * away from the deployed build.
 */
export const PROBE_CONFIRMED = Object.freeze(['up', 'left', 'nextForward', 'nextBackward', 'nextLeft', 'nextRight', 'followRoad', 'followRoadAhead', 'snapTurnLeft', 'snapTurnRight', 'turnLeft', 'turnRight', 'announceDirections', 'announceLineDirectionality', 'speakContextCue', 'reviewRoute', 'switchView', 'toggleSonar', 'toggleBeacon', 'toggleAmbientSounds', 'openFeatureCard', 'openCommandMenu']);

/** Commands that need a matching `<name>_release` in first-person mode. */
export const HOLD_COMMANDS = Object.freeze(['up', 'down', 'left', 'right']);

/** @returns {boolean} Whether `name` is a real Audiom command. */
export function isCommand(name) {
  return Object.prototype.hasOwnProperty.call(COMMANDS, name);
}

/**
 * Command names, filtered. Defaults exclude everything that mutates the user's
 * map — an LLM tool layer should never be able to reach `deleteUserObject`.
 *
 * @param {{categories?: string[], includeDestructive?: boolean}} [opts]
 * @returns {string[]}
 */
export function commandNames({ categories = null, includeDestructive = false } = {}) {
  return Object.keys(COMMANDS).filter((n) => {
    const c = COMMANDS[n];
    if (!includeDestructive && c.category === 'destructive') return false;
    return !categories || categories.includes(c.category);
  });
}

/** The `_release` partner for a hold command, or null. */
export function releaseFor(name) {
  return HOLD_COMMANDS.includes(name) ? `${name}_release` : null;
}
