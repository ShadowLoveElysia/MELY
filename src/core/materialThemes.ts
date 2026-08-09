import { ciede2000, rgbToLab, type Rgb } from "./color";
import type { MaterialTheme } from "../types";

export interface ThemeBlock {
  blockId: string;
  color: Rgb;
}

export interface ThemeDefinition {
  id: MaterialTheme;
  blocks: readonly ThemeBlock[];
  decorationBlocks: readonly string[];
}

const THEMES: Record<MaterialTheme, ThemeDefinition> = {
  original: { id: "original", blocks: [], decorationBlocks: [] },
  greekMarble: {
    id: "greekMarble",
    blocks: [
      { blockId: "minecraft:smooth_quartz", color: [231, 226, 218] },
      { blockId: "minecraft:quartz_block", color: [235, 229, 222] },
      { blockId: "minecraft:calcite", color: [223, 224, 217] },
      { blockId: "minecraft:polished_diorite", color: [192, 193, 190] },
      { blockId: "minecraft:smooth_sandstone", color: [220, 203, 145] },
    ],
    decorationBlocks: [],
  },
  steampunk: {
    id: "steampunk",
    blocks: [
      { blockId: "minecraft:copper_block", color: [192, 107, 79] },
      { blockId: "minecraft:cut_copper", color: [191, 106, 80] },
      { blockId: "minecraft:exposed_copper", color: [161, 125, 103] },
      { blockId: "minecraft:weathered_copper", color: [108, 153, 110] },
      { blockId: "minecraft:oxidized_copper", color: [82, 162, 132] },
      { blockId: "minecraft:raw_iron_block", color: [166, 135, 107] },
      { blockId: "minecraft:iron_block", color: [221, 221, 216] },
      { blockId: "minecraft:deepslate_gold_ore", color: [77, 75, 71] },
    ],
    decorationBlocks: [],
  },
  ancientRuins: {
    id: "ancientRuins",
    blocks: [
      { blockId: "minecraft:stone_bricks", color: [122, 121, 122] },
      { blockId: "minecraft:mossy_stone_bricks", color: [115, 121, 105] },
      { blockId: "minecraft:calcite", color: [223, 224, 217] },
      { blockId: "minecraft:moss_block", color: [89, 109, 45] },
    ],
    decorationBlocks: ["minecraft:vine", "minecraft:glow_lichen"],
  },
};

const labs = new Map<MaterialTheme, ReturnType<typeof rgbToLab>[]>(
  Object.values(THEMES).map((theme) => [theme.id, theme.blocks.map((entry) => rgbToLab(entry.color))]),
);

export const getMaterialTheme = (theme: MaterialTheme) => THEMES[theme];

export const matchThemeColor = (rgb: Rgb, theme: Exclude<MaterialTheme, "original">) => {
  const definition = THEMES[theme];
  const target = rgbToLab(rgb);
  const themeLabs = labs.get(theme) ?? [];
  let bestIndex = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < definition.blocks.length; index += 1) {
    const distance = ciede2000(target, themeLabs[index]);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  return definition.blocks[bestIndex];
};
