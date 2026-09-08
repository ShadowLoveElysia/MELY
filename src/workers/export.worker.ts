/// <reference lib="webworker" />

import {
  createExportBundleStream,
  planExportBundle,
  type ExportBundleOptions,
} from "../core/exportBundle";
import type { ProjectionDocument } from "../types";
import {
  exportWorkerTransferables,
  type ExportWorkerCommand,
  type ExportWorkerEvent,
} from "../core/exportWorkerProtocol";

let activeJobId: string | null = null;
let cancelled = false;
let waitingAck: { sequence: number; resolve: () => void } | null = null;
let plannedDocument: ProjectionDocument | null = null;
let plannedOptions: ExportBundleOptions | null = null;
let plannedResult: ReturnType<typeof planExportBundle> | null = null;
let planReady = false;
let runStarted = false;

const send = (event: ExportWorkerEvent, transfer: Transferable[] = []) => {
  self.postMessage(event, { transfer });
};

const throwIfCancelled = () => {
  if (cancelled) throw new DOMException("Export was cancelled", "AbortError");
};

const waitForAck = (sequence: number) => new Promise<void>((resolve) => {
  waitingAck = { sequence, resolve };
});

const run = async (
  jobId: string,
  document: ProjectionDocument,
  options: ExportBundleOptions,
  planned?: ReturnType<typeof planExportBundle>,
) => {
  activeJobId = jobId;
  const indexedOptions = planned ? { ...options, partitionIndex: planned.partitionIndex } : options;
  try {
    const plan = planned ?? planExportBundle(document, indexedOptions);
    let sequence = 0;
    const streamed = await createExportBundleStream(document, async (chunk) => {
      throwIfCancelled();
      const current = sequence++;
      send({ type: "OUTPUT_CHUNK", jobId, sequence: current, chunk }, [chunk.buffer]);
      await waitForAck(current);
      throwIfCancelled();
    }, {
      ...indexedOptions,
      onProgress: (progress) => send({ type: "PROGRESS", jobId, progress }),
    });
    send({ type: "COMPLETE", jobId, result: streamed });
  } catch (error) {
    const recoverable = error instanceof DOMException && error.name === "AbortError";
    send({ type: "ERROR", jobId, code: recoverable ? "EXPORT_CANCELLED" : "EXPORT_FAILED", recoverable });
  } finally {
    // The document's buffers are returned only after the worker has stopped
    // reading them.  A crashed worker cannot reach this handshake.
    if (activeJobId === jobId) {
      send({ type: "OWNERSHIP_RETURNED", jobId, document }, exportWorkerTransferables(document));
      activeJobId = null;
      waitingAck = null;
      plannedDocument = null;
      plannedOptions = null;
      plannedResult = null;
      planReady = false;
      runStarted = false;
    }
  }
};

self.onmessage = (event: MessageEvent<ExportWorkerCommand>) => {
  const command = event.data;
  if (!command || typeof command !== "object") return;
  if (command.type === "CANCEL") {
    if (command.jobId === activeJobId) {
      cancelled = true;
      waitingAck?.resolve();
    }
    return;
  }
  if (command.type === "OUTPUT_ACK") {
    if (command.jobId === activeJobId && waitingAck?.sequence === command.sequence) {
      waitingAck.resolve();
      waitingAck = null;
    }
    return;
  }
  if (command.jobId !== activeJobId && activeJobId !== null) return;
  if (command.type === "PLAN") {
    if (activeJobId !== null) {
      send({
        type: "ERROR",
        jobId: command.jobId,
        code: "EXPORT_PLAN_FAILED",
        message: "An export job is already active",
        recoverable: false,
      });
      return;
    }
    activeJobId = command.jobId;
    cancelled = false;
    waitingAck = null;
    planReady = false;
    runStarted = false;
    plannedDocument = command.document;
    plannedOptions = command.options;
    try {
      plannedResult = planExportBundle(command.document, command.options);
      if (cancelled) throw new DOMException("Export was cancelled", "AbortError");
      planReady = true;
      const publicPlan = { ...plannedResult.plan };
      delete (publicPlan as { partitionIndex?: unknown }).partitionIndex;
      send({
        type: "PLAN_READY",
        jobId: command.jobId,
        plan: publicPlan,
        resources: plannedResult.resources,
      });
    } catch (error) {
      send({
        type: "ERROR",
        jobId: command.jobId,
        code: "EXPORT_PLAN_FAILED",
        recoverable: false,
      });
      // Planning can fail before START arrives, so explicitly return the
      // transferred document instead of leaving the caller waiting forever.
      if (activeJobId === command.jobId && plannedDocument) {
        const document = plannedDocument;
        send({ type: "OWNERSHIP_RETURNED", jobId: command.jobId, document }, exportWorkerTransferables(document));
        activeJobId = null;
        plannedDocument = null;
        plannedOptions = null;
        plannedResult = null;
        planReady = false;
      }
    }
    return;
  }

  if (command.type !== "START") return;
  try {
    if (!planReady || !plannedResult || !plannedDocument || runStarted) {
      throw new Error("START requires exactly one successful PLAN");
    }
    if (command.document) {
      throw new Error("START must reuse the document transferred during PLAN");
    }
    if (cancelled) throw new DOMException("Export was cancelled", "AbortError");
    runStarted = true;
    void run(command.jobId, plannedDocument, plannedOptions ?? command.options, plannedResult);
  } catch (error) {
    send({
      type: "ERROR",
      jobId: command.jobId,
      code: "EXPORT_PLAN_FAILED",
      recoverable: false,
    });
    if (activeJobId === command.jobId && plannedDocument) {
      const document = plannedDocument;
      send({ type: "OWNERSHIP_RETURNED", jobId: command.jobId, document }, exportWorkerTransferables(document));
      activeJobId = null;
      plannedDocument = null;
      plannedOptions = null;
      plannedResult = null;
      planReady = false;
      runStarted = false;
    }
  }
};

export {};
