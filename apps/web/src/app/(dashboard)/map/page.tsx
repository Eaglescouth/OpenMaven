"use client";

/**
 * map/page.tsx
 *
 * Smart Maven Tactical C2 View — primary operational display.
 *
 * Layout:
 *   ┌─────────────────────────────────────────────┐
 *   │  (left sidebar — Map Layers — in AppShell)  │
 *   │  ┌─────────────────────────────────────────┐│
 *   │  │           SATELLITE MAP                 ││
 *   │  │                                         ││
 *   │  │  [asset markers per class]              ││
 *   │  └─────────────────────────────────────────┘│
 *   └─────────────────────────────────────────────┘
 */

import { useState, useMemo, useCallback, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { MapView } from "@/components/map-view";
import { MAP_STYLES, type MapStyleId } from "@/components/map-view-inner";
import { SimulationControls } from "@/components/simulation-controls";
import { ContextMenu, type ContextMenuState } from "@/components/context-menu";
import { useMapLayers } from "@/lib/map-layer-context";
import { useSimulation } from "@/lib/use-simulation";
import { simAssetsToTactical } from "@/lib/sim-to-tactical";

// ── Page ──────────────────────────────────────────────────────────────────────

export default function MapPage() {
  const { visibleLayers, selectedAsset, setSelectedAsset } = useMapLayers();
  const [mapStyle, setMapStyle] = useState<MapStyleId>("dark");
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [moveMode, setMoveMode] = useState<string | null>(null); // asset_id being moved
  const [moveDest, setMoveDest] = useState<{ lng: number; lat: number } | null>(null);
  // Track assets we've explicitly ordered to move (not auto-patrol)
  const [commandedMoves, setCommandedMoves] = useState<Map<string, { lng: number; lat: number }>>(new Map());

  const sim = useSimulation();
  const searchParams = useSearchParams();
  const [flyTo, setFlyTo] = useState<{ lat: number; lng: number; zoom?: number } | null>(null);

  useEffect(() => {
    const lat = searchParams.get("lat");
    const lng = searchParams.get("lng") ?? searchParams.get("lon");
    if (!lat || !lng) return;

    const parsedLat = Number(lat);
    const parsedLng = Number(lng);
    if (Number.isFinite(parsedLat) && Number.isFinite(parsedLng)) {
      setFlyTo({ lat: parsedLat, lng: parsedLng, zoom: 9 });
    }
  }, [searchParams]);

  // Keep the context's selected asset fresh with latest sim data
  const selectedId = selectedAsset?.asset_id ?? null;

  // Convert live simulation assets to the TacticalAsset format the map expects
  const tacticalAssets = useMemo(
    () => simAssetsToTactical(sim.assets),
    [sim.assets],
  );

  const visibleAssets = useMemo(
    () => tacticalAssets.filter((a) => visibleLayers.has(a.asset_class)),
    [tacticalAssets, visibleLayers],
  );

  // Remove commanded move tracking when asset arrives at destination
  useEffect(() => {
    let changed = false;
    const next = new Map(commandedMoves);
    next.forEach((_, assetId) => {
      const asset = sim.assets[assetId];
      if (!asset || asset.status !== "moving") {
        next.delete(assetId);
        changed = true;
      }
    });
    if (changed) setCommandedMoves(next);
  }, [sim.assets, commandedMoves]);

  // Compute move path line for the map:
  // 1. Preview mode: moveMode + moveDest (before confirm)
  // 2. Commanded move: asset we explicitly ordered (after confirm, while still moving)
  const movePath = useMemo(() => {
    // Preview path (move mode with a chosen destination)
    if (moveMode && moveDest) {
      const asset = sim.assets[moveMode];
      if (!asset) return null;
      return {
        from: [asset.position.longitude, asset.position.latitude] as [number, number],
        to: [moveDest.lng, moveDest.lat] as [number, number],
      };
    }

    // Commanded move on selected asset (only moves we explicitly issued)
    if (selectedId && commandedMoves.has(selectedId)) {
      const asset = sim.assets[selectedId];
      const dest = commandedMoves.get(selectedId)!;
      if (asset) {
        return {
          from: [asset.position.longitude, asset.position.latitude] as [number, number],
          to: [dest.lng, dest.lat] as [number, number],
        };
      }
    }

    return null;
  }, [moveMode, moveDest, selectedId, commandedMoves, sim.assets]);

  // ── Context menu handlers ────────────────────────────────────────────────

  const handleContextMenu = useCallback(
    (event: {
      type: "asset" | "map";
      asset?: { asset_id: string; callsign: string; weapons: string[] };
      lngLat?: { lng: number; lat: number };
      x: number;
      y: number;
    }) => {
      setContextMenu({
        type: event.type,
        asset: event.asset,
        lngLat: event.lngLat,
        x: event.x,
        y: event.y,
      });
    },
    [],
  );

  const handleContextMenuAction = useCallback(
    (action: string, payload?: Record<string, unknown>) => {
      setContextMenu(null);

      if (action === "details" && payload?.assetId) {
        const simAsset = sim.assets[payload.assetId as string];
        if (simAsset) setSelectedAsset(simAsset);
      }

      if (action === "move" && payload?.assetId) {
        setMoveMode(payload.assetId as string);
      }

      if (action === "strike" && payload?.weaponId && payload?.targetId) {
        sim.strike(payload.weaponId as string, payload.targetId as string);
      }

      if (action === "move_here" && payload?.assetId && payload?.lat != null && payload?.lon != null) {
        setMoveMode(payload.assetId as string);
        setMoveDest({ lng: payload.lon as number, lat: payload.lat as number });
      }
    },
    [sim, setSelectedAsset],
  );

  const handleMapClick = useCallback(
    (lngLat: { lng: number; lat: number }) => {
      if (moveMode) {
        if (!moveDest) {
          // First click: preview path
          setMoveDest(lngLat);
        } else {
          // Second click or confirm: execute move
          sim.moveAsset(moveMode, moveDest.lat, moveDest.lng);
          setMoveMode(null);
          setMoveDest(null);
        }
      }
    },
    [moveMode, moveDest, sim],
  );

  const handleMovePathDrag = useCallback(
    (lngLat: { lng: number; lat: number }) => {
      setMoveDest(lngLat);
    },
    [],
  );

  const handleConfirmMove = useCallback(() => {
    if (moveMode && moveDest) {
      sim.moveAsset(moveMode, moveDest.lat, moveDest.lng);
      setCommandedMoves((prev) => new Map(prev).set(moveMode, moveDest));
      setSelectedAsset(sim.assets[moveMode] ?? null);
      setMoveMode(null);
      setMoveDest(null);
    }
  }, [moveMode, moveDest, sim, setSelectedAsset]);

  const handleCancelMove = useCallback(() => {
    setMoveMode(null);
    setMoveDest(null);
  }, []);

  return (
    <div className="flex-1 flex flex-col bg-[var(--om-bg-deep)] overflow-hidden">
      {/* ── Simulation Controls ─────────────────────────────────────── */}
      <SimulationControls
        connected={sim.connected}
        tick={sim.tick}
        speed={sim.speed}
        onSetSpeed={sim.setSpeed}
        assetCount={Object.keys(sim.assets).length}
        pendingEvents={sim.pendingEvents}
      />

      {/* ── Map ──────────────────────────────────────────────────────── */}
      <div className="flex-1 relative min-h-0">
        <MapView
          assets={visibleAssets}
          visibleLayers={visibleLayers}
          activeBoardState={sim.boardState}
          flyTo={flyTo}
          onAssetClick={(tacticalAsset) => {
            if (moveMode) return; // ignore clicks during move mode
            const simAsset = sim.assets[tacticalAsset.asset_id];
            if (selectedId === tacticalAsset.asset_id) {
              setSelectedAsset(null);
            } else if (simAsset) {
              setSelectedAsset(simAsset);
            }
          }}
          selectedId={selectedId}
          mapStyle={mapStyle}
          onContextMenu={handleContextMenu}
          onMapClick={moveMode ? handleMapClick : undefined}
          movePath={movePath}
          onMovePathDrag={handleMovePathDrag}
        />

        {/* Move-mode indicator */}
        {moveMode && (
          <div
            className="absolute top-2 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 px-3 py-1.5 rounded-sm text-[10px] font-semibold"
            style={{
              background: "rgba(45,114,210,0.15)",
              border: "1px solid rgba(45,114,210,0.4)",
              color: "var(--om-blue-light)",
              backdropFilter: "blur(4px)",
            }}
          >
            {moveDest ? (
              <>
                <span>
                  {moveDest.lat.toFixed(2)}, {moveDest.lng.toFixed(2)}
                </span>
                <button
                  onClick={handleConfirmMove}
                  className="px-2 py-0.5 bg-[var(--om-blue)]/20 border border-[var(--om-blue)]/40 rounded-sm hover:bg-[var(--om-blue)]/30 cursor-pointer transition-colors"
                >
                  Confirm
                </button>
                <button
                  onClick={handleCancelMove}
                  className="text-[var(--om-text-secondary)] hover:text-[var(--om-text-primary)] cursor-pointer"
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                Click map to set destination
                <button
                  onClick={handleCancelMove}
                  className="text-[var(--om-text-secondary)] hover:text-[var(--om-text-primary)] cursor-pointer ml-1"
                >
                  Cancel
                </button>
              </>
            )}
          </div>
        )}

        {/* Asset count HUD */}
        <div className="absolute top-2 left-2 z-20 flex gap-1.5">
          {(["Military", "Infrastructure", "Logistics"] as const).map((cls) => {
            const count = visibleAssets.filter((a) => a.asset_class === cls).length;
            if (!visibleLayers.has(cls)) return null;
            return (
              <div
                key={cls}
                className="flex items-center gap-1.5 px-2 py-1 rounded-sm text-[9px] font-mono"
                style={{
                  background: "rgba(30,34,41,0.85)",
                  border: "1px solid var(--om-border)",
                  backdropFilter: "blur(4px)",
                }}
              >
                <span className="font-semibold text-[var(--om-text-primary)]">{count}</span>
                <span className="text-[var(--om-text-muted)]">{cls}</span>
              </div>
            );
          })}
        </div>

        {/* Top-right HUD: map style toggle */}
        <div className="absolute top-2 right-2 z-20 flex items-center gap-2">
          <div
            className="flex rounded-sm overflow-hidden text-[9px] font-semibold"
            style={{ background: "rgba(30,34,41,0.85)", border: "1px solid var(--om-border)", backdropFilter: "blur(4px)" }}
          >
            {MAP_STYLES.map(({ id, label }) => (
              <button
                key={id}
                onClick={() => setMapStyle(id)}
                className={`px-2.5 py-1 cursor-pointer transition-colors ${
                  mapStyle === id
                    ? "bg-[var(--om-blue)]/20 text-[var(--om-blue-light)]"
                    : "text-[var(--om-text-muted)] hover:text-[var(--om-text-secondary)]"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Context Menu */}
        {contextMenu && (
          <ContextMenu
            state={contextMenu}
            selectedAssetId={selectedId}
            onAction={handleContextMenuAction}
            onClose={() => setContextMenu(null)}
          />
        )}
      </div>
    </div>
  );
}
