import assert from "node:assert/strict";
import test from "node:test";
import { createProjectionDocument } from "../src/core/projectionDocument";
import {
  createProjectionEngineeringPlan,
  materialInputsFromProjection,
  serializeEngineeringPlanJson,
  serializeEngineeringPlanText,
} from "../src/core/projectionPlanning";

test("projection planning derives survival materials and optional support blocks", () => {
  const document = createProjectionDocument([
    { position: [0, 0, 0], paletteIndex: 0 },
    { position: [1, 0, 0], paletteIndex: 0 },
    { position: [32, 64, 0], paletteIndex: 1 },
  ], [
    { blockId: "minecraft:white_concrete" },
    { blockId: "minecraft:end_rod", emissive: true },
  ]);
  const inputs = materialInputsFromProjection(document, {
    includeSupportBlocks: true,
    supportBlockCount: 65,
  });
  assert.deepEqual(inputs.map(({ blockId, count, category }) => ({ blockId, count, category })), [
    { blockId: "minecraft:white_concrete", count: 2, category: "structure" },
    { blockId: "minecraft:end_rod", count: 1, category: "lighting" },
    { blockId: "minecraft:cobblestone", count: 65, category: "support" },
  ]);
});

test("engineering plans include stable 32-cube placement coordinates", () => {
  const document = createProjectionDocument([
    { position: [0, 0, 0], paletteIndex: 0 },
    { position: [31, 31, 31], paletteIndex: 0 },
    { position: [32, 64, 0], paletteIndex: 0 },
  ], [{ blockId: "minecraft:white_concrete" }]);
  const plan = createProjectionEngineeringPlan(document, { splitSize: 32 });
  assert.equal(plan.parts.length, 2);
  assert.deepEqual(plan.parts.map((part) => part.origin), [[0, 0, 0], [32, 64, 0]]);
  assert.match(plan.parts[1].placement, /X=32, Y=64, Z=0/);
  assert.equal(plan.materialPlan.requirements[0].count, 3);
  assert.equal(JSON.parse(serializeEngineeringPlanJson(plan)).generator, "MELY");
  assert.match(serializeEngineeringPlanText(plan), /Estimated large chests:/);
  assert.match(serializeEngineeringPlanText(plan, "zh-CN"), /工程建造指南/);
  assert.match(serializeEngineeringPlanText(plan, "ja-JP"), /素材リスト/);
});
