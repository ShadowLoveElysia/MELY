import assert from "node:assert/strict";
import test from "node:test";
import {
  createPerformanceTelemetryRecorder,
  type PerformanceTelemetryContext,
} from "../src/core/performanceTelemetry";

const sequenceClock = (values: number[]) => {
  let index = 0;
  return () => {
    const value = values[index];
    index += 1;
    if (value === undefined) throw new Error("Test clock exhausted");
    return value;
  };
};

const productionContext: PerformanceTelemetryContext = {
  scope: "production-ui",
  workflow: "generation-export",
  backend: "web-worker",
  generationMode: "solid",
  exportFormat: "litematic",
  targetHeight: 4_064,
  workerThreads: 8,
};

test("records structured stage durations against a relative monotonic clock", () => {
  const recorder = createPerformanceTelemetryRecorder({
    ...productionContext,
    now: sequenceClock([100, 110, 145, 160]),
  });

  const span = recorder.start("voxelization.scan");
  span.end("completed", { candidateChecks: 30_536_307, blockCount: 25_948_193 });
  const report = recorder.report();

  assert.deepEqual(report, {
    schemaVersion: 1,
    context: productionContext,
    elapsedMs: 60,
    stages: [{
      sequence: 0,
      stage: "voxelization.scan",
      startedAtMs: 10,
      durationMs: 35,
      outcome: "completed",
      metrics: { candidateChecks: 30_536_307, blockCount: 25_948_193 },
    }],
  });
});

test("supports an honest combined voxelization stage for the interleaved TypeScript fallback", () => {
  const recorder = createPerformanceTelemetryRecorder({
    ...productionContext,
    now: sequenceClock([0, 2, 12, 14]),
  });
  recorder.measure("voxelization.total", () => ({ blockCount: 24 }), (value) => ({
    blockCount: value.blockCount,
  }));

  assert.deepEqual(recorder.report().stages[0], {
    sequence: 0,
    stage: "voxelization.total",
    startedAtMs: 2,
    durationMs: 10,
    outcome: "completed",
    metrics: { blockCount: 24 },
  });
});

test("clamps a regressing host clock instead of producing negative timings", () => {
  const recorder = createPerformanceTelemetryRecorder({
    ...productionContext,
    now: sequenceClock([50, 45, 40, 60]),
  });

  const span = recorder.start("preflight");
  const measurement = span.end();

  assert.equal(measurement.startedAtMs, 0);
  assert.equal(measurement.durationMs, 0);
  assert.equal(recorder.report().elapsedMs, 10);
});

test("keeps Litematic self-decode exclusive to validation reports", () => {
  const production = createPerformanceTelemetryRecorder({
    ...productionContext,
    now: sequenceClock([0]),
  });
  assert.throws(
    () => production.start("validation.litematic-decode"),
    /restricted to validation telemetry/,
  );

  const validation = createPerformanceTelemetryRecorder({
    scope: "validation",
    workflow: "generation-export",
    backend: "node-validation",
    now: sequenceClock([0, 5, 25, 30]),
  });
  validation.measure("validation.litematic-decode", () => ({ blockCount: 42 }), (value) => ({
    blockCount: value.blockCount,
  }));

  assert.deepEqual(validation.report().stages[0], {
    sequence: 0,
    stage: "validation.litematic-decode",
    startedAtMs: 5,
    durationMs: 20,
    outcome: "completed",
    metrics: { blockCount: 42 },
  });
});

test("copies only allowlisted public fields and never serializes paths or error text", () => {
  const unsafeContext = {
    ...productionContext,
    modelPath: "C:\\private\\model.pmx",
    outputPath: "/private/export.litematic",
  };
  const recorder = createPerformanceTelemetryRecorder({
    ...unsafeContext,
    now: sequenceClock([0, 1, 2, 3]),
  });
  recorder.start("write").end("failed", {
    byteLength: 1024,
    sourcePath: unsafeContext.modelPath,
    errorMessage: "write failed at /private/export.litematic",
  } as never);

  const serialized = JSON.stringify(recorder.report());
  assert.doesNotMatch(serialized, /private|model\.pmx|export\.litematic|write failed/);
  assert.match(serialized, /"byteLength":1024/);
});

test("measure and measureAsync retain failures while rethrowing the original error", async () => {
  const recorder = createPerformanceTelemetryRecorder({
    ...productionContext,
    now: sequenceClock([0, 1, 3, 4, 8, 9]),
  });
  const syncError = new Error("sync failure");
  assert.throws(
    () => recorder.measure("projection-document", () => { throw syncError; }),
    (error) => error === syncError,
  );

  const asyncError = new Error("async failure");
  await assert.rejects(
    recorder.measureAsync("litematic.gzip", async () => { throw asyncError; }),
    (error) => error === asyncError,
  );

  assert.deepEqual(
    recorder.report().stages.map(({ stage, outcome }) => ({ stage, outcome })),
    [
      { stage: "projection-document", outcome: "failed" },
      { stage: "litematic.gzip", outcome: "failed" },
    ],
  );
});

test("ending a span twice fails without duplicating the measurement", () => {
  const recorder = createPerformanceTelemetryRecorder({
    ...productionContext,
    now: sequenceClock([0, 1, 2, 3, 4]),
  });
  const span = recorder.start("ipc");
  span.end("cancelled", { cancellationLatencyMs: 125 });

  assert.throws(() => span.end(), /already ended/);
  const firstReport = recorder.report();
  firstReport.stages[0].durationMs = 999;
  assert.equal(recorder.report().stages[0].durationMs, 1);
});
