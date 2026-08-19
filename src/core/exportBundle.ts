import { strToU8 } from "fflate";
import type {
  ProjectionBlockState,
  ProjectionDocument,
  ProjectionView,
} from "../types";
import {
  DEFAULT_LOCALE,
  translate,
  type LocaleCode,
  type TranslationKey,
  type TranslationParams,
} from "../i18n";
import {
  createProjectionDocument,
  deriveBedrockProjectionDocument,
  iterateProjectionViewBlocks,
  splitProjectionViews,
} from "./projectionDocument";
import { createSchematic, type SchematicExportOptions } from "./schematic";
import { createMcstructure, type McstructureExportOptions } from "./mcstructure";
import {
  iterateMcfunctionBehaviorPackFiles,
  streamMcfunctionBehaviorPack,
  type McfunctionExportOptions,
} from "./mcfunction";
import {
  createLitematicFromDocument,
  type ExportOptions as LitematicExportOptions,
} from "./litematic";
import {
  assertJavaProjectionExportSafety,
  type JavaProjectionExportSafetyInput,
} from "./exportPreflight";
import type {
  JavaCompatibilityLevel,
  JavaCompatibilityWarningCode,
} from "./minecraftVersions";
import { AppError } from "./appError";
import {
  createMaterialPlan,
  type MaterialPlan,
} from "./materialPlanner";
import { materialInputsFromProjection } from "./projectionPlanning";
import { createProjectionViewContentHash } from "./projectionContentHash";
import {
  combineZipChunks,
  createZipCollector,
  createZipStreamWriter,
  MAX_ZIP32_OUTPUT_BYTES,
  type ZipChunkSink,
} from "./zipStream";

export { MAX_ZIP32_OUTPUT_BYTES } from "./zipStream";

type Point = [number, number, number];

export interface ExportBundleOptions {
  name?: string;
  guideLocale?: LocaleCode;
  partSize?: number | Point;
  includeSchematic?: boolean;
  includeMcstructure?: boolean;
  includeMcfunction?: boolean;
  schematic?: SchematicExportOptions;
  mcstructure?: McstructureExportOptions;
  mcfunction?: McfunctionExportOptions;
  litematic?: LitematicExportOptions;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  maxWorkingBytes?: number;
  onProgress?: (progress: ExportBundleProgress) => void;
  safety?: JavaProjectionExportSafetyInput;
}

export type ExportBundlePhase = "preparing" | "overall" | "parts" | "behaviorPack" | "metadata" | "complete";
export type ExportBundleFileStatus = "started" | "completed" | "failed";

export interface ExportBundleProgress {
  phase: ExportBundlePhase;
  progress: number;
  completedParts: number;
  totalParts: number;
  currentFile?: string;
  currentFileStatus?: ExportBundleFileStatus;
  fileStartedAt?: string;
  fileFinishedAt?: string;
  fileDurationMs?: number;
  completedFiles: number;
  bytesWritten: number;
}

export interface ExportBundleResourceEstimate {
  blockCount: number;
  occupiedRegionVolume: number;
  partCount: number;
  paletteSize: number;
  bitsPerBlock: number;
  packedBlockStateBytes: number;
  largestRegionVolume: number;
  largestRegionStagingBytes: number;
  nbtGzipDuplicationBytes: number;
  baseWorkingBytes: number;
  documentWorkingBytes: number;
  partMetadataBytes: number;
  mcfunctionWorkingBytes: number;
  estimatedWorkingBytes: number;
  workingBudgetBytes: number;
  allowed: boolean;
  requiresConfirmation: boolean;
}

export type ExportBundleChunkSink = ZipChunkSink;

export interface ExportBundlePart {
  id: string;
  index: Point;
  bounds: ProjectionView["bounds"];
  occupiedBounds: ProjectionView["occupiedBounds"];
  blockCount: number;
  buildOrder: number;
  contentHash: string;
  relativeOffset: Point;
  files: {
    litematic: string;
    schematic?: string;
    mcstructure?: string;
  };
}

export interface ExportBundle {
  bytes: Uint8Array;
  manifest: {
    format: "MELYExportBundle";
    version: 1;
    name: string;
    projection: {
      format: ProjectionDocument["format"];
      version: ProjectionDocument["version"];
      edition: ProjectionDocument["edition"];
      minecraftVersion: string;
      bounds: ProjectionDocument["bounds"];
      blockCount: number;
      palette: ProjectionBlockState[];
      height: {
        mode: string;
        targetHeight: number;
        actualHeight: number;
        recommendedBottomY: number;
        highestOccupiedY: number;
        targetDimensionMinY: number | null;
        targetDimensionMaxY: number | null;
        thirdPartyDatapackDisclaimer: string;
      };
    };
    anchor: Point;
    litematic: {
      overall: string;
      targetMinecraftVersion: string;
      serializerMinecraftVersion: string;
      dataVersion: number;
      formatVersion: number;
      subVersion: number;
      compatibilityLevel: JavaCompatibilityLevel;
      compatibilityWarningCode: JavaCompatibilityWarningCode | null;
    };
    guides: {
      locale: LocaleCode;
      readme: string;
      coordinatesJson: string;
      coordinatesText: string;
      materials: string;
      chests: string;
    };
    parts: ExportBundlePart[];
    behaviorPack?: {
      root: string;
      entryFunction: string;
    };
  };
  summary: {
    partCount: number;
    fileCount: number;
    byteLength: number;
  };
}

export interface StreamedExportBundle extends Omit<ExportBundle, "bytes"> {}

export const DEFAULT_BUNDLE_WORKING_BUDGET_BYTES = 768 * 1024 ** 2;
/** Web 内存保留风险的提示阈值，不是 ZIP 写入上限。 */
export const DEFAULT_WEB_BUNDLE_OUTPUT_BUDGET_BYTES = 512 * 1024 ** 2;
const SYNC_BUNDLE_WORKING_BUDGET_BYTES = 256 * 1024 ** 2;
const BUNDLE_BASE_WORKING_BYTES = 96 * 1024 ** 2;
const REGION_STAGING_BYTES_PER_BLOCK = 12;
const NBT_GZIP_DUPLICATION_FACTOR = 4;
const DOCUMENT_BYTES_PER_BLOCK = 56;
const PART_METADATA_BYTES = 12 * 1024;

interface ExportBundlePlan {
  name: string;
  slug: string;
  anchor: Point;
  overallLitematic: string;
  views: ProjectionView[];
  parts: ExportBundlePart[];
  includeSchematic: boolean;
  includeMcstructure: boolean;
  includeMcfunction: boolean;
  litematic: {
    targetMinecraftVersion: string;
    serializerMinecraftVersion: string;
    dataVersion: number;
    formatVersion: number;
    subVersion: number;
    compatibilityLevel: JavaCompatibilityLevel;
    compatibilityWarningCode: JavaCompatibilityWarningCode | null;
  };
  height: {
    mode: string;
    targetHeight: number;
    actualHeight: number;
    placementBottomY: number;
    placementTopY: number;
    targetDimensionMinY: number | null;
    targetDimensionMaxY: number | null;
  };
}

const GUIDE_FILES = {
  readme: "README.txt",
  coordinatesJson: "coordinates.json",
  coordinatesText: "coordinates.txt",
  materials: "planning/materials.json",
  chests: "planning/chests.json",
} as const;

const normalizeName = (value: string | undefined) => {
  const normalized = value?.normalize("NFKC").trim();
  return normalized || "MELY Projection";
};

const fileSlug = (value: string) => value
  .normalize("NFKC")
  .toLowerCase()
  .replace(/[^a-z0-9_.-]+/g, "_")
  .replace(/^[_.-]+|[_.-]+$/g, "") || "mely_projection";

const partDocument = (document: ProjectionDocument, view: ProjectionView) =>
  createProjectionDocument(
    iterateProjectionViewBlocks(document, view),
    document.palette,
    {
      edition: document.edition,
      minecraftVersion: document.minecraftVersion,
      metadata: document.metadata,
    },
  );

const coordinatesText = (
  locale: LocaleCode,
  name: string,
  anchor: Point,
  parts: readonly ExportBundlePart[],
  entryFunction?: string,
) => {
  const t = (key: TranslationKey, params: TranslationParams = {}) => translate(locale, key, params);
  const number = new Intl.NumberFormat(locale);
  const lines = [
    t("export.guide.coordinatesTitle", { name }),
    t("export.guide.anchor", { coordinates: anchor.join(" ") }),
    t("export.guide.placementHint"),
  ];
  parts.forEach((part) => {
    lines.push(
      t("export.guide.partLine", {
        order: part.buildOrder,
        id: part.id,
        origin: part.occupiedBounds.min.join(" "),
        offset: part.relativeOffset.join(" "),
        blocks: number.format(part.blockCount),
        hash: part.contentHash,
      }),
    );
  });
  if (entryFunction) {
    lines.push(t("export.guide.behaviorPack", { function: entryFunction }));
  }
  return `${lines.join("\n")}\n`;
};

const bundleReadmeText = (
  locale: LocaleCode,
  name: string,
  document: ProjectionDocument,
  plan: ExportBundlePlan,
  materials: MaterialPlan,
  entryFunction?: string,
) => {
  const t = (key: TranslationKey, params: TranslationParams = {}) => translate(locale, key, params);
  const number = new Intl.NumberFormat(locale);
  const dimensions = document.bounds?.dimensions ?? [0, 0, 0];
  const lines = [
    t("export.guide.readmeTitle"),
    t("export.guide.project", { name }),
    "",
    t("export.guide.summaryTitle"),
    t("export.guide.blockCount", { count: number.format(document.blockCount) }),
    t("export.guide.dimensions", { dimensions: dimensions.join(" x ") }),
    `Minecraft Java: ${document.minecraftVersion}`,
    ...(plan.litematic.compatibilityWarningCode
      ? [
          `Compatibility warning: ${plan.litematic.compatibilityWarningCode}.`,
          `Target Java ${plan.litematic.targetMinecraftVersion} is untested; files use Java ${plan.litematic.serializerMinecraftVersion} serializer metadata (DataVersion ${plan.litematic.dataVersion}). Community validation is required.`,
        ]
      : []),
    `Placement Y: ${plan.height.placementBottomY}..${plan.height.placementTopY}`,
    typeof document.metadata?.heightDisclaimer === "string" ? document.metadata.heightDisclaimer : "",
    t("export.guide.largeChests", { count: number.format(materials.totalLargeChests) }),
    t("export.guide.shulkerBoxes", { count: number.format(materials.totalShulkerBoxes) }),
    "",
    t("export.guide.materialsTitle"),
  ];

  materials.requirements.forEach((material) => {
    lines.push(t("export.guide.materialLine", {
      block: material.blockId,
      category: t(`survival.category.${material.category}` as TranslationKey),
      count: number.format(material.count),
      shulkers: number.format(material.shulkerBoxes),
      stacks: number.format(material.stacks),
      loose: number.format(material.looseItems),
    }));
  });

  lines.push("", t("export.guide.chestsTitle"));
  if (materials.chests.length === 0) {
    lines.push(t("export.guide.noChests"));
  } else {
    materials.chests.forEach((chest) => {
      lines.push(t("export.guide.chestHeader", {
        index: number.format(chest.index),
        used: number.format(chest.usedSlots),
        free: number.format(chest.freeSlots),
      }));
      chest.allocations.forEach((allocation) => {
        lines.push(t("export.guide.chestAllocation", {
          start: number.format(allocation.startSlot),
          end: number.format(allocation.startSlot + allocation.slotCount - 1),
          block: allocation.blockId,
          count: number.format(allocation.itemCount),
        }));
      });
    });
  }

  lines.push(
    "",
    t("export.guide.partsTitle"),
    t("export.guide.anchor", { coordinates: plan.anchor.join(" ") }),
    t("export.guide.placementHint"),
  );
  plan.parts.forEach((part) => {
    lines.push(t("export.guide.partLine", {
      order: part.buildOrder,
      id: part.id,
      origin: part.occupiedBounds.min.join(" "),
      offset: part.relativeOffset.join(" "),
      blocks: number.format(part.blockCount),
      hash: part.contentHash,
    }));
  });
  if (entryFunction) lines.push("", t("export.guide.behaviorPack", { function: entryFunction }));
  return `${lines.join("\n")}\n`;
};

const materialPlanJson = (materials: MaterialPlan) => `${JSON.stringify({
  generator: "MELY",
  format: "MELYMaterialPlan",
  version: 1,
  totalBlocks: materials.totalBlocks,
  totalStorageSlots: materials.totalStorageSlots,
  totalLargeChests: materials.totalLargeChests,
  totalShulkerBoxes: materials.totalShulkerBoxes,
  requirements: materials.requirements,
}, null, 2)}\n`;

const chestPlanJson = (materials: MaterialPlan) => `${JSON.stringify({
  generator: "MELY",
  format: "MELYChestPlan",
  version: 1,
  totalLargeChests: materials.totalLargeChests,
  chests: materials.chests,
}, null, 2)}\n`;

const createBundleGuideFiles = (
  document: ProjectionDocument,
  plan: ExportBundlePlan,
  locale: LocaleCode,
  behaviorPack?: ExportBundle["manifest"]["behaviorPack"],
) => {
  const materials = createMaterialPlan(materialInputsFromProjection(document));
  return [
    {
      path: GUIDE_FILES.readme,
      content: bundleReadmeText(
        locale,
        plan.name,
        document,
        plan,
        materials,
        behaviorPack?.entryFunction,
      ),
    },
    {
      path: GUIDE_FILES.coordinatesJson,
      content: `${JSON.stringify({ anchor: plan.anchor, parts: plan.parts }, null, 2)}\n`,
    },
    {
      path: GUIDE_FILES.coordinatesText,
      content: coordinatesText(
        locale,
        plan.name,
        plan.anchor,
        plan.parts,
        behaviorPack?.entryFunction,
      ),
    },
    { path: GUIDE_FILES.materials, content: materialPlanJson(materials) },
    { path: GUIDE_FILES.chests, content: chestPlanJson(materials) },
  ] as const;
};

const createBundlePlan = (
  document: ProjectionDocument,
  options: ExportBundleOptions,
  safety: ReturnType<typeof assertJavaProjectionExportSafety>,
): ExportBundlePlan => {
  if (!document.bounds || document.blockCount === 0) {
    throw new RangeError("Cannot bundle an empty projection");
  }
  const name = normalizeName(options.name);
  const slug = fileSlug(name);
  const anchor = [...document.bounds.min] as Point;
  const includeSchematic = options.includeSchematic ?? false;
  const includeMcstructure = options.includeMcstructure ?? false;
  const includeMcfunction = options.includeMcfunction ?? false;
  const views = splitProjectionViews(document, options.partSize ?? [32, 32, 32]);
  const targetDimension = safety.input.targetDimension
    ?? safety.compatibility.effectiveDefaultDimension;
  const litematicAdapter = safety.serializerProfile.exporters.litematic;
  if (!litematicAdapter) {
    throw new RangeError("Litematica export has no compatible serializer");
  }
  const parts = views.map((view, index): ExportBundlePart => {
    const id = `part_${index.toString().padStart(4, "0")}`;
    const root = `parts/${id}/${slug}_${id}`;
    return {
      id,
      index: [...view.index],
      bounds: view.bounds,
      occupiedBounds: view.occupiedBounds,
      blockCount: view.blockCount,
      buildOrder: index + 1,
      contentHash: createProjectionViewContentHash(document, view),
      relativeOffset: view.occupiedBounds.min.map((value, axis) =>
        value - anchor[axis]) as Point,
      files: {
        litematic: `${root}.litematic`,
        ...(includeSchematic ? { schematic: `${root}.schem` } : {}),
        ...(includeMcstructure ? { mcstructure: `${root}.mcstructure` } : {}),
      },
    };
  });
  return {
    name,
    slug,
    anchor,
    overallLitematic: `litematica/${slug}.litematic`,
    views,
    parts,
    includeSchematic,
    includeMcstructure,
    includeMcfunction,
    litematic: {
      targetMinecraftVersion: safety.requestedProfile.id,
      serializerMinecraftVersion: safety.serializerProfile.id,
      dataVersion: safety.serializerProfile.dataVersion,
      formatVersion: litematicAdapter.formatVersion,
      subVersion: litematicAdapter.subVersion ?? 0,
      compatibilityLevel: safety.compatibility.level,
      compatibilityWarningCode: safety.compatibility.warningCode,
    },
    height: {
      mode: safety.preflight.mode,
      targetHeight: safety.preflight.targetHeight,
      actualHeight: safety.preflight.actualHeight,
      placementBottomY: safety.preflight.placementMinY,
      placementTopY: safety.preflight.placementMaxY,
      targetDimensionMinY: targetDimension?.minY ?? null,
      targetDimensionMaxY: targetDimension
        ? targetDimension.minY + targetDimension.height - 1
        : null,
    },
  };
};

const assertBundleExportSafety = (
  document: ProjectionDocument,
  options: ExportBundleOptions,
) => {
  const result = assertJavaProjectionExportSafety(document, "bundle", options.safety);
  if (options.includeSchematic && !result.serializerProfile.exporters.spongeSchematic) {
    throw new RangeError(
      `EXPORT_FORMAT_UNSUPPORTED_FOR_VERSION: Sponge schematic export has no compatible serializer for Minecraft Java ${result.requestedProfile.id}`,
    );
  }
  return result;
};

const buildManifest = (
  document: ProjectionDocument,
  plan: ExportBundlePlan,
  guideLocale: LocaleCode,
  behaviorPack?: ExportBundle["manifest"]["behaviorPack"],
): ExportBundle["manifest"] => ({
  format: "MELYExportBundle",
  version: 1,
  name: plan.name,
  projection: {
    format: document.format,
    version: document.version,
    edition: document.edition,
    minecraftVersion: document.minecraftVersion,
    bounds: document.bounds,
    blockCount: document.blockCount,
    palette: document.palette,
    height: {
      mode: plan.height.mode,
      targetHeight: plan.height.targetHeight,
      actualHeight: plan.height.actualHeight,
      recommendedBottomY: plan.height.placementBottomY,
      highestOccupiedY: plan.height.placementTopY,
      targetDimensionMinY: plan.height.targetDimensionMinY,
      targetDimensionMaxY: plan.height.targetDimensionMaxY,
      thirdPartyDatapackDisclaimer: typeof document.metadata?.heightDisclaimer === "string"
        ? document.metadata.heightDisclaimer
        : "",
    },
  },
  anchor: plan.anchor,
  litematic: {
    overall: plan.overallLitematic,
    ...plan.litematic,
  },
  guides: {
    locale: guideLocale,
    readme: GUIDE_FILES.readme,
    coordinatesJson: GUIDE_FILES.coordinatesJson,
    coordinatesText: GUIDE_FILES.coordinatesText,
    materials: GUIDE_FILES.materials,
    chests: GUIDE_FILES.chests,
  },
  parts: plan.parts,
  ...(behaviorPack ? { behaviorPack } : {}),
});

const regionVolume = (view: ProjectionView) => view.bounds.dimensions.reduce(
  (volume, dimension) => volume * dimension,
  1,
);

const safeProduct = (...values: number[]) => {
  let product = 1;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || product > Number.MAX_SAFE_INTEGER / value) {
      return Number.POSITIVE_INFINITY;
    }
    product *= value;
  }
  return product;
};

const safeSum = (...values: number[]) => {
  let sum = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || sum > Number.MAX_SAFE_INTEGER - value) {
      return Number.POSITIVE_INFINITY;
    }
    sum += value;
  }
  return sum;
};

const packedBlockStateBytes = (volume: number, bitsPerBlock: number) => {
  const bitCount = safeProduct(volume, bitsPerBlock);
  if (!Number.isSafeInteger(bitCount)) return Number.POSITIVE_INFINITY;
  return safeProduct(Math.ceil(bitCount / 64), 8);
};

export const estimateExportBundleResources = (
  document: ProjectionDocument,
  options: ExportBundleOptions = {},
): ExportBundleResourceEstimate => {
  if (!document.bounds || document.blockCount === 0) {
    throw new RangeError("Cannot bundle an empty projection");
  }
  const views = splitProjectionViews(document, options.partSize ?? [32, 32, 32]);
  const paletteSize = document.palette.length + 1;
  const bitsPerBlock = Math.max(2, Math.ceil(Math.log2(Math.max(1, paletteSize))));
  let occupiedRegionVolume = 0;
  let packedBytes = 0;
  let largestRegionVolume = 0;
  for (const view of views) {
    const volume = regionVolume(view);
    occupiedRegionVolume = safeSum(occupiedRegionVolume, volume);
    packedBytes = safeSum(packedBytes, packedBlockStateBytes(volume, bitsPerBlock));
    largestRegionVolume = Math.max(largestRegionVolume, volume);
  }
  const partCount = views.length;
  const largestChunkBlocks = document.chunks.reduce(
    (largest, chunk) => Math.max(largest, chunk.positions.length),
    0,
  );
  const configuredCommandLimit = options.mcfunction?.maxCommandsPerFunction;
  const leafCommandLimit = Number.isSafeInteger(configuredCommandLimit)
    && configuredCommandLimit !== undefined
    && configuredCommandLimit >= 2
    ? configuredCommandLimit
    : 10_000;
  const mcfunctionWorkingBytes = (options.includeMcfunction ?? false)
    ? safeSum(
        safeProduct(largestChunkBlocks, 384),
        safeProduct(Math.min(largestChunkBlocks, leafCommandLimit), 128),
        safeProduct(document.chunks.length, 192),
      )
    : 0;
  const largestRegionStagingBytes = safeProduct(
    largestRegionVolume,
    REGION_STAGING_BYTES_PER_BLOCK,
  );
  const nbtGzipDuplicationBytes = safeProduct(packedBytes, NBT_GZIP_DUPLICATION_FACTOR);
  const documentWorkingBytes = safeProduct(document.blockCount, DOCUMENT_BYTES_PER_BLOCK);
  const partMetadataBytes = safeProduct(partCount, PART_METADATA_BYTES);
  const estimatedWorkingBytes = safeSum(
    BUNDLE_BASE_WORKING_BYTES,
    packedBytes,
    largestRegionStagingBytes,
    nbtGzipDuplicationBytes,
    documentWorkingBytes,
    partMetadataBytes,
    mcfunctionWorkingBytes,
  );
  const maximum = options.maxWorkingBytes ?? DEFAULT_BUNDLE_WORKING_BUDGET_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum <= 0) {
    throw new RangeError("Export bundle working-set warning threshold must be a positive safe integer");
  }
  return {
    blockCount: document.blockCount,
    occupiedRegionVolume,
    partCount,
    paletteSize,
    bitsPerBlock,
    packedBlockStateBytes: packedBytes,
    largestRegionVolume,
    largestRegionStagingBytes,
    nbtGzipDuplicationBytes,
    baseWorkingBytes: BUNDLE_BASE_WORKING_BYTES,
    documentWorkingBytes,
    partMetadataBytes,
    mcfunctionWorkingBytes,
    estimatedWorkingBytes,
    workingBudgetBytes: maximum,
    allowed: Number.isSafeInteger(estimatedWorkingBytes),
    requiresConfirmation: Number.isSafeInteger(estimatedWorkingBytes)
      && estimatedWorkingBytes > maximum,
  };
};

const assertBundleResources = (
  document: ProjectionDocument,
  options: ExportBundleOptions,
) => {
  const estimate = estimateExportBundleResources(document, options);
  if (!estimate.allowed) {
    throw new RangeError("Export bundle working-set estimate exceeds the safe integer range");
  }
  return estimate;
};

const abortReason = (signal: AbortSignal) => signal.reason instanceof Error
  ? signal.reason
  : new DOMException("Export bundle generation was cancelled", "AbortError");

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw abortReason(signal);
};

const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

class ExportBundleFileError extends AppError {
  override readonly cause: unknown;

  constructor(file: string, cause: unknown) {
    super("error.export.bundleFile", { file });
    this.cause = cause;
  }
}

export const createExportBundleStream = async (
  document: ProjectionDocument,
  sink: ExportBundleChunkSink,
  options: ExportBundleOptions = {},
): Promise<StreamedExportBundle> => {
  const safety = assertBundleExportSafety(document, options);
  assertBundleResources(document, options);
  const plan = createBundlePlan(document, options, safety);
  const guideLocale = options.guideLocale ?? DEFAULT_LOCALE;
  let latestBytes = 0;
  let completedFiles = 0;
  const report = (
    phase: ExportBundlePhase,
    progress: number,
    completedParts: number,
    currentFile?: string,
    currentFileStatus?: ExportBundleFileStatus,
    timing?: {
      fileStartedAt: string;
      fileFinishedAt?: string;
      fileDurationMs?: number;
    },
  ) => options.onProgress?.({
    phase,
    progress: Math.max(0, Math.min(1, progress)),
    completedParts,
    totalParts: plan.parts.length,
    ...(currentFile ? { currentFile } : {}),
    ...(currentFileStatus ? { currentFileStatus } : {}),
    ...timing,
    completedFiles,
    bytesWritten: latestBytes,
  });
  const writer = createZipStreamWriter(sink, options, (bytes) => {
    latestBytes = bytes;
  });
  const addFile = async (
    phase: ExportBundlePhase,
    progress: number,
    completedParts: number,
    path: string,
    createBytes: Uint8Array | (() => Uint8Array | Promise<Uint8Array>),
    compress: boolean,
  ) => {
    const startedAtMs = Date.now();
    const fileStartedAt = new Date(startedAtMs).toISOString();
    report(phase, progress, completedParts, path, "started", { fileStartedAt });
    try {
      const bytes = typeof createBytes === "function" ? await createBytes() : createBytes;
      await writer.add(path, bytes, compress);
    } catch (error) {
      const finishedAtMs = Date.now();
      report(phase, progress, completedParts, path, "failed", {
        fileStartedAt,
        fileFinishedAt: new Date(finishedAtMs).toISOString(),
        fileDurationMs: Math.max(0, finishedAtMs - startedAtMs),
      });
      if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw error;
      }
      if (error instanceof AppError) throw error;
      throw new ExportBundleFileError(path, error);
    }
    completedFiles += 1;
    const finishedAtMs = Date.now();
    report(phase, progress, completedParts, path, "completed", {
      fileStartedAt,
      fileFinishedAt: new Date(finishedAtMs).toISOString(),
      fileDurationMs: Math.max(0, finishedAtMs - startedAtMs),
    });
  };

  try {
    throwIfAborted(options.signal);
    report("preparing", 0.01, 0);
    await addFile("overall", 0.08, 0, plan.overallLitematic, () =>
      createLitematicFromDocument(document, {
        ...options.litematic,
        name: options.litematic?.name ?? plan.name,
        regionMaxSize: 32,
        safety: options.safety,
      }).bytes, false);
    await yieldToEventLoop();

    for (let index = 0; index < plan.views.length; index += 1) {
      throwIfAborted(options.signal);
      const view = plan.views[index];
      const descriptor = plan.parts[index];
      const part = partDocument(document, view);
      if (!part.bounds) continue;
      const partProgress = 0.08 + 0.7 * ((index + 1) / Math.max(1, plan.parts.length));
      await addFile("parts", partProgress, index, descriptor.files.litematic, () =>
        createLitematicFromDocument(part, {
          ...options.litematic,
          name: `${options.litematic?.name ?? plan.name} ${descriptor.id}`,
          regionMaxSize: 32,
          safety: options.safety,
        }).bytes, false);
      if (descriptor.files.schematic) {
        await addFile("parts", partProgress, index, descriptor.files.schematic, () =>
          createSchematic(part, {
            ...options.schematic,
            name: `${plan.name} ${descriptor.id}`,
            safety: options.safety,
          }).bytes, false);
      }
      if (descriptor.files.mcstructure) {
        await addFile(
          "parts",
          partProgress,
          index,
          descriptor.files.mcstructure,
          () => createMcstructure(deriveBedrockProjectionDocument(part), options.mcstructure).bytes,
          true,
        );
      }
      const completedParts = index + 1;
      report("parts", partProgress, completedParts);
      await yieldToEventLoop();
    }

    let behaviorPack: ExportBundle["manifest"]["behaviorPack"];
    if (plan.includeMcfunction) {
      const root = "behavior_pack";
      let streamedFiles = 0;
      const functions = await streamMcfunctionBehaviorPack(deriveBedrockProjectionDocument(document), {
        ...options.mcfunction,
        packName: options.mcfunction?.packName ?? plan.name,
      }, async (file) => {
        throwIfAborted(options.signal);
        await addFile(
          "behaviorPack",
          0.9,
          plan.parts.length,
          `${root}/${file.path}`,
          strToU8(file.content),
          true,
        );
        streamedFiles += 1;
        if ((streamedFiles & 31) === 0) await yieldToEventLoop();
      });
      await addFile(
        "behaviorPack",
        0.9,
        plan.parts.length,
        `${root}/manifest.json`,
        strToU8(`${JSON.stringify(functions.manifest, null, 2)}\n`),
        true,
      );
      behaviorPack = { root, entryFunction: functions.entryFunction };
      report("behaviorPack", 0.9, plan.parts.length, behaviorPack.entryFunction);
    }

    const manifest = buildManifest(document, plan, guideLocale, behaviorPack);
    await addFile(
      "metadata",
      0.94,
      plan.parts.length,
      "bundle.json",
      strToU8(`${JSON.stringify(manifest, null, 2)}\n`),
      true,
    );
    for (const guide of createBundleGuideFiles(document, plan, guideLocale, behaviorPack)) {
      await addFile(
        "metadata",
        0.98,
        plan.parts.length,
        guide.path,
        strToU8(guide.content),
        true,
      );
    }
    report("metadata", 0.98, plan.parts.length, "bundle.json");
    const summary = await writer.close();
    report("complete", 1, plan.parts.length);
    return {
      manifest,
      summary: {
        partCount: plan.parts.length,
        fileCount: summary.fileCount,
        byteLength: summary.bytesWritten,
      },
    };
  } catch (error) {
    writer.abort();
    throw error;
  }
};

export const createExportBundleAsync = async (
  document: ProjectionDocument,
  options: ExportBundleOptions = {},
): Promise<ExportBundle> => {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const streamed = await createExportBundleStream(document, (chunk) => {
    chunks.push(chunk);
    byteLength += chunk.byteLength;
  }, {
    ...options,
    maxOutputBytes: options.maxOutputBytes,
  });
  return {
    ...streamed,
    bytes: combineZipChunks(chunks, byteLength),
  };
};

export const createExportBundle = (
  document: ProjectionDocument,
  options: ExportBundleOptions = {},
): ExportBundle => {
  const safety = assertBundleExportSafety(document, options);
  assertBundleResources(document, {
    ...options,
    maxWorkingBytes: options.maxWorkingBytes ?? SYNC_BUNDLE_WORKING_BUDGET_BYTES,
  });
  if (!document.bounds || document.blockCount === 0) {
    throw new RangeError("Cannot bundle an empty projection");
  }
  const plan = createBundlePlan(document, options, safety);
  const guideLocale = options.guideLocale ?? DEFAULT_LOCALE;
  const archive = createZipCollector({ maxOutputBytes: options.maxOutputBytes });
  archive.add(plan.overallLitematic, createLitematicFromDocument(document, {
    ...options.litematic,
    name: options.litematic?.name ?? plan.name,
    regionMaxSize: 32,
    safety: options.safety,
  }).bytes, false);
  plan.views.forEach((view, index) => {
    const part = partDocument(document, view);
    if (!part.bounds) return;
    const descriptor = plan.parts[index];
    archive.add(descriptor.files.litematic, createLitematicFromDocument(part, {
      ...options.litematic,
      name: `${options.litematic?.name ?? plan.name} ${descriptor.id}`,
      regionMaxSize: 32,
      safety: options.safety,
    }).bytes, false);
    if (descriptor.files.schematic) {
      archive.add(descriptor.files.schematic, createSchematic(part, {
        ...options.schematic,
        name: `${plan.name} ${descriptor.id}`,
        safety: options.safety,
      }).bytes, false);
    }
    if (descriptor.files.mcstructure) {
      archive.add(
        descriptor.files.mcstructure,
        createMcstructure(deriveBedrockProjectionDocument(part), options.mcstructure).bytes,
        true,
      );
    }
  });

  let behaviorPack: ExportBundle["manifest"]["behaviorPack"];
  if (plan.includeMcfunction) {
    const iterator = iterateMcfunctionBehaviorPackFiles(deriveBedrockProjectionDocument(document), {
      ...options.mcfunction,
      packName: options.mcfunction?.packName ?? plan.name,
    });
    const root = "behavior_pack";
    while (true) {
      const next = iterator.next();
      if (next.done === true) {
        archive.add(
          `${root}/manifest.json`,
          strToU8(`${JSON.stringify(next.value.manifest, null, 2)}\n`),
          true,
        );
        behaviorPack = { root, entryFunction: next.value.entryFunction };
        break;
      }
      archive.add(`${root}/${next.value.path}`, strToU8(next.value.content), true);
    }
  }

  const manifest = buildManifest(document, plan, guideLocale, behaviorPack);
  archive.add("bundle.json", strToU8(`${JSON.stringify(manifest, null, 2)}\n`), true);
  createBundleGuideFiles(document, plan, guideLocale, behaviorPack).forEach((guide) => {
    archive.add(guide.path, strToU8(guide.content), true);
  });
  const completed = archive.close();
  const bytes = completed.bytes;
  return {
    bytes,
    manifest,
    summary: {
      partCount: plan.parts.length,
      fileCount: completed.summary.fileCount,
      byteLength: bytes.byteLength,
    },
  };
};

export const createProjectionExportBundle = createExportBundle;
