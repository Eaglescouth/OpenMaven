"use client";

/**
 * map-view.tsx
 *
 * Thin dynamic wrapper around MapViewInner.  next/dynamic with ssr:false is
 * required because maplibre-gl accesses browser-only APIs at import time.
 */

import dynamic from "next/dynamic";
import type { TacticalAsset, AssetClass } from "@/lib/tactical-mock";
import type { MapStyleId, DetectionTarget } from "./map-view-inner";

export interface MapViewProps {
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
  movePath?: {
    from: [number, number];
    to: [number, number];
  } | null;
  onMovePathDrag?: (lngLat: { lng: number; lat: number }) => void;
  activeBoardState?: DetectionTarget[];
  flyTo?: { lat: number; lng: number; zoom?: number } | null;
}

const MapViewInner = dynamic(
  () => import("./map-view-inner").then((m) => m.MapViewInner),
  {
    ssr: false,
    loading: () => (
      <div className="w-full h-full flex items-center justify-center bg-[var(--om-bg-deep)]">
        <span className="text-[11px] text-[var(--om-text-muted)] tracking-widest uppercase">
          Initialising map…
        </span>
      </div>
    ),
  },
);

export function MapView(props: MapViewProps) {
  return <MapViewInner {...props} />;
}
