import {
  DEFAULT_BEDROCK_VERSION,
  DEFAULT_MINECRAFT_VERSION,
  getJavaCompatibilityProfile,
  getJavaVersionProfile,
} from "./minecraftVersions";

export type MinecraftEdition = "java" | "bedrock";
export type BlockUse = "structure" | "lighting" | "glass" | "decoration" | "support";
export type MinecraftBlockStateValue = string | number | boolean;

export const BEDROCK_1_20_VERSION = DEFAULT_BEDROCK_VERSION.id;

export interface BedrockBlockMapping {
  blockId: string;
  states: Readonly<Record<string, MinecraftBlockStateValue>>;
}

export interface VersionedBlockDefinition {
  canonicalId: string;
  java: Record<string, string>;
  bedrock: Record<string, BedrockBlockMapping>;
  stackSize: number;
  lightLevel: number;
  gravity: boolean;
  rare: boolean;
  noisy: boolean;
  use: BlockUse;
}

export interface JavaBlockCapability {
  readonly versionId: string;
  readonly blockId: string;
  readonly available: boolean;
  readonly serializable: boolean;
  readonly resolvedId: string | null;
  readonly reason: "available" | "profile_unknown" | "profile_unverified" | "block_unavailable" | "mapping_unavailable";
}

interface BlockDefinitionOptions {
  bedrockId?: string;
  bedrockStates?: Readonly<Record<string, MinecraftBlockStateValue>>;
  stackSize?: number;
  lightLevel?: number;
  gravity?: boolean;
  rare?: boolean;
  noisy?: boolean;
  use?: BlockUse;
}

const namespacedId = (id: string) => id.includes(":") ? id : `minecraft:${id}`;

const block = (
  id: string,
  definition: BlockDefinitionOptions = {},
): VersionedBlockDefinition => {
  const canonicalId = namespacedId(id);
  const bedrockMapping: BedrockBlockMapping = {
    blockId: namespacedId(definition.bedrockId ?? id),
    states: { ...(definition.bedrockStates ?? {}) },
  };
  return {
    canonicalId,
    java: { [DEFAULT_MINECRAFT_VERSION.id]: canonicalId },
    bedrock: { [BEDROCK_1_20_VERSION]: bedrockMapping },
    stackSize: definition.stackSize ?? 64,
    lightLevel: definition.lightLevel ?? 0,
    gravity: definition.gravity ?? false,
    rare: definition.rare ?? false,
    noisy: definition.noisy ?? false,
    use: definition.use ?? "structure",
  };
};

const DYE_COLORS = [
  "white",
  "light_gray",
  "gray",
  "black",
  "brown",
  "red",
  "orange",
  "yellow",
  "lime",
  "green",
  "cyan",
  "light_blue",
  "blue",
  "purple",
  "magenta",
  "pink",
] as const;

const bedrockDyeColor = (color: typeof DYE_COLORS[number]) =>
  color === "light_gray" ? "silver" : color;

const coloredBlocks = (
  suffix: string,
  options: Omit<BlockDefinitionOptions, "bedrockId" | "bedrockStates"> & {
    bedrockFamilyId?: string;
  } = {},
) => {
  const { bedrockFamilyId, ...definition } = options;
  return DYE_COLORS.map((color) => block(`${color}_${suffix}`, {
    ...definition,
    ...(bedrockFamilyId
    ? {
        bedrockId: bedrockFamilyId,
        bedrockStates: { color: bedrockDyeColor(color) },
      }
    : {}),
  }));
};

const DEFINITIONS = [
  block("air", { stackSize: 0 }),
  block("end_rod", {
    bedrockStates: { facing_direction: 1 },
    lightLevel: 14,
    use: "lighting",
  }),
  block("white_stained_glass_pane", {
    bedrockId: "stained_glass_pane",
    bedrockStates: { color: "white" },
    use: "glass",
  }),
  block("glowstone", { lightLevel: 15, use: "lighting" }),
  block("sea_lantern", { lightLevel: 15, use: "lighting" }),
  block("ochre_froglight", {
    bedrockStates: { pillar_axis: "y" },
    lightLevel: 15,
    use: "lighting",
  }),
  block("verdant_froglight", {
    bedrockStates: { pillar_axis: "y" },
    lightLevel: 15,
    use: "lighting",
  }),
  block("pearlescent_froglight", {
    bedrockStates: { pillar_axis: "y" },
    lightLevel: 15,
    use: "lighting",
  }),
  block("redstone_lamp", { use: "lighting" }),
  ...coloredBlocks("concrete"),
  ...coloredBlocks("wool"),
  ...coloredBlocks("terracotta", { bedrockFamilyId: "stained_hardened_clay" }),
  block("terracotta", { bedrockId: "hardened_clay" }),
  block("smooth_quartz", {
    bedrockId: "quartz_block",
    bedrockStates: { chisel_type: "smooth", pillar_axis: "y" },
  }),
  block("quartz_block", {
    bedrockStates: { chisel_type: "default", pillar_axis: "y" },
  }),
  block("calcite"),
  block("polished_diorite", {
    bedrockId: "stone",
    bedrockStates: { stone_type: "diorite_smooth" },
  }),
  block("diorite", {
    bedrockId: "stone",
    bedrockStates: { stone_type: "diorite" },
    noisy: true,
  }),
  block("smooth_sandstone", {
    bedrockId: "sandstone",
    bedrockStates: { sand_stone_type: "smooth" },
  }),
  block("cut_sandstone", {
    bedrockId: "sandstone",
    bedrockStates: { sand_stone_type: "cut" },
  }),
  block("sandstone", {
    bedrockStates: { sand_stone_type: "default" },
    noisy: true,
  }),
  block("smooth_red_sandstone", {
    bedrockId: "red_sandstone",
    bedrockStates: { sand_stone_type: "smooth" },
  }),
  block("stone", { bedrockStates: { stone_type: "stone" } }),
  block("smooth_stone"),
  block("polished_andesite", {
    bedrockId: "stone",
    bedrockStates: { stone_type: "andesite_smooth" },
  }),
  block("andesite", {
    bedrockId: "stone",
    bedrockStates: { stone_type: "andesite" },
    noisy: true,
  }),
  block("polished_deepslate"),
  block("deepslate_tiles"),
  block("polished_blackstone"),
  block("blackstone", { noisy: true }),
  block("coal_block"),
  block("obsidian"),
  block("clay"),
  block("packed_mud"),
  block("mud_bricks"),
  block("bricks", { bedrockId: "brick_block", noisy: true }),
  block("nether_bricks", { bedrockId: "nether_brick" }),
  block("red_nether_bricks", { bedrockId: "red_nether_brick" }),
  block("purpur_block", {
    bedrockStates: { chisel_type: "default", pillar_axis: "y" },
  }),
  block("prismarine_bricks", {
    bedrockId: "prismarine",
    bedrockStates: { prismarine_block_type: "bricks" },
  }),
  block("dark_prismarine", {
    bedrockId: "prismarine",
    bedrockStates: { prismarine_block_type: "dark" },
  }),
  block("oak_planks", {
    bedrockId: "planks",
    bedrockStates: { wood_type: "oak" },
  }),
  block("spruce_planks", {
    bedrockId: "planks",
    bedrockStates: { wood_type: "spruce" },
  }),
  block("birch_planks", {
    bedrockId: "planks",
    bedrockStates: { wood_type: "birch" },
  }),
  block("jungle_planks", {
    bedrockId: "planks",
    bedrockStates: { wood_type: "jungle" },
  }),
  block("acacia_planks", {
    bedrockId: "planks",
    bedrockStates: { wood_type: "acacia" },
  }),
  block("dark_oak_planks", {
    bedrockId: "planks",
    bedrockStates: { wood_type: "dark_oak" },
  }),
  block("mangrove_planks"),
  block("cherry_planks"),
  block("bamboo_planks"),
  block("crimson_planks"),
  block("warped_planks"),
  block("copper_block"),
  block("cut_copper"),
  block("exposed_copper"),
  block("weathered_copper"),
  block("oxidized_copper"),
  block("raw_iron_block", { rare: true }),
  block("iron_block", { rare: true }),
  block("deepslate_gold_ore", { rare: true, noisy: true }),
  block("stone_bricks", {
    bedrockId: "stonebrick",
    bedrockStates: { stone_brick_type: "default" },
  }),
  block("mossy_stone_bricks", {
    bedrockId: "stonebrick",
    bedrockStates: { stone_brick_type: "mossy" },
    noisy: true,
  }),
  block("moss_block", { noisy: true, use: "decoration" }),
  block("vine", {
    bedrockStates: { vine_direction_bits: 1 },
    use: "decoration",
  }),
  block("glow_lichen", {
    bedrockStates: { multi_face_direction_bits: 1 },
    lightLevel: 7,
    use: "decoration",
  }),
  block("cobblestone", { use: "support" }),
  block("snow_block", { bedrockId: "snow" }),
  block("gold_block", { rare: true }),
  block("diamond_block", { rare: true }),
  block("emerald_block", { rare: true }),
  block("lapis_block", { rare: true }),
  block("redstone_block", { rare: true }),
  block("sand", {
    bedrockStates: { sand_type: "normal" },
    gravity: true,
    noisy: true,
  }),
  block("red_sand", {
    bedrockId: "sand",
    bedrockStates: { sand_type: "red" },
    gravity: true,
    noisy: true,
  }),
  block("gravel", { gravity: true, noisy: true }),
] as const;

const REGISTRY = new Map(DEFINITIONS.map((definition) => [definition.canonicalId, definition]));

const normalizeId = (blockId: string) => {
  const normalized = blockId.normalize("NFKC").trim().toLowerCase();
  return namespacedId(normalized);
};

const resolveVersion = <T>(versions: Record<string, T>, version: string): T => {
  const resolved = versions[version];
  if (resolved === undefined) throw new RangeError(`No block mapping is registered for ${version}`);
  return resolved;
};

export const getBlockDefinition = (blockId: string): VersionedBlockDefinition => {
  const canonicalId = normalizeId(blockId);
  return REGISTRY.get(canonicalId) ?? block(canonicalId);
};

const profileBlockAvailability = (canonicalId: string, versionId: string): boolean | null => {
  const profile = getJavaVersionProfile(versionId);
  if (!profile) return null;
  if (canonicalId === "minecraft:end_rod") return profile.blocks.endRod;
  if (canonicalId === "minecraft:white_stained_glass_pane") {
    return profile.blocks.whiteStainedGlassPane;
  }
  return true;
};

/** 先核对目标版本的已知方块事实，再用兼容 Profile 尝试序列化。 */
export const getJavaBlockCapability = (
  blockId: string,
  versionId = DEFAULT_MINECRAFT_VERSION.id,
): JavaBlockCapability => {
  const canonicalId = normalizeId(blockId);
  const profile = getJavaVersionProfile(versionId);
  if (!profile) {
    return {
      versionId,
      blockId: canonicalId,
      available: false,
      serializable: false,
      resolvedId: null,
      reason: "profile_unknown",
    };
  }
  if (profileBlockAvailability(canonicalId, versionId) === false) {
    const compatibility = getJavaCompatibilityProfile(versionId);
    const resolvedId = compatibility
      ? REGISTRY.get(canonicalId)?.java[compatibility.serializerProfile.id] ?? null
      : null;
    return {
      versionId,
      blockId: canonicalId,
      available: false,
      // 已知不存在只表示目标客户端可能拒绝，不禁止社区继续尝试产物。
      serializable: resolvedId !== null,
      resolvedId,
      reason: "block_unavailable",
    };
  }
  const compatibility = getJavaCompatibilityProfile(versionId);
  if (!compatibility) {
    return {
      versionId,
      blockId: canonicalId,
      available: true,
      serializable: false,
      resolvedId: null,
      reason: "profile_unverified",
    };
  }
  const definition = REGISTRY.get(canonicalId);
  const resolvedId = definition?.java[compatibility.serializerProfile.id] ?? null;
  return resolvedId
    ? {
        versionId,
        blockId: canonicalId,
        available: true,
        serializable: true,
        resolvedId,
        reason: "available",
      }
    : {
        versionId,
        blockId: canonicalId,
        available: true,
        serializable: false,
        resolvedId: null,
        reason: "mapping_unavailable",
      };
};

export const isJavaBlockAvailable = (blockId: string, versionId: string) =>
  getJavaBlockCapability(blockId, versionId).available;

export const resolveBedrockBlockMapping = (
  blockId: string,
  version = BEDROCK_1_20_VERSION,
): BedrockBlockMapping => {
  const canonicalId = normalizeId(blockId);
  const definition = REGISTRY.get(canonicalId);
  if (!definition) {
    throw new RangeError(`No Bedrock block mapping is registered for ${canonicalId}`);
  }
  const mapping = resolveVersion(definition.bedrock, version);
  return {
    blockId: mapping.blockId,
    states: { ...mapping.states },
  };
};

export const resolveBlockId = (
  blockId: string,
  edition: MinecraftEdition,
  version = edition === "java" ? DEFAULT_MINECRAFT_VERSION.id : BEDROCK_1_20_VERSION,
) => {
  const canonicalId = normalizeId(blockId);
  const definition = edition === "bedrock"
    ? REGISTRY.get(canonicalId)
    : getBlockDefinition(canonicalId);
  if (!definition) {
    throw new RangeError(`No Bedrock block mapping is registered for ${canonicalId}`);
  }
  if (edition === "bedrock") {
    return resolveVersion(definition.bedrock, version).blockId;
  }
  const capability = getJavaBlockCapability(canonicalId, version);
  if (!capability.serializable || !capability.resolvedId) {
    throw new RangeError(`No block mapping is registered for ${version}`);
  }
  return capability.resolvedId;
};

export const registeredBlocks = () => [...REGISTRY.values()];
