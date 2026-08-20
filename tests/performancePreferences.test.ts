import assert from "node:assert/strict";
import test from "node:test";
import {
  createManualPerformancePreferences,
  createWebPerformanceCapabilities,
  DEFAULT_PERFORMANCE_PREFERENCES,
  normalizePerformanceCapabilities,
  parsePerformancePreferences,
  PERFORMANCE_PREFERENCES_STORAGE_KEY,
  resolveNativeWorkerThreads,
  serializePerformancePreferences,
} from "../src/core/performancePreferences";

test("automatic worker count uses half the physical cores without exceeding available parallelism", () => {
  const topologies = [
    { physicalCores: 1, logicalProcessors: 1, availableParallelism: 1, expected: 1 },
    { physicalCores: 2, logicalProcessors: 4, availableParallelism: 4, expected: 1 },
    { physicalCores: 6, logicalProcessors: 12, availableParallelism: 12, expected: 3 },
    { physicalCores: 16, logicalProcessors: 32, availableParallelism: 32, expected: 8 },
  ];

  for (const topology of topologies) {
    const capabilities = normalizePerformanceCapabilities({
      ...topology,
      physicalCountReliable: true,
      recommendedThreads: 999,
    });
    const resolved = resolveNativeWorkerThreads(DEFAULT_PERFORMANCE_PREFERENCES, capabilities);
    assert.equal(capabilities.recommendedThreads, topology.expected);
    assert.equal(resolved.effectiveThreads, topology.expected);
    assert.equal(resolved.wasClamped, false);
  }
});

test("process parallelism limits the recommendation without rewriting physical topology", () => {
  const capabilities = normalizePerformanceCapabilities({
    physicalCores: 16,
    logicalProcessors: 32,
    availableParallelism: 4,
    physicalCountReliable: true,
  });

  assert.deepEqual(capabilities, {
    physicalCores: 16,
    logicalProcessors: 32,
    availableParallelism: 4,
    recommendedThreads: 4,
    maximumThreads: 4,
    physicalCountReliable: true,
    source: "native",
    estimated: false,
  });
  assert.equal(resolveNativeWorkerThreads(DEFAULT_PERFORMANCE_PREFERENCES, capabilities).reservedPhysicalCores, 12);
});

test("capability normalization repairs invalid relationships and marks unreliable physical counts", () => {
  const capabilities = normalizePerformanceCapabilities({
    physicalCores: 64,
    logicalProcessors: 32,
    availableParallelism: 128,
    physicalCountReliable: true,
  });

  assert.equal(capabilities.physicalCores, 32);
  assert.equal(capabilities.logicalProcessors, 32);
  assert.equal(capabilities.availableParallelism, 32);
  assert.equal(capabilities.maximumThreads, 32);
  assert.equal(capabilities.recommendedThreads, 16);
  assert.equal(capabilities.physicalCountReliable, false);
  assert.equal(capabilities.estimated, true);
});

test("web hardware concurrency is always exposed as a conservative estimate", () => {
  const estimated = createWebPerformanceCapabilities(32);
  assert.deepEqual(estimated, {
    physicalCores: 16,
    logicalProcessors: 32,
    availableParallelism: 32,
    recommendedThreads: 8,
    maximumThreads: 16,
    physicalCountReliable: false,
    source: "web",
    estimated: true,
  });

  const unavailable = createWebPerformanceCapabilities(undefined);
  assert.equal(unavailable.physicalCores, 1);
  assert.equal(unavailable.logicalProcessors, 1);
  assert.equal(unavailable.recommendedThreads, 1);
  assert.equal(unavailable.estimated, true);
});

test("versioned persistence stores only automatic or manual user intent", () => {
  assert.equal(PERFORMANCE_PREFERENCES_STORAGE_KEY, "mely.performance.nativeWorkerThreads.v1");
  assert.equal(serializePerformancePreferences(DEFAULT_PERFORMANCE_PREFERENCES), JSON.stringify({
    version: 1,
    nativeWorkerThreads: { mode: "auto" },
  }));

  const manual = createManualPerformancePreferences(12);
  const serialized = serializePerformancePreferences(manual);
  assert.deepEqual(parsePerformancePreferences(serialized), {
    version: 1,
    nativeWorkerThreads: { mode: "manual", manualThreads: 12 },
  });
  assert.doesNotMatch(serialized, /physicalCores|logicalProcessors|recommendedThreads/);
});

test("damaged and unknown preference payloads safely return to automatic mode", () => {
  const automatic = {
    version: 1,
    nativeWorkerThreads: { mode: "auto" },
  };
  assert.deepEqual(parsePerformancePreferences(null), automatic);
  assert.deepEqual(parsePerformancePreferences("{"), automatic);
  assert.deepEqual(parsePerformancePreferences(JSON.stringify({
    version: 2,
    nativeWorkerThreads: { mode: "manual", manualThreads: 8 },
  })), automatic);
  assert.deepEqual(parsePerformancePreferences(JSON.stringify({
    version: 1,
    nativeWorkerThreads: { mode: "manual", manualThreads: 0 },
  })), automatic);
});

test("manual intent survives persistence while runtime values clamp to the current safe maximum", () => {
  const preferences = createManualPerformancePreferences(24);
  const constrained = normalizePerformanceCapabilities({
    physicalCores: 16,
    logicalProcessors: 32,
    availableParallelism: 10,
    physicalCountReliable: true,
  });
  const resolved = resolveNativeWorkerThreads(preferences, constrained);

  assert.deepEqual(preferences.nativeWorkerThreads, { mode: "manual", manualThreads: 24 });
  assert.equal(resolved.requestedThreads, 24);
  assert.equal(resolved.configuredThreads, 10);
  assert.equal(resolved.effectiveThreads, 10);
  assert.equal(resolved.maximumThreads, 10);
  assert.equal(resolved.wasClamped, true);
  assert.equal(resolved.aboveRecommended, true);
  assert.equal(resolved.reservedPhysicalCores, 6);
});

test("a manual value above the recommendation remains allowed and discoverable for confirmation", () => {
  const capabilities = normalizePerformanceCapabilities({
    physicalCores: 16,
    logicalProcessors: 32,
    availableParallelism: 32,
    physicalCountReliable: true,
  });
  const resolved = resolveNativeWorkerThreads(createManualPerformancePreferences(16), capabilities);

  assert.equal(resolved.recommendedThreads, 8);
  assert.equal(resolved.effectiveThreads, 16);
  assert.equal(resolved.wasClamped, false);
  assert.equal(resolved.aboveRecommended, true);
});
