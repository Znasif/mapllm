import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { INBOUND } from '../lib/audiomChannel';
import { createViewportTracker, isInnerPin } from '../lib/dotpadViewport';
import {
  runDotpadSync, createResyncScheduler, describeScale, SYNC_FAILURE_TEXT,
} from '../lib/dotpadSync';
import { createPinQuantizer, createSendGate, PRESETS, DEFAULT_PRESET, pinKey } from '../lib/dotpadPins';
import { matchL0 } from '../lib/l0';
import { speak as defaultSpeak } from '../lib/speak';

/** Pointing while not synced prompts at most this often (§5). */
const UNSYNCED_PROMPT_MS = 10000;

const samePin = (a, b) => (a === b) || (!!a && !!b && a[0] === b[0] && a[1] === b[1]);

// A soft tick when the finger enters the 2-pin border band — quieter and
// shorter than the registration beep, so it reads as "edge", not "event".
let tickCtx;
function tick() {
  try {
    tickCtx = tickCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = tickCtx.createOscillator();
    const g = tickCtx.createGain();
    o.frequency.value = 1400;
    o.connect(g); g.connect(tickCtx.destination);
    const t = tickCtx.currentTime;
    g.gain.setValueAtTime(0.05, t);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 0.03);
    o.start(t); o.stop(t + 0.035);
  } catch { /* noop */ }
}

/**
 * The DOT Pad bridge: MediaPipe fingertip → Audiom's avatar, confined to the
 * DOT Pad window Audiom is currently rendering.
 *
 * Design: `docs/dotpad-camio-design.md` §5-§6.5. Owns, for the component's
 * life:
 *   - the viewport tracker (`lib/dotpadViewport.js`) fed by `positionChanged`;
 *   - the pin quantizer and send gate (`lib/dotpadPins.js`);
 *   - the sync runner (`lib/dotpadSync.js`) and the STALE-only auto-resync timer;
 *   - the host's short spoken prompts.
 *
 * Finger sends happen only while SYNCED, only for inner-band pins; the 2-pin
 * border band is silent apart from a soft tick on entry (decision 3). The
 * window itself moves only when Audiom pages it — the mirror follows.
 *
 * Every per-frame path (`onUv`) works on refs and sets React state only when a
 * displayed value actually changes.
 *
 * @param {object} options
 * @param {object|null} options.channel `createAudiomChannel` instance (from AudiomMap's onChannel).
 * @param {(text: string) => unknown} [options.speak]
 */
export function useDotpadBridge({ channel, speak = defaultSpeak }) {
  const trackerRef = useRef(null);
  if (!trackerRef.current) trackerRef.current = createViewportTracker();
  const quantRef = useRef(null);
  if (!quantRef.current) quantRef.current = createPinQuantizer({ hysteresis: PRESETS[DEFAULT_PRESET].hysteresis });
  const gateRef = useRef(null);
  if (!gateRef.current) gateRef.current = createSendGate(PRESETS[DEFAULT_PRESET]);

  const channelRef = useRef(channel);
  useEffect(() => { channelRef.current = channel; }, [channel]);
  const speakRef = useRef(speak);
  useEffect(() => { speakRef.current = speak; }, [speak]);

  const [syncState, setSyncState] = useState('unsynced');
  const [model, setModel] = useState(null);
  const [avatarPin, setAvatarPin] = useState(null);
  const [fingerPin, setFingerPin] = useState(null);
  const [pages, setPages] = useState([0, 0]);
  const [phase, setPhase] = useState(null);
  const [lastFailure, setLastFailure] = useState(null);
  const [preset, setPresetState] = useState(DEFAULT_PRESET);
  const [hysteresis, setHysteresisState] = useState(PRESETS[DEFAULT_PRESET].hysteresis);
  const [autoResync, setAutoResyncState] = useState(true);
  const autoResyncRef = useRef(true);

  const fingerRef = useRef(null);
  const inBandRef = useRef(false);
  const lastPromptRef = useRef(-Infinity);
  const syncingRef = useRef(false);

  /** Copy the tracker into React state (cheap; values are compared first). */
  const refresh = useCallback(() => {
    const t = trackerRef.current;
    setSyncState(t.state);
    setModel(t.model);
    setAvatarPin((prev) => (samePin(prev, t.avatarPin()) ? prev : t.avatarPin()));
    const pg = t.pages();
    setPages((prev) => (prev[0] === pg[0] && prev[1] === pg[1] ? prev : pg));
  }, []);

  const requestSyncRef = useRef(null);
  const scheduler = useMemo(() => createResyncScheduler({
    onFire: () => {
      if (trackerRef.current.state === 'stale' && autoResyncRef.current) requestSyncRef.current?.({ auto: true });
    },
  }), []);

  /**
   * Run one sync. Manual (S / button / voice) or automatic (stale + quiet).
   * A second request while one is running is ignored.
   */
  const requestSync = useCallback(async ({ auto = false } = {}) => {
    const ch = channelRef.current;
    if (!ch) { speakRef.current('Load a map first.'); return null; }
    if (syncingRef.current) return null;
    syncingRef.current = true;
    scheduler.cancel();
    gateRef.current.lift();
    setLastFailure(null);
    speakRef.current(auto ? 'Re-syncing the DOT Pad. Hands off the keys.' : 'Syncing the DOT Pad. Hands off the keys.');
    setSyncState('syncing');
    let res;
    try {
      res = await runDotpadSync({ channel: ch, tracker: trackerRef.current, settleMs: 40, onPhase: setPhase });
    } finally {
      syncingRef.current = false;
    }
    setPhase(null);
    if (res.ok) {
      const scale = describeScale(res.metresPerPin);
      speakRef.current(`DOT Pad synced.${scale ? ` One pin is about ${scale.text}.` : ''}`);
    } else {
      setLastFailure(res.reason);
      speakRef.current(SYNC_FAILURE_TEXT[res.reason] || 'DOT Pad sync failed.');
    }
    refresh();
    // Console handle for live debugging: the last result and the tracker.
    if (typeof window !== 'undefined') window.dotpadLastSync = res;
    return res;
  }, [refresh, scheduler]);
  useEffect(() => { requestSyncRef.current = requestSync; }, [requestSync]);

  // positionChanged → the mirror; ready → start over.
  useEffect(() => {
    if (!channel) return undefined;
    const t = trackerRef.current;
    const offPosition = channel.onPosition((L) => {
      const r = t.observe(L);
      if (r.kind === 'ignored') return;
      if (r.becameStale) {
        speakRef.current(autoResyncRef.current
          ? 'DOT Pad scale changed — re-syncing.'
          : 'DOT Pad scale changed — press S to sync.');
      }
      // §5: only STALE arms the timer; each foreign move restarts the quiet period.
      if (autoResyncRef.current && t.state === 'stale' && r.kind !== 'echo') scheduler.poke();
      refresh();
    });
    const offMessage = channel.onMessage((type) => {
      if (type !== INBOUND.READY) return;
      scheduler.cancel();
      t.invalidate('ready');
      gateRef.current.lift();
      refresh();
      speakRef.current("Map loaded. Connect the DOT Pad in Audiom's display options, then press S to sync.");
    });
    if (typeof window !== 'undefined') window.dotpadTracker = t;
    return () => { offPosition(); offMessage(); scheduler.cancel(); };
  }, [channel, refresh, scheduler]);

  /**
   * Per camera frame: the fingertip in registration space, or null when no
   * pointing hand is tracked. §6.5 steps 1-5.
   *
   * @param {{u: number, v: number}|null} uv
   */
  const onUv = useCallback((uv) => {
    const now = performance.now();
    const t = trackerRef.current;
    const q = quantRef.current;
    const g = gateRef.current;
    const setFinger = (pin) => {
      if (samePin(fingerRef.current, pin)) return;
      fingerRef.current = pin;
      setFingerPin(pin);
    };

    // 1. No pointing hand, or off the pad: the finger is gone.
    const pin = uv ? q.update(uv.u, uv.v).pin : null;
    if (!uv) q.reset();
    if (!pin) { g.lift(); setFinger(null); inBandRef.current = false; return; }
    setFinger(pin);

    const inBand = !isInnerPin(pin, t.model?.geometry);
    if (inBand && !inBandRef.current) tick();
    inBandRef.current = inBand;

    if (t.state !== 'synced') {
      if (t.state !== 'syncing' && now - lastPromptRef.current > UNSYNCED_PROMPT_MS) {
        lastPromptRef.current = now;
        speakRef.current('DOT Pad not synced — press S.');
      }
      g.offer(null, now);
      return;
    }

    // 2. Border band → silent, no send, lastSentKey kept.
    const target = t.targetForPin(pin);
    if (!target) { g.offer(null, now); return; }

    // 3. Already there, or already on its way.
    const key = pinKey(pin);
    if (samePin(pin, t.avatarPin())) { g.acknowledge(key); return; }
    if (samePin(pin, t.pendingPin())) return;

    // 4. Rate-limited send, echo noted first.
    if (g.offer(key, now) && channelRef.current) {
      t.noteSent(target);
      channelRef.current.moveAvatar(target);
    }
  }, []);

  const setPreset = useCallback((id) => {
    const p = PRESETS[id];
    if (!p) return;
    gateRef.current.configure({ minIntervalMs: p.minIntervalMs, dwellMs: p.dwellMs });
    quantRef.current.setHysteresis(p.hysteresis);
    setPresetState(id);
    setHysteresisState(p.hysteresis);
  }, []);

  const setHysteresis = useCallback((h) => {
    quantRef.current.setHysteresis(h);
    setHysteresisState(h);
  }, []);

  const setAutoResync = useCallback((on) => {
    autoResyncRef.current = !!on;
    setAutoResyncState(!!on);
    if (!on) scheduler.cancel();
    else if (trackerRef.current.state === 'stale') scheduler.poke();
  }, [scheduler]);

  /**
   * Voice: "sync" / "sync DOT Pad" (L0 intent `dotpad_sync`). Returns true when
   * it handled the utterance, so the caller can route anything else onward.
   */
  const onUtterance = useCallback((transcript) => {
    if (matchL0(transcript)?.intent !== 'dotpad_sync') return false;
    requestSync();
    return true;
  }, [requestSync]);

  const statusText = useMemo(() => {
    switch (syncState) {
      case 'syncing':
        return `Syncing…${phase ? ` (${phase})` : ''}`;
      case 'synced': {
        const scale = describeScale(model?.metresPerPin);
        const bits = ['Synced'];
        if (scale) bits.push(`1 pin ≈ ${scale.text}`);
        if (model) bits.push(`heading ${Math.round(model.headingDeg)}°`);
        bits.push(`pages from anchor ${pages[0]}, ${pages[1]}`);
        return bits.join(' · ');
      }
      case 'stale':
        return autoResync
          ? 'Out of sync — re-syncing once the keys are quiet'
          : 'Out of sync — press S';
      default:
        return lastFailure
          ? `Not synced — ${SYNC_FAILURE_TEXT[lastFailure] || lastFailure}`
          : 'Not synced — connect the DOT Pad in Audiom, then press S';
    }
  }, [syncState, phase, model, pages, autoResync, lastFailure]);

  return {
    syncState,
    statusText,
    avatarPin,
    fingerPin,
    model,
    pages,
    requestSync,
    onUv,
    onUtterance,
    preset,
    setPreset,
    hysteresis,
    setHysteresis,
    autoResync,
    setAutoResync,
  };
}

export default useDotpadBridge;
