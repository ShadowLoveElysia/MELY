import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assessGenerationResourceRisk } from "../src/core/generationResourceRisk";
import type { ResourceEstimate } from "../src/core/resourceBudget";

const estimate = (
  overrides: Partial<ResourceEstimate> = {},
): ResourceEstimate => ({
  estimatedBytes: 256 * 1024 ** 2,
  estimatedVoxelVolume: 1_000_000,
  estimatedBlocks: 120_000,
  estimatedCandidates: 120_000,
  allowed: true,
  reason: "ok",
  requiresConfirmation: false,
  risks: [],
  ...overrides,
});

test("ordinary generation does not require an additional resource-risk confirmation", () => {
  const assessment = assessGenerationResourceRisk({
    mode: "solid",
    targetHeight: 320,
    triangleCount: 39_627,
    estimate: estimate(),
  });

  assert.equal(assessment.requiresConfirmation, false);
  assert.equal(assessment.reason, "ok");
  assert.deepEqual(assessment.risks, []);
  assert.ok(assessment.minimumSeconds <= assessment.maximumSeconds);
});

test("a 4064 solid workload requires confirmation without becoming a hard rejection", () => {
  const resourceEstimate = estimate({
    estimatedBytes: 6 * 1024 ** 3,
    estimatedBlocks: 23_000_000,
    estimatedCandidates: 114_500_000,
    reason: "memory",
    requiresConfirmation: true,
    risks: ["memory"],
  });
  const assessment = assessGenerationResourceRisk({
    mode: "solid",
    targetHeight: 4_064,
    triangleCount: 39_627,
    estimate: resourceEstimate,
  });

  assert.equal(resourceEstimate.allowed, true);
  assert.equal(assessment.requiresConfirmation, true);
  assert.equal(assessment.reason, "memory");
  assert.deepEqual(assessment.risks, ["memory", "largeWorkload"]);
  assert.equal(assessment.estimatedCandidateChecks, 114_500_000);
});

test("solid risk estimates retain finite saturated values for unbounded inputs", () => {
  const assessment = assessGenerationResourceRisk({
    mode: "solid",
    targetHeight: 4_064,
    triangleCount: Number.POSITIVE_INFINITY,
    estimate: estimate({
      estimatedBlocks: Number.POSITIVE_INFINITY,
      estimatedCandidates: Number.POSITIVE_INFINITY,
    }),
  });

  assert.equal(assessment.estimatedCandidateChecks, Number.MAX_SAFE_INTEGER);
  assert.equal(Number.isFinite(assessment.maximumSeconds), true);
  assert.equal(assessment.requiresConfirmation, true);
});

test("the App binds resource acceptance to the exact generation configuration", () => {
  const source = readFileSync("src/App.tsx", "utf8");

  for (const field of [
    "mode",
    "modelId",
    "poseRevision",
    "partsRevision",
    "javaVersionId",
    "heightMode",
    "targetDimensionMinY",
    "targetDimensionHeight",
    "placementBottomY",
    "hologramOptions",
    "solidOptions",
  ]) {
    assert.match(source, new RegExp(`interface GenerationResourceRiskConfiguration[\\s\\S]*?${field}:`));
  }
  assert.match(source, /resourceRisk\.requiresConfirmation[\s\S]*acceptedResourceRiskFingerprint !== resourceRiskFingerprint/);
  assert.match(source, /setPendingGenerationResourceRisk\(\{[\s\S]*fingerprint: resourceRiskFingerprint/);
  assert.match(source, /generationResourceRiskFingerprint\(currentConfiguration\) !== pending\.fingerprint/);
  assert.match(source, /setToast\(t\("generationResourceRisk\.stale"\)\)/);
  assert.match(source, /void generate\([\s\S]*pending\.configuration\.mode[\s\S]*pending\.fingerprint/);
  assert.match(source, /disabled: !generationResourceRiskAcknowledged/);
});
