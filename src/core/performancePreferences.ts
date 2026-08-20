export const PERFORMANCE_PREFERENCES_STORAGE_KEY = "mely.performance.nativeWorkerThreads.v1";

export type NativeWorkerThreadPreference =
  | { mode: "auto" }
  | { mode: "manual"; manualThreads: number };

export interface PerformancePreferencesV1 {
  version: 1;
  nativeWorkerThreads: NativeWorkerThreadPreference;
}

export type PerformanceCapabilitySource = "native" | "web";

export interface PerformanceCapabilitiesInput {
  physicalCores?: unknown;
  logicalProcessors?: unknown;
  availableParallelism?: unknown;
  recommendedThreads?: unknown;
  physicalCountReliable?: unknown;
  source?: PerformanceCapabilitySource;
}

export interface PerformanceCapabilities {
  physicalCores: number;
  logicalProcessors: number;
  availableParallelism: number;
  recommendedThreads: number;
  maximumThreads: number;
  physicalCountReliable: boolean;
  source: PerformanceCapabilitySource;
  estimated: boolean;
}

export interface ResolvedNativeWorkerThreads {
  mode: NativeWorkerThreadPreference["mode"];
  requestedThreads: number;
  configuredThreads: number;
  effectiveThreads: number;
  recommendedThreads: number;
  maximumThreads: number;
  reservedPhysicalCores: number;
  wasClamped: boolean;
  aboveRecommended: boolean;
}

const AUTO_PREFERENCES: PerformancePreferencesV1 = {
  version: 1,
  nativeWorkerThreads: { mode: "auto" },
};

const positiveInteger = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.round(value)));
};

const cloneAutoPreferences = (): PerformancePreferencesV1 => ({
  version: 1,
  nativeWorkerThreads: { mode: "auto" },
});

export const createAutoPerformancePreferences = cloneAutoPreferences;

export const createManualPerformancePreferences = (manualThreads: number): PerformancePreferencesV1 => {
  const normalizedThreads = positiveInteger(manualThreads);
  return normalizedThreads === null
    ? cloneAutoPreferences()
    : {
      version: 1,
      nativeWorkerThreads: { mode: "manual", manualThreads: normalizedThreads },
    };
};

export const normalizePerformancePreferences = (value: unknown): PerformancePreferencesV1 => {
  if (!value || typeof value !== "object") return cloneAutoPreferences();
  const candidate = value as Partial<PerformancePreferencesV1>;
  if (candidate.version !== 1) return cloneAutoPreferences();

  const nativeWorkerThreads = candidate.nativeWorkerThreads;
  if (!nativeWorkerThreads || typeof nativeWorkerThreads !== "object") return cloneAutoPreferences();
  if (nativeWorkerThreads.mode === "auto") return cloneAutoPreferences();
  if (nativeWorkerThreads.mode !== "manual") return cloneAutoPreferences();

  return createManualPerformancePreferences(nativeWorkerThreads.manualThreads);
};

export const parsePerformancePreferences = (serialized: string | null | undefined): PerformancePreferencesV1 => {
  if (!serialized) return cloneAutoPreferences();
  try {
    return normalizePerformancePreferences(JSON.parse(serialized));
  } catch {
    return cloneAutoPreferences();
  }
};

export const serializePerformancePreferences = (preferences: unknown): string => (
  JSON.stringify(normalizePerformancePreferences(preferences))
);

/**
 * 保留机器物理拓扑与进程可用并行度两个概念。CPU 亲和性收窄时，推荐值按
 * 可用并行度裁剪，但不能把进程上限伪装成机器物理核心数。
 */
export const normalizePerformanceCapabilities = (
  input: PerformanceCapabilitiesInput,
): PerformanceCapabilities => {
  const source = input.source === "web" ? "web" : "native";
  const rawPhysicalCores = positiveInteger(input.physicalCores);
  const rawLogicalProcessors = positiveInteger(input.logicalProcessors);
  const rawAvailableParallelism = positiveInteger(input.availableParallelism);
  const logicalProcessors = rawLogicalProcessors
    ?? rawAvailableParallelism
    ?? rawPhysicalCores
    ?? 1;
  const availableParallelism = Math.min(rawAvailableParallelism ?? logicalProcessors, logicalProcessors);
  const estimatedPhysicalCores = Math.max(1, Math.ceil(logicalProcessors / 2));
  const physicalCores = Math.min(rawPhysicalCores ?? estimatedPhysicalCores, logicalProcessors);
  const maximumThreads = Math.max(1, Math.min(physicalCores, availableParallelism));
  const recommendedThreads = Math.max(1, Math.min(
    Math.floor(physicalCores / 2),
    availableParallelism,
  ));
  const physicalCountReliable = source === "native"
    && input.physicalCountReliable === true
    && rawPhysicalCores !== null
    && rawPhysicalCores <= logicalProcessors;

  return {
    physicalCores,
    logicalProcessors,
    availableParallelism,
    recommendedThreads,
    maximumThreads,
    physicalCountReliable,
    source,
    estimated: !physicalCountReliable,
  };
};

export const createWebPerformanceCapabilities = (
  hardwareConcurrency: number | null | undefined,
): PerformanceCapabilities => {
  const logicalProcessors = positiveInteger(hardwareConcurrency) ?? 1;
  return normalizePerformanceCapabilities({
    source: "web",
    logicalProcessors,
    availableParallelism: logicalProcessors,
    physicalCores: Math.max(1, Math.ceil(logicalProcessors / 2)),
    physicalCountReliable: false,
  });
};

export const resolveNativeWorkerThreads = (
  preferences: unknown,
  capabilitiesInput: PerformanceCapabilities | PerformanceCapabilitiesInput,
): ResolvedNativeWorkerThreads => {
  const normalizedPreferences = normalizePerformancePreferences(preferences);
  const capabilities = normalizePerformanceCapabilities(capabilitiesInput);
  const mode = normalizedPreferences.nativeWorkerThreads.mode;
  const requestedThreads = mode === "manual"
    ? normalizedPreferences.nativeWorkerThreads.manualThreads
    : capabilities.recommendedThreads;
  const configuredThreads = Math.max(1, Math.min(requestedThreads, capabilities.maximumThreads));

  return {
    mode,
    requestedThreads,
    configuredThreads,
    effectiveThreads: configuredThreads,
    recommendedThreads: capabilities.recommendedThreads,
    maximumThreads: capabilities.maximumThreads,
    reservedPhysicalCores: Math.max(0, capabilities.physicalCores - configuredThreads),
    wasClamped: configuredThreads !== requestedThreads,
    aboveRecommended: configuredThreads > capabilities.recommendedThreads,
  };
};

export const DEFAULT_PERFORMANCE_PREFERENCES = Object.freeze(AUTO_PREFERENCES);
