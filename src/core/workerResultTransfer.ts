import type { ProjectionResult } from "../types";

export const projectionResultTransferables = (result: ProjectionResult): Transferable[] => {
  if (result.kind !== "solid") {
    return [result.positions.buffer, result.facings.buffer, result.materials.buffer] as Transferable[];
  }
  const buffers: Transferable[] = [
    result.positions.buffer as ArrayBuffer,
    result.blockIndices.buffer as ArrayBuffer,
  ];
  for (const chunk of result.chunks ?? []) {
    buffers.push(
      chunk.positions.buffer as ArrayBuffer,
      chunk.blockIndices.buffer as ArrayBuffer,
    );
  }
  return buffers;
};
