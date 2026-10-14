#!/usr/bin/env node
/**
 * lib/announcer.js — audiom.html's live-region announcer (the page never
 * speaks; its prompts go to ARIA live regions).
 *
 *   node starter/scripts/test_announcer.mjs
 *
 * FULLY OFFLINE, fake timers. Checked:
 *   - a message clears the region, then sets the text after the delay;
 *   - the SAME text twice is two DOM changes ('' then text, each time), so a
 *     screen reader hears a repeated corner prompt;
 *   - a newer message replaces a pending one on its channel (barge-in);
 *   - polite and assertive are independent;
 *   - empty input is ignored; `{text}` objects are accepted;
 *   - dispose drops pending messages.
 */

import { createAnnouncer } from '../src/lib/announcer.js';

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
const section = (title) => console.log(`\n— ${title} ${'—'.repeat(Math.max(0, 62 - title.length))}`);

/** Fake timers + a recording sink. */
function rig(delayMs = 60) {
  let now = 0, nextId = 1;
  const timers = new Map(); // id → { at, fn }
  const log = [];
  const region = { polite: '', assertive: '' };
  const a = createAnnouncer({
    delayMs,
    onChange: (ch, text) => { region[ch] = text; log.push([ch, text]); },
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer: (id) => { timers.delete(id); },
  });
  const advance = (ms) => {
    now += ms;
    for (const [id, t] of [...timers].sort((x, y) => x[1].at - y[1].at)) {
      if (t.at <= now && timers.has(id)) { timers.delete(id); t.fn(); }
    }
  };
  return { a, log, region, advance, pending: () => timers.size };
}

section('clear, then set');
{
  const r = rig();
  check(r.a.announce('Load a map first.') === true, 'announce returns true');
  check(r.region.polite === '', 'region cleared immediately');
  r.advance(59);
  check(r.region.polite === '', 'text not yet set before the delay');
  r.advance(1);
  check(r.region.polite === 'Load a map first.', 'text set after the delay');
  check(r.region.assertive === '', 'assertive untouched');
}

section('same text twice is announced twice');
{
  const r = rig();
  const prompt = 'Point at the top-left corner pin of the DOT Pad and hold.';
  r.a.announce(prompt); r.advance(100);
  r.a.announce(prompt); r.advance(100);
  const polite = r.log.filter(([ch]) => ch === 'polite').map(([, t]) => t);
  check(JSON.stringify(polite) === JSON.stringify(['', prompt, '', prompt]),
    'DOM goes "" → text → "" → text', JSON.stringify(polite));
}

section('barge-in: newer replaces pending');
{
  const r = rig();
  r.a.announce('Syncing the DOT Pad. Hands off the keys.');
  r.advance(10);
  r.a.announce('DOT Pad synced.');
  check(r.pending() === 1, 'only one pending timer');
  r.advance(100);
  check(r.region.polite === 'DOT Pad synced.', 'latest message wins');
  check(!r.log.some(([, t]) => t.startsWith('Syncing')), 'superseded message never shown');
}

section('channels are independent');
{
  const r = rig();
  r.a.announce('Map loaded.');
  r.a.announce('Camera blocked. Allow it for this page.', { assertive: true });
  r.advance(100);
  check(r.region.polite === 'Map loaded.', 'polite kept');
  check(r.region.assertive === 'Camera blocked. Allow it for this page.', 'assertive set');
}

section('input handling');
{
  const r = rig();
  check(r.a.announce('') === false && r.a.announce('   ') === false && r.a.announce(null) === false,
    'empty / blank / null ignored');
  check(r.log.length === 0, 'nothing touched for empty input');
  r.a.announce({ text: '  Registered. Lift your hand for a moment. ' });
  r.advance(100);
  check(r.region.polite === 'Registered. Lift your hand for a moment.', '{text} accepted and trimmed');
}

section('dispose');
{
  const r = rig();
  r.a.announce('DOT Pad not synced — press S.');
  r.a.dispose();
  r.advance(100);
  check(r.region.polite === '' && r.pending() === 0, 'pending message dropped');
  r.a.announce('again');
  r.advance(100);
  check(r.region.polite === 'again', 'still usable after dispose (StrictMode re-mount)');
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
