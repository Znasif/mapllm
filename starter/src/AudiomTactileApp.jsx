import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { parseAudiomId, parseAudiomSources, parseAudiomView, viewForPlace, PREDEFINED_SOURCES, AUDIOM_DEFAULT_MAP } from './audiom';
import { forwardLookup, featureToPoint, featureToLabel, featureToBbox } from './lib/geocoding';
import { AudiomMap } from './AudiomMap';
import { TactileExplorerGeneric } from './TactileExplorerGeneric';
import { SliderField } from './components/SliderField';
import { useDotpadBridge } from './hooks/useDotpadBridge';
import { useAnnouncer } from './hooks/useAnnouncer';
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
 *
 * This page never speaks: the Audiom map it embeds does the talking. The
 * page's own status and instructions (sync, corner prompts, geocoding, camera
 * errors) go through ONE `announce` (hooks/useAnnouncer.js) into the live
 * regions at the top of the sidebar, for the user's screen reader and for a
 * sighted helper. (The hidden mic path below still speaks; it is not shown.)
 */
const MAPBOX_TOKEN = (import.meta.env.VITE_MAPBOX_TOKEN || '').trim();

// ?pointer=camio swaps the camera pointer for the camio-pointer library
// (CamioPointerPanel, a lazy chunk; same props). Default: TactileExplorerGeneric.
const CamioPointerPanel = lazy(() => import('./CamioPointerPanel').then((m) => ({ default: m.CamioPointerPanel })));
const PointerPanel = new URLSearchParams(window.location.search).get('pointer') === 'camio'
  ? CamioPointerPanel
  : TactileExplorerGeneric;

// HARD-CODE (Pages): open a map on load — `?map=<id|link>` first, else the
// build-time VITE_AUDIOM_DEFAULT_MAP (see audiom.js). The Load field still works.
const INITIAL_MAP = new URLSearchParams(window.location.search).get('map') || AUDIOM_DEFAULT_MAP;
const INITIAL_MAP_ID = parseAudiomId(INITIAL_MAP) || '';

export default function AudiomTactileApp() {
  const [sourceInput, setSourceInput] = useState(INITIAL_MAP || '/maps/885');
  const [sources, setSources] = useState('');
  const [mapId, setMapId] = useState(INITIAL_MAP_ID);
  const [view, setView] = useState(null); // { centerLng, centerLat, zoom?, anchors?, extent? }
  const [place, setPlace] = useState('');  // geocoded label when the field held an address
  const [searching, setSearching] = useState(false);
  const geocodeAbortRef = useRef(null);
  const [error, setError] = useState('');
  const [channel, setChannel] = useState(null);
  const [showRectPanel, setShowRectPanel] = useState(true);
  const [registration, setRegistration] = useState({ phase: 'idle', isFixed: false });
  const actionsRef = useRef(null);
  const { polite: announcement, assertive: alertText, announce } = useAnnouncer();

  const bridge = useDotpadBridge({ channel, announce });
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

  async function load() {
    const raw = String(sourceInput || '').trim();
    if (!raw) { setError('Enter a map link, an embed id, a source, a GeoJSON URL, or an address.'); return; }
    geocodeAbortRef.current?.abort();
    setSources(''); setMapId(''); setError(''); setPlace('');

    // One id namespace since the `/d/` route was removed — see audiom.js.
    const mid = parseAudiomId(raw);
    if (mid) { setView(null); setMapId(mid); return; }

    // Anything that is not a link, an id or a known source is a place to look
    // up ("golden gate park", "2318 Fillmore St"). Audiom's own address search
    // is UI-only (Google Places in its map form), so geocode here and hand the
    // embed an OSM area in its AOI contract.
    const urlish = /^(https?:)?\/\/|^[/?]|[?&=]/.test(raw);
    const known = PREDEFINED_SOURCES.some((s) => s.toLowerCase() === raw.toLowerCase());
    if (!urlish && !known) {
      if (!MAPBOX_TOKEN) { setError('Address search needs VITE_MAPBOX_TOKEN in .env.'); return; }
      const ac = new AbortController();
      geocodeAbortRef.current = ac;
      setSearching(true);
      try {
        const feature = (await forwardLookup(raw, MAPBOX_TOKEN, null, ac.signal))[0];
        const point = featureToPoint(feature);
        if (!point) {
          setError(`No place found for “${raw}”.`);
          announce(`No place found for ${raw}.`);
          return;
        }
        const label = featureToLabel(feature) || raw;
        setPlace(label);
        setView(viewForPlace(point, featureToBbox(feature)));
        setSources('osm');
        announce(`Loading the map around ${label}.`);
      } catch (e) {
        if (e?.name !== 'AbortError') setError(`Address search failed: ${e.message}`);
      } finally {
        if (geocodeAbortRef.current === ac) setSearching(false);
      }
      return;
    }
    // A dynamic source (e.g. osm) loads the area the URL names, so carry it over
    // from a pasted `…?sources=osm&center=lng,lat&zoom=z` or an audiom.net
    // `/map?anchors=…&extent=…` link (no `sources` there: those are OSM maps).
    const v = parseAudiomView(raw);
    setView(v.centerLng != null ? v : null);
    setSources(parseAudiomSources(raw) || (v.anchors && /[?&]anchors=/.test(raw) ? 'osm' : raw));
  }

  const pick = (s) => {
    geocodeAbortRef.current?.abort();
    setSourceInput(s); setSources(s); setMapId(''); setView(null); setError(''); setPlace('');
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

        <section className="panel-section">
          <h2>Map</h2>
          <div className="geocoder">
            <input
              className="geocoder-input"
              placeholder="Golden Gate Park · 2318 Fillmore St · /maps/885 · osm · https://…/data.geojson"
              value={sourceInput}
              onChange={(e) => setSourceInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') load(); }}
              aria-label="Address or place, Audiom map, embed id, or data source"
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
          <button type="button" className="primary-button" onClick={load} disabled={searching}>
            {searching ? 'Finding place…' : 'Load'}
          </button>
          {place ? <p className="point-meta">place: {place} · {view?.extent === 'bbox' ? 'whole area' : 'about 360 m around it'}</p> : null}
          {mapId ? <p className="point-meta">map id {mapId} · /embed/{mapId}</p> : null}
          {!mapId && sources ? <p className="point-meta">source: {sources}</p> : null}
          {error ? <p className="error-text">{error}</p> : null}
        </section>

        <section className="panel-section">
          <h2>DOT Pad</h2>
          <p className="point-meta" style={{ fontSize: '0.95rem' }}>
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
            min={0} max={3} step={0.25}
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
            <Suspense fallback={null}>
              <PointerPanel
                onUv={bridge.onUv}
                avatarPin={bridge.avatarPin}
                fingerPin={bridge.fingerPin}
                pagesLabel={pagesLabel}
                showRectPanel={showRectPanel}
                actionsRef={actionsRef}
                onRegistrationChange={handleRegistration}
                leadingControls={syncButton}
                announce={announce}
              />
            </Suspense>
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
