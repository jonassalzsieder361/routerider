"use client";

import { useState } from "react";
import type { BikeSetupValues } from "@/components/BikeSetup";
import { calculateFrontRearPressure } from "@/lib/pressureEngine";
import type { SurfaceDistribution } from "@/lib/surfaceClassification";

interface PressureResultProps {
  bikeSetup: BikeSetupValues;
  distribution: SurfaceDistribution;
}

interface OptionalPsiInputProps {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
}

function OptionalPsiInput({ label, value, onChange }: OptionalPsiInputProps) {
  return (
    <label className="flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400">
      {label}
      <input
        type="number"
        placeholder="—"
        value={value ?? ""}
        onChange={(e) => {
          const raw = e.target.value;
          onChange(raw === "" ? null : Number(raw));
        }}
        className="w-24 rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
      />
    </label>
  );
}

interface WheelColumnProps {
  label: string;
  psi: number;
  clamped: boolean;
  minPsi: number;
  maxPsi: number;
  userMinPsi: number | null;
  onUserMinPsiChange: (value: number | null) => void;
  userMaxPsi: number | null;
  onUserMaxPsiChange: (value: number | null) => void;
}

function WheelColumn({
  label,
  psi,
  clamped,
  minPsi,
  maxPsi,
  userMinPsi,
  onUserMinPsiChange,
  userMaxPsi,
  onUserMaxPsiChange,
}: WheelColumnProps) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        {label}
      </span>
      <span className="text-3xl font-semibold text-zinc-900 dark:text-zinc-100">{psi} psi</span>

      {clamped && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          Wir haben deinen Wert auf den sicheren Bereich angepasst ({minPsi}–{maxPsi} psi).
        </p>
      )}

      <div className="mt-2 flex gap-3">
        <OptionalPsiInput label="Min (Aufdruck)" value={userMinPsi} onChange={onUserMinPsiChange} />
        <OptionalPsiInput label="Max (Aufdruck)" value={userMaxPsi} onChange={onUserMaxPsiChange} />
      </div>
    </div>
  );
}

/**
 * Test-only display for Phase 7 (docs Section 44: "STOP → Kalibrierungstest") — the polished
 * result screen is Phase 8's scope, not this one.
 */
export function PressureResult({ bikeSetup, distribution }: PressureResultProps) {
  const [frontMinPsi, setFrontMinPsi] = useState<number | null>(null);
  const [frontMaxPsi, setFrontMaxPsi] = useState<number | null>(null);
  const [rearMinPsi, setRearMinPsi] = useState<number | null>(null);
  const [rearMaxPsi, setRearMaxPsi] = useState<number | null>(null);

  const result = calculateFrontRearPressure({
    bikeSetup,
    distribution,
    frontUserMinPsi: frontMinPsi,
    frontUserMaxPsi: frontMaxPsi,
    rearUserMinPsi: rearMinPsi,
    rearUserMaxPsi: rearMaxPsi,
  });

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-zinc-200 p-6 dark:border-zinc-800">
      <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
        Pressure (Test-Anzeige, Phase 7)
      </h2>

      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        <WheelColumn
          label="Front"
          psi={result.front.psi}
          clamped={result.front.clamped}
          minPsi={result.front.minPsi}
          maxPsi={result.front.maxPsi}
          userMinPsi={frontMinPsi}
          onUserMinPsiChange={setFrontMinPsi}
          userMaxPsi={frontMaxPsi}
          onUserMaxPsiChange={setFrontMaxPsi}
        />
        <WheelColumn
          label="Rear"
          psi={result.rear.psi}
          clamped={result.rear.clamped}
          minPsi={result.rear.minPsi}
          maxPsi={result.rear.maxPsi}
          userMinPsi={rearMinPsi}
          onUserMinPsiChange={setRearMinPsi}
          userMaxPsi={rearMaxPsi}
          onUserMaxPsiChange={setRearMaxPsi}
        />
      </div>

      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Berto-Basis (vor Terrain, vor Clamp) — Front: {result.front.basePsi.toFixed(1)} psi ·
        Rear: {result.rear.basePsi.toFixed(1)} psi
        <br />
        Terrain-Modifier: {result.terrainModifier.toFixed(2)} → terrain-adjusted (vor Clamp) —
        Front: {result.front.rawPsi.toFixed(1)} psi · Rear: {result.rear.rawPsi.toFixed(1)} psi
      </p>
    </div>
  );
}
