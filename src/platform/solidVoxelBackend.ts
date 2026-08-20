import {
  createWebPerformanceCapabilities,
  normalizePerformanceCapabilities,
  type PerformanceCapabilities,
  type PerformanceCapabilitiesInput,
} from "../core/performancePreferences";
import type { SolidOptions } from "../types";

export const SOLID_VOXEL_CPU_CAPABILITIES_COMMAND = "solid_voxel_capabilities";

export type SolidVoxelBackendKind = "native-rayon" | "web-worker";

export type NativeSolidVoxelJobFeature =
  | "rawSnapshotUpload"
  | "nativeResultHandles"
  | "limitedPreview"
  | "chunkBatchPull"
  | "litematicWrite";

export interface NativeSolidVoxelNumericRange {
  minimum: number;
  maximum: number;
}

export interface NativeSupportedSolidOptions {
  fillModes: readonly ["shell"];
  faceDetails: readonly ["off"];
  dithering: NativeSolidVoxelNumericRange;
  ruinDecoration: NativeSolidVoxelNumericRange;
  textureSampling: true;
  skinProtection: true;
  emissiveMapping: true;
}

export interface NativeSolidVoxelJobApi {
  version: 1;
  rawSnapshotVersion: 1;
  nativeResultHandles: true;
  features: readonly NativeSolidVoxelJobFeature[];
  supportedSolidOptions: NativeSupportedSolidOptions;
}

/**
 * 这里只描述后端身份与结果所有权能力。生成、取消和句柄协议会在原生任务
 * command 落地后扩展，避免基础探测层提前调用尚不存在的 command。
 */
export interface SolidVoxelBackend {
  readonly kind: SolidVoxelBackendKind;
  readonly nativeExecution: boolean;
  readonly supportsNativeResultHandles: boolean;
}

export const NATIVE_RAYON_SOLID_VOXEL_BACKEND: SolidVoxelBackend = Object.freeze({
  kind: "native-rayon",
  nativeExecution: true,
  supportsNativeResultHandles: true,
});

export const WEB_WORKER_SOLID_VOXEL_BACKEND: SolidVoxelBackend = Object.freeze({
  kind: "web-worker",
  nativeExecution: false,
  supportsNativeResultHandles: false,
});

export type TauriCpuCapabilityUnavailableReason =
  | "web-runtime"
  | "tauri-api-unavailable"
  | "capability-invoke-failed"
  | "invalid-capability-response";

export type TauriCpuCapabilityProbe =
  | {
    status: "available";
    capabilities: PerformanceCapabilities;
    jobApi: NativeSolidVoxelJobApi | null;
  }
  | {
    status: "unavailable";
    reason: TauriCpuCapabilityUnavailableReason;
  };

export interface TauriCoreCapabilityApi {
  isTauri(): boolean;
  invoke(command: string): Promise<unknown>;
}

export type TauriCoreCapabilityLoader = () => Promise<TauriCoreCapabilityApi>;

export interface SolidVoxelBackendProbeOptions {
  hardwareConcurrency?: number | null;
  webWorkerAvailable?: boolean;
  loadTauriCore?: TauriCoreCapabilityLoader;
}

export type NativeSolidVoxelBackendUnavailableReason =
  | "web-runtime"
  | "native-capability-unavailable"
  | "native-job-command-not-implemented";

export interface SolidVoxelEnvironment {
  capabilities: PerformanceCapabilities;
  nativeCapabilityProbe: TauriCpuCapabilityProbe;
  nativeJobApi: NativeSolidVoxelJobApi | null;
  nativeJobAvailable: boolean;
  nativeBackendUnavailableReason: NativeSolidVoxelBackendUnavailableReason | null;
  usedWebCapabilityFallback: boolean;
  webWorkerFallbackAvailable: boolean;
}

export interface SolidVoxelBackendProbeResult extends SolidVoxelEnvironment {
  backend: SolidVoxelBackend | null;
}

const loadTauriCore: TauriCoreCapabilityLoader = async () => {
  const core = await import("@tauri-apps/api/core");
  return {
    isTauri: core.isTauri,
    invoke: (command) => core.invoke<unknown>(command),
  };
};

const isPositiveSafeInteger = (value: unknown): value is number => (
  typeof value === "number"
  && Number.isSafeInteger(value)
  && value > 0
);

const isNativeCapabilityResponse = (value: unknown): value is PerformanceCapabilitiesInput => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as PerformanceCapabilitiesInput;
  return isPositiveSafeInteger(candidate.physicalCores)
    && isPositiveSafeInteger(candidate.logicalProcessors)
    && isPositiveSafeInteger(candidate.availableParallelism)
    && isPositiveSafeInteger(candidate.recommendedThreads)
    && typeof candidate.physicalCountReliable === "boolean";
};

const NATIVE_JOB_FEATURES = new Set<NativeSolidVoxelJobFeature>([
  "rawSnapshotUpload",
  "nativeResultHandles",
  "limitedPreview",
  "chunkBatchPull",
  "litematicWrite",
]);

const parseZeroOnlyRange = (value: unknown): NativeSolidVoxelNumericRange | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<NativeSolidVoxelNumericRange>;
  return candidate.minimum === 0 && candidate.maximum === 0
    ? Object.freeze({ minimum: 0, maximum: 0 })
    : null;
};

const parseSupportedSolidOptions = (value: unknown): NativeSupportedSolidOptions | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<NativeSupportedSolidOptions>;
  const dithering = parseZeroOnlyRange(candidate.dithering);
  const ruinDecoration = parseZeroOnlyRange(candidate.ruinDecoration);
  if (
    !Array.isArray(candidate.fillModes)
    || candidate.fillModes.length !== 1
    || candidate.fillModes[0] !== "shell"
    || !Array.isArray(candidate.faceDetails)
    || candidate.faceDetails.length !== 1
    || candidate.faceDetails[0] !== "off"
    || !dithering
    || !ruinDecoration
    || candidate.textureSampling !== true
    || candidate.skinProtection !== true
    || candidate.emissiveMapping !== true
  ) return null;
  return Object.freeze({
    fillModes: Object.freeze(["shell"]) as readonly ["shell"],
    faceDetails: Object.freeze(["off"]) as readonly ["off"],
    dithering,
    ruinDecoration,
    textureSampling: true,
    skinProtection: true,
    emissiveMapping: true,
  });
};

const parseNativeJobApi = (value: unknown): NativeSolidVoxelJobApi | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<NativeSolidVoxelJobApi>;
  if (
    candidate.version !== 1
    || candidate.rawSnapshotVersion !== 1
    || candidate.nativeResultHandles !== true
    || !Array.isArray(candidate.features)
  ) return null;
  const supportedSolidOptions = parseSupportedSolidOptions(candidate.supportedSolidOptions);
  if (!supportedSolidOptions) return null;
  const features = candidate.features;
  if (
    features.some(feature => typeof feature !== "string" || !NATIVE_JOB_FEATURES.has(
      feature as NativeSolidVoxelJobFeature,
    ))
    || new Set(features).size !== features.length
  ) return null;
  return Object.freeze({
    version: 1,
    rawSnapshotVersion: 1,
    nativeResultHandles: true,
    features: Object.freeze([...features]) as readonly NativeSolidVoxelJobFeature[],
    supportedSolidOptions,
  });
};

const hasRequiredNativeJobFeatures = (jobApi: NativeSolidVoxelJobApi | null) => (
  jobApi !== null
  && jobApi.nativeResultHandles
  && jobApi.features.includes("rawSnapshotUpload")
  && jobApi.features.includes("nativeResultHandles")
  && jobApi.features.includes("limitedPreview")
  && jobApi.features.includes("chunkBatchPull")
  && jobApi.features.includes("litematicWrite")
);

export const canRunNativeSolidOptions = (
  jobApi: NativeSolidVoxelJobApi | null | undefined,
  options: Readonly<SolidOptions>,
) => Boolean(
  jobApi
  && options.fillMode === "shell"
  && options.faceDetail === "off"
  && options.dithering >= jobApi.supportedSolidOptions.dithering.minimum
  && options.dithering <= jobApi.supportedSolidOptions.dithering.maximum
  && options.ruinDecoration >= jobApi.supportedSolidOptions.ruinDecoration.minimum
  && options.ruinDecoration <= jobApi.supportedSolidOptions.ruinDecoration.maximum
);

const readHardwareConcurrency = (): number | undefined => {
  try {
    return typeof navigator === "undefined" ? undefined : navigator.hardwareConcurrency;
  } catch {
    return undefined;
  }
};

export const isWebWorkerSolidVoxelBackendAvailable = (): boolean => {
  try {
    return typeof Worker === "function";
  } catch {
    return false;
  }
};

/**
 * CPU capability command 与原生体素任务能力彼此独立。动态加载和调用均被
 * 收敛为可判定结果，普通 Web、SSR 和受限 WebView 不会因 Tauri API 抛错。
 */
export const probeTauriSolidVoxelCpuCapabilities = async (
  loader: TauriCoreCapabilityLoader = loadTauriCore,
): Promise<TauriCpuCapabilityProbe> => {
  let core: TauriCoreCapabilityApi;
  try {
    core = await loader();
  } catch {
    return { status: "unavailable", reason: "tauri-api-unavailable" };
  }

  try {
    if (!core.isTauri()) {
      return { status: "unavailable", reason: "web-runtime" };
    }
  } catch {
    return { status: "unavailable", reason: "tauri-api-unavailable" };
  }

  let response: unknown;
  try {
    response = await core.invoke(SOLID_VOXEL_CPU_CAPABILITIES_COMMAND);
  } catch {
    return { status: "unavailable", reason: "capability-invoke-failed" };
  }
  if (!isNativeCapabilityResponse(response)) {
    return { status: "unavailable", reason: "invalid-capability-response" };
  }

  return {
    status: "available",
    capabilities: normalizePerformanceCapabilities({
      ...response,
      source: "native",
    }),
    jobApi: parseNativeJobApi((response as Record<string, unknown>).jobApi),
  };
};

/**
 * CPU 拓扑与原生任务全链就绪彼此独立。只有原始上传、结果句柄、
 * 有界预览、分批消费和 Litematic 写出均可用时，UI 才能报告 native-ready。
 */
export const probeSolidVoxelEnvironment = async (
  options: SolidVoxelBackendProbeOptions = {},
): Promise<SolidVoxelEnvironment> => {
  const nativeCapabilityProbe = await probeTauriSolidVoxelCpuCapabilities(
    options.loadTauriCore ?? loadTauriCore,
  );
  const hardwareConcurrency = options.hardwareConcurrency === undefined
    ? readHardwareConcurrency()
    : options.hardwareConcurrency;
  const capabilities = nativeCapabilityProbe.status === "available"
    ? nativeCapabilityProbe.capabilities
    : createWebPerformanceCapabilities(hardwareConcurrency);
  const webWorkerFallbackAvailable = options.webWorkerAvailable
    ?? isWebWorkerSolidVoxelBackendAvailable();
  const nativeJobApi = nativeCapabilityProbe.status === "available"
    ? nativeCapabilityProbe.jobApi
    : null;
  const nativeJobAvailable = hasRequiredNativeJobFeatures(nativeJobApi);
  const nativeBackendUnavailableReason: NativeSolidVoxelBackendUnavailableReason | null = nativeJobAvailable
    ? null
    : nativeCapabilityProbe.status === "available"
      ? "native-job-command-not-implemented"
    : nativeCapabilityProbe.reason === "web-runtime"
      ? "web-runtime"
      : "native-capability-unavailable";

  return {
    capabilities,
    nativeCapabilityProbe,
    nativeJobApi,
    nativeJobAvailable,
    nativeBackendUnavailableReason,
    usedWebCapabilityFallback: nativeCapabilityProbe.status !== "available",
    webWorkerFallbackAvailable,
  };
};

export const selectSolidVoxelBackend = (
  environment: SolidVoxelEnvironment,
): SolidVoxelBackend | null => (
  environment.nativeJobAvailable
    ? NATIVE_RAYON_SOLID_VOXEL_BACKEND
    : environment.webWorkerFallbackAvailable ? WEB_WORKER_SOLID_VOXEL_BACKEND : null
);

export const probeSolidVoxelBackend = async (
  options: SolidVoxelBackendProbeOptions = {},
): Promise<SolidVoxelBackendProbeResult> => {
  const environment = await probeSolidVoxelEnvironment(options);
  return {
    ...environment,
    backend: selectSolidVoxelBackend(environment),
  };
};
