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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { Viewport3D } from "./components/Viewport3D";
import { Windows } from "./components/Windows";
import { appError, errorDescriptor } from "./core/appError";
import {
  preflightProjectionExport,
  type ExportPreflightFormat,
  type ExportPreflightReason,
  type ExportPreflightResult,
} from "./core/exportPreflight";
import {
  DEFAULT_TARGET_HEIGHT,
  EXTENDED_WORLD_HEIGHT,
  VANILLA_WORLD_HEIGHT,
  clampTargetHeight,
  evaluateProjectionHeightRisk,
  type HeightLimitMode,
} from "./core/heightSafety";
import type {
  MmdModelCandidate,
  MmdMotionCandidateTracks,
} from "./core/mmdAssets";
import type { LoadedMmdModel } from "./core/mmdModel";
import {
  areMotionTracksReadyForGeneration,
  canToggleMotionPlayback,
  formatMotionFrame,
  getAdjacentMotionFrame,
  shouldIgnoreMotionShortcut,
} from "./core/motionUi";
import {
  createMotionPlaybackStore,
  createMotionTimeStore,
} from "./core/motionTimeStore";
import { createProjectionDocumentFromResult } from "./core/projectionDocument";
import { formatBinaryBytes, estimateVoxelizationResources } from "./core/resourceBudget";
import type { ExportBundlePhase } from "./core/exportBundle";
import {
  createConversionWorkerLifecycle,
  type ConversionWorkerLifecycle,
} from "./core/workerLifecycle";
import { useI18n } from "./i18n/I18nProvider";
import type { LocaleCode, TranslationKey } from "./i18n";
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
  material: "mixed",
  directionMode: "vertical",
  isolatePanes: true,
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

const exportPreflightReasonKeys = {
  empty: "exportCenter.unavailable.empty",
  unsafeVolume: "exportCenter.unavailable.volume",
  dimensionLimit: "exportCenter.unavailable.dimension",
} as const satisfies Record<ExportPreflightReason, TranslationKey>;

interface PendingExport {
  format: ExportFormat;
  document: ProjectionDocument;
  name: string;
  targetHeight: number;
  actualHeight: number;
  safetyHeight: number;
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
const DEFAULT_SIDEBAR_WIDTH = 372;
const MIN_SIDEBAR_WIDTH = 300;
const MAX_SIDEBAR_WIDTH = 840;
const MIN_VIEWPORT_WIDTH = 420;

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
  if (!model) return 0;
  const seen = new Set<string>();
  let bytes = 0;
  const materials = Array.isArray(model.mesh.material) ? model.mesh.material : [model.mesh.material];
  for (const material of materials) {
    if (!material.visible || material.opacity <= 0.01) continue;
    const map = (material as typeof material & { map?: import("three").Texture | null }).map;
    if (!map || seen.has(map.uuid)) continue;
    seen.add(map.uuid);
    const image = map.source.data ?? map.image;
    if (!image || typeof image !== "object") continue;
    const dimensions = image as { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number };
    const width = dimensions.naturalWidth ?? dimensions.width ?? 0;
    const height = dimensions.naturalHeight ?? dimensions.height ?? 0;
    bytes += Math.max(0, width) * Math.max(0, height) * 4;
  }
  return bytes;
};

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
  model.root.updateMatrixWorld(true);
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
  const modelLoadRequestRef = useRef<string>("");
  const modelRef = useRef<LoadedMmdModel | null>(null);
  const modelReleaseRef = useRef<Promise<void>>(Promise.resolve());
  const addAssetsRef = useRef<(files: File[]) => void | Promise<void>>(() => undefined);
  const expandedAssetsRef = useRef<File[]>([]);
  const projectionDocumentRef = useRef<{
    result: ProjectionResult;
    document: ProjectionDocument;
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
  const sidebarResizeCleanupRef = useRef<(() => void) | null>(null);
  const lockedMotionFramesRef = useRef(emptyLockedMotionFrames());
  const [options, setOptions] = useState(initialOptions);
  const [solidOptions, setSolidOptions] = useState(initialSolidOptions);
  const [generationMode, setGenerationMode] = useState<GenerationMode>("hologram");
  const [result, setResult] = useState<ProjectionResult | null>(null);
  const [assets, setAssets] = useState<ImportedAsset[]>([]);
  const [modelCandidates, setModelCandidates] = useState<MmdModelCandidate[]>([]);
  const [selectedModelPath, setSelectedModelPath] = useState("");
  const [motionCandidates, setMotionCandidates] = useState<MmdMotionCandidateTracks>(emptyMotionCandidateTracks);
  const [selectedMotionPaths, setSelectedMotionPaths] = useState(emptySelectedMotionPaths);
  const [mmdModel, setMmdModel] = useState<LoadedMmdModel | null>(null);
  const [motionTracks, setMotionTracks] = useState<MmdMotionTracks>(emptyMotionTracks);
  const [lockedMotionFrames, setLockedMotionFrames] = useState(emptyLockedMotionFrames);
  const [poseRevision, setPoseRevision] = useState(0);
  const [partsRevision, setPartsRevision] = useState(0);
  const [poseEditing, setPoseEditing] = useState(false);
  const [selectedBoneIndex, setSelectedBoneIndex] = useState<number | null>(null);
  const [poseState, setPoseState] = useState<MmdPoseState>(emptyPoseState);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelLoadStageKey, setModelLoadStageKey] = useState<AppStageKey>("app.stage.prepareModel");
  const [progress, setProgress] = useState(0);
  const [stageKey, setStageKey] = useState<AppStageKey | WorkerStageKey>("app.stage.prepareGeneration");
  const [exportCurrentFile, setExportCurrentFile] = useState("");
  const [processing, setProcessing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const [physicsEnabled, setPhysicsEnabled] = useState(false);
  const [physicsLoading, setPhysicsLoading] = useState(false);
  const hiddenMaterialIndicesRef = useRef<number[]>([]);
  const [hiddenMaterialIndices, setHiddenMaterialIndices] = useState<number[]>([]);
  const [cameraMode, setCameraMode] = useState<CameraMode>("perspective");
  const [previewMode, setPreviewMode] = useState<PreviewMode>("source");
  const [showGrid, setShowGrid] = useState(true);
  const [showBounds, setShowBounds] = useState(true);
  const [nightMode, setNightMode] = useState(false);
  const [heightMode, setHeightMode] = useState<HeightLimitMode>("vanilla");
  const [heightUnlockOpen, setHeightUnlockOpen] = useState(false);
  const [clearResourcesOpen, setClearResourcesOpen] = useState(false);
  const [clearResourceSelection, setClearResourceSelection] = useState(emptyClearResourceSelection);
  const [exportCenterOpen, setExportCenterOpen] = useState(false);
  const [exportPreflights, setExportPreflights] = useState<Partial<Record<ExportFormat, ExportPreflightResult>>>({});
  const [bundleFormats, setBundleFormats] = useState({
    includeSchematic: false,
    includeMcstructure: false,
    includeMcfunction: false,
  });
  const [pendingExport, setPendingExport] = useState<PendingExport | null>(null);
  const [extendedExportAcknowledged, setExtendedExportAcknowledged] = useState(false);
  const [survivalToolsOpen, setSurvivalToolsOpen] = useState(false);
  const [survivalDocument, setSurvivalDocument] = useState<ProjectionDocument | null>(null);
  const survivalToolsTriggerRef = useRef<HTMLButtonElement>(null);
  const clearResourcesTriggerRef = useRef<HTMLButtonElement>(null);
  const [resetToken, setResetToken] = useState(0);
  const [focusFaceToken, setFocusFaceToken] = useState(0);
  const [toast, setToast] = useState<string | null>(null);

  MOTION_TRACK_KINDS.forEach((kind) => {
    motionRuntime[kind].info = motionTracks[kind];
  });
  lockedMotionFramesRef.current = lockedMotionFrames;

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
    setResult(null);
    projectionDocumentRef.current = null;
    setSurvivalDocument(null);
    setSurvivalToolsOpen(false);
    setExportCenterOpen(false);
    setExportPreflights({});
    setPendingExport(null);
    setExtendedExportAcknowledged(false);
  }, []);

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
          workerLifecycleRef.current?.cancel();
          projectionDocumentRef.current = null;
          setSurvivalDocument(null);
          setResult(event.result);
          setProcessing(false);
          setProgress(1);
          setStageKey("worker.stage.complete");
          setPoseEditing(false);
          setPreviewMode("hologram");
        } else if (event.type === "ERROR") {
          workerLifecycleRef.current?.cancel();
          setProcessing(false);
          setPreviewMode("source");
          setToast(translateRef.current(event.code, event.params));
        }
      },
    });
    workerLifecycleRef.current = lifecycle;

    return () => {
      currentJobRef.current = "";
      lifecycle.dispose();
      if (workerLifecycleRef.current === lifecycle) workerLifecycleRef.current = null;
    };
  }, []);

  const localizeError = useCallback((error: unknown) => {
    const descriptor = errorDescriptor(error);
    return t(descriptor.code, descriptor.params);
  }, [t]);

  useEffect(() => () => {
    modelLoadRequestRef.current = "";
    expandedAssetsRef.current = [];
    if (motionScrubCommitTimerRef.current !== null) {
      window.clearTimeout(motionScrubCommitTimerRef.current);
    }
    MOTION_TRACK_KINDS.forEach((kind) => {
      const timer = motionRuntime[kind].uiPublishTimer;
      if (timer !== null) window.clearTimeout(timer);
    });
    modelRef.current?.dispose();
    modelRef.current = null;
  }, [motionRuntime]);

  const invalidateProjection = useCallback((reason = "settings") => {
    currentJobRef.current = `${reason}:${crypto.randomUUID()}`;
    workerLifecycleRef.current?.cancel();
    setProcessing(false);
    clearProjectionArtifacts();
    setPreviewMode("source");
  }, [clearProjectionArtifacts]);

  const invalidatePoseProjection = useCallback(() => {
    invalidateProjection("pose");
  }, [invalidateProjection]);

  const commitMotionScrub = useCallback(() => {
    motionScrubCommitTimerRef.current = null;
    invalidatePoseProjection();
    setPoseRevision((value) => value + 1);
  }, [invalidatePoseProjection]);

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
    const model = modelRef.current;
    if (!model || !MOTION_TRACK_KINDS.some((kind) => motionRuntime[kind].info)) return null;

    let evaluated = false;
    let settlePhysics = false;
    MOTION_TRACK_KINDS.forEach((kind) => {
      const runtime = motionRuntime[kind];
      const motion = runtime.info;
      if (!motion) return;
      if (runtime.pendingSeconds !== null) {
        runtime.seconds = runtime.pendingSeconds;
        runtime.pendingSeconds = null;
        runtime.renderedUiSeconds = runtime.seconds;
        evaluated = true;
        settlePhysics = true;
        return;
      }
      if (!runtime.playing || motion.durationSeconds <= 0) return;
      runtime.seconds = (
        runtime.clock.startSeconds + Math.max(0, now - runtime.clock.startedAt) / 1000
      ) % motion.durationSeconds;
      const displayedFrame = Math.round(runtime.seconds * motion.frameRate);
      if (displayedFrame !== runtime.clock.lastUiFrame) {
        runtime.clock.lastUiFrame = displayedFrame;
        runtime.renderedUiSeconds = runtime.seconds;
      }
      evaluated = true;
    });
    if (!evaluated) return null;
    const times = currentMotionTimes();
    if (settlePhysics && model.physicsEnabled()) model.updatePose(times);
    else model.updatePreviewPose(times);
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
  const heightRisk = useMemo(
    () => evaluateProjectionHeightRisk(targetHeight, result?.bounds),
    [result?.bounds, targetHeight],
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
      }), [estimatedBlockCount, estimatedDimensions, generationMode, mmdModel, solidOptions.fillMode, targetHeight]);
  const survivalLabels = useMemo(
    () => buildSurvivalLabels(locale, t),
    [locale, t],
  );

  const generate = useCallback(async (
    mode: GenerationMode,
    nextHologramOptions: HologramOptions,
    nextSolidOptions: SolidOptions,
  ) => {
    const model = modelRef.current;
    const workerLifecycle = workerLifecycleRef.current;
    if (!workerLifecycle || !model) {
      setToast(t("toast.modelRequired"));
      return;
    }
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
    });
    if (!resources.allowed) {
      setToast(t(resources.reason === "volume" ? "toast.resourceVolumeRejected" : "toast.resourceMemoryRejected", {
        memory: formatBinaryBytes(resources.estimatedBytes),
      }));
      return;
    }
    const jobId = crypto.randomUUID();
    currentJobRef.current = jobId;
    workerLifecycle.start(jobId);
    clearProjectionArtifacts();
    setPreviewMode("source");
    setProcessing(true);
    setExportCurrentFile("");
    setProgress(0.04);
    setStageKey("app.stage.createJob");

    try {
      setStageKey("app.stage.capturePose");
      if (model.physicsEnabled()) model.updatePose(currentMotionTimes());
      const includeTextures = mode === "solid";
      const { createMmdMeshSnapshot, releaseMmdMeshSnapshot } = await import("./core/mmdSnapshot");
      const snapshot = await createMmdMeshSnapshot(model, {
        includeTextures,
        isCancelled: () => !workerLifecycle.isCurrent(jobId),
        onProgress: (value) => {
          if (!workerLifecycle.isCurrent(jobId)) return;
          setProgress(0.04 + value * 0.12);
        },
      });
      try {
        if (!workerLifecycle.isCurrent(jobId)) return;
        const command: WorkerCommand = mode === "solid"
          ? {
              type: "GENERATE_SOLID",
              jobId,
              options: nextSolidOptions,
              source: { kind: "mesh", mesh: snapshot },
            }
          : {
              type: "GENERATE_HOLOGRAM",
              jobId,
              options: nextHologramOptions,
              source: { kind: "mesh", mesh: snapshot },
            };
        workerLifecycle.post(jobId, command, snapshotTransferables(snapshot));
      } finally {
        releaseMmdMeshSnapshot(snapshot);
      }
    } catch (error) {
      if (currentJobRef.current !== jobId || (error instanceof Error && error.name === "AbortError")) return;
      workerLifecycle.cancel();
      setProcessing(false);
      setPreviewMode("source");
      setToast(t("toast.generationFailed", { reason: localizeError(error) }));
    }
  }, [clearProjectionArtifacts, currentMotionTimes, localizeError, t]);

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
    const onResize = () => {
      if (window.innerWidth <= 720) return;
      setSidebarWidth((current) => clampSidebarWidth(current));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => () => sidebarResizeCleanupRef.current?.(), []);

  const beginSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || window.innerWidth <= 720) return;
    event.preventDefault();
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

  const updateOptions = (patch: Partial<HologramOptions>) => {
    const normalizedPatch = patch.targetHeight === undefined
      ? patch
      : { ...patch, targetHeight: clampTargetHeight(patch.targetHeight, heightMode) };
    setOptions((current) => ({ ...current, ...normalizedPatch }));
    if (normalizedPatch.targetHeight !== undefined) {
      setSolidOptions((current) => ({ ...current, targetHeight: normalizedPatch.targetHeight ?? current.targetHeight }));
    }
    if (Object.keys(normalizedPatch).some((key) => key !== "glow")) invalidateProjection("hologram-options");
  };

  const updateSolidOptions = (patch: Partial<SolidOptions>) => {
    const normalizedPatch = patch.targetHeight === undefined
      ? patch
      : { ...patch, targetHeight: clampTargetHeight(patch.targetHeight, heightMode) };
    setSolidOptions((current) => ({ ...current, ...normalizedPatch }));
    if (normalizedPatch.targetHeight !== undefined) {
      setOptions((current) => ({ ...current, targetHeight: normalizedPatch.targetHeight ?? current.targetHeight }));
    }
    invalidateProjection("solid-options");
  };

  const toggleExtendedHeight = () => {
    if (heightMode === "extended") {
      setHeightMode("vanilla");
      const targetHeight = Math.min(options.targetHeight, VANILLA_WORLD_HEIGHT);
      setOptions((current) => ({ ...current, targetHeight }));
      setSolidOptions((current) => ({ ...current, targetHeight }));
      invalidateProjection("height-lock");
      return;
    }
    setHeightUnlockOpen(true);
  };

  const unlockExtendedHeight = () => {
    setHeightMode("extended");
    setHeightUnlockOpen(false);
    setToast(t("toast.extendedHeightUnlocked", { maximum: number(EXTENDED_WORLD_HEIGHT) }));
  };

  const changeGenerationMode = (mode: GenerationMode) => {
    if (mode === "solid" && !modelRef.current) {
      setToast(t("toast.solidModelRequired"));
      return;
    }
    invalidateProjection("mode");
    setGenerationMode(mode);
  };

  const releaseCurrentModel = useCallback(async () => {
    const previousModel = modelRef.current;
    modelRef.current = null;
    setMmdModel(null);
    setSelectedModelPath("");
    setMotionCandidates(emptyMotionCandidateTracks());
    resetMotionTracks();
    setPhysicsEnabled(false);
    setPhysicsLoading(false);
    hiddenMaterialIndicesRef.current = [];
    setHiddenMaterialIndices([]);
    setPoseEditing(false);
    setSelectedBoneIndex(null);
    setPoseState(emptyPoseState);

    if (!previousModel) {
      await modelReleaseRef.current;
      return;
    }

    const release = (async () => {
      await yieldForModelRelease();
      previousModel.dispose();
      await yieldForModelRelease();
    })();
    modelReleaseRef.current = release;
    try {
      await release;
    } finally {
      if (modelReleaseRef.current === release) modelReleaseRef.current = Promise.resolve();
    }
  }, [resetMotionTracks]);

  const clearCurrentModel = async () => {
    if (modelLoading) return;
    const requestId = crypto.randomUUID();
    modelLoadRequestRef.current = requestId;
    invalidateProjection(`model-clear:${requestId}`);
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
    }
  };

  const loadModelFromPackage = useCallback(async (
    packageFiles: File[],
    modelFile: File,
    modelPath: string,
    requestId: string,
  ) => {
    setModelLoadStageKey("app.stage.parseModel");
    await releaseCurrentModel();
    if (modelLoadRequestRef.current !== requestId) return;

    const { loadMmdModel } = await import("./core/mmdModel");
    const loaded = await loadMmdModel(packageFiles, modelFile);
    if (modelLoadRequestRef.current !== requestId) {
      loaded.dispose();
      return;
    }

    modelRef.current = loaded;
    setMmdModel(loaded);
    setSelectedModelPath(modelPath);
    setPoseEditing(false);
    setSelectedBoneIndex(chooseDefaultBone(loaded.bones));
    setPoseState(loaded.poseState());
    setSolidOptions((current) => ({
      ...current,
      skinMaterialIndices: loaded.materials
        .filter((material) => material.suggestedSkin)
        .map((material) => material.index),
      emissiveMaterialIndices: loaded.materials
        .filter((material) => material.suggestedEmissive)
        .map((material) => material.index),
    }));
    clearProjectionArtifacts();
    setPreviewMode("source");
    setResetToken((value) => value + 1);
    setPoseRevision((value) => value + 1);

    const loadedTracks: Partial<Record<MmdMotionTrackKind, MmdMotionTrackInfo>> = {};
    const {
      groupMmdMotionTrackCandidates,
      inspectMmdMotionCandidates,
    } = await import("./core/mmdAssets");
    const compatibleMotions = groupMmdMotionTrackCandidates(
      await inspectMmdMotionCandidates(packageFiles, loaded),
    );
    setMotionCandidates(compatibleMotions);
    if (compatibleMotions.dance.length || compatibleMotions.expression.length) {
      setModelLoadStageKey("app.stage.parseMotion");
      for (const kind of MOTION_TRACK_KINDS) {
        const candidate = compatibleMotions[kind][0];
        if (!candidate) continue;
        loadedTracks[kind] = await loaded.loadMotion(candidate.file, kind);
        if (modelLoadRequestRef.current !== requestId) {
          if (modelRef.current === loaded) modelRef.current = null;
          loaded.dispose();
          return;
        }
      }
      MOTION_TRACK_KINDS.forEach((kind) => {
        const info = loadedTracks[kind];
        const candidate = compatibleMotions[kind][0];
        if (info && candidate) installMotionTrack(kind, info, candidate.path);
      });
      loaded.updatePose({ dance: 0, expression: 0 });
      setPoseRevision((value) => value + 1);
    }

    const warnings = loaded.stats.textureWarnings;
    const loadedMotion = loadedTracks.dance ?? loadedTracks.expression;
    setToast(t("toast.modelLoaded", {
      name: loaded.stats.name,
      vertices: number(loaded.stats.vertexCount),
      motion: loadedMotion ? t("toast.modelLoadedMotion", { frames: number(loadedMotion.maxFrame) }) : "",
      warnings: warnings ? t("toast.modelLoadedWarnings", { count: number(warnings) }) : "",
    }));
  }, [clearProjectionArtifacts, installMotionTrack, number, releaseCurrentModel, t]);

  const addAssets = async (files: File[]) => {
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
      const candidates = await inspectMmdModels(expanded);
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
              const loadedMotion = await currentModel.loadMotion(candidate.file, kind);
              if (modelLoadRequestRef.current !== requestId) return;
              installMotionTrack(kind, loadedMotion, candidate.path);
              loadedTracks.push(loadedMotion);
            }
            currentModel.updatePose(currentMotionTimes());
            setPoseEditing(false);
            invalidatePoseProjection();
            setPoseRevision((value) => value + 1);
            setAssets((current) => [...current, ...nextAssets]);
            expandedAssetsRef.current = combinedFiles;
            setPreviewMode("source");
            setToast(t("toast.motionLoaded", {
              name: loadedTracks.map((track) => track.name).join(" + "),
              frames: number(Math.max(...loadedTracks.map((track) => track.maxFrame))),
            }));
            return;
          }
          setAssets((current) => [...current, ...nextAssets]);
          expandedAssetsRef.current = combinedFiles;
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
    if (modelLoading || path === selectedModelPath) return;
    if (!path) {
      await clearCurrentModel();
      return;
    }
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
    }
  };

  const selectMotionFromPackage = async (kind: MmdMotionTrackKind, path: string) => {
    const model = modelRef.current;
    if (!model || modelLoading || processing || path === selectedMotionPaths[kind]) return;

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
    }
  };

  const changePhysicsEnabled = async (enabled: boolean) => {
    const model = modelRef.current;
    if (!model || !model.physicsAvailable || physicsLoading || modelLoading || processing) return;
    setPhysicsLoading(true);
    stopAllMotionPlayback();
    try {
      await model.setPhysicsEnabled(enabled);
      if (modelRef.current !== model) return;
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
      if (modelRef.current === model) setPhysicsLoading(false);
    }
  };

  const changeMaterialVisibility = useCallback((index: number, visible: boolean) => {
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
    const next = [...hidden].sort((left, right) => left - right);
    hiddenMaterialIndicesRef.current = next;
    setHiddenMaterialIndices(next);
    invalidateProjection("material-visibility");
    setPartsRevision((value) => value + 1);
    setPreviewMode("source");
  }, [invalidateProjection, modelLoading, processing]);

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
  };

  const setMotionPlayingState = (kind: MmdMotionTrackKind, playing: boolean) => {
    const model = modelRef.current;
    const motion = motionTracks[kind];
    const runtime = motionRuntime[kind];
    if (!motion || !model) return;
    if (playing && !canToggleMotionPlayback(true, lockedMotionFrames[kind])) return;
    if (motionScrubCommitTimerRef.current !== null) {
      window.clearTimeout(motionScrubCommitTimerRef.current);
      motionScrubCommitTimerRef.current = null;
    }
    if (playing) {
      runtime.pendingSeconds = null;
      setLockedMotionFrames((current) => ({ ...current, [kind]: null }));
      if (result || previewMode !== "source") invalidatePoseProjection();
      setPoseEditing(false);
      runtime.clock = {
        startedAt: performance.now(),
        startSeconds: runtime.seconds,
        lastUiFrame: Math.round(runtime.seconds * motion.frameRate),
      };
    } else {
      runtime.playing = false;
      runtime.pendingSeconds = null;
      runtime.timeStore.set(runtime.seconds);
    }
    runtime.playing = playing;
    runtime.playbackStore.set(playing);
    setPreviewMode("source");
  };

  const setMotionFrame = (kind: MmdMotionTrackKind, frame: number) => {
    const model = modelRef.current;
    const motion = motionTracks[kind];
    const runtime = motionRuntime[kind];
    if (!model || !motion) return;
    const wasPlaying = runtime.playing;
    runtime.playing = false;
    if (wasPlaying) runtime.playbackStore.set(false);
    if (lockedMotionFrames[kind] !== null) {
      setLockedMotionFrames((current) => ({ ...current, [kind]: null }));
    }
    const clampedFrame = Math.max(0, Math.min(motion.maxFrame, frame));
    const seconds = clampedFrame / motion.frameRate;
    runtime.pendingSeconds = seconds;
    runtime.seconds = seconds;
    if (result) scheduleMotionScrubCommit();
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

  const toggleMotionLock = (kind: MmdMotionTrackKind) => {
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
    const model = modelRef.current;
    if (!model) return;
    invalidatePoseProjection();
    setPoseState(model.poseState());
    setPoseRevision((value) => value + 1);
    setPreviewMode("source");
  }, [invalidatePoseProjection]);

  const setPoseEditingState = (editing: boolean) => {
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
    setSelectedBoneIndex(index);
    if (index !== null && !poseEditing) {
      setPoseEditingState(true);
    }
  };

  const nudgeSelectedBone = (axis: "x" | "y" | "z", direction: -1 | 1) => {
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
    const model = modelRef.current;
    if (!model || selectedBoneIndex === null || !model.resetBone(selectedBoneIndex)) return;
    commitPoseMutation();
    setToast(t("toast.boneReset"));
  };

  const undoPose = useCallback(() => {
    const model = modelRef.current;
    if (!model?.undoPose()) return;
    commitPoseMutation();
  }, [commitPoseMutation]);

  const redoPose = useCallback(() => {
    const model = modelRef.current;
    if (!model?.redoPose()) return;
    commitPoseMutation();
  }, [commitPoseMutation]);

  const resetPoseEdits = () => {
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
    const model = modelRef.current;
    if (!model) {
      setToast(t("toast.modelRequired"));
      return;
    }
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
    }
  };

  const importExternalPose = async (file: File) => {
    const model = modelRef.current;
    if (!model) {
      setToast(t("toast.modelRequired"));
      return;
    }
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
    }
  };

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
    const cached = projectionDocumentRef.current;
    if (cached?.result === result) return cached.document;
    await yieldToBrowser();
    const document = createProjectionDocumentFromResult(result, {
      edition: "java",
      minecraftVersion: "1.20.1",
      metadata: {
        name: projectionName,
        generator: "MELY",
        targetHeight,
        generationMode: result.kind === "solid" ? "solid" : "hologram",
      },
    });
    projectionDocumentRef.current = { result, document };
    return document;
  }, [projectionName, result, targetHeight]);

  const describeExportPreflight = useCallback((preflight: ExportPreflightResult) => {
    if (!preflight.reason) return "";
    const volume = preflight.volume === null
      ? "0"
      : Number.isFinite(preflight.volume)
        ? number(preflight.volume)
        : `>${number(Number.MAX_SAFE_INTEGER)}`;
    return t(exportPreflightReasonKeys[preflight.reason], {
      volume,
      limit: number(preflight.reason === "dimensionLimit"
        ? preflight.dimensionLimit ?? 0
        : preflight.volumeLimit ?? 0),
      dimension: number(Math.max(...(preflight.dimensions ?? [0]))),
    });
  }, [number, t]);

  const exportPreflightMessage = useCallback((preflight: ExportPreflightResult) => {
    const reason = describeExportPreflight(preflight);
    return preflight.reason && preflight.reason !== "empty"
      ? `${reason} ${t("exportCenter.useBundle")}`
      : reason;
  }, [describeExportPreflight, t]);

  const updateExportPreflights = useCallback((document: ProjectionDocument) => {
    const preflights = Object.fromEntries(exportFormats.map((format) => [
      format,
      preflightProjectionExport(document, format),
    ])) as Record<ExportFormat, ExportPreflightResult>;
    setExportPreflights(preflights);
    return preflights;
  }, []);

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
    const preflight = preflightProjectionExport(request.document, request.format);
    setExportPreflights((current) => ({ ...current, [request.format]: preflight }));
    if (!preflight.allowed) {
      setExporting(false);
      setToast(exportPreflightMessage(preflight));
      setPendingExport(null);
      setExtendedExportAcknowledged(false);
      return;
    }
    setExporting(true);
    setExportCurrentFile("");
    setExportCenterOpen(false);
    try {
      await yieldToBrowser();
      if (request.format === "bundle") {
        const [{
          createExportBundleStream,
          DEFAULT_WEB_BUNDLE_OUTPUT_BUDGET_BYTES,
        }, desktop] = await Promise.all([
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
            description: t("export.description.unified", { version: "1.20.1" }),
          },
          schematic: {
            author: "MELY",
            description: t("export.description.unified", { version: "1.20.1" }),
          },
          mcfunction: {
            packName: request.name,
            description: t("export.description.bedrockPack"),
          },
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
            {
              ...bundleOptions,
              maxOutputBytes: DEFAULT_WEB_BUNDLE_OUTPUT_BUDGET_BYTES,
            },
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
        const [{ createMcfunctionBehaviorPackZipStream }, {
          DEFAULT_WEB_BUNDLE_OUTPUT_BUDGET_BYTES,
        }, desktop] = await Promise.all([
          import("./core/mcfunction"),
          import("./core/exportBundle"),
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
              request.document,
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
            request.document,
            (chunk) => {
              chunks.push(chunk);
            },
            {
              ...behaviorPackOptions,
              maxOutputBytes: DEFAULT_WEB_BUNDLE_OUTPUT_BUDGET_BYTES,
            },
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
      let bytes: Uint8Array;
      let extension: string;
      let mime = "application/octet-stream";
      if (request.format === "litematic") {
        const { createLitematicFromDocument } = await import("./core/litematic");
        bytes = createLitematicFromDocument(request.document, {
          name: request.name,
          author: "MELY",
          description: t("export.description.unified", { version: "1.20.1" }),
          regionMaxSize: 32,
        }).bytes;
        extension = "litematic";
        mime = "application/gzip";
      } else if (request.format === "schematic") {
        const { createSchematic } = await import("./core/schematic");
        bytes = createSchematic(request.document, {
          name: request.name,
          author: "MELY",
          description: t("export.description.unified", { version: "1.20.1" }),
        }).bytes;
        extension = "schem";
        mime = "application/gzip";
      } else if (request.format === "mcstructure") {
        const { createMcstructure } = await import("./core/mcstructure");
        bytes = createMcstructure(request.document).bytes;
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
      setExporting(false);
      setExportCurrentFile("");
      setPendingExport(null);
      setExtendedExportAcknowledged(false);
      if (!survivalToolsOpen) projectionDocumentRef.current = null;
    }
  }, [exportPreflightMessage, locale, localizeError, survivalToolsOpen, t]);

  const requestExport = async (format: ExportFormat) => {
    if (!result || exporting) return;
    setExporting(true);
    try {
      const document = await prepareProjectionDocument();
      const preflight = preflightProjectionExport(document, format);
      setExportPreflights((current) => ({ ...current, [format]: preflight }));
      if (!preflight.allowed) {
        setExporting(false);
        setToast(exportPreflightMessage(preflight));
        return;
      }
      const request: PendingExport = {
        format,
        document,
        name: projectionName,
        targetHeight,
        actualHeight: document.bounds?.dimensions[1] ?? 0,
        safetyHeight: evaluateProjectionHeightRisk(targetHeight, document.bounds).requiredHeight,
        ...(format === "bundle" ? { bundleFormats: { ...bundleFormats } } : {}),
      };
      if (evaluateProjectionHeightRisk(targetHeight, document.bounds).requiresExportConfirmation) {
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
          <span className="version-chip">{t("app.version")}</span>
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
          <IconButton label={t("toolbar.projectInfo")} onClick={() => setToast(t("app.info"))}> <Info size={17} /> </IconButton>
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
            selectedBoneIndex={selectedBoneIndex}
            poseEditing={poseEditing}
            poseState={poseState}
            processing={processing}
            modelLoading={modelLoading}
            modelLoadStage={t(modelLoadStageKey)}
            exporting={exporting}
            heightMaximum={heightMode === "extended" ? EXTENDED_WORLD_HEIGHT : VANILLA_WORLD_HEIGHT}
            extendedHeightUnlocked={heightMode === "extended"}
            extendedHeightActive={extendedHeightActive}
            estimatedBlockCount={estimatedBlockCount}
            resourceEstimateLabel={resourceEstimate ? formatBinaryBytes(resourceEstimate.estimatedBytes) : null}
            progress={progress}
            stage={t(stageKey)}
            progressDetail={exporting ? exportCurrentFile : ""}
            sidebarWidth={sidebarWidth}
            physicsAvailable={mmdModel?.physicsAvailable ?? false}
            physicsEnabled={physicsEnabled}
            physicsLoading={physicsLoading}
            onOptionsChange={updateOptions}
            onSolidOptionsChange={updateSolidOptions}
            onGenerationModeChange={changeGenerationMode}
            onPreviewModeChange={changePreviewMode}
            onAssetsAdded={addAssets}
            onPhysicsEnabledChange={changePhysicsEnabled}
            onMaterialVisibilityChange={changeMaterialVisibility}
            onSidebarResizeStart={beginSidebarResize}
            onSidebarResizeStep={stepSidebarWidth}
            onSidebarResizeReset={resetSidebarWidth}
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
            onExtendedHeightToggle={toggleExtendedHeight}
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

            <Viewport3D
              result={result}
              model={mmdModel}
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
              onBoneSelected={selectBone}
              onPoseCommitted={commitPoseMutation}
              onBeforeRender={advanceMotionPreview}
              onAfterRender={publishRenderedMotionPreview}
            />

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
                {poseEditing ? <><kbd>{t("viewport.clickJoint")}</kbd><kbd>{t("viewport.dragRing")}</kbd></> : <><kbd>{t("viewport.rotate")}</kbd><kbd>{t("viewport.pan")}</kbd><kbd>{t("viewport.zoom")}</kbd></>}
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
                  disabled={processing || modelLoading}
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
            vanilla: number(VANILLA_WORLD_HEIGHT),
            maximum: number(EXTENDED_WORLD_HEIGHT),
          })}</p>
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
            const unavailable = Boolean(preflight && !preflight.allowed);
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
                  {preflight && !preflight.allowed ? (
                    <>
                      <small className="export-format__reason">{describeExportPreflight(preflight)}</small>
                      {preflight.reason !== "empty" ? (
                        <small className="export-format__alternative">{t("exportCenter.useBundle")}</small>
                      ) : null}
                    </>
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
                onChange={(event) => setBundleFormats((current) => ({
                  ...current,
                  [option]: event.currentTarget.checked,
                }))}
              />
              <span>{t(label)}</span>
            </label>
          ))}
        </fieldset>
        <p className="export-center-note">{t("exportCenter.splitNote")}</p>
      </Windows>

      <Windows
        open={Boolean(pendingExport)}
        title={t("extendedExport.title")}
        closeLabel={t("common.close")}
        danger
        dismissible={!exporting}
        onClose={() => {
          if (exporting) return;
          setPendingExport(null);
          setExtendedExportAcknowledged(false);
          if (!survivalToolsOpen) projectionDocumentRef.current = null;
        }}
        actions={[
          {
            label: t("common.cancel"),
            disabled: exporting,
            onClick: () => {
              setPendingExport(null);
              setExtendedExportAcknowledged(false);
              if (!survivalToolsOpen) projectionDocumentRef.current = null;
            },
          },
          {
            label: exporting ? t("sidebar.packaging") : t("extendedExport.confirm"),
            emphasis: "danger",
            disabled: !extendedExportAcknowledged || exporting || !pendingExport,
            onClick: () => pendingExport && void performExport(pendingExport),
          },
        ]}
      >
        <div className="safety-copy">
          <p>{t("extendedExport.body", {
            height: number(pendingExport?.safetyHeight ?? heightRisk.requiredHeight),
            vanilla: number(VANILLA_WORLD_HEIGHT),
          })}</p>
          <ul>
            <li>{t("extendedExport.checkDatapack")}</li>
            <li>{t("extendedExport.checkRisk")}</li>
          </ul>
          <label className="risk-acknowledgement">
            <input
              type="checkbox"
              checked={extendedExportAcknowledged}
              onChange={(event) => setExtendedExportAcknowledged(event.currentTarget.checked)}
            />
            <span>{t("extendedExport.acknowledge")}</span>
          </label>
        </div>
      </Windows>

      {toast ? <div className="toast"><Download size={15} />{toast}</div> : null}
    </main>
  );
}
