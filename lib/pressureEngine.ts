import type { BikeSetupValues, TireType, WheelDiameter } from "@/components/BikeSetup";
import type { SurfaceDistribution } from "@/lib/surfaceClassification";

const KG_TO_LBS = 2.2046226218;

/** docs/RouteRider Tire Pressure.pdf, Section 20 "Base Pressure" (Berto-based tire-drop formula). */
export function bertoBasePressurePsi(wheelLoadLbs: number, tireWidthMm: number): number {
  return (600 * wheelLoadLbs) / tireWidthMm ** 2 + 0.75 * tireWidthMm - 25;
}

// docs/RouteRider Tire Pressure.pdf, Section 21 "Terrain Modifiers".
export const SURFACE_MODIFIERS = { paved: 1.0, gravel: 0.9, trail: 0.8 } as const;
const PAVED_MODIFIER = SURFACE_MODIFIERS.paved;
const GRAVEL_MODIFIER = SURFACE_MODIFIERS.gravel;
const TRAIL_MODIFIER = SURFACE_MODIFIERS.trail;

/**
 * Distance-weighted terrain modifier (Section 22). Per Section 15 "Unknown Surface Handling"
 * (Resolved Decision), the known Paved/Gravel/Trail shares are normalized to 100% before use
 * here — Unknown itself carries no modifier weight, since it isn't one of the three surface
 * classes the modifier table covers. If nothing at all is classified, falls back to 1.0 (no
 * modification) rather than dividing by zero.
 */
export function terrainModifier(distribution: SurfaceDistribution): number {
  const known = distribution.paved + distribution.gravel + distribution.trail;
  if (known <= 0) return 1.0;

  return (
    (distribution.paved / known) * PAVED_MODIFIER +
    (distribution.gravel / known) * GRAVEL_MODIFIER +
    (distribution.trail / known) * TRAIL_MODIFIER
  );
}

// D8 "Wheel Diameter Modifier" (Nachtrag in docs/RouteRider - Build Guide v0.1.md, Phase 6/7):
// 700c/29" is the reference; smaller wheels get more pressure. Applied after the terrain
// modifier and before the D6 clamp. One value for the whole bike, front and rear alike.
export const WHEEL_DIAMETER_MODIFIERS: Record<WheelDiameter, number> = {
  "700c": 1.0,
  "650b": 1.05,
  "26": 1.08,
};

// docs/RouteRider Tire Pressure - Resolved Decisions D4-D7.md, D6 "Safety Pressure Bounds" —
// v0.1 generic lookup table, researched per D6's note that concrete numbers are a prerequisite
// for Phase 7. Tube/Tubeless (D4) only changes the minimum; the maximum is shared.
export interface SafetyBounds {
  minTubePsi: number;
  minTubelessPsi: number;
  maxPsi: number;
}

export function safetyBoundsForWidth(tireWidthMm: number): SafetyBounds {
  if (tireWidthMm < 32) return { minTubePsi: 40, minTubelessPsi: 35, maxPsi: 90 };
  if (tireWidthMm <= 40) return { minTubePsi: 30, minTubelessPsi: 22, maxPsi: 65 };
  if (tireWidthMm <= 50) return { minTubePsi: 25, minTubelessPsi: 18, maxPsi: 50 };
  return { minTubePsi: 20, minTubelessPsi: 15, maxPsi: 35 };
}

export interface WheelPressureInput {
  wheelLoadLbs: number;
  tireWidthMm: number;
  tireType: TireType;
  terrainModifier: number;
  wheelDiameterModifier: number;
  /** Printed-on-sidewall override (D6) — replaces the generic table for this wheel when set. */
  userMinPsi?: number | null;
  userMaxPsi?: number | null;
}

export interface WheelPressureResult {
  /** Final recommendation: terrain- and wheel-adjusted, clamped to safety bounds, rounded to whole psi. */
  psi: number;
  /** Pre-clamp value, after terrain and wheel-diameter modifiers, unrounded — for display/debugging. */
  rawPsi: number;
  /** After the terrain modifier, before the wheel-diameter modifier (D8). */
  terrainPsi: number;
  /** Pure Berto result before the terrain modifier. */
  basePsi: number;
  clamped: boolean;
  minPsi: number;
  maxPsi: number;
}

export function calculateWheelPressure(input: WheelPressureInput): WheelPressureResult {
  const basePsi = bertoBasePressurePsi(input.wheelLoadLbs, input.tireWidthMm);
  const terrainPsi = basePsi * input.terrainModifier;
  const rawPsi = terrainPsi * input.wheelDiameterModifier;

  const bounds = safetyBoundsForWidth(input.tireWidthMm);
  const genericMin = input.tireType === "tubeless" ? bounds.minTubelessPsi : bounds.minTubePsi;
  const minPsi = input.userMinPsi ?? genericMin;
  const maxPsi = input.userMaxPsi ?? bounds.maxPsi;

  const clamped = rawPsi < minPsi || rawPsi > maxPsi;
  const clampedPsi = Math.min(maxPsi, Math.max(minPsi, rawPsi));

  return { psi: Math.round(clampedPsi), rawPsi, terrainPsi, basePsi, clamped, minPsi, maxPsi };
}

export interface FrontRearPressureInput {
  bikeSetup: BikeSetupValues;
  distribution: SurfaceDistribution;
  frontUserMinPsi?: number | null;
  frontUserMaxPsi?: number | null;
  rearUserMinPsi?: number | null;
  rearUserMaxPsi?: number | null;
}

export interface FrontRearPressureResult {
  front: WheelPressureResult;
  rear: WheelPressureResult;
  terrainModifier: number;
  wheelDiameterModifier: number;
}

/**
 * Ties Berto base pressure + terrain modifier + wheel-diameter modifier (D8) + D6 safety clamp
 * together for front and rear.
 */
export function calculateFrontRearPressure(
  input: FrontRearPressureInput
): FrontRearPressureResult {
  const { bikeSetup, distribution } = input;

  const systemWeightLbs =
    (bikeSetup.riderWeightKg + bikeSetup.bikeWeightKg + bikeSetup.luggageWeightKg) * KG_TO_LBS;

  const frontLoadLbs = systemWeightLbs * (bikeSetup.frontWeightPercent / 100);
  const rearLoadLbs = systemWeightLbs * (bikeSetup.rearWeightPercent / 100);

  const modifier = terrainModifier(distribution);
  const wheelModifier = WHEEL_DIAMETER_MODIFIERS[bikeSetup.wheelDiameter];

  const front = calculateWheelPressure({
    wheelLoadLbs: frontLoadLbs,
    tireWidthMm: bikeSetup.frontTireWidthMm,
    tireType: bikeSetup.tireType,
    terrainModifier: modifier,
    wheelDiameterModifier: wheelModifier,
    userMinPsi: input.frontUserMinPsi,
    userMaxPsi: input.frontUserMaxPsi,
  });

  const rear = calculateWheelPressure({
    wheelLoadLbs: rearLoadLbs,
    tireWidthMm: bikeSetup.rearTireWidthMm,
    tireType: bikeSetup.tireType,
    terrainModifier: modifier,
    wheelDiameterModifier: wheelModifier,
    userMinPsi: input.rearUserMinPsi,
    userMaxPsi: input.rearUserMaxPsi,
  });

  return { front, rear, terrainModifier: modifier, wheelDiameterModifier: wheelModifier };
}
