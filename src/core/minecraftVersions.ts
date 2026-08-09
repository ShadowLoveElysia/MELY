export interface MinecraftVersionProfile {
  id: string;
  label: string;
  dataVersion: number;
  litematicVersion: number;
  litematicSubVersion: number;
}

export interface BedrockVersionProfile {
  id: string;
  label: string;
  minEngineVersion: readonly [number, number, number];
  blockVersion: number;
}

export const MINECRAFT_1_20_1: MinecraftVersionProfile = {
  id: "1.20.1",
  label: "Minecraft Java 1.20.1",
  dataVersion: 3465,
  litematicVersion: 6,
  litematicSubVersion: 1,
};

export const BEDROCK_1_20_10: BedrockVersionProfile = {
  id: "1.20.10",
  label: "Minecraft Bedrock 1.20.10",
  minEngineVersion: [1, 20, 10],
  blockVersion: 0x0114_0a01,
};

export const DEFAULT_MINECRAFT_VERSION = MINECRAFT_1_20_1;
export const DEFAULT_BEDROCK_VERSION = BEDROCK_1_20_10;
