import assert from "node:assert/strict";
import test from "node:test";
import {
  createMaterialPlan,
  LARGE_CHEST_SLOTS,
  SHULKER_BOX_SLOTS,
  summarizeMaterials,
} from "../src/core/materialPlanner";

test("material requirements convert counts into shulker boxes, stacks, and loose items", () => {
  const [requirement] = summarizeMaterials([{
    blockId: "white_concrete",
    count: 5_120,
  }]);
  assert.equal(requirement.blockId, "minecraft:white_concrete");
  assert.equal(requirement.shulkerBoxes, 2);
  assert.equal(requirement.stacks, 26);
  assert.equal(requirement.looseItems, 0);
  assert.equal(requirement.storageSlots, 80);
  assert.equal(SHULKER_BOX_SLOTS, 27);
});

test("duplicate materials merge without changing stable palette order", () => {
  const requirements = summarizeMaterials([
    { blockId: "minecraft:end_rod", count: 64, category: "lighting" },
    { blockId: "white_concrete", count: 10 },
    { blockId: "end_rod", count: 1, category: "lighting" },
  ]);
  assert.deepEqual(requirements.map((entry) => entry.blockId), [
    "minecraft:end_rod",
    "minecraft:white_concrete",
  ]);
  assert.equal(requirements[0].count, 65);
  assert.equal(requirements[0].stacks, 1);
  assert.equal(requirements[0].looseItems, 1);
});

test("chest planner fills consecutive slots and splits a material across chest boundaries", () => {
  const plan = createMaterialPlan([
    { blockId: "white_concrete", count: 60 * 64 },
    { blockId: "quartz_block", count: 10 },
  ]);
  assert.equal(plan.totalLargeChests, 2);
  assert.equal(plan.chests[0].usedSlots, LARGE_CHEST_SLOTS);
  assert.deepEqual(plan.chests[0].allocations[0], {
    blockId: "minecraft:white_concrete",
    category: "structure",
    startSlot: 1,
    slotCount: 54,
    itemCount: 54 * 64,
    fullStacks: 54,
    looseItems: 0,
  });
  assert.equal(plan.chests[1].allocations[0].slotCount, 6);
  assert.equal(plan.chests[1].allocations[1].startSlot, 7);
  assert.equal(plan.chests[1].allocations[1].looseItems, 10);
  assert.equal(plan.chests[1].freeSlots, 47);
});

test("chest planner isolates categories and keeps support blocks in dedicated chests", () => {
  const plan = createMaterialPlan([
    { blockId: "white_concrete", count: 10 },
    { blockId: "quartz_block", count: 20 },
    { blockId: "end_rod", count: 30, category: "lighting" },
    { blockId: "white_stained_glass_pane", count: 40, category: "glass" },
    { blockId: "cobblestone", count: 50, category: "support" },
  ]);

  assert.equal(plan.totalLargeChests, 4);
  assert.deepEqual(
    plan.chests.map((chest) => [...new Set(chest.allocations.map(({ category }) => category))]),
    [["structure"], ["lighting"], ["glass"], ["support"]],
  );
  assert.deepEqual(
    plan.chests[0].allocations.map(({ blockId, startSlot }) => [blockId, startSlot]),
    [["minecraft:white_concrete", 1], ["minecraft:quartz_block", 2]],
  );
  assert.deepEqual(plan.chests[3].allocations.map(({ blockId }) => blockId), [
    "minecraft:cobblestone",
  ]);

  const allocated = plan.chests.flatMap((chest) => chest.allocations)
    .reduce((sum, allocation) => sum + allocation.itemCount, 0);
  assert.equal(allocated, plan.totalBlocks);
  assert.ok(plan.chests.every((chest) => chest.usedSlots + chest.freeSlots === LARGE_CHEST_SLOTS));
});

test("planner supports non-standard stack sizes and rejects conflicting registry data", () => {
  const plan = createMaterialPlan([{ blockId: "custom:tool", count: 17, stackSize: 16 }]);
  assert.equal(plan.requirements[0].stacks, 1);
  assert.equal(plan.requirements[0].looseItems, 1);
  assert.equal(plan.requirements[0].storageSlots, 2);
  assert.throws(() => summarizeMaterials([
    { blockId: "custom:tool", count: 1, stackSize: 16 },
    { blockId: "custom:tool", count: 1, stackSize: 64 },
  ]), /Conflicting stack sizes/);
});
