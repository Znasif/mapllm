/**
 * Generate eval cases from what Audiom actually emits.
 *
 * ── WHY ───────────────────────────────────────────────────────────────────
 *
 * `docs/eval_dataset.json` is 21 hand-authored cases whose every place name is
 * Midtown-Manhattan-via-MapIO. It has **zero** `audiom_tier_a` cases, so the
 * profile the Audiom work rests on has never been measured. Worse, extending it
 * by hand means inventing utterances about places a human happened to notice,
 * which measures the author's imagination as much as the model.
 *
 * These cases are derived instead: the names, the distractors and the expected
 * arguments all come out of a live Audiom response, so the ground truth is
 * whatever Audiom emitted for that map. Regenerate for a different map id and
 * the benchmark moves with it.
 *
 * ── TWO RESPONSE SHAPES, BECAUSE AUDIOM HAS TWO ───────────────────────────
 *
 *   /map-definitions/:id/layers      { layers: [ { source: FeatureCollection } ] }
 *   /dataset-attributes?sourceType=osm&bbox=…
 *                                    { features: [...], keys: {...}, totalFeatures }
 *
 * The second needs no map definition and writes nothing, which is the only way
 * to benchmark an arbitrary OSM area without creating rows in Audiom's database.
 * `featuresOf` accepts either and is the single place that knows the difference.
 *
 * PLATFORM-FREE. Fetching belongs to the caller; this turns features into cases
 * and nothing else, so `scripts/test_case_gen.mjs` runs it with no network.
 */

/** Case kinds, and the tool each one must elicit. */
export const CASE_KINDS = Object.freeze({
  whats_here: { tool: 'whats_here', needsPlace: false },
  describe_surroundings: { tool: 'describe_surroundings', needsPlace: false },
  get_place_details: { tool: 'get_place_details', needsPlace: true },
  get_distance_to: { tool: 'get_distance_to', needsPlace: true },
  get_direction_to: { tool: 'get_direction_to', needsPlace: true },
  am_i_at: { tool: 'am_i_at', needsPlace: true },
  route_to: { tool: 'route_to', needsPlace: true },
  refusal: { tool: null, needsPlace: false },
});

/**
 * Utterance templates. `{place}` is substituted with a real feature name.
 *
 * Deliberately plain: this measures whether the model reaches for the right
 * tool, not whether it survives creative phrasing. Paraphrase robustness is a
 * separate axis and mixing them makes a regression unattributable.
 */
const TEMPLATES = Object.freeze({
  whats_here: ['What am I touching?', 'What is here?', "What's under my finger?"],
  describe_surroundings: ["What's around me?", 'Describe my surroundings.', "What's nearby?"],
  get_place_details: ['Tell me about {place}.', 'What is {place}?', 'Describe {place}.'],
  get_distance_to: ['How far is {place}?', 'What is the distance to {place}?'],
  get_direction_to: ['Which way is {place}?', 'What direction is {place} in?'],
  am_i_at: ['Am I at {place}?', 'Is this {place}?'],
  route_to: ['Take me to {place}.', 'Navigate to {place}.'],
  // Answerable by no tool this world serves. Kept generic — a refusal case that
  // names a real place is testing resolution, not refusal.
  refusal: [
    'What is the weather like?',
    'Who is the president?',
    'What time is it?',
    'Tell me a joke.',
  ],
});

/**
 * Pull a flat feature list out of either Audiom response shape.
 *
 * @param {object} payload
 * @returns {object[]} GeoJSON-ish features with a `properties` object
 */
export function featuresOf(payload) {
  if (Array.isArray(payload?.features)) return payload.features;
  if (Array.isArray(payload?.layers)) {
    return payload.layers.flatMap((l) => l?.source?.features || []);
  }
  if (Array.isArray(payload)) return payload;
  return [];
}

/**
 * The display name of a feature, or null.
 *
 * `name` is the only property Audiom guarantees across sources — the OSM bbox
 * above carries it on 100% of 7,525 features, as does 885 — so it is the one
 * key this module is allowed to know about. Everything else is unpredictable
 * (594 distinct keys on one NYC bbox), which is exactly why nothing here reads
 * any other key by name.
 */
export function nameOf(feature) {
  const n = feature?.properties?.name ?? feature?.name;
  return typeof n === 'string' && n.trim() ? n.trim() : null;
}

/** Deterministic 32-bit hash → seeded picker, so regeneration is stable. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Usable place names, cleaned and ranked.
 *
 * Rejects names that would make a case untestable rather than hard:
 *  - duplicates (case-insensitive) — "which Starbucks?" is ambiguity, not recall
 *  - names appearing on many features — same problem, and OSM is full of them
 *  - very long names — Audiom synthesises "Intersection of A & B" labels that
 *    are real but make an utterance absurd to speak aloud
 *  - short all-lowercase Latin tokens — OSM carries features literally named
 *    "on", "yes" and "st". "How far is on?" is a broken case, not a hard one.
 *    Deliberately narrow: it cannot catch a real 2-character CJK name, which a
 *    blanket minimum length would
 *
 * @param {object[]} features
 * @param {{maxLength?: number}} [opts]
 * @returns {string[]}
 */
const JUNK_NAME = /^[a-z]{1,3}$/;

export function usableNames(features, { maxLength = 40 } = {}) {
  const counts = new Map();
  for (const f of features) {
    const n = nameOf(f);
    if (!n) continue;
    const key = n.toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const seen = new Set();
  const out = [];
  for (const f of features) {
    const n = nameOf(f);
    if (!n) continue;
    const key = n.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (counts.get(key) !== 1) continue;
    if (n.length > maxLength) continue;
    if (JUNK_NAME.test(n)) continue;
    out.push(n);
  }
  return out;
}

/**
 * Build a case set from a live Audiom payload.
 *
 * @param {object} payload the response from either endpoint
 * @param {object} opts
 * @param {string} opts.profile capability profile these cases run under
 * @param {string} opts.source human label recording where the data came from
 * @param {string} [opts.idPrefix]
 * @param {number} [opts.perKind] cases per place-taking kind
 * @param {number} [opts.seed]
 * @param {number} [opts.distractors] extra names offered alongside the answer
 * @returns {{cases: object[], stats: object}}
 */
export function buildCases(payload, {
  profile,
  source,
  idPrefix = 'A',
  perKind = 3,
  seed = 20260828,
  distractors = 2,
} = {}) {
  if (!profile) throw new Error('buildCases: `profile` is required');
  const features = featuresOf(payload);
  const names = usableNames(features);
  const rand = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];

  const cases = [];
  let n = 0;
  const push = (kind, utterance, place) => {
    const spec = CASE_KINDS[kind];
    n += 1;
    const resolved = [];
    if (place) {
      resolved.push(place);
      // Distractors come from the SAME map, so the candidate block looks like
      // one L1 would actually produce. Inventing them would make the case
      // easier than reality in a way nobody would notice.
      const pool = names.filter((x) => x !== place);
      for (let i = 0; i < distractors && pool.length; i += 1) {
        const d = pick(pool);
        if (d && !resolved.includes(d)) resolved.push(d);
      }
    }
    cases.push({
      id: `${idPrefix}${String(n).padStart(2, '0')}`,
      capability_profile: profile,
      utterance,
      expected_tool: spec.tool,
      expected_args: spec.needsPlace ? { place } : (spec.tool ? null : null),
      context: resolved.length ? { resolved_places: resolved } : {},
      generated_from: source,
    });
  };

  for (const kind of ['whats_here', 'describe_surroundings']) {
    for (const u of TEMPLATES[kind].slice(0, 2)) push(kind, u, null);
  }
  // One place per case within a kind. Without this the seeded picker can draw
  // the same name twice and two "cases" become one, quietly shrinking coverage.
  const used = new Set();
  const pickUnused = () => {
    for (let tries = 0; tries < 50; tries += 1) {
      const c = pick(names);
      if (c && !used.has(c)) { used.add(c); return c; }
    }
    return names.find((c) => !used.has(c)) || null;
  };
  for (const kind of ['get_place_details', 'get_distance_to', 'get_direction_to', 'am_i_at', 'route_to']) {
    if (!names.length) continue;
    for (let i = 0; i < perKind; i += 1) {
      const place = pickUnused();
      if (!place) break;
      const template = pick(TEMPLATES[kind]);
      push(kind, template.replace('{place}', place), place);
    }
  }
  for (const u of TEMPLATES.refusal) push('refusal', u, null);

  return {
    cases,
    stats: {
      source,
      profile,
      features: features.length,
      named: features.filter((f) => nameOf(f)).length,
      usableNames: names.length,
      cases: cases.length,
      // The property census is the point of §"dump what's available": it says
      // how much an allowlist would have thrown away on this map alone.
      distinctPropertyKeys: new Set(
        features.flatMap((f) => Object.keys(f?.properties || {})),
      ).size,
    },
  };
}
