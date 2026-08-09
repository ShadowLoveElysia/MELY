import { ciede2000, rgbToLab, type Rgb } from "./color";
import { getBlockDefinition } from "./blockRegistry";

export interface EmissiveMaterialSample {
  color: Rgb;
  ambient?: readonly number[];
  emissive?: readonly number[];
  manual?: boolean;
}

export interface EmissiveBlockChoice {
  blockId: string;
  color: Rgb;
  lightLevel: number;
}

const LIGHT_BLOCKS: readonly EmissiveBlockChoice[] = [
  { blockId: "minecraft:end_rod", color: [232, 227, 212], lightLevel: 14 },
  { blockId: "minecraft:glowstone", color: [206, 153, 77], lightLevel: 15 },
  { blockId: "minecraft:sea_lantern", color: [172, 199, 190], lightLevel: 15 },
  { blockId: "minecraft:ochre_froglight", color: [246, 225, 157], lightLevel: 15 },
  { blockId: "minecraft:verdant_froglight", color: [211, 234, 208], lightLevel: 15 },
  { blockId: "minecraft:pearlescent_froglight", color: [238, 209, 228], lightLevel: 15 },
];

const channelEnergy = (channels: readonly number[] | undefined) => {
  if (!channels?.length) return 0;
  return channels.slice(0, 3).reduce((sum, channel) => sum + Math.max(0, channel), 0) / 3;
};

export const emissiveStrength = (sample: EmissiveMaterialSample) => {
  if (sample.manual) return 1;
  return channelEnergy(sample.emissive);
};

export const isEmissiveMaterial = (sample: EmissiveMaterialSample, threshold = 0.35) =>
  emissiveStrength(sample) >= threshold;

export const matchEmissiveBlock = (rgb: Rgb): EmissiveBlockChoice => {
  const target = rgbToLab(rgb);
  let best = LIGHT_BLOCKS[0];
  let bestDistance = Infinity;
  for (const candidate of LIGHT_BLOCKS) {
    const distance = ciede2000(target, rgbToLab(candidate.color));
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  const registered = getBlockDefinition(best.blockId);
  return { ...best, lightLevel: registered.lightLevel };
};

export const emissiveBlockChoices = () => [...LIGHT_BLOCKS];
