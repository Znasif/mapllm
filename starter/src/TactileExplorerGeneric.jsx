import { useEffect, useRef, useState } from 'react';
import cv from '@techstark/opencv-js';
import { openCameraStream } from './cameraDevices';
import { createPointingTracker, pointingHint } from './gestureRecognizer';
import { speak } from './lib/speak';
import { createCornerCapture, CORNER_PROMPTS } from './lib/cornerRegistration';
import {
  DOTPAD_TEMPLATE, applyH, checkPinQuad, homography4, maskPolygons, orderQuad, resolveConfirmTouch, selectDevice,
} from './lib/dotpadTemplate';
import { DOTPAD_GEOMETRY } from './lib/dotpadViewport';

const MEDIAPIPE_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm';
const HAND_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// DOT Pad pin field. Used DIRECTLY — never via surface.acuityGrid (§6.2).
const PIN_COLS = DOTPAD_TEMPLATE.cols;
const PIN_ROWS = DOTPAD_TEMPLATE.rows;
const BAND = DOTPAD_GEOMETRY.o;

// Hands-off windows (§6.3 / §6.4): how long MediaPipe must see no hand, and
// the most we wait before going ahead anyway.
const REF_HANDS_OFF_MS = 400;
const REF_HANDS_OFF_MAX_MS = 4000;
const FIND_HANDS_OFF_MS = 500;
const FIND_HANDS_OFF_MAX_MS = 8000;

function waitForOpenCV() {
  return new Promise((resolve) => {
    if (cv.Mat) { resolve(); return; }
    cv.onRuntimeInitialized = resolve;
  });
}

// One Euro Filter — speed-adaptive low-pass for noisy fingertip tracking.
function makeOneEuroFilter(minCutoff = 1.0, beta = 0.007, dCutoff = 1.0) {
  let xFilt = null, dxFilt = 0, lastT = null;
  const alpha = (cutoff, dt) => { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); };
  return function filter(x, t) {
    if (lastT === null) { xFilt = x; lastT = t; return x; }
    const dt = Math.max((t - lastT) / 1000, 1e-6);
    lastT = t;
    const dx = (x - xFilt) / dt;
    dxFilt = dxFilt + alpha(dCutoff, dt) * (dx - dxFilt);
    const cutoff = minCutoff + beta * Math.abs(dxFilt);
    xFilt = xFilt + alpha(cutoff, dt) * (x - xFilt);
    return xFilt;
  };
}

// ---- accessibility cues ----
// `speak` moved to lib/speak.js in milestone 5c — same cancel-then-speak
// behaviour, now shared with AudiomMap's whats_here. The M-S queue replaces it.
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

const cornerPrompt = (name) => `Point at the ${name} corner pin of the DOT Pad and hold.`;

/**
 * Camera-driven pointer for a DOT Pad (docs/dotpad-camio-design.md §6).
 *
 * Registration, two ways, both ending in the same place:
 *   - **Four corners [R]** (primary): point at the centre of each corner PIN
 *     (TL → TR → BR → BL), dwell-locked by `createCornerCapture`, then
 *     `checkPinQuad` sanity-checks the quad.
 *   - **Auto-find [A]**: hands off, OpenCV finds candidate quads, and
 *     `selectDevice` maps the template (`resources/dotpad_corners.json`) through
 *     the display window. One touch on the top-left pin confirms orientation
 *     when the braille text window was not seen.
 * Either way the AKAZE reference is taken from a HANDS-OFF frame, with the pin
 * field and text window masked out (they change state and hands cover them).
 *
 * Each frame afterwards: live camera → snapshot (AKAZE homography) → (u, v) in
 * the corner-pin square, emitted RAW through `onUv`. Pin quantization, the
 * border band and every avatar move belong to `useDotpadBridge`.
 *
 * Props:
 *  - onUv({u, v} | null)  every frame; null when no pointing hand is registered.
 *  - avatarPin / fingerPin  [x, y] for the rectified panel (blue / yellow).
 *  - pagesLabel             shown on the rectified panel.
 *  - showRectPanel          the rectified pin-grid view.
 *  - actionsRef             receives { register, autoFind, toggleFixed } so the
 *                           sidebar buttons can drive this component.
 *  - onRegistrationChange({ phase, isFixed })
 *  - leadingControls        rendered first in the on-map control strip — the
 *                           host puts Sync there so it is the first focusable
 *                           element after the iframe (R9).
 */
export function TactileExplorerGeneric({
  onUv, avatarPin = null, fingerPin = null, pagesLabel = '', showRectPanel = true,
  actionsRef, onRegistrationChange, leadingControls = null,
}) {
  const videoRef = useRef(null);
  const offRef = useRef(document.createElement('canvas')); // clean frame for AKAZE
  const debugRef = useRef(null);
  const rectRef = useRef(null);   // rectified pin-grid view
  const rectOffRef = useRef(document.createElement('canvas')); // warp target
  const runningRef = useRef(false);

  const onUvRef = useRef(onUv);
  useEffect(() => { onUvRef.current = onUv; }, [onUv]);
  const avatarPinRef = useRef(avatarPin);
  useEffect(() => { avatarPinRef.current = avatarPin; }, [avatarPin]);
  const fingerPinRef = useRef(fingerPin);
  useEffect(() => { fingerPinRef.current = fingerPin; }, [fingerPin]);
  const pagesLabelRef = useRef(pagesLabel);
  useEffect(() => { pagesLabelRef.current = pagesLabel; }, [pagesLabel]);

  // 'idle' | 'capturing' | 'handsoff' | 'autofind' | 'confirm' | 'ready'
  const phaseRef = useRef('idle');
  // Four-corner dwell state machine, shared with the OSM build and checked
  // headlessly by scripts/test_cornerRegistration.mjs.
  const captureRef = useRef(createCornerCapture());
  // Auto-find's one-touch orientation confirm: first corner only.
  const confirmRef = useRef(createCornerCapture());
  // The registered corner-pin centres (snapshot px, TL,TR,BR,BL), and the ones
  // waiting for a hands-off frame (or a confirm touch) before they count.
  const cornersRef = useRef(null);
  const pendingRef = useRef(null);
  const handsOffRef = useRef(null); // { startedAt, zeroSince, minMs, maxMs, then }
  const isFixedRef = useRef(false);

  const s = useRef({
    hl: null, sift: null, bf: null,
    kpTpl: null, descTpl: null,          // features of the hands-off snapshot
    Hfwd: null, Hinv: null, HsnapToUv: null,
    bestInliers: 0, bestInliersAt: 0, tick: 0,
    oefX: makeOneEuroFilter(), oefY: makeOneEuroFilter(),
    pointTracker: null, wasPointing: false, lastHint: undefined,
    lastUv: null,
  });

  const [status, setStatus] = useState('Initializing…');
  const [gestureHint, setGestureHint] = useState(null);
  const [attempt, setAttempt] = useState(0); // bump to retry camera/model init
  const [camInfo, setCamInfo] = useState(null);
  const [phase, setPhaseState] = useState('idle');
  const [debugInfo, setDebugInfo] = useState({ good: 0, inliers: 0, refKp: 0 });
  const [isFixed, setIsFixed] = useState(false);

  const setPhase = (p) => { phaseRef.current = p; setPhaseState(p); };

  useEffect(() => { onRegistrationChange?.({ phase, isFixed }); }, [phase, isFixed, onRegistrationChange]);

  const clearTracking = () => {
    const st = s.current;
    st.HsnapToUv?.delete(); st.HsnapToUv = null;
    st.Hfwd?.delete(); st.Hinv?.delete();
    st.Hfwd = st.Hinv = null;
    st.bestInliers = 0;
    cornersRef.current = null;
    pendingRef.current = null;
    isFixedRef.current = false; setIsFixed(false);
  };

  const startCapture = () => {
    captureRef.current.reset();
    clearTracking();
    setPhase('capturing');
    setStatus('Registering DOT Pad corners');
    speak(cornerPrompt(CORNER_PROMPTS[0]));
  };

  const startAutoFind = () => {
    clearTracking();
    handsOffRef.current = {
      startedAt: performance.now(), zeroSince: null,
      minMs: FIND_HANDS_OFF_MS, maxMs: FIND_HANDS_OFF_MAX_MS, then: 'find',
    };
    setPhase('autofind');
    setStatus('Auto-find: hands off the pad');
    speak('Take your hands off the DOT Pad.');
  };

  const toggleFixed = () => {
    const next = !isFixedRef.current;
    isFixedRef.current = next; setIsFixed(next);
    if (s.current.Hfwd && !s.current.Hfwd.empty()) setStatus(next ? 'Tracking (Fixed)' : 'Tracking');
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

  useEffect(() => {
    const st = s.current;
    let cancelled = false;

    /**
     * Take the AKAZE reference from the CURRENT frame — called only once the
     * hands are off — with the pin field and braille text window masked out
     * (§6.3). The corners stay in snapshot pixels: the camera is static across
     * the hands-off gap.
     */
    function captureReference(corners) {
      const off = offRef.current;
      const snap = cv.imread(off);
      const gray = new cv.Mat();
      cv.cvtColor(snap, gray, cv.COLOR_RGBA2GRAY); snap.delete();

      const mask = new cv.Mat(gray.rows, gray.cols, cv.CV_8UC1, new cv.Scalar(255));
      try {
        const { pinField, textWindow } = maskPolygons(homography4(DOTPAD_TEMPLATE.pinCorners, corners));
        for (const poly of [pinField, textWindow]) {
          const pts = cv.matFromArray(4, 1, cv.CV_32SC2, poly.flat().map((n) => Math.round(n)));
          cv.fillConvexPoly(mask, pts, new cv.Scalar(0));
          pts.delete();
        }
      } catch (e) {
        console.warn('[TactileExplorerGeneric] reference mask skipped:', e);
      }

      st.kpTpl?.delete(); st.descTpl?.delete();
      st.kpTpl = new cv.KeyPointVector();
      st.descTpl = new cv.Mat();
      st.sift.detectAndCompute(gray, mask, st.kpTpl, st.descTpl);
      mask.delete(); gray.delete();

      const c = corners;
      const srcPx = cv.matFromArray(4, 1, cv.CV_32FC2,
        [c[0][0], c[0][1], c[1][0], c[1][1], c[2][0], c[2][1], c[3][0], c[3][1]]);
      const dstUv = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, 1, 0, 1, 1, 0, 1]);
      st.HsnapToUv?.delete();
      // (u, v) = (0,0)…(1,1) at the corner-pin CENTRES (D5).
      st.HsnapToUv = cv.getPerspectiveTransform(srcPx, dstUv);
      srcPx.delete(); dstUv.delete();

      // The snapshot IS the current frame, so snapshot->camera is the identity
      // right now. Seed it so tracking works the instant registration finishes,
      // rather than waiting for AKAZE to score 8+ inliers — which may never
      // happen on a feature-poor device, leaving the tool apparently dead.
      // NB: built with matFromArray, not cv.Mat.eye — that returns a MatExpr,
      // whose support in OpenCV.js is partial and can throw when handed to
      // perspectiveTransform (which would kill the render loop mid-registration).
      const I = () => cv.matFromArray(3, 3, cv.CV_64F, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
      st.Hfwd?.delete(); st.Hinv?.delete();
      st.Hfwd = I();
      st.Hinv = I();
      st.bestInliers = 0; st.bestInliersAt = 0;
      cornersRef.current = corners.map((p) => [...p]);
      setDebugInfo((d) => ({ ...d, refKp: st.kpTpl.size() }));
    }

    /**
     * §6.4 step 1: candidate quads from Canny edges and Otsu in both polarities
     * (the real pad's colours are unknown). Kept small here — the text window
     * is well under 1% of a typical frame — and `selectDevice` applies the 1%
     * floor to display-window hypotheses.
     */
    function detectQuads() {
      const off = offRef.current;
      const frame = cv.imread(off);
      const gray = new cv.Mat();
      cv.cvtColor(frame, gray, cv.COLOR_RGBA2GRAY); frame.delete();
      const blur = new cv.Mat();
      cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
      gray.delete();
      const minArea = 0.0005 * off.width * off.height;
      const quads = [];

      const collect = (bin) => {
        const contours = new cv.MatVector();
        const hier = new cv.Mat();
        cv.findContours(bin, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
        for (let i = 0; i < contours.size() && quads.length < 80; i++) {
          const cnt = contours.get(i);
          if (cv.contourArea(cnt) >= minArea) {
            const approx = new cv.Mat();
            cv.approxPolyDP(cnt, approx, 0.02 * cv.arcLength(cnt, true), true);
            if (approx.rows === 4 && cv.isContourConvex(approx)) {
              const d = approx.data32S;
              quads.push(orderQuad([[d[0], d[1]], [d[2], d[3]], [d[4], d[5]], [d[6], d[7]]]));
            }
            approx.delete();
          }
          cnt.delete();
        }
        contours.delete(); hier.delete();
      };

      const edges = new cv.Mat();
      cv.Canny(blur, edges, 40, 120);
      const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
      cv.dilate(edges, edges, kernel);
      kernel.delete();
      collect(edges);
      edges.delete();

      const bin = new cv.Mat();
      cv.threshold(blur, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      collect(bin);
      cv.threshold(blur, bin, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
      collect(bin);
      bin.delete(); blur.delete();
      return quads;
    }

    function beginHandsOff(corners, now) {
      pendingRef.current = corners;
      handsOffRef.current = {
        startedAt: now, zeroSince: null, minMs: REF_HANDS_OFF_MS, maxMs: REF_HANDS_OFF_MAX_MS, then: 'reference',
      };
      setPhase('handsoff');
      setStatus('Lift your hand…');
    }

    /** True once MediaPipe has seen no hand for `minMs`, or `maxMs` has passed. */
    function handsOffElapsed(handCount, now) {
      const h = handsOffRef.current;
      if (!h) return true;
      if (handCount === 0) h.zeroSince ??= now;
      else h.zeroSince = null;
      return (h.zeroSince !== null && now - h.zeroSince >= h.minMs) || now - h.startedAt >= h.maxMs;
    }

    function finishReference() {
      captureReference(pendingRef.current);
      pendingRef.current = null;
      handsOffRef.current = null;
      setPhase('ready');
      setStatus('Tracking');
      speak('DOT Pad registered. Point at the pins.');
    }

    function runAutoFind() {
      handsOffRef.current = null;
      const off = offRef.current;
      let found = null;
      try {
        found = selectDevice(detectQuads(), { width: off.width, height: off.height });
      } catch (e) {
        console.error('[TactileExplorerGeneric] auto-find failed:', e);
      }
      if (!found) {
        setPhase('idle');
        setStatus('DOT Pad not found — press R to register by corners');
        speak("I couldn't find the DOT Pad. Press R to register it by its corners.");
        return;
      }
      if (found.needsConfirm) {
        pendingRef.current = found.pinCorners;
        confirmRef.current.reset();
        setPhase('confirm');
        setStatus('Found — touch the top-left pin to confirm');
        speak('Found the DOT Pad. Touch the top-left pin and hold.');
        return;
      }
      // Text window seen: orientation is settled and the hands are already off.
      pendingRef.current = found.pinCorners;
      finishReference();
    }

    async function init() {
      setStatus('Loading hand model…');
      const { HandLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
      const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM);
      // numHands: 2 — with 1, a second pointing hand is invisible and the
      // ambiguity can never be detected. See gestureRecognizer.js.
      st.hl = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate: 'GPU' },
        runningMode: 'VIDEO', numHands: 2,
      });
      if (cancelled) return;

      setStatus('Loading OpenCV…');
      await waitForOpenCV();
      if (cancelled) return;

      st.sift = new cv.AKAZE();
      st.bf = new cv.BFMatcher(cv.NORM_HAMMING, false);

      // Camera choice is Chrome's — its permission prompt lists every input
      // with a preview. facingMode is applied on mobile only so the desktop
      // prompt is not biased toward a virtual/headset camera. Retries fall back
      // to plain `video: true`, which succeeds on desktops where the
      // constrained request can return a device that never produces frames.
      setStatus(attempt === 0 ? 'Opening camera…' : 'Opening camera (any device)…');
      const stream = await openCameraStream({ relaxed: attempt > 0 });
      if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
      const video = videoRef.current;
      video.srcObject = stream;
      await video.play();

      // A camera can open yet deliver no frames (element suspended, or the
      // device is held by another app). Wait for real dimensions before
      // claiming success, otherwise the render loop silently no-ops forever.
      const gotFrames = await new Promise((resolve) => {
        const t0 = performance.now();
        const check = () => {
          if (cancelled) { resolve(false); return; }
          if (video.videoWidth > 0 && video.videoHeight > 0) { resolve(true); return; }
          if (performance.now() - t0 > 6000) { resolve(false); return; }
          requestAnimationFrame(check);
        };
        check();
      });
      if (cancelled) return;

      const track = stream.getVideoTracks()[0];
      setCamInfo({
        w: video.videoWidth, h: video.videoHeight,
        label: track?.label || 'camera', state: track?.readyState || '?',
      });

      if (!gotFrames) {
        setStatus('Camera opened but sent no frames — close other apps using it (e.g. the Camera app), then Retry.');
        return;
      }

      setStatus('Ready — press R (corners) or A (auto-find).');
      runningRef.current = true;
      requestAnimationFrame(loop);
    }

    // Any throw inside a requestAnimationFrame callback silently ends the chain,
    // which looks exactly like "registration stopped working". Keep the loop
    // alive and surface the error instead of dying quietly.
    function loop() {
      try {
        loopBody();
      } catch (e) {
        console.error('[TactileExplorerGeneric] frame failed:', e);
        setStatus(`Frame error: ${e.message} — press r to re-register`);
        requestAnimationFrame(loop);
      }
    }

    /** Emit the fingertip (u, v), or null. The bridge ignores repeats of null cheaply. */
    function emitUv(uv) {
      st.lastUv = uv;
      onUvRef.current?.(uv);
    }

    function loopBody() {
      if (!runningRef.current || cancelled) return;
      const video = videoRef.current;
      if (!video) { requestAnimationFrame(loop); return; }
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) { requestAnimationFrame(loop); return; }

      const off = offRef.current;
      off.width = vw; off.height = vh;
      off.getContext('2d').drawImage(video, 0, 0);

      const now = performance.now();
      const result = st.hl.detectForVideo(video, now);
      const handCount = result?.landmarks?.length ?? 0;

      // Require an actual pointing gesture, as camio-explorer does. Taking
      // landmarks[0][8] unconditionally meant a flat palm, a fist, or a hand
      // reaching across the pad all produced a confident cursor — and during
      // corner capture could lock a dwell that was never a point.
      st.pointTracker ??= createPointingTracker();
      const gesture = st.pointTracker.update(result, now);

      let fx = null, fy = null;
      if (gesture.pointing && gesture.tip) {
        // Re-seed the smoothing filters on re-acquisition, otherwise the One
        // Euro state carries across the gap and the cursor slides in from
        // wherever the hand last was.
        if (!st.wasPointing) {
          st.oefX = makeOneEuroFilter();
          st.oefY = makeOneEuroFilter();
        }
        fx = st.oefX(gesture.tip.x * vw, now);
        fy = st.oefY(gesture.tip.y * vh, now);
      }
      st.wasPointing = gesture.pointing;

      // Speak only on transitions, and only the ambiguous case — announcing
      // every dropped frame would be unusable.
      const hint = pointingHint(gesture);
      if (hint !== st.lastHint) {
        st.lastHint = hint;
        setGestureHint(hint);
        if (gesture.tooManyHandsPointing) speak('Point with only one hand.');
      }

      const ph = phaseRef.current;

      // ── Four-corner capture ─────────────────────────────────────────
      if (ph === 'capturing') {
        const cap = captureRef.current.update(fx, fy, now);
        if (cap.locked) {
          beep();
          if (cap.complete) {
            const check = checkPinQuad(cap.corners);
            if (!check.ok) {
              captureRef.current.reset();
              setStatus(`Corners rejected (${check.reason}) — again`);
              speak(`Those corners don't look like the pin area — let's try again. ${cornerPrompt(CORNER_PROMPTS[0])}`);
            } else {
              beginHandsOff(cap.corners.map((p) => [...p]), now);
              speak('Registered. Lift your hand for a moment.');
            }
          } else {
            speak(cornerPrompt(cap.nextPrompt));
          }
        }
        if (st.lastUv !== null) emitUv(null);
        drawDebug(fx, fy);
        drawRectified(fx, fy);
        requestAnimationFrame(loop);
        return;
      }

      // ── Hands-off gaps: the reference frame, or the auto-find frame ──
      if (ph === 'handsoff' || ph === 'autofind') {
        if (handsOffElapsed(handCount, now)) {
          if (handsOffRef.current?.then === 'find') runAutoFind();
          else finishReference();
        }
        if (st.lastUv !== null) emitUv(null);
        drawDebug(fx, fy);
        drawRectified(fx, fy);
        requestAnimationFrame(loop);
        return;
      }

      // ── Auto-find orientation confirm: one dwell on the top-left pin ──
      if (ph === 'confirm') {
        const cap = confirmRef.current.update(fx, fy, now);
        if (cap.locked) {
          beep();
          const resolved = resolveConfirmTouch(pendingRef.current, cap.corners[0]);
          if (!resolved) {
            speak("That wasn't near a corner pin. Let's register by the corners instead.");
            startCapture();
          } else {
            beginHandsOff(resolved, now);
            speak('Confirmed. Lift your hand for a moment.');
          }
        }
        if (st.lastUv !== null) emitUv(null);
        drawDebug(fx, fy);
        drawRectified(fx, fy);
        requestAnimationFrame(loop);
        return;
      }

      // ── AKAZE match (every 6 frames) while tracking ────────────────
      st.tick += 1;
      if (ph === 'ready' && !isFixedRef.current && st.tick % 6 === 0 && st.descTpl?.rows > 0) {
        const frameMat = cv.imread(off);
        const frameGray = new cv.Mat();
        cv.cvtColor(frameMat, frameGray, cv.COLOR_RGBA2GRAY); frameMat.delete();
        const kpFrame = new cv.KeyPointVector();
        const descFrame = new cv.Mat();
        // Live frames stay unmasked; RANSAC handles the pins and the hand.
        const mask = new cv.Mat();
        st.sift.detectAndCompute(frameGray, mask, kpFrame, descFrame);
        mask.delete(); frameGray.delete();

        if (descFrame.rows >= 4) {
          const knn = new cv.DMatchVectorVector();
          st.bf.knnMatch(st.descTpl, descFrame, knn, 2);
          const good = [];
          for (let i = 0; i < knn.size(); i++) {
            const pair = knn.get(i);
            if (pair.size() >= 2 && pair.get(0).distance < 0.75 * pair.get(1).distance) {
              good.push({ q: pair.get(0).queryIdx, t: pair.get(0).trainIdx });
            }
          }
          knn.delete();

          if (good.length >= 8) {
            const srcArr = good.flatMap((m) => { const p = st.kpTpl.get(m.q).pt; return [p.x, p.y]; });
            const dstArr = good.flatMap((m) => { const p = kpFrame.get(m.t).pt; return [p.x, p.y]; });
            const srcPts = cv.matFromArray(good.length, 1, cv.CV_32FC2, srcArr);
            const dstPts = cv.matFromArray(good.length, 1, cv.CV_32FC2, dstArr);
            const inlierMask = new cv.Mat();
            const Hfwd = cv.findHomography(srcPts, dstPts, cv.RANSAC, 8.0, inlierMask);
            const inliers = Hfwd && !Hfwd.empty() ? cv.countNonZero(inlierMask) : 0;
            srcPts.delete(); dstPts.delete(); inlierMask.delete();

            setDebugInfo((d) => ({ ...d, good: good.length, inliers }));
            const stale = (now - st.bestInliersAt) > 7000;
            if (stale) st.bestInliers = 0;
            if (inliers >= 8 && inliers >= st.bestInliers) {
              st.Hfwd?.delete(); st.Hinv?.delete();
              st.Hfwd = Hfwd;
              st.Hinv = new cv.Mat();
              cv.invert(Hfwd, st.Hinv, cv.DECOMP_SVD);
              st.bestInliers = inliers; st.bestInliersAt = now;
            } else if (Hfwd) { Hfwd.delete(); }
          }
        }
        descFrame.delete(); kpFrame.delete();
      }

      // ── Fingertip -> snapshot -> (u, v), raw ───────────────────────
      let uv = null;
      if (ph === 'ready' && fx !== null && st.Hinv && !st.Hinv.empty() && st.HsnapToUv) {
        const p0 = cv.matFromArray(1, 1, cv.CV_32FC2, [fx, fy]);
        const p1 = new cv.Mat();
        cv.perspectiveTransform(p0, p1, st.Hinv);
        const p2 = new cv.Mat();
        cv.perspectiveTransform(p1, p2, st.HsnapToUv);
        const u = p2.data32F[0], v = p2.data32F[1];
        p0.delete(); p1.delete(); p2.delete();
        if (Number.isFinite(u) && Number.isFinite(v)) uv = { u, v };
      }
      if (uv || st.lastUv !== null) emitUv(uv);

      drawDebug(fx, fy);
      drawRectified(fx, fy);
      requestAnimationFrame(loop);
    }

    /**
     * Reverse projection onto the DOT Pad's own pin grid: the camera view is
     * warped so the four corner-pin centres land on the corner pin centres of a
     * 60 × 40 grid. Then the pins are drawn over it — border band shaded,
     * finger pin yellow, the mirrored avatar pin blue. Compare it with
     * Audiom's TactilePinView (Display options) during development.
     */
    function drawRectified(fx, fy) {
      const panel = rectRef.current;
      if (!panel) return;
      const CELL = 6;
      const W = PIN_COLS * CELL, H = PIN_ROWS * CELL;
      const off = rectOffRef.current;
      if (off.width !== W || off.height !== H) { off.width = W; off.height = H; }

      const corners = cornersRef.current;
      const registered = corners && st.Hfwd && !st.Hfwd.empty() && st.HsnapToUv;
      if (registered) {
        const c = corners;
        const snapPts = cv.matFromArray(4, 1, cv.CV_32FC2,
          [c[0][0], c[0][1], c[1][0], c[1][1], c[2][0], c[2][1], c[3][0], c[3][1]]);
        const camPts = new cv.Mat();
        cv.perspectiveTransform(snapPts, camPts, st.Hfwd); // snapshot -> live camera
        snapPts.delete();
        const lo = CELL / 2, hiX = W - CELL / 2, hiY = H - CELL / 2;
        const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [lo, lo, hiX, lo, hiX, hiY, lo, hiY]);
        const Hcr = cv.getPerspectiveTransform(camPts, dstPts);
        camPts.delete(); dstPts.delete();
        const frame = cv.imread(offRef.current);
        const warped = new cv.Mat();
        cv.warpPerspective(frame, warped, Hcr, new cv.Size(W, H), cv.INTER_LINEAR,
          cv.BORDER_CONSTANT, new cv.Scalar(15, 23, 42, 255));
        frame.delete(); Hcr.delete();
        cv.imshow(off, warped);
        warped.delete();
      } else {
        const c0 = off.getContext('2d');
        c0.fillStyle = '#0f172a'; c0.fillRect(0, 0, W, H);
      }

      if (panel.width !== W || panel.height !== H) { panel.width = W; panel.height = H; }
      const ctx = panel.getContext('2d');
      ctx.drawImage(off, 0, 0);
      ctx.fillStyle = 'rgba(15,23,42,0.35)'; ctx.fillRect(0, 0, W, H);

      // Border band: the 2-pin frame Audiom pages from — never a send target.
      ctx.fillStyle = 'rgba(234,88,12,0.28)';
      ctx.fillRect(0, 0, W, BAND * CELL);
      ctx.fillRect(0, H - BAND * CELL, W, BAND * CELL);
      ctx.fillRect(0, BAND * CELL, BAND * CELL, H - 2 * BAND * CELL);
      ctx.fillRect(W - BAND * CELL, BAND * CELL, BAND * CELL, H - 2 * BAND * CELL);

      ctx.fillStyle = 'rgba(203,213,225,0.55)';
      for (let x = 0; x < PIN_COLS; x++) {
        for (let y = 0; y < PIN_ROWS; y++) ctx.fillRect(x * CELL + CELL / 2 - 0.75, y * CELL + CELL / 2 - 0.75, 1.5, 1.5);
      }

      const pinBox = (p, fill, stroke) => {
        ctx.fillStyle = fill; ctx.strokeStyle = stroke; ctx.lineWidth = 1.5;
        ctx.fillRect(p[0] * CELL, p[1] * CELL, CELL, CELL);
        ctx.strokeRect(p[0] * CELL + 0.5, p[1] * CELL + 0.5, CELL - 1, CELL - 1);
      };
      const ap = avatarPinRef.current;
      if (ap && ap[0] >= 0 && ap[0] < PIN_COLS && ap[1] >= 0 && ap[1] < PIN_ROWS) pinBox(ap, 'rgba(59,130,246,0.85)', '#bfdbfe');
      const fp = fingerPinRef.current;
      if (fp) pinBox(fp, 'rgba(250,204,21,0.8)', '#000');

      // The raw fingertip, continuous, for judging jitter against the pitch.
      const uv = st.lastUv;
      if (uv) {
        ctx.beginPath();
        ctx.arc(uv.u * (PIN_COLS - 1) * CELL + CELL / 2, uv.v * (PIN_ROWS - 1) * CELL + CELL / 2, 4, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(250,204,21,0.95)'; ctx.lineWidth = 1.5; ctx.stroke();
      }

      ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'left';
      const label = registered ? `DOT Pad 60×40 ${pagesLabelRef.current || ''}` : 'press R (corners) or A (auto-find)';
      ctx.fillStyle = 'rgba(15,23,42,0.8)'; ctx.fillRect(1, 1, ctx.measureText(label).width + 8, 13);
      ctx.fillStyle = '#e2e8f0'; ctx.fillText(label, 5, 11);
    }

    // Live camera thumbnail with captured / predicted corners + fingertip.
    function drawDebug(fx, fy) {
      const dbg = debugRef.current;
      if (!dbg) return;
      const off = offRef.current;
      const vw = off.width, vh = off.height;
      if (!vw || !vh) return;
      const dw = 320, dh = Math.round((dw * vh) / vw);
      dbg.width = dw; dbg.height = dh;
      const ctx = dbg.getContext('2d');
      const sx = dw / vw, sy = dh / vh;
      ctx.drawImage(off, 0, 0, dw, dh);

      const ph = phaseRef.current;
      const dots = ph === 'capturing' ? captureRef.current.corners
        : (ph === 'confirm' || ph === 'handsoff') ? (pendingRef.current || []) : [];
      dots.forEach(([x, y], i) => {
        ctx.beginPath(); ctx.arc(x * sx, y * sy, i === 0 && ph === 'confirm' ? 5 : 3, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? 'rgba(59,130,246,0.95)' : 'rgba(250,204,21,0.9)'; ctx.fill();
      });

      // The live homography, made visible: pin-space and template quads go
      // snapshot → camera through Hfwd, so a bad match shows up as a box that
      // no longer hugs the pad. Green = pin field (outer pin edges), orange
      // dashed = the inner 56 × 36 send area, cyan = bezel + text line.
      const corners = cornersRef.current;
      if (ph === 'ready' && corners && st.Hfwd && !st.Hfwd.empty()) {
        const d = st.Hfwd.data64F;
        const Hf = [[d[0], d[1], d[2]], [d[3], d[4], d[5]], [d[6], d[7], d[8]]];
        const last = [PIN_COLS - 1, PIN_ROWS - 1];
        let Hpin = null, Htpl = null;
        try {
          Hpin = homography4([[0, 0], [last[0], 0], last, [0, last[1]]], corners);
          Htpl = homography4(DOTPAD_TEMPLATE.pinCorners, corners);
        } catch { /* degenerate corners — skip the overlay, keep the fingertip */ }
        if (Hpin && Htpl) drawOutline(Hf, Hpin, Htpl);
      }
      if (fx !== null) {
        ctx.beginPath(); ctx.arc(fx * sx, fy * sy, 6, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(250,204,21,0.9)'; ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
        ctx.fill(); ctx.stroke();
      }

      function drawOutline(Hf, Hpin, Htpl) {
        const last = [PIN_COLS - 1, PIN_ROWS - 1];
        const toCam = (H, q) => q.map((p) => applyH(Hf, applyH(H, p))).map(([x, y]) => [x * sx, y * sy]);
        const quad = (q, stroke, width, dash = []) => {
          ctx.beginPath();
          q.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
          ctx.closePath();
          ctx.setLineDash(dash); ctx.strokeStyle = stroke; ctx.lineWidth = width; ctx.stroke();
          ctx.setLineDash([]);
        };
        const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
        quad(toCam(Htpl, DOTPAD_TEMPLATE.bezel), 'rgba(34,211,238,0.7)', 1);
        quad(toCam(Htpl, DOTPAD_TEMPLATE.textWindow), 'rgba(34,211,238,0.7)', 1);
        quad(toCam(Hpin, rect(-0.5, -0.5, last[0] + 0.5, last[1] + 0.5)), 'rgba(34,197,94,0.95)', 2);
        quad(toCam(Hpin, rect(BAND - 0.5, BAND - 0.5, last[0] - BAND + 0.5, last[1] - BAND + 0.5)),
          'rgba(234,88,12,0.9)', 1, [4, 3]);
        const [tx, ty] = toCam(Hpin, [[0, 0]])[0]; // TL pin: orientation check
        ctx.beginPath(); ctx.arc(tx, ty, 3, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(59,130,246,0.95)'; ctx.fill();
      }
    }

    init().catch((e) => {
      console.error('[TactileExplorerGeneric] init failed:', e);
      setStatus(`Camera error: ${e.name === 'NotAllowedError' ? 'permission denied' : e.message}`);
    });

    return () => {
      cancelled = true;
      runningRef.current = false;
      videoRef.current?.srcObject?.getTracks()?.forEach((t) => t.stop());
      st.Hfwd?.delete(); st.Hinv?.delete(); st.HsnapToUv?.delete();
      st.descTpl?.delete(); st.kpTpl?.delete(); st.sift?.delete(); st.bf?.delete();
      st.Hfwd = st.Hinv = st.HsnapToUv = st.descTpl = st.kpTpl = st.sift = st.bf = null;
      onUvRef.current?.(null);
    };
  }, [attempt]);

  const progress = phase === 'capturing'
    ? ` (${captureRef.current.index}/4 — ${CORNER_PROMPTS[Math.min(captureRef.current.index, 3)]} pin)`
    : '';

  return (
    <>
      {/* NOT display:none — a hidden video element can be suspended by the
          browser so videoWidth stays 0 and no frames ever reach the canvas.
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
            onClick={() => { setStatus('Retrying…'); setAttempt((a) => a + 1); }}
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
            ? 'Freeze the current homography (press ; )'
            : 'Register the DOT Pad first — then Fix freezes the homography'}
        >
          {isFixed ? '🔓 Unfix [ ; ]' : '🔒 Fix [ ; ]'}
        </button>
      </div>

      <div className="tactile-debug-panel">
        <div className="tactile-debug-header">
          <span>
            {status}{progress}
            {camInfo ? ` · ${camInfo.w}×${camInfo.h} ${camInfo.state}` : ' · no camera yet'}
            &nbsp;·&nbsp; ref kp: {debugInfo.refKp} &nbsp;·&nbsp; good: {debugInfo.good} &nbsp;·&nbsp; inliers: {debugInfo.inliers}
            {gestureHint ? <>&nbsp;·&nbsp;<strong>{gestureHint}</strong></> : null}
          </span>
          <button
            type="button"
            className={`tactile-debug-fix-btn ${isFixed ? 'fixed' : ''}`}
            onClick={toggleFixed}
            title="Freeze the current homography (press ; )"
          >
            {isFixed ? 'Unfix' : 'Fix'}
          </button>
        </div>
        <canvas ref={debugRef} className="tactile-debug-canvas" />
      </div>

      {/* The rectified pin grid: the camera warped onto the DOT Pad's own 60×40
          lattice, with the mirrored avatar (blue) and the finger (yellow). */}
      {showRectPanel && (
        <div className="tactile-rect-panel">
          <div className="tactile-debug-header">
            <span>
              pin grid 60×40
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
