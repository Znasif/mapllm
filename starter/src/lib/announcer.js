/**
 * announcer — the audiom.html page's one channel for its own status and
 * instructions, as screen-reader text instead of speech.
 *
 * The Audiom map the page embeds does the talking; this page must not speak
 * over it. So every host message (sync, corner prompts, geocoding, camera
 * errors) goes into an ARIA live region that the user's screen reader reads in
 * its own voice and queue, and that a sighted helper can see.
 *
 * Two channels, each backing one always-rendered region:
 *   - 'polite'    → <p role="status" aria-live="polite" aria-atomic="true">
 *   - 'assertive' → <p role="alert"  aria-live="assertive" aria-atomic="true">
 *
 * Re-announcing: a live region only speaks when its DOM changes, so the same
 * text twice in a row ("Point at the top-left corner pin…" after rejected
 * corners) would be silent. Every message therefore CLEARS the region first and
 * sets the text `delayMs` later. A newer message on the same channel replaces a
 * pending one (barge-in, like the old cancel-then-speak).
 *
 * PLATFORM-FREE: no React, no DOM. `onChange(channel, text)` is the sink (the
 * React hook `hooks/useAnnouncer.js` feeds state), timers are injectable for
 * tests (scripts/test_announcer.mjs).
 *
 * @param {object} options
 * @param {(channel: 'polite'|'assertive', text: string) => void} options.onChange
 * @param {number} [options.delayMs]
 * @param {(fn: () => void, ms: number) => unknown} [options.setTimer]
 * @param {(handle: unknown) => void} [options.clearTimer]
 */
export function createAnnouncer({
  onChange,
  delayMs = 60,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (h) => clearTimeout(h),
}) {
  const pending = { polite: null, assertive: null };

  /**
   * @param {string|{text?: string}} input A string, or anything with `.text`.
   * @param {{assertive?: boolean}} [opts]
   * @returns {boolean} Whether anything was announced.
   */
  function announce(input, { assertive = false } = {}) {
    const text = String((typeof input === 'string' ? input : input?.text) ?? '').trim();
    if (!text) return false;
    const channel = assertive ? 'assertive' : 'polite';
    if (pending[channel] !== null) clearTimer(pending[channel]);
    onChange(channel, '');
    pending[channel] = setTimer(() => {
      pending[channel] = null;
      onChange(channel, text);
    }, delayMs);
    return true;
  }

  /** Drop any pending message (unmount). */
  function dispose() {
    for (const ch of Object.keys(pending)) {
      if (pending[ch] !== null) clearTimer(pending[ch]);
      pending[ch] = null;
    }
  }

  return { announce, dispose };
}

export default createAnnouncer;
