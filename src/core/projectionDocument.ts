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
  SolidVoxelChunk,
  SolidVoxelResult,
} from "../types";
import { DEFAULT_BEDROCK_VERSION, DEFAULT_MINECRAFT_VERSION } from "./minecraftVersions";
import { assertHologramBlockIsolation } from "./hologramIsolation";

export const PROJECTION_DOCUMENT_VERSION = 1 as const;
export const PROJECTION_CHUNK_SIZE = 32;

type Point = [number, number, number];
type MaxSize = number | Point;

interface MutableView {
  index: Point;
  occupiedMin: Point;
  occupiedMax: Point;
  blockCount: number;
}

const axisIndex = (axis: ProjectionAxis) => axis === "x" ? 0 : axis === "y" ? 1 : 2;

const compareYzx = (left: Point, right: Point) =>
  left[1] - right[1] || left[2] - right[2] || left[0] - right[0];

const compareChunkYzx = (
  left: { chunk: Point },
  right: { chunk: Point },
) => compareYzx(left.chunk, right.chunk);

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

const projectionOptions = (
  palette: readonly ProjectionBlockState[],
  options: ProjectionDocumentOptions,
) => {
  const edition = options.edition ?? "java";
  return {
    edition,
    minecraftVersion: options.minecraftVersion ?? (
      edition === "bedrock" ? DEFAULT_BEDROCK_VERSION.id : DEFAULT_MINECRAFT_VERSION.id
    ),
    metadata: options.metadata ? { ...options.metadata } : undefined,
    palette: palette.map(cloneState),
  };
};

const assertProjectionPalette = (
  palette: readonly ProjectionBlockState[],
  context: string,
) => {
  if (palette.length > 0x1_0000) {
    throw new RangeError(`${context} palette exceeds the Uint16 index range`);
  }
};

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

const JAVA_ONLY_PROJECTION_METADATA_KEYS = new Set([
  "javaVersion",
  "javaVersionId",
  "versionId",
  "releaseStatus",
  "verification",
  "profileFingerprint",
  "targetHeight",
  "heightMode",
  "datapackAcknowledged",
  "placementBottomY",
  "targetDimension",
  "targetDimensionId",
  "targetDimensionMinY",
  "targetDimensionMaxY",
  "heightDisclaimer",
  "confirmations",
  "extremeConfirmations",
  "configurationFingerprint",
  "exportFingerprint",
]);

export const createProjectionDocument = (
  blocks: Iterable<ProjectionBlock>,
  palette: readonly ProjectionBlockState[],
  options: ProjectionDocumentOptions = {},
): ProjectionDocument => {
  const resolved = projectionOptions(palette, options);
  const chunks = new Map<string, {
    chunk: Point;
    positions: number[];
    paletteIndices: number[];
  }>();
  const min: Point = [Infinity, Infinity, Infinity];
  const max: Point = [-Infinity, -Infinity, -Infinity];
  let blockCount = 0;

  for (const block of blocks) {
    const position = [...block.position] as Point;
    position.forEach((value, index) => assertCoordinate(value, "xyz"[index]));
    if (!Number.isInteger(block.paletteIndex) || !resolved.palette[block.paletteIndex]) {
      throw new RangeError(`Unknown projection palette index: ${block.paletteIndex}`);
    }

    const chunk: Point = position.map((value) => floorDiv(value, PROJECTION_CHUNK_SIZE)) as Point;
    const local: Point = position.map((value, index) =>
      value - chunk[index] * PROJECTION_CHUNK_SIZE) as Point;
    const key = chunkKey(chunk);
    let target = chunks.get(key);
    if (!target) {
      target = { chunk, positions: [], paletteIndices: [] };
      chunks.set(key, target);
    }
    target.positions.push(encodeLocalPosition(local[0], local[1], local[2]));
    target.paletteIndices.push(block.paletteIndex);
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], position[axis]);
      max[axis] = Math.max(max[axis], position[axis]);
    }
    blockCount += 1;
  }

  const sortedChunks = [...chunks.values()]
    .sort(compareChunkYzx)
    .map(({ chunk, positions, paletteIndices }) => {
      const order = Uint16Array.from(positions.keys());
      order.sort((left, right) =>
        positions[left] - positions[right] || paletteIndices[left] - paletteIndices[right]);
      const sortedPositions = new Uint16Array(order.length);
      const sortedPaletteIndices = resolved.palette.length <= 0x1_0000
        ? new Uint16Array(order.length)
        : new Uint32Array(order.length);
      for (let index = 0; index < order.length; index += 1) {
        sortedPositions[index] = positions[order[index]];
        sortedPaletteIndices[index] = paletteIndices[order[index]];
        if (index > 0 && sortedPositions[index - 1] === sortedPositions[index]) {
          const local = decodeLocalPosition(sortedPositions[index]);
          throw new Error(
            `Duplicate projection block at ${chunk[0] * PROJECTION_CHUNK_SIZE + local[0]},`
            + `${chunk[1] * PROJECTION_CHUNK_SIZE + local[1]},`
            + `${chunk[2] * PROJECTION_CHUNK_SIZE + local[2]}`,
          );
        }
      }
      return {
        chunk: [...chunk] as Point,
        positions: sortedPositions,
        paletteIndices: sortedPaletteIndices,
      };
    });

  return {
    format: "MELYProjection",
    version: PROJECTION_DOCUMENT_VERSION,
    edition: resolved.edition,
    minecraftVersion: resolved.minecraftVersion,
    ...(resolved.metadata ? { metadata: resolved.metadata } : {}),
    palette: resolved.palette,
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
  const document = createProjectionDocument(blocks, palette, {
    ...options,
    metadata: { ...options.metadata, source: "hologram" },
  });
  assertProjectionDocumentHologramIsolation(document, "ProjectionDocument");
  return document;
};

const assertChunkCoordinate = (chunk: Point, context: string) => {
  chunk.forEach((value, axis) => {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`${context} ${"xyz"[axis]} coordinate must be a safe integer`);
    }
    const minimum = value * PROJECTION_CHUNK_SIZE;
    const maximum = minimum + PROJECTION_CHUNK_SIZE - 1;
    if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum)) {
      throw new RangeError(`${context} coordinates exceed the safe integer range`);
    }
  });
};

const assertSortedChunkBuffers = (
  chunk: Pick<SolidVoxelChunk, "chunk" | "positions" | "blockIndices">,
  paletteSize: number,
  context: string,
) => {
  if (!(chunk.positions instanceof Uint16Array)
    || !(chunk.blockIndices instanceof Uint16Array)
    || chunk.positions.length !== chunk.blockIndices.length) {
    throw new RangeError(`${context} has inconsistent buffers`);
  }
  let previous = -1;
  for (let index = 0; index < chunk.positions.length; index += 1) {
    const localPosition = chunk.positions[index];
    if (localPosition >= PROJECTION_CHUNK_SIZE ** 3) {
      throw new RangeError(`${context} contains invalid local position ${localPosition}`);
    }
    if (localPosition <= previous) {
      throw new Error(`${context} local positions must be strictly increasing and unique`);
    }
    const paletteIndex = chunk.blockIndices[index];
    if (paletteIndex >= paletteSize) {
      throw new RangeError(`${context} contains unknown palette index ${paletteIndex}`);
    }
    previous = localPosition;
  }
};

/**
 * 接收 Worker 已冻结的 32^3 typed chunks，不再建立逐方块 JS 对象。
 * 输入缓冲区所有权随文档转移，调用方需要保留结果时应先自行复制。
 */
export const createProjectionDocumentFromSolidChunks = (
  chunks: readonly SolidVoxelChunk[],
  palette: readonly ProjectionBlockState[],
  options: ProjectionDocumentOptions = {},
): ProjectionDocument => {
  const resolved = projectionOptions(palette, options);
  assertProjectionPalette(resolved.palette, "Solid voxel");
  const sortedChunks = chunks.every((chunk, index) =>
    index === 0 || compareChunkYzx(chunks[index - 1], chunk) < 0)
    ? chunks
    : [...chunks].sort(compareChunkYzx);
  const min: Point = [Infinity, Infinity, Infinity];
  const max: Point = [-Infinity, -Infinity, -Infinity];
  let blockCount = 0;
  let previousChunk: Point | undefined;

  const projectionChunks = sortedChunks.map((chunk) => {
    const coordinates = [...chunk.chunk] as Point;
    const context = `Solid voxel chunk ${chunkKey(coordinates)}`;
    assertChunkCoordinate(coordinates, context);
    if (previousChunk && compareYzx(previousChunk, coordinates) === 0) {
      throw new Error(`Duplicate solid voxel chunk: ${chunkKey(coordinates)}`);
    }
    assertSortedChunkBuffers(chunk, resolved.palette.length, context);
    if (chunk.positions.length === 0) {
      throw new RangeError(`${context} must contain at least one block`);
    }
    for (let index = 0; index < chunk.positions.length; index += 1) {
      const local = decodeLocalPosition(chunk.positions[index]);
      for (let axis = 0; axis < 3; axis += 1) {
        const coordinate = coordinates[axis] * PROJECTION_CHUNK_SIZE + local[axis];
        min[axis] = Math.min(min[axis], coordinate);
        max[axis] = Math.max(max[axis], coordinate);
      }
    }
    blockCount += chunk.positions.length;
    if (!Number.isSafeInteger(blockCount)) {
      throw new RangeError("Solid voxel block count exceeds the safe integer range");
    }
    previousChunk = coordinates;
    return {
      chunk: coordinates,
      positions: chunk.positions,
      paletteIndices: chunk.blockIndices,
    };
  });

  return {
    format: "MELYProjection",
    version: PROJECTION_DOCUMENT_VERSION,
    edition: resolved.edition,
    minecraftVersion: resolved.minecraftVersion,
    ...(resolved.metadata ? { metadata: resolved.metadata } : {}),
    palette: resolved.palette,
    chunks: projectionChunks,
    bounds: blockCount > 0 ? boundsFromExtents(min, max) : null,
    blockCount,
  };
};

export const createProjectionDocumentFromSolid = (
  result: SolidVoxelResult,
  options: ProjectionDocumentOptions = {},
): ProjectionDocument => {
  const palette = result.palette.map((entry) => ({
    blockId: entry.blockId,
    color: [...entry.color] as [number, number, number],
  }));
  if (result.storage === "chunked") {
    if (result.positions.length !== 0 || result.blockIndices.length !== 0) {
      throw new RangeError("Chunked solid voxel result must not duplicate flat buffers");
    }
    if (!result.chunks) {
      throw new RangeError("Chunked solid voxel result is missing chunks");
    }
    return createProjectionDocumentFromSolidChunks(result.chunks, palette, {
      ...options,
      metadata: { ...options.metadata, source: "solid" },
    });
  }
  const blockCount = result.positions.length / 3;
  if (!Number.isInteger(blockCount) || result.blockIndices.length !== blockCount) {
    throw new RangeError("Solid voxel result buffers have inconsistent lengths");
  }
  function* iterateFlatSolidBlocks(): Generator<ProjectionBlock> {
    for (let index = 0; index < blockCount; index += 1) {
      yield {
        position: roundedPosition(result.positions, index),
        paletteIndex: result.blockIndices[index],
      };
    }
  }
  return createProjectionDocument(iterateFlatSolidBlocks(), palette, {
    ...options,
    metadata: { ...options.metadata, source: "solid" },
  });
};

export const createProjectionDocumentFromResult = (
  result: ProjectionResult,
  options: ProjectionDocumentOptions = {},
) => result.kind === "solid"
  ? createProjectionDocumentFromSolid(result, options)
  : createProjectionDocumentFromHologram(result, options);

export const projectionResultToDocument = createProjectionDocumentFromResult;

/**
 * Bedrock 导出只派生几何与通用工程信息，不继承 Java 世界高度授权。
 */
export const deriveBedrockProjectionDocument = (
  document: ProjectionDocument,
): ProjectionDocument => {
  const metadataEntries = Object.entries(document.metadata ?? {}).filter(
    ([key]) => !JAVA_ONLY_PROJECTION_METADATA_KEYS.has(key),
  );
  return createProjectionDocument(
    iterateProjectionBlocks(document),
    document.palette,
    {
      edition: "bedrock",
      minecraftVersion: DEFAULT_BEDROCK_VERSION.id,
      ...(metadataEntries.length > 0
        ? { metadata: Object.fromEntries(metadataEntries) }
        : {}),
    },
  );
};

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

const assertProjectionChunk = (
  chunk: ProjectionDocument["chunks"][number],
  paletteSize: number,
  context: string,
) => {
  const coordinates = [...chunk.chunk] as Point;
  assertChunkCoordinate(coordinates, context);
  if (!(chunk.positions instanceof Uint16Array)
    || !(chunk.paletteIndices instanceof Uint16Array)
      && !(chunk.paletteIndices instanceof Uint32Array)
    || chunk.positions.length !== chunk.paletteIndices.length) {
    throw new RangeError(`${context} has inconsistent buffers`);
  }
  let previous = -1;
  for (let index = 0; index < chunk.positions.length; index += 1) {
    const localPosition = chunk.positions[index];
    if (localPosition >= PROJECTION_CHUNK_SIZE ** 3) {
      throw new RangeError(`${context} contains invalid local position ${localPosition}`);
    }
    if (localPosition <= previous) {
      throw new Error(`${context} local positions must be strictly increasing and unique`);
    }
    const paletteIndex = chunk.paletteIndices[index];
    if (!Number.isInteger(paletteIndex) || paletteIndex >= paletteSize) {
      throw new RangeError(`${context} contains unknown palette index ${paletteIndex}`);
    }
    previous = localPosition;
  }
  return coordinates;
};

/** 最终导出前按分块重算文档事实，不为每个方块创建坐标字符串。 */
export const assertProjectionDocumentIntegrity = (
  document: ProjectionDocument,
  context = "ProjectionDocument",
) => {
  const min: Point = [Infinity, Infinity, Infinity];
  const max: Point = [-Infinity, -Infinity, -Infinity];
  let blockCount = 0;
  const chunks = document.chunks.every((chunk, index) =>
    index === 0 || compareChunkYzx(document.chunks[index - 1], chunk) < 0)
    ? document.chunks
    : [...document.chunks].sort(compareChunkYzx);
  let previousChunk: Point | undefined;
  for (const chunk of chunks) {
    const label = `${context} chunk ${chunkKey(chunk.chunk)}`;
    const coordinates = assertProjectionChunk(chunk, document.palette.length, label);
    if (previousChunk && compareYzx(previousChunk, coordinates) === 0) {
      throw new Error(`${context} contains duplicate chunk ${chunkKey(coordinates)}`);
    }
    if (chunk.positions.length === 0) {
      throw new RangeError(`${label} must contain at least one block`);
    }
    for (let index = 0; index < chunk.positions.length; index += 1) {
      const local = decodeLocalPosition(chunk.positions[index]);
      for (let axis = 0; axis < 3; axis += 1) {
        const coordinate = coordinates[axis] * PROJECTION_CHUNK_SIZE + local[axis];
        min[axis] = Math.min(min[axis], coordinate);
        max[axis] = Math.max(max[axis], coordinate);
      }
    }
    blockCount += chunk.positions.length;
    if (!Number.isSafeInteger(blockCount)) {
      throw new RangeError(`${context} block count exceeds the safe integer range`);
    }
    previousChunk = coordinates;
  }
  if (blockCount !== document.blockCount) {
    throw new Error(`${context} blockCount ${document.blockCount} does not match actual ${blockCount}`);
  }
  if (blockCount === 0) {
    if (document.bounds !== null) throw new Error(`${context} empty document must not declare bounds`);
    return;
  }
  if (!document.bounds) throw new Error(`${context} non-empty document must declare bounds`);
  const actual = boundsFromExtents(min, max);
  for (let axis = 0; axis < 3; axis += 1) {
    if (!Number.isSafeInteger(actual.dimensions[axis]) || actual.dimensions[axis] <= 0) {
      throw new RangeError(`${context} bounds exceed safe integer range`);
    }
    if (
      document.bounds.min[axis] !== actual.min[axis]
      || document.bounds.max[axis] !== actual.max[axis]
      || document.bounds.dimensions[axis] !== actual.dimensions[axis]
    ) {
      throw new Error(`${context} declared bounds do not match actual block coordinates`);
    }
  }
};

/**
 * 只要文档包含隔离材质就必须验证，不能信任可省略或伪造的 source 元数据。
 */
export const assertProjectionDocumentHologramIsolation = (
  document: ProjectionDocument,
  context = "Hologram projection",
) => {
  const source = document.metadata?.source;
  const generationMode = document.metadata?.generationMode;
  // 实体投影允许把末地烛和玻璃板作为普通调色板方块；六向隔离仅是灵动虚空合同。
  if (source !== "hologram" && generationMode !== "hologram") return;
  assertHologramBlockIsolation(iterateProjectionBlocks(document), document.palette, context);
};

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
