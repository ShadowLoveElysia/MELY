import type { ProjectionDocument } from "../types";
import {
  preflightProjectionHeight,
  type HeightMode,
  type HeightSafetyErrorCode,
  type ProjectionHeightPreflightInput,
} from "./heightSafety";
import {
  getJavaCompatibilityProfile,
  getJavaVersionProfile,
  requireJavaCompatibilityProfile,
} from "./minecraftVersions";
import {
  assertProjectionDocumentHologramIsolation,
  assertProjectionDocumentIntegrity,
} from "./projectionDocument";
import { getJavaBlockCapability } from "./blockRegistry";

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

export type HeightAwareExportPreflightReason = ExportPreflightReason | HeightSafetyErrorCode;

export interface HeightAwareExportPreflightResult extends Omit<ExportPreflightResult, "reason"> {
  reason: HeightAwareExportPreflightReason | null;
  heightErrorCode: HeightSafetyErrorCode | null;
  requiredHeight: number;
  actualHeight: number;
  placementMinY: number;
  placementMaxY: number;
}

export interface ProjectionHeightExportPreflightInput extends Omit<
  ProjectionHeightPreflightInput,
  "versionId" | "bounds"
> {
  versionId?: string;
}

export type JavaProjectionExportFormat = "litematic" | "schematic" | "bundle";

export interface JavaProjectionExportSafetyInput extends Partial<
  Omit<ProjectionHeightExportPreflightInput, "versionId">
> {
  versionId?: string;
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

const metadataNumber = (document: ProjectionDocument, key: string) => {
  const value = document.metadata?.[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
};

const metadataBoolean = (document: ProjectionDocument, key: string) =>
  document.metadata?.[key] === true;

const metadataHeightMode = (document: ProjectionDocument): HeightMode | null => {
  const value = document.metadata?.heightMode;
  return value === "default" || value === "extended_2032" || value === "experimental_4064"
    ? value
    : null;
};

const targetDimensionFromMetadata = (document: ProjectionDocument) => {
  const minY = metadataNumber(document, "targetDimensionMinY");
  const maxY = metadataNumber(document, "targetDimensionMaxY");
  if (minY === null || maxY === null || maxY < minY) return undefined;
  return { minY, height: maxY - minY + 1 };
};

const serializerSafetyInput = (
  document: ProjectionDocument,
  input: JavaProjectionExportSafetyInput,
): ProjectionHeightExportPreflightInput => {
  const versionId = input.versionId ?? document.minecraftVersion;
  const compatibility = getJavaCompatibilityProfile(versionId);
  const profile = compatibility?.requestedProfile ?? getJavaVersionProfile(versionId);
  const serializerProfile = compatibility?.serializerProfile;
  const actualHeight = document.bounds?.dimensions[1] ?? 0;
  const declaredMode = input.heightMode ?? metadataHeightMode(document);
  const defaultHeight = profile?.defaultDimension?.height
    ?? serializerProfile?.defaultDimension.height
    ?? 0;
  const heightMode = declaredMode ?? (actualHeight <= defaultHeight ? "default" : "extended_2032");
  const metadataTargetHeight = metadataNumber(document, "targetHeight");
  const targetHeight = input.targetHeight ?? metadataTargetHeight ?? actualHeight;
  const targetDimension = input.targetDimension ?? targetDimensionFromMetadata(document);
  const placementBottomY = input.placementBottomY
    ?? metadataNumber(document, "placementBottomY")
    ?? targetDimension?.minY
    ?? profile?.defaultDimension?.minY
    ?? serializerProfile?.defaultDimension.minY
    ?? 0;
  return {
    versionId,
    heightMode,
    targetHeight,
    datapackAcknowledged: input.datapackAcknowledged
      ?? metadataBoolean(document, "datapackAcknowledged"),
    placementBottomY,
    targetDimension,
    confirmations: input.confirmations,
    configurationFingerprint: input.configurationFingerprint,
    exportFingerprint: input.exportFingerprint,
  };
};

const serializerExporterKey = (format: JavaProjectionExportFormat) =>
  format === "schematic" ? "spongeSchematic" : "litematic";

/**
 * Java 最终序列化器的统一门禁。扩展高度必须携带完整目标维度声明，
 * 防止把默认 384 层范围误当成第三方扩展维度。
 */
export const assertJavaProjectionExportSafety = (
  document: ProjectionDocument,
  format: JavaProjectionExportFormat,
  input: JavaProjectionExportSafetyInput = {},
) => {
  if (document.edition !== "java") {
    throw new RangeError(`${format} export requires a Java Edition projection document`);
  }
  assertProjectionDocumentIntegrity(document, `${format} export`);
  assertProjectionDocumentHologramIsolation(document, `${format} export`);
  const resolved = serializerSafetyInput(document, input);
  if (resolved.versionId !== document.minecraftVersion) {
    throw new RangeError(
      `JAVA_VERSION_PROFILE_MISMATCH: Safety version ${resolved.versionId} does not match document version ${document.minecraftVersion}`,
    );
  }
  const compatibility = requireJavaCompatibilityProfile(
    resolved.versionId ?? document.minecraftVersion,
  );
  const { requestedProfile, serializerProfile } = compatibility;
  if (!serializerProfile.exporters[serializerExporterKey(format)]) {
    throw new RangeError(
      `EXPORT_FORMAT_UNSUPPORTED_FOR_VERSION: ${format} export has no compatible serializer`,
    );
  }
  for (const state of document.palette) {
    const capability = getJavaBlockCapability(state.blockId, requestedProfile.id);
    if (!capability.serializable) {
      throw new RangeError(
        `JAVA_BLOCK_UNSUPPORTED: ${state.blockId} cannot be serialized for Minecraft Java ${requestedProfile.id} (${capability.reason})`,
      );
    }
  }
  const defaultDimension = requestedProfile.defaultDimension ?? serializerProfile.defaultDimension;
  const defaultHeight = defaultDimension.height;
  const requiredHeight = Math.max(resolved.targetHeight, document.bounds?.dimensions[1] ?? 0);
  if (
    requiredHeight <= defaultHeight
    && resolved.targetDimension
    && (
      resolved.targetDimension.minY !== defaultDimension.minY
      || resolved.targetDimension.height !== defaultDimension.height
    )
  ) {
    throw new RangeError(
      "PLACEMENT_OUTSIDE_DIMENSION_RANGE: Default-height export must use the profile default dimension",
    );
  }
  if (requiredHeight > defaultHeight && !resolved.targetDimension) {
    throw new RangeError(
      "PLACEMENT_OUTSIDE_DIMENSION_RANGE: Extended Java export requires an explicit target dimension range",
    );
  }
  const preflight = preflightProjectionHeight({
    ...resolved,
    versionId: requestedProfile.id,
    bounds: document.bounds,
  });
  if (!preflight.allowed) {
    throw new RangeError(`${preflight.errorCode}: Java projection export safety check failed`);
  }
  return {
    // 保留 profile 作为实际写入 NBT 的 Profile，避免把回退元数据伪装成目标版本。
    profile: serializerProfile,
    requestedProfile,
    serializerProfile,
    compatibility,
    preflight,
    input: resolved,
  };
};

/** 最终导出入口：在旧的格式资源检查之外，重新核验版本、实际高度、Y 范围和确认指纹。 */
export const preflightProjectionHeightExport = (
  document: ProjectionDocument,
  format: ExportPreflightFormat,
  input: ProjectionHeightExportPreflightInput,
  options: ExportPreflightOptions = {},
): HeightAwareExportPreflightResult => {
  const structural = preflightProjectionExport(document, format, options);
  const versionId = input.versionId ?? document.minecraftVersion;
  if (document.edition !== "java") {
    return {
      ...structural,
      heightErrorCode: null,
      requiredHeight: input.targetHeight,
      actualHeight: document.bounds?.dimensions[1] ?? 0,
      placementMinY: input.placementBottomY,
      placementMaxY: input.placementBottomY + Math.max(0, (document.bounds?.dimensions[1] ?? 0) - 1),
    };
  }
  const height = preflightProjectionHeight({
    ...input,
    versionId,
    bounds: document.bounds,
  });
  const common = {
    ...structural,
    requiredHeight: height.requiredHeight,
    actualHeight: height.actualHeight,
    placementMinY: height.placementMinY,
    placementMaxY: height.placementMaxY,
  };
  if (!height.allowed) {
    return {
      ...common,
      allowed: false,
      reason: height.errorCode,
      heightErrorCode: height.errorCode,
    };
  }
  return {
    ...common,
    allowed: structural.allowed,
    reason: structural.reason,
    heightErrorCode: null,
  };
};
