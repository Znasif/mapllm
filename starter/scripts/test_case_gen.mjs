#!/usr/bin/env node
/**
 * Headless checks for `src/lib/parity/caseGen.js`.
 *
 * Runs entirely on hand-written payloads in the two shapes Audiom actually
 * returns — no network, no key, no map. The generator is what decides the
 * benchmark's ground truth, so a bug here silently mis-grades every run.
 */
import {
  CASE_KINDS, buildCases, featuresOf, nameOf, usableNames,
} from '../src/lib/parity/caseGen.js';

let pass = 0; let fail = 0;
const check = (n, c, e = '') => { c ? (pass++, console.log(`  ok   ${n}`)) : (fail++, console.log(`  FAIL ${n}${e ? ` — ${e}` : ''}`)); };
const eq = (n, a, b) => check(n, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

const feat = (name, props = {}) => ({ properties: { name, ...props } });
const NAMES = ['Empire State Building', 'Herald Square', 'Koreatown', 'Bryant Park',
  'Penn Station', 'Macys', 'Greeley Square', 'Madison Avenue'];
const features = NAMES.map((n, i) => feat(n, { [`k${i}`]: 'v' }));

console.log('\nfeaturesOf handles both Audiom shapes');
eq('dataset-attributes shape', featuresOf({ features, totalFeatures: 8 }).length, 8);
eq('layers shape', featuresOf({ layers: [{ source: { features: features.slice(0, 3) } },
  { source: { features: features.slice(3) } }] }).length, 8);
eq('bare array', featuresOf(features).length, 8);
eq('neither', featuresOf({ nope: 1 }), []);
eq('null', featuresOf(null), []);

console.log('\nnameOf');
eq('from properties', nameOf(feat('X')), 'X');
eq('from the record', nameOf({ name: 'Y' }), 'Y');
eq('trimmed', nameOf(feat('  Z  ')), 'Z');
eq('blank is null', nameOf(feat('   ')), null);
eq('missing is null', nameOf({ properties: {} }), null);

console.log('\nusableNames rejects what makes a case broken, not hard');
{
  const noisy = [
    feat('Empire State Building'), feat('Starbucks'), feat('Starbucks'),
    feat('on'), feat('st'), feat('yes'),
    feat('Intersection of 34th Street - Herald Square (B,D,F,M,N,Q,R,W) & 34th Street'),
    feat('東京'), feat('Noa'), feat(''),
  ];
  const u = usableNames(noisy);
  check('keeps a normal name', u.includes('Empire State Building'));
  check('drops a name on two features', !u.includes('Starbucks'));
  check('drops short lowercase junk', !u.includes('on') && !u.includes('st') && !u.includes('yes'));
  check('keeps a short CJK name', u.includes('東京'), JSON.stringify(u));
  check('keeps a short capitalised name', u.includes('Noa'));
  check('drops an over-long synthesised label', !u.some((x) => x.startsWith('Intersection of')));
  check('drops blanks', !u.includes(''));
}

console.log('\nbuildCases');
{
  const { cases, stats } = buildCases({ features }, { profile: 'audiom_tier_a', source: 'test' });
  check('generates cases', cases.length > 10, String(cases.length));
  check('every case names the profile', cases.every((c) => c.capability_profile === 'audiom_tier_a'));
  check('every case records its provenance', cases.every((c) => c.generated_from === 'test'));
  check('ids are unique', new Set(cases.map((c) => c.id)).size === cases.length);

  const placeCases = cases.filter((c) => CASE_KINDS[
    Object.keys(CASE_KINDS).find((k) => CASE_KINDS[k].tool === c.expected_tool) || 'refusal'
  ]?.needsPlace);
  check('place cases carry expected_args.place',
    placeCases.every((c) => typeof c.expected_args?.place === 'string' && c.expected_args.place));
  check('the expected place is a REAL feature name',
    placeCases.every((c) => NAMES.includes(c.expected_args.place)));
  check('the expected place is offered as a candidate',
    placeCases.every((c) => c.context.resolved_places.includes(c.expected_args.place)));
  check('distractors are real names from the same map',
    placeCases.every((c) => c.context.resolved_places.every((n) => NAMES.includes(n))));
  check('distractors are not the answer repeated',
    placeCases.every((c) => new Set(c.context.resolved_places).size === c.context.resolved_places.length));

  const refusals = cases.filter((c) => c.expected_tool === null);
  check('refusal cases exist', refusals.length >= 3, String(refusals.length));
  check('refusals name no place',
    refusals.every((c) => !NAMES.some((n) => c.utterance.includes(n))));
  check('refusals offer no candidates',
    refusals.every((c) => !c.context.resolved_places));

  // A repeated place inside one kind silently halves that kind's coverage.
  for (const tool of ['get_place_details', 'get_distance_to', 'am_i_at', 'route_to']) {
    const forTool = cases.filter((c) => c.expected_tool === tool).map((c) => c.expected_args.place);
    check(`${tool} uses distinct places`, new Set(forTool).size === forTool.length,
      JSON.stringify(forTool));
  }

  eq('stats count features', stats.features, 8);
  check('stats count distinct property keys', stats.distinctPropertyKeys >= 8, String(stats.distinctPropertyKeys));
}

console.log('\ndeterminism');
{
  const a = buildCases({ features }, { profile: 'p', source: 's', seed: 7 });
  const b = buildCases({ features }, { profile: 'p', source: 's', seed: 7 });
  const c = buildCases({ features }, { profile: 'p', source: 's', seed: 8 });
  eq('same seed, same cases', a.cases, b.cases);
  check('different seed, different cases', JSON.stringify(a.cases) !== JSON.stringify(c.cases));
}

console.log('\ndegenerate inputs');
{
  const { cases } = buildCases({ features: [] }, { profile: 'p', source: 's' });
  check('no names still yields the place-free cases', cases.length > 0);
  check('and no case claims a place', cases.every((c) => !c.expected_args?.place));
  check('missing profile throws', (() => {
    try { buildCases({ features }, { source: 's' }); return false; } catch { return true; }
  })());
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail === 0) console.log('ALL PASS');
process.exit(fail === 0 ? 0 : 1);
