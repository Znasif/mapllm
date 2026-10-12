/**
 * CamioDotPad live demo (vite dev): start the camera, auto-register or
 * register by corners, and watch pin events and the debug overlay.
 *
 *   npm run demo   →  http://localhost:5180/        (sources)
 *                     http://localhost:5180/?dist  (the vendored bundle)
 */
import type * as Lib from '../src/index';

const params = new URLSearchParams(location.search);
const lib: typeof Lib = params.has('dist')
	? ((await import('../dist/CamioDotPad-0.1.0.js')) as unknown as typeof Lib)
	: await import('../src/index');

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const camera = $<HTMLSelectElement>('camera');
const btn = {
	start: $<HTMLButtonElement>('start'),
	stop: $<HTMLButtonElement>('stop'),
	auto: $<HTMLButtonElement>('auto'),
	corners: $<HTMLButtonElement>('corners'),
	confirm: $<HTMLButtonElement>('confirm'),
	cancel: $<HTMLButtonElement>('cancel'),
};
const fixed = $<HTMLInputElement>('fixed');
const speakBox = $<HTMLInputElement>('speak');
const debug = $<HTMLCanvasElement>('debug');
const grid = $<HTMLCanvasElement>('grid');
const logEl = $<HTMLPreElement>('log');
const statusEl = $<HTMLParagraphElement>('status');
const pinEl = $<HTMLSpanElement>('pin');
const tip = $<HTMLInputElement>('tip');

const log = (line: string) => {
	const t = (performance.now() / 1000).toFixed(1).padStart(7);
	logEl.textContent = `${t}s  ${line}\n${logEl.textContent ?? ''}`.slice(0, 20000);
};

// The model: self-hosted copy if present, else Google's public model file
// (a static download; no video or landmarks ever leave the page).
const LOCAL_MODEL = '/mediapipe/hand_landmarker.task';
const REMOTE_MODEL =
	'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
async function modelUrl() {
	if (params.get('model')) return params.get('model') as string;
	try {
		const r = await fetch(LOCAL_MODEL, { method: 'HEAD' });
		if (r.ok && (r.headers.get('content-type') ?? '').indexOf('html') < 0) return LOCAL_MODEL;
	} catch {
		// fall through to the public model
	}
	return REMOTE_MODEL;
}

/** Fill the camera list (labels appear once permission has been granted). */
async function listCameras() {
	if (!navigator.mediaDevices?.enumerateDevices) return;
	const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
	const keep = camera.value;
	camera.innerHTML = '<option value="">Default camera</option>';
	for (const d of devices) {
		const o = document.createElement('option');
		o.value = d.deviceId;
		o.textContent = d.label || `Camera ${camera.options.length}`;
		camera.append(o);
	}
	// Prefer the document camera aimed at the pad (Anker PowerConf C200) if listed.
	const preferred = devices.find((d) => /C200|PowerConf/i.test(d.label));
	camera.value = keep || preferred?.deviceId || '';
}
void listCameras();

let pointer: Lib.DotPadPointer | null = null;
let raf = 0;

function speak(text: string) {
	if (!speakBox.checked || !('speechSynthesis' in window)) return;
	speechSynthesis.cancel();
	speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

function drawGrid(pin: Lib.PinEvent | null) {
	const ctx = grid.getContext('2d');
	if (!ctx) return;
	const s = 10;
	ctx.fillStyle = '#0f172a';
	ctx.fillRect(0, 0, grid.width, grid.height);
	for (let r = 0; r < 40; r++)
		for (let c = 0; c < 60; c++) {
			const border = c < 2 || r < 2 || c > 57 || r > 37;
			ctx.fillStyle = border ? '#7c2d12' : '#334155';
			ctx.beginPath();
			ctx.arc(c * s + s / 2, r * s + s / 2, 2.2, 0, Math.PI * 2);
			ctx.fill();
		}
	if (pin) {
		ctx.fillStyle = pin.inBorder ? '#f97316' : '#facc15';
		ctx.fillRect(pin.x * s, pin.y * s, s, s);
	}
}
drawGrid(null);

function setEnabled(running: boolean) {
	btn.start.disabled = running;
	btn.stop.disabled = !running;
	btn.auto.disabled = !running;
	btn.corners.disabled = !running;
	btn.confirm.disabled = !running;
	btn.cancel.disabled = !running;
	fixed.disabled = !running;
	camera.disabled = running;
}

function frame() {
	if (pointer) pointer.drawDebug(debug);
	raf = requestAnimationFrame(frame);
}

btn.start.onclick = async () => {
	btn.start.disabled = true;
	try {
		pointer?.dispose();
		pointer = lib.createDotPadPointer({
			wasmBase: '/mediapipe/wasm',
			modelUrl: await modelUrl(),
			deviceId: camera.value || undefined,
			tipOffsetPins: Number(tip.value),
		});
		pointer.on('prompt', (p) => {
			log(`prompt  ${p.code}: ${p.text}`);
			speak(p.text);
		});
		pointer.on('status', (s) => {
			statusEl.textContent = `${s.message}${s.handsInView ? ` · hands ${s.handsInView}` : ''}${s.pointing ? ' · pointing' : ''}`;
			if (s.phase === 'confirm') btn.confirm.classList.add('primary');
			else btn.confirm.classList.remove('primary');
		});
		pointer.on('pin', (p) => {
			pinEl.textContent = `${p.x}, ${p.y}${p.inBorder ? ' (border)' : ''}`;
			drawGrid(p);
			log(`pin     ${p.x},${p.y}${p.inBorder ? ' border' : ''}  (f ${p.fx.toFixed(2)}, ${p.fy.toFixed(2)})`);
		});
		pointer.on('leave', (e) => {
			pinEl.textContent = '—';
			drawGrid(null);
			log(`leave   ${e.reason}`);
		});
		pointer.on('registration', (r) =>
			log(`registered (${r.method}${r.textFound ? ', text line' : ''}) pitch ${r.pitchPx.toFixed(2)} px  TL ${r.corners[0].map((v) => v.toFixed(0)).join(',')}`),
		);
		pointer.on('lost', (e) => log(`LOST    ${e.reason}`));
		pointer.on('moved', (e) => log(`moved   via ${e.via}, ${e.pins.toFixed(1)} pins`));
		pointer.on('cue', (e) => log(`cue     ${e.code}`));
		pointer.on('error', (e) => log(`error   ${e.code}: ${e.message}`));
		statusEl.textContent = 'Starting camera and hand model…';
		await pointer.start();
		const track = (pointer.videoElement?.srcObject as MediaStream | null)?.getVideoTracks()[0];
		log(`camera  ${track?.label ?? '?'}  ${pointer.videoElement?.videoWidth}×${pointer.videoElement?.videoHeight}`);
		setEnabled(true);
		void listCameras();
		cancelAnimationFrame(raf);
		frame();
	} catch (error) {
		statusEl.textContent = String(error);
		log(`start failed: ${String(error)}`);
		setEnabled(false);
	}
};
btn.stop.onclick = () => {
	pointer?.stop();
	setEnabled(false);
	statusEl.textContent = 'Stopped (registration kept)';
};
btn.auto.onclick = async () => {
	const r = await pointer?.autoRegister();
	log(`autoRegister → ${r ? 'registered' : 'null'}`);
};
btn.corners.onclick = () => pointer?.registerByCorners();
btn.confirm.onclick = () => pointer?.confirmTopLeft();
btn.cancel.onclick = () => pointer?.cancel();
fixed.onchange = () => pointer?.setFixed(fixed.checked);
tip.oninput = () => {
	$('tipv').textContent = tip.value;
	if (pointer) pointer.core.options.tipOffsetPins = Number(tip.value);
};
window.addEventListener('keydown', (e) => {
	if (!pointer?.running || e.ctrlKey || e.metaKey || e.altKey) return;
	if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'SELECT') return;
	if (e.key === 'a' || e.key === 'A') void btn.auto.onclick?.(new MouseEvent('click'));
	if (e.key === 'r' || e.key === 'R') pointer.registerByCorners();
	if (e.key === ';') {
		fixed.checked = !fixed.checked;
		pointer.setFixed(fixed.checked);
	}
	if (e.key === 'Escape') pointer.cancel();
});
