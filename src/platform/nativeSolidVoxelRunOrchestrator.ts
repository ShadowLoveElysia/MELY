import type { NativeThreadExecutionSnapshot } from "../core/nativeThreadRisk";
import type { MmdMeshSnapshot, ProjectionDocumentOptions, SolidOptions } from "../types";
import {
  createNativeSolidVoxelJobStore,
  type NativeSolidVoxelJobStore,
  type NativeSolidVoxelRunSnapshot,
} from "./nativeSolidVoxelJobStore";
import {
  createNativeSolidVoxelResultStore,
  type NativeSolidVoxelMaterializedResult,
  type NativeSolidVoxelResultStore,
} from "./nativeSolidVoxelResultStore";
import {
  createDefaultTauriSolidVoxelTransport,
  createTauriSolidVoxelClient,
  SOLID_VOXEL_JOB_STATUS_COMMAND,
  TauriSolidVoxelClientError,
  type NativeSolidVoxelError,
  type SolidVoxelJobId,
  type SolidVoxelResultHandle,
  type SolidVoxelResultManifest,
  type TauriSolidVoxelClient,
  type TauriSolidVoxelTransport,
} from "./tauriSolidVoxelBackend";

export const DEFAULT_NATIVE_SOLID_VOXEL_POLL_INTERVAL_MS = 100;

export type NativeSolidVoxelRunWait = (milliseconds: number) => Promise<void>;

export interface NativeSolidVoxelRunInput {
  execution: NativeThreadExecutionSnapshot;
  options: Readonly<SolidOptions>;
  snapshot: MmdMeshSnapshot;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
  onProgress?: (
    fraction: number,
    snapshot: Readonly<NativeSolidVoxelRunSnapshot>,
  ) => void;
  onSnapshotUploaded?: () => void;
  onMaterializationProgress?: (
    pulledChunkCount: number,
    totalChunkCount: number,
  ) => void;
  materialization?: {
    maxBytes?: number;
    document?: ProjectionDocumentOptions;
  };
}

export interface NativeSolidVoxelRunDependencies {
  client?: TauriSolidVoxelClient;
  createTransport?: () => Promise<TauriSolidVoxelTransport>;
  createClient?: (
    transport: TauriSolidVoxelTransport,
  ) => TauriSolidVoxelClient | Promise<TauriSolidVoxelClient>;
  createJobStore?: (client: TauriSolidVoxelClient) => NativeSolidVoxelJobStore;
  createResultStore?: typeof createNativeSolidVoxelResultStore;
  pollIntervalMs?: number;
  wait?: NativeSolidVoxelRunWait;
}

export interface NativeSolidVoxelCompletedOwnership {
  jobId: SolidVoxelJobId;
  handle: SolidVoxelResultHandle;
  manifest: SolidVoxelResultManifest;
  client: TauriSolidVoxelClient;
  resultStore: NativeSolidVoxelResultStore;
  materialized: NativeSolidVoxelMaterializedResult;
}

export type NativeSolidVoxelRunResult =
  | { kind: "fallback-allowed"; reason: TauriSolidVoxelClientError }
  | { kind: "completed"; ownership: NativeSolidVoxelCompletedOwnership };

const defaultWait: NativeSolidVoxelRunWait = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

const canFallbackBeforeNativeCreate = (error: unknown): error is TauriSolidVoxelClientError => (
  error instanceof TauriSolidVoxelClientError
  && (
    error.kind === "runtime-unavailable"
    || (error.kind === "native" && error.nativeError?.category === "unsupported")
  )
);

const createAbortError = (message: string, signal?: AbortSignal) => {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  return new DOMException(message, "AbortError");
};

const isAbortError = (error: unknown) => (
  error instanceof Error && error.name === "AbortError"
);

const nativeStatusError = (
  error: NativeSolidVoxelError | TauriSolidVoxelClientError | null,
) => (
  error instanceof TauriSolidVoxelClientError
    ? error
    : error
    ? new TauriSolidVoxelClientError(
        "native",
        SOLID_VOXEL_JOB_STATUS_COMMAND,
        "Native solid voxel job reported a failure",
        { cause: error, nativeError: error },
      )
    : new TauriSolidVoxelClientError(
        "protocol",
        SOLID_VOXEL_JOB_STATUS_COMMAND,
        "Native solid voxel job entered a terminal state without an error",
      )
);

const completedResultError = () => new TauriSolidVoxelClientError(
  "protocol",
  SOLID_VOXEL_JOB_STATUS_COMMAND,
  "Native solid voxel job completed without a result handle and manifest",
);

const resolveClient = async (
  dependencies: NativeSolidVoxelRunDependencies,
  assertCurrent: () => void,
): Promise<TauriSolidVoxelClient> => {
  if (dependencies.client) return dependencies.client;
  assertCurrent();
  const transport = await (
    dependencies.createTransport ?? createDefaultTauriSolidVoxelTransport
  )();
  assertCurrent();
  const client = await (
    dependencies.createClient
    ?? ((value) => createTauriSolidVoxelClient(value, { writeLitematic: true }))
  )(transport);
  assertCurrent();
  return client;
};

const awaitAbortable = async <Value>(
  operation: Promise<Value>,
  signal: AbortSignal | undefined,
  message: string,
): Promise<Value> => {
  if (!signal) return operation;
  if (signal.aborted) throw createAbortError(message, signal);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(createAbortError(message, signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
};

const waitWithAbort = async (
  wait: NativeSolidVoxelRunWait,
  milliseconds: number,
  signal?: AbortSignal,
) => {
  if (!signal) {
    await wait(milliseconds);
    return;
  }
  if (signal.aborted) {
    throw createAbortError("Native solid voxel job was cancelled", signal);
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(createAbortError("Native solid voxel job was cancelled", signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([wait(milliseconds), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
};

/**
 * 原生 create 成功是不可逆的回退边界。完成后 job 所有权转交给 resultStore；
 * 编排器不会释放成功结果，调用方必须在替换、取消或窗口关闭时显式释放。
 */
export const runNativeSolidVoxelJob = async (
  input: NativeSolidVoxelRunInput,
  dependencies: NativeSolidVoxelRunDependencies = {},
): Promise<NativeSolidVoxelRunResult> => {
  const pollIntervalMs = dependencies.pollIntervalMs
    ?? DEFAULT_NATIVE_SOLID_VOXEL_POLL_INTERVAL_MS;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    throw new RangeError("Native solid voxel poll interval must be a finite non-negative number");
  }

  const isCurrent = input.isCurrent ?? (() => true);
  let cancellationRequested = false;
  const assertCurrent = () => {
    if (input.signal?.aborted) {
      cancellationRequested = true;
      throw createAbortError("Native solid voxel job was cancelled", input.signal);
    }
    if (!isCurrent()) {
      cancellationRequested = true;
      throw createAbortError("Native solid voxel job became stale");
    }
  };

  assertCurrent();
  let client: TauriSolidVoxelClient;
  try {
    const clientOperation = resolveClient(dependencies, assertCurrent);
    client = await awaitAbortable(
      clientOperation,
      input.signal,
      "Native solid voxel transport loading was cancelled",
    );
  } catch (error) {
    assertCurrent();
    if (canFallbackBeforeNativeCreate(error)) {
      return { kind: "fallback-allowed", reason: error };
    }
    throw error;
  }
  assertCurrent();

  const jobStore = (dependencies.createJobStore ?? createNativeSolidVoxelJobStore)(client);
  let resultStore: NativeSolidVoxelResultStore | null = null;

  try {
    const started = await jobStore.start({
      execution: input.execution,
      options: input.options,
      snapshot: input.snapshot,
      signal: input.signal,
      isCurrent,
    });
    if (started.kind === "fallback-allowed") return started;
    assertCurrent();
    input.onSnapshotUploaded?.();

    let lastProgress = -1;
    while (true) {
      assertCurrent();
      const run = await jobStore.poll({ signal: input.signal, isCurrent });
      assertCurrent();

      if (run.status) {
        const fraction = run.phase === "completed"
          ? 1
          : Math.max(lastProgress, run.status.progress.fraction);
        if (fraction > lastProgress) {
          lastProgress = fraction;
          input.onProgress?.(fraction, run);
        }
      }

      if (run.phase === "failed") throw nativeStatusError(run.error);
      if (run.phase === "cancelled") {
        cancellationRequested = true;
        throw createAbortError("Native solid voxel job was cancelled");
      }
      if (run.phase === "released") {
        throw new TauriSolidVoxelClientError(
          "protocol",
          SOLID_VOXEL_JOB_STATUS_COMMAND,
          "Native solid voxel job was released before result ownership was transferred",
        );
      }
      if (run.phase === "completed") {
        if (!run.resultHandle || !run.manifest) throw completedResultError();
        resultStore = (dependencies.createResultStore ?? createNativeSolidVoxelResultStore)(
          client,
          {
            jobId: started.jobId,
            handle: run.resultHandle,
            manifest: run.manifest,
          },
        );
        const unsubscribe = resultStore.subscribe((resultSnapshot) => {
          if (input.signal?.aborted || !isCurrent()) return;
          input.onMaterializationProgress?.(
            resultSnapshot.pulledChunkCount,
            resultSnapshot.totalChunkCount,
          );
        });
        let materialized: NativeSolidVoxelMaterializedResult;
        try {
          materialized = await resultStore.consume({
            ...input.materialization,
            signal: input.signal,
          });
        } finally {
          unsubscribe();
        }
        assertCurrent();
        return {
          kind: "completed",
          ownership: {
            jobId: started.jobId,
            handle: run.resultHandle,
            manifest: run.manifest,
            client,
            resultStore,
            materialized,
          },
        };
      }

      await waitWithAbort(
        dependencies.wait ?? defaultWait,
        pollIntervalMs,
        input.signal,
      );
    }
  } catch (error) {
    const cancelled = cancellationRequested || input.signal?.aborted || isAbortError(error);
    if (resultStore) {
      let released = cancelled
        ? await resultStore.cancel().catch(() => false)
        : await resultStore.release().catch(() => false);
      while (!released) {
        await waitWithAbort(dependencies.wait ?? defaultWait, pollIntervalMs);
        released = await resultStore.release().catch(() => false);
      }
    } else if (jobStore.getSnapshot().jobId !== null) {
      if (cancelled) await jobStore.cancel().catch(() => undefined);
      let released = await jobStore.release().catch(() => false);
      while (!released) {
        await waitWithAbort(dependencies.wait ?? defaultWait, pollIntervalMs);
        released = await jobStore.release().catch(() => false);
      }
    }
    throw error;
  }
};
