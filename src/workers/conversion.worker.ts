/// <reference lib="webworker" />

import { generateHologram, generateMeshHologram } from "../core/hologram";
import { generateSolidVoxels } from "../core/solidVoxelizer";
import { workerErrorDescriptor } from "../core/appError";
import { assertWorkerResources } from "../core/workerResourcePreflight";
import { projectionResultTransferables } from "../core/workerResultTransfer";
import { assertWorkerGenerationHeight, assertWorkerResultHeight } from "../core/workerHeightPreflight";
import { createPerformanceTelemetryRecorder } from "../core/performanceTelemetry";
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
  const telemetry = createPerformanceTelemetryRecorder({
    scope: "production-ui",
    workflow: "generation",
    backend: "web-worker",
    generationMode: command.type === "GENERATE_SOLID" ? "solid" : "hologram",
    targetHeight: command.options.targetHeight,
    workerThreads: 1,
  });

  try {
    const resources = telemetry.measure("preflight", () => {
      assertWorkerGenerationHeight(command);
      return assertWorkerResources(command);
    });
    const progress = (stage: WorkerStage, value: number) => {
      send({ type: "PROGRESS", jobId: command.jobId, stage, progress: value });
    };
    let result;
    if (command.type === "GENERATE_SOLID") {
      // 当前 TS 回退路径在同一热循环完成 SAT、UV、纹理与 Alpha；拆成虚假子阶段会污染基线。
      result = telemetry.measure("voxelization.total", () => generateSolidVoxels(
        command.source.mesh,
        command.options,
        progress,
        { workEstimate: resources.solidWorkEstimate },
      ), (generated) => ({
        triangleCount: command.source.mesh.indices.length / 3,
        candidateChecks: generated.stats.triangleBoxTests,
        blockCount: generated.stats.blockCount,
        chunkCount: generated.chunks?.length ?? 0,
      }));
    } else if (command.source.kind === "mesh") {
      if (
        !command.generationSeed
        || command.generationSeed.minecraftVersion !== command.versionId
      ) {
        throw new RangeError("WORKER_GENERATION_SEED_INVALID");
      }
      result = generateMeshHologram(command.source.mesh, {
        ...command.options,
        contentHash: command.generationSeed.contentHash,
        minecraftVersion: command.generationSeed.minecraftVersion,
      }, progress);
    } else {
      progress("tracing", 0.18);
      progress("sampling", 0.55);
      result = generateHologram(command.options);
      progress("isolation", 0.82);
    }
    assertWorkerResultHeight(command, result);
    send({ type: "PROGRESS", jobId: command.jobId, stage: "complete", progress: 1 });
    send(
      { type: "RESULT", jobId: command.jobId, result, telemetry: telemetry.report() },
      projectionResultTransferables(result),
    );
  } catch (error) {
    const descriptor = workerErrorDescriptor(error);
    send({
      type: "ERROR",
      jobId: command.jobId,
      code: descriptor.code,
      params: descriptor.params,
      telemetry: telemetry.report(),
    });
  } finally {
    if (sourceMesh) releaseInputMesh(sourceMesh);
  }
};

export {};
