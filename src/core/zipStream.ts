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
  /** 仅供边界测试注入 ZIP32 计数初值，不应用于生产调用。 */
  zip32TestState?: Zip32TestState;
}

export interface Zip32TestState {
  entryCount?: number;
  localOffset?: number;
  centralDirectorySize?: number;
  entryUncompressedSize?: number;
  entryCompressedSize?: number;
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

export const MAX_ZIP32_VALUE = 0xffff_ffff;
export const MAX_ZIP32_ENTRIES = 0xffff;
export const MAX_ZIP32_NAME_BYTES = 0xffff;
export const MAX_ZIP32_OUTPUT_BYTES = MAX_ZIP32_VALUE;
export const DEFAULT_ZIP_INPUT_CHUNK_BYTES = 256 * 1024;

const ZIP_LOCAL_HEADER_FIXED_BYTES = 30;
const ZIP_DATA_DESCRIPTOR_BYTES = 16;
const ZIP_CENTRAL_HEADER_FIXED_BYTES = 46;
const ZIP_END_RECORD_BYTES = 22;
const utf8Encoder = new TextEncoder();

interface Zip32State {
  entryCount: number;
  localOffset: number;
  centralDirectorySize: number;
}

export interface Zip32EntryCheck {
  nameBytes: number;
  uncompressedSize: number;
  compressedSize: number;
}

const zip32Error = (field: string, value: number, maximum: number) => new RangeError(
  `ZIP32 ${field} ${value} exceeds maximum ${maximum}`,
);

const zip32Integer = (value: number, field: string) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`ZIP32 ${field} must be a non-negative safe integer`);
  }
  return value;
};

const checkedZip32Sum = (field: string, maximum: number, ...values: number[]) => {
  const sum = values.reduce((total, value) => total + zip32Integer(value, field), 0);
  if (!Number.isSafeInteger(sum) || sum > maximum) throw zip32Error(field, sum, maximum);
  return sum;
};

export const assertZip32Entry = (
  state: Readonly<Zip32State>,
  entry: Readonly<Zip32EntryCheck>,
): Zip32State => {
  const entryCount = checkedZip32Sum("entry count", MAX_ZIP32_ENTRIES, state.entryCount, 1);
  const nameBytes = zip32Integer(entry.nameBytes, "UTF-8 filename length");
  if (nameBytes > MAX_ZIP32_NAME_BYTES) {
    throw zip32Error("UTF-8 filename length", nameBytes, MAX_ZIP32_NAME_BYTES);
  }
  const uncompressedSize = zip32Integer(entry.uncompressedSize, "uncompressed entry size");
  if (uncompressedSize > MAX_ZIP32_VALUE) {
    throw zip32Error("uncompressed entry size", uncompressedSize, MAX_ZIP32_VALUE);
  }
  const compressedSize = zip32Integer(entry.compressedSize, "compressed entry size");
  if (compressedSize > MAX_ZIP32_VALUE) {
    throw zip32Error("compressed entry size", compressedSize, MAX_ZIP32_VALUE);
  }
  const localRecordSize = checkedZip32Sum(
    "local record size",
    MAX_ZIP32_VALUE,
    ZIP_LOCAL_HEADER_FIXED_BYTES,
    nameBytes,
    compressedSize,
    ZIP_DATA_DESCRIPTOR_BYTES,
  );
  const localOffset = checkedZip32Sum(
    "local data offset",
    MAX_ZIP32_VALUE,
    state.localOffset,
    localRecordSize,
  );
  const centralDirectorySize = checkedZip32Sum(
    "central directory size",
    MAX_ZIP32_VALUE,
    state.centralDirectorySize,
    ZIP_CENTRAL_HEADER_FIXED_BYTES,
    nameBytes,
  );
  checkedZip32Sum(
    "central directory offset",
    MAX_ZIP32_VALUE,
    localOffset,
    centralDirectorySize,
    ZIP_END_RECORD_BYTES,
  );
  return { entryCount, localOffset, centralDirectorySize };
};

const initialZip32State = (testState?: Zip32TestState): Zip32State => ({
  entryCount: zip32Integer(testState?.entryCount ?? 0, "entry count"),
  localOffset: zip32Integer(testState?.localOffset ?? 0, "local data offset"),
  centralDirectorySize: zip32Integer(
    testState?.centralDirectorySize ?? 0,
    "central directory size",
  ),
});

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
  let zip32State = initialZip32State(options.zip32TestState);
  let bytesWritten = 0;
  let fileCount = 0;
  let currentEntryCompressedSize = 0;
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
      if (state === "open") currentEntryCompressedSize += ownedChunk.byteLength;
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
    const nameBytes = utf8Encoder.encode(path).byteLength;
    const uncompressedSize = options.zip32TestState?.entryUncompressedSize ?? bytes.byteLength;
    if (nameBytes > MAX_ZIP32_NAME_BYTES) {
      throw zip32Error("UTF-8 filename length", nameBytes, MAX_ZIP32_NAME_BYTES);
    }
    if (uncompressedSize > MAX_ZIP32_VALUE) {
      throw zip32Error("uncompressed entry size", uncompressedSize, MAX_ZIP32_VALUE);
    }
    // 已知字段在交给 fflate 前验证，避免其 16/32 位写入发生静默截断。
    assertZip32Entry(zip32State, { nameBytes, uncompressedSize, compressedSize: 0 });
    currentEntryCompressedSize = 0;
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
    const emittedLocalRecordBytes = currentEntryCompressedSize;
    currentEntryCompressedSize = 0;
    const compressedSize = options.zip32TestState?.entryCompressedSize
      ?? emittedLocalRecordBytes - ZIP_LOCAL_HEADER_FIXED_BYTES - nameBytes - ZIP_DATA_DESCRIPTOR_BYTES;
    try {
      zip32State = assertZip32Entry(zip32State, {
        nameBytes,
        uncompressedSize,
        compressedSize,
      });
    } catch (error) {
      setFailure(error);
      throw error;
    }
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
      checkedZip32Sum(
        "central directory offset",
        MAX_ZIP32_VALUE,
        zip32State.localOffset,
        zip32State.centralDirectorySize,
        ZIP_END_RECORD_BYTES,
      );
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

export const createZipCollector = (options: Pick<
  ZipStreamOptions,
  "maxOutputBytes" | "zip32TestState"
> = {}) => {
  const maximumOutput = outputLimit(options.maxOutputBytes);
  let zip32State = initialZip32State(options.zip32TestState);
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
      const nameBytes = utf8Encoder.encode(path).byteLength;
      const uncompressedSize = options.zip32TestState?.entryUncompressedSize ?? bytes.byteLength;
      if (nameBytes > MAX_ZIP32_NAME_BYTES) {
        throw zip32Error("UTF-8 filename length", nameBytes, MAX_ZIP32_NAME_BYTES);
      }
      if (uncompressedSize > MAX_ZIP32_VALUE) {
        throw zip32Error("uncompressed entry size", uncompressedSize, MAX_ZIP32_VALUE);
      }
      assertZip32Entry(zip32State, { nameBytes, uncompressedSize, compressedSize: 0 });
      const entryStart = bytesWritten;
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
      const emittedLocalRecordBytes = bytesWritten - entryStart;
      const compressedSize = options.zip32TestState?.entryCompressedSize
        ?? emittedLocalRecordBytes - ZIP_LOCAL_HEADER_FIXED_BYTES - nameBytes - ZIP_DATA_DESCRIPTOR_BYTES;
      try {
        zip32State = assertZip32Entry(zip32State, {
          nameBytes,
          uncompressedSize,
          compressedSize,
        });
      } catch (zip32Failure) {
        error = zip32Failure;
        throw zip32Failure;
      }
      fileCount += 1;
    },
    close: () => {
      checkedZip32Sum(
        "central directory offset",
        MAX_ZIP32_VALUE,
        zip32State.localOffset,
        zip32State.centralDirectorySize,
        ZIP_END_RECORD_BYTES,
      );
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
