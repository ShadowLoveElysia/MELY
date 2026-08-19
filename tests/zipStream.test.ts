import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { unzipSync } from "fflate";
import { AppError } from "../src/core/appError";
import {
  MAX_ZIP32_ENTRIES,
  MAX_ZIP32_NAME_BYTES,
  MAX_ZIP32_VALUE,
  assertZip32Entry,
  combineZipChunks,
  createZipCollector,
  createZipStreamWriter,
} from "../src/core/zipStream";

const deterministicBytes = (length: number) => {
  const bytes = new Uint8Array(length);
  let state = 0x6d2b79f5;
  for (let index = 0; index < bytes.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 0xff;
  }
  return bytes;
};

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const deferred = () => {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve?.() };
};

test("streamed ZIP preserves a multi-chunk entry without detaching its source buffer", async () => {
  const source = deterministicBytes(3 * 1024 * 1024 + 137);
  const sourceHash = sha256(source);
  const output: Uint8Array[] = [];
  let outputBytes = 0;
  const writer = createZipStreamWriter((chunk) => {
    output.push(chunk);
    outputBytes += chunk.byteLength;
  });

  await writer.add("payload.bin", source, true);
  const summary = await writer.close();
  const archive = combineZipChunks(output, outputBytes);
  const restored = unzipSync(archive)["payload.bin"];

  assert.ok(restored);
  assert.equal(source.byteLength, 3 * 1024 * 1024 + 137);
  assert.equal(sha256(source), sourceHash);
  assert.equal(sha256(restored), sourceHash);
  assert.equal(Buffer.compare(Buffer.from(restored), Buffer.from(source)), 0);
  assert.equal(summary.bytesWritten, archive.byteLength);
  assert.equal(summary.fileCount, 1);
  assert.ok(writer.diagnostics.inputChunksPushed > 2);
  assert.ok(
    writer.diagnostics.peakInputBytesInFlight <= writer.diagnostics.inputChunkBytes,
  );
  assert.equal(writer.diagnostics.pendingInputBytes, 0);
  assert.equal(writer.diagnostics.pendingOutputChunks, 0);
});

test("slow ZIP sinks keep input and output queues bounded", async () => {
  const source = deterministicBytes(2 * 1024 * 1024 + 17);
  const output: Uint8Array[] = [];
  let outputBytes = 0;
  let activeSinks = 0;
  let peakActiveSinks = 0;
  const writer = createZipStreamWriter(async (chunk) => {
    activeSinks += 1;
    peakActiveSinks = Math.max(peakActiveSinks, activeSinks);
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
    output.push(chunk.slice());
    outputBytes += chunk.byteLength;
    activeSinks -= 1;
  }, { inputChunkBytes: 64 * 1024 });

  await writer.add("slow.bin", source, true);
  await writer.close();
  const restored = unzipSync(combineZipChunks(output, outputBytes))["slow.bin"];

  assert.equal(Buffer.compare(Buffer.from(restored), Buffer.from(source)), 0);
  assert.equal(peakActiveSinks, 1);
  assert.equal(writer.diagnostics.peakInputBytesInFlight, 64 * 1024);
  assert.ok(writer.diagnostics.peakPendingOutputChunks <= 3);
  assert.ok(writer.diagnostics.peakPendingOutputBytes <= 2 * 64 * 1024);
  assert.equal(writer.diagnostics.pendingInputBytes, 0);
  assert.equal(writer.diagnostics.pendingOutputChunks, 0);
  assert.equal(writer.diagnostics.pendingOutputBytes, 0);
});

test("AbortSignal interrupts compression without waiting for a blocked sink", async () => {
  const controller = new AbortController();
  const sinkStarted = deferred();
  const releaseSink = deferred();
  const writer = createZipStreamWriter(async () => {
    sinkStarted.resolve();
    await releaseSink.promise;
  }, { signal: controller.signal, inputChunkBytes: 64 * 1024 });
  const adding = writer.add("cancel.bin", deterministicBytes(4 * 1024 * 1024), true);
  await sinkStarted.promise;

  controller.abort(new Error("cancelled during ZIP test"));
  await assert.rejects(
    Promise.race([
      adding,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("ZIP cancellation timed out")), 500);
      }),
    ]),
    /cancelled during ZIP test/,
  );
  releaseSink.resolve();
  await assert.rejects(writer.close(), /cancelled during ZIP test/);
});

test("ZIP output budget rejects before an oversized chunk reaches the sink", async () => {
  let sinkCalls = 0;
  const writer = createZipStreamWriter(() => {
    sinkCalls += 1;
  }, { maxOutputBytes: 1 });

  await assert.rejects(writer.add("budget.bin", new Uint8Array([1, 2, 3]), true), (
    error: unknown,
  ) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, "error.export.bundleOutput");
    return true;
  });
  assert.equal(sinkCalls, 0);
  await assert.rejects(writer.close(), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, "error.export.bundleOutput");
    return true;
  });
});

test("ZIP32 structural limits accept exact maxima and reject the next value", () => {
  assert.doesNotThrow(() => assertZip32Entry(
    {
      entryCount: MAX_ZIP32_ENTRIES - 1,
      localOffset: 0,
      centralDirectorySize: 0,
    },
    {
      nameBytes: 0,
      uncompressedSize: MAX_ZIP32_VALUE,
      compressedSize: 0,
    },
  ));
  assert.throws(() => assertZip32Entry(
    { entryCount: MAX_ZIP32_ENTRIES, localOffset: 0, centralDirectorySize: 0 },
    { nameBytes: 0, uncompressedSize: 0, compressedSize: 0 },
  ), /ZIP32 entry count 65536 exceeds maximum 65535/);
  assert.throws(() => assertZip32Entry(
    { entryCount: 0, localOffset: 0, centralDirectorySize: 0 },
    { nameBytes: MAX_ZIP32_NAME_BYTES + 1, uncompressedSize: 0, compressedSize: 0 },
  ), /UTF-8 filename length 65536 exceeds maximum 65535/);
  assert.throws(() => assertZip32Entry(
    { entryCount: 0, localOffset: 0, centralDirectorySize: 0 },
    { nameBytes: 0, uncompressedSize: MAX_ZIP32_VALUE + 1, compressedSize: 0 },
  ), /uncompressed entry size 4294967296 exceeds maximum 4294967295/);
  assert.throws(() => assertZip32Entry(
    { entryCount: 0, localOffset: 0, centralDirectorySize: 0 },
    { nameBytes: 0, uncompressedSize: 0, compressedSize: MAX_ZIP32_VALUE + 1 },
  ), /compressed entry size 4294967296 exceeds maximum 4294967295/);
});

test("ZIP32 validates local offsets and central directory arithmetic without allocating 4 GiB", () => {
  assert.throws(() => assertZip32Entry(
    {
      entryCount: 0,
      localOffset: MAX_ZIP32_VALUE - 10,
      centralDirectorySize: 0,
    },
    { nameBytes: 1, uncompressedSize: 0, compressedSize: 0 },
  ), /local data offset/);
  assert.throws(() => assertZip32Entry(
    {
      entryCount: 0,
      localOffset: 0,
      centralDirectorySize: MAX_ZIP32_VALUE - 10,
    },
    { nameBytes: 1, uncompressedSize: 0, compressedSize: 0 },
  ), /central directory size/);
  assert.throws(() => assertZip32Entry(
    {
      entryCount: 0,
      localOffset: MAX_ZIP32_VALUE - 150,
      centralDirectorySize: 100,
    },
    { nameBytes: 1, uncompressedSize: 0, compressedSize: 0 },
  ), /central directory offset/);
});

test("stream and collector apply injected ZIP32 entry boundaries before large allocations", async () => {
  let sinkCalls = 0;
  const writer = createZipStreamWriter(() => {
    sinkCalls += 1;
  }, {
    zip32TestState: { entryCount: MAX_ZIP32_ENTRIES },
  });
  await assert.rejects(writer.add("entry.txt", new Uint8Array(0)), /entry count/);
  assert.equal(sinkCalls, 0);

  const collector = createZipCollector({
    zip32TestState: { entryUncompressedSize: MAX_ZIP32_VALUE + 1 },
  });
  assert.throws(
    () => collector.add("entry.txt", new Uint8Array(0)),
    /uncompressed entry size/,
  );
});

test("ZIP32 filename limit counts UTF-8 bytes rather than JavaScript code units", async () => {
  const path = "猫".repeat(Math.floor(MAX_ZIP32_NAME_BYTES / 3) + 1);
  assert.ok(path.length < MAX_ZIP32_NAME_BYTES);
  const writer = createZipStreamWriter(() => undefined);

  await assert.rejects(writer.add(path, new Uint8Array(0)), /UTF-8 filename length/);
});
