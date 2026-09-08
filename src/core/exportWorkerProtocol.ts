import type { ExportBundleOptions, ExportBundlePlan, ExportBundleProgress, ExportBundleResourceEstimate, StreamedExportBundle } from "./exportBundle";
import type { ProjectionDocument } from "../types";

export type ExportWorkerCommand =
  | { type: "PLAN"; jobId: string; document: ProjectionDocument; options: ExportBundleOptions }
  | { type: "START"; jobId: string; document?: ProjectionDocument; options: ExportBundleOptions; plan?: ExportBundlePlan }
  | { type: "CANCEL"; jobId: string }
  | { type: "OUTPUT_ACK"; jobId: string; sequence: number };

export type ExportWorkerEvent =
  | { type: "PLAN_READY"; jobId: string; plan: ExportBundlePlan; resources: ExportBundleResourceEstimate }
  | { type: "PROGRESS"; jobId: string; progress: ExportBundleProgress }
  | { type: "OUTPUT_CHUNK"; jobId: string; sequence: number; chunk: Uint8Array; final?: boolean }
  | { type: "OWNERSHIP_RETURNED"; jobId: string; document: ProjectionDocument }
  | { type: "COMPLETE"; jobId: string; result: StreamedExportBundle }
  | { type: "ERROR"; jobId: string; code: string; message?: string; recoverable: boolean };

export interface ExportWorkerPort {
  postMessage(message: ExportWorkerCommand, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<ExportWorkerEvent>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
}

/** Remove runtime-only fields before an options object crosses the Worker IPC boundary. */
export const cloneableExportOptions = <T extends {
  signal?: AbortSignal;
  onProgress?: unknown;
  partitionIndex?: unknown;
}>(options: T): Omit<T, "signal" | "onProgress" | "partitionIndex"> => {
  const clone = { ...options } as T & {
    signal?: AbortSignal;
    onProgress?: unknown;
    partitionIndex?: unknown;
  };
  delete clone.signal;
  delete clone.onProgress;
  delete clone.partitionIndex;
  return clone as Omit<T, "signal" | "onProgress" | "partitionIndex">;
};

export const exportWorkerTransferables = (document: ProjectionDocument): Transferable[] => {
  const buffers = new Set<ArrayBuffer>();
  for (const chunk of document.chunks) {
    buffers.add(chunk.positions.buffer as ArrayBuffer);
    buffers.add(chunk.paletteIndices.buffer as ArrayBuffer);
  }
  return [...buffers];
};

export const isExportWorkerEvent = (value: unknown): value is ExportWorkerEvent => {
  if (!value || typeof value !== "object" || !("type" in value) || !("jobId" in value)) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.jobId !== "string" || candidate.jobId.length === 0) return false;
  if (candidate.type === "OUTPUT_CHUNK") {
    return candidate.chunk instanceof Uint8Array
      && Number.isSafeInteger(candidate.sequence)
      && Number(candidate.sequence) >= 0;
  }
  if (candidate.type === "PLAN_READY") {
    return !!candidate.plan && typeof candidate.plan === "object"
      && !!candidate.resources && typeof candidate.resources === "object";
  }
  if (candidate.type === "PROGRESS") return !!candidate.progress && typeof candidate.progress === "object";
  if (candidate.type === "OWNERSHIP_RETURNED") {
    return !!candidate.document && typeof candidate.document === "object";
  }
  if (candidate.type === "COMPLETE") return !!candidate.result && typeof candidate.result === "object";
  if (candidate.type === "ERROR") {
    return typeof candidate.code === "string"
      && typeof candidate.recoverable === "boolean"
      && (candidate.message === undefined || typeof candidate.message === "string");
  }
  return false;
};
