import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError } from "../src/core/appError";
import {
  openDesktopChunkWriter,
  saveBytesToSelectedPath,
} from "../src/platform/desktop";

test("desktop save cancellation returns false without writing", async () => {
  let writes = 0;
  const saved = await saveBytesToSelectedPath(
    new Uint8Array([1, 2, 3]),
    { defaultPath: "pose.json" },
    async () => null,
    async () => {
      writes += 1;
    },
  );

  assert.equal(saved, false);
  assert.equal(writes, 0);
});

test("desktop save writes the selected path once and returns true", async () => {
  const bytes = new Uint8Array([4, 5, 6]);
  const writes: Array<{ path: string; bytes: Uint8Array }> = [];
  const saved = await saveBytesToSelectedPath(
    bytes,
    {
      defaultPath: "MELY.pose.json",
      filters: [{ name: "Pose JSON", extensions: ["json"] }],
    },
    async (options) => {
      assert.equal(options.defaultPath, "MELY.pose.json");
      return "C:\\Exports\\MELY.pose.json";
    },
    async (path, output) => {
      writes.push({ path, bytes: output });
    },
  );

  assert.equal(saved, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.path, "C:\\Exports\\MELY.pose.json");
  assert.equal(writes[0]?.bytes, bytes);
});

test("desktop chunk writer cancels before opening a file", async () => {
  let opens = 0;
  const writer = await openDesktopChunkWriter(
    { defaultPath: "project.zip" },
    async () => null,
    async () => {
      opens += 1;
      throw new Error("must not open");
    },
  );

  assert.equal(writer, null);
  assert.equal(opens, 0);
});

test("desktop chunk writer preserves sequential ZIP output and closes once", async () => {
  const writes: number[][] = [];
  let closes = 0;
  const writer = await openDesktopChunkWriter(
    { defaultPath: "project.zip" },
    async () => "C:\\Exports\\project.zip",
    async (path) => {
      assert.equal(path, "C:\\Exports\\project.zip");
      return {
        write: async (chunk: Uint8Array) => {
          writes.push([...chunk]);
          return chunk.byteLength;
        },
        close: async () => {
          closes += 1;
        },
      } as never;
    },
  );
  assert.ok(writer);

  await Promise.all([
    writer.write(Uint8Array.from([1, 2])),
    writer.write(Uint8Array.from([3, 4, 5])),
  ]);
  await writer.close();
  await writer.close();

  assert.deepEqual(writes, [[1, 2], [3, 4, 5]]);
  assert.equal(closes, 1);
});

test("desktop chunk writer rejects partial native writes", async () => {
  let closes = 0;
  const writer = await openDesktopChunkWriter(
    {},
    async () => "C:\\Exports\\partial.zip",
    async () => ({
      write: async () => 1,
      close: async () => {
        closes += 1;
      },
    }) as never,
  );
  assert.ok(writer);

  await assert.rejects(writer.write(Uint8Array.from([1, 2])), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, "error.desktop.incompleteWrite");
    assert.deepEqual(error.params, { written: 1, expected: 2 });
    return true;
  });
  await writer.abort();
  assert.equal(closes, 1);
});

test("desktop save wraps picker and write failures without exposing native messages", async () => {
  await assert.rejects(saveBytesToSelectedPath(
    new Uint8Array([1]),
    {},
    async () => {
      throw new Error("native picker failure");
    },
    async () => undefined,
  ), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, "error.desktop.selectSavePath");
    assert.equal((error.cause as Error).message, "native picker failure");
    return true;
  });

  await assert.rejects(saveBytesToSelectedPath(
    new Uint8Array([1]),
    {},
    async () => "C:\\Exports\\failed.bin",
    async () => {
      throw new Error("native write failure");
    },
  ), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, "error.desktop.writeFile");
    assert.equal((error.cause as Error).message, "native write failure");
    return true;
  });
});

test("desktop chunk writer wraps file-open failures", async () => {
  await assert.rejects(openDesktopChunkWriter(
    {},
    async () => "C:\\Exports\\failed.zip",
    async () => {
      throw new Error("native open failure");
    },
  ), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, "error.desktop.openFile");
    assert.equal((error.cause as Error).message, "native open failure");
    return true;
  });
});

test("desktop chunk writer wraps native write and close failures", async () => {
  const writeFailure = await openDesktopChunkWriter(
    {},
    async () => "C:\\Exports\\write-failed.zip",
    async () => ({
      write: async () => {
        throw new Error("native stream write failure");
      },
      close: async () => undefined,
    }) as never,
  );
  assert.ok(writeFailure);
  await assert.rejects(writeFailure.write(Uint8Array.of(1)), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, "error.desktop.writeFile");
    assert.equal((error.cause as Error).message, "native stream write failure");
    return true;
  });
  await writeFailure.abort();

  const closeFailure = await openDesktopChunkWriter(
    {},
    async () => "C:\\Exports\\close-failed.zip",
    async () => ({
      write: async (chunk: Uint8Array) => chunk.byteLength,
      close: async () => {
        throw new Error("native stream close failure");
      },
    }) as never,
  );
  assert.ok(closeFailure);
  await closeFailure.write(Uint8Array.of(1));
  await assert.rejects(closeFailure.close(), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, "error.desktop.closeFile");
    assert.equal((error.cause as Error).message, "native stream close failure");
    return true;
  });
});
