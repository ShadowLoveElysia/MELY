import assert from "node:assert/strict";
import test from "node:test";
import {
  BEDROCK_1_20_VERSION,
  getBlockDefinition,
  getJavaBlockCapability,
  isJavaBlockAvailable,
  registeredBlocks,
  resolveBedrockBlockMapping,
  resolveBlockId,
} from "../src/core/blockRegistry";
import { getMaterialTheme, matchThemeColor } from "../src/core/materialThemes";
import { createBlockPalette } from "../src/core/blockPalette";
import type { SolidOptions } from "../src/types";

test("versioned registry resolves Java and Bedrock keys from one canonical block", () => {
  assert.equal(resolveBlockId("end_rod", "java", "1.20.1"), "minecraft:end_rod");
  assert.equal(resolveBlockId("minecraft:end_rod", "bedrock"), "minecraft:end_rod");
  assert.equal(BEDROCK_1_20_VERSION, "1.20.10");
  const definition = getBlockDefinition("glow_lichen");
  assert.equal(definition.lightLevel, 7);
  assert.equal(definition.use, "decoration");
});

test("registered Java versions use an explicit compatibility fallback", () => {
  assert.equal(
    resolveBlockId("minecraft:end_rod", "java", "1.20.2"),
    "minecraft:end_rod",
  );
  assert.throws(
    () => resolveBlockId("minecraft:end_rod", "java", "future-unknown"),
    /No block mapping is registered for future-unknown/,
  );
  assert.throws(
    () => resolveBlockId("minecraft:end_rod", "bedrock", "1.20.0"),
    /No block mapping is registered for 1\.20\.0/,
  );
});

test("Java block capability separates target availability from best-effort serialization", () => {
  assert.deepEqual(getJavaBlockCapability("end_rod", "1.8.9"), {
    versionId: "1.8.9",
    blockId: "minecraft:end_rod",
    available: false,
    serializable: true,
    resolvedId: "minecraft:end_rod",
    reason: "block_unavailable",
  });
  assert.equal(isJavaBlockAvailable("white_stained_glass_pane", "1.8.9"), true);
  assert.deepEqual(getJavaBlockCapability("white_stained_glass_pane", "1.8.9"), {
    versionId: "1.8.9",
    blockId: "minecraft:white_stained_glass_pane",
    available: true,
    serializable: true,
    resolvedId: "minecraft:white_stained_glass_pane",
    reason: "available",
  });
  assert.deepEqual(getJavaBlockCapability("end_rod", "26.3"), {
    versionId: "26.3",
    blockId: "minecraft:end_rod",
    available: true,
    serializable: true,
    resolvedId: "minecraft:end_rod",
    reason: "available",
  });
  assert.deepEqual(getJavaBlockCapability("end_rod", "1.20.1"), {
    versionId: "1.20.1",
    blockId: "minecraft:end_rod",
    available: true,
    serializable: true,
    resolvedId: "minecraft:end_rod",
    reason: "available",
  });
  assert.equal(getJavaBlockCapability("end_rod", "future").reason, "profile_unknown");
});

test("Bedrock 1.20 mappings preserve flattened blocks and encode legacy families", () => {
  assert.deepEqual(resolveBedrockBlockMapping("white_concrete"), {
    blockId: "minecraft:white_concrete",
    states: {},
  });
  assert.deepEqual(resolveBedrockBlockMapping("light_gray_terracotta"), {
    blockId: "minecraft:stained_hardened_clay",
    states: { color: "silver" },
  });
  assert.deepEqual(resolveBedrockBlockMapping("white_stained_glass_pane"), {
    blockId: "minecraft:stained_glass_pane",
    states: { color: "white" },
  });
  assert.deepEqual(resolveBedrockBlockMapping("smooth_quartz"), {
    blockId: "minecraft:quartz_block",
    states: { chisel_type: "smooth", pillar_axis: "y" },
  });
  assert.deepEqual(resolveBedrockBlockMapping("smooth_sandstone"), {
    blockId: "minecraft:sandstone",
    states: { sand_stone_type: "smooth" },
  });
  assert.deepEqual(resolveBedrockBlockMapping("oak_planks"), {
    blockId: "minecraft:planks",
    states: { wood_type: "oak" },
  });
  assert.deepEqual(resolveBedrockBlockMapping("prismarine_bricks"), {
    blockId: "minecraft:prismarine",
    states: { prismarine_block_type: "bricks" },
  });
  assert.deepEqual(resolveBedrockBlockMapping("bricks"), {
    blockId: "minecraft:brick_block",
    states: {},
  });
  assert.deepEqual(resolveBedrockBlockMapping("snow_block"), {
    blockId: "minecraft:snow",
    states: {},
  });
  for (const blockId of [
    "copper_block",
    "cut_copper",
    "exposed_copper",
    "weathered_copper",
    "oxidized_copper",
  ]) {
    assert.equal(resolveBedrockBlockMapping(blockId).blockId, `minecraft:${blockId}`);
  }
  assert.equal(resolveBlockId("smooth_quartz", "java", "1.20.1"), "minecraft:smooth_quartz");
  assert.equal(resolveBlockId("light_gray_terracotta", "java", "1.20.1"), "minecraft:light_gray_terracotta");
});

test("every registered palette block has an explicit Bedrock 1.20 mapping", () => {
  const definitions = registeredBlocks();
  assert.ok(definitions.length >= 100);
  for (const definition of definitions) {
    const mapping = resolveBedrockBlockMapping(definition.canonicalId);
    assert.match(mapping.blockId, /^minecraft:[a-z0-9_]+$/);
    assert.deepEqual(mapping, definition.bedrock[BEDROCK_1_20_VERSION]);
  }
});

test("registry exposes survival planning properties", () => {
  assert.equal(getBlockDefinition("sand").gravity, true);
  assert.equal(getBlockDefinition("iron_block").rare, true);
  assert.equal(getBlockDefinition("cobblestone").use, "support");
  assert.equal(getBlockDefinition("white_concrete").stackSize, 64);
});

test("unknown blocks fail closed for every edition export", () => {
  assert.throws(
    () => resolveBedrockBlockMapping("minecraft:future_custom_block"),
    /No Bedrock block mapping is registered/,
  );
  assert.throws(
    () => resolveBlockId("minecraft:future_custom_block", "bedrock"),
    /No Bedrock block mapping is registered/,
  );
  assert.deepEqual(
    getJavaBlockCapability("minecraft:future_custom_block", "1.20.1"),
    {
      versionId: "1.20.1",
      blockId: "minecraft:future_custom_block",
      available: true,
      serializable: false,
      resolvedId: null,
      reason: "mapping_unavailable",
    },
  );
  assert.throws(
    () => resolveBlockId("minecraft:future_custom_block", "java", "1.20.1"),
    /No block mapping is registered/,
  );
});

test("material themes use their declared block families", () => {
  assert.equal(matchThemeColor([245, 240, 232], "greekMarble").blockId, "minecraft:quartz_block");
  assert.match(matchThemeColor([184, 104, 75], "steampunk").blockId, /copper|iron|gold/);
  assert.ok(getMaterialTheme("ancientRuins").decorationBlocks.includes("minecraft:vine"));
});

test("every generated solid palette block has an explicit Java 1.20.1 mapping", () => {
  const options: SolidOptions = {
    targetHeight: 320,
    alphaThreshold: 0.3,
    thicknessCompensation: 0.08,
    fillMode: "shell",
    palettePreset: "balanced",
    faceDetail: "balanced",
    materialTheme: "original",
    dithering: 0,
    emissiveMapping: true,
    emissiveMaterialIndices: [],
    ruinDecoration: 0,
    skinProtection: true,
    skinMaterialIndices: [],
    excludeGravity: false,
    excludeRare: false,
  };
  for (const materialTheme of ["original", "greekMarble", "steampunk", "ancientRuins"] as const) {
    const palette = createBlockPalette({ ...options, materialTheme });
    for (const entry of palette.entries) {
      assert.equal(
        getJavaBlockCapability(entry.blockId, "1.20.1").serializable,
        true,
        `${materialTheme}: ${entry.blockId}`,
      );
    }
  }
});
