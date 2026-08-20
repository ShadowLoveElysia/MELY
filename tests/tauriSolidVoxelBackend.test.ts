import assert from "node:assert/strict";
import test from "node:test";
import {
  SolidVoxelResultEnvelopeError,
  solidVoxelResultEnvelopeCrc32,
  SOLID_VOXEL_RESULT_BATCH_FLAG,
  SOLID_VOXEL_RESULT_BATCH_HEADER_SIZE,
  SOLID_VOXEL_RESULT_BATCH_MAGIC,
} from "../src/core/solidVoxelResultEnvelope";
import {
  CANCEL_SOLID_VOXEL_JOB_COMMAND,
  CREATE_SOLID_VOXEL_JOB_COMMAND,
  DEFAULT_SOLID_VOXEL_BATCH_BYTES,
  GET_SOLID_VOXEL_PREVIEW_COMMAND,
  MAX_SOLID_VOXEL_BATCH_BYTES,
  MAX_SOLID_VOXEL_PREVIEW_POINTS,
  MIN_SOLID_VOXEL_BATCH_BYTES,
  PULL_SOLID_VOXEL_CHUNKS_COMMAND,
  RELEASE_SOLID_VOXEL_JOB_COMMAND,
  SOLID_VOXEL_JOB_STATUS_COMMAND,
  TauriSolidVoxelClientError,
  UPLOAD_SOLID_VOXEL_SNAPSHOT_COMMAND,
  WRITE_SOLID_VOXEL_LITEMATIC_COMMAND,
  createTauriSolidVoxelClient,
  type TauriSolidVoxelTransport,
} from "../src/platform/tauriSolidVoxelBackend";

const JOB_ID = 9_007_199_254_740_993n;
const JOB_ID_TEXT = "9007199254740993";
const handle = { id: 7n, generation: 3n };
const handleDto = { id: "7", generation: "3" };
const execution = {
  backend: "native-rayon" as const,
  workerThreads: 8,
  recommendedThreads: 8,
  maximumThreads: 16,
  memorySuggestedThreads: null,
};
const jobOptions = {
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

const manifest = {
  blockCount: 4_064,
  surfaceBlockCount: 4_000,
  filledBlockCount: 64,
  skinBlockCount: 320,
  alphaRejected: 12,
  triangleBoxTests: 80_000,
  paletteSize: 16,
  dimensions: [1, 4_064, 1],
  bounds: { min: [0, -2_032, 0], max: [0, 2_031, 0] },
  chunkCount: 127,
};

const completedStatus = {
  jobId: JOB_ID_TEXT,
  workerThreads: 8,
  state: "completed",
  progress: { completedUnits: 100, totalUnits: 100, fraction: 1 },
  resultHandle: handleDto,
  manifest,
};

const transport = (overrides: Partial<TauriSolidVoxelTransport> = {}): TauriSolidVoxelTransport => ({
  invokeJson: async () => undefined,
  invokeRaw: async () => undefined,
  invokeRawResponse: async () => new Uint8Array(0),
  ...overrides,
});

const align8 = (value: number) => value + (8 - value % 8) % 8;
const textEncoder = new TextEncoder();

const resultBatchEnvelope = (options: {
  responseHandle?: typeof handle;
  cursor?: string | null;
  done?: boolean;
  startChunkIndex?: number;
} = {}) => {
  const responseHandle = options.responseHandle ?? handle;
  const done = options.done ?? true;
  const startChunkIndex = options.startChunkIndex ?? 0;
  const cursor = textEncoder.encode(options.cursor ?? "");
  const paletteId = textEncoder.encode("minecraft:stone");
  const paletteLogicalLength = 12 + paletteId.byteLength;
  const paletteByteLength = startChunkIndex === 0 ? align8(paletteLogicalLength) : 0;
  const chunkLogicalLength = 28;
  const chunkByteLength = align8(chunkLogicalLength);
  const paletteStart = align8(SOLID_VOXEL_RESULT_BATCH_HEADER_SIZE + cursor.byteLength);
  const totalLength = paletteStart + paletteByteLength + chunkByteLength;
  const bytes = new Uint8Array(totalLength);
  const view = new DataView(bytes.buffer);
  bytes.set(textEncoder.encode(SOLID_VOXEL_RESULT_BATCH_MAGIC));
  view.setUint16(8, 1, true);
  view.setUint16(10, SOLID_VOXEL_RESULT_BATCH_HEADER_SIZE, true);
  view.setUint32(
    12,
    (startChunkIndex === 0 ? SOLID_VOXEL_RESULT_BATCH_FLAG.first : 0)
      | (done ? SOLID_VOXEL_RESULT_BATCH_FLAG.last : 0),
    true,
  );
  view.setUint32(16, totalLength, true);
  view.setBigUint64(24, responseHandle.id, true);
  view.setBigUint64(32, responseHandle.generation, true);
  view.setBigUint64(40, BigInt(startChunkIndex), true);
  view.setUint32(48, 1, true);
  view.setUint32(52, startChunkIndex + (done ? 1 : 2), true);
  view.setUint32(56, 1, true);
  view.setUint32(60, paletteByteLength, true);
  view.setUint32(64, cursor.byteLength, true);
  bytes.set(cursor, SOLID_VOXEL_RESULT_BATCH_HEADER_SIZE);
  if (startChunkIndex === 0) {
    view.setUint32(paletteStart, paletteLogicalLength, true);
    view.setUint32(paletteStart + 4, paletteId.byteLength, true);
    bytes.set([125, 125, 125], paletteStart + 8);
    bytes.set(paletteId, paletteStart + 12);
  }
  const chunkStart = paletteStart + paletteByteLength;
  view.setUint32(chunkStart, chunkLogicalLength, true);
  view.setUint32(chunkStart + 16, 1, true);
  view.setUint16(chunkStart + 24, startChunkIndex, true);
  view.setUint16(chunkStart + 26, 0, true);
  view.setUint32(20, solidVoxelResultEnvelopeCrc32(bytes, true), true);
  return bytes;
};

const assertClientError = (
  expectedKind: TauriSolidVoxelClientError["kind"],
  expectedCommand?: string,
) => (error: unknown) => {
  assert.ok(error instanceof TauriSolidVoxelClientError);
  assert.equal(error.kind, expectedKind);
  if (expectedCommand) assert.equal(error.command, expectedCommand);
  return true;
};

test("create uses the exact command and preserves a u64 job id without Number precision loss", async () => {
  const calls: unknown[][] = [];
  const client = createTauriSolidVoxelClient(transport({
    invokeJson: async (...args) => {
      calls.push(args);
      return { jobId: JOB_ID_TEXT, workerThreads: 8 };
    },
  }));

  const result = await client.createJob({
    workerThreads: execution.workerThreads,
    options: jobOptions,
  });

  assert.deepEqual(result, { jobId: JOB_ID, workerThreads: 8 });
  assert.deepEqual(calls, [[CREATE_SOLID_VOXEL_JOB_COMMAND, {
    workerThreads: 8,
    options: jobOptions,
  }]]);
});

test("create freezes the selected thread snapshot and forwards every SolidOptions field", async () => {
  let args: Record<string, unknown> | undefined;
  const client = createTauriSolidVoxelClient(transport({
    invokeJson: async (_command, value) => {
      args = value;
      return { jobId: "1", workerThreads: 12 };
    },
  }));
  const fullOptions = {
    ...jobOptions,
    fillMode: "filled" as const,
    palettePreset: "balanced" as const,
    faceDetail: "strong" as const,
    materialTheme: "ancientRuins" as const,
    dithering: 72,
    emissiveMapping: false,
    emissiveMaterialIndices: [2, 9],
    ruinDecoration: 48,
    skinProtection: false,
    skinMaterialIndices: [1, 4],
    excludeGravity: false,
    excludeRare: false,
  };

  await client.createJob({
    workerThreads: 12,
    options: fullOptions,
  });

  assert.deepEqual(args, { workerThreads: 12, options: fullOptions });
  assert.deepEqual(Object.keys((args?.options ?? {}) as object).sort(), Object.keys(jobOptions).sort());
});

test("snapshot upload keeps the envelope as a top-level Uint8Array", async () => {
  const envelope = new Uint8Array([0x4d, 0x45, 0x4c, 0x59]);
  let rawCommand = "";
  let rawArgument: unknown;
  let jsonCalls = 0;
  const client = createTauriSolidVoxelClient(transport({
    invokeJson: async () => {
      jsonCalls += 1;
      throw new Error("upload must not use JSON transport");
    },
    invokeRaw: async (command, bytes) => {
      rawCommand = command;
      rawArgument = bytes;
      return { jobId: JOB_ID_TEXT, state: "running" };
    },
  }));

  assert.deepEqual(await client.uploadSnapshotEnvelope(JOB_ID, envelope), {
    jobId: JOB_ID,
    state: "running",
  });
  assert.equal(rawCommand, UPLOAD_SOLID_VOXEL_SNAPSHOT_COMMAND);
  assert.equal(rawArgument, envelope);
  assert.ok(rawArgument instanceof Uint8Array);
  assert.equal(jsonCalls, 0);
});

test("status, cancel and release use decimal job ids and reject mismatched responses", async () => {
  const calls: unknown[][] = [];
  const responses = [
    completedStatus,
    { jobId: JOB_ID_TEXT, cancellationRequested: true },
    { jobId: JOB_ID_TEXT, fullyReleased: true },
  ];
  const client = createTauriSolidVoxelClient(transport({
    invokeJson: async (...args) => {
      calls.push(args);
      return responses.shift();
    },
  }));

  const status = await client.getJobStatus(JOB_ID);
  assert.equal(status.jobId, JOB_ID);
  assert.deepEqual(status.resultHandle, handle);
  assert.deepEqual(status.manifest, manifest);
  assert.deepEqual(await client.cancelJob(JOB_ID), {
    jobId: JOB_ID,
    cancellationRequested: true,
  });
  assert.deepEqual(await client.releaseJob(JOB_ID), {
    jobId: JOB_ID,
    fullyReleased: true,
  });
  assert.deepEqual(calls, [
    [SOLID_VOXEL_JOB_STATUS_COMMAND, { jobId: JOB_ID_TEXT }],
    [CANCEL_SOLID_VOXEL_JOB_COMMAND, { jobId: JOB_ID_TEXT }],
    [RELEASE_SOLID_VOXEL_JOB_COMMAND, { jobId: JOB_ID_TEXT }],
  ]);

  const mismatch = createTauriSolidVoxelClient(transport({
    invokeJson: async () => ({ ...completedStatus, jobId: "1" }),
  }));
  await assert.rejects(
    mismatch.getJobStatus(JOB_ID),
    assertClientError("protocol", SOLID_VOXEL_JOB_STATUS_COMMAND),
  );

  for (const invalidReceipt of [
    undefined,
    { jobId: "1", fullyReleased: true },
    { jobId: JOB_ID_TEXT },
    { jobId: JOB_ID_TEXT, fullyReleased: "yes" },
  ]) {
    const invalidRelease = createTauriSolidVoxelClient(transport({
      invokeJson: async () => invalidReceipt,
    }));
    await assert.rejects(
      invalidRelease.releaseJob(JOB_ID),
      assertClientError("protocol", RELEASE_SOLID_VOXEL_JOB_COMMAND),
    );
  }
});

test("status rejects incomplete terminal states, unknown states and invalid finite data", async () => {
  const invalidResponses = [
    { ...completedStatus, resultHandle: undefined },
    { ...completedStatus, manifest: undefined },
    {
      ...completedStatus,
      state: "failed",
      resultHandle: undefined,
      manifest: undefined,
      error: undefined,
    },
    { ...completedStatus, state: "paused" },
    {
      ...completedStatus,
      progress: { completedUnits: 1, totalUnits: 2, fraction: Number.NaN },
    },
    {
      ...completedStatus,
      manifest: { ...manifest, bounds: { min: [0, 0, 0], max: [0, 1, 0] } },
    },
    { ...completedStatus, manifest: { ...manifest, chunkCount: -1 } },
    { ...completedStatus, manifest: { ...manifest, chunks: [] } },
  ];

  for (const response of invalidResponses) {
    const client = createTauriSolidVoxelClient(transport({
      invokeJson: async () => response,
    }));
    await assert.rejects(
      client.getJobStatus(JOB_ID),
      assertClientError("protocol", SOLID_VOXEL_JOB_STATUS_COMMAND),
    );
  }
});

test("native failure metadata is retained while transport and protocol failures remain distinct", async () => {
  const nativeError = {
    code: "OUT_OF_MEMORY",
    category: "internal",
    retryable: true,
    message: "allocation failed",
  } as const;
  const nativeClient = createTauriSolidVoxelClient(transport({
    invokeJson: async () => ({
      jobId: JOB_ID_TEXT,
      workerThreads: 8,
      state: "failed",
      progress: { completedUnits: 40, totalUnits: 100, fraction: 0.4 },
      error: nativeError,
    }),
  }));
  const status = await nativeClient.getJobStatus(JOB_ID);
  assert.deepEqual(status.error, nativeError);

  const transportClient = createTauriSolidVoxelClient(transport({
    invokeJson: async () => { throw new Error("ipc down"); },
  }));
  await assert.rejects(
    transportClient.getJobStatus(JOB_ID),
    assertClientError("transport", SOLID_VOXEL_JOB_STATUS_COMMAND),
  );

  const protocolClient = createTauriSolidVoxelClient(transport({
    invokeJson: async () => ({ jobId: JOB_ID_TEXT }),
  }));
  await assert.rejects(
    protocolClient.getJobStatus(JOB_ID),
    assertClientError("protocol", SOLID_VOXEL_JOB_STATUS_COMMAND),
  );
});

test("awaiting-upload accepts Rust's null fraction only when no work units exist", async () => {
  const client = createTauriSolidVoxelClient(transport({
    invokeJson: async () => ({
      jobId: JOB_ID_TEXT,
      workerThreads: 8,
      state: "awaitingUpload",
      progress: { completedUnits: 0, totalUnits: 0, fraction: null },
    }),
  }));
  const status = await client.getJobStatus(JOB_ID);
  assert.equal(status.progress.fraction, 0);

  const invalid = createTauriSolidVoxelClient(transport({
    invokeJson: async () => ({
      jobId: JOB_ID_TEXT,
      workerThreads: 8,
      state: "running",
      progress: { completedUnits: 0, totalUnits: 1, fraction: null },
    }),
  }));
  await assert.rejects(
    invalid.getJobStatus(JOB_ID),
    assertClientError("protocol", SOLID_VOXEL_JOB_STATUS_COMMAND),
  );
});

test("limited preview enforces the 200k point ceiling and explicit truncation metadata", async () => {
  const calls: unknown[][] = [];
  const client = createTauriSolidVoxelClient(transport({
    invokeJson: async (...args) => {
      calls.push(args);
      return {
        handle: handleDto,
        points: [[0, -2_032, 0], [0, 2_031, 0]],
        blockIndices: [0, 1],
        totalPoints: 4_064,
        truncated: true,
      };
    },
  }));

  const preview = await client.getLimitedPreview(handle, 2);
  assert.equal(preview.points.length, 2);
  assert.equal(preview.totalPoints, 4_064);
  assert.equal(preview.truncated, true);
  assert.deepEqual(calls, [[GET_SOLID_VOXEL_PREVIEW_COMMAND, {
    handle: handleDto,
    maxPoints: 2,
  }]]);
  await assert.rejects(
    client.getLimitedPreview(handle, MAX_SOLID_VOXEL_PREVIEW_POINTS + 1),
    assertClientError("protocol", GET_SOLID_VOXEL_PREVIEW_COMMAND),
  );

  const inconsistent = createTauriSolidVoxelClient(transport({
    invokeJson: async () => ({
      handle: handleDto,
      points: [[0, 0, 0]],
      blockIndices: [0],
      totalPoints: 2,
      truncated: false,
    }),
  }));
  await assert.rejects(
    inconsistent.getLimitedPreview(handle, 1),
    assertClientError("protocol", GET_SOLID_VOXEL_PREVIEW_COMMAND),
  );
});

test("chunk batches use only raw-response transport and enforce 8-32 MiB backpressure", async () => {
  const bytes = resultBatchEnvelope();
  let rawResponseCall: unknown[] | null = null;
  let jsonCalls = 0;
  const client = createTauriSolidVoxelClient(transport({
    invokeJson: async () => {
      jsonCalls += 1;
      throw new Error("batch must not use JSON transport");
    },
    invokeRawResponse: async (...args) => {
      rawResponseCall = args;
      return bytes;
    },
  }));

  const batch = await client.pullResultBatch(handle);
  assert.deepEqual(batch.handle, handle);
  assert.equal(batch.first, true);
  assert.equal(batch.done, true);
  assert.equal(batch.cursor, null);
  assert.deepEqual(batch.palette, [{ blockId: "minecraft:stone", color: [125, 125, 125] }]);
  assert.deepEqual([...batch.chunks[0].positions], [0]);
  assert.equal(jsonCalls, 0);
  assert.deepEqual(rawResponseCall, [PULL_SOLID_VOXEL_CHUNKS_COMMAND, {
    handle: handleDto,
    maxBytes: DEFAULT_SOLID_VOXEL_BATCH_BYTES,
  }]);
  await assert.rejects(
    client.pullResultBatch(handle, { maxBytes: MIN_SOLID_VOXEL_BATCH_BYTES - 1 }),
    assertClientError("protocol", PULL_SOLID_VOXEL_CHUNKS_COMMAND),
  );
  await assert.rejects(
    client.pullResultBatch(handle, { maxBytes: MAX_SOLID_VOXEL_BATCH_BYTES + 1 }),
    assertClientError("protocol", PULL_SOLID_VOXEL_CHUNKS_COMMAND),
  );

  const jsonArrayClient = createTauriSolidVoxelClient(transport({
    invokeRawResponse: async () => ({
      handle: handleDto,
      bytes: [1, 2, 3],
      cursor: null,
      done: true,
    } as unknown as Uint8Array),
  }));
  await assert.rejects(
    jsonArrayClient.pullResultBatch(handle),
    assertClientError("protocol", PULL_SOLID_VOXEL_CHUNKS_COMMAND),
  );
});

test("stale handles and oversized raw responses are rejected", async () => {
  const stale = createTauriSolidVoxelClient(transport({
    invokeRawResponse: async () => resultBatchEnvelope({
      responseHandle: { ...handle, generation: 4n },
    }),
  }));
  await assert.rejects(
    stale.pullResultBatch(handle),
    assertClientError("protocol", PULL_SOLID_VOXEL_CHUNKS_COMMAND),
  );

  const oversized = createTauriSolidVoxelClient(transport({
    invokeRawResponse: async () => new Uint8Array(MIN_SOLID_VOXEL_BATCH_BYTES + 1),
  }));
  await assert.rejects(
    oversized.pullResultBatch(handle, { maxBytes: MIN_SOLID_VOXEL_BATCH_BYTES }),
    assertClientError("protocol", PULL_SOLID_VOXEL_CHUNKS_COMMAND),
  );
});

test("chunk batches decode opaque cursors and bind FIRST to initial versus continuation requests", async () => {
  const first = createTauriSolidVoxelClient(transport({
    invokeRawResponse: async () => resultBatchEnvelope({ cursor: "opaque.signature", done: false }),
  }));
  const firstBatch = await first.pullResultBatch(handle);
  assert.equal(firstBatch.cursor, "opaque.signature");
  assert.equal(firstBatch.done, false);

  const continuation = createTauriSolidVoxelClient(transport({
    invokeRawResponse: async () => resultBatchEnvelope({
      startChunkIndex: 1,
      done: true,
    }),
  }));
  const finalBatch = await continuation.pullResultBatch(handle, { cursor: "opaque.signature" });
  assert.equal(finalBatch.first, false);
  assert.equal(finalBatch.done, true);

  await assert.rejects(
    continuation.pullResultBatch(handle),
    assertClientError("protocol", PULL_SOLID_VOXEL_CHUNKS_COMMAND),
  );
});

test("chunk batch decoder failures are surfaced as protocol errors", async () => {
  const damaged = resultBatchEnvelope();
  damaged[damaged.length - 1] ^= 1;
  const client = createTauriSolidVoxelClient(transport({
    invokeRawResponse: async () => damaged,
  }));

  await assert.rejects(
    client.pullResultBatch(handle),
    (error: unknown) => {
      assertClientError("protocol", PULL_SOLID_VOXEL_CHUNKS_COMMAND)(error);
      assert.ok(error instanceof TauriSolidVoxelClientError);
      assert.match(error.message, /invalid batch envelope \(checksum-mismatch\)/i);
      assert.ok(error.cause instanceof SolidVoxelResultEnvelopeError);
      assert.equal(error.cause.code, "checksum-mismatch");
      return true;
    },
  );
});

test("native Litematic writing is capability gated and carries only handle/path/export safety data", async () => {
  const request = {
    handle,
    outputPath: "C:\\exports\\mely-4064.litematic",
    overwriteExisting: true,
    name: "MELY 4064",
    regionMaxSize: 32,
    safety: {
      heightMode: "experimental_4064" as const,
      targetHeight: 4_064,
      targetDimension: { minY: -2_032, height: 4_064 },
      placementBottomY: -2_032,
      targetMinecraftVersion: "1.20.1",
      serializerMinecraftVersion: "1.20.1",
      dataVersion: 3_465,
      formatVersion: 6,
      subVersion: 1,
    },
  };
  const unavailable = createTauriSolidVoxelClient(transport());
  await assert.rejects(
    unavailable.writeLitematic(request),
    assertClientError("runtime-unavailable", WRITE_SOLID_VOXEL_LITEMATIC_COMMAND),
  );

  let call: unknown[] | null = null;
  const available = createTauriSolidVoxelClient(transport({
    invokeJson: async (...args) => {
      call = args;
      return {
        outputPath: request.outputPath,
        byteLength: 12_345,
        blockCount: 4_064,
        regionCount: 127,
        paletteSize: 16,
        dimensions: [1, 4_064, 1],
        dataVersion: 3_465,
      };
    },
  }), { writeLitematic: true });
  const summary = await available.writeLitematic(request);
  assert.equal(summary.outputPath, request.outputPath);
  assert.equal(summary.blockCount, 4_064);
  assert.deepEqual(call, [WRITE_SOLID_VOXEL_LITEMATIC_COMMAND, {
    ...request,
    handle: handleDto,
  }]);
  assert.doesNotMatch(JSON.stringify(call), /chunks|positions|blockIndices|projectionDocument/i);
});
