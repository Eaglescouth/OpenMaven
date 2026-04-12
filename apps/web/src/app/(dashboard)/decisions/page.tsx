"use client";

import { useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useSimulation } from "@/lib/use-simulation";

const stageOrder = [
  "DYNAMIC",
  "PENDING_PAIRING",
  "PAIRED",
  "IN_EXECUTION",
  "COMPLETE",
] as const;

type TargetStage = typeof stageOrder[number];

const stageLabels: Record<TargetStage, { label: string; color: string; border: string }> = {
  DYNAMIC: { label: "DYNAMIC", color: "text-amber-300", border: "border-amber-500" },
  PENDING_PAIRING: { label: "PENDING PAIRING", color: "text-sky-300", border: "border-sky-500" },
  PAIRED: { label: "PAIRED", color: "text-violet-300", border: "border-violet-500" },
  IN_EXECUTION: { label: "IN EXECUTION", color: "text-emerald-300", border: "border-emerald-500" },
  COMPLETE: { label: "COMPLETE", color: "text-green-300", border: "border-green-500" },
};

function formatTimestamp(iso: string) {
  const date = new Date(iso);
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function DecisionsPage() {
  const router = useRouter();
  const sim = useSimulation();
  const boardState = sim.boardState ?? [];

  const groupedTargets = useMemo(
    () =>
      stageOrder.reduce((acc, stage) => {
        acc[stage] = boardState.filter((target) => target.stage === stage);
        return acc;
      }, {} as Record<TargetStage, typeof boardState>),
    [boardState],
  );

  const handleCardClick = useCallback(
    (target: typeof boardState[number]) => {
      router.push(`/map?lat=${encodeURIComponent(target.detection.lat)}&lng=${encodeURIComponent(target.detection.lon)}`);
    },
    [router],
  );

  return (
    <div className="h-full flex flex-col bg-[var(--om-bg-deep)]">
      <div className="flex items-center justify-between gap-4 px-4 py-3 border-b border-[var(--om-border)] bg-[var(--om-bg-primary)]">
        <div>
          <h1 className="text-sm font-semibold text-[var(--om-text-primary)]">Targeting Board</h1>
          <p className="text-[11px] text-[var(--om-text-muted)] mt-1">
            Live detection targets from the simulation, grouped by stage.
          </p>
        </div>
        <div className="text-[11px] text-[var(--om-text-muted)] tracking-[0.16em] uppercase">
          {boardState.length} active target{boardState.length === 1 ? "" : "s"}
        </div>
      </div>

      <div className="flex-1 overflow-x-auto overflow-y-hidden py-3">
        <div className="flex min-w-max gap-3 px-4">
          {stageOrder.map((stage) => {
            const targets = groupedTargets[stage];
            const config = stageLabels[stage];

            return (
              <div key={stage} className="flex flex-col w-[260px] rounded-sm border border-[var(--om-border)] bg-[var(--om-bg-primary)] overflow-hidden">
                <div className={`px-3 py-2 border-b ${config.border} bg-[var(--om-bg-elevated)]`}>
                  <div className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${config.color}`}>
                    {config.label}
                  </div>
                  <div className="text-[9px] text-[var(--om-text-muted)] mt-1">
                    {targets.length} item{targets.length === 1 ? "" : "s"}
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto p-3 space-y-3">
                  {targets.length === 0 ? (
                    <div className="text-[10px] text-[var(--om-text-disabled)]">No targets</div>
                  ) : (
                    targets.map((target) => (
                      <button
                        key={target.target_id}
                        type="button"
                        onClick={() => handleCardClick(target)}
                        className="w-full text-left rounded-sm border border-[var(--om-border-strong)] bg-[var(--om-bg-deep)] p-3 transition hover:border-[var(--om-blue)] hover:bg-[var(--om-bg-hover)]"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="text-[10px] font-semibold text-[var(--om-text-secondary)] uppercase tracking-[0.12em]">
                            {target.detection.asset_type}
                          </div>
                          <div className="text-[10px] text-[var(--om-blue-light)] font-semibold">
                            {Math.round(target.detection.confidence)}%
                          </div>
                        </div>

                        <div className="mt-2 text-[12px] font-semibold text-[var(--om-text-primary)] leading-snug">
                          {target.detection.grid_ref}
                        </div>

                        <div className="mt-2 text-[10px] text-[var(--om-text-muted)]">
                          Source: {target.detection.source_label}
                        </div>

                        <div className="mt-3 flex items-center justify-between text-[9px] text-[var(--om-text-muted)]">
                          <span>{formatTimestamp(target.detection.timestamp)}</span>
                          <span className="font-[family-name:var(--font-mono)]">#{target.target_id.slice(-6)}</span>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
