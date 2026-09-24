"use client";

import { useCallback, useRef, useState } from "react";
import { GpxParseError, parseGpx, type GpxParseResult } from "@/lib/gpx";
import { RouteAnalysis } from "@/components/RouteAnalysis";
import { BikeSetup, type BikeSetupValues } from "@/components/BikeSetup";
import { PressureResult } from "@/components/PressureResult";
import type { SurfaceDistribution } from "@/lib/surfaceClassification";

type Status = "idle" | "loading" | "success" | "error";

export function GpxUpload() {
  const [status, setStatus] = useState<Status>("idle");
  const [fileName, setFileName] = useState<string | null>(null);
  const [result, setResult] = useState<GpxParseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [surfaceDistribution, setSurfaceDistribution] = useState<SurfaceDistribution | null>(
    null
  );
  const [bikeSetup, setBikeSetup] = useState<BikeSetupValues | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".gpx")) {
      setStatus("error");
      setError("Bitte eine .gpx-Datei auswählen.");
      return;
    }

    setStatus("loading");
    setFileName(file.name);
    setError(null);
    setSurfaceDistribution(null);
    setBikeSetup(null);

    try {
      const text = await file.text();
      const parsed = parseGpx(text);
      setResult(parsed);
      setStatus("success");
    } catch (err) {
      setResult(null);
      setStatus("error");
      setError(
        err instanceof GpxParseError
          ? err.message
          : "Die Datei konnte nicht verarbeitet werden."
      );
    }
  }, []);

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    e.target.value = "";
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  return (
    <div className="w-full max-w-xl">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
        }}
        aria-label="GPX-Datei auswählen"
        className={`flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-4 py-10 text-center cursor-pointer transition-colors sm:px-6 sm:py-16 ${
          isDragging
            ? "border-zinc-900 bg-zinc-100 dark:border-zinc-100 dark:bg-zinc-900"
            : "border-zinc-300 dark:border-zinc-700"
        }`}
      >
        <p className="text-base font-medium text-zinc-900 dark:text-zinc-100">
          GPX-Route hochladen
        </p>
        {/* A real-looking button: on touch devices drag & drop doesn't exist, so the tap target
            has to read as "pick a file" and opens the native file picker via the hidden input. */}
        <span className="inline-flex min-h-11 items-center rounded-full bg-zinc-900 px-5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">
          Datei auswählen
        </span>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          .gpx<span className="pointer-coarse:hidden"> · oder Datei hierher ziehen</span>
        </p>
        <input
          ref={inputRef}
          type="file"
          accept=".gpx,application/gpx+xml"
          className="hidden"
          onChange={onInputChange}
        />
      </div>

      {status === "loading" && (
        <p className="mt-4 text-sm break-words text-zinc-500 dark:text-zinc-400">
          Verarbeite {fileName}…
        </p>
      )}

      {status === "error" && error && (
        <p className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</p>
      )}

      {status === "success" && result && (
        <div className="mt-6 flex flex-col gap-4">
          <div className="rounded-xl border border-zinc-200 p-4 sm:p-6 dark:border-zinc-800">
            <p className="text-sm font-medium break-words text-zinc-900 dark:text-zinc-100">
              {fileName}
            </p>
            <dl className="mt-3 grid grid-cols-2 gap-4 text-sm">
              <div>
                <dt className="text-zinc-500 dark:text-zinc-400">Distanz</dt>
                <dd className="font-medium text-zinc-900 dark:text-zinc-100">
                  {(result.distanceMeters / 1000).toFixed(1)} km
                </dd>
              </div>
              <div>
                <dt className="text-zinc-500 dark:text-zinc-400">Höhenmeter</dt>
                <dd className="font-medium text-zinc-900 dark:text-zinc-100">
                  {result.elevationGainMeters !== null
                    ? `${Math.round(result.elevationGainMeters)} m`
                    : "nicht zuverlässig verfügbar"}
                </dd>
              </div>
            </dl>
          </div>

          <RouteAnalysis points={result.points} onAnalyzed={setSurfaceDistribution} />

          {surfaceDistribution && <BikeSetup onChange={setBikeSetup} />}

          {surfaceDistribution && bikeSetup && (
            <PressureResult bikeSetup={bikeSetup} distribution={surfaceDistribution} />
          )}
        </div>
      )}
    </div>
  );
}
