/**
 * The in-tab backend — milestone 3w.
 *
 * `LocalLLMClient` was written in milestone 3 as a seam with a `transport` slot
 * and a FROZEN request contract, specifically so this file could slot in behind
 * it (plan §5, milestone 3 row). Nothing above the seam changes. This module
 * implements exactly the two methods the seam names:
 *
 *     embeddings(body, { signal })            -> OpenAI embeddings response
 *     chat(body, { signal, onChunk })         -> OpenAI completion, or chunks
 *
 * and `LocalLLMClient` cannot tell it from `HttpTransport`.
 *
 * ── Why this is a translation layer and not a reimplementation ───────────────
 *
 * wllama v3 embeds llama-server's OWN request path in WASM
 * (`oaicompat_chat_params_parse` / `params_from_json_cmpl`): the whole options
 * object is `JSON.stringify`-ed and handed to that parser. So `tools`,
 * `tool_choice`, `chat_template_kwargs`, `cache_prompt`, per-request `grammar`
 * and `response_format.json_schema` all mean what they mean on the HTTP router,
 * with the same semantics and the same bugs. The frozen body passes through
 * essentially verbatim. Only four things genuinely differ, and they are the
 * four things this file exists to handle:
 *
 *   1. **`model` is not a routing field.** The HTTP router serves every tier
 *      from one port and picks with `model`. wllama v3 is `n_parallel: 1` —
 *      one model per instance — so `l1` and `l3` are two `Wllama` objects, two
 *      workers, two WASM heaps (plan §8, and the memory is additive). `model`
 *      therefore selects an *engine* here rather than being sent anywhere.
 *   2. **`signal` is called `abortSignal`** and lives inside the options object
 *      rather than beside it.
 *   3. **Streaming is a callback, not SSE.** `{stream: true, onData}` yields
 *      the same `chat.completion.chunk` objects `ChatAssembler` already eats,
 *      so there is no second parser and no second assembler.
 *   4a. **Embeddings do not batch.** `createEmbedding` accepts `string[]` but
 *      answers with a single vector. `embeddings()` loops. See its doc comment.
 *   4. **Loading is explicit and slow.** HTTP has a server already running;
 *      here the first call would otherwise sit on a 2.6 GB download. Loads are
 *      idempotent, deduped, and observable via `onProgress`.
 *
 * ── What is NOT here, deliberately ──────────────────────────────────────────
 *
 * No imperative KV control. v3 dropped v2's `kvClear`/`kvRemove`; what survives
 * is configuration (`n_cache_reuse`, `cache_type_k/v`, `cache_idle_slots`) and
 * it lives in `modelProfiles.js`. Milestone 15 (slot save/restore) stays on the
 * HTTP backend for exactly this reason — do not add an API here that pretends
 * otherwise.
 *
 * Platform-free in the same sense as the rest of `src/lib`: no DOM, no fetch,
 * no static `@wllama/wllama` import. The `Wllama` class is injected or lazily
 * imported, which is what lets `test_wllama_backend.mjs` run the whole contract
 * in Node with no model, no GPU and no network.
 */

import { TIER, LOCAL_MAX_TOKENS } from '../localLLM.js';
import { PROFILES, kvUpperBoundBytes } from './modelProfiles.js';

/**
 * Fields the frozen body may carry that must NOT reach llama.cpp's parser.
 *
 * `stream` is owned by this layer: the caller says "stream" by passing
 * `onChunk`, and letting a stale `stream: true` through while `onData` is
 * absent flips wllama into its async-iterator overload, which returns an
 * iterator nobody reads and hangs the turn.
 */
const OWNED_BY_TRANSPORT = new Set(['stream', 'onData', 'abortSignal']);

/** Everything else rides through untouched — that is the point of the seam. */
function toWllamaOptions(body) {
  const out = {};
  for (const [key, value] of Object.entries(body)) {
    if (!OWNED_BY_TRANSPORT.has(key)) out[key] = value;
  }
  return out;
}

/**
 * The §8.0 guard, restated at the backend boundary.
 *
 * `LocalLLMClient.chatCompletion` already forces `enable_thinking: false`
 * whenever `tools` are present, and `modelProfiles.js` sets both
 * `reasoning: false` and `default_template_kwargs` at load time. This is the
 * third check, and it is not redundant paranoia: the measured failure is that
 * the model emits 256 tokens of chain-of-thought, finishes on `length`, and
 * emits NO TOOL CALL AT ALL — a silent product-path failure that looks like a
 * dumb model rather than a config bug. Anything constructing a body by hand and
 * handing it to this transport directly gets told, loudly, at the boundary.
 */
function assertThinkingDisabled(body) {
  if (!body.tools?.length) return;
  if (body.chat_template_kwargs?.enable_thinking !== false) {
    throw new Error(
      'WllamaTransport: refusing a tools request without chat_template_kwargs.enable_thinking === false ' +
      '(design doc §8.0 — with tools present, thinking-on emits no tool call at all). ' +
      'Build the request through LocalLLMClient.chatCompletion, which sets it.',
    );
  }
}

/** Same reasoning as `LOCAL_MAX_TOKENS` in localLLM.js; enforced again at the edge. */
function clampMaxTokens(body) {
  const asked = body.max_tokens ?? LOCAL_MAX_TOKENS;
  return Math.max(1, Math.min(asked, LOCAL_MAX_TOKENS));
}

/**
 * Default `Wllama` factory. Only ever runs in a browser — every Node test
 * injects `createInstance`, so `@wllama/wllama` is not a Node dependency of the
 * test suite and the HTTP backend never pulls it into a bundle.
 */
async function defaultCreateInstance({ wasmUrl, config } = {}) {
  const { Wllama } = await import('@wllama/wllama/esm/index.js');
  let resolved = wasmUrl;
  if (!resolved) {
    // Vite rewrites `?url` to the emitted asset path. Kept inside the factory
    // so nothing outside a browser build ever evaluates it.
    resolved = (await import('@wllama/wllama/esm/wasm/wllama.wasm?url')).default;
  }
  return new Wllama({ default: resolved }, config);
}

/**
 * Delete every model wllama has cached in OPFS.
 *
 * ⚠️ The obvious hand-written version is wrong, and it wasted an evening:
 * wllama does NOT keep a `models/` directory at the OPFS root, so
 * `removeEntry('models', {recursive: true})` throws `NotFoundError` and deletes
 * nothing — which reads as "Chrome won't clear OPFS" when in fact the wrong key
 * was being removed. The real layout (see `esm/index.js`, OPFS_UTILS_WORKER_CODE
 * and `CacheManager`) is:
 *
 *     <opfs root>/cache/<sha1(fullURL)>_<fileName>
 *     <opfs root>/cache/__metadata__<sha1(fullURL)>_<fileName>
 *
 * Note this drops the whole cache, both tiers. Prefer
 * `wllama.cacheManager.deleteMany(predicate)` when only one model should go.
 *
 * @returns {Promise<boolean>} true if a cache directory was found and removed
 */
export async function clearWllamaCache() {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return false;
  const root = await navigator.storage.getDirectory();
  try {
    await root.removeEntry('cache', { recursive: true });
    return true;
  } catch (err) {
    if (err?.name === 'NotFoundError') return false; // nothing cached; not an error
    throw err;
  }
}

/**
 * One loaded model in one worker. The unit v3's `n_parallel: 1` forces on us.
 */
export class WllamaEngine {
  /**
   * @param {object}   opts
   * @param {object}   opts.profile          from `modelProfiles.js`
   * @param {string}   [opts.url]            first shard; overrides profile.url
   * @param {object}   [opts.hf]             {repo, filePath}; overrides profile.hf
   * @param {object}   [opts.load]           LoadModelParams overrides
   * @param {string}   [opts.wasmUrl]
   * @param {Function} [opts.createInstance] () => Promise<Wllama>; injected in tests
   * @param {(p: {loaded: number, total: number}) => void} [opts.onProgress]
   */
  constructor({
    profile, url, hf, load, wasmUrl, wllamaConfig, createInstance, onProgress,
    fetchImpl, baseHref,
  } = {}) {
    if (!profile) throw new Error('WllamaEngine: `profile` is required');
    this.profile = profile;
    this.url = url ?? profile.url;
    this.hf = hf ?? profile.hf;
    this.loadParams = { ...profile.load, ...load };
    this.wasmUrl = wasmUrl;
    this.wllamaConfig = wllamaConfig;
    this.createInstance = createInstance || defaultCreateInstance;
    this.onProgress = onProgress;
    /** Injectable so `#resolveSource` is testable with no network. */
    this.fetchImpl = fetchImpl;
    /** Base for resolving a relative `url`; the document in a browser. */
    this.baseHref = baseHref
      ?? (typeof location !== 'undefined' ? location.href : 'http://localhost/');

    this.instance = null;
    this.contextInfo = null;
    /** @type {'idle'|'loading'|'ready'|'failed'} */
    this.status = 'idle';
    this.error = null;
    /** In-flight load, so a burst of concurrent calls downloads once. Same
     * pattern `placeIndex.js` uses for concurrent index builds. */
    this.loading = null;
  }

  get ready() {
    return this.status === 'ready';
  }

  /**
   * HEAD the candidate sources and pick the first that returns real bytes.
   *
   * `fetch` is injectable so this stays testable with no network. A source is
   * usable only if the request succeeds, the status is OK, and — when the
   * profile states `weightsBytes` — the served length matches it. A length that
   * disagrees means a redirect to an error page, a truncated mirror, or the
   * wrong quantisation, all of which look identical once llama.cpp aborts.
   *
   * @returns {Promise<{kind:'url',url:string}|{kind:'hf',hf:object}|{kind:'none'}>}
   */
  async #resolveSource() {
    const fetchImpl = this.fetchImpl
      ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    const expected = this.profile?.weightsBytes;
    const tried = [];

    /**
     * ⚠️ A first shard is NOT the model's size, and conflating the two broke the
     * W spike for an afternoon: `e2b-q4-00001-of-00005.gguf` is 23,532,320 bytes
     * against a `weightsBytes` of 2,620,370,976, so a naive length check rejects
     * the split GGUF every single time and silently falls through to whatever is
     * second in the list. Only a single-file source can be size-checked.
     */
    const isShard = (href) => /-\d{5}-of-\d{5}\.gguf(\?|$)/.test(href);

    /**
     * ⚠️ A HEAD is not enough, and this is the failure that wrote `<!do` into OPFS.
     *
     * Vite's `htmlFallbackMiddleware` answers an unmatched `/models/*.gguf` with
     * **200 + index.html**, not 404. A status-only check therefore passes; the
     * `isShard` exemption above skips the one length check that might have
     * caught it; wllama downloads five HTML pages; and `Model.validate()` calls
     * them VALID — it compares `metadata.originalSize` against the file size and
     * the downloads did complete, so the sizes agree. Nothing inside wllama ever
     * looks for the GGUF magic. llama.cpp is handed `<!do` and aborts the module.
     *
     * So read the first four bytes and require `GGUF`. One ranged GET, and it is
     * the only check that catches an HTML body from a local dev server and from
     * a redirecting CDN alike.
     */
    const usable = async (label, href) => {
      if (!fetchImpl) return true; // no way to check; let wllama try
      try {
        const res = await fetchImpl(href, { headers: { Range: 'bytes=0-3' }, redirect: 'follow' });
        if (!res.ok) { tried.push(`${label} → HTTP ${res.status}`); return false; }

        // A 206 describes the slice, so the full size lives in Content-Range.
        // A server that ignores Range reports the whole file in Content-Length.
        const len = res.status === 206
          ? Number(res.headers?.get?.('content-range')?.split('/')?.[1])
          : Number(res.headers?.get?.('content-length'));
        if (expected && !isShard(href) && Number.isFinite(len) && len > 0 && len !== expected) {
          tried.push(`${label} → ${len} bytes, expected ${expected}`);
          return false;
        }

        const magic = String.fromCharCode(
          ...new Uint8Array((await res.arrayBuffer()).slice(0, 4)),
        );
        if (magic !== 'GGUF') {
          const ctype = res.headers?.get?.('content-type') || 'unknown content-type';
          tried.push(`${label} → not a GGUF; first bytes are ${JSON.stringify(magic)} (${ctype})`);
          return false;
        }
        return true;
      } catch (err) {
        tried.push(`${label} → ${err?.message || err}`);
        return false;
      }
    };

    if (this.url && await usable('url', new URL(this.url, this.baseHref).href)) {
      return { kind: 'url', url: this.url };
    }
    if (this.hf) {
      const href = `https://huggingface.co/${this.hf.repo}/resolve/main/${this.hf.filePath}`;
      if (await usable('hf', href)) return { kind: 'hf', hf: this.hf };
    }
    if (tried.length) {
      throw new Error(
        `WllamaEngine(${this.profile.id}): no usable model source. ${tried.join('; ')}. ` +
        'Handing any of these to wllama would abort the WASM module rather than fail cleanly.',
      );
    }
    return { kind: 'none' };
  }

  /**
   * Evict anything in wllama's OPFS cache that is not a GGUF, and say so.
   *
   * ⚠️ This is NOT redundant with `#resolveSource`, and believing it was cost a
   * full debugging round. The preflight guards what wllama DOWNLOADS. It cannot
   * help here, because on a warm cache wllama never reaches the network:
   * `ModelManager` reads OPFS first and `Model.validate()` only asks whether
   * `metadata.originalSize === file.size`. When Vite's html fallback served
   * `index.html` for five shards, all five downloads COMPLETED, so the sizes
   * agree and the cache is judged VALID forever. The observed result:
   *
   *     gguf_init_from_reader: invalid magic characters: '<!do', expected 'GGUF'
   *
   * survives a fixed preflight, a dev-server fix and a page reload, because the
   * poison is already on disk under the same URL key.
   *
   * Every shard of a split GGUF carries its own magic (verified against all
   * five of e2b-q4-0000N-of-00005), so a 4-byte read per entry is a complete
   * test and costs nothing.
   */
  async #evictNonGgufCacheEntries(instance) {
    const cache = instance?.cacheManager;
    if (!cache?.list) return [];
    let entries;
    try {
      entries = await cache.list(); // already excludes __metadata__ sidecars
    } catch {
      return [];
    }

    const poisoned = [];
    for (const entry of entries) {
      try {
        const blob = await cache.open(entry.name);
        if (!blob) continue;
        const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
        if (String.fromCharCode(...head) !== 'GGUF') poisoned.push(entry);
      } catch {
        // Unreadable is as bad as wrong; let the re-download settle it.
        poisoned.push(entry);
      }
    }

    if (poisoned.length) {
      const names = new Set(poisoned.map((e) => e.name));
      // `deleteMany` drops the metadata sidecar too, which matters: an orphaned
      // sidecar makes `getMetadata` report a size for a file that is gone.
      await cache.deleteMany((e) => names.has(e.name));
      console.warn(
        `WllamaEngine(${this.profile.id}): evicted ${poisoned.length} non-GGUF cache ` +
        `entr${poisoned.length === 1 ? 'y' : 'ies'} from OPFS — ` +
        poisoned.map((e) => `${e.name} (${e.size} bytes, from ${e.metadata?.originalURL || 'unknown URL'})`).join('; ') +
        '. These will be re-downloaded.',
      );
    }
    return poisoned;
  }

  /**
   * Idempotent. Concurrent callers share one download; a caller that arrives
   * after a successful load returns immediately.
   */
  async load() {
    if (this.status === 'ready') return this.instance;
    if (this.loading) return this.loading;

    this.status = 'loading';
    this.error = null;
    this.loading = (async () => {
      const instance = await this.createInstance({
        wasmUrl: this.wasmUrl,
        config: this.wllamaConfig,
        profile: this.profile,
      });
      // Before anything is read from OPFS. See the method's comment for why the
      // network preflight below cannot cover this case.
      await this.#evictNonGgufCacheEntries(instance);

      const params = {
        ...this.loadParams,
        progressCallback: (p) => this.onProgress?.({ ...p, profile: this.profile.id }),
      };
      // ⚠️ Preflight, and note why it is not optional. A source that does not
      // resolve to real GGUF bytes does NOT throw a catchable fetch error: wllama
      // caches whatever came back, llama.cpp fails to build a context, and
      // `GGML_ASSERT(ctx_tgt != nullptr)` **aborts the whole WASM module**. Two
      // consequences that cost a day each:
      //
      //   1. The try/catch below WAS a fallback in name only. Once the module has
      //      aborted, `instance` is dead, so retrying `loadModelFromHF` on it can
      //      never work. The choice of source has to be made BEFORE wllama is
      //      handed anything.
      //   2. The abort surfaces as `RuntimeError: (ABORT)` with no mention of the
      //      URL, the status, or the byte count — which is why a plain 404 got
      //      diagnosed as a wrong model, twice. Check first; say what was wrong.
      //
      // ⚠️ There is deliberately NO catch-and-retry here, and it must stay that
      // way. A retry wrapper was tried and removed: point 1 above is the reason
      // it cannot work — after a GGML abort `instance` is dead, so a second
      // `loadModelFrom*` on it is guaranteed to fail. What such a wrapper does
      // in practice is hide `#resolveSource`'s message (the one that names the
      // URL, the status and the byte count) behind a vaguer second error, and,
      // if it purges OPFS on the way, discard 2.6 GB of good weights on every
      // failure. The preflight above is the fix; a retry is not.
      //
      const source = await this.#resolveSource();
      if (source.kind === 'url') {
        await instance.loadModelFromUrl(source.url, params);
      } else if (source.kind === 'hf') {
        await instance.loadModelFromHF(source.hf, params);
      } else if (this.hf) {
        await instance.loadModelFromHF(this.hf, params);
      } else {
        throw new Error(
          `WllamaEngine(${this.profile.id}): no model source — pass \`url\` (first shard of a ` +
          'split GGUF) or `hf` {repo, filePath}',
        );
      }

      // ⚠️ wllama v3 does not always reject `loadModelFrom*` when the embedded
      // llama-server fails to open the weights. The failure is written to the
      // worker's stderr — `llama_model_load: error loading model` — and the
      // promise resolves anyway. Left unchecked the engine is marked `ready`,
      // the first question reaches a server with no model, and what the user is
      // shown is two levels of nonsense: `tools param requires --jinja flag`
      // (there is no chat template because there is no model), then the glue
      // stream desynchronises and reports
      //
      //     RangeError: Invalid typed array length: 1163217991
      //
      // which is 0x45554C47 — the four ASCII bytes `GLUE`, wllama's own frame
      // magic, read as a buffer length. Neither message names the real problem.
      // Ask wllama directly instead, and fail here where the error is truthful.
      if (instance.isModelLoaded && !instance.isModelLoaded()) {
        throw new Error(
          `WllamaEngine(${this.profile.id}): wllama resolved the load but no model is open. ` +
          'Check the worker log for `error loading model` — the usual cause is cached bytes ' +
          'that are not a GGUF. The cache guard above should have evicted them; if it did not, ' +
          'clear OPFS with `clearWllamaCache()` and reload.',
        );
      }

      this.instance = instance;
      // Captured once: the transport's memory reporting and the harness both
      // read n_layer/n_embd/n_ctx from here rather than hardcoding architecture.
      try {
        this.contextInfo = instance.getLoadedContextInfo?.() ?? null;
      } catch {
        this.contextInfo = null;
      }
      this.status = 'ready';
      return instance;
    })();

    try {
      return await this.loading;
    } catch (err) {
      this.status = 'failed';
      this.error = err;
      throw err;
    } finally {
      this.loading = null;
    }
  }

  /** Free the worker and the heap. Safe to call when never loaded. */
  async unload() {
    const instance = this.instance;
    this.instance = null;
    this.contextInfo = null;
    this.status = 'idle';
    if (instance?.exit) await instance.exit().catch(() => {});
  }

  /**
   * What this instance costs. `kvUpperBoundBytes` is honest about being loose —
   * see its doc comment; GQA and sliding-window layers both cut the real figure.
   */
  footprint() {
    return {
      id: this.profile.id,
      tier: this.profile.tier,
      status: this.status,
      contextInfo: this.contextInfo,
      kvUpperBoundBytes: kvUpperBoundBytes(this.contextInfo, this.loadParams),
    };
  }
}

/**
 * The `transport` `LocalLLMClient` takes. Multiplexes the OpenAI `model` field
 * onto engines, because wllama cannot.
 */
export class WllamaTransport {
  /**
   * @param {object} opts
   * @param {Record<string, WllamaEngine>} [opts.engines]  tier -> engine
   * @param {object} [opts.chat]   {profile, url, hf, load, ...} for TIER.REASON
   * @param {object} [opts.embed]  same, for TIER.EMBED; omit for chat-only
   * @param {Function} [opts.createInstance]  injected in tests
   * @param {boolean} [opts.autoLoad]  load on first use (default true). False
   *        makes an unloaded tier a loud error instead of a 2.6 GB surprise
   *        download in the middle of a user's question.
   */
  constructor({ engines, chat, embed, createInstance, wasmUrl, wllamaConfig, onProgress, autoLoad = true } = {}) {
    /** @type {Record<string, WllamaEngine>} */
    this.engines = { ...engines };
    this.autoLoad = autoLoad;

    const build = (spec, tier) => {
      if (!spec) return;
      const profile = typeof spec.profile === 'string' ? PROFILES[spec.profile] : spec.profile;
      if (!profile) throw new Error(`WllamaTransport: unknown profile for tier ${tier}`);
      if (profile.tier !== tier) {
        throw new Error(`WllamaTransport: profile "${profile.id}" is tier ${profile.tier}, not ${tier}`);
      }
      this.engines[tier] = new WllamaEngine({
        ...spec, profile, createInstance, wasmUrl, wllamaConfig, onProgress,
      });
    };
    build(chat, TIER.REASON);
    build(embed, TIER.EMBED);

    // `LocalLLMClient` copies `transport.baseUrl` onto itself for scripts that
    // print it. There is no URL here, and saying so beats saying "/llm/v1".
    this.baseUrl = null;

    // A console handle for `probe()`. Browser only, and deliberately the LAST
    // transport constructed wins — there is one per session.
    if (typeof globalThis !== 'undefined' && typeof window !== 'undefined') {
      globalThis.__llm = this;
      globalThis.__llmProbe = (...args) => this.probe(...args);
    }
  }

  /**
   * Bisect the `no tokens to decode` → PR #20277 abort, from the console.
   *
   * Run `await __llmProbe()` in DevTools after the model has loaded. It sends
   * three requests of increasing shape and reports the first one that dies:
   *
   *   1. `hi`                      — no system message, no tools
   *   2. system + user             — the real prompt, still no tools
   *   3. system + user + tools     — what the dispatcher actually sends
   *
   * Which step aborts is the answer, and nothing else in this session has been
   * able to produce it:
   *
   *   step 1 aborts   → the loaded model/context is broken. Not the prompt, not
   *                     the tools, not the dispatcher. Suspect the weights on
   *                     disk (a bad shard passes `Model.validate()`, see
   *                     `#evictNonGgufCacheEntries`) or the load params.
   *   step 2 aborts   → the prompt. Length, or a chat-template rendering that
   *                     produces zero tokens.
   *   step 3 aborts   → the tools block — i.e. the jinja tool rendering, which
   *                     is the only thing step 3 adds.
   *   nothing aborts  → the transport is fine and the trigger is upstream in
   *                     the dispatcher's own body (a different message array
   *                     than the one built here).
   *
   * ⚠️ Each step that aborts kills the WASM module, so the run STOPS at the
   * first failure. A second step after an abort would fail for the trivial
   * reason that the instance is dead, and reading that as a second data point
   * is exactly the mistake this method exists to prevent. Reload the page
   * between probes.
   *
   * @param {object} [opts]
   * @param {object[]} [opts.tools]  tool array for step 3; defaults to none,
   *        in which case step 3 is skipped. Pass
   *        `__llm.probe({ tools: dispatcher.served().tools })` to include it.
   * @returns {Promise<object[]>} one record per step attempted
   */
  async probe({ tools } = {}) {
    const SYSTEM = 'You control a tactile map for a blind user exploring by touch.';
    const steps = [
      { name: '1/plain', body: { messages: [{ role: 'user', content: 'hi' }] } },
      {
        name: '2/system+user',
        body: {
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: 'how many streets on this map' },
          ],
        },
      },
    ];
    if (tools?.length) {
      steps.push({
        name: '3/system+user+tools',
        body: {
          messages: steps[1].body.messages,
          tools,
          chat_template_kwargs: { enable_thinking: false },
        },
      });
    } else {
      console.warn('[llm probe] no `tools` passed — step 3 skipped. Re-run as ' +
        '`__llmProbe({ tools: <your dispatcher>.served().tools })` to test the tool block.');
    }

    const results = [];
    for (const step of steps) {
      const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
      try {
        const out = await this.chat({ ...step.body, max_tokens: 16 });
        const text = out?.choices?.[0]?.message?.content ?? '';
        const ms = Math.round((typeof performance !== 'undefined' ? performance.now() : 0) - t0);
        console.warn(`[llm probe] ${step.name} OK in ${ms}ms → ${JSON.stringify(String(text).slice(0, 120))}`);
        results.push({ step: step.name, ok: true, ms, text });
      } catch (err) {
        console.error(`[llm probe] ${step.name} FAILED — ${err?.message || err}`, err);
        console.error('[llm probe] stopping here: an abort kills the WASM module, so every ' +
          'later step would fail for that reason alone. Reload the page before probing again.');
        results.push({ step: step.name, ok: false, error: String(err?.message || err) });
        break;
      }
    }
    return results;
  }

  /** @returns {WllamaEngine} */
  engineFor(tier) {
    const engine = this.engines[tier];
    if (!engine) {
      const have = Object.keys(this.engines).join(', ') || 'none';
      throw new Error(
        `WllamaTransport: no engine for tier "${tier}" (configured: ${have}). ` +
        `${tier === TIER.EMBED
          ? 'PlaceIndex needs an `embed` profile — l1 is a SECOND Wllama instance, not a mode of the chat one (plan §8).'
          : 'Pass a `chat` profile.'}`,
      );
    }
    return engine;
  }

  async #ready(tier) {
    const engine = this.engineFor(tier);
    if (engine.ready) return engine;
    if (!this.autoLoad) {
      throw new Error(
        `WllamaTransport: engine "${engine.profile.id}" (${tier}) is not loaded and autoLoad is off. ` +
        'Call preload() behind a progress indicator before the first turn.',
      );
    }
    await engine.load();
    return engine;
  }

  /**
   * Download and open models ahead of the first question. Loading 2.6 GB on the
   * first utterance is a product bug, not a latency figure.
   *
   * @param {string[]} [tiers]  defaults to every configured tier
   */
  async preload(tiers) {
    const list = tiers ?? Object.keys(this.engines);
    // Sequential on purpose: two simultaneous multi-GB downloads on a laptop
    // link is slower than one after the other, and the peak heap during load is
    // additive too.
    for (const tier of list) await this.engineFor(tier).load();
    return this.stats();
  }

  /**
   * @see HttpTransport.embeddings — same contract, no HTTP.
   *
   * ⚠️ DIFFERENCE 5: **wllama does not batch.** `createEmbedding` types its
   * parameter as `input: string | string[]`, but returns exactly ONE embedding
   * however many inputs it is handed. The HTTP router returns one per input, so
   * `LocalLLMClient.embed` — written against that contract — wrote a single
   * vector into a 2,410-slot array and left the rest `undefined`. Nothing threw.
   * The index reported 2,410 places, every count looked healthy, and retrieval
   * silently degraded to "whatever came first in the corpus": measured
   * 2026-08-29 as L1 recall 0/15 with the same five places returned for every
   * query, underneath a respectable 70% tool-selection score.
   *
   * So the loop is the translation. One call per input, order preserved by
   * construction. It is sequential because the instance is `n_parallel: 1`
   * anyway — concurrency here would queue inside the worker, not speed it up.
   */
  async embeddings(body, { signal, onProgress } = {}) {
    const engine = await this.#ready(body.model ?? TIER.EMBED);
    const { model, input, ...rest } = body;
    const inputs = Array.isArray(input) ? input : [input];

    const data = [];
    let promptTokens = 0;
    for (let i = 0; i < inputs.length; i += 1) {
      // Checked per item as well as inside wllama's polling loop, so a barge-in
      // during a 3,000-place index build stops between items too.
      if (signal?.aborted) {
        const err = new Error('Embedding aborted');
        err.name = 'AbortError';
        throw err;
      }
      const res = await engine.instance.createEmbedding({
        ...rest,
        input: inputs[i],
        abortSignal: signal,
      });
      const row = res?.data?.[0];
      if (!row) {
        throw new Error(`wllama returned no embedding for input ${i} of ${inputs.length}`);
      }
      data.push({ object: 'embedding', index: i, embedding: row.embedding });
      promptTokens += res?.usage?.prompt_tokens ?? 0;
      onProgress?.({ done: i + 1, total: inputs.length });
    }

    return {
      object: 'list',
      model: model ?? TIER.EMBED,
      data,
      usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
    };
  }

  /**
   * @see HttpTransport.chat — same contract, no HTTP.
   *
   * `body` is the already-final OpenAI request the frozen contract produces.
   * It is forwarded as-is apart from the four differences documented at the top
   * of this file.
   */
  async chat(body, { signal, onChunk } = {}) {
    assertThinkingDisabled(body);
    const engine = await this.#ready(body.model ?? TIER.REASON);
    const options = toWllamaOptions(body);
    options.max_tokens = clampMaxTokens(body);
    options.abortSignal = signal;

    // ⚠️ Diagnostic for the `no tokens to decode` abort (llama.cpp PR #20277 —
    // a kill switch that fires after N consecutive EMPTY batches, so what it is
    // really reporting is "this request produced nothing to decode"). Printing
    // the shape of the outgoing request is the only way to tell an empty/blank
    // message from a prompt that overruns n_ctx; both look identical from the
    // WASM side, and both end in the same bare `(ABORT)`.
    if (typeof console !== 'undefined') {
      const ctx = engine.contextInfo?.n_ctx;
      const msgs = Array.isArray(body.messages) ? body.messages : [];
      const chars = msgs.reduce((n, m) => n + (typeof m?.content === 'string' ? m.content.length : 0), 0);
      // ⚠️ `console.warn`, not `console.debug`. Chrome's DevTools console hides
      // `debug` unless the level dropdown is switched to Verbose, so the one
      // line this whole investigation depends on was being printed and never
      // seen. Warn shows at the default level.
      console.warn(
        `[llm] request → ${msgs.length} message(s), ${chars} chars ` +
        `(~${Math.round(chars / 4)} tok est), ${body.tools?.length ?? 0} tool(s), ` +
        `max_tokens=${options.max_tokens}, n_ctx=${ctx ?? '?'}`,
        msgs.map((m) => ({
          role: m?.role,
          type: typeof m?.content,
          len: typeof m?.content === 'string' ? m.content.length : null,
          head: typeof m?.content === 'string' ? m.content.slice(0, 120) : m?.content,
        })),
      );
      // ⚠️ An assistant turn that carries `tool_calls` has empty content BY
      // DESIGN — that is how the OpenAI shape says "I called a tool instead of
      // speaking", and the jinja template renders the calls, not the content.
      // Counting it as blank made round 2 of every successful tool loop print a
      // false alarm, which is worse than useless in a diagnostic whose whole job
      // is to be believed. Array content (multimodal parts) is usable too. What
      // is genuinely fatal is a message with nothing at all to render.
      const usable = (m) => {
        if (typeof m?.content === 'string' && m.content.trim()) return true;
        if (Array.isArray(m?.content) && m.content.length) return true;
        if (m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) return true;
        return false;
      };
      const blank = msgs.filter((m) => !usable(m));
      if (!msgs.length || blank.length) {
        console.error(
          '[llm] this request has no usable content — llama.cpp will report ' +
          '"no tokens to decode" and then abort. Blank/absent message(s):', blank,
        );
      }
      if (ctx && chars / 4 > ctx) {
        console.error(
          `[llm] prompt is roughly ${Math.round(chars / 4)} tokens against n_ctx ${ctx}. ` +
          'Overrunning the context is the other way into the empty-batch abort.',
        );
      }
    }

    if (!onChunk) {
      return engine.instance.createChatCompletion({ ...options, stream: false });
    }
    // Returns undefined; the client's ChatAssembler folds the chunks. These are
    // the same `chat.completion.chunk` objects the SSE path parses, so the
    // assembler needs no wllama-specific branch.
    await engine.instance.createChatCompletion({
      ...options,
      stream: true,
      onData: (chunk) => onChunk(chunk),
    });
    return undefined;
  }

  /** Everything the two-instance memory picture needs, per engine. */
  stats() {
    return Object.fromEntries(
      Object.entries(this.engines).map(([tier, engine]) => [tier, engine.footprint()]),
    );
  }

  async unload() {
    for (const engine of Object.values(this.engines)) await engine.unload();
  }
}
