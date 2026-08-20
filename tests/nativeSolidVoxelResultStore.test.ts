import assert from "node:assert/strict";
import test from "node:test";
import { createProjectionDocumentContentHash } from "../src/core/projectionContentHash";
import type { SolidVoxelResultBatchEnvelope } from "../src/core/solidVoxelResultEnvelope";
import {
  createNativeSolidVoxelResultStore,
} from "../src/platform/nativeSolidVoxelResultStore";
import {
  DEFAULT_SOLID_VOXEL_BATCH_BYTES,
  TauriSolidVoxelClientError,
  type SolidVoxelResultManifest,
  type TauriSolidVoxelClient,
} from "../src/platform/tauriSolidVoxelBackend";
import type { SolidVoxelChunk, VoxelPaletteEntry } from "../src/types";

const JOB_ID = 19n;
const handle = { id: 31n, generation: 2n };
const palette: VoxelPaletteEntry[] = [
  { blockId: "minecraft:white_concrete", color: [207, 213, 214] },
  { blockId: "minecraft:black_concrete", color: [8, 10, 15] },
];
const chunks: SolidVoxelChunk[] = [
  {
    chunk: [-1, 0, 0],
    positions: Uint16Array.of(31),
    blockIndices: Uint16Array.of(0),
  },
  {
    chunk: [0, 0, 0],
    positions: Uint16Array.of(0, 1_057),
    blockIndices: Uint16Array.of(1, 0),
  },
];
const manifest: SolidVoxelResultManifest = {
  blockCount: 3,
  surfaceBlockCount: 3,
  filledBlockCount: 0,
  skinBlockCount: 1,
  alphaRejected: 2,
  triangleBoxTests: 40,
  paletteSize: 2,
  dimensions: [3, 2, 2],
  bounds: { min: [-1, 0, 0], max: [1, 1, 1] },
  chunkCount: 2,
};

const batch = (
  overrides: Partial<SolidVoxelResultBatchEnvelope>,
): SolidVoxelResultBatchEnvelope => ({
  version: 1,
  handle,
  startChunkIndex: 0,
  totalChunkCount: 2,
  totalPaletteCount: 2,
  first: true,
  done: false,
  cursor: "next",
  palette,
  chunks: [chunks[0]],
  ...overrides,
});

const pages = (): SolidVoxelResultBatchEnvelope[] => [
  batch({}),
  batch({
    startChunkIndex: 1,
    first: false,
    done: true,
    cursor: null,
    palette: undefined,
    chunks: [chunks[1]],
  }),
];

const client = (overrides: Partial<TauriSolidVoxelClient> = {}): TauriSolidVoxelClient => ({
  createJob: async () => ({ jobId: JOB_ID, workerThreads: 8 }),
  uploadSnapshotEnvelope: async () => ({ jobId: JOB_ID, state: "running" }),
  getJobStatus: async () => ({
    jobId: JOB_ID,
    workerThreads: 8,
    state: "completed",
    progress: { completedUnits: 1, totalUnits: 1, fraction: 1 },
    resultHandle: handle,
    manifest,
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
  pullResultBatch: async () => pages()[0],
  writeLitematic: async () => { throw new Error("unused"); },
  ...overrides,
});

test("result store serializes batch pulls and materializes canonical solid/document/hash data", async () => {
  const source = pages();
  const calls: unknown[] = [];
  let inFlight = 0;
  let maximumInFlight = 0;
  const store = createNativeSolidVoxelResultStore(client({
    pullResultBatch: async (requestedHandle, options) => {
      calls.push([requestedHandle, options]);
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return source.shift()!;
    },
  }), { jobId: JOB_ID, handle, manifest });

  const firstConsume = store.consume({
    document: {
      minecraftVersion: "1.20.1",
      metadata: { heightMode: "experimental_4064", targetHeight: 4_064 },
    },
  });
  assert.equal(store.consume(), firstConsume, "concurrent consumers must share one pull pipeline");
  const materialized = await firstConsume;

  assert.equal(maximumInFlight, 1);
  assert.deepEqual(calls, [
    [handle, { maxBytes: DEFAULT_SOLID_VOXEL_BATCH_BYTES }],
    [handle, { cursor: "next", maxBytes: DEFAULT_SOLID_VOXEL_BATCH_BYTES }],
  ]);
  assert.equal(materialized.result.storage, "chunked");
  assert.equal(materialized.result.positions.length, 0);
  assert.equal(materialized.result.blockIndices.length, 0);
  assert.deepEqual(materialized.result.palette, palette);
  assert.equal(materialized.result.stats.blockCount, 3);
  assert.equal(materialized.document.blockCount, 3);
  assert.deepEqual(materialized.document.bounds, {
    min: [-1, 0, 0],
    max: [1, 1, 1],
    dimensions: [3, 2, 2],
  });
  assert.equal(materialized.document.metadata?.source, "solid");
  assert.equal(materialized.document.metadata?.targetHeight, 4_064);
  assert.equal(
    materialized.contentHash,
    createProjectionDocumentContentHash(materialized.document),
  );
  assert.equal(store.getSnapshot().phase, "completed");
  assert.equal(store.getSnapshot().pulledChunkCount, 2);
});

test("cross-page discontinuity fails closed and releases the owned native job", async () => {
  const source = pages();
  source[1] = batch({
    startChunkIndex: 0,
    first: false,
    done: true,
    cursor: null,
    palette: undefined,
    chunks: [chunks[1]],
  });
  const released: bigint[] = [];
  const store = createNativeSolidVoxelResultStore(client({
    pullResultBatch: async () => source.shift()!,
    releaseJob: async jobId => {
      released.push(jobId);
      return { jobId, fullyReleased: true };
    },
  }), { jobId: JOB_ID, handle, manifest });

  await assert.rejects(store.consume(), (error: unknown) => (
    error instanceof TauriSolidVoxelClientError
    && error.kind === "protocol"
    && error.message.includes("expected 1")
  ));
  assert.deepEqual(released, [JOB_ID]);
  assert.equal(store.getSnapshot().phase, "failed");
  assert.equal(store.getSnapshot().result, null);
});

test("unchanged cursors are rejected before another page can be requested", async () => {
  const first = batch({ cursor: "same" });
  const second = batch({
    startChunkIndex: 1,
    first: false,
    cursor: "same",
    palette: undefined,
    chunks: [chunks[1]],
  });
  let pulls = 0;
  let releases = 0;
  const store = createNativeSolidVoxelResultStore(client({
    pullResultBatch: async () => {
      pulls += 1;
      return pulls === 1 ? first : second;
    },
    releaseJob: async jobId => {
      releases += 1;
      return { jobId, fullyReleased: true };
    },
  }), { jobId: JOB_ID, handle, manifest });

  await assert.rejects(store.consume(), /cursor is missing, repeated, or did not advance/);
  assert.equal(pulls, 2);
  assert.equal(releases, 1);
});

test("manifest numeric, palette, stats, block, and bounds facts are revalidated", async () => {
  const invalidManifests: SolidVoxelResultManifest[] = [
    { ...manifest, blockCount: Number.MAX_SAFE_INTEGER + 1 },
    { ...manifest, paletteSize: 3 },
    { ...manifest, surfaceBlockCount: 2 },
    { ...manifest, blockCount: 4, surfaceBlockCount: 4 },
    { ...manifest, bounds: { min: [-1, 0, 0], max: [2, 1, 1] }, dimensions: [4, 2, 2] },
  ];

  for (const invalid of invalidManifests) {
    let pageIndex = 0;
    let releases = 0;
    const source = pages();
    const store = createNativeSolidVoxelResultStore(client({
      pullResultBatch: async () => source[pageIndex++],
      releaseJob: async jobId => {
        releases += 1;
        return { jobId, fullyReleased: true };
      },
    }), { jobId: JOB_ID, handle, manifest: invalid });
    await assert.rejects(store.consume(), TauriSolidVoxelClientError);
    assert.equal(releases, 1);
    assert.equal(store.getSnapshot().phase, "failed");
  }
});

test("AbortSignal cancellation releases the native handle without requesting a batch", async () => {
  const controller = new AbortController();
  controller.abort();
  let pulls = 0;
  const calls: string[] = [];
  const store = createNativeSolidVoxelResultStore(client({
    pullResultBatch: async () => {
      pulls += 1;
      return pages()[0];
    },
    releaseJob: async jobId => {
      calls.push(`release:${jobId}`);
      return { jobId, fullyReleased: true };
    },
  }), { jobId: JOB_ID, handle, manifest });

  await assert.rejects(
    store.consume({ signal: controller.signal }),
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  );
  assert.equal(pulls, 0);
  assert.deepEqual(calls, [`release:${JOB_ID}`]);
  assert.equal(store.getSnapshot().phase, "cancelled");
});

test("cancel stops an in-flight pipeline and release remains idempotent", async () => {
  let resolvePage: ((value: SolidVoxelResultBatchEnvelope) => void) | undefined;
  const pendingPage = new Promise<SolidVoxelResultBatchEnvelope>(resolve => {
    resolvePage = resolve;
  });
  const calls: string[] = [];
  const store = createNativeSolidVoxelResultStore(client({
    pullResultBatch: async () => pendingPage,
    cancelJob: async jobId => {
      calls.push(`cancel:${jobId}`);
      return { jobId, cancellationRequested: true };
    },
    releaseJob: async jobId => {
      calls.push(`release:${jobId}`);
      return { jobId, fullyReleased: true };
    },
  }), { jobId: JOB_ID, handle, manifest });

  const consuming = store.consume();
  await store.cancel();
  await assert.rejects(
    consuming,
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  );
  resolvePage!(pages()[0]);
  await store.release();

  assert.deepEqual(calls, [`cancel:${JOB_ID}`, `release:${JOB_ID}`]);
  assert.equal(store.getSnapshot().phase, "released");
});

test("a completed materialization keeps ownership until explicit release", async () => {
  const source = pages();
  let releases = 0;
  const store = createNativeSolidVoxelResultStore(client({
    pullResultBatch: async () => source.shift()!,
    releaseJob: async jobId => {
      releases += 1;
      return { jobId, fullyReleased: true };
    },
  }), { jobId: JOB_ID, handle, manifest });

  await store.consume();
  assert.equal(releases, 0);
  await store.release();
  await store.release();
  assert.equal(releases, 1);
  assert.equal(store.getSnapshot().result, null);
  assert.equal(store.getSnapshot().phase, "released");
});

test("a failed release can be retried without losing native ownership", async () => {
  let releaseAttempts = 0;
  const store = createNativeSolidVoxelResultStore(client({
    releaseJob: async jobId => {
      releaseAttempts += 1;
      if (releaseAttempts === 1) throw new Error("transient release failure");
      return { jobId, fullyReleased: true };
    },
  }), { jobId: JOB_ID, handle, manifest });

  await assert.rejects(store.release(), /transient release failure/);
  assert.equal(store.getSnapshot().phase, "idle");
  await store.release();
  assert.equal(releaseAttempts, 2);
  assert.equal(store.getSnapshot().phase, "released");
});

test("an unsettled release keeps the result owned and can be retried", async () => {
  let releaseAttempts = 0;
  const store = createNativeSolidVoxelResultStore(client({
    releaseJob: async jobId => ({
      jobId,
      fullyReleased: ++releaseAttempts > 1,
    }),
  }), { jobId: JOB_ID, handle, manifest });

  await store.release();
  assert.notEqual(store.getSnapshot().phase, "released");
  await store.release();
  assert.equal(store.getSnapshot().phase, "released");
});
