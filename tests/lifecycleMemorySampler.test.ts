import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  RECOVERY_RATIO_LIMIT,
  isRecoveryRatioWithinLimit,
  retryOperation,
  serializeError,
} = require("../scripts/verify-lifecycle-memory.cjs") as {
  RECOVERY_RATIO_LIMIT: number;
  isRecoveryRatioWithinLimit: (ratio: number, limit?: number) => boolean;
  retryOperation: <T>(
    operation: (attempt: number) => Promise<T>,
    options?: {
      maxAttempts?: number;
      retryDelayMs?: number;
      delayFn?: (milliseconds: number) => Promise<void>;
      onFailure?: (failure: { attempt: number; maxAttempts: number; error: unknown }) => void;
    },
  ) => Promise<{
    value: T;
    attempts: number;
    failures: Array<{ attempt: number; maxAttempts: number; error: unknown }>;
  }>;
  serializeError: (error: unknown) => { name: string; message: string; code?: string };
};

test("lifecycle recovery ratio enforces the R1 1.2 hard limit", () => {
  assert.equal(RECOVERY_RATIO_LIMIT, 1.2);
  assert.equal(isRecoveryRatioWithinLimit(1), true);
  assert.equal(isRecoveryRatioWithinLimit(1.2), true);
  assert.equal(isRecoveryRatioWithinLimit(1.200001), false);
  assert.equal(isRecoveryRatioWithinLimit(Number.NaN), false);
  assert.equal(isRecoveryRatioWithinLimit(Number.POSITIVE_INFINITY), false);
});

test("the lifecycle release report includes recovery ratio in its hard assertions", () => {
  const source = readFileSync("scripts/verify-lifecycle-memory.cjs", "utf8");

  assert.match(source, /recoveryRatioLimit: RECOVERY_RATIO_LIMIT/);
  assert.match(source, /report\.recoveryRatioWithinLimit = isRecoveryRatioWithinLimit/);
  assert.match(source, /assertions = \{[\s\S]*recoveryRatioWithinLimit: report\.recoveryRatioWithinLimit/);
  assert.match(source, /Object\.values\(report\.assertions\)\.every\(Boolean\)/);
});

test("release memory gates treat up to five GiB as safe", () => {
  const lifecycle = readFileSync("scripts/verify-lifecycle-memory.cjs", "utf8");
  const art = readFileSync("scripts/verify-art-e2e.cjs", "utf8");
  const generation = readFileSync("scripts/verify-generation.cjs", "utf8");
  const workload = readFileSync("scripts/verify-release-workload.cjs", "utf8");
  const sources = [lifecycle, art, generation, workload];

  for (const source of sources) {
    assert.match(source, /const FIVE_GIB = 5 \* 1024 \*\* 3;/);
    assert.doesNotMatch(source, /TWO_GIB|underTwoGiB|exceeded 2 GiB/);
  }
  assert.match(lifecycle, /memoryLimitBytes: FIVE_GIB/);
  assert.match(lifecycle, /peakWorkingSetBytes <= FIVE_GIB/);
  assert.match(lifecycle, /withinFiveGiB: report\.withinFiveGiB/);
  assert.match(art, /peakWorkingSetBytes <= FIVE_GIB/);
  assert.match(generation, /workingSet > FIVE_GIB/);
  assert.match(workload, /peakWorkingSetBytes <= FIVE_GIB/);
});

test("measurement retries recover from bounded transient failures", async () => {
  const attempts: number[] = [];
  const delays: number[] = [];
  const failures: number[] = [];

  const result = await retryOperation(async (attempt) => {
    attempts.push(attempt);
    if (attempt < 3) throw new Error(`transient-${attempt}`);
    return 42;
  }, {
    maxAttempts: 3,
    retryDelayMs: 25,
    delayFn: async (milliseconds) => { delays.push(milliseconds); },
    onFailure: ({ attempt }) => { failures.push(attempt); },
  });

  assert.equal(result.value, 42);
  assert.equal(result.attempts, 3);
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.deepEqual(failures, [1, 2]);
  assert.deepEqual(delays, [25, 50]);
  assert.equal(result.failures.length, 2);
});

test("measurement retries preserve the terminal error and stop at the configured limit", async () => {
  const recorded: Array<{ attempt: number; message: string }> = [];

  await assert.rejects(
    retryOperation(async () => {
      const error = new Error("persistent sampler failure");
      Object.assign(error, { code: "EPIPE" });
      throw error;
    }, {
      maxAttempts: 3,
      retryDelayMs: 0,
      delayFn: async () => undefined,
      onFailure: ({ attempt, error }) => {
        recorded.push({ attempt, message: serializeError(error).message });
      },
    }),
    (error: unknown) => {
      assert.deepEqual(serializeError(error), {
        name: "Error",
        message: "persistent sampler failure",
        code: "EPIPE",
      });
      return true;
    },
  );

  assert.deepEqual(recorded, [
    { attempt: 1, message: "persistent sampler failure" },
    { attempt: 2, message: "persistent sampler failure" },
    { attempt: 3, message: "persistent sampler failure" },
  ]);
});

test("measurement retry configuration rejects an invalid attempt budget", async () => {
  await assert.rejects(
    retryOperation(async () => 1, { maxAttempts: 0 }),
    /maxAttempts must be a positive integer/,
  );
});
