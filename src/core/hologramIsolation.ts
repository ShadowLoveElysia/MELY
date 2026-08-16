type Point = readonly [number, number, number];

export interface HologramIsolationBlock {
  position: Point;
  paletteIndex: number;
}

export interface HologramIsolationState {
  blockId: string;
}

const POSITIVE_NEIGHBOURS: readonly Point[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

const positionKey = ([x, y, z]: Point) => `${x},${y},${z}`;

const assertIntegerPoint = (point: Point) => {
  if (!point.every(Number.isSafeInteger)) {
    throw new RangeError(`Hologram coordinates must be safe integers: ${positionKey(point)}`);
  }
};

/**
 * 验证投影坐标的六向隔离不变量。只检查正方向即可覆盖每一对相邻坐标。
 */
export const assertSixWayIsolated = (
  positions: Iterable<Point>,
  context = "Hologram",
) => {
  const occupied = new Set<string>();
  for (const point of positions) {
    assertIntegerPoint(point);
    const key = positionKey(point);
    if (occupied.has(key)) {
      throw new Error(`${context} contains duplicate projection blocks at ${key}`);
    }
    occupied.add(key);
  }

  for (const key of occupied) {
    const [x, y, z] = key.split(",").map(Number) as [number, number, number];
    for (const [dx, dy, dz] of POSITIVE_NEIGHBOURS) {
      const neighbour = positionKey([x + dx, y + dy, z + dz]);
      if (occupied.has(neighbour)) {
        throw new Error(`${context} violates six-way isolation at ${key} and ${neighbour}`);
      }
    }
  }
};

export const isIsolatedHologramState = (state: HologramIsolationState | undefined) => {
  const blockId = state?.blockId.replace(/^minecraft:/, "");
  return blockId === "end_rod"
    || blockId === "white_stained_glass_pane"
    || blockId === "stained_glass_pane";
};

/**
 * 供 ProjectionDocument 和各导出器共用；材质混合时仍视为同一隔离集合。
 */
export const assertHologramBlockIsolation = (
  blocks: Iterable<HologramIsolationBlock>,
  palette: readonly HologramIsolationState[],
  context = "Hologram projection",
) => {
  const positions: Point[] = [];
  for (const block of blocks) {
    if (isIsolatedHologramState(palette[block.paletteIndex])) {
      positions.push(block.position);
    }
  }
  assertSixWayIsolated(positions, context);
};
