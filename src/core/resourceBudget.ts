import type { SolidFillMode } from "../types";

export const DEFAULT_MEMORY_BUDGET_BYTES = 5 * 1024 ** 3;
export const MAX_FILLED_VOXEL_VOLUME = 12_000_000;
export const MAX_PROJECTION_BLOCKS = 320_000;
export const MAX_HOLOGRAM_CANDIDATES = 1_280_000;

export interface ResourceEstimateInput {
  targetHeight: number;
  width: number;
  depth: number;
  triangleCount: number;
  textureBytes: number;
  fillMode: SolidFillMode;
  estimatedBlocks?: number;
  candidateCount?: number;
  interiorDensity?: number;
}

export interface ResourceEstimate {
  estimatedBytes: number;
  estimatedVoxelVolume: number;
  estimatedBlocks: number;
  estimatedCandidates: number;
  allowed: boolean;
  reason: "ok" | "memory" | "volume" | "blocks" | "candidates";
  requiresConfirmation: boolean;
  risks: Exclude<ResourceEstimate["reason"], "ok">[];
}

const finiteInteger = (value: number) => Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));

/** 与全息生成器一致：先计算自适应稀疏步长，再保留未裁剪候选数用于风险提示。 */
export const estimateSparseHologramInterior = (
  width: number,
  height: number,
  depth: number,
  density: number,
) => {
  const volume = finiteInteger(width) * finiteInteger(height) * finiteInteger(depth);
  if (volume <= 0 || density <= 0) {
    return { stride: 1, candidateCount: 0, selectedCount: 0 };
  }
  const safeInteriorBudget = Math.floor(MAX_PROJECTION_BLOCKS * 0.7);
  const stride = Math.max(1, Math.ceil(Math.cbrt(volume / safeInteriorBudget)));
  const sampledWidth = Math.ceil(finiteInteger(width) / stride);
  const sampledHeight = Math.ceil(finiteInteger(height) / stride);
  const sampledDepth = Math.ceil(finiteInteger(depth) / stride);
  const candidateCount = sampledWidth * sampledHeight * sampledDepth;
  return {
    stride,
    candidateCount,
    selectedCount: Math.round(candidateCount * Math.max(0, Math.min(100, density)) / 100),
  };
};

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
  const baseBlocks = input.fillMode === "filled"
    ? Math.max(surfaceEstimate, Math.round(volume * 0.42))
    : surfaceEstimate;
  const density = Math.max(0, Math.min(100, input.interiorDensity ?? 0));
  const hologramBudgeted = input.interiorDensity !== undefined || input.candidateCount !== undefined;
  const interior = input.fillMode === "shell"
    ? estimateSparseHologramInterior(width, height, depth, density)
    : { candidateCount: 0, selectedCount: 0 };
  const contourCandidates = baseBlocks;
  // 建议阈值只用于风险提示；估算必须保留真实数量，否则会漏掉超限确认。
  const estimatedBlocks = hologramBudgeted && input.candidateCount === undefined
    ? contourCandidates + interior.selectedCount
    : baseBlocks + interior.selectedCount;
  const candidateCount = finiteInteger(input.candidateCount ?? (
    input.fillMode === "shell" ? contourCandidates + interior.candidateCount : baseBlocks
  ));

  const typedVolumeBytes = input.fillMode === "filled" ? volume * 10 : 0;
  const surfaceObjectBytes = estimatedBlocks * (input.fillMode === "filled" ? 44 : 68);
  const candidateObjectBytes = hologramBudgeted ? candidateCount * 68 : 0;
  const outputBytes = estimatedBlocks * 16;
  const triangleBytes = finiteInteger(input.triangleCount) * 56;
  const textureBytes = finiteInteger(input.textureBytes) * 2;
  const estimatedBytes = typedVolumeBytes
    + surfaceObjectBytes
    + candidateObjectBytes
    + outputBytes
    + triangleBytes
    + textureBytes
    + 128 * 1024 ** 2;
  const exceedsAddressableVolume = input.fillMode === "filled" && volume > MAX_FILLED_VOXEL_VOLUME;
  const exceedsBlocks = hologramBudgeted && estimatedBlocks > MAX_PROJECTION_BLOCKS;
  const exceedsCandidates = hologramBudgeted && candidateCount > MAX_HOLOGRAM_CANDIDATES;
  const risks: ResourceEstimate["risks"] = [];
  if (exceedsAddressableVolume) risks.push("volume");
  if (exceedsBlocks) risks.push("blocks");
  if (exceedsCandidates) risks.push("candidates");
  if (estimatedBytes > memoryBudgetBytes) risks.push("memory");
  const reason = risks[0] ?? "ok";
  return {
    estimatedBytes,
    estimatedVoxelVolume: volume,
    estimatedBlocks,
    estimatedCandidates: candidateCount,
    // 超预算只触发用户风险确认，不得替代用户拒绝可执行任务。
    allowed: true,
    reason,
    requiresConfirmation: risks.length > 0,
    risks,
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
