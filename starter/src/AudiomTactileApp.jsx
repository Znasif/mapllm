import { useCallback, useEffect, useRef, useState } from 'react';
import { parseAudiomId, parseAudiomSources, parseAudiomView, PREDEFINED_SOURCES } from './audiom';
import { AudiomMap } from './AudiomMap';
import { TactileExplorerGeneric } from './TactileExplorerGeneric';
import { SliderField } from './components/SliderField';
import { useDotpadBridge } from './hooks/useDotpadBridge';
import { PRESETS } from './lib/dotpadPins';
import { speak } from './lib/speak';
import asset from './lib/assetUrl';

/**
 * Audiom + CamIO on a DOT Pad (docs/dotpad-camio-design.md §7).
 *
 * Audiom renders its 60 × 40 tactile window onto the DOT Pad itself; this page
 * only (1) registers the pad in the camera, (2) mirrors Audiom's window from
 * `positionChanged` and (3) turns the fingertip into `moveAvatar` on the pin
 * under it. The window moves only when Audiom pages it (keyboard walking).
 *
 * This REPLACES the printed-material mode that used to live here (bounds
 * discovery, window fraction/pan, print aspect, the map overlay). Bounds
 * discovery in particular is gone on purpose: ~90 avatar moves would each be
 * pushed through the pad as a frame. `AudiomProbePanel.jsx` is left unused.
 */
export default function AudiomTactileApp() {
  const [sourceInput, setSourceInput] = useState('/maps/885');
  const [sources, setSources] = useState('');
  const [mapId, setMapId] = useState('');
  const [view, setView] = useState(null); // { centerLng, centerLat, zoom? } from a pasted URL
  const [error, setError] = useState('');
  const [channel, setChannel] = useState(null);
  const [showRectPanel, setShowRectPanel] = useState(true);
  const [registration, setRegistration] = useState({ phase: 'idle', isFixed: false });
  const actionsRef = useRef(null);

  const bridge = useDotpadBridge({ channel });
  const { requestSync } = bridge;

  // Stable identity: AudiomMap re-invokes onChannel whenever it changes.
  const handleChannel = useCallback(({ channel: ch }) => { setChannel(ch); }, []);
  const handleRegistration = useCallback((r) => { setRegistration(r); }, []);

  // Voice: "sync" / "sync DOT Pad"; anything else gets the old fallback line.
  const bridgeUtterance = bridge.onUtterance;
  const handleUtterance = useCallback((transcript) => {
    if (bridgeUtterance(transcript)) return;
    speak(`I heard, ${transcript}. Nothing is connected to answer that yet.`);
  }, [bridgeUtterance]);

  // S syncs. Like r / a / ; (TactileExplorerGeneric) it only works while focus
  // is outside the Audiom iframe — the iframe swallows keys (R9).
  useEffect(() => {
    function onKey(e) {
      if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 's' || e.key === 'S') { e.preventDefault(); requestSync(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [requestSync]);

  function load() {
    const raw = String(sourceInput || '').trim();
    if (!raw) { setError('Enter a map link, an embed id, a source, or a GeoJSON URL.'); return; }
    setSources(''); setMapId(''); setError('');

    // One id namespace since the `/d/` route was removed — see audiom.js.
    const mid = parseAudiomId(raw);
    if (mid) { setView(null); setMapId(mid); return; }
    // A dynamic source (e.g. osm) loads wherever the embed's center/zoom point,
    // so carry them over from a pasted `…?sources=osm&center=lng,lat&zoom=z`.
    const v = parseAudiomView(raw);
    setView(v.centerLng != null ? v : null);
    setSources(parseAudiomSources(raw) || raw);
  }

  const pick = (s) => {
    setSourceInput(s); setSources(s); setMapId(''); setView(null); setError('');
  };

  const loaded = sources || mapId;
  const pagesLabel = bridge.syncState === 'synced' || bridge.syncState === 'stale'
    ? `page ${bridge.pages[0]}, ${bridge.pages[1]}`
    : '';

  const syncButton = (
    <button
      type="button"
      className="tactile-fix-btn"
      onClick={() => requestSync()}
      disabled={!channel || bridge.syncState === 'syncing'}
      title="Measure Audiom's pin grid and re-anchor the DOT Pad window (press S)"
    >
      {bridge.syncState === 'syncing' ? '⏳ Syncing…' : '⇄ Sync DOT Pad [ s ]'}
    </button>
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <header className="sidebar-header">
          <div>
            <p className="eyebrow">Audiom · DOT Pad · CamIO</p>
            <h1>Tactile Audiom Explorer</h1>
          </div>
          <p className="subtle">
            Audiom draws the map on the DOT Pad. Point at a pin and the avatar goes
            there; walk with the arrow keys and Audiom pages the pad.
          </p>
          <a href={asset('index.html')} style={{ display: 'inline-block', marginTop: '0.5rem', fontSize: '0.85rem', fontWeight: 600, color: '#2563eb', textDecoration: 'none' }}>
            ← Door-to-Door (OSM) mode
          </a>
        </header>

        <section className="panel-section">
          <h2>Map</h2>
          <div className="geocoder">
            <input
              className="geocoder-input"
              placeholder="/maps/885 · 570 · osm · https://…/data.geojson"
              value={sourceInput}
              onChange={(e) => setSourceInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') load(); }}
              aria-label="Audiom map, embed id, or data source"
            />
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', margin: '0.5rem 0' }}>
            {PREDEFINED_SOURCES.map((s) => (
              <button key={s} type="button" onClick={() => pick(s)}
                style={{
                  fontSize: '0.75rem', padding: '0.2rem 0.5rem', borderRadius: '0.4rem',
                  border: '1px solid #cbd5e1', cursor: 'pointer',
                  background: sources === s ? '#2563eb' : '#fff',
                  color: sources === s ? '#fff' : '#334155',
                }}>{s}</button>
            ))}
          </div>
          <button type="button" className="primary-button" onClick={load}>Load</button>
          {mapId ? <p className="point-meta">map id {mapId} · /embed/{mapId}</p> : null}
          {!mapId && sources ? <p className="point-meta">source: {sources}</p> : null}
          {error ? <p className="error-text">{error}</p> : null}
        </section>

        <section className="panel-section">
          <h2>DOT Pad</h2>
          <p className="point-meta" aria-live="polite" role="status" style={{ fontSize: '0.95rem' }}>
            {bridge.statusText}
          </p>
          <p className="point-meta">
            camera: {registration.phase === 'ready' ? `registered${registration.isFixed ? ' (fixed)' : ''}` : registration.phase}
            {bridge.fingerPin ? ` · finger pin ${bridge.fingerPin[0]},${bridge.fingerPin[1]}` : ''}
            {bridge.avatarPin ? ` · avatar pin ${bridge.avatarPin[0]},${bridge.avatarPin[1]}` : ''}
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', margin: '0.5rem 0' }}>
            <button type="button" className="primary-button" onClick={() => requestSync()}
              disabled={!channel || bridge.syncState === 'syncing'}>
              Sync DOT Pad [S]
            </button>
            <button type="button" onClick={() => actionsRef.current?.register()}>Register corners [R]</button>
            <button type="button" onClick={() => actionsRef.current?.autoFind()}>Auto-find pad [A]</button>
            <button type="button" onClick={() => actionsRef.current?.toggleFixed()}
              disabled={registration.phase !== 'ready'}>
              {registration.isFixed ? 'Unfix [;]' : 'Fix [;]'}
            </button>
          </div>

          <label className="slider-field">
            <span>DOT Pad model</span>
            <select value={bridge.preset} onChange={(e) => bridge.setPreset(e.target.value)}>
              {Object.values(PRESETS).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} — {p.dwellMs ? `${p.dwellMs} ms dwell, ` : ''}{p.minIntervalMs} ms between moves
                </option>
              ))}
            </select>
          </label>
          <SliderField
            label={`Pin hysteresis: ${bridge.hysteresis.toFixed(2)} pin`}
            min={0} max={1} step={0.05}
            value={bridge.hysteresis} onChange={bridge.setHysteresis}
          />
          <label className="switch-row">
            <input type="checkbox" checked={bridge.autoResync}
              onChange={(e) => bridge.setAutoResync(e.target.checked)} />
            <span>Auto-resync when the scale changes</span>
          </label>
          <label className="switch-row">
            <input type="checkbox" checked={showRectPanel}
              onChange={(e) => setShowRectPanel(e.target.checked)} />
            <span>Show the rectified pin grid</span>
          </label>
          <p className="subtle" style={{ fontSize: '0.75rem' }}>
            Connect the pad inside Audiom first (Display options → DOT Pad). Press
            <kbd>S</kbd> after connecting — and again after any reconnect. Host keys
            (<kbd>S</kbd> <kbd>R</kbd> <kbd>A</kbd> <kbd>;</kbd>) only work while focus is
            outside the map: <kbd>Shift</kbd>+<kbd>Tab</kbd> out of it, or say “sync”.
            The outer two pins on each edge never move the avatar.
          </p>
        </section>

        <section className="panel-section compact">
          <h2>How to use</h2>
          <ol className="entrance-list" style={{ listStyle: 'decimal', paddingLeft: '1.25rem' }}>
            <li>Load a map. In Audiom's display options, connect the DOT Pad (Bluetooth or USB).</li>
            <li>Register the pad: <kbd>R</kbd> and point at each corner <strong>pin</strong> (TL → TR → BR → BL, ~1.5 s each), or <kbd>A</kbd> to auto-find it with your hands off.</li>
            <li>Press <kbd>S</kbd> to sync. Audiom switches to grid mode and steps the avatar a few times.</li>
            <li>Point at a pin — the avatar goes there. Walk with the arrows; Audiom pages the pad and the finger follows.</li>
            <li>No pad? Turn on Audiom's tactile pin view and compare it with the rectified pin grid.</li>
          </ol>
        </section>
      </aside>

      <main className="map-panel">
        {loaded ? (
          <>
            <AudiomMap
              fill
              mapId={mapId} sources={sources}
              view={view} syncView={!!view}
              autoDrive={false}
              onChannel={handleChannel}
              onUtterance={handleUtterance}
            />
            <TactileExplorerGeneric
              onUv={bridge.onUv}
              avatarPin={bridge.avatarPin}
              fingerPin={bridge.fingerPin}
              pagesLabel={pagesLabel}
              showRectPanel={showRectPanel}
              actionsRef={actionsRef}
              onRegistrationChange={handleRegistration}
              leadingControls={syncButton}
            />
          </>
        ) : (
          <div className="map-placeholder">
            <div>
              <h2>Load a map to begin</h2>
              <p>Try <code>/maps/885</code>, <code>570</code>, or <code>osm</code>.</p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
