/**
 * Fingertip (u, v) → DOT Pad pin → rate-limited send.
 *
 * Design: `docs/dotpad-camio-design.md` §6.5 (D5, D7). Registration corners are
 * the CENTRES of the four corner pins, so `(u, v)` in the unit square maps to
 * pin `(u·(cols−1), v·(rows−1))` — the same convention as Audiom's `worldToPin`
 * rounding and the old Braille Doodle path (`u = col/(cols−1)`).
 *
 * Two pure pieces, both clock-free (the caller passes `now`):
 *   - the quantizer: per-axis rounding with hysteresis, and an off-pad cut;
 *   - the send gate: dwell + minimum interval + no-resend-of-the-same-pin.
 *
 * PLATFORM-FREE. Covered by `scripts/test_dotpad_pins.mjs`.
 */

/**
 * Per-model send policy. The host cannot tell a Gen-1 pad from a DOT Pad X, so
 * the user picks. Gen-1 re-renders and says "Lift your hands…" on every frame
 * (F16), hence the long dwell and interval.
 */
export const PRESETS = Object.freeze({
  'dotpad-x': Object.freeze({ id: 'dotpad-x', label: 'DOT Pad X', minIntervalMs: 150, dwellMs: 0, hysteresis: 0.35 }),
  'dotpad-gen1': Object.freeze({ id: 'dotpad-gen1', label: 'DOT Pad (Gen-1)', minIntervalMs: 2500, dwellMs: 600, hysteresis: 0.5 }),
});

/** Default device (the user can switch in the UI). */
export const DEFAULT_PRESET = 'dotpad-x';

/** Stable string key for a pin, used by the gate. */
export const pinKey = (p) => (p ? `${p[0]},${p[1]}` : null);

/**
 * @param {object} [options]
 * @param {number} [options.cols]         Pin columns. DOT Pad: 60, used DIRECTLY — never via `acuityGrid` (§6.2).
 * @param {number} [options.rows]         Pin rows. DOT Pad: 40.
 * @param {number} [options.hysteresis]   Extra pins past the half-pin boundary before switching.
 * @param {number} [options.offPadMargin] Pins beyond the corner-pin centres that still count as on the pad.
 */
export function createPinQuantizer({ cols = 60, rows = 40, hysteresis = 0.35, offPadMargin = 1 } = {}) {
  let prev = null;
  let h = hysteresis;

  const axis = (f, prevIdx, n) => {
    const idx = Math.max(0, Math.min(n - 1, Math.round(f)));
    if (prevIdx == null) return idx;
    return Math.abs(f - prevIdx) <= 0.5 + h ? prevIdx : idx;
  };

  return {
    get hysteresis() { return h; },
    setHysteresis(next) { if (Number.isFinite(next) && next >= 0) h = next; },
    reset() { prev = null; },

    /**
     * @param {number} u
     * @param {number} v
     * @returns {{pin: number[]|null, f: number[]}}
     */
    update(u, v) {
      const fx = u * (cols - 1);
      const fy = v * (rows - 1);
      const f = [fx, fy];
      if (!Number.isFinite(fx) || !Number.isFinite(fy)
          || fx < -offPadMargin || fx > cols - 1 + offPadMargin
          || fy < -offPadMargin || fy > rows - 1 + offPadMargin) {
        prev = null;
        return { pin: null, f };
      }
      const pin = [axis(fx, prev?.[0], cols), axis(fy, prev?.[1], rows)];
      prev = pin;
      return { pin, f };
    },
  };
}

/**
 * Decides WHEN a pin is sent as `moveAvatar`.
 *
 *   offer(key, now)  → key to send now, or null
 *     null key (border band / not synced) → resets the dwell candidate only
 *     send iff dwell elapsed && min interval elapsed && key ≠ lastSentKey
 *   lift()           → finger gone: resets the candidate AND lastSentKey, so
 *                      re-touching the same pin re-sends
 *   acknowledge(key) → the avatar is already on `key` (e.g. the keyboard walked
 *                      it under the finger): treat it as sent, send nothing
 *
 * @param {{minIntervalMs?: number, dwellMs?: number}} [options]
 */
export function createSendGate({ minIntervalMs = 150, dwellMs = 0 } = {}) {
  let candidate = null;
  let since = 0;
  let lastSentKey = null;
  let lastSentAt = -Infinity;
  let policy = { minIntervalMs, dwellMs };

  return {
    get lastSentKey() { return lastSentKey; },
    get candidate() { return candidate; },
    configure(next) { policy = { ...policy, ...next }; },

    offer(key, now) {
      if (key == null) { candidate = null; return null; }
      if (key !== candidate) { candidate = key; since = now; }
      if (key === lastSentKey) return null;
      if (now - since < policy.dwellMs) return null;
      if (now - lastSentAt < policy.minIntervalMs) return null;
      lastSentKey = key;
      lastSentAt = now;
      return key;
    },

    lift() {
      candidate = null;
      lastSentKey = null;
    },

    acknowledge(key) {
      candidate = null;
      lastSentKey = key;
    },
  };
}
