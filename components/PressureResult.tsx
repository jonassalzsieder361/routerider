"use client";

import { useState } from "react";
import { WHEEL_DIAMETER_LABELS, type BikeSetupValues } from "@/components/BikeSetup";
import {
  calculateFrontRearPressure,
  SURFACE_MODIFIERS,
  type WheelPressureResult,
} from "@/lib/pressureEngine";
import type { SurfaceDistribution } from "@/lib/surfaceClassification";
import { formatPressure, psiToBar, type PressureUnit } from "@/lib/units";

interface PressureResultProps {
  bikeSetup: BikeSetupValues;
  distribution: SurfaceDistribution;
}

// docs/RouteRider Tire Pressure.pdf, Section 36 "Product Transparency" — the doc marks the final
// wording as still open; this is the wording given for Phase 8.
const DISCLAIMER =
  "Diese Empfehlung ist ein Ausgangspunkt, kein Sicherheitsgarant. Passe den Druck nach eigenem Gefühl und Fahrbedingungen an.";

const RIDE_TYPE_LABELS: Record<BikeSetupValues["rideType"], string> = {
  performance: "Performance / Race",
  gravel: "Gravel / Endurance",
  bikepacking: "Bikepacking / Loaded",
};

// Shades from the "Trail" concept's terrain-mix bar (B-Result.dc.html), plus a track tone for Unknown.
const SURFACE_ROWS: { key: keyof SurfaceDistribution; label: string; color: string; modifier?: number }[] = [
  { key: "paved", label: "Paved", color: "#D4D1C9", modifier: SURFACE_MODIFIERS.paved },
  { key: "gravel", label: "Gravel", color: "#9A9A9A", modifier: SURFACE_MODIFIERS.gravel },
  { key: "trail", label: "Trail", color: "#2A2A2A", modifier: SURFACE_MODIFIERS.trail },
  { key: "unknown", label: "Unknown", color: "#F0EEE7" },
];

/** Intermediate values keep one extra decimal so each step of the explanation stays traceable. */
function formatDetail(psi: number, unit: PressureUnit): string {
  return unit === "psi" ? psi.toFixed(1) : psiToBar(psi).toFixed(2);
}

function formatKg(kg: number): string {
  return Number.isInteger(kg) ? `${kg}` : kg.toFixed(1);
}

interface UnitToggleProps {
  unit: PressureUnit;
  onChange: (unit: PressureUnit) => void;
}

/** PSI/BAR segmented control — moss-green active state from the "Trail" design concept. */
function UnitToggle({ unit, onChange }: UnitToggleProps) {
  const options: { value: PressureUnit; label: string }[] = [
    { value: "psi", label: "PSI" },
    { value: "bar", label: "BAR" },
  ];

  return (
    <div className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-[#F0EEE7] p-[3px]">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === unit}
          onClick={() => onChange(option.value)}
          // Invisible ::before extends the tap area to >=44px tall without changing the pill's look.
          className={`relative rounded-full px-3 py-1.5 text-[11.5px] font-semibold transition-colors before:absolute before:inset-x-0 before:-inset-y-2 ${
            option.value === unit ? "bg-[#3F6B4A] text-white" : "text-[#6B6660]"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

interface PressureCardProps {
  label: string;
  unit: PressureUnit;
  wheel: WheelPressureResult;
}

function PressureCard({ label, unit, wheel }: PressureCardProps) {
  return (
    <div className="flex flex-1 flex-col items-center gap-1 rounded-2xl border border-[#EDEAE2] bg-white px-2 py-5">
      <span className="text-[11px] uppercase tracking-[1px] text-[#8A857C]">{label}</span>
      <span className="text-[44px] font-semibold leading-none tabular-nums text-[#1A1A1A]">
        {formatPressure(wheel.psi, unit)}
      </span>
      <span className="text-xs text-[#8A857C]">{unit}</span>
      {wheel.clamped && (
        <span className="mt-1 rounded-full bg-[#F6EFE3] px-2.5 py-0.5 text-[11px] font-medium text-[#8A5A1F]">
          auf sicheren Bereich angepasst
        </span>
      )}
    </div>
  );
}

function TerrainMixBar({ distribution }: { distribution: SurfaceDistribution }) {
  const rows = SURFACE_ROWS.filter((row) => distribution[row.key] > 0);

  return (
    <div className="flex flex-col gap-2">
      <span className="text-[13px] font-semibold">Terrain mix</span>
      <div className="flex h-2.5 overflow-hidden rounded-full bg-[#F0EEE7]">
        {rows.map((row) => (
          <div
            key={row.key}
            style={{ width: `${distribution[row.key]}%`, background: row.color }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-[11.5px] text-[#6B6660]">
        {rows.map((row) => (
          <span key={row.key}>
            {row.label} {Math.round(distribution[row.key])}%
          </span>
        ))}
      </div>
    </div>
  );
}

interface OptionalPsiInputProps {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
}

function OptionalPsiInput({ label, value, onChange }: OptionalPsiInputProps) {
  return (
    <label className="flex flex-col gap-1 text-[11.5px] text-[#6B6660]">
      {label}
      <input
        type="number"
        placeholder="—"
        value={value ?? ""}
        onChange={(e) => {
          const raw = e.target.value;
          onChange(raw === "" ? null : Number(raw));
        }}
        className="min-h-11 w-full rounded-xl border border-[#E3E0D8] bg-white px-3 py-1.5 text-[13px] text-[#1A1A1A] outline-none focus:border-[#3F6B4A]"
      />
    </label>
  );
}

function Step({ index, title, children }: { index: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2.5 sm:gap-3">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#EAF1EC] text-[11px] font-semibold text-[#3F6B4A]">
        {index}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="text-[13px] font-semibold">{title}</span>
        <div className="flex flex-col gap-1.5 text-[12.5px] leading-relaxed text-[#6B6660]">
          {children}
        </div>
      </div>
    </div>
  );
}

/** Front | Rear row inside the explanation steps, so both wheels are always read side by side. */
function WheelRow({ label, front, rear }: { label: string; front: string; rear: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 tabular-nums">
      <span>{label}</span>
      {/* ml-auto keeps the values right-aligned when they wrap below the label on narrow phones. */}
      <span className="ml-auto flex gap-x-4 whitespace-nowrap">
        <span>
          <span className="text-[#9A9488]">F </span>
          <span className="text-[#1A1A1A]">{front}</span>
        </span>
        <span>
          <span className="text-[#9A9488]">R </span>
          <span className="text-[#1A1A1A]">{rear}</span>
        </span>
      </span>
    </div>
  );
}

/** Phase 8 result screen (docs Sections 34–36): front/rear recommendation, "Why?" breakdown, disclaimer. */
export function PressureResult({ bikeSetup, distribution }: PressureResultProps) {
  const [unit, setUnit] = useState<PressureUnit>("psi");
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
  const { front, rear } = result;

  const systemWeightKg =
    bikeSetup.riderWeightKg + bikeSetup.bikeWeightKg + bikeSetup.luggageWeightKg;
  const frontLoadKg = (systemWeightKg * bikeSetup.frontWeightPercent) / 100;
  const rearLoadKg = (systemWeightKg * bikeSetup.rearWeightPercent) / 100;

  const tireTypeLabel = bikeSetup.tireType === "tubeless" ? "Tubeless" : "Schlauch";
  const tireWidthLabel =
    bikeSetup.frontTireWidthMm === bikeSetup.rearTireWidthMm
      ? `${bikeSetup.frontTireWidthMm} mm`
      : `${bikeSetup.frontTireWidthMm}/${bikeSetup.rearTireWidthMm} mm`;

  const knownShare = distribution.paved + distribution.gravel + distribution.trail;
  const anyClamped = front.clamped || rear.clamped;
  const hasUserBounds =
    frontMinPsi !== null || frontMaxPsi !== null || rearMinPsi !== null || rearMaxPsi !== null;

  return (
    <div
      style={{ fontFamily: "var(--font-work-sans)" }}
      className="flex flex-col gap-5 rounded-2xl border border-[#EDEAE2] bg-[#FAF9F6] p-4 text-[#1A1A1A] sm:p-6"
    >
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[17px] font-semibold">Empfohlener Reifendruck</h2>
          <UnitToggle unit={unit} onChange={setUnit} />
        </div>
        <p className="text-[13px] text-[#6B6660]">
          Optimiert für dein {tireWidthLabel} {tireTypeLabel}-Setup und den Surface-Mix dieser
          Route.
        </p>
      </div>

      <div className="flex gap-3">
        <PressureCard label="Front" unit={unit} wheel={front} />
        <PressureCard label="Rear" unit={unit} wheel={rear} />
      </div>

      <TerrainMixBar distribution={distribution} />

      <details className="group rounded-[14px] border border-[#EDEAE2] bg-white px-3 sm:px-4">
        <summary className="flex min-h-11 cursor-pointer list-none flex-col justify-center gap-2 py-3.5 [&::-webkit-details-marker]:hidden">
          <span className="flex items-center justify-between gap-3">
            <span className="text-[13.5px] font-semibold">Warum dieser Druck?</span>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#1A1A1A"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0 transition-transform group-open:rotate-180"
            aria-hidden
          >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </span>
          <span className="text-xs leading-relaxed text-[#6B6660] group-open:hidden">
          Berto-Formel, angepasst an {Math.round(distribution.gravel)}% Gravel /{" "}
          {Math.round(distribution.trail)}% Trail, {tireWidthLabel} {tireTypeLabel},{" "}
          {formatKg(systemWeightKg)} kg Systemgewicht.
          </span>
        </summary>

        <div className="flex flex-col gap-5 border-t border-[#EDEAE2] pt-4 pb-4">
          <Step index={1} title="Dein Setup">
            <div className="flex justify-between gap-4 tabular-nums">
              <span>Systemgewicht</span>
              <span className="text-[#1A1A1A]">{formatKg(systemWeightKg)} kg</span>
            </div>
            <span className="text-[11.5px] text-[#9A9488]">
              Fahrer {formatKg(bikeSetup.riderWeightKg)} kg + Bike{" "}
              {formatKg(bikeSetup.bikeWeightKg)} kg + Gepäck {formatKg(bikeSetup.luggageWeightKg)}{" "}
              kg · {RIDE_TYPE_LABELS[bikeSetup.rideType]}, Verteilung{" "}
              {bikeSetup.frontWeightPercent}/{bikeSetup.rearWeightPercent}
            </span>
            <WheelRow
              label="Radlast"
              front={`${formatKg(frontLoadKg)} kg`}
              rear={`${formatKg(rearLoadKg)} kg`}
            />
            <WheelRow
              label="Reifenbreite"
              front={`${bikeSetup.frontTireWidthMm} mm`}
              rear={`${bikeSetup.rearTireWidthMm} mm`}
            />
            <WheelRow label="Reifen-Setup" front={tireTypeLabel} rear={tireTypeLabel} />
          </Step>

          <Step index={2} title="Berto-Basis (Rohwert)">
            <span>
              Druck aus Radlast und Reifenbreite — noch ohne Terrain und Sicherheitsbereich.
            </span>
            <WheelRow
              label="Rohwert"
              front={`${formatDetail(front.basePsi, unit)} ${unit}`}
              rear={`${formatDetail(rear.basePsi, unit)} ${unit}`}
            />
            <span className="font-mono text-[11px] text-[#9A9488]">
              600 × Radlast[lbs] / Breite[mm]² + 0.75 × Breite[mm] − 25 = psi
            </span>
          </Step>

          <Step index={3} title={`Terrain-Modifier × ${result.terrainModifier.toFixed(2)}`}>
            <div className="flex flex-col gap-0.5 tabular-nums">
              {SURFACE_ROWS.map((row) => (
                <div key={row.key} className="grid grid-cols-[1fr_auto_auto] gap-x-3 sm:gap-x-4">
                  <span>{row.label}</span>
                  <span className="text-right text-[#1A1A1A]">
                    {distribution[row.key].toFixed(1)}%
                  </span>
                  <span className="w-12 text-right">
                    {row.modifier !== undefined ? `× ${row.modifier.toFixed(2)}` : "—"}
                  </span>
                </div>
              ))}
            </div>
            {distribution.unknown > 0 && knownShare > 0 && (
              <span className="text-[11.5px] text-[#9A9488]">
                Unbekannte Abschnitte zählen nicht mit — Paved/Gravel/Trail werden auf 100 %
                hochgerechnet.
              </span>
            )}
            {knownShare <= 0 && (
              <span className="text-[11.5px] text-[#9A9488]">
                Kein Belag bekannt — Druck bleibt ohne Terrain-Anpassung.
              </span>
            )}
            <WheelRow
              label="Nach Terrain"
              front={`${formatDetail(front.terrainPsi, unit)} ${unit}`}
              rear={`${formatDetail(rear.terrainPsi, unit)} ${unit}`}
            />
          </Step>

          <Step
            index={4}
            title={`Laufrad-Modifier × ${result.wheelDiameterModifier.toFixed(2)}`}
          >
            <span>
              {WHEEL_DIAMETER_LABELS[bikeSetup.wheelDiameter]}
              {bikeSetup.wheelDiameter === "700c"
                ? " ist die Referenz — keine Anpassung."
                : " — kleinere Laufräder brauchen etwas mehr Druck."}
            </span>
            <WheelRow
              label="Nach Laufrad"
              front={`${formatDetail(front.rawPsi, unit)} ${unit}`}
              rear={`${formatDetail(rear.rawPsi, unit)} ${unit}`}
            />
          </Step>

          <Step index={5} title="Sicherheitsbereich">
            <WheelRow
              label="Erlaubt"
              front={`${formatPressure(front.minPsi, unit)}–${formatPressure(front.maxPsi, unit)} ${unit}`}
              rear={`${formatPressure(rear.minPsi, unit)}–${formatPressure(rear.maxPsi, unit)} ${unit}`}
            />
            <span className="text-[11.5px] text-[#9A9488]">
              {hasUserBounds
                ? "Wo angegeben, gelten deine Werte vom Reifen-Aufdruck statt der Standardtabelle."
                : `Standardwerte für Reifenbreite und ${tireTypeLabel}.`}
            </span>
            {anyClamped ? (
              <div className="flex flex-col gap-1.5 rounded-xl bg-[#F6EFE3] px-3 py-2.5 text-[#8A5A1F]">
                <span className="font-medium">
                  Wir haben deinen Wert auf den sicheren Bereich angepasst.
                </span>
                {[
                  { label: "Front", wheel: front },
                  { label: "Rear", wheel: rear },
                ]
                  .filter(({ wheel }) => wheel.clamped)
                  .map(({ label, wheel }) => (
                    <span key={label} className="tabular-nums">
                      {label}: berechnet {formatDetail(wheel.rawPsi, unit)} {unit} → empfohlen{" "}
                      {formatPressure(wheel.psi, unit)} {unit}
                    </span>
                  ))}
              </div>
            ) : (
              <span>Beide Werte liegen im sicheren Bereich — keine Anpassung nötig.</span>
            )}
          </Step>

          <Step index={6} title="Empfehlung">
            <WheelRow
              label="Gerundet"
              front={`${formatPressure(front.psi, unit)} ${unit}`}
              rear={`${formatPressure(rear.psi, unit)} ${unit}`}
            />
          </Step>

          <div className="flex flex-col gap-2 border-t border-[#EDEAE2] pt-4">
            <span className="text-[13px] font-semibold">Grenzwerte vom Reifen-Aufdruck (optional)</span>
            <span className="text-[11.5px] text-[#9A9488]">
              In psi. Ersetzt die Standardtabelle für das jeweilige Rad.
            </span>
            <div className="grid grid-cols-2 gap-3">
              <OptionalPsiInput label="Front min" value={frontMinPsi} onChange={setFrontMinPsi} />
              <OptionalPsiInput label="Front max" value={frontMaxPsi} onChange={setFrontMaxPsi} />
              <OptionalPsiInput label="Rear min" value={rearMinPsi} onChange={setRearMinPsi} />
              <OptionalPsiInput label="Rear max" value={rearMaxPsi} onChange={setRearMaxPsi} />
            </div>
          </div>
        </div>
      </details>

      <p className="text-center text-[12px] italic leading-relaxed text-[#8A857C]">{DISCLAIMER}</p>
    </div>
  );
}
