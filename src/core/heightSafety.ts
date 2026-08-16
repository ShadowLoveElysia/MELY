import { getJavaVersionProfile } from "./minecraftVersions";
import { sha256Hex } from "./projectionContentHash";

export const DEFAULT_TARGET_HEIGHT = 320;
export const VANILLA_WORLD_HEIGHT = 384;
export const EXTENDED_WORLD_HEIGHT = 2032;
export const EXPERIMENTAL_WORLD_HEIGHT = 4064;
export const EXPERIMENTAL_WORLD_MIN_Y = -2032;
export const EXPERIMENTAL_WORLD_MAX_Y = 2031;
export const COMPATIBILITY_DEFAULT_DIMENSION: Readonly<HeightDimension> = Object.freeze({
  minY: -64,
  height: VANILLA_WORLD_HEIGHT,
});

/** 旧名称仍供现有 UI 使用；核心 API 会先转换成三级状态。 */
export type HeightLimitMode = "vanilla" | "extended";
export type HeightMode = "default" | "extended_2032" | "experimental_4064";
export type HeightModeInput = HeightMode | HeightLimitMode;
export type HeightRiskLevel = "safe" | "extended" | "experimental";

export type HeightSafetyErrorCode =
  | "JAVA_VERSION_PROFILE_UNKNOWN"
  | "JAVA_VERSION_PROFILE_UNVERIFIED"
  | "HEIGHT_EXTENSION_UNSUPPORTED_BEFORE_1_17"
  | "HEIGHT_MODE_INVALID"
  | "HEIGHT_TARGET_INVALID"
  | "HEIGHT_DATAPACK_ACK_REQUIRED"
  | "HEIGHT_EXTREME_CONFIRMATION_REQUIRED"
  | "HEIGHT_EXCEEDS_4064"
  | "TARGET_DIMENSION_DECLARATION_REQUIRED"
  | "PLACEMENT_OUTSIDE_DIMENSION_RANGE"
  | "EXPORT_FORMAT_UNSUPPORTED_FOR_VERSION";

export type HeightSafetyWarningCode =
  | "JAVA_VERSION_BEST_EFFORT"
  | "HEIGHT_DEFAULT_DIMENSION_FALLBACK"
  | "HEIGHT_EXTENSION_UNTESTED_FOR_VERSION";

export interface HeightDimension {
  minY: number;
  height: number;
}

export interface HeightSafetyProfile {
  id: string;
  releaseStatus: "verified" | "provisional" | "untested" | "unavailable";
  heightEra: "legacy_fixed" | "modern_datapack" | "unknown";
  defaultDimension: HeightDimension | null;
  heightCapability: "default_only" | "third_party_extended";
  maximumVerifiedHeight: number | null;
  verification?: unknown;
  exporters?: {
    litematic?: unknown | null;
    spongeSchematic?: unknown | null;
    legacySchematic?: unknown | null;
  };
}

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

export interface ExtremeHeightConfirmationRecord {
  confirmedAt: number;
  configurationFingerprint: string;
  summary: string;
}

export interface ExtremeExportConfirmationRecord extends ExtremeHeightConfirmationRecord {
  exportFingerprint: string;
}

export interface ExtremeHeightConfirmationState {
  unlock: ExtremeHeightConfirmationRecord | null;
  environment: ExtremeHeightConfirmationRecord | null;
  export: ExtremeExportConfirmationRecord | null;
}

export interface ExtremeHeightFingerprintInput {
  projectId: string;
  resultId: string | null;
  generationMode: string;
  generationParameters: Readonly<Record<string, unknown>>;
  versionId: string;
  profileFingerprint: string;
  targetHeight: number;
  actualHeight: number;
  bounds: ProjectionHeightBounds | null;
  targetDimension: HeightDimension & { id: string };
  placementBottomY: number;
  edition: "java" | "bedrock";
  exportFormat: string;
  resourceEstimate: Readonly<Record<string, unknown>>;
}

export interface GenerationHeightPreflightInput {
  versionId: string;
  heightMode: HeightModeInput;
  targetHeight: number;
  datapackAcknowledged?: boolean;
  confirmations?: ExtremeHeightConfirmationState | null;
  configurationFingerprint?: string | null;
  /** 仅用于隔离测试和离线验证；业务入口默认从注册表重新查询。 */
  profile?: HeightSafetyProfile | null;
}

export interface ProjectionHeightPreflightInput extends GenerationHeightPreflightInput {
  bounds: ProjectionHeightBounds | null;
  placementBottomY: number;
  targetDimension?: HeightDimension;
  exportFingerprint?: string | null;
  /** Worker 结果复核尚未进入第三关；最终导出入口不得关闭此检查。 */
  requireExtremeExportConfirmation?: boolean;
}

export interface GenerationHeightPreflightResult {
  allowed: boolean;
  errorCode: HeightSafetyErrorCode | null;
  warnings: readonly HeightSafetyWarningCode[];
  versionId: string;
  mode: HeightMode;
  requiredMode: HeightMode;
  targetHeight: number;
  requiredHeight: number;
  maximumHeight: number;
  dimension: HeightDimension | null;
}

const EMPTY_EXTREME_CONFIRMATIONS: ExtremeHeightConfirmationState = {
  unlock: null,
  environment: null,
  export: null,
};

const roundedHeight = (value: number) => {
  if (!Number.isFinite(value)) return DEFAULT_TARGET_HEIGHT;
  return Math.round(value);
};

const isHeightModeInput = (mode: unknown): mode is HeightModeInput => (
  mode === "default"
  || mode === "extended_2032"
  || mode === "experimental_4064"
  || mode === "vanilla"
  || mode === "extended"
);

const normalizeHeightMode = (mode: unknown): HeightMode => {
  if (mode === "extended" || mode === "extended_2032") return "extended_2032";
  if (mode === "experimental_4064") return "experimental_4064";
  return "default";
};

const requiredModeForHeight = (height: number, defaultHeight: number): HeightMode => {
  if (height <= defaultHeight) return "default";
  if (height <= EXTENDED_WORLD_HEIGHT) return "extended_2032";
  return "experimental_4064";
};

const modeRank = (mode: HeightMode) => {
  if (mode === "default") return 0;
  if (mode === "extended_2032") return 1;
  return 2;
};

const maximumForMode = (mode: HeightMode, defaultHeight: number) => {
  if (mode === "experimental_4064") return EXPERIMENTAL_WORLD_HEIGHT;
  if (mode === "extended_2032") return EXTENDED_WORLD_HEIGHT;
  return defaultHeight;
};

const validDimension = (dimension: HeightDimension | null): dimension is HeightDimension =>
  Boolean(
    dimension
    && Number.isSafeInteger(dimension.minY)
    && Number.isSafeInteger(dimension.height)
    && dimension.height > 0
    && dimension.height <= EXPERIMENTAL_WORLD_HEIGHT
    && Number.isSafeInteger(dimension.minY + dimension.height - 1),
  );

const profileForInput = (input: GenerationHeightPreflightInput): HeightSafetyProfile | null => {
  if (input.profile !== undefined) return input.profile;
  return getJavaVersionProfile(input.versionId) as HeightSafetyProfile | null;
};

const dimensionForProfile = (profile: HeightSafetyProfile): HeightDimension => (
  validDimension(profile.defaultDimension)
    ? profile.defaultDimension
    : COMPATIBILITY_DEFAULT_DIMENSION
);

const warningsForProfile = (
  profile: HeightSafetyProfile,
  requiredMode: HeightMode,
  targetHeight: number,
): readonly HeightSafetyWarningCode[] => {
  const warnings: HeightSafetyWarningCode[] = [];
  if (profile.releaseStatus !== "verified" || !profile.verification) {
    warnings.push("JAVA_VERSION_BEST_EFFORT");
  }
  if (!validDimension(profile.defaultDimension)) {
    warnings.push("HEIGHT_DEFAULT_DIMENSION_FALLBACK");
  }
  if (
    requiredMode !== "default"
    && (profile.maximumVerifiedHeight === null || targetHeight > profile.maximumVerifiedHeight)
  ) {
    warnings.push("HEIGHT_EXTENSION_UNTESTED_FOR_VERSION");
  }
  return warnings;
};

const failedGenerationPreflight = (
  input: GenerationHeightPreflightInput,
  errorCode: HeightSafetyErrorCode,
  profile: HeightSafetyProfile | null,
  targetHeight: number,
  requiredMode: HeightMode,
  warnings: readonly HeightSafetyWarningCode[] = [],
): GenerationHeightPreflightResult => ({
  allowed: false,
  errorCode,
  warnings,
  versionId: input.versionId,
  mode: normalizeHeightMode(input.heightMode),
  requiredMode,
  targetHeight,
  requiredHeight: targetHeight,
  maximumHeight: profile
    ? maximumForMode(normalizeHeightMode(input.heightMode), dimensionForProfile(profile).height)
    : 0,
  dimension: profile ? dimensionForProfile(profile) : null,
});

export const heightMaximum = (mode: HeightLimitMode) => mode === "extended"
  ? EXTENDED_WORLD_HEIGHT
  : VANILLA_WORLD_HEIGHT;

export const clampTargetHeight = (value: number, mode: HeightLimitMode) => Math.max(
  32,
  Math.min(heightMaximum(mode), roundedHeight(value)),
);

export const heightRiskLevel = (
  targetHeight: number,
  defaultHeight = VANILLA_WORLD_HEIGHT,
): HeightRiskLevel => {
  const normalized = roundedHeight(targetHeight);
  if (normalized > EXTENDED_WORLD_HEIGHT) return "experimental";
  return normalized > defaultHeight ? "extended" : "safe";
};

export const projectionHeight = (bounds?: ProjectionHeightBounds | null) => {
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
  defaultHeight = VANILLA_WORLD_HEIGHT,
): ProjectionHeightRisk => {
  const normalizedTargetHeight = Math.max(0, roundedHeight(targetHeight));
  const actualHeight = projectionHeight(bounds);
  const requiredHeight = Math.max(normalizedTargetHeight, actualHeight);
  const risk = heightRiskLevel(requiredHeight, defaultHeight);
  return {
    targetHeight: normalizedTargetHeight,
    actualHeight,
    requiredHeight,
    risk,
    requiresExportConfirmation: risk !== "safe",
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
    requiresExportConfirmation: risk !== "safe",
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

const canonicalizeFingerprintValue = (value: unknown): unknown => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError("Fingerprint numbers must be finite");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalizeFingerprintValue);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalizeFingerprintValue(entry)]));
  }
  throw new TypeError("Fingerprint input must contain only serializable values");
};

const fingerprint = (kind: string, value: unknown) => {
  const canonical = JSON.stringify([kind, 1, canonicalizeFingerprintValue(value)]);
  return `sha256:${sha256Hex(new TextEncoder().encode(canonical))}`;
};

export const createHeightProfileFingerprint = (profile: HeightSafetyProfile) => fingerprint(
  "MELYHeightProfile",
  profile,
);

export const createExtremeHeightConfigurationFingerprint = (
  input: ExtremeHeightFingerprintInput,
) => fingerprint("MELYExtremeHeightConfiguration", {
  ...input,
  exportFormat: undefined,
  resourceEstimate: undefined,
});

export const createExtremeExportFingerprint = (
  input: ExtremeHeightFingerprintInput,
) => fingerprint("MELYExtremeHeightExport", input);

export const createExtremeHeightConfirmationState = (): ExtremeHeightConfirmationState => ({
  ...EMPTY_EXTREME_CONFIRMATIONS,
});

const confirmationRecord = (
  configurationFingerprint: string,
  summary: string,
  confirmedAt: number,
): ExtremeHeightConfirmationRecord => {
  if (!configurationFingerprint) throw new RangeError("Configuration fingerprint is required");
  if (!Number.isFinite(confirmedAt)) throw new RangeError("Confirmation timestamp must be finite");
  return { configurationFingerprint, summary, confirmedAt };
};

export const confirmExtremeUnlock = (
  state: ExtremeHeightConfirmationState,
  configurationFingerprint: string,
  summary: string,
  confirmedAt = Date.now(),
): ExtremeHeightConfirmationState => ({
  unlock: confirmationRecord(configurationFingerprint, summary, confirmedAt),
  environment: null,
  export: null,
});

export const confirmExtremeEnvironment = (
  state: ExtremeHeightConfirmationState,
  configurationFingerprint: string,
  summary: string,
  confirmedAt = Date.now(),
): ExtremeHeightConfirmationState => {
  if (state.unlock?.configurationFingerprint !== configurationFingerprint) {
    throw new Error("Extreme height unlock confirmation is missing or stale");
  }
  return {
    unlock: state.unlock,
    environment: confirmationRecord(configurationFingerprint, summary, confirmedAt),
    export: null,
  };
};

export const extremeExportPhrase = (requiredHeight: number) => `导出 ${requiredHeight}`;

export const confirmExtremeExport = (
  state: ExtremeHeightConfirmationState,
  configurationFingerprint: string,
  exportFingerprint: string,
  dynamicPhrase: string,
  requiredHeight: number,
  summary: string,
  confirmedAt = Date.now(),
): ExtremeHeightConfirmationState => {
  if (
    state.unlock?.configurationFingerprint !== configurationFingerprint
    || state.environment?.configurationFingerprint !== configurationFingerprint
  ) {
    throw new Error("Extreme height environment confirmation is missing or stale");
  }
  if (dynamicPhrase !== extremeExportPhrase(requiredHeight)) {
    throw new Error("Extreme export phrase does not match the current required height");
  }
  return {
    unlock: state.unlock,
    environment: state.environment,
    export: {
      ...confirmationRecord(configurationFingerprint, summary, confirmedAt),
      exportFingerprint,
    },
  };
};

export const invalidateExtremeConfirmations = (
  state: ExtremeHeightConfirmationState,
  configurationFingerprint: string,
  exportFingerprint?: string,
): ExtremeHeightConfirmationState => {
  if (
    state.unlock?.configurationFingerprint !== configurationFingerprint
    || state.environment?.configurationFingerprint !== configurationFingerprint
  ) return createExtremeHeightConfirmationState();
  if (exportFingerprint !== undefined && state.export?.exportFingerprint !== exportFingerprint) {
    return clearExtremeExportConfirmation(state);
  }
  return state;
};

export const clearExtremeExportConfirmation = (
  state: ExtremeHeightConfirmationState,
): ExtremeHeightConfirmationState => ({ ...state, export: null });

export const hasExtremeEnvironmentConfirmation = (
  state: ExtremeHeightConfirmationState | null | undefined,
  configurationFingerprint: string | null | undefined,
) => Boolean(
  configurationFingerprint
  && state?.unlock?.configurationFingerprint === configurationFingerprint
  && state.environment?.configurationFingerprint === configurationFingerprint,
);

export const hasExtremeExportConfirmation = (
  state: ExtremeHeightConfirmationState | null | undefined,
  configurationFingerprint: string | null | undefined,
  exportFingerprint: string | null | undefined,
) => {
  const exportConfirmation = state?.export;
  return Boolean(
    hasExtremeEnvironmentConfirmation(state, configurationFingerprint)
    && exportFingerprint
    && exportConfirmation?.configurationFingerprint === configurationFingerprint
    && exportConfirmation?.exportFingerprint === exportFingerprint,
  );
};

export const preflightGenerationHeight = (
  input: GenerationHeightPreflightInput,
): GenerationHeightPreflightResult => {
  const profile = profileForInput(input);
  const targetHeight = input.targetHeight;
  const defaultDimension = profile ? dimensionForProfile(profile) : COMPATIBILITY_DEFAULT_DIMENSION;
  const requiredMode = requiredModeForHeight(
    Number.isSafeInteger(targetHeight) && targetHeight > 0 ? targetHeight : 1,
    defaultDimension.height,
  );

  if (!isHeightModeInput(input.heightMode)) {
    return failedGenerationPreflight(
      input,
      "HEIGHT_MODE_INVALID",
      profile,
      targetHeight,
      requiredMode,
    );
  }
  if (!Number.isSafeInteger(targetHeight) || targetHeight <= 0) {
    return failedGenerationPreflight(
      input,
      "HEIGHT_TARGET_INVALID",
      profile,
      targetHeight,
      requiredMode,
    );
  }

  if (targetHeight > EXPERIMENTAL_WORLD_HEIGHT) {
    return failedGenerationPreflight(
      input,
      "HEIGHT_EXCEEDS_4064",
      profile,
      targetHeight,
      requiredMode,
    );
  }
  if (!profile || profile.id !== input.versionId) {
    return failedGenerationPreflight(
      input,
      "JAVA_VERSION_PROFILE_UNKNOWN",
      profile,
      targetHeight,
      requiredMode,
    );
  }

  const mode = normalizeHeightMode(input.heightMode);
  const actualRequiredMode = requiredModeForHeight(targetHeight, defaultDimension.height);
  const warnings = warningsForProfile(profile, actualRequiredMode, targetHeight);
  if (actualRequiredMode !== "default") {
    if (modeRank(mode) < modeRank(actualRequiredMode)) {
      return failedGenerationPreflight(
        input,
        actualRequiredMode === "experimental_4064"
          ? "HEIGHT_EXTREME_CONFIRMATION_REQUIRED"
          : "HEIGHT_DATAPACK_ACK_REQUIRED",
        profile,
        targetHeight,
        actualRequiredMode,
        warnings,
      );
    }
    if (!input.datapackAcknowledged) {
      return failedGenerationPreflight(
        input,
        "HEIGHT_DATAPACK_ACK_REQUIRED",
        profile,
        targetHeight,
        actualRequiredMode,
        warnings,
      );
    }
    if (
      actualRequiredMode === "experimental_4064"
      && !hasExtremeEnvironmentConfirmation(
        input.confirmations,
        input.configurationFingerprint,
      )
    ) {
      return failedGenerationPreflight(
        input,
        "HEIGHT_EXTREME_CONFIRMATION_REQUIRED",
        profile,
        targetHeight,
        actualRequiredMode,
        warnings,
      );
    }
  }

  return {
    allowed: true,
    errorCode: null,
    warnings,
    versionId: input.versionId,
    mode,
    requiredMode: actualRequiredMode,
    targetHeight,
    requiredHeight: targetHeight,
    maximumHeight: maximumForMode(mode, defaultDimension.height),
    dimension: defaultDimension,
  };
};

/**
 * 核心和序列化器共用同一检查：实际模型高度不能低于 UI 声明，
 * 放置后的绝对 Y 范围也必须完整落在目标维度内。
 */
export const preflightProjectionHeight = (
  input: ProjectionHeightPreflightInput,
): GenerationHeightPreflightResult & {
  actualHeight: number;
  placementMinY: number;
  placementMaxY: number;
} => {
  const actualHeight = projectionHeight(input.bounds);
  const requiredHeight = Math.max(input.targetHeight, actualHeight);
  const base = preflightGenerationHeight({ ...input, targetHeight: requiredHeight });
  const placementMinY = input.placementBottomY;
  const placementMaxY = placementMinY + Math.max(0, actualHeight - 1);
  const result = { ...base, requiredHeight, actualHeight, placementMinY, placementMaxY };
  if (!base.allowed) return result;

  const dimension = input.targetDimension ?? (
    base.requiredMode === "default" ? base.dimension : null
  );
  if (!validDimension(dimension)) {
    return {
      ...result,
      allowed: false,
      errorCode: "TARGET_DIMENSION_DECLARATION_REQUIRED",
    };
  }
  const maximumY = dimension.minY + dimension.height - 1;
  if (
    !Number.isSafeInteger(placementMinY)
    || !Number.isSafeInteger(placementMaxY)
    || placementMinY < dimension.minY
    || placementMaxY > maximumY
  ) {
    return { ...result, allowed: false, errorCode: "PLACEMENT_OUTSIDE_DIMENSION_RANGE" };
  }
  if (
    input.requireExtremeExportConfirmation !== false
    && base.requiredMode === "experimental_4064"
    && !hasExtremeExportConfirmation(
      input.confirmations,
      input.configurationFingerprint,
      input.exportFingerprint,
    )
  ) {
    return { ...result, allowed: false, errorCode: "HEIGHT_EXTREME_CONFIRMATION_REQUIRED" };
  }
  return result;
};
