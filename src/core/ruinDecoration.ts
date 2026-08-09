import type {
  ProjectionBlock,
  ProjectionBlockState,
  ProjectionDocument,
} from "../types";
import {
  createProjectionDocument,
  iterateProjectionBlocks,
} from "./projectionDocument";

type Point = [number, number, number];

export interface RuinDecorationOptions {
  amount: number;
  seed?: number;
}

const DIRECTIONS = [
  { delta: [1, 0, 0] as Point, attachment: "west" },
  { delta: [-1, 0, 0] as Point, attachment: "east" },
  { delta: [0, 0, 1] as Point, attachment: "north" },
  { delta: [0, 0, -1] as Point, attachment: "south" },
] as const;

const key = (position: readonly number[]) => position.join(",");

const hashCoordinate = (position: readonly number[], seed: number) => {
  let hash = (seed ^ 0x9e3779b9) >>> 0;
  for (const value of position) {
    hash ^= Math.imul(value | 0, 0x85ebca6b);
    hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35) >>> 0;
  }
  return (hash ^ (hash >>> 16)) >>> 0;
};

const stateKey = (state: ProjectionBlockState) => {
  const properties = state.properties
    ? Object.entries(state.properties)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => `${name}=${value}`)
        .join(",")
    : "";
  return `${state.blockId}[${properties}]`;
};

const cloneState = (state: ProjectionBlockState): ProjectionBlockState => ({
  ...state,
  ...(state.properties ? { properties: { ...state.properties } } : {}),
  ...(state.color ? { color: [...state.color] as [number, number, number] } : {}),
});

const mossState = (hash: number): ProjectionBlockState => hash % 4 === 0
  ? { blockId: "minecraft:moss_block", color: [89, 109, 45] }
  : { blockId: "minecraft:mossy_stone_bricks", color: [115, 121, 105] };

const decorationState = (
  hash: number,
  attachment: string,
): ProjectionBlockState => hash % 5 === 0
  ? {
      blockId: "minecraft:glow_lichen",
      properties: {
        down: "false",
        east: "false",
        north: "false",
        south: "false",
        up: "false",
        waterlogged: "false",
        west: "false",
        [attachment]: "true",
      },
      emissive: true,
    }
  : {
      blockId: "minecraft:vine",
      properties: {
        east: "false",
        north: "false",
        south: "false",
        up: "false",
        west: "false",
        [attachment]: "true",
      },
    };

export const decorateAncientRuins = (
  document: ProjectionDocument,
  options: RuinDecorationOptions,
): ProjectionDocument => {
  const amount = Math.max(0, Math.min(1, options.amount / 100));
  if (amount === 0 || document.blockCount === 0) return document;
  const seed = Math.floor(options.seed ?? 0x4d454c59);
  const originalBlocks = [...iterateProjectionBlocks(document)];
  const occupied = new Set(originalBlocks.map((block) => key(block.position)));
  const palette = document.palette.map(cloneState);
  const paletteMap = new Map(palette.map((state, index) => [stateKey(state), index]));
  const paletteIndexFor = (state: ProjectionBlockState) => {
    const signature = stateKey(state);
    const existing = paletteMap.get(signature);
    if (existing !== undefined) return existing;
    const index = palette.length;
    palette.push(state);
    paletteMap.set(signature, index);
    return index;
  };
  const blocks: ProjectionBlock[] = [];
  const added = new Set<string>();

  for (const block of originalBlocks) {
    const hash = hashCoordinate(block.position, seed);
    const sourceState = document.palette[block.paletteIndex];
    const exposed = DIRECTIONS.filter(({ delta }) => !occupied.has(key([
      block.position[0] + delta[0],
      block.position[1] + delta[1],
      block.position[2] + delta[2],
    ])));
    const replace = exposed.length > 0
      && !sourceState.emissive
      && !["minecraft:vine", "minecraft:glow_lichen"].includes(sourceState.blockId)
      && (hash & 0xffff) / 0xffff < amount * 0.22;
    blocks.push({
      position: [...block.position],
      paletteIndex: replace ? paletteIndexFor(mossState(hash)) : block.paletteIndex,
    });

    if (!exposed.length || ((hash >>> 16) & 0xffff) / 0xffff >= amount * 0.16) continue;
    const direction = exposed[hash % exposed.length];
    const position: Point = [
      block.position[0] + direction.delta[0],
      block.position[1] + direction.delta[1],
      block.position[2] + direction.delta[2],
    ];
    const positionKey = key(position);
    if (occupied.has(positionKey) || added.has(positionKey)) continue;
    const state = decorationState(hash, direction.attachment);
    blocks.push({ position, paletteIndex: paletteIndexFor(state) });
    added.add(positionKey);
  }

  return createProjectionDocument(blocks, palette, {
    edition: document.edition,
    minecraftVersion: document.minecraftVersion,
    metadata: {
      ...document.metadata,
      ruinDecoration: Math.round(amount * 100),
      ruinDecorationSeed: seed,
    },
  });
};
