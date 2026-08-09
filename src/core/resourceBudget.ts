import type { SolidFillMode } from "../types";

export const DEFAULT_MEMORY_BUDGET_BYTES = 2 * 1024 ** 3;
export const MAX_FILLED_VOXEL_VOLUME = 12_000_000;

export interface ResourceEstimateInput {
  targetHeight: number;
  width: number;
  depth: number;
  triangleCount: number;
  textureBytes: number;
  fillMode: SolidFillMode;
  estimatedBlocks?: number;
}

export interface ResourceEstimate {
  estimatedBytes: number;
  estimatedVoxelVolume: number;
  estimatedBlocks: number;
  allowed: boolean;
  reason: "ok" | "memory" | "volume";
}

const finiteInteger = (value: number) => Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));

export const estimateVoxelizationResources = (
  input: ResourceEstimateInput,
  memoryBudgetBytes = DEFAULT_MEMORY_BUDGET_BYTES,
): ResourceEstimate => {
  const height = finiteInteger(input.targetHeight);
  const width = finiteInteger(input.width);
  const depth = finiteInteger(input.depth);
  const volume = width * height * depth;
  const surfaceEstimate = input.estimatedBlocks === undefined
    ? Math.max(0, Math.round(2 * (width * height + width * depth + height * depth) * 0.58))
    : finiteInteger(input.estimatedBlocks);
  const estimatedBlocks = input.fillMode === "filled"
    ? Math.max(surfaceEstimate, Math.round(volume * 0.42))
    : surfaceEstimate;

  const typedVolumeBytes = input.fillMode === "filled" ? volume * 10 : 0;
  const surfaceObjectBytes = estimatedBlocks * (input.fillMode === "filled" ? 44 : 68);
  const outputBytes = estimatedBlocks * 16;
  const triangleBytes = finiteInteger(input.triangleCount) * 56;
  const textureBytes = finiteInteger(input.textureBytes) * 2;
  const estimatedBytes = typedVolumeBytes
    + surfaceObjectBytes
    + outputBytes
    + triangleBytes
    + textureBytes
    + 128 * 1024 ** 2;
  const exceedsAddressableVolume = input.fillMode === "filled" && volume > MAX_FILLED_VOXEL_VOLUME;
  return {
    estimatedBytes,
    estimatedVoxelVolume: volume,
    estimatedBlocks,
    allowed: estimatedBytes <= memoryBudgetBytes && !exceedsAddressableVolume,
    reason: exceedsAddressableVolume ? "volume" : estimatedBytes > memoryBudgetBytes ? "memory" : "ok",
  };
};

export interface MmdRuntimeMemoryInput {
  vertexCount: number;
  indexCount: number;
  morphCount: number;
  splitVertexCount: number;
  splitMorphCount: number;
  textureBytes: number;
  outlineProxyCount?: number;
}

export interface MmdRuntimeMemoryEstimate {
  denseMorphBytes: number;
  splitMorphBytes: number;
  geometryBytes: number;
  textureBytes: number;
  estimatedBytes: number;
  savedBytes: number;
}

export const estimateMmdRuntimeMemory = (
  input: MmdRuntimeMemoryInput,
): MmdRuntimeMemoryEstimate => {
  const vertexCount = finiteInteger(input.vertexCount);
  const indexCount = finiteInteger(input.indexCount);
  const morphCount = finiteInteger(input.morphCount);
  const splitVertexCount = finiteInteger(input.splitVertexCount);
  const splitMorphCount = finiteInteger(input.splitMorphCount);
  const textureBytes = finiteInteger(input.textureBytes);
  const proxyCount = finiteInteger(input.outlineProxyCount ?? 0);
  const baseVertexBytes = vertexCount * (3 + 3 + 2 + 4 + 4) * 4;
  const baseIndexBytes = indexCount * (vertexCount > 0xffff ? 4 : 2);
  const denseMorphBytes = vertexCount * morphCount * 3 * 4;
  const splitGeometryBytes = splitVertexCount * (3 + 3 + 2 + 4 + 4) * 4;
  const splitMorphBytes = splitVertexCount * splitMorphCount * 3 * 4;
  const geometryBytes = baseVertexBytes + baseIndexBytes + splitGeometryBytes;
  const proxyBytes = proxyCount * 2048;
  const estimatedBytes = geometryBytes + splitMorphBytes + textureBytes + proxyBytes;
  return {
    denseMorphBytes,
    splitMorphBytes,
    geometryBytes,
    textureBytes,
    estimatedBytes,
    savedBytes: Math.max(0, denseMorphBytes - splitMorphBytes),
  };
};

export const formatBinaryBytes = (bytes: number) => {
  const value = Math.max(0, bytes);
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GiB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(0)} MiB`;
  if (value >= 1024) return `${(value / 1024).toFixed(0)} KiB`;
  return `${Math.round(value)} B`;
};
