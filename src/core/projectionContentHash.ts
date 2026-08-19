import type {
  ProjectionBlockState,
  ProjectionChunk,
  ProjectionDocument,
  ProjectionView,
} from "../types";
import { PROJECTION_CHUNK_SIZE } from "./projectionDocument";

type Point = [number, number, number];

const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
] as const;

const SHA256_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

const rotateRight = (value: number, bits: number) =>
  (value >>> bits) | (value << (32 - bits));

const compressSha256Block = (
  hash: number[],
  message: Uint8Array,
  offset: number,
  words: Uint32Array,
) => {
  for (let index = 0; index < 16; index += 1) {
    const wordOffset = offset + index * 4;
    words[index] = (
      (message[wordOffset] << 24)
      | (message[wordOffset + 1] << 16)
      | (message[wordOffset + 2] << 8)
      | message[wordOffset + 3]
    ) >>> 0;
  }
  for (let index = 16; index < 64; index += 1) {
    const previous15 = words[index - 15];
    const previous2 = words[index - 2];
    const sigma0 = rotateRight(previous15, 7)
      ^ rotateRight(previous15, 18)
      ^ (previous15 >>> 3);
    const sigma1 = rotateRight(previous2, 17)
      ^ rotateRight(previous2, 19)
      ^ (previous2 >>> 10);
    words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
  }

  let [a, b, c, d, e, f, g, h] = hash;
  for (let index = 0; index < 64; index += 1) {
    const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
    const choice = (e & f) ^ (~e & g);
    const temporary1 = (h + sum1 + choice + SHA256_CONSTANTS[index] + words[index]) >>> 0;
    const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
    const majority = (a & b) ^ (a & c) ^ (b & c);
    const temporary2 = (sum0 + majority) >>> 0;
    h = g;
    g = f;
    f = e;
    e = (d + temporary1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (temporary1 + temporary2) >>> 0;
  }

  hash[0] = (hash[0] + a) >>> 0;
  hash[1] = (hash[1] + b) >>> 0;
  hash[2] = (hash[2] + c) >>> 0;
  hash[3] = (hash[3] + d) >>> 0;
  hash[4] = (hash[4] + e) >>> 0;
  hash[5] = (hash[5] + f) >>> 0;
  hash[6] = (hash[6] + g) >>> 0;
  hash[7] = (hash[7] + h) >>> 0;
};

class Sha256Stream {
  private readonly hash: number[] = [...SHA256_INITIAL];
  private readonly pending = new Uint8Array(64);
  private readonly words = new Uint32Array(64);
  private pendingLength = 0;
  private byteLength = 0n;
  private finished = false;

  update(bytes: Uint8Array) {
    if (this.finished) throw new Error("SHA-256 stream is already finalized");
    this.byteLength += BigInt(bytes.byteLength);
    let offset = 0;
    if (this.pendingLength > 0) {
      const copied = Math.min(64 - this.pendingLength, bytes.byteLength);
      this.pending.set(bytes.subarray(0, copied), this.pendingLength);
      this.pendingLength += copied;
      offset = copied;
      if (this.pendingLength === 64) {
        compressSha256Block(this.hash, this.pending, 0, this.words);
        this.pendingLength = 0;
      }
    }
    while (offset + 64 <= bytes.byteLength) {
      compressSha256Block(this.hash, bytes, offset, this.words);
      offset += 64;
    }
    if (offset < bytes.byteLength) {
      const remainder = bytes.subarray(offset);
      this.pending.set(remainder);
      this.pendingLength = remainder.byteLength;
    }
    return this;
  }

  digestHex() {
    if (this.finished) throw new Error("SHA-256 stream is already finalized");
    this.finished = true;
    const finalLength = this.pendingLength < 56 ? 64 : 128;
    const final = new Uint8Array(finalLength);
    final.set(this.pending.subarray(0, this.pendingLength));
    final[this.pendingLength] = 0x80;
    const bitLength = this.byteLength * 8n;
    for (let index = 0; index < 8; index += 1) {
      final[final.length - 1 - index] = Number((bitLength >> BigInt(index * 8)) & 0xffn);
    }
    for (let offset = 0; offset < final.length; offset += 64) {
      compressSha256Block(this.hash, final, offset, this.words);
    }
    return this.hash.map((value) => value.toString(16).padStart(8, "0")).join("");
  }
}

export const sha256Hex = (bytes: Uint8Array) => {
  const stream = new Sha256Stream();
  stream.update(bytes);
  return stream.digestHex();
};

const encoder = new TextEncoder();

const hashLines = (lines: Iterable<string>) => {
  const stream = new Sha256Stream();
  let first = true;
  for (const line of lines) {
    if (!first) stream.update(encoder.encode("\n"));
    stream.update(encoder.encode(line));
    first = false;
  }
  return `sha256:${stream.digestHex()}`;
};

const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

const canonicalProperties = (state: ProjectionBlockState) =>
  Object.entries(state.properties ?? {}).sort(([left], [right]) => compareText(left, right));

const canonicalViewState = (state: ProjectionBlockState) => JSON.stringify([
  state.blockId,
  canonicalProperties(state),
]);

const canonicalDocumentState = (state: ProjectionBlockState) => JSON.stringify([
  state.blockId,
  canonicalProperties(state),
  state.color ?? null,
  state.emissive ?? null,
]);

const canonicalMetadata = (document: ProjectionDocument) => Object.entries(document.metadata ?? {})
  .sort(([left], [right]) => compareText(left, right))
  .map(([key, value]) => {
    if (
      typeof value !== "string"
      && typeof value !== "boolean"
      && (typeof value !== "number" || !Number.isFinite(value))
    ) {
      throw new TypeError(`Projection metadata ${key} must contain a finite scalar value`);
    }
    return [key, Object.is(value, -0) ? 0 : value];
  });

const decodeLocalPosition = (position: number): Point => {
  const x = position % PROJECTION_CHUNK_SIZE;
  const yz = Math.floor(position / PROJECTION_CHUNK_SIZE);
  const z = yz % PROJECTION_CHUNK_SIZE;
  const y = Math.floor(yz / PROJECTION_CHUNK_SIZE);
  return [x, y, z];
};

interface ChunkCursor {
  chunk: ProjectionChunk;
  order?: Uint16Array;
  offset: number;
  sourceIndex: number;
  position: Point;
  previousLocalPosition: number;
}

const inBounds = (
  position: Point,
  bounds?: Pick<ProjectionView["bounds"], "min" | "max">,
) => !bounds || position.every((value, axis) =>
  value >= bounds.min[axis] && value <= bounds.max[axis]);

const advanceCursor = (
  cursor: ChunkCursor,
  bounds?: Pick<ProjectionView["bounds"], "min" | "max">,
) => {
  while (++cursor.offset < cursor.chunk.positions.length) {
    cursor.sourceIndex = cursor.order?.[cursor.offset] ?? cursor.offset;
    const localPosition = cursor.chunk.positions[cursor.sourceIndex];
    if (localPosition >= PROJECTION_CHUNK_SIZE ** 3) {
      throw new RangeError(`Projection chunk ${cursor.chunk.chunk.join(",")} has invalid local position`);
    }
    if (localPosition <= cursor.previousLocalPosition) {
      throw new RangeError(`Projection chunk ${cursor.chunk.chunk.join(",")} has duplicate local position`);
    }
    cursor.previousLocalPosition = localPosition;
    const local = decodeLocalPosition(localPosition);
    cursor.position = [
      cursor.chunk.chunk[0] * PROJECTION_CHUNK_SIZE + local[0],
      cursor.chunk.chunk[1] * PROJECTION_CHUNK_SIZE + local[1],
      cursor.chunk.chunk[2] * PROJECTION_CHUNK_SIZE + local[2],
    ];
    if (!cursor.position.every(Number.isSafeInteger)) {
      throw new RangeError(`Projection chunk ${cursor.chunk.chunk.join(",")} exceeds safe coordinates`);
    }
    if (inBounds(cursor.position, bounds)) return true;
  }
  return false;
};

const compareCursors = (left: ChunkCursor, right: ChunkCursor) =>
  left.position[1] - right.position[1]
  || left.position[2] - right.position[2]
  || left.position[0] - right.position[0];

const heapPush = (heap: ChunkCursor[], cursor: ChunkCursor) => {
  let index = heap.length;
  heap.push(cursor);
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compareCursors(heap[parent], cursor) <= 0) break;
    heap[index] = heap[parent];
    index = parent;
  }
  heap[index] = cursor;
};

const heapPop = (heap: ChunkCursor[]) => {
  const first = heap[0];
  const last = heap.pop()!;
  if (heap.length === 0) return first;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    if (left >= heap.length) break;
    const right = left + 1;
    const child = right < heap.length && compareCursors(heap[right], heap[left]) < 0
      ? right
      : left;
    if (compareCursors(heap[child], last) >= 0) break;
    heap[index] = heap[child];
    index = child;
  }
  heap[index] = last;
  return first;
};

const createCursor = (
  chunk: ProjectionChunk,
  bounds?: Pick<ProjectionView["bounds"], "min" | "max">,
) => {
  if (!(chunk.positions instanceof Uint16Array)
    || !(chunk.paletteIndices instanceof Uint16Array)
      && !(chunk.paletteIndices instanceof Uint32Array)) {
    throw new RangeError(`Projection chunk ${chunk.chunk.join(",")} must use typed buffers`);
  }
  if (chunk.positions.length !== chunk.paletteIndices.length) {
    throw new RangeError(`Projection chunk ${chunk.chunk.join(",")} has inconsistent buffers`);
  }
  if (chunk.positions.length > PROJECTION_CHUNK_SIZE ** 3) {
    throw new RangeError(`Projection chunk ${chunk.chunk.join(",")} exceeds local capacity`);
  }
  const order = chunk.positions.every((position, index) =>
    index === 0 || chunk.positions[index - 1] < position)
    ? undefined
    : Uint16Array.from(chunk.positions.keys()).sort((left, right) =>
      chunk.positions[left] - chunk.positions[right]);
  const cursor: ChunkCursor = {
    chunk,
    order,
    offset: -1,
    sourceIndex: -1,
    position: [0, 0, 0],
    previousLocalPosition: -1,
  };
  return advanceCursor(cursor, bounds) ? cursor : undefined;
};

/** 用每个 chunk 一个游标做 Y/Z/X 归并，避免建立全量方块数组。 */
function* canonicalChunkBlocks(
  document: ProjectionDocument,
  states: readonly string[],
  bounds?: Pick<ProjectionView["bounds"], "min" | "max">,
  origin: Point = [0, 0, 0],
): Generator<string> {
  const heap: ChunkCursor[] = [];
  for (const chunk of document.chunks) {
    const cursor = createCursor(chunk, bounds);
    if (cursor) heapPush(heap, cursor);
  }
  while (heap.length > 0) {
    const cursor = heapPop(heap);
    const state = states[cursor.chunk.paletteIndices[cursor.sourceIndex]];
    if (state === undefined) {
      throw new RangeError(
        `Unknown projection palette index: ${cursor.chunk.paletteIndices[cursor.sourceIndex]}`,
      );
    }
    yield JSON.stringify([
      cursor.position[0] - origin[0],
      cursor.position[1] - origin[1],
      cursor.position[2] - origin[2],
      state,
    ]);
    if (advanceCursor(cursor, bounds)) heapPush(heap, cursor);
  }
}

const countBlocksInBounds = (
  document: ProjectionDocument,
  bounds: Pick<ProjectionView["bounds"], "min" | "max">,
) => {
  let count = 0;
  for (const chunk of document.chunks) {
    if (chunk.positions.length !== chunk.paletteIndices.length) {
      throw new RangeError(`Projection chunk ${chunk.chunk.join(",")} has inconsistent buffers`);
    }
    for (const localPosition of chunk.positions) {
      const local = decodeLocalPosition(localPosition);
      const position: Point = [
        chunk.chunk[0] * PROJECTION_CHUNK_SIZE + local[0],
        chunk.chunk[1] * PROJECTION_CHUNK_SIZE + local[1],
        chunk.chunk[2] * PROJECTION_CHUNK_SIZE + local[2],
      ];
      if (inBounds(position, bounds)) count += 1;
    }
  }
  return count;
};

export const createProjectionViewContentHash = (
  document: ProjectionDocument,
  view: ProjectionView,
) => {
  const origin = view.occupiedBounds.min;
  const states = document.palette.map(canonicalViewState);
  const blockCount = countBlocksInBounds(document, view.bounds);
  function* lines() {
    yield JSON.stringify([
      "MELYProjectionPart",
      1,
      document.edition,
      document.minecraftVersion,
      blockCount,
    ]);
    yield* canonicalChunkBlocks(document, states, view.bounds, origin);
  }
  return hashLines(lines());
};

/** 第三关确认绑定文档的全部导出语义，同时忽略 chunk 与调色板的内部排列。 */
export const createProjectionDocumentContentHash = (document: ProjectionDocument) => {
  const states = document.palette.map(canonicalDocumentState);
  const bounds = document.bounds
    ? [document.bounds.min, document.bounds.max, document.bounds.dimensions]
    : null;
  function* lines() {
    yield JSON.stringify([
      "MELYProjectionDocument",
      1,
      document.format,
      document.version,
      document.edition,
      document.minecraftVersion,
      canonicalMetadata(document),
      [...states].sort(),
      document.blockCount,
      bounds,
    ]);
    yield* canonicalChunkBlocks(document, states);
  }
  return hashLines(lines());
};
