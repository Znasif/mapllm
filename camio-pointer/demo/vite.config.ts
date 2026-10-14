import { createReadStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WASM = join(ROOT, 'node_modules/@mediapipe/tasks-vision/wasm');
const OPENCV = join(ROOT, 'node_modules/@techstark/opencv-js/dist/opencv.js');

/**
 * Demo server: serves the MediaPipe WASM straight from node_modules at
 * /mediapipe/wasm/ (exactly the layout a host self-hosts), and the hand model
 * from demo/public/mediapipe/hand_landmarker.task when present (run
 * `node scripts/copy-assets.mjs demo/public/mediapipe --fetch-model` once).
 * OpenCV.js is served from node_modules at /opencv/opencv.js (the demo's
 * `opencvUrl`; a host self-hosts it, e.g. with copy-assets --opencv).
 */
export default defineConfig({
	root: fileURLToPath(new URL('.', import.meta.url)),
	server: { port: 5180, strictPort: false, fs: { allow: [ROOT] } },
	build: { target: 'es2022' },
	plugins: [
		{
			name: 'camio-mediapipe-wasm',
			configureServer(server) {
				server.middlewares.use('/mediapipe/wasm', (req, res, next) => {
					const name = (req.url || '').split('?')[0].replace(/^\/+/, '');
					const file = join(WASM, name);
					if (!name || name.includes('..') || !existsSync(file)) return next();
					res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
					res.setHeader('Content-Length', String(statSync(file).size));
					createReadStream(file).pipe(res);
				});
				server.middlewares.use('/opencv/opencv.js', (_req, res, next) => {
					if (!existsSync(OPENCV)) return next();
					res.setHeader('Content-Type', 'text/javascript');
					res.setHeader('Content-Length', String(statSync(OPENCV).size));
					createReadStream(OPENCV).pipe(res);
				});
			},
		},
	],
});
