import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { parseAudiomId, AUDIOM_DEFAULT_MAP } from './audiom';
import { AudiomMap } from './AudiomMap';
import { useAnnouncer } from './hooks/useAnnouncer';
import { PAPER_MAP_ID, bboxFromSearch, pointToLngLat } from './lib/paperMap';
import { speak } from './lib/speak';

/**
 * Audiom map 885 + a camera pointer for a printed copy of it.
 *
 * The camio-pointer library (CamioPointerPanel, a lazy chunk) registers the
 * sheet by its four corner marks and reports the pointing fingertip as (u, v);
 * each 'point' moves Audiom's avatar to `pointToLngLat(u, v, BBOX)`
 * (lib/paperMap.js) and an open hand sends Audiom's `stopSpeech`.
 *
 * This page never speaks: the Audiom map it embeds does the talking. Its own
 * status and prompts go through ONE `announce` (hooks/useAnnouncer.js) into the
 * live regions at the top of the sidebar. (The hidden mic path still speaks; it
 * is not shown.)
 */
const CamioPointerPanel = lazy(() => import('./CamioPointerPanel').then((m) => ({ default: m.CamioPointerPanel })));

const MAP_ID = parseAudiomId(AUDIOM_DEFAULT_MAP) || PAPER_MAP_ID;
// The printed frame's corners in lng/lat; `?bbox=w,s,e,n` overrides for calibration.
const BBOX = bboxFromSearch(typeof window !== 'undefined' ? window.location.search : '');

export default function AudiomTactileApp() {
  const [channel, setChannel] = useState(null);
  const [camera, setCamera] = useState({ phase: 'idle', isFixed: false, text: 'Starting camera', cameraError: false });
  const actionsRef = useRef(null);
  const channelRef = useRef(null);
  useEffect(() => { channelRef.current = channel; }, [channel]);
  const { polite: announcement, assertive: alertText, announce } = useAnnouncer();

  // Stable identities: AudiomMap re-invokes onChannel whenever it changes.
  const handleChannel = useCallback(({ channel: ch }) => { setChannel(ch); }, []);
  const handleStatus = useCallback((s) => { setCamera(s); }, []);

  /** A 'point' (or any { u, v }) → the avatar. Returns the [lng, lat] sent, or null. */
  const handlePoint = useCallback((p) => {
    const pos = pointToLngLat(p, BBOX);
    if (!pos || !channelRef.current?.moveAvatar(pos)) return null;
    return pos;
  }, []);
  const handleOpenHand = useCallback(() => { channelRef.current?.executeCommand('stopSpeech'); }, []);

  // Console handle for calibration: paperPoint({ u: 0, v: 0 }) moves the avatar
  // to the top-left corner of the frame, through the same path as a 'point'.
  useEffect(() => {
    window.paperPoint = handlePoint;
    return () => { if (window.paperPoint === handlePoint) delete window.paperPoint; };
  }, [handlePoint]);

  const handleUtterance = useCallback((transcript) => {
    speak(`I heard, ${transcript}. Nothing is connected to answer that yet.`);
  }, []);

  const ready = camera.phase === 'ready';

  // ≤980px, styles.css flattens the sidebar (display: contents) and reorders:
  // header, status, Camera, the map, the camera preview, then How to use.
  return (
    <div className="app-shell app-shell--audiom">
      <aside className="sidebar">
        <header className="sidebar-header">
          <div>
            <p className="eyebrow">Audiom · CamIO</p>
            <h1>Tactile Audiom Explorer</h1>
          </div>
          <p className="subtle">
            Point at the printed map and the avatar goes there.
          </p>
        </header>

        {/* The page's only live regions (see the header comment): the
            announcer clears then sets the text, so a repeated prompt is read
            again. Always rendered — a live region added with its text is not. */}
        <section className="panel-section compact">
          <p className="point-meta" role="status" aria-live="polite" aria-atomic="true"
            style={{ fontSize: '0.95rem', margin: 0, minHeight: '1.3em' }}>
            {announcement}
          </p>
          <p className="error-text" role="alert" aria-live="assertive" aria-atomic="true" style={{ margin: 0 }}>
            {alertText}
          </p>
        </section>

        <section className="panel-section camera-section">
          <h2>Camera</h2>
          <p className="point-meta" style={{ fontSize: '0.95rem' }}>{camera.text}</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', margin: '0.5rem 0' }}>
            <button type="button" className="primary-button" onClick={() => actionsRef.current?.register()}>
              {ready ? 'Re-register corners [R]' : 'Register corners [R]'}
            </button>
            <button type="button" onClick={() => actionsRef.current?.toggleFixed()} disabled={!ready}>
              {camera.isFixed ? 'Unfix [;]' : 'Fix [;]'}
            </button>
            {camera.cameraError && (
              <button type="button" onClick={() => actionsRef.current?.retry()}>Retry camera</button>
            )}
          </div>
          <p className="subtle keyboard-hint" style={{ fontSize: '0.75rem' }}>
            Keys work while focus is outside the map (<kbd>Shift</kbd>+<kbd>Tab</kbd> out of it).
          </p>
        </section>

        <section className="panel-section compact howto-section">
          <h2>How to use</h2>
          <ol className="entrance-list" style={{ listStyle: 'decimal', paddingLeft: '1.25rem' }}>
            <li>Print the map and lay it under the camera.</li>
            <li>Tap <strong>Register corners</strong> (or press <kbd>R</kbd>), then point at each corner mark and hold: top-left, top-right, bottom-right, bottom-left.</li>
            <li>Point at the map to move the avatar.</li>
            <li>Open your hand to stop speech.</li>
          </ol>
        </section>
      </aside>

      <main className="map-panel">
        <AudiomMap
          fill
          mapId={MAP_ID}
          autoDrive={false}
          onChannel={handleChannel}
          onUtterance={handleUtterance}
        />
        <Suspense fallback={null}>
          <CamioPointerPanel
            onPoint={handlePoint}
            onOpenHand={handleOpenHand}
            onStatus={handleStatus}
            actionsRef={actionsRef}
            announce={announce}
          />
        </Suspense>
      </main>
    </div>
  );
}
