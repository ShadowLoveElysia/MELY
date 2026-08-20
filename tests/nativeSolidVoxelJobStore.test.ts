import assert from "node:assert/strict";
import test from "node:test";
import {
  createNativeSolidVoxelJobStore,
} from "../src/platform/nativeSolidVoxelJobStore";
import {
  TauriSolidVoxelClientError,
  type TauriSolidVoxelClient,
} from "../src/platform/tauriSolidVoxelBackend";
import type { MmdMeshSnapshot, SolidOptions } from "../src/types";

const JOB_ID = 19n;
const handle = { id: 31n, generation: 2n };
const execution = {
  backend: "native-rayon" as const,
  workerThreads: 8,
  recommendedThreads: 8,
  maximumThreads: 16,
  memorySuggestedThreads: null,
};
const options: SolidOptions = {
  targetHeight: 4_064,
  alphaThreshold: 0.3,
  thicknessCompensation: 0.08,
  fillMode: "shell",
  palettePreset: "clean",
  faceDetail: "off",
  materialTheme: "original",
  dithering: 0,
  emissiveMapping: true,
  emissiveMaterialIndices: [],
  ruinDecoration: 0,
  skinProtection: true,
  skinMaterialIndices: [],
  excludeGravity: true,
  excludeRare: true,
};
const snapshot: MmdMeshSnapshot = {
  positions: new Float32Array([0, 0, 0, 0, 1, 0, 1, 0, 0]),
  indices: new Uint32Array([0, 1, 2]),
  triangleMaterials: new Uint16Array([0]),
};
const manifest = {
  blockCount: 4_064,
  surfaceBlockCount: 4_064,
  filledBlockCount: 0,
  skinBlockCount: 0,
  alphaRejected: 0,
  triangleBoxTests: 4_064,
  paletteSize: 1,
  dimensions: [1, 4_064, 1] as [number, number, number],
  bounds: {
    min: [0, -2_032, 0] as [number, number, number],
    max: [0, 2_031, 0] as [number, number, number],
  },
  chunkCount: 127,
};

const client = (overrides: Partial<TauriSolidVoxelClient> = {}): TauriSolidVoxelClient => ({
  createJob: async () => ({ jobId: JOB_ID, workerThreads: 8 }),
  uploadSnapshotEnvelope: async () => ({ jobId: JOB_ID, state: "running" }),
  getJobStatus: async () => ({
    jobId: JOB_ID,
    workerThreads: 8,
    state: "running",
    progress: { completedUnits: 1, totalUnits: 2, fraction: 0.5 },
  }),
  cancelJob: async () => ({ jobId: JOB_ID, cancellationRequested: true }),
  releaseJob: async jobId => ({ jobId, fullyReleased: true }),
  getLimitedPreview: async () => ({
    handle,
    points: [],
    blockIndices: [],
    totalPoints: 0,
    truncated: false,
  }),
  pullResultBatch: async () => ({
    version: 1,
    handle,
    startChunkIndex: 0,
    totalChunkCount: 1,
    totalPaletteCount: 1,
    first: true,
    cursor: null,
    done: true,
    palette: [{ blockId: "minecraft:stone", color: [125, 125, 125] }],
    chunks: [{
      chunk: [0, 0, 0],
      positions: Uint16Array.of(0),
      blockIndices: Uint16Array.of(0),
    }],
  }),
  writeLitematic: async () => {
    throw new Error("unused");
  },
  ...overrides,
});

test("store freezes the accepted thread snapshot and uploads an envelope containing the job id", async () => {
  let createRequest: unknown;
  let uploaded: Uint8Array | undefined;
  const store = createNativeSolidVoxelJobStore(client({
    createJob: async (request) => {
      createRequest = request;
      return { jobId: JOB_ID, workerThreads: 8 };
    },
    uploadSnapshotEnvelope: async (jobId, envelope) => {
      assert.equal(jobId, JOB_ID);
      uploaded = envelope;
      return { jobId, state: "running" };
    },
  }));

  const started = await store.start({ execution, options, snapshot });
  assert.deepEqual(started, { kind: "started", jobId: JOB_ID });
  assert.deepEqual(createRequest, { workerThreads: 8, options });
  assert.ok(uploaded instanceof Uint8Array);
  assert.equal(new DataView(uploaded.buffer, uploaded.byteOffset).getBigUint64(32, true), JOB_ID);
  assert.equal(store.getSnapshot().phase, "running");
  assert.equal(store.getSnapshot().execution?.workerThreads, 8);
});

test("runtime unavailable before create is the only automatic Web fallback boundary", async () => {
  const unavailable = new TauriSolidVoxelClientError(
    "runtime-unavailable",
    "create_solid_voxel_job",
    "command unavailable",
  );
  const store = createNativeSolidVoxelJobStore(client({
    createJob: async () => { throw unavailable; },
  }));

  assert.deepEqual(await store.start({ execution, options, snapshot }), {
    kind: "fallback-allowed",
    reason: unavailable,
  });
  assert.equal(store.getSnapshot().jobId, null);
  assert.equal(store.getSnapshot().phase, "failed");
});

test("transport failure before create is reported instead of being mislabeled unsupported", async () => {
  const failure = new TauriSolidVoxelClientError(
    "transport",
    "create_solid_voxel_job",
    "IPC failed",
  );
  const store = createNativeSolidVoxelJobStore(client({
    createJob: async () => { throw failure; },
  }));

  await assert.rejects(store.start({ execution, options, snapshot }), failure);
  assert.equal(store.getSnapshot().error, failure);
});

test("any upload or running failure after job creation forbids silent Web recomputation", async () => {
  const uploadFailure = new TauriSolidVoxelClientError(
    "runtime-unavailable",
    "upload_solid_voxel_snapshot",
    "upload failed",
  );
  const uploadStore = createNativeSolidVoxelJobStore(client({
    uploadSnapshotEnvelope: async () => { throw uploadFailure; },
  }));
  await assert.rejects(
    uploadStore.start({ execution, options, snapshot }),
    uploadFailure,
  );
  assert.equal(uploadStore.getSnapshot().jobId, null);
  assert.equal(uploadStore.getSnapshot().phase, "failed");

  let releasedAfterUploadFailure = false;
  const releaseCheckedStore = createNativeSolidVoxelJobStore(client({
    uploadSnapshotEnvelope: async () => { throw uploadFailure; },
    releaseJob: async (jobId) => {
      assert.equal(jobId, JOB_ID);
      releasedAfterUploadFailure = true;
      return { jobId, fullyReleased: true };
    },
  }));
  await assert.rejects(
    releaseCheckedStore.start({ execution, options, snapshot }),
    uploadFailure,
  );
  assert.equal(releasedAfterUploadFailure, true);

  const runningFailure = new TauriSolidVoxelClientError(
    "transport",
    "solid_voxel_job_status",
    "poll failed",
  );
  const runningStore = createNativeSolidVoxelJobStore(client({
    getJobStatus: async () => { throw runningFailure; },
  }));
  assert.deepEqual(
    await runningStore.start({ execution, options, snapshot }),
    { kind: "started", jobId: JOB_ID },
  );
  await assert.rejects(runningStore.poll(), runningFailure);
  assert.equal(runningStore.getSnapshot().phase, "failed");
  assert.equal(runningStore.getSnapshot().jobId, JOB_ID);
});

test("failed upload release remains owned and can be retried explicitly", async () => {
  const uploadFailure = new TauriSolidVoxelClientError(
    "transport",
    "upload_solid_voxel_snapshot",
    "upload failed",
  );
  let releaseAttempts = 0;
  const store = createNativeSolidVoxelJobStore(client({
    uploadSnapshotEnvelope: async () => { throw uploadFailure; },
    releaseJob: async () => {
      releaseAttempts += 1;
      if (releaseAttempts === 1) throw new Error("transient release failure");
      return { jobId: JOB_ID, fullyReleased: true };
    },
  }));

  await assert.rejects(store.start({ execution, options, snapshot }), uploadFailure);
  assert.equal(store.getSnapshot().jobId, JOB_ID);
  assert.equal(store.getSnapshot().phase, "failed");
  await store.release();
  assert.equal(releaseAttempts, 2);
  assert.equal(store.getSnapshot().jobId, null);
  assert.equal(store.getSnapshot().phase, "released");
});

test("completed native result remains an owned handle and manifest, never a fake ProjectionDocument", async () => {
  const store = createNativeSolidVoxelJobStore(client({
    getJobStatus: async () => ({
      jobId: JOB_ID,
      workerThreads: 8,
      state: "completed",
      progress: { completedUnits: 100, totalUnits: 100, fraction: 1 },
      resultHandle: handle,
      manifest,
    }),
  }));
  await store.start({ execution, options, snapshot });
  const completed = await store.poll();

  assert.equal(completed.phase, "completed");
  assert.equal(completed.resultHandle, handle);
  assert.equal(completed.manifest, manifest);
  assert.equal("format" in completed, false);
  assert.equal("chunks" in completed, false);
});

test("cancel and release target the owned job and release clears the handle", async () => {
  const calls: unknown[] = [];
  const store = createNativeSolidVoxelJobStore(client({
    cancelJob: async (jobId) => {
      calls.push(["cancel", jobId]);
      return { jobId, cancellationRequested: true };
    },
    releaseJob: async (jobId) => {
      calls.push(["release", jobId]);
      return { jobId, fullyReleased: true };
    },
  }));
  await store.start({ execution, options, snapshot });
  await store.cancel();
  await store.release();

  assert.deepEqual(calls, [["cancel", JOB_ID], ["release", JOB_ID]]);
  assert.equal(store.getSnapshot().phase, "released");
  assert.equal(store.getSnapshot().jobId, null);
  assert.equal(store.getSnapshot().resultHandle, null);
});

test("an unsettled release keeps ownership and can be retried", async () => {
  let releaseAttempts = 0;
  const store = createNativeSolidVoxelJobStore(client({
    releaseJob: async jobId => ({
      jobId,
      fullyReleased: ++releaseAttempts > 1,
    }),
  }));
  await store.start({ execution, options, snapshot });

  await store.release();
  assert.equal(store.getSnapshot().jobId, JOB_ID);
  assert.notEqual(store.getSnapshot().phase, "released");
  await store.release();
  assert.equal(store.getSnapshot().jobId, null);
  assert.equal(store.getSnapshot().phase, "released");
});
