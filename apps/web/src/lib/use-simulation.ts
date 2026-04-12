"use client";

import { useState, useEffect, useRef, useCallback } from "react";

// ── Types ───────────────────────────────────────────────────────────────────

export interface SimPosition {
  latitude: number;
  longitude: number;
  altitude_m: number;
  heading_deg: number;
  pitch_deg: number;
  roll_deg: number;
}

export interface SimMovementOrder {
  destination: SimPosition;
  start_tick: number;
  arrive_tick: number;
  origin_lat: number;
  origin_lon: number;
}

export interface SimAsset {
  asset_id: string;
  callsign: string;
  asset_type: string;
  faction_id: string;
  position: SimPosition;
  speed_kmh: number;
  max_speed_kmh: number;
  status: string;
  health: number;
  sensor_type: string | null;
  sensor_range_km: number;
  weapons: string[];
  movement_order: SimMovementOrder | null;
}

export interface SimFaction {
  faction_id: string;
  name: string;
  side: string;
  doctrine: string;
  capability: number;
  morale: number;
}

export interface SimSnapshot {
  tick: number;
  speed: number;
  assets: Record<string, SimAsset>;
  factions: Record<string, SimFaction>;
  pending_events: number;
}

export interface StateDiff {
  tick: number;
  asset_updates: Array<Record<string, unknown>>;
  events_fired: Array<Record<string, unknown>>;
  alerts: string[];
}
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
// ── Hook ────────────────────────────────────────────────────────────────────

interface UseSimulationOptions {
  /** WebSocket URL. Defaults to ws://localhost:8000/api/simulation/ws */
  url?: string;
  /** Auto-connect on mount. Default true */
  autoConnect?: boolean;
}

interface UseSimulationReturn {
  connected: boolean;
  tick: number;
  speed: number;
  assets: Record<string, SimAsset>;
  factions: Record<string, SimFaction>;
  pendingEvents: number;
  boardState: DetectionTarget[];
  /** Set simulation speed (0=pause, 1, 2, 5, 10) */
  setSpeed: (speed: number) => void;
  /** Execute a strike */
  strike: (weaponId: string, targetId: string) => void;
  /** Move an asset */
  moveAsset: (assetId: string, lat: number, lon: number) => void;
  /** Request full state refresh */
  refresh: () => void;
}

export function useSimulation(options: UseSimulationOptions = {}): UseSimulationReturn {
  const {
    url = "ws://localhost:8000/api/simulation/ws",
    autoConnect = true,
  } = options;

  const [connected, setConnected] = useState(false);
  const [tick, setTick] = useState(0);
  const [speed, setSpeedState] = useState(0);
  const [assets, setAssets] = useState<Record<string, SimAsset>>({});
  const [factions, setFactions] = useState<Record<string, SimFaction>>({});
  const [pendingEvents, setPendingEvents] = useState(0);
  const [boardState, setBoardState] = useState<DetectionTarget[]>([]);

  const wsRef = useRef<WebSocket | null>(null);

  // ── Send helper ─────────────────────────────────────────────────────

  const send = useCallback((data: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  // ── Commands ────────────────────────────────────────────────────────

  const setSpeed = useCallback((s: number) => {
    send({ type: "set_speed", speed: s });
  }, [send]);

  const strike = useCallback((weaponId: string, targetId: string) => {
    send({ type: "strike", weapon_id: weaponId, target_id: targetId });
  }, [send]);

  const moveAsset = useCallback((assetId: string, lat: number, lon: number) => {
    send({ type: "move", asset_id: assetId, latitude: lat, longitude: lon });
  }, [send]);

  const refresh = useCallback(() => {
    send({ type: "get_state" });
  }, [send]);

  // ── Message handler ─────────────────────────────────────────────────

  const handleMessage = useCallback((event: MessageEvent) => {
    const msg = JSON.parse(event.data);

    if (msg.type === "snapshot") {
      const data: SimSnapshot = msg.data;
      setTick(data.tick);
      setSpeedState(data.speed);
      setAssets(data.assets);
      setFactions(data.factions);
      setPendingEvents(data.pending_events);
      return;
    }

    if (msg.type === "diff") {
      const diff: StateDiff = msg.data ?? msg;
      setTick(diff.tick);

      // Patch asset positions from diff
      if (diff.asset_updates?.length > 0) {
        setAssets((prev) => {
          const next = { ...prev };
          for (const update of diff.asset_updates) {
            const id = update.asset_id as string;
            if (id && next[id] && update.position) {
              next[id] = {
                ...next[id],
                position: update.position as SimPosition,
                status: (update.event === "arrived" ? "active" : next[id].status),
              };
            }
          }
          return next;
        });
      }
      return;
    }

    if (msg.type === "strike_result") {
      const data = msg.data ?? msg;
      const targetId = data.target_id as string;
      const targetStatus = data.target_status as string;
      const targetHealth = data.target_health as number | undefined;
      if (targetId) {
        setAssets((prev) => {
          const asset = prev[targetId];
          if (!asset) return prev;
          return {
            ...prev,
            [targetId]: {
              ...asset,
              status: targetStatus ?? asset.status,
              health: targetHealth ?? (targetStatus === "destroyed" ? 0 : asset.health),
            },
          };
        });
      }
      return;
    }

    if (msg.type === "speed_changed") {
      setSpeedState(msg.speed);
      return;
    }

    if (msg.type === "detections") {
      const data = msg.data ?? msg;
      const boardState = Array.isArray(data.board_state) ? data.board_state as DetectionTarget[] : [];
      setBoardState(boardState);
      return;
    }
  }, []);

  // ── Connection lifecycle ────────────────────────────────────────────

  useEffect(() => {
    if (!autoConnect) return;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);
    ws.onmessage = handleMessage;

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [url, autoConnect, handleMessage]);

  return {
    connected,
    tick,
    speed,
    assets,
    factions,
    pendingEvents,
    boardState,
    setSpeed,
    strike,
    moveAsset,
    refresh,
  };
}
