import type {
  ProjectionBlock,
  ProjectionBounds,
  ProjectionChunk,
  ProjectionDocument,
  ProjectionView,
} from "../types";
import { PROJECTION_CHUNK_SIZE } from "./projectionDocument";

type Point = [number, number, number];

/** Spatial index shared by export planning and partition encoders. */
export interface ProjectionPartitionIndex {
  readonly partSize: Point;
  readonly views: readonly ProjectionView[];
  readonly sourceChunkCount: number;
  readonly blockCount: number;
  readonly candidateChunkIndices: readonly (readonly number[])[];
  readonly scanStats: {
    sourceChunksVisited: number;
    sourceBlocksVisited: number;
    candidateReferences: number;
  };
  readonly sourceFingerprint: string;
}

const floorDiv = (value: number, divisor: number) => Math.floor(value / divisor);
const pointKey = (point: readonly number[]) => point.join(",");

// The index is a runtime cache.  Keeping the source document in a WeakMap
// prevents a structured-cloned or otherwise stale index from being reused.
const indexDocuments = new WeakMap<object, ProjectionDocument>();
const indexViewOrdinals = new WeakMap<object, ReadonlyMap<string, number>>();
const indexSourceBuffers = new WeakMap<object, readonly {
  positions: Uint16Array;
  paletteIndices: Uint16Array | Uint32Array;
}[]>();

const samePoint = (left: readonly number[], right: readonly number[]) =>
  left.length === 3 && right.length === 3 && left.every((value, axis) => value === right[axis]);

const sameBounds = (left: ProjectionBounds, right: ProjectionBounds) =>
  samePoint(left.min, right.min)
  && samePoint(left.max, right.max)
  && samePoint(left.dimensions, right.dimensions);

const sameView = (left: ProjectionView | undefined, right: ProjectionView | undefined) =>
  !!left && !!right
  && samePoint(left.index, right.index)
  && sameBounds(left.bounds, right.bounds)
  && sameBounds(left.occupiedBounds, right.occupiedBounds)
  && left.blockCount === right.blockCount;

const normalizePartSize = (value: number | Point = [32, 32, 32]): Point => {
  const result = (typeof value === "number" ? [value, value, value] : [...value]) as Point;
  if (result.length !== 3 || result.some((entry) => !Number.isSafeInteger(entry) || entry <= 0)) {
    throw new RangeError("Projection partition size must contain positive safe integers");
  }
  return result;
};

const decodeLocalPosition = (position: number): Point => {
  const x = position % PROJECTION_CHUNK_SIZE;
  const yz = Math.floor(position / PROJECTION_CHUNK_SIZE);
  return [x, Math.floor(yz / PROJECTION_CHUNK_SIZE), yz % PROJECTION_CHUNK_SIZE];
};

const worldPosition = (chunk: readonly number[], localPosition: number): Point => {
  const local = decodeLocalPosition(localPosition);
  const result = [
    chunk[0] * PROJECTION_CHUNK_SIZE + local[0],
    chunk[1] * PROJECTION_CHUNK_SIZE + local[1],
    chunk[2] * PROJECTION_CHUNK_SIZE + local[2],
  ];
  if (result.some((value) => !Number.isSafeInteger(value))) {
    throw new RangeError("Projection world coordinate exceeds the safe integer range");
  }
  return result as Point;
};

const assertChunk = (chunk: ProjectionChunk, index: number, paletteSize: number) => {
  if (!Array.isArray(chunk.chunk) || chunk.chunk.length !== 3
    || chunk.chunk.some((value) => !Number.isSafeInteger(value))) {
    throw new RangeError(`Projection chunk ${index} has unsafe coordinates`);
  }
  for (const coordinate of chunk.chunk) {
    const origin = coordinate * PROJECTION_CHUNK_SIZE;
    const maximum = origin + PROJECTION_CHUNK_SIZE - 1;
    if (!Number.isSafeInteger(origin) || !Number.isSafeInteger(maximum)) {
      throw new RangeError(`Projection chunk ${index} coordinates exceed the safe range`);
    }
  }
  if (!(chunk.positions instanceof Uint16Array)
    || (!(chunk.paletteIndices instanceof Uint16Array) && !(chunk.paletteIndices instanceof Uint32Array))
    || chunk.positions.length !== chunk.paletteIndices.length) {
    throw new RangeError(`Projection chunk ${index} has inconsistent buffers`);
  }
  let previous = -1;
  for (let offset = 0; offset < chunk.positions.length; offset += 1) {
    const position = chunk.positions[offset];
    if (position >= PROJECTION_CHUNK_SIZE ** 3) {
      throw new RangeError(`Projection chunk ${index} contains invalid local position ${position}`);
    }
    if (position <= previous) {
      throw new RangeError(`Projection chunk ${index} local positions must be strictly increasing and unique`);
    }
    const paletteIndex = chunk.paletteIndices[offset];
    if (!Number.isInteger(paletteIndex) || paletteIndex < 0 || paletteIndex >= paletteSize) {
      throw new RangeError(`Projection chunk ${index} contains unknown palette index ${paletteIndex}`);
    }
    previous = position;
  }
};

const sourceFingerprint = (document: ProjectionDocument) => JSON.stringify([
  document.blockCount,
  document.chunks.length,
  document.bounds,
  document.palette,
  document.chunks.map((chunk) => [chunk.chunk, chunk.positions.length]),
]);

const assertIndexMatchesDocument = (document: ProjectionDocument, index: ProjectionPartitionIndex) => {
  if (!index || typeof index !== "object" || indexDocuments.get(index as object) !== document) {
    throw new RangeError("Projection partition index is not bound to the source document");
  }
  if (index.sourceChunkCount !== document.chunks.length
    || index.blockCount !== document.blockCount
    || index.sourceFingerprint !== sourceFingerprint(document)) {
    throw new RangeError("Projection partition index does not match the source document");
  }
  if (index.views.length !== index.candidateChunkIndices.length) {
    throw new RangeError("Projection partition index has inconsistent view candidates");
  }
  const sourceBuffers = indexSourceBuffers.get(index as object);
  if (!sourceBuffers || sourceBuffers.length !== document.chunks.length) {
    throw new RangeError("Projection partition index has no valid source buffer binding");
  }
  sourceBuffers.forEach((buffers, chunkIndex) => {
    const chunk = document.chunks[chunkIndex];
    if (buffers.positions !== chunk.positions || buffers.paletteIndices !== chunk.paletteIndices) {
      throw new RangeError("Projection partition index source buffers have changed");
    }
  });
  if (index.views.length > 0 && !document.bounds) {
    throw new RangeError("Projection partition index requires non-empty document bounds");
  }
  const ordinals = indexViewOrdinals.get(index as object);
  if (!ordinals || ordinals.size !== index.views.length) {
    throw new RangeError("Projection partition index has no valid view map");
  }
  index.views.forEach((view, ordinal) => {
    if (ordinals.get(pointKey(view.index)) !== ordinal) {
      throw new RangeError("Projection partition index contains an invalid view map");
    }
    const candidates = index.candidateChunkIndices[ordinal];
    let previous = -1;
    for (const chunkIndex of candidates) {
      if (!Number.isSafeInteger(chunkIndex)
        || chunkIndex < 0
        || chunkIndex >= document.chunks.length
        || chunkIndex <= previous) {
        throw new RangeError("Projection partition index contains an invalid source chunk reference");
      }
      previous = chunkIndex;
    }
  });
};

/** Validate an externally supplied index before using it in a bundle plan. */
export const assertProjectionPartitionIndex = (
  document: ProjectionDocument,
  index: ProjectionPartitionIndex,
  partSize?: number | Point,
) => {
  assertIndexMatchesDocument(document, index);
  if (partSize !== undefined) {
    const expected = normalizePartSize(partSize);
    if (!samePoint(index.partSize, expected)) {
      throw new RangeError("Projection partition index uses a different partition size");
    }
  }
  return index;
};

export const createProjectionPartitionIndex = (
  document: ProjectionDocument,
  partSize: number | Point = [32, 32, 32],
): ProjectionPartitionIndex => {
  const normalizedSize = normalizePartSize(partSize);
  if ((document.blockCount === 0) !== (document.bounds === null)) {
    throw new RangeError("Projection document bounds and blockCount are inconsistent");
  }
  if (!Number.isSafeInteger(document.blockCount) || document.blockCount < 0) {
    throw new RangeError("Projection document blockCount must be a non-negative safe integer");
  }
  if (!document.bounds || document.blockCount === 0) {
    for (let chunkIndex = 0; chunkIndex < document.chunks.length; chunkIndex += 1) {
      const chunk = document.chunks[chunkIndex];
      assertChunk(chunk, chunkIndex, document.palette.length);
      if (chunk.positions.length > 0) {
        throw new RangeError("Projection document blockCount is zero but chunks contain blocks");
      }
    }
    if (document.blockCount !== 0 || document.bounds !== null) {
      throw new RangeError("Projection document bounds and blockCount are inconsistent");
    }
    const emptyIndex = Object.freeze({
      partSize: Object.freeze(normalizedSize) as unknown as Point,
      views: Object.freeze([]),
      sourceChunkCount: document.chunks.length,
      blockCount: document.blockCount,
      candidateChunkIndices: Object.freeze([]),
      scanStats: Object.freeze({
        sourceChunksVisited: document.chunks.length,
        sourceBlocksVisited: 0,
        candidateReferences: 0,
      }),
      sourceFingerprint: sourceFingerprint(document),
    });
    indexDocuments.set(emptyIndex, document);
    indexViewOrdinals.set(emptyIndex, new Map());
    indexSourceBuffers.set(emptyIndex, document.chunks.map((chunk) => ({
      positions: chunk.positions,
      paletteIndices: chunk.paletteIndices,
    })));
    return emptyIndex;
  }
  const mutableViews = new Map<string, {
    index: Point;
    occupiedMin: Point;
    occupiedMax: Point;
    blockCount: number;
  }>();
  const chunkPartitionKeys: Array<Set<string>> = [];
  let sourceBlocksVisited = 0;
  for (let chunkIndex = 0; chunkIndex < document.chunks.length; chunkIndex += 1) {
    const chunk = document.chunks[chunkIndex];
    assertChunk(chunk, chunkIndex, document.palette.length);
    const partitions = new Set<string>();
    chunkPartitionKeys.push(partitions);
    for (const localPosition of chunk.positions) {
      const position = worldPosition(chunk.chunk, localPosition);
      const partition = position.map((value, axis) =>
        floorDiv(value - document.bounds!.min[axis], normalizedSize[axis])) as Point;
      const key = pointKey(partition);
      partitions.add(key);
      let view = mutableViews.get(key);
      if (!view) {
        view = {
          index: partition,
          occupiedMin: [...position],
          occupiedMax: [...position],
          blockCount: 0,
        };
        mutableViews.set(key, view);
      }
      for (let axis = 0; axis < 3; axis += 1) {
        view.occupiedMin[axis] = Math.min(view.occupiedMin[axis], position[axis]);
        view.occupiedMax[axis] = Math.max(view.occupiedMax[axis], position[axis]);
      }
      view.blockCount += 1;
      sourceBlocksVisited += 1;
    }
  }
  if (sourceBlocksVisited !== document.blockCount) {
    throw new RangeError(
      `Projection blockCount ${document.blockCount} does not match actual ${sourceBlocksVisited}`,
    );
  }
  const boundsFromExtents = (min: Point, max: Point): ProjectionBounds => ({
    min,
    max,
    dimensions: max.map((value, axis) => value - min[axis] + 1) as Point,
  });
  const compareYzx = (left: Point, right: Point) =>
    left[1] - right[1] || left[2] - right[2] || left[0] - right[0];
  const views = [...mutableViews.values()]
    .sort((left, right) => compareYzx(left.index, right.index))
    .map((view): ProjectionView => {
      const min = view.index.map((value, axis) =>
        document.bounds!.min[axis] + value * normalizedSize[axis]) as Point;
      const max = min.map((value, axis) =>
        Math.min(document.bounds!.max[axis], value + normalizedSize[axis] - 1)) as Point;
      return {
        index: view.index,
        bounds: boundsFromExtents(min, max),
        occupiedBounds: boundsFromExtents(view.occupiedMin, view.occupiedMax),
        blockCount: view.blockCount,
      };
    }).map((view) => Object.freeze({
    ...view,
    index: Object.freeze([...view.index]) as unknown as [number, number, number],
    bounds: Object.freeze({
      ...view.bounds,
      min: Object.freeze([...view.bounds.min]) as unknown as [number, number, number],
      max: Object.freeze([...view.bounds.max]) as unknown as [number, number, number],
      dimensions: Object.freeze([...view.bounds.dimensions]) as unknown as [number, number, number],
    }),
    occupiedBounds: Object.freeze({
      ...view.occupiedBounds,
      min: Object.freeze([...view.occupiedBounds.min]) as unknown as [number, number, number],
      max: Object.freeze([...view.occupiedBounds.max]) as unknown as [number, number, number],
      dimensions: Object.freeze([...view.occupiedBounds.dimensions]) as unknown as [number, number, number],
    }),
  }));
  const viewIndices = new Map<string, number>();
  views.forEach((view, index) => viewIndices.set(pointKey(view.index), index));
  const candidateSets = views.map(() => new Set<number>());
  chunkPartitionKeys.forEach((partitions, chunkIndex) => {
    partitions.forEach((partitionKey) => {
      const candidate = viewIndices.get(partitionKey);
      if (candidate === undefined) throw new Error(`Missing projection partition ${partitionKey}`);
      candidateSets[candidate].add(chunkIndex);
    });
  });
  const candidateChunkIndices = candidateSets.map((set) => Object.freeze([...set].sort((a, b) => a - b)));
  const index = Object.freeze({
    partSize: Object.freeze(normalizedSize) as unknown as Point,
    views: Object.freeze([...views]),
    sourceChunkCount: document.chunks.length,
    blockCount: document.blockCount,
    candidateChunkIndices: Object.freeze(candidateChunkIndices),
    scanStats: Object.freeze({
      sourceChunksVisited: document.chunks.length,
      sourceBlocksVisited,
      candidateReferences: candidateChunkIndices.reduce((sum, value) => sum + value.length, 0),
    }),
    sourceFingerprint: sourceFingerprint(document),
  });
  indexDocuments.set(index, document);
  indexViewOrdinals.set(index, new Map(views.map((view, ordinal) => [pointKey(view.index), ordinal])));
  indexSourceBuffers.set(index, document.chunks.map((chunk) => ({
    positions: chunk.positions,
    paletteIndices: chunk.paletteIndices,
  })));
  return index;
};

export const iterateProjectionPartitionBlocks = function* (
  document: ProjectionDocument,
  index: ProjectionPartitionIndex,
  partition: number | ProjectionView,
): Generator<ProjectionBlock> {
  assertIndexMatchesDocument(document, index);
  const partIndex = typeof partition === "number"
    ? partition
    : projectionPartitionForView(index, partition);
  const view = index.views[partIndex];
  if (!view || partIndex < 0) throw new RangeError(`Unknown projection partition ${partIndex}`);
  for (const chunkIndex of index.candidateChunkIndices[partIndex]) {
    const chunk = document.chunks[chunkIndex];
    assertChunk(chunk, chunkIndex, document.palette.length);
    for (let offset = 0; offset < chunk.positions.length; offset += 1) {
      const position = worldPosition(chunk.chunk, chunk.positions[offset]);
      if (position.every((value, axis) => value >= view.bounds.min[axis] && value <= view.bounds.max[axis])) {
        if (chunk.paletteIndices[offset] >= 0xffff_ffff) {
          throw new RangeError(`Projection chunk ${chunkIndex} contains an invalid palette index`);
        }
        yield { position, paletteIndex: chunk.paletteIndices[offset] };
      }
    }
  }
};

export const projectionPartitionForView = (index: ProjectionPartitionIndex, view: ProjectionView) => {
  const result = indexViewOrdinals.get(index as object)?.get(pointKey(view.index));
  if (result === undefined || !sameView(index.views[result], view)) {
    throw new RangeError(`Projection view ${pointKey(view.index)} is not indexed`);
  }
  return result;
};

export const projectionPartitionIndex = createProjectionPartitionIndex;
