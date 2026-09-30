/**
 * Tool-selection benchmark — the JS twin of `scripts/eval_tools.py`, and the
 * first thing in this stack that produces a **number without a human**.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * The parity harness (`runner.js`) replays a 28-turn MapIO session and emits
 * transcripts with `grade: null` on every turn; a person grades them afterwards
 * against six classes. That is the right instrument for answer *quality*, and it
 * is why nothing has ever actually been graded — it costs a human afternoon per
 * arm, so no arm has been run twice.
 *
 * `docs/eval_dataset.json` is a different instrument that was already sitting
 * here unused by anything in JS: 21 cases, each with an `expected_tool` and
 * `expected_args`. Whether the model picked the right tool is a **mechanical**
 * question. No judgement, no rubric, no afternoon. That makes it the benchmark
 * you can run on every change, which is the only kind that gets run.
 *
 * It also answers the question the harness cannot: `wllama-ny-parity-first-run`
 * recorded that the tool *layer* is numerically exact (841.7 vs 841.66) and that
 * the failures are tool **selection**. This measures exactly that.
 *
 * ── WHAT IT DOES NOT MEASURE ──────────────────────────────────────────────
 *
 * Answer quality. A model can select `whats_here` correctly and then narrate
 * nonsense. This is a necessary condition for a good session, not a sufficient
 * one, and it does not replace the parity harness — it makes the parity harness
 * affordable to *interpret*, by telling you whether a regression was selection
 * or prose.
 *
 * ── GRADING, COPIED FROM THE PYTHON DELIBERATELY ──────────────────────────
 *
 * `eval_tools.py:393-413`, rule for rule, because an arm-to-arm comparison
 * across the two stacks is worthless if the graders disagree:
 *
 *   expected_tool === null   correct iff NO tool was called; any call is a
 *                            false positive (the 5 refusal cases: X01 X02 N01-N03)
 *   otherwise                toolMatch iff called === expected
 *                            argsMatch iff every key in expected_args matches
 *                            (subset comparison — extra keys are permitted,
 *                            exactly as the Python does it)
 *
 * PLATFORM-FREE, like everything else in `lib/`. No fs, no network, no `window`.
 * The runner (`scripts/eval_tools.mjs`) does IO; this decides what is correct,
 * and `scripts/test_tool_eval.mjs` proves it against fabricated responses with
 * no server anywhere.
 */

import { buildSystemPrompt, buildUserTurn } from '../candidateContext.js';
import { filterTools } from '../toolFilter.js';

/**
 * Frame per capability profile. Ported from `eval_tools.py:71-77` including its
 * caveat, because divergence here silently changes which tools are offered.
 *
 * ⚠️ `audiom_tier_a` is a PLACEHOLDER. §3.2 calls its frame "geographic or ENU"
 * depending on the fetched source, and the 21-case dataset contains no tier-A
 * case, so nothing has ever exercised it. Revisit against a real source before
 * trusting a tier-A number — see `addAudiomCases` in the plan (audiom_io.md §6).
 */
export const PROFILE_FRAMES = Object.freeze({
  osm_full: 'geographic',
  osm_places_only: 'geographic',
  audiom_tier_a: 'enu',
  audiom_tier_c: 'enu',
  camio: 'image',
});

/**
 * Prove the embedding tier actually works before a single case is scored.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * The first real run scored 70% with **L1 recall 0/15**, and the retrieved list
 * was byte-identical for every query: the first five places in the corpus, in
 * file order. That is the signature of degenerate scores — NaN or all-equal —
 * where `sort` leaves the array untouched. Nothing errored, no count looked
 * wrong, and the headline number was respectable.
 *
 * Two embeddings of obviously different text must be finite, unit-length and
 * NOT near-identical. If they are, retrieval is broken and every recall figure
 * below it is noise, so the run should say so at the top rather than let a
 * reader infer competence from the tool-selection score.
 *
 * @param {object} client a `LocalLLMClient` (or anything with `embedQueries`)
 * @returns {Promise<{ok: boolean, reason: string|null, dim: number,
 *   similarity: number|null, norms: number[]}>}
 */
export async function checkEmbeddings(client) {
  const probes = ['a hotel with a rooftop bar', 'the subway train to Coney Island'];
  let vecs;
  try {
    vecs = await client.embedQueries(probes);
  } catch (err) {
    return { ok: false, reason: `embedQueries threw: ${err?.message || err}`, dim: 0, similarity: null, norms: [] };
  }
  if (!Array.isArray(vecs) || vecs.length !== probes.length || !vecs[0]?.length) {
    return { ok: false, reason: 'embedQueries did not return one vector per input', dim: 0, similarity: null, norms: [] };
  }

  const norm = (v) => Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  const norms = vecs.map(norm);
  if (norms.some((n) => !Number.isFinite(n) || n === 0)) {
    return { ok: false, reason: 'embeddings are non-finite or zero — check `encoding_format`', dim: vecs[0].length, similarity: null, norms };
  }

  let d = 0;
  for (let i = 0; i < vecs[0].length; i += 1) d += vecs[0][i] * vecs[1][i];
  const similarity = d / (norms[0] * norms[1]);
  if (!Number.isFinite(similarity)) {
    return { ok: false, reason: 'similarity is NaN', dim: vecs[0].length, similarity: null, norms };
  }
  // Two unrelated sentences scoring ~1 means the encoder is returning a
  // constant, which ranks every query identically.
  if (similarity > 0.99) {
    return { ok: false, reason: `unrelated texts score ${similarity.toFixed(4)} — the encoder is returning a constant`, dim: vecs[0].length, similarity, norms };
  }
  return { ok: true, reason: null, dim: vecs[0].length, similarity, norms };
}

/**
 * Build the exact prompt, user turn and tool list one case is judged on.
 *
 * Uses the real `candidateContext` and `toolFilter` — the same modules the app
 * and the Python shim call — so a benchmark failure is a failure of the thing
 * that ships, never of a re-implementation. Tool lists are cached per
 * profile+frame because `filterTools` is pure and the dataset repeats profiles.
 *
 * @param {object} schema `docs/llm-tools.schema.json`
 * @param {object} testCase one entry of `eval_dataset.json`
 * @param {{toolCache?: Map, frames?: object, candidates?: string[]}} [opts]
 * @returns {{id: string, profile: string, frame: string, systemPrompt: string,
 *   userMessage: string, tools: object[]}}
 */
export function compileCase(schema, testCase, {
  toolCache = null, frames = PROFILE_FRAMES, candidates = null,
} = {}) {
  const profile = testCase.capability_profile || 'osm_full';
  const frame = frames[profile];
  if (!frame) {
    throw new Error(`No frame mapping for capability_profile "${profile}" — add it to PROFILE_FRAMES`);
  }
  const profileSchema = schema?.capabilityProfiles?.[profile];
  if (!profileSchema) {
    throw new Error(`Unknown capability_profile "${profile}" — not in schema.capabilityProfiles`);
  }

  const key = `${profile}::${frame}`;
  let tools = toolCache?.get(key);
  if (!tools) {
    tools = filterTools(schema, { capabilities: new Set(profileSchema.caps || []), frame });
    toolCache?.set(key, tools);
  }

  // `candidates` overrides the dataset's `resolved_places`. That is the whole
  // l1 story: in `dataset` mode the case is handed the right names for free and
  // only L3's tool choice is under test; in `l1` mode the names come out of
  // EmbeddingGemma and a miss can be attributed to retrieval instead of
  // selection. Reporting one number for both is how you spend a week tuning a
  // prompt for a problem that lives in the index.
  const names = candidates ?? (testCase.context?.resolved_places || []);
  const matches = names.map((name) => (typeof name === 'string' ? { name } : name));
  return {
    id: testCase.id,
    profile,
    frame,
    systemPrompt: buildSystemPrompt(),
    userMessage: buildUserTurn(matches, testCase.utterance),
    tools,
  };
}

/**
 * The place a case actually hinges on, or null when it hinges on none.
 *
 * Read off `expected_args.place` rather than the resolved-places list, because
 * that list is a distractor set by design — P03 lists three cafes and only one
 * is the answer.
 *
 * @param {object} testCase
 * @returns {string|null}
 */
export function expectedPlace(testCase) {
  const p = testCase?.expected_args?.place;
  return typeof p === 'string' && p ? p : null;
}

/**
 * Grade the RETRIEVAL stage on its own terms.
 *
 * `hit` is recall: did L1 put the needed place in front of L3 at all? A case
 * that needs no place is `n/a` and must never be counted as a retrieval success
 * — averaging those in is how an index that returns nothing scores well on a
 * dataset where two thirds of the cases take no arguments.
 *
 * @param {object} testCase
 * @param {string[]|null} retrieved names L1 surfaced, in rank order
 * @returns {{applicable: boolean, hit: boolean|null, rank: number|null, wanted: string|null}}
 */
export function gradeRetrieval(testCase, retrieved) {
  const wanted = expectedPlace(testCase);
  if (!wanted) return { applicable: false, hit: null, rank: null, wanted: null };
  const names = (retrieved || []).map((m) => (typeof m === 'string' ? m : m?.name));
  const idx = names.indexOf(wanted);
  return { applicable: true, hit: idx >= 0, rank: idx >= 0 ? idx + 1 : null, wanted };
}

/**
 * Pull the first tool call out of a chat completion message.
 *
 * Reads `tool_calls` rather than `finish_reason`, matching `toolLoop.js:159`:
 * a truncated round can report `length` while still carrying a complete call.
 * A call whose arguments are not valid JSON is reported as `argsError` and
 * grades as a tool match with an args miss — the model chose right and
 * serialised wrong, which is a different defect and worth seeing separately.
 *
 * @param {object|null} message
 * @returns {{calledTool: string|null, calledArgs: object|null, argsError: string|null}}
 */
export function extractCall(message) {
  const call = message?.tool_calls?.[0];
  if (!call) return { calledTool: null, calledArgs: null, argsError: null };

  const name = call.function?.name ?? null;
  const raw = call.function?.arguments ?? '';
  if (typeof raw === 'object' && raw !== null) {
    return { calledTool: name, calledArgs: raw, argsError: null };
  }
  try {
    return {
      calledTool: name,
      calledArgs: String(raw).trim() ? JSON.parse(String(raw)) : {},
      argsError: null,
    };
  } catch (err) {
    return { calledTool: name, calledArgs: null, argsError: String(err.message || err) };
  }
}

/**
 * Grade one case. See the module header for the rules; they are the Python's.
 *
 * @param {object} testCase
 * @param {{calledTool: string|null, calledArgs: object|null}} outcome
 * @returns {{toolMatch: boolean, argsMatch: boolean, falsePositive: boolean, correct: boolean}}
 */
export function gradeCase(testCase, { calledTool = null, calledArgs = null } = {}) {
  const expectedTool = testCase.expected_tool ?? null;
  const expectedArgs = testCase.expected_args ?? null;

  if (expectedTool === null) {
    const falsePositive = calledTool !== null;
    return {
      toolMatch: !falsePositive,
      argsMatch: !falsePositive,
      falsePositive,
      correct: !falsePositive,
    };
  }

  if (calledTool !== expectedTool) {
    return { toolMatch: false, argsMatch: false, falsePositive: false, correct: false };
  }

  let argsMatch = false;
  if (expectedArgs !== null && calledArgs !== null && typeof calledArgs === 'object') {
    // Subset comparison, as the Python does: every expected key must match;
    // extra keys the model volunteered are not penalised here.
    argsMatch = Object.entries(expectedArgs).every(([k, v]) => calledArgs[k] === v);
  } else if (expectedArgs === null && calledArgs === null) {
    argsMatch = true;
  } else if (expectedArgs === null) {
    // `expected_args: null` means "any arguments are acceptable" (P02 does this).
    argsMatch = true;
  }

  return { toolMatch: true, argsMatch, falsePositive: false, correct: argsMatch };
}

/**
 * Totals over graded cases.
 *
 * `correct` is the headline: tool AND args, with refusals counted as correct
 * only when nothing was called. Reporting tool accuracy alone flatters a model
 * that reaches for the right tool and fills it in wrongly.
 *
 * @param {object[]} results
 */
export function summarise(results) {
  const n = results.length;
  const count = (pred) => results.filter(pred).length;
  const refusals = results.filter((r) => (r.expectedTool ?? null) === null);
  return {
    cases: n,
    toolMatch: count((r) => r.toolMatch),
    argsMatch: count((r) => r.argsMatch),
    correct: count((r) => r.correct),
    falsePositives: count((r) => r.falsePositive),
    argsErrors: count((r) => r.argsError),
    errors: count((r) => r.error),
    refusalCases: refusals.length,
    refusalsHeld: refusals.filter((r) => r.correct).length,
    accuracy: n ? count((r) => r.correct) / n : 0,
    // Retrieval is summarised over the cases it APPLIES to, never over all of
    // them — see `gradeRetrieval`.
    retrievalCases: count((r) => r.retrieval?.applicable),
    retrievalHits: count((r) => r.retrieval?.hit),
    byProfile: results.reduce((acc, r) => {
      const p = (acc[r.profile] ||= { cases: 0, correct: 0 });
      p.cases += 1;
      if (r.correct) p.correct += 1;
      return acc;
    }, {}),
  };
}

const pad = (s, n) => String(s ?? '').padEnd(n);

/**
 * Human-readable report. Misses first — a 90% run's whole information content
 * is the two failures, and burying them under eighteen `ok` lines is how a
 * benchmark stops being read.
 *
 * @param {object[]} results
 * @param {{label?: string}} [opts]
 * @returns {string}
 */
export function formatEvalReport(results, { label = '' } = {}) {
  const s = summarise(results);
  const lines = [];
  const pct = (x) => `${(100 * (s.cases ? x / s.cases : 0)).toFixed(0)}%`;

  lines.push(`Tool-selection benchmark${label ? ` — ${label}` : ''}`);
  lines.push(
    `${s.correct}/${s.cases} correct (${pct(s.correct)})  ·  `
    + `tool ${s.toolMatch}/${s.cases}  ·  args ${s.argsMatch}/${s.cases}  ·  `
    + `refusals held ${s.refusalsHeld}/${s.refusalCases}`,
  );
  if (s.retrievalCases) {
    lines.push(
      `L1 recall ${s.retrievalHits}/${s.retrievalCases} on the cases that need a place`,
    );
    // Zero is not "bad recall", it is a broken tier — and a reader who sees a
    // healthy tool-selection score above it will not conclude that on their own.
    if (s.retrievalHits === 0) {
      lines.push(
        '⚠️  L1 RETRIEVAL IS BROKEN — not one case retrieved its place. Treat every '
        + 'number here as tool selection ONLY; the candidate block contributed nothing.',
      );
    }
  }
  if (s.falsePositives) lines.push(`⚠️  ${s.falsePositives} false positive(s) — called a tool when it should not have`);
  if (s.argsErrors) lines.push(`⚠️  ${s.argsErrors} unparseable argument string(s)`);
  if (s.errors) lines.push(`⚠️  ${s.errors} case(s) failed to run at all`);

  const misses = results.filter((r) => !r.correct);
  if (misses.length) {
    lines.push('');
    lines.push(`MISSES (${misses.length})`);
    lines.push(`${pad('id', 6)}${pad('profile', 18)}${pad('expected', 26)}${pad('called', 26)}why`);
    lines.push('-'.repeat(96));
    for (const r of misses) {
      // Attribution first: if L1 never surfaced the place, L3 could not have
      // named it and calling this a selection failure is simply wrong.
      const why = r.error ? `error: ${r.error}`
        : r.retrieval?.applicable && r.retrieval.hit === false
          ? `L1 MISS — "${r.retrieval.wanted}" was never retrieved`
          : r.falsePositive ? 'false positive'
            : r.argsError ? `bad args json: ${r.argsError}`
              : r.toolMatch ? `args: got ${JSON.stringify(r.calledArgs)}`
                : 'wrong tool';
      lines.push(
        pad(r.id, 6) + pad(r.profile, 18) + pad(r.expectedTool ?? '(none)', 26)
        + pad(r.calledTool ?? '(none)', 26) + why,
      );
    }
  } else {
    lines.push('');
    lines.push('No misses.');
  }

  lines.push('');
  lines.push('by profile: ' + Object.entries(s.byProfile)
    .map(([p, v]) => `${p} ${v.correct}/${v.cases}`).join('  ·  '));

  // Coverage is part of the result. A profile with no cases cannot regress, and
  // reading 100% without this line invites believing the whole system is covered.
  const uncovered = Object.keys(PROFILE_FRAMES).filter((p) => !s.byProfile[p]);
  if (uncovered.length) {
    lines.push(`⚠️  NOT COVERED by this dataset: ${uncovered.join(', ')} — these profiles are unmeasured, not passing`);
  }

  return lines.join('\n');
}
