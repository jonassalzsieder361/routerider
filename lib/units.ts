export type PressureUnit = "psi" | "bar";

const PSI_PER_BAR = 14.5038;

export function psiToBar(psi: number): number {
  return psi / PSI_PER_BAR;
}

/** Whole-number psi, or bar rounded to one decimal — display only, never used for calculation. */
export function formatPressure(psi: number, unit: PressureUnit): string {
  return unit === "psi" ? `${Math.round(psi)}` : psiToBar(psi).toFixed(1);
}
