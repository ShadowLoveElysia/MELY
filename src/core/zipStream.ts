import {
  Zip,
  ZipDeflate,
  ZipPassThrough,
} from "fflate";
import { appError } from "./appError";

export type ZipChunkSink = (chunk: Uint8Array) => void | Promise<void>;

export interface ZipStreamOptions {
  maxOutputBytes?: number;
  signal?: AbortSignal;
  inputChunkBytes?: number;
}

export interface ZipStreamSummary {
  bytesWritten: number;
  fileCount: number;
}

export interface ZipStreamDiagnostics {
  inputChunkBytes: number;
  inputChunksPushed: number;
  pendingInputBytes: number;
  peakInputBytesInFlight: number;
  pendingOutputChunks: number;
  pendingOutputBytes: number;
  peakPendingOutputChunks: number;
  peakPendingOutputBytes: number;
}

export const MAX_ZIP32_OUTPUT_BYTES = 0xffff_ffff - 65_536;
export const DEFAULT_ZIP_INPUT_CHUNK_BYTES = 256 * 1024;

const outputLimit = (maximum?: number) => {
  const resolved = Math.min(maximum ?? MAX_ZIP32_OUTPUT_BYTES, MAX_ZIP32_OUTPUT_BYTES);
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError("ZIP output limit must be a positive safe integer");
  }
  return resolved;
};

const inputChunkSize = (size?: number) => {
  const resolved = size ?? DEFAULT_ZIP_INPUT_CHUNK_BYTES;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError("ZIP input chunk size must be a positive safe integer");
  }
  return resolved;
};

const abortReason = (signal: AbortSignal) => signal.reason instanceof Error
  ? signal.reason
  : new DOMException("ZIP generation was cancelled", "AbortError");

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw abortReason(signal);
};

const outputLimitError = (size: number, maximum: number) => appError("error.export.bundleOutput", {
  size: Math.ceil(size / 1024 ** 2),
  limit: Math.floor(maximum / 1024 ** 2),
});

export const combineZipChunks = (chunks: readonly Uint8Array[], byteLength: number) => {
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== byteLength) throw new Error("ZIP output length mismatch");
  return bytes;
};

export const createZipStreamWriter = (
  sink: ZipChunkSink,
  options: ZipStreamOptions = {},
  onBytesWritten: (bytes: number) => void = () => undefined,
) => {
  const maximumOutput = outputLimit(options.maxOutputBytes);
  const maximumInputChunk = inputChunkSize(options.inputChunkBytes);
  let bytesWritten = 0;
  let fileCount = 0;
  let failure: unknown;
  let inputChunksPushed = 0;
  let pendingInputBytes = 0;
  let peakInputBytesInFlight = 0;
  let pendingOutputChunks = 0;
  let pendingOutputBytes = 0;
  let peakPendingOutputChunks = 0;
  let peakPendingOutputBytes = 0;
  let state: "open" | "closing" | "closed" | "failed" = "open";
  let outputQueue = Promise.resolve();
  let failReject: ((reason: unknown) => void) | undefined;
  const failed = new Promise<never>((_resolve, reject) => {
    failReject = reject;
  });
  void failed.catch(() => undefined);
  let closeResolve: (() => void) | undefined;
  let closeReject: ((reason: unknown) => void) | undefined;
  const closed = new Promise<void>((resolve, reject) => {
    closeResolve = resolve;
    closeReject = reject;
  });
  void closed.catch(() => undefined);
  const archive = new Zip((error, chunk, final) => {
    const ownedChunk = chunk?.byteLength ? chunk.slice() : undefined;
    if (ownedChunk) {
      pendingOutputChunks += 1;
      pendingOutputBytes += ownedChunk.byteLength;
      peakPendingOutputChunks = Math.max(peakPendingOutputChunks, pendingOutputChunks);
      peakPendingOutputBytes = Math.max(peakPendingOutputBytes, pendingOutputBytes);
    }
    outputQueue = outputQueue.then(async () => {
      if (error) throw error;
      if (!ownedChunk) return;
      try {
        throwIfAborted(options.signal);
        const nextLength = bytesWritten + ownedChunk.byteLength;
        if (!Number.isSafeInteger(nextLength) || nextLength > maximumOutput) {
          throw outputLimitError(nextLength, maximumOutput);
        }
        await sink(ownedChunk);
        throwIfAborted(options.signal);
        bytesWritten = nextLength;
        onBytesWritten(bytesWritten);
      } finally {
        pendingOutputChunks -= 1;
        pendingOutputBytes -= ownedChunk.byteLength;
      }
    });
    void outputQueue.catch(setFailure);
    if (final) outputQueue.then(closeResolve, closeReject);
  });

  const onAbort = () => {
    if (options.signal) setFailure(abortReason(options.signal));
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  function setFailure(reason: unknown) {
    if (failure) return;
    failure = reason;
    state = "failed";
    failReject?.(reason);
    archive.terminate();
    closeReject?.(reason);
    options.signal?.removeEventListener("abort", onAbort);
  }

  const throwIfFailed = () => {
    if (failure) throw failure;
  };

  const waitForOutput = async () => {
    await Promise.race([outputQueue, failed]);
    throwIfFailed();
    throwIfAborted(options.signal);
  };

  const add = async (path: string, bytes: Uint8Array, compress = true) => {
    throwIfFailed();
    if (state !== "open") throw new Error(`ZIP writer is ${state}`);
    throwIfAborted(options.signal);
    await waitForOutput();
    const input = compress
      ? new ZipDeflate(path, { level: 6 })
      : new ZipPassThrough(path);
    archive.add(input);
    const completed = new Promise<void>((resolve, reject) => {
      const forward = input.ondata;
      if (!forward) {
        reject(new Error("ZIP input stream was not attached"));
        return;
      }
      input.ondata = (error, data, final) => {
        try {
          forward(error, data, final);
          if (error) reject(error);
          else if (final) resolve();
        } catch (streamError) {
          reject(streamError);
        }
      };
    });
    await waitForOutput();
    if (bytes.byteLength === 0) {
      input.push(bytes.slice(), true);
      await waitForOutput();
    }
    else {
      for (let offset = 0; offset < bytes.byteLength; offset += maximumInputChunk) {
        throwIfAborted(options.signal);
        throwIfFailed();
        const end = Math.min(bytes.byteLength, offset + maximumInputChunk);
        const chunk = bytes.slice(offset, end);
        inputChunksPushed += 1;
        pendingInputBytes = chunk.byteLength;
        peakInputBytesInFlight = Math.max(peakInputBytesInFlight, pendingInputBytes);
        input.push(chunk, end === bytes.byteLength);
        pendingInputBytes = 0;
        await waitForOutput();
      }
    }
    await Promise.race([completed, failed]);
    await waitForOutput();
    fileCount += 1;
  };

  return {
    add,
    abort: () => {
      if (state === "closed" || state === "failed") return;
      const reason = options.signal?.aborted
        ? abortReason(options.signal)
        : new DOMException("ZIP generation was cancelled", "AbortError");
      setFailure(reason);
    },
    close: async (): Promise<ZipStreamSummary> => {
      throwIfFailed();
      if (state !== "open") throw new Error(`ZIP writer is ${state}`);
      throwIfAborted(options.signal);
      state = "closing";
      archive.end();
      await Promise.race([closed, failed]);
      await waitForOutput();
      state = "closed";
      options.signal?.removeEventListener("abort", onAbort);
      return { bytesWritten, fileCount };
    },
    get bytesWritten() {
      return bytesWritten;
    },
    get diagnostics(): ZipStreamDiagnostics {
      return {
        inputChunkBytes: maximumInputChunk,
        inputChunksPushed,
        pendingInputBytes,
        peakInputBytesInFlight,
        pendingOutputChunks,
        pendingOutputBytes,
        peakPendingOutputChunks,
        peakPendingOutputBytes,
      };
    },
  };
};

export const createZipCollector = (options: Pick<ZipStreamOptions, "maxOutputBytes"> = {}) => {
  const maximumOutput = outputLimit(options.maxOutputBytes);
  const chunks: Uint8Array[] = [];
  let bytesWritten = 0;
  let fileCount = 0;
  let error: unknown;
  let finished = false;
  const archive = new Zip((archiveError, chunk, final) => {
    if (archiveError) error = archiveError;
    if (chunk?.byteLength) {
      const nextLength = bytesWritten + chunk.byteLength;
      if (!Number.isSafeInteger(nextLength) || nextLength > maximumOutput) {
        error = outputLimitError(nextLength, maximumOutput);
      } else {
        chunks.push(chunk.slice());
        bytesWritten = nextLength;
      }
    }
    if (final) finished = true;
  });
  const assertHealthy = () => {
    if (error) throw error;
  };

  return {
    add: (path: string, bytes: Uint8Array, compress = true) => {
      assertHealthy();
      const input = compress
        ? new ZipDeflate(path, { level: 6 })
        : new ZipPassThrough(path);
      archive.add(input);
      if (bytes.byteLength === 0) input.push(bytes, true);
      else {
        for (let offset = 0; offset < bytes.byteLength; offset += DEFAULT_ZIP_INPUT_CHUNK_BYTES) {
          const end = Math.min(bytes.byteLength, offset + DEFAULT_ZIP_INPUT_CHUNK_BYTES);
          input.push(bytes.subarray(offset, end), end === bytes.byteLength);
          assertHealthy();
        }
      }
      fileCount += 1;
    },
    close: () => {
      archive.end();
      assertHealthy();
      if (!finished) throw new Error("ZIP collector did not finish synchronously");
      return {
        bytes: combineZipChunks(chunks, bytesWritten),
        summary: { bytesWritten, fileCount },
      };
    },
  };
};
