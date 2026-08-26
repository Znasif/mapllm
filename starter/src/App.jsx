import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

import Sidebar from './components/Sidebar';
import MapCanvas from './components/MapCanvas';
import LocationSearch from './components/LocationSearch';
import TactilePanel from './components/TactilePanel';
import { useMapbox, GH_HQ } from './hooks/useMapbox';
import { usePinGrid } from './hooks/usePinGrid';
import { useMapioDispatcher } from './hooks/useMapioDispatcher';
import { featureToPoint, featureToLabel, reverseLookup } from './lib/geocoding';
import { syncPointMarker } from './lib/mapMarkers';
import asset from './lib/assetUrl';
import { TactileExplorer } from './TactileExplorer';
import { AudiomAvatar } from './AudiomAvatar';

/**
 * Tactile Map Explorer.
 *
 * Composition root only — map lifecycle lives in useMapbox, grid derivation in
 * usePinGrid, and the panels are presentational components.
 */
export default function App() {
  const mapboxToken = (import.meta.env.VITE_MAPBOX_TOKEN || '').trim();

  // Location
  const [query, setQuery] = useState('');
  const [point, setPoint] = useState(null);

  // Tactile grid
  const [showTactile, setShowTactile] = useState(true);
  const [pinScale, setPinScale] = useState(5000);
  const [bboxPadding, setBboxPadding] = useState(0.15);
  const [showExplorer, setShowExplorer] = useState(false);
  const [showAudiom, setShowAudiom] = useState(false);
  const [groundTruthProbe, setGroundTruthProbe] = useState(null);

  const placeMarkerRef = useRef(null);
  const probeMarkerRef = useRef(null);
  const fingerCoordRef = useRef(null);
  const cornerFractionsRef = useRef(null);
  const [llmBackend, setLlmBackend] = useState('wllama');

  // MapIO Dispatcher & Map selection hook
  const {
    selectedMapKey,
    setSelectedMapKey,
    selectedMap,
    MAPIO_MAPS,
    isLoadingMap,
    mapInfo,
    isListening,
    transcript,
    lastAnswer,
    isProcessing,
    toggleListening,
    handleQuery,
    setTranscript,
    wllamaStatus,
    sttNotice,
    canInstallStt,
    installStt,
    installingStt,
  } = useMapioDispatcher({ coordRef: fingerCoordRef, backend: llmBackend });

  // Bias geocoder results toward what the user is looking at.
  const proximity = useMemo(
    () => (point ? { lng: point.lng, lat: point.lat } : { lng: GH_HQ.lng, lat: GH_HQ.lat }),
    [point],
  );

  const explorerActive = showExplorer && showTactile;
  const handleMapClick = useCallback(
    async (clicked) => {
      if (explorerActive) {
        setGroundTruthProbe(clicked);
        return;
      }
      setPoint(clicked);
      setQuery(await reverseLookup(clicked, mapboxToken));
    },
    [explorerActive, mapboxToken],
  );

  const { mapContainerRef, mapRef, mapLoadedRef } = useMapbox({
    mapboxToken,
    onMapClick: handleMapClick,
  });

  const { pinBbox, pinGridRawRef } = usePinGrid({
    mapRef,
    mapLoadedRef,
    showTactile,
    showExplorer,
    pinScale,
    bboxPadding,
    cornerFractionsRef,
  });

  // Corner fractions shrink the full-device bbox down to just the pin area.
  //
  // brailledoodle_corners.json stores the four calibrated corners as PIXEL
  // coordinates in braille.png — its own key is the path to that file — so they
  // only become fractions once divided by THAT image's natural dimensions.
  //
  // ⚠️ The divisor is deliberately NOT `selectedMap.templateUrl`. Dividing
  // braille.png's pixels by a MapIO template's dimensions silently rescales the
  // grid by the ratio between two unrelated images, and non-uniformly, so the
  // ASPECT RATIO changes too. Measured with new_york/template.png (1920x1824
  // against braille.png's 1271x909): the artwork area went from 0.786 x 0.789
  // of the sheet at aspect 0.996 to 0.520 x 0.393 at aspect 1.324, shifted hard
  // toward the top-left. The mask fill is derived from the same bbox, so the
  // transparency moves with it and the whole grid "looks different".
  //
  // Per-map calibration is a real need, but it needs a corners file PER
  // template. Until one exists, only the physical braille sheet is calibrated.
  useEffect(() => {
    let cancelled = false;

    Promise.all([
      fetch(asset('brailledoodle_corners.json')).then((r) => r.json()),
      new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => resolve(null);
        img.src = asset('braille.png');
      }),
    ])
      .then(([cornersData, dims]) => {
        if (cancelled || !cornersData || !dims) return;
        const corners = Object.values(cornersData)[0];
        if (!corners || corners.length < 4) return;

        const [tl, tr, br, bl] = corners;
        cornerFractionsRef.current = {
          left: Math.min(tl[0], bl[0]) / dims.w,
          right: Math.max(tr[0], br[0]) / dims.w,
          top: Math.min(tl[1], tr[1]) / dims.h,
          bottom: Math.max(bl[1], br[1]) / dims.h,
        };
      })
      .catch(() => { /* uncalibrated: usePinGrid falls back to the full bbox */ });

    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    syncPointMarker(mapRef.current, placeMarkerRef, point, 'place');
  }, [mapRef, point]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !point) return;
    map.easeTo({ center: [point.lng, point.lat], duration: 600 });
  }, [mapRef, point]);

  useEffect(() => {
    if (!explorerActive) setGroundTruthProbe(null);
  }, [explorerActive]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (!groundTruthProbe) {
      probeMarkerRef.current?.remove();
      probeMarkerRef.current = null;
      return;
    }

    if (!probeMarkerRef.current) {
      const el = document.createElement('div');
      el.className = 'probe-marker';
      el.innerHTML = '✛';
      probeMarkerRef.current = new mapboxgl.Marker({ element: el, anchor: 'center' })
        .setLngLat([groundTruthProbe.lng, groundTruthProbe.lat])
        .addTo(map);
    } else {
      probeMarkerRef.current.setLngLat([groundTruthProbe.lng, groundTruthProbe.lat]);
    }
  }, [mapRef, groundTruthProbe]);

  const handleSelectFeature = useCallback((feature) => {
    const selected = featureToPoint(feature);
    if (!selected) return;
    const label = featureToLabel(feature);
    setPoint({ ...selected, label });
    setQuery(label);
  }, []);

  return (
    <div className="app-shell">
      <Sidebar>
        <LocationSearch
          query={query}
          onQueryChange={setQuery}
          point={point}
          onSelectFeature={handleSelectFeature}
          accessToken={mapboxToken}
          proximity={proximity}
        />
        <TactilePanel
          showTactile={showTactile}
          onShowTactileChange={setShowTactile}
          pinScale={pinScale}
          onPinScaleChange={setPinScale}
          bboxPadding={bboxPadding}
          onBboxPaddingChange={setBboxPadding}
          showExplorer={showExplorer}
          onShowExplorerChange={setShowExplorer}
          showAudiom={showAudiom}
          onShowAudiomChange={setShowAudiom}
          hasMapboxToken={Boolean(mapboxToken)}
          // MapIO props
          selectedMapKey={selectedMapKey}
          onSelectMapKey={setSelectedMapKey}
          MAPIO_MAPS={MAPIO_MAPS}
          isLoadingMap={isLoadingMap}
          mapInfo={mapInfo}
          isListening={isListening}
          toggleListening={toggleListening}
          transcript={transcript}
          lastAnswer={lastAnswer}
          isProcessing={isProcessing}
          handleQuery={handleQuery}
          setTranscript={setTranscript}
          llmBackend={llmBackend}
          onLlmBackendChange={setLlmBackend}
          wllamaStatus={wllamaStatus}
          sttNotice={sttNotice}
          canInstallStt={canInstallStt}
          installStt={installStt}
          installingStt={installingStt}
        />
      </Sidebar>

      <MapCanvas containerRef={mapContainerRef} hasToken={Boolean(mapboxToken)}>
        {showExplorer && showTactile && (
          <TactileExplorer
            key={selectedMapKey}
            bbox={pinBbox}
            mapRef={mapRef}
            mapLoadedRef={mapLoadedRef}
            templateUrl={asset(selectedMap.templateUrl)}
            pinGridRef={pinGridRawRef}
            onCoord={(coord) => { fingerCoordRef.current = coord; }}
            groundTruthProbe={groundTruthProbe}
          />
        )}

        {showAudiom && showTactile && (
          <AudiomAvatar bbox={pinBbox} coordRef={fingerCoordRef} throttleMs={1000} />
        )}
      </MapCanvas>
    </div>
  );
}

