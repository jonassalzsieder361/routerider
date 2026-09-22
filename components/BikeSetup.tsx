"use client";

import { useEffect, useState } from "react";

export type TireType = "tube" | "tubeless";
export type RideType = "performance" | "gravel" | "bikepacking";

export interface BikeSetupValues {
  riderWeightKg: number;
  bikeWeightKg: number;
  luggageWeightKg: number;
  frontTireWidthMm: number;
  rearTireWidthMm: number;
  tireType: TireType;
  rideType: RideType;
  /** Front/rear always sum to 100 by construction — rear is derived, never stored separately. */
  frontWeightPercent: number;
  rearWeightPercent: number;
}

interface BikeSetupProps {
  onChange?: (values: BikeSetupValues) => void;
}

// docs/RouteRider Tire Pressure.pdf, Section 18 "Ride Type & Weight Distribution" —
// names and front/rear starting points as given there (confirmed in Section 46 "Resolved Decisions").
const RIDE_TYPE_PRESETS: Record<RideType, { label: string; front: number }> = {
  performance: { label: "Performance / Race", front: 45 },
  gravel: { label: "Gravel / Endurance", front: 47 },
  bikepacking: { label: "Bikepacking / Loaded", front: 40 },
};

const RIDE_TYPE_ORDER: RideType[] = ["performance", "gravel", "bikepacking"];
const DEFAULT_RIDE_TYPE: RideType = "gravel";

// v0.1 calibration bounds for this data-entry step only — not the D6 safety pressure
// bounds (those clamp the Phase 7 pressure recommendation, a separate concern).
const RIDER_WEIGHT_BOUNDS = { min: 30, max: 180, step: 1, default: 75 };
const BIKE_WEIGHT_BOUNDS = { min: 5, max: 30, step: 0.5, default: 12 };
const LUGGAGE_WEIGHT_BOUNDS = { min: 0, max: 40, step: 0.5, default: 5 };
const TIRE_WIDTH_BOUNDS = { min: 20, max: 75, step: 1, default: 40 };
const FRONT_PERCENT_BOUNDS = { min: 30, max: 60, step: 1 };

interface NumberFieldProps {
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onCommit: (value: number) => void;
}

/** Free typing while focused; clamps into [min, max] and commits on blur. */
function NumberField({ label, unit, value, min, max, step, onCommit }: NumberFieldProps) {
  const [draft, setDraft] = useState(String(value));
  // "Adjusting state during render" (react.dev) instead of an effect: an external commit
  // (e.g. a ride-type preset changing this field) should immediately resync the draft.
  const [syncedValue, setSyncedValue] = useState(value);
  if (value !== syncedValue) {
    setSyncedValue(value);
    setDraft(String(value));
  }

  const commit = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, parsed));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };

  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium text-[#1A1A1A]">{label}</span>
      <div className="flex items-center gap-2 rounded-xl border border-[#E3E0D8] bg-white px-3 py-2">
        <input
          type="number"
          inputMode="decimal"
          value={draft}
          min={min}
          max={max}
          step={step}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          className="w-full min-w-0 bg-transparent text-[15px] text-[#1A1A1A] outline-none"
        />
        <span className="shrink-0 text-[12px] text-[#8A857C]">{unit}</span>
      </div>
      <span className="text-[11px] text-[#9A9488]">
        Bereich: {min}–{max} {unit}
      </span>
    </label>
  );
}

interface SegmentedToggleProps<T extends string> {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}

function SegmentedToggle<T extends string>({ options, value, onChange }: SegmentedToggleProps<T>) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-full bg-[#F0EEE7] p-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={`rounded-full px-4 py-1.5 text-[12.5px] font-semibold transition-colors ${
            option.value === value ? "bg-[#3F6B4A] text-white" : "text-[#6B6660]"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function BikeSetup({ onChange }: BikeSetupProps) {
  const [riderWeightKg, setRiderWeightKg] = useState(RIDER_WEIGHT_BOUNDS.default);
  const [bikeWeightKg, setBikeWeightKg] = useState(BIKE_WEIGHT_BOUNDS.default);
  const [luggageWeightKg, setLuggageWeightKg] = useState(LUGGAGE_WEIGHT_BOUNDS.default);
  const [frontTireWidthMm, setFrontTireWidthMm] = useState(TIRE_WIDTH_BOUNDS.default);
  const [rearTireWidthMm, setRearTireWidthMm] = useState(TIRE_WIDTH_BOUNDS.default);
  const [tireType, setTireType] = useState<TireType>("tubeless");
  const [rideType, setRideType] = useState<RideType>(DEFAULT_RIDE_TYPE);
  const [frontWeightPercent, setFrontWeightPercent] = useState(
    RIDE_TYPE_PRESETS[DEFAULT_RIDE_TYPE].front
  );

  const rearWeightPercent = 100 - frontWeightPercent;
  const systemWeightKg = riderWeightKg + bikeWeightKg + luggageWeightKg;

  useEffect(() => {
    onChange?.({
      riderWeightKg,
      bikeWeightKg,
      luggageWeightKg,
      frontTireWidthMm,
      rearTireWidthMm,
      tireType,
      rideType,
      frontWeightPercent,
      rearWeightPercent,
    });
    // onChange intentionally excluded: it may be a fresh function identity on every parent
    // render, and this effect should only re-fire when the setup values themselves change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    riderWeightKg,
    bikeWeightKg,
    luggageWeightKg,
    frontTireWidthMm,
    rearTireWidthMm,
    tireType,
    rideType,
    frontWeightPercent,
    rearWeightPercent,
  ]);

  const selectPreset = (type: RideType) => {
    setRideType(type);
    setFrontWeightPercent(RIDE_TYPE_PRESETS[type].front);
  };

  return (
    <div
      style={{ fontFamily: "var(--font-work-sans)" }}
      className="flex flex-col gap-6 rounded-2xl border border-[#EDEAE2] bg-[#FAF9F6] p-6 text-[#1A1A1A]"
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-[17px] font-semibold">Bike setup</h2>
        <p className="text-[13px] text-[#6B6660]">
          Diese Werte fließen später in die Reifendruck-Berechnung ein.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <span className="text-[13px] font-semibold">Gewicht</span>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <NumberField
            label="Rider"
            unit="kg"
            value={riderWeightKg}
            min={RIDER_WEIGHT_BOUNDS.min}
            max={RIDER_WEIGHT_BOUNDS.max}
            step={RIDER_WEIGHT_BOUNDS.step}
            onCommit={setRiderWeightKg}
          />
          <NumberField
            label="Bike"
            unit="kg"
            value={bikeWeightKg}
            min={BIKE_WEIGHT_BOUNDS.min}
            max={BIKE_WEIGHT_BOUNDS.max}
            step={BIKE_WEIGHT_BOUNDS.step}
            onCommit={setBikeWeightKg}
          />
          <NumberField
            label="Luggage"
            unit="kg"
            value={luggageWeightKg}
            min={LUGGAGE_WEIGHT_BOUNDS.min}
            max={LUGGAGE_WEIGHT_BOUNDS.max}
            step={LUGGAGE_WEIGHT_BOUNDS.step}
            onCommit={setLuggageWeightKg}
          />
        </div>
        <p className="text-[12px] text-[#8A857C]">
          System weight: <span className="font-semibold text-[#1A1A1A]">{systemWeightKg} kg</span>
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <span className="text-[13px] font-semibold">Reifen</span>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <NumberField
            label="Front width"
            unit="mm"
            value={frontTireWidthMm}
            min={TIRE_WIDTH_BOUNDS.min}
            max={TIRE_WIDTH_BOUNDS.max}
            step={TIRE_WIDTH_BOUNDS.step}
            onCommit={setFrontTireWidthMm}
          />
          <NumberField
            label="Rear width"
            unit="mm"
            value={rearTireWidthMm}
            min={TIRE_WIDTH_BOUNDS.min}
            max={TIRE_WIDTH_BOUNDS.max}
            step={TIRE_WIDTH_BOUNDS.step}
            onCommit={setRearTireWidthMm}
          />
        </div>
        <p className="text-[11px] text-[#9A9488]">
          Die tatsächlich gemessene Reifenbreite liefert das genaueste Ergebnis.
        </p>

        <SegmentedToggle
          options={[
            { value: "tubeless", label: "Tubeless" },
            { value: "tube", label: "Tube" },
          ]}
          value={tireType}
          onChange={setTireType}
        />
      </div>

      <div className="flex flex-col gap-3">
        <span className="text-[13px] font-semibold">Ride type</span>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {RIDE_TYPE_ORDER.map((type) => {
            const preset = RIDE_TYPE_PRESETS[type];
            // Highlight only while the slider still matches this preset's exact split —
            // dragging away from it should visibly deselect every card, per Section 18
            // ("preset preloads the split, but it stays freely editable afterwards").
            const selected = frontWeightPercent === preset.front;
            return (
              <button
                key={type}
                type="button"
                onClick={() => selectPreset(type)}
                className={`flex flex-col items-start gap-1 rounded-xl border px-4 py-3 text-left transition-colors ${
                  selected
                    ? "border-[#3F6B4A] bg-[#EAF1EC]"
                    : "border-[#EDEAE2] bg-white"
                }`}
              >
                <span
                  className={`text-[13.5px] font-semibold ${
                    selected ? "text-[#3F6B4A]" : "text-[#1A1A1A]"
                  }`}
                >
                  {preset.label}
                </span>
                <span className="text-[11.5px] text-[#8A857C]">
                  {preset.front} / {100 - preset.front}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex flex-col gap-2 rounded-xl border border-[#EDEAE2] bg-white p-4">
          <div className="flex items-center justify-between text-[13px] font-semibold">
            <span>Front {frontWeightPercent}%</span>
            <span>Rear {rearWeightPercent}%</span>
          </div>
          <input
            type="range"
            min={FRONT_PERCENT_BOUNDS.min}
            max={FRONT_PERCENT_BOUNDS.max}
            step={FRONT_PERCENT_BOUNDS.step}
            value={frontWeightPercent}
            onChange={(e) => setFrontWeightPercent(Number(e.target.value))}
            className="w-full accent-[#3F6B4A]"
          />
          <p className="text-[11px] text-[#9A9488]">
            Suggested starting point. Adjust if most of your luggage is carried on the front or
            rear of the bike.
          </p>
        </div>
      </div>
    </div>
  );
}
