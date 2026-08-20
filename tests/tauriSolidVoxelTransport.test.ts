import assert from "node:assert/strict";
import test from "node:test";
import {
  TauriSolidVoxelClientError,
  createDefaultTauriSolidVoxelTransport,
  createTauriSolidVoxelTransport,
  type TauriSolidVoxelCoreApi,
} from "../src/platform/tauriSolidVoxelTransport";

const coreApi = (
  invoke: TauriSolidVoxelCoreApi["invoke"],
  isTauri = true,
): TauriSolidVoxelCoreApi => ({ isTauri: () => isTauri, invoke });

test("production transport keeps JSON arguments and raw request bytes on separate invoke paths", async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const core = coreApi(async (command, args) => {
    calls.push({ command, args });
    return { accepted: true } as never;
  });
  const transport = createTauriSolidVoxelTransport(core);
  const jsonArgs = { workerThreads: 8, options: { targetHeight: 4_064 } };
  const snapshot = new Uint8Array([0x4d, 0x4c, 0x59, 0x53]);

  await transport.invokeJson("create_solid_voxel_job", jsonArgs);
  await transport.invokeRaw("upload_solid_voxel_snapshot", snapshot);

  assert.deepEqual(calls, [
    { command: "create_solid_voxel_job", args: jsonArgs },
    { command: "upload_solid_voxel_snapshot", args: snapshot },
  ]);
  assert.equal(calls[1]?.args, snapshot);
  assert.ok(calls[1]?.args instanceof Uint8Array);
});

test("raw-response transport normalizes Tauri ArrayBuffer envelopes to Uint8Array", async () => {
  const envelope = new Uint8Array([0x4d, 0x4c, 0x59, 0x52]);
  const args = { handle: { id: "7", generation: "3" }, maxBytes: 8 * 1024 * 1024 };
  const calls: Array<{ command: string; args: unknown }> = [];
  const transport = createTauriSolidVoxelTransport(coreApi(async (command, value) => {
    calls.push({ command, args: value });
    return envelope as never;
  }));

  const response = await transport.invokeRawResponse("pull_solid_voxel_chunks", args);

  assert.equal(response, envelope);
  assert.deepEqual(calls, [{ command: "pull_solid_voxel_chunks", args }]);

  const arrayBufferTransport = createTauriSolidVoxelTransport(coreApi(async () => (
    envelope.buffer.slice(envelope.byteOffset, envelope.byteOffset + envelope.byteLength) as never
  )));
  const normalized = await arrayBufferTransport.invokeRawResponse("pull_solid_voxel_chunks", args);
  assert.ok(normalized instanceof Uint8Array);
  assert.deepEqual([...normalized], [...envelope]);
});

test("raw-response transport fails closed instead of fabricating metadata plus bytes", async () => {
  const invalidResponses: unknown[] = [
    { bytes: new Uint8Array([1]), cursor: "opaque", done: false },
    [1, 2, 3],
    null,
  ];

  for (const response of invalidResponses) {
    const transport = createTauriSolidVoxelTransport(coreApi(async () => response as never));
    await assert.rejects(
      transport.invokeRawResponse("pull_solid_voxel_chunks", {}),
      (error: unknown) => {
        assert.ok(error instanceof TauriSolidVoxelClientError);
        assert.equal(error.kind, "protocol");
        assert.equal(error.command, "pull_solid_voxel_chunks");
        assert.match(error.message, /top-level byte buffer/);
        assert.match(error.message, /metadata.*binary envelope/);
        return true;
      },
    );
  }
});

test("default transport checks Tauri runtime and keeps loader failures typed", async () => {
  await assert.rejects(
    createDefaultTauriSolidVoxelTransport(async () => coreApi(async () => undefined as never, false)),
    (error: unknown) => {
      assert.ok(error instanceof TauriSolidVoxelClientError);
      assert.equal(error.kind, "runtime-unavailable");
      return true;
    },
  );

  const loaderFailure = new Error("module unavailable");
  await assert.rejects(
    createDefaultTauriSolidVoxelTransport(async () => { throw loaderFailure; }),
    (error: unknown) => {
      assert.ok(error instanceof TauriSolidVoxelClientError);
      assert.equal(error.kind, "runtime-unavailable");
      assert.equal(error.cause, loaderFailure);
      return true;
    },
  );
});
