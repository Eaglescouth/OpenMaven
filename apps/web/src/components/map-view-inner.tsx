"use client";

/**
 * map-view-inner.tsx
 *
 * Tactical MapLibre map with MIL-STD-2525 NATO markers rendered via milsymbol.
 * Markers are colored by affiliation (friendly/hostile/neutral) and shaped by
 * battle dimension (air/ground/sea/subsurface).  Each marker shows a callsign
 * label below the symbol.
 *
 * Must be loaded via next/dynamic with ssr:false — maplibre-gl is browser-only.
 */

import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import ms from "milsymbol";
import type { TacticalAsset, AssetClass } from "@/lib/tactical-mock";
import { getSidc } from "@/lib/sidc-map";

export interface DetectionRecord {
  detection_id: string;
  timestamp: string;
  asset_id: string;
  asset_type: string;
  confidence: number;
  grid_ref: string;
  lat: number;
  lon: number;
  source_label: string;
  classification: string;
}

export interface DetectionTarget {
  target_id: string;
  stage: "DYNAMIC" | "PENDING_PAIRING" | "PAIRED" | "IN_EXECUTION" | "COMPLETE";
  created_at: string;
  updated_at: string;
  history?: Array<[string, string]>;
  detection: DetectionRecord;
}

// ── Map styles ───────────────────────────────────────────────────────────────

const DARK_STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

const SATELLITE_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    esri: {
      type: "raster",
      tiles: [
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      ],
      tileSize: 256,
      maxzoom: 18,
      attribution: "Esri, Maxar, Earthstar Geographics",
    },
  },
  layers: [
    { id: "esri-satellite", type: "raster", source: "esri", minzoom: 0, maxzoom: 18 },
  ],
};

export type MapStyleId = "dark" | "satellite";

export const MAP_STYLES: { id: MapStyleId; label: string; style: string | maplibregl.StyleSpecification }[] = [
  { id: "dark",      label: "Dark",      style: DARK_STYLE },
  { id: "satellite", label: "Satellite",  style: SATELLITE_STYLE },
];

// ── NATO symbol rendering ────────────────────────────────────────────────────

const MARKER_SIZE = 18;

function renderNatoSymbol(asset: TacticalAsset): string {
  const sidc = getSidc(asset.sim_asset_type, asset.affiliation);
  const symbol = new ms.Symbol(sidc, { size: MARKER_SIZE });
  return symbol.asSVG();
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface TacticalMapProps {
  assets: TacticalAsset[];
  visibleLayers: Set<AssetClass>;
  onAssetClick?: (asset: TacticalAsset) => void;
  selectedId?: string | null;
  mapStyle?: MapStyleId;
  className?: string;
  onContextMenu?: (event: {
    type: "asset" | "map";
    asset?: { asset_id: string; callsign: string; weapons: string[] };
    lngLat?: { lng: number; lat: number };
    x: number;
    y: number;
  }) => void;
  onMapClick?: (lngLat: { lng: number; lat: number }) => void;
  /** Dashed path line from asset to destination. */
  movePath?: {
    from: [number, number]; // [lng, lat]
    to: [number, number];   // [lng, lat]
  } | null;
  /** Called when the destination endpoint is dragged to a new position. */
  onMovePathDrag?: (lngLat: { lng: number; lat: number }) => void;
  activeBoardState?: DetectionTarget[];
  flyTo?: { lat: number; lng: number; zoom?: number } | null;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function MapViewInner({
  assets,
  visibleLayers,
  onAssetClick,
  selectedId,
  mapStyle = "dark",
  className = "",
  onContextMenu,
  onMapClick,
  movePath,
  onMovePathDrag,
  activeBoardState,
  flyTo,
}: TacticalMapProps) {
  const containerRef        = useRef<HTMLDivElement>(null);
  const mapRef              = useRef<maplibregl.Map | null>(null);
  const markersRef          = useRef<Map<string, { marker: maplibregl.Marker; asset: TacticalAsset }>>(new Map());
  const onAssetClickRef     = useRef(onAssetClick);
  onAssetClickRef.current   = onAssetClick;
  const onContextMenuRef    = useRef(onContextMenu);
  onContextMenuRef.current  = onContextMenu;
  const onMapClickRef         = useRef(onMapClick);
  onMapClickRef.current       = onMapClick;
  const onMovePathDragRef     = useRef(onMovePathDrag);
  onMovePathDragRef.current   = onMovePathDrag;
  const destMarkerRef         = useRef<maplibregl.Marker | null>(null);
  // Tracks whether the map has genuinely fired its "load" event.
  // map.loaded() is not a reliable guard — it can return true before
  // transform.projection is initialised, causing the "projection" crash.
  const mapLoadedRef          = useRef(false);

  const resolvedStyle = MAP_STYLES.find((s) => s.id === mapStyle)?.style ?? DARK_STYLE;

  // ── Initialise map ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: resolvedStyle,
      center: [43.0, 33.0],
      zoom: 5.5,
      attributionControl: {},
      maxZoom: 16,
    });

    // Set the flag only after the load event fires — this is the single
    // reliable signal that transform.projection is fully initialised.
    map.once("load", () => { mapLoadedRef.current = true; });

    mapRef.current = map;

    // Map-level right-click (on empty space)
    map.on("contextmenu", (e) => {
      e.preventDefault();
      onContextMenuRef.current?.({
        type: "map",
        lngLat: { lng: e.lngLat.lng, lat: e.lngLat.lat },
        x: e.point.x,
        y: e.point.y,
      });
    });

    // Map-level click (for move-mode)
    map.on("click", (e) => {
      onMapClickRef.current?.({ lng: e.lngLat.lng, lat: e.lngLat.lat });
    });

    return () => {
      map.remove();
      mapRef.current = null;
      mapLoadedRef.current = false;
      markersRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Switch style when mapStyle prop changes ────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.setStyle(resolvedStyle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapStyle]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!map || !(map as any).transform || !(map as any).transform.projection) return;

    const SOURCE_ID = "detection-overlay-source";
    const LAYER_ID = "detection-overlay-layer";

    const updateOverlay = () => {
      if (!map || !mapRef.current) return;

      if (!activeBoardState || activeBoardState.length === 0) {
        try {
          if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
          if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
        } catch {
          // style already unloaded
        }
        return;
      }

      const geojson: GeoJSON.FeatureCollection = {
        type: "FeatureCollection",
        features: activeBoardState.map((target) => ({
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: [target.detection.lon, target.detection.lat],
          },
          properties: {
            target_id: target.target_id,
            stage: target.stage,
            label: target.detection.asset_type,
          },
        })),
      };

      const source = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
      if (source) {
        source.setData(geojson);
      } else {
        map.addSource(SOURCE_ID, { type: "geojson", data: geojson });
        map.addLayer({
          id: LAYER_ID,
          type: "circle",
          source: SOURCE_ID,
          paint: {
            "circle-color": "#ff4d4f",
            "circle-radius": 10,
            "circle-opacity": 0.8,
            "circle-stroke-color": "rgba(255,255,255,0.9)",
            "circle-stroke-width": 2,
          },
        });
      }
    };

    if (map.loaded() && map.isStyleLoaded()) {
      updateOverlay();
    } else {
      map.once("styledata", updateOverlay);
    }

    return () => {
      if (!map) return;
      try {
        if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
        if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      } catch {
        // map already removed or style changed
      }
    };
  }, [activeBoardState, mapStyle]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !flyTo) return;

    const doFly = () => {
      if (!map || !flyTo) return;
      map.flyTo({
        center: [flyTo.lng, flyTo.lat],
        zoom: flyTo.zoom ?? 8,
        speed: 0.8,
        curve: 1.4,
      });
    };

    if (map.loaded() && map.isStyleLoaded()) {
      doFly();
    } else {
      map.once("styledata", doFly);
    }
  }, [flyTo?.lat, flyTo?.lng, flyTo?.zoom, mapStyle]);

  // ── Sync markers — add/remove/update without full rebuild ──────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    function syncMarkers() {
      if (!map) return;

      const visible = assets.filter((a) => visibleLayers.has(a.asset_class));
      const visibleIds = new Set(visible.map((a) => a.asset_id));

      // Remove markers for assets no longer visible
      markersRef.current.forEach(({ marker }, id) => {
        if (!visibleIds.has(id)) {
          marker.remove();
          markersRef.current.delete(id);
        }
      });

      for (const asset of visible) {
        const existing = markersRef.current.get(asset.asset_id);

        if (existing) {
          existing.marker.setLngLat([asset.longitude, asset.latitude]);
          existing.asset = asset;
          continue;
        }

        // Build marker element: NATO symbol + callsign label
        const el = document.createElement("div");
        el.style.cssText = "cursor:pointer;display:flex;flex-direction:column;align-items:center;";

        const inner = document.createElement("div");
        inner.style.cssText = "transition:transform 120ms ease,filter 120ms ease;line-height:0;";
        inner.innerHTML = renderNatoSymbol(asset);
        el.appendChild(inner);

        // Callsign label below the symbol
        const label = document.createElement("div");
        label.textContent = asset.callsign;
        label.style.cssText =
          "font-size:8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,system-ui,monospace;font-weight:600;" +
          "color:#d4d4d8;text-shadow:0 1px 3px rgba(0,0,0,0.9);" +
          "white-space:nowrap;margin-top:1px;letter-spacing:0.03em;pointer-events:none;";
        el.appendChild(label);

        // Hover effects (on inner, not el, to preserve MapLibre's transform)
        el.addEventListener("mouseenter", () => {
          inner.style.transform = "scale(1.4)";
          el.style.zIndex       = "10";
          inner.style.filter    = "drop-shadow(0 0 6px rgba(255,255,255,0.5))";
        });
        el.addEventListener("mouseleave", () => {
          inner.style.transform = "scale(1)";
          el.style.zIndex       = "1";
          inner.style.filter    = "";
        });

        // Hard guard: transform.projection must exist before addTo() calls
        // map.project() internally. The load event does not guarantee this.
        if (!(map as any).transform?.projection) {
          console.warn(`[MapView] Skipping marker ${asset.asset_id}: map.transform.projection not ready`);
          continue;
        }

        try {
          const marker = new maplibregl.Marker({ element: el, anchor: "center" })
            .setLngLat([asset.longitude, asset.latitude]);
          if (map && (map as any).transform?.projection) {
            marker.addTo(map);
          } else {
            console.warn("Map projection not ready, skipping marker draw.");
          }

          const assetId = asset.asset_id;
          el.addEventListener("click", () => {
            const entry = markersRef.current.get(assetId);
            if (entry) onAssetClickRef.current?.(entry.asset);
          });

          el.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const entry = markersRef.current.get(assetId);
            if (entry) {
              const rect = containerRef.current?.getBoundingClientRect();
              const x = e.clientX - (rect?.left ?? 0);
              const y = e.clientY - (rect?.top ?? 0);
              onContextMenuRef.current?.({
                type: "asset",
                asset: {
                  asset_id: entry.asset.asset_id,
                  callsign: entry.asset.callsign,
                  weapons: entry.asset.weapons ?? [],
                },
                x,
                y,
              });
            }
          });

          markersRef.current.set(asset.asset_id, { marker, asset });
        } catch (err) {
          console.warn(`[MapView] Failed to add marker for ${asset.asset_id}:`, err);
        }
      }
    }

    // "load" alone is insufficient — transform.projection may not be set yet.
    // "idle" fires after the first full render, guaranteeing all state is ready.
    if (mapLoadedRef.current && (map as any).transform?.projection) {
      syncMarkers();
    } else {
      map.once("idle", syncMarkers);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets, visibleLayers]);

  // ── Highlight selected marker ───────────────────────────────────────────────
  useEffect(() => {
    markersRef.current.forEach(({ marker, asset }) => {
      const el = marker.getElement();
      const inner = el.firstElementChild as HTMLElement | null;
      if (!inner) return;
      if (asset.asset_id === selectedId) {
        inner.style.transform = "scale(1.8)";
        el.style.zIndex       = "20";
        inner.style.filter    = "drop-shadow(0 0 8px rgba(255,255,255,0.6))";
      } else {
        inner.style.transform = "scale(1)";
        el.style.zIndex       = "1";
        inner.style.filter    = "";
      }
    });
  }, [selectedId]);

  // ── Draw move path (dashed line + draggable endpoint) ─────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const SOURCE_ID = "move-path-source";
    const LAYER_ID = "move-path-layer";

    function addPathLayer() {
      // Guard: map may have been removed between scheduling and execution
      if (!map || !mapRef.current) return;

      if (!movePath) {
        // Remove line and marker if no path
        try {
          if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
          if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
        } catch { /* map removed */ }
        if (destMarkerRef.current) {
          destMarkerRef.current.remove();
          destMarkerRef.current = null;
        }
        return;
      }

      const geojson: GeoJSON.FeatureCollection = {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: {
              type: "LineString",
              coordinates: [movePath.from, movePath.to],
            },
            properties: {},
          },
        ],
      };

      // Update or create source/layer
      const source = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
      if (source) {
        source.setData(geojson);
      } else {
        map.addSource(SOURCE_ID, { type: "geojson", data: geojson });
        map.addLayer({
          id: LAYER_ID,
          type: "line",
          source: SOURCE_ID,
          paint: {
            "line-color": "#2D72D2",
            "line-width": 2,
            "line-dasharray": [4, 3],
            "line-opacity": 0.7,
          },
        });
      }

      // Destination marker (draggable crosshair)
      if (!destMarkerRef.current) {
        const el = document.createElement("div");
        el.style.cssText =
          "width:14px;height:14px;border:2px solid #2D72D2;border-radius:50%;" +
          "background:rgba(45,114,210,0.2);cursor:grab;box-shadow:0 0 6px rgba(45,114,210,0.5);";
        const marker = new maplibregl.Marker({ element: el, draggable: true })
          .setLngLat(movePath.to);

        if ((map as any).transform?.projection) {
          marker.addTo(map);
        }

        marker.on("dragend", () => {
          const lngLat = marker.getLngLat();
          onMovePathDragRef.current?.({ lng: lngLat.lng, lat: lngLat.lat });
        });
        destMarkerRef.current = marker;
      } else {
        destMarkerRef.current.setLngLat(movePath.to);
      }
    }

    if (map.loaded() && map.isStyleLoaded()) {
      addPathLayer();
    } else {
      map.once("styledata", addPathLayer);
    }

    return () => {
      // Guard: map may already be destroyed by the init effect's cleanup
      if (destMarkerRef.current) {
        destMarkerRef.current.remove();
        destMarkerRef.current = null;
      }
      try {
        if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
        if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      } catch {
        // Map already removed — safe to ignore
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movePath?.from[0], movePath?.from[1], movePath?.to[0], movePath?.to[1]]);

  return <div ref={containerRef} className={`w-full h-full ${className}`} onContextMenu={(e) => e.preventDefault()} />;
}
