import { Buffer } from "buffer";
import { encode, Int, type TagObject } from "nbt-ts";
import { gzip } from "pako";
import type {
  HologramOptions,
  ProjectionDocument,
  ProjectionResult,
  ProjectionView,
  SolidOptions,
} from "../types";
import { DEFAULT_MINECRAFT_VERSION } from "./minecraftVersions";
import { appError } from "./appError";
import {
  createProjectionDocumentFromResult,
  iterateProjectionViewBlocks,
  splitProjectionViews,
} from "./projectionDocument";

interface BlockState extends TagObject {
  Name: string;
  Properties?: Record<string, string>;
}

export interface ExportOptions {
  name?: string;
  author?: string;
  description?: string;
  timestamp?: number;
  regionMaxSize?: number | [number, number, number];
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
  minecraftVersion: string;
  dataVersion: number;
  regionCount: number;
}

export interface LitematicExport {
  bytes: Uint8Array;
  summary: LitematicExportSummary;
}

const sanitizeName = (value: string) => {
  const cleaned = value
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "MELY_Hologram";
};

export const packBlockStates = (indices: Uint32Array, paletteSize: number) => {
  const bitsPerBlock = Math.max(2, Math.ceil(Math.log2(Math.max(1, paletteSize))));
  const totalBits = indices.length * bitsPerBlock;
  const packed = new BigInt64Array(Math.ceil(totalBits / 64));
  const unsigned = new Array<bigint>(packed.length).fill(0n);
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

  unsigned.forEach((value, index) => {
    packed[index] = BigInt.asIntN(64, value);
  });

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
    Name: state.blockId,
    ...(state.properties ? { Properties: { ...state.properties } } : {}),
  })),
];

const buildRegionData = (
  document: ProjectionDocument,
  view: ProjectionView,
  palette: readonly BlockState[],
) => {
  const [sizeX, sizeY, sizeZ] = view.bounds.dimensions;
  const volume = sizeX * sizeY * sizeZ;
  const indices = new Uint32Array(volume);
  for (const block of iterateProjectionViewBlocks(document, view)) {
    const x = block.position[0] - view.bounds.min[0];
    const y = block.position[1] - view.bounds.min[1];
    const z = block.position[2] - view.bounds.min[2];
    if (x < 0 || x >= sizeX || y < 0 || y >= sizeY || z < 0 || z >= sizeZ) {
      throw appError("error.litematic.coordinateOutside", { x, y, z });
    }
    const paletteIndex = block.paletteIndex + 1;
    if (!palette[paletteIndex]) {
      throw appError("error.litematic.unknownPalette", { index: paletteIndex - 1 });
    }
    indices[(y * sizeZ + z) * sizeX + x] = paletteIndex;
  }
  const { packed, bitsPerBlock } = packBlockStates(indices, palette.length);
  return { volume, packed, bitsPerBlock };
};

const regionName = (view: ProjectionView, regionCount: number) => regionCount === 1
  ? "Hologram"
  : `R_${view.index[1]}_${view.index[2]}_${view.index[0]}`;

export const createLitematicFromDocument = (
  document: ProjectionDocument,
  exportOptions: ExportOptions = {},
): LitematicExport => {
  if (document.blockCount === 0 || !document.bounds) throw appError("error.litematic.emptyProjection");
  if (document.edition !== "java") {
    throw new RangeError("Litematica export requires a Java Edition projection document");
  }

  const version = DEFAULT_MINECRAFT_VERSION;
  const timestamp = BigInt(exportOptions.timestamp ?? Date.now());
  const name = sanitizeName(exportOptions.name ?? "MELY_Projection");
  const author = exportOptions.author?.trim() || "MELY";
  const description = exportOptions.description?.trim() || `MELY | Minecraft ${version.id}`;
  const views = splitProjectionViews(document, exportOptions.regionMaxSize ?? 32);
  const palette = litematicPalette(document);
  let totalVolume = 0;
  let maximumBitsPerBlock = 2;
  let longCount = 0;
  const regions: Record<string, TagObject> = {};
  for (const view of views) {
    const data = buildRegionData(document, view, palette);
    totalVolume += data.volume;
    maximumBitsPerBlock = Math.max(maximumBitsPerBlock, data.bitsPerBlock);
    longCount += data.packed.length;
    regions[regionName(view, views.length)] = {
      Position: {
        x: new Int(view.bounds.min[0] - document.bounds.min[0]),
        y: new Int(view.bounds.min[1] - document.bounds.min[1]),
        z: new Int(view.bounds.min[2] - document.bounds.min[2]),
      },
      Size: {
        x: new Int(view.bounds.dimensions[0]),
        y: new Int(view.bounds.dimensions[1]),
        z: new Int(view.bounds.dimensions[2]),
      },
      BlockStatePalette: palette,
      BlockStates: data.packed,
      Entities: [],
      TileEntities: [],
      PendingBlockTicks: [],
      PendingFluidTicks: [],
    };
  }
  const [sizeX, sizeY, sizeZ] = document.bounds.dimensions;

  const root = {
    Version: new Int(version.litematicVersion),
    SubVersion: new Int(version.litematicSubVersion),
    MinecraftDataVersion: new Int(version.dataVersion),
    Metadata: {
      EnclosingSize: { x: new Int(sizeX), y: new Int(sizeY), z: new Int(sizeZ) },
      Author: author,
      Description: description,
      Name: name,
      Software: "MELY_0.3.0",
      RegionCount: new Int(views.length),
      TimeCreated: timestamp,
      TimeModified: timestamp,
      TotalBlocks: new Int(document.blockCount),
      TotalVolume: new Int(totalVolume),
      PreviewImageData: new Int32Array(0),
    },
    Regions: regions,
  };

  const globalWithBuffer = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
  globalWithBuffer.Buffer ??= Buffer;
  const encoded = encode("", root);
  const bytes = gzip(encoded, { level: 9 });
  return {
    bytes,
    summary: {
      name,
      byteLength: bytes.byteLength,
      blockCount: document.blockCount,
      volume: totalVolume,
      paletteSize: palette.length,
      bitsPerBlock: maximumBitsPerBlock,
      longCount,
      dimensions: [...document.bounds.dimensions],
      minecraftVersion: version.id,
      dataVersion: version.dataVersion,
      regionCount: views.length,
    },
  };
};

export const createLitematic = (
  result: ProjectionResult,
  _generationOptions: HologramOptions | SolidOptions,
  exportOptions: ExportOptions = {},
) => createLitematicFromDocument(createProjectionDocumentFromResult(result), {
  ...exportOptions,
  name: exportOptions.name ?? (result.kind === "solid" ? "MELY_Solid" : "MELY_Hologram"),
});
