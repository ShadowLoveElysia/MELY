import {
  Aperture,
  Box,
  Boxes,
  Camera,
  Download,
  Focus,
  Grid3X3,
  Info,
  Languages,
  ListChecks,
  Maximize2,
  Moon,
  Orbit,
  PanelLeftClose,
  PanelLeftOpen,
  Rotate3D,
  ScanFace,
  ScanLine,
  Sparkles,
  Sun,
  Trash2,
  UserRound,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { MathUtils, Vector3 } from "three";
import { IconButton } from "./components/IconButton";
import {
  MotionTrackFrameReadout,
  MotionStatusText,
  MotionTimeline,
} from "./components/MotionTimeline";
import { Sidebar, type ImportedAsset } from "./components/Sidebar";
import { SurvivalTools, type SurvivalToolsLabels } from "./components/SurvivalTools";
import { RendererViewport } from "./components/RendererViewport";
import type { RendererMaterialSelection } from "./components/rendererViewportTypes";
import { Windows } from "./components/Windows";
import { appError, errorDescriptor } from "./core/appError";
import {
  preflightProjectionExport,
  preflightProjectionHeightExport,
  type HeightAwareExportPreflightResult,
  type ExportPreflightFormat,
  type ExportPreflightReason,
  type ExportPreflightResult,
} from "./core/exportPreflight";
import {
  COMPATIBILITY_DEFAULT_DIMENSION,
  DEFAULT_TARGET_HEIGHT,
  EXPERIMENTAL_WORLD_HEIGHT,
  EXTENDED_WORLD_HEIGHT,
  clearExtremeExportConfirmation,
  confirmExtremeEnvironment,
  confirmExtremeExport,
  confirmExtremeUnlock,
  createExtremeExportFingerprint,
  createExtremeHeightConfigurationFingerprint,
  createExtremeHeightConfirmationState,
  createHeightProfileFingerprint,
  evaluateProjectionHeightRisk,
  extremeExportPhrase,
  hasExtremeEnvironmentConfirmation,
  invalidateExtremeConfirmations,
  preflightGenerationHeight,
  type ExtremeHeightConfirmationState,
  type ExtremeHeightFingerprintInput,
  type HeightDimension,
  type HeightMode,
} from "./core/heightSafety";
import {
  DEFAULT_MINECRAFT_VERSION,
  JAVA_VERSION_PROFILES,
  getJavaVersionProfile,
  requireJavaCompatibilityProfile,
} from "./core/minecraftVersions";
import type {
  MmdModelCandidate,
  MmdMotionCandidateTracks,
} from "./core/mmdAssets";
import { loadMmdModelForRenderer } from "./core/mmdRendererFactory";
import {
  computeMmdLivePhysicsDeltaSeconds,
  type LoadedMmdModel,
  type MmdPoseTransferState,
  type MmdRendererMode,
} from "./core/mmdRuntime";
import {
  areMotionTracksReadyForGeneration,
  canToggleMotionPlayback,
  formatMotionFrame,
  getAdjacentMotionFrame,
  normalizeMotionFrame,
  shouldIgnoreMotionShortcut,
} from "./core/motionUi";
import {
  createMotionPlaybackStore,
  createMotionTimeStore,
} from "./core/motionTimeStore";
import {
  createProjectionDocumentFromResult,
  deriveBedrockProjectionDocument,
} from "./core/projectionDocument";
import { createProjectionDocumentContentHash, sha256Hex } from "./core/projectionContentHash";
import {
  estimateVoxelizationResources,
  formatBinaryBytes,
  type ResourceEstimate,
} from "./core/resourceBudget";
import {
  assessGenerationResourceRisk,
  type GenerationResourceRiskAssessment,
} from "./core/generationResourceRisk";
import {
  createAutoPerformancePreferences,
  createManualPerformancePreferences,
  createWebPerformanceCapabilities,
  parsePerformancePreferences,
  PERFORMANCE_PREFERENCES_STORAGE_KEY,
  resolveNativeWorkerThreads,
  serializePerformancePreferences,
  type PerformanceCapabilities,
  type PerformancePreferencesV1,
} from "./core/performancePreferences";
import {
  assessNativeThreadRisk,
  continueSelectedNativeThreadExecution,
  useRecommendedNativeThreadExecution,
  type NativeThreadExecutionSnapshot,
  type NativeThreadRiskAssessment,
} from "./core/nativeThreadRisk";
import type { ExportBundlePhase, ExportBundleResourceEstimate } from "./core/exportBundle";
import {
  createConversionWorkerLifecycle,
  type ConversionWorkerLifecycle,
} from "./core/workerLifecycle";
import { useI18n } from "./i18n/I18nProvider";
import type { LocaleCode, TranslationKey } from "./i18n";
import {
  canRunNativeSolidOptions,
  probeSolidVoxelBackend,
  type SolidVoxelBackendProbeResult,
} from "./platform/solidVoxelBackend";
import {
  runNativeSolidVoxelJob,
  type NativeSolidVoxelCompletedOwnership,
} from "./platform/nativeSolidVoxelRunOrchestrator";
import {
  TauriSolidVoxelClientError,
} from "./platform/tauriSolidVoxelBackend";
import type {
  CameraMode,
  GenerationMode,
  HologramOptions,
  MmdMeshSnapshot,
  MmdBoneInfo,
  MmdMotionTrackInfo,
  MmdMotionTrackKind,
  MmdMotionTracks,
  MmdMotionTimes,
  MmdPoseState,
  ProjectionResult,
  PreviewMode,
  ProjectionDocument,
  SolidOptions,
  WorkerCommand,
  WorkerEvent,
  WorkerStage,
} from "./types";
import { APP_VERSION } from "./version";

type AppStageKey = Extract<TranslationKey, `app.stage.${string}`>;
type WorkerStageKey = Extract<TranslationKey, `worker.stage.${string}`>;

const languageLabelKeys = {
  "zh-CN": "language.zh-CN",
  "en-US": "language.en-US",
  "ja-JP": "language.ja-JP",
} as const satisfies Record<LocaleCode, TranslationKey>;

const workerStageKeys = {
  tracing: "worker.stage.tracing",
  sampling: "worker.stage.sampling",
  isolation: "worker.stage.isolation",
  voxelizing: "worker.stage.voxelizing",
  texturing: "worker.stage.texturing",
  filling: "worker.stage.filling",
  matching: "worker.stage.matching",
  complete: "worker.stage.complete",
} as const satisfies Record<WorkerStage, WorkerStageKey>;

const exportBundleStageKeys = {
  preparing: "app.stage.exportPreparing",
  overall: "app.stage.exportOverall",
  parts: "app.stage.exportParts",
  behaviorPack: "app.stage.exportBehaviorPack",
  metadata: "app.stage.exportMetadata",
  complete: "app.stage.exportComplete",
} as const satisfies Record<ExportBundlePhase, AppStageKey>;

const initialOptions: HologramOptions = {
  targetHeight: DEFAULT_TARGET_HEIGHT,
  sampleSpacing: 2,
  interiorDensity: 0,
  material: "mixed",
  directionMode: "vertical",
  preserveFace: true,
  glow: 72,
};

const initialSolidOptions: SolidOptions = {
  targetHeight: DEFAULT_TARGET_HEIGHT,
  alphaThreshold: 0.3,
  thicknessCompensation: 0.08,
  fillMode: "shell",
  palettePreset: "clean",
  faceDetail: "off",
  materialTheme: "original",
  dithering: 0,
  emissiveMapping: true,
  emissiveMaterialIndices: [],
  ruinDecoration: 0,
  skinProtection: true,
  skinMaterialIndices: [],
  excludeGravity: true,
  excludeRare: true,
};

const exportFormats = [
  "litematic",
  "bundle",
  "schematic",
  "mcstructure",
  "mcfunction",
] as const satisfies readonly ExportPreflightFormat[];

type ExportFormat = (typeof exportFormats)[number];

const isBedrockExportFormat = (
  format: ExportFormat,
): format is "mcstructure" | "mcfunction" =>
  format === "mcstructure" || format === "mcfunction";

const exportPreflightReasonKeys = {
  empty: "exportCenter.unavailable.empty",
  unsafeVolume: "exportCenter.unavailable.volume",
  dimensionLimit: "exportCenter.unavailable.dimension",
} as const satisfies Record<ExportPreflightReason, TranslationKey>;

interface ExportResourceRisk {
  fingerprint: string;
  reasons: Array<"denseVolume" | "workingSet" | "webRetention">;
  denseVolume: number | null;
  denseVolumeLimit: number | null;
  bundle?: ExportBundleResourceEstimate;
  estimatedWebRetentionBytes: number;
}

interface PendingExport {
  format: ExportFormat;
  document: ProjectionDocument;
  name: string;
  targetHeight: number;
  actualHeight: number;
  requiredHeight: number;
  targetDimensionHeight: number;
  configurationFingerprint?: string;
  exportFingerprint?: string;
  safety: {
    heightMode: HeightMode;
    targetHeight: number;
    placementBottomY: number;
    targetDimension?: HeightDimension;
    configurationFingerprint?: string;
    confirmations: ExtremeHeightConfirmationState;
  };
  resultId: string;
  experimental: boolean;
  resourceRisk?: ExportResourceRisk;
  resourceRiskAccepted?: boolean;
  bundleFormats?: {
    includeSchematic: boolean;
    includeMcstructure: boolean;
    includeMcfunction: boolean;
  };
}

const emptyPoseState: MmdPoseState = {
  editCount: 0,
  canUndo: false,
  canRedo: false,
};

const MOTION_TRACK_KINDS = ["dance", "expression"] as const satisfies readonly MmdMotionTrackKind[];

const emptyMotionTracks = (): MmdMotionTracks => ({
  dance: null,
  expression: null,
});

const emptyLockedMotionFrames = (): Record<MmdMotionTrackKind, number | null> => ({
  dance: null,
  expression: null,
});

const emptyMotionCandidateTracks = (): MmdMotionCandidateTracks => ({
  dance: [],
  expression: [],
});

const emptySelectedMotionPaths = (): Record<MmdMotionTrackKind, string> => ({
  dance: "",
  expression: "",
});

type ClearResourceKind = "model" | MmdMotionTrackKind;

const emptyClearResourceSelection = (): Record<ClearResourceKind, boolean> => ({
  model: false,
  dance: false,
  expression: false,
});

const SIDEBAR_WIDTH_STORAGE_KEY = "mely.sidebarWidth";
const SIDEBAR_UI_SCALE_STORAGE_KEY = "mely.sidebarUiScale";
const DEFAULT_SIDEBAR_WIDTH = 372;
const MIN_SIDEBAR_WIDTH = 300;
const MAX_SIDEBAR_WIDTH = 840;
const MIN_VIEWPORT_WIDTH = 420;
const SIDEBAR_UI_SCALES = [1, 1.1, 1.25, 1.5] as const;

const clampSidebarWidth = (width: number, viewportWidth = window.innerWidth) => {
  const viewportMaximum = viewportWidth <= 720
    ? MAX_SIDEBAR_WIDTH
    : Math.max(MIN_SIDEBAR_WIDTH, viewportWidth - MIN_VIEWPORT_WIDTH);
  return Math.round(Math.min(
    MAX_SIDEBAR_WIDTH,
    viewportMaximum,
    Math.max(MIN_SIDEBAR_WIDTH, width),
  ));
};

const initialSidebarWidth = () => {
  try {
    const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
    return clampSidebarWidth(Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_SIDEBAR_WIDTH);
  } catch {
    return clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
  }
};

interface MotionTrackRuntime {
  seconds: number;
  timeStore: ReturnType<typeof createMotionTimeStore>;
  playbackStore: ReturnType<typeof createMotionPlaybackStore>;
  pendingSeconds: number | null;
  renderedUiSeconds: number | null;
  uiPublishTimer: number | null;
  playing: boolean;
  info: MmdMotionTrackInfo | null;
  clock: {
    startedAt: number;
    startSeconds: number;
    lastUiFrame: number;
  };
}

interface GenerationResourceRiskConfiguration {
  mode: GenerationMode;
  modelId: string;
  poseRevision: number;
  partsRevision: number;
  javaVersionId: string;
  heightMode: HeightMode;
  targetDimensionMinY: number | null;
  targetDimensionHeight: number | null;
  placementBottomY: number | null;
  hologramOptions: HologramOptions;
  solidOptions: SolidOptions;
}

interface PendingGenerationResourceRisk {
  fingerprint: string;
  configuration: GenerationResourceRiskConfiguration;
  resources: ResourceEstimate;
  assessment: GenerationResourceRiskAssessment;
  nativeThreadExecutionSnapshot: NativeThreadExecutionSnapshot | null;
}

interface PendingThreadResourceRisk {
  assessment: NativeThreadRiskAssessment;
  mode: GenerationMode;
  hologramOptions: HologramOptions;
  solidOptions: SolidOptions;
  acceptedResourceRiskFingerprint?: string;
}

const nativeResultConfigurationKey = (input: {
  javaVersionId: string;
  heightMode: HeightMode;
  targetHeight: number;
  targetDimensionMinY: number | null;
  targetDimensionHeight: number | null;
  placementBottomY: number | null;
  projectionName: string;
}) => JSON.stringify(input);

const solidProjectionDocumentOptions = (input: {
  javaVersionId: string;
  heightMode: HeightMode;
  targetHeight: number;
  targetDimensionMinY: number | null;
  targetDimensionHeight: number | null;
  placementBottomY: number | null;
  projectionName: string;
}) => {
  const profile = getJavaVersionProfile(input.javaVersionId);
  const defaultDimension = profile?.defaultDimension ?? COMPATIBILITY_DEFAULT_DIMENSION;
  const placementMetadata: Record<string, string | number | boolean> = input.heightMode === "default"
    ? {
        placementBottomY: defaultDimension.minY,
        targetDimensionMinY: defaultDimension.minY,
        targetDimensionMaxY: defaultDimension.minY + defaultDimension.height - 1,
      }
    : Number.isSafeInteger(input.targetDimensionMinY)
      && Number.isSafeInteger(input.targetDimensionHeight)
      && (input.targetDimensionHeight ?? 0) > 0
      && Number.isSafeInteger(input.placementBottomY)
      ? {
          placementBottomY: input.placementBottomY!,
          targetDimensionMinY: input.targetDimensionMinY!,
          targetDimensionMaxY: input.targetDimensionMinY! + input.targetDimensionHeight! - 1,
        }
      : {};
  return {
    edition: "java" as const,
    minecraftVersion: input.javaVersionId,
    metadata: {
      name: input.projectionName,
      generator: "MELY",
      targetHeight: input.targetHeight,
      heightMode: input.heightMode,
      datapackAcknowledged: input.heightMode !== "default",
      ...placementMetadata,
      heightDisclaimer: input.heightMode === "default"
        ? ""
        : "Requires a third-party height data pack matching the exact Java version and target dimension. MELY does not provide, install, validate, or endorse it.",
      generationMode: "solid",
    },
  };
};

type ExtremeDialogStage = "unlock" | "environment" | null;
type ExtremeDialogOrigin = "initial" | "reconfirm" | null;

interface ActiveMmdSource {
  files: File[];
  modelFile: File;
  modelPath: string;
  rendererMode: MmdRendererMode;
}

interface MmdRuntimeRestoreState {
  poseTransfer: MmdPoseTransferState | null;
  hiddenMaterialIndices: readonly number[];
  selectedMaterialIndex: number | null;
  motionPaths: Record<MmdMotionTrackKind, string>;
  motionTimes: MmdMotionTimes;
  lockedFrames: Record<MmdMotionTrackKind, number | null>;
  playing: Record<MmdMotionTrackKind, boolean>;
  selectedBoneIndex: number | null;
  poseEditing: boolean;
  physicsEnabled: boolean;
}

interface ViewportBinding {
  generation: number;
  modelId: string;
}

interface ViewportLifecycleWaiter {
  generation: number;
  modelId: string;
  resolve: () => void;
  reject: (error: unknown) => void;
  timer: number;
  promise: Promise<void>;
}

const createMotionTrackRuntime = (): MotionTrackRuntime => ({
  seconds: 0,
  timeStore: createMotionTimeStore(),
  playbackStore: createMotionPlaybackStore(),
  pendingSeconds: null,
  renderedUiSeconds: null,
  uiPublishTimer: null,
  playing: false,
  info: null,
  clock: {
    startedAt: 0,
    startSeconds: 0,
    lastUiFrame: 0,
  },
});

const chooseDefaultBone = (bones: readonly MmdBoneInfo[]) => bones.find((bone) => {
  const names = `${bone.name} ${bone.englishName}`.normalize("NFKC").toLowerCase();
  return names.includes("センター") || names.includes("center");
})?.index ?? bones[0]?.index ?? null;

const classifyAsset = (file: File): ImportedAsset["type"] => {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "pmx" || extension === "pmd") return "model";
  if (extension === "vmd") return "motion";
  if (extension === "zip") return "archive";
  return "texture";
};

const downloadBinaryFile = (bytes: Uint8Array, fileName: string, type: string) => {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const downloadBinaryChunks = (chunks: readonly Uint8Array[], fileName: string, type: string) => {
  const url = URL.createObjectURL(new Blob([...chunks] as BlobPart[], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const saveBinaryFile = async (
  bytes: Uint8Array,
  fileName: string,
  type: string,
  filterName: string,
  extension: string,
): Promise<boolean> => {
  const desktop = await import("./platform/desktop");
  if (desktop.isDesktopRuntime()) {
    return desktop.saveBytesWithDesktopDialog(bytes, {
      defaultPath: fileName,
      filters: [{ name: filterName, extensions: [extension] }],
    });
  }
  downloadBinaryFile(bytes, fileName, type);
  return true;
};

const yieldToBrowser = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));

const textureByteEstimate = (model: LoadedMmdModel | null) => {
  return model?.textureByteEstimate() ?? 0;
};

const sidebarWidthMaximum = (viewportWidth = window.innerWidth) => viewportWidth <= 720
  ? MAX_SIDEBAR_WIDTH
  : Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, viewportWidth - MIN_VIEWPORT_WIDTH));

const normalizeSidebarUiScale = (scale: number) => SIDEBAR_UI_SCALES.reduce(
  (closest, candidate) => Math.abs(candidate - scale) < Math.abs(closest - scale)
    ? candidate
    : closest,
  SIDEBAR_UI_SCALES[0],
);

const initialSidebarUiScale = () => {
  try {
    return normalizeSidebarUiScale(Number(window.localStorage.getItem(SIDEBAR_UI_SCALE_STORAGE_KEY)));
  } catch {
    return SIDEBAR_UI_SCALES[0];
  }
};

const initialPerformancePreferences = (): PerformancePreferencesV1 => {
  try {
    return parsePerformancePreferences(window.localStorage.getItem(PERFORMANCE_PREFERENCES_STORAGE_KEY));
  } catch {
    return createAutoPerformancePreferences();
  }
};

const initialPerformanceCapabilities = (): PerformanceCapabilities => createWebPerformanceCapabilities(
  typeof navigator === "undefined" ? undefined : navigator.hardwareConcurrency,
);

const buildSurvivalLabels = (
  locale: LocaleCode,
  t: ReturnType<typeof useI18n>["t"],
): SurvivalToolsLabels => ({
  numberLocale: locale,
  title: t("survival.title"),
  close: t("common.close"),
  tabs: {
    materials: t("survival.tab.materials"),
    chests: t("survival.tab.chests"),
    layers: t("survival.tab.layers"),
  },
  summary: {
    blocks: t("survival.summary.blocks"),
    materials: t("survival.summary.materials"),
    largeChests: t("survival.summary.largeChests"),
    shulkerBoxes: t("survival.summary.shulkerBoxes"),
  },
  materials: {
    block: t("survival.materials.block"),
    category: t("survival.materials.category"),
    quantity: t("survival.materials.quantity"),
    transport: t("survival.materials.transport"),
    empty: t("survival.materials.empty"),
    breakdown: t("survival.materials.breakdown"),
    shulkerUnit: t("survival.materials.shulkerUnit"),
    stackUnit: t("survival.materials.stackUnit"),
    looseUnit: t("survival.materials.looseUnit"),
    includeSupport: t("survival.materials.includeSupport"),
    supportCount: t("survival.materials.supportCount"),
    supportBlock: t("survival.materials.supportBlock"),
  },
  chests: {
    empty: t("survival.chests.empty"),
    chestTitle: t("survival.chests.chestTitle"),
    usage: t("survival.chests.usage"),
    freeSlots: t("survival.chests.freeSlots"),
    slotRange: t("survival.chests.slotRange"),
    allocationItems: t("survival.chests.allocationItems"),
    slotTitle: t("survival.chests.slotTitle"),
    previousPage: t("survival.chests.previousPage"),
    nextPage: t("survival.chests.nextPage"),
    page: t("survival.chests.page"),
  },
  layers: {
    axis: t("survival.layers.axis"),
    axisX: t("survival.layers.axisX"),
    axisY: t("survival.layers.axisY"),
    axisZ: t("survival.layers.axisZ"),
    previousOccupied: t("survival.layers.previousOccupied"),
    nextOccupied: t("survival.layers.nextOccupied"),
    coordinate: t("survival.layers.coordinate"),
    coordinateRange: t("survival.layers.coordinateRange"),
    zoomOut: t("survival.layers.zoomOut"),
    zoomIn: t("survival.layers.zoomIn"),
    resetView: t("survival.layers.resetView"),
    markCompleted: t("survival.layers.markCompleted"),
    completed: t("survival.layers.completed"),
    progress: t("survival.layers.progress"),
    blocks: t("survival.layers.blocks"),
    legend: t("survival.layers.legend"),
    empty: t("survival.layers.empty"),
    canvas: t("survival.layers.canvas"),
    position: t("survival.layers.position"),
  },
  categories: {
    structure: t("survival.category.structure"),
    lighting: t("survival.category.lighting"),
    glass: t("survival.category.glass"),
    decoration: t("survival.category.decoration"),
    support: t("survival.category.support"),
  },
});

const estimateModelDimensions = (
  model: LoadedMmdModel | null,
  targetHeight: number,
): [number, number, number] => {
  if (!model) return [Math.max(1, Math.round(targetHeight * 0.45)), targetHeight, Math.max(1, Math.round(targetHeight * 0.3))];
  const bounds = model.visibleBounds();
  if (bounds.isEmpty()) return [1, Math.max(1, Math.round(targetHeight)), 1];
  const size = bounds.getSize(new Vector3());
  const scale = Math.max(1, targetHeight) / Math.max(size.y, 0.001);
  return [
    Math.max(1, Math.ceil(size.x * scale)),
    Math.max(1, Math.round(targetHeight)),
    Math.max(1, Math.ceil(size.z * scale)),
  ];
};

const estimateProjectionBlocks = (
  dimensions: readonly number[],
  mode: GenerationMode,
  hologramSpacing: number,
  fillMode: SolidOptions["fillMode"],
) => {
  const [width, height, depth] = dimensions;
  const surface = Math.max(1, Math.round(2 * (width * height + width * depth + height * depth) * 0.58));
  if (mode === "hologram") {
    return Math.max(1, Math.round(surface * 0.2 / Math.max(1, hologramSpacing) ** 2));
  }
  return fillMode === "filled"
    ? Math.max(surface, Math.round(width * height * depth * 0.42))
    : surface;
};

const safeFileStem = (value: string) => value
  .replace(/[\\/:*?"<>|]+/g, "_")
  .replace(/\s+/g, "_")
  .replace(/^_+|_+$/g, "") || "pose";

const generationResourceRiskFingerprint = (
  configuration: GenerationResourceRiskConfiguration,
) => `sha256:${sha256Hex(new TextEncoder().encode(JSON.stringify(configuration)))}`;

const estimateWebExportRetentionBytes = (
  document: ProjectionDocument,
  format: ExportFormat,
) => {
  if (format === "bundle") return document.blockCount * 64 + 96 * 1024 ** 2;
  if (format === "mcfunction") return document.blockCount * 192 + 16 * 1024 ** 2;
  return 0;
};

const exportResourceRiskFingerprint = (
  resultId: string,
  format: ExportFormat,
  bundleFormats: PendingExport["bundleFormats"],
  risk: Omit<ExportResourceRisk, "fingerprint">,
) => `sha256:${sha256Hex(new TextEncoder().encode(JSON.stringify({
  resultId,
  format,
  bundleFormats: bundleFormats ?? null,
  risk,
})))}`;

const formatRiskDuration = (
  seconds: number,
  number: (value: number) => string,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
) => {
  if (seconds < 60) {
    return t("generationResourceRisk.durationSeconds", { value: number(seconds) });
  }
  if (seconds < 3_600) {
    return t("generationResourceRisk.durationMinutes", {
      value: number(Math.ceil(seconds / 60)),
    });
  }
  return t("generationResourceRisk.durationHours", {
    value: number(Math.ceil(seconds / 3_600)),
  });
};

const yieldForModelRelease = () => new Promise<void>((resolve) => {
  window.requestAnimationFrame(() => window.setTimeout(resolve, 0));
});

const snapshotTransferables = (mesh: MmdMeshSnapshot) => {
  const transfer: Transferable[] = [
    mesh.positions.buffer,
    mesh.indices.buffer,
    mesh.triangleMaterials.buffer,
  ];
  if (mesh.uvs) transfer.push(mesh.uvs.buffer);
  mesh.textures?.forEach((texture) => transfer.push(texture.pixels.buffer));
  return transfer;
};

export default function App() {
  const { locale, locales, setLocale, t, number } = useI18n();
  const translateRef = useRef(t);
  translateRef.current = t;
  const workerLifecycleRef = useRef<ConversionWorkerLifecycle | null>(null);
  const currentJobRef = useRef<string>("");
  const nativeRunAbortControllerRef = useRef<AbortController | null>(null);
  const nativeResultOwnershipRef = useRef<NativeSolidVoxelCompletedOwnership | null>(null);
  const nativeOwnershipCleanupPromiseRef = useRef<Promise<void>>(Promise.resolve());
  const modelLoadRequestRef = useRef<string>("");
  const modelRef = useRef<LoadedMmdModel | null>(null);
  const modelReleaseRef = useRef<Promise<void>>(Promise.resolve());
  // Holds a lease for the active or in-flight renderer model. A new backend
  // cannot allocate a context until the previous lease is disposed.
  const rendererLeaseRef = useRef<Promise<void>>(Promise.resolve());
  const viewportUnmountPromiseRef = useRef<Promise<void> | null>(null);
  const viewportUnmountWaiterRef = useRef<ViewportLifecycleWaiter | null>(null);
  // React StrictMode may run an effect cleanup as a development probe. Keep a
  // binding-level request marker so only an unmount explicitly requested by a
  // renderer transaction can advance the release handshake.
  const viewportUnmountRequestRef = useRef<ViewportBinding | null>(null);
  const viewportReadyWaiterRef = useRef<ViewportLifecycleWaiter | null>(null);
  const viewportGenerationRef = useRef(0);
  const activeViewportRef = useRef<{ generation: number; modelId: string } | null>(null);
  const readyViewportRef = useRef<{ generation: number; modelId: string } | null>(null);
  const backendOperationRef = useRef<string | null>(null);
  const rendererSwitchOwnerRef = useRef<string | null>(null);
  const rendererSwitchingRef = useRef(false);
  const addAssetsRef = useRef<(files: File[]) => void | Promise<void>>(() => undefined);
  const expandedAssetsRef = useRef<File[]>([]);
  const activeMmdSourceRef = useRef<ActiveMmdSource | null>(null);
  const projectionDocumentRef = useRef<{
    result: ProjectionResult;
    document: ProjectionDocument;
    configurationKey: string;
    contentHash?: string;
  } | null>(null);
  const motionRuntimeRef = useRef<Record<MmdMotionTrackKind, MotionTrackRuntime> | null>(null);
  if (!motionRuntimeRef.current) {
    motionRuntimeRef.current = {
      dance: createMotionTrackRuntime(),
      expression: createMotionTrackRuntime(),
    };
  }
  const motionRuntime = motionRuntimeRef.current;
  const motionScrubCommitTimerRef = useRef<number | null>(null);
  const lastLivePhysicsFrameRef = useRef<number | null>(null);
  const sidebarResizeCleanupRef = useRef<(() => void) | null>(null);
  const lockedMotionFramesRef = useRef(emptyLockedMotionFrames());
  const [options, setOptions] = useState(initialOptions);
  const [solidOptions, setSolidOptions] = useState(initialSolidOptions);
  const [performancePreferences, setPerformancePreferences] = useState(initialPerformancePreferences);
  const [performanceCapabilities, setPerformanceCapabilities] = useState(initialPerformanceCapabilities);
  const [solidVoxelBackendProbe, setSolidVoxelBackendProbe] = useState<SolidVoxelBackendProbeResult | null>(null);
  const [activeWorkerThreads, setActiveWorkerThreads] = useState<number | null>(null);
  const [generationMode, setGenerationMode] = useState<GenerationMode>("hologram");
  const [result, setResult] = useState<ProjectionResult | null>(null);
  const [assets, setAssets] = useState<ImportedAsset[]>([]);
  const [modelCandidates, setModelCandidates] = useState<MmdModelCandidate[]>([]);
  const [selectedModelPath, setSelectedModelPath] = useState("");
  const [motionCandidates, setMotionCandidates] = useState<MmdMotionCandidateTracks>(emptyMotionCandidateTracks);
  const [selectedMotionPaths, setSelectedMotionPaths] = useState(emptySelectedMotionPaths);
  const [mmdModel, setMmdModel] = useState<LoadedMmdModel | null>(null);
  const [renderMode, setRenderMode] = useState<MmdRendererMode>("vanilla");
  const renderModeRef = useRef<MmdRendererMode>("vanilla");
  renderModeRef.current = renderMode;
  const [viewportMounted, setViewportMounted] = useState(false);
  const viewportMountedRef = useRef(false);
  viewportMountedRef.current = viewportMounted;
  const [viewportBinding, setViewportBinding] = useState<ViewportBinding | null>(null);
  const [viewportReadyBinding, setViewportReadyBinding] = useState<ViewportBinding | null>(null);
  const [motionTracks, setMotionTracks] = useState<MmdMotionTracks>(emptyMotionTracks);
  const [lockedMotionFrames, setLockedMotionFrames] = useState(emptyLockedMotionFrames);
  const [poseRevision, setPoseRevision] = useState(0);
  const [partsRevision, setPartsRevision] = useState(0);
  const [poseEditing, setPoseEditing] = useState(false);
  const [selectedBoneIndex, setSelectedBoneIndex] = useState<number | null>(null);
  const [poseState, setPoseState] = useState<MmdPoseState>(emptyPoseState);
  const [modelLoading, setModelLoading] = useState(false);
  // Expose the ref-backed operation mutex to viewport input handlers. Ref
  // writes alone do not trigger a render, so the mirror keeps transform
  // controls from mutating a model during an async backend operation.
  const [backendOperationBusy, setBackendOperationBusy] = useState(false);
  const [modelLoadStageKey, setModelLoadStageKey] = useState<AppStageKey>("app.stage.prepareModel");
  const [progress, setProgress] = useState(0);
  const [stageKey, setStageKey] = useState<AppStageKey | WorkerStageKey>("app.stage.prepareGeneration");
  const [exportCurrentFile, setExportCurrentFile] = useState("");
  const [processing, setProcessing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const [sidebarUiScale, setSidebarUiScale] = useState(initialSidebarUiScale);
  const [physicsEnabled, setPhysicsEnabled] = useState(false);
  const [physicsLoading, setPhysicsLoading] = useState(false);
  const hiddenMaterialIndicesRef = useRef<number[]>([]);
  const [hiddenMaterialIndices, setHiddenMaterialIndices] = useState<number[]>([]);
  const [selectedMaterialIndex, setSelectedMaterialIndex] = useState<number | null>(null);
  const [materialSelectionRequestId, setMaterialSelectionRequestId] = useState(0);
  const lastPickedMaterialIndexRef = useRef<number | null>(null);
  const materialSelectionProbeRevisionRef = useRef(0);
  const [materialSelectionProbeRevision, setMaterialSelectionProbeRevision] = useState(0);
  const [cameraMode, setCameraMode] = useState<CameraMode>("perspective");
  const [previewMode, setPreviewMode] = useState<PreviewMode>("source");
  const [showGrid, setShowGrid] = useState(true);
  const [showBounds, setShowBounds] = useState(true);
  const [nightMode, setNightMode] = useState(false);
  const [heightMode, setHeightMode] = useState<HeightMode>("default");
  const [javaVersionId, setJavaVersionId] = useState(DEFAULT_MINECRAFT_VERSION.id);
  const [targetDimensionMinY, setTargetDimensionMinY] = useState<number | null>(null);
  const [targetDimensionHeight, setTargetDimensionHeight] = useState<number | null>(null);
  const [placementBottomY, setPlacementBottomY] = useState<number | null>(null);
  const [heightUnlockOpen, setHeightUnlockOpen] = useState(false);
  const [extremeDialogStage, setExtremeDialogStage] = useState<ExtremeDialogStage>(null);
  const [extremeDialogOrigin, setExtremeDialogOrigin] = useState<ExtremeDialogOrigin>(null);
  const [extremeEnvironmentChecks, setExtremeEnvironmentChecks] = useState({
    datapack: false,
    backup: false,
    toolchain: false,
  });
  const [extremeConfirmations, setExtremeConfirmations] = useState<ExtremeHeightConfirmationState>(
    createExtremeHeightConfirmationState,
  );
  const extremeConfirmationsRef = useRef(extremeConfirmations);
  extremeConfirmationsRef.current = extremeConfirmations;
  const [extremeExportPhraseInput, setExtremeExportPhraseInput] = useState("");
  const [clearResourcesOpen, setClearResourcesOpen] = useState(false);
  const [clearResourceSelection, setClearResourceSelection] = useState(emptyClearResourceSelection);
  const [exportCenterOpen, setExportCenterOpen] = useState(false);
  const [exportPreflights, setExportPreflights] = useState<Partial<Record<ExportFormat, HeightAwareExportPreflightResult | ExportPreflightResult>>>({});
  const [bundleFormats, setBundleFormats] = useState({
    includeSchematic: false,
    includeMcstructure: false,
    includeMcfunction: false,
  });
  const [pendingExport, setPendingExport] = useState<PendingExport | null>(null);
  const [extendedExportAcknowledged, setExtendedExportAcknowledged] = useState(false);
  const [pendingGenerationResourceRisk, setPendingGenerationResourceRisk] = useState<PendingGenerationResourceRisk | null>(null);
  const [generationResourceRiskAcknowledged, setGenerationResourceRiskAcknowledged] = useState(false);
  const [pendingThreadResourceRisk, setPendingThreadResourceRisk] = useState<PendingThreadResourceRisk | null>(null);
  const [survivalToolsOpen, setSurvivalToolsOpen] = useState(false);
  const [survivalDocument, setSurvivalDocument] = useState<ProjectionDocument | null>(null);
  const survivalToolsTriggerRef = useRef<HTMLButtonElement>(null);
  const clearResourcesTriggerRef = useRef<HTMLButtonElement>(null);
  const generateTriggerRef = useRef<HTMLButtonElement>(null);
  const [resetToken, setResetToken] = useState(0);
  const [focusFaceToken, setFocusFaceToken] = useState(0);
  const [toast, setToast] = useState<string | null>(null);

  const replaceExtremeConfirmations = useCallback((
    next: ExtremeHeightConfirmationState | (
      (current: ExtremeHeightConfirmationState) => ExtremeHeightConfirmationState
    ),
  ) => {
    const resolved = typeof next === "function" ? next(extremeConfirmationsRef.current) : next;
    extremeConfirmationsRef.current = resolved;
    setExtremeConfirmations(resolved);
  }, []);

  const invalidateExtremeAuthorization = useCallback(() => {
    replaceExtremeConfirmations(createExtremeHeightConfirmationState());
    setExtremeEnvironmentChecks({ datapack: false, backup: false, toolchain: false });
    setExtremeDialogStage(null);
    setExtremeDialogOrigin(null);
  }, [replaceExtremeConfirmations]);

  const acquireBackendOperation = useCallback(() => {
    if (backendOperationRef.current) return null;
    const operationId = crypto.randomUUID();
    backendOperationRef.current = operationId;
    setBackendOperationBusy(true);
    return operationId;
  }, []);

  const releaseBackendOperation = useCallback((operationId: string) => {
    if (backendOperationRef.current !== operationId) return;
    backendOperationRef.current = null;
    setBackendOperationBusy(false);
  }, []);

  const ownsBackendOperation = useCallback((operationId: string) => (
    backendOperationRef.current === operationId
  ), []);

  MOTION_TRACK_KINDS.forEach((kind) => {
    motionRuntime[kind].info = motionTracks[kind];
  });
  lockedMotionFramesRef.current = lockedMotionFrames;

  const resolvedWorkerThreads = useMemo(
    () => resolveNativeWorkerThreads(performancePreferences, performanceCapabilities),
    [performanceCapabilities, performancePreferences],
  );
  const nativeSolidVoxelJobAvailable = Boolean(solidVoxelBackendProbe?.nativeJobAvailable);

  const releaseNativeSolidVoxelOwnership = useCallback(async () => {
    nativeRunAbortControllerRef.current?.abort();
    nativeRunAbortControllerRef.current = null;
    const previousCleanup = nativeOwnershipCleanupPromiseRef.current.catch(() => undefined);
    const cleanup = (async () => {
      await previousCleanup;
      const resultOwnership = nativeResultOwnershipRef.current;
      if (!resultOwnership) return;
      while (!await resultOwnership.resultStore.release()) {
        await yieldToBrowser();
      }
      if (nativeResultOwnershipRef.current === resultOwnership) {
        nativeResultOwnershipRef.current = null;
      }
    })();
    nativeOwnershipCleanupPromiseRef.current = cleanup;
    await cleanup;
  }, []);

  const cancelNativeSolidVoxelExecution = useCallback(async () => {
    nativeRunAbortControllerRef.current?.abort();
    nativeRunAbortControllerRef.current = null;
    const previousCleanup = nativeOwnershipCleanupPromiseRef.current.catch(() => undefined);
    const cleanup = (async () => {
      await previousCleanup;
      const resultOwnership = nativeResultOwnershipRef.current;
      if (!resultOwnership) return;
      let fullyReleased = await resultOwnership.resultStore.cancel();
      while (!fullyReleased) {
        await yieldToBrowser();
        fullyReleased = await resultOwnership.resultStore.release();
      }
      if (nativeResultOwnershipRef.current === resultOwnership) {
        nativeResultOwnershipRef.current = null;
      }
    })();
    nativeOwnershipCleanupPromiseRef.current = cleanup;
    await cleanup;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void probeSolidVoxelBackend().then((probe) => {
      if (cancelled) return;
      setSolidVoxelBackendProbe(probe);
      setPerformanceCapabilities(probe.capabilities);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        PERFORMANCE_PREFERENCES_STORAGE_KEY,
        serializePerformancePreferences(performancePreferences),
      );
    } catch {
      // 性能偏好持久化失败不应阻止生成或影响投影内容。
    }
  }, [performancePreferences]);

  const publishMotionSeconds = useCallback((kind: MmdMotionTrackKind, seconds: number) => {
    const runtime = motionRuntime[kind];
    if (motionScrubCommitTimerRef.current !== null) {
      window.clearTimeout(motionScrubCommitTimerRef.current);
      motionScrubCommitTimerRef.current = null;
    }
    if (runtime.uiPublishTimer !== null) {
      window.clearTimeout(runtime.uiPublishTimer);
      runtime.uiPublishTimer = null;
    }
    runtime.pendingSeconds = null;
    runtime.renderedUiSeconds = null;
    runtime.seconds = seconds;
    runtime.timeStore.set(seconds);
  }, [motionRuntime]);

  const clearProjectionArtifacts = useCallback(() => {
    void releaseNativeSolidVoxelOwnership().catch(() => undefined);
    setResult(null);
    projectionDocumentRef.current = null;
    setSurvivalDocument(null);
    setSurvivalToolsOpen(false);
    setExportCenterOpen(false);
    setExportPreflights({});
    setPendingExport(null);
    setExtendedExportAcknowledged(false);
    setExtremeExportPhraseInput("");
    replaceExtremeConfirmations((current) => clearExtremeExportConfirmation(current));
  }, [releaseNativeSolidVoxelOwnership, replaceExtremeConfirmations]);

  useEffect(() => {
    const lifecycle = createConversionWorkerLifecycle({
      createWorker: () => new Worker(
        new URL("./workers/conversion.worker.ts", import.meta.url),
        { type: "module" },
      ),
      onEvent: (event: WorkerEvent) => {
        if (event.jobId !== currentJobRef.current) return;
        if (event.type === "PROGRESS") {
          setProgress(event.progress);
          setStageKey(workerStageKeys[event.stage]);
        } else if (event.type === "RESULT") {
          currentJobRef.current = "";
          workerLifecycleRef.current?.cancel();
          projectionDocumentRef.current = null;
          setSurvivalDocument(null);
          setResult(event.result);
          setProcessing(false);
          setActiveWorkerThreads(null);
          setProgress(1);
          setStageKey("worker.stage.complete");
          setPoseEditing(false);
          setPreviewMode("hologram");
        } else if (event.type === "ERROR") {
          currentJobRef.current = "";
          workerLifecycleRef.current?.cancel();
          setProcessing(false);
          setActiveWorkerThreads(null);
          setProgress(0);
          setStageKey("app.stage.prepareGeneration");
          setPreviewMode("source");
          setToast(translateRef.current(event.code, event.params));
        }
      },
    });
    workerLifecycleRef.current = lifecycle;

    return () => {
      currentJobRef.current = "";
      setActiveWorkerThreads(null);
      lifecycle.dispose();
      if (workerLifecycleRef.current === lifecycle) workerLifecycleRef.current = null;
    };
  }, []);

  const localizeError = useCallback((error: unknown) => {
    if (error instanceof TauriSolidVoxelClientError) {
      if (error.kind === "runtime-unavailable") return t("error.native.unavailable");
      if (error.kind === "transport") return t("error.native.transport");
      if (error.kind === "protocol") return t("error.native.protocol");
      const category = error.nativeError?.category ?? "internal";
      return t(`error.native.${category}` as TranslationKey);
    }
    const descriptor = errorDescriptor(error);
    return t(descriptor.code, descriptor.params);
  }, [t]);

  useEffect(() => () => {
    void cancelNativeSolidVoxelExecution().catch(() => undefined);
    modelLoadRequestRef.current = "";
    expandedAssetsRef.current = [];
    if (motionScrubCommitTimerRef.current !== null) {
      window.clearTimeout(motionScrubCommitTimerRef.current);
    }
    MOTION_TRACK_KINDS.forEach((kind) => {
      const timer = motionRuntime[kind].uiPublishTimer;
      if (timer !== null) window.clearTimeout(timer);
    });
    const model = modelRef.current;
    modelRef.current = null;
    if (model) {
      modelReleaseRef.current = Promise.resolve(model.dispose()).catch(() => undefined);
    }
  }, [cancelNativeSolidVoxelExecution, motionRuntime]);

  const invalidateProjection = useCallback((reason = "settings") => {
    currentJobRef.current = `${reason}:${crypto.randomUUID()}`;
    workerLifecycleRef.current?.cancel();
    void cancelNativeSolidVoxelExecution().catch(() => undefined);
    setProcessing(false);
    setActiveWorkerThreads(null);
    clearProjectionArtifacts();
    setPreviewMode("source");
  }, [cancelNativeSolidVoxelExecution, clearProjectionArtifacts]);

  const invalidatePoseProjection = useCallback(() => {
    invalidateProjection("pose");
  }, [invalidateProjection]);

  const commitMotionScrub = useCallback(() => {
    motionScrubCommitTimerRef.current = null;
    const model = modelRef.current;
    if (!backendOperationRef.current && model?.physicsEnabled()) {
      model.updatePose({
        dance: motionRuntime.dance.seconds,
        expression: motionRuntime.expression.seconds,
      });
      lastLivePhysicsFrameRef.current = null;
    }
    invalidatePoseProjection();
    setPoseRevision((value) => value + 1);
  }, [invalidatePoseProjection, motionRuntime]);

  const scheduleMotionScrubCommit = useCallback(() => {
    if (motionScrubCommitTimerRef.current !== null) {
      window.clearTimeout(motionScrubCommitTimerRef.current);
    }
    motionScrubCommitTimerRef.current = window.setTimeout(commitMotionScrub, 120);
  }, [commitMotionScrub]);

  const currentMotionTimes = useCallback((): MmdMotionTimes => ({
    dance: motionRuntime.dance.seconds,
    expression: motionRuntime.expression.seconds,
  }), [motionRuntime]);

  const stopAllMotionPlayback = useCallback(() => {
    lastLivePhysicsFrameRef.current = null;
    MOTION_TRACK_KINDS.forEach((kind) => {
      const runtime = motionRuntime[kind];
      runtime.playing = false;
      runtime.pendingSeconds = null;
      runtime.playbackStore.set(false);
      runtime.timeStore.set(runtime.seconds);
    });
  }, [motionRuntime]);

  const resetMotionTracks = useCallback(() => {
    stopAllMotionPlayback();
    MOTION_TRACK_KINDS.forEach((kind) => {
      motionRuntime[kind].info = null;
      publishMotionSeconds(kind, 0);
    });
    setMotionTracks(emptyMotionTracks());
    setLockedMotionFrames(emptyLockedMotionFrames());
    setSelectedMotionPaths(emptySelectedMotionPaths());
  }, [motionRuntime, publishMotionSeconds, stopAllMotionPlayback]);

  const resetMotionTrack = useCallback((kind: MmdMotionTrackKind) => {
    const runtime = motionRuntime[kind];
    runtime.info = null;
    runtime.playing = false;
    runtime.playbackStore.set(false);
    publishMotionSeconds(kind, 0);
    setMotionTracks((current) => ({ ...current, [kind]: null }));
    setLockedMotionFrames((current) => ({ ...current, [kind]: null }));
    setSelectedMotionPaths((current) => ({ ...current, [kind]: "" }));
  }, [motionRuntime, publishMotionSeconds]);

  const installMotionTrack = useCallback((
    kind: MmdMotionTrackKind,
    info: MmdMotionTrackInfo,
    path: string,
  ) => {
    const runtime = motionRuntime[kind];
    runtime.info = info;
    runtime.playing = false;
    runtime.playbackStore.set(false);
    publishMotionSeconds(kind, 0);
    setMotionTracks((current) => ({ ...current, [kind]: info }));
    setLockedMotionFrames((current) => ({ ...current, [kind]: null }));
    setSelectedMotionPaths((current) => ({ ...current, [kind]: path }));
  }, [motionRuntime, publishMotionSeconds]);

  const advanceMotionPreview = useCallback((now: number) => {
    // Snapshotting, physics toggles and renderer transitions may yield while
    // retaining the active model. Do not let the shared RAF mutate that model
    // until the owning backend operation has released its lease.
    if (backendOperationRef.current) {
      // Keep active playback clocks frozen while the backend is reserved. The
      // next frame after release therefore resumes from the same timeline
      // position instead of jumping by the operation duration.
      MOTION_TRACK_KINDS.forEach((kind) => {
        const runtime = motionRuntime[kind];
        if (!runtime.playing) return;
        runtime.clock.startSeconds = runtime.seconds;
        runtime.clock.startedAt = now;
      });
      lastLivePhysicsFrameRef.current = now;
      return null;
    }
    const model = modelRef.current;
    if (!model || !MOTION_TRACK_KINDS.some((kind) => motionRuntime[kind].info)) return null;

    let evaluated = false;
    let livePlaybackEvaluated = false;
    MOTION_TRACK_KINDS.forEach((kind) => {
      const runtime = motionRuntime[kind];
      const motion = runtime.info;
      if (!motion) return;
      if (runtime.pendingSeconds !== null) {
        runtime.seconds = runtime.pendingSeconds;
        runtime.pendingSeconds = null;
        runtime.renderedUiSeconds = runtime.seconds;
        evaluated = true;
        return;
      }
      if (!runtime.playing || motion.durationSeconds <= 0) return;
      runtime.seconds = (
        runtime.clock.startSeconds + Math.max(0, now - runtime.clock.startedAt) / 1000
      ) % motion.durationSeconds;
      livePlaybackEvaluated = true;
      const displayedFrame = Math.round(runtime.seconds * motion.frameRate);
      if (displayedFrame !== runtime.clock.lastUiFrame) {
        runtime.clock.lastUiFrame = displayedFrame;
        runtime.renderedUiSeconds = runtime.seconds;
      }
      evaluated = true;
    });
    if (!evaluated) return null;
    const times = currentMotionTimes();
    // Keep the active renderer's physics solver in the live playback path.
    // `updatePreviewPose` intentionally skips physics in all three backends;
    // using it while physics is enabled would make clothing/body collisions
    // disappear during playback and only reappear after a scrub or snapshot.
    if (model.physicsEnabled() && livePlaybackEvaluated) {
      const deltaSeconds = computeMmdLivePhysicsDeltaSeconds(
        now,
        lastLivePhysicsFrameRef.current,
      );
      lastLivePhysicsFrameRef.current = now;
      model.updateLivePose(times, deltaSeconds);
    } else {
      lastLivePhysicsFrameRef.current = null;
      model.updatePreviewPose(times);
    }
    return times;
  }, [currentMotionTimes, motionRuntime]);

  const publishRenderedMotionPreview = useCallback((
    renderedAt: number,
    evaluatedMotionTimes: MmdMotionTimes | null,
    gpuSynchronized: boolean,
  ) => {
    if (evaluatedMotionTimes !== null && (window as Window & {
      __MELY_E2E_GPU_PROBE__?: boolean;
    }).__MELY_E2E_GPU_PROBE__) {
      window.dispatchEvent(new CustomEvent("mely:vmd-frame-rendered", {
        detail: {
          times: evaluatedMotionTimes,
          frames: {
            dance: evaluatedMotionTimes.dance * (motionRuntime.dance.info?.frameRate ?? 30),
            expression: evaluatedMotionTimes.expression * (motionRuntime.expression.info?.frameRate ?? 30),
          },
          renderedAt,
          gpuSynchronized,
        },
      }));
    }
    MOTION_TRACK_KINDS.forEach((kind) => {
      const runtime = motionRuntime[kind];
      if (runtime.renderedUiSeconds === null || runtime.uiPublishTimer !== null) return;
      runtime.uiPublishTimer = window.setTimeout(() => {
        runtime.uiPublishTimer = null;
        const seconds = runtime.renderedUiSeconds;
        runtime.renderedUiSeconds = null;
        if (seconds !== null) runtime.timeStore.set(seconds);
      }, 0);
    });
  }, [motionRuntime]);

  const targetHeight = options.targetHeight;
  const selectedProfile = getJavaVersionProfile(javaVersionId);
  const selectedDefaultDimension = selectedProfile?.defaultDimension ?? COMPATIBILITY_DEFAULT_DIMENSION;
  const selectedDefaultHeight = selectedDefaultDimension.height;
  const heightRisk = useMemo(
    () => evaluateProjectionHeightRisk(targetHeight, result?.bounds, selectedDefaultHeight),
    [result?.bounds, selectedDefaultHeight, targetHeight],
  );
  const extendedHeightActive = heightRisk.requiresExportConfirmation;
  const estimatedDimensions = useMemo(
    () => estimateModelDimensions(mmdModel, targetHeight),
    [mmdModel, partsRevision, targetHeight],
  );
  const estimatedBlockCount = useMemo(() => result?.stats.blockCount ?? (mmdModel
    ? estimateProjectionBlocks(
        estimatedDimensions,
        generationMode,
        options.sampleSpacing,
        solidOptions.fillMode,
      )
    : null), [estimatedDimensions, generationMode, mmdModel, options.sampleSpacing, result, solidOptions.fillMode]);
  const resourceEstimate = useMemo(() => !mmdModel || estimatedBlockCount === null
    ? null
    : estimateVoxelizationResources({
        targetHeight,
        width: estimatedDimensions[0],
        depth: estimatedDimensions[2],
        triangleCount: mmdModel.visibleTriangleCount(),
        textureBytes: generationMode === "solid" ? textureByteEstimate(mmdModel) : 0,
        fillMode: generationMode === "solid" ? solidOptions.fillMode : "shell",
        estimatedBlocks: estimatedBlockCount,
        ...(generationMode === "hologram" ? { interiorDensity: options.interiorDensity ?? 0 } : {}),
      }), [estimatedBlockCount, estimatedDimensions, generationMode, mmdModel, options.interiorDensity, solidOptions.fillMode, targetHeight]);
  const declaredTargetDimension = useMemo<HeightDimension | undefined>(() => (
    Number.isSafeInteger(targetDimensionMinY)
    && Number.isSafeInteger(targetDimensionHeight)
    && (targetDimensionHeight ?? 0) > 0
      ? { minY: targetDimensionMinY!, height: targetDimensionHeight! }
      : undefined
  ), [targetDimensionHeight, targetDimensionMinY]);
  const placementForHeightPreflight = heightMode === "default"
    ? selectedDefaultDimension.minY
    : placementBottomY ?? Number.NaN;
  const extremeFingerprintBase = useMemo<ExtremeHeightFingerprintInput | null>(() => {
    if (
      !selectedProfile
      || (heightMode !== "experimental_4064" && extremeDialogStage === null)
      || !declaredTargetDimension
    ) return null;
    return {
      projectId: selectedModelPath || mmdModel?.stats.name || "unsaved-project",
      resultId: null,
      generationMode,
      generationParameters: generationMode === "solid"
        ? { ...solidOptions }
        : { ...options },
      versionId: javaVersionId,
      profileFingerprint: createHeightProfileFingerprint(selectedProfile),
      targetHeight,
      // 解锁与环境关仅绑定生成配置；实际结果在第三关 export fingerprint 中加入。
      actualHeight: targetHeight,
      bounds: null,
      targetDimension: { id: "user-declared", ...declaredTargetDimension },
      placementBottomY: placementBottomY ?? Number.NaN,
      edition: "java",
      exportFormat: "pending",
      resourceEstimate: resourceEstimate
        ? {
            estimatedBytes: resourceEstimate.estimatedBytes,
            estimatedBlocks: resourceEstimate.estimatedBlocks,
            estimatedCandidates: resourceEstimate.estimatedCandidates,
          }
        : {},
    };
  }, [declaredTargetDimension, extremeDialogStage, generationMode, heightMode, javaVersionId,
    mmdModel?.stats.name, options, placementBottomY, resourceEstimate, selectedModelPath,
    selectedProfile, solidOptions, targetHeight]);
  const computedExtremeConfigurationFingerprint = useMemo(() => extremeFingerprintBase
    ? createExtremeHeightConfigurationFingerprint(extremeFingerprintBase)
    : null, [extremeFingerprintBase]);
  const extremeConfigurationFingerprint = computedExtremeConfigurationFingerprint;
  const extremeEnvironmentConfirmed = heightMode === "experimental_4064"
    && hasExtremeEnvironmentConfirmation(
      extremeConfirmations,
      extremeConfigurationFingerprint,
    );

  useEffect(() => {
    if (heightMode !== "experimental_4064") return;
    if (extremeDialogStage !== null) return;
    if (!extremeConfigurationFingerprint) {
      replaceExtremeConfirmations(createExtremeHeightConfirmationState());
      return;
    }
    replaceExtremeConfirmations((current) => invalidateExtremeConfirmations(
      current,
      extremeConfigurationFingerprint,
    ));
  }, [extremeConfigurationFingerprint, extremeDialogStage, heightMode]);

  useEffect(() => {
    if (heightMode !== "experimental_4064") return;
    invalidateExtremeAuthorization();
    // 模型、姿态或材质变化只使确认失效，不能改写用户选择的极限高度。
  }, [invalidateExtremeAuthorization, partsRevision, poseRevision, selectedModelPath]);
  const survivalLabels = useMemo(
    () => buildSurvivalLabels(locale, t),
    [locale, t],
  );

  const generate = useCallback(async (
    mode: GenerationMode,
    nextHologramOptions: HologramOptions,
    nextSolidOptions: SolidOptions,
    acceptedResourceRiskFingerprint?: string,
    acceptedNativeThreadExecution?: NativeThreadExecutionSnapshot | null,
  ) => {
    if (backendOperationRef.current) return;
    const versionProfile = getJavaVersionProfile(javaVersionId);
    if (!versionProfile) {
      setToast(t("toast.heightPreflightRejected", { reason: "JAVA_VERSION_PROFILE_UNKNOWN" }));
      return;
    }
    const generationHeight = preflightGenerationHeight({
      versionId: javaVersionId,
      heightMode,
      targetHeight: mode === "solid" ? nextSolidOptions.targetHeight : nextHologramOptions.targetHeight,
      datapackAcknowledged: heightMode !== "default",
      targetDimension: heightMode === "default"
        ? versionProfile.defaultDimension ?? COMPATIBILITY_DEFAULT_DIMENSION
        : declaredTargetDimension,
      confirmations: extremeConfirmationsRef.current,
      configurationFingerprint: extremeConfigurationFingerprint,
    });
    if (!generationHeight.allowed) {
      if (
        generationHeight.errorCode === "HEIGHT_EXTREME_CONFIRMATION_REQUIRED"
        && heightMode === "experimental_4064"
      ) {
        setExtremeDialogStage("unlock");
        setExtremeDialogOrigin("reconfirm");
        setExtremeEnvironmentChecks({ datapack: false, backup: false, toolchain: false });
        return;
      }
      setToast(t("toast.heightPreflightRejected", { reason: generationHeight.errorCode ?? "unknown" }));
      return;
    }
    const model = modelRef.current;
    const workerLifecycle = workerLifecycleRef.current;
    if (!workerLifecycle || !model) {
      setToast(t("toast.modelRequired"));
      return;
    }
    const nativeThreadRisk = assessNativeThreadRisk({
      resolvedThreads: resolvedWorkerThreads,
      capabilities: performanceCapabilities,
      nativeJobAvailable: nativeSolidVoxelJobAvailable
        && mode === "solid"
        && canRunNativeSolidOptions(solidVoxelBackendProbe?.nativeJobApi, nextSolidOptions),
    });
    let nativeThreadExecutionSnapshot = acceptedNativeThreadExecution
      ?? nativeThreadRisk.executionSnapshot;
    if (
      acceptedNativeThreadExecution
      && (
        !nativeSolidVoxelJobAvailable
        || mode !== "solid"
        || !canRunNativeSolidOptions(solidVoxelBackendProbe?.nativeJobApi, nextSolidOptions)
      )
    ) {
      setPendingThreadResourceRisk(null);
      setToast(t("threadResourceRisk.stale"));
      return;
    }
    if (
      nativeThreadRisk.needsConfirmation
      && acceptedNativeThreadExecution === undefined
    ) {
      generateTriggerRef.current = document.activeElement instanceof HTMLButtonElement
        ? document.activeElement
        : null;
      setPendingThreadResourceRisk({
        assessment: nativeThreadRisk,
        mode,
        hologramOptions: { ...nextHologramOptions },
        solidOptions: { ...nextSolidOptions },
        acceptedResourceRiskFingerprint,
      });
      return;
    }
    if (
      !nativeSolidVoxelJobAvailable
      || mode !== "solid"
      || !canRunNativeSolidOptions(solidVoxelBackendProbe?.nativeJobApi, nextSolidOptions)
    ) nativeThreadExecutionSnapshot = null;
    const targetHeight = mode === "solid" ? nextSolidOptions.targetHeight : nextHologramOptions.targetHeight;
    const dimensions = estimateModelDimensions(model, targetHeight);
    const estimatedBlocks = estimateProjectionBlocks(
      dimensions,
      mode,
      nextHologramOptions.sampleSpacing,
      nextSolidOptions.fillMode,
    );
    const resources = estimateVoxelizationResources({
      targetHeight,
      width: dimensions[0],
      depth: dimensions[2],
      triangleCount: model.visibleTriangleCount(),
      textureBytes: mode === "solid" ? textureByteEstimate(model) : 0,
      fillMode: mode === "solid" ? nextSolidOptions.fillMode : "shell",
      estimatedBlocks,
      ...(mode === "hologram" ? { interiorDensity: nextHologramOptions.interiorDensity ?? 0 } : {}),
    });
    const resourceRisk = assessGenerationResourceRisk({
      mode,
      targetHeight,
      triangleCount: model.visibleTriangleCount(),
      estimate: resources,
    });
    const resourceRiskConfiguration: GenerationResourceRiskConfiguration = {
      mode,
      modelId: model.id,
      poseRevision,
      partsRevision,
      javaVersionId,
      heightMode,
      targetDimensionMinY,
      targetDimensionHeight,
      placementBottomY,
      hologramOptions: { ...nextHologramOptions },
      solidOptions: { ...nextSolidOptions },
    };
    const resourceRiskFingerprint = generationResourceRiskFingerprint(resourceRiskConfiguration);
    if (
      resourceRisk.requiresConfirmation
      && acceptedResourceRiskFingerprint !== resourceRiskFingerprint
    ) {
      setPendingGenerationResourceRisk({
        fingerprint: resourceRiskFingerprint,
        configuration: resourceRiskConfiguration,
        resources,
        assessment: resourceRisk,
        nativeThreadExecutionSnapshot,
      });
      setGenerationResourceRiskAcknowledged(false);
      return;
    }
    setPendingGenerationResourceRisk(null);
    setGenerationResourceRiskAcknowledged(false);
    const requestedFrameSuffix = MOTION_TRACK_KINDS
      .flatMap((kind) => {
        const motion = motionTracks[kind];
        if (!motion) return [];
        const frame = lockedMotionFramesRef.current[kind]
          ?? motionRuntime[kind].seconds * motion.frameRate;
        return [`_${kind === "dance" ? "D" : "E"}${formatMotionFrame(frame)}`];
      })
      .join("");
    const requestedSourceName = mmdModel?.stats.name
      || assets.find((asset) => asset.type === "model")?.name.replace(/\.[^.]+$/, "")
      || "ELY_Hologram";
    const requestedProjectionName = `MELY_${safeFileStem(requestedSourceName)}${requestedFrameSuffix}${
      poseState.editCount ? "_POSE" : ""
    }_${mode === "solid" ? "SOLID" : "HOLOGRAM"}`;
    // Generation reads and mutates the active renderer while capturing the
    // snapshot. Keep the same backend lease used by model/renderer changes so
    // a programmatic switch cannot dispose the model between those steps.
    const operationId = acquireBackendOperation();
    if (!operationId) return;
    const jobId = crypto.randomUUID();
    let useWebWorker = nativeThreadExecutionSnapshot === null;
    let snapshotTransferredToWorker = false;
    let nativeRunSignal: AbortSignal | null = null;

    try {
      currentJobRef.current = jobId;
      await releaseNativeSolidVoxelOwnership();
      if (currentJobRef.current !== jobId || modelRef.current !== model) return;
      clearProjectionArtifacts();
      if (useWebWorker) workerLifecycle.start(jobId);
      setPreviewMode("source");
      setProcessing(true);
      setActiveWorkerThreads(nativeThreadExecutionSnapshot?.workerThreads ?? null);
      setExportCurrentFile("");
      setProgress(0.04);
      setStageKey("app.stage.createJob");
      setStageKey("app.stage.capturePose");
      if (modelRef.current !== model) {
        if (useWebWorker) workerLifecycle.cancel();
        setProcessing(false);
        setActiveWorkerThreads(null);
        return;
      }
      if (model.physicsEnabled()) model.updatePose(currentMotionTimes());
      const includeTextures = mode === "solid";
      const { releaseMmdMeshSnapshot } = await import("./core/mmdSnapshot");
      const snapshot = await model.createSnapshot({
        includeTextures,
        isCancelled: () => currentJobRef.current !== jobId || modelRef.current !== model,
        onProgress: (value) => {
          if (currentJobRef.current !== jobId || modelRef.current !== model) return;
          setProgress(0.04 + value * 0.12);
        },
      });
      try {
        if (currentJobRef.current !== jobId || modelRef.current !== model) return;
        if (!useWebWorker && nativeThreadExecutionSnapshot) {
          setStageKey("worker.stage.voxelizing");
          const configuration = {
            javaVersionId,
            heightMode,
            targetHeight: nextSolidOptions.targetHeight,
            targetDimensionMinY,
            targetDimensionHeight,
            placementBottomY,
            projectionName: requestedProjectionName,
          };
          const abortController = new AbortController();
          nativeRunSignal = abortController.signal;
          nativeRunAbortControllerRef.current = abortController;
          let nativeRun;
          try {
            nativeRun = await runNativeSolidVoxelJob({
              execution: nativeThreadExecutionSnapshot,
              options: nextSolidOptions,
              snapshot,
              signal: abortController.signal,
              isCurrent: () => (
                currentJobRef.current === jobId
                && modelRef.current === model
                && nativeRunAbortControllerRef.current === abortController
              ),
              onSnapshotUploaded: () => releaseMmdMeshSnapshot(snapshot),
              onProgress: (fraction) => {
                if (fraction >= 1) setStageKey("app.stage.prepareGeneration");
                setProgress(0.16 + fraction * 0.72);
              },
              onMaterializationProgress: (pulledChunkCount, totalChunkCount) => {
                if (totalChunkCount <= 0) return;
                setProgress(0.88 + Math.min(1, pulledChunkCount / totalChunkCount) * 0.1);
              },
              materialization: {
                document: solidProjectionDocumentOptions(configuration),
              },
            });
          } finally {
            if (nativeRunAbortControllerRef.current === abortController) {
              nativeRunAbortControllerRef.current = null;
            }
          }
          if (nativeRun.kind === "fallback-allowed") {
            useWebWorker = true;
            setActiveWorkerThreads(null);
            workerLifecycle.start(jobId);
          } else {
            const { ownership } = nativeRun;
            const { materialized } = ownership;
            nativeResultOwnershipRef.current = ownership;
            projectionDocumentRef.current = {
              result: materialized.result,
              document: materialized.document,
              configurationKey: nativeResultConfigurationKey(configuration),
              contentHash: materialized.contentHash,
            };
            currentJobRef.current = "";
            setSurvivalDocument(null);
            setResult(materialized.result);
            setProcessing(false);
            setActiveWorkerThreads(null);
            setProgress(1);
            setStageKey("worker.stage.complete");
            setPoseEditing(false);
            setPreviewMode("hologram");
            return;
          }
        }
        const command: WorkerCommand = mode === "solid"
          ? {
              type: "GENERATE_SOLID",
              jobId,
              options: nextSolidOptions,
              versionId: javaVersionId,
              heightMode,
              datapackAcknowledged: heightMode !== "default",
              targetDimension: heightMode === "default"
                ? versionProfile.defaultDimension ?? COMPATIBILITY_DEFAULT_DIMENSION
                : declaredTargetDimension,
              placementBottomY: placementForHeightPreflight,
              confirmations: extremeConfirmationsRef.current,
              configurationFingerprint: extremeConfigurationFingerprint ?? undefined,
              source: { kind: "mesh", mesh: snapshot },
            }
          : {
              type: "GENERATE_HOLOGRAM",
              jobId,
              options: nextHologramOptions,
              versionId: javaVersionId,
              heightMode,
              datapackAcknowledged: heightMode !== "default",
              targetDimension: heightMode === "default"
                ? versionProfile.defaultDimension ?? COMPATIBILITY_DEFAULT_DIMENSION
                : declaredTargetDimension,
              placementBottomY: placementForHeightPreflight,
              confirmations: extremeConfirmationsRef.current,
              configurationFingerprint: extremeConfigurationFingerprint ?? undefined,
              generationSeed: {
                contentHash: `sha256:${sha256Hex(new Uint8Array(snapshot.positions.buffer))}`,
                minecraftVersion: javaVersionId,
              },
              source: { kind: "mesh", mesh: snapshot },
            };
        snapshotTransferredToWorker = workerLifecycle.post(
          jobId,
          command,
          snapshotTransferables(snapshot),
        );
        if (!snapshotTransferredToWorker) {
          throw appError("error.worker.protocol");
        }
      } finally {
        if (!snapshotTransferredToWorker && snapshot.positions.byteLength > 0) {
          releaseMmdMeshSnapshot(snapshot);
        }
      }
    } catch (error) {
      const stale = currentJobRef.current !== jobId || modelRef.current !== model;
      const locallyAborted = nativeRunSignal?.aborted ?? false;
      if (stale || locallyAborted) return;
      if (useWebWorker) workerLifecycle.cancel();
      else await cancelNativeSolidVoxelExecution();
      setProcessing(false);
      setActiveWorkerThreads(null);
      setPreviewMode("source");
      setToast(t("toast.generationFailed", { reason: localizeError(error) }));
    } finally {
      releaseBackendOperation(operationId);
    }
  }, [acquireBackendOperation, cancelNativeSolidVoxelExecution,
    clearProjectionArtifacts, currentMotionTimes,
    declaredTargetDimension, extremeConfigurationFingerprint, heightMode,
    javaVersionId, localizeError, nativeSolidVoxelJobAvailable, partsRevision,
    performanceCapabilities, placementBottomY, resolvedWorkerThreads,
    placementForHeightPreflight, poseRevision, releaseBackendOperation,
    releaseNativeSolidVoxelOwnership,
    solidVoxelBackendProbe?.nativeJobApi, t,
    targetDimensionHeight, targetDimensionMinY, assets, mmdModel?.stats.name,
    motionRuntime, motionTracks, poseState.editCount]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 2800);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
    } catch {
      // Width persistence is optional when storage is unavailable.
    }
  }, [sidebarWidth]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_UI_SCALE_STORAGE_KEY, String(sidebarUiScale));
    } catch {
      // UI scale persistence is optional when storage is unavailable.
    }
  }, [sidebarUiScale]);

  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth <= 720) return;
      setSidebarWidth((current) => clampSidebarWidth(current));
    };
    const onBlur = () => sidebarResizeCleanupRef.current?.();
    window.addEventListener("resize", onResize);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  useEffect(() => () => sidebarResizeCleanupRef.current?.(), []);

  const beginSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || window.innerWidth <= 720) return;
    event.preventDefault();
    const resizeHandle = event.currentTarget;
    const pointerId = event.pointerId;
    resizeHandle.setPointerCapture?.(pointerId);
    sidebarResizeCleanupRef.current?.();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onPointerMove = (pointerEvent: PointerEvent) => {
      setSidebarWidth(clampSidebarWidth(startWidth + pointerEvent.clientX - startX));
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
      if (resizeHandle.hasPointerCapture?.(pointerId)) {
        resizeHandle.releasePointerCapture(pointerId);
      }
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      if (sidebarResizeCleanupRef.current === cleanup) sidebarResizeCleanupRef.current = null;
    };
    sidebarResizeCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", cleanup);
    window.addEventListener("pointercancel", cleanup);
  }, [sidebarWidth]);

  const resetSidebarWidth = useCallback(() => {
    setSidebarWidth(clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH));
  }, []);

  const stepSidebarWidth = useCallback((delta: number) => {
    setSidebarWidth((current) => clampSidebarWidth(current + delta));
  }, []);

  const changeSidebarUiScale = useCallback((scale: number) => {
    setSidebarUiScale(normalizeSidebarUiScale(scale));
  }, []);

  const updateOptions = (patch: Partial<HologramOptions>) => {
    if (backendOperationRef.current) return;
    const selectedDefaultHeight = getJavaVersionProfile(javaVersionId)?.defaultDimension?.height
      ?? COMPATIBILITY_DEFAULT_DIMENSION.height;
    const maximumHeight = heightMode === "experimental_4064"
      ? EXPERIMENTAL_WORLD_HEIGHT
      : heightMode === "extended_2032"
        ? EXTENDED_WORLD_HEIGHT
        : selectedDefaultHeight;
    const normalizedPatch = patch.targetHeight === undefined
      ? patch
      : {
          ...patch,
          targetHeight: Math.max(32, Math.min(maximumHeight, Math.round(patch.targetHeight))),
        };
    setOptions((current) => ({ ...current, ...normalizedPatch }));
    if (normalizedPatch.targetHeight !== undefined) {
      setSolidOptions((current) => ({ ...current, targetHeight: normalizedPatch.targetHeight ?? current.targetHeight }));
    }
    if (Object.keys(normalizedPatch).some((key) => key !== "glow")) invalidateProjection("hologram-options");
    if (
      heightMode === "experimental_4064"
      && Object.keys(normalizedPatch).some((key) => key !== "glow")
    ) {
      invalidateExtremeAuthorization();
    }
  };

  const updateSolidOptions = (patch: Partial<SolidOptions>) => {
    if (backendOperationRef.current) return;
    const selectedDefaultHeight = getJavaVersionProfile(javaVersionId)?.defaultDimension?.height
      ?? COMPATIBILITY_DEFAULT_DIMENSION.height;
    const maximumHeight = heightMode === "experimental_4064"
      ? EXPERIMENTAL_WORLD_HEIGHT
      : heightMode === "extended_2032"
        ? EXTENDED_WORLD_HEIGHT
        : selectedDefaultHeight;
    const normalizedPatch = patch.targetHeight === undefined
      ? patch
      : {
          ...patch,
          targetHeight: Math.max(32, Math.min(maximumHeight, Math.round(patch.targetHeight))),
        };
    setSolidOptions((current) => ({ ...current, ...normalizedPatch }));
    if (normalizedPatch.targetHeight !== undefined) {
      setOptions((current) => ({ ...current, targetHeight: normalizedPatch.targetHeight ?? current.targetHeight }));
    }
    invalidateProjection("solid-options");
    if (heightMode === "experimental_4064") {
      invalidateExtremeAuthorization();
    }
  };

  const toggleExtendedHeight = () => {
    if (backendOperationRef.current) return;
    if (heightMode !== "default") {
      setHeightMode("default");
      setTargetDimensionMinY(null);
      setTargetDimensionHeight(null);
      setPlacementBottomY(null);
      setExtremeDialogStage(null);
      replaceExtremeConfirmations(createExtremeHeightConfirmationState());
      const defaultHeight = getJavaVersionProfile(javaVersionId)?.defaultDimension?.height
        ?? COMPATIBILITY_DEFAULT_DIMENSION.height;
      const targetHeight = Math.min(options.targetHeight, defaultHeight);
      setOptions((current) => ({ ...current, targetHeight }));
      setSolidOptions((current) => ({ ...current, targetHeight }));
      invalidateProjection("height-lock");
      return;
    }
    setHeightUnlockOpen(true);
  };

  const unlockExtendedHeight = () => {
    if (backendOperationRef.current) return;
    setHeightMode("extended_2032");
    setTargetDimensionMinY(-1024);
    setTargetDimensionHeight(EXTENDED_WORLD_HEIGHT);
    setPlacementBottomY(-1024);
    setHeightUnlockOpen(false);
    setToast(t("toast.extendedHeightUnlocked", { maximum: number(EXTENDED_WORLD_HEIGHT) }));
  };

  const changeGenerationMode = (mode: GenerationMode) => {
    if (backendOperationRef.current) return;
    if (mode === generationMode) return;
    if (mode === "solid" && !modelRef.current) {
      setToast(t("toast.solidModelRequired"));
      return;
    }
    invalidateProjection("mode");
    if (heightMode === "experimental_4064") {
      invalidateExtremeAuthorization();
    }
    setGenerationMode(mode);
  };

  const beginExtremeHeightUnlock = () => {
    if (backendOperationRef.current) return;
    if (heightMode !== "extended_2032" && heightMode !== "experimental_4064") return;
    const initialUnlock = heightMode === "extended_2032";
    if (initialUnlock) {
      setHeightMode("experimental_4064");
      setOptions((current) => ({ ...current, targetHeight: EXPERIMENTAL_WORLD_HEIGHT }));
      setSolidOptions((current) => ({ ...current, targetHeight: EXPERIMENTAL_WORLD_HEIGHT }));
      setTargetDimensionMinY(-2032);
      setTargetDimensionHeight(EXPERIMENTAL_WORLD_HEIGHT);
      setPlacementBottomY(-2032);
      invalidateProjection("extreme-height-unlock");
    }
    invalidateExtremeAuthorization();
    setExtremeDialogStage("unlock");
    setExtremeDialogOrigin(initialUnlock ? "initial" : "reconfirm");
  };

  const confirmExtremeUnlockStage = () => {
    if (backendOperationRef.current) return;
    const fingerprint = extremeFingerprintBase
      ? createExtremeHeightConfigurationFingerprint(extremeFingerprintBase)
      : null;
    if (!fingerprint) return;
    replaceExtremeConfirmations((current) => confirmExtremeUnlock(
      current,
      fingerprint,
      `Java ${javaVersionId}; Y=-2032..2031; 2033-4064 layers`,
    ));
    setExtremeDialogStage("environment");
  };

  const cancelExtremeHeightUnlock = () => {
    if (backendOperationRef.current) return;
    setExtremeDialogStage(null);
    setExtremeDialogOrigin(null);
    setExtremeEnvironmentChecks({ datapack: false, backup: false, toolchain: false });
    replaceExtremeConfirmations(createExtremeHeightConfirmationState());
    if (extremeDialogOrigin === "reconfirm") return;
    setHeightMode("extended_2032");
    setTargetDimensionMinY(-1024);
    setTargetDimensionHeight(EXTENDED_WORLD_HEIGHT);
    setPlacementBottomY(-1024);
    const normalizedHeight = Math.min(options.targetHeight, EXTENDED_WORLD_HEIGHT);
    setOptions((current) => ({ ...current, targetHeight: normalizedHeight }));
    setSolidOptions((current) => ({ ...current, targetHeight: normalizedHeight }));
  };

  const confirmExtremeEnvironmentStage = () => {
    if (backendOperationRef.current) return;
    const fingerprint = extremeFingerprintBase
      ? createExtremeHeightConfigurationFingerprint(extremeFingerprintBase)
      : null;
    if (!fingerprint || !Object.values(extremeEnvironmentChecks).every(Boolean)) return;
    try {
      replaceExtremeConfirmations((current) => confirmExtremeEnvironment(
        current,
        fingerprint,
        `Java ${javaVersionId}; data pack, backup, and toolchain self-checked`,
      ));
      setHeightMode("experimental_4064");
      setExtremeDialogStage(null);
      setExtremeDialogOrigin(null);
    } catch (error) {
      setToast(localizeError(error));
    }
  };

  const changeTargetDimension = (patch: {
    minY?: number | null;
    height?: number | null;
    placementBottomY?: number | null;
  }) => {
    if (backendOperationRef.current) return;
    const normalize = (value: number | null) => Number.isSafeInteger(value) ? value : null;
    if (patch.minY !== undefined) setTargetDimensionMinY(normalize(patch.minY));
    if (patch.height !== undefined) {
      const height = normalize(patch.height);
      setTargetDimensionHeight(height !== null && height > 0 ? height : null);
    }
    if (patch.placementBottomY !== undefined) {
      setPlacementBottomY(normalize(patch.placementBottomY));
    }
    if (heightMode === "experimental_4064") invalidateExtremeAuthorization();
    projectionDocumentRef.current = null;
    setSurvivalDocument(null);
    setSurvivalToolsOpen(false);
    setExportCenterOpen(false);
    setExportPreflights({});
    setPendingExport(null);
    setExtendedExportAcknowledged(false);
  };

  const changeJavaVersion = (versionId: string) => {
    if (backendOperationRef.current) return;
    const profile = getJavaVersionProfile(versionId);
    if (!profile) return;
    setJavaVersionId(versionId);
    if (heightMode === "default") {
      setTargetDimensionMinY(null);
      setTargetDimensionHeight(null);
      setPlacementBottomY(null);
      const maximum = profile.defaultDimension?.height ?? COMPATIBILITY_DEFAULT_DIMENSION.height;
      const nextTargetHeight = Math.min(options.targetHeight, maximum);
      setOptions((current) => ({ ...current, targetHeight: nextTargetHeight }));
      setSolidOptions((current) => ({ ...current, targetHeight: nextTargetHeight }));
      replaceExtremeConfirmations(createExtremeHeightConfirmationState());
    } else if (heightMode === "experimental_4064") {
      invalidateExtremeAuthorization();
    } else {
      replaceExtremeConfirmations(createExtremeHeightConfirmationState());
    }
    setHeightUnlockOpen(false);
    setExtremeDialogStage(null);
    setExtendedExportAcknowledged(false);
    invalidateProjection("java-version");
    if (profile.releaseStatus !== "verified") {
      setToast(t("toast.javaVersionUnverified", { version: profile.id }));
    }
  };

  const captureMmdRuntimeRestoreState = useCallback((
    model: LoadedMmdModel,
  ): MmdRuntimeRestoreState => ({
    poseTransfer: model.exportPoseTransferState(),
    hiddenMaterialIndices: [...hiddenMaterialIndicesRef.current],
    selectedMaterialIndex,
    motionPaths: { ...selectedMotionPaths },
    motionTimes: currentMotionTimes(),
    lockedFrames: { ...lockedMotionFrames },
    playing: Object.fromEntries(MOTION_TRACK_KINDS.map((kind) => [kind, motionRuntime[kind].playing])) as Record<MmdMotionTrackKind, boolean>,
    selectedBoneIndex,
    poseEditing,
    physicsEnabled: model.physicsEnabled(),
  }), [currentMotionTimes, lockedMotionFrames, motionRuntime, poseEditing, selectedBoneIndex, selectedMaterialIndex, selectedMotionPaths]);

  const loadRendererModelWithLease = useCallback(async (
    mode: MmdRendererMode,
    files: readonly File[],
    modelFile: File,
  ): Promise<LoadedMmdModel> => {
    const previousLease = rendererLeaseRef.current.catch(() => undefined);
    let releaseLease!: () => void;
    const lease = new Promise<void>((resolve) => {
      releaseLease = resolve;
    });
    const queuedLease = previousLease.then(() => lease);
    rendererLeaseRef.current = queuedLease;
    await previousLease;

    let loaded: LoadedMmdModel;
    try {
      loaded = await loadMmdModelForRenderer(mode, files, modelFile);
    } catch (error) {
      releaseLease();
      if (rendererLeaseRef.current === queuedLease) rendererLeaseRef.current = Promise.resolve();
      throw error;
    }

    const originalDispose = loaded.dispose.bind(loaded);
    let disposePromise: Promise<void> | null = null;
    loaded.dispose = async () => {
      if (disposePromise) return disposePromise;
      disposePromise = (async () => {
        try {
          await originalDispose();
        } finally {
          releaseLease();
          if (rendererLeaseRef.current === queuedLease) rendererLeaseRef.current = Promise.resolve();
        }
      })();
      return disposePromise;
    };
    return loaded;
  }, []);

  const resolveViewportLifecycleWaiter = useCallback((
    waiterRef: MutableRefObject<ViewportLifecycleWaiter | null>,
    generation: number,
    modelId: string,
  ) => {
    const waiter = waiterRef.current;
    if (!waiter || waiter.generation !== generation || waiter.modelId !== modelId) return false;
    waiterRef.current = null;
    window.clearTimeout(waiter.timer);
    waiter.resolve();
    return true;
  }, []);

  const rejectViewportLifecycleWaiter = useCallback((
    waiterRef: MutableRefObject<ViewportLifecycleWaiter | null>,
    generation: number,
    modelId: string,
    error: unknown,
  ) => {
    const waiter = waiterRef.current;
    if (!waiter || waiter.generation !== generation || waiter.modelId !== modelId) return false;
    waiterRef.current = null;
    window.clearTimeout(waiter.timer);
    waiter.reject(error);
    return true;
  }, []);

  const waitForViewportReady = useCallback((binding: { generation: number; modelId: string }) => {
    if (
      readyViewportRef.current?.generation === binding.generation
      && readyViewportRef.current.modelId === binding.modelId
    ) return Promise.resolve();
    const existing = viewportReadyWaiterRef.current;
    if (existing?.generation === binding.generation && existing.modelId === binding.modelId) {
      return existing.promise;
    }
    let resolveWaiter!: () => void;
    let rejectWaiter!: (error: unknown) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveWaiter = resolve;
      rejectWaiter = reject;
    });
    const waiter = {
      generation: binding.generation,
      modelId: binding.modelId,
      resolve: resolveWaiter,
      reject: rejectWaiter,
      timer: 0,
      promise,
    } satisfies ViewportLifecycleWaiter;
    waiter.timer = window.setTimeout(() => {
      rejectViewportLifecycleWaiter(
        viewportReadyWaiterRef,
        binding.generation,
        binding.modelId,
        new Error("Renderer viewport did not become ready"),
      );
    }, 15000);
    viewportReadyWaiterRef.current = waiter;
    return promise;
  }, [rejectViewportLifecycleWaiter]);

  const acknowledgeViewportReady = useCallback((binding: { generation: number; modelId: string }) => {
    if (
      activeViewportRef.current?.generation !== binding.generation
      || activeViewportRef.current.modelId !== binding.modelId
    ) return;
    readyViewportRef.current = binding;
    setViewportReadyBinding(binding);
    resolveViewportLifecycleWaiter(viewportReadyWaiterRef, binding.generation, binding.modelId);
  }, [resolveViewportLifecycleWaiter]);

  const acknowledgeViewportUnmount = useCallback((binding: { generation: number; modelId: string }) => {
    const requested = viewportUnmountRequestRef.current;
    if (
      !requested
      || requested.generation !== binding.generation
      || requested.modelId !== binding.modelId
    ) return;
    viewportUnmountRequestRef.current = null;
    if (
      activeViewportRef.current?.generation === binding.generation
      && activeViewportRef.current.modelId === binding.modelId
    ) {
      activeViewportRef.current = null;
      readyViewportRef.current = null;
      setViewportReadyBinding(null);
    }
    rejectViewportLifecycleWaiter(
      viewportReadyWaiterRef,
      binding.generation,
      binding.modelId,
      new Error("Renderer viewport was unmounted before it became ready"),
    );
    resolveViewportLifecycleWaiter(viewportUnmountWaiterRef, binding.generation, binding.modelId);
  }, [rejectViewportLifecycleWaiter, resolveViewportLifecycleWaiter]);

  const waitForViewportUnmount = useCallback(async () => {
    if (viewportUnmountPromiseRef.current) return viewportUnmountPromiseRef.current;
    const binding = activeViewportRef.current;
    if (!binding) {
      await yieldForModelRelease();
      return;
    }
    // A binding is committed before React necessarily commits the viewport
    // element. In that small window there is no unmount callback to await, but
    // the binding still has to be invalidated before the next backend loads.
    // Relying on viewportMountedRef here can otherwise leave a failed load's
    // identity mounted in state and allow a stale cleanup to race the next
    // renderer transaction.
    if (!viewportMountedRef.current) {
      rejectViewportLifecycleWaiter(
        viewportReadyWaiterRef,
        binding.generation,
        binding.modelId,
        new Error("Renderer viewport was released before mounting"),
      );
      activeViewportRef.current = null;
      readyViewportRef.current = null;
      viewportUnmountRequestRef.current = null;
      setViewportMounted(false);
      setViewportBinding(null);
      setViewportReadyBinding(null);
      await yieldForModelRelease();
      return;
    }
    let resolveWaiter!: () => void;
    let rejectWaiter!: (error: unknown) => void;
    const unmounted = new Promise<void>((resolve, reject) => {
      resolveWaiter = resolve;
      rejectWaiter = reject;
    });
    const waiter = {
      generation: binding.generation,
      modelId: binding.modelId,
      resolve: resolveWaiter,
      reject: rejectWaiter,
      timer: 0,
      promise: unmounted,
    } satisfies ViewportLifecycleWaiter;
    viewportUnmountRequestRef.current = binding;
    waiter.timer = window.setTimeout(() => {
      if (
        viewportUnmountRequestRef.current?.generation === binding.generation
        && viewportUnmountRequestRef.current.modelId === binding.modelId
      ) {
        viewportUnmountRequestRef.current = null;
      }
      rejectViewportLifecycleWaiter(
        viewportUnmountWaiterRef,
        binding.generation,
        binding.modelId,
        new Error("Renderer viewport did not finish unmounting"),
      );
    }, 15000);
    viewportUnmountWaiterRef.current = waiter;
    const pending = (async () => {
      setViewportMounted(false);
      setViewportBinding(null);
      setViewportReadyBinding(null);
      await unmounted;
    })();
    const settled = pending.finally(() => {
      if (
        viewportUnmountRequestRef.current?.generation === binding.generation
        && viewportUnmountRequestRef.current.modelId === binding.modelId
      ) {
        viewportUnmountRequestRef.current = null;
      }
      if (viewportUnmountPromiseRef.current === settled) viewportUnmountPromiseRef.current = null;
    });
    viewportUnmountPromiseRef.current = settled;
    return settled;
  }, [rejectViewportLifecycleWaiter]);

  const releaseCurrentModel = useCallback(async (expectedModel?: LoadedMmdModel | null) => {
    const previousModel = modelRef.current;
    // A stale load task must never clear a model that a newer transaction has
    // already committed. The identity check is intentionally synchronous,
    // before any state is reset or viewport unmount is requested.
    if (expectedModel !== undefined && previousModel !== expectedModel) return;
    modelRef.current = null;
    setMmdModel(null);
    setSelectedModelPath("");
    setMotionCandidates(emptyMotionCandidateTracks());
    resetMotionTracks();
    setPhysicsEnabled(false);
    setPhysicsLoading(false);
    hiddenMaterialIndicesRef.current = [];
    setHiddenMaterialIndices([]);
    setSelectedMaterialIndex(null);
    setPoseEditing(false);
    setSelectedBoneIndex(null);
    setPoseState(emptyPoseState);

    const viewportRelease = waitForViewportUnmount();

    if (!previousModel) {
      await modelReleaseRef.current.catch(() => undefined);
      let viewportError: unknown = null;
      try {
        await viewportRelease;
      } catch (error) {
        viewportError = error;
      }
      await yieldForModelRelease();
      if (viewportError) throw viewportError;
      return;
    }

    const previousRelease = modelReleaseRef.current.catch(() => undefined);
    const release = (async () => {
      await previousRelease;
      // A lifecycle timeout must not skip model disposal. The viewport is
      // still asked to unmount first, but disposal is forced in the finally
      // path so the renderer lease cannot remain held forever.
      let viewportError: unknown = null;
      try {
        await viewportRelease;
      } catch (error) {
        viewportError = error;
      }
      await yieldForModelRelease();
      let disposeError: unknown = null;
      try {
        await previousModel.dispose();
      } catch (error) {
        disposeError = error;
      }
      await yieldForModelRelease();
      if (disposeError) throw disposeError;
      if (viewportError) throw viewportError;
    })();
    modelReleaseRef.current = release;
    try {
      await release;
    } finally {
      if (modelReleaseRef.current === release) modelReleaseRef.current = Promise.resolve();
    }
  }, [resetMotionTracks, waitForViewportUnmount]);

  const clearCurrentModel = async () => {
    if (backendOperationRef.current || modelLoading || physicsLoading || rendererSwitchingRef.current) return;
    const operationId = acquireBackendOperation();
    if (!operationId) return;
    const requestId = crypto.randomUUID();
    modelLoadRequestRef.current = requestId;
    invalidateProjection(`model-clear:${requestId}`);
    // Clearing the model invalidates the source identity before teardown. If
    // viewport cleanup rejects, no stale package can be reused by a later
    // renderer-switch request.
    activeMmdSourceRef.current = null;
    setPoseEditing(false);
    setModelLoading(true);
    setModelLoadStageKey("app.stage.clearModel");
    try {
      await releaseCurrentModel();
      if (modelLoadRequestRef.current === requestId) setToast(t("toast.modelCleared"));
    } finally {
      if (modelLoadRequestRef.current === requestId) {
        setModelLoading(false);
        setModelLoadStageKey("app.stage.modelComplete");
      }
      releaseBackendOperation(operationId);
    }
  };

  const loadModelFromPackage = useCallback(async (
    packageFiles: File[],
    modelFile: File,
    modelPath: string,
    requestId: string,
    rendererMode: MmdRendererMode = renderModeRef.current,
    restoreState?: MmdRuntimeRestoreState,
  ) => {
    if (modelLoadRequestRef.current !== requestId) return;
    setModelLoadStageKey("app.stage.parseModel");
    // A normal model replacement invalidates the previous source immediately.
    // If viewport teardown later rejects, no stale source may remain eligible
    // for a renderer switch while the model identity has already been cleared.
    if (!restoreState) activeMmdSourceRef.current = null;
    const modelBeforeRelease = modelRef.current;
    await releaseCurrentModel(modelBeforeRelease);
    if (modelLoadRequestRef.current !== requestId) return;

    let loaded: LoadedMmdModel | null = null;
    try {
      loaded = await loadRendererModelWithLease(rendererMode, packageFiles, modelFile);
      if (modelLoadRequestRef.current !== requestId) {
        await loaded.dispose();
        return;
      }

      const loadedTracks: Partial<Record<MmdMotionTrackKind, MmdMotionTrackInfo>> = {};
      const loadedTrackPaths: Partial<Record<MmdMotionTrackKind, string>> = {};
      const {
        groupMmdMotionTrackCandidates,
        inspectMmdMotionCandidates,
      } = await import("./core/mmdAssets");
      const compatibleMotions = groupMmdMotionTrackCandidates(
        await inspectMmdMotionCandidates(packageFiles, loaded),
      );
      if (modelLoadRequestRef.current !== requestId) {
        await loaded.dispose();
        return;
      }
      setModelLoadStageKey("app.stage.parseMotion");
      for (const kind of MOTION_TRACK_KINDS) {
        const preferredPath = restoreState?.motionPaths[kind];
        const candidate = restoreState
          ? (preferredPath
            ? compatibleMotions[kind].find((entry) => entry.path === preferredPath)
            : undefined)
          : compatibleMotions[kind][0];
        if (!candidate) {
          if (restoreState && preferredPath) {
            throw appError("error.motion.loadFailed");
          }
          continue;
        }
        loadedTracks[kind] = await loaded.loadMotion(candidate.file, kind);
        loadedTrackPaths[kind] = candidate.path;
        if (modelLoadRequestRef.current !== requestId) {
          await loaded.dispose();
          return;
        }
      }

      if (restoreState?.poseTransfer) {
        const applied = loaded.importPoseTransferState(restoreState.poseTransfer);
        if (applied.missingBoneNames.length || applied.missingMorphNames.length) {
          throw appError("error.model.loadFailed");
        }
      }
      if (restoreState?.physicsEnabled && loaded.physicsAvailable) {
        await loaded.setPhysicsEnabled(true);
        if (modelLoadRequestRef.current !== requestId) {
          if (modelRef.current === loaded) await releaseCurrentModel(loaded);
          else await loaded.dispose();
          return;
        }
        if (!loaded.physicsEnabled()) throw appError("error.physics.loadFailed");
      } else if (restoreState?.physicsEnabled && !loaded.physicsAvailable) {
        throw appError("error.physics.loadFailed");
      }
      const restoredTimes = restoreState?.motionTimes ?? { dance: 0, expression: 0 };
      loaded.updatePose(restoredTimes);
      for (const index of restoreState?.hiddenMaterialIndices ?? []) {
        if (loaded.materials[index]) loaded.setMaterialVisible(index, false);
      }

      if (modelLoadRequestRef.current !== requestId) {
        await loaded.dispose();
        return;
      }

      const binding: ViewportBinding = {
        generation: ++viewportGenerationRef.current,
        modelId: loaded.id,
      };
      // A new binding is the commit point for a replacement backend. Any
      // previous unmount request has already settled or timed out by this
      // point, so a later stale cleanup must not affect the new viewport.
      viewportUnmountRequestRef.current = null;
      activeViewportRef.current = binding;
      readyViewportRef.current = null;
      setViewportReadyBinding(null);
      modelRef.current = loaded;
      setMmdModel(loaded);
      setViewportBinding(binding);
      setViewportMounted(true);
      setSelectedModelPath(modelPath);
      setPoseEditing(Boolean(restoreState?.poseEditing) && !MOTION_TRACK_KINDS.some((kind) => restoreState?.playing[kind]));
      const restoredSelectedBone = restoreState?.selectedBoneIndex;
      setSelectedBoneIndex(
        restoredSelectedBone !== null
          && restoredSelectedBone !== undefined
          && loaded.bones[restoredSelectedBone]
          ? restoredSelectedBone
          : chooseDefaultBone(loaded.bones),
      );
      setPoseState(loaded.poseState());
      setSolidOptions((current) => ({
        ...current,
        skinMaterialIndices: loaded!.materials
          .filter((material) => material.suggestedSkin)
          .map((material) => material.index),
        emissiveMaterialIndices: loaded!.materials
          .filter((material) => material.suggestedEmissive)
          .map((material) => material.index),
      }));
      setMotionCandidates(compatibleMotions);
      MOTION_TRACK_KINDS.forEach((kind) => {
        const info = loadedTracks[kind];
        if (info) installMotionTrack(kind, info, loadedTrackPaths[kind] ?? restoreState?.motionPaths[kind] ?? info.name);
      });
      if (restoreState) {
        MOTION_TRACK_KINDS.forEach((kind) => {
          const info = loadedTracks[kind];
          if (!info) return;
          const restoredSeconds = Math.max(0, Math.min(info.durationSeconds, restoredTimes[kind]));
          publishMotionSeconds(kind, restoredSeconds);
          setLockedMotionFrames((current) => ({ ...current, [kind]: restoreState.lockedFrames[kind] }));
          const runtime = motionRuntime[kind];
          const playing = Boolean(restoreState.playing[kind]) && restoreState.lockedFrames[kind] === null;
          runtime.playing = playing;
          runtime.playbackStore.set(playing);
          runtime.clock = {
            startedAt: performance.now(),
            startSeconds: restoredSeconds,
            lastUiFrame: Math.round(restoredSeconds * info.frameRate),
          };
        });
      }
      setPhysicsEnabled(loaded.physicsEnabled());
      hiddenMaterialIndicesRef.current = [...(restoreState?.hiddenMaterialIndices ?? [])];
      setHiddenMaterialIndices(hiddenMaterialIndicesRef.current);
      const restoredSelectedMaterialIndex = restoreState?.selectedMaterialIndex ?? null;
      setSelectedMaterialIndex(
        restoredSelectedMaterialIndex !== null
          && Number.isInteger(restoredSelectedMaterialIndex)
          && loaded.materials[restoredSelectedMaterialIndex]?.index === restoredSelectedMaterialIndex
          ? restoredSelectedMaterialIndex
          : null,
      );
      activeMmdSourceRef.current = {
        files: [...packageFiles],
        modelFile,
        modelPath,
        rendererMode,
      };
      setRenderMode(rendererMode);
      clearProjectionArtifacts();
      setPreviewMode("source");
      setResetToken((value) => value + 1);
      setPoseRevision((value) => value + 1);

      await waitForViewportReady(binding);
      if (modelLoadRequestRef.current !== requestId || modelRef.current !== loaded) {
        if (modelRef.current === loaded) await releaseCurrentModel(loaded);
        else await loaded.dispose();
        return;
      }

      const warnings = loaded.stats.textureWarnings;
      const loadedMotion = loadedTracks.dance ?? loadedTracks.expression;
      setToast(t("toast.modelLoaded", {
        name: loaded.stats.name,
        vertices: number(loaded.stats.vertexCount),
        motion: loadedMotion ? t("toast.modelLoadedMotion", { frames: number(loadedMotion.maxFrame) }) : "",
        warnings: warnings ? t("toast.modelLoadedWarnings", { count: number(warnings) }) : "",
      }));
      return loaded;
    } catch (error) {
      if (loaded && modelRef.current === loaded) {
        // Once a binding has been committed, failure (including a readiness
        // timeout) must use the same requested-unmount handshake as a normal
        // renderer transition. Directly clearing state would bypass the gate
        // and leave the old viewport binding orphaned.
        await releaseCurrentModel(loaded);
      } else if (loaded) {
        await loaded.dispose();
      }
      throw error;
    }
  }, [clearProjectionArtifacts, installMotionTrack, loadRendererModelWithLease, motionRuntime, number, publishMotionSeconds, releaseCurrentModel, t, waitForViewportReady]);

  /**
   * Renderer changes are serialized as an unload-then-load transaction. The
   * old model is fully disposed before a new WebGL owner is created; if the
   * new backend fails, the same source files and pose state rebuild the old
   * backend so conversion remains usable.
   */
  const switchRenderer = useCallback(async (nextMode: MmdRendererMode) => {
    const current = modelRef.current;
    const source = activeMmdSourceRef.current;
    const previousMode = current?.rendererMode ?? renderModeRef.current;
    if (!current || !source || nextMode === previousMode || rendererSwitchingRef.current) return;
    if (modelLoading || processing || exporting || physicsLoading) return;
    const operationId = acquireBackendOperation();
    if (!operationId) return;

    rendererSwitchingRef.current = true;
    const requestId = crypto.randomUUID();
    rendererSwitchOwnerRef.current = requestId;
    modelLoadRequestRef.current = requestId;
    let restoreState: MmdRuntimeRestoreState;
    try {
      restoreState = captureMmdRuntimeRestoreState(current);
    } catch (error) {
      // Keep a synchronous pose-export failure from leaving the renderer
      // transaction permanently locked in the switching state.
      rendererSwitchOwnerRef.current = null;
      rendererSwitchingRef.current = false;
      releaseBackendOperation(operationId);
      setToast(t("toast.rendererSwitchFailed", { reason: localizeError(error) }));
      return;
    }
    stopAllMotionPlayback();
    invalidateProjection(`renderer-switch:${nextMode}:${requestId}`);
    setPoseEditing(false);
    setModelLoading(true);
    setModelLoadStageKey("app.stage.parseModel");

    try {
      await loadModelFromPackage(
        source.files,
        source.modelFile,
        source.modelPath,
        requestId,
        nextMode,
        restoreState,
      );
      if (modelLoadRequestRef.current === requestId) {
        setToast(t("toast.rendererSwitched", { mode: nextMode }));
      }
    } catch (error) {
      if (modelLoadRequestRef.current !== requestId) return;
      setRenderMode(previousMode);
      try {
        await loadModelFromPackage(
          source.files,
          source.modelFile,
          source.modelPath,
          requestId,
          previousMode,
          restoreState,
        );
        setToast(t("toast.rendererSwitchFailedRollback", {
          reason: localizeError(error),
        }));
      } catch (rollbackError) {
        activeMmdSourceRef.current = null;
        setToast(t("toast.rendererSwitchFailed", {
          reason: `${localizeError(error)}; ${localizeError(rollbackError)}`,
        }));
      }
    } finally {
      if (rendererSwitchOwnerRef.current === requestId) {
        rendererSwitchOwnerRef.current = null;
        rendererSwitchingRef.current = false;
        releaseBackendOperation(operationId);
        if (modelLoadRequestRef.current === requestId) {
          setModelLoading(false);
          setModelLoadStageKey("app.stage.modelComplete");
        }
      }
    }
  }, [acquireBackendOperation, captureMmdRuntimeRestoreState, exporting, invalidateProjection, loadModelFromPackage, localizeError, modelLoading, physicsLoading, processing, releaseBackendOperation, stopAllMotionPlayback, t]);

  const addAssets = async (files: File[]) => {
    if (backendOperationRef.current || physicsLoading || rendererSwitchingRef.current) return;
    const operationId = acquireBackendOperation();
    if (!operationId) return;
    const requestId = crypto.randomUUID();
    modelLoadRequestRef.current = requestId;
    invalidateProjection(`model-load:${requestId}`);
    setPoseEditing(false);
    setModelLoading(true);
    setModelLoadStageKey("app.stage.readAssets");

    try {
      const {
        choosePrimaryMmdModel,
        expandMmdAssets,
        groupMmdMotionTrackCandidates,
        inspectMmdMotionCandidates,
        inspectMmdModels,
        normalizeAssetPath,
      } = await import("./core/mmdAssets");
      const expanded = await expandMmdAssets(files);
      if (modelLoadRequestRef.current !== requestId) return;
      const candidates = await inspectMmdModels(expanded);
      if (modelLoadRequestRef.current !== requestId) return;
      const modelFile = choosePrimaryMmdModel(expanded, candidates);
      const nextAssets = expanded.map((file) => ({
        name: file.name,
        path: normalizeAssetPath(file.webkitRelativePath || file.name),
        type: classifyAsset(file),
        size: file.size,
      }));

      if (!modelFile) {
        if (modelLoadRequestRef.current === requestId) {
          const currentModel = modelRef.current;
          const combinedFiles = [...expandedAssetsRef.current, ...expanded];
          const compatibleMotions = currentModel
            ? groupMmdMotionTrackCandidates(
                await inspectMmdMotionCandidates(combinedFiles, currentModel),
              )
            : emptyMotionCandidateTracks();
          if (
            modelLoadRequestRef.current !== requestId
            || (currentModel && modelRef.current !== currentModel)
          ) return;
          if (currentModel) setMotionCandidates(compatibleMotions);
          const importedPaths = new Set(expanded.map((file) => normalizeAssetPath(
            file.webkitRelativePath || file.name,
          )));
          const selectedCandidates = Object.fromEntries(MOTION_TRACK_KINDS.map((kind) => [
            kind,
            compatibleMotions[kind].find((candidate) => importedPaths.has(candidate.path)),
          ])) as Partial<Record<MmdMotionTrackKind, MmdMotionCandidateTracks[MmdMotionTrackKind][number]>>;
          if ((selectedCandidates.dance || selectedCandidates.expression) && currentModel) {
            setModelLoadStageKey("app.stage.parseMotion");
            const loadedTracks: MmdMotionTrackInfo[] = [];
            for (const kind of MOTION_TRACK_KINDS) {
              const candidate = selectedCandidates[kind];
              if (!candidate) continue;
              if (modelLoadRequestRef.current !== requestId || modelRef.current !== currentModel) return;
              const loadedMotion = await currentModel.loadMotion(candidate.file, kind);
              if (modelLoadRequestRef.current !== requestId || modelRef.current !== currentModel) return;
              installMotionTrack(kind, loadedMotion, candidate.path);
              loadedTracks.push(loadedMotion);
            }
            if (modelLoadRequestRef.current !== requestId || modelRef.current !== currentModel) return;
            currentModel.updatePose(currentMotionTimes());
            setPoseEditing(false);
            invalidatePoseProjection();
            setPoseRevision((value) => value + 1);
            setAssets((current) => [...current, ...nextAssets]);
            expandedAssetsRef.current = combinedFiles;
            if (activeMmdSourceRef.current && modelRef.current === currentModel) {
              activeMmdSourceRef.current = {
                ...activeMmdSourceRef.current,
                files: [...combinedFiles],
              };
            }
            setPreviewMode("source");
            setToast(t("toast.motionLoaded", {
              name: loadedTracks.map((track) => track.name).join(" + "),
              frames: number(Math.max(...loadedTracks.map((track) => track.maxFrame))),
            }));
            return;
          }
          if (modelLoadRequestRef.current !== requestId) return;
          setAssets((current) => [...current, ...nextAssets]);
          expandedAssetsRef.current = combinedFiles;
          if (activeMmdSourceRef.current && currentModel && modelRef.current === currentModel) {
            activeMmdSourceRef.current = {
              ...activeMmdSourceRef.current,
              files: [...combinedFiles],
            };
          }
          setToast(t("toast.assetsWithoutModel", { count: number(expanded.length) }));
        }
        return;
      }

      expandedAssetsRef.current = expanded;
      setModelCandidates(candidates);
      setAssets(nextAssets);
      const modelPath = normalizeAssetPath(modelFile.webkitRelativePath || modelFile.name);
      await loadModelFromPackage(expanded, modelFile, modelPath, requestId);
    } catch (error) {
      if (modelLoadRequestRef.current === requestId) {
        setToast(t("toast.modelImportFailed", { reason: localizeError(error) }));
      }
    } finally {
      if (modelLoadRequestRef.current === requestId) {
        setModelLoading(false);
        setModelLoadStageKey("app.stage.modelComplete");
      }
      releaseBackendOperation(operationId);
    }
  };
  addAssetsRef.current = addAssets;

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import("./platform/desktop").then(async (desktop) => {
      if (disposed || !desktop.isDesktopRuntime()) return;
      unlisten = await desktop.listenForDesktopDragDrop((event) => {
        if (event.type !== "drop" || !event.paths.length) return;
        void desktop.readDesktopAssets(event.paths)
          .then((files) => addAssetsRef.current(files))
          .catch((error) => {
            const descriptor = errorDescriptor(error);
            setToast(translateRef.current("toast.modelImportFailed", {
              reason: translateRef.current(descriptor.code, descriptor.params),
            }));
          });
      });
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const selectModelFromPackage = async (path: string) => {
    if (backendOperationRef.current || modelLoading || physicsLoading || rendererSwitchingRef.current || path === selectedModelPath) return;
    if (!path) {
      await clearCurrentModel();
      return;
    }
    const operationId = acquireBackendOperation();
    if (!operationId) return;
    const requestId = crypto.randomUUID();
    modelLoadRequestRef.current = requestId;
    invalidateProjection(`model-switch:${requestId}`);
    setPoseEditing(false);
    setModelLoading(true);
    setModelLoadStageKey("app.stage.switchModel");

    try {
      const { findMmdModelByPath } = await import("./core/mmdAssets");
      const packageFiles = expandedAssetsRef.current;
      const modelFile = findMmdModelByPath(packageFiles, path);
      if (!modelFile) throw appError("error.model.notFound");
      await loadModelFromPackage(
        packageFiles,
        modelFile,
        path,
        requestId,
      );
    } catch (error) {
      if (modelLoadRequestRef.current === requestId) {
        setToast(t("toast.modelSwitchFailed", { reason: localizeError(error) }));
      }
    } finally {
      if (modelLoadRequestRef.current === requestId) {
        setModelLoading(false);
        setModelLoadStageKey("app.stage.modelComplete");
      }
      releaseBackendOperation(operationId);
    }
  };

  const selectMotionFromPackage = async (kind: MmdMotionTrackKind, path: string) => {
    if (backendOperationRef.current) return;
    const model = modelRef.current;
    if (!model || modelLoading || physicsLoading || processing || rendererSwitchingRef.current || path === selectedMotionPaths[kind]) return;

    if (!path) {
      model.clearMotion(kind);
      resetMotionTrack(kind);
      model.updatePose(currentMotionTimes());
      setPoseEditing(false);
      setPoseState(model.poseState());
      invalidateProjection(`motion-clear:${kind}`);
      setPoseRevision((value) => value + 1);
      setPreviewMode("source");
      setToast(t("toast.motionCleared", {
        track: t(kind === "dance" ? "sidebar.motion.danceTrack" : "sidebar.motion.expressionTrack"),
      }));
      return;
    }

    const candidate = motionCandidates[kind].find((entry) => entry.path === path);
    if (!candidate) return;
    const operationId = acquireBackendOperation();
    if (!operationId) return;
    const requestId = crypto.randomUUID();
    modelLoadRequestRef.current = requestId;
    invalidateProjection(`motion-switch:${kind}:${requestId}`);
    setPoseEditing(false);
    setModelLoading(true);
    setModelLoadStageKey("app.stage.parseMotion");

    try {
      const loadedMotion = await model.loadMotion(candidate.file, kind);
      if (modelLoadRequestRef.current !== requestId || modelRef.current !== model) return;
      installMotionTrack(kind, loadedMotion, candidate.path);
      model.updatePose(currentMotionTimes());
      setPoseState(model.poseState());
      setPoseRevision((value) => value + 1);
      setPreviewMode("source");
      setToast(t("toast.motionLoaded", {
        name: loadedMotion.name,
        frames: number(loadedMotion.maxFrame),
      }));
    } catch (error) {
      if (modelLoadRequestRef.current === requestId && modelRef.current === model) {
        setToast(t("toast.motionSwitchFailed", { reason: localizeError(error) }));
      }
    } finally {
      if (modelLoadRequestRef.current === requestId) {
        setModelLoading(false);
        setModelLoadStageKey("app.stage.modelComplete");
      }
      releaseBackendOperation(operationId);
    }
  };

  const changePhysicsEnabled = async (enabled: boolean) => {
    const model = modelRef.current;
    if (!model || !model.physicsAvailable || physicsLoading || modelLoading || processing || rendererSwitchingRef.current) return;
    const operationId = acquireBackendOperation();
    if (!operationId) return;
    setPhysicsLoading(true);
    stopAllMotionPlayback();
    try {
      await model.setPhysicsEnabled(enabled);
      if (modelRef.current !== model) return;
      lastLivePhysicsFrameRef.current = null;
      model.updatePose(currentMotionTimes());
      setPhysicsEnabled(model.physicsEnabled());
      invalidateProjection("physics");
      setPoseRevision((value) => value + 1);
      setPreviewMode("source");
      setToast(t(enabled ? "toast.physicsEnabled" : "toast.physicsDisabled"));
    } catch (error) {
      if (modelRef.current === model) {
        setPhysicsEnabled(model.physicsEnabled());
        setToast(t("toast.physicsFailed", { reason: localizeError(error) }));
      }
    } finally {
      if (ownsBackendOperation(operationId)) setPhysicsLoading(false);
      releaseBackendOperation(operationId);
    }
  };

  const changeMaterialVisibility = useCallback((index: number, visible: boolean) => {
    if (backendOperationRef.current) return;
    const model = modelRef.current;
    if (!model || modelLoading || processing || !model.materials[index]) return;
    const hidden = new Set(hiddenMaterialIndicesRef.current);
    if (visible) {
      if (!hidden.delete(index)) return;
    } else {
      if (hidden.has(index) || model.materials.length - hidden.size <= 1) return;
      hidden.add(index);
    }
    model.setMaterialVisible(index, visible);
    lastPickedMaterialIndexRef.current = null;
    const next = [...hidden].sort((left, right) => left - right);
    hiddenMaterialIndicesRef.current = next;
    setHiddenMaterialIndices(next);
    invalidateProjection("material-visibility");
    setPartsRevision((value) => value + 1);
    setPreviewMode("source");
  }, [invalidateProjection, modelLoading, processing]);

  useEffect(() => {
    const probeWindow = window as Window & {
      __MELY_E2E_MATERIAL_SELECTION_PROBE__?: boolean;
    };
    if (!probeWindow.__MELY_E2E_MATERIAL_SELECTION_PROBE__ || !mmdModel) return;
    const selectedHidden = selectedMaterialIndex !== null
      && hiddenMaterialIndices.includes(selectedMaterialIndex);
    probeWindow.dispatchEvent(new CustomEvent("mely:material-selection-state", {
      detail: {
        backend: mmdModel.rendererMode,
        modelId: mmdModel.id,
        selectedMaterialIndex,
        pickedMaterialIndex: lastPickedMaterialIndexRef.current,
        hiddenMaterialIndices: [...hiddenMaterialIndices],
        outlineTargetCount: selectedMaterialIndex !== null
          && previewMode === "source"
          && !selectedHidden
          ? 1
          : 0,
      },
    }));
    lastPickedMaterialIndexRef.current = null;
  }, [
    hiddenMaterialIndices,
    materialSelectionRequestId,
    materialSelectionProbeRevision,
    mmdModel,
    previewMode,
    selectedMaterialIndex,
  ]);

  const changeMaterialSelection = useCallback((index: number | null) => {
    if (index === null) {
      lastPickedMaterialIndexRef.current = null;
      setSelectedMaterialIndex(null);
      materialSelectionProbeRevisionRef.current += 1;
      setMaterialSelectionProbeRevision(materialSelectionProbeRevisionRef.current);
      return;
    }
    const model = modelRef.current;
    if (
      !model
      || !Number.isInteger(index)
      || model.materials[index]?.index !== index
    ) return;
    lastPickedMaterialIndexRef.current = null;
    setSelectedMaterialIndex(index);
    materialSelectionProbeRevisionRef.current += 1;
    setMaterialSelectionProbeRevision(materialSelectionProbeRevisionRef.current);
  }, []);

  const handleRendererMaterialSelection = useCallback((
    selection: RendererMaterialSelection | null,
    sourceModelId: string,
  ) => {
    const model = modelRef.current;
    if (
      !model
      || sourceModelId !== model.id
      || previewMode !== "source"
      || backendOperationRef.current
      || modelLoading
      || processing
      || exporting
      || physicsLoading
    ) return;
    if (selection === null) {
      lastPickedMaterialIndexRef.current = null;
      setSelectedMaterialIndex(null);
      materialSelectionProbeRevisionRef.current += 1;
      setMaterialSelectionProbeRevision(materialSelectionProbeRevisionRef.current);
      return;
    }
    if (
      selection.modelId !== model.id
      || !Number.isInteger(selection.materialIndex)
      || model.materials[selection.materialIndex]?.index !== selection.materialIndex
    ) return;

    lastPickedMaterialIndexRef.current = selection.materialIndex;
    setSelectedMaterialIndex(selection.materialIndex);
    setSidebarOpen(true);
    materialSelectionProbeRevisionRef.current += 1;
    setMaterialSelectionProbeRevision(materialSelectionProbeRevisionRef.current);
    // 只有视口点击递增定位请求；跨渲染器恢复不会抢占侧栏焦点。
    setMaterialSelectionRequestId((current) => current + 1);
  }, [exporting, modelLoading, physicsLoading, previewMode, processing]);

  const openClearResources = () => {
    setClearResourceSelection(emptyClearResourceSelection());
    setClearResourcesOpen(true);
  };

  const closeClearResources = () => {
    setClearResourcesOpen(false);
    setClearResourceSelection(emptyClearResourceSelection());
  };

  const toggleClearResource = (kind: ClearResourceKind, checked: boolean) => {
    setClearResourceSelection((current) => {
      if (kind === "model") {
        return checked
          ? { model: true, dance: true, expression: true }
          : { ...current, model: false };
      }
      if (current.model) return current;
      return { ...current, [kind]: checked };
    });
  };

  const confirmClearResources = async () => {
    const selection = clearResourceSelection;
    if (!selection.model && !selection.dance && !selection.expression) return;
    closeClearResources();
    if (selection.model) {
      await clearCurrentModel();
      return;
    }

    if (backendOperationRef.current) return;
    const operationId = acquireBackendOperation();
    if (!operationId) return;
    try {
      const model = modelRef.current;
      if (!model) return;
      const kinds = MOTION_TRACK_KINDS.filter((kind) => selection[kind] && motionRuntime[kind].info);
      if (!kinds.length) return;
      stopAllMotionPlayback();
      if (kinds.length === MOTION_TRACK_KINDS.length) model.clearMotion();
      else model.clearMotion(kinds[0]);
      kinds.forEach(resetMotionTrack);
      model.updatePose(currentMotionTimes());
      setPoseEditing(false);
      setPoseState(model.poseState());
      invalidateProjection("resource-clear");
      setPoseRevision((value) => value + 1);
      setPreviewMode("source");
      setToast(t("toast.resourcesCleared"));
    } finally {
      releaseBackendOperation(operationId);
    }
  };

  const setMotionPlayingState = (kind: MmdMotionTrackKind, playing: boolean) => {
    if (backendOperationRef.current) return;
    const model = modelRef.current;
    const motion = motionTracks[kind];
    const runtime = motionRuntime[kind];
    if (!motion || !model) return;
    if (playing && !canToggleMotionPlayback(true, lockedMotionFrames[kind])) return;
    const hadPendingScrubCommit = motionScrubCommitTimerRef.current !== null;
    if (motionScrubCommitTimerRef.current !== null) {
      window.clearTimeout(motionScrubCommitTimerRef.current);
      motionScrubCommitTimerRef.current = null;
    }
    if (playing) {
      if (hadPendingScrubCommit && model.physicsEnabled()) {
        model.updatePose(currentMotionTimes());
      }
      runtime.pendingSeconds = null;
      setLockedMotionFrames((current) => ({ ...current, [kind]: null }));
      if (result || previewMode !== "source") invalidatePoseProjection();
      setPoseEditing(false);
      runtime.clock = {
        startedAt: performance.now(),
        startSeconds: runtime.seconds,
        lastUiFrame: Math.round(runtime.seconds * motion.frameRate),
      };
      lastLivePhysicsFrameRef.current = runtime.clock.startedAt;
    } else {
      lastLivePhysicsFrameRef.current = null;
      runtime.playing = false;
      runtime.pendingSeconds = null;
      runtime.timeStore.set(runtime.seconds);
    }
    runtime.playing = playing;
    runtime.playbackStore.set(playing);
    setPreviewMode("source");
  };

  const setMotionFrame = (kind: MmdMotionTrackKind, frame: number) => {
    if (backendOperationRef.current) return;
    if (!Number.isFinite(frame)) return;
    const model = modelRef.current;
    const motion = motionTracks[kind];
    const runtime = motionRuntime[kind];
    if (!model || !motion) return;
    const clampedFrame = normalizeMotionFrame(frame, motion.maxFrame);
    const currentFrame = runtime.seconds * motion.frameRate;
    if (Math.abs(clampedFrame - currentFrame) <= 1e-6) return;
    const wasPlaying = runtime.playing;
    runtime.playing = false;
    if (wasPlaying) runtime.playbackStore.set(false);
    if (lockedMotionFrames[kind] !== null) {
      setLockedMotionFrames((current) => ({ ...current, [kind]: null }));
    }
    const seconds = clampedFrame / motion.frameRate;
    runtime.pendingSeconds = seconds;
    runtime.seconds = seconds;
    if (result || model.physicsEnabled()) scheduleMotionScrubCommit();
    if (previewMode !== "source") setPreviewMode("source");
  };

  const stepMotionFrame = (kind: MmdMotionTrackKind, direction: -1 | 1) => {
    const motion = motionTracks[kind];
    if (!motion || lockedMotionFrames[kind] !== null) return;
    setMotionFrame(kind, getAdjacentMotionFrame(
      motionRuntime[kind].seconds * motion.frameRate,
      motion.maxFrame,
      direction,
    ));
  };

  const generateCurrentPose = () => {
    if (backendOperationRef.current || exporting) return;
    if (!areMotionTracksReadyForGeneration(MOTION_TRACK_KINDS.map((kind) => ({
      loaded: Boolean(motionTracks[kind]),
      lockedFrame: lockedMotionFrames[kind],
    })))) {
      setToast(t("toast.motionLockRequired"));
      return;
    }
    setPoseEditing(false);
    setPreviewMode("source");
    void generate(generationMode, options, solidOptions);
  };

  const closeGenerationResourceRisk = () => {
    setPendingGenerationResourceRisk(null);
    setGenerationResourceRiskAcknowledged(false);
  };

  const confirmGenerationResourceRisk = () => {
    if (backendOperationRef.current) return;
    const pending = pendingGenerationResourceRisk;
    const model = modelRef.current;
    if (!pending || !generationResourceRiskAcknowledged || !model) return;
    const currentConfiguration: GenerationResourceRiskConfiguration = {
      mode: generationMode,
      modelId: model.id,
      poseRevision,
      partsRevision,
      javaVersionId,
      heightMode,
      targetDimensionMinY,
      targetDimensionHeight,
      placementBottomY,
      hologramOptions: { ...options },
      solidOptions: { ...solidOptions },
    };
    if (generationResourceRiskFingerprint(currentConfiguration) !== pending.fingerprint) {
      closeGenerationResourceRisk();
      setToast(t("generationResourceRisk.stale"));
      return;
    }
    closeGenerationResourceRisk();
    void generate(
      pending.configuration.mode,
      pending.configuration.hologramOptions,
      pending.configuration.solidOptions,
      pending.fingerprint,
      pending.nativeThreadExecutionSnapshot,
    );
  };

  const closeThreadResourceRisk = () => {
    setPendingThreadResourceRisk(null);
  };

  const continueWithSelectedThreads = () => {
    if (backendOperationRef.current) return;
    const pending = pendingThreadResourceRisk;
    if (!pending) return;
    const executionSnapshot = continueSelectedNativeThreadExecution(pending.assessment);
    if (!executionSnapshot || !nativeSolidVoxelJobAvailable) {
      closeThreadResourceRisk();
      setToast(t("threadResourceRisk.stale"));
      return;
    }
    closeThreadResourceRisk();
    void generate(
      pending.mode,
      pending.hologramOptions,
      pending.solidOptions,
      pending.acceptedResourceRiskFingerprint,
      executionSnapshot,
    );
  };

  const continueWithRecommendedThreads = () => {
    if (backendOperationRef.current) return;
    const pending = pendingThreadResourceRisk;
    if (!pending) return;
    const executionSnapshot = useRecommendedNativeThreadExecution(pending.assessment);
    if (!executionSnapshot || !nativeSolidVoxelJobAvailable) {
      closeThreadResourceRisk();
      setToast(t("threadResourceRisk.stale"));
      return;
    }
    closeThreadResourceRisk();
    void generate(
      pending.mode,
      pending.hologramOptions,
      pending.solidOptions,
      pending.acceptedResourceRiskFingerprint,
      executionSnapshot,
    );
  };

  const changeWorkerThreads = (threads: number) => {
    setPerformancePreferences(createManualPerformancePreferences(threads));
  };

  const restoreAutomaticWorkerThreads = () => {
    setPerformancePreferences(createAutoPerformancePreferences());
  };

  const pendingRecommendedWorkerThreads = pendingThreadResourceRisk?.assessment.executionSnapshot
    ? Math.min(
        pendingThreadResourceRisk.assessment.executionSnapshot.workerThreads,
        pendingThreadResourceRisk.assessment.executionSnapshot.recommendedThreads,
        pendingThreadResourceRisk.assessment.executionSnapshot.memorySuggestedThreads
          ?? pendingThreadResourceRisk.assessment.executionSnapshot.maximumThreads,
      )
    : 1;

  const toggleMotionLock = (kind: MmdMotionTrackKind) => {
    if (backendOperationRef.current) return;
    const model = modelRef.current;
    const motion = motionTracks[kind];
    const runtime = motionRuntime[kind];
    if (!model || !motion) return;
    if (lockedMotionFrames[kind] !== null) {
      setLockedMotionFrames((current) => ({ ...current, [kind]: null }));
      invalidatePoseProjection();
      setToast(t("toast.motionUnlocked"));
      return;
    }

    runtime.playing = false;
    runtime.playbackStore.set(false);
    if (motionScrubCommitTimerRef.current !== null) {
      window.clearTimeout(motionScrubCommitTimerRef.current);
      motionScrubCommitTimerRef.current = null;
    }
    const exactFrame = Math.max(0, Math.min(
      motion.maxFrame,
      runtime.seconds * motion.frameRate,
    ));
    const seconds = exactFrame / motion.frameRate;
    runtime.pendingSeconds = null;
    runtime.seconds = seconds;
    model.updatePose(currentMotionTimes());
    publishMotionSeconds(kind, seconds);
    setLockedMotionFrames((current) => ({ ...current, [kind]: exactFrame }));
    invalidateProjection("motion-lock");
    setPoseRevision((value) => value + 1);
    setPreviewMode("source");
    setToast(t("toast.motionLocked", {
      track: t(kind === "dance" ? "sidebar.motion.danceTrack" : "sidebar.motion.expressionTrack"),
      frame: `${kind === "dance" ? "D" : "E"}${formatMotionFrame(exactFrame)}`,
    }));
  };

  const changePreviewMode = (mode: PreviewMode) => {
    if (mode === "source") {
      if (mmdModel) setPreviewMode("source");
      return;
    }
    if (!result) {
      setToast(t("toast.projectionRequired"));
      return;
    }
    setPoseEditing(false);
    setPreviewMode("hologram");
  };

  const commitPoseMutation = useCallback(() => {
    if (backendOperationRef.current) return;
    const model = modelRef.current;
    if (!model) return;
    invalidatePoseProjection();
    setPoseState(model.poseState());
    setPoseRevision((value) => value + 1);
    setPreviewMode("source");
  }, [invalidatePoseProjection]);

  const setPoseEditingState = (editing: boolean) => {
    if (backendOperationRef.current) return;
    if (editing === poseEditing) return;
    const model = modelRef.current;
    if (!model) return;
    if (editing) {
      stopAllMotionPlayback();
      if (MOTION_TRACK_KINDS.some((kind) => motionTracks[kind])) {
        model.updatePose(currentMotionTimes());
      }
      setSelectedBoneIndex((current) => current ?? chooseDefaultBone(model.bones));
      setPreviewMode("source");
    }
    setPoseEditing(editing);
    setPoseRevision((value) => value + 1);
  };

  const selectBone = (index: number | null) => {
    if (backendOperationRef.current) return;
    setSelectedBoneIndex(index);
    if (index !== null && !poseEditing) {
      setPoseEditingState(true);
    }
  };

  const nudgeSelectedBone = (axis: "x" | "y" | "z", direction: -1 | 1) => {
    if (backendOperationRef.current) return;
    const model = modelRef.current;
    if (!model || selectedBoneIndex === null) return;
    const bone = model.bones[selectedBoneIndex];
    if (!bone) return;
    const amount = bone.controlMode === "translate"
      ? model.translationStep * direction
      : MathUtils.degToRad(5) * direction;
    if (model.nudgeBone(selectedBoneIndex, axis, amount)) commitPoseMutation();
  };

  const resetSelectedBone = () => {
    if (backendOperationRef.current) return;
    const model = modelRef.current;
    if (!model || selectedBoneIndex === null || !model.resetBone(selectedBoneIndex)) return;
    commitPoseMutation();
    setToast(t("toast.boneReset"));
  };

  const undoPose = useCallback(() => {
    if (backendOperationRef.current) return;
    const model = modelRef.current;
    if (!model?.undoPose()) return;
    commitPoseMutation();
  }, [commitPoseMutation]);

  const redoPose = useCallback(() => {
    if (backendOperationRef.current) return;
    const model = modelRef.current;
    if (!model?.redoPose()) return;
    commitPoseMutation();
  }, [commitPoseMutation]);

  const resetPoseEdits = () => {
    if (backendOperationRef.current) return;
    const model = modelRef.current;
    if (!model?.resetPoseEdits()) return;
    commitPoseMutation();
    setToast(t("toast.poseReset"));
  };

  const currentMotionFrameSuffix = () => MOTION_TRACK_KINDS
    .flatMap((kind) => {
      const motion = motionTracks[kind];
      if (!motion) return [];
      const frame = lockedMotionFramesRef.current[kind]
        ?? motionRuntime[kind].seconds * motion.frameRate;
      return [`_${kind === "dance" ? "D" : "E"}${formatMotionFrame(frame)}`];
    })
    .join("");

  const exportCurrentPose = async () => {
    if (backendOperationRef.current) return;
    const model = modelRef.current;
    if (!model) {
      setToast(t("toast.modelRequired"));
      return;
    }
    const operationId = acquireBackendOperation();
    if (!operationId) return;
    try {
      if (MOTION_TRACK_KINDS.some((kind) => motionRuntime[kind].playing)) {
        stopAllMotionPlayback();
        model.updatePose(currentMotionTimes());
        setPoseRevision((value) => value + 1);
      }
      const { stringifyMelyPose } = await import("./core/melyPose");
      const pose = model.exportMelyPose();
      const frameSuffix = currentMotionFrameSuffix();
      const saved = await saveBinaryFile(
        new TextEncoder().encode(stringifyMelyPose(pose)),
        `MELY_${safeFileStem(model.stats.name)}${frameSuffix}.pose.json`,
        "application/json;charset=utf-8",
        t("sidebar.pose.exportJson"),
        "json",
      );
      if (!saved) return;
      setToast(t("toast.poseExported", {
        bones: number(pose.bones.length),
        morphs: number(pose.morphs?.length ?? 0),
      }));
    } catch (error) {
      setToast(t("toast.poseExportFailed", { reason: localizeError(error) }));
    } finally {
      releaseBackendOperation(operationId);
    }
  };

  const importExternalPose = async (file: File) => {
    if (backendOperationRef.current) return;
    const model = modelRef.current;
    if (!model) {
      setToast(t("toast.modelRequired"));
      return;
    }
    const operationId = acquireBackendOperation();
    if (!operationId) return;
    try {
      const { parseMelyPoseJson } = await import("./core/melyPose");
      const document = parseMelyPoseJson(await file.text());

      model.clearMotion();
      resetMotionTracks();

      const applied = model.importMelyPose(document);
      setPoseEditing(false);
      setPoseState(model.poseState());
      setSelectedBoneIndex((current) => current ?? chooseDefaultBone(model.bones));
      invalidatePoseProjection();
      setPoseRevision((value) => value + 1);
      setPreviewMode("source");

      const missingNames = [
        ...applied.missingBoneNames,
        ...applied.missingMorphNames,
      ];
      if (missingNames.length) {
        const visibleNames = missingNames.slice(0, 5).join(", ");
        const remaining = Math.max(0, missingNames.length - 5);
        setToast(t("toast.poseImportedWithMissing", {
          bones: number(applied.appliedBoneCount),
          morphs: number(applied.appliedMorphCount),
          missing: number(missingNames.length),
          names: remaining ? `${visibleNames} +${number(remaining)}` : visibleNames,
        }));
      } else {
        setToast(t("toast.poseImported", {
          bones: number(applied.appliedBoneCount),
          morphs: number(applied.appliedMorphCount),
        }));
      }
    } catch (error) {
      setToast(t("toast.poseImportFailed", { reason: localizeError(error) }));
    } finally {
      releaseBackendOperation(operationId);
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape"
        || event.repeat
        || event.defaultPrevented
        || selectedMaterialIndex === null
        || shouldIgnoreMotionShortcut(event.target)
      ) return;
      event.preventDefault();
      changeMaterialSelection(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [changeMaterialSelection, selectedMaterialIndex]);

  useEffect(() => {
    if (!poseEditing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (shouldIgnoreMotionShortcut(event.target)) return;
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") return;
      event.preventDefault();
      if (event.shiftKey) redoPose();
      else undoPose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [poseEditing, redoPose, undoPose]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const targetKind = motionTracks.dance ? "dance" : motionTracks.expression ? "expression" : null;
      if (
        event.code !== "Space"
        || event.repeat
        || event.ctrlKey
        || event.metaKey
        || event.altKey
        || shouldIgnoreMotionShortcut(event.target)
        || !targetKind
        || !canToggleMotionPlayback(true, lockedMotionFrames[targetKind])
      ) return;
      event.preventDefault();
      setMotionPlayingState(targetKind, !motionRuntime[targetKind].playing);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [lockedMotionFrames, motionRuntime, motionTracks]);

  const projectionName = useMemo(() => {
    const sourceName = mmdModel?.stats.name
      || assets.find((asset) => asset.type === "model")?.name.replace(/\.[^.]+$/, "")
      || "ELY_Hologram";
    const frameSuffix = currentMotionFrameSuffix();
    const poseSuffix = poseState.editCount ? "_POSE" : "";
    const modeSuffix = result?.kind === "solid" ? "_SOLID" : "_HOLOGRAM";
    return `MELY_${safeFileStem(sourceName)}${frameSuffix}${poseSuffix}${modeSuffix}`;
  }, [assets, lockedMotionFrames, mmdModel, motionTracks, poseRevision, poseState.editCount, result?.kind]);

  const prepareProjectionDocument = useCallback(async () => {
    if (!result) throw appError("error.litematic.emptyProjection");
    const configuration = {
      javaVersionId,
      heightMode,
      targetHeight,
      targetDimensionMinY,
      targetDimensionHeight,
      placementBottomY,
      projectionName,
    };
    const configurationKey = nativeResultConfigurationKey(configuration);
    const cached = projectionDocumentRef.current;
    if (cached?.result === result && cached.configurationKey === configurationKey) {
      return cached.document;
    }
    await yieldToBrowser();
    const documentOptions = solidProjectionDocumentOptions(configuration);
    const document = createProjectionDocumentFromResult(result, {
      ...documentOptions,
      metadata: {
        ...documentOptions.metadata,
        generationMode: result.kind === "solid" ? "solid" : "hologram",
      },
    });
    projectionDocumentRef.current = { result, document, configurationKey };
    return document;
  }, [heightMode, javaVersionId, placementBottomY, projectionName, result,
    targetDimensionHeight, targetDimensionMinY, targetHeight]);

  const documentResultId = useCallback(
    (document: ProjectionDocument) => {
      const cached = projectionDocumentRef.current;
      if (cached?.document === document && cached.contentHash) return cached.contentHash;
      const contentHash = createProjectionDocumentContentHash(document);
      if (cached?.document === document) cached.contentHash = contentHash;
      return contentHash;
    },
    [],
  );

  const heightSafetyForExport = useCallback((
    document: ProjectionDocument,
    format: ExportFormat,
    exportFingerprint?: string,
    snapshot?: PendingExport["safety"],
  ) => ({
    heightMode: snapshot?.heightMode ?? heightMode,
    targetHeight: snapshot?.targetHeight ?? targetHeight,
    datapackAcknowledged: (snapshot?.heightMode ?? heightMode) !== "default",
    placementBottomY: snapshot?.placementBottomY ?? Number(document.metadata?.placementBottomY),
    targetDimension: snapshot?.targetDimension ?? (typeof document.metadata?.targetDimensionMinY === "number"
      && typeof document.metadata?.targetDimensionMaxY === "number"
      ? {
          minY: document.metadata.targetDimensionMinY,
          height: document.metadata.targetDimensionMaxY - document.metadata.targetDimensionMinY + 1,
        }
      : undefined),
    confirmations: snapshot?.confirmations ?? extremeConfirmationsRef.current,
    configurationFingerprint: snapshot?.configurationFingerprint
      ?? extremeConfigurationFingerprint
      ?? undefined,
    exportFingerprint,
    versionId: document.minecraftVersion,
    exportFormat: format,
  }), [extremeConfigurationFingerprint, heightMode, targetHeight]);

  const extremeExportFingerprints = useCallback((
    document: ProjectionDocument,
    format: ExportFormat,
  ) => {
    if (!extremeFingerprintBase || !extremeConfigurationFingerprint) return null;
    const input: ExtremeHeightFingerprintInput = {
      ...extremeFingerprintBase,
      resultId: documentResultId(document),
      actualHeight: document.bounds?.dimensions[1] ?? 0,
      bounds: document.bounds,
      exportFormat: format,
    };
    return {
      configurationFingerprint: extremeConfigurationFingerprint,
      exportFingerprint: createExtremeExportFingerprint(input),
    };
  }, [documentResultId, extremeConfigurationFingerprint, extremeFingerprintBase]);

  const describeExportPreflight = useCallback((preflight: HeightAwareExportPreflightResult | ExportPreflightResult) => {
    if (!preflight.reason) return "";
    if (!(preflight.reason in exportPreflightReasonKeys)) {
      return t("exportCenter.unavailable.capability", { reason: preflight.reason });
    }
    const volume = preflight.volume === null
      ? "0"
      : Number.isFinite(preflight.volume)
        ? number(preflight.volume)
        : `>${number(Number.MAX_SAFE_INTEGER)}`;
    return t(exportPreflightReasonKeys[preflight.reason as ExportPreflightReason], {
      volume,
      limit: number(preflight.reason === "dimensionLimit"
        ? preflight.dimensionLimit ?? 0
        : preflight.volumeLimit ?? 0),
      dimension: number(Math.max(...(preflight.dimensions ?? [0]))),
    });
  }, [number, t]);

  const exportPreflightMessage = useCallback((preflight: HeightAwareExportPreflightResult | ExportPreflightResult) => {
    const reason = describeExportPreflight(preflight);
    return preflight.reason && preflight.reason !== "empty"
      ? `${reason} ${t("exportCenter.useBundle")}`
      : reason;
  }, [describeExportPreflight, t]);

  const updateExportPreflights = useCallback((document: ProjectionDocument) => {
    const bedrockDocument = deriveBedrockProjectionDocument(document);
    const preflights = Object.fromEntries(exportFormats.map((format) => [
      format,
      isBedrockExportFormat(format)
        ? preflightProjectionExport(bedrockDocument, format)
        : preflightProjectionHeightExport(
            document,
            format,
            heightSafetyForExport(document, format),
          ),
    ])) as Record<ExportFormat, HeightAwareExportPreflightResult | ExportPreflightResult>;
    setExportPreflights(preflights);
    return preflights;
  }, [heightSafetyForExport]);

  const openExportCenter = async () => {
    if (!result || exporting) return;
    setExporting(true);
    try {
      const document = await prepareProjectionDocument();
      updateExportPreflights(document);
      setExportCenterOpen(true);
    } catch (error) {
      setToast(t("toast.exportFailed", { reason: localizeError(error) }));
    } finally {
      setExporting(false);
    }
  };

  const performExport = useCallback(async (request: PendingExport) => {
    const bedrockFormat = isBedrockExportFormat(request.format);
    const exportDocument = bedrockFormat
      ? deriveBedrockProjectionDocument(request.document)
      : request.document;
    const exportFingerprint = bedrockFormat ? undefined : request.exportFingerprint;
    const preflight = bedrockFormat
      ? preflightProjectionExport(exportDocument, request.format)
      : preflightProjectionHeightExport(
          request.document,
          request.format,
          heightSafetyForExport(request.document, request.format, exportFingerprint, request.safety),
        );
    setExportPreflights((current) => ({ ...current, [request.format]: preflight }));
    if (!preflight.allowed) {
      setExporting(false);
      setToast(exportPreflightMessage(preflight));
      setPendingExport(null);
      setExtendedExportAcknowledged(false);
      return;
    }
    // 资源阈值不拒绝导出，但必须由绑定当前投影与选项的确认重入。
    if (request.resourceRisk && !request.resourceRiskAccepted) {
      setExporting(false);
      setToast(t("exportResourceRisk.confirmationRequired"));
      return;
    }
    setExporting(true);
    setExportCurrentFile("");
    setExportCenterOpen(false);
    let nativeWriteOperationId: string | null = null;
    try {
      await yieldToBrowser();
      if (request.format === "bundle") {
        const [{ createExportBundleStream }, desktop] = await Promise.all([
          import("./core/exportBundle"),
          import("./platform/desktop"),
        ]);
        const bundleOptions = {
          name: request.name,
          guideLocale: locale,
          partSize: [32, 32, 32] as [number, number, number],
          includeSchematic: request.bundleFormats?.includeSchematic ?? false,
          includeMcstructure: request.bundleFormats?.includeMcstructure ?? false,
          includeMcfunction: request.bundleFormats?.includeMcfunction ?? false,
          litematic: {
            author: "MELY",
            description: t("export.description.unified", { version: request.document.minecraftVersion }),
          },
          schematic: {
            author: "MELY",
            description: t("export.description.unified", { version: request.document.minecraftVersion }),
          },
          mcfunction: {
            packName: request.name,
            description: t("export.description.bedrockPack"),
          },
          safety: heightSafetyForExport(
            request.document,
            request.format,
            exportFingerprint,
            request.safety,
          ),
          onProgress: (event: import("./core/exportBundle").ExportBundleProgress) => {
            setProgress(event.progress);
            setStageKey(exportBundleStageKeys[event.phase]);
            if (event.phase === "complete") setExportCurrentFile("");
            else if (event.currentFile) setExportCurrentFile(event.currentFile);
            window.dispatchEvent(new CustomEvent("mely:export-progress", { detail: event }));
          },
        };
        let byteLength = 0;
        if (desktop.isDesktopRuntime()) {
          const writer = await desktop.openDesktopChunkWriterWithDialog({
            defaultPath: `${request.name}.zip`,
            filters: [{
              name: t("export.format.bundle"),
              extensions: ["zip"],
            }],
          });
          if (!writer) return;
          try {
            const streamed = await createExportBundleStream(
              request.document,
              (chunk) => writer.write(chunk),
              bundleOptions,
            );
            byteLength = streamed.summary.byteLength;
            await writer.close();
          } catch (error) {
            await writer.abort();
            throw error;
          }
        } else {
          const chunks: Uint8Array[] = [];
          const bundle = await createExportBundleStream(
            request.document,
            (chunk) => {
              chunks.push(chunk);
            },
            bundleOptions,
          );
          byteLength = bundle.summary.byteLength;
          downloadBinaryChunks(chunks, `${request.name}.zip`, "application/zip");
        }
        setToast(t("toast.exportFormatComplete", {
          format: t("export.format.bundle"),
          size: (byteLength / 1024).toFixed(1),
        }));
        return;
      }
      if (request.format === "mcfunction") {
        const [{ createMcfunctionBehaviorPackZipStream }, desktop] = await Promise.all([
          import("./core/mcfunction"),
          import("./platform/desktop"),
        ]);
        const behaviorPackOptions = {
          namespace: safeFileStem(request.name).toLowerCase(),
          packName: request.name,
          description: t("export.description.bedrockPack"),
        };
        let byteLength = 0;
        if (desktop.isDesktopRuntime()) {
          const writer = await desktop.openDesktopChunkWriterWithDialog({
            defaultPath: `${request.name}.zip`,
            filters: [{
              name: t("export.format.mcfunction"),
              extensions: ["zip"],
            }],
          });
          if (!writer) return;
          try {
            const streamed = await createMcfunctionBehaviorPackZipStream(
              exportDocument,
              (chunk) => writer.write(chunk),
              behaviorPackOptions,
            );
            byteLength = streamed.archive.bytesWritten;
            await writer.close();
          } catch (error) {
            await writer.abort();
            throw error;
          }
        } else {
          const chunks: Uint8Array[] = [];
          const streamed = await createMcfunctionBehaviorPackZipStream(
            exportDocument,
            (chunk) => {
              chunks.push(chunk);
            },
            behaviorPackOptions,
          );
          byteLength = streamed.archive.bytesWritten;
          downloadBinaryChunks(chunks, `${request.name}.zip`, "application/zip");
        }
        setToast(t("toast.exportFormatComplete", {
          format: t("export.format.mcfunction"),
          size: (byteLength / 1024).toFixed(1),
        }));
        return;
      }
      if (request.format === "litematic") {
        const desktop = await import("./platform/desktop");
        const litematicOptions = {
          name: request.name,
          author: "MELY",
          description: t("export.description.unified", { version: request.document.minecraftVersion }),
          regionMaxSize: 32,
          safety: heightSafetyForExport(
            request.document,
            request.format,
            exportFingerprint,
            request.safety,
          ),
        };
        let byteLength = 0;
        const nativeOwnership = nativeResultOwnershipRef.current;
        const cachedDocument = projectionDocumentRef.current;
        if (
          desktop.isDesktopRuntime()
          && nativeOwnership
          && cachedDocument?.result === nativeOwnership.materialized.result
          && cachedDocument.document === request.document
        ) {
          nativeWriteOperationId = acquireBackendOperation();
          if (!nativeWriteOperationId) return;
          const outputPath = await desktop.selectDesktopSavePath({
            defaultPath: `${request.name}.litematic`,
            filters: [{
              name: t("export.format.litematic"),
              extensions: ["litematic"],
            }],
          });
          if (!outputPath) return;
          if (
            nativeResultOwnershipRef.current !== nativeOwnership
            || projectionDocumentRef.current?.document !== request.document
          ) return;
          const compatibility = requireJavaCompatibilityProfile(request.document.minecraftVersion);
          const descriptor = compatibility.serializerProfile.exporters.litematic;
          if (!descriptor || descriptor.subVersion === null || !request.safety.targetDimension) {
            throw new RangeError("Native Litematic export requires a complete Java serializer contract");
          }
          setExportCurrentFile(outputPath);
          const summary = await nativeOwnership.client.writeLitematic({
            handle: nativeOwnership.handle,
            outputPath,
            overwriteExisting: true,
            name: request.name,
            author: "MELY",
            description: t("export.description.unified", {
              version: request.document.minecraftVersion,
            }),
            regionMaxSize: 32,
            safety: {
              heightMode: request.safety.heightMode,
              targetHeight: request.safety.targetHeight,
              targetDimension: request.safety.targetDimension,
              placementBottomY: request.safety.placementBottomY,
              targetMinecraftVersion: request.document.minecraftVersion,
              serializerMinecraftVersion: compatibility.serializerProfile.id,
              dataVersion: compatibility.serializerProfile.dataVersion,
              formatVersion: descriptor.formatVersion,
              subVersion: descriptor.subVersion,
            },
          });
          byteLength = summary.byteLength;
        } else {
          const { streamLitematicFromDocument } = await import("./core/litematic");
          if (desktop.isDesktopRuntime()) {
            const writer = await desktop.openDesktopChunkWriterWithDialog({
              defaultPath: `${request.name}.litematic`,
              filters: [{
                name: t("export.format.litematic"),
                extensions: ["litematic"],
              }],
            });
            if (!writer) return;
            try {
              const summary = await streamLitematicFromDocument(
                request.document,
                (chunk) => writer.write(chunk),
                litematicOptions,
              );
              byteLength = summary.byteLength;
              await writer.close();
            } catch (error) {
              await writer.abort();
              throw error;
            }
          } else {
            const chunks: Uint8Array[] = [];
            const summary = await streamLitematicFromDocument(
              request.document,
              (chunk) => { chunks.push(chunk); },
              litematicOptions,
            );
            byteLength = summary.byteLength;
            downloadBinaryChunks(chunks, `${request.name}.litematic`, "application/gzip");
          }
        }
        setToast(t("toast.exportFormatComplete", {
          format: t("export.format.litematic"),
          size: (byteLength / 1024).toFixed(1),
        }));
        return;
      }
      let bytes: Uint8Array;
      let extension: string;
      let mime = "application/octet-stream";
      if (request.format === "schematic") {
        const { createSchematic } = await import("./core/schematic");
        bytes = createSchematic(request.document, {
          name: request.name,
          author: "MELY",
          description: t("export.description.unified", { version: request.document.minecraftVersion }),
          safety: heightSafetyForExport(
            request.document,
            request.format,
            exportFingerprint,
            request.safety,
          ),
        }).bytes;
        extension = "schem";
        mime = "application/gzip";
      } else if (request.format === "mcstructure") {
        const { createMcstructure } = await import("./core/mcstructure");
        bytes = createMcstructure(exportDocument).bytes;
        extension = "mcstructure";
      } else {
        throw new RangeError(`Unsupported export format: ${request.format}`);
      }
      const saved = await saveBinaryFile(
        bytes,
        `${request.name}.${extension}`,
        mime,
        t(`export.format.${request.format}` as TranslationKey),
        extension,
      );
      if (!saved) return;
      setToast(t("toast.exportFormatComplete", {
        format: t(`export.format.${request.format}` as TranslationKey),
        size: (bytes.byteLength / 1024).toFixed(1),
      }));
    } catch (error) {
      setToast(t("toast.exportFailed", { reason: localizeError(error) }));
    } finally {
      if (nativeWriteOperationId) releaseBackendOperation(nativeWriteOperationId);
      setExporting(false);
      setExportCurrentFile("");
      setPendingExport(null);
      setExtendedExportAcknowledged(false);
      setExtremeExportPhraseInput("");
      replaceExtremeConfirmations((current) => clearExtremeExportConfirmation(current));
      if (!survivalToolsOpen) projectionDocumentRef.current = null;
    }
  }, [acquireBackendOperation, exportPreflightMessage, heightSafetyForExport, locale,
    localizeError, releaseBackendOperation, survivalToolsOpen, t]);

  const requestExport = async (format: ExportFormat) => {
    if (!result || exporting) return;
    setExporting(true);
    try {
      const document = await prepareProjectionDocument();
      const fingerprints = isBedrockExportFormat(format)
        ? null
        : extremeExportFingerprints(document, format);
      const preflight = isBedrockExportFormat(format)
        ? preflightProjectionExport(deriveBedrockProjectionDocument(document), format)
        : preflightProjectionHeightExport(
            document,
            format,
            heightSafetyForExport(document, format, fingerprints?.exportFingerprint),
          );
      setExportPreflights((current) => ({ ...current, [format]: preflight }));
      const requestHeightRisk = evaluateProjectionHeightRisk(
        targetHeight,
        document.bounds,
        selectedDefaultHeight,
      );
      const confirmationHeight = "confirmationHeight" in preflight
        ? preflight.confirmationHeight
        : requestHeightRisk.requiredHeight;
      // Bedrock 格式没有 Java 4064 三阶段指纹；其资源风险只走普通二次确认。
      const experimental = !isBedrockExportFormat(format)
        && confirmationHeight > EXTENDED_WORLD_HEIGHT;
      const needsExtremeEnvironmentConfirmation = !isBedrockExportFormat(format)
        && experimental
        && preflight.reason === "HEIGHT_EXTREME_CONFIRMATION_REQUIRED"
        && !hasExtremeEnvironmentConfirmation(
          extremeConfirmationsRef.current,
          fingerprints?.configurationFingerprint,
        );
      if (needsExtremeEnvironmentConfirmation) {
        setExporting(false);
        setExportCenterOpen(false);
        setExtremeEnvironmentChecks({ datapack: false, backup: false, toolchain: false });
        setExtremeDialogOrigin("reconfirm");
        setExtremeDialogStage("unlock");
        return;
      }
      const needsExtremeExportConfirmation = !isBedrockExportFormat(format)
        && experimental
        && preflight.reason === "HEIGHT_EXTREME_CONFIRMATION_REQUIRED"
        && fingerprints;
      if (!preflight.allowed && !needsExtremeExportConfirmation) {
        setExporting(false);
        setToast(exportPreflightMessage(preflight));
        return;
      }
      const resourceRiskReasons: NonNullable<PendingExport["resourceRisk"]>["reasons"] = [];
      if (preflight.requiresConfirmation) resourceRiskReasons.push("denseVolume");
      let bundleResourceEstimate: ExportBundleResourceEstimate | undefined;
      let webRetentionWarningBytes = 0;
      if (format === "bundle") {
        const {
          DEFAULT_WEB_BUNDLE_OUTPUT_BUDGET_BYTES,
          estimateExportBundleResources,
        } = await import("./core/exportBundle");
        bundleResourceEstimate = estimateExportBundleResources(document, {
          partSize: [32, 32, 32],
          includeSchematic: bundleFormats.includeSchematic,
          includeMcstructure: bundleFormats.includeMcstructure,
          includeMcfunction: bundleFormats.includeMcfunction,
        });
        if (bundleResourceEstimate.requiresConfirmation) resourceRiskReasons.push("workingSet");
        const desktop = await import("./platform/desktop");
        if (!desktop.isDesktopRuntime()) {
          webRetentionWarningBytes = estimateWebExportRetentionBytes(document, format);
          if (webRetentionWarningBytes > DEFAULT_WEB_BUNDLE_OUTPUT_BUDGET_BYTES) {
            resourceRiskReasons.push("webRetention");
          }
        }
      } else if (format === "mcfunction") {
        const [{ DEFAULT_WEB_BUNDLE_OUTPUT_BUDGET_BYTES }, desktop] = await Promise.all([
          import("./core/exportBundle"),
          import("./platform/desktop"),
        ]);
        if (!desktop.isDesktopRuntime()) {
          webRetentionWarningBytes = estimateWebExportRetentionBytes(document, format);
          if (webRetentionWarningBytes > DEFAULT_WEB_BUNDLE_OUTPUT_BUDGET_BYTES) {
            resourceRiskReasons.push("webRetention");
          }
        }
      }
      const resultId = documentResultId(document);
      const pendingBundleFormats = format === "bundle" ? { ...bundleFormats } : undefined;
      const resourceRisk = resourceRiskReasons.length > 0 ? {
        reasons: resourceRiskReasons,
        denseVolume: preflight.requiresConfirmation ? preflight.volume : null,
        denseVolumeLimit: preflight.requiresConfirmation ? preflight.volumeLimit : null,
        ...(bundleResourceEstimate ? { bundle: bundleResourceEstimate } : {}),
        estimatedWebRetentionBytes: webRetentionWarningBytes,
      } : null;
      const request: PendingExport = {
        format,
        document,
        name: projectionName,
        targetHeight,
        actualHeight: document.bounds?.dimensions[1] ?? 0,
        requiredHeight: "requiredHeight" in preflight
          ? preflight.requiredHeight
          : requestHeightRisk.requiredHeight,
        targetDimensionHeight: typeof document.metadata?.targetDimensionMinY === "number"
          && typeof document.metadata?.targetDimensionMaxY === "number"
          ? document.metadata.targetDimensionMaxY - document.metadata.targetDimensionMinY + 1
          : selectedDefaultHeight,
        configurationFingerprint: fingerprints?.configurationFingerprint,
        exportFingerprint: fingerprints?.exportFingerprint,
        safety: {
          heightMode,
          targetHeight,
          placementBottomY: Number(document.metadata?.placementBottomY),
          targetDimension: typeof document.metadata?.targetDimensionMinY === "number"
            && typeof document.metadata?.targetDimensionMaxY === "number"
            ? {
                minY: document.metadata.targetDimensionMinY,
                height: document.metadata.targetDimensionMaxY - document.metadata.targetDimensionMinY + 1,
              }
            : undefined,
          configurationFingerprint: fingerprints?.configurationFingerprint,
          confirmations: extremeConfirmationsRef.current,
        },
        resultId,
        experimental,
        ...(resourceRisk ? {
          resourceRisk: {
            ...resourceRisk,
            fingerprint: exportResourceRiskFingerprint(
              resultId,
              format,
              pendingBundleFormats,
              resourceRisk,
            ),
          },
        } : {}),
        ...(pendingBundleFormats ? { bundleFormats: pendingBundleFormats } : {}),
      };
      if (
        (!isBedrockExportFormat(format) && confirmationHeight > selectedDefaultHeight)
        || resourceRiskReasons.length > 0
      ) {
        setExportCenterOpen(false);
        setPendingExport(request);
        setExtendedExportAcknowledged(false);
        setExporting(false);
        return;
      }
      await performExport(request);
    } catch (error) {
      setExporting(false);
      setToast(t("toast.exportFailed", { reason: localizeError(error) }));
    }
  };

  const confirmPendingExport = () => {
    if (!pendingExport) return;
    const currentBundleConfiguration = pendingExport.format === "bundle"
      ? JSON.stringify(bundleFormats)
      : null;
    const pendingBundleConfiguration = pendingExport.bundleFormats
      ? JSON.stringify(pendingExport.bundleFormats)
      : null;
    const currentPlacementBottomY = pendingExport.safety.heightMode === "default"
      ? selectedDefaultDimension.minY
      : placementForHeightPreflight;
    const currentTargetDimension = pendingExport.safety.heightMode === "default"
      ? pendingExport.safety.targetDimension
      : declaredTargetDimension;
    const currentResourceFingerprint = pendingExport.resourceRisk
      ? exportResourceRiskFingerprint(
          pendingExport.resultId,
          pendingExport.format,
          pendingExport.bundleFormats,
          {
            reasons: pendingExport.resourceRisk.reasons,
            denseVolume: pendingExport.resourceRisk.denseVolume,
            denseVolumeLimit: pendingExport.resourceRisk.denseVolumeLimit,
            ...(pendingExport.resourceRisk.bundle
              ? { bundle: pendingExport.resourceRisk.bundle }
              : {}),
            estimatedWebRetentionBytes: pendingExport.resourceRisk.estimatedWebRetentionBytes,
          },
        )
      : null;
    if (
      !projectionDocumentRef.current
      || projectionDocumentRef.current.result !== result
      || projectionDocumentRef.current.document !== pendingExport.document
      || projectionDocumentRef.current.contentHash !== pendingExport.resultId
      || pendingExport.safety.heightMode !== heightMode
      || pendingExport.safety.targetHeight !== targetHeight
      || (!isBedrockExportFormat(pendingExport.format)
        && pendingExport.safety.configurationFingerprint !== (extremeConfigurationFingerprint ?? undefined))
      || pendingExport.safety.placementBottomY !== currentPlacementBottomY
      || pendingExport.safety.targetDimension?.minY !== currentTargetDimension?.minY
      || pendingExport.safety.targetDimension?.height !== currentTargetDimension?.height
      || currentBundleConfiguration !== pendingBundleConfiguration
      || currentResourceFingerprint !== (pendingExport.resourceRisk?.fingerprint ?? null)
    ) {
      setPendingExport(null);
      setExtendedExportAcknowledged(false);
      setExtremeExportPhraseInput("");
      setToast(t("toast.heightPreflightRejected", { reason: "HEIGHT_CONFIRMATION_STALE" }));
      return;
    }
    if (!pendingExport.experimental) {
      void performExport({ ...pendingExport, resourceRiskAccepted: true });
      return;
    }
    if (
      !pendingExport.configurationFingerprint
      || !pendingExport.exportFingerprint
    ) return;
    try {
      const confirmed = confirmExtremeExport(
        extremeConfirmationsRef.current,
        pendingExport.configurationFingerprint,
        pendingExport.exportFingerprint,
        extremeExportPhraseInput,
        pendingExport.requiredHeight,
        `${pendingExport.format}; ${pendingExport.actualHeight} layers; ${pendingExport.safety.placementBottomY}..${
          pendingExport.safety.placementBottomY + Math.max(0, pendingExport.actualHeight - 1)
        }`,
      );
      replaceExtremeConfirmations(confirmed);
      void performExport({
        ...pendingExport,
        resourceRiskAccepted: true,
        safety: { ...pendingExport.safety, confirmations: confirmed },
      });
    } catch (error) {
      setToast(localizeError(error));
    }
  };

  const openSurvivalTools = async () => {
    if (!result || exporting) return;
    setExporting(true);
    try {
      setSurvivalDocument(await prepareProjectionDocument());
      setSurvivalToolsOpen(true);
    } catch (error) {
      setToast(t("toast.guideFailed", { reason: localizeError(error) }));
    } finally {
      setExporting(false);
    }
  };

  const closeSurvivalTools = () => {
    setSurvivalToolsOpen(false);
    setSurvivalDocument(null);
    if (!pendingExport) projectionDocumentRef.current = null;
  };

  const closeExportCenter = () => {
    setExportCenterOpen(false);
    setExportPreflights({});
    if (!survivalToolsOpen && !pendingExport) projectionDocumentRef.current = null;
  };

  const stats = result?.stats ?? null;
  const hasMotion = MOTION_TRACK_KINDS.some((kind) => Boolean(motionTracks[kind]));
  // Mount as soon as the model/backend identity is committed. The viewport
  // reports its real first-frame readiness asynchronously; gating the mount on
  // that acknowledgement would deadlock the loader before onReady can fire.
  const viewportReady = viewportMounted && Boolean(
    mmdModel && mmdModel.rendererMode === renderMode && viewportBinding,
  );
  const statusText = useMemo(() => {
    if (modelLoading) return t(modelLoadStageKey);
    if (processing) return t(stageKey);
    if (poseEditing && mmdModel) {
      const selected = selectedBoneIndex === null ? null : mmdModel.bones[selectedBoneIndex];
      return selected
        ? t("app.status.pose", {
            name: selected.displayName || t("model.boneFallback", { index: selected.index + 1 }),
          })
        : t("app.status.poseEditing");
    }
    if (mmdModel) return t("app.status.modelLoaded", { name: mmdModel.stats.name });
    return t("app.status.waitingModel");
  }, [mmdModel, modelLoadStageKey, modelLoading, poseEditing, processing, selectedBoneIndex, stageKey, t]);
  const showMotionStatus = Boolean(
    !modelLoading && !processing && !poseEditing && hasMotion && mmdModel,
  );

  return (
    <main className={`app-shell ${sidebarOpen ? "" : "app-shell--sidebar-closed"}`}>
      <header className="titlebar">
        <div className="brand">
          <div className="brand-mark"><span /><span /><span /></div>
          <span className="brand-name">MELY</span>
          <span className="brand-divider" />
          <span className="brand-subtitle">{t("app.subtitle")}</span>
        </div>
        <div className="project-state">
          <span className={`status-dot ${processing || modelLoading || exporting ? "status-dot--busy" : ""}`} />
          <span>{showMotionStatus ? (
            <span className="motion-status-list">
              {MOTION_TRACK_KINDS.map((kind) => motionTracks[kind] ? (
                <span key={kind}>
                  <MotionStatusText
                    kind={kind}
                    motion={motionTracks[kind]}
                    timeSource={motionRuntime[kind].timeStore}
                    playbackSource={motionRuntime[kind].playbackStore}
                    lockedFrame={lockedMotionFrames[kind]}
                  />
                </span>
              ) : null)}
            </span>
          ) : statusText}</span>
          <span className="version-chip">{`v${APP_VERSION} · ${t("app.version")}`}</span>
        </div>
        <div className="title-actions">
          <label className="locale-control" title={t("language.selector")}>
            <Languages size={16} />
            <select
              aria-label={t("language.selector")}
              value={locale}
              onChange={(event) => setLocale(event.target.value as LocaleCode)}
            >
              {locales.map((entry) => <option key={entry} value={entry}>{t(languageLabelKeys[entry])}</option>)}
            </select>
          </label>
          <label className="renderer-control" title={t("toolbar.renderer")}>
            <select
              aria-label={t("toolbar.renderer")}
              value={renderMode}
              disabled={!mmdModel || modelLoading || processing || exporting || physicsLoading}
              onChange={(event) => void switchRenderer(event.target.value as MmdRendererMode)}
            >
              <option value="vanilla">{t("renderer.vanilla")}</option>
              <option value="moeru">{t("renderer.moeru")}</option>
              <option value="babylon">{t("renderer.babylon")}</option>
            </select>
          </label>
          <IconButton label={sidebarOpen ? t("toolbar.hideSidebar") : t("toolbar.showSidebar")} onClick={() => setSidebarOpen((value) => !value)}>
            {sidebarOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
          </IconButton>
          <IconButton
            label={nightMode ? t("toolbar.dayPreview") : t("toolbar.nightPreview")}
            active={nightMode}
            onClick={() => setNightMode((value) => !value)}
          >
            {nightMode ? <Sun size={17} /> : <Moon size={17} />}
          </IconButton>
          <IconButton
            ref={survivalToolsTriggerRef}
            label={t("toolbar.survivalGuide")}
            disabled={!result || exporting}
            onClick={() => void openSurvivalTools()}
          >
            <ListChecks size={17} />
          </IconButton>
          <IconButton label={t("toolbar.projectInfo")} onClick={() => setToast(t("app.info", { version: APP_VERSION }))}> <Info size={17} /> </IconButton>
        </div>
      </header>

      <div className="workspace">
        {sidebarOpen ? (
          <Sidebar
            options={options}
            solidOptions={solidOptions}
            generationMode={generationMode}
            previewMode={previewMode}
            stats={stats}
            modelStats={mmdModel?.stats ?? null}
            motionTracks={motionTracks}
            lockedMotionFrames={lockedMotionFrames}
            bones={mmdModel?.bones ?? []}
            materials={mmdModel?.materials ?? []}
            hiddenMaterialIndices={hiddenMaterialIndices}
            selectedMaterialIndex={selectedMaterialIndex}
            materialSelectionRequestId={materialSelectionRequestId}
            selectedBoneIndex={selectedBoneIndex}
            poseEditing={poseEditing}
            poseState={poseState}
            processing={processing}
            modelLoading={modelLoading}
            modelLoadStage={t(modelLoadStageKey)}
            exporting={exporting}
            javaVersionProfiles={JAVA_VERSION_PROFILES}
            selectedJavaVersionId={javaVersionId}
            versionCompatibilityWarning={selectedProfile?.releaseStatus === "verified"
              ? undefined
              : t("toast.javaVersionUnverified", { version: javaVersionId })}
            heightMaximum={heightMode === "experimental_4064"
              ? EXPERIMENTAL_WORLD_HEIGHT
              : heightMode === "extended_2032"
                ? EXTENDED_WORLD_HEIGHT
                : selectedDefaultHeight}
            extendedHeightUnlocked={heightMode !== "default"}
            experimentalHeightActive={heightMode === "experimental_4064"}
            experimentalHeightConfirmed={extremeEnvironmentConfirmed}
            extendedHeightActive={extendedHeightActive}
            targetDimensionMinY={targetDimensionMinY}
            targetDimensionHeight={targetDimensionHeight}
            placementBottomY={placementBottomY}
            estimatedBlockCount={estimatedBlockCount}
            resourceEstimateLabel={resourceEstimate ? formatBinaryBytes(resourceEstimate.estimatedBytes) : null}
            progress={progress}
            stage={t(stageKey)}
            progressDetail={exporting ? exportCurrentFile : ""}
            sidebarWidth={sidebarWidth}
            sidebarWidthMaximum={sidebarWidthMaximum()}
            sidebarUiScale={sidebarUiScale}
            physicsAvailable={mmdModel?.physicsAvailable ?? false}
            physicsEnabled={physicsEnabled}
            physicsLoading={physicsLoading}
            performanceCapabilities={performanceCapabilities}
            performanceMode={resolvedWorkerThreads.mode}
            configuredWorkerThreads={resolvedWorkerThreads.configuredThreads}
            activeWorkerThreads={activeWorkerThreads}
            nativeSolidVoxelJobAvailable={nativeSolidVoxelJobAvailable}
            onOptionsChange={updateOptions}
            onSolidOptionsChange={updateSolidOptions}
            onGenerationModeChange={changeGenerationMode}
            onPreviewModeChange={changePreviewMode}
            onAssetsAdded={addAssets}
            onPhysicsEnabledChange={changePhysicsEnabled}
            onMaterialVisibilityChange={changeMaterialVisibility}
            onMaterialSelectionChange={changeMaterialSelection}
            onSidebarResizeStart={beginSidebarResize}
            onSidebarResizeStep={stepSidebarWidth}
            onSidebarResizeReset={resetSidebarWidth}
            onSidebarUiScaleChange={changeSidebarUiScale}
            onPoseEditingChange={setPoseEditingState}
            onBoneSelected={selectBone}
            onPoseNudge={nudgeSelectedBone}
            onPoseUndo={undoPose}
            onPoseRedo={redoPose}
            onBoneReset={resetSelectedBone}
            onPoseReset={resetPoseEdits}
            onPoseExport={exportCurrentPose}
            onPoseImport={importExternalPose}
            onGenerate={generateCurrentPose}
            onExport={() => void openExportCenter()}
            onJavaVersionChange={changeJavaVersion}
            onExtendedHeightToggle={toggleExtendedHeight}
            onExperimentalHeightUnlock={beginExtremeHeightUnlock}
            onTargetDimensionChange={changeTargetDimension}
            onWorkerThreadsChange={changeWorkerThreads}
            onRestoreAutomaticWorkerThreads={restoreAutomaticWorkerThreads}
          />
        ) : null}

        <section className={`viewport-panel ${hasMotion ? "viewport-panel--with-motion" : ""}`}>
          <div className="viewport-stage">
            <div className="viewport-toolbar viewport-toolbar--left">
              <div className="toolbar-group">
                <IconButton
                  label={t("toolbar.sourceModel")}
                  active={previewMode === "source"}
                  disabled={!mmdModel}
                  onClick={() => changePreviewMode("source")}
                >
                  <UserRound size={17} />
                </IconButton>
                <IconButton
                  label={t("toolbar.minecraftProjection")}
                  active={previewMode === "hologram"}
                  disabled={!result}
                  onClick={() => changePreviewMode("hologram")}
                >
                  {generationMode === "solid" ? <Boxes size={17} /> : <Sparkles size={17} />}
                </IconButton>
              </div>
              <div className="toolbar-group">
                <IconButton label={t("toolbar.orbitView")} active={!poseEditing} onClick={() => setPoseEditingState(false)}><Orbit size={18} /></IconButton>
                <IconButton
                  label={t("toolbar.bonePose")}
                  active={poseEditing}
                  disabled={!mmdModel}
                  onClick={() => setPoseEditingState(!poseEditing)}
                >
                  <Rotate3D size={18} />
                </IconButton>
              </div>
              <div className="toolbar-group">
                <IconButton label={t("toolbar.showGrid")} active={showGrid} onClick={() => setShowGrid((value) => !value)}><Grid3X3 size={17} /></IconButton>
                <IconButton label={t("toolbar.showBounds")} active={showBounds} onClick={() => setShowBounds((value) => !value)}><ScanLine size={18} /></IconButton>
              </div>
            </div>

            <div className="viewport-toolbar viewport-toolbar--right">
              <div className="toolbar-group">
                <IconButton
                  ref={clearResourcesTriggerRef}
                  label={t("toolbar.clearResources")}
                  className="icon-button--destructive"
                  aria-haspopup="dialog"
                  disabled={!mmdModel || modelLoading || processing || exporting}
                  onClick={openClearResources}
                >
                  <Trash2 size={17} />
                </IconButton>
                <IconButton label={t("toolbar.resetCamera")} onClick={() => setResetToken((value) => value + 1)}><Focus size={18} /></IconButton>
                <IconButton
                  label={t("toolbar.focusFace")}
                  disabled={!mmdModel}
                  onClick={() => setFocusFaceToken((value) => value + 1)}
                >
                  <ScanFace size={18} />
                </IconButton>
                <IconButton label={t("toolbar.perspective")} active={cameraMode === "perspective"} onClick={() => setCameraMode("perspective")}><Aperture size={18} /></IconButton>
                <IconButton label={t("toolbar.orthographic")} active={cameraMode === "orthographic"} onClick={() => setCameraMode("orthographic")}><Box size={18} /></IconButton>
                <IconButton label={t("toolbar.fitViewport")} onClick={() => setResetToken((value) => value + 1)}><Maximize2 size={17} /></IconButton>
              </div>
            </div>

            {viewportReady ? <RendererViewport
              result={result}
              model={mmdModel}
              renderMode={renderMode}
              backendBusy={backendOperationBusy}
              lifecycleBinding={viewportBinding ?? undefined}
              isPlaying={MOTION_TRACK_KINDS.some((kind) => motionRuntime[kind].playing)}
              previewMode={previewMode}
              targetHeight={options.targetHeight}
              modelLoading={modelLoading}
              glow={options.glow}
              nightMode={nightMode}
              cameraMode={cameraMode}
              showGrid={showGrid}
              showBounds={showBounds}
              resetToken={resetToken}
              focusFaceToken={focusFaceToken}
              partsRevision={partsRevision}
              poseRevision={poseRevision}
              poseEditing={poseEditing}
              selectedBoneIndex={selectedBoneIndex}
              selectedMaterialIndex={selectedMaterialIndex}
              hiddenMaterialIndices={hiddenMaterialIndices}
              materialSelectionRequestId={materialSelectionRequestId}
              onBoneSelected={selectBone}
              onMaterialSelected={(selection) => {
                handleRendererMaterialSelection(selection, viewportBinding?.modelId ?? "");
              }}
              onPoseCommitted={commitPoseMutation}
              onBeforeRender={advanceMotionPreview}
              onAfterRender={publishRenderedMotionPreview}
              onReady={(binding) => {
                if (binding) acknowledgeViewportReady(binding);
              }}
              onUnmount={(binding) => {
                if (binding) acknowledgeViewportUnmount(binding);
              }}
            /> : null}

            {modelLoading || !mmdModel ? (
              <div className="viewport-loading">
                <div className="loading-symbol">{modelLoading ? <Sparkles size={24} /> : <UserRound size={24} />}</div>
                <strong>{modelLoading ? t(modelLoadStageKey) : t("viewport.importModel")}</strong>
                <span>{modelLoading ? t("viewport.loadingDetails") : t("viewport.supportedAssets")}</span>
              </div>
            ) : null}

            <div className="viewport-info">
              <div className="view-label">
                <Camera size={14} />
                <span>{poseEditing ? t("viewport.poseMode") : cameraMode === "perspective" ? t("viewport.perspective") : t("viewport.orthographic")}</span>
                {poseEditing ? (
                  <><kbd>{t("viewport.clickJoint")}</kbd><kbd>{t("viewport.dragRing")}</kbd></>
                ) : (
                  <>
                    {previewMode === "source" && mmdModel ? <kbd>{t("viewport.selectPart")}</kbd> : null}
                    <kbd>{t("viewport.rotate")}</kbd>
                    <kbd>{t("viewport.pan")}</kbd>
                    <kbd>{t("viewport.zoom")}</kbd>
                  </>
                )}
              </div>
              {previewMode === "source" && mmdModel ? (
                <div className="scene-stats scene-stats--model">
                  <span><UserRound size={14} /> {t("viewport.vertices", { count: number(mmdModel.stats.vertexCount) })}</span>
                  <span className="stat-separator" />
                  <span>{t("viewport.triangles", { count: number(mmdModel.stats.triangleCount) })}</span>
                  <span>{t("viewport.bones", { count: number(mmdModel.stats.boneCount) })}</span>
                  {MOTION_TRACK_KINDS.map((kind) => motionTracks[kind] ? (
                    <MotionTrackFrameReadout
                      key={kind}
                      kind={kind}
                      motion={motionTracks[kind]}
                      timeSource={motionRuntime[kind].timeStore}
                      lockedFrame={lockedMotionFrames[kind]}
                    />
                  ) : null)}
                  {poseState.editCount ? <span>{t("viewport.edits", { count: number(poseState.editCount) })}</span> : null}
                </div>
              ) : result?.kind === "solid" ? (
                <div className="scene-stats">
                  <span><Boxes size={14} /> {t("viewport.blocks", { count: number(result.stats.blockCount) })}</span>
                  <span className="stat-separator" />
                  <span>{t("viewport.colors", { count: number(result.stats.paletteSize) })}</span>
                  <span>{t("viewport.skinBlocks", { count: number(result.stats.skinBlockCount) })}</span>
                </div>
              ) : result ? (
                <div className="scene-stats">
                  <span><Boxes size={14} /> {t("viewport.blocks", { count: number(result.stats.blockCount) })}</span>
                  <span className="stat-separator" />
                  <span>{t("viewport.rods", { count: number(result.stats.endRodCount) })}</span>
                  <span>{t("viewport.panes", { count: number(result.stats.paneCount) })}</span>
                </div>
              ) : null}
            </div>

            <div className="axis-gizmo" aria-hidden="true">
              <span className="axis axis--y">Y</span>
              <span className="axis axis--x">X</span>
              <span className="axis axis--z">Z</span>
            </div>
          </div>

          {hasMotion ? (
            <div className="viewport-motion-stack">
              {MOTION_TRACK_KINDS.map((kind) => motionTracks[kind] ? (
                <MotionTimeline
                  key={kind}
                  kind={kind}
                  motion={motionTracks[kind]}
                  timeSource={motionRuntime[kind].timeStore}
                  playbackSource={motionRuntime[kind].playbackStore}
                  lockedFrame={lockedMotionFrames[kind]}
                  disabled={processing || modelLoading || physicsLoading || backendOperationBusy}
                  onPlayingChange={(playing) => setMotionPlayingState(kind, playing)}
                  onFrameChange={(frame) => setMotionFrame(kind, frame)}
                  onFrameStep={(direction) => stepMotionFrame(kind, direction)}
                  onLockToggle={() => toggleMotionLock(kind)}
                />
              ) : null)}
            </div>
          ) : null}
        </section>
      </div>

      {survivalToolsOpen && survivalDocument ? (
        <SurvivalTools
          projection={survivalDocument}
          labels={survivalLabels}
          onClose={closeSurvivalTools}
          restoreFocusTo={survivalToolsTriggerRef.current}
        />
      ) : null}

      <Windows
        open={clearResourcesOpen}
        title={t("clearResources.title")}
        closeLabel={t("common.close")}
        onClose={closeClearResources}
        restoreFocusTo={clearResourcesTriggerRef.current}
        actions={[
          {
            label: t("common.cancel"),
            onClick: closeClearResources,
          },
          {
            label: t("clearResources.confirm"),
            emphasis: "destructive",
            disabled: !Object.values(clearResourceSelection).some(Boolean),
            onClick: () => void confirmClearResources(),
          },
        ]}
      >
        <p>{t("clearResources.body")}</p>
        <fieldset className="clear-resource-options">
          <legend>{t("clearResources.options")}</legend>
          <label className="clear-resource-option">
            <input
              type="checkbox"
              checked={clearResourceSelection.dance}
              disabled={clearResourceSelection.model || !motionTracks.dance}
              onChange={(event) => toggleClearResource("dance", event.currentTarget.checked)}
            />
            <span>
              <strong>{t("clearResources.motion")}</strong>
              <small>{t("clearResources.motionHint")}</small>
            </span>
          </label>
          <label className="clear-resource-option">
            <input
              type="checkbox"
              checked={clearResourceSelection.expression}
              disabled={clearResourceSelection.model || !motionTracks.expression}
              onChange={(event) => toggleClearResource("expression", event.currentTarget.checked)}
            />
            <span>
              <strong>{t("clearResources.expression")}</strong>
              <small>{t("clearResources.expressionHint")}</small>
            </span>
          </label>
          <label className="clear-resource-option clear-resource-option--model">
            <input
              type="checkbox"
              checked={clearResourceSelection.model}
              disabled={!mmdModel}
              onChange={(event) => toggleClearResource("model", event.currentTarget.checked)}
            />
            <span>
              <strong>{t("clearResources.model")}</strong>
              <small>{t("clearResources.modelHint")}</small>
            </span>
          </label>
        </fieldset>
      </Windows>

      <Windows
        open={heightUnlockOpen}
        title={t("heightUnlock.title")}
        closeLabel={t("common.close")}
        danger
        onClose={() => setHeightUnlockOpen(false)}
        actions={[
          {
            label: t("common.cancel"),
            onClick: () => setHeightUnlockOpen(false),
          },
          {
            label: t("heightUnlock.confirm"),
            emphasis: "danger",
            onClick: unlockExtendedHeight,
          },
        ]}
      >
        <div className="safety-copy">
          <p>{t("heightUnlock.body", {
            vanilla: number(selectedDefaultHeight),
            maximum: number(EXTENDED_WORLD_HEIGHT),
          })}</p>
        </div>
      </Windows>

      {(() => {
        const currentExtremeFingerprint = extremeFingerprintBase
          ? createExtremeHeightConfigurationFingerprint(extremeFingerprintBase)
          : null;
        return <Windows
        open={extremeDialogStage === "unlock"}
        title={t("extremeHeight.unlockTitle")}
        closeLabel={t("common.close")}
        danger
        onClose={cancelExtremeHeightUnlock}
        actions={[
          {
            label: t("common.cancel"),
            onClick: cancelExtremeHeightUnlock,
          },
          {
            label: t("extremeHeight.continue"),
            emphasis: "danger",
            disabled: !currentExtremeFingerprint,
            onClick: confirmExtremeUnlockStage,
          },
        ]}
      >
        <div className="safety-copy">
          <p>{t("extremeHeight.unlockBody")}</p>
          <ul>
            <li>{t("extremeHeight.boundary")}</li>
            <li>{t("extremeHeight.thirdParty")}</li>
          </ul>
        </div>
      </Windows>;
      })()}

      <Windows
        open={extremeDialogStage === "environment"}
        title={t("extremeHeight.environmentTitle")}
        closeLabel={t("common.close")}
        danger
        onClose={cancelExtremeHeightUnlock}
        actions={[
          {
            label: t("common.cancel"),
            onClick: cancelExtremeHeightUnlock,
          },
          {
            label: t("extremeHeight.environmentConfirm"),
            emphasis: "danger",
            disabled: !Object.values(extremeEnvironmentChecks).every(Boolean),
            onClick: confirmExtremeEnvironmentStage,
          },
        ]}
      >
        <div className="safety-copy">
          {(["datapack", "backup", "toolchain"] as const).map((key) => (
            <label className="risk-acknowledgement" key={key}>
              <input
                type="checkbox"
                checked={extremeEnvironmentChecks[key]}
                onChange={(event) => {
                  const checked = event.currentTarget.checked;
                  setExtremeEnvironmentChecks((current) => ({ ...current, [key]: checked }));
                }}
              />
              <span>{t(`extremeHeight.environment.${key}` as TranslationKey)}</span>
            </label>
          ))}
        </div>
      </Windows>

      <Windows
        open={exportCenterOpen}
        title={t("exportCenter.title")}
        closeLabel={t("common.close")}
        onClose={closeExportCenter}
        actions={[{
          label: t("common.close"),
          onClick: closeExportCenter,
        }]}
      >
        <p>{t("exportCenter.body")}</p>
        <div className="export-format-grid">
          {exportFormats.map((format) => {
            const preflight = exportPreflights[format];
            const awaitsExtremeConfirmation = preflight
              && !preflight.allowed
              && preflight.reason === "HEIGHT_EXTREME_CONFIRMATION_REQUIRED";
            const unavailable = Boolean(preflight && !preflight.allowed && !awaitsExtremeConfirmation);
            return (
              <button
                type="button"
                className={[
                  "export-format",
                  format === "bundle" ? "export-format--featured" : "",
                  unavailable ? "export-format--unavailable" : "",
                ].filter(Boolean).join(" ")}
                key={format}
                disabled={!result || exporting || unavailable}
                onClick={() => void requestExport(format)}
              >
                <Download size={17} />
                <span>
                  <strong>{t(`export.format.${format}` as TranslationKey)}</strong>
                  <small>{t(`export.format.${format}.hint` as TranslationKey)}</small>
                  {preflight && !preflight.allowed && !awaitsExtremeConfirmation ? (
                    <>
                      <small className="export-format__reason">{describeExportPreflight(preflight)}</small>
                      {preflight.reason !== "empty" ? (
                        <small className="export-format__alternative">{t("exportCenter.useBundle")}</small>
                      ) : null}
                    </>
                  ) : null}
                  {preflight?.requiresConfirmation ? (
                    <small className="export-format__reason">
                      {t("exportResourceRisk.preflightWarning")}
                    </small>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
        <fieldset className="bundle-format-options" disabled={exporting}>
          <legend>{t("exportCenter.bundleFormats.title")}</legend>
          <p>{t("exportCenter.bundleFormats.hint")}</p>
          {([
            ["includeSchematic", "exportCenter.bundleFormats.schematic"],
            ["includeMcstructure", "exportCenter.bundleFormats.mcstructure"],
            ["includeMcfunction", "exportCenter.bundleFormats.mcfunction"],
          ] as const).map(([option, label]) => (
            <label key={option}>
              <input
                type="checkbox"
                checked={bundleFormats[option]}
                onChange={(event) => {
                  const checked = event.currentTarget.checked;
                  setBundleFormats((current) => ({
                    ...current,
                    [option]: checked,
                  }));
                }}
              />
              <span>{t(label)}</span>
            </label>
          ))}
        </fieldset>
        <p className="export-center-note">{t("exportCenter.splitNote")}</p>
      </Windows>

      <Windows
        open={Boolean(pendingThreadResourceRisk)}
        title={t("threadResourceRisk.title")}
        closeLabel={t("common.close")}
        danger
        onClose={closeThreadResourceRisk}
        restoreFocusTo={generateTriggerRef.current}
        actions={pendingThreadResourceRisk ? [
          {
            label: t("common.cancel"),
            onClick: closeThreadResourceRisk,
          },
          {
            label: t("threadResourceRisk.useRecommended", {
              count: number(pendingRecommendedWorkerThreads),
            }),
            onClick: continueWithRecommendedThreads,
          },
          {
            label: t("threadResourceRisk.continue", {
              count: number(pendingThreadResourceRisk.assessment.executionSnapshot?.workerThreads ?? 1),
            }),
            emphasis: "danger",
            onClick: continueWithSelectedThreads,
          },
        ] : []}
      >
        {pendingThreadResourceRisk?.assessment.executionSnapshot ? (
          <div className="safety-copy">
            <p>{t("threadResourceRisk.body", {
              configured: number(pendingThreadResourceRisk.assessment.executionSnapshot.workerThreads),
              recommended: number(
                pendingRecommendedWorkerThreads,
              ),
            })}</p>
          </div>
        ) : null}
      </Windows>

      <Windows
        open={Boolean(pendingGenerationResourceRisk)}
        title={t("generationResourceRisk.title")}
        closeLabel={t("common.close")}
        danger
        onClose={closeGenerationResourceRisk}
        actions={[
          {
            label: t("common.cancel"),
            onClick: closeGenerationResourceRisk,
          },
          {
            label: t("generationResourceRisk.continue"),
            emphasis: "danger",
            disabled: !generationResourceRiskAcknowledged,
            onClick: confirmGenerationResourceRisk,
          },
        ]}
      >
        {pendingGenerationResourceRisk ? (
          <div className="safety-copy generation-resource-risk">
            <p>{t("generationResourceRisk.body")}</p>
            <dl className="generation-resource-risk__facts">
              <div>
                <dt>{t("generationResourceRisk.candidates")}</dt>
                <dd>{t("generationResourceRisk.approximate", {
                  value: number(pendingGenerationResourceRisk.assessment.estimatedCandidateChecks),
                })}</dd>
              </div>
              <div>
                <dt>{t("generationResourceRisk.memory")}</dt>
                <dd>{t("generationResourceRisk.approximate", {
                  value: formatBinaryBytes(pendingGenerationResourceRisk.resources.estimatedBytes),
                })}</dd>
              </div>
              <div>
                <dt>{t("generationResourceRisk.blocks")}</dt>
                <dd>{t("generationResourceRisk.approximate", {
                  value: number(pendingGenerationResourceRisk.resources.estimatedBlocks),
                })}</dd>
              </div>
              <div>
                <dt>{t("generationResourceRisk.duration")}</dt>
                <dd>{t("generationResourceRisk.durationRange", {
                  minimum: formatRiskDuration(
                    pendingGenerationResourceRisk.assessment.minimumSeconds,
                    number,
                    t,
                  ),
                  maximum: formatRiskDuration(
                    pendingGenerationResourceRisk.assessment.maximumSeconds,
                    number,
                    t,
                  ),
                })}</dd>
              </div>
            </dl>
            <p>{t("generationResourceRisk.details", {
              risks: pendingGenerationResourceRisk.assessment.risks
                .map((risk) => t(`generationResourceRisk.reason.${risk}` as TranslationKey))
                .join(t("generationResourceRisk.reasonSeparator")),
            })}</p>
            <p>{t("generationResourceRisk.workerRefines")}</p>
            <label className="risk-acknowledgement">
              <input
                type="checkbox"
                checked={generationResourceRiskAcknowledged}
                onChange={(event) => setGenerationResourceRiskAcknowledged(event.currentTarget.checked)}
              />
              <span>{t("generationResourceRisk.acknowledge")}</span>
            </label>
          </div>
        ) : null}
      </Windows>

      <Windows
        open={Boolean(pendingExport)}
        title={pendingExport?.resourceRisk
          && pendingExport.requiredHeight <= selectedDefaultHeight
          ? t("exportResourceRisk.title")
          : t("extendedExport.title")}
        closeLabel={t("common.close")}
        danger
        dismissible={!exporting}
        onClose={() => {
          if (exporting) return;
          setPendingExport(null);
          setExtendedExportAcknowledged(false);
          setExtremeExportPhraseInput("");
          replaceExtremeConfirmations((current) => clearExtremeExportConfirmation(current));
          if (!survivalToolsOpen) projectionDocumentRef.current = null;
        }}
        actions={[
          {
            label: t("common.cancel"),
            disabled: exporting,
            onClick: () => {
              setPendingExport(null);
              setExtendedExportAcknowledged(false);
              setExtremeExportPhraseInput("");
              replaceExtremeConfirmations((current) => clearExtremeExportConfirmation(current));
              if (!survivalToolsOpen) projectionDocumentRef.current = null;
            },
          },
          {
            label: exporting ? t("sidebar.packaging") : t("extendedExport.confirm"),
            emphasis: "danger",
            disabled: !extendedExportAcknowledged
              || exporting
              || !pendingExport
              || (Boolean(pendingExport?.experimental)
                && extremeExportPhraseInput !== extremeExportPhrase(pendingExport.requiredHeight)),
            onClick: confirmPendingExport,
          },
        ]}
      >
        <div className="safety-copy">
          {pendingExport && pendingExport.requiredHeight > selectedDefaultHeight ? (
            <p>{t("extendedExport.body", {
              height: number(pendingExport?.targetDimensionHeight ?? selectedDefaultHeight),
              vanilla: number(selectedDefaultHeight),
            })}</p>
          ) : null}
          {pendingExport && pendingExport.targetDimensionHeight !== pendingExport.requiredHeight ? (
            <p>{t("extendedExport.projectionHeight", {
              height: number(pendingExport.requiredHeight),
            })}</p>
          ) : null}
          {pendingExport?.resourceRisk ? (
            <div className="generation-resource-risk">
              <p>{t("exportResourceRisk.body")}</p>
              <ul>
                {pendingExport.resourceRisk.reasons.includes("denseVolume") ? (
                  <li>{t("exportResourceRisk.denseVolume", {
                    volume: number(pendingExport.resourceRisk.denseVolume ?? 0),
                    limit: number(pendingExport.resourceRisk.denseVolumeLimit ?? 0),
                  })}</li>
                ) : null}
                {pendingExport.resourceRisk.reasons.includes("workingSet") ? (
                  <li>{t("exportResourceRisk.workingSet", {
                    memory: formatBinaryBytes(
                      pendingExport.resourceRisk.bundle?.estimatedWorkingBytes ?? 0,
                    ),
                    limit: formatBinaryBytes(
                      pendingExport.resourceRisk.bundle?.workingBudgetBytes ?? 0,
                    ),
                  })}</li>
                ) : null}
                {pendingExport.resourceRisk.reasons.includes("webRetention") ? (
                  <li>{t("exportResourceRisk.webRetention", {
                    memory: formatBinaryBytes(
                      pendingExport.resourceRisk.estimatedWebRetentionBytes,
                    ),
                  })}</li>
                ) : null}
              </ul>
              <p>{t("exportResourceRisk.continueHint")}</p>
            </div>
          ) : null}
          <ul>
            {pendingExport && pendingExport.requiredHeight > selectedDefaultHeight ? (
              <>
                <li>{t("extendedExport.checkDatapack")}</li>
                <li>{t("extendedExport.checkRisk")}</li>
              </>
            ) : null}
          </ul>
          <label className="risk-acknowledgement">
            <input
              type="checkbox"
              checked={extendedExportAcknowledged}
              onChange={(event) => setExtendedExportAcknowledged(event.currentTarget.checked)}
            />
            <span>{t(
              pendingExport?.resourceRisk && pendingExport.requiredHeight <= selectedDefaultHeight
                ? "exportResourceRisk.acknowledge"
                : "extendedExport.acknowledge",
            )}</span>
          </label>
          {pendingExport?.experimental ? (
            <label className="extreme-export-phrase">
              <span>{t("extremeHeight.exportPhrase", {
                phrase: extremeExportPhrase(pendingExport.requiredHeight),
              })}</span>
              <input
                type="text"
                value={extremeExportPhraseInput}
                autoComplete="off"
                onChange={(event) => setExtremeExportPhraseInput(event.currentTarget.value)}
              />
            </label>
          ) : null}
        </div>
      </Windows>

      {toast ? <div className="toast"><Download size={15} />{toast}</div> : null}
    </main>
  );
}
