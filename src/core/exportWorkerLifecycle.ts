import type { ProjectionDocument } from "../types";
import type { ExportBundleOptions, ExportBundlePlan, ExportBundleProgress, ExportBundleResourceEstimate, StreamedExportBundle } from "./exportBundle";
import {
  exportWorkerTransferables,
  isExportWorkerEvent,
  type ExportWorkerCommand,
  type ExportWorkerEvent,
  type ExportWorkerPort,
} from "./exportWorkerProtocol";

export interface ExportWorkerLifecycleOptions {
  createWorker: () => ExportWorkerPort;
  onProgress?: (progress: ExportBundleProgress) => void;
  onPlan?: (plan: ExportBundlePlan, resources: ExportBundleResourceEstimate) => void;
  onOutput?: (chunk: Uint8Array, sequence: number) => Promise<void> | void;
  onComplete?: (result: StreamedExportBundle) => void;
  onOwnershipReturned?: (document: ProjectionDocument) => void;
  onError?: (error: Error, recoverable: boolean) => void;
  onCrash?: (error: Error) => void;
}

export interface ExportWorkerLifecycle {
  plan(document: ProjectionDocument, options: ExportBundleOptions): string;
  start(document?: ProjectionDocument, options?: ExportBundleOptions, plan?: ExportBundlePlan): boolean;
  cancel(): void;
  dispose(): void;
  isCurrent(jobId: string): boolean;
  getActiveJobId(): string | null;
}

export interface ExportWorkerBundleRunOptions {
  createWorker: () => ExportWorkerPort;
  document: ProjectionDocument;
  options: ExportBundleOptions;
  signal?: AbortSignal;
  onProgress?: (progress: ExportBundleProgress) => void;
  onOutput?: (chunk: Uint8Array, sequence: number) => Promise<void> | void;
  onOwnershipReturned?: (document: ProjectionDocument) => void;
  onCrash?: (error: Error) => void;
}

const cloneableExportOptions = (options: ExportBundleOptions): ExportBundleOptions => {
  const clone = { ...options };
  delete clone.signal;
  delete clone.onProgress;
  delete clone.partitionIndex;
  return clone;
};

const safeError = (value: unknown) => value instanceof Error ? value : new Error(String(value));

/** Promise wrapper used by the UI; it resolves only after output and ownership handoff. */
export const runExportBundleWorker = (
  input: ExportWorkerBundleRunOptions,
): Promise<{ result: StreamedExportBundle; returnedDocument: ProjectionDocument }> => {
  if (input.signal?.aborted) {
    return Promise.reject(
      input.signal.reason instanceof Error
        ? input.signal.reason
        : new DOMException("Export was cancelled", "AbortError"),
    );
  }
  let lifecycle: ExportWorkerLifecycle;
  let result: StreamedExportBundle | undefined;
  let returnedDocument: ProjectionDocument | undefined;
  let pendingError: Error | undefined;
  let cancellationRequested = false;
  let resolveRun: ((value: { result: StreamedExportBundle; returnedDocument: ProjectionDocument }) => void) | undefined;
  let rejectRun: ((reason: unknown) => void) | undefined;
  const completion = new Promise<{ result: StreamedExportBundle; returnedDocument: ProjectionDocument }>((resolve, reject) => {
    resolveRun = resolve;
    rejectRun = reject;
  });
  let settled = false;
  const fail = (error: unknown) => {
    if (settled) return;
    settled = true;
    rejectRun?.(error);
    lifecycle.dispose();
  };
  lifecycle = createExportWorkerLifecycle({
    createWorker: input.createWorker,
    onProgress: input.onProgress,
    onOutput: input.onOutput,
    onComplete: (value) => {
      result = value;
      if (returnedDocument) {
        settled = true;
        resolveRun?.({ result: value, returnedDocument });
        lifecycle.dispose();
      }
    },
    onOwnershipReturned: (document) => {
      returnedDocument = document;
      try {
        input.onOwnershipReturned?.(document);
      } catch (error) {
        pendingError = safeError(error);
      }
      if (pendingError || cancellationRequested) {
        fail(pendingError ?? new DOMException("Export was cancelled", "AbortError"));
        return;
      }
      if (result) {
        settled = true;
        resolveRun?.({ result, returnedDocument: document });
        lifecycle.dispose();
      }
    },
    onError: (error, recoverable) => {
      if (recoverable) {
        pendingError = new DOMException("Export was cancelled", "AbortError");
      } else {
        pendingError = error;
      }
    },
    onCrash: (error) => {
      input.onCrash?.(error);
      fail(error);
    },
  });
  const onAbort = () => {
    cancellationRequested = true;
    lifecycle.cancel();
    // Wait for OWNERSHIP_RETURNED so the caller can safely reuse the buffers.
  };
  if (input.signal) {
    input.signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    lifecycle.plan(input.document, cloneableExportOptions(input.options));
    if (!lifecycle.start(undefined, cloneableExportOptions(input.options))) {
      throw new Error("Export worker did not accept START after PLAN");
    }
  } catch (error) {
    fail(error);
  }
  void completion.then(
    () => input.signal?.removeEventListener("abort", onAbort),
    () => input.signal?.removeEventListener("abort", onAbort),
  );
  return completion;
};

const abortError = (message: string) => new DOMException(message, "AbortError");

export const createExportWorkerLifecycle = ({
  createWorker,
  onProgress,
  onPlan,
  onOutput,
  onComplete,
  onOwnershipReturned,
  onError,
  onCrash,
}: ExportWorkerLifecycleOptions): ExportWorkerLifecycle => {
  let worker: ExportWorkerPort | null = null;
  let activeJobId: string | null = null;
  let disposed = false;
  let generation = 0;
  let cancelling = false;
  let phase: "idle" | "planning" | "starting" | "planned" | "running" | "failed" = "idle";
  let pendingOutputSequence: number | null = null;
  let nextOutputSequence = 0;
  let plannedDocument: ProjectionDocument | null = null;
  let plannedOptions: ExportBundleOptions | null = null;
  let crashHandler: ((message: string) => void) | null = null;
  const replace = () => {
    generation += 1;
    const currentGeneration = generation;
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    }
    const next = createWorker();
    worker = next;
    next.onmessage = (message) => {
      if (disposed || generation !== currentGeneration || worker !== next) return;
      const event = message.data;
      if (!isExportWorkerEvent(event) || event.jobId !== activeJobId) {
        if (event?.jobId === activeJobId) onError?.(new Error("Invalid export worker event"), false);
        return;
      }
      if (event.type === "PLAN_READY") {
        if (phase !== "planning" && phase !== "starting") {
          onError?.(new Error("Invalid export worker PLAN_READY event"), false);
          return;
        }
        phase = phase === "starting" ? "running" : "planned";
        onPlan?.(event.plan, event.resources);
      }
      else if (event.type === "PROGRESS") onProgress?.(event.progress);
      else if (event.type === "OUTPUT_CHUNK") {
        if (
          phase !== "running"
          || pendingOutputSequence !== null
          || !(event.chunk instanceof Uint8Array)
          || event.sequence !== nextOutputSequence
        ) {
          onError?.(new Error("Invalid export worker OUTPUT_CHUNK sequence"), false);
          try {
            next.postMessage({ type: "CANCEL", jobId: event.jobId });
          } catch {
            crashHandler?.("Export worker cancellation failed");
          }
          return;
        }
        pendingOutputSequence = event.sequence;
        void Promise.resolve(onOutput?.(event.chunk, event.sequence)).then(() => {
          if (
            activeJobId === event.jobId
            && worker === next
            && pendingOutputSequence === event.sequence
          ) {
            pendingOutputSequence = null;
            nextOutputSequence += 1;
            try {
              next.postMessage({ type: "OUTPUT_ACK", jobId: event.jobId, sequence: event.sequence });
            } catch {
              crashHandler?.("Export worker acknowledgement failed");
            }
          }
        }).catch((error) => {
          onError?.(safeError(error), false);
          try {
            next.postMessage({ type: "CANCEL", jobId: event.jobId });
          } catch {
            crashHandler?.("Export worker cancellation failed");
          }
        });
      } else if (event.type === "COMPLETE") {
        if (phase !== "running" || pendingOutputSequence !== null) {
          onError?.(new Error("Invalid export worker COMPLETE event"), false);
          return;
        }
        onComplete?.(event.result);
      }
      else if (event.type === "OWNERSHIP_RETURNED") {
        onOwnershipReturned?.(event.document);
        activeJobId = null;
        cancelling = false;
        phase = "idle";
        pendingOutputSequence = null;
        nextOutputSequence = 0;
        plannedDocument = null;
        plannedOptions = null;
      }
      else if (event.type === "ERROR") {
        phase = "failed";
        onError?.(new Error(event.message ?? event.code), event.recoverable);
      }
    };
    const handleCrash = (message: string) => {
      if (disposed || generation !== currentGeneration || worker !== next) return;
      const failedJobId = activeJobId;
      activeJobId = null;
      cancelling = false;
      phase = "idle";
      pendingOutputSequence = null;
      plannedDocument = null;
      plannedOptions = null;
      next.onmessage = null;
      next.onerror = null;
      next.onmessageerror = null;
      next.terminate();
      if (failedJobId !== null) onCrash?.(new Error(message));
      if (!disposed) replace();
    };
    crashHandler = handleCrash;
    next.onerror = (event) => {
      event.preventDefault?.();
      handleCrash("Export worker crashed");
    };
    next.onmessageerror = () => {
      handleCrash("Export worker message protocol failed");
    };
  };
  replace();
  const newJob = () => crypto.randomUUID();
  return {
    plan(document, options) {
      if (disposed) throw abortError("Export worker lifecycle has been disposed");
      if (activeJobId !== null) {
        throw new Error("An export worker job is already active");
      }
      const jobId = newJob();
      activeJobId = jobId;
      cancelling = false;
      phase = "planning";
      pendingOutputSequence = null;
      nextOutputSequence = 0;
      plannedDocument = document;
      plannedOptions = cloneableExportOptions(options);
      worker!.postMessage(
        { type: "PLAN", jobId, document, options: plannedOptions },
        exportWorkerTransferables(document),
      );
      return jobId;
    },
    start(document, options = {}, plan) {
      if (disposed || !activeJobId || !worker || cancelling || (phase !== "planning" && phase !== "planned")) return false;
      // A document sent by PLAN has already transferred its buffers. Reusing
      // the detached main-thread object in START would replace the worker's
      // live document with empty buffers, so START omits it after planning.
      const sourceDocument = document && !plannedDocument ? document : undefined;
      const sourceOptions = plannedOptions ?? options;
      const command: ExportWorkerCommand = {
        type: "START",
        jobId: activeJobId,
        ...(sourceDocument ? { document: sourceDocument } : {}),
        options: cloneableExportOptions(sourceOptions),
        ...(plan ? { plan } : {}),
      };
      phase = "starting";
      worker.postMessage(command, sourceDocument ? exportWorkerTransferables(sourceDocument) : []);
      return true;
    },
    cancel() {
      if (!activeJobId || !worker) return;
      cancelling = true;
      try {
        worker.postMessage({ type: "CANCEL", jobId: activeJobId });
      } catch {
        crashHandler?.("Export worker cancellation failed");
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      activeJobId = null;
      cancelling = false;
      phase = "idle";
      pendingOutputSequence = null;
      plannedDocument = null;
      plannedOptions = null;
      crashHandler = null;
      worker?.terminate();
      worker = null;
    },
    isCurrent(jobId) { return !disposed && activeJobId === jobId; },
    getActiveJobId() { return activeJobId; },
  };
};
