#!/usr/bin/env node
/**
 * Generate eval cases from a live Audiom response. READ-ONLY.
 *
 * ⚠️ This script issues GET requests and nothing else. It never POSTs, PATCHes
 * or DELETEs, and it must never create a `map_definitions` row — benchmarking
 * must not write to Audiom's database. The OSM path below exists precisely so
 * an arbitrary area can be measured without one.
 *
 *   # map 885 (ESRI-sourced, Wisconsin quaternary) — tier A via the layers endpoint
 *   node scripts/gen_eval_cases.mjs --map 885 --profile audiom_tier_a
 *
 *   # Empire State Building neighbourhood — OSM, no map definition, no write
 *   node scripts/gen_eval_cases.mjs --osm-bbox -73.9920,40.7440,-73.9800,40.7530 \
 *        --profile audiom_tier_a --label empire_state
 *
 * The API key is read from `starter/.env` (`VITE_AUDIOM_FULL_ACCESS_KEY`) or
 * `$AUDIOM_API_KEY` and is sent as an `x-api-key` header — never in the URL,
 * which would put it in access logs. It is never printed.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCases, featuresOf, nameOf } from '../src/lib/parity/caseGen.js';
import { normalisePlaces } from '../src/lib/placeIndex.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const BACKEND = process.env.AUDIOM_BACKEND || 'https://audiom-backend-staging.herokuapp.com';

function apiKey() {
  if (process.env.AUDIOM_API_KEY) return process.env.AUDIOM_API_KEY;
  try {
    const env = readFileSync(join(root, '.env'), 'utf-8');
    const m = env.match(/^VITE_AUDIOM_FULL_ACCESS_KEY=(.*)$/m)
      || env.match(/^VITE_AUDIOM_KEY=(.*)$/m);
    return m ? m[1].trim().replace(/^["']|["']$/g, '').replace(/\r$/, '') : null;
  } catch { return null; }
}

function parseArgs(argv) {
  const o = {
    map: null, osmBbox: null, profile: 'audiom_tier_a', label: null,
    perKind: 3, seed: 20260828, out: null, timeoutMs: 300_000,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i]; const next = () => argv[++i];
    if (a === '--map') o.map = next();
    else if (a === '--osm-bbox') o.osmBbox = next();
    else if (a === '--profile') o.profile = next();
    else if (a === '--label') o.label = next();
    else if (a === '--per-kind') o.perKind = Number(next());
    else if (a === '--seed') o.seed = Number(next());
    else if (a === '--out') o.out = next();
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`Unknown flag: ${a}`);
  }
  return o;
}

async function get(path, params = {}) {
  const key = apiKey();
  if (!key) throw new Error('No API key — set AUDIOM_API_KEY or VITE_AUDIOM_FULL_ACCESS_KEY in starter/.env');
  const url = new URL(BACKEND + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  // Header, not query string: a key in a URL lands in access logs and referrers.
  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { accept: 'application/json', 'x-api-key': key },
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${res.statusText}`);
  return res.json();
}

async function main() {
  const o = parseArgs(process.argv);
  if (o.help || (!o.map && !o.osmBbox)) {
    console.log('usage: --map <id> | --osm-bbox <minLng,minLat,maxLng,maxLat>  [--profile p] [--label l] [--per-kind n] [--out path]');
    return 0;
  }

  let payload;
  let source;
  if (o.map) {
    source = `audiom:map-definitions/${o.map}/layers`;
    console.log(`GET /map-definitions/${o.map}/layers …`);
    payload = await get(`/map-definitions/${o.map}/layers`);
  } else {
    const bbox = `[${o.osmBbox.split(',').map((s) => s.trim()).join(',')}]`;
    source = `audiom:dataset-attributes?sourceType=osm&bbox=${bbox}`;
    console.log(`GET /dataset-attributes sourceType=osm bbox=${bbox} …`);
    payload = await get('/dataset-attributes', { sourceType: 'osm', bbox });
  }

  const label = o.label || (o.map ? `map${o.map}` : 'osm');
  const { cases, stats } = buildCases(payload, {
    profile: o.profile,
    source,
    idPrefix: o.map ? `M${o.map}-` : 'OSM-',
    perKind: o.perKind,
    seed: o.seed,
  });

  console.log('\nstats:');
  for (const [k, v] of Object.entries(stats)) console.log(`  ${k}: ${v}`);

  if (!cases.length) {
    console.error('\nNo cases generated — the response carried no usable named features.');
    return 1;
  }

  console.log(`\n${cases.length} cases:`);
  for (const c of cases) {
    console.log(`  ${c.id.padEnd(10)} ${String(c.expected_tool ?? '(refuse)').padEnd(24)} ${c.utterance}`);
  }

  const out = o.out || join(root, 'docs', `eval_dataset_${label}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(cases, null, 2)}\n`);
  console.log(`\nwritten: ${out}`);

  // The L1 corpus, beside the cases. Without it the benchmark would have to
  // borrow someone else's places to build an index — which is how the MapIO
  // New York model ended up underneath an "Audiom" benchmark in the first place.
  // Named features only: an unnamed feature cannot be retrieved BY NAME, so
  // indexing it adds cost and noise and can never add recall.
  const places = normalisePlaces(
    featuresOf(payload)
      .filter((f) => nameOf(f))
      .map((f, i) => ({
        id: `${label}#${i}`,
        name: nameOf(f),
        category: '',
        aliases: [],
        props: f.properties || {},
        provenance: { source: 'audiom:layers', layer: label },
      })),
  );
  const placesOut = join(dirname(out), `eval_places_${label}.json`);
  writeFileSync(placesOut, `${JSON.stringify(places, null, 2)}\n`);
  console.log(`written: ${placesOut}  (${places.length} places for the L1 index)`);
  return 0;
}

main().then((c) => process.exit(c)).catch((err) => {
  console.error(`\n[gen_eval_cases] ${err?.message || err}`);
  process.exit(2);
});
