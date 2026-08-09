export const DEFAULT_TARGET_HEIGHT = 320;
export const VANILLA_WORLD_HEIGHT = 384;
export const EXTENDED_WORLD_HEIGHT = 2032;

export type HeightLimitMode = "vanilla" | "extended";
export type HeightRiskLevel = "safe" | "extended";

export interface HeightSafetyState {
  mode: HeightLimitMode;
  maximum: number;
  targetHeight: number;
  risk: HeightRiskLevel;
  requiresExportConfirmation: boolean;
}

export interface ProjectionHeightBounds {
  min: readonly [number, number, number];
  max: readonly [number, number, number];
  dimensions?: readonly [number, number, number];
}

export interface ProjectionHeightRisk {
  targetHeight: number;
  actualHeight: number;
  requiredHeight: number;
  risk: HeightRiskLevel;
  requiresExportConfirmation: boolean;
}

const roundedHeight = (value: number) => {
  if (!Number.isFinite(value)) return DEFAULT_TARGET_HEIGHT;
  return Math.round(value);
};

export const heightMaximum = (mode: HeightLimitMode) => mode === "extended"
  ? EXTENDED_WORLD_HEIGHT
  : VANILLA_WORLD_HEIGHT;

export const clampTargetHeight = (value: number, mode: HeightLimitMode) => Math.max(
  32,
  Math.min(heightMaximum(mode), roundedHeight(value)),
);

export const heightRiskLevel = (targetHeight: number): HeightRiskLevel =>
  roundedHeight(targetHeight) > VANILLA_WORLD_HEIGHT ? "extended" : "safe";

const projectionHeight = (bounds?: ProjectionHeightBounds | null) => {
  if (!bounds) return 0;
  const declaredHeight = bounds.dimensions?.[1];
  if (Number.isSafeInteger(declaredHeight) && (declaredHeight ?? 0) > 0) {
    return declaredHeight ?? 0;
  }
  const derivedHeight = bounds.max[1] - bounds.min[1] + 1;
  return Number.isSafeInteger(derivedHeight) && derivedHeight > 0 ? derivedHeight : 0;
};

export const evaluateProjectionHeightRisk = (
  targetHeight: number,
  bounds?: ProjectionHeightBounds | null,
): ProjectionHeightRisk => {
  const normalizedTargetHeight = Math.max(0, roundedHeight(targetHeight));
  const actualHeight = projectionHeight(bounds);
  const requiredHeight = Math.max(normalizedTargetHeight, actualHeight);
  const risk = heightRiskLevel(requiredHeight);
  return {
    targetHeight: normalizedTargetHeight,
    actualHeight,
    requiredHeight,
    risk,
    requiresExportConfirmation: risk === "extended",
  };
};

export const createHeightSafetyState = (
  targetHeight: number,
  mode: HeightLimitMode,
): HeightSafetyState => {
  const normalizedHeight = clampTargetHeight(targetHeight, mode);
  const risk = heightRiskLevel(normalizedHeight);
  return {
    mode,
    maximum: heightMaximum(mode),
    targetHeight: normalizedHeight,
    risk,
    requiresExportConfirmation: risk === "extended",
  };
};

export const lockExtendedHeight = (targetHeight: number): HeightSafetyState =>
  createHeightSafetyState(Math.min(targetHeight, VANILLA_WORLD_HEIGHT), "vanilla");

export const estimateScaledBlockCount = (
  currentBlockCount: number,
  currentHeight: number,
  targetHeight: number,
  surfaceOnly: boolean,
) => {
  if (currentBlockCount <= 0 || currentHeight <= 0 || targetHeight <= 0) return 0;
  const scale = targetHeight / currentHeight;
  const exponent = surfaceOnly ? 2 : 3;
  return Math.max(1, Math.round(currentBlockCount * scale ** exponent));
};
