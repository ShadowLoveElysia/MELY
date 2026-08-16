import type {
  ProjectionBlockState,
  ProjectionDocument,
} from "../types";
import {
  BEDROCK_1_20_VERSION,
  getBlockDefinition,
  resolveBedrockBlockMapping,
  type MinecraftBlockStateValue,
} from "./blockRegistry";
import { DEFAULT_BEDROCK_VERSION } from "./minecraftVersions";
import {
  assertProjectionDocumentHologramIsolation,
  assertProjectionDocumentIntegrity,
  iterateProjectionBlocks,
} from "./projectionDocument";

export type BedrockBlockStateValue = MinecraftBlockStateValue;

export interface ResolvedBedrockBlockState {
  blockId: string;
  states: Record<string, BedrockBlockStateValue>;
}

export interface McstructureExportOptions {
  maxVolume?: number;
}

export interface McstructureExport {
  bytes: Uint8Array;
  summary: {
    dimensions: [number, number, number];
    origin: [number, number, number];
    blockCount: number;
    volume: number;
    paletteSize: number;
    blockVersion: number;
  };
}

interface IndexedBlock {
  linearIndex: number;
  paletteIndex: number;
}

const TAG_END = 0;
const TAG_BYTE = 1;
const TAG_INT = 3;
const TAG_STRING = 8;
const TAG_LIST = 9;
const TAG_COMPOUND = 10;
const DEFAULT_MAX_VOLUME = 64 * 1024 * 1024;
export const BEDROCK_BLOCK_VERSION = DEFAULT_BEDROCK_VERSION.blockVersion;

const FACING_DIRECTION: Record<string, number> = {
  down: 0,
  up: 1,
  north: 2,
  south: 3,
  west: 4,
  east: 5,
};

const VINE_DIRECTION_BITS = {
  south: 1,
  west: 2,
  north: 4,
  east: 8,
} as const;

const MULTI_FACE_DIRECTION_BITS = {
  down: 1,
  up: 2,
  north: 4,
  south: 8,
  west: 16,
  east: 32,
} as const;

const directionBits = (
  properties: ProjectionBlockState["properties"],
  bits: Readonly<Record<string, number>>,
  fallback: number,
) => {
  const directions = Object.keys(bits);
  const hasDirectionalState = ["down", "up", "north", "south", "west", "east"]
    .some((direction) => properties?.[direction] !== undefined);
  if (!hasDirectionalState) return fallback;
  return directions.reduce((mask, direction) =>
    properties?.[direction] === "true" ? mask | bits[direction] : mask, 0);
};

export const resolveBedrockBlockState = (
  state: ProjectionBlockState,
  version = BEDROCK_1_20_VERSION,
): ResolvedBedrockBlockState => {
  const canonicalId = getBlockDefinition(state.blockId).canonicalId;
  const mapping = resolveBedrockBlockMapping(canonicalId, version);
  const states: Record<string, BedrockBlockStateValue> = { ...mapping.states };

  if (canonicalId === "minecraft:end_rod") {
    const facing = state.properties?.facing;
    if (facing !== undefined && FACING_DIRECTION[facing] !== undefined) {
      states.facing_direction = FACING_DIRECTION[facing];
    }
  }
  if (typeof states.pillar_axis === "string") {
    const axis = state.properties?.axis;
    if (axis === "x" || axis === "y" || axis === "z") states.pillar_axis = axis;
  }
  if (canonicalId === "minecraft:vine") {
    states.vine_direction_bits = directionBits(
      state.properties,
      VINE_DIRECTION_BITS,
      Number(states.vine_direction_bits ?? 1),
    );
  }
  if (canonicalId === "minecraft:glow_lichen") {
    states.multi_face_direction_bits = directionBits(
      state.properties,
      MULTI_FACE_DIRECTION_BITS,
      Number(states.multi_face_direction_bits ?? 1),
    );
  }

  return { blockId: mapping.blockId, states };
};

class LittleEndianNbtWriter {
  private bytes: Uint8Array;
  private view: DataView;
  private offset = 0;
  private readonly encoder = new TextEncoder();

  constructor(initialCapacity: number) {
    this.bytes = new Uint8Array(Math.max(1024, initialCapacity));
    this.view = new DataView(this.bytes.buffer);
  }

  private ensure(length: number) {
    if (this.offset + length <= this.bytes.length) return;
    let capacity = this.bytes.length;
    while (capacity < this.offset + length) capacity *= 2;
    const next = new Uint8Array(capacity);
    next.set(this.bytes);
    this.bytes = next;
    this.view = new DataView(next.buffer);
  }

  byte(value: number) {
    this.ensure(1);
    this.view.setInt8(this.offset, value);
    this.offset += 1;
  }

  int(value: number) {
    this.ensure(4);
    this.view.setInt32(this.offset, value, true);
    this.offset += 4;
  }

  string(value: string) {
    const encoded = this.encoder.encode(value);
    if (encoded.length > 0xffff) throw new RangeError("NBT string exceeds 65535 bytes");
    this.ensure(2 + encoded.length);
    this.view.setUint16(this.offset, encoded.length, true);
    this.offset += 2;
    this.bytes.set(encoded, this.offset);
    this.offset += encoded.length;
  }

  header(type: number, name: string) {
    this.byte(type);
    this.string(name);
  }

  namedInt(name: string, value: number) {
    this.header(TAG_INT, name);
    this.int(value);
  }

  namedString(name: string, value: string) {
    this.header(TAG_STRING, name);
    this.string(value);
  }

  namedCompound(name: string, write: () => void) {
    this.header(TAG_COMPOUND, name);
    write();
    this.byte(TAG_END);
  }

  namedIntList(name: string, values: readonly number[]) {
    this.header(TAG_LIST, name);
    this.byte(TAG_INT);
    this.int(values.length);
    values.forEach((value) => this.int(value));
  }

  namedEmptyCompoundList(name: string) {
    this.header(TAG_LIST, name);
    this.byte(TAG_COMPOUND);
    this.int(0);
  }

  namedCompoundList(name: string, writers: readonly (() => void)[]) {
    this.header(TAG_LIST, name);
    this.byte(TAG_COMPOUND);
    this.int(writers.length);
    writers.forEach((write) => {
      write();
      this.byte(TAG_END);
    });
  }

  namedBlockIndexLayers(name: string, blocks: readonly IndexedBlock[], volume: number) {
    this.header(TAG_LIST, name);
    this.byte(TAG_LIST);
    this.int(2);

    this.byte(TAG_INT);
    this.int(volume);
    let blockCursor = 0;
    for (let index = 0; index < volume; index += 1) {
      const block = blocks[blockCursor];
      if (block?.linearIndex === index) {
        this.int(block.paletteIndex);
        blockCursor += 1;
      } else {
        this.int(-1);
      }
    }

    this.byte(TAG_INT);
    this.int(volume);
    for (let index = 0; index < volume; index += 1) this.int(-1);
  }

  namedStateCompound(name: string, states: Record<string, BedrockBlockStateValue>) {
    this.namedCompound(name, () => {
      Object.entries(states)
        .sort(([left], [right]) => left.localeCompare(right))
        .forEach(([key, value]) => {
          if (typeof value === "string") this.namedString(key, value);
          else if (typeof value === "boolean") {
            this.header(TAG_BYTE, key);
            this.byte(value ? 1 : 0);
          } else this.namedInt(key, value);
        });
    });
  }

  finish() {
    return this.bytes.slice(0, this.offset);
  }
}

const stateKey = (state: ResolvedBedrockBlockState) =>
  `${state.blockId}|${Object.entries(state.states)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(",")}`;

export const createMcstructure = (
  document: ProjectionDocument,
  options: McstructureExportOptions = {},
): McstructureExport => {
  if (document.edition !== "bedrock" || document.minecraftVersion !== DEFAULT_BEDROCK_VERSION.id) {
    throw new RangeError(
      `Bedrock structure export requires a Bedrock ${DEFAULT_BEDROCK_VERSION.id} projection document`,
    );
  }
  assertProjectionDocumentIntegrity(document, "Bedrock structure export");
  assertProjectionDocumentHologramIsolation(document, "Bedrock structure export");
  if (!document.bounds || document.blockCount === 0) {
    throw new RangeError("Cannot export an empty Bedrock structure");
  }
  const dimensions = [...document.bounds.dimensions] as [number, number, number];
  const [sizeX, sizeY, sizeZ] = dimensions;
  const volume = sizeX * sizeY * sizeZ;
  const maxVolume = options.maxVolume ?? DEFAULT_MAX_VOLUME;
  if (!Number.isSafeInteger(volume) || volume <= 0 || volume > maxVolume) {
    throw new RangeError(`Bedrock structure volume ${volume} exceeds limit ${maxVolume}`);
  }

  const palette: ResolvedBedrockBlockState[] = [];
  const paletteMap = new Map<string, number>();
  const sourceIndices = new Int32Array(document.palette.length).fill(-1);
  document.palette.forEach((source, index) => {
    const state = resolveBedrockBlockState(source);
    if (state.blockId === "minecraft:air") return;
    const key = stateKey(state);
    let paletteIndex = paletteMap.get(key);
    if (paletteIndex === undefined) {
      paletteIndex = palette.length;
      paletteMap.set(key, paletteIndex);
      palette.push(state);
    }
    sourceIndices[index] = paletteIndex;
  });

  const blocks: IndexedBlock[] = [];
  for (const block of iterateProjectionBlocks(document)) {
    const paletteIndex = sourceIndices[block.paletteIndex];
    if (paletteIndex < 0) continue;
    const x = block.position[0] - document.bounds.min[0];
    const y = block.position[1] - document.bounds.min[1];
    const z = block.position[2] - document.bounds.min[2];
    blocks.push({
      linearIndex: (x * sizeY + y) * sizeZ + z,
      paletteIndex,
    });
  }
  blocks.sort((left, right) => left.linearIndex - right.linearIndex);

  const blockVersion = BEDROCK_BLOCK_VERSION;
  const writer = new LittleEndianNbtWriter(volume * 8 + palette.length * 128 + 4096);
  writer.header(TAG_COMPOUND, "");
  writer.namedInt("format_version", 1);
  writer.namedIntList("size", dimensions);
  writer.namedCompound("structure", () => {
    writer.namedBlockIndexLayers("block_indices", blocks, volume);
    writer.namedEmptyCompoundList("entities");
    writer.namedCompound("palette", () => {
      writer.namedCompound("default", () => {
        writer.namedCompoundList("block_palette", palette.map((state) => () => {
          writer.namedString("name", state.blockId);
          writer.namedStateCompound("states", state.states);
          writer.namedInt("version", blockVersion);
        }));
        writer.namedCompound("block_position_data", () => {});
      });
    });
  });
  writer.namedIntList("structure_world_origin", document.bounds.min);
  writer.byte(TAG_END);

  return {
    bytes: writer.finish(),
    summary: {
      dimensions,
      origin: [...document.bounds.min],
      blockCount: blocks.length,
      volume,
      paletteSize: palette.length,
      blockVersion,
    },
  };
};
