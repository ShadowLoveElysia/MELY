import { encodeSolidVoxelSnapshotEnvelope } from "../core/solidVoxelSnapshotEnvelope";
import type { NativeThreadExecutionSnapshot } from "../core/nativeThreadRisk";
import type { MmdMeshSnapshot, SolidOptions } from "../types";
import {
  TauriSolidVoxelClientError,
  type NativeSolidVoxelError,
  type SolidVoxelJobId,
  type SolidVoxelJobStatus,
  type SolidVoxelResultHandle,
  type SolidVoxelResultManifest,
  type TauriSolidVoxelClient,
} from "./tauriSolidVoxelBackend";

export type NativeSolidVoxelRunPhase =
  | "idle"
  | "creating"
  | "uploading"
  | "running"
  | "completed"
  | "cancelled"
  | "failed"
  | "released";

export interface NativeSolidVoxelRunSnapshot {
  phase: NativeSolidVoxelRunPhase;
  jobId: SolidVoxelJobId | null;
  execution: NativeThreadExecutionSnapshot | null;
  status: SolidVoxelJobStatus | null;
  resultHandle: SolidVoxelResultHandle | null;
  manifest: SolidVoxelResultManifest | null;
  error: NativeSolidVoxelError | TauriSolidVoxelClientError | null;
}

export type NativeSolidVoxelStartResult =
  | { kind: "started"; jobId: SolidVoxelJobId }
  | { kind: "fallback-allowed"; reason: TauriSolidVoxelClientError };

export interface NativeSolidVoxelJobStore {
  getSnapshot(): Readonly<NativeSolidVoxelRunSnapshot>;
  subscribe(listener: (snapshot: Readonly<NativeSolidVoxelRunSnapshot>) => void): () => void;
  start(input: {
    execution: NativeThreadExecutionSnapshot;
    options: Readonly<SolidOptions>;
    snapshot: MmdMeshSnapshot;
    signal?: AbortSignal;
    isCurrent?: () => boolean;
  }): Promise<NativeSolidVoxelStartResult>;
  poll(input?: {
    signal?: AbortSignal;
    isCurrent?: () => boolean;
  }): Promise<Readonly<NativeSolidVoxelRunSnapshot>>;
  cancel(): Promise<void>;
  release(): Promise<boolean>;
}

const INITIAL_SNAPSHOT: Readonly<NativeSolidVoxelRunSnapshot> = Object.freeze({
  phase: "idle",
  jobId: null,
  execution: null,
  status: null,
  resultHandle: null,
  manifest: null,
  error: null,
});

const cloneExecution = (
  execution: NativeThreadExecutionSnapshot,
): NativeThreadExecutionSnapshot => Object.freeze({ ...execution });

const asClientError = (error: unknown, command = "native-solid-voxel-job") => (
  error instanceof TauriSolidVoxelClientError
    ? error
    : new TauriSolidVoxelClientError(
        "transport",
        command,
        "Native solid voxel job failed",
        { cause: error },
      )
);

const canFallbackBeforeNativeStart = (error: TauriSolidVoxelClientError) => (
  error.kind === "runtime-unavailable"
  || (error.kind === "native" && error.nativeError?.category === "unsupported")
);

const abortError = (message: string, signal?: AbortSignal) => {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  return new DOMException(message, "AbortError");
};

const isAbortError = (error: unknown) => (
  error instanceof Error && error.name === "AbortError"
);

const assertStartCurrent = (input: {
  signal?: AbortSignal;
  isCurrent?: () => boolean;
}) => {
  if (input.signal?.aborted) {
    throw abortError("Native solid voxel job creation was cancelled", input.signal);
  }
  if (input.isCurrent && !input.isCurrent()) {
    throw abortError("Native solid voxel job creation became stale");
  }
};

const awaitAbortable = async <Value>(
  operation: Promise<Value>,
  signal: AbortSignal | undefined,
  message: string,
): Promise<Value> => {
  if (!signal) return operation;
  if (signal.aborted) throw abortError(message, signal);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError(message, signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
};

/**
 * Store 只拥有原生 job/handle 生命周期，不把结果伪装成 ProjectionDocument。
 * 一旦 create 成功取得 jobId，所有后续失败都必须显式报告，不能自动转跑 Web Worker。
 */
export const createNativeSolidVoxelJobStore = (
  client: TauriSolidVoxelClient,
): NativeSolidVoxelJobStore => {
  let current: Readonly<NativeSolidVoxelRunSnapshot> = INITIAL_SNAPSHOT;
  let operationGeneration = 0;
  const releaseOperations = new Map<SolidVoxelJobId, Promise<boolean>>();
  const listeners = new Set<(snapshot: Readonly<NativeSolidVoxelRunSnapshot>) => void>();

  const update = (patch: Partial<NativeSolidVoxelRunSnapshot>) => {
    current = Object.freeze({ ...current, ...patch });
    listeners.forEach(listener => listener(current));
  };

  const requireJobId = () => {
    if (current.jobId === null) {
      throw new TauriSolidVoxelClientError(
        "protocol",
        "native-solid-voxel-job",
        "No native solid voxel job is active",
      );
    }
    return current.jobId;
  };

  const releaseOwnedJob = (jobId: SolidVoxelJobId) => {
    const active = releaseOperations.get(jobId);
    if (active) return active;
    const operation = client.releaseJob(jobId).then(receipt => receipt.fullyReleased);
    releaseOperations.set(jobId, operation);
    void operation.then(
      (fullyReleased) => {
        if (!fullyReleased && releaseOperations.get(jobId) === operation) {
          releaseOperations.delete(jobId);
        }
      },
      () => {
        if (releaseOperations.get(jobId) === operation) releaseOperations.delete(jobId);
      },
    );
    return operation;
  };

  const canStartFromPhase = (phase: NativeSolidVoxelRunPhase) => (
    phase === "idle"
    || phase === "released"
    || phase === "failed"
    || phase === "cancelled"
  );

  return {
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async start(input) {
      if (!canStartFromPhase(current.phase) || current.jobId !== null) {
        throw new TauriSolidVoxelClientError(
          "protocol",
          "native-solid-voxel-job",
          "A native solid voxel job is already owned by this store",
        );
      }
      const startGeneration = ++operationGeneration;
      const execution = cloneExecution(input.execution);
      update({
        phase: "creating",
        jobId: null,
        execution,
        status: null,
        resultHandle: null,
        manifest: null,
        error: null,
      });

      const assertOwnedStart = () => {
        if (operationGeneration !== startGeneration) {
          throw abortError("Native solid voxel job creation became stale");
        }
        assertStartCurrent(input);
      };
      assertOwnedStart();

      let created;
      const createOperation = client.createJob({
        workerThreads: execution.workerThreads,
        options: input.options,
      });
      try {
        created = await awaitAbortable(
          createOperation,
          input.signal,
          "Native solid voxel job creation was cancelled",
        );
        assertOwnedStart();
      } catch (error) {
        if (isAbortError(error) || operationGeneration !== startGeneration) {
          // create command 无法被 Promise 取消；迟到的 jobId 必须由原生层释放。
          void createOperation.then(
            late => {
              void releaseOwnedJob(late.jobId).catch(() => undefined);
            },
            () => undefined,
          );
          if (operationGeneration === startGeneration) {
            operationGeneration += 1;
            update({ phase: "cancelled", error: null });
          }
          throw isAbortError(error)
            ? error
            : abortError("Native solid voxel job creation became stale");
        }
        const clientError = asClientError(error);
        update({ phase: "failed", error: clientError });
        if (canFallbackBeforeNativeStart(clientError)) {
          return { kind: "fallback-allowed", reason: clientError };
        }
        throw clientError;
      }

      update({ phase: "uploading", jobId: created.jobId });
      try {
        assertOwnedStart();
        const uploadOperation = client.uploadSnapshotEnvelope(
          created.jobId,
          encodeSolidVoxelSnapshotEnvelope(created.jobId, input.snapshot),
        );
        await awaitAbortable(
          uploadOperation,
          input.signal,
          "Native solid voxel snapshot upload was cancelled",
        );
        assertOwnedStart();
        update({ phase: "running" });
        return { kind: "started", jobId: created.jobId };
      } catch (error) {
        if (isAbortError(error) || operationGeneration !== startGeneration) {
          await client.cancelJob(created.jobId).catch(() => undefined);
          const released = await releaseOwnedJob(created.jobId).catch(() => false);
          if (operationGeneration === startGeneration) {
            operationGeneration += 1;
            update({
              phase: "cancelled",
              jobId: released ? null : created.jobId,
              error: null,
            });
          }
          throw isAbortError(error)
            ? error
            : abortError("Native solid voxel snapshot upload became stale");
        }
        const clientError = asClientError(error);
        // 创建成功后上传失败仍属于原生任务生命周期；释放失败不能覆盖原始错误。
        const released = await releaseOwnedJob(created.jobId).catch(() => false);
        update({
          phase: "failed",
          jobId: released ? null : created.jobId,
          error: clientError,
        });
        throw clientError;
      }
    },

    async poll(input = {}) {
      const pollGeneration = operationGeneration;
      const assertOwnedPoll = () => {
        if (operationGeneration !== pollGeneration) {
          throw abortError("Native solid voxel status request became stale");
        }
        assertStartCurrent(input);
      };
      const jobId = requireJobId();
      try {
        assertOwnedPoll();
        const status = await awaitAbortable(
          client.getJobStatus(jobId),
          input.signal,
          "Native solid voxel status request was cancelled",
        );
        assertOwnedPoll();
        if (status.state === "completed") {
          update({
            phase: "completed",
            status,
            resultHandle: status.resultHandle ?? null,
            manifest: status.manifest ?? null,
            error: null,
          });
        } else if (status.state === "failed") {
          update({ phase: "failed", status, error: status.error ?? null });
        } else if (status.state === "cancelled") {
          update({ phase: "cancelled", status, error: status.error ?? null });
        } else {
          update({ phase: status.state === "awaitingUpload" ? "uploading" : "running", status });
        }
        return current;
      } catch (error) {
        if (isAbortError(error)) throw error;
        const clientError = asClientError(error);
        update({ phase: "failed", error: clientError });
        throw clientError;
      }
    },

    async cancel() {
      const jobId = requireJobId();
      await client.cancelJob(jobId);
    },

    async release() {
      operationGeneration += 1;
      const jobId = current.jobId;
      if (jobId !== null) {
        const fullyReleased = await releaseOwnedJob(jobId);
        if (!fullyReleased) return false;
      }
      current = Object.freeze({ ...INITIAL_SNAPSHOT, phase: "released" });
      listeners.forEach(listener => listener(current));
      return true;
    },
  };
};
