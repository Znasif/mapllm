import { useEffect, useRef, useState } from 'react';
import {
  MEDIAPIPE_VERSION, OPENCV_VERSION, PROMPTS, createCamioPointer,
} from './vendor/camio/CamioPointer-0.2.0.js';
import { openCameraStream } from './cameraDevices';
import { cancelSpeech } from './lib/speak';
import { CORNER_PROMPTS } from './lib/cornerRegistration';
import { uvFromPose } from './lib/camioUv';
import { DOTPAD_GEOMETRY } from './lib/dotpadViewport';

// Assets from the CDN. The WASM must match the MediaPipe build bundled into the
// library; the model is the same file TactileExplorerGeneric loads. OpenCV.js
// is only fetched for a rect surface — never on the DOT Pad used here.
const MEDIAPIPE_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
const HAND_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const OPENCV_URL = `https://cdn.jsdelivr.net/npm/@techstark/opencv-js@${OPENCV_VERSION}/dist/opencv.js`;

const PIN_COLS = DOTPAD_GEOMETRY.W;
const PIN_ROWS = DOTPAD_GEOMETRY.H;
const BAND = DOTPAD_GEOMETRY.o;

// Library phases → the names TactileExplorerGeneric reports to the host.
const PHASE_NAMES = {
  idle: 'idle', corners: 'capturing', autoFind: 'autofind', confirm: 'confirm', handsOff: 'handsoff', ready: 'ready',
};

const NO_ANNOUNCE = () => {};

// Same corner-lock beep as TactileExplorerGeneric (a sound cue, not an
// instruction — it stays).
let _ac;
const beep = () => {
  try {
    _ac = _ac || new (window.AudioContext || window.webkitAudioContext)();
    const o = _ac.createOscillator(), g = _ac.createGain();
    o.frequency.value = 880; o.connect(g); g.connect(_ac.destination);
    g.gain.setValueAtTime(0.2, _ac.currentTime); o.start();
    g.gain.exponentialRampToValueAtTime(0.001, _ac.currentTime + 0.15); o.stop(_ac.currentTime + 0.16);
  } catch { /* noop */ }
};

/** Status line from the library's status (TactileExplorerGeneric's wording where it has one). */
function statusText(st) {
  switch (st.phase) {
    case 'corners': return 'Registering DOT Pad corners';
    case 'autoFind': return st.message === 'Hands off' ? 'Auto-find: hands off the pad' : 'Auto-find: looking for the pins…';
    case 'confirm': return 'Found the pins, but not which way up — touch the top-left pin';
    case 'handsOff': return 'Lift your hand…';
    case 'ready':
      switch (st.tracking) {
        case 'fixed': return 'Tracking (Fixed)';
        case 'lost': return 'DOT Pad lost — hands off for a moment';
        case 'static': return 'Tracking (pins not visible — holding the registration)';
        case 'occluded': return 'Tracking (pins covered)';
        default: return 'Tracking';
      }
    default: return st.registered ? 'Registered' : 'Ready — press R (corners) or A (auto-find).';
  }
}

/**
 * The camio-pointer library (src/vendor/camio) as a drop-in for
 * TactileExplorerGeneric: same props, controls and keys (r / a / ;), same
 * `onUv` contract. Selected with `audiom.html?pointer=camio`.
 *
 * The library owns registration (corners or lattice auto-find), tracking (the
 * pin-lattice follower, no OpenCV), the drift watchdog and the pointing
 * gesture. Its 'point' event fires only when the pin changes, but the bridge's
 * quantizer and send gate (dwell, min interval) expect a sample every frame —
 * so each animation frame the pointing fingertip is mapped through the
 * library's current pose to fractional pins (fx, fy), exactly as the library
 * computes the fx / fy of its 'point' events, and sent as
 *   u = fx / (cols − 1), v = fy / (rows − 1)   (lib/camioUv.js)
 * (corner-pin CENTRES = 0 / 1, TactileExplorerGeneric's convention). It is
 * sent only while the library has a current point (registered, not lost,
 * pointing, on the pad), else null. Library `hysteresis: 0` so the bridge's
 * preset / slider stays the only pin hysteresis.
 *
 * Prompts (the library's default English) and the camera-denied error go to
 * the host's `announce` — on audiom.html an ARIA live region; the page itself
 * never speaks, the Audiom map does the talking. An open hand still calls
 * cancelSpeech() (the user's "open hand stops speech" gesture); with nothing
 * of the page's own speaking it is a no-op unless the hidden mic path spoke.
 */
export function CamioPointerPanel({
  onUv, avatarPin = null, fingerPin = null, pagesLabel = '', showRectPanel = true,
  actionsRef, onRegistrationChange, leadingControls = null, announce = NO_ANNOUNCE,
}) {
  const announceRef = useRef(announce);
  useEffect(() => { announceRef.current = announce; }, [announce]);
  const videoRef = useRef(null);
  const debugRef = useRef(null);
  const rectRef = useRef(null);
  const pointerRef = useRef(null);
  const lastUvRef = useRef(null);

  const onUvRef = useRef(onUv);
  useEffect(() => { onUvRef.current = onUv; }, [onUv]);
  const avatarPinRef = useRef(avatarPin);
  useEffect(() => { avatarPinRef.current = avatarPin; }, [avatarPin]);
  const fingerPinRef = useRef(fingerPin);
  useEffect(() => { fingerPinRef.current = fingerPin; }, [fingerPin]);
  const pagesLabelRef = useRef(pagesLabel);
  useEffect(() => { pagesLabelRef.current = pagesLabel; }, [pagesLabel]);

  const [initStatus, setInitStatus] = useState('Initializing…'); // until the library runs, or an error
  const [attempt, setAttempt] = useState(0); // bump to retry camera/model init
  const [camInfo, setCamInfo] = useState(null);
  const [pst, setPst] = useState(null); // the library's PointerStatus
  const [trackInfo, setTrackInfo] = useState(null); // { found, visible }

  const phase = PHASE_NAMES[pst?.phase] || 'idle';
  const isFixed = !!pst?.fixed;
  useEffect(() => { onRegistrationChange?.({ phase, isFixed }); }, [phase, isFixed, onRegistrationChange]);

  const startCapture = () => pointerRef.current?.registerByCorners();
  const startAutoFind = () => {
    pointerRef.current?.autoRegister().catch((e) => console.warn('[CamioPointerPanel] auto-find failed:', e));
  };
  const toggleFixed = () => {
    const p = pointerRef.current;
    if (p) p.setFixed(!p.status.fixed);
  };

  if (actionsRef) actionsRef.current = { register: startCapture, autoFind: startAutoFind, toggleFixed };

  // Keyboard: ';' Fix, 'r' register by corners, 'a' auto-find (ignored while
  // typing in a field). Dead while focus is inside the Audiom iframe (R9).
  useEffect(() => {
    function onKey(e) {
      if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === ';' || e.code === 'Semicolon') { e.preventDefault(); toggleFixed(); }
      if (e.key === 'r' || e.key === 'R') { e.preventDefault(); startCapture(); }
      if (e.key === 'a' || e.key === 'A') { e.preventDefault(); startAutoFind(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** Emit the fingertip (u, v), or null once. The bridge ignores repeats of null cheaply. */
  const emitUv = (uv) => {
    if (!uv && lastUvRef.current === null) return;
    lastUvRef.current = uv;
    onUvRef.current?.(uv);
  };

  // Camera + library. The camera is opened here (cameraDevices.js, as before,
  // with the relaxed retry) into a rendered <video>, and handed to the library.
  useEffect(() => {
    let cancelled = false;
    const video = videoRef.current;
    const pointer = createCamioPointer({
      surface: { kind: 'dotpad', border: BAND },
      wasmBase: MEDIAPIPE_WASM,
      modelUrl: HAND_MODEL_URL,
      opencvUrl: OPENCV_URL,
      video,
      hysteresis: 0,
    });
    pointerRef.current = pointer;
    const reported = new Set();
    pointer.on('prompt', ({ text }) => announceRef.current?.(text));
    pointer.on('openHand', () => cancelSpeech());
    pointer.on('cue', ({ code }) => { if (code === 'lock') beep(); });
    pointer.on('status', (st) => setPst(st));
    pointer.on('error', (e) => {
      if (reported.has(e.code)) return;
      reported.add(e.code);
      console.warn('[CamioPointerPanel]', e.code, e.message);
    });

    async function init() {
      setInitStatus(attempt === 0 ? 'Opening camera…' : 'Opening camera (any device)…');
      const stream = await openCameraStream({ relaxed: attempt > 0 });
      if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
      video.srcObject = stream;
      await video.play();
      setInitStatus('Loading hand model…');
      await pointer.start(); // waits for real frames; throws when none arrive
      if (cancelled) return;
      const track = stream.getVideoTracks()[0];
      setCamInfo({
        w: video.videoWidth, h: video.videoHeight,
        label: track?.label || 'camera', state: track?.readyState || '?',
      });
      setPst(pointer.status);
      setInitStatus(null);
    }

    init().catch((e) => {
      if (cancelled) return;
      console.error('[CamioPointerPanel] init failed:', e);
      if (e?.name === 'NotAllowedError') announceRef.current?.(PROMPTS['camera.denied'], { assertive: true });
      setInitStatus(/no frames/i.test(e?.message || '')
        ? 'Camera opened but sent no frames — close other apps using it (e.g. the Camera app), then Retry.'
        : `Camera error: ${e?.name === 'NotAllowedError' ? 'permission denied' : e?.message}`);
    });

    return () => {
      cancelled = true;
      pointer.dispose();
      if (pointerRef.current === pointer) pointerRef.current = null;
      video?.srcObject?.getTracks?.().forEach((t) => t.stop());
      if (video) video.srcObject = null;
      setPst(null);
      lastUvRef.current = null;
      onUvRef.current?.(null);
    };
  }, [attempt]);

  // Per animation frame: the fingertip → onUv, the library's debug overlay,
  // and the pin view.
  useEffect(() => {
    let raf = 0, n = 0, lastRectKey = '';
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const p = pointerRef.current;
      let uv = null;
      if (p?.running) {
        const core = p.core;
        if (core.currentPoint) uv = uvFromPose(p.pose, core.view.tip, core.currentGrid);
        if (debugRef.current) p.drawDebug(debugRef.current);
        if (++n % 15 === 0) {
          const step = core.lastTrackStep;
          setTrackInfo((prev) => (step && (prev?.found !== step.found || prev?.visible !== step.visible)
            ? { found: step.found, visible: step.visible } : prev));
        }
      }
      emitUv(uv);

      const registered = !!p?.registration;
      const key = `${registered}|${avatarPinRef.current}|${fingerPinRef.current}|${pagesLabelRef.current}|${uv ? `${uv.u.toFixed(3)},${uv.v.toFixed(3)}` : ''}`;
      if (key !== lastRectKey) {
        lastRectKey = key;
        drawPinView(rectRef.current, {
          registered, uv, avatarPin: avatarPinRef.current, fingerPin: fingerPinRef.current, pagesLabel: pagesLabelRef.current,
        });
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  const status = initStatus ?? (pst ? statusText(pst) : 'Initializing…');
  const progress = pst?.phase === 'corners'
    ? ` (${pst.cornersLocked}/4 — ${CORNER_PROMPTS[Math.min(pst.cornersLocked, 3)]} pin)`
    : '';
  const gestureHint = pst && pst.gesture !== 'none' && pst.gesture !== 'pointing'
    ? ({ exploring: 'hand, not pointing', open: 'open hand', tooMany: 'two hands on one side' })[pst.gesture]
    : null;

  return (
    <>
      {/* NOT display:none — a hidden video element can be suspended by the
          browser so videoWidth stays 0 and no frames ever reach the library.
          Keep it rendered but effectively invisible. */}
      <video
        ref={videoRef}
        muted
        playsInline
        autoPlay
        style={{
          position: 'absolute', top: 0, left: 0,
          width: 2, height: 2, opacity: 0.01,
          pointerEvents: 'none', zIndex: 0,
        }}
      />

      <div className="tactile-controls-panel">
        {leadingControls}
        {/Camera error|no frames/.test(status) && (
          <button
            type="button"
            className="tactile-fix-btn"
            onClick={() => { setInitStatus('Retrying…'); setAttempt((a) => a + 1); }}
          >
            ⟳ Retry camera
          </button>
        )}
        <button type="button" className="tactile-fix-btn" onClick={startCapture}>
          {phase === 'ready' ? '↻ Re-register corners [ r ]' : '🎯 Register corners [ r ]'}
        </button>
        <button type="button" className="tactile-fix-btn" onClick={startAutoFind}>
          🔎 Auto-find pad [ a ]
        </button>
        <button
          type="button"
          className={`tactile-fix-btn ${isFixed ? 'fixed' : ''}`}
          onClick={toggleFixed}
          disabled={phase !== 'ready'}
          title={phase === 'ready'
            ? 'Freeze the current pose (press ; )'
            : 'Register the DOT Pad first — then Fix freezes the pose'}
        >
          {isFixed ? '🔓 Unfix [ ; ]' : '🔒 Fix [ ; ]'}
        </button>
      </div>

      <div className="tactile-debug-panel">
        <div className="tactile-debug-header">
          <span>
            camio-pointer · {status}{progress}
            {camInfo ? ` · ${camInfo.w}×${camInfo.h} ${camInfo.state}` : ' · no camera yet'}
            {pst?.phase === 'ready' ? <>&nbsp;·&nbsp;tracking: {pst.tracking}</> : null}
            {trackInfo ? <>&nbsp;·&nbsp;pins: {trackInfo.found}/{trackInfo.visible}</> : null}
            {gestureHint ? <>&nbsp;·&nbsp;<strong>{gestureHint}</strong></> : null}
          </span>
          <button
            type="button"
            className={`tactile-debug-fix-btn ${isFixed ? 'fixed' : ''}`}
            onClick={toggleFixed}
            title="Freeze the current pose (press ; )"
          >
            {isFixed ? 'Unfix' : 'Fix'}
          </button>
        </div>
        {/* The library's drawDebug overlay: camera frame, pin field, tracker pins, fingertip. */}
        <canvas ref={debugRef} width={320} className="tactile-debug-canvas" />
      </div>

      {/* The pin grid (no camera warp — that needed OpenCV): the mirrored
          avatar (blue) and the finger (yellow). */}
      {showRectPanel && (
        <div className="tactile-rect-panel">
          <div className="tactile-debug-header">
            <span>
              pin view · pin grid 60×40
              {fingerPin ? ` · finger ${fingerPin[0]},${fingerPin[1]}` : ''}
              {avatarPin ? ` · avatar ${avatarPin[0]},${avatarPin[1]}` : ''}
              {pagesLabel ? ` · ${pagesLabel}` : ''}
            </span>
          </div>
          <canvas ref={rectRef} className="tactile-debug-canvas" />
        </div>
      )}

      {!status.startsWith('Tracking') && (
        <div className="tactile-status-hud">{status}{progress}</div>
      )}
    </>
  );
}

/** The 60 × 40 pins (2-pin band orange), avatar pin blue, finger pin yellow, raw fingertip ring. */
function drawPinView(canvas, { registered, uv, avatarPin, fingerPin, pagesLabel }) {
  if (!canvas) return;
  const S = 8, M = 12;
  const W = PIN_COLS * S + 2 * M, H = PIN_ROWS * S + 2 * M + 14;
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const ctx = canvas.getContext('2d');
  const pinXY = (i, j) => [M + (i + 0.5) * S, M + 14 + (j + 0.5) * S];
  ctx.fillStyle = '#0f172a'; ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < PIN_COLS; i++) {
    for (let j = 0; j < PIN_ROWS; j++) {
      const inBand = i < BAND || j < BAND || i > PIN_COLS - 1 - BAND || j > PIN_ROWS - 1 - BAND;
      const [x, y] = pinXY(i, j);
      ctx.fillStyle = inBand ? 'rgba(249,115,22,0.9)' : 'rgba(239,68,68,0.9)';
      ctx.fillRect(x - 1, y - 1, 2, 2);
    }
  }
  const pinBox = (p, fill, stroke) => {
    const [x, y] = pinXY(p[0], p[1]);
    ctx.fillStyle = fill; ctx.strokeStyle = stroke; ctx.lineWidth = 1.5;
    ctx.fillRect(x - S / 2, y - S / 2, S, S);
    ctx.strokeRect(x - S / 2, y - S / 2, S, S);
  };
  if (avatarPin && avatarPin[0] >= 0 && avatarPin[0] < PIN_COLS && avatarPin[1] >= 0 && avatarPin[1] < PIN_ROWS) {
    pinBox(avatarPin, 'rgba(59,130,246,0.6)', '#bfdbfe');
  }
  if (fingerPin) pinBox(fingerPin, 'rgba(250,204,21,0.6)', '#000');
  if (uv) {
    const [x, y] = pinXY(uv.u * (PIN_COLS - 1), uv.v * (PIN_ROWS - 1));
    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(250,204,21,0.95)'; ctx.lineWidth = 1.5; ctx.stroke();
  }
  ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'left';
  const label = registered ? `DOT Pad 60×40 ${pagesLabel || ''}` : 'press R (corners) or A (auto-find)';
  ctx.fillStyle = '#e2e8f0'; ctx.fillText(label, M, 16);
}
