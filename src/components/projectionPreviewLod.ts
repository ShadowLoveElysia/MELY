import type { SolidVoxelResult } from "../types";

export const MAX_PROJECTION_PREVIEW_INSTANCES = 200_000;
const SOLID_CHUNK_SIZE = 32;

export interface ProjectionPreviewSamplePlan {
  sourcePointCount: number;
  samplePointCount: number;
  estimatedInstanceCount: number;
  lod: boolean;
  sourceIndexAt: (sampleIndex: number) => number;
}

export interface SolidPreviewPoint {
  x: number;
  y: number;
  z: number;
  paletteIndex: number;
}

export interface SolidPreviewSource {
  pointCount: number;
  pointAt: (sourceIndex: number, target: SolidPreviewPoint) => SolidPreviewPoint;
}

const nonNegativeSafeInteger = (value: number) => (
  Number.isSafeInteger(value) && value > 0 ? value : 0
);

/**
 * 仅为 GPU 预览生成等距采样计划。计划不持有坐标副本，也不改写导出所用的全量结果。
 */
export const createProjectionPreviewSamplePlan = (
  sourcePointCount: number,
  instancesPerPoint = 1,
  instanceLimit = MAX_PROJECTION_PREVIEW_INSTANCES,
): ProjectionPreviewSamplePlan => {
  const normalizedSourceCount = nonNegativeSafeInteger(sourcePointCount);
  const normalizedInstancesPerPoint = nonNegativeSafeInteger(instancesPerPoint);
  const normalizedInstanceLimit = nonNegativeSafeInteger(instanceLimit);
  const maximumSamplePoints = normalizedInstancesPerPoint > 0
    ? Math.floor(normalizedInstanceLimit / normalizedInstancesPerPoint)
    : 0;
  const samplePointCount = Math.min(normalizedSourceCount, maximumSamplePoints);
  const intervalCount = Math.max(1, samplePointCount - 1);
  const sourceIntervalCount = Math.max(0, normalizedSourceCount - 1);
  const baseStep = Math.floor(sourceIntervalCount / intervalCount);
  const distributedRemainder = sourceIntervalCount % intervalCount;

  return {
    sourcePointCount: normalizedSourceCount,
    samplePointCount,
    estimatedInstanceCount: samplePointCount * normalizedInstancesPerPoint,
    lod: samplePointCount < normalizedSourceCount,
    sourceIndexAt: (sampleIndex) => {
      if (
        !Number.isSafeInteger(sampleIndex)
        || sampleIndex < 0
        || sampleIndex >= samplePointCount
      ) {
        throw new RangeError("Projection preview sample index is out of range");
      }
      if (samplePointCount === 1) return 0;
      return sampleIndex * baseStep
        + Math.floor(sampleIndex * distributedRemainder / intervalCount);
    },
  };
};

const assertSourceIndex = (sourceIndex: number, pointCount: number) => {
  if (!Number.isSafeInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= pointCount) {
    throw new RangeError("Solid preview source index is out of range");
  }
};

const findChunkIndex = (chunkStarts: Float64Array, sourceIndex: number) => {
  let low = 0;
  let high = chunkStarts.length - 1;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (chunkStarts[middle] <= sourceIndex) low = middle;
    else high = middle;
  }
  return low;
};

/** 将 flat/chunked 实体结果统一为按全局索引读取的零展开预览源。 */
export const createSolidPreviewSource = (result: SolidVoxelResult): SolidPreviewSource => {
  const chunks = result.storage === "chunked" ? result.chunks ?? [] : [];
  if (result.storage !== "chunked") {
    const pointCount = Math.min(
      result.blockIndices.length,
      Math.floor(result.positions.length / 3),
    );
    return {
      pointCount,
      pointAt: (sourceIndex, target) => {
        assertSourceIndex(sourceIndex, pointCount);
        const offset = sourceIndex * 3;
        target.x = result.positions[offset];
        target.y = result.positions[offset + 1];
        target.z = result.positions[offset + 2];
        target.paletteIndex = result.blockIndices[sourceIndex];
        return target;
      },
    };
  }

  const chunkStarts = new Float64Array(chunks.length + 1);
  for (let index = 0; index < chunks.length; index += 1) {
    chunkStarts[index + 1] = chunkStarts[index] + Math.min(
      chunks[index].positions.length,
      chunks[index].blockIndices.length,
    );
  }
  const pointCount = chunkStarts[chunks.length];
  return {
    pointCount,
    pointAt: (sourceIndex, target) => {
      assertSourceIndex(sourceIndex, pointCount);
      const chunkIndex = findChunkIndex(chunkStarts, sourceIndex);
      const chunk = chunks[chunkIndex];
      const localOffset = sourceIndex - chunkStarts[chunkIndex];
      const localIndex = chunk.positions[localOffset];
      const localX = localIndex % SOLID_CHUNK_SIZE;
      const packedZY = Math.floor(localIndex / SOLID_CHUNK_SIZE);
      const localZ = packedZY % SOLID_CHUNK_SIZE;
      const localY = Math.floor(packedZY / SOLID_CHUNK_SIZE);
      target.x = chunk.chunk[0] * SOLID_CHUNK_SIZE + localX;
      target.y = chunk.chunk[1] * SOLID_CHUNK_SIZE + localY;
      target.z = chunk.chunk[2] * SOLID_CHUNK_SIZE + localZ;
      target.paletteIndex = chunk.blockIndices[localOffset];
      return target;
    },
  };
};
