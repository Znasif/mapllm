#!/usr/bin/env node
/**
 * PlaceIndex mechanics — build, cache reuse, LRU eviction, tie handling.
 *
 * ── WHAT CHANGED AND WHY ──────────────────────────────────────────────────
 *
 * This file used to require a live embedding server (`127.0.0.1:8081`, the Mac
 * router) and measured two different things at once: semantic recall@k on six
 * real utterances, and the index's own cache mechanics. With the router gone it
 * could not run at all, so it measured nothing.
 *
 * The two halves have different homes now:
 *
 *   recall@k        needs REAL embeddings, so it belongs where the models are —
 *                   `explore/wllama-spike/tooleval.html` in `l1` mode, which
 *                   retrieves with EmbeddingGemma and grades retrieval
 *                   separately from tool selection (`toolEval.gradeRetrieval`).
 *   cache mechanics  never needed a server. Build/rebuild/evict is pure logic
 *                   over injected vectors, and it is what this file keeps.
 *
 * The fake client returns deterministic unit vectors, so ranking is exactly
 * predictable and a scoring regression fails here loudly instead of hiding
 * inside embedding noise. It is NOT a semantic test and must not grow into one.
 */

import {
  MemoryStore, PlaceIndex, TIE_EPSILON, indexKey,
} from '../src/lib/placeIndex.js';

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
};
const eq = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b),
  `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

/**
 * Deterministic stand-in for the embedding tier.
 *
 * Each document becomes a one-hot unit vector chosen by its position in
 * `vocabulary`, and a query becomes the vector of whichever vocabulary term it
 * contains. Cosine similarity is then exactly 1 for the intended match and 0
 * for everything else, which makes ranking assertions exact.
 */
function fakeClient(vocabulary) {
  const dim = vocabulary.length;
  const oneHot = (i) => { const v = new Float32Array(dim); if (i >= 0) v[i] = 1; return v; };
  const indexOfTerm = (text) => vocabulary.findIndex((t) => String(text).toLowerCase().includes(t));
  let embedCalls = 0;
  return {
    get embedCalls() { return embedCalls; },
    async embedDocuments(docs) {
      embedCalls += 1;
      return docs.map((d) => oneHot(indexOfTerm(typeof d === 'string' ? d : d?.text ?? '')));
    },
    async embedQueries(queries) {
      return queries.map((q) => oneHot(indexOfTerm(q)));
    },
  };
}

// Real names from `docs/eval_places_empire_state.json`, i.e. from Audiom's own
// OSM read of the Empire State neighbourhood. Nothing here is MapIO.
const VOCAB = ['rail', 'hotel', 'plaza', 'broadway', 'building'];
const PLACES = [
  { id: 0, name: 'PATH (rail system)', category: 'railway', context: 'rail system' },
  { id: 1, name: 'The Grand Hotel', category: 'tourism.hotel', context: 'hotel' },
  { id: 2, name: 'Big Screen Plaza', category: 'amenity', context: 'plaza' },
  { id: 3, name: 'Broadway', category: 'highway', context: 'broadway' },
  { id: 4, name: 'The Martin Building', category: 'building', context: 'building' },
];
const ctx = { worldId: 'audiom:empire_state', windowId: 'full' };

console.log('\nbuild');
{
  const client = fakeClient(VOCAB);
  const index = new PlaceIndex({ client, store: new MemoryStore(), maxCached: 3 });
  const record = await index.build({ ...ctx, places: PLACES });
  eq('count', record.count, PLACES.length);
  eq('dim', record.dim, VOCAB.length);
  check('vectors sized count x dim', record.vectors.length === record.count * record.dim,
    `${record.vectors.length}`);
  check('embedded once', client.embedCalls === 1, String(client.embedCalls));
}

console.log('\nrebuild reuses the cache');
{
  const client = fakeClient(VOCAB);
  const index = new PlaceIndex({ client, store: new MemoryStore(), maxCached: 3 });
  const first = await index.build({ ...ctx, places: PLACES });
  const second = await index.build({ ...ctx, places: PLACES });
  eq('same build timestamp', second.builtAt, first.builtAt);
  check('no second embedding pass', client.embedCalls === 1, String(client.embedCalls));

  const forced = await index.build({ ...ctx, places: PLACES, force: true });
  check('force: re-embeds', client.embedCalls === 2, String(client.embedCalls));
  check('force: new record', forced.builtAt >= first.builtAt);
}

console.log('\nresolve ranks by similarity');
{
  const client = fakeClient(VOCAB);
  const index = new PlaceIndex({ client, store: new MemoryStore(), maxCached: 3 });
  await index.build({ ...ctx, places: PLACES });

  for (const [utterance, want] of [
    ['the rail system', 'PATH (rail system)'],
    ['find me a hotel', 'The Grand Hotel'],
    ['the plaza', 'Big Screen Plaza'],
    ['walk down broadway', 'Broadway'],
  ]) {
    const { matches } = await index.resolve(utterance, ctx);
    eq(`"${utterance}" ranks ${want} first`, matches[0]?.name, want);
  }

  // An utterance matching no vocabulary term scores 0 against everything: the
  // index must still answer, and must not claim confidence.
  const { matches, confident } = await index.resolve('completely unrelated', ctx);
  check('unmatched utterance still returns candidates', matches.length > 0);
  check('and is not confident', confident === false);
}

console.log('\nno index');
{
  const index = new PlaceIndex({ client: fakeClient(VOCAB), store: new MemoryStore() });
  const res = await index.resolve('anything', ctx);
  eq('reason', res.reason, 'no-index');
  eq('no matches', res.matches, []);
  check('not confident', res.confident === false);
}

console.log('\nLRU eviction');
{
  const store = new MemoryStore();
  const index = new PlaceIndex({ client: fakeClient(VOCAB), store, maxCached: 3 });
  await index.build({ ...ctx, places: PLACES });
  for (const windowId of ['w2', 'w3', 'w4']) {
    await index.build({ worldId: ctx.worldId, windowId, places: PLACES.slice(0, 3) });
  }
  const keys = (await store.entries()).map((e) => e.key);
  check('capped at maxCached', keys.length === 3, `${keys.length}: ${keys.join(', ')}`);
  check('oldest window evicted', !keys.includes(indexKey(ctx.worldId, 'full')), keys.join(', '));
  check('newest window kept', keys.includes(indexKey(ctx.worldId, 'w4')), keys.join(', '));
}

console.log('\ntie epsilon');
{
  check('TIE_EPSILON is a small positive number',
    typeof TIE_EPSILON === 'number' && TIE_EPSILON > 0 && TIE_EPSILON < 1, String(TIE_EPSILON));

  // Two places sharing a vocabulary term score identically, so the margin is 0
  // and the result must be reported as not-confident rather than picking one.
  const client = fakeClient(['plaza']);
  const index = new PlaceIndex({ client, store: new MemoryStore() });
  await index.build({
    ...ctx,
    places: [
      { id: 0, name: 'Big Screen Plaza', category: 'amenity', context: 'plaza' },
      { id: 1, name: 'Greeley Square Plaza', category: 'amenity', context: 'plaza' },
    ],
  });
  const { matches, confident, margin } = await index.resolve('the plaza', ctx);
  check('both plazas returned', matches.length === 2, JSON.stringify(matches.map((m) => m.name)));
  check('margin is ~0', Math.abs(margin) < TIE_EPSILON, String(margin));
  check('a tie is not confident', confident === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail === 0) console.log('ALL PASS');
process.exit(fail === 0 ? 0 : 1);
