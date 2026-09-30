/**
 * Audiom command discovery — what does `executeCommand` actually accept?
 *
 * `audiomChannel.executeCommand(command)` sends `{type:'executeCommand',
 * payload:{command}}` into the embed. We know exactly TWO valid command strings:
 * `'up'` and `'left'`, and we only know them because `AudiomMap.jsx` uses them as
 * perpendicular probes for the bounds binary search. Audiom's keyboard help lists
 * ~70 shortcuts, but those are KEY names ("Shift + m", "ArrowUp"), not command
 * names — `'up'` is not spelled `'ArrowUp'`, so there is an internal enum in
 * between and its spelling is unknown. This module discovers it empirically
 * rather than guessing, because a guessed table that silently half-works is worse
 * than no table.
 *
 * ── THE ONE QUESTION THIS MODULE EXISTS TO ANSWER ──────────────────────────
 *
 * Does an UNRECOGNISED command produce an `error` reply?
 *
 * Everything depends on that, because Audiom's commands are mostly ACTUATORS
 * whose whole effect is speech. "Scan" narrates and never moves the avatar, so
 * a valid Scan and a rejected `xyzzy` are indistinguishable — both are silent,
 * both leave the position untouched — UNLESS rejection has its own signal.
 *
 *   error oracle exists  → silence means ACCEPTED, and the full sweep is decisive
 *   no error oracle      → silence means NOTHING, and no amount of probing helps;
 *                          the vocabulary has to come from Audiom's frontend
 *
 * So `probeCommands` establishes the oracle FIRST, with three nonsense controls
 * that must agree, and `formatProbeReport` leads with that verdict. When there is
 * no oracle every silent row is labelled `unknown (no oracle)` — never `rejected`.
 * Reporting a silent row as a rejection would manufacture a vocabulary out of
 * noise, which is the specific failure this design is built to prevent.
 *
 * PLATFORM-FREE, like `audiomChannel.js` and the adapters, and for the same
 * reason: `scripts/test_audiom_command_probe.mjs` drives all of it from Node
 * against a fake channel. No `window`, no `document`, no `import.meta.env`.
 * `sleep` and `random` are injected so the tests are deterministic and instant.
 *
 * The channel is duck-typed. Anything with `getState()`, `onMessage(fn)`,
 * `executeCommand(str)` and `moveAvatar(pos)` works.
 */

/** Default settle window after a command, in ms. */
export const DEFAULT_SETTLE_MS = 400;

/** How many nonsense controls must agree before the oracle verdict is trusted. */
export const DEFAULT_CONTROL_COUNT = 3;

/**
 * The known-good command. `AudiomMap.jsx` relies on it for the bounds probe, so
 * if this one ever reports `rejected` the probe itself is broken, not Audiom.
 */
export const POSITIVE_CONTROL = 'up';

/** Movement threshold. Matches the `> 1e-9` oracle in `AudiomMap.discoverBounds`. */
const MOVED_EPSILON = 1e-9;

/**
 * Candidate commands, from Audiom's keyboard help.
 *
 * ⚠️ DELIBERATELY EXCLUDED — every entry that mutates the user's map or session:
 * Save Map, Save Custom Layer, Drop Point, Start Building Shape, Delete Object,
 * Reset the demo (f4), Set bookmark (Shift+1-0) and Settings. A discovery sweep
 * fires every candidate at a live map; the way we would learn one of those names
 * is correct is by it TAKING EFFECT. Also excluded: the volume, step-size, speech
 * rate and units toggles — harmless but they leave the session altered in ways
 * the user did not ask for and may not notice.
 *
 * ⚠️ ALSO REMOVED after the 2026-08-27 sweep, which fired them on a live map and
 * left sonar, the beacon and ambient sounds all flipped, the view switched and
 * two panels open: Switch View, Toggle Sonar, Toggle Beacon, Toggle Ambient
 * Sounds, Open Feature Card, Open Command Menu. They are CONFIRMED VALID and
 * recorded in `audiomCommands.js` — there is nothing left to discover about
 * them, and re-probing only toggles the user's session again. The original
 * exclusion rule was "nothing that alters the session"; these slipped through
 * it because they read as harmless. They were not.
 *
 * `key` is carried only so a human reading the report can map a result back to
 * the help screen. Nothing derives command names from it — see `nameVariants`.
 */
export const CANDIDATE_LABELS = Object.freeze([
  { label: 'Scan', key: 's' },
  { label: 'Announce Surroundings', key: 'a' },
  { label: 'Announce Directions', key: 'd' },
  { label: 'Announce Line Directionality', key: 'Shift + a' },
  { label: 'Get Direction', key: 'w' },
  { label: 'Get Coordinates', key: 'c' },
  { label: 'Get Latitude And Longitude', key: 'Alt + c' },
  { label: 'Nearby Features', key: 'Shift + m' },
  { label: 'Features Menu', key: 'm' },
  { label: 'Orient To Feature', key: 'O' },
  { label: 'Set Orientation', key: 'Shift + O' },
  { label: 'Grid View', key: 'g' },
  { label: 'First Person View', key: 'f' },
  { label: 'Border Mode', key: 'b' },
  { label: 'Follow Road', key: 'Shift + f' },
  { label: 'Follow Road Ahead', key: 'Alt + Shift + ArrowUp' },
  { label: 'Follow Road To The Left', key: 'Alt + Shift + ArrowLeft' },
  { label: 'Follow Road To The Right', key: 'Alt + Shift + ArrowRight' },
  { label: 'Rotate 180 Degrees', key: 'Shift + ArrowDown' },
  { label: 'Snap Turn Left', key: 'Shift + ArrowLeft' },
  { label: 'Snap Turn Right', key: 'Shift + ArrowRight' },
  { label: 'Turn Left', key: 'Ctrl + Shift + ArrowLeft' },
  { label: 'Turn Right', key: 'Ctrl + Shift + ArrowRight' },
  { label: 'Next Forward', key: 'Ctrl + ArrowUp' },
  { label: 'Next Backward', key: 'Ctrl + ArrowDown' },
  { label: 'Next Left', key: 'Ctrl + ArrowLeft' },
  { label: 'Next Right', key: 'Ctrl + ArrowRight' },
  { label: 'Play Context Cue Sound', key: 'q' },
  { label: 'Speak Context Cue', key: 'Shift + q' },
  { label: 'Review Route', key: 'Shift + R' },
  { label: 'Orientation Briefing', key: 'i' },
]);

/**
 * The short run: one variant each of the highest-value labels, plus the controls.
 *
 * snake_case is the single variant tried here purely because it is the cheapest
 * bet — the two names we have confirmed (`up`, `left`) are lowercase words, and
 * snake is the commonest multi-word extension of that. It is a BET, not a
 * finding. If the oracle turns out to exist, `{full: true}` settles the spelling
 * properly by trying all four conventions; if it does not, no spelling guess is
 * worth anything anyway.
 */
export const SHORT_LABELS = Object.freeze([
  'Scan',
  'Announce Surroundings',
  'Get Coordinates',
  'Nearby Features',
  'Orient To Feature',
  'Grid View',
  'Next Forward',
  'Orientation Briefing',
]);

/**
 * Naming-convention sweep for one label. Fully general — derived from the label
 * string alone, with no per-command special cases.
 *
 *   'Announce Surroundings' -> announce_surroundings
 *                              announceSurroundings
 *                              announce-surroundings
 *                              announcesurroundings
 *
 * @param {string} label
 * @returns {string[]} Deduped, in the order above.
 */
export function nameVariants(label) {
  const words = String(label || '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  if (!words.length) return [];

  const camel = words[0] + words.slice(1).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  const variants = [words.join('_'), camel, words.join('-'), words.join('')];
  return [...new Set(variants)];
}

/**
 * Flatten labels into one candidate per naming variant.
 *
 * @param {ReadonlyArray<{label: string, key?: string}>} [labels]
 * @returns {Array<{label: string, key: string|undefined, command: string}>}
 */
export function buildCandidates(labels = CANDIDATE_LABELS) {
  const out = [];
  const seen = new Set();
  for (const entry of labels) {
    for (const command of nameVariants(entry.label)) {
      if (seen.has(command)) continue;
      seen.add(command);
      out.push({ label: entry.label, key: entry.key, command });
    }
  }
  return out;
}

/**
 * The short candidate set: first variant only, high-value labels only.
 * @returns {Array<{label: string, key: string|undefined, command: string}>}
 */
export function shortCandidates() {
  const wanted = new Set(SHORT_LABELS);
  return CANDIDATE_LABELS
    .filter((e) => wanted.has(e.label))
    .map((e) => ({ label: e.label, key: e.key, command: nameVariants(e.label)[0] }));
}

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const defaultRandom = () => Math.random().toString(16).slice(2, 10);

/**
 * Run one command and classify what happened.
 *
 * Subscribes AFTER reading the position and unsubscribes BEFORE reading it
 * again, so neither `getState` round trip pollutes the captured message list
 * with its own `stateChanged`.
 */
async function probeOne(channel, command, { settleMs, sleep, restore, home }) {
  const before = await channel.getState();
  const messages = [];
  const off = channel.onMessage((type, payload) => { messages.push({ type, payload }); });

  const sent = channel.executeCommand(command) !== false;
  await sleep(settleMs);
  off();

  const after = await channel.getState();
  const moved = Boolean(
    before && after
    && (Math.abs(after[0] - before[0]) > MOVED_EPSILON
      || Math.abs(after[1] - before[1]) > MOVED_EPSILON),
  );
  const errored = messages.some((m) => m.type === 'error');

  if (restore && moved && home) channel.moveAvatar(home);

  return { command, sent, moved, errored, messages };
}

/**
 * Probe Audiom's command vocabulary.
 *
 * Order matters and is not negotiable: `getState` sanity, then the nonsense
 * controls, then the positive control, then the candidates. A candidate result
 * read without the oracle verdict in hand is not evidence of anything.
 *
 * @param {object} channel A live `createAudiomChannel(...)` (duck-typed).
 * @param {object} [opts]
 * @param {Array<{label: string, key?: string, command: string}>} [opts.candidates]
 * @param {number} [opts.settleMs] Wait after each command before reading replies.
 * @param {(ms: number) => Promise<void>} [opts.sleep] Injected for tests.
 * @param {() => string} [opts.random] Injected for tests.
 * @param {boolean} [opts.restore] Move the avatar home after anything that moved it.
 * @param {number} [opts.controlCount] Nonsense controls that must agree.
 * @param {(p: {index: number, total: number, command: string}) => void} [opts.onProgress]
 * @returns {Promise<object>} `{ok:false, reason}` or the full result.
 */
export async function probeCommands(channel, {
  candidates = shortCandidates(),
  settleMs = DEFAULT_SETTLE_MS,
  sleep = defaultSleep,
  random = defaultRandom,
  restore = true,
  controlCount = DEFAULT_CONTROL_COUNT,
  onProgress = null,
} = {}) {
  if (!channel) return { ok: false, reason: 'no-channel' };

  const home = await channel.getState();
  // Without a working getState nothing downstream is interpretable: `moved` is
  // the primary signal for half the commands and it is derived from position.
  if (!home) return { ok: false, reason: 'no-state' };

  const opts = { settleMs, sleep, restore, home };
  const total = controlCount + 1 + candidates.length;
  let index = 0;
  const step = (command) => { index += 1; onProgress?.({ index, total, command }); };

  const controls = [];
  for (let i = 0; i < controlCount; i += 1) {
    // Prefixed AND randomised: a fixed nonsense string could, with terrible
    // luck, be a real command, and that would invert the entire verdict.
    const command = `__probe_${random()}`;
    step(command);
    controls.push(await probeOne(channel, command, opts));
  }

  step(POSITIVE_CONTROL);
  const positive = await probeOne(channel, POSITIVE_CONTROL, opts);

  const results = [];
  for (const c of candidates) {
    step(c.command);
    const r = await probeOne(channel, c.command, opts);
    results.push({ ...r, label: c.label, key: c.key });
  }

  if (restore) channel.moveAvatar(home);

  const allErrored = controls.every((c) => c.errored);
  const noneErrored = controls.every((c) => !c.errored);
  const agreed = allErrored || noneErrored;

  return {
    ok: true,
    home,
    oracle: {
      // Only usable when rejection errors AND acceptance does not. If `up`
      // errors too, `error` is not a rejection signal, it is noise.
      available: agreed && allErrored && !positive.errored,
      agreed,
      erroredCount: controls.filter((c) => c.errored).length,
      samples: controls,
    },
    positive,
    results,
  };
}

/**
 * Classify one result. `oracleAvailable` is what makes silence readable.
 * @returns {string}
 */
export function verdictFor(result, oracleAvailable) {
  if (!result.sent) return 'not-sent';
  if (result.errored) return 'rejected';
  if (result.moved) return 'accepted (moved)';
  if (result.messages.length) return 'accepted (replied)';
  return oracleAvailable ? 'accepted (silent)' : 'unknown (no oracle)';
}

const pad = (s, n) => String(s).padEnd(n);

/**
 * Column widths. Shared by the header and the rows so they cannot drift, and
 * KEY_W fits the longest key in `CANDIDATE_LABELS` ("Alt + Shift + ArrowRight")
 * — at 12 it ran straight into the verdict and printed "ArrowUprejected".
 */
const CMD_W = 26;
const LABEL_W = 28;
const KEY_W = 26;

/**
 * Human-readable report. Leads with the oracle verdict, because every row below
 * it means something different depending on that one line.
 *
 * @param {object} result Output of `probeCommands`.
 * @returns {string}
 */
export function formatProbeReport(result) {
  if (!result?.ok) {
    const why = {
      'no-channel': 'no channel — is the Audiom frame mounted?',
      'no-state': 'getState() returned nothing — the embed is not answering, so '
        + 'no command result would be interpretable. Nothing was probed.',
    }[result?.reason] || result?.reason || 'unknown';
    return `Audiom command probe: ABORTED — ${why}`;
  }

  const { oracle, positive, results } = result;
  const lines = [];

  if (!oracle.agreed) {
    lines.push(
      `VERDICT: UNRELIABLE — ${oracle.erroredCount} of ${oracle.samples.length} nonsense `
      + 'controls returned `error` and the rest did not. The signal is not stable, so '
      + 'no row below can be trusted. Re-run with a larger settleMs.',
    );
  } else if (oracle.available) {
    lines.push(
      'VERDICT: ERROR ORACLE AVAILABLE — unrecognised commands reply `error` and the '
      + 'known-good `up` does not. Silence therefore means ACCEPTED, and the rows below '
      + 'are decisive. Run `audiomProbe({ full: true })` to sweep the whole list.',
    );
  } else if (positive.errored) {
    lines.push(
      'VERDICT: UNUSABLE — the known-good `up` also returned `error`, so `error` is not '
      + 'a rejection signal. Something else is wrong; the vocabulary cannot be probed.',
    );
  } else {
    lines.push(
      'VERDICT: NO ERROR ORACLE — unrecognised commands are swallowed silently. A silent '
      + 'row below is genuinely UNKNOWN, not a rejection: a valid command that only '
      + 'speaks (Scan, Announce Surroundings) looks exactly like a rejected one. The '
      + 'vocabulary has to come from Audiom\'s frontend instead.',
    );
  }

  // ACCEPTED FIRST, and rejected collapsed to a name list.
  //
  // The full sweep is ~149 rows of which all but a handful are rejected, and a
  // browser console export truncates. Putting the answer at the top and the
  // bulk at the bottom means a truncated capture still carries the finding —
  // which is exactly how the first full run was nearly lost.
  const notable = results.filter((r) => verdictFor(r, oracle.available) !== 'rejected');
  const rejected = results.filter((r) => verdictFor(r, oracle.available) === 'rejected');

  lines.push('');
  lines.push(pad('command', CMD_W) + pad('label', LABEL_W) + pad('key', KEY_W) + 'verdict');
  lines.push('-'.repeat(CMD_W + LABEL_W + KEY_W + 20));

  const positiveRow = { ...positive, label: '(positive control)', key: '' };
  for (const r of [positiveRow, ...notable]) {
    lines.push(
      pad(r.command, CMD_W) + pad(r.label || '', LABEL_W) + pad(r.key || '', KEY_W)
      + verdictFor(r, oracle.available),
    );
  }
  if (!notable.length) lines.push('(nothing but the positive control)');

  lines.push('');
  lines.push(oracle.available
    ? `${notable.length} of ${results.length} candidates accepted.`
    : `${results.length} candidates probed; none can be confirmed without an oracle.`);

  if (rejected.length) {
    lines.push('');
    lines.push(`rejected (${rejected.length}): ${rejected.map((r) => r.command).join(', ')}`);
  }

  return lines.join('\n');
}
