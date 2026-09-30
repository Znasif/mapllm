#!/usr/bin/env node
/**
 * Tool-selection benchmark, JavaScript stack — the runner.
 *
 * The twin of `scripts/eval_tools.py`, driving `src/lib` through the same seam
 * everything else uses (`createLLMClient({ backend })`). All the judgement lives
 * in `src/lib/parity/toolEval.js`, which is platform-free and proved by
 * `scripts/test_tool_eval.mjs` with no server; this file only does IO.
 *
 * Unlike the parity harness, THIS ONE SCORES ITSELF. No human, no rubric, no
 * `_graded.md`. That is the whole point: a benchmark that costs an afternoon to
 * interpret gets run once, and this repo has the once to prove it.
 *
 *   # no server needed — compile every prompt, print sizes, call nothing
 *   node scripts/eval_tools.mjs --dry-run
 *
 *   # the real thing against the local router
 *   node scripts/eval_tools.mjs --server http://localhost:11434/v1 --model l3
 *
 *   # one case, verbose, when chasing a single miss
 *   node scripts/eval_tools.mjs --only P03 --verbose
 *
 * Results land in `benchmark/tool_eval_<ts>.json` next to a printed report.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLLMClient } from '../src/lib/llm/index.js';
import {
  compileCase, extractCall, formatEvalReport, gradeCase, summarise,
} from '../src/lib/parity/toolEval.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

function parseArgs(argv) {
  const out = {
    dryRun: false, verbose: false, only: null, label: '',
    server: 'http://localhost:11434/v1', model: 'l3', backend: 'http',
    dataset: join(root, 'docs/eval_dataset_empire_state.json'),
    schema: join(root, 'docs/llm-tools.schema.json'),
    outDir: join(root, 'benchmark'),
    maxTokens: 256, timeoutMs: 300_000,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--verbose' || a === '-v') out.verbose = true;
    else if (a === '--only') out.only = next();
    else if (a === '--label') out.label = next();
    else if (a === '--server') out.server = next();
    else if (a === '--model') out.model = next();
    else if (a === '--backend') out.backend = next();
    else if (a === '--dataset') out.dataset = next();
    else if (a === '--out') out.outDir = next();
    else if (a === '--max-tokens') out.maxTokens = Number(next());
    else if (a === '--help' || a === '-h') { out.help = true; }
    else throw new Error(`Unknown flag: ${a}`);
  }
  return out;
}

const USAGE = `
node scripts/eval_tools.mjs [options]

  --dry-run          compile every prompt, call no model, print sizes
  --server <url>     OpenAI-compatible base URL (default http://localhost:11434/v1)
  --model <name>     model/tier id (default l3)
  --backend <name>   http | wllama (default http)
  --only <ID>        run one case, e.g. P03
  --label <text>     tag the run in the report and filename
  --verbose          print the tool list and user turn per case
  --max-tokens <n>   cap the completion (default 256)
`.trim();

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) { console.log(USAGE); return 0; }

  const schema = JSON.parse(readFileSync(opts.schema, 'utf-8'));
  let dataset = JSON.parse(readFileSync(opts.dataset, 'utf-8'));
  if (opts.only) {
    dataset = dataset.filter((t) => t.id === opts.only);
    if (!dataset.length) throw new Error(`No case with id "${opts.only}"`);
  }

  const cache = new Map();
  const compiled = dataset.map((tc) => ({ tc, c: compileCase(schema, tc, { toolCache: cache }) }));

  if (opts.dryRun) {
    // Deliberately more than "it didn't crash": prompt and tool-list sizes are
    // the numbers that explain a bad score later, and they cost nothing to see.
    console.log(`\nDRY RUN — ${compiled.length} case(s), no model called\n`);
    console.log(`${'id'.padEnd(6)}${'profile'.padEnd(18)}${'frame'.padEnd(12)}${'tools'.padEnd(7)}${'sys'.padEnd(7)}user`);
    console.log('-'.repeat(70));
    for (const { c } of compiled) {
      console.log(
        c.id.padEnd(6) + c.profile.padEnd(18) + c.frame.padEnd(12)
        + String(c.tools.length).padEnd(7) + String(c.systemPrompt.length).padEnd(7)
        + String(c.userMessage.length),
      );
    }
    const names = [...new Set(compiled.flatMap(({ c }) => c.tools.map((t) => t.function?.name)))].sort();
    console.log(`\n${names.length} distinct tools offered across these cases:`);
    console.log('  ' + names.join(', '));
    if (opts.verbose) {
      for (const { c } of compiled) {
        console.log(`\n── ${c.id} ${'─'.repeat(60)}`);
        console.log(c.userMessage);
        console.log(`tools: ${c.tools.map((t) => t.function?.name).join(', ')}`);
      }
    }
    return 0;
  }

  const client = await createLLMClient({
    backend: opts.backend,
    http: { baseUrl: opts.server, timeoutMs: opts.timeoutMs },
  });

  const results = [];
  for (const { tc, c } of compiled) {
    const started = Date.now();
    const base = {
      id: c.id,
      profile: c.profile,
      frame: c.frame,
      utterance: tc.utterance,
      expectedTool: tc.expected_tool ?? null,
      expectedArgs: tc.expected_args ?? null,
      toolCount: c.tools.length,
    };

    try {
      const res = await client.chatCompletion({
        messages: [
          { role: 'system', content: c.systemPrompt },
          { role: 'user', content: c.userMessage },
        ],
        tools: c.tools,
        model: opts.model,
        maxTokens: opts.maxTokens,
      });
      const { calledTool, calledArgs, argsError } = extractCall(res?.message);
      const grade = gradeCase(tc, { calledTool, calledArgs });
      results.push({
        ...base, calledTool, calledArgs, argsError, ...grade,
        narration: res?.message?.content ?? '',
        seconds: (Date.now() - started) / 1000,
        error: null,
      });
    } catch (err) {
      // A transport failure is NOT a wrong answer. It is counted separately and
      // never silently folded into the accuracy figure.
      results.push({
        ...base, calledTool: null, calledArgs: null, argsError: null,
        toolMatch: false, argsMatch: false, falsePositive: false, correct: false,
        seconds: (Date.now() - started) / 1000,
        error: String(err?.message || err),
      });
    }

    const r = results[results.length - 1];
    const mark = r.error ? 'ERR ' : r.correct ? 'ok  ' : 'MISS';
    console.log(`  ${mark} ${r.id.padEnd(6)} ${String(r.calledTool ?? '(none)').padEnd(26)} ${r.seconds.toFixed(1)}s`);
    if (opts.verbose && r.narration) console.log(`       ${r.narration.slice(0, 160)}`);
  }

  const label = opts.label || `${opts.backend}:${opts.model}`;
  const report = formatEvalReport(results, { label });
  console.log(`\n${report}\n`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  mkdirSync(opts.outDir, { recursive: true });
  const path = join(opts.outDir, `tool_eval_${stamp}.json`);
  writeFileSync(path, JSON.stringify({
    label, model: opts.model, backend: opts.backend, server: opts.server,
    dataset: opts.dataset, at: new Date().toISOString(),
    summary: summarise(results), results,
  }, null, 2));
  console.log(`written: ${path}`);

  // Exit non-zero only when the run itself failed. A low score is a finding, not
  // a broken command — making it an error would tempt someone to stop running it.
  return summarise(results).errors ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(`\n[eval_tools] ${err?.stack || err}`);
  process.exit(2);
});
