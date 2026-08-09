import assert from "node:assert/strict";
import test from "node:test";
import { createProjectionDocument, iterateProjectionBlocks } from "../src/core/projectionDocument";
import { resolveBedrockBlockState } from "../src/core/mcstructure";
import { decorateAncientRuins } from "../src/core/ruinDecoration";

const blockKeys = (document: ReturnType<typeof createProjectionDocument>) =>
  [...iterateProjectionBlocks(document)].map((block) => `${block.position.join(",")}:${block.paletteIndex}`);

test("zero ruin decoration returns the original sparse projection", () => {
  const document = createProjectionDocument([
    { position: [0, 0, 0], paletteIndex: 0 },
  ], [{ blockId: "minecraft:stone_bricks" }]);
  assert.equal(decorateAncientRuins(document, { amount: 0 }), document);
});

test("ruin decoration is deterministic and only adds blocks on exposed air faces", () => {
  const blocks = Array.from({ length: 128 }, (_, x) => ({
    position: [x, 0, 0] as [number, number, number],
    paletteIndex: 0,
  }));
  const document = createProjectionDocument(blocks, [{ blockId: "minecraft:stone_bricks" }]);
  const first = decorateAncientRuins(document, { amount: 100, seed: 42 });
  const second = decorateAncientRuins(document, { amount: 100, seed: 42 });
  assert.deepEqual(blockKeys(first), blockKeys(second));
  assert.ok(first.blockCount > document.blockCount);
  const originalPositions = new Set(blocks.map((block) => block.position.join(",")));
  const additions = [...iterateProjectionBlocks(first)].filter((block) =>
    !originalPositions.has(block.position.join(",")));
  assert.ok(additions.length > 0);
  assert.ok(additions.every((block) => Math.abs(block.position[2]) === 1));
  assert.ok(additions.every((block) => [
    "minecraft:vine",
    "minecraft:glow_lichen",
  ].includes(first.palette[block.paletteIndex].blockId)));
  additions.forEach((block) => {
    const state = first.palette[block.paletteIndex];
    const bedrock = resolveBedrockBlockState(state);
    if (block.position[2] === 1) {
      assert.equal(state.properties?.north, "true");
      assert.equal(
        bedrock.states[state.blockId === "minecraft:vine"
          ? "vine_direction_bits"
          : "multi_face_direction_bits"],
        4,
      );
    } else {
      assert.equal(state.properties?.south, "true");
      assert.equal(
        bedrock.states[state.blockId === "minecraft:vine"
          ? "vine_direction_bits"
          : "multi_face_direction_bits"],
        state.blockId === "minecraft:vine" ? 1 : 8,
      );
    }
  });
});

test("ruin decoration never replaces emissive source blocks", () => {
  const document = createProjectionDocument([
    { position: [0, 0, 0], paletteIndex: 0 },
  ], [{ blockId: "minecraft:sea_lantern", emissive: true }]);
  const decorated = decorateAncientRuins(document, { amount: 100, seed: 1 });
  const source = [...iterateProjectionBlocks(decorated)].find((block) => block.position.every((value) => value === 0));
  assert.ok(source);
  assert.equal(decorated.palette[source!.paletteIndex].blockId, "minecraft:sea_lantern");
});
