"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import type { GpxPoint } from "@/lib/gpx";
import {
  overpassHeuristicMatcher,
  type MatchedSegment,
  type MatchProgress,
} from "@/lib/mapMatching";

const RouteMap = dynamic(
  () => import("@/components/RouteMap").then((mod) => mod.RouteMap),
  { ssr: false }
);

type MatchStatus = "idle" | "loading" | "done" | "error";

interface RouteAnalysisProps {
  points: GpxPoint[];
}

const LEGEND: { status: MatchedSegment["status"]; label: string; color: string }[] = [
  { status: "matched", label: "Gematcht", color: "#16a34a" },
  { status: "ambiguous", label: "Mehrdeutig", color: "#f59e0b" },
  { status: "unmatched", label: "Kein Match", color: "#71717a" },
];

export function RouteAnalysis({ points }: RouteAnalysisProps) {
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

  return (
    <div className="flex flex-col gap-4">
      <RouteMap points={points} matchedSegments={segments ?? undefined} />

      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={handleAnalyze}
          disabled={status === "loading"}
          className="self-start rounded-full bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          {status === "loading"
            ? progress
              ? `Route wird analysiert… (${progress.completedChunks}/${progress.totalChunks})`
              : "Route wird analysiert…"
            : status === "error"
              ? "Erneut versuchen"
              : "Route analysieren"}
        </button>

        {status === "error" && error && (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        )}

        {status === "done" && counts && (
          <div className="flex flex-col gap-2 text-sm text-zinc-600 dark:text-zinc-400">
            <p>
              {counts.matched} Segmente gematcht, {counts.ambiguous} mehrdeutig,{" "}
              {counts.unmatched} ohne Match.
            </p>
            <div className="flex flex-wrap gap-4">
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
      </div>
    </div>
  );
}
