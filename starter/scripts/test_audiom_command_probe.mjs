#!/usr/bin/env node
/**
 * Headless checks for `src/lib/audiomCommandProbe.js`.
 *
 * Everything here runs against a FAKE channel — no browser, no network, no
 * Audiom. The point is that the oracle logic, which is the part that decides
 * whether a whole probing session means anything, is provable without hardware.
 * Only the live `executeCommand` round trip needs a real embed.
 */

import {
  CANDIDATE_LABELS,
  POSITIVE_CONTROL,
  buildCandidates,
  formatProbeReport,
  nameVariants,
  probeCommands,
  shortCandidates,
  verdictFor,
} from '../src/lib/audiomCommandProbe.js';
import {
  COMMANDS, HOLD_COMMANDS, PROBE_CONFIRMED, commandNames, isCommand, releaseFor,
} from '../src/lib/audiomCommands.js';

let pass = 0;
let fail = 0;

function check(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}
const eq = (name, actual, expected) => check(
  name,
  JSON.stringify(actual) === JSON.stringify(expected),
  `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`,
);

const sleep = async () => {};
const seq = (values) => { let i = 0; return () => values[i++ % values.length]; };

/**
 * A scriptable stand-in for `createAudiomChannel`.
 *
 * `behaviour(command)` returns what the embed would do:
 *   { error: true }      reply with an `error` message
 *   { move: [dx, dy] }   shift the avatar
 *   { reply: 'type' }    reply with some other message
 *   undefined            silence
 */
function fakeChannel(behaviour, { start = [10, 20], stateFails = false } = {}) {
  let pos = [...start];
  const handlers = new Set();
  const moves = [];
  return {
    moves,
    get position() { return [...pos]; },
    async getState() { return stateFails ? null : [...pos]; },
    onMessage(fn) { handlers.add(fn); return () => handlers.delete(fn); },
    moveAvatar(p) { moves.push([...p]); pos = [...p]; return true; },
    executeCommand(command) {
      const b = behaviour(command) || {};
      if (b.sent === false) return false;
      if (b.move) pos = [pos[0] + b.move[0], pos[1] + b.move[1]];
      if (b.error) for (const h of handlers) h('error', { code: 'unknown_command' });
      if (b.reply) for (const h of handlers) h(b.reply, {});
      return true;
    },
  };
}

// Rejects everything except `up`, which moves. The healthy world.
const withOracle = (c) => (c === POSITIVE_CONTROL ? { move: [0.5, 0] } : { error: true });
// Swallows everything. `up` still moves, because it is real.
const noOracle = (c) => (c === POSITIVE_CONTROL ? { move: [0.5, 0] } : undefined);

const one = { candidates: [], sleep, random: seq(['a1', 'b2', 'c3']) };

console.log('\nnameVariants');
eq('multi-word', nameVariants('Announce Surroundings'),
  ['announce_surroundings', 'announceSurroundings', 'announce-surroundings', 'announcesurroundings']);
eq('single word dedupes to one', nameVariants('Scan'), ['scan']);
eq('already lowercase', nameVariants('scan'), ['scan']);
eq('punctuation and digits', nameVariants('Rotate 180 Degrees'),
  ['rotate_180_degrees', 'rotate180Degrees', 'rotate-180-degrees', 'rotate180degrees']);
eq('empty', nameVariants(''), []);
eq('null', nameVariants(null), []);

console.log('\nbuildCandidates');
{
  const built = buildCandidates([{ label: 'Grid View', key: 'g' }]);
  eq('one label expands to its variants', built.map((c) => c.command),
    ['grid_view', 'gridView', 'grid-view', 'gridview']);
  check('carries label and key', built.every((c) => c.label === 'Grid View' && c.key === 'g'));

  const dupes = buildCandidates([{ label: 'Scan', key: 's' }, { label: 'scan', key: 'x' }]);
  eq('dedupes across labels', dupes.map((c) => c.command), ['scan']);

  const all = buildCandidates();
  check('full sweep is larger than the label list', all.length > CANDIDATE_LABELS.length);
  check('every command is non-empty', all.every((c) => typeof c.command === 'string' && c.command));
}

console.log('\nshortCandidates');
{
  const short = shortCandidates();
  check('short run is small', short.length >= 6 && short.length <= 10, `got ${short.length}`);
  check('one variant per label', new Set(short.map((c) => c.label)).size === short.length);
}

console.log('\ndestructive commands are excluded');
{
  const banned = ['save map', 'save custom layer', 'drop point', 'start building shape',
    'delete object', 'reset', 'set bookmark', 'settings', 'delete'];
  const labels = CANDIDATE_LABELS.map((e) => e.label.toLowerCase());
  for (const b of banned) {
    check(`no "${b}"`, !labels.some((l) => l.includes(b)), `found in ${JSON.stringify(labels.filter((l) => l.includes(b)))}`);
  }
}

console.log('\noracle detection');
{
  const r = await probeCommands(fakeChannel(withOracle), one);
  check('ok', r.ok === true);
  check('available', r.oracle.available === true);
  check('agreed', r.oracle.agreed === true);
  check('all three controls errored', r.oracle.erroredCount === 3);
  check('three controls taken', r.oracle.samples.length === 3);
  check('controls used distinct random names',
    new Set(r.oracle.samples.map((s) => s.command)).size === 3);
  check('control names cannot collide with a real command',
    r.oracle.samples.every((s) => s.command.startsWith('__probe_')));
  check('positive control did not error', r.positive.errored === false);
  check('positive control moved', r.positive.moved === true);
}

console.log('\noracle absent');
{
  const r = await probeCommands(fakeChannel(noOracle), one);
  check('not available', r.oracle.available === false);
  check('agreed (consistently silent)', r.oracle.agreed === true);
  check('no control errored', r.oracle.erroredCount === 0);
}

console.log('\noracle unreliable');
{
  // Only the first nonsense control errors.
  let n = 0;
  const flaky = (c) => {
    if (c === POSITIVE_CONTROL) return { move: [0.5, 0] };
    n += 1;
    return n === 1 ? { error: true } : undefined;
  };
  const r = await probeCommands(fakeChannel(flaky), one);
  check('agreed is false', r.oracle.agreed === false);
  check('available is false', r.oracle.available === false);
  check('report says UNRELIABLE', formatProbeReport(r).includes('UNRELIABLE'));
}

console.log('\npositive control erroring makes the oracle unusable');
{
  const everythingErrors = () => ({ error: true });
  const r = await probeCommands(fakeChannel(everythingErrors), one);
  check('available is false', r.oracle.available === false);
  check('report says UNUSABLE', formatProbeReport(r).includes('UNUSABLE'));
}

console.log('\naborts');
{
  const r = await probeCommands(fakeChannel(withOracle, { stateFails: true }), one);
  eq('no-state', [r.ok, r.reason], [false, 'no-state']);
  check('report says ABORTED', formatProbeReport(r).includes('ABORTED'));
  const n = await probeCommands(null, one);
  eq('no-channel', [n.ok, n.reason], [false, 'no-channel']);
}

console.log('\nclassification');
{
  const oracleOn = true;
  eq('not sent', verdictFor({ sent: false, messages: [] }, oracleOn), 'not-sent');
  eq('errored', verdictFor({ sent: true, errored: true, messages: [] }, oracleOn), 'rejected');
  eq('moved', verdictFor({ sent: true, moved: true, messages: [] }, oracleOn), 'accepted (moved)');
  eq('replied', verdictFor({ sent: true, messages: [{ type: 'x' }] }, oracleOn), 'accepted (replied)');
  eq('silent with oracle', verdictFor({ sent: true, messages: [] }, true), 'accepted (silent)');
  eq('silent without oracle', verdictFor({ sent: true, messages: [] }, false), 'unknown (no oracle)');
}

console.log('\nsilence is never reported as rejection without an oracle');
{
  const cands = [{ label: 'Scan', key: 's', command: 'scan' }];
  const r = await probeCommands(fakeChannel(noOracle), { ...one, candidates: cands });
  const text = formatProbeReport(r);
  check('row is unknown', verdictFor(r.results[0], r.oracle.available) === 'unknown (no oracle)');
  check('report labels it unknown', text.includes('unknown (no oracle)'));
  // Deliberately checks the TABLE ROWS, not the whole report: the headline
  // explains what a rejection would have looked like, so a substring search
  // over the prose trips on its own explanation.
  const rows = text.split('\n').filter((l) => l.startsWith('scan'));
  check('a row exists for the candidate', rows.length === 1);
  check('no row is labelled rejected', rows.every((l) => !l.includes('rejected')));
  check('report says NO ERROR ORACLE', text.includes('NO ERROR ORACLE'));
  check('report refuses to confirm anything',
    text.includes('none can be confirmed without an oracle'));
}

console.log('\naccepted rows survive truncation');
{
  // One accepted command buried among many rejected ones: the accepted row must
  // appear ABOVE every rejected name, so a clipped console capture keeps it.
  const many = Array.from({ length: 40 }, (_, i) => ({ label: `L${i}`, command: `c${i}` }));
  many.push({ label: 'Announce Directions', command: 'announceDirections' });
  const behaviour = (c) => {
    if (c === POSITIVE_CONTROL) return { move: [0.5, 0] };
    return c === 'announceDirections' ? undefined : { error: true };
  };
  const r = await probeCommands(fakeChannel(behaviour), { ...one, candidates: many });
  const text = formatProbeReport(r);
  check('the one hit is accepted', verdictFor(r.results[40], true) === 'accepted (silent)');
  const hitLine = text.split('\n').findIndex((l) => l.startsWith('announceDirections'));
  const bulkLine = text.split('\n').findIndex((l) => l.startsWith('rejected ('));
  check('hit appears in the report', hitLine >= 0);
  check('hit is above the rejected bulk', hitLine < bulkLine, `hit ${hitLine}, bulk ${bulkLine}`);
  check('rejected are collapsed to one line', bulkLine >= 0);
  check('report stays short', text.split('\n').length < 20, `${text.split('\n').length} lines`);
  check('count is reported', text.includes('1 of 41 candidates accepted.'));
}

console.log('\nmovement threshold and restore');
{
  const tiny = (c) => (c === 'nudge' ? { move: [1e-12, 0] } : undefined);
  const r = await probeCommands(fakeChannel(tiny), {
    ...one, candidates: [{ label: 'Nudge', command: 'nudge' }],
  });
  check('sub-epsilon movement is not "moved"', r.results[0].moved === false);

  const ch = fakeChannel(withOracle);
  const r2 = await probeCommands(ch, {
    ...one, candidates: [{ label: 'Walk', command: 'walk' }],
  });
  check('positive control moved', r2.positive.moved === true);
  check('avatar restored to home', JSON.stringify(ch.position) === JSON.stringify([10, 20]));
  check('restore was actually called', ch.moves.length > 0);

  const ch2 = fakeChannel(withOracle);
  await probeCommands(ch2, { ...one, restore: false });
  check('restore:false leaves the avatar where it landed',
    JSON.stringify(ch2.position) !== JSON.stringify([10, 20]));
}

console.log('\nprogress and ordering');
{
  const seen = [];
  const cands = [{ label: 'Scan', command: 'scan' }, { label: 'Grid View', command: 'grid_view' }];
  const r = await probeCommands(fakeChannel(withOracle), {
    ...one, candidates: cands, onProgress: (p) => seen.push(p),
  });
  check('one progress call per probe', seen.length === 3 + 1 + 2);
  check('total is right on every call', seen.every((p) => p.total === 6));
  check('index increments', seen.every((p, i) => p.index === i + 1));
  check('controls come first', seen.slice(0, 3).every((p) => p.command.startsWith('__probe_')));
  eq('positive control is fourth', seen[3].command, POSITIVE_CONTROL);
  eq('candidates last, in order', seen.slice(4).map((p) => p.command), ['scan', 'grid_view']);
  eq('results carry their labels', r.results.map((x) => x.label), ['Scan', 'Grid View']);
}

console.log('\nmessage capture is not polluted by getState');
{
  // A channel that emits `stateChanged` on every getState, as the real one does.
  const ch = fakeChannel(() => undefined);
  const realGetState = ch.getState.bind(ch);
  const handlers = [];
  ch.onMessage = (fn) => { handlers.push(fn); return () => handlers.splice(handlers.indexOf(fn), 1); };
  ch.getState = async () => { handlers.forEach((h) => h('stateChanged', {})); return realGetState(); };
  const r = await probeCommands(ch, { ...one, candidates: [{ label: 'Scan', command: 'scan' }] });
  check('no stray stateChanged captured', r.results[0].messages.length === 0,
    JSON.stringify(r.results[0].messages));
}

console.log('\nauthoritative command table (from Audiom source)');
{
  const names = Object.keys(COMMANDS);
  check('108 commands', names.length === 108, `got ${names.length}`);
  check('isCommand works', isCommand('nearbyScan') && isCommand('aroundMe'));
  check('isCommand rejects a name the probe guessed wrong',
    !isCommand('scan') && !isCommand('announceSurroundings') && !isCommand('gridView'));
  check('isCommand is not fooled by prototype keys', !isCommand('toString'));

  // The 17 the probe could not name, resolved from source. These are the exact
  // pairs that make "camelCase of the help label" an unsafe rule.
  const resolved = {
    Scan: 'nearbyScan',
    'Announce Surroundings': 'aroundMe',
    'Get Coordinates': 'announceCoordinates',
    'Get Latitude And Longitude': 'announceExternalCoordinates',
    'Get Direction': 'announceOrientation',
    'Nearby Features': 'openNearbyFeaturePicker',
    'Features Menu': 'openFeaturePicker',
    'Orient To Feature': 'orientFeatureSelection',
    'Set Orientation': 'openOrientationDialog',
    'Grid View': 'activateGridView',
    'First Person View': 'activateFirstPersonView',
    'Border Mode': 'toggleBorderMode',
    'Follow Road To The Left': 'followRoadLeft',
    'Follow Road To The Right': 'followRoadRight',
    'Rotate 180 Degrees': 'rotate180',
    'Play Context Cue Sound': 'playContextCue',
    'Orientation Briefing': 'replayOrientationBriefing',
  };
  for (const [label, name] of Object.entries(resolved)) {
    check(`"${label}" -> ${name}`, isCommand(name));
  }

  // Cross-check: source table must contain everything a live embed accepted.
  // This is what catches `explore/Audiom-Front-End` drifting from the deploy.
  for (const n of PROBE_CONFIRMED) {
    check(`probe-confirmed "${n}" exists in source`, isCommand(n));
  }
  check('probe confirmed 22', PROBE_CONFIRMED.length === 22);

  // Hold/release: the runaway-movement hazard.
  check('four hold commands', HOLD_COMMANDS.length === 4);
  check('holds are flagged in the table',
    HOLD_COMMANDS.every((n) => COMMANDS[n].holdsUntilRelease === true));
  check('every hold has a real release partner',
    HOLD_COMMANDS.every((n) => isCommand(releaseFor(n))));
  eq('releaseFor is null for non-holds', releaseFor('nextForward'), null);
  check('nothing else claims holdsUntilRelease',
    Object.keys(COMMANDS).filter((n) => COMMANDS[n].holdsUntilRelease).length === 4);

  // Destructive commands exist in the table but must never be servable.
  const destructive = ['deleteUserObject', 'dropPoint', 'saveCustomLayer',
    'saveMapWithAnnouncement', 'onBuildShape', 'resetDemo', 'setLandmark1'];
  check('destructive commands are catalogued', destructive.every((n) => isCommand(n)));
  check('destructive commands are categorised as such',
    destructive.every((n) => COMMANDS[n].category === 'destructive'));
  const safe = commandNames();
  check('commandNames excludes destructive by default',
    destructive.every((n) => !safe.includes(n)));
  check('commandNames can opt in',
    commandNames({ includeDestructive: true }).length > safe.length);
  check('category filter works',
    commandNames({ categories: ['inform'] }).every((n) => COMMANDS[n].category === 'inform'));
  check('every command has a category',
    Object.values(COMMANDS).every((c) => typeof c.category === 'string' && c.category));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail === 0) console.log('ALL PASS');
process.exit(fail === 0 ? 0 : 1);
