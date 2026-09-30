#!/usr/bin/env node
/**
 * Headless checks for the place normalisers in `src/lib/placeIndex.js`.
 *
 * The point of `fromAudiomPlace` is that an Audiom-fed L1 index must embed more
 * than "Name. category." — `audiomWorldAdapter.js:235` parks every source
 * attribute in `props` and defers the decision to M8, and this is M8. The
 * load-bearing assertion here is not that fields are copied but that the
 * EMBEDDED DOCUMENT actually gets richer; a normaliser that silently produced
 * the naive document would pass a field-by-field test and retrieve like a coin
 * flip in production.
 *
 * No network, no LLM, no adapter — the records are written out by hand in the
 * exact shape `audiomWorldAdapter` builds them.
 */

import {
  AUDIOM_MAX_TOTAL_CHARS, AUDIOM_MAX_VALUE_CHARS,
  fromAudiomPlace, normalisePlaces, placeDocument, placesOf,
} from '../src/lib/placeIndex.js';
let pass=0,fail=0;
const check=(n,c,e='')=>{c?(pass++,console.log('  ok   '+n)):(fail++,console.log('  FAIL '+n+(e?' — '+e:'')));};
const eq=(n,a,b)=>check(n,JSON.stringify(a)===JSON.stringify(b),`got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

// A record exactly as audiomWorldAdapter.js builds it (line ~853).
const audiomPlace = {
  id: 'quat#12', name: 'Holy Hill Formation',
  aliases: ['B7: Highways', 'Sym3'],
  category: 'glacial, contact, structural',
  geometry: { type: 'LineString', coordinates: [[0,0],[1,1]] },
  props: { sourceName: 'quat_survey', ruleName: 'B7: Highways', ruleType: 'contact',
           briefing: 'structural', description: 'Rolling glacial sediment' },
  provenance: { source: 'audiom:layers', layer: 'Quaternary', id: '12' },
};

console.log('\nfromAudiomPlace takes what is AVAILABLE, not what is expected');
{
  const a = fromAudiomPlace(audiomPlace, 0);
  eq('name', a.name, 'Holy Hill Formation');
  eq('category is the adapter-derived join', a.category, 'glacial, contact, structural');
  check('description prop indexed', a.locationDescription.includes('Rolling glacial sediment'));
  check('category PARTS are not re-indexed',
    !a.locationDescription.includes('contact') && !a.locationDescription.includes('structural'),
    a.locationDescription);
  check('aliases reach context', a.context.includes('B7: Highways') && a.context.includes('Sym3'));
  check('layer reaches context', a.context.includes('Quaternary'));
  eq('accessibility explicit and empty', a.accessibility, []);
  check('geometry is NOT indexed', !JSON.stringify(a).includes('LineString'));

  // THE POINT. Keys nobody could have predicted must still be indexed — an
  // allowlist would silently miss every one of these.
  const unforeseen = fromAudiomPlace({
    name: 'Unit 3a',
    props: {
      UNIT_NAME: 'Holy Hill Formation',
      Symbol_Description: 'Rolling glacial sediment',
      Comentario: 'deposito rodante',
      wibble_47: 'a key nobody has ever seen',
    },
  }, 0);
  for (const v of ['Holy Hill Formation', 'Rolling glacial sediment', 'deposito rodante',
    'a key nobody has ever seen']) {
    check(`indexes an unforeseen key carrying "${v.slice(0, 24)}"`,
      unforeseen.locationDescription.includes(v));
  }

  // Structural filter, not a name filter: identifiers and numbers are dropped
  // because they cannot help resolve a NAME, whatever they are called.
  const noisy = fromAudiomPlace({
    name: 'X',
    props: { OBJECTID: 12345, SHAPE_Area: 40.7128, code: '99', blank: '   ', real: 'Elm Street' },
  }, 0);
  check('numeric attributes dropped', !noisy.locationDescription.includes('12345'));
  check('float attributes dropped', !noisy.locationDescription.includes('40.7128'));
  check('digit-only strings dropped', !noisy.locationDescription.includes('99'));
  check('whitespace-only dropped', !/\s\s/.test(noisy.locationDescription));
  check('language-carrying value kept', noisy.locationDescription.includes('Elm Street'));

  // Non-Latin scripts carry language too — a Latin-letter test would drop them.
  const cjk = fromAudiomPlace({ name: 'X', props: { note: '東京駅' } }, 0);
  check('non-Latin script kept', cjk.locationDescription.includes('東京駅'));

  // No triple-embedding of the same string under name/category/alias/prop.
  const dup = fromAudiomPlace({
    name: 'Elm', category: 'road', aliases: ['Elm St'],
    props: { a: 'Elm', b: 'road', c: 'Elm St', d: 'genuinely new' },
  }, 0);
  eq('values already represented are skipped', dup.locationDescription, 'genuinely new');

  // Bounded, so one verbose feature cannot crowd the embedding window.
  const long = fromAudiomPlace({ name: 'X', props: { a: 'z'.repeat(5000) } }, 0);
  check('single value truncated', long.locationDescription.length <= AUDIOM_MAX_VALUE_CHARS + 1);
  const many = fromAudiomPlace({
    name: 'X',
    props: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, `value number ${i} here`])),
  }, 0);
  check('total dump bounded', many.locationDescription.length <= AUDIOM_MAX_TOTAL_CHARS,
    String(many.locationDescription.length));
  check('bounded dump still has content', many.locationDescription.length > 100);
}

console.log('\nit actually changes the embedded document');
{
  const a = fromAudiomPlace(audiomPlace, 0);
  const doc = placeDocument(a);
  const naive = placeDocument({ name: audiomPlace.name, category: audiomPlace.category });
  check('document is richer than name+category', doc.text.length > naive.text.length,
    `${doc.text.length} vs ${naive.text.length}`);
  check('document carries the source attribute', doc.text.includes('Rolling glacial sediment'));
  check('name is preserved for the answer', doc.name === 'Holy Hill Formation');
}

console.log('\nedge cases');
{
  eq('no props', fromAudiomPlace({ name: 'X' }, 3).locationDescription, '');
  eq('no props keeps a usable record', fromAudiomPlace({ name: 'X' }, 3).name, 'X');
  eq('id falls back to the record id', fromAudiomPlace({ id: 'z', name: 'X' }).id, 'z');
  eq('explicit id wins', fromAudiomPlace({ id: 'z', name: 'X' }, 7).id, 7);
  eq('empty record does not throw', fromAudiomPlace({}, 0).locationDescription, '');
  check('nested objects are not stringified into the index',
    !fromAudiomPlace({ name: 'X', props: { geom: { type: 'Point' } } }, 0).locationDescription.includes('Point'));
  check('arrays are not stringified into the index',
    !fromAudiomPlace({ name: 'X', props: { tags: ['a', 'b'] } }, 0).locationDescription.includes('a'));
}

console.log('\nplacesOf handles both shapes');
eq('method form', placesOf({ places: () => [{ name: 'm' }] }), [{ name: 'm' }]);
eq('field form', placesOf({ places: [{ name: 'f' }] }), [{ name: 'f' }]);
eq('absent', placesOf({}), []);
eq('null adapter', placesOf(null), []);

console.log('\nnormalisePlaces routes by provenance');
const mixed = normalisePlaces([audiomPlace, { name: 'A Camio POI', categories: ['catering.cafe'], street: 'E 37th' }]);
// String()-guarded so a routing regression fails as an assertion rather than
// throwing on undefined — a crash still exits non-zero but says far less.
// `sourceName` is just another prop now, so it lands in the dump like any
// other — checking `context` for it was asserting the old key-mapped design.
check('audiom record took the audiom path',
  String(mixed[0]?.locationDescription || '').includes('Rolling glacial sediment'),
  JSON.stringify(mixed[0]).slice(0, 140));
check('audiom record is normalised, not passed through',
  !('props' in (mixed[0] || {})) && !('geometry' in (mixed[0] || {})));
check('camio record took the camio path',
  mixed[1]?.category === 'catering.cafe' && mixed[1]?.context === 'E 37th',
  JSON.stringify(mixed[1]).slice(0, 140));
const passthrough = normalisePlaces([{ id: 9, name: 'Ready', category: 'c', context: 'x' }]);
eq('already-normalised record passes through', passthrough[0].name, 'Ready');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
