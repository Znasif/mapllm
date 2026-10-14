import { useEffect, useRef, useState } from 'react';
import {
  MEDIAPIPE_VERSION, OPENCV_VERSION, PROMPTS, createCamioPointer,
} from './vendor/camio/CamioPointer-0.2.0.js';
import { openCameraStream } from './cameraDevices';
import { CORNER_PROMPTS } from './lib/cornerRegistration';

// Assets from the CDN. The WASM must match the MediaPipe build bundled into the
// library. OpenCV.js (AKAZE tracking of the sheet, in a worker) is fetched on
// start() because the surface is a rect.
const MEDIAPIPE_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
const HAND_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const OPENCV_URL = `https://cdn.jsdelivr.net/npm/@techstark/opencv-js@${OPENCV_VERSION}/dist/opencv.js`;

// Minimum time between two moves: the library's send gate (the same gate the
// old bridge used, at its 150 ms default). The library also holds 1.5 cells
// (2.5 mm each) of hysteresis and emits a 'point' only when the cell changes.
const MIN_INTERVAL_MS = 150;

const NOOP = () => {};

// Corner-lock beep (a sound cue, not an instruction).
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

/** Short status line from the library's status. */
function statusText(st) {
  switch (st.phase) {
    case 'corners': return `Registering corners (${st.cornersLocked}/4, ${CORNER_PROMPTS[Math.min(st.cornersLocked, 3)]})`;
    case 'handsOff': return 'Lift your hand';
    case 'ready':
      switch (st.tracking) {
        case 'fixed': return 'Ready (fixed)';
        case 'loading': return 'Ready (loading tracker)';
        case 'static': return 'Ready (not following the sheet)';
        case 'occluded': return 'Ready (sheet covered)';
        default: return 'Ready';
      }
    default: return st.registered ? 'Registered' : 'Not registered. Press R.';
  }
}

/**
 * Camera pointer for the printed map: the camio-pointer library
 * (src/vendor/camio) on a `{ kind: 'rect' }` surface.
 *
 * Registration is the library's corner dwell (TL → TR → BR → BL); it then
 * follows the sheet with AKAZE (OpenCV.js in a worker) and emits a 'point'
 * `{ u, v }` when the pointing fingertip changes cell. This component only
 * relays: `onPoint` (the host maps it to the avatar), `onOpenHand`, and the
 * library's prompts to `announce` (the page's live region — nothing here
 * speaks). The controls live in the host's sidebar through `actionsRef`
 * ({ register, toggleFixed, retry }) and `onStatus`; this component renders
 * only the hidden video and the camera debug overlay for a sighted helper.
 * Keys: R register, ; fix (dead while focus is inside the Audiom iframe).
 */
export function CamioPointerPanel({
  onPoint = NOOP, onLeave = NOOP, onOpenHand = NOOP, onStatus, actionsRef, announce = NOOP,
}) {
  const cb = useRef({});
  cb.current = { onPoint, onLeave, onOpenHand, announce };
  const videoRef = useRef(null);
  const debugRef = useRef(null);
  const pointerRef = useRef(null);

  const [initStatus, setInitStatus] = useState('Starting camera'); // until the library runs, or an error
  const [cameraError, setCameraError] = useState(false);
  const [attempt, setAttempt] = useState(0); // bump to retry camera/model init
  const [camInfo, setCamInfo] = useState(null);
  const [pst, setPst] = useState(null); // the library's PointerStatus
  const [cell, setCell] = useState(null); // last 'point' [col, row], for the overlay

  const phase = pst?.phase || 'idle';
  const isFixed = !!pst?.fixed;
  const status = initStatus ?? (pst ? statusText(pst) : 'Starting camera');
  useEffect(() => {
    onStatus?.({ phase, isFixed, text: status, cameraError });
  }, [phase, isFixed, status, cameraError, onStatus]);

  const register = () => pointerRef.current?.registerByCorners();
  const toggleFixed = () => {
    const p = pointerRef.current;
    if (p?.status.registered) p.setFixed(!p.status.fixed);
  };
  const retry = () => { setCameraError(false); setInitStatus('Retrying camera'); setAttempt((a) => a + 1); };

  if (actionsRef) actionsRef.current = { register, toggleFixed, retry };

  // Keyboard: 'r' register by corners, ';' fix (ignored while typing in a field).
  useEffect(() => {
    function onKey(e) {
      if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === ';' || e.code === 'Semicolon') { e.preventDefault(); toggleFixed(); }
      if (e.key === 'r' || e.key === 'R') { e.preventDefault(); register(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Camera + library. The camera is opened here (cameraDevices.js, with the
  // relaxed retry) into a rendered <video> and handed to the library.
  useEffect(() => {
    let cancelled = false;
    const video = videoRef.current;
    const pointer = createCamioPointer({
      surface: { kind: 'rect' },
      wasmBase: MEDIAPIPE_WASM,
      modelUrl: HAND_MODEL_URL,
      opencvUrl: OPENCV_URL,
      video,
      minIntervalMs: MIN_INTERVAL_MS,
    });
    pointerRef.current = pointer;
    const reported = new Set();
    pointer.on('prompt', ({ text }) => cb.current.announce(text));
    pointer.on('point', (p) => { setCell([p.col, p.row]); cb.current.onPoint(p); });
    pointer.on('leave', (e) => { setCell(null); cb.current.onLeave(e); });
    pointer.on('openHand', (e) => cb.current.onOpenHand(e));
    pointer.on('cue', ({ code }) => { if (code === 'lock') beep(); });
    pointer.on('status', (st) => setPst(st));
    pointer.on('error', (e) => {
      if (reported.has(e.code)) return;
      reported.add(e.code);
      console.warn('[CamioPointerPanel]', e.code, e.message);
    });

    async function init() {
      setInitStatus(attempt === 0 ? 'Opening camera' : 'Opening camera (any device)');
      const stream = await openCameraStream({ relaxed: attempt > 0 });
      if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
      video.srcObject = stream;
      await video.play();
      setInitStatus('Loading hand model');
      await pointer.start(); // waits for real frames; throws when none arrive
      if (cancelled) return;
      const track = stream.getVideoTracks()[0];
      setCamInfo({ w: video.videoWidth, h: video.videoHeight, state: track?.readyState || '?' });
      setPst(pointer.status);
      setInitStatus(null);
    }

    init().catch((e) => {
      if (cancelled) return;
      console.error('[CamioPointerPanel] init failed:', e);
      setCameraError(true);
      if (e?.name === 'NotAllowedError') cb.current.announce(PROMPTS['camera.denied'], { assertive: true });
      setInitStatus(/no frames/i.test(e?.message || '')
        ? 'Camera sent no frames. Close other apps using it, then retry.'
        : `Camera error: ${e?.name === 'NotAllowedError' ? 'permission denied' : e?.message}`);
    });

    return () => {
      cancelled = true;
      pointer.dispose();
      if (pointerRef.current === pointer) pointerRef.current = null;
      video?.srcObject?.getTracks?.().forEach((t) => t.stop());
      if (video) video.srcObject = null;
      setPst(null);
      setCell(null);
    };
  }, [attempt]);

  // The library's debug overlay, every animation frame.
  useEffect(() => {
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const p = pointerRef.current;
      if (p?.running && debugRef.current) p.drawDebug(debugRef.current);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

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

      {/* For a sighted helper: the camera frame, the registered sheet and the fingertip. */}
      <div className="tactile-debug-panel" aria-hidden="true">
        <div className="tactile-debug-header">
          <span>
            camera · {status}
            {camInfo ? ` · ${camInfo.w}×${camInfo.h} ${camInfo.state}` : ''}
            {cell ? ` · cell ${cell[0]},${cell[1]}` : ''}
            {gestureHint ? <>&nbsp;·&nbsp;<strong>{gestureHint}</strong></> : null}
          </span>
        </div>
        <canvas ref={debugRef} width={320} className="tactile-debug-canvas" />
      </div>
    </>
  );
}
