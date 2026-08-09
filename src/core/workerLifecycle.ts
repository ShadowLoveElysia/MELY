import type { WorkerCommand, WorkerEvent } from "../types";

export interface ConversionWorkerPort {
  onmessage: ((event: MessageEvent<WorkerEvent>) => void) | null;
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

  const replaceWorker = () => {
    generation += 1;
    const currentGeneration = generation;
    const previous = worker;
    worker = null;
    if (previous) {
      previous.onmessage = null;
      previous.terminate();
    }
    if (disposed) return;

    const next = createWorker();
    worker = next;
    next.onmessage = (message) => {
      const event = message.data;
      if (
        disposed
        || generation !== currentGeneration
        || worker !== next
        || event.jobId !== activeJobId
      ) return;
      onEvent(event);
    };
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
