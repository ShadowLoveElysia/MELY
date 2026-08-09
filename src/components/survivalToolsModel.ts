import type { ProjectionAxis, ProjectionDocument } from "../types";
import {
  createLayerGuideProgress,
  deserializeLayerGuideProgress,
  type LayerGuideIndexedSource,
  type LayerGuideProgress,
} from "../core/layerGuide";
import { createMaterialPlan } from "../core/materialPlanner";
import { PROJECTION_CHUNK_SIZE } from "../core/projectionDocument";
import {
  materialInputsFromProjection,
  type ProjectionPlanningOptions,
} from "../core/projectionPlanning";

const HASH_SEED_A = 0x811c9dc5;
const HASH_SEED_B = 0x9e3779b9;
const HASH_PRIME = 0x01000193;
const PROGRESS_KEY_PREFIX = "mely:survival-guide:v1";
const LOCAL_POSITION_CAPACITY = PROJECTION_CHUNK_SIZE ** 3;
const MAX_PACKED_CHUNKS = 2 ** (32 - Math.log2(LOCAL_POSITION_CAPACITY));

interface ProjectionLayerAxisIndex {
  occupied: Int32Array;
  starts: Uint32Array;
  references: Uint32Array | Float64Array;
}

interface MutableProjectionLayerIndexStats {
  indexBuilds: number;
  indexedBlockVisits: number;
  sliceCalls: number;
  sliceBlockVisits: number;
  estimatedIndexBytes: number;
}

export interface ProjectionLayerIndexStats extends MutableProjectionLayerIndexStats {
  indexedAxes: ProjectionAxis[];
}

export type ProjectionLayerGuideSource = LayerGuideIndexedSource<ProjectionDocument["palette"][number]>;

const projectionLayerStats = new WeakMap<ProjectionLayerGuideSource, {
  mutable: MutableProjectionLayerIndexStats;
  caches: Partial<Record<ProjectionAxis, ProjectionLayerAxisIndex>>;
}>();

const axisIndex = (axis: ProjectionAxis) => axis === "x" ? 0 : axis === "y" ? 1 : 2;

const localCoordinate = (encoded: number, axis: ProjectionAxis) => {
  const x = encoded % PROJECTION_CHUNK_SIZE;
  const yz = Math.floor(encoded / PROJECTION_CHUNK_SIZE);
  const z = yz % PROJECTION_CHUNK_SIZE;
  const y = Math.floor(yz / PROJECTION_CHUNK_SIZE);
  return axis === "x" ? x : axis === "y" ? y : z;
};

const decodeLocalPosition = (encoded: number): [number, number, number] => {
  const x = encoded % PROJECTION_CHUNK_SIZE;
  const yz = Math.floor(encoded / PROJECTION_CHUNK_SIZE);
  return [x, Math.floor(yz / PROJECTION_CHUNK_SIZE), yz % PROJECTION_CHUNK_SIZE];
};

const assertLocalPosition = (encoded: number) => {
  if (!Number.isSafeInteger(encoded) || encoded < 0 || encoded >= LOCAL_POSITION_CAPACITY) {
    throw new RangeError(`Invalid projection chunk local position: ${encoded}`);
  }
};

const assertProjectionCoordinate = (coordinate: number) => {
  if (!Number.isSafeInteger(coordinate)
    || coordinate < -0x8000_0000
    || coordinate > 0x7fff_ffff) {
    throw new RangeError("Layer guide coordinates must fit signed 32-bit storage");
  }
};

const updateHashByte = (hash: number, value: number) =>
  Math.imul(hash ^ (value & 0xff), HASH_PRIME) >>> 0;

const updateHashNumber = (hash: number, value: number) => {
  let next = hash;
  const normalized = value >>> 0;
  next = updateHashByte(next, normalized);
  next = updateHashByte(next, normalized >>> 8);
  next = updateHashByte(next, normalized >>> 16);
  return updateHashByte(next, normalized >>> 24);
};

const updateHashString = (hash: number, value: string) => {
  let next = hash;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    next = updateHashByte(next, code);
    next = updateHashByte(next, code >>> 8);
  }
  return updateHashByte(next, 0xff);
};

const canonicalState = (document: ProjectionDocument, paletteIndex: number) => {
  const state = document.palette[paletteIndex];
  if (!state) throw new RangeError(`Unknown projection palette index: ${paletteIndex}`);
  const properties = Object.entries(state.properties ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  return `${state.blockId}[${properties}]|${state.color?.join(",") ?? ""}|${state.emissive ?? ""}`;
};

export const createProjectionFingerprint = (document: ProjectionDocument) => {
  let first = updateHashString(HASH_SEED_A, document.edition);
  let second = updateHashString(HASH_SEED_B, document.minecraftVersion);
  first = updateHashNumber(first, document.version);
  second = updateHashNumber(second, document.blockCount);

  document.palette.forEach((_, paletteIndex) => {
    const state = canonicalState(document, paletteIndex);
    first = updateHashString(first, state);
    second = updateHashString(second, state);
  });

  const chunks = [...document.chunks].sort((left, right) =>
    left.chunk[1] - right.chunk[1]
    || left.chunk[2] - right.chunk[2]
    || left.chunk[0] - right.chunk[0]);
  for (const chunk of chunks) {
    chunk.chunk.forEach((coordinate) => {
      first = updateHashNumber(first, coordinate);
      second = updateHashNumber(second, coordinate ^ 0x5bd1e995);
    });
    if (chunk.positions.length !== chunk.paletteIndices.length) {
      throw new RangeError("Projection chunk has inconsistent buffers");
    }
    for (let index = 0; index < chunk.positions.length; index += 1) {
      first = updateHashNumber(first, chunk.positions[index]);
      first = updateHashNumber(first, chunk.paletteIndices[index]);
      second = updateHashNumber(second, chunk.paletteIndices[index]);
      second = updateHashNumber(second, chunk.positions[index]);
    }
  }

  return `${document.version}-${document.blockCount.toString(36)}-${first.toString(36)}-${second.toString(36)}`;
};

export const createProjectionLayerInput = (
  document: ProjectionDocument,
): ProjectionLayerGuideSource => {
  if (!Number.isSafeInteger(document.blockCount)
    || document.blockCount < 0
    || document.blockCount > 0xffff_ffff) {
    throw new RangeError("Projection block count must fit unsigned 32-bit layer indexes");
  }
  let countedBlocks = 0;
  document.chunks.forEach((chunk) => {
    if (chunk.positions.length !== chunk.paletteIndices.length) {
      throw new RangeError(`Projection chunk ${chunk.chunk.join(",")} has inconsistent buffers`);
    }
    if (chunk.positions.length > LOCAL_POSITION_CAPACITY) {
      throw new RangeError(`Projection chunk ${chunk.chunk.join(",")} exceeds its block capacity`);
    }
    countedBlocks += chunk.positions.length;
  });
  if (countedBlocks !== document.blockCount) {
    throw new RangeError("Projection block count does not match its chunk data");
  }

  const caches: Partial<Record<ProjectionAxis, ProjectionLayerAxisIndex>> = {};
  const mutable: MutableProjectionLayerIndexStats = {
    indexBuilds: 0,
    indexedBlockVisits: 0,
    sliceCalls: 0,
    sliceBlockVisits: 0,
    estimatedIndexBytes: 0,
  };
  let validatedBlocks = false;

  const buildAxis = (axis: ProjectionAxis) => {
    const cached = caches[axis];
    if (cached) return cached;
    const fixedAxis = axisIndex(axis);
    const counts = new Map<number, number>();
    for (const chunk of document.chunks) {
      const chunkBase = chunk.chunk[fixedAxis] * PROJECTION_CHUNK_SIZE;
      for (let blockIndex = 0; blockIndex < chunk.positions.length; blockIndex += 1) {
        const encoded = chunk.positions[blockIndex];
        if (!validatedBlocks) {
          assertLocalPosition(encoded);
          const paletteIndex = chunk.paletteIndices[blockIndex];
          if (!Number.isSafeInteger(paletteIndex)
            || paletteIndex < 0
            || paletteIndex >= document.palette.length) {
            throw new RangeError(`Unknown projection palette index: ${paletteIndex}`);
          }
        }
        const coordinate = chunkBase + localCoordinate(encoded, axis);
        assertProjectionCoordinate(coordinate);
        counts.set(coordinate, (counts.get(coordinate) ?? 0) + 1);
        mutable.indexedBlockVisits += 1;
      }
    }
    validatedBlocks = true;
    const occupiedValues = [...counts.keys()].sort((left, right) => left - right);
    const occupied = Int32Array.from(occupiedValues);
    const layerByCoordinate = new Map(occupiedValues.map((coordinate, index) => [coordinate, index]));
    const starts = new Uint32Array(occupied.length + 1);
    for (let index = 0; index < occupied.length; index += 1) {
      starts[index + 1] = starts[index] + (counts.get(occupied[index]) ?? 0);
    }
    const usePacked32 = document.chunks.length <= MAX_PACKED_CHUNKS;
    const references = usePacked32
      ? new Uint32Array(document.blockCount)
      : new Float64Array(document.blockCount);
    const cursors = starts.slice(0, occupied.length);
    document.chunks.forEach((chunk, chunkIndex) => {
      const chunkBase = chunk.chunk[fixedAxis] * PROJECTION_CHUNK_SIZE;
      for (let blockIndex = 0; blockIndex < chunk.positions.length; blockIndex += 1) {
        const coordinate = chunkBase + localCoordinate(chunk.positions[blockIndex], axis);
        const layerIndex = layerByCoordinate.get(coordinate);
        if (layerIndex === undefined) throw new Error("Projection layer index lost an occupied coordinate");
        const reference = chunkIndex * LOCAL_POSITION_CAPACITY + blockIndex;
        references[cursors[layerIndex]++] = reference;
        mutable.indexedBlockVisits += 1;
      }
    });
    const index = { occupied, starts, references };
    caches[axis] = index;
    mutable.indexBuilds += 1;
    mutable.estimatedIndexBytes += occupied.byteLength + starts.byteLength + references.byteLength;
    return index;
  };

  const source: ProjectionLayerGuideSource = {
    kind: "indexed",
    palette: document.palette,
    occupiedCoordinates: (axis) => buildAxis(axis).occupied,
    visitLayer: (axis, coordinate, visitor) => {
      mutable.sliceCalls += 1;
      const index = buildAxis(axis);
      let low = 0;
      let high = index.occupied.length;
      while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        if (index.occupied[middle] < coordinate) low = middle + 1;
        else high = middle;
      }
      if (index.occupied[low] !== coordinate) return;
      const start = index.starts[low];
      const end = index.starts[low + 1];
      mutable.sliceBlockVisits += end - start;
      for (let referenceIndex = start; referenceIndex < end; referenceIndex += 1) {
        const reference = index.references[referenceIndex];
        const chunkIndex = Math.floor(reference / LOCAL_POSITION_CAPACITY);
        const blockIndex = reference - chunkIndex * LOCAL_POSITION_CAPACITY;
        const chunk = document.chunks[chunkIndex];
        const local = decodeLocalPosition(chunk.positions[blockIndex]);
        visitor({
          position: [
            chunk.chunk[0] * PROJECTION_CHUNK_SIZE + local[0],
            chunk.chunk[1] * PROJECTION_CHUNK_SIZE + local[1],
            chunk.chunk[2] * PROJECTION_CHUNK_SIZE + local[2],
          ],
          paletteIndex: chunk.paletteIndices[blockIndex],
          sourceIndex: reference,
        });
      }
    },
  };
  projectionLayerStats.set(source, { mutable, caches });
  return source;
};

export const getProjectionLayerIndexStats = (
  source: ProjectionLayerGuideSource,
): ProjectionLayerIndexStats => {
  const state = projectionLayerStats.get(source);
  if (!state) throw new TypeError("Unknown projection layer guide source");
  return {
    ...state.mutable,
    indexedAxes: (Object.keys(state.caches) as ProjectionAxis[]).sort(),
  };
};

export const createProjectionMaterialPlan = (
  document: ProjectionDocument,
  options: ProjectionPlanningOptions = {},
) => createMaterialPlan(materialInputsFromProjection(document, options));

export const layerProgressStorageKey = (
  fingerprint: string,
  axis: ProjectionAxis,
) => `${PROGRESS_KEY_PREFIX}:${fingerprint}:${axis}`;

export const loadLayerProgress = (
  storage: Pick<Storage, "getItem"> | null,
  fingerprint: string,
  axis: ProjectionAxis,
): LayerGuideProgress => {
  if (!storage) return createLayerGuideProgress(axis);
  try {
    const serialized = storage.getItem(layerProgressStorageKey(fingerprint, axis));
    if (!serialized) return createLayerGuideProgress(axis);
    const progress = deserializeLayerGuideProgress(serialized);
    return progress.axis === axis ? progress : createLayerGuideProgress(axis);
  } catch {
    return createLayerGuideProgress(axis);
  }
};
