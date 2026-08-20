import assert from "node:assert/strict";
import test from "node:test";
import {
  assessNativeThreadRisk,
  continueSelectedNativeThreadExecution,
  useRecommendedNativeThreadExecution,
} from "../src/core/nativeThreadRisk";
import {
  createManualPerformancePreferences,
  normalizePerformanceCapabilities,
  resolveNativeWorkerThreads,
} from "../src/core/performancePreferences";

const capabilities = normalizePerformanceCapabilities({
  physicalCores: 16,
  logicalProcessors: 32,
  availableParallelism: 32,
  physicalCountReliable: true,
  source: "native",
});

const resolvedThreads = (threads: number) => resolveNativeWorkerThreads(
  createManualPerformancePreferences(threads),
  capabilities,
);

test("Web fallback never requests a native thread-risk confirmation", () => {
  const assessment = assessNativeThreadRisk({
    resolvedThreads: resolvedThreads(16),
    capabilities,
    memorySuggestedThreads: 4,
    nativeJobAvailable: false,
  });

  assert.deepEqual(assessment, {
    reasons: [],
    needsConfirmation: false,
    fingerprint: null,
    executionSnapshot: null,
  });
  assert.equal(continueSelectedNativeThreadExecution(assessment), null);
  assert.equal(useRecommendedNativeThreadExecution(assessment), null);
});

test("a native selection above the CPU recommendation remains executable after confirmation", () => {
  const assessment = assessNativeThreadRisk({
    resolvedThreads: resolvedThreads(16),
    capabilities,
    nativeJobAvailable: true,
  });

  assert.deepEqual(assessment.reasons, ["aboveRecommended"]);
  assert.equal(assessment.needsConfirmation, true);
  assert.equal(assessment.executionSnapshot?.workerThreads, 16);
  assert.equal(continueSelectedNativeThreadExecution(assessment)?.workerThreads, 16);
  assert.equal(useRecommendedNativeThreadExecution(assessment)?.workerThreads, 8);
});

test("a memory suggestion triggers confirmation without silently lowering the selected value", () => {
  const assessment = assessNativeThreadRisk({
    resolvedThreads: resolvedThreads(8),
    capabilities,
    memorySuggestedThreads: 4,
    nativeJobAvailable: true,
  });

  assert.deepEqual(assessment.reasons, ["aboveMemorySuggestion"]);
  assert.equal(assessment.needsConfirmation, true);
  assert.equal(assessment.executionSnapshot?.workerThreads, 8);
  assert.equal(continueSelectedNativeThreadExecution(assessment)?.workerThreads, 8);
  assert.equal(useRecommendedNativeThreadExecution(assessment)?.workerThreads, 4);
});

test("CPU and memory reasons are retained together and only require confirmation", () => {
  const assessment = assessNativeThreadRisk({
    resolvedThreads: resolvedThreads(16),
    capabilities,
    memorySuggestedThreads: 6,
    nativeJobAvailable: true,
  });

  assert.deepEqual(assessment.reasons, ["aboveRecommended", "aboveMemorySuggestion"]);
  assert.equal(assessment.needsConfirmation, true);
  assert.equal(continueSelectedNativeThreadExecution(assessment)?.workerThreads, 16);
  assert.equal(useRecommendedNativeThreadExecution(assessment)?.workerThreads, 6);
});

test("ordinary native execution has a stable snapshot without requiring confirmation", () => {
  const first = assessNativeThreadRisk({
    resolvedThreads: resolvedThreads(8),
    capabilities,
    memorySuggestedThreads: 8,
    nativeJobAvailable: true,
  });
  const second = assessNativeThreadRisk({
    resolvedThreads: resolvedThreads(8),
    capabilities,
    memorySuggestedThreads: 8,
    nativeJobAvailable: true,
  });

  assert.deepEqual(first.reasons, []);
  assert.equal(first.needsConfirmation, false);
  assert.match(first.fingerprint ?? "", /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.deepEqual(first.executionSnapshot, {
    backend: "native-rayon",
    workerThreads: 8,
    recommendedThreads: 8,
    maximumThreads: 16,
    memorySuggestedThreads: 8,
  });
});

test("the confirmation fingerprint changes with the frozen worker count", () => {
  const eightThreads = assessNativeThreadRisk({
    resolvedThreads: resolvedThreads(8),
    capabilities,
    nativeJobAvailable: true,
  });
  const twelveThreads = assessNativeThreadRisk({
    resolvedThreads: resolvedThreads(12),
    capabilities,
    nativeJobAvailable: true,
  });

  assert.notEqual(eightThreads.fingerprint, twelveThreads.fingerprint);
  assert.equal(eightThreads.executionSnapshot?.workerThreads, 8);
  assert.equal(twelveThreads.executionSnapshot?.workerThreads, 12);
});

test("height, SolidOptions, and content data cannot enter the native thread fingerprint", () => {
  const baseInput = {
    resolvedThreads: resolvedThreads(12),
    capabilities,
    memorySuggestedThreads: 8,
    nativeJobAvailable: true,
  };
  const unrelatedInput = {
    ...baseInput,
    solidOptions: { targetHeight: 4_064, fillMode: "filled" },
    heightMode: "experimental_4064",
    contentHash: "sha256:projection-content",
  };

  const base = assessNativeThreadRisk(baseInput);
  const withUnrelatedData = assessNativeThreadRisk(unrelatedInput);
  assert.equal(base.fingerprint, withUnrelatedData.fingerprint);
  assert.deepEqual(Object.keys(withUnrelatedData.executionSnapshot ?? {}).sort(), [
    "backend",
    "maximumThreads",
    "memorySuggestedThreads",
    "recommendedThreads",
    "workerThreads",
  ]);
});

test("recommended execution is deterministic and never increases a conservative selection", () => {
  const assessment = assessNativeThreadRisk({
    resolvedThreads: resolvedThreads(4),
    capabilities,
    nativeJobAvailable: true,
  });

  const first = useRecommendedNativeThreadExecution(assessment);
  const second = useRecommendedNativeThreadExecution(assessment);
  assert.deepEqual(first, second);
  assert.equal(first?.workerThreads, 4);
  assert.notEqual(first, assessment.executionSnapshot);
});
