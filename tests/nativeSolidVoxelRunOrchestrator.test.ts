import assert from "node:assert/strict";
import test from "node:test";
import type { NativeThreadExecutionSnapshot } from "../src/core/nativeThreadRisk";
import type { NativeSolidVoxelMaterializedResult } from "../src/platform/nativeSolidVoxelResultStore";
import {
  DEFAULT_NATIVE_SOLID_VOXEL_POLL_INTERVAL_MS,
  runNativeSolidVoxelJob,
} from "../src/platform/nativeSolidVoxelRunOrchestrator";
import {
  TauriSolidVoxelClientError,
  type SolidVoxelJobStatus,
  type SolidVoxelResultManifest,
  type TauriSolidVoxelClient,
} from "../src/platform/tauriSolidVoxelBackend";
import type { MmdMeshSnapshot, SolidOptions } from "../src/types";

const JOB_ID = 19n;
const handle = { id: 31n, generation: 2n };
const execution: NativeThreadExecutionSnapshot = {
  backend: "native-rayon",
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
const manifest: SolidVoxelResultManifest = {
  blockCount: 1,
  surfaceBlockCount: 1,
  filledBlockCount: 0,
  skinBlockCount: 0,
  alphaRejected: 0,
  triangleBoxTests: 1,
  paletteSize: 1,
  dimensions: [1, 1, 1],
  bounds: { min: [0, 0, 0], max: [0, 0, 0] },
  chunkCount: 1,
};
const materialized: NativeSolidVoxelMaterializedResult = {
  result: {
    kind: "solid",
    storage: "chunked",
    positions: new Float32Array(0),
    blockIndices: new Uint16Array(0),
    chunks: [{
      chunk: [0, 0, 0],
      positions: Uint16Array.of(0),
      blockIndices: Uint16Array.of(0),
    }],
    palette: [{ blockId: "minecraft:stone", color: [125, 125, 125] }],
    stats: {
      blockCount: 1,
      surfaceBlockCount: 1,
      filledBlockCount: 0,
      skinBlockCount: 0,
      alphaRejected: 0,
      triangleBoxTests: 1,
      paletteSize: 1,
      dimensions: [1, 1, 1],
    },
    bounds: { min: [0, 0, 0], max: [0, 0, 0] },
  },
  document: {
    format: "MELYProjection",
    version: 1,
    edition: "java",
    minecraftVersion: "1.20.1",
    palette: [{ blockId: "minecraft:stone", color: [125, 125, 125] }],
    chunks: [{
      chunk: [0, 0, 0],
      positions: Uint16Array.of(0),
      paletteIndices: Uint16Array.of(0),
    }],
    bounds: { min: [0, 0, 0], max: [0, 0, 0], dimensions: [1, 1, 1] },
    blockCount: 1,
  },
  contentHash: "sha256:test",
};

const runningStatus = (
  fraction: number,
  state: SolidVoxelJobStatus["state"] = "running",
): SolidVoxelJobStatus => ({
  jobId: JOB_ID,
  workerThreads: 8,
  state,
  progress: { completedUnits: Math.round(fraction * 100), totalUnits: 100, fraction },
  ...(state === "completed" ? { resultHandle: handle, manifest } : {}),
});

const client = (overrides: Partial<TauriSolidVoxelClient> = {}): TauriSolidVoxelClient => ({
  createJob: async () => ({ jobId: JOB_ID, workerThreads: 8 }),
  uploadSnapshotEnvelope: async () => ({ jobId: JOB_ID, state: "running" }),
  getJobStatus: async () => runningStatus(1, "completed"),
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
    done: true,
    cursor: null,
    palette: [{ blockId: "minecraft:stone", color: [125, 125, 125] }],
    chunks: [{
      chunk: [0, 0, 0],
      positions: Uint16Array.of(0),
      blockIndices: Uint16Array.of(0),
    }],
  }),
  writeLitematic: async () => { throw new Error("unused"); },
  ...overrides,
});

const input = () => ({ execution, options, snapshot });

const resultStore = (overrides: {
  consume?: () => Promise<NativeSolidVoxelMaterializedResult>;
  cancel?: () => Promise<boolean>;
  release?: () => Promise<boolean>;
  subscribe?: (
    listener: (snapshot: {
      phase: "pulling";
      pulledChunkCount: number;
      totalChunkCount: number;
      result: null;
      error: null;
    }) => void,
  ) => () => void;
} = {}) => ({
  getSnapshot: () => ({
    phase: "idle" as const,
    pulledChunkCount: 0,
    totalChunkCount: 0,
    result: null,
    error: null,
  }),
  subscribe: overrides.subscribe ?? (() => () => undefined),
  consume: overrides.consume ?? (async () => materialized),
  cancel: overrides.cancel ?? (async () => true),
  release: overrides.release ?? (async () => true),
});

test("runtime unavailable before native create allows explicit Web fallback", async () => {
  const unavailable = new TauriSolidVoxelClientError(
    "runtime-unavailable",
    "create_solid_voxel_job",
    "Tauri unavailable",
  );
  const result = await runNativeSolidVoxelJob(input(), {
    createTransport: async () => { throw unavailable; },
  });

  assert.deepEqual(result, { kind: "fallback-allowed", reason: unavailable });
});

test("failure after native create never returns fallback and releases the job", async () => {
  const uploadFailure = new TauriSolidVoxelClientError(
    "runtime-unavailable",
    "upload_solid_voxel_snapshot",
    "upload unavailable",
  );
  const releases: bigint[] = [];

  await assert.rejects(runNativeSolidVoxelJob(input(), {
    client: client({
      uploadSnapshotEnvelope: async () => { throw uploadFailure; },
      releaseJob: async jobId => {
        releases.push(jobId);
        return { jobId, fullyReleased: true };
      },
    }),
  }), uploadFailure);
  assert.deepEqual(releases, [JOB_ID]);
});

test("cleanup releases a started job once when polling fails", async () => {
  const pollFailure = new TauriSolidVoxelClientError(
    "transport",
    "solid_voxel_job_status",
    "poll failed",
  );
  const calls: string[] = [];

  await assert.rejects(runNativeSolidVoxelJob(input(), {
    client: client({
      getJobStatus: async () => { throw pollFailure; },
      releaseJob: async jobId => {
        calls.push(`release:${jobId}`);
        return { jobId, fullyReleased: true };
      },
    }),
  }), pollFailure);

  assert.deepEqual(calls, [`release:${JOB_ID}`]);
});

test("cleanup waits until native release is fully settled", async () => {
  const pollFailure = new TauriSolidVoxelClientError(
    "transport",
    "solid_voxel_job_status",
    "poll failed",
  );
  let releaseAttempts = 0;
  const waits: number[] = [];

  await assert.rejects(runNativeSolidVoxelJob(input(), {
    client: client({
      getJobStatus: async () => { throw pollFailure; },
      releaseJob: async jobId => ({
        jobId,
        fullyReleased: ++releaseAttempts > 1,
      }),
    }),
    wait: async milliseconds => { waits.push(milliseconds); },
  }), pollFailure);

  assert.equal(releaseAttempts, 2);
  assert.deepEqual(waits, [DEFAULT_NATIVE_SOLID_VOXEL_POLL_INTERVAL_MS]);
});

test("upload cleanup retries a failed release without hiding the upload error", async () => {
  const uploadFailure = new TauriSolidVoxelClientError(
    "transport",
    "upload_solid_voxel_snapshot",
    "upload failed",
  );
  let releaseAttempts = 0;

  await assert.rejects(runNativeSolidVoxelJob(input(), {
    client: client({
      uploadSnapshotEnvelope: async () => { throw uploadFailure; },
      releaseJob: async jobId => {
        releaseAttempts += 1;
        if (releaseAttempts === 1) throw new Error("transient release failure");
        return { jobId, fullyReleased: true };
      },
    }),
  }), uploadFailure);

  assert.equal(releaseAttempts, 2);
});

test("snapshot upload ownership callback runs exactly once only after a successful upload", async () => {
  const events: string[] = [];
  await runNativeSolidVoxelJob({
    ...input(),
    onSnapshotUploaded: () => events.push("uploaded"),
  }, {
    client: client({
      uploadSnapshotEnvelope: async () => {
        events.push("upload-command");
        return { jobId: JOB_ID, state: "running" };
      },
    }),
    createResultStore: () => resultStore(),
  });
  assert.deepEqual(events, ["upload-command", "uploaded"]);

  const unavailable = new TauriSolidVoxelClientError(
    "runtime-unavailable",
    "create_solid_voxel_job",
    "Tauri unavailable",
  );
  await runNativeSolidVoxelJob({
    ...input(),
    onSnapshotUploaded: () => events.push("fallback-uploaded"),
  }, {
    client: client({ createJob: async () => { throw unavailable; } }),
  });

  const uploadFailure = new TauriSolidVoxelClientError(
    "transport",
    "upload_solid_voxel_snapshot",
    "upload failed",
  );
  await assert.rejects(runNativeSolidVoxelJob({
    ...input(),
    onSnapshotUploaded: () => events.push("failed-uploaded"),
  }, {
    client: client({ uploadSnapshotEnvelope: async () => { throw uploadFailure; } }),
  }), uploadFailure);
  assert.deepEqual(events, ["upload-command", "uploaded"]);
});

test("polling publishes progress monotonically and uses the default 100 ms cadence", async () => {
  const statuses = [runningStatus(0.4), runningStatus(0.2), runningStatus(1, "completed")];
  const progress: number[] = [];
  const waits: number[] = [];
  const store = resultStore();

  const result = await runNativeSolidVoxelJob({
    ...input(),
    onProgress: fraction => progress.push(fraction),
  }, {
    client: client({ getJobStatus: async () => statuses.shift()! }),
    wait: async milliseconds => { waits.push(milliseconds); },
    createResultStore: () => store,
  });

  assert.equal(result.kind, "completed");
  assert.deepEqual(progress, [0.4, 1]);
  assert.deepEqual(waits, [
    DEFAULT_NATIVE_SOLID_VOXEL_POLL_INTERVAL_MS,
    DEFAULT_NATIVE_SOLID_VOXEL_POLL_INTERVAL_MS,
  ]);
});

test("stale status completion is cancelled before progress or result consumption", async () => {
  let current = true;
  let consumed = 0;
  const calls: string[] = [];
  const staleClient = client({
    getJobStatus: async () => {
      current = false;
      return runningStatus(1, "completed");
    },
    cancelJob: async jobId => {
      calls.push(`cancel:${jobId}`);
      return { jobId, cancellationRequested: true };
    },
    releaseJob: async jobId => {
      calls.push(`release:${jobId}`);
      return { jobId, fullyReleased: true };
    },
  });

  await assert.rejects(runNativeSolidVoxelJob({
    ...input(),
    isCurrent: () => current,
    onProgress: () => calls.push("progress"),
  }, {
    client: staleClient,
    createResultStore: () => resultStore({
      consume: async () => {
        consumed += 1;
        return materialized;
      },
    }),
  }), (error: unknown) => error instanceof Error && error.name === "AbortError");

  assert.equal(consumed, 0);
  assert.deepEqual(calls, [`cancel:${JOB_ID}`, `release:${JOB_ID}`]);
});

test("completed ownership retains the result handle until explicit release", async () => {
  let releases = 0;
  const store = resultStore({
    release: async () => {
      releases += 1;
      return true;
    },
  });

  const completed = await runNativeSolidVoxelJob(input(), {
    client: client(),
    createResultStore: () => store,
  });

  assert.equal(completed.kind, "completed");
  if (completed.kind !== "completed") return;
  assert.equal(completed.ownership.jobId, JOB_ID);
  assert.equal(completed.ownership.handle, handle);
  assert.equal(completed.ownership.manifest, manifest);
  assert.equal(completed.ownership.resultStore, store);
  assert.equal(completed.ownership.materialized, materialized);
  assert.equal(releases, 0);

  await completed.ownership.resultStore.release();
  assert.equal(releases, 1);
});

test("native terminal errors retain structured details as a cause", async () => {
  const nativeError = {
    code: "SOLID_VOXEL_FAILED",
    category: "internal" as const,
    retryable: true,
    message: "private native detail",
  };

  await assert.rejects(runNativeSolidVoxelJob(input(), {
    client: client({
      getJobStatus: async () => ({
        ...runningStatus(1, "failed"),
        error: nativeError,
      }),
    }),
  }), (error: unknown) => (
    error instanceof TauriSolidVoxelClientError
    && error.kind === "native"
    && error.nativeError === nativeError
    && error.cause === nativeError
    && !error.message.includes(nativeError.message)
  ));
});

test("materialization progress stops after unsubscribe and suppresses stale callbacks", async () => {
  const progress: Array<[number, number]> = [];
  let subscribedListener: ((snapshot: {
    phase: "pulling";
    pulledChunkCount: number;
    totalChunkCount: number;
    result: null;
    error: null;
  }) => void) | undefined;
  let unsubscribed = 0;
  let current = true;
  const store = resultStore({
    subscribe: (listener) => {
      subscribedListener = listener;
      return () => { unsubscribed += 1; };
    },
    consume: async () => {
      subscribedListener!({
        phase: "pulling",
        pulledChunkCount: 2,
        totalChunkCount: 8,
        result: null,
        error: null,
      });
      current = false;
      subscribedListener!({
        phase: "pulling",
        pulledChunkCount: 4,
        totalChunkCount: 8,
        result: null,
        error: null,
      });
      current = true;
      return materialized;
    },
  });

  await runNativeSolidVoxelJob({
    ...input(),
    isCurrent: () => current,
    onMaterializationProgress: (pulled, total) => progress.push([pulled, total]),
  }, {
    client: client(),
    createResultStore: () => store,
  });

  assert.deepEqual(progress, [[2, 8]]);
  assert.equal(unsubscribed, 1);
});

test("AbortSignal while create is in flight releases the late native job", async () => {
  const controller = new AbortController();
  let markCreateStarted: (() => void) | undefined;
  const createStarted = new Promise<void>((resolve) => { markCreateStarted = resolve; });
  let resolveCreate: ((value: { jobId: bigint; workerThreads: number }) => void) | undefined;
  const createPending = new Promise<{ jobId: bigint; workerThreads: number }>((resolve) => {
    resolveCreate = resolve;
  });
  const releases: bigint[] = [];
  const running = runNativeSolidVoxelJob({ ...input(), signal: controller.signal }, {
    client: client({
      createJob: async () => {
        markCreateStarted!();
        return createPending;
      },
      releaseJob: async jobId => {
        releases.push(jobId);
        return { jobId, fullyReleased: true };
      },
    }),
  });

  await createStarted;
  controller.abort();
  await assert.rejects(running, (error: unknown) => (
    error instanceof Error && error.name === "AbortError"
  ));
  resolveCreate!({ jobId: JOB_ID, workerThreads: 8 });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(releases, [JOB_ID]);
});

test("AbortSignal while upload is in flight cancels and releases without polling", async () => {
  const controller = new AbortController();
  let markUploadStarted: (() => void) | undefined;
  const uploadStarted = new Promise<void>((resolve) => { markUploadStarted = resolve; });
  let resolveUpload: (() => void) | undefined;
  const uploadPending = new Promise<void>((resolve) => { resolveUpload = resolve; });
  const calls: string[] = [];
  let polls = 0;
  const running = runNativeSolidVoxelJob({ ...input(), signal: controller.signal }, {
    client: client({
      uploadSnapshotEnvelope: async () => {
        markUploadStarted!();
        await uploadPending;
        return { jobId: JOB_ID, state: "running" };
      },
      getJobStatus: async () => {
        polls += 1;
        return runningStatus(1, "completed");
      },
      cancelJob: async jobId => {
        calls.push(`cancel:${jobId}`);
        return { jobId, cancellationRequested: true };
      },
      releaseJob: async jobId => {
        calls.push(`release:${jobId}`);
        return { jobId, fullyReleased: true };
      },
    }),
  });

  await uploadStarted;
  controller.abort();
  await assert.rejects(running, (error: unknown) => (
    error instanceof Error && error.name === "AbortError"
  ));
  resolveUpload!();
  assert.equal(polls, 0);
  assert.deepEqual(calls, [`cancel:${JOB_ID}`, `release:${JOB_ID}`]);
});

test("AbortSignal while transport is resolving exits before native create", async () => {
  const controller = new AbortController();
  const pendingTransport = new Promise<never>(() => undefined);
  let clients = 0;
  const running = runNativeSolidVoxelJob({ ...input(), signal: controller.signal }, {
    createTransport: async () => pendingTransport,
    createClient: () => {
      clients += 1;
      return client();
    },
  });

  controller.abort();
  await assert.rejects(running, (error: unknown) => (
    error instanceof Error && error.name === "AbortError"
  ));
  assert.equal(clients, 0);
});

test("AbortSignal while poll is in flight cancels and releases before callbacks", async () => {
  const controller = new AbortController();
  let markPollStarted: (() => void) | undefined;
  const pollStarted = new Promise<void>((resolve) => { markPollStarted = resolve; });
  let resolveStatus: ((value: SolidVoxelJobStatus) => void) | undefined;
  const pendingStatus = new Promise<SolidVoxelJobStatus>((resolve) => { resolveStatus = resolve; });
  const calls: string[] = [];
  const running = runNativeSolidVoxelJob({
    ...input(),
    signal: controller.signal,
    onProgress: () => calls.push("progress"),
  }, {
    client: client({
      getJobStatus: async () => {
        markPollStarted!();
        return pendingStatus;
      },
      cancelJob: async jobId => {
        calls.push(`cancel:${jobId}`);
        return { jobId, cancellationRequested: true };
      },
      releaseJob: async jobId => {
        calls.push(`release:${jobId}`);
        return { jobId, fullyReleased: true };
      },
    }),
  });

  await pollStarted;
  controller.abort();
  await assert.rejects(running, (error: unknown) => (
    error instanceof Error && error.name === "AbortError"
  ));
  resolveStatus!(runningStatus(1, "completed"));
  assert.deepEqual(calls, [`cancel:${JOB_ID}`, `release:${JOB_ID}`]);
});
