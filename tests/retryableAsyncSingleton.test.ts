import assert from "node:assert/strict";
import test from "node:test";
import { createRetryableAsyncSingleton } from "../src/core/retryableAsyncSingleton";

test("retryable async singleton shares success and rotates after rejection", async () => {
  let attempts = 0;
  let rejectFirst: ((reason: Error) => void) | null = null;
  const load = createRetryableAsyncSingleton(async () => {
    attempts += 1;
    if (attempts === 1) {
      await new Promise<never>((_resolve, reject) => { rejectFirst = reject; });
    }
    return { attempt: attempts };
  });

  const first = load();
  const concurrent = load();
  assert.equal(first, concurrent);
  assert.equal(attempts, 0);
  await Promise.resolve();
  assert.equal(attempts, 1);
  rejectFirst?.(new Error("initialization failed"));
  await assert.rejects(first, /initialization failed/);

  const retry = load();
  const retryConcurrent = load();
  assert.equal(retry, retryConcurrent);
  assert.notEqual(retry, first);
  assert.deepEqual(await retry, { attempt: 2 });
  assert.equal(await load(), await retry);
  assert.equal(attempts, 2);
});
