/**
 * DOT Pad template geometry — registration checks and auto-find selection.
 *
 * Design: `docs/dotpad-camio-design.md` §6 (D5, D6). The numbers below are
 * `resources/dotpad_corners.json`, measured from `resources/dotpad.png`
 * (352×292): a comb fit of 60 and 40 teeth gave a square pitch of 3.3335 px.
 * `scripts/test_dotpad_template.mjs` asserts the JSON and this constant agree.
 *
 * The template is used GEOMETRICALLY only — find the display window as a quad,
 * map template ratios through it, confirm orientation with one touch. It is NOT
 * an AKAZE reference: the render is flat grey plus two periodic dot lattices,
 * which is exactly the phantom-homography problem (§6.4, "Rejected").
 *
 * PLATFORM-FREE: no OpenCV, no DOM. The component does the contour work and
 * hands plain `[x, y]` quads to {@link selectDevice}.
 */

/** Corner order everywhere: TL, TR, BR, BL. */
export const DOTPAD_TEMPLATE = Object.freeze({
  image: 'dotpad.png',
  imageSize: [352, 292],
  cols: 60,
  rows: 40,
  pinPitchPx: 3.3335,
  pinCorners: [[77.0, 57.34], [273.68, 57.34], [273.68, 187.35], [77.0, 187.35]],
  displayWindow: [[62.0, 42.5], [288.5, 42.5], [288.5, 202.5], [62.0, 202.5]],
  textWindow: [[62.0, 248.5], [288.5, 248.5], [288.5, 269.5], [62.0, 269.5]],
  bezel: [[50.0, 30.5], [300.5, 30.5], [300.5, 214.0], [50.0, 214.0]],
  maskPinField: [[72.0, 52.3], [278.7, 52.3], [278.7, 192.4], [72.0, 192.4]],
  note: 'Corner order TL,TR,BR,BL. pinCorners are corner-PIN CENTRES. maskPinField = pin field ± 1.5 pitch.',
});

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const mean = (a, b) => (a + b) / 2;

/** Width / height of a TL,TR,BR,BL quad, from mean opposite edges. */
export function quadAspect(q) {
  return mean(dist(q[0], q[1]), dist(q[3], q[2])) / mean(dist(q[0], q[3]), dist(q[1], q[2]));
}

/** Display-window aspect in the template: 226.5 / 160 = 1.416. */
export const DISPLAY_ASPECT = quadAspect(DOTPAD_TEMPLATE.displayWindow);

/* ------------------------------------------------------------ homography -- */

/**
 * 4-point DLT: the 3×3 `H` (h33 = 1) with `H·src[i] ∝ dst[i]`.
 *
 * @param {number[][]} src Four [x, y].
 * @param {number[][]} dst Four [x, y].
 * @returns {number[][]} 3×3.
 */
export function homography4(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [X, Y] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y);
  }
  // Gaussian elimination with partial pivoting on the 8×8 system.
  const n = 8;
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (Math.abs(A[piv][c]) < 1e-12) throw new RangeError('homography4: degenerate quad');
    [A[c], A[piv]] = [A[piv], A[c]];
    [b[c], b[piv]] = [b[piv], b[c]];
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      if (f === 0) continue;
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const h = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * h[k];
    h[r] = s / A[r][r];
  }
  return [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1]];
}

/** Apply a 3×3 homography to one point. */
export function applyH(H, p) {
  const w = H[2][0] * p[0] + H[2][1] * p[1] + H[2][2];
  return [
    (H[0][0] * p[0] + H[0][1] * p[1] + H[0][2]) / w,
    (H[1][0] * p[0] + H[1][1] * p[1] + H[1][2]) / w,
  ];
}

/* ------------------------------------------------------------ quad tools -- */

/**
 * Order four points TL, TR, BR, BL in image space (y down): sort by angle around
 * the centroid, which is clockwise on screen, and start at the smallest x + y.
 */
export function orderQuad(pts) {
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const sorted = [...pts].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  let start = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i][0] + sorted[i][1] < sorted[start][0] + sorted[start][1]) start = i;
  }
  return sorted.map((_, i) => sorted[(i + start) % sorted.length]);
}

/** Cyclic shift: `rotateQuad(q, r)[i] = q[(i + r) % 4]`. */
export const rotateQuad = (q, r) => q.map((_, i) => q[(i + r) % 4]);

/** Shoelace area (positive for a TL,TR,BR,BL quad in y-down image space). */
export function quadArea(q) {
  let s = 0;
  for (let i = 0; i < q.length; i++) {
    const a = q[i];
    const b = q[(i + 1) % q.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

/**
 * §6.3 sanity check on four locked corner-pin centres.
 *   - convex and clockwise on screen (every turn has the same, positive, sign);
 *   - mean(top, bottom) / mean(left, right) in [1.15, 2.0] — 59/39 = 1.51,
 *     with room for perspective.
 *
 * @param {number[][]} corners TL, TR, BR, BL.
 * @returns {{ok: boolean, reason: string|null, ratio: number}}
 */
export function checkPinQuad(corners, { minRatio = 1.15, maxRatio = 2.0 } = {}) {
  if (!Array.isArray(corners) || corners.length !== 4) return { ok: false, reason: 'need-four', ratio: NaN };
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    const c = corners[(i + 2) % 4];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (!(cross > 0)) return { ok: false, reason: 'not-convex-clockwise', ratio: quadAspect(corners) };
  }
  const ratio = quadAspect(corners);
  if (!(ratio >= minRatio && ratio <= maxRatio)) return { ok: false, reason: 'aspect', ratio };
  return { ok: true, reason: null, ratio };
}

/** Mean corner distance between two quads, minimised over cyclic order. */
function quadDistance(a, b) {
  let best = Infinity;
  for (let r = 0; r < 4; r++) {
    const rb = rotateQuad(b, r);
    const d = (dist(a[0], rb[0]) + dist(a[1], rb[1]) + dist(a[2], rb[2]) + dist(a[3], rb[3])) / 4;
    if (d < best) best = d;
  }
  return best;
}

/**
 * §6.4 step 2: pick the display window and its rotation from candidate quads.
 *
 * Each quad is tried as the display window in 4 cyclic orders (device rotated
 * 0/90/180/270). A hypothesis scores +1 when some OTHER quad sits where the
 * template's braille text window would be (mean corner distance < 8% of the
 * display width) — that is what resolves 180°. Hypotheses more than ±25% off the
 * 1.416 display aspect are rejected; within that, aspect error and text-match
 * distance break ties.
 *
 * The 1%-of-frame area floor (§6.4 step 1) applies to DISPLAY hypotheses only.
 * The text window is ~13% of the display's area, so a pad filling 5% of the
 * frame has a text window well under 1%; filtering it out would throw away the
 * only cue that resolves 180°. Text candidates need only `minTextAreaFrac`.
 *
 * @param {number[][][]} quads Candidate quads (any vertex order).
 * @param {{width: number, height: number}} [frameSize] Enables the area floors.
 * @returns {null | {
 *   rotation: number, displayCorners: number[][], pinCorners: number[][],
 *   textFound: boolean, needsConfirm: boolean, score: number, H: number[][]
 * }}
 */
export function selectDevice(quads, frameSize = null, {
  textTol = 0.08, aspectTol = 0.25, minAreaFrac = 0.01, minTextAreaFrac = 0.0005,
} = {}) {
  const tpl = DOTPAD_TEMPLATE;
  const frameArea = frameSize ? frameSize.width * frameSize.height : 0;
  const ordered = (quads || [])
    .filter((q) => Array.isArray(q) && q.length === 4)
    .map(orderQuad)
    .filter((q) => Math.abs(quadArea(q)) >= minTextAreaFrac * frameArea);

  let best = null;
  ordered.forEach((Q, qi) => {
    if (Math.abs(quadArea(Q)) < minAreaFrac * frameArea) return;
    for (let r = 0; r < 4; r++) {
      const Qr = rotateQuad(Q, r);
      const aspectErr = Math.abs(quadAspect(Qr) / DISPLAY_ASPECT - 1);
      if (aspectErr > aspectTol) continue;
      let H;
      try { H = homography4(tpl.displayWindow, Qr); } catch { continue; }
      const T = tpl.textWindow.map((p) => applyH(H, p));
      const width = mean(dist(Qr[0], Qr[1]), dist(Qr[3], Qr[2]));
      let textDist = Infinity;
      ordered.forEach((O, oi) => {
        if (oi === qi) return;
        const d = quadDistance(T, O);
        if (d < textDist) textDist = d;
      });
      const textFound = textDist < textTol * width;
      const score = (textFound ? 1 - textDist / width : 0) - aspectErr;
      if (!best || score > best.score) {
        best = {
          rotation: r,
          displayCorners: Qr,
          pinCorners: tpl.pinCorners.map((p) => applyH(H, p)),
          textFound,
          needsConfirm: !textFound,
          score,
          H,
        };
      }
    }
  });
  return best;
}

/**
 * §6.4 step 3: one touch on the top-left pin fixes the orientation.
 *
 * @param {number[][]} pinCorners Predicted TL, TR, BR, BL.
 * @param {number[]} touch The locked fingertip.
 * @param {{pitches?: number, cols?: number, rows?: number}} [options]
 * @returns {number[][]|null} The corners re-ordered so the touched one is TL, or
 *   null when the touch is not within `pitches` pin pitches of any corner.
 */
export function resolveConfirmTouch(pinCorners, touch, { pitches = 3, cols = 60, rows = 40 } = {}) {
  const pitch = mean(
    mean(dist(pinCorners[0], pinCorners[1]), dist(pinCorners[3], pinCorners[2])) / (cols - 1),
    mean(dist(pinCorners[0], pinCorners[3]), dist(pinCorners[1], pinCorners[2])) / (rows - 1),
  );
  let bestI = -1;
  let bestD = Infinity;
  pinCorners.forEach((c, i) => { const d = dist(c, touch); if (d < bestD) { bestD = d; bestI = i; } });
  if (bestI < 0 || bestD > pitches * pitch) return null;
  return rotateQuad(pinCorners, bestI);
}

/**
 * §6.3 reference mask polygons in snapshot pixels: the pin field (± 1.5 pitch)
 * and the braille text window grown by `expandPx`. Both change state and get
 * occluded by hands, so AKAZE must not take reference features from them.
 *
 * @param {number[][]} H Template → snapshot (`homography4(pinCorners_tpl, corners)`).
 * @param {{expandPx?: number}} [options]
 * @returns {{pinField: number[][], textWindow: number[][]}}
 */
export function maskPolygons(H, { expandPx = 4 } = {}) {
  const tpl = DOTPAD_TEMPLATE;
  const pinField = tpl.maskPinField.map((p) => applyH(H, p));
  const text = tpl.textWindow.map((p) => applyH(H, p));
  const cx = text.reduce((s, p) => s + p[0], 0) / 4;
  const cy = text.reduce((s, p) => s + p[1], 0) / 4;
  const grow = expandPx * Math.SQRT2; // along the corner diagonal ≈ expandPx per edge
  const textWindow = text.map(([x, y]) => {
    const d = Math.hypot(x - cx, y - cy) || 1;
    return [x + ((x - cx) / d) * grow, y + ((y - cy) / d) * grow];
  });
  return { pinField, textWindow };
}
