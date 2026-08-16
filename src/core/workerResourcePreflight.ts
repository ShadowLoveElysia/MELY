import type { MmdMeshSnapshot, WorkerCommand } from "../types";
import {
  estimateVoxelizationResources,
  type ResourceEstimate,
} from "./resourceBudget";
import {
  getJavaVersionProfile,
  type JavaVersionProfile,
} from "./minecraftVersions";

export type WorkerResourcePreflightResult = ResourceEstimate & {
  width: number;
  height: number;
  depth: number;
  triangleCount: number;
  textureBytes: number;
};

const positiveTargetHeight = (value: number) => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("Worker target height must be a positive safe integer");
  }
  return value;
};

const checkedByteLength = (current: number, value: ArrayBufferView) => {
  const next = current + value.byteLength;
  if (!Number.isSafeInteger(next)) throw new RangeError("Worker texture bytes exceed safe arithmetic");
  return next;
};

const snapshotDimensions = (
  mesh: MmdMeshSnapshot,
  targetHeight: number,
): [number, number, number] => {
  if (mesh.positions.length === 0 || mesh.positions.length % 3 !== 0) {
    throw new RangeError("Worker mesh positions are invalid");
  }
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < mesh.positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = mesh.positions[index + axis];
      if (!Number.isFinite(value)) throw new RangeError("Worker mesh contains a non-finite vertex");
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    }
  }
  const sourceHeight = max[1] - min[1];
  if (!(sourceHeight > 1e-6)) throw new RangeError("Worker mesh height is too small");
  const scale = Math.max(1, targetHeight - 1) / sourceHeight;
  return [
    Math.max(1, Math.ceil((max[0] - min[0]) * scale) + 1),
    targetHeight,
    Math.max(1, Math.ceil((max[2] - min[2]) * scale) + 1),
  ];
};

const estimatedSurfaceBlocks = ([width, height, depth]: readonly number[]) => Math.max(
  1,
  Math.round(2 * (width * height + width * depth + height * depth) * 0.58),
);

const estimatedHologramBlocks = (
  dimensions: readonly number[],
  sampleSpacing: number,
) => Math.max(
  1,
  Math.round(estimatedSurfaceBlocks(dimensions) * 0.2 / Math.max(1, sampleSpacing) ** 2),
);

/** Worker 必须从转移后的快照重新测量，不能信任 UI 的宽深、三角形或纹理估算。 */
export const preflightWorkerResources = (
  command: WorkerCommand,
): WorkerResourcePreflightResult => {
  const height = positiveTargetHeight(command.options.targetHeight);
  const mesh = command.source.kind === "mesh" ? command.source.mesh : null;
  const dimensions = mesh
    ? snapshotDimensions(mesh, height)
    : [
        Math.max(1, Math.ceil(height * 0.45)),
        height,
        Math.max(1, Math.ceil(height * 0.3)),
      ] as [number, number, number];
  const triangleCount = mesh ? mesh.indices.length / 3 : 0;
  if (!Number.isSafeInteger(triangleCount)) throw new RangeError("Worker triangle data is invalid");
  const textureBytes = mesh?.textures?.reduce(
    (total, texture) => checkedByteLength(total, texture.pixels),
    0,
  ) ?? 0;
  const hologram = command.type === "GENERATE_HOLOGRAM";
  const fillMode = hologram ? "shell" : command.options.fillMode;
  const surfaceBlocks = estimatedSurfaceBlocks(dimensions);
  const estimatedBlocks = hologram
    ? estimatedHologramBlocks(dimensions, command.options.sampleSpacing)
    : fillMode === "filled"
      ? Math.max(surfaceBlocks, Math.round(dimensions[0] * height * dimensions[2] * 0.42))
      : surfaceBlocks;
  const estimate = estimateVoxelizationResources({
    targetHeight: height,
    width: dimensions[0],
    depth: dimensions[2],
    triangleCount,
    textureBytes: hologram ? 0 : textureBytes,
    fillMode,
    estimatedBlocks,
    ...(hologram ? { interiorDensity: command.options.interiorDensity ?? 0 } : {}),
  });
  return {
    ...estimate,
    width: dimensions[0],
    height,
    depth: dimensions[2],
    triangleCount,
    textureBytes: hologram ? 0 : textureBytes,
  };
};

/**
 * 生成阶段只校验版本标识是否登记。Profile 的测试状态和导出适配器能力
 * 只用于风险提示，不能阻止生成与预览；具体格式兼容性由最终序列化器处理。
 */
export const assertWorkerMaterialCapabilities = (
  command: WorkerCommand,
  profileOverride?: JavaVersionProfile,
) => {
  if (command.type !== "GENERATE_HOLOGRAM") return;
  const registeredProfile = getJavaVersionProfile(command.versionId ?? "");
  if (!registeredProfile) {
    throw new RangeError(`JAVA_VERSION_PROFILE_UNKNOWN: ${command.versionId ?? ""}`);
  }
  if (profileOverride && profileOverride.id !== registeredProfile.id) {
    throw new RangeError(
      `JAVA_VERSION_PROFILE_MISMATCH: ${profileOverride.id} does not match ${registeredProfile.id}`,
    );
  }
};

export const assertWorkerResources = (command: WorkerCommand): WorkerResourcePreflightResult => {
  assertWorkerMaterialCapabilities(command);
  const result = preflightWorkerResources(command);
  if (!result.allowed) {
    throw new RangeError(`WORKER_RESOURCE_${result.reason.toUpperCase()}`);
  }
  return result;
};
