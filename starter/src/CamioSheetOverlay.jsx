import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { mercAspect } from './audiom';
import { lngLatToPoint } from './lib/paperMap';
import { expandTriangle, fitContain, pxToUv, sheetHomography, warpMesh } from './lib/sheetOverlay';

// Redraw budget: the camera runs at ~30 fps but a sighted helper only needs to
// follow the hand, and phones are slow. Narrow = the ≤980px layout.
const FRAME_MS_WIDE = 1000 / 15;
const FRAME_MS_NARROW = 1000 / 8;
const NARROW_QUERY = '(max-width: 980px)';
// Working resolutions: the warp source (the video copied down once per redraw)
// and the warped sheet's long side. The marks canvas is full resolution.
const SOURCE_MAX_W = 640;
const SHEET_MAX_PX = 800;
const LIVE_MAX_W = 640;
// Mesh: 12 × 8 cells, two triangles each.
const MESH_NX = 12;
const MESH_NY = 8;
// Gap (CSS px) kept around the fitted sheet so its outline is visible.
const SHEET_MARGIN = 10;

const FINGER = '#facc15';
const AVATAR = '#2563eb';

/**
 * The camera, full size over the Audiom map (a visual aid for a sighted
 * helper; aria-hidden — screen-reader users get the sidebar's live status).
 *
 *  - Not registered (or registering): the live camera frame with the
 *    library's own debug drawing (corner progress, fingertip), letterboxed
 *    (`contain`) so all four corners of the sheet stay in view.
 *  - Registered: the RECTIFIED sheet — the frame warped by the inverse of the
 *    registration pose so the registered quad is an upright rectangle of the
 *    map extent's shape (Mercator aspect of `bbox`), fitted and centred, faint
 *    — with the fingertip (yellow ring) and Audiom's avatar (blue dot) on it.
 *
 * The rectified sheet is NOT pixel-aligned to Audiom's own map underneath:
 * Audiom's embed API does not report its viewport (pan/zoom), so the sheet is
 * simply fitted to the overlay. It shows the finger and the avatar in the SAME
 * frame (the printed sheet), which is what a helper needs to see the avatar
 * follow the finger.
 *
 * `pointer-events: none` throughout, so Audiom underneath stays fully usable.
 * The warp is Canvas 2D (lib/sheetOverlay.js): no OpenCV on this thread.
 *
 * @param {object} props
 * @param {React.MutableRefObject} props.pointerRef the CamioPointer
 * @param {boolean} props.show
 * @param {number[]} props.bbox the printed frame's [w, s, e, n]
 * @param {React.MutableRefObject<number[]|null>} props.avatarRef Audiom's avatar [lng, lat]
 * @param {string|null} [props.hint] a gesture hint for the legend ("open hand", …)
 * @param {object|null} [props.testHook] `?camiotest` only: drawing stats are written to it
 */
export function CamioSheetOverlay({ pointerRef, show, bbox, avatarRef, hint = null, testHook = null }) {
  const rootRef = useRef(null);
  const liveRef = useRef(null);
  const sheetRef = useRef(null);
  const marksRef = useRef(null);
  const showRef = useRef(show);
  showRef.current = show;
  const [mode, setMode] = useState('live'); // 'live' | 'sheet'
  const [box, setBox] = useState(null); // { top, left, width, height } over the Audiom frame

  // Cover exactly the Audiom iframe (not its status bar): it is a sibling's
  // child inside .map-panel, so measure it and follow its size.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const host = root?.parentElement;
    if (!host) return undefined;
    const measure = () => {
      const frame = host.querySelector('.audiom-frame');
      const hr = host.getBoundingClientRect();
      const r = frame ? frame.getBoundingClientRect() : hr;
      const next = {
        top: Math.round(r.top - hr.top), left: Math.round(r.left - hr.left),
        width: Math.round(r.width), height: Math.round(r.height),
      };
      setBox((b) => (b && b.top === next.top && b.left === next.left && b.width === next.width
        && b.height === next.height ? b : next));
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(host);
    // The iframe may mount after this overlay (AudiomMap renders it once ready).
    const mo = new MutationObserver(() => {
      const frame = host.querySelector('.audiom-frame');
      if (frame && ro) ro.observe(frame);
      measure();
    });
    mo.observe(host, { childList: true, subtree: true });
    const frame = host.querySelector('.audiom-frame');
    if (frame) ro?.observe(frame);
    window.addEventListener('resize', measure);
    return () => { ro?.disconnect(); mo.disconnect(); window.removeEventListener('resize', measure); };
  }, []);

  useEffect(() => {
    let raf = 0;
    let last = -Infinity;
    let modeNow = 'live';
    const mq = typeof matchMedia === 'function' ? matchMedia(NARROW_QUERY) : null;
    const source = document.createElement('canvas');
    const sctx = source.getContext('2d');
    const times = [];
    const aspect = mercAspect(bbox);

    const drawLive = (p, w) => {
      const c = liveRef.current;
      const fw = p.core.view.frame.width;
      const target = Math.max(160, Math.round(Math.min(LIVE_MAX_W, fw || LIVE_MAX_W, w)));
      if (c.width !== target) c.width = target;
      p.drawDebug(c); // sizes the height to the frame's aspect; CSS letterboxes it
    };

    const drawSheet = (p, video, pose, grid, w, h) => {
      const c = sheetRef.current;
      const marks = marksRef.current;
      const k = Math.min(1, SHEET_MAX_PX / Math.max(w, h));
      const cw = Math.max(1, Math.round(w * k));
      const ch = Math.max(1, Math.round(h * k));
      if (c.width !== cw) c.width = cw;
      if (c.height !== ch) c.height = ch;
      const ctx = c.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cw, ch);

      // The video, once, at the working resolution.
      const fw = video.videoWidth, fh = video.videoHeight;
      const s = Math.min(1, SOURCE_MAX_W / fw);
      const sw = Math.round(fw * s), sh = Math.round(fh * s);
      if (source.width !== sw) source.width = sw;
      if (source.height !== sh) source.height = sh;
      sctx.drawImage(video, 0, 0, sw, sh);

      const H = sheetHomography(pose, grid);
      const m = SHEET_MARGIN * k;
      const fit = fitContain(aspect, cw - 2 * m, ch - 2 * m);
      const rect = { x: fit.x + m, y: fit.y + m, w: fit.w, h: fit.h };
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h); // off-frame parts of the sheet
      for (const t of warpMesh(H, rect, MESH_NX, MESH_NY)) {
        if (!t.m) continue;
        const d = expandTriangle(t.dst, 0.6);
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(d[0][0], d[0][1]);
        ctx.lineTo(d[1][0], d[1][1]);
        ctx.lineTo(d[2][0], d[2][1]);
        ctx.closePath();
        ctx.clip();
        // m maps camera px → canvas px; the source is the frame scaled by s.
        ctx.setTransform(t.m[0] / s, t.m[1] / s, t.m[2] / s, t.m[3] / s, t.m[4], t.m[5]);
        ctx.drawImage(source, 0, 0);
        ctx.restore();
      }

      // Marks: full opacity, full resolution, in CSS px.
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const mw = Math.round(w * dpr), mh = Math.round(h * dpr);
      if (marks.width !== mw) marks.width = mw;
      if (marks.height !== mh) marks.height = mh;
      const g = marks.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, mw, mh);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const css = { x: rect.x / k, y: rect.y / k, w: rect.w / k, h: rect.h / k };
      const at = (uv) => [css.x + uv.u * css.w, css.y + uv.v * css.h];
      const onSheet = (uv) => uv && uv.u > -0.05 && uv.u < 1.05 && uv.v > -0.05 && uv.v < 1.05;

      g.lineWidth = 3;
      g.strokeStyle = 'rgba(15,23,42,0.9)';
      g.strokeRect(css.x, css.y, css.w, css.h);
      g.lineWidth = 1.5;
      g.strokeStyle = '#ffffff';
      g.strokeRect(css.x, css.y, css.w, css.h);

      const avatarUv = avatarRef.current ? lngLatToPoint(avatarRef.current, bbox) : null;
      let avatarCss = null;
      if (onSheet(avatarUv)) {
        avatarCss = at(avatarUv);
        g.beginPath();
        g.arc(avatarCss[0], avatarCss[1], 9, 0, Math.PI * 2);
        g.fillStyle = AVATAR;
        g.fill();
        g.lineWidth = 3;
        g.strokeStyle = '#ffffff';
        g.stroke();
      }
      const tipUv = pxToUv(p.core.view.tip, pose, grid);
      let tipCss = null;
      if (onSheet(tipUv)) {
        tipCss = at(tipUv);
        g.beginPath();
        g.arc(tipCss[0], tipCss[1], 14, 0, Math.PI * 2);
        g.lineWidth = 7;
        g.strokeStyle = 'rgba(15,23,42,0.9)';
        g.stroke();
        g.lineWidth = 4;
        g.strokeStyle = FINGER;
        g.stroke();
      }
      return { sheetCss: css, avatarUv, avatarCss, tipUv, tipCss };
    };

    const frame = (now) => {
      raf = requestAnimationFrame(frame);
      if (!showRef.current || document.hidden) return;
      if (now - last < (mq?.matches ? FRAME_MS_NARROW : FRAME_MS_WIDE)) return;
      const p = pointerRef.current;
      const root = rootRef.current;
      if (!p?.running || !root || !liveRef.current) return;
      const w = root.clientWidth, h = root.clientHeight;
      if (!w || !h) return;
      last = now;

      const t0 = performance.now();
      const core = p.core;
      const pose = core.pose;
      const video = p.videoElement;
      const sheet = !!(pose && core.currentRegistration && core.currentPhase === 'ready'
        && video?.videoWidth);
      let info = null;
      if (sheet) info = drawSheet(p, video, pose, core.currentGrid, w, h);
      else drawLive(p, w);
      const ms = performance.now() - t0;

      const next = sheet ? 'sheet' : 'live';
      if (next !== modeNow) { modeNow = next; setMode(next); }
      times.push(ms);
      if (times.length > 120) times.shift();
      if (testHook) {
        testHook.overlay = {
          mode: next, ms, msAvg: times.reduce((a, b) => a + b, 0) / times.length,
          msMax: Math.max(...times), frames: (testHook.overlay?.frames || 0) + 1,
          box: { w, h }, narrow: !!mq?.matches, ...(info || {}),
        };
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [pointerRef, avatarRef, bbox, testHook]);

  return (
    <div
      ref={rootRef}
      id="camio-overlay"
      className={`camio-overlay camio-overlay--${mode}`}
      hidden={!show}
      aria-hidden="true"
      style={box ? { top: box.top, left: box.left, width: box.width, height: box.height } : undefined}
    >
      <canvas ref={liveRef} className="camio-overlay-live" width={LIVE_MAX_W} />
      <canvas ref={sheetRef} className="camio-overlay-sheet" />
      <canvas ref={marksRef} className="camio-overlay-marks" />
      {mode === 'sheet' && (
        <div className="camio-overlay-legend">
          <span><i className="camio-key camio-key--finger" /> Finger</span>
          <span><i className="camio-key camio-key--avatar" /> Avatar</span>
          {hint && <strong>{hint}</strong>}
          <span className="camio-overlay-note">Printed sheet, not aligned to the map</span>
        </div>
      )}
    </div>
  );
}
