import { ciede2000, rgbToLab, type Lab, type Rgb } from "./color";
import type { SolidOptions, VoxelPaletteEntry } from "../types";
import { getBlockDefinition } from "./blockRegistry";
import { getMaterialTheme } from "./materialThemes";

interface BlockColor extends VoxelPaletteEntry {
  skinSafe?: boolean;
  faceFeatureSafe?: boolean;
  gravity?: boolean;
  rare?: boolean;
  noisy?: boolean;
  lab?: Lab;
}

export type PaletteRole = "general" | "skinBase" | "faceFeature";

const block = (
  blockId: string,
  color: Rgb,
  flags: Omit<BlockColor, keyof VoxelPaletteEntry | "lab"> = {},
): BlockColor => ({
  blockId: `minecraft:${blockId}`,
  color,
  ...flags,
});

const COLORS = [
  block("white_concrete", [207, 213, 214], { skinSafe: true, faceFeatureSafe: true }),
  block("light_gray_concrete", [125, 125, 115], { skinSafe: true, faceFeatureSafe: true }),
  block("gray_concrete", [54, 57, 61], { faceFeatureSafe: true }),
  block("black_concrete", [8, 10, 15], { faceFeatureSafe: true }),
  block("brown_concrete", [96, 59, 31], { faceFeatureSafe: true }),
  block("red_concrete", [142, 32, 32], { faceFeatureSafe: true }),
  block("orange_concrete", [224, 97, 0], { faceFeatureSafe: true }),
  block("yellow_concrete", [241, 175, 21], { faceFeatureSafe: true }),
  block("lime_concrete", [94, 168, 24], { faceFeatureSafe: true }),
  block("green_concrete", [73, 91, 36], { faceFeatureSafe: true }),
  block("cyan_concrete", [21, 119, 136], { faceFeatureSafe: true }),
  block("light_blue_concrete", [36, 137, 199], { faceFeatureSafe: true }),
  block("blue_concrete", [44, 46, 143], { faceFeatureSafe: true }),
  block("purple_concrete", [100, 31, 156], { faceFeatureSafe: true }),
  block("magenta_concrete", [169, 48, 159], { faceFeatureSafe: true }),
  block("pink_concrete", [214, 101, 143], { skinSafe: true, faceFeatureSafe: true }),
  block("white_wool", [234, 236, 237]),
  block("light_gray_wool", [142, 142, 135]),
  block("gray_wool", [62, 68, 71]),
  block("black_wool", [20, 21, 25]),
  block("brown_wool", [114, 72, 41]),
  block("red_wool", [161, 39, 35]),
  block("orange_wool", [240, 118, 19]),
  block("yellow_wool", [248, 198, 39]),
  block("lime_wool", [112, 185, 25]),
  block("green_wool", [84, 109, 27]),
  block("cyan_wool", [21, 137, 145]),
  block("light_blue_wool", [58, 175, 217]),
  block("blue_wool", [53, 57, 157]),
  block("purple_wool", [121, 42, 172]),
  block("magenta_wool", [189, 68, 179]),
  block("pink_wool", [237, 141, 172]),
  block("white_terracotta", [209, 178, 161], { skinSafe: true }),
  block("light_gray_terracotta", [135, 107, 98], { skinSafe: true }),
  block("gray_terracotta", [58, 42, 36]),
  block("black_terracotta", [37, 23, 16]),
  block("brown_terracotta", [77, 51, 36], { skinSafe: true }),
  block("red_terracotta", [143, 61, 47], { skinSafe: true }),
  block("orange_terracotta", [161, 83, 37], { skinSafe: true }),
  block("yellow_terracotta", [186, 133, 35], { skinSafe: true }),
  block("lime_terracotta", [103, 117, 52]),
  block("green_terracotta", [76, 83, 42]),
  block("cyan_terracotta", [86, 91, 91]),
  block("light_blue_terracotta", [113, 108, 137]),
  block("blue_terracotta", [74, 59, 91]),
  block("purple_terracotta", [118, 70, 86]),
  block("magenta_terracotta", [149, 88, 108]),
  block("pink_terracotta", [161, 78, 78], { skinSafe: true }),
  block("terracotta", [152, 94, 67], { skinSafe: true }),
  block("smooth_quartz", [231, 226, 218], { skinSafe: true }),
  block("quartz_block", [235, 229, 222], { skinSafe: true }),
  block("calcite", [223, 224, 217], { skinSafe: true }),
  block("smooth_sandstone", [220, 203, 145], { skinSafe: true }),
  block("cut_sandstone", [217, 199, 137], { skinSafe: true }),
  block("sandstone", [216, 200, 143], { skinSafe: true, noisy: true }),
  block("smooth_red_sandstone", [181, 97, 31], { skinSafe: true }),
  block("stone", [125, 125, 125]),
  block("smooth_stone", [158, 158, 158]),
  block("polished_diorite", [192, 193, 190]),
  block("diorite", [188, 188, 183], { noisy: true }),
  block("polished_andesite", [132, 134, 133]),
  block("andesite", [136, 136, 136], { noisy: true }),
  block("polished_deepslate", [72, 72, 74]),
  block("deepslate_tiles", [54, 54, 56]),
  block("polished_blackstone", [53, 48, 56]),
  block("blackstone", [42, 36, 41], { noisy: true }),
  block("coal_block", [16, 15, 15]),
  block("obsidian", [15, 10, 24]),
  block("clay", [160, 166, 179]),
  block("packed_mud", [142, 106, 79]),
  block("mud_bricks", [137, 103, 79]),
  block("bricks", [150, 97, 83], { noisy: true }),
  block("nether_bricks", [45, 22, 27]),
  block("red_nether_bricks", [69, 7, 9]),
  block("purpur_block", [169, 126, 169]),
  block("prismarine_bricks", [99, 171, 158]),
  block("dark_prismarine", [52, 91, 75]),
  block("oak_planks", [162, 130, 79]),
  block("spruce_planks", [114, 84, 48]),
  block("birch_planks", [196, 179, 123]),
  block("jungle_planks", [160, 115, 80]),
  block("acacia_planks", [169, 91, 51]),
  block("dark_oak_planks", [67, 43, 20]),
  block("mangrove_planks", [117, 54, 48]),
  block("cherry_planks", [226, 178, 172]),
  block("bamboo_planks", [193, 173, 70]),
  block("crimson_planks", [101, 48, 70]),
  block("warped_planks", [43, 104, 99]),
  block("moss_block", [89, 109, 45], { noisy: true }),
  block("snow_block", [249, 254, 254]),
  block("iron_block", [221, 221, 216], { rare: true }),
  block("gold_block", [246, 208, 61], { rare: true }),
  block("diamond_block", [98, 237, 228], { rare: true }),
  block("emerald_block", [42, 203, 87], { rare: true }),
  block("lapis_block", [30, 67, 140], { rare: true }),
  block("redstone_block", [176, 24, 9], { rare: true }),
  block("sand", [219, 207, 163], { gravity: true, noisy: true }),
  block("red_sand", [191, 103, 33], { gravity: true, noisy: true }),
  block("gravel", [132, 128, 127], { gravity: true, noisy: true }),
] satisfies BlockColor[];

const prepared = COLORS.map((entry) => ({ ...entry, lab: rgbToLab(entry.color) }));

export interface PreparedBlockPalette {
  entries: VoxelPaletteEntry[];
  labs: Lab[];
  skinIndices: number[];
  faceFeatureIndices: number[];
}

export const createBlockPalette = (options: SolidOptions): PreparedBlockPalette => {
  const theme = options.materialTheme ?? "original";
  const source: BlockColor[] = theme === "original"
    ? prepared
    : getMaterialTheme(theme).blocks.map((entry) => {
        const definition = getBlockDefinition(entry.blockId);
        return {
          ...entry,
          skinSafe: true,
          faceFeatureSafe: true,
          gravity: definition.gravity,
          rare: definition.rare,
          noisy: definition.noisy,
          lab: rgbToLab(entry.color),
        };
      });
  const filtered = source.filter((entry) => {
    if (options.excludeGravity && entry.gravity) return false;
    if (options.excludeRare && entry.rare) return false;
    if (theme === "original" && options.palettePreset === "clean" && entry.noisy) return false;
    return true;
  });
  if (!filtered.length) {
    const fallback = source.find((entry) => !entry.gravity) ?? prepared[0];
    filtered.push(fallback);
  }
  const entries = filtered.map(({ blockId, color }) => ({ blockId, color }));
  const skinIndices: number[] = [];
  const faceFeatureIndices: number[] = [];
  filtered.forEach((entry, index) => {
    if (entry.skinSafe && !entry.noisy) skinIndices.push(index);
    if (entry.faceFeatureSafe && !entry.noisy) faceFeatureIndices.push(index);
  });
  return {
    entries,
    labs: filtered.map((entry) => entry.lab ?? rgbToLab(entry.color)),
    skinIndices,
    faceFeatureIndices,
  };
};

const resolvePaletteRole = (role: PaletteRole | boolean): PaletteRole => {
  if (typeof role === "boolean") return role ? "skinBase" : "general";
  return role;
};

export const matchBlockColor = (
  rgb: Rgb,
  palette: PreparedBlockPalette,
  role: PaletteRole | boolean = "general",
) => {
  const target = rgbToLab(rgb);
  const resolvedRole = resolvePaletteRole(role);
  const candidates = resolvedRole === "skinBase"
    ? palette.skinIndices
    : resolvedRole === "faceFeature"
      ? palette.faceFeatureIndices
      : undefined;
  const useRestrictedCandidates = candidates !== undefined && candidates.length > 0;
  let bestIndex = useRestrictedCandidates ? candidates[0] : 0;
  let bestDistance = Infinity;
  if (useRestrictedCandidates) {
    for (const index of candidates) {
      const distance = ciede2000(target, palette.labs[index]);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
  } else {
    for (let index = 0; index < palette.entries.length; index += 1) {
      const distance = ciede2000(target, palette.labs[index]);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
  }
  return bestIndex;
};
