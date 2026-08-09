import type { ProjectionDocument } from "../types";

export type ExportPreflightFormat =
  | "litematic"
  | "bundle"
  | "schematic"
  | "mcstructure"
  | "mcfunction";

export type ExportPreflightReason = "empty" | "unsafeVolume" | "dimensionLimit";

export interface ExportPreflightOptions {
  volumeLimit?: number;
  maxVolume?: number;
}

export interface ExportPreflightResult {
  format: ExportPreflightFormat;
  allowed: boolean;
  reason: ExportPreflightReason | null;
  dimensions: [number, number, number] | null;
  volume: number | null;
  volumeLimit: number | null;
  dimensionLimit: number | null;
}

export const DEFAULT_DENSE_EXPORT_VOLUME_LIMIT = 64 * 1024 * 1024;
export const SCHEMATIC_DIMENSION_LIMIT = 0x7fff;

const denseFormats = new Set<ExportPreflightFormat>(["schematic", "mcstructure"]);

const validatedVolumeLimit = (options: ExportPreflightOptions) => {
  const limit = options.volumeLimit ?? options.maxVolume ?? DEFAULT_DENSE_EXPORT_VOLUME_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError("Export preflight volume limit must be a positive safe integer");
  }
  return limit;
};

const safeVolume = (dimensions: readonly number[]) => {
  let volume = 1;
  for (const dimension of dimensions) {
    if (!Number.isSafeInteger(dimension) || dimension <= 0) {
      return { safe: false, volume: Number.POSITIVE_INFINITY };
    }
    if (volume > Number.MAX_SAFE_INTEGER / dimension) {
      return { safe: false, volume: Number.POSITIVE_INFINITY };
    }
    volume *= dimension;
  }
  return { safe: true, volume };
};

export const preflightProjectionExport = (
  document: ProjectionDocument,
  format: ExportPreflightFormat,
  options: ExportPreflightOptions = {},
): ExportPreflightResult => {
  if (!document.bounds || document.blockCount === 0) {
    return {
      format,
      allowed: false,
      reason: "empty",
      dimensions: null,
      volume: null,
      volumeLimit: denseFormats.has(format) ? validatedVolumeLimit(options) : null,
      dimensionLimit: format === "schematic" ? SCHEMATIC_DIMENSION_LIMIT : null,
    };
  }

  const dimensions = [...document.bounds.dimensions] as [number, number, number];
  const measured = safeVolume(dimensions);
  const dimensionLimit = format === "schematic" ? SCHEMATIC_DIMENSION_LIMIT : null;
  const volumeLimit = denseFormats.has(format) ? validatedVolumeLimit(options) : null;

  if (dimensionLimit !== null && dimensions.some((dimension) => (
    !Number.isSafeInteger(dimension) || dimension <= 0 || dimension > dimensionLimit
  ))) {
    return {
      format,
      allowed: false,
      reason: "dimensionLimit",
      dimensions,
      volume: measured.volume,
      volumeLimit,
      dimensionLimit,
    };
  }

  if (volumeLimit !== null && (!measured.safe || measured.volume > volumeLimit)) {
    return {
      format,
      allowed: false,
      reason: "unsafeVolume",
      dimensions,
      volume: measured.volume,
      volumeLimit,
      dimensionLimit,
    };
  }

  return {
    format,
    allowed: true,
    reason: null,
    dimensions,
    volume: measured.volume,
    volumeLimit,
    dimensionLimit,
  };
};
