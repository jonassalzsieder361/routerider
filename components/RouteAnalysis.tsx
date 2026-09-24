"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import type { GpxPoint } from "@/lib/gpx";
import {
  overpassHeuristicMatcher,
  type MatchedSegment,
  type MatchProgress,
} from "@/lib/mapMatching";
import {
  classifyRoute,
  type SurfaceClass,
  type SurfaceDistribution,
} from "@/lib/surfaceClassification";

const RouteMap = dynamic(
  () => import("@/components/RouteMap").then((mod) => mod.RouteMap),
  { ssr: false }
);

type MatchStatus = "idle" | "loading" | "done" | "error";

interface RouteAnalysisProps {
  points: GpxPoint[];
  /** Fired once map matching + surface classification finish successfully (Phase 6/7 gate on this). */
  onAnalyzed?: (distribution: SurfaceDistribution) => void;
}

const LEGEND: { status: MatchedSegment["status"]; label: string; color: string }[] = [
  { status: "matched", label: "Gematcht", color: "#16a34a" },
  { status: "ambiguous", label: "Mehrdeutig", color: "#f59e0b" },
  { status: "unmatched", label: "Kein Match", color: "#71717a" },
];

const SURFACE_ORDER: SurfaceClass[] = ["paved", "gravel", "trail", "unknown"];

const SURFACE_LEGEND: Record<SurfaceClass, { label: string; color: string }> = {
  paved: { label: "Paved", color: "#334155" },
  gravel: { label: "Gravel", color: "#ca8a04" },
  trail: { label: "Trail", color: "#c2410c" },
  unknown: { label: "Unknown", color: "#a1a1aa" },
};

function SurfaceDistributionBar({ distribution }: { distribution: SurfaceDistribution }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        {SURFACE_ORDER.map((surfaceClass) =>
          distribution[surfaceClass] > 0 ? (
            <div
              key={surfaceClass}
              style={{
                width: `${distribution[surfaceClass]}%`,
                backgroundColor: SURFACE_LEGEND[surfaceClass].color,
              }}
              title={`${SURFACE_LEGEND[surfaceClass].label}: ${distribution[surfaceClass].toFixed(1)}%`}
            />
          ) : null
        )}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-zinc-600 dark:text-zinc-400">
        {SURFACE_ORDER.map((surfaceClass) => (
          <span key={surfaceClass} className="flex items-center gap-1.5">
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: SURFACE_LEGEND[surfaceClass].color }}
            />
            {SURFACE_LEGEND[surfaceClass].label} — {distribution[surfaceClass].toFixed(1)}%
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * Overpass chunks can take a while on mobile connections, and progress only arrives after each
 * chunk finishes — so the bar pulses before the first chunk and a seconds counter keeps ticking,
 * making it visible that the request is still alive rather than hung.
 */
function AnalysisProgress({ progress }: { progress: MatchProgress | null }) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const id = setInterval(() => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const percent = progress ? (progress.completedChunks / progress.totalChunks) * 100 : 0;

  return (
    <div role="status" className="flex flex-col gap-2 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium text-zinc-900 dark:text-zinc-100">
          {progress
            ? `Abschnitt ${progress.completedChunks} von ${progress.totalChunks} geladen`
            : "Wegenetz wird geladen…"}
        </span>
        <span className="shrink-0 tabular-nums text-zinc-500 dark:text-zinc-400">
          {elapsedSeconds} s
        </span>
      </div>
      <div className="relative h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        <div
          className="h-full rounded-full bg-zinc-900 transition-[width] duration-500 dark:bg-zinc-100"
          style={{ width: `${percent}%` }}
        />
        <div className="absolute inset-0 animate-pulse bg-zinc-900/15 dark:bg-zinc-100/15" />
      </div>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Das kann bei langen Routen oder mobiler Verbindung 1–2 Minuten dauern. Die Analyse läuft
        weiter, solange die Sekunden zählen.
      </p>
    </div>
  );
}

export function RouteAnalysis({ points, onAnalyzed }: RouteAnalysisProps) {
  const [status, setStatus] = useState<MatchStatus>("idle");
  const [segments, setSegments] = useState<MatchedSegment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<MatchProgress | null>(null);

  const handleAnalyze = async () => {
    setStatus("loading");
    setError(null);
    setProgress(null);

    try {
      const result = await overpassHeuristicMatcher.matchRoute(points, setProgress);
      setSegments(result);
      setStatus("done");
      onAnalyzed?.(classifyRoute(result).distribution);
    } catch (err) {
      setStatus("error");
      setError(
        err instanceof Error ? err.message : "Map Matching ist fehlgeschlagen."
      );
    }
  };

  const counts = segments
    ? {
        matched: segments.filter((s) => s.status === "matched").length,
        ambiguous: segments.filter((s) => s.status === "ambiguous").length,
        unmatched: segments.filter((s) => s.status === "unmatched").length,
      }
    : null;

  const surfaceDistribution = segments ? classifyRoute(segments).distribution : null;

  return (
    <div className="flex flex-col gap-4">
      <RouteMap points={points} matchedSegments={segments ?? undefined} />

      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={handleAnalyze}
          disabled={status === "loading"}
          className="min-h-11 w-full rounded-full bg-zinc-900 px-5 py-2.5 text-sm sm:w-auto sm:self-start font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          {status === "loading"
            ? "Route wird analysiert…"
            : status === "error"
              ? "Erneut versuchen"
              : "Route analysieren"}
        </button>

        {status === "loading" && <AnalysisProgress progress={progress} />}

        {status === "error" && error && (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        )}

        {status === "done" && counts && (
          <div className="flex flex-col gap-2 text-sm text-zinc-600 dark:text-zinc-400">
            <p>
              {counts.matched} Segmente gematcht, {counts.ambiguous} mehrdeutig,{" "}
              {counts.unmatched} ohne Match.
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {LEGEND.map((item) => (
                <span key={item.status} className="flex items-center gap-1.5">
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: item.color }}
                  />
                  {item.label}
                </span>
              ))}
            </div>
          </div>
        )}

        {status === "done" && surfaceDistribution && (
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
              Surface-Verteilung
            </h3>
            <SurfaceDistributionBar distribution={surfaceDistribution} />
          </div>
        )}
      </div>
    </div>
  );
}
