import { Int, Short, encode, type TagObject } from "nbt-ts";
import { gzip } from "pako";
import type {
  ProjectionBlockState,
  ProjectionDocument,
} from "../types";
import { DEFAULT_MINECRAFT_VERSION } from "./minecraftVersions";
import { resolveBlockId } from "./blockRegistry";
import { iterateProjectionBlocks } from "./projectionDocument";

export interface SchematicExportOptions {
  name?: string;
  author?: string;
  description?: string;
  dataVersion?: number;
  maxVolume?: number;
}

export interface SchematicExport {
  bytes: Uint8Array;
  summary: {
    dimensions: [number, number, number];
    offset: [number, number, number];
    blockCount: number;
    volume: number;
    paletteSize: number;
    dataVersion: number;
  };
}

interface IndexedBlock {
  linearIndex: number;
  paletteIndex: number;
}

const DEFAULT_MAX_VOLUME = 64 * 1024 * 1024;

const stateString = (state: ProjectionBlockState, version: string) => {
  const blockId = resolveBlockId(state.blockId, "java", version);
  const properties = state.properties
    ? Object.entries(state.properties)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${value}`)
        .join(",")
    : "";
  return properties ? `${blockId}[${properties}]` : blockId;
};

const varIntLength = (value: number) => {
  let remaining = value >>> 0;
  let length = 1;
  while (remaining >= 0x80) {
    remaining >>>= 7;
    length += 1;
  }
  return length;
};

const writeVarInt = (target: Int8Array, offset: number, value: number) => {
  let remaining = value >>> 0;
  let cursor = offset;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) byte |= 0x80;
    target[cursor] = byte > 127 ? byte - 256 : byte;
    cursor += 1;
  } while (remaining !== 0);
  return cursor;
};

const buildPalette = (document: ProjectionDocument) => {
  const states = ["minecraft:air"];
  const stateIndices = new Map([[states[0], 0]]);
  const sourceIndices = new Uint32Array(document.palette.length);
  document.palette.forEach((state, index) => {
    const serialized = stateString(state, document.minecraftVersion);
    let targetIndex = stateIndices.get(serialized);
    if (targetIndex === undefined) {
      targetIndex = states.length;
      states.push(serialized);
      stateIndices.set(serialized, targetIndex);
    }
    sourceIndices[index] = targetIndex;
  });
  return { states, sourceIndices };
};

const sanitizeText = (value: string | undefined, fallback: string) => {
  const normalized = value?.normalize("NFKC").trim();
  return normalized || fallback;
};

export const createSchematic = (
  document: ProjectionDocument,
  options: SchematicExportOptions = {},
): SchematicExport => {
  if (!document.bounds || document.blockCount === 0) {
    throw new RangeError("Cannot export an empty Sponge schematic");
  }
  const dimensions = [...document.bounds.dimensions] as [number, number, number];
  dimensions.forEach((dimension) => {
    if (!Number.isSafeInteger(dimension) || dimension <= 0 || dimension > 0x7fff) {
      throw new RangeError("Sponge schematic dimensions must be between 1 and 32767");
    }
  });
  const [width, height, length] = dimensions;
  const volume = width * height * length;
  const maxVolume = options.maxVolume ?? DEFAULT_MAX_VOLUME;
  if (!Number.isSafeInteger(volume) || volume > maxVolume) {
    throw new RangeError(`Sponge schematic volume ${volume} exceeds limit ${maxVolume}`);
  }

  const { states, sourceIndices } = buildPalette(document);
  const indexedBlocks: IndexedBlock[] = [];
  for (const block of iterateProjectionBlocks(document)) {
    const paletteIndex = sourceIndices[block.paletteIndex];
    if (paletteIndex === 0) continue;
    const x = block.position[0] - document.bounds.min[0];
    const y = block.position[1] - document.bounds.min[1];
    const z = block.position[2] - document.bounds.min[2];
    indexedBlocks.push({
      linearIndex: (y * length + z) * width + x,
      paletteIndex,
    });
  }
  indexedBlocks.sort((left, right) => left.linearIndex - right.linearIndex);

  let dataLength = volume;
  indexedBlocks.forEach((block) => {
    dataLength += varIntLength(block.paletteIndex) - 1;
  });
  const blockData = new Int8Array(dataLength);
  let cursor = 0;
  let nextLinearIndex = 0;
  for (const block of indexedBlocks) {
    cursor += block.linearIndex - nextLinearIndex;
    cursor = writeVarInt(blockData, cursor, block.paletteIndex);
    nextLinearIndex = block.linearIndex + 1;
  }
  cursor += volume - nextLinearIndex;
  if (cursor !== blockData.length) {
    throw new Error("Sponge schematic block data length mismatch");
  }

  const palette = Object.fromEntries(
    states.map((state, index) => [state, new Int(index)]),
  ) as TagObject;
  const dataVersion = options.dataVersion ?? DEFAULT_MINECRAFT_VERSION.dataVersion;
  const root = {
    Version: new Int(3),
    DataVersion: new Int(dataVersion),
    Metadata: {
      Name: sanitizeText(options.name, "MELY Projection"),
      Author: sanitizeText(options.author, "MELY"),
      Description: sanitizeText(options.description, "Generated by MELY"),
    },
    Width: new Short(width),
    Height: new Short(height),
    Length: new Short(length),
    Offset: Int32Array.from(document.bounds.min),
    Blocks: {
      Palette: palette,
      Data: blockData,
      BlockEntities: [],
    },
    Entities: [],
  };
  const bytes = gzip(encode("Schematic", root), { level: 9 });
  return {
    bytes,
    summary: {
      dimensions,
      offset: [...document.bounds.min],
      blockCount: indexedBlocks.length,
      volume,
      paletteSize: states.length,
      dataVersion,
    },
  };
};
