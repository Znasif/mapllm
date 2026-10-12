#!/usr/bin/env node
/**
 * Copy the MediaPipe WASM runtime (from node_modules, same version as the
 * bundle) into <dest>, and optionally fetch the hand model.
 *
 *   node scripts/copy-assets.mjs <dest>                 # e.g. ../explore/Audiom-Front-End/public/vendor/mediapipe
 *   node scripts/copy-assets.mjs <dest> --fetch-model   # also download hand_landmarker.task (~7.8 MB)
 *   node scripts/copy-assets.mjs <dest> --simd-only     # skip the non-SIMD fallback (~10.8 MB less)
 *
 * Layout written: <dest>/wasm/vision_wasm_internal.{js,wasm},
 * <dest>/wasm/vision_wasm_nosimd_internal.{js,wasm}, <dest>/hand_landmarker.task.
 */
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dest = args.find((a) => !a.startsWith('--'));
if (!dest) {
	console.error('usage: node scripts/copy-assets.mjs <dest> [--fetch-model] [--simd-only]');
	process.exit(2);
}
const out = resolve(dest);
const src = join(ROOT, 'node_modules/@mediapipe/tasks-vision/wasm');
mkdirSync(join(out, 'wasm'), { recursive: true });
const files = ['vision_wasm_internal.js', 'vision_wasm_internal.wasm'];
if (!args.includes('--simd-only')) files.push('vision_wasm_nosimd_internal.js', 'vision_wasm_nosimd_internal.wasm');
for (const f of files) {
	copyFileSync(join(src, f), join(out, 'wasm', f));
	console.log(`wasm/${f}  ${(statSync(join(out, 'wasm', f)).size / 1e6).toFixed(1)} MB`);
}
const MODEL_URL =
	'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const model = join(out, 'hand_landmarker.task');
if (args.includes('--fetch-model')) {
	const res = await fetch(MODEL_URL);
	if (!res.ok) throw new Error(`model download failed: ${res.status}`);
	writeFileSync(model, Buffer.from(await res.arrayBuffer()));
	console.log(`hand_landmarker.task  ${(statSync(model).size / 1e6).toFixed(1)} MB`);
} else if (!existsSync(model)) {
	console.log(`hand_landmarker.task  NOT copied — download it from\n  ${MODEL_URL}\n  (or re-run with --fetch-model)`);
}
