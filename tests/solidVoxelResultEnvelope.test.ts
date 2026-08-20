import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeSolidVoxelResultBatchEnvelope,
  solidVoxelResultEnvelopeCrc32,
  SolidVoxelResultEnvelopeError,
  SOLID_VOXEL_RESULT_BATCH_FLAG,
  SOLID_VOXEL_RESULT_BATCH_HEADER_SIZE,
  SOLID_VOXEL_RESULT_BATCH_MAGIC,
} from "../src/core/solidVoxelResultEnvelope";
import type {
  SolidVoxelChunk,
  VoxelPaletteEntry,
} from "../src/types";

const align8 = (value: number) => value + (8 - value % 8) % 8;
const encoder = new TextEncoder();

interface FixtureOptions {
  handle?: { id: bigint; generation: bigint };
  startChunkIndex: number;
  totalChunkCount: number;
  palette?: VoxelPaletteEntry[];
  totalPaletteCount: number;
  chunks: SolidVoxelChunk[];
  cursor?: string | null;
  done: boolean;
}

const encodePalette = (palette: readonly VoxelPaletteEntry[]) => {
  const records = palette.map((entry) => {
    const blockId = encoder.encode(entry.blockId);
    const logicalLength = 12 + blockId.length;
    const bytes = new Uint8Array(align8(logicalLength));
    const view = new DataView(bytes.buffer);
    view.setUint32(0, logicalLength, true);
    view.setUint32(4, blockId.length, true);
    bytes.set(entry.color, 8);
    bytes.set(blockId, 12);
    return bytes;
  });
  const bytes = new Uint8Array(records.reduce((sum, record) => sum + record.length, 0));
  let offset = 0;
  for (const record of records) {
    bytes.set(record, offset);
    offset += record.length;
  }
  return bytes;
};

const encodeChunk = (chunk: SolidVoxelChunk) => {
  const logicalLength = 24 + chunk.positions.length * 4;
  const bytes = new Uint8Array(align8(logicalLength));
  const view = new DataView(bytes.buffer);
  view.setUint32(0, logicalLength, true);
  chunk.chunk.forEach((coordinate, axis) => view.setInt32(4 + axis * 4, coordinate, true));
  view.setUint32(16, chunk.positions.length, true);
  chunk.positions.forEach((position, index) => view.setUint16(24 + index * 2, position, true));
  const blockIndicesOffset = 24 + chunk.positions.length * 2;
  chunk.blockIndices.forEach((paletteIndex, index) => (
    view.setUint16(blockIndicesOffset + index * 2, paletteIndex, true)
  ));
  return bytes;
};

/** 与 Rust encoder 对齐的最小独立 fixture builder。 */
const encodeFixture = (options: FixtureOptions) => {
  const cursor = options.cursor === null || options.cursor === undefined
    ? new Uint8Array(0)
    : encoder.encode(options.cursor);
  const palette = encodePalette(options.palette ?? []);
  const chunkRecords = options.chunks.map(encodeChunk);
  const cursorEnd = SOLID_VOXEL_RESULT_BATCH_HEADER_SIZE + cursor.length;
  const paletteStart = align8(cursorEnd);
  const chunksStart = paletteStart + palette.length;
  const totalLength = chunksStart + chunkRecords.reduce((sum, record) => sum + record.length, 0);
  const bytes = new Uint8Array(totalLength);
  const view = new DataView(bytes.buffer);
  bytes.set(encoder.encode(SOLID_VOXEL_RESULT_BATCH_MAGIC), 0);
  view.setUint16(8, 1, true);
  view.setUint16(10, SOLID_VOXEL_RESULT_BATCH_HEADER_SIZE, true);
  const first = options.startChunkIndex === 0;
  view.setUint32(
    12,
    (first ? SOLID_VOXEL_RESULT_BATCH_FLAG.first : 0)
      | (options.done ? SOLID_VOXEL_RESULT_BATCH_FLAG.last : 0),
    true,
  );
  view.setUint32(16, totalLength, true);
  view.setBigUint64(24, options.handle?.id ?? 7n, true);
  view.setBigUint64(32, options.handle?.generation ?? 3n, true);
  view.setBigUint64(40, BigInt(options.startChunkIndex), true);
  view.setUint32(48, options.chunks.length, true);
  view.setUint32(52, options.totalChunkCount, true);
  view.setUint32(56, options.totalPaletteCount, true);
  view.setUint32(60, palette.length, true);
  view.setUint32(64, cursor.length, true);
  bytes.set(cursor, SOLID_VOXEL_RESULT_BATCH_HEADER_SIZE);
  bytes.set(palette, paletteStart);
  let offset = chunksStart;
  for (const record of chunkRecords) {
    bytes.set(record, offset);
    offset += record.length;
  }
  view.setUint32(20, solidVoxelResultEnvelopeCrc32(bytes, true), true);
  return bytes;
};

const rewriteChecksum = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(20, 0, true);
  view.setUint32(20, solidVoxelResultEnvelopeCrc32(bytes, true), true);
  return bytes;
};

const expectCode = (code: string, operation: () => unknown) => assert.throws(
  operation,
  (error: unknown) => error instanceof SolidVoxelResultEnvelopeError && error.code === code,
);

const palette: VoxelPaletteEntry[] = [
  { blockId: "minecraft:white_concrete", color: [207, 213, 214] },
  { blockId: "minecraft:black_concrete", color: [8, 10, 15] },
];
const firstChunk: SolidVoxelChunk = {
  chunk: [-1, 0, 0],
  positions: Uint16Array.of(31),
  blockIndices: Uint16Array.of(0),
};
const secondChunk: SolidVoxelChunk = {
  chunk: [0, 0, 0],
  positions: Uint16Array.of(0, 1_057, 32_767),
  blockIndices: Uint16Array.of(1, 0, 1),
};

test("result batch v1 decodes a first page with palette, opaque cursor, and copied chunks", () => {
  const encoded = encodeFixture({
    startChunkIndex: 0,
    totalChunkCount: 2,
    totalPaletteCount: palette.length,
    palette,
    chunks: [firstChunk],
    cursor: "v1.7.3.next.signature",
    done: false,
  });
  const decoded = decodeSolidVoxelResultBatchEnvelope(encoded);

  assert.deepEqual(decoded.handle, { id: 7n, generation: 3n });
  assert.equal(decoded.first, true);
  assert.equal(decoded.done, false);
  assert.equal(decoded.cursor, "v1.7.3.next.signature");
  assert.equal(decoded.startChunkIndex, 0);
  assert.equal(decoded.totalChunkCount, 2);
  assert.deepEqual(decoded.palette, palette);
  assert.deepEqual(decoded.chunks[0].chunk, [-1, 0, 0]);
  assert.deepEqual([...decoded.chunks[0].positions], [31]);
  assert.deepEqual([...decoded.chunks[0].blockIndices], [0]);

  encoded.fill(0);
  assert.equal(decoded.palette?.[0].blockId, "minecraft:white_concrete");
  assert.equal(decoded.chunks[0].positions[0], 31);
});

test("result batch v1 decodes a final continuation without duplicating palette", () => {
  const decoded = decodeSolidVoxelResultBatchEnvelope(encodeFixture({
    startChunkIndex: 1,
    totalChunkCount: 2,
    totalPaletteCount: palette.length,
    chunks: [secondChunk],
    cursor: null,
    done: true,
  }));

  assert.equal(decoded.first, false);
  assert.equal(decoded.done, true);
  assert.equal(decoded.cursor, null);
  assert.equal(decoded.palette, undefined);
  assert.deepEqual([...decoded.chunks[0].positions], [0, 1_057, 32_767]);
});

test("single-page fixture remains a stable Rust compatibility vector", () => {
  const encoded = encodeFixture({
    handle: { id: 0x0102_0304_0506_0708n, generation: 9n },
    startChunkIndex: 0,
    totalChunkCount: 1,
    totalPaletteCount: 1,
    palette: [{ blockId: "minecraft:stone", color: [125, 125, 125] }],
    chunks: [{
      chunk: [0, -1, 2],
      positions: Uint16Array.of(0, 32_767),
      blockIndices: Uint16Array.of(0, 0),
    }],
    cursor: null,
    done: true,
  });

  assert.equal(encoded.byteLength, 136);
  assert.equal(new DataView(encoded.buffer).getUint32(20, true), 0xfc8b_9e4e);
  assert.equal(
    Buffer.from(encoded).toString("hex"),
    "4d4c5952424154000100480003000000880000004e9e8bfc0807060504030201"
      + "0900000000000000000000000000000001000000010000000100000020000000"
      + "00000000000000001b0000000f0000007d7d7d006d696e6563726166743a7374"
      + "6f6e6500000000002000000000000000ffffffff020000000200000000000000"
      + "0000ff7f00000000",
  );
});

test("decoder rejects damaged identity, version, total length, and checksum", () => {
  const encoded = encodeFixture({
    startChunkIndex: 0,
    totalChunkCount: 1,
    totalPaletteCount: 1,
    palette: [palette[0]],
    chunks: [firstChunk],
    done: true,
  });
  expectCode("truncated", () => decodeSolidVoxelResultBatchEnvelope(encoded.subarray(0, 71)));

  const magic = encoded.slice();
  magic[0] ^= 0xff;
  expectCode("invalid-magic", () => decodeSolidVoxelResultBatchEnvelope(magic));

  const version = encoded.slice();
  new DataView(version.buffer).setUint16(8, 2, true);
  expectCode("unsupported-version", () => decodeSolidVoxelResultBatchEnvelope(version));

  const length = encoded.slice();
  new DataView(length.buffer).setUint32(16, length.length - 8, true);
  expectCode("invalid-header", () => decodeSolidVoxelResultBatchEnvelope(length));

  const checksum = encoded.slice();
  checksum[checksum.length - 1] ^= 1;
  expectCode("checksum-mismatch", () => decodeSolidVoxelResultBatchEnvelope(checksum));
});

test("decoder enforces FIRST/LAST range semantics and cursor lifecycle", () => {
  const first = encodeFixture({
    startChunkIndex: 0,
    totalChunkCount: 2,
    totalPaletteCount: palette.length,
    palette,
    chunks: [firstChunk],
    cursor: "next",
    done: false,
  });
  const missingFirst = first.slice();
  new DataView(missingFirst.buffer).setUint32(12, 0, true);
  expectCode("invalid-header", () => decodeSolidVoxelResultBatchEnvelope(rewriteChecksum(missingFirst)));

  const falseLast = first.slice();
  new DataView(falseLast.buffer).setUint32(12, 3, true);
  expectCode("invalid-header", () => decodeSolidVoxelResultBatchEnvelope(rewriteChecksum(falseLast)));

  const missingCursor = first.slice();
  new DataView(missingCursor.buffer).setUint32(64, 0, true);
  expectCode("invalid-cursor", () => decodeSolidVoxelResultBatchEnvelope(rewriteChecksum(missingCursor)));

  const finalWithCursor = encodeFixture({
    startChunkIndex: 1,
    totalChunkCount: 2,
    totalPaletteCount: palette.length,
    chunks: [secondChunk],
    cursor: "forbidden",
    done: true,
  });
  expectCode("invalid-cursor", () => decodeSolidVoxelResultBatchEnvelope(finalWithCursor));
});

test("decoder rejects palette UTF-8, duplicate IDs, reserved bytes, and non-zero padding", () => {
  const encoded = encodeFixture({
    startChunkIndex: 0,
    totalChunkCount: 1,
    totalPaletteCount: palette.length,
    palette,
    chunks: [firstChunk],
    done: true,
  });
  const paletteOffset = SOLID_VOXEL_RESULT_BATCH_HEADER_SIZE;

  const utf8 = encoded.slice();
  utf8[paletteOffset + 12] = 0xff;
  expectCode("invalid-utf8", () => decodeSolidVoxelResultBatchEnvelope(rewriteChecksum(utf8)));

  const reserved = encoded.slice();
  reserved[paletteOffset + 11] = 1;
  expectCode("invalid-palette", () => decodeSolidVoxelResultBatchEnvelope(rewriteChecksum(reserved)));

  const firstLogicalLength = new DataView(encoded.buffer).getUint32(paletteOffset, true);
  const firstRecordEnd = paletteOffset + firstLogicalLength;
  const padding = encoded.slice();
  padding[firstRecordEnd] = 1;
  expectCode("non-zero-padding", () => decodeSolidVoxelResultBatchEnvelope(rewriteChecksum(padding)));

  const duplicate = encodeFixture({
    startChunkIndex: 0,
    totalChunkCount: 1,
    totalPaletteCount: 2,
    palette: [palette[0], { ...palette[0] }],
    chunks: [firstChunk],
    done: true,
  });
  expectCode("invalid-palette", () => decodeSolidVoxelResultBatchEnvelope(duplicate));
});

test("decoder rejects malformed, unsorted, duplicate, and out-of-palette chunk entries", () => {
  const duplicatePosition = encodeFixture({
    startChunkIndex: 0,
    totalChunkCount: 1,
    totalPaletteCount: 1,
    palette: [palette[0]],
    chunks: [{
      chunk: [0, 0, 0],
      positions: Uint16Array.of(5, 5),
      blockIndices: Uint16Array.of(0, 0),
    }],
    done: true,
  });
  expectCode("invalid-chunk", () => decodeSolidVoxelResultBatchEnvelope(duplicatePosition));

  const paletteIndex = encodeFixture({
    startChunkIndex: 0,
    totalChunkCount: 1,
    totalPaletteCount: 1,
    palette: [palette[0]],
    chunks: [{ ...firstChunk, blockIndices: Uint16Array.of(1) }],
    done: true,
  });
  expectCode("invalid-chunk", () => decodeSolidVoxelResultBatchEnvelope(paletteIndex));

  const unsortedChunks = encodeFixture({
    startChunkIndex: 0,
    totalChunkCount: 2,
    totalPaletteCount: palette.length,
    palette,
    chunks: [secondChunk, firstChunk],
    done: true,
  });
  expectCode("invalid-order", () => decodeSolidVoxelResultBatchEnvelope(unsortedChunks));

  const malformedLength = encodeFixture({
    startChunkIndex: 0,
    totalChunkCount: 1,
    totalPaletteCount: 1,
    palette: [palette[0]],
    chunks: [firstChunk],
    done: true,
  });
  const paletteLength = new DataView(malformedLength.buffer).getUint32(60, true);
  const chunkOffset = SOLID_VOXEL_RESULT_BATCH_HEADER_SIZE + paletteLength;
  new DataView(malformedLength.buffer).setUint32(chunkOffset, 24, true);
  expectCode("invalid-chunk", () => decodeSolidVoxelResultBatchEnvelope(rewriteChecksum(malformedLength)));
});

test("decoder rejects unsafe start indexes, oversized palette count, and trailing bytes", () => {
  const encoded = encodeFixture({
    startChunkIndex: 0,
    totalChunkCount: 1,
    totalPaletteCount: 1,
    palette: [palette[0]],
    chunks: [firstChunk],
    done: true,
  });
  const unsafe = encoded.slice();
  new DataView(unsafe.buffer).setBigUint64(40, BigInt(Number.MAX_SAFE_INTEGER) + 1n, true);
  expectCode("overflow", () => decodeSolidVoxelResultBatchEnvelope(rewriteChecksum(unsafe)));

  const paletteOverflow = encoded.slice();
  new DataView(paletteOverflow.buffer).setUint32(56, 0x1_0001, true);
  expectCode("invalid-header", () => decodeSolidVoxelResultBatchEnvelope(rewriteChecksum(paletteOverflow)));

  const extended = new Uint8Array(encoded.length + 8);
  extended.set(encoded);
  new DataView(extended.buffer).setUint32(16, extended.length, true);
  expectCode("invalid-header", () => decodeSolidVoxelResultBatchEnvelope(rewriteChecksum(extended)));
});
