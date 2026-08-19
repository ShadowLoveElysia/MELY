import { Deflate } from "pako";
import { APP_VERSION } from "../version";
import type {
  HologramOptions,
  ProjectionBounds,
  ProjectionDocument,
  ProjectionResult,
  ProjectionView,
  SolidOptions,
} from "../types";
import { appError } from "./appError";
import { resolveBlockId } from "./blockRegistry";
import {
  assertJavaProjectionExportSafety,
  type JavaProjectionExportSafetyInput,
} from "./exportPreflight";
import type {
  JavaCompatibilityLevel,
  JavaCompatibilityWarningCode,
} from "./minecraftVersions";
import {
  createProjectionDocumentFromResult,
  splitProjectionViews,
} from "./projectionDocument";

interface BlockState {
  Name: string;
  Properties?: Record<string, string>;
}

export interface ExportOptions {
  name?: string;
  author?: string;
  description?: string;
  timestamp?: number;
  regionMaxSize?: number | [number, number, number];
  safety?: JavaProjectionExportSafetyInput;
  signal?: AbortSignal;
}

export interface LitematicExportSummary {
  name: string;
  byteLength: number;
  blockCount: number;
  volume: number;
  paletteSize: number;
  bitsPerBlock: number;
  longCount: number;
  dimensions: [number, number, number];
  /** 用户选择的目标版本；不代表文件实际写入了该版本的 DataVersion。 */
  minecraftVersion: string;
  serializerMinecraftVersion: string;
  dataVersion: number;
  formatVersion: number;
  subVersion: number;
  compatibilityLevel: JavaCompatibilityLevel;
  compatibilityWarningCode: JavaCompatibilityWarningCode | null;
  regionCount: number;
}

export interface LitematicExport {
  bytes: Uint8Array;
  summary: LitematicExportSummary;
}

export type LitematicChunkSink = (chunk: Uint8Array) => void | Promise<void>;

const TAG_END = 0;
const TAG_INT = 3;
const TAG_LONG = 4;
const TAG_STRING = 8;
const TAG_LIST = 9;
const TAG_COMPOUND = 10;
const TAG_INT_ARRAY = 11;
const TAG_LONG_ARRAY = 12;
const NBT_INT_MIN = -0x8000_0000;
const NBT_INT_MAX = 0x7fff_ffff;
const NBT_LONG_MIN = -(1n << 63n);
const NBT_LONG_MAX = (1n << 63n) - 1n;
const NBT_BUFFER_SIZE = 64 * 1024;
const GZIP_OUTPUT_CHUNK_SIZE = 16 * 1024;
const PROJECTION_CHUNK_SIZE = 32;

type Point = [number, number, number];

interface PreparedLitematic {
  document: ProjectionDocument;
  views: ProjectionView[];
  palette: BlockState[];
  timestamp: bigint;
  name: string;
  author: string;
  description: string;
  targetMinecraftVersion: string;
  serializerMinecraftVersion: string;
  compatibilityLevel: JavaCompatibilityLevel;
  compatibilityWarning: JavaCompatibilityWarningCode | "";
  dataVersion: number;
  formatVersion: number;
  subVersion: number;
  totalVolume: number;
  maximumBitsPerBlock: number;
  totalLongCount: number;
  chunkIndex: Map<string, ProjectionDocument["chunks"][number]>;
}

const sanitizeName = (value: string) => {
  const cleaned = value
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "MELY_Hologram";
};

const assertNbtInt = (value: number, field: string, nonNegative = false) => {
  if (!Number.isSafeInteger(value)
    || value < NBT_INT_MIN
    || value > NBT_INT_MAX
    || (nonNegative && value < 0)) {
    throw new RangeError(`${field} cannot be represented as an NBT signed int: ${value}`);
  }
  return value;
};

const assertNbtLength = (value: number, field: string) => assertNbtInt(value, field, true);

const assertSafeProduct = (left: number, right: number, field: string) => {
  const value = left * right;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} exceeds the safe integer range`);
  }
  return value;
};

const assertTimestamp = (value: number) => {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`Litematic timestamp must be a safe integer: ${value}`);
  }
  const timestamp = BigInt(value);
  if (timestamp < NBT_LONG_MIN || timestamp > NBT_LONG_MAX) {
    throw new RangeError(`Litematic timestamp exceeds the NBT signed long range: ${value}`);
  }
  return timestamp;
};

const throwIfAborted = (signal: AbortSignal | undefined) => {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Litematic export was cancelled", "AbortError");
};

export const packBlockStates = (indices: Uint32Array, paletteSize: number) => {
  if (!Number.isSafeInteger(paletteSize) || paletteSize <= 0 || paletteSize > NBT_INT_MAX) {
    throw new RangeError(`Litematic palette size is not representable: ${paletteSize}`);
  }
  const bitsPerBlock = Math.max(2, Math.ceil(Math.log2(paletteSize)));
  const totalBits = assertSafeProduct(indices.length, bitsPerBlock, "Litematic block-state bit count");
  const longCount = Math.ceil(totalBits / 64);
  assertNbtLength(longCount, "Litematic BlockStates length");
  const packed = new BigInt64Array(longCount);
  const unsigned = new BigUint64Array(packed.buffer);
  const mask = (1n << BigInt(bitsPerBlock)) - 1n;

  for (let index = 0; index < indices.length; index += 1) {
    const value = BigInt(indices[index]) & mask;
    const startOffset = index * bitsPerBlock;
    const startLongIndex = Math.floor(startOffset / 64);
    const startBitOffset = startOffset & 63;
    unsigned[startLongIndex] |= value << BigInt(startBitOffset);

    const bitsInStartLong = 64 - startBitOffset;
    if (bitsInStartLong < bitsPerBlock) {
      unsigned[startLongIndex + 1] |= value >> BigInt(bitsInStartLong);
    }
  }

  return { packed, bitsPerBlock };
};

export const unpackBlockState = (
  packed: BigInt64Array,
  index: number,
  bitsPerBlock: number,
) => {
  const mask = (1n << BigInt(bitsPerBlock)) - 1n;
  const startOffset = index * bitsPerBlock;
  const startLongIndex = Math.floor(startOffset / 64);
  const startBitOffset = startOffset & 63;
  const startValue = BigInt.asUintN(64, packed[startLongIndex]);
  const bitsInStartLong = 64 - startBitOffset;

  if (bitsInStartLong >= bitsPerBlock) {
    return Number((startValue >> BigInt(startBitOffset)) & mask);
  }

  const endValue = BigInt.asUintN(64, packed[startLongIndex + 1]);
  return Number(
    ((startValue >> BigInt(startBitOffset)) | (endValue << BigInt(bitsInStartLong))) & mask,
  );
};

const litematicPalette = (document: ProjectionDocument): BlockState[] => [
  { Name: "minecraft:air" },
  ...document.palette.map((state) => ({
    Name: resolveBlockId(state.blockId, "java", document.minecraftVersion),
    ...(state.properties ? { Properties: { ...state.properties } } : {}),
  })),
];

const chunkKey = (x: number, y: number, z: number) => `${x},${y},${z}`;

const decodeLocalPosition = (position: number): Point => {
  const x = position % PROJECTION_CHUNK_SIZE;
  const yz = Math.floor(position / PROJECTION_CHUNK_SIZE);
  const z = yz % PROJECTION_CHUNK_SIZE;
  return [x, Math.floor(yz / PROJECTION_CHUNK_SIZE), z];
};

const volumeOf = (bounds: ProjectionBounds, field: string) => {
  const xy = assertSafeProduct(bounds.dimensions[0], bounds.dimensions[1], field);
  return assertSafeProduct(xy, bounds.dimensions[2], field);
};

const buildRegionData = (
  prepared: PreparedLitematic,
  view: ProjectionView,
) => {
  const { document, palette, chunkIndex } = prepared;
  const bounds = view.bounds;
  const [sizeX, sizeY, sizeZ] = bounds.dimensions;
  const volume = volumeOf(bounds, "Litematic region volume");
  assertNbtLength(volume, "Litematic region dense block-state volume");
  const indices = new Uint32Array(volume);
  const minimumChunk = bounds.min.map((value) => Math.floor(value / PROJECTION_CHUNK_SIZE)) as Point;
  const maximumChunk = bounds.max.map((value) => Math.floor(value / PROJECTION_CHUNK_SIZE)) as Point;
  let blockCount = 0;

  for (let chunkY = minimumChunk[1]; chunkY <= maximumChunk[1]; chunkY += 1) {
    for (let chunkZ = minimumChunk[2]; chunkZ <= maximumChunk[2]; chunkZ += 1) {
      for (let chunkX = minimumChunk[0]; chunkX <= maximumChunk[0]; chunkX += 1) {
        const chunk = chunkIndex.get(chunkKey(chunkX, chunkY, chunkZ));
        if (!chunk) continue;
        for (let index = 0; index < chunk.positions.length; index += 1) {
          const local = decodeLocalPosition(chunk.positions[index]);
          const x = chunkX * PROJECTION_CHUNK_SIZE + local[0] - bounds.min[0];
          const y = chunkY * PROJECTION_CHUNK_SIZE + local[1] - bounds.min[1];
          const z = chunkZ * PROJECTION_CHUNK_SIZE + local[2] - bounds.min[2];
          if (x < 0 || x >= sizeX || y < 0 || y >= sizeY || z < 0 || z >= sizeZ) continue;
          const paletteIndex = chunk.paletteIndices[index] + 1;
          if (!palette[paletteIndex]) {
            throw appError("error.litematic.unknownPalette", { index: paletteIndex - 1 });
          }
          indices[(y * sizeZ + z) * sizeX + x] = paletteIndex;
          blockCount += 1;
        }
      }
    }
  }
  if (blockCount !== view.blockCount) {
    throw new Error(
      `Litematic region ${view.index.join(",")} expected ${view.blockCount} blocks but encoded ${blockCount}`,
    );
  }
  const { packed, bitsPerBlock } = packBlockStates(indices, palette.length);
  return { volume, packed, bitsPerBlock };
};

const regionName = (view: ProjectionView, regionCount: number) => regionCount === 1
  ? "Hologram"
  : `R_${view.index[1]}_${view.index[2]}_${view.index[0]}`;

class BigEndianNbtWriter {
  private readonly bytes = new Uint8Array(NBT_BUFFER_SIZE);
  private readonly view = new DataView(this.bytes.buffer);
  private readonly encoder = new TextEncoder();
  private offset = 0;

  constructor(private readonly emit: (chunk: Uint8Array) => void) {}

  private ensure(length: number) {
    if (length > this.bytes.length) {
      throw new RangeError(`NBT primitive write exceeds buffer capacity: ${length}`);
    }
    if (this.offset + length > this.bytes.length) this.flush();
  }

  private rawByte(value: number) {
    this.ensure(1);
    this.view.setUint8(this.offset, value);
    this.offset += 1;
  }

  private rawInt(value: number) {
    this.ensure(4);
    this.view.setInt32(this.offset, value, false);
    this.offset += 4;
  }

  private rawLong(value: bigint) {
    this.ensure(8);
    this.view.setBigInt64(this.offset, value, false);
    this.offset += 8;
  }

  private rawBytes(value: Uint8Array) {
    let sourceOffset = 0;
    while (sourceOffset < value.byteLength) {
      if (this.offset === this.bytes.length) this.flush();
      const length = Math.min(value.byteLength - sourceOffset, this.bytes.length - this.offset);
      this.bytes.set(value.subarray(sourceOffset, sourceOffset + length), this.offset);
      this.offset += length;
      sourceOffset += length;
    }
  }

  private rawString(value: string, field: string) {
    const encoded = this.encoder.encode(value);
    if (encoded.byteLength > 0xffff) {
      throw new RangeError(`${field} exceeds the NBT UTF-8 string limit`);
    }
    this.ensure(2);
    this.view.setUint16(this.offset, encoded.byteLength, false);
    this.offset += 2;
    this.rawBytes(encoded);
  }

  private header(type: number, name: string) {
    this.rawByte(type);
    this.rawString(name, `NBT tag name ${name}`);
  }

  startRootCompound() {
    this.header(TAG_COMPOUND, "");
  }

  startCompound(name: string) {
    this.header(TAG_COMPOUND, name);
  }

  endCompound() {
    this.rawByte(TAG_END);
  }

  namedInt(name: string, value: number, nonNegative = false) {
    this.header(TAG_INT, name);
    this.rawInt(assertNbtInt(value, name, nonNegative));
  }

  namedLong(name: string, value: bigint) {
    if (value < NBT_LONG_MIN || value > NBT_LONG_MAX) {
      throw new RangeError(`${name} exceeds the NBT signed long range`);
    }
    this.header(TAG_LONG, name);
    this.rawLong(value);
  }

  namedString(name: string, value: string) {
    this.header(TAG_STRING, name);
    this.rawString(value, name);
  }

  startCompoundList(name: string, length: number) {
    this.header(TAG_LIST, name);
    this.rawByte(TAG_COMPOUND);
    this.rawInt(assertNbtLength(length, `${name} length`));
  }

  namedEmptyList(name: string) {
    this.header(TAG_LIST, name);
    this.rawByte(TAG_END);
    this.rawInt(0);
  }

  namedEmptyIntArray(name: string) {
    this.header(TAG_INT_ARRAY, name);
    this.rawInt(0);
  }

  namedLongArray(name: string, values: BigInt64Array) {
    this.header(TAG_LONG_ARRAY, name);
    this.rawInt(assertNbtLength(values.length, `${name} length`));
    for (const value of values) this.rawLong(value);
  }

  flush() {
    if (this.offset === 0) return;
    this.emit(this.bytes.slice(0, this.offset));
    this.offset = 0;
  }
}

const prepareLitematic = (
  document: ProjectionDocument,
  exportOptions: ExportOptions,
): PreparedLitematic => {
  if (document.blockCount === 0 || !document.bounds) throw appError("error.litematic.emptyProjection");
  if (document.edition !== "java") {
    throw new RangeError("Litematica export requires a Java Edition projection document");
  }
  const {
    requestedProfile,
    serializerProfile,
    compatibility,
  } = assertJavaProjectionExportSafety(document, "litematic", exportOptions.safety);
  const adapter = serializerProfile.exporters.litematic;
  if (!adapter) {
    throw new RangeError(
      `Litematica export has no compatible serializer for Minecraft Java ${requestedProfile.id}`,
    );
  }
  const timestamp = assertTimestamp(exportOptions.timestamp ?? Date.now());
  const name = sanitizeName(exportOptions.name ?? "MELY_Projection");
  const author = exportOptions.author?.trim() || "MELY";
  const description = exportOptions.description?.trim() || (compatibility.level === "best_effort"
    ? `MELY | Target Minecraft ${requestedProfile.id} is untested; serialized with Java ${serializerProfile.id}`
    : `MELY | Minecraft ${requestedProfile.id}`);
  const views = splitProjectionViews(document, exportOptions.regionMaxSize ?? 32);
  const palette = litematicPalette(document);

  assertNbtLength(views.length, "Litematic region count");
  assertNbtLength(document.blockCount, "Litematic total block count");
  assertNbtLength(palette.length, "Litematic palette length");
  document.bounds.dimensions.forEach((value, axis) => {
    assertNbtInt(value, `Litematic enclosing ${"xyz"[axis]} size`, true);
  });
  assertNbtInt(adapter.formatVersion, "Litematic Version");
  assertNbtInt(adapter.subVersion ?? 0, "Litematic SubVersion");
  assertNbtInt(serializerProfile.dataVersion, "Litematic MinecraftDataVersion");

  let totalVolume = 0;
  let maximumBitsPerBlock = 2;
  let totalLongCount = 0;
  for (const view of views) {
    const volume = volumeOf(view.bounds, "Litematic total volume");
    totalVolume += volume;
    if (!Number.isSafeInteger(totalVolume)) {
      throw new RangeError("Litematic total volume exceeds the safe integer range");
    }
    view.bounds.dimensions.forEach((value, axis) => {
      assertNbtInt(value, `Litematic region ${"xyz"[axis]} size`, true);
      assertNbtInt(
        view.bounds.min[axis] - document.bounds!.min[axis],
        `Litematic region ${"xyz"[axis]} position`,
      );
    });
    const bits = Math.max(2, Math.ceil(Math.log2(palette.length)));
    const bitCount = assertSafeProduct(volume, bits, "Litematic region block-state bit count");
    const longs = Math.ceil(bitCount / 64);
    assertNbtLength(longs, "Litematic BlockStates length");
    maximumBitsPerBlock = Math.max(maximumBitsPerBlock, bits);
    totalLongCount += longs;
    if (!Number.isSafeInteger(totalLongCount)) {
      throw new RangeError("Litematic total long count exceeds the safe integer range");
    }
  }
  assertNbtInt(totalVolume, "Litematic TotalVolume", true);

  const chunkIndex = new Map<string, ProjectionDocument["chunks"][number]>();
  for (const chunk of document.chunks) {
    chunkIndex.set(chunkKey(...chunk.chunk), chunk);
  }

  return {
    document,
    views,
    palette,
    timestamp,
    name,
    author,
    description,
    targetMinecraftVersion: requestedProfile.id,
    serializerMinecraftVersion: serializerProfile.id,
    compatibilityLevel: compatibility.level,
    compatibilityWarning: compatibility.warningCode ?? "",
    dataVersion: serializerProfile.dataVersion,
    formatVersion: adapter.formatVersion,
    subVersion: adapter.subVersion ?? 0,
    totalVolume,
    maximumBitsPerBlock,
    totalLongCount,
    chunkIndex,
  };
};

const writePalette = (writer: BigEndianNbtWriter, palette: readonly BlockState[]) => {
  writer.startCompoundList("BlockStatePalette", palette.length);
  for (const state of palette) {
    writer.namedString("Name", state.Name);
    if (state.Properties) {
      writer.startCompound("Properties");
      for (const [key, value] of Object.entries(state.Properties)) writer.namedString(key, value);
      writer.endCompound();
    }
    writer.endCompound();
  }
};

const writePrefix = (writer: BigEndianNbtWriter, prepared: PreparedLitematic) => {
  const { document } = prepared;
  const [sizeX, sizeY, sizeZ] = document.bounds!.dimensions;
  writer.startRootCompound();
  writer.namedInt("Version", prepared.formatVersion);
  writer.namedInt("SubVersion", prepared.subVersion);
  writer.namedInt("MinecraftDataVersion", prepared.dataVersion);
  writer.startCompound("Metadata");
  writer.startCompound("EnclosingSize");
  writer.namedInt("x", sizeX, true);
  writer.namedInt("y", sizeY, true);
  writer.namedInt("z", sizeZ, true);
  writer.endCompound();
  writer.namedString("Author", prepared.author);
  writer.namedString("Description", prepared.description);
  writer.namedString("Name", prepared.name);
  writer.namedString("Software", `MELY_${APP_VERSION}`);
  writer.namedString("TargetMinecraftVersion", prepared.targetMinecraftVersion);
  writer.namedString("SerializerMinecraftVersion", prepared.serializerMinecraftVersion);
  writer.namedString("CompatibilityLevel", prepared.compatibilityLevel);
  writer.namedString("CompatibilityWarning", prepared.compatibilityWarning);
  writer.namedInt("RegionCount", prepared.views.length, true);
  writer.namedLong("TimeCreated", prepared.timestamp);
  writer.namedLong("TimeModified", prepared.timestamp);
  writer.namedInt("TotalBlocks", document.blockCount, true);
  writer.namedInt("TotalVolume", prepared.totalVolume, true);
  writer.namedEmptyIntArray("PreviewImageData");
  writer.endCompound();
  writer.startCompound("Regions");
};

const writeRegion = (
  writer: BigEndianNbtWriter,
  prepared: PreparedLitematic,
  view: ProjectionView,
) => {
  const data = buildRegionData(prepared, view);
  const bounds = view.bounds;
  const documentMin = prepared.document.bounds!.min;
  writer.startCompound(regionName(view, prepared.views.length));
  writer.startCompound("Position");
  writer.namedInt("x", bounds.min[0] - documentMin[0]);
  writer.namedInt("y", bounds.min[1] - documentMin[1]);
  writer.namedInt("z", bounds.min[2] - documentMin[2]);
  writer.endCompound();
  writer.startCompound("Size");
  writer.namedInt("x", bounds.dimensions[0], true);
  writer.namedInt("y", bounds.dimensions[1], true);
  writer.namedInt("z", bounds.dimensions[2], true);
  writer.endCompound();
  writePalette(writer, prepared.palette);
  writer.namedLongArray("BlockStates", data.packed);
  writer.namedEmptyList("Entities");
  writer.namedEmptyList("TileEntities");
  writer.namedEmptyList("PendingBlockTicks");
  writer.namedEmptyList("PendingFluidTicks");
  writer.endCompound();
};

const writeSuffix = (writer: BigEndianNbtWriter) => {
  writer.endCompound();
  writer.endCompound();
  writer.flush();
};

const summaryFromPrepared = (
  prepared: PreparedLitematic,
  byteLength: number,
): LitematicExportSummary => ({
  name: prepared.name,
  byteLength,
  blockCount: prepared.document.blockCount,
  volume: prepared.totalVolume,
  paletteSize: prepared.palette.length,
  bitsPerBlock: prepared.maximumBitsPerBlock,
  longCount: prepared.totalLongCount,
  dimensions: [...prepared.document.bounds!.dimensions],
  minecraftVersion: prepared.targetMinecraftVersion,
  serializerMinecraftVersion: prepared.serializerMinecraftVersion,
  dataVersion: prepared.dataVersion,
  formatVersion: prepared.formatVersion,
  subVersion: prepared.subVersion,
  compatibilityLevel: prepared.compatibilityLevel,
  compatibilityWarningCode: prepared.compatibilityWarning || null,
  regionCount: prepared.views.length,
});

const createDeflater = (onData: (chunk: Uint8Array) => void) => {
  const deflater = new Deflate({ gzip: true, level: 9, chunkSize: GZIP_OUTPUT_CHUNK_SIZE });
  deflater.onData = (value) => {
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
    onData(chunk.slice());
  };
  const push = (chunk: Uint8Array, final = false) => {
    if (!deflater.push(chunk, final) || deflater.err) {
      throw new Error(`Litematic gzip failed: ${deflater.msg || deflater.err}`);
    }
  };
  return { deflater, push };
};

/**
 * 逐 region 编码 NBT 并直接送入 gzip。sink 只接收拥有独立缓冲区的压缩块，
 * 因而桌面端可以直接落盘，不保留完整 NBT 或完整压缩文件。
 */
export const streamLitematicFromDocument = async (
  document: ProjectionDocument,
  sink: LitematicChunkSink,
  exportOptions: ExportOptions = {},
): Promise<LitematicExportSummary> => {
  const prepared = prepareLitematic(document, exportOptions);
  const pending: Uint8Array[] = [];
  let byteLength = 0;
  const { push } = createDeflater((chunk) => pending.push(chunk));
  const writer = new BigEndianNbtWriter((chunk) => push(chunk));
  const drain = async () => {
    while (pending.length > 0) {
      throwIfAborted(exportOptions.signal);
      const chunk = pending.shift()!;
      byteLength += chunk.byteLength;
      if (!Number.isSafeInteger(byteLength)) {
        throw new RangeError("Litematic gzip byte length exceeds the safe integer range");
      }
      await sink(chunk);
    }
  };

  throwIfAborted(exportOptions.signal);
  writePrefix(writer, prepared);
  writer.flush();
  await drain();
  for (const view of prepared.views) {
    throwIfAborted(exportOptions.signal);
    writeRegion(writer, prepared, view);
    writer.flush();
    await drain();
  }
  writeSuffix(writer);
  push(new Uint8Array(0), true);
  await drain();
  return summaryFromPrepared(prepared, byteLength);
};

export const createLitematicFromDocument = (
  document: ProjectionDocument,
  exportOptions: ExportOptions = {},
): LitematicExport => {
  const prepared = prepareLitematic(document, exportOptions);
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const { push } = createDeflater((chunk) => {
    chunks.push(chunk);
    byteLength += chunk.byteLength;
    if (!Number.isSafeInteger(byteLength)) {
      throw new RangeError("Litematic gzip byte length exceeds the safe integer range");
    }
  });
  const writer = new BigEndianNbtWriter((chunk) => push(chunk));
  throwIfAborted(exportOptions.signal);
  writePrefix(writer, prepared);
  for (const view of prepared.views) {
    throwIfAborted(exportOptions.signal);
    writeRegion(writer, prepared, view);
    writer.flush();
  }
  writeSuffix(writer);
  push(new Uint8Array(0), true);

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, summary: summaryFromPrepared(prepared, byteLength) };
};

export const createLitematic = (
  result: ProjectionResult,
  generationOptions: HologramOptions | SolidOptions,
  exportOptions: ExportOptions = {},
) => createLitematicFromDocument(createProjectionDocumentFromResult(result, {
  metadata: { targetHeight: generationOptions.targetHeight },
}), {
  ...exportOptions,
  name: exportOptions.name ?? (result.kind === "solid" ? "MELY_Solid" : "MELY_Hologram"),
});
