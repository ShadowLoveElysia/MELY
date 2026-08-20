import type { HeightMode } from "../core/heightSafety";
import {
  decodeSolidVoxelResultBatchEnvelope,
  SolidVoxelResultEnvelopeError,
  type SolidVoxelResultBatchEnvelope,
} from "../core/solidVoxelResultEnvelope";
import type { SolidOptions } from "../types";
import { TauriSolidVoxelClientError } from "./tauriSolidVoxelError";
import type { TauriSolidVoxelTransport } from "./tauriSolidVoxelTransport";

export {
  TauriSolidVoxelClientError,
} from "./tauriSolidVoxelError";
export type { TauriSolidVoxelClientErrorKind } from "./tauriSolidVoxelError";
export { createDefaultTauriSolidVoxelTransport } from "./tauriSolidVoxelTransport";
export type { TauriSolidVoxelTransport } from "./tauriSolidVoxelTransport";

export const CREATE_SOLID_VOXEL_JOB_COMMAND = "create_solid_voxel_job";
export const UPLOAD_SOLID_VOXEL_SNAPSHOT_COMMAND = "upload_solid_voxel_snapshot";
export const SOLID_VOXEL_JOB_STATUS_COMMAND = "solid_voxel_job_status";
export const CANCEL_SOLID_VOXEL_JOB_COMMAND = "cancel_solid_voxel_job";
export const RELEASE_SOLID_VOXEL_JOB_COMMAND = "release_solid_voxel_job";
export const GET_SOLID_VOXEL_PREVIEW_COMMAND = "get_solid_voxel_preview";
export const PULL_SOLID_VOXEL_CHUNKS_COMMAND = "pull_solid_voxel_chunks";
export const WRITE_SOLID_VOXEL_LITEMATIC_COMMAND = "write_solid_voxel_litematic";

export const MAX_SOLID_VOXEL_PREVIEW_POINTS = 200_000;
export const MIN_SOLID_VOXEL_BATCH_BYTES = 8 * 1024 * 1024;
export const DEFAULT_SOLID_VOXEL_BATCH_BYTES = 16 * 1024 * 1024;
export const MAX_SOLID_VOXEL_BATCH_BYTES = 32 * 1024 * 1024;

export type SolidVoxelJobId = bigint;
export type SolidVoxelJobState =
  | "awaitingUpload"
  | "running"
  | "completed"
  | "cancelled"
  | "failed";

export type NativeSolidVoxelErrorCategory =
  | "validation"
  | "unsupported"
  | "cancelled"
  | "busy"
  | "internal";

export interface NativeSolidVoxelError {
  code: string;
  category: NativeSolidVoxelErrorCategory;
  retryable: boolean;
  message?: string;
}

/** 原生 command 与支持矩阵均以完整 SolidOptions 为一次性任务快照。 */
export type SolidVoxelJobOptions = Readonly<SolidOptions>;

export interface CreateSolidVoxelJobRequest {
  workerThreads: number;
  options: SolidVoxelJobOptions;
}

export interface CreatedSolidVoxelJob {
  jobId: SolidVoxelJobId;
  workerThreads: number;
}

export interface SolidVoxelResultHandle {
  id: bigint;
  generation: bigint;
}

export interface SolidVoxelProgress {
  completedUnits: number;
  totalUnits: number;
  fraction: number;
}

export interface SolidVoxelBounds {
  min: [number, number, number];
  max: [number, number, number];
}

export interface SolidVoxelResultManifest {
  blockCount: number;
  surfaceBlockCount: number;
  filledBlockCount: number;
  skinBlockCount: number;
  alphaRejected: number;
  triangleBoxTests: number;
  paletteSize: number;
  dimensions: [number, number, number];
  bounds: SolidVoxelBounds;
  chunkCount: number;
}

export interface SolidVoxelJobStatus {
  jobId: SolidVoxelJobId;
  workerThreads: number;
  state: SolidVoxelJobState;
  progress: SolidVoxelProgress;
  resultHandle?: SolidVoxelResultHandle;
  manifest?: SolidVoxelResultManifest;
  error?: NativeSolidVoxelError;
}

export interface SolidVoxelUploadReceipt {
  jobId: SolidVoxelJobId;
  state: "running";
}

export interface SolidVoxelCancellationReceipt {
  jobId: SolidVoxelJobId;
  cancellationRequested: boolean;
}

export type SolidVoxelPreviewPoint = readonly [number, number, number];

export interface SolidVoxelLimitedPreview {
  handle: SolidVoxelResultHandle;
  points: SolidVoxelPreviewPoint[];
  blockIndices: number[];
  totalPoints: number;
  truncated: boolean;
}

export type SolidVoxelChunkBatch = SolidVoxelResultBatchEnvelope;

export interface NativeLitematicExportSafety {
  heightMode: HeightMode;
  targetHeight: number;
  targetDimension: {
    minY: number;
    height: number;
  };
  placementBottomY: number;
  targetMinecraftVersion: string;
  serializerMinecraftVersion: string;
  dataVersion: number;
  formatVersion: number;
  subVersion: number;
}

export interface WriteNativeSolidVoxelLitematicRequest {
  handle: SolidVoxelResultHandle;
  outputPath: string;
  /** 仅在保存对话框已完成覆盖确认后设为 true。 */
  overwriteExisting: boolean;
  name: string;
  author?: string;
  description?: string;
  regionMaxSize: number | [number, number, number];
  safety: NativeLitematicExportSafety;
}

export interface NativeSolidVoxelLitematicSummary {
  outputPath: string;
  byteLength: number;
  blockCount: number;
  regionCount: number;
  paletteSize: number;
  dimensions: [number, number, number];
  dataVersion: number;
}

export interface NativeSolidVoxelCapabilities {
  writeLitematic: boolean;
}

export interface SolidVoxelReleaseReceipt {
  jobId: SolidVoxelJobId;
  fullyReleased: boolean;
}

export interface TauriSolidVoxelClient {
  createJob(request: CreateSolidVoxelJobRequest): Promise<CreatedSolidVoxelJob>;
  uploadSnapshotEnvelope(jobId: SolidVoxelJobId, envelope: Uint8Array): Promise<SolidVoxelUploadReceipt>;
  getJobStatus(jobId: SolidVoxelJobId): Promise<SolidVoxelJobStatus>;
  cancelJob(jobId: SolidVoxelJobId): Promise<SolidVoxelCancellationReceipt>;
  releaseJob(jobId: SolidVoxelJobId): Promise<SolidVoxelReleaseReceipt>;
  getLimitedPreview(
    handle: SolidVoxelResultHandle,
    maxPoints: number,
  ): Promise<SolidVoxelLimitedPreview>;
  pullResultBatch(
    handle: SolidVoxelResultHandle,
    options?: { cursor?: string; maxBytes?: number },
  ): Promise<SolidVoxelChunkBatch>;
  writeLitematic(
    request: WriteNativeSolidVoxelLitematicRequest,
  ): Promise<NativeSolidVoxelLitematicSummary>;
}

const JOB_STATES = new Set<SolidVoxelJobState>([
  "awaitingUpload",
  "running",
  "completed",
  "cancelled",
  "failed",
]);
const NATIVE_ERROR_CATEGORIES = new Set<NativeSolidVoxelErrorCategory>([
  "validation",
  "unsupported",
  "cancelled",
  "busy",
  "internal",
]);
const DECIMAL_U64_PATTERN = /^[1-9]\d*$/;
const MAX_U64 = (1n << 64n) - 1n;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

const protocolError = (command: string, message: string, cause?: unknown) => (
  new TauriSolidVoxelClientError("protocol", command, message, { cause })
);

const nativeErrorFromRejectedValue = (
  value: unknown,
  command: string,
): NativeSolidVoxelError | null => {
  let candidate: unknown = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  try {
    return parseNativeError(candidate, command);
  } catch {
    return null;
  }
};

const transportError = (command: string, cause: unknown) => (
  cause instanceof TauriSolidVoxelClientError
    ? cause
    : nativeErrorFromRejectedValue(cause, command)
      ? new TauriSolidVoxelClientError(
          "native",
          command,
          `Native solid voxel command failed for ${command}`,
          {
            cause,
            nativeError: nativeErrorFromRejectedValue(cause, command) ?? undefined,
          },
        )
      : new TauriSolidVoxelClientError(
        "transport",
        command,
        `Native solid voxel transport failed for ${command}`,
        { cause },
      )
);

const assertSafeInteger = (
  value: unknown,
  command: string,
  field: string,
  minimum = 0,
): number => {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw protocolError(command, `${field} must be a safe integer >= ${minimum}`);
  }
  return value as number;
};

const assertFiniteNumber = (
  value: unknown,
  command: string,
  field: string,
): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw protocolError(command, `${field} must be finite`);
  }
  return value;
};

const assertBoolean = (value: unknown, command: string, field: string): boolean => {
  if (typeof value !== "boolean") throw protocolError(command, `${field} must be boolean`);
  return value;
};

const assertNonEmptyString = (value: unknown, command: string, field: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw protocolError(command, `${field} must be a non-empty string`);
  }
  return value;
};

const parseJobId = (value: unknown, command: string): SolidVoxelJobId => {
  if (typeof value !== "string" || !DECIMAL_U64_PATTERN.test(value)) {
    throw protocolError(command, "jobId must be a canonical unsigned decimal string");
  }
  const jobId = BigInt(value);
  if (jobId > MAX_U64) throw protocolError(command, "jobId exceeds u64");
  return jobId;
};

const encodeJobId = (jobId: SolidVoxelJobId, command: string): string => {
  if (typeof jobId !== "bigint" || jobId <= 0n || jobId > MAX_U64) {
    throw protocolError(command, "jobId must fit unsigned 64-bit range");
  }
  return jobId.toString(10);
};

const parseTuple = <Length extends number>(
  value: unknown,
  length: Length,
  command: string,
  field: string,
  integer: boolean,
  minimum?: number,
): number[] & { length: Length } => {
  if (!Array.isArray(value) || value.length !== length) {
    throw protocolError(command, `${field} must contain exactly ${length} numbers`);
  }
  const tuple = value.map((entry, index) => integer
    ? assertSafeInteger(entry, command, `${field}[${index}]`, minimum ?? Number.MIN_SAFE_INTEGER)
    : assertFiniteNumber(entry, command, `${field}[${index}]`));
  return tuple as number[] & { length: Length };
};

const parseHandle = (value: unknown, command: string): SolidVoxelResultHandle => {
  if (!isRecord(value)) throw protocolError(command, "result handle must be an object");
  return {
    id: parseJobId(value.id, command),
    generation: parseJobId(value.generation, command),
  };
};

const sameHandle = (left: SolidVoxelResultHandle, right: SolidVoxelResultHandle) => (
  left.id === right.id && left.generation === right.generation
);

const handleArgs = (handle: SolidVoxelResultHandle, command: string) => ({
  id: encodeJobId(handle.id, command),
  generation: encodeJobId(handle.generation, command),
});

const parseProgress = (value: unknown, command: string): SolidVoxelProgress => {
  if (!isRecord(value)) throw protocolError(command, "progress must be an object");
  const completedUnits = assertSafeInteger(value.completedUnits, command, "progress.completedUnits", 0);
  const totalUnits = assertSafeInteger(value.totalUnits, command, "progress.totalUnits", 0);
  const fraction = value.fraction === null && totalUnits === 0
    ? 0
    : assertFiniteNumber(value.fraction, command, "progress.fraction");
  if (completedUnits > totalUnits || fraction < 0 || fraction > 1) {
    throw protocolError(command, "progress is outside its declared range");
  }
  return { completedUnits, totalUnits, fraction };
};

const parseNativeError = (value: unknown, command: string): NativeSolidVoxelError => {
  if (!isRecord(value)) throw protocolError(command, "native error must be an object");
  const category = value.category;
  if (typeof category !== "string" || !NATIVE_ERROR_CATEGORIES.has(category as NativeSolidVoxelErrorCategory)) {
    throw protocolError(command, "native error category is unknown");
  }
  if (value.message !== undefined && typeof value.message !== "string") {
    throw protocolError(command, "native error message must be a string");
  }
  return {
    code: assertNonEmptyString(value.code, command, "error.code"),
    category: category as NativeSolidVoxelErrorCategory,
    retryable: assertBoolean(value.retryable, command, "error.retryable"),
    ...(value.message === undefined ? {} : { message: value.message }),
  };
};

const parseManifest = (value: unknown, command: string): SolidVoxelResultManifest => {
  if (!isRecord(value)) throw protocolError(command, "manifest must be an object");
  if ("chunks" in value || "palette" in value) {
    throw protocolError(command, "manifest must not contain full chunks or palette data");
  }
  if (!isRecord(value.bounds)) throw protocolError(command, "manifest.bounds must be an object");
  const dimensions = parseTuple(
    value.dimensions,
    3,
    command,
    "manifest.dimensions",
    true,
    1,
  ) as [number, number, number];
  const min = parseTuple(
    value.bounds.min,
    3,
    command,
    "manifest.bounds.min",
    true,
  ) as [number, number, number];
  const max = parseTuple(
    value.bounds.max,
    3,
    command,
    "manifest.bounds.max",
    true,
  ) as [number, number, number];
  for (let axis = 0; axis < 3; axis += 1) {
    if (max[axis] < min[axis] || max[axis] - min[axis] + 1 !== dimensions[axis]) {
      throw protocolError(command, "manifest bounds and dimensions are inconsistent");
    }
  }
  return {
    blockCount: assertSafeInteger(value.blockCount, command, "manifest.blockCount", 0),
    surfaceBlockCount: assertSafeInteger(value.surfaceBlockCount, command, "manifest.surfaceBlockCount", 0),
    filledBlockCount: assertSafeInteger(value.filledBlockCount, command, "manifest.filledBlockCount", 0),
    skinBlockCount: assertSafeInteger(value.skinBlockCount, command, "manifest.skinBlockCount", 0),
    alphaRejected: assertSafeInteger(value.alphaRejected, command, "manifest.alphaRejected", 0),
    triangleBoxTests: assertSafeInteger(value.triangleBoxTests, command, "manifest.triangleBoxTests", 0),
    paletteSize: assertSafeInteger(value.paletteSize, command, "manifest.paletteSize", 0),
    dimensions,
    bounds: { min, max },
    chunkCount: assertSafeInteger(value.chunkCount, command, "manifest.chunkCount", 0),
  };
};

const parseStatus = (value: unknown, expectedJobId: bigint): SolidVoxelJobStatus => {
  const command = SOLID_VOXEL_JOB_STATUS_COMMAND;
  if (!isRecord(value)) throw protocolError(command, "job status must be an object");
  const jobId = parseJobId(value.jobId, command);
  if (jobId !== expectedJobId) throw protocolError(command, "job status belongs to another job");
  if (typeof value.state !== "string" || !JOB_STATES.has(value.state as SolidVoxelJobState)) {
    throw protocolError(command, "job status state is unknown");
  }
  const state = value.state as SolidVoxelJobState;
  const status: SolidVoxelJobStatus = {
    jobId,
    workerThreads: assertSafeInteger(value.workerThreads, command, "workerThreads", 1),
    state,
    progress: parseProgress(value.progress, command),
  };
  if (value.resultHandle !== undefined) status.resultHandle = parseHandle(value.resultHandle, command);
  if (value.manifest !== undefined) status.manifest = parseManifest(value.manifest, command);
  if (value.error !== undefined) status.error = parseNativeError(value.error, command);
  if (state === "completed" && (!status.resultHandle || !status.manifest)) {
    throw protocolError(command, "completed status requires a result handle and manifest");
  }
  if (state === "failed" && !status.error) {
    throw protocolError(command, "failed status requires a native error");
  }
  return status;
};

const validateCreateRequest = (request: CreateSolidVoxelJobRequest) => {
  const command = CREATE_SOLID_VOXEL_JOB_COMMAND;
  const workerThreads = assertSafeInteger(request.workerThreads, command, "workerThreads", 1);
  const options = request.options;
  const targetHeight = assertSafeInteger(options.targetHeight, command, "options.targetHeight", 1);
  const alphaThreshold = assertFiniteNumber(options.alphaThreshold, command, "options.alphaThreshold");
  if (alphaThreshold < 0 || alphaThreshold > 1) {
    throw protocolError(command, "options.alphaThreshold must be between 0 and 1");
  }
  if (options.fillMode !== "shell" && options.fillMode !== "filled") {
    throw protocolError(command, "options.fillMode is unknown");
  }
  if (options.palettePreset !== "balanced" && options.palettePreset !== "clean") {
    throw protocolError(command, "options.palettePreset is unknown");
  }
  if (!(["off", "balanced", "strong"] as const).includes(options.faceDetail)) {
    throw protocolError(command, "options.faceDetail is unknown");
  }
  if (!(["original", "greekMarble", "steampunk", "ancientRuins"] as const).includes(
    options.materialTheme,
  )) {
    throw protocolError(command, "options.materialTheme is unknown");
  }
  const dithering = assertFiniteNumber(options.dithering, command, "options.dithering");
  const ruinDecoration = assertFiniteNumber(
    options.ruinDecoration,
    command,
    "options.ruinDecoration",
  );
  if (dithering < 0 || dithering > 100 || ruinDecoration < 0 || ruinDecoration > 100) {
    throw protocolError(command, "percentage options must be between 0 and 100");
  }
  const integerIndices = (value: unknown, field: string) => {
    if (!Array.isArray(value)) throw protocolError(command, `${field} must be an array`);
    const seen = new Set<number>();
    const result = value.map((entry, index) => {
      const normalized = assertSafeInteger(entry, command, `${field}[${index}]`, 0);
      if (seen.has(normalized)) throw protocolError(command, `${field} contains duplicates`);
      seen.add(normalized);
      return normalized;
    });
    return result;
  };
  return {
    workerThreads,
    options: {
      targetHeight,
      alphaThreshold,
      thicknessCompensation: assertFiniteNumber(
        options.thicknessCompensation,
        command,
        "options.thicknessCompensation",
      ),
      fillMode: options.fillMode,
      palettePreset: options.palettePreset,
      faceDetail: options.faceDetail,
      materialTheme: options.materialTheme,
      dithering,
      emissiveMapping: assertBoolean(options.emissiveMapping, command, "options.emissiveMapping"),
      emissiveMaterialIndices: integerIndices(
        options.emissiveMaterialIndices,
        "options.emissiveMaterialIndices",
      ),
      ruinDecoration,
      skinProtection: assertBoolean(options.skinProtection, command, "options.skinProtection"),
      skinMaterialIndices: integerIndices(
        options.skinMaterialIndices,
        "options.skinMaterialIndices",
      ),
      excludeGravity: assertBoolean(options.excludeGravity, command, "options.excludeGravity"),
      excludeRare: assertBoolean(options.excludeRare, command, "options.excludeRare"),
    },
  };
};

const invokeJson = async (
  transport: TauriSolidVoxelTransport,
  command: string,
  args?: Record<string, unknown>,
) => {
  try {
    return await transport.invokeJson(command, args);
  } catch (error) {
    throw transportError(command, error);
  }
};

const invokeRaw = async (
  transport: TauriSolidVoxelTransport,
  command: string,
  bytes: Uint8Array,
) => {
  try {
    return await transport.invokeRaw(command, bytes);
  } catch (error) {
    throw transportError(command, error);
  }
};

const invokeRawResponse = async (
  transport: TauriSolidVoxelTransport,
  command: string,
  args: Record<string, unknown>,
) => {
  try {
    return await transport.invokeRawResponse(command, args);
  } catch (error) {
    throw transportError(command, error);
  }
};

const parseLitematicSummary = (
  value: unknown,
  request: WriteNativeSolidVoxelLitematicRequest,
): NativeSolidVoxelLitematicSummary => {
  const command = WRITE_SOLID_VOXEL_LITEMATIC_COMMAND;
  if (!isRecord(value)) throw protocolError(command, "Litematic summary must be an object");
  if (value.outputPath !== request.outputPath) {
    throw protocolError(command, "Litematic summary output path does not match the request");
  }
  return {
    outputPath: request.outputPath,
    byteLength: assertSafeInteger(value.byteLength, command, "summary.byteLength", 0),
    blockCount: assertSafeInteger(value.blockCount, command, "summary.blockCount", 0),
    regionCount: assertSafeInteger(value.regionCount, command, "summary.regionCount", 0),
    paletteSize: assertSafeInteger(value.paletteSize, command, "summary.paletteSize", 0),
    dimensions: parseTuple(
      value.dimensions,
      3,
      command,
      "summary.dimensions",
      true,
      1,
    ) as [number, number, number],
    dataVersion: assertSafeInteger(value.dataVersion, command, "summary.dataVersion", 0),
  };
};

/**
 * JSON 控制消息、原始上传与原始响应保持为三条独立通道，避免大型 typed array
 * 被意外序列化为普通数字数组。
 */
export const createTauriSolidVoxelClient = (
  transport: TauriSolidVoxelTransport,
  capabilities: NativeSolidVoxelCapabilities = { writeLitematic: false },
): TauriSolidVoxelClient => ({
  async createJob(request) {
    const command = CREATE_SOLID_VOXEL_JOB_COMMAND;
    const normalized = validateCreateRequest(request);
    const response = await invokeJson(transport, command, normalized);
    if (!isRecord(response)) throw protocolError(command, "create response must be an object");
    return {
      jobId: parseJobId(response.jobId, command),
      workerThreads: assertSafeInteger(response.workerThreads, command, "workerThreads", 1),
    };
  },

  async uploadSnapshotEnvelope(jobId, envelope) {
    const command = UPLOAD_SOLID_VOXEL_SNAPSHOT_COMMAND;
    encodeJobId(jobId, command);
    if (!(envelope instanceof Uint8Array) || envelope.byteLength === 0) {
      throw protocolError(command, "snapshot envelope must be a non-empty Uint8Array");
    }
    const response = await invokeRaw(transport, command, envelope);
    if (!isRecord(response)) throw protocolError(command, "upload receipt must be an object");
    const responseJobId = parseJobId(response.jobId, command);
    if (responseJobId !== jobId || response.state !== "running") {
      throw protocolError(command, "upload receipt does not match the uploaded job");
    }
    return { jobId: responseJobId, state: "running" };
  },

  async getJobStatus(jobId) {
    const encodedJobId = encodeJobId(jobId, SOLID_VOXEL_JOB_STATUS_COMMAND);
    return parseStatus(await invokeJson(transport, SOLID_VOXEL_JOB_STATUS_COMMAND, {
      jobId: encodedJobId,
    }), jobId);
  },

  async cancelJob(jobId) {
    const command = CANCEL_SOLID_VOXEL_JOB_COMMAND;
    const response = await invokeJson(transport, command, {
      jobId: encodeJobId(jobId, command),
    });
    if (!isRecord(response)) throw protocolError(command, "cancel receipt must be an object");
    const responseJobId = parseJobId(response.jobId, command);
    if (responseJobId !== jobId) throw protocolError(command, "cancel receipt belongs to another job");
    return {
      jobId: responseJobId,
      cancellationRequested: assertBoolean(
        response.cancellationRequested,
        command,
        "cancellationRequested",
      ),
    };
  },

  async releaseJob(jobId) {
    const command = RELEASE_SOLID_VOXEL_JOB_COMMAND;
    const response = await invokeJson(transport, command, {
      jobId: encodeJobId(jobId, command),
    });
    if (!isRecord(response)) throw protocolError(command, "release receipt must be an object");
    const responseJobId = parseJobId(response.jobId, command);
    if (responseJobId !== jobId) throw protocolError(command, "release receipt belongs to another job");
    return {
      jobId: responseJobId,
      fullyReleased: assertBoolean(response.fullyReleased, command, "fullyReleased"),
    };
  },

  async getLimitedPreview(handle, maxPoints) {
    const command = GET_SOLID_VOXEL_PREVIEW_COMMAND;
    const normalizedHandle = handleArgs(handle, command);
    const normalizedMaxPoints = assertSafeInteger(maxPoints, command, "maxPoints", 1);
    if (normalizedMaxPoints > MAX_SOLID_VOXEL_PREVIEW_POINTS) {
      throw protocolError(command, `maxPoints must not exceed ${MAX_SOLID_VOXEL_PREVIEW_POINTS}`);
    }
    const response = await invokeJson(transport, command, {
      handle: normalizedHandle,
      maxPoints: normalizedMaxPoints,
    });
    if (!isRecord(response)) throw protocolError(command, "preview response must be an object");
    const responseHandle = parseHandle(response.handle, command);
    if (!sameHandle(responseHandle, handle)) {
      throw protocolError(command, "preview belongs to another result handle");
    }
    if (!Array.isArray(response.points) || response.points.length > normalizedMaxPoints) {
      throw protocolError(command, "preview exceeds the requested point limit");
    }
    const points = response.points.map((point, index) => (
      parseTuple(point, 3, command, `points[${index}]`, true) as [number, number, number]
    ));
    if (!Array.isArray(response.blockIndices) || response.blockIndices.length !== points.length) {
      throw protocolError(command, "preview block indices must match point count");
    }
    const blockIndices = response.blockIndices.map((entry, index) => (
      assertSafeInteger(entry, command, `blockIndices[${index}]`, 0)
    ));
    const totalPoints = assertSafeInteger(response.totalPoints, command, "totalPoints", 0);
    const truncated = assertBoolean(response.truncated, command, "truncated");
    if (totalPoints < points.length || truncated !== (totalPoints > points.length)) {
      throw protocolError(command, "preview truncation metadata is inconsistent");
    }
    return { handle: responseHandle, points, blockIndices, totalPoints, truncated };
  },

  async pullResultBatch(handle, options = {}) {
    const command = PULL_SOLID_VOXEL_CHUNKS_COMMAND;
    const normalizedHandle = handleArgs(handle, command);
    const maxBytes = assertSafeInteger(
      options.maxBytes ?? DEFAULT_SOLID_VOXEL_BATCH_BYTES,
      command,
      "maxBytes",
      MIN_SOLID_VOXEL_BATCH_BYTES,
    );
    if (maxBytes > MAX_SOLID_VOXEL_BATCH_BYTES) {
      throw protocolError(command, `maxBytes must not exceed ${MAX_SOLID_VOXEL_BATCH_BYTES}`);
    }
    if (options.cursor !== undefined && typeof options.cursor !== "string") {
      throw protocolError(command, "cursor must be a string");
    }
    const responseBytes = await invokeRawResponse(transport, command, {
      handle: normalizedHandle,
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      maxBytes,
    });
    if (!(responseBytes instanceof Uint8Array)) {
      throw protocolError(command, "batch response must be a top-level Uint8Array envelope");
    }
    if (responseBytes.byteLength > maxBytes) {
      throw protocolError(command, "batch exceeds the requested byte limit");
    }
    let response: SolidVoxelResultBatchEnvelope;
    try {
      response = decodeSolidVoxelResultBatchEnvelope(responseBytes);
    } catch (error) {
      if (error instanceof SolidVoxelResultEnvelopeError) {
        throw protocolError(command, `invalid batch envelope (${error.code})`, error);
      }
      throw error;
    }
    if (!sameHandle(response.handle, handle)) {
      throw protocolError(command, "batch belongs to another result handle");
    }
    if ((options.cursor === undefined) !== response.first) {
      throw protocolError(command, "batch FIRST flag does not match the requested cursor");
    }
    return response;
  },

  async writeLitematic(request) {
    const command = WRITE_SOLID_VOXEL_LITEMATIC_COMMAND;
    if (!capabilities.writeLitematic) {
      throw new TauriSolidVoxelClientError(
        "runtime-unavailable",
        command,
        "Native Litematic writing is not available in this runtime",
      );
    }
    const normalizedRequest = {
      ...request,
      handle: handleArgs(request.handle, command),
    };
    const response = await invokeJson(transport, command, normalizedRequest);
    return parseLitematicSummary(response, request);
  },
});
