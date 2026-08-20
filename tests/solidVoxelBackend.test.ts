import assert from "node:assert/strict";
import test from "node:test";
import {
  canRunNativeSolidOptions,
  probeSolidVoxelBackend,
  probeSolidVoxelEnvironment,
  probeTauriSolidVoxelCpuCapabilities,
  selectSolidVoxelBackend,
  SOLID_VOXEL_CPU_CAPABILITIES_COMMAND,
  WEB_WORKER_SOLID_VOXEL_BACKEND,
  type TauriCoreCapabilityLoader,
} from "../src/platform/solidVoxelBackend";

const supportedSolidOptions = {
  fillModes: ["shell"],
  faceDetails: ["off"],
  dithering: { minimum: 0, maximum: 0 },
  ruinDecoration: { minimum: 0, maximum: 0 },
  textureSampling: true,
  skinProtection: true,
  emissiveMapping: true,
};

const defaultSolidOptions = {
  targetHeight: 4_064,
  alphaThreshold: 0.3,
  thicknessCompensation: 0.08,
  fillMode: "shell" as const,
  palettePreset: "clean" as const,
  faceDetail: "off" as const,
  materialTheme: "original" as const,
  dithering: 0,
  emissiveMapping: true,
  emissiveMaterialIndices: [],
  ruinDecoration: 0,
  skinProtection: true,
  skinMaterialIndices: [],
  excludeGravity: true,
  excludeRare: true,
};

test("ordinary Web runtime uses an estimated capability profile without invoking Tauri commands", async () => {
  let invokeCount = 0;
  const loadTauriCore: TauriCoreCapabilityLoader = async () => ({
    isTauri: () => false,
    invoke: async () => {
      invokeCount += 1;
      throw new Error("Web runtime must not invoke Tauri commands");
    },
  });

  const result = await probeSolidVoxelBackend({
    hardwareConcurrency: 32,
    webWorkerAvailable: true,
    loadTauriCore,
  });

  assert.equal(invokeCount, 0);
  assert.deepEqual(result.nativeCapabilityProbe, {
    status: "unavailable",
    reason: "web-runtime",
  });
  assert.equal(result.nativeJobApi, null);
  assert.deepEqual(result.capabilities, {
    physicalCores: 16,
    logicalProcessors: 32,
    availableParallelism: 32,
    recommendedThreads: 8,
    maximumThreads: 16,
    physicalCountReliable: false,
    source: "web",
    estimated: true,
  });
  assert.equal(result.backend, WEB_WORKER_SOLID_VOXEL_BACKEND);
  assert.equal(result.nativeJobAvailable, false);
  assert.equal(result.nativeBackendUnavailableReason, "web-runtime");
  assert.equal(result.usedWebCapabilityFallback, true);
  assert.equal(result.webWorkerFallbackAvailable, true);
});

test("Tauri CPU probe invokes only the registered capability command", async () => {
  const invokedCommands: string[] = [];
  const result = await probeSolidVoxelBackend({
    hardwareConcurrency: 2,
    webWorkerAvailable: true,
    loadTauriCore: async () => ({
      isTauri: () => true,
      invoke: async (command) => {
        invokedCommands.push(command);
        return {
          physicalCores: 16,
          logicalProcessors: 32,
          availableParallelism: 32,
          recommendedThreads: 8,
          physicalCountReliable: true,
        };
      },
    }),
  });

  assert.deepEqual(invokedCommands, [SOLID_VOXEL_CPU_CAPABILITIES_COMMAND]);
  assert.equal(result.capabilities.source, "native");
  assert.equal(result.capabilities.physicalCores, 16);
  assert.equal(result.capabilities.recommendedThreads, 8);
  assert.equal(result.capabilities.maximumThreads, 16);
  assert.equal(result.capabilities.estimated, false);

  // CPU command 成功不代表原生任务 command 已经存在。
  assert.equal(result.nativeJobAvailable, false);
  assert.equal(result.nativeBackendUnavailableReason, "native-job-command-not-implemented");
  assert.equal(result.backend?.kind, "web-worker");
  assert.equal(result.usedWebCapabilityFallback, false);
  assert.equal(result.nativeJobApi, null);
});

test("environment probing and backend selection keep CPU capability separate from job availability", async () => {
  const environment = await probeSolidVoxelEnvironment({
    webWorkerAvailable: true,
    loadTauriCore: async () => ({
      isTauri: () => true,
      invoke: async () => ({
        physicalCores: 8,
        logicalProcessors: 16,
        availableParallelism: 16,
        recommendedThreads: 4,
        physicalCountReliable: true,
      }),
    }),
  });

  assert.equal(environment.nativeCapabilityProbe.status, "available");
  assert.equal(environment.nativeJobAvailable, false);
  assert.equal(selectSolidVoxelBackend(environment).kind, "web-worker");
});

test("native jobs require the complete versioned execution and result-consumption chain", async () => {
  const capability = (features: string[], nativeResultHandles = true) => probeSolidVoxelBackend({
    webWorkerAvailable: true,
    loadTauriCore: async () => ({
      isTauri: () => true,
      invoke: async () => ({
        physicalCores: 16,
        logicalProcessors: 32,
        availableParallelism: 32,
        recommendedThreads: 8,
        physicalCountReliable: true,
        jobApi: {
          version: 1,
          rawSnapshotVersion: 1,
          nativeResultHandles,
          features,
          supportedSolidOptions,
        },
      }),
    }),
  });

  const incomplete = await capability(["rawSnapshotUpload"], false);
  assert.equal(incomplete.nativeJobAvailable, false);
  assert.equal(incomplete.backend, WEB_WORKER_SOLID_VOXEL_BACKEND);

  const complete = await capability([
    "rawSnapshotUpload",
    "nativeResultHandles",
    "limitedPreview",
    "chunkBatchPull",
    "litematicWrite",
  ]);
  assert.equal(complete.nativeJobAvailable, true);
  assert.equal(complete.nativeBackendUnavailableReason, null);
  assert.equal(complete.backend?.kind, "native-rayon");
  assert.equal(complete.backend?.supportsNativeResultHandles, true);
});

test("malformed or unknown native job API features fail closed", async () => {
  const result = await probeSolidVoxelBackend({
    webWorkerAvailable: true,
    loadTauriCore: async () => ({
      isTauri: () => true,
      invoke: async () => ({
        physicalCores: 16,
        logicalProcessors: 32,
        availableParallelism: 32,
        recommendedThreads: 8,
        physicalCountReliable: true,
        jobApi: {
          version: 1,
          rawSnapshotVersion: 1,
          nativeResultHandles: true,
          features: ["rawSnapshotUpload", "futureUnknownFeature"],
          supportedSolidOptions,
        },
      }),
    }),
  });

  assert.equal(result.nativeJobApi, null);
  assert.equal(result.nativeJobAvailable, false);
  assert.equal(result.backend, WEB_WORKER_SOLID_VOXEL_BACKEND);
});

test("native option selection accepts the shell subset independently from execution readiness", async () => {
  const result = await probeSolidVoxelBackend({
    webWorkerAvailable: true,
    loadTauriCore: async () => ({
      isTauri: () => true,
      invoke: async () => ({
        physicalCores: 16,
        logicalProcessors: 32,
        availableParallelism: 32,
        recommendedThreads: 8,
        physicalCountReliable: true,
        jobApi: {
          version: 1,
          rawSnapshotVersion: 1,
          nativeResultHandles: true,
          features: ["rawSnapshotUpload", "nativeResultHandles"],
          supportedSolidOptions,
        },
      }),
    }),
  });

  assert.equal(result.nativeJobAvailable, false);
  assert.equal(canRunNativeSolidOptions(result.nativeJobApi, defaultSolidOptions), true);
  assert.equal(canRunNativeSolidOptions(result.nativeJobApi, {
    ...defaultSolidOptions,
    fillMode: "filled",
  }), false);
  assert.equal(canRunNativeSolidOptions(result.nativeJobApi, {
    ...defaultSolidOptions,
    faceDetail: "balanced",
  }), false);
  assert.equal(canRunNativeSolidOptions(result.nativeJobApi, {
    ...defaultSolidOptions,
    dithering: 1,
  }), false);
  assert.equal(canRunNativeSolidOptions(result.nativeJobApi, {
    ...defaultSolidOptions,
    materialTheme: "ancientRuins",
    ruinDecoration: 1,
  }), false);
});

test("failed dynamic Tauri loading is a safe Web fallback instead of a rejected probe", async () => {
  const result = await probeSolidVoxelBackend({
    hardwareConcurrency: 12,
    webWorkerAvailable: true,
    loadTauriCore: async () => {
      throw new Error("Tauri API is not bundled in this runtime");
    },
  });

  assert.deepEqual(result.nativeCapabilityProbe, {
    status: "unavailable",
    reason: "tauri-api-unavailable",
  });
  assert.equal(result.capabilities.source, "web");
  assert.equal(result.capabilities.logicalProcessors, 12);
  assert.equal(result.backend?.kind, "web-worker");
  assert.equal(result.nativeBackendUnavailableReason, "native-capability-unavailable");
});

test("Tauri invoke failures and malformed payloads cannot masquerade as native capability", async () => {
  const invokeFailure = await probeTauriSolidVoxelCpuCapabilities(async () => ({
    isTauri: () => true,
    invoke: async () => {
      throw new Error("command unavailable");
    },
  }));
  assert.deepEqual(invokeFailure, {
    status: "unavailable",
    reason: "capability-invoke-failed",
  });

  const malformed = await probeTauriSolidVoxelCpuCapabilities(async () => ({
    isTauri: () => true,
    invoke: async () => ({ physicalCores: 16 }),
  }));
  assert.deepEqual(malformed, {
    status: "unavailable",
    reason: "invalid-capability-response",
  });
});

test("absence of both native jobs and Web Worker is represented without throwing", async () => {
  const result = await probeSolidVoxelBackend({
    hardwareConcurrency: null,
    webWorkerAvailable: false,
    loadTauriCore: async () => ({
      isTauri: () => false,
      invoke: async () => undefined,
    }),
  });

  assert.equal(result.backend, null);
  assert.equal(result.webWorkerFallbackAvailable, false);
  assert.equal(result.capabilities.logicalProcessors, 1);
  assert.equal(result.capabilities.recommendedThreads, 1);
});
