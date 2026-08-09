/// <reference lib="webworker" />

import { generateHologram, generateMeshHologram } from "../core/hologram";
import { generateSolidVoxels } from "../core/solidVoxelizer";
import { errorDescriptor } from "../core/appError";
import type { MmdMeshSnapshot, WorkerCommand, WorkerEvent, WorkerStage } from "../types";

const send = (event: WorkerEvent, transfer: Transferable[] = []) => {
  self.postMessage(event, { transfer });
};

const releaseInputMesh = (mesh: MmdMeshSnapshot) => {
  mesh.positions = new Float32Array(0);
  mesh.indices = new Uint32Array(0);
  mesh.triangleMaterials = new Uint16Array(0);
  mesh.uvs = undefined;
  mesh.materials = undefined;
  mesh.textures?.forEach((texture) => {
    texture.pixels = new Uint8ClampedArray(0);
  });
  mesh.textures = undefined;
  mesh.faceFrame = undefined;
};

self.onmessage = (message: MessageEvent<WorkerCommand>) => {
  const command = message.data;
  const sourceMesh = command.source.kind === "mesh" ? command.source.mesh : undefined;

  try {
    const progress = (stage: WorkerStage, value: number) => {
      send({ type: "PROGRESS", jobId: command.jobId, stage, progress: value });
    };
    let result;
    if (command.type === "GENERATE_SOLID") {
      result = generateSolidVoxels(command.source.mesh, command.options, progress);
    } else if (command.source.kind === "mesh") {
      result = generateMeshHologram(command.source.mesh, command.options, progress);
    } else {
      progress("tracing", 0.18);
      progress("sampling", 0.55);
      result = generateHologram(command.options);
      progress("isolation", 0.82);
    }
    send({ type: "PROGRESS", jobId: command.jobId, stage: "complete", progress: 1 });
    send(
      { type: "RESULT", jobId: command.jobId, result },
      result.kind === "solid"
        ? [result.positions.buffer, result.blockIndices.buffer]
        : [result.positions.buffer, result.facings.buffer, result.materials.buffer],
    );
  } catch (error) {
    const descriptor = errorDescriptor(error);
    send({
      type: "ERROR",
      jobId: command.jobId,
      code: descriptor.code === "error.unknown" ? "error.worker.unknown" : descriptor.code,
      params: descriptor.params,
    });
  } finally {
    if (sourceMesh) releaseInputMesh(sourceMesh);
  }
};

export {};
