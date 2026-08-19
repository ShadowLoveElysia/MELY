import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { generateMeshHologram } from "../src/core/hologram";
import { MAX_PROJECTION_BLOCKS } from "../src/core/resourceBudget";
import type { HologramMeshSnapshot, HologramOptions } from "../src/types";

const cubeIndices = Uint32Array.from([
  0, 2, 1, 0, 3, 2,
  4, 5, 6, 4, 6, 7,
  0, 1, 5, 0, 5, 4,
  3, 7, 6, 3, 6, 2,
  0, 4, 7, 0, 7, 3,
  1, 2, 6, 1, 6, 5,
]);

const cube = (): HologramMeshSnapshot => ({
  positions: Float32Array.from([
    -1, 0, -1, 1, 0, -1, 1, 2, -1, -1, 2, -1,
    -1, 0, 1, 1, 0, 1, 1, 2, 1, -1, 2, 1,
  ]),
  indices: cubeIndices,
  triangleMaterials: new Uint16Array(cubeIndices.length / 3),
});

const baseOptions: Omit<HologramOptions, "targetHeight"> = {
  sampleSpacing: 3,
  interiorDensity: 100,
  material: "mixed",
  directionMode: "vertical",
  preserveFace: true,
  glow: 70,
};

test("synthetic 256/384/2032/4064 stress matrix stays sparse and bounded", { timeout: 30_000 }, () => {
  for (const targetHeight of [256, 384, 2_032, 4_064]) {
    const result = generateMeshHologram(cube(), {
      ...baseOptions,
      targetHeight,
      contentHash: "height-release-audit-cube",
      minecraftVersion: "synthetic-stress-profile",
    });

    assert.equal(result.bounds.min[1], 0, String(targetHeight));
    assert.equal(result.bounds.max[1], targetHeight - 1, String(targetHeight));
    assert.equal(result.stats.dimensions[1], targetHeight, String(targetHeight));
    assert.ok(result.stats.blockCount <= MAX_PROJECTION_BLOCKS, String(targetHeight));
    assert.ok(result.positions.byteLength <= MAX_PROJECTION_BLOCKS * 3 * 4, String(targetHeight));
  }
});

test("release documents state the third-party data-pack boundary in every language", () => {
  const documents = [
    readFileSync("README.md", "utf8"),
    readFileSync("docs/README.en.md", "utf8"),
    readFileSync("docs/README.ja.md", "utf8"),
  ];

  for (const document of documents) {
    assert.match(document, /2032|2,032/);
    assert.match(document, /4064|4,064/);
    assert.match(document, /-2032\.\.2031/);
    assert.match(document, /pack_format/);
  }
  assert.match(documents[0], /不制作、捆绑、下载、安装、验证或担保/);
  assert.match(documents[1], /does not create, bundle, download, install, validate, or endorse/);
  assert.match(documents[2], /作成、同梱、ダウンロード、導入、検証、保証を行いません/);
  assert.match(documents[0], /允许以 best-effort 方式尝试生成与导出/);
  assert.match(documents[1], /best-effort generation and export/);
  assert.match(documents[2], /best-effort の生成と出力を試せます/);
  assert.match(documents[0], /不会阻止生成或尝试导出/);
  assert.match(documents[1], /do not block generation or an export attempt/);
  assert.match(documents[2], /生成や出力の試行を妨げません/);
  assert.ok(documents.every((document) => !document.includes("原生支持 4096")));
  assert.ok(documents.every((document) => !document.includes("native 4096 support")));
});

test("release validation includes cancellation recovery and reachable 2032/4064 evidence runners", () => {
  const lifecycle = readFileSync("scripts/verify-lifecycle-memory.cjs", "utf8");
  const runner = readFileSync("scripts/run-real-2032-hologram-bundle.ps1", "utf8");
  const workload = readFileSync("scripts/verify-release-workload.cjs", "utf8");
  const synthetic = readFileSync("scripts/verify-height-export-e2e.cjs", "utf8");

  assert.match(lifecycle, /startGenerationForCancellation/);
  assert.match(lifecycle, /cancelledByReplacement/);
  assert.match(lifecycle, /workingSetPeakRecoveryRatio/);
  assert.match(lifecycle, /liveHeapRecovered/);
  assert.match(runner, /MELY_TARGET_HEIGHT = "2032"/);
  assert.match(runner, /MELY_TARGET_DIMENSION_MIN_Y = "-1024"/);
  assert.match(runner, /MELY_TARGET_DIMENSION_HEIGHT = "2032"/);
  assert.match(runner, /MELY_PLACEMENT_BOTTOM_Y = "-1024"/);
  assert.match(runner, /verify-release-workload\.cjs/);
  assert.match(workload, /Extended-height workloads require integer MELY_TARGET_DIMENSION_MIN_Y/);
  assert.match(workload, /Declared placement Y=/);
  assert.match(workload, /unlockDisabled/);
  assert.match(workload, /best-effort height workflows must remain reachable/);
  assert.match(workload, /confirmEnabledAfterAcknowledge/);
  assert.doesNotMatch(workload, /expectedFailClosed|failClosedVerified/);
  assert.match(synthetic, /extended2032Reachable/);
  assert.match(synthetic, /extreme4064Reachable/);
  assert.match(synthetic, /Large projection: resource-risk confirmation/);
  assert.match(synthetic, /Generation resource risk is not a confirmation-only gate/);
  assert.match(synthetic, /continuedToWorker/);
  assert.match(synthetic, /generateFixture\(page, "narrow", 2032, 2032, true\)/);
  assert.match(synthetic, /startFixtureGeneration\(page, true\)/);
  assert.match(synthetic, /2,032-layer Java export is not attemptable/);
  assert.match(synthetic, /bedrockDirectExports/);
  assert.match(synthetic, /isBedrockFormat/);
  assert.doesNotMatch(synthetic, /extended2032FailClosed|expectedFailClosed/);
});
