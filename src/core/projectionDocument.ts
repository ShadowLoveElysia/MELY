import type {
  HologramResult,
  ProjectionAxis,
  ProjectionBlock,
  ProjectionBlockState,
  ProjectionBounds,
  ProjectionDocument,
  ProjectionDocumentOptions,
  ProjectionMaterialCount,
  ProjectionResult,
  ProjectionView,
  SolidVoxelResult,
} from "../types";
import { DEFAULT_BEDROCK_VERSION, DEFAULT_MINECRAFT_VERSION } from "./minecraftVersions";

export const PROJECTION_DOCUMENT_VERSION = 1 as const;
export const PROJECTION_CHUNK_SIZE = 32;

type Point = [number, number, number];
type MaxSize = number | Point;

interface MutableChunkBlock {
  localPosition: number;
  paletteIndex: number;
}

interface MutableView {
  index: Point;
  occupiedMin: Point;
  occupiedMax: Point;
  blockCount: number;
}

const axisIndex = (axis: ProjectionAxis) => axis === "x" ? 0 : axis === "y" ? 1 : 2;

const compareYzx = (left: Point, right: Point) =>
  left[1] - right[1] || left[2] - right[2] || left[0] - right[0];

const floorDiv = (value: number, divisor: number) => Math.floor(value / divisor);

const encodeLocalPosition = (x: number, y: number, z: number) =>
  x + PROJECTION_CHUNK_SIZE * (z + PROJECTION_CHUNK_SIZE * y);

const decodeLocalPosition = (position: number): Point => {
  const x = position % PROJECTION_CHUNK_SIZE;
  const yz = Math.floor(position / PROJECTION_CHUNK_SIZE);
  const z = yz % PROJECTION_CHUNK_SIZE;
  const y = Math.floor(yz / PROJECTION_CHUNK_SIZE);
  return [x, y, z];
};

const chunkKey = (chunk: Point) => `${chunk[0]},${chunk[1]},${chunk[2]}`;

const assertCoordinate = (value: number, axis: string) => {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`Projection ${axis} coordinate must be a safe integer`);
  }
};

const cloneState = (state: ProjectionBlockState): ProjectionBlockState => ({
  blockId: state.blockId,
  ...(state.properties
    ? { properties: Object.fromEntries(Object.entries(state.properties).sort(([a], [b]) => a.localeCompare(b))) }
    : {}),
  ...(state.color ? { color: [...state.color] as [number, number, number] } : {}),
  ...(state.emissive !== undefined ? { emissive: state.emissive } : {}),
});

const boundsFromExtents = (min: Point, max: Point): ProjectionBounds => ({
  min: [...min] as Point,
  max: [...max] as Point,
  dimensions: [
    max[0] - min[0] + 1,
    max[1] - min[1] + 1,
    max[2] - min[2] + 1,
  ],
});

const roundedPosition = (positions: Float32Array, index: number): Point => [
  Math.round(positions[index * 3]),
  Math.round(positions[index * 3 + 1]),
  Math.round(positions[index * 3 + 2]),
];

const materialFacingState = (material: number, facing: number): ProjectionBlockState => {
  if (material === 0) {
    if (facing !== 2) {
      throw new RangeError(`Unsupported hologram end rod facing code: ${facing}`);
    }
    return {
      blockId: "minecraft:end_rod",
      properties: { facing: "up" },
      emissive: true,
    };
  }
  if (material === 1) {
    return {
      blockId: "minecraft:white_stained_glass_pane",
      properties: {
        east: "false",
        north: "false",
        south: "false",
        waterlogged: "false",
        west: "false",
      },
      emissive: false,
    };
  }
  throw new RangeError(`Unsupported hologram material index: ${material}`);
};

const stateKey = (state: ProjectionBlockState) => {
  const properties = state.properties
    ? Object.entries(state.properties)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${value}`)
        .join(",")
    : "";
  const color = state.color?.join(",") ?? "";
  return `${state.blockId}[${properties}]|${color}|${state.emissive ?? ""}`;
};

export const createProjectionDocument = (
  blocks: Iterable<ProjectionBlock>,
  palette: readonly ProjectionBlockState[],
  options: ProjectionDocumentOptions = {},
): ProjectionDocument => {
  const edition = options.edition ?? "java";
  const clonedPalette = palette.map(cloneState);
  const chunks = new Map<string, { chunk: Point; blocks: MutableChunkBlock[] }>();
  const min: Point = [Infinity, Infinity, Infinity];
  const max: Point = [-Infinity, -Infinity, -Infinity];
  let blockCount = 0;

  for (const block of blocks) {
    const position = [...block.position] as Point;
    position.forEach((value, index) => assertCoordinate(value, "xyz"[index]));
    if (!Number.isInteger(block.paletteIndex) || !clonedPalette[block.paletteIndex]) {
      throw new RangeError(`Unknown projection palette index: ${block.paletteIndex}`);
    }

    const chunk: Point = position.map((value) => floorDiv(value, PROJECTION_CHUNK_SIZE)) as Point;
    const local: Point = position.map((value, index) =>
      value - chunk[index] * PROJECTION_CHUNK_SIZE) as Point;
    const key = chunkKey(chunk);
    let target = chunks.get(key);
    if (!target) {
      target = { chunk, blocks: [] };
      chunks.set(key, target);
    }
    target.blocks.push({
      localPosition: encodeLocalPosition(local[0], local[1], local[2]),
      paletteIndex: block.paletteIndex,
    });
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], position[axis]);
      max[axis] = Math.max(max[axis], position[axis]);
    }
    blockCount += 1;
  }

  const sortedChunks = [...chunks.values()]
    .sort((left, right) => compareYzx(left.chunk, right.chunk))
    .map(({ chunk, blocks: chunkBlocks }) => {
      chunkBlocks.sort((left, right) =>
        left.localPosition - right.localPosition || left.paletteIndex - right.paletteIndex);
      for (let index = 1; index < chunkBlocks.length; index += 1) {
        if (chunkBlocks[index - 1].localPosition === chunkBlocks[index].localPosition) {
          const local = decodeLocalPosition(chunkBlocks[index].localPosition);
          throw new Error(
            `Duplicate projection block at ${chunk[0] * PROJECTION_CHUNK_SIZE + local[0]},`
            + `${chunk[1] * PROJECTION_CHUNK_SIZE + local[1]},`
            + `${chunk[2] * PROJECTION_CHUNK_SIZE + local[2]}`,
          );
        }
      }
      const paletteIndices = clonedPalette.length <= 0x1_0000
        ? Uint16Array.from(chunkBlocks, (block) => block.paletteIndex)
        : Uint32Array.from(chunkBlocks, (block) => block.paletteIndex);
      return {
        chunk: [...chunk] as Point,
        positions: Uint16Array.from(chunkBlocks, (block) => block.localPosition),
        paletteIndices,
      };
    });

  return {
    format: "MELYProjection",
    version: PROJECTION_DOCUMENT_VERSION,
    edition,
    minecraftVersion: options.minecraftVersion ?? (
      edition === "bedrock" ? DEFAULT_BEDROCK_VERSION.id : DEFAULT_MINECRAFT_VERSION.id
    ),
    ...(options.metadata ? { metadata: { ...options.metadata } } : {}),
    palette: clonedPalette,
    chunks: sortedChunks,
    bounds: blockCount > 0 ? boundsFromExtents(min, max) : null,
    blockCount,
  };
};

export const createProjectionDocumentFromHologram = (
  result: HologramResult,
  options: ProjectionDocumentOptions = {},
): ProjectionDocument => {
  const blockCount = result.positions.length / 3;
  if (!Number.isInteger(blockCount)
    || result.materials.length !== blockCount
    || result.facings.length !== blockCount) {
    throw new RangeError("Hologram result buffers have inconsistent lengths");
  }

  const palette: ProjectionBlockState[] = [];
  const paletteMap = new Map<string, number>();
  const blocks: ProjectionBlock[] = new Array(blockCount);
  for (let index = 0; index < blockCount; index += 1) {
    const state = materialFacingState(result.materials[index], result.facings[index]);
    const key = stateKey(state);
    let paletteIndex = paletteMap.get(key);
    if (paletteIndex === undefined) {
      paletteIndex = palette.length;
      paletteMap.set(key, paletteIndex);
      palette.push(state);
    }
    blocks[index] = { position: roundedPosition(result.positions, index), paletteIndex };
  }
  return createProjectionDocument(blocks, palette, {
    ...options,
    metadata: { source: "hologram", ...options.metadata },
  });
};

export const createProjectionDocumentFromSolid = (
  result: SolidVoxelResult,
  options: ProjectionDocumentOptions = {},
): ProjectionDocument => {
  const blockCount = result.positions.length / 3;
  if (!Number.isInteger(blockCount) || result.blockIndices.length !== blockCount) {
    throw new RangeError("Solid voxel result buffers have inconsistent lengths");
  }
  const palette = result.palette.map((entry) => ({
    blockId: entry.blockId,
    color: [...entry.color] as [number, number, number],
  }));
  const blocks = Array.from({ length: blockCount }, (_, index): ProjectionBlock => ({
    position: roundedPosition(result.positions, index),
    paletteIndex: result.blockIndices[index],
  }));
  return createProjectionDocument(blocks, palette, {
    ...options,
    metadata: { source: "solid", ...options.metadata },
  });
};

export const createProjectionDocumentFromResult = (
  result: ProjectionResult,
  options: ProjectionDocumentOptions = {},
) => result.kind === "solid"
  ? createProjectionDocumentFromSolid(result, options)
  : createProjectionDocumentFromHologram(result, options);

export const projectionResultToDocument = createProjectionDocumentFromResult;

export function* iterateProjectionBlocks(document: ProjectionDocument): Generator<ProjectionBlock> {
  for (const chunk of document.chunks) {
    if (chunk.positions.length !== chunk.paletteIndices.length) {
      throw new RangeError(`Projection chunk ${chunkKey(chunk.chunk)} has inconsistent buffers`);
    }
    for (let index = 0; index < chunk.positions.length; index += 1) {
      const local = decodeLocalPosition(chunk.positions[index]);
      yield {
        position: [
          chunk.chunk[0] * PROJECTION_CHUNK_SIZE + local[0],
          chunk.chunk[1] * PROJECTION_CHUNK_SIZE + local[1],
          chunk.chunk[2] * PROJECTION_CHUNK_SIZE + local[2],
        ],
        paletteIndex: chunk.paletteIndices[index],
      };
    }
  }
}

export function* iterateProjectionSlice(
  document: ProjectionDocument,
  axis: ProjectionAxis,
  coordinate: number,
): Generator<ProjectionBlock> {
  assertCoordinate(coordinate, axis);
  const selectedAxis = axisIndex(axis);
  const selectedChunk = floorDiv(coordinate, PROJECTION_CHUNK_SIZE);
  for (const chunk of document.chunks) {
    if (chunk.chunk[selectedAxis] !== selectedChunk) continue;
    for (let index = 0; index < chunk.positions.length; index += 1) {
      const local = decodeLocalPosition(chunk.positions[index]);
      const position: Point = [
        chunk.chunk[0] * PROJECTION_CHUNK_SIZE + local[0],
        chunk.chunk[1] * PROJECTION_CHUNK_SIZE + local[1],
        chunk.chunk[2] * PROJECTION_CHUNK_SIZE + local[2],
      ];
      if (position[selectedAxis] === coordinate) {
        yield { position, paletteIndex: chunk.paletteIndices[index] };
      }
    }
  }
}

export const countProjectionMaterials = (
  document: ProjectionDocument,
): ProjectionMaterialCount[] => {
  const counts = new Array<number>(document.palette.length).fill(0);
  for (const chunk of document.chunks) {
    for (const paletteIndex of chunk.paletteIndices) {
      if (!document.palette[paletteIndex]) {
        throw new RangeError(`Unknown projection palette index: ${paletteIndex}`);
      }
      counts[paletteIndex] += 1;
    }
  }
  return counts.flatMap((count, paletteIndex) => count > 0
    ? [{ paletteIndex, state: document.palette[paletteIndex], count }]
    : []);
};

const normalizeMaxSize = (maxSize: MaxSize): Point => {
  const values: Point = typeof maxSize === "number"
    ? [maxSize, maxSize, maxSize]
    : [...maxSize];
  values.forEach((value) => {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError("Projection view maximum size must contain positive safe integers");
    }
  });
  return values;
};

export const splitProjectionViews = (
  document: ProjectionDocument,
  maxSize: MaxSize,
): ProjectionView[] => {
  if (!document.bounds) return [];
  const size = normalizeMaxSize(maxSize);
  const views = new Map<string, MutableView>();
  for (const block of iterateProjectionBlocks(document)) {
    const index = block.position.map((value, axis) =>
      floorDiv(value - document.bounds!.min[axis], size[axis])) as Point;
    const key = chunkKey(index);
    let view = views.get(key);
    if (!view) {
      view = {
        index,
        occupiedMin: [...block.position],
        occupiedMax: [...block.position],
        blockCount: 0,
      };
      views.set(key, view);
    }
    for (let axis = 0; axis < 3; axis += 1) {
      view.occupiedMin[axis] = Math.min(view.occupiedMin[axis], block.position[axis]);
      view.occupiedMax[axis] = Math.max(view.occupiedMax[axis], block.position[axis]);
    }
    view.blockCount += 1;
  }

  return [...views.values()]
    .sort((left, right) => compareYzx(left.index, right.index))
    .map((view) => {
      const min = view.index.map((value, axis) =>
        document.bounds!.min[axis] + value * size[axis]) as Point;
      const max = min.map((value, axis) =>
        Math.min(document.bounds!.max[axis], value + size[axis] - 1)) as Point;
      return {
        index: [...view.index] as Point,
        bounds: boundsFromExtents(min, max),
        occupiedBounds: boundsFromExtents(view.occupiedMin, view.occupiedMax),
        blockCount: view.blockCount,
      };
    });
};

export function* iterateProjectionBlocksInBounds(
  document: ProjectionDocument,
  bounds: Pick<ProjectionBounds, "min" | "max">,
): Generator<ProjectionBlock> {
  const minimumChunk = bounds.min.map((value) =>
    floorDiv(value, PROJECTION_CHUNK_SIZE)) as Point;
  const maximumChunk = bounds.max.map((value) =>
    floorDiv(value, PROJECTION_CHUNK_SIZE)) as Point;
  for (const chunk of document.chunks) {
    if (chunk.chunk.some((value, axis) =>
      value < minimumChunk[axis] || value > maximumChunk[axis])) continue;
    if (chunk.positions.length !== chunk.paletteIndices.length) {
      throw new RangeError(`Projection chunk ${chunkKey(chunk.chunk)} has inconsistent buffers`);
    }
    for (let index = 0; index < chunk.positions.length; index += 1) {
      const local = decodeLocalPosition(chunk.positions[index]);
      const position: Point = [
        chunk.chunk[0] * PROJECTION_CHUNK_SIZE + local[0],
        chunk.chunk[1] * PROJECTION_CHUNK_SIZE + local[1],
        chunk.chunk[2] * PROJECTION_CHUNK_SIZE + local[2],
      ];
      if (position.every((value, axis) =>
        value >= bounds.min[axis] && value <= bounds.max[axis])) {
        yield { position, paletteIndex: chunk.paletteIndices[index] };
      }
    }
  }
}

export const iterateProjectionViewBlocks = (
  document: ProjectionDocument,
  view: ProjectionView,
) => iterateProjectionBlocksInBounds(document, view.bounds);

export const projectionDocumentTransferables = (
  document: ProjectionDocument,
): ArrayBuffer[] => {
  const buffers = new Set<ArrayBuffer>();
  for (const chunk of document.chunks) {
    if (chunk.positions.buffer instanceof ArrayBuffer) buffers.add(chunk.positions.buffer);
    if (chunk.paletteIndices.buffer instanceof ArrayBuffer) buffers.add(chunk.paletteIndices.buffer);
  }
  return [...buffers];
};
