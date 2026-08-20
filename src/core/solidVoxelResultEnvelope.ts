import type {
  SolidVoxelChunk,
  VoxelPaletteEntry,
} from "../types";

/** 原生实体结果分页协议；所有多字节字段均为 little-endian。 */
export const SOLID_VOXEL_RESULT_BATCH_MAGIC = "MLYRBAT\0";
export const SOLID_VOXEL_RESULT_BATCH_VERSION = 1;
export const SOLID_VOXEL_RESULT_BATCH_HEADER_SIZE = 72;
export const SOLID_VOXEL_RESULT_BATCH_ALIGNMENT = 8;
export const SOLID_VOXEL_RESULT_BATCH_MAX_CURSOR_BYTES = 4_096;

export const SOLID_VOXEL_RESULT_BATCH_FLAG = {
  first: 1 << 0,
  last: 1 << 1,
} as const;

const MAGIC = new TextEncoder().encode(SOLID_VOXEL_RESULT_BATCH_MAGIC);
const CHECKSUM_OFFSET = 20;
const PALETTE_FIXED_SIZE = 12;
const CHUNK_FIXED_SIZE = 24;
const CHUNK_CAPACITY = 32 ** 3;
const MAX_PALETTE_ENTRIES = 0x1_0000;
const MAX_STRING_BYTES = 1 << 20;
const U32_MAX = 0xffff_ffff;
const U64_MAX = 0xffff_ffff_ffff_ffffn;
const KNOWN_FLAGS = SOLID_VOXEL_RESULT_BATCH_FLAG.first
  | SOLID_VOXEL_RESULT_BATCH_FLAG.last;

export interface SolidVoxelResultHandleEnvelope {
  id: bigint;
  generation: bigint;
}

export interface SolidVoxelResultBatchEnvelope {
  version: typeof SOLID_VOXEL_RESULT_BATCH_VERSION;
  handle: SolidVoxelResultHandleEnvelope;
  startChunkIndex: number;
  totalChunkCount: number;
  totalPaletteCount: number;
  first: boolean;
  done: boolean;
  cursor: string | null;
  palette?: VoxelPaletteEntry[];
  chunks: SolidVoxelChunk[];
}

export type SolidVoxelResultEnvelopeErrorCode =
  | "invalid-input"
  | "invalid-magic"
  | "unsupported-version"
  | "invalid-header"
  | "truncated"
  | "overflow"
  | "misaligned"
  | "non-zero-padding"
  | "checksum-mismatch"
  | "invalid-cursor"
  | "invalid-utf8"
  | "invalid-palette"
  | "invalid-chunk"
  | "invalid-order";

export class SolidVoxelResultEnvelopeError extends Error {
  constructor(
    readonly code: SolidVoxelResultEnvelopeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SolidVoxelResultEnvelopeError";
  }
}

const fail = (code: SolidVoxelResultEnvelopeErrorCode, message: string): never => {
  throw new SolidVoxelResultEnvelopeError(code, message);
};

const align8 = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    return fail("overflow", "alignment input is out of range");
  }
  const aligned = value + (SOLID_VOXEL_RESULT_BATCH_ALIGNMENT - value % SOLID_VOXEL_RESULT_BATCH_ALIGNMENT)
    % SOLID_VOXEL_RESULT_BATCH_ALIGNMENT;
  if (!Number.isSafeInteger(aligned) || aligned > U32_MAX) {
    return fail("overflow", "aligned offset exceeds u32");
  }
  return aligned;
};

const checkedAdd = (left: number, right: number, label: string) => {
  const sum = left + right;
  if (!Number.isSafeInteger(sum) || sum < 0 || sum > U32_MAX) {
    return fail("overflow", `${label} exceeds u32`);
  }
  return sum;
};

const toSafeNumber = (value: bigint, label: string) => {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    return fail("overflow", `${label} exceeds the JavaScript safe integer range`);
  }
  return Number(value);
};

const assertZeroRange = (bytes: Uint8Array, start: number, end: number, label: string) => {
  for (let offset = start; offset < end; offset += 1) {
    if (bytes[offset] !== 0) return fail("non-zero-padding", `${label} contains non-zero padding`);
  }
};

const decodeUtf8 = (bytes: Uint8Array, label: string) => {
  if (bytes.byteLength > MAX_STRING_BYTES) return fail("overflow", `${label} exceeds the string limit`);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return fail("invalid-utf8", `${label} is not valid UTF-8`);
  }
};

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? (value >>> 1) ^ 0xedb8_8320 : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/** CRC-32/ISO-HDLC；校验时 20..23 字节视为零。 */
export const solidVoxelResultEnvelopeCrc32 = (
  bytes: Uint8Array,
  zeroChecksumField = false,
) => {
  let crc = 0xffff_ffff;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    const value = zeroChecksumField && index >= CHECKSUM_OFFSET && index < CHECKSUM_OFFSET + 4
      ? 0
      : bytes[index];
    crc = (crc >>> 8) ^ crcTable[(crc ^ value) & 0xff];
  }
  return (crc ^ 0xffff_ffff) >>> 0;
};

const compareYzx = (
  left: readonly [number, number, number],
  right: readonly [number, number, number],
) => left[1] - right[1] || left[2] - right[2] || left[0] - right[0];

const decodeCursor = (bytes: Uint8Array, done: boolean) => {
  if (done) {
    if (bytes.byteLength !== 0) return fail("invalid-cursor", "last result batch must not contain a cursor");
    return null;
  }
  if (bytes.byteLength === 0 || bytes.byteLength > SOLID_VOXEL_RESULT_BATCH_MAX_CURSOR_BYTES) {
    return fail("invalid-cursor", "non-final result batch must contain a bounded cursor");
  }
  for (const byte of bytes) {
    if (byte < 0x21 || byte > 0x7e) {
      return fail("invalid-cursor", "result batch cursor must use visible ASCII bytes");
    }
  }
  return String.fromCharCode(...bytes);
};

interface DecodeState {
  bytes: Uint8Array;
  view: DataView;
  offset: number;
}

const decodePalette = (
  state: DecodeState,
  count: number,
  byteLength: number,
) => {
  const sectionStart = state.offset;
  const sectionEnd = checkedAdd(sectionStart, byteLength, "palette section end");
  if (sectionEnd > state.bytes.byteLength) return fail("truncated", "palette section exceeds the envelope");
  const palette: VoxelPaletteEntry[] = [];
  const blockIds = new Set<string>();

  for (let index = 0; index < count; index += 1) {
    if (state.offset % SOLID_VOXEL_RESULT_BATCH_ALIGNMENT !== 0) {
      return fail("misaligned", `palette record ${index} is not 8-byte aligned`);
    }
    if (state.offset + PALETTE_FIXED_SIZE > sectionEnd) {
      return fail("truncated", `palette record ${index} is truncated`);
    }
    const logicalLength = state.view.getUint32(state.offset, true);
    const blockIdLength = state.view.getUint32(state.offset + 4, true);
    if (logicalLength !== PALETTE_FIXED_SIZE + blockIdLength || blockIdLength === 0) {
      return fail("invalid-palette", `palette record ${index} has an invalid length`);
    }
    if (state.view.getUint8(state.offset + 11) !== 0) {
      return fail("invalid-palette", `palette record ${index} has non-zero reserved data`);
    }
    const recordEnd = checkedAdd(state.offset, logicalLength, `palette record ${index} end`);
    const paddedEnd = align8(recordEnd);
    if (recordEnd > sectionEnd || paddedEnd > sectionEnd) {
      return fail("truncated", `palette record ${index} exceeds the palette section`);
    }
    const blockId = decodeUtf8(
      state.bytes.subarray(state.offset + PALETTE_FIXED_SIZE, recordEnd),
      `palette record ${index} blockId`,
    );
    if (!blockId || blockIds.has(blockId)) {
      return fail("invalid-palette", `palette record ${index} has an empty or duplicate blockId`);
    }
    blockIds.add(blockId);
    palette.push({
      blockId,
      color: [
        state.view.getUint8(state.offset + 8),
        state.view.getUint8(state.offset + 9),
        state.view.getUint8(state.offset + 10),
      ],
    });
    assertZeroRange(state.bytes, recordEnd, paddedEnd, `palette record ${index}`);
    state.offset = paddedEnd;
  }
  if (state.offset !== sectionEnd) {
    return fail("invalid-palette", "paletteByteLength does not exactly cover its records");
  }
  return palette;
};

const decodeChunks = (
  state: DecodeState,
  count: number,
  totalPaletteCount: number,
) => {
  const chunks: SolidVoxelChunk[] = [];
  let previousChunk: [number, number, number] | undefined;

  for (let chunkIndex = 0; chunkIndex < count; chunkIndex += 1) {
    if (state.offset % SOLID_VOXEL_RESULT_BATCH_ALIGNMENT !== 0) {
      return fail("misaligned", `chunk record ${chunkIndex} is not 8-byte aligned`);
    }
    if (state.offset + CHUNK_FIXED_SIZE > state.bytes.byteLength) {
      return fail("truncated", `chunk record ${chunkIndex} is truncated`);
    }
    const logicalLength = state.view.getUint32(state.offset, true);
    const chunk: [number, number, number] = [
      state.view.getInt32(state.offset + 4, true),
      state.view.getInt32(state.offset + 8, true),
      state.view.getInt32(state.offset + 12, true),
    ];
    const blockCount = state.view.getUint32(state.offset + 16, true);
    if (blockCount === 0 || blockCount > CHUNK_CAPACITY) {
      return fail("invalid-chunk", `chunk record ${chunkIndex} has an invalid block count`);
    }
    if (state.view.getUint32(state.offset + 20, true) !== 0) {
      return fail("invalid-chunk", `chunk record ${chunkIndex} has non-zero reserved data`);
    }
    const expectedLength = CHUNK_FIXED_SIZE + blockCount * 4;
    if (logicalLength !== expectedLength) {
      return fail("invalid-chunk", `chunk record ${chunkIndex} has an invalid length`);
    }
    const recordEnd = checkedAdd(state.offset, logicalLength, `chunk record ${chunkIndex} end`);
    const paddedEnd = align8(recordEnd);
    if (recordEnd > state.bytes.byteLength || paddedEnd > state.bytes.byteLength) {
      return fail("truncated", `chunk record ${chunkIndex} exceeds the envelope`);
    }
    if (previousChunk && compareYzx(previousChunk, chunk) >= 0) {
      return fail("invalid-order", `chunk record ${chunkIndex} is not strictly ordered by Y, Z, X`);
    }

    const positions = new Uint16Array(blockCount);
    const blockIndices = new Uint16Array(blockCount);
    const positionsOffset = state.offset + CHUNK_FIXED_SIZE;
    const blockIndicesOffset = positionsOffset + blockCount * 2;
    let previousPosition = -1;
    for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
      const position = state.view.getUint16(positionsOffset + blockIndex * 2, true);
      const paletteIndex = state.view.getUint16(blockIndicesOffset + blockIndex * 2, true);
      if (position >= CHUNK_CAPACITY || position <= previousPosition) {
        return fail("invalid-chunk", `chunk record ${chunkIndex} positions are not canonical`);
      }
      if (paletteIndex >= totalPaletteCount) {
        return fail("invalid-chunk", `chunk record ${chunkIndex} references an unknown palette entry`);
      }
      positions[blockIndex] = position;
      blockIndices[blockIndex] = paletteIndex;
      previousPosition = position;
    }
    assertZeroRange(state.bytes, recordEnd, paddedEnd, `chunk record ${chunkIndex}`);
    chunks.push({ chunk, positions, blockIndices });
    previousChunk = chunk;
    state.offset = paddedEnd;
  }
  return chunks;
};

/**
 * 严格解码一个原生结果分页。返回的 typed arrays 独立于输入 envelope，
 * 因而调用方可以在追加到结果 store 后立即释放原始 IPC 缓冲区。
 */
export const decodeSolidVoxelResultBatchEnvelope = (
  input: Uint8Array,
): SolidVoxelResultBatchEnvelope => {
  if (!(input instanceof Uint8Array)) return fail("invalid-input", "result envelope must be a Uint8Array");
  if (input.byteLength < SOLID_VOXEL_RESULT_BATCH_HEADER_SIZE) {
    return fail("truncated", "result envelope is shorter than its header");
  }
  const bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < MAGIC.length; index += 1) {
    if (bytes[index] !== MAGIC[index]) return fail("invalid-magic", "result envelope magic does not match");
  }
  const version = view.getUint16(8, true);
  if (version !== SOLID_VOXEL_RESULT_BATCH_VERSION) {
    return fail("unsupported-version", `unsupported result envelope version ${version}`);
  }
  if (view.getUint16(10, true) !== SOLID_VOXEL_RESULT_BATCH_HEADER_SIZE) {
    return fail("invalid-header", "result envelope header size is not canonical");
  }
  const flags = view.getUint32(12, true);
  if ((flags & ~KNOWN_FLAGS) !== 0) return fail("invalid-header", "result envelope has unknown flags");
  const totalByteLength = view.getUint32(16, true);
  if (totalByteLength !== bytes.byteLength || totalByteLength % SOLID_VOXEL_RESULT_BATCH_ALIGNMENT !== 0) {
    return fail("invalid-header", "result envelope length is not canonical");
  }
  const expectedChecksum = view.getUint32(CHECKSUM_OFFSET, true);
  if (solidVoxelResultEnvelopeCrc32(bytes, true) !== expectedChecksum) {
    return fail("checksum-mismatch", "result envelope checksum does not match");
  }
  if (view.getUint32(68, true) !== 0) return fail("invalid-header", "result envelope reserved data is non-zero");

  const first = (flags & SOLID_VOXEL_RESULT_BATCH_FLAG.first) !== 0;
  const done = (flags & SOLID_VOXEL_RESULT_BATCH_FLAG.last) !== 0;
  const startChunkIndexBig = view.getBigUint64(40, true);
  const startChunkIndex = toSafeNumber(startChunkIndexBig, "startChunkIndex");
  const chunkCount = view.getUint32(48, true);
  const totalChunkCount = view.getUint32(52, true);
  const totalPaletteCount = view.getUint32(56, true);
  const paletteByteLength = view.getUint32(60, true);
  const cursorByteLength = view.getUint32(64, true);
  const endChunkIndex = checkedAdd(startChunkIndex, chunkCount, "result batch chunk range");

  if (totalChunkCount === 0 || totalPaletteCount === 0) {
    return fail("invalid-header", "native shell result must contain chunks and palette entries");
  }
  if (totalPaletteCount > MAX_PALETTE_ENTRIES) {
    return fail("invalid-header", "result palette exceeds Uint16 index capacity");
  }
  if (endChunkIndex > totalChunkCount || first !== (startChunkIndex === 0)) {
    return fail("invalid-header", "result batch chunk range or FIRST flag is inconsistent");
  }
  if (done !== (endChunkIndex === totalChunkCount)) {
    return fail("invalid-header", "result batch LAST flag is inconsistent with its chunk range");
  }
  if (!done && chunkCount === 0) {
    return fail("invalid-header", "non-final result batch must contain at least one chunk");
  }
  if (cursorByteLength > SOLID_VOXEL_RESULT_BATCH_MAX_CURSOR_BYTES) {
    return fail("invalid-cursor", "result batch cursor exceeds its protocol limit");
  }

  const cursorStart = SOLID_VOXEL_RESULT_BATCH_HEADER_SIZE;
  const cursorEnd = checkedAdd(cursorStart, cursorByteLength, "cursor end");
  const paletteStart = align8(cursorEnd);
  if (paletteStart > bytes.byteLength) return fail("truncated", "result batch cursor exceeds the envelope");
  const cursor = decodeCursor(bytes.subarray(cursorStart, cursorEnd), done);
  assertZeroRange(bytes, cursorEnd, paletteStart, "result batch cursor");

  if (first ? paletteByteLength === 0 : paletteByteLength !== 0) {
    return fail("invalid-header", "palette section presence does not match the FIRST flag");
  }
  const state: DecodeState = { bytes, view, offset: paletteStart };
  const palette = first
    ? decodePalette(state, totalPaletteCount, paletteByteLength)
    : undefined;
  const chunks = decodeChunks(state, chunkCount, totalPaletteCount);
  if (state.offset !== bytes.byteLength) {
    return fail("invalid-header", "result envelope contains unclaimed trailing bytes");
  }

  const handleId = view.getBigUint64(24, true);
  const handleGeneration = view.getBigUint64(32, true);
  if (handleId === 0n || handleId > U64_MAX || handleGeneration === 0n || handleGeneration > U64_MAX) {
    return fail("invalid-header", "result envelope handle must be non-zero u64 values");
  }
  return {
    version: SOLID_VOXEL_RESULT_BATCH_VERSION,
    handle: { id: handleId, generation: handleGeneration },
    startChunkIndex,
    totalChunkCount,
    totalPaletteCount,
    first,
    done,
    cursor,
    ...(palette ? { palette } : {}),
    chunks,
  };
};
