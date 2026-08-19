import type { WorkerCommand, WorkerEvent } from "../types";

export interface ConversionWorkerPort {
  onmessage: ((event: MessageEvent<WorkerEvent>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
  postMessage: (message: WorkerCommand, transfer: Transferable[]) => void;
  terminate: () => void;
}

interface ConversionWorkerLifecycleOptions {
  createWorker: () => ConversionWorkerPort;
  onEvent: (event: WorkerEvent) => void;
}

export interface ConversionWorkerLifecycle {
  start: (jobId: string) => void;
  post: (jobId: string, command: WorkerCommand, transfer?: Transferable[]) => boolean;
  cancel: () => void;
  isCurrent: (jobId: string) => boolean;
  dispose: () => void;
}

export const createConversionWorkerLifecycle = ({
  createWorker,
  onEvent,
}: ConversionWorkerLifecycleOptions): ConversionWorkerLifecycle => {
  let worker: ConversionWorkerPort | null = null;
  let activeJobId: string | null = null;
  let generation = 0;
  let disposed = false;

  const detachWorker = (target: ConversionWorkerPort) => {
    target.onmessage = null;
    target.onerror = null;
    target.onmessageerror = null;
  };

  const replaceWorker = () => {
    generation += 1;
    const currentGeneration = generation;
    const previous = worker;
    worker = null;
    if (previous) {
      detachWorker(previous);
      previous.terminate();
    }
    if (disposed) return;

    const next = createWorker();
    worker = next;
    const handleWorkerFailure = (code: "error.worker.crashed" | "error.worker.protocol") => {
      if (
        disposed
        || generation !== currentGeneration
        || worker !== next
      ) return;
      const failedJobId = activeJobId;
      activeJobId = null;
      detachWorker(next);
      next.terminate();
      worker = null;
      replaceWorker();
      if (failedJobId !== null) {
        onEvent({ type: "ERROR", jobId: failedJobId, code });
      }
    };
    next.onmessage = (message) => {
      const event = message.data;
      if (
        disposed
        || generation !== currentGeneration
        || worker !== next
      ) return;
      if (
        !event
        || typeof event !== "object"
        || !("jobId" in event)
        || typeof event.jobId !== "string"
        || !("type" in event)
        || !["PROGRESS", "RESULT", "ERROR"].includes(String(event.type))
      ) {
        handleWorkerFailure("error.worker.protocol");
        return;
      }
      if (event.jobId !== activeJobId) return;
      onEvent(event);
    };
    next.onerror = (event) => {
      event.preventDefault?.();
      handleWorkerFailure("error.worker.crashed");
    };
    next.onmessageerror = () => handleWorkerFailure("error.worker.protocol");
  };

  replaceWorker();

  return {
    start: (jobId) => {
      if (disposed) throw new Error("Conversion worker lifecycle has been disposed.");
      const replacesActiveJob = activeJobId !== null;
      activeJobId = jobId;
      if (replacesActiveJob || !worker) replaceWorker();
    },
    post: (jobId, command, transfer = []) => {
      if (disposed || activeJobId !== jobId || command.jobId !== jobId || !worker) return false;
      worker.postMessage(command, transfer);
      return true;
    },
    cancel: () => {
      if (disposed || activeJobId === null) return;
      activeJobId = null;
      replaceWorker();
    },
    isCurrent: (jobId) => !disposed && activeJobId === jobId,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      activeJobId = null;
      replaceWorker();
    },
  };
};
