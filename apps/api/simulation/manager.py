"""SimulationManager — holds world state, runs the tick loop, processes commands."""

import asyncio
import logging
import random
import uuid
from enum import Enum
from typing import Any

from pydantic import BaseModel

from detection.detection_engine import process_assets
from detection.models import Asset, Detection, Target, TargetingBoard, TargetStage
from detection.targeting_board import auto_triage, create_target
from simulation.assets import AssetStatus, MovementOrder, Position, SimAsset
from simulation.events import EventQueue, EventType, Mutation, SimEvent
from simulation.faction import Faction
from simulation.rules import (
    DependencyLink,
    bearing_degrees,
    find_dependents,
    haversine_km,
    interpolate_position,
    resolve_strike_by_names,
    ticks_to_arrive,
)

logger = logging.getLogger(__name__)


# ── Detection helpers ─────────────────────────────────────────────────────────


def _derive_asset_class(asset_type: str) -> str:
    """Map a SimAsset type string to a detection Asset class."""
    t = asset_type.lower()
    if any(k in t for k in ("truck", "supply", "fuel", "depot", "convoy")):
        return "Logistics"
    if any(k in t for k in ("plant", "pump", "hospital", "base", "station")):
        return "Infrastructure"
    return "Military"


def _serialize_detection(d: Detection) -> dict[str, Any]:
    return {
        "detection_id": str(d.detection_id),
        "timestamp": d.timestamp.isoformat(),
        "asset_id": d.asset_id,
        "asset_type": d.asset_type,
        "confidence": d.confidence,
        "grid_ref": d.grid_ref,
        "lat": d.lat,
        "lon": d.lon,
        "source_label": d.source_label,
        "classification": d.classification,
    }


def _serialize_target(t: Target) -> dict[str, Any]:
    return {
        "target_id": t.target_id,
        "detection": _serialize_detection(t.detection),
        "stage": t.stage.value,
        "created_at": t.created_at.isoformat(),
        "updated_at": t.updated_at.isoformat(),
        "history": [[stage.value, ts.isoformat()] for stage, ts in t.history],
    }


# ── Speed control ────────────────────────────────────────────────────────────


class SimSpeed(float, Enum):
    PAUSED = 0.0
    NORMAL = 1.0
    FAST = 2.0
    FASTER = 5.0
    FASTEST = 10.0


# ── State diff (broadcast to clients each tick) ─────────────────────────────


class StateDiff(BaseModel):
    """Changes from a single tick, sent to clients via WebSocket."""

    tick: int
    asset_updates: list[dict[str, Any]]
    events_fired: list[dict[str, Any]]
    alerts: list[str]


# ── Manager ──────────────────────────────────────────────────────────────────


class SimulationManager:
    """Central simulation state and tick loop.

    Holds all world state (assets, factions, events) and runs
    the tick loop as an asyncio background task. Commands from
    WebSocket clients mutate state here.
    """

    def __init__(self, tick_duration_s: float = 10.0) -> None:
        self.tick: int = 0
        self.speed: SimSpeed = SimSpeed.NORMAL
        self.tick_duration_s: float = tick_duration_s
        self._patrol_assets: set[str] = set()  # asset IDs on auto-patrol

        self.assets: dict[str, SimAsset] = {}
        self.factions: dict[str, Faction] = {}
        self.dependencies: list[DependencyLink] = []
        self.event_queue: EventQueue = EventQueue()
        self.event_log: list[SimEvent] = []

        self.targeting_board: TargetingBoard = TargetingBoard()
        self._rng: random.Random = random.Random()

        self._task: asyncio.Task[None] | None = None
        self._broadcast_fn: Any = None  # set externally by WebSocket manager

    # ── Lifecycle ─────────────────────────────────────────────────────────

    def start(self) -> None:
        """Start the background tick loop."""
        if self._task is not None:
            return
        self._task = asyncio.create_task(self._tick_loop())
        logger.info("Simulation started.")

    def stop(self) -> None:
        """Stop the background tick loop."""
        if self._task is None:
            return
        self._task.cancel()
        self._task = None
        logger.info("Simulation stopped.")

    def set_speed(self, speed: SimSpeed) -> None:
        self.speed = speed

    # ── Setup ─────────────────────────────────────────────────────────────

    def add_asset(self, asset: SimAsset) -> None:
        self.assets[asset.asset_id] = asset

    def add_faction(self, faction: Faction) -> None:
        self.factions[faction.faction_id] = faction

    def add_dependency(self, dep: DependencyLink) -> None:
        self.dependencies.append(dep)

    def get_asset(self, asset_id: str) -> SimAsset | None:
        return self.assets.get(asset_id)

    def get_faction(self, faction_id: str) -> Faction | None:
        return self.factions.get(faction_id)

    def get_snapshot(self) -> dict[str, Any]:
        """Return full world state as a serializable dict."""
        return {
            "tick": self.tick,
            "speed": self.speed.value,
            "assets": {k: v.model_dump() for k, v in self.assets.items()},
            "factions": {k: v.model_dump() for k, v in self.factions.items()},
            "pending_events": self.event_queue.pending_count,
        }

    # ── Commands ──────────────────────────────────────────────────────────

    def command_strike(self, weapon_id: str, target_id: str) -> dict[str, Any]:
        """Execute a strike against a target asset."""
        target = self.assets.get(target_id)
        if target is None:
            return {"error": "Target not found"}
        if not target.is_alive():
            return {"error": "Target already destroyed"}

        result = resolve_strike_by_names(weapon_id, target.asset_type)
        if result is None:
            return {"error": f"Unknown weapon: {weapon_id}"}

        target.apply_damage(result.damage_percent)
        self._update_faction_capability(target.faction_id)

        if result.destroyed:
            self._handle_infrastructure_cascade(target_id)

        # Log as event
        event = self.event_queue.create_and_schedule(
            event_type=EventType.STRIKE,
            description=f"Strike on {target.callsign}: {result.description}",
            scheduled_tick=self.tick,  # immediate
            faction_id=target.faction_id,
        )
        self.event_log.append(event)

        return {
            "result": result.model_dump(),
            "target_status": target.status.value,
            "target_health": target.health,
        }

    def command_move(
        self,
        asset_id: str,
        dest_lat: float,
        dest_lon: float,
        dest_alt: float = 0.0,
        terrain: str = "air",
    ) -> dict[str, Any]:
        """Order an asset to move to a destination."""
        asset = self.assets.get(asset_id)
        if asset is None:
            return {"error": "Asset not found"}
        if not asset.is_alive():
            return {"error": "Asset is destroyed"}

        distance = haversine_km(
            asset.position.latitude, asset.position.longitude,
            dest_lat, dest_lon,
        )
        speed = asset.max_speed_kmh or asset.speed_kmh
        ticks = ticks_to_arrive(speed, distance, terrain, self.tick_duration_s)

        if ticks < 0:
            return {"error": "Asset cannot move (zero speed)"}

        asset.movement_order = MovementOrder(
            destination=Position(latitude=dest_lat, longitude=dest_lon, altitude_m=dest_alt),
            start_tick=self.tick,
            arrive_tick=self.tick + ticks,
            origin_lat=asset.position.latitude,
            origin_lon=asset.position.longitude,
        )
        asset.status = AssetStatus.MOVING
        heading = bearing_degrees(
            asset.position.latitude, asset.position.longitude,
            dest_lat, dest_lon,
        )
        asset.position.heading_deg = heading

        return {
            "distance_km": round(distance, 1),
            "eta_ticks": ticks,
            "heading": round(heading, 1),
        }

    # ── Auto-patrol ─────────────────────────────────────────────────────

    # Static asset types that should never patrol
    _STATIC_TYPES: set[str] = {
        "M777 Howitzer", "M224 Mortar", "M142 HIMARS",
        "S-400 Triumf SAM", "MIM-104 Patriot", "Iron Dome Defense System",
        "EW Radar Vehicle", "Forward Operating Base", "Field Hospital",
        "Oil Pump Jack",
    }

    def assign_patrol(self, asset_id: str) -> None:
        """Give an asset a random waypoint near its current position."""
        asset = self.assets.get(asset_id)
        if asset is None or not asset.is_alive():
            return
        if asset.max_speed_kmh <= 0 and asset.speed_kmh <= 0:
            return
        if asset.asset_type in self._STATIC_TYPES:
            return

        # Pick patrol radius based on asset domain
        atype = asset.asset_type
        is_air = any(k in atype for k in (
            "Reaper", "Global Hawk", "F-16", "F-35", "AC-130",
            "AWACS", "Apache", "Chinook", "C-17", "Drone",
        ))
        is_sea = any(k in atype for k in ("DDG", "Arleigh", "Seawolf", "Wasp", "Patrol Boat", "Queen Elizabeth"))

        if is_air:
            radius_deg = 1.5  # ~150 km
            terrain = "air"
            alt = asset.position.altitude_m
        elif is_sea:
            radius_deg = 0.5  # ~50 km
            terrain = "water"
            alt = 0.0
        else:
            radius_deg = 0.15  # ~15 km for ground
            terrain = "desert"
            alt = asset.position.altitude_m

        # Random destination within radius, clamped to theatre
        dlat = (random.random() - 0.5) * 2 * radius_deg
        dlon = (random.random() - 0.5) * 2 * radius_deg
        dest_lat = max(29.0, min(37.0, asset.position.latitude + dlat))
        dest_lon = max(34.0, min(48.0, asset.position.longitude + dlon))

        self.command_move(asset_id, dest_lat, dest_lon, dest_alt=alt, terrain=terrain)
        self._patrol_assets.add(asset_id)

    def assign_all_patrols(self) -> None:
        """Give every mobile asset an initial patrol waypoint."""
        for asset_id, asset in self.assets.items():
            if asset.is_alive() and asset.asset_type not in self._STATIC_TYPES:
                speed = asset.max_speed_kmh or asset.speed_kmh
                if speed > 0:
                    self.assign_patrol(asset_id)

    # ── Tick loop ─────────────────────────────────────────────────────────

    async def _tick_loop(self) -> None:
        """Run forever, advancing one tick per interval."""
        while True:
            if self.speed == SimSpeed.PAUSED:
                await asyncio.sleep(0.1)
                continue

            interval = self.tick_duration_s / self.speed.value
            await asyncio.sleep(interval)
            diff = self._advance_tick()

            if self._broadcast_fn is not None:
                await self._broadcast_fn({"type": "diff", "data": diff.model_dump()})

            detection_payload = self._run_detection_tick()
            if self._broadcast_fn is not None and detection_payload["new_detections"]:
                await self._broadcast_fn({"type": "detections", "data": detection_payload})

    def _advance_tick(self) -> StateDiff:
        """Process one simulation tick."""
        self.tick += 1
        asset_updates: list[dict[str, Any]] = []
        alerts: list[str] = []

        # 1. Process movement
        for asset in self.assets.values():
            update = self._tick_movement(asset)
            if update:
                asset_updates.append(update)

        # 2. Fire due events
        due_events = self.event_queue.pop_due_events(self.tick)
        events_fired = []
        for event in due_events:
            fired = self._resolve_event(event)
            if fired:
                events_fired.append(event.model_dump())
                self.event_log.append(event)

        return StateDiff(
            tick=self.tick,
            asset_updates=asset_updates,
            events_fired=events_fired,
            alerts=alerts,
        )

    def _tick_movement(self, asset: SimAsset) -> dict[str, Any] | None:
        """Update position for a moving asset. Returns update dict or None."""
        if asset.movement_order is None:
            return None

        order = asset.movement_order

        if self.tick >= order.arrive_tick:
            # Arrived
            asset.position.latitude = order.destination.latitude
            asset.position.longitude = order.destination.longitude
            asset.position.altitude_m = order.destination.altitude_m
            asset.movement_order = None
            asset.status = AssetStatus.ACTIVE

            # Auto-reassign patrol waypoint
            if asset.asset_id in self._patrol_assets:
                self.assign_patrol(asset.asset_id)

            return {
                "asset_id": asset.asset_id,
                "event": "arrived",
                "position": asset.position.model_dump(),
            }

        # In transit — interpolate
        total_ticks = order.arrive_tick - order.start_tick
        elapsed = self.tick - order.start_tick
        fraction = elapsed / total_ticks

        lat, lon = interpolate_position(
            order.origin_lat, order.origin_lon,
            order.destination.latitude, order.destination.longitude,
            fraction,
        )
        asset.position.latitude = lat
        asset.position.longitude = lon

        return {
            "asset_id": asset.asset_id,
            "event": "moving",
            "position": asset.position.model_dump(),
            "progress": round(fraction, 2),
        }

    def _resolve_event(self, event: SimEvent) -> bool:
        """Roll probability and execute an event. Returns True if it fired."""
        if event.probability < 1.0 and random.random() > event.probability:
            return False

        for mutation in event.mutations:
            self._apply_mutation(mutation)
        return True

    def _apply_mutation(self, mutation: Mutation) -> None:
        """Apply a single mutation to world state."""
        action = mutation.action
        params = mutation.params

        if action == "destroy_asset":
            asset = self.assets.get(params.get("asset_id", ""))
            if asset:
                asset.destroy()
                self._update_faction_capability(asset.faction_id)
                self._handle_infrastructure_cascade(asset.asset_id)

        elif action == "damage_asset":
            asset = self.assets.get(params.get("asset_id", ""))
            if asset:
                asset.apply_damage(params.get("damage", 0.5))
                self._update_faction_capability(asset.faction_id)

        elif action == "move_asset":
            self.command_move(
                params.get("asset_id", ""),
                params.get("latitude", 0),
                params.get("longitude", 0),
            )

        elif action == "update_leader":
            faction = self.factions.get(params.get("faction_id", ""))
            if faction:
                faction.kill_leader(params.get("leader_id", ""))

        elif action == "update_morale":
            faction = self.factions.get(params.get("faction_id", ""))
            if faction:
                faction.apply_morale_hit(params.get("severity", 0.1))

        elif action == "spawn_asset":
            asset_data = params.get("asset")
            if asset_data:
                new_asset = SimAsset(**asset_data)
                self.add_asset(new_asset)

        else:
            logger.warning("Unknown mutation action: %s", action)

    # ── Internal helpers ──────────────────────────────────────────────────

    def _update_faction_capability(self, faction_id: str) -> None:
        """Recalculate a faction's capability from surviving assets."""
        faction = self.factions.get(faction_id)
        if faction is None:
            return

        faction_assets = [a for a in self.assets.values() if a.faction_id == faction_id]
        total = len(faction_assets)
        alive = sum(1 for a in faction_assets if a.is_alive())
        faction.recalculate_capability(alive, total)

    def _handle_infrastructure_cascade(self, destroyed_id: str) -> None:
        """When an asset is destroyed, degrade anything that depended on it."""
        dependents = find_dependents(destroyed_id, self.dependencies)
        for dep in dependents:
            target = self.assets.get(dep.target_id)
            if target is None or not target.is_alive():
                continue

            target.apply_damage(dep.degradation_rate)
            self.event_queue.create_and_schedule(
                event_type=EventType.INFRASTRUCTURE_CASCADE,
                description=f"{target.callsign} degraded — lost dependency on {destroyed_id}",
                scheduled_tick=self.tick,
            )

    def _run_detection_tick(self) -> dict[str, Any]:
        """Run the detection engine against red-force assets and update the targeting board."""
        # Build Asset objects for alive red-faction assets only
        red_faction_ids: set[str] = {
            fid for fid, f in self.factions.items() if f.side == "red"
        }
        detection_assets: dict[str, Asset] = {
            sim.asset_id: Asset(
                asset_id=sim.asset_id,
                asset_type=sim.asset_type,
                asset_class=_derive_asset_class(sim.asset_type),
                latitude=sim.position.latitude,
                longitude=sim.position.longitude,
                heading_deg=sim.position.heading_deg,
                speed_kmh=sim.speed_kmh,
            )
            for sim in self.assets.values()
            if sim.faction_id in red_faction_ids and sim.is_alive()
        }

        # Roll detections
        detections: list[Detection] = process_assets(detection_assets, self._rng)

        # Skip assets that already have an active (non-COMPLETE) target on the board
        active_asset_ids: set[str] = {
            t.detection.asset_id
            for t in self.targeting_board.targets.values()
            if t.stage != TargetStage.COMPLETE
        }
        new_detections = [d for d in detections if d.asset_id not in active_asset_ids]

        # Create new targets and auto-triage
        for detection in new_detections:
            self.targeting_board = create_target(detection, self.targeting_board)
        self.targeting_board = auto_triage(self.targeting_board)

        return {
            "board_state": [_serialize_target(t) for t in self.targeting_board.targets.values()],
            "new_detections": [_serialize_detection(d) for d in new_detections],
        }
