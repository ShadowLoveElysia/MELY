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
  UserRound,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box3, MathUtils, Vector3 } from "three";
import { IconButton } from "./components/IconButton";
import {
  MotionFrameReadout,
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
import type { MmdModelCandidate } from "./core/mmdAssets";
import type { LoadedMmdModel } from "./core/mmdModel";
import {
  canToggleMotionPlayback,
  formatMotionFrame,
  getAdjacentMotionFrame,
  isMotionReadyForGeneration,
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
  MmdMotionInfo,
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
  const size = new Box3().setFromObject(model.root, false).getSize(new Vector3());
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
  const motionSecondsRef = useRef(0);
  const motionTimeStoreRef = useRef<ReturnType<typeof createMotionTimeStore> | null>(null);
  if (!motionTimeStoreRef.current) motionTimeStoreRef.current = createMotionTimeStore();
  const motionTimeStore = motionTimeStoreRef.current;
  const motionPlaybackStoreRef = useRef<ReturnType<typeof createMotionPlaybackStore> | null>(null);
  if (!motionPlaybackStoreRef.current) motionPlaybackStoreRef.current = createMotionPlaybackStore();
  const motionPlaybackStore = motionPlaybackStoreRef.current;
  const pendingMotionSecondsRef = useRef<number | null>(null);
  const renderedMotionUiSecondsRef = useRef<number | null>(null);
  const motionUiPublishTimerRef = useRef<number | null>(null);
  const motionScrubCommitTimerRef = useRef<number | null>(null);
  const motionPlayingRef = useRef(false);
  const motionInfoRef = useRef<MmdMotionInfo | null>(null);
  const motionClockRef = useRef({
    startedAt: 0,
    startSeconds: 0,
    lastUiFrame: 0,
  });
  const [options, setOptions] = useState(initialOptions);
  const [solidOptions, setSolidOptions] = useState(initialSolidOptions);
  const [generationMode, setGenerationMode] = useState<GenerationMode>("hologram");
  const [result, setResult] = useState<ProjectionResult | null>(null);
  const [assets, setAssets] = useState<ImportedAsset[]>([]);
  const [modelCandidates, setModelCandidates] = useState<MmdModelCandidate[]>([]);
  const [selectedModelPath, setSelectedModelPath] = useState("");
  const [mmdModel, setMmdModel] = useState<LoadedMmdModel | null>(null);
  const [motionInfo, setMotionInfo] = useState<MmdMotionInfo | null>(null);
  const [lockedMotionFrame, setLockedMotionFrame] = useState<number | null>(null);
  const [poseRevision, setPoseRevision] = useState(0);
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
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 720);
  const [cameraMode, setCameraMode] = useState<CameraMode>("perspective");
  const [previewMode, setPreviewMode] = useState<PreviewMode>("source");
  const [showGrid, setShowGrid] = useState(true);
  const [showBounds, setShowBounds] = useState(true);
  const [nightMode, setNightMode] = useState(false);
  const [heightMode, setHeightMode] = useState<HeightLimitMode>("vanilla");
  const [heightUnlockOpen, setHeightUnlockOpen] = useState(false);
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
  const [resetToken, setResetToken] = useState(0);
  const [focusFaceToken, setFocusFaceToken] = useState(0);
  const [toast, setToast] = useState<string | null>(null);

  motionInfoRef.current = motionInfo;

  const publishMotionSeconds = useCallback((seconds: number) => {
    if (motionScrubCommitTimerRef.current !== null) {
      window.clearTimeout(motionScrubCommitTimerRef.current);
      motionScrubCommitTimerRef.current = null;
    }
    if (motionUiPublishTimerRef.current !== null) {
      window.clearTimeout(motionUiPublishTimerRef.current);
      motionUiPublishTimerRef.current = null;
    }
    pendingMotionSecondsRef.current = null;
    renderedMotionUiSecondsRef.current = null;
    motionSecondsRef.current = seconds;
    motionTimeStore.set(seconds);
  }, [motionTimeStore]);

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
    if (motionUiPublishTimerRef.current !== null) {
      window.clearTimeout(motionUiPublishTimerRef.current);
    }
    modelRef.current?.dispose();
    modelRef.current = null;
  }, []);

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

  const advanceMotionPreview = useCallback((now: number) => {
    const model = modelRef.current;
    const motion = motionInfoRef.current;
    if (!model || !motion) return null;

    const pendingSeconds = pendingMotionSecondsRef.current;
    if (pendingSeconds !== null) {
      pendingMotionSecondsRef.current = null;
      model.updatePreviewPose(pendingSeconds);
      motionSecondsRef.current = pendingSeconds;
      renderedMotionUiSecondsRef.current = pendingSeconds;
      return pendingSeconds;
    }

    if (!motionPlayingRef.current || motion.durationSeconds <= 0) return null;

    const clock = motionClockRef.current;
    const seconds = (
      clock.startSeconds + Math.max(0, now - clock.startedAt) / 1000
    ) % motion.durationSeconds;
    model.updatePreviewPose(seconds);
    motionSecondsRef.current = seconds;

    const displayedFrame = Math.round(seconds * motion.frameRate);
    if (displayedFrame !== clock.lastUiFrame) {
      clock.lastUiFrame = displayedFrame;
      renderedMotionUiSecondsRef.current = seconds;
    }
    return seconds;
  }, []);

  const publishRenderedMotionPreview = useCallback((
    renderedAt: number,
    evaluatedMotionSeconds: number | null,
    gpuSynchronized: boolean,
  ) => {
    if (evaluatedMotionSeconds !== null && (window as Window & {
      __MELY_E2E_GPU_PROBE__?: boolean;
    }).__MELY_E2E_GPU_PROBE__) {
      window.dispatchEvent(new CustomEvent("mely:vmd-frame-rendered", {
        detail: {
          seconds: evaluatedMotionSeconds,
          frame: evaluatedMotionSeconds * (motionInfoRef.current?.frameRate ?? 30),
          renderedAt,
          gpuSynchronized,
        },
      }));
    }
    if (renderedMotionUiSecondsRef.current === null || motionUiPublishTimerRef.current !== null) return;
    motionUiPublishTimerRef.current = window.setTimeout(() => {
      motionUiPublishTimerRef.current = null;
      const seconds = renderedMotionUiSecondsRef.current;
      renderedMotionUiSecondsRef.current = null;
      if (seconds !== null) motionTimeStore.set(seconds);
    }, 0);
  }, [motionTimeStore]);

  const targetHeight = options.targetHeight;
  const heightRisk = useMemo(
    () => evaluateProjectionHeightRisk(targetHeight, result?.bounds),
    [result?.bounds, targetHeight],
  );
  const extendedHeightActive = heightRisk.requiresExportConfirmation;
  const estimatedDimensions = useMemo(
    () => estimateModelDimensions(mmdModel, targetHeight),
    [mmdModel, targetHeight],
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
        triangleCount: mmdModel.stats.triangleCount,
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
      triangleCount: model.stats.triangleCount,
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
  }, [clearProjectionArtifacts, localizeError, t]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 2800);
    return () => window.clearTimeout(timeout);
  }, [toast]);

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

  const loadModelFromPackage = useCallback(async (
    packageFiles: File[],
    modelFile: File,
    modelPath: string,
    requestId: string,
  ) => {
    setModelLoadStageKey("app.stage.parseModel");
    const previousModel = modelRef.current;
    if (previousModel) {
      modelRef.current = null;
      motionPlayingRef.current = false;
      setMmdModel(null);
      setMotionInfo(null);
      publishMotionSeconds(0);
      motionPlaybackStore.set(false);
      setLockedMotionFrame(null);
      setPoseEditing(false);
      setSelectedBoneIndex(null);
      setPoseState(emptyPoseState);
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
    } else {
      await modelReleaseRef.current;
    }
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
    setMotionInfo(null);
    publishMotionSeconds(0);
    motionPlayingRef.current = false;
    motionPlaybackStore.set(false);
    setLockedMotionFrame(null);
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

    let loadedMotion: MmdMotionInfo | null = null;
    const { choosePrimaryMmdMotion } = await import("./core/mmdAssets");
    const motionFile = await choosePrimaryMmdMotion(packageFiles, loaded);
    if (motionFile) {
      setModelLoadStageKey("app.stage.parseMotion");
      loadedMotion = await loaded.loadMotion(motionFile);
      if (modelLoadRequestRef.current !== requestId) {
        if (modelRef.current === loaded) modelRef.current = null;
        loaded.dispose();
        return;
      }
      setMotionInfo(loadedMotion);
      setLockedMotionFrame(null);
      setPoseRevision((value) => value + 1);
    }

    const warnings = loaded.stats.textureWarnings;
    setToast(t("toast.modelLoaded", {
      name: loaded.stats.name,
      vertices: number(loaded.stats.vertexCount),
      motion: loadedMotion ? t("toast.modelLoadedMotion", { frames: number(loadedMotion.maxFrame) }) : "",
      warnings: warnings ? t("toast.modelLoadedWarnings", { count: number(warnings) }) : "",
    }));
  }, [clearProjectionArtifacts, number, publishMotionSeconds, t]);

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
        choosePrimaryMmdMotion,
        expandMmdAssets,
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
          const motionFile = await choosePrimaryMmdMotion(expanded, currentModel ?? undefined);
          if (motionFile && currentModel) {
            setModelLoadStageKey("app.stage.parseMotion");
            const loadedMotion = await currentModel.loadMotion(motionFile);
            if (modelLoadRequestRef.current !== requestId) return;
            setMotionInfo(loadedMotion);
            publishMotionSeconds(0);
            motionPlayingRef.current = false;
            motionPlaybackStore.set(false);
            setLockedMotionFrame(null);
            setPoseEditing(false);
            invalidatePoseProjection();
            setPoseRevision((value) => value + 1);
            setAssets((current) => [...current.filter((asset) => asset.type !== "motion"), ...nextAssets]);
            expandedAssetsRef.current = [...expandedAssetsRef.current, ...expanded];
            setPreviewMode("source");
            setToast(t("toast.motionLoaded", {
              name: loadedMotion.name,
              frames: number(loadedMotion.maxFrame),
            }));
            return;
          }
          setAssets((current) => [...current, ...nextAssets]);
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
    if (!path || path === selectedModelPath || modelLoading) return;
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

  const setMotionPlayingState = (playing: boolean) => {
    const model = modelRef.current;
    if (!motionInfo || !model) return;
    if (playing && !canToggleMotionPlayback(true, lockedMotionFrame)) return;
    if (motionScrubCommitTimerRef.current !== null) {
      window.clearTimeout(motionScrubCommitTimerRef.current);
      motionScrubCommitTimerRef.current = null;
    }
    if (playing) {
      pendingMotionSecondsRef.current = null;
      setLockedMotionFrame(null);
      if (result || previewMode !== "source") invalidatePoseProjection();
      setPoseEditing(false);
      motionClockRef.current = {
        startedAt: performance.now(),
        startSeconds: motionSecondsRef.current,
        lastUiFrame: Math.round(motionSecondsRef.current * motionInfo.frameRate),
      };
    } else {
      motionPlayingRef.current = false;
      pendingMotionSecondsRef.current = null;
      motionTimeStore.set(motionSecondsRef.current);
    }
    motionPlayingRef.current = playing;
    motionPlaybackStore.set(playing);
    setPreviewMode("source");
  };

  const setMotionFrame = (frame: number) => {
    const model = modelRef.current;
    if (!model || !motionInfo) return;
    const wasPlaying = motionPlayingRef.current;
    motionPlayingRef.current = false;
    if (wasPlaying) motionPlaybackStore.set(false);
    if (lockedMotionFrame !== null) setLockedMotionFrame(null);
    const clampedFrame = Math.max(0, Math.min(motionInfo.maxFrame, frame));
    const seconds = clampedFrame / motionInfo.frameRate;
    pendingMotionSecondsRef.current = seconds;
    motionSecondsRef.current = seconds;
    if (result) scheduleMotionScrubCommit();
    if (previewMode !== "source") setPreviewMode("source");
  };

  const stepMotionFrame = (direction: -1 | 1) => {
    if (!motionInfo || lockedMotionFrame !== null) return;
    setMotionFrame(getAdjacentMotionFrame(
      motionSecondsRef.current * motionInfo.frameRate,
      motionInfo.maxFrame,
      direction,
    ));
  };

  const generateCurrentPose = () => {
    if (!isMotionReadyForGeneration(Boolean(motionInfo), lockedMotionFrame)) {
      setToast(t("toast.motionLockRequired"));
      return;
    }
    setPoseEditing(false);
    setPreviewMode("source");
    void generate(generationMode, options, solidOptions);
  };

  const toggleMotionLock = () => {
    const model = modelRef.current;
    if (!model || !motionInfo) return;
    if (lockedMotionFrame !== null) {
      setLockedMotionFrame(null);
      invalidatePoseProjection();
      setToast(t("toast.motionUnlocked"));
      return;
    }

    motionPlayingRef.current = false;
    motionPlaybackStore.set(false);
    if (motionScrubCommitTimerRef.current !== null) {
      window.clearTimeout(motionScrubCommitTimerRef.current);
      motionScrubCommitTimerRef.current = null;
    }
    const exactFrame = Math.max(0, Math.min(
      motionInfo.maxFrame,
      motionSecondsRef.current * motionInfo.frameRate,
    ));
    const seconds = exactFrame / motionInfo.frameRate;
    pendingMotionSecondsRef.current = null;
    model.updatePose(seconds);
    publishMotionSeconds(seconds);
    setLockedMotionFrame(exactFrame);
    invalidateProjection("motion-lock");
    setPoseRevision((value) => value + 1);
    setPreviewMode("source");
    setToast(t("toast.motionLocked", { frame: formatMotionFrame(exactFrame) }));
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
      motionPlayingRef.current = false;
      motionPlaybackStore.set(false);
      pendingMotionSecondsRef.current = null;
      if (motionInfo) model.updatePose(motionSecondsRef.current);
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

  const exportCurrentPose = async () => {
    const model = modelRef.current;
    if (!model) {
      setToast(t("toast.modelRequired"));
      return;
    }
    try {
      if (motionPlayingRef.current && motionInfo) {
        motionPlayingRef.current = false;
        motionPlaybackStore.set(false);
        model.updatePose(motionSecondsRef.current);
        motionTimeStore.set(motionSecondsRef.current);
        setPoseRevision((value) => value + 1);
      }
      const { stringifyMelyPose } = await import("./core/melyPose");
      const pose = model.exportMelyPose();
      const frameSuffix = motionInfo
        ? `_F${formatMotionFrame(lockedMotionFrame ?? motionSecondsRef.current * motionInfo.frameRate)}`
        : "";
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

      motionPlayingRef.current = false;
      motionPlaybackStore.set(false);
      model.clearMotion();
      setMotionInfo(null);
      publishMotionSeconds(0);
      setLockedMotionFrame(null);
      expandedAssetsRef.current = expandedAssetsRef.current.filter((asset) => (
        !asset.name.toLowerCase().endsWith(".vmd")
      ));
      setAssets((current) => current.filter((asset) => asset.type !== "motion"));

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
      if (
        event.code !== "Space"
        || event.repeat
        || event.ctrlKey
        || event.metaKey
        || event.altKey
        || shouldIgnoreMotionShortcut(event.target)
        || !canToggleMotionPlayback(Boolean(motionInfo), lockedMotionFrame)
      ) return;
      event.preventDefault();
      setMotionPlayingState(!motionPlayingRef.current);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [lockedMotionFrame, motionInfo]);

  const projectionName = useMemo(() => {
    const sourceName = mmdModel?.stats.name
      || assets.find((asset) => asset.type === "model")?.name.replace(/\.[^.]+$/, "")
      || "ELY_Hologram";
    const frameSuffix = motionInfo
      ? `_F${formatMotionFrame(lockedMotionFrame ?? motionSecondsRef.current * motionInfo.frameRate)}`
      : "";
    const poseSuffix = poseState.editCount ? "_POSE" : "";
    const modeSuffix = result?.kind === "solid" ? "_SOLID" : "_HOLOGRAM";
    return `MELY_${safeFileStem(sourceName)}${frameSuffix}${poseSuffix}${modeSuffix}`;
  }, [assets, lockedMotionFrame, mmdModel, motionInfo, poseRevision, poseState.editCount, result?.kind]);

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
    !modelLoading && !processing && !poseEditing && motionInfo && mmdModel,
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
          <span>{showMotionStatus && motionInfo ? (
            <MotionStatusText
              motion={motionInfo}
              timeSource={motionTimeStore}
              playbackSource={motionPlaybackStore}
              lockedFrame={lockedMotionFrame}
            />
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
            modelCandidates={modelCandidates}
            selectedModelPath={selectedModelPath}
            motionInfo={motionInfo}
            lockedMotionFrame={lockedMotionFrame}
            bones={mmdModel?.bones ?? []}
            materials={mmdModel?.materials ?? []}
            selectedBoneIndex={selectedBoneIndex}
            poseEditing={poseEditing}
            poseState={poseState}
            assets={assets}
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
            onOptionsChange={updateOptions}
            onSolidOptionsChange={updateSolidOptions}
            onGenerationModeChange={changeGenerationMode}
            onPreviewModeChange={changePreviewMode}
            onAssetsAdded={addAssets}
            onModelSelected={selectModelFromPackage}
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

        <section className={`viewport-panel ${motionInfo ? "viewport-panel--with-motion" : ""}`}>
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
                  {motionInfo ? (
                    <MotionFrameReadout
                      motion={motionInfo}
                      timeSource={motionTimeStore}
                      lockedFrame={lockedMotionFrame}
                    />
                  ) : null}
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

          {motionInfo ? (
            <MotionTimeline
              motion={motionInfo}
              timeSource={motionTimeStore}
              playbackSource={motionPlaybackStore}
              lockedFrame={lockedMotionFrame}
              disabled={processing || modelLoading}
              onPlayingChange={setMotionPlayingState}
              onFrameChange={setMotionFrame}
              onFrameStep={stepMotionFrame}
              onLockToggle={toggleMotionLock}
            />
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
