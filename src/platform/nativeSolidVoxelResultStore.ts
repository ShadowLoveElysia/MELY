import {
  assertProjectionDocumentIntegrity,
  createProjectionDocumentFromSolid,
} from "../core/projectionDocument";
import { createProjectionDocumentContentHash } from "../core/projectionContentHash";
import type { SolidVoxelResultBatchEnvelope } from "../core/solidVoxelResultEnvelope";
import type {
  ProjectionDocument,
  ProjectionDocumentOptions,
  SolidVoxelChunk,
  SolidVoxelResult,
  VoxelPaletteEntry,
} from "../types";
import {
  DEFAULT_SOLID_VOXEL_BATCH_BYTES,
  PULL_SOLID_VOXEL_CHUNKS_COMMAND,
  TauriSolidVoxelClientError,
  type SolidVoxelJobId,
  type SolidVoxelResultHandle,
  type SolidVoxelResultManifest,
  type TauriSolidVoxelClient,
} from "./tauriSolidVoxelBackend";

export type NativeSolidVoxelResultPhase =
  | "idle"
  | "pulling"
  | "completed"
  | "cancelled"
  | "failed"
  | "released";

export interface NativeSolidVoxelMaterializedResult {
  result: SolidVoxelResult;
  document: ProjectionDocument;
  contentHash: string;
}

export interface NativeSolidVoxelResultSnapshot {
  phase: NativeSolidVoxelResultPhase;
  pulledChunkCount: number;
  totalChunkCount: number;
  result: NativeSolidVoxelMaterializedResult | null;
  error: TauriSolidVoxelClientError | null;
}

export interface NativeSolidVoxelResultStore {
  getSnapshot(): Readonly<NativeSolidVoxelResultSnapshot>;
  subscribe(listener: (snapshot: Readonly<NativeSolidVoxelResultSnapshot>) => void): () => void;
  consume(options?: {
    maxBytes?: number;
    signal?: AbortSignal;
    document?: ProjectionDocumentOptions;
  }): Promise<NativeSolidVoxelMaterializedResult>;
  cancel(): Promise<boolean>;
  release(): Promise<boolean>;
}

const INITIAL_SNAPSHOT: Readonly<NativeSolidVoxelResultSnapshot> = Object.freeze({
  phase: "idle",
  pulledChunkCount: 0,
  totalChunkCount: 0,
  result: null,
  error: null,
});

const sameHandle = (
  left: SolidVoxelResultHandle,
  right: SolidVoxelResultHandle,
) => left.id === right.id && left.generation === right.generation;

const compareYzx = (
  left: readonly [number, number, number],
  right: readonly [number, number, number],
) => left[1] - right[1] || left[2] - right[2] || left[0] - right[0];

const protocolError = (message: string, cause?: unknown) => new TauriSolidVoxelClientError(
  "protocol",
  PULL_SOLID_VOXEL_CHUNKS_COMMAND,
  message,
  { cause },
);

const abortError = () => new DOMException("Native solid voxel result consumption was cancelled", "AbortError");

const toClientError = (error: unknown) => error instanceof TauriSolidVoxelClientError
  ? error
  : protocolError("Native solid voxel result could not be materialized", error);

const assertSafeCount = (value: number, label: string) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw protocolError(`${label} must be a non-negative safe integer`);
  }
};

const assertManifestShape = (manifest: SolidVoxelResultManifest) => {
  const counts = [
    [manifest.blockCount, "Native block count"],
    [manifest.surfaceBlockCount, "Native surface block count"],
    [manifest.filledBlockCount, "Native filled block count"],
    [manifest.skinBlockCount, "Native skin block count"],
    [manifest.alphaRejected, "Native alpha-rejected count"],
    [manifest.triangleBoxTests, "Native triangle-box test count"],
    [manifest.paletteSize, "Native palette count"],
    [manifest.chunkCount, "Native chunk count"],
  ] as const;
  counts.forEach(([value, label]) => assertSafeCount(value, label));
  if (manifest.blockCount === 0 || manifest.paletteSize === 0 || manifest.chunkCount === 0) {
    throw protocolError("Native shell manifest must contain blocks, palette entries, and chunks");
  }
  if (manifest.paletteSize > 0x1_0000) {
    throw protocolError("Native palette exceeds the Uint16 index range");
  }
  if (
    manifest.surfaceBlockCount + manifest.filledBlockCount !== manifest.blockCount
    || manifest.skinBlockCount > manifest.blockCount
  ) {
    throw protocolError("Native result statistics are internally inconsistent");
  }
  for (let axis = 0; axis < 3; axis += 1) {
    const minimum = manifest.bounds.min[axis];
    const maximum = manifest.bounds.max[axis];
    const dimension = manifest.dimensions[axis];
    if (
      !Number.isSafeInteger(minimum)
      || !Number.isSafeInteger(maximum)
      || !Number.isSafeInteger(dimension)
      || dimension <= 0
      || maximum < minimum
      || maximum - minimum + 1 !== dimension
    ) {
      throw protocolError("Native manifest bounds and dimensions are inconsistent");
    }
  }
};

const assertManifest = (
  manifest: SolidVoxelResultManifest,
  palette: readonly VoxelPaletteEntry[],
  chunks: readonly SolidVoxelChunk[],
) => {
  assertManifestShape(manifest);
  if (palette.length !== manifest.paletteSize) {
    throw protocolError(
      `Native palette count ${palette.length} does not match manifest ${manifest.paletteSize}`,
    );
  }
  if (chunks.length !== manifest.chunkCount) {
    throw protocolError(
      `Native chunk count ${chunks.length} does not match manifest ${manifest.chunkCount}`,
    );
  }
  let blockCount = 0;
  let previousChunk: SolidVoxelChunk | undefined;
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const chunk of chunks) {
    if (previousChunk && compareYzx(previousChunk.chunk, chunk.chunk) >= 0) {
      throw protocolError("Native chunks are not globally ordered by Y, Z, X");
    }
    blockCount += chunk.positions.length;
    if (!Number.isSafeInteger(blockCount)) {
      throw protocolError("Native block count exceeds the JavaScript safe integer range");
    }
    for (const localPosition of chunk.positions) {
      const x = localPosition % 32;
      const yz = Math.floor(localPosition / 32);
      const z = yz % 32;
      const y = Math.floor(yz / 32);
      const local = [x, y, z];
      for (let axis = 0; axis < 3; axis += 1) {
        const coordinate = chunk.chunk[axis] * 32 + local[axis];
        if (!Number.isSafeInteger(coordinate)) {
          throw protocolError("Native result contains a coordinate outside the safe integer range");
        }
        minimum[axis] = Math.min(minimum[axis], coordinate);
        maximum[axis] = Math.max(maximum[axis], coordinate);
      }
    }
    previousChunk = chunk;
  }
  if (blockCount !== manifest.blockCount) {
    throw protocolError(
      `Native block count ${blockCount} does not match manifest ${manifest.blockCount}`,
    );
  }
  for (let axis = 0; axis < 3; axis += 1) {
    if (
      minimum[axis] !== manifest.bounds.min[axis]
      || maximum[axis] !== manifest.bounds.max[axis]
      || maximum[axis] - minimum[axis] + 1 !== manifest.dimensions[axis]
    ) {
      throw protocolError("Native bounds do not match the materialized chunk coordinates");
    }
  }
};

const createSolidResult = (
  manifest: SolidVoxelResultManifest,
  palette: VoxelPaletteEntry[],
  chunks: SolidVoxelChunk[],
): SolidVoxelResult => ({
  kind: "solid",
  storage: "chunked",
  positions: new Float32Array(0),
  blockIndices: new Uint16Array(0),
  chunks,
  palette,
  stats: {
    blockCount: manifest.blockCount,
    surfaceBlockCount: manifest.surfaceBlockCount,
    filledBlockCount: manifest.filledBlockCount,
    skinBlockCount: manifest.skinBlockCount,
    alphaRejected: manifest.alphaRejected,
    triangleBoxTests: manifest.triangleBoxTests,
    paletteSize: manifest.paletteSize,
    dimensions: [...manifest.dimensions],
  },
  bounds: {
    min: [...manifest.bounds.min],
    max: [...manifest.bounds.max],
  },
});

/**
 * 逐批接管原生结果。拉取、验证和追加严格串行，确保 WebView 中至多存在
 * 一个尚未消费的 IPC batch；失败和取消都会释放原生 job/handle。
 */
export const createNativeSolidVoxelResultStore = (
  client: TauriSolidVoxelClient,
  ownership: {
    jobId: SolidVoxelJobId;
    handle: SolidVoxelResultHandle;
    manifest: SolidVoxelResultManifest;
  },
): NativeSolidVoxelResultStore => {
  let current = INITIAL_SNAPSHOT;
  let activeConsume: Promise<NativeSolidVoxelMaterializedResult> | null = null;
  let cancellationRequested = false;
  let releasePromise: Promise<boolean> | null = null;
  let rejectActivePull: ((reason: DOMException) => void) | null = null;
  const listeners = new Set<(snapshot: Readonly<NativeSolidVoxelResultSnapshot>) => void>();

  const update = (patch: Partial<NativeSolidVoxelResultSnapshot>) => {
    current = Object.freeze({ ...current, ...patch });
    listeners.forEach(listener => listener(current));
  };
  const releaseOwnedJob = () => {
    if (!releasePromise) {
      const operation = client.releaseJob(ownership.jobId)
        .then(receipt => receipt.fullyReleased);
      releasePromise = operation;
      void operation.then(
        (fullyReleased) => {
          if (!fullyReleased && releasePromise === operation) releasePromise = null;
        },
        () => {
          if (releasePromise === operation) releasePromise = null;
        },
      );
    }
    return releasePromise;
  };
  const throwIfCancelled = (signal?: AbortSignal) => {
    if (cancellationRequested || signal?.aborted) throw abortError();
  };

  return {
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    consume(options = {}) {
      if (activeConsume) return activeConsume;
      if (current.phase !== "idle") {
        return Promise.reject(protocolError(`Cannot consume a result in phase ${current.phase}`));
      }
      cancellationRequested = false;
      update({ phase: "pulling", error: null });

      activeConsume = (async () => {
        const chunks: SolidVoxelChunk[] = [];
        const seenCursors = new Set<string>();
        let palette: VoxelPaletteEntry[] | undefined;
        let cursor: string | undefined;
        let totalChunkCount: number | undefined;
        let totalPaletteCount: number | undefined;
        let onAbort: (() => void) | undefined;
        const cancellation = new Promise<never>((_resolve, reject) => {
          rejectActivePull = reject;
        });
        if (options.signal) {
          onAbort = () => {
            cancellationRequested = true;
            rejectActivePull?.(abortError());
            void releaseOwnedJob().catch(() => undefined);
          };
          options.signal.addEventListener("abort", onAbort, { once: true });
        }
        try {
          assertManifestShape(ownership.manifest);
          while (true) {
            throwIfCancelled(options.signal);
            // 下一批只会在上一批完成解码、连续性校验和追加后发起。
            const batch: SolidVoxelResultBatchEnvelope = await Promise.race([
              client.pullResultBatch(
                ownership.handle,
                {
                  ...(cursor === undefined ? {} : { cursor }),
                  maxBytes: options.maxBytes ?? DEFAULT_SOLID_VOXEL_BATCH_BYTES,
                },
              ),
              cancellation,
            ]);
            throwIfCancelled(options.signal);
            if (!sameHandle(batch.handle, ownership.handle)) {
              throw protocolError("Native result batch belongs to another handle generation");
            }
            if (batch.startChunkIndex !== chunks.length) {
              throw protocolError(
                `Native result batch starts at chunk ${batch.startChunkIndex}, expected ${chunks.length}`,
              );
            }
            if (totalChunkCount === undefined) {
              if (!batch.first || !batch.palette) {
                throw protocolError("The first native result batch must contain the canonical palette");
              }
              totalChunkCount = batch.totalChunkCount;
              totalPaletteCount = batch.totalPaletteCount;
              palette = batch.palette;
              if (
                totalChunkCount !== ownership.manifest.chunkCount
                || totalPaletteCount !== ownership.manifest.paletteSize
              ) {
                throw protocolError("Native result batch totals do not match the completed manifest");
              }
            } else if (
              batch.first
              || batch.palette !== undefined
              || batch.totalChunkCount !== totalChunkCount
              || batch.totalPaletteCount !== totalPaletteCount
            ) {
              throw protocolError("Native result batch repeated or changed immutable metadata");
            }
            const previous = chunks.at(-1);
            if (previous && batch.chunks.length > 0
              && compareYzx(previous.chunk, batch.chunks[0].chunk) >= 0) {
              throw protocolError("Native chunks are not globally ordered across batch boundaries");
            }
            chunks.push(...batch.chunks);
            update({ pulledChunkCount: chunks.length, totalChunkCount });
            if (batch.done) {
              if (batch.cursor !== null || chunks.length !== totalChunkCount) {
                throw protocolError("Final native result batch has an inconsistent cursor or chunk count");
              }
              break;
            }
            if (batch.cursor === null || seenCursors.has(batch.cursor)) {
              throw protocolError("Native result cursor is missing, repeated, or did not advance");
            }
            seenCursors.add(batch.cursor);
            cursor = batch.cursor;
          }

          assertManifest(ownership.manifest, palette!, chunks);
          const result = createSolidResult(ownership.manifest, palette!, chunks);
          const document = createProjectionDocumentFromSolid(result, options.document);
          assertProjectionDocumentIntegrity(document, "Native solid voxel result");
          const materialized = {
            result,
            document,
            contentHash: createProjectionDocumentContentHash(document),
          };
          update({ phase: "completed", result: materialized, error: null });
          return materialized;
        } catch (error) {
          const cancelled = cancellationRequested
            || options.signal?.aborted
            || error instanceof DOMException && error.name === "AbortError";
          const clientError = cancelled ? null : toClientError(error);
          if (current.phase !== "released") {
            if (cancelled) {
              update({ phase: "cancelled", error: null });
            } else {
              update({ phase: "failed", error: clientError });
            }
          }
          try {
            await releaseOwnedJob();
          } catch (releaseError) {
            if (!cancelled && current.phase !== "released" && current.error === null) {
              update({ error: toClientError(releaseError) });
            }
          }
          if (cancelled) throw error;
          throw clientError;
        } finally {
          rejectActivePull = null;
          if (onAbort && options.signal) {
            options.signal.removeEventListener("abort", onAbort);
          }
        }
      })();
      return activeConsume;
    },

    async cancel() {
      cancellationRequested = true;
      rejectActivePull?.(abortError());
      await client.cancelJob(ownership.jobId).catch(() => undefined);
      const fullyReleased = await releaseOwnedJob();
      if (fullyReleased) {
        current = Object.freeze({ ...INITIAL_SNAPSHOT, phase: "released" });
        listeners.forEach(listener => listener(current));
        return true;
      }
      if (current.phase !== "completed" && current.phase !== "released") {
        update({ phase: "cancelled", result: null, error: null });
      }
      return false;
    },

    async release() {
      cancellationRequested = true;
      rejectActivePull?.(abortError());
      const fullyReleased = await releaseOwnedJob();
      if (!fullyReleased) return false;
      current = Object.freeze({ ...INITIAL_SNAPSHOT, phase: "released" });
      listeners.forEach(listener => listener(current));
      return true;
    },
  };
};
