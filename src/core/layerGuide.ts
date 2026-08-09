export type LayerGuideAxis = "x" | "y" | "z";
export type LayerGuideDirection = "previous" | "next";
export type LayerGuidePoint = [number, number, number];

export interface LayerGuideInput<TPalette = unknown> {
  positions: ArrayLike<number>;
  paletteIndices: ArrayLike<number>;
  palette: readonly TPalette[];
}

export interface LayerGuideIndexedBlock {
  position: LayerGuidePoint;
  paletteIndex: number;
  sourceIndex: number;
}

export type LayerGuideCoordinateList = readonly number[] | Int32Array;

export interface LayerGuideIndexedSource<TPalette = unknown> {
  kind: "indexed";
  palette: readonly TPalette[];
  occupiedCoordinates: (axis: LayerGuideAxis) => LayerGuideCoordinateList;
  visitLayer: (
    axis: LayerGuideAxis,
    coordinate: number,
    visitor: (block: LayerGuideIndexedBlock) => void,
  ) => void;
}

export type LayerGuideSource<TPalette = unknown> =
  | LayerGuideInput<TPalette>
  | LayerGuideIndexedSource<TPalette>;

export interface LayerGuideBounds2D {
  min: [number, number];
  max: [number, number];
  dimensions: [number, number];
}

export interface LayerGuidePixel<TPalette = unknown> {
  position: LayerGuidePoint;
  u: number;
  v: number;
  paletteIndex: number;
  paletteEntry: TPalette;
  sourceIndex: number;
}

export interface LayerGuideLegendEntry<TPalette = unknown> {
  paletteIndex: number;
  paletteEntry: TPalette;
  count: number;
}

export interface LayerGuideSlice<TPalette = unknown> {
  axis: LayerGuideAxis;
  coordinate: number;
  uAxis: LayerGuideAxis;
  vAxis: LayerGuideAxis;
  bounds: LayerGuideBounds2D | null;
  pixels: LayerGuidePixel<TPalette>[];
  legend: LayerGuideLegendEntry<TPalette>[];
  blockCount: number;
}

export interface LayerGuideNavigation {
  coordinate: number;
  occupiedIndex: number;
  totalLayers: number;
  first: number | null;
  previous: number | null;
  next: number | null;
  last: number | null;
}

export interface LayerGuideProgress {
  format: "MELYLayerGuideProgress";
  version: 1;
  axis: LayerGuideAxis;
  completedCoordinates: number[];
}

export interface LayerGuideProgressSummary {
  completedLayers: number;
  remainingLayers: number;
  totalLayers: number;
  ratio: number;
}

const PROGRESS_FORMAT = "MELYLayerGuideProgress" as const;
const PROGRESS_VERSION = 1 as const;

const AXIS_LAYOUT: Record<LayerGuideAxis, {
  fixed: 0 | 1 | 2;
  u: 0 | 1 | 2;
  v: 0 | 1 | 2;
  uAxis: LayerGuideAxis;
  vAxis: LayerGuideAxis;
}> = {
  x: { fixed: 0, u: 2, v: 1, uAxis: "z", vAxis: "y" },
  y: { fixed: 1, u: 0, v: 2, uAxis: "x", vAxis: "z" },
  z: { fixed: 2, u: 0, v: 1, uAxis: "x", vAxis: "y" },
};

const compareNumber = (left: number, right: number) => left < right ? -1 : left > right ? 1 : 0;

function assertAxis(axis: string): asserts axis is LayerGuideAxis {
  if (!(axis in AXIS_LAYOUT)) throw new RangeError(`Unknown layer guide axis: ${axis}`);
}

const assertCoordinate = (value: number, label: string) => {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a safe integer`);
  }
};

const inputBlockCount = <TPalette>(input: LayerGuideInput<TPalette>) => {
  const blockCount = input.positions.length / 3;
  if (!Number.isSafeInteger(blockCount) || input.paletteIndices.length !== blockCount) {
    throw new RangeError("Layer guide buffers have inconsistent lengths");
  }
  return blockCount;
};

const isIndexedSource = <TPalette>(
  input: LayerGuideSource<TPalette>,
): input is LayerGuideIndexedSource<TPalette> =>
  "kind" in input && input.kind === "indexed";

const readPoint = <TPalette>(
  input: LayerGuideInput<TPalette>,
  sourceIndex: number,
): LayerGuidePoint => {
  const offset = sourceIndex * 3;
  const point: LayerGuidePoint = [
    Number(input.positions[offset]),
    Number(input.positions[offset + 1]),
    Number(input.positions[offset + 2]),
  ];
  point.forEach((coordinate, axis) => assertCoordinate(coordinate, `Layer guide xyz[${axis}]`));
  return point;
};

const readPaletteIndex = <TPalette>(
  input: LayerGuideInput<TPalette>,
  sourceIndex: number,
) => {
  const paletteIndex = Number(input.paletteIndices[sourceIndex]);
  if (!Number.isSafeInteger(paletteIndex)
    || paletteIndex < 0
    || paletteIndex >= input.palette.length) {
    throw new RangeError(`Unknown layer guide palette index: ${paletteIndex}`);
  }
  return paletteIndex;
};

const canonicalCoordinates = (coordinates: Iterable<number>) => {
  const unique = new Set<number>();
  for (const coordinate of coordinates) {
    assertCoordinate(coordinate, "Layer coordinate");
    unique.add(coordinate);
  }
  return [...unique].sort(compareNumber);
};

const lowerBound = (coordinates: readonly number[], target: number) => {
  let low = 0;
  let high = coordinates.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (coordinates[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
};

export const listOccupiedLayerCoordinates = <TPalette>(
  input: LayerGuideSource<TPalette>,
  axis: LayerGuideAxis,
) => {
  assertAxis(axis);
  if (isIndexedSource(input)) return input.occupiedCoordinates(axis);
  const fixedAxis = AXIS_LAYOUT[axis].fixed;
  const coordinates = new Set<number>();
  const blockCount = inputBlockCount(input);
  for (let sourceIndex = 0; sourceIndex < blockCount; sourceIndex += 1) {
    const point = readPoint(input, sourceIndex);
    readPaletteIndex(input, sourceIndex);
    coordinates.add(point[fixedAxis]);
  }
  return [...coordinates].sort(compareNumber);
};

export const createLayerGuideSlice = <TPalette>(
  input: LayerGuideSource<TPalette>,
  axis: LayerGuideAxis,
  coordinate: number,
): LayerGuideSlice<TPalette> => {
  assertAxis(axis);
  assertCoordinate(coordinate, "Layer coordinate");
  const layout = AXIS_LAYOUT[axis];
  const pixels: LayerGuidePixel<TPalette>[] = [];
  const legendCounts = new Map<number, number>();
  let minU = Infinity;
  let minV = Infinity;
  let maxU = -Infinity;
  let maxV = -Infinity;

  const append = (
    position: LayerGuidePoint,
    paletteIndex: number,
    sourceIndex: number,
  ) => {
    if (!Number.isSafeInteger(paletteIndex)
      || paletteIndex < 0
      || paletteIndex >= input.palette.length) {
      throw new RangeError(`Unknown layer guide palette index: ${paletteIndex}`);
    }
    position.forEach((value, positionAxis) =>
      assertCoordinate(value, `Layer guide xyz[${positionAxis}]`));
    if (position[layout.fixed] !== coordinate) return;
    const u = position[layout.u];
    const v = position[layout.v];
    pixels.push({
      position,
      u,
      v,
      paletteIndex,
      paletteEntry: input.palette[paletteIndex],
      sourceIndex,
    });
    legendCounts.set(paletteIndex, (legendCounts.get(paletteIndex) ?? 0) + 1);
    minU = Math.min(minU, u);
    minV = Math.min(minV, v);
    maxU = Math.max(maxU, u);
    maxV = Math.max(maxV, v);
  };

  if (isIndexedSource(input)) {
    input.visitLayer(axis, coordinate, ({ position, paletteIndex, sourceIndex }) => {
      append(position, paletteIndex, sourceIndex);
    });
  } else {
    const blockCount = inputBlockCount(input);
    for (let sourceIndex = 0; sourceIndex < blockCount; sourceIndex += 1) {
      const position = readPoint(input, sourceIndex);
      const paletteIndex = readPaletteIndex(input, sourceIndex);
      append(position, paletteIndex, sourceIndex);
    }
  }

  pixels.sort((left, right) =>
    compareNumber(left.v, right.v)
    || compareNumber(left.u, right.u)
    || compareNumber(left.paletteIndex, right.paletteIndex)
    || compareNumber(left.sourceIndex, right.sourceIndex));
  const legend = [...legendCounts.entries()]
    .sort(([left], [right]) => compareNumber(left, right))
    .map(([paletteIndex, count]) => ({
      paletteIndex,
      paletteEntry: input.palette[paletteIndex],
      count,
    }));
  const bounds = pixels.length === 0
    ? null
    : {
        min: [minU, minV] as [number, number],
        max: [maxU, maxV] as [number, number],
        dimensions: [maxU - minU + 1, maxV - minV + 1] as [number, number],
      };

  return {
    axis,
    coordinate,
    uAxis: layout.uAxis,
    vAxis: layout.vAxis,
    bounds,
    pixels,
    legend,
    blockCount: pixels.length,
  };
};

export const getLayerGuideNavigation = (
  occupiedCoordinates: Iterable<number>,
  coordinate: number,
): LayerGuideNavigation => {
  assertCoordinate(coordinate, "Layer coordinate");
  const coordinates = canonicalCoordinates(occupiedCoordinates);
  const insertionIndex = lowerBound(coordinates, coordinate);
  const occupied = coordinates[insertionIndex] === coordinate;
  return {
    coordinate,
    occupiedIndex: occupied ? insertionIndex : -1,
    totalLayers: coordinates.length,
    first: coordinates[0] ?? null,
    previous: coordinates[occupied ? insertionIndex - 1 : insertionIndex - 1] ?? null,
    next: coordinates[occupied ? insertionIndex + 1 : insertionIndex] ?? null,
    last: coordinates.at(-1) ?? null,
  };
};

export const getAdjacentLayerCoordinate = (
  occupiedCoordinates: Iterable<number>,
  coordinate: number,
  direction: LayerGuideDirection,
) => {
  const navigation = getLayerGuideNavigation(occupiedCoordinates, coordinate);
  return direction === "previous" ? navigation.previous : navigation.next;
};

export const createLayerGuideProgress = (
  axis: LayerGuideAxis,
  completedCoordinates: Iterable<number> = [],
): LayerGuideProgress => {
  assertAxis(axis);
  return {
    format: PROGRESS_FORMAT,
    version: PROGRESS_VERSION,
    axis,
    completedCoordinates: canonicalCoordinates(completedCoordinates),
  };
};

export const setLayerCompleted = (
  progress: LayerGuideProgress,
  coordinate: number,
  completed: boolean,
) => {
  const normalized = createLayerGuideProgress(progress.axis, progress.completedCoordinates);
  assertCoordinate(coordinate, "Layer coordinate");
  const coordinates = new Set(normalized.completedCoordinates);
  if (completed) coordinates.add(coordinate);
  else coordinates.delete(coordinate);
  return createLayerGuideProgress(normalized.axis, coordinates);
};

export const isLayerCompleted = (
  progress: LayerGuideProgress,
  coordinate: number,
) => {
  assertCoordinate(coordinate, "Layer coordinate");
  const coordinates = canonicalCoordinates(progress.completedCoordinates);
  return coordinates[lowerBound(coordinates, coordinate)] === coordinate;
};

export const summarizeLayerGuideProgress = (
  progress: LayerGuideProgress,
  occupiedCoordinates: Iterable<number>,
): LayerGuideProgressSummary => {
  const occupied = canonicalCoordinates(occupiedCoordinates);
  const completed = new Set(createLayerGuideProgress(
    progress.axis,
    progress.completedCoordinates,
  ).completedCoordinates);
  const completedLayers = occupied.reduce(
    (count, coordinate) => count + Number(completed.has(coordinate)),
    0,
  );
  return {
    completedLayers,
    remainingLayers: occupied.length - completedLayers,
    totalLayers: occupied.length,
    ratio: occupied.length === 0 ? 0 : completedLayers / occupied.length,
  };
};

export const serializeLayerGuideProgress = (progress: LayerGuideProgress) =>
  JSON.stringify(createLayerGuideProgress(progress.axis, progress.completedCoordinates));

export const deserializeLayerGuideProgress = (serialized: string): LayerGuideProgress => {
  const value: unknown = JSON.parse(serialized);
  if (!value || typeof value !== "object") {
    throw new TypeError("Layer guide progress must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.format !== PROGRESS_FORMAT || record.version !== PROGRESS_VERSION) {
    throw new RangeError("Unsupported layer guide progress format or version");
  }
  if (typeof record.axis !== "string") throw new TypeError("Layer guide progress axis is missing");
  assertAxis(record.axis);
  if (!Array.isArray(record.completedCoordinates)) {
    throw new TypeError("Layer guide completed coordinates must be an array");
  }
  if (!record.completedCoordinates.every((coordinate) => typeof coordinate === "number")) {
    throw new TypeError("Layer guide completed coordinates must contain numbers");
  }
  return createLayerGuideProgress(record.axis, record.completedCoordinates);
};
