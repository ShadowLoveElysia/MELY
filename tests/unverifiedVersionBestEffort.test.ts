import assert from "node:assert/strict";
import test from "node:test";
import { translate, translationKeyExists } from "../src/i18n";
import { preflightGenerationHeight } from "../src/core/heightSafety";
import {
  getJavaCompatibilityProfile,
  getJavaExporterCapability,
  getJavaVersionProfile,
} from "../src/core/minecraftVersions";
import { assertWorkerGenerationHeight } from "../src/core/workerHeightPreflight";
import { assertWorkerMaterialCapabilities } from "../src/core/workerResourcePreflight";
import type { WorkerCommand } from "../src/types";

const untestedCommand = (): WorkerCommand => ({
  type: "GENERATE_HOLOGRAM",
  jobId: "untested-java-1.17",
  versionId: "1.17",
  heightMode: "default",
  targetDimension: { minY: 0, height: 256 },
  placementBottomY: 0,
  options: {
    targetHeight: 200,
    sampleSpacing: 2,
    interiorDensity: 0,
    material: "mixed",
    directionMode: "vertical",
    preserveFace: true,
    glow: 72,
  },
  generationSeed: { contentHash: "fixture", minecraftVersion: "1.17" },
  source: { kind: "demo" },
});

test("a registered untested Java version enters generation as best effort", () => {
  const profile = getJavaVersionProfile("1.17");
  assert.ok(profile);
  assert.equal(profile.releaseStatus, "untested");

  const compatibility = getJavaCompatibilityProfile(profile.id);
  assert.ok(compatibility);
  assert.equal(compatibility.requestedProfile, profile);
  assert.equal(compatibility.level, "best_effort");
  assert.equal(compatibility.warningCode, "JAVA_VERSION_BEST_EFFORT");
  assert.ok(getJavaExporterCapability(profile.id, "litematic"));

  const preflight = preflightGenerationHeight({
    versionId: profile.id,
    heightMode: "default",
    targetHeight: 200,
  });
  assert.equal(preflight.allowed, true);
  assert.equal(preflight.errorCode, null);
  assert.deepEqual(preflight.warnings, ["JAVA_VERSION_BEST_EFFORT"]);
});

test("Worker checks real material capability without rejecting an untested status", () => {
  const command = untestedCommand();
  assert.doesNotThrow(() => assertWorkerGenerationHeight(command));
  assert.doesNotThrow(() => assertWorkerMaterialCapabilities(command));
});

test("untested status is presented as a non-blocking warning in every locale", () => {
  assert.equal(translationKeyExists("sidebar.scale.versionStatus.untested"), true);

  const messages = [
    translate("zh-CN", "toast.javaVersionUnverified", { version: "1.17" }),
    translate("en-US", "toast.javaVersionUnverified", { version: "1.17" }),
    translate("ja-JP", "toast.javaVersionUnverified", { version: "1.17" }),
  ];
  assert.match(messages[0], /测试|核验/);
  assert.match(messages[0], /仍可|可以|可尝试/);
  assert.doesNotMatch(messages[0], /禁用|不允许|不可生成|不可导出/);
  assert.match(messages[1], /not fully tested/i);
  assert.match(messages[1], /still try/i);
  assert.doesNotMatch(messages[1], /disabled|not allowed/i);
  assert.match(messages[2], /テスト|検証/);
  assert.match(messages[2], /試せ/);
  assert.doesNotMatch(messages[2], /無効|許可されません/);
});

