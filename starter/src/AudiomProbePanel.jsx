import { useEffect, useMemo, useRef } from 'react';
import { buildProbeGeometry } from './lib/probeGeometry';

/**
 * Diagnostic view of the Audiom bounds probe. Draws nothing the app depends on
 * — it changes no bounds, no aspect and no row count; it only makes visible
 * what `discoverBounds` already computed and then threw away.
 *
 * What to look at, in order:
 *
 *  1. THE SEED versus THE CENTRE of the resolved rectangle. The probe runs four
 *     independent 1-D searches from the seed: west/east along the seed's
 *     latitude, south/north along its longitude. That is a cross-section through
 *     one point, and it equals the map's bounding box only when the seed happens
 *     to sit on a line from which all four true edges are reachable. The further
 *     the seed sits from the centre (the dashed pink arrow, reported as `off
 *     centre` in the stats), the more of the map the cross-section never sampled.
 *  2. THE SAMPLE DOTS. Green read inside, orange read outside, magenta answered
 *     nothing (a failed `getState`). A ray whose green dots stop well short of
 *     its opposite number's, with the seed near centre, is an edge the avatar
 *     could not reach — on map 885 the eastward ray stops at the Lake Michigan
 *     shoreline, 19.8 km inside the true east edge, while north and south run
 *     ~22 km PAST the last feature into empty space.
 *  3. THE EDGE TICKS and their printed lng/lat. These are the four numbers that
 *     become the bounds, the aspect, and therefore the physical sheet.
 *
 * Everything is scaled from the telemetry itself — no per-map constants and no
 * dataset branches — so a 4 m room diagram and a whole state read the same way.
 * Projection is `lib/probeGeometry.js`, i.e. Web Mercator, the same convention
 * `mercAspect` uses, so the box drawn here has the aspect the app prints at.
 */

const MAX_W = 316;
const MAX_H = 360;

const COLORS = {
  bg: '#0b1220',
  rectFill: 'rgba(56,189,248,0.08)',
  rect: '#38bdf8',
  ray: '#64748b',
  rayFailed: '#ef4444',
  inside: '#22c55e',
  outside: '#f97316',
  nulls: '#e879f9',
  seed: '#facc15',
  center: '#f472b6',
  label: '#94a3b8',
};

/**
 * Decimals to print a coordinate at, derived from the span being shown rather
 * than fixed: 4 dp is meaningless on a 3 m indoor diagram and wasteful on a
 * continent. ~4 significant digits past the span, clamped to something a
 * 320 px panel can still fit.
 */
function decimalsFor(span) {
  if (!(span > 0)) return 4;
  return Math.min(8, Math.max(2, Math.ceil(-Math.log10(span)) + 3));
}

function fmtDistance(m) {
  if (!Number.isFinite(m)) return '—';
  if (m < 1) return `${(m * 100).toFixed(0)} cm`;
  if (m < 1000) return `${m.toFixed(1)} m`;
  return `${(m / 1000).toFixed(2)} km`;
}

/** Draw a sample dot. Clipped samples become a border chevron, not a dot. */
function drawSample(ctx, s, px, py) {
  const color = s.inside === true ? COLORS.inside : s.inside === false ? COLORS.outside : COLORS.nulls;
  if (s.clipped) {
    // Off-scale: expansion doubles 0.5° → 200°, so a first-outside sample can be
    // orders of magnitude beyond the map. Marked at the border so it is visibly
    // present but cannot squash the diagram.
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(px - 3.5, py - 3.5);
    ctx.lineTo(px + 3.5, py);
    ctx.lineTo(px - 3.5, py + 3.5);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
    return;
  }
  ctx.beginPath();
  ctx.arc(px, py, s.inside === true ? 2.4 : 3, 0, Math.PI * 2);
  if (s.inside === true) {
    ctx.fillStyle = color;
    ctx.fill();
  } else {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }
}

function draw(canvas, geo, size) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  canvas.width = Math.round(size.w * dpr);
  canvas.height = Math.round(size.h * dpr);
  canvas.style.width = `${size.w}px`;
  canvas.style.height = `${size.h}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, size.w, size.h);

  const X = (x) => x * size.w;
  const Y = (y) => y * size.h;

  // --- resolved rectangle -------------------------------------------------
  if (geo.rect) {
    const rx = X(geo.rect.x0); const ry = Y(geo.rect.y0);
    const rw = X(geo.rect.x1) - rx; const rh = Y(geo.rect.y1) - ry;
    ctx.fillStyle = COLORS.rectFill;
    ctx.fillRect(rx, ry, rw, rh);
    ctx.strokeStyle = COLORS.rect;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(rx, ry, rw, rh);
  }

  // --- rays, samples, edge ticks ------------------------------------------
  const sx = X(geo.seed.x); const sy = Y(geo.seed.y);
  for (const ray of geo.rays) {
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(X(ray.tip.x), Y(ray.tip.y));
    ctx.strokeStyle = ray.resolved ? COLORS.ray : COLORS.rayFailed;
    ctx.lineWidth = 1;
    ctx.setLineDash(ray.resolved ? [] : [3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);

    for (const s of ray.samples) drawSample(ctx, s, X(s.x), Y(s.y));

    if (ray.edge) {
      // Tick perpendicular to the ray's own axis, so it reads as an edge rather
      // than another sample.
      const ex = X(ray.edge.x); const ey = Y(ray.edge.y);
      ctx.strokeStyle = COLORS.rect;
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (ray.axis === 'lng') { ctx.moveTo(ex, ey - 6); ctx.lineTo(ex, ey + 6); }
      else { ctx.moveTo(ex - 6, ey); ctx.lineTo(ex + 6, ey); }
      ctx.stroke();
    } else {
      // No substitute edge is drawn. The ray ends where the search gave up, and
      // says so.
      const tx = X(ray.tip.x); const ty = Y(ray.tip.y);
      ctx.strokeStyle = COLORS.rayFailed;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(tx - 4, ty - 4); ctx.lineTo(tx + 4, ty + 4);
      ctx.moveTo(tx + 4, ty - 4); ctx.lineTo(tx - 4, ty + 4);
      ctx.stroke();
    }
  }

  // --- centre, and the seed's offset from it ------------------------------
  if (geo.center) {
    const cx = X(geo.center.x); const cy = Y(geo.center.y);
    ctx.strokeStyle = COLORS.center;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(sx, sy);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(cx - 6, cy); ctx.lineTo(cx + 6, cy);
    ctx.moveTo(cx, cy - 6); ctx.lineTo(cx, cy + 6);
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }

  // --- the seed itself ----------------------------------------------------
  ctx.beginPath();
  ctx.arc(sx, sy, 4.5, 0, Math.PI * 2);
  ctx.fillStyle = COLORS.seed;
  ctx.fill();
  ctx.strokeStyle = COLORS.bg;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // --- edge value labels --------------------------------------------------
  ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = COLORS.label;
  const spanLng = geo.rect ? geo.rect.east - geo.rect.west : null;
  const spanLat = geo.rect ? geo.rect.north - geo.rect.south : null;
  const put = (text, x, y, align, baseline) => {
    ctx.textAlign = align;
    ctx.textBaseline = baseline;
    ctx.fillText(text, Math.min(Math.max(x, 2), size.w - 2), Math.min(Math.max(y, 2), size.h - 2));
  };
  for (const ray of geo.rays) {
    const isLng = ray.axis === 'lng';
    const dp = decimalsFor(isLng ? spanLng : spanLat);
    const text = ray.resolved ? ray.value.toFixed(dp) : `${ray.key} incomplete`;
    ctx.fillStyle = ray.resolved ? COLORS.label : COLORS.rayFailed;
    const ex = X(ray.edge ? ray.edge.x : ray.tip.x);
    const ey = Y(ray.edge ? ray.edge.y : ray.tip.y);
    if (ray.key === 'west') put(text, ex - 8, ey, 'right', 'middle');
    else if (ray.key === 'east') put(text, ex + 8, ey, 'left', 'middle');
    else if (ray.key === 'north') put(text, ex, ey - 9, 'center', 'bottom');
    else put(text, ex, ey + 9, 'center', 'top');
  }
}

export function AudiomProbePanel({ telemetry }) {
  const canvasRef = useRef(null);
  const geo = useMemo(() => buildProbeGeometry(telemetry), [telemetry]);

  const size = useMemo(() => {
    const a = geo.scene?.aspect;
    if (!Number.isFinite(a) || a <= 0) return null;
    // Fit the scene inside the panel WITHOUT distorting it: the whole point is
    // that the drawn rectangle carries the map's real Mercator aspect.
    let w = MAX_W; let h = MAX_W / a;
    if (h > MAX_H) { h = MAX_H; w = MAX_H * a; }
    return { w: Math.round(w), h: Math.round(h) };
  }, [geo]);

  useEffect(() => {
    if (!canvasRef.current || !size || !geo.scene) return;
    draw(canvasRef.current, geo, size);
  }, [geo, size]);

  return (
    <div className="audiom-probe-panel">
      <div className="tactile-debug-header">
        <span>bounds probe{geo.sampleCount ? ` · ${geo.sampleCount} samples` : ''}</span>
        {geo.rect ? <span>aspect {geo.rect.aspect.toFixed(4)}</span> : null}
      </div>

      {!geo.scene ? (
        // No guess, no placeholder box: say what is missing and stop.
        <p className="audiom-probe-empty">
          {geo.reason === 'no-telemetry'
            ? 'No probe telemetry yet. Load a map and wait for bounds discovery.'
            : `Probe telemetry unusable (${geo.reason}).`}
        </p>
      ) : (
        <>
          <canvas ref={canvasRef} className="audiom-probe-canvas" />
          <div className="audiom-probe-stats">
            {geo.offset ? (
              <p>
                seed off centre&nbsp;
                <strong style={{ color: Math.max(Math.abs(geo.offset.fracX), Math.abs(geo.offset.fracY)) > 0.1 ? '#f472b6' : '#22c55e' }}>
                  {(geo.offset.fracX * 100).toFixed(1)}% × {(geo.offset.fracY * 100).toFixed(1)}%
                </strong>
                &nbsp;of half-extent · {fmtDistance(geo.offset.dMeters)}
              </p>
            ) : null}
            {geo.unresolved.length ? (
              <p style={{ color: '#ef4444' }}>
                probe incomplete: {geo.unresolved.map((k) => {
                  const r = geo.rays.find((ray) => ray.key === k);
                  return `${k}${r?.reason ? ` (${r.reason})` : ''}`;
                }).join(', ')}
              </p>
            ) : null}
            {!geo.ok && !geo.unresolved.length ? (
              <p style={{ color: '#ef4444' }}>bounds rejected: {geo.reason}</p>
            ) : null}
            <p className="audiom-probe-key">
              <span style={{ color: COLORS.seed }}>●</span> seed ·
              <span style={{ color: COLORS.center }}> ✛</span> centre ·
              <span style={{ color: COLORS.inside }}> ●</span> inside ·
              <span style={{ color: COLORS.outside }}> ○</span> outside ·
              <span style={{ color: COLORS.nulls }}> ▸</span> no answer / off-scale
            </p>
            <p className="audiom-probe-key">
              Four 1-D searches from ONE seed measure a cross-section, not a box.
              A large offset, or rays stopping asymmetrically, is that error made visible.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
