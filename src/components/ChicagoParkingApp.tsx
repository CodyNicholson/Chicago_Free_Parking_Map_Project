import { useState, useEffect, useMemo, useRef, useCallback, FormEvent, KeyboardEvent } from 'react';
import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  CurbProperties,
  DailyOverrides,
  DAYS_OF_WEEK,
  NEIGHBORHOODS,
} from '../types/parking';
import {
  evaluateCurbAvailability,
  formatDuration,
  formatSlotTime,
  getChicagoCurrentDayAndSlot,
} from '../utils/curbEvaluator';
import {
  CurbFeature,
  findNearestCurbToLngLat,
  interpolateCurbCoordinate,
  matchNeighborhoodByName,
  parseChicagoAddressQuery,
  searchCurbFeatures,
} from '../utils/addressSearch';

interface HoverPopupState {
  x: number;
  y: number;
  curb: CurbProperties;
}

export default function ChicagoParkingApp() {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const searchMarkerRef = useRef<maplibregl.Marker | null>(null);
  const [mapLoaded, setMapLoaded] = useState<boolean>(false);

  // Default to Saturday 1:45 PM (slot 55)
  const [selectedDay, setSelectedDay] = useState<number>(6);
  const [selectedSlot, setSelectedSlot] = useState<number>(55);
  const [minDurationHours, setMinDurationHours] = useState<number>(0); // 0 = Any free, 2 = 2h+, 4 = 4h+, 10 = Overnight
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [highlightedIndex, setHighlightedIndex] = useState<number>(0);
  const [isDropdownOpen, setIsDropdownOpen] = useState<boolean>(false);
  const [searchStatusMsg, setSearchStatusMsg] = useState<string | null>(null);

  const [selectedCurb, setSelectedCurb] = useState<CurbProperties | null>(null);
  const [hoverPopup, setHoverPopup] = useState<HoverPopupState | null>(null);

  const [curbFeatures, setCurbFeatures] = useState<CurbFeature[]>([]);
  const [evalTimeMs, setEvalTimeMs] = useState<number>(0.2);
  const [freeCurbCount, setFreeCurbCount] = useState<number>(0);

  const [overrides, setOverrides] = useState<DailyOverrides>({
    isWinterBanSeason: false,
    isTwoInchSnowBanActive: false,
    activeSweepingWardSectionsToday: ['35-04', '01-02'],
  });

  // Fetch overrides_today.json and city-wide compiled curb GeoJSON on mount
  useEffect(() => {
    fetch('/data/overrides_today.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && Array.isArray(data.activeSweepingWardSectionsToday)) {
          setOverrides({
            generatedAt: data.generatedAt,
            timezone: data.timezone,
            isWinterBanSeason: Boolean(data.isWinterBanSeason),
            isTwoInchSnowBanActive: Boolean(data.isTwoInchSnowBanActive),
            activeSweepingWardSectionsToday: data.activeSweepingWardSectionsToday,
          });
        }
      })
      .catch(() => {
        // Keep default overrides if offline
      });

    fetch('/data/chicago_curbs.geojson')
      .then((r) => r.json())
      .then((geojson) => {
        if (geojson && Array.isArray(geojson.features)) {
          setCurbFeatures(geojson.features);
        }
      })
      .catch((err) => {
        console.error('Failed to load chicago_curbs.geojson:', err);
      });
  }, []);

  // Group city-wide curb features by unique schedule key for O(1) GPU style evaluation
  const scheduleBuckets = useMemo(() => {
    const map = new Map<string, { sample: CurbProperties; count: number }>();
    for (let i = 0; i < curbFeatures.length; i++) {
      const props = curbFeatures[i].properties;
      const key =
        props.sched_key ||
        `${props.mask_hex.slice(0, 16)}:${props.w_sec}:${props.w_ban ? 1 : 0}:${props.s_route ? 1 : 0}`;
      const existing = map.get(key);
      if (existing) {
        existing.count++;
      } else {
        map.set(key, { sample: props, count: 1 });
      }
    }
    return map;
  }, [curbFeatures]);

  // Evaluate selected curb whenever time slider, day, overrides, or selected street changes
  const selectedCurbEval = useMemo(() => {
    if (!selectedCurb) return null;
    return evaluateCurbAvailability(selectedCurb, selectedDay, selectedSlot, overrides);
  }, [selectedCurb, selectedDay, selectedSlot, overrides]);

  // Evaluate hovered curb for instant desktop tooltip
  const hoverCurbEval = useMemo(() => {
    if (!hoverPopup) return null;
    return evaluateCurbAvailability(hoverPopup.curb, selectedDay, selectedSlot, overrides);
  }, [hoverPopup, selectedDay, selectedSlot, overrides]);

  // Smart Chicago address & street search results (supports exact house numbers e.g. "2420 N Kedzie")
  const searchResults = useMemo(() => {
    return searchCurbFeatures(searchQuery, curbFeatures, 8);
  }, [searchQuery, curbFeatures]);

  // Initialize MapLibre GL JS defaulted to City-Wide Chicago view showing all streets
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const pmtilesProtocol = new Protocol();
    maplibregl.addProtocol('pmtiles', pmtilesProtocol.tile);

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
      center: [-87.6550, 41.8820], // City-wide Chicago overview default
      zoom: 11.6,
      minZoom: 9.5,
      maxZoom: 18.5,
      pitch: 0,
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

    map.on('load', () => {
      const pmtilesUrl = import.meta.env.VITE_PMTILES_URL as string | undefined;

      if (pmtilesUrl) {
        map.addSource('chicago_curbs', {
          type: 'vector',
          url: `pmtiles://${pmtilesUrl}`,
        });
      } else {
        map.addSource('chicago_curbs', {
          type: 'geojson',
          data: '/data/chicago_curbs.geojson',
          promoteId: 'curb_id',
        });
      }

      // Outer glow layer for selected curb
      map.addLayer({
        id: 'curb-selected-glow',
        type: 'line',
        source: 'chicago_curbs',
        ...(pmtilesUrl ? { 'source-layer': 'chicago_curbs' } : {}),
        filter: ['==', ['get', 'curb_id'], -1],
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
        paint: {
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 5, 14, 9, 18, 16],
          'line-color': '#38BDF8',
          'line-opacity': 0.85,
          'line-blur': 1.5,
        },
      });

      // Main city-wide curb schedule line layer visible across all zoom levels
      map.addLayer({
        id: 'curb-lines',
        type: 'line',
        source: 'chicago_curbs',
        ...(pmtilesUrl ? { 'source-layer': 'chicago_curbs' } : {}),
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
        paint: {
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            10,
            1.4,
            11.6,
            2.1,
            13.5,
            3.2,
            15.5,
            5.2,
            18,
            9.0,
          ],
          'line-color': '#10B981',
          'line-opacity': 0.9,
        },
      });

      // Click handler for both desktop and mobile tap
      map.on('click', 'curb-lines', (e) => {
        if (!e.features || e.features.length === 0) return;
        const props = e.features[0].properties as unknown as CurbProperties;
        setSelectedCurb({
          ...props,
          curb_id: Number(props.curb_id),
          w_ban: props.w_ban === true || (props.w_ban as unknown) === 'true',
          s_route: props.s_route === true || (props.s_route as unknown) === 'true',
        });
      });

      // Hover handler for desktop instant preview
      map.on('mousemove', 'curb-lines', (e) => {
        map.getCanvas().style.cursor = 'pointer';
        if (!e.features || e.features.length === 0) return;
        const props = e.features[0].properties as unknown as CurbProperties;
        setHoverPopup({
          x: e.point.x,
          y: e.point.y,
          curb: {
            ...props,
            curb_id: Number(props.curb_id),
            w_ban: props.w_ban === true || (props.w_ban as unknown) === 'true',
            s_route: props.s_route === true || (props.s_route as unknown) === 'true',
          },
        });
      });

      map.on('mouseleave', 'curb-lines', () => {
        map.getCanvas().style.cursor = '';
        setHoverPopup(null);
      });

      setMapLoaded(true);
    });

    mapRef.current = map;
    return () => {
      searchMarkerRef.current?.remove();
      maplibregl.removeProtocol('pmtiles');
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Re-evaluate all city-wide schedule buckets in < 0.3ms & update WebGL GPU paint expressions
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded || scheduleBuckets.size === 0) return;

    const t0 = performance.now();
    const minMinutesRequired = minDurationHours * 60;
    let qualifyingFreeCount = 0;

    const colorMatchArgs: (string | unknown[])[] = ['match', ['get', 'sched_key']];
    const opacityMatchArgs: (string | number | unknown[])[] = ['match', ['get', 'sched_key']];

    scheduleBuckets.forEach(({ sample, count }, schedKey) => {
      const evaluation = evaluateCurbAvailability(
        sample,
        selectedDay,
        selectedSlot,
        overrides
      );

      const meetsMinDuration =
        minDurationHours === 0
          ? true
          : evaluation.isFreeNow &&
            (evaluation.isFree24_7 || evaluation.remainingMinutes >= minMinutesRequired);

      if (evaluation.isFreeNow && meetsMinDuration) {
        qualifyingFreeCount += count;
      }

      const color =
        evaluation.statusTier === 'free_long'
          ? '#10B981' // Emerald-500 (Free 2h+)
          : evaluation.statusTier === 'free_ending_soon'
          ? '#F59E0B' // Amber-500 (Ends < 2h)
          : '#F43F5E'; // Rose-500 (Restricted now)

      colorMatchArgs.push(schedKey, color);
      opacityMatchArgs.push(schedKey, meetsMinDuration ? 0.92 : 0.15);
    });

    colorMatchArgs.push('#10B981');
    opacityMatchArgs.push(0.9);

    if (map.getLayer('curb-lines')) {
      map.setPaintProperty('curb-lines', 'line-color', colorMatchArgs);
      map.setPaintProperty('curb-lines', 'line-opacity', opacityMatchArgs);
    }

    const elapsed = Math.max(0.1, Number((performance.now() - t0).toFixed(2)));
    setEvalTimeMs(elapsed);
    setFreeCurbCount(qualifyingFreeCount);
  }, [mapLoaded, scheduleBuckets, selectedDay, selectedSlot, minDurationHours, overrides]);

  // Update selected curb highlight glow filter
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded || !map.getLayer('curb-selected-glow')) return;
    map.setFilter('curb-selected-glow', [
      '==',
      ['get', 'curb_id'],
      selectedCurb ? selectedCurb.curb_id : -1,
    ]);
  }, [mapLoaded, selectedCurb]);

  const placeSearchPin = useCallback((lng: number, lat: number, label: string) => {
    const map = mapRef.current;
    if (!map) return;

    searchMarkerRef.current?.remove();

    const el = document.createElement('div');
    el.className = 'flex flex-col items-center pointer-events-none';
    el.innerHTML = `
      <div class="px-2 py-0.5 rounded-md bg-sky-500 text-slate-950 text-[11px] font-bold shadow-lg whitespace-nowrap mb-1 border border-white/40">
        ${label}
      </div>
      <div class="h-3.5 w-3.5 rounded-full bg-sky-400 ring-4 ring-sky-400/40 border-2 border-white shadow-md"></div>
    `;

    searchMarkerRef.current = new maplibregl.Marker({ element: el, anchor: 'bottom' })
      .setLngLat([lng, lat])
      .addTo(map);
  }, []);

  const jumpToNeighborhood = useCallback((lng: number, lat: number, zoom: number) => {
    searchMarkerRef.current?.remove();
    setSearchStatusMsg(null);
    mapRef.current?.flyTo({ center: [lng, lat], zoom, duration: 900 });
  }, []);

  const handleSelectSearchResult = useCallback(
    (feat: CurbFeature, customHouseNumber?: number | null) => {
      const parsed = parseChicagoAddressQuery(searchQuery);
      const houseNum = customHouseNumber !== undefined ? customHouseNumber : parsed.houseNumber;
      const targetCoord = interpolateCurbCoordinate(feat, houseNum);

      setSelectedCurb(feat.properties);
      setIsDropdownOpen(false);
      setSearchStatusMsg(null);

      const pinLabel =
        houseNum !== null
          ? `${houseNum} ${feat.properties.name}`
          : `${feat.properties.addr} ${feat.properties.name}`;

      placeSearchPin(targetCoord[0], targetCoord[1], pinLabel);

      mapRef.current?.flyTo({
        center: targetCoord,
        zoom: 16.2,
        duration: 900,
      });
    },
    [searchQuery, placeSearchPin]
  );

  // Handle Enter key / Form Submit in the address search input
  const handleSearchSubmit = useCallback(
    async (e?: FormEvent) => {
      if (e) e.preventDefault();
      const q = searchQuery.trim();
      if (!q) return;

      setSearchStatusMsg(null);

      // 1. Check if there is a direct match in our city-wide Chicago curb segments
      if (searchResults.length > 0) {
        const chosen =
          searchResults[Math.min(highlightedIndex, searchResults.length - 1)] ||
          searchResults[0];
        handleSelectSearchResult(chosen);
        return;
      }

      // 2. Check if the user entered a neighborhood name (e.g., "Pilsen", "Lakeview", "Hyde Park")
      const matchedNeighborhood = matchNeighborhoodByName(q);
      if (matchedNeighborhood) {
        setIsDropdownOpen(false);
        jumpToNeighborhood(
          matchedNeighborhood.lng,
          matchedNeighborhood.lat,
          matchedNeighborhood.zoom
        );
        return;
      }

      // 3. Geocode arbitrary Chicago address/landmark via Nominatim bounded to Chicago & snap to nearest curb
      try {
        setSearchStatusMsg('Locating address in Chicago...');
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(
          `${q}, Chicago, IL`
        )}&viewbox=-87.94,42.02,-87.52,41.64&bounded=1&limit=1`;

        const resp = await fetch(url, { headers: { Accept: 'application/json' } });
        if (resp.ok) {
          const results = await resp.json();
          if (Array.isArray(results) && results.length > 0) {
            const lng = parseFloat(results[0].lon);
            const lat = parseFloat(results[0].lat);
            const nearestCurb = findNearestCurbToLngLat(lng, lat, curbFeatures);
            setIsDropdownOpen(false);
            setSearchStatusMsg(null);

            placeSearchPin(lng, lat, q.toUpperCase());
            if (nearestCurb) {
              setSelectedCurb(nearestCurb.properties);
            }
            mapRef.current?.flyTo({
              center: [lng, lat],
              zoom: 16.0,
              duration: 900,
            });
            return;
          }
        }
      } catch {
        // Ignore network error and fall through to status message
      }

      setSearchStatusMsg(
        `No exact match for "${q}". Try an address like "2420 N Kedzie" or "1060 W Addison".`
      );
    },
    [
      searchQuery,
      searchResults,
      highlightedIndex,
      handleSelectSearchResult,
      jumpToNeighborhood,
      curbFeatures,
      placeSearchPin,
    ]
  );

  const handleSearchKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setIsDropdownOpen(true);
        setHighlightedIndex((prev) =>
          searchResults.length > 0 ? (prev + 1) % searchResults.length : 0
        );
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setIsDropdownOpen(true);
        setHighlightedIndex((prev) =>
          searchResults.length > 0
            ? (prev - 1 + searchResults.length) % searchResults.length
            : 0
        );
      } else if (e.key === 'Escape') {
        setIsDropdownOpen(false);
      }
    },
    [searchResults.length]
  );

  const handleJumpToNow = useCallback(() => {
    const { day, slot } = getChicagoCurrentDayAndSlot();
    setSelectedDay(day);
    setSelectedSlot(slot);
  }, []);

  const handleLocateMe = useCallback(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((pos) => {
      mapRef.current?.flyTo({
        center: [pos.coords.longitude, pos.coords.latitude],
        zoom: 16,
        duration: 1000,
      });
    });
  }, []);

  const toggleSweepingSection = useCallback((wardSec: string) => {
    setOverrides((prev) => {
      const exists = prev.activeSweepingWardSectionsToday.includes(wardSec);
      return {
        ...prev,
        activeSweepingWardSectionsToday: exists
          ? prev.activeSweepingWardSectionsToday.filter((s) => s !== wardSec)
          : [...prev.activeSweepingWardSectionsToday, wardSec],
      };
    });
  }, []);

  return (
    <div className="relative h-dvh w-screen overflow-hidden bg-slate-950 text-slate-100 font-sans select-none">
      {/* Full-Bleed MapLibre Canvas */}
      <div ref={mapContainerRef} className="absolute inset-0 h-full w-full" />

      {/* Desktop Hover Tooltip */}
      {hoverPopup &&
        hoverCurbEval &&
        (!selectedCurb || selectedCurb.curb_id !== hoverPopup.curb.curb_id) && (
          <div
            style={{
              transform: `translate(${hoverPopup.x + 14}px, ${hoverPopup.y - 28}px)`,
            }}
            className="hidden md:block pointer-events-none fixed top-0 left-0 z-30 rounded-xl bg-slate-900/95 border border-slate-700 px-3 py-2 shadow-xl backdrop-blur-md"
          >
            <div className="flex items-center gap-2">
              <span
                className={`h-2 w-2 rounded-full ${
                  hoverCurbEval.statusTier === 'free_long'
                    ? 'bg-emerald-400'
                    : hoverCurbEval.statusTier === 'free_ending_soon'
                    ? 'bg-amber-400'
                    : 'bg-rose-500'
                }`}
              />
              <span className="text-xs font-bold text-white">
                {hoverPopup.curb.addr} {hoverPopup.curb.name}
              </span>
              <span className="text-[10px] font-medium text-slate-400">
                ({hoverPopup.curb.parity === 'O' ? 'Odd' : 'Even'} • {hoverPopup.curb.side})
              </span>
            </div>
            <div className="text-[11px] text-slate-300 mt-0.5">
              {hoverCurbEval.isFreeNow
                ? `Free (${formatDuration(
                    hoverCurbEval.remainingMinutes,
                    hoverCurbEval.isFree24_7
                  )}) — ${hoverCurbEval.freeUntilFormatted}`
                : `Restricted — ${hoverCurbEval.nextFreeAtFormatted}`}
            </div>
          </div>
        )}

      {/* TOP BAR (Mobile Search + Desktop Integrated Sidebar) */}
      <aside className="absolute top-3 left-3 right-3 md:right-auto md:w-96 z-20 flex flex-col gap-3 pointer-events-none">
        {/* Search & Neighborhood Panel */}
        <div className="pointer-events-auto rounded-2xl bg-slate-900/90 backdrop-blur-md border border-slate-800 p-3.5 shadow-2xl">
          <div className="flex items-center justify-between gap-2 mb-2.5">
            <div className="flex items-center gap-2">
              <span className="inline-block h-3 w-3 rounded-full bg-emerald-400 animate-pulse" />
              <h1 className="text-base font-bold tracking-tight text-white">
                ChiCurb <span className="text-xs font-normal text-slate-400">Free Parking Map</span>
              </h1>
            </div>
            <div className="flex items-center gap-1.5">
              <span
                title="Client-side 672-bit bitmask evaluation latency"
                className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700"
              >
                {evalTimeMs}ms
              </span>
              <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                {freeCurbCount > 0
                  ? `${freeCurbCount.toLocaleString()} Free Curbs`
                  : 'All Chicago Live'}
              </span>
            </div>
          </div>

          {/* Street / Address Search Form (Supports pressing Enter or clicking Go) */}
          <form onSubmit={handleSearchSubmit} className="relative">
            <input
              type="text"
              value={searchQuery}
              onFocus={() => setIsDropdownOpen(true)}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setHighlightedIndex(0);
                setIsDropdownOpen(true);
                setSearchStatusMsg(null);
              }}
              onKeyDown={handleSearchKeyDown}
              placeholder="Enter Chicago address or street (e.g., 2420 N Kedzie)..."
              className="w-full rounded-xl bg-slate-800/90 border border-slate-700 pl-3.5 pr-16 py-2 text-sm text-white placeholder-slate-400 focus:outline-none focus:border-emerald-500"
            />
            <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-1">
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    setSearchStatusMsg(null);
                    searchMarkerRef.current?.remove();
                  }}
                  aria-label="Clear search"
                  className="text-xs text-slate-400 hover:text-white px-1.5 py-1 cursor-pointer"
                >
                  ✕
                </button>
              )}
              <button
                type="submit"
                aria-label="Search address"
                className="rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs px-2.5 py-1 transition cursor-pointer"
              >
                Go
              </button>
            </div>

            {/* Search Feedback Message */}
            {searchStatusMsg && (
              <div className="mt-1.5 rounded-lg bg-slate-800/95 border border-slate-700 px-3 py-1.5 text-xs text-amber-300">
                {searchStatusMsg}
              </div>
            )}

            {/* Autocomplete Search Results Dropdown */}
            {isDropdownOpen && searchResults.length > 0 && (
              <div className="absolute left-0 right-0 top-full mt-1.5 rounded-xl bg-slate-900/98 border border-slate-700 shadow-2xl overflow-hidden z-40 max-h-64 overflow-y-auto">
                {searchResults.map((feat, idx) => {
                  const ev = evaluateCurbAvailability(
                    feat.properties,
                    selectedDay,
                    selectedSlot,
                    overrides
                  );
                  const isHighlighted = idx === highlightedIndex;
                  return (
                    <button
                      key={feat.properties.curb_id}
                      type="button"
                      onMouseEnter={() => setHighlightedIndex(idx)}
                      onClick={() => handleSelectSearchResult(feat)}
                      className={`w-full text-left px-3.5 py-2 border-b border-slate-800/80 last:border-none flex items-center justify-between gap-2 transition cursor-pointer ${
                        isHighlighted ? 'bg-slate-800' : 'hover:bg-slate-800/70'
                      }`}
                    >
                      <div>
                        <div className="text-xs font-bold text-white">
                          {feat.properties.addr} {feat.properties.name}
                        </div>
                        <div className="text-[11px] text-slate-400">
                          {feat.properties.neighborhood} •{' '}
                          {feat.properties.parity === 'O' ? 'Odd Side' : 'Even Side'} (
                          {feat.properties.side})
                        </div>
                      </div>
                      <span
                        className={`shrink-0 px-2 py-0.5 rounded text-[10px] font-bold ${
                          ev.isFreeNow
                            ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                            : 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                        }`}
                      >
                        {ev.isFreeNow
                          ? formatDuration(ev.remainingMinutes, ev.isFree24_7)
                          : 'Restricted'}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </form>

          {/* Quick City-Wide & Neighborhood Jump Pills */}
          <div className="mt-2.5 flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-0.5">
            {NEIGHBORHOODS.map((n) => (
              <button
                key={n.name}
                type="button"
                onClick={() => jumpToNeighborhood(n.lng, n.lat, n.zoom)}
                className={`shrink-0 rounded-lg border px-2.5 py-1 text-xs font-medium transition cursor-pointer ${
                  n.name === 'All Chicago'
                    ? 'bg-emerald-500/20 hover:bg-emerald-500/30 border-emerald-500/40 text-emerald-300 font-semibold'
                    : 'bg-slate-800 hover:bg-slate-700 border-slate-700/80 text-slate-200'
                }`}
              >
                {n.name}
              </button>
            ))}
          </div>

          {/* Minimum Free Duration Filter */}
          <div className="mt-3 pt-2.5 border-t border-slate-800/90 flex items-center justify-between gap-2">
            <span className="text-xs text-slate-400 font-medium">Min Free Window:</span>
            <div className="flex gap-1">
              {[
                { label: 'Any', hrs: 0 },
                { label: '2h+', hrs: 2 },
                { label: '4h+', hrs: 4 },
                { label: 'Overnight', hrs: 10 },
              ].map((opt) => (
                <button
                  key={opt.label}
                  type="button"
                  onClick={() => setMinDurationHours(opt.hrs)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition cursor-pointer ${
                    minDurationHours === opt.hrs
                      ? 'bg-emerald-500 text-slate-950 shadow-sm'
                      : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* DESKTOP TIME-OF-DAY CONTROLLER (Hidden on Mobile, Placed in Bottom Bar on Mobile) */}
        <div className="hidden md:block pointer-events-auto rounded-2xl bg-slate-900/90 backdrop-blur-md border border-slate-800 p-4 shadow-2xl">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="text-xs uppercase tracking-wider font-semibold text-slate-400">
                Inspect Day & Time
              </span>
              <button
                type="button"
                onClick={handleJumpToNow}
                className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-emerald-300 border border-slate-700 transition cursor-pointer"
              >
                Now
              </button>
            </div>
            <span className="text-sm font-bold text-emerald-400">
              {DAYS_OF_WEEK[selectedDay]} • {formatSlotTime(selectedSlot)}
            </span>
          </div>

          {/* Day Selector */}
          <div className="grid grid-cols-7 gap-1 mb-3">
            {DAYS_OF_WEEK.map((d, idx) => (
              <button
                key={d}
                type="button"
                onClick={() => setSelectedDay(idx)}
                className={`py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer ${
                  selectedDay === idx
                    ? 'bg-emerald-500 text-slate-950'
                    : 'bg-slate-800 text-slate-400 hover:text-white'
                }`}
              >
                {d}
              </button>
            ))}
          </div>

          {/* 15-Minute Time Slider */}
          <input
            type="range"
            min={0}
            max={95}
            value={selectedSlot}
            onChange={(e) => setSelectedSlot(parseInt(e.target.value, 10))}
            aria-label="Inspect time of day in 15-minute increments"
            className="w-full accent-emerald-400 cursor-pointer"
          />
          <div className="flex justify-between text-[11px] text-slate-400 mt-1">
            <span>12 AM</span>
            <span>6 AM</span>
            <span>12 PM</span>
            <span>6 PM</span>
            <span>11:45 PM</span>
          </div>

          {/* Live Daily Edge Overrides Bar (overrides_today.json) */}
          <div className="mt-3.5 pt-3 border-t border-slate-800">
            <div className="flex items-center justify-between text-[11px] text-slate-400 mb-2">
              <span>Live Edge Overrides (`overrides_today.json`)</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => toggleSweepingSection('35-04')}
                className={`px-2 py-1 rounded-md text-[11px] font-medium border transition cursor-pointer ${
                  overrides.activeSweepingWardSectionsToday.includes('35-04')
                    ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                    : 'bg-slate-800/80 text-slate-400 border-slate-700'
                }`}
              >
                Sweep 35-04
              </button>
              <button
                type="button"
                onClick={() => toggleSweepingSection('01-02')}
                className={`px-2 py-1 rounded-md text-[11px] font-medium border transition cursor-pointer ${
                  overrides.activeSweepingWardSectionsToday.includes('01-02')
                    ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                    : 'bg-slate-800/80 text-slate-400 border-slate-700'
                }`}
              >
                Sweep 01-02
              </button>
              <button
                type="button"
                onClick={() =>
                  setOverrides((prev) => ({
                    ...prev,
                    isWinterBanSeason: !prev.isWinterBanSeason,
                  }))
                }
                className={`px-2 py-1 rounded-md text-[11px] font-medium border transition cursor-pointer ${
                  overrides.isWinterBanSeason
                    ? 'bg-sky-500/20 text-sky-300 border-sky-500/40'
                    : 'bg-slate-800/80 text-slate-400 border-slate-700'
                }`}
              >
                Winter 3–7a Ban
              </button>
              <button
                type="button"
                onClick={() =>
                  setOverrides((prev) => ({
                    ...prev,
                    isTwoInchSnowBanActive: !prev.isTwoInchSnowBanActive,
                  }))
                }
                className={`px-2 py-1 rounded-md text-[11px] font-medium border transition cursor-pointer ${
                  overrides.isTwoInchSnowBanActive
                    ? 'bg-rose-500/25 text-rose-300 border-rose-500/50'
                    : 'bg-slate-800/80 text-slate-400 border-slate-700'
                }`}
              >
                2&quot; Snow Ban
              </button>
            </div>
          </div>

          {/* Legend */}
          <div className="mt-3.5 pt-3 border-t border-slate-800 grid grid-cols-3 gap-2 text-xs">
            <div className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
              <span className="text-slate-300">Free (2h+)</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
              <span className="text-slate-300">Ends &lt; 2h</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-rose-500" />
              <span className="text-slate-300">Restricted</span>
            </div>
          </div>
        </div>
      </aside>

      {/* FLOATING GPS "LOCATE ME" BUTTON */}
      <button
        type="button"
        onClick={handleLocateMe}
        aria-label="Center map on my location"
        className="absolute right-3 bottom-40 md:bottom-8 z-20 flex items-center gap-2 rounded-full bg-slate-900/95 hover:bg-slate-800 border border-slate-700 px-4 py-2.5 text-xs font-semibold text-white shadow-xl backdrop-blur-md transition cursor-pointer"
      >
        <span className="h-2 w-2 rounded-full bg-sky-400" />
        Near Me
      </button>

      {/* SELECTED CURB DETAILS DRAWER (Desktop Floating Card / Mobile Slide-Up Sheet) */}
      {selectedCurb && selectedCurbEval && (
        <section
          aria-label="Selected Curb Schedule Details"
          className="
            fixed bottom-24 md:bottom-6 left-3 right-3 md:left-3 md:right-auto md:w-96 z-30
            rounded-2xl bg-slate-900/95 backdrop-blur-xl border border-slate-700 p-4 shadow-2xl
            transition-all duration-200
          "
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="flex items-center flex-wrap gap-2">
                <span
                  className={`px-2 py-0.5 rounded-md text-xs font-bold ${
                    selectedCurbEval.isFreeNow
                      ? selectedCurbEval.remainingMinutes < 120 && !selectedCurbEval.isFree24_7
                        ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                        : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                      : 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                  }`}
                >
                  {selectedCurbEval.isFreeNow
                    ? `FREE • ${formatDuration(
                        selectedCurbEval.remainingMinutes,
                        selectedCurbEval.isFree24_7
                      )}`
                    : 'RESTRICTED NOW'}
                </span>
                <span className="text-xs font-medium text-slate-400">
                  {selectedCurb.parity === 'O' ? 'Odd Side' : 'Even Side'} ({selectedCurb.side})
                </span>
                {selectedCurb.w_sec && (
                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                    Ward {selectedCurb.w_sec}
                  </span>
                )}
              </div>

              <h2 className="mt-1.5 text-base font-bold text-white">
                {selectedCurb.addr} {selectedCurb.name}
              </h2>
              <p className="text-xs text-slate-300 mt-0.5">
                {selectedCurb.neighborhood ? `${selectedCurb.neighborhood} — ` : ''}
                {selectedCurbEval.isFreeNow
                  ? selectedCurbEval.freeUntilFormatted
                  : selectedCurbEval.nextFreeAtFormatted}
              </p>
            </div>

            <button
              type="button"
              onClick={() => setSelectedCurb(null)}
              aria-label="Close curb details"
              className="rounded-lg bg-slate-800 p-1.5 text-slate-400 hover:text-white cursor-pointer"
            >
              ✕
            </button>
          </div>

          {/* 24-Hour Visual Availability Strip for Selected Day */}
          <div className="mt-3 pt-3 border-t border-slate-800">
            <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1.5">
              <span>24-Hour Curb Schedule ({DAYS_OF_WEEK[selectedDay]})</span>
              <span className="text-slate-300 font-medium">
                {selectedCurbEval.restrictionReason}
              </span>
            </div>
            <div className="grid grid-cols-24 gap-0.5 h-3.5 w-full rounded overflow-hidden bg-slate-800 p-0.5">
              {selectedCurbEval.hourlyTimeline.map((isFreeHour, hr) => {
                const isSelectedHour = Math.floor(selectedSlot / 4) === hr;
                return (
                  <button
                    key={hr}
                    type="button"
                    onClick={() => setSelectedSlot(hr * 4)}
                    title={`${hr}:00 - ${isFreeHour ? 'Free' : 'Restricted'} (Click to inspect)`}
                    className={`h-full rounded-xs cursor-pointer transition-transform ${
                      isFreeHour
                        ? 'bg-emerald-400 hover:bg-emerald-300'
                        : 'bg-rose-500/80 hover:bg-rose-400'
                    } ${isSelectedHour ? 'ring-2 ring-white z-10 scale-y-110' : ''}`}
                  />
                );
              })}
            </div>
            <div className="flex justify-between text-[10px] text-slate-400 mt-1">
              <span>12a</span>
              <span>6a</span>
              <span>12p</span>
              <span>6p</span>
              <span>11p</span>
            </div>
          </div>
        </section>
      )}

      {/* MOBILE BOTTOM TIME-SCRUBBER BAR (Thumb-Zone Optimized) */}
      <footer className="md:hidden fixed bottom-0 inset-x-0 z-20 bg-slate-900/95 backdrop-blur-lg border-t border-slate-800 px-4 py-2.5 pb-safe">
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex gap-1 overflow-x-auto no-scrollbar">
            {DAYS_OF_WEEK.map((d, idx) => (
              <button
                key={d}
                type="button"
                onClick={() => setSelectedDay(idx)}
                className={`px-2 py-0.5 rounded text-xs font-semibold ${
                  selectedDay === idx ? 'bg-emerald-500 text-slate-950' : 'text-slate-400'
                }`}
              >
                {d}
              </button>
            ))}
          </div>
          <span className="text-xs font-bold text-emerald-400 shrink-0 ml-2">
            {formatSlotTime(selectedSlot)}
          </span>
        </div>

        <input
          type="range"
          min={0}
          max={95}
          value={selectedSlot}
          onChange={(e) => setSelectedSlot(parseInt(e.target.value, 10))}
          aria-label="Inspect time of day"
          className="w-full accent-emerald-400"
        />
      </footer>
    </div>
  );
}
