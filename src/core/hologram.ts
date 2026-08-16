import type {
  FaceFrameSnapshot,
  HologramMaterial,
  HologramMeshSnapshot,
  HologramOptions,
  HologramResult,
} from "../types";
import { appError } from "./appError";
import {
  faceFeaturePriority,
  faceLocalPoint,
  featureInsideFace,
  materialFaceFeatureKind,
  normalizeFaceFrameSnapshot,
  pointInsideFaceRegion,
  validFaceFrame,
  type FaceFeatureKind,
} from "./faceFeatures";
import { assertSixWayIsolated } from "./hologramIsolation";

type Point = [number, number, number];
type FeatureKind = "outline" | "garment" | "face" | "depth" | "slice";
type SampleTier = "interior" | "surface" | "outline" | "critical";
type InteriorMode = "disabled" | "closed-volume" | "shell-fallback" | "unavailable";

export interface HologramDensityOptions extends HologramOptions {
  interiorDensity?: number;
  contentHash?: string;
  minecraftVersion?: string;
}

export interface HologramInteriorStats {
  interiorDensity: number;
  interiorMode: InteriorMode;
  interiorCandidateCount: number;
  interiorSelectedCount: number;
  interiorBlockCount: number;
  interiorSamplingStride: number;
  interiorWarnings: string[];
}

export type HologramDensityResult = Omit<HologramResult, "stats"> & {
  stats: HologramResult["stats"] & HologramInteriorStats;
};

interface FeatureCurve {
  kind: FeatureKind;
  priority: number;
  points: Point[];
}

interface Sample {
  position: Point;
  facing: number;
  material: number;
  priority: number;
  tier: SampleTier;
  stableScore: number;
}

interface FeatureSegment {
  start: Point;
  end: Point;
  normal: Point;
  kind: FeatureKind;
  priority: number;
  stepMultiplier: number;
}

interface MeshEdge {
  a: number;
  b: number;
  fromKey: string;
  toKey: string;
  firstTriangle: number;
  secondTriangle: number;
  triangleCount: number;
  windingBalance: number;
}

interface MeshGeometry {
  positions: Float32Array;
  indices: Uint32Array;
  triangleMaterials: Uint16Array;
  triangleNormals: Float32Array;
  triangleAreas: Float32Array;
  faceFeatureKinds: Array<FaceFeatureKind | undefined>;
  faceFrame?: FaceFrameSnapshot;
  height: number;
  bounds: {
    min: Point;
    max: Point;
  };
}

interface MeshTopology {
  closed: boolean;
  reason:
    | "closed"
    | "open"
    | "non-manifold"
    | "inconsistent-winding"
    | "degenerate"
    | "self-intersecting"
    | "self-intersection-unverified";
}

interface TriangleIntersectionEntry {
  triangleIndex: number;
  vertices: [Point, Point, Point];
  vertexKeys: [string, string, string];
  min: Point;
  max: Point;
}

interface InteriorSampling {
  samples: Sample[];
  mode: InteriorMode;
  candidateCount: number;
  selectedCount: number;
  samplingStride: number;
  warnings: string[];
}

interface ScanlineTriangle {
  a: Point;
  edge1: Point;
  edge2: Point;
  yzDeterminant: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

interface FaceClassification {
  inside: boolean;
  feature?: FaceFeatureKind;
}

type HologramProgress = (stage: "tracing" | "sampling" | "isolation", progress: number) => void;

const circle = (
  center: Point,
  radiusX: number,
  radiusY: number,
  depth: number,
  start = 0,
  end = Math.PI * 2,
  segments = 40,
): Point[] =>
  Array.from({ length: segments + 1 }, (_, index) => {
    const angle = start + ((end - start) * index) / segments;
    return [
      center[0] + Math.cos(angle) * radiusX,
      center[1] + Math.sin(angle) * radiusY,
      center[2] + Math.sin(angle * 2) * depth,
    ];
  });

const line = (...points: Point[]) => points;

const buildDemoFeatures = (preserveFace: boolean): FeatureCurve[] => {
  const features: FeatureCurve[] = [
    { kind: "outline", priority: 1, points: circle([0, 0.84, 0], 0.105, 0.125, 0.012) },
    {
      kind: "outline",
      priority: 0.95,
      points: circle([0, 0.865, -0.008], 0.135, 0.165, 0.02, Math.PI * 0.05, Math.PI * 0.95, 32),
    },
    {
      kind: "outline",
      priority: 0.92,
      points: line(
        [-0.122, 0.895, -0.012],
        [-0.145, 0.81, -0.018],
        [-0.132, 0.72, -0.012],
        [-0.105, 0.655, 0],
      ),
    },
    {
      kind: "outline",
      priority: 0.92,
      points: line(
        [0.122, 0.895, -0.012],
        [0.145, 0.81, -0.018],
        [0.132, 0.72, -0.012],
        [0.105, 0.655, 0],
      ),
    },
    {
      kind: "outline",
      priority: 0.9,
      points: line([-0.055, 0.72, 0], [-0.16, 0.695, 0], [-0.205, 0.61, 0.008], [-0.19, 0.49, 0.015]),
    },
    {
      kind: "outline",
      priority: 0.9,
      points: line([0.055, 0.72, 0], [0.16, 0.695, 0], [0.205, 0.61, 0.008], [0.19, 0.49, 0.015]),
    },
    {
      kind: "outline",
      priority: 0.86,
      points: line([-0.16, 0.69, 0], [-0.28, 0.61, 0.005], [-0.31, 0.49, 0.015], [-0.27, 0.38, 0.02]),
    },
    {
      kind: "outline",
      priority: 0.86,
      points: line([0.16, 0.69, 0], [0.28, 0.61, 0.005], [0.31, 0.49, 0.015], [0.27, 0.38, 0.02]),
    },
    {
      kind: "garment",
      priority: 0.82,
      points: line([-0.19, 0.49, 0], [-0.235, 0.355, 0.02], [-0.29, 0.245, 0.018], [-0.22, 0.205, 0]),
    },
    {
      kind: "garment",
      priority: 0.82,
      points: line([0.19, 0.49, 0], [0.235, 0.355, 0.02], [0.29, 0.245, 0.018], [0.22, 0.205, 0]),
    },
    {
      kind: "garment",
      priority: 0.84,
      points: circle([0, 0.235, 0], 0.245, 0.05, 0.045, Math.PI, Math.PI * 2, 32),
    },
    {
      kind: "garment",
      priority: 0.75,
      points: circle([0, 0.235, -0.02], 0.245, 0.05, 0.04, 0, Math.PI, 32),
    },
    {
      kind: "outline",
      priority: 0.9,
      points: line([-0.115, 0.215, 0], [-0.12, 0.13, 0.006], [-0.105, 0.035, 0.012], [-0.09, 0, 0.025]),
    },
    {
      kind: "outline",
      priority: 0.9,
      points: line([0.115, 0.215, 0], [0.12, 0.13, 0.006], [0.105, 0.035, 0.012], [0.09, 0, 0.025]),
    },
    {
      kind: "outline",
      priority: 0.76,
      points: line([-0.125, 0.2, -0.015], [-0.15, 0.115, -0.02], [-0.14, 0.025, -0.01]),
    },
    {
      kind: "outline",
      priority: 0.76,
      points: line([0.125, 0.2, -0.015], [0.15, 0.115, -0.02], [0.14, 0.025, -0.01]),
    },
    {
      kind: "garment",
      priority: 0.7,
      points: line([-0.16, 0.46, 0.02], [-0.085, 0.42, 0.035], [0, 0.405, 0.04], [0.085, 0.42, 0.035], [0.16, 0.46, 0.02]),
    },
    {
      kind: "garment",
      priority: 0.72,
      points: line([-0.19, 0.34, 0.025], [-0.09, 0.31, 0.045], [0, 0.3, 0.05], [0.09, 0.31, 0.045], [0.19, 0.34, 0.025]),
    },
    {
      kind: "depth",
      priority: 0.68,
      points: line([0, 0.72, -0.085], [0, 0.58, -0.105], [0, 0.42, -0.09], [0, 0.25, -0.055]),
    },
    {
      kind: "depth",
      priority: 0.64,
      points: circle([0, 0.55, 0], 0.19, 0.02, 0.085, 0, Math.PI * 2, 28),
    },
  ];

  if (preserveFace) {
    features.push(
      { kind: "face", priority: 1.2, points: line([-0.065, 0.865, 0.105], [-0.025, 0.862, 0.115]) },
      { kind: "face", priority: 1.2, points: line([0.025, 0.862, 0.115], [0.065, 0.865, 0.105]) },
      { kind: "face", priority: 1.1, points: line([-0.022, 0.79, 0.113], [0, 0.784, 0.118], [0.022, 0.79, 0.113]) },
      { kind: "face", priority: 1.05, points: line([0, 0.84, 0.118], [-0.006, 0.815, 0.122]) },
    );
  }

  return features;
};

const distance = (a: Point, b: Point) =>
  Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);

const normalize = (vector: Point): Point => {
  const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;
  return [vector[0] / length, vector[1] / length, vector[2] / length];
};

const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const subtract = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

const add = (a: Point, b: Point): Point => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

const multiply = (vector: Point, scalar: number): Point => [
  vector[0] * scalar,
  vector[1] * scalar,
  vector[2] * scalar,
];

const cross = (a: Point, b: Point): Point => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

const midpoint = (a: Point, b: Point): Point => multiply(add(a, b), 0.5);

const VERTICAL_FACING = 2;
export const MAX_HOLOGRAM_BLOCKS = 320_000;
export const MAX_HOLOGRAM_CANDIDATES = 1_280_000;
const HASH_RANGE = 0x1_0000_0000;

const sampleTierForFeature = (kind: FeatureKind): SampleTier => {
  if (kind === "face") return "critical";
  if (kind === "outline" || kind === "garment") return "outline";
  return "surface";
};

const TIER_PRIORITY: Record<SampleTier, number> = {
  interior: 0,
  surface: 1,
  outline: 2,
  critical: 3,
};

const hashString = (value: string) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

const hashCoordinate = ([x, y, z]: Point, seed: number) => {
  let hash = (seed ^ 0x9e3779b9) >>> 0;
  for (const value of [x, y, z]) {
    hash ^= Math.imul(value | 0, 0x85ebca6b);
    hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35) >>> 0;
  }
  return (hash ^ (hash >>> 16)) >>> 0;
};

const normalizeInteriorDensity = (density: number | undefined) => {
  if (density === undefined) return 0;
  if (!Number.isFinite(density)) {
    throw new RangeError("Hologram interior density must be a finite number");
  }
  return Math.max(0, Math.min(100, density));
};

const materialForFeature = (material: HologramMaterial, kind: FeatureKind) => {
  if (material === "end_rod") return 0;
  if (material === "white_pane") return 1;
  return kind === "garment" || kind === "depth" || kind === "slice" ? 1 : 0;
};

const quantize = (point: Point): Point => [Math.round(point[0]), Math.round(point[1]), Math.round(point[2])];

const pointKey = ([x, y, z]: Point) => `${x},${y},${z}`;

const neighboursOf = ([x, y, z]: Point): Point[] => [
  [x + 1, y, z],
  [x - 1, y, z],
  [x, y + 1, z],
  [x, y - 1, z],
  [x, y, z + 1],
  [x, y, z - 1],
];

const hasIsolationConflict = (sample: Sample, accepted: Map<string, Sample>) => {
  const [x, y, z] = sample.position;
  return neighboursOf([x, y, z]).some((position) => accepted.has(pointKey(position)));
};

const compareSamples = (left: Sample, right: Sample) => {
  const positionOrder = left.position[1] - right.position[1]
    || left.position[2] - right.position[2]
    || left.position[0] - right.position[0];
  return TIER_PRIORITY[right.tier] - TIER_PRIORITY[left.tier]
    || right.priority - left.priority
    || left.material - right.material
    || (left.tier === "interior" ? left.stableScore - right.stableScore : positionOrder)
    || (left.tier === "interior" ? positionOrder : left.stableScore - right.stableScore);
};

const emptyInteriorSampling = (): InteriorSampling => ({
  samples: [],
  mode: "disabled",
  candidateCount: 0,
  selectedCount: 0,
  samplingStride: 0,
  warnings: [],
});

const finalizeSamples = (
  rawSamples: Sample[],
  options: HologramDensityOptions,
  interior: InteriorSampling = emptyInteriorSampling(),
): HologramDensityResult => {
  rawSamples.sort(compareSamples);
  const accepted = new Map<string, Sample>();
  let removedConflicts = 0;
  let interiorBlockCount = 0;

  for (const sample of rawSamples) {
    const key = pointKey(sample.position);
    if (accepted.has(key)) continue;

    if (hasIsolationConflict(sample, accepted)) {
      removedConflicts += 1;
      continue;
    }

    accepted.set(key, sample);
    if (sample.tier === "interior") interiorBlockCount += 1;
  }

  const samples = [...accepted.values()];
  if (samples.length === 0) throw appError("error.hologram.empty");
  if (samples.length > MAX_HOLOGRAM_BLOCKS) {
    throw new RangeError(
      `Hologram blocks ${samples.length} exceed the safe limit ${MAX_HOLOGRAM_BLOCKS}`,
    );
  }
  assertSixWayIsolated(samples.map((sample) => sample.position), "Generated hologram");

  const positions = new Float32Array(samples.length * 3);
  const facings = new Uint8Array(samples.length);
  const materials = new Uint8Array(samples.length);
  const min: Point = [Infinity, Infinity, Infinity];
  const max: Point = [-Infinity, -Infinity, -Infinity];
  let endRodCount = 0;
  let paneCount = 0;

  samples.forEach((sample, index) => {
    positions.set(sample.position, index * 3);
    facings[index] = sample.facing;
    materials[index] = sample.material;

    if (sample.material === 0) endRodCount += 1;
    else paneCount += 1;

    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], sample.position[axis]);
      max[axis] = Math.max(max[axis], sample.position[axis]);
    }
  });

  const dimensions: [number, number, number] = [
    max[0] - min[0] + 1,
    max[1] - min[1] + 1,
    max[2] - min[2] + 1,
  ];

  return {
    positions,
    facings,
    materials,
    stats: {
      blockCount: samples.length,
      endRodCount,
      paneCount,
      removedConflicts,
      dimensions,
      interiorDensity: normalizeInteriorDensity(options.interiorDensity),
      interiorMode: interior.mode,
      interiorCandidateCount: interior.candidateCount,
      interiorSelectedCount: interior.selectedCount,
      interiorBlockCount,
      interiorSamplingStride: interior.samplingStride,
      interiorWarnings: interior.warnings,
    },
    bounds: { min, max },
  };
};

const pointFromBuffer = (positions: Float32Array, index: number): Point => [
  positions[index * 3],
  positions[index * 3 + 1],
  positions[index * 3 + 2],
];

const normalizeMesh = (snapshot: HologramMeshSnapshot, targetHeight: number): MeshGeometry => {
  if (snapshot.positions.length === 0 || snapshot.positions.length % 3 !== 0) {
    throw appError("error.mesh.invalidVertices");
  }
  if (snapshot.indices.length === 0 || snapshot.indices.length % 3 !== 0) {
    throw appError("error.mesh.invalidTriangles");
  }

  const vertexCount = snapshot.positions.length / 3;
  const min: Point = [Infinity, Infinity, Infinity];
  const max: Point = [-Infinity, -Infinity, -Infinity];
  for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = snapshot.positions[vertexIndex * 3 + axis];
      if (!Number.isFinite(value)) throw appError("error.mesh.nonFiniteVertex");
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    }
  }

  const sourceHeight = max[1] - min[1];
  if (sourceHeight <= 1e-6) throw appError("error.mesh.zeroHeight");
  const targetSpan = Math.max(1, Math.round(targetHeight) - 1);
  const scale = targetSpan / sourceHeight;
  const centerX = (min[0] + max[0]) * 0.5;
  const centerZ = (min[2] + max[2]) * 0.5;
  const positions = new Float32Array(snapshot.positions.length);

  for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex += 1) {
    positions[vertexIndex * 3] = (snapshot.positions[vertexIndex * 3] - centerX) * scale;
    positions[vertexIndex * 3 + 1] = (snapshot.positions[vertexIndex * 3 + 1] - min[1]) * scale;
    positions[vertexIndex * 3 + 2] = (snapshot.positions[vertexIndex * 3 + 2] - centerZ) * scale;
  }

  const triangleCount = snapshot.indices.length / 3;
  const triangleNormals = new Float32Array(triangleCount * 3);
  const triangleAreas = new Float32Array(triangleCount);
  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
    const aIndex = snapshot.indices[triangleIndex * 3];
    const bIndex = snapshot.indices[triangleIndex * 3 + 1];
    const cIndex = snapshot.indices[triangleIndex * 3 + 2];
    if (aIndex >= vertexCount || bIndex >= vertexCount || cIndex >= vertexCount) {
      throw appError("error.mesh.invalidTriangleVertex");
    }
    const a = pointFromBuffer(positions, aIndex);
    const b = pointFromBuffer(positions, bIndex);
    const c = pointFromBuffer(positions, cIndex);
    const rawNormal = cross(subtract(b, a), subtract(c, a));
    const doubleArea = Math.hypot(...rawNormal);
    const normal = doubleArea > 1e-8 ? multiply(rawNormal, 1 / doubleArea) : [0, 1, 0] as Point;
    triangleNormals.set(normal, triangleIndex * 3);
    triangleAreas[triangleIndex] = doubleArea * 0.5;
  }

  const triangleMaterials = snapshot.triangleMaterials.length === triangleCount
    ? snapshot.triangleMaterials
    : new Uint16Array(triangleCount);
  const faceFrame = normalizeFaceFrameSnapshot(
    snapshot.faceFrame,
    centerX,
    min[1],
    centerZ,
    scale,
  );
  return {
    positions,
    indices: snapshot.indices,
    triangleMaterials,
    triangleNormals,
    triangleAreas,
    faceFeatureKinds: snapshot.materials?.map(materialFaceFeatureKind) ?? [],
    faceFrame,
    height: targetSpan,
    bounds: {
      min: [
        (min[0] - centerX) * scale,
        0,
        (min[2] - centerZ) * scale,
      ],
      max: [
        (max[0] - centerX) * scale,
        targetSpan,
        (max[2] - centerZ) * scale,
      ],
    },
  };
};

const classifyFacePoint = (
  geometry: MeshGeometry,
  position: Point,
  triangleIndices: readonly number[],
): FaceClassification => {
  if (!validFaceFrame(geometry.faceFrame)) return { inside: false };
  const local = faceLocalPoint(position, geometry.faceFrame);
  if (!pointInsideFaceRegion(local)) return { inside: false };

  let feature: FaceFeatureKind | undefined;
  for (const triangleIndex of triangleIndices) {
    if (triangleIndex < 0) continue;
    const materialIndex = geometry.triangleMaterials[triangleIndex] ?? 0;
    const candidate = geometry.faceFeatureKinds[materialIndex];
    if (
      candidate
      && featureInsideFace(candidate, local)
      && faceFeaturePriority(candidate) > faceFeaturePriority(feature)
    ) {
      feature = candidate;
    }
  }
  return { inside: true, feature };
};

const triangleNormal = (geometry: MeshGeometry, triangleIndex: number): Point => [
  geometry.triangleNormals[triangleIndex * 3],
  geometry.triangleNormals[triangleIndex * 3 + 1],
  geometry.triangleNormals[triangleIndex * 3 + 2],
];

const buildMeshEdges = (geometry: MeshGeometry) => {
  const edges = new Map<string, MeshEdge>();
  const vertexKeys = new Array<string>(geometry.positions.length / 3);
  const vertexKey = (index: number) => {
    const cached = vertexKeys[index];
    if (cached) return cached;
    const point = pointFromBuffer(geometry.positions, index);
    const key = `${Math.round(point[0] * 1000)},${Math.round(point[1] * 1000)},${Math.round(point[2] * 1000)}`;
    vertexKeys[index] = key;
    return key;
  };
  const addEdge = (a: number, b: number, triangleIndex: number) => {
    const aKey = vertexKey(a);
    const bKey = vertexKey(b);
    const key = aKey < bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`;
    const existing = edges.get(key);
    if (existing) {
      existing.triangleCount += 1;
      const sameDirection = existing.fromKey === aKey && existing.toKey === bKey;
      existing.windingBalance += sameDirection ? 1 : -1;
      if (existing.secondTriangle === -1) existing.secondTriangle = triangleIndex;
      return;
    }
    edges.set(key, {
      a,
      b,
      fromKey: aKey,
      toKey: bKey,
      firstTriangle: triangleIndex,
      secondTriangle: -1,
      triangleCount: 1,
      windingBalance: 1,
    });
  };

  for (let offset = 0; offset < geometry.indices.length; offset += 3) {
    const triangleIndex = offset / 3;
    const a = geometry.indices[offset];
    const b = geometry.indices[offset + 1];
    const c = geometry.indices[offset + 2];
    addEdge(a, b, triangleIndex);
    addEdge(b, c, triangleIndex);
    addEdge(c, a, triangleIndex);
  }
  return edges;
};

const SELF_INTERSECTION_EPSILON = 1e-7;
const MAX_SELF_INTERSECTION_PAIR_TESTS = 8_000_000;

const triangleVertexKeys = (geometry: MeshGeometry, triangleIndex: number) => (
  [0, 1, 2].map((corner) => {
    const point = pointFromBuffer(geometry.positions, geometry.indices[triangleIndex * 3 + corner]);
    return `${Math.round(point[0] * 1000)},${Math.round(point[1] * 1000)},${Math.round(point[2] * 1000)}`;
  }) as [string, string, string]
);

const triangleIntersectionEntry = (
  geometry: MeshGeometry,
  triangleIndex: number,
): TriangleIntersectionEntry => {
  const vertices = triangleAt(geometry, triangleIndex);
  return {
    triangleIndex,
    vertices,
    vertexKeys: triangleVertexKeys(geometry, triangleIndex),
    min: [
      Math.min(vertices[0][0], vertices[1][0], vertices[2][0]),
      Math.min(vertices[0][1], vertices[1][1], vertices[2][1]),
      Math.min(vertices[0][2], vertices[1][2], vertices[2][2]),
    ],
    max: [
      Math.max(vertices[0][0], vertices[1][0], vertices[2][0]),
      Math.max(vertices[0][1], vertices[1][1], vertices[2][1]),
      Math.max(vertices[0][2], vertices[1][2], vertices[2][2]),
    ],
  };
};

const sharesVertex = (left: TriangleIntersectionEntry, right: TriangleIntersectionEntry) =>
  left.vertexKeys.some((leftKey) => right.vertexKeys.includes(leftKey));

const overlapsTriangleBounds = (
  left: TriangleIntersectionEntry,
  right: TriangleIntersectionEntry,
) => [0, 1, 2].every((axis) => (
  left.min[axis] <= right.max[axis] + SELF_INTERSECTION_EPSILON
  && right.min[axis] <= left.max[axis] + SELF_INTERSECTION_EPSILON
));

const pointInTriangle3d = (point: Point, triangle: [Point, Point, Point]) => {
  const [a, b, c] = triangle;
  const edge0 = subtract(b, a);
  const edge1 = subtract(c, a);
  const relative = subtract(point, a);
  const normal = cross(edge0, edge1);
  const normalLength = Math.hypot(...normal);
  if (normalLength <= SELF_INTERSECTION_EPSILON) return false;
  if (Math.abs(dot(relative, normal)) > SELF_INTERSECTION_EPSILON * normalLength) return false;
  const dot00 = dot(edge0, edge0);
  const dot01 = dot(edge0, edge1);
  const dot11 = dot(edge1, edge1);
  const dot20 = dot(relative, edge0);
  const dot21 = dot(relative, edge1);
  const denominator = dot00 * dot11 - dot01 * dot01;
  if (Math.abs(denominator) <= SELF_INTERSECTION_EPSILON) return false;
  const u = (dot11 * dot20 - dot01 * dot21) / denominator;
  const v = (dot00 * dot21 - dot01 * dot20) / denominator;
  return u > SELF_INTERSECTION_EPSILON
    && v > SELF_INTERSECTION_EPSILON
    && u + v < 1 - SELF_INTERSECTION_EPSILON;
};

const segmentIntersectsTriangle = (
  start: Point,
  end: Point,
  triangle: [Point, Point, Point],
) => {
  const direction = subtract(end, start);
  const edge1 = subtract(triangle[1], triangle[0]);
  const edge2 = subtract(triangle[2], triangle[0]);
  const perpendicular = cross(direction, edge2);
  const determinant = dot(edge1, perpendicular);
  if (Math.abs(determinant) <= SELF_INTERSECTION_EPSILON) return false;
  const inverse = 1 / determinant;
  const originDelta = subtract(start, triangle[0]);
  const u = dot(originDelta, perpendicular) * inverse;
  if (u < -SELF_INTERSECTION_EPSILON || u > 1 + SELF_INTERSECTION_EPSILON) return false;
  const crossDelta = cross(originDelta, edge1);
  const v = dot(direction, crossDelta) * inverse;
  if (v < -SELF_INTERSECTION_EPSILON || u + v > 1 + SELF_INTERSECTION_EPSILON) return false;
  const distanceAlongSegment = dot(edge2, crossDelta) * inverse;
  return distanceAlongSegment > SELF_INTERSECTION_EPSILON
    && distanceAlongSegment < 1 - SELF_INTERSECTION_EPSILON;
};

const coplanarTrianglesOverlap = (
  left: [Point, Point, Point],
  right: [Point, Point, Point],
) => {
  const leftNormal = cross(subtract(left[1], left[0]), subtract(left[2], left[0]));
  const normalLength = Math.hypot(...leftNormal);
  if (normalLength <= SELF_INTERSECTION_EPSILON) return false;
  if (right.some((point) => (
    Math.abs(dot(subtract(point, left[0]), leftNormal))
      > SELF_INTERSECTION_EPSILON * normalLength
  ))) return false;
  if (left.some((point) => pointInTriangle3d(point, right))
    || right.some((point) => pointInTriangle3d(point, left))) return true;

  const droppedAxis = Math.abs(leftNormal[0]) >= Math.abs(leftNormal[1])
    && Math.abs(leftNormal[0]) >= Math.abs(leftNormal[2])
    ? 0
    : Math.abs(leftNormal[1]) >= Math.abs(leftNormal[2]) ? 1 : 2;
  const project = (point: Point): [number, number] => droppedAxis === 0
    ? [point[1], point[2]]
    : droppedAxis === 1 ? [point[0], point[2]] : [point[0], point[1]];
  const orientation = (
    a: readonly [number, number],
    b: readonly [number, number],
    c: readonly [number, number],
  ) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const onSegment = (
    point: readonly [number, number],
    start: readonly [number, number],
    end: readonly [number, number],
  ) => Math.abs(orientation(start, end, point)) <= SELF_INTERSECTION_EPSILON
    && point[0] >= Math.min(start[0], end[0]) - SELF_INTERSECTION_EPSILON
    && point[0] <= Math.max(start[0], end[0]) + SELF_INTERSECTION_EPSILON
    && point[1] >= Math.min(start[1], end[1]) - SELF_INTERSECTION_EPSILON
    && point[1] <= Math.max(start[1], end[1]) + SELF_INTERSECTION_EPSILON;
  const segmentsIntersect = (
    a: readonly [number, number],
    b: readonly [number, number],
    c: readonly [number, number],
    d: readonly [number, number],
  ) => {
    const abC = orientation(a, b, c);
    const abD = orientation(a, b, d);
    const cdA = orientation(c, d, a);
    const cdB = orientation(c, d, b);
    if (
      ((abC > SELF_INTERSECTION_EPSILON && abD < -SELF_INTERSECTION_EPSILON)
        || (abC < -SELF_INTERSECTION_EPSILON && abD > SELF_INTERSECTION_EPSILON))
      && ((cdA > SELF_INTERSECTION_EPSILON && cdB < -SELF_INTERSECTION_EPSILON)
        || (cdA < -SELF_INTERSECTION_EPSILON && cdB > SELF_INTERSECTION_EPSILON))
    ) return true;
    return onSegment(c, a, b)
      || onSegment(d, a, b)
      || onSegment(a, c, d)
      || onSegment(b, c, d);
  };
  const left2d = left.map(project);
  const right2d = right.map(project);
  for (let leftEdge = 0; leftEdge < 3; leftEdge += 1) {
    for (let rightEdge = 0; rightEdge < 3; rightEdge += 1) {
      if (segmentsIntersect(
        left2d[leftEdge],
        left2d[(leftEdge + 1) % 3],
        right2d[rightEdge],
        right2d[(rightEdge + 1) % 3],
      )) return true;
    }
  }
  return false;
};

const trianglesIntersect = (
  left: [Point, Point, Point],
  right: [Point, Point, Point],
) => {
  for (let edge = 0; edge < 3; edge += 1) {
    if (segmentIntersectsTriangle(left[edge], left[(edge + 1) % 3], right)) return true;
    if (segmentIntersectsTriangle(right[edge], right[(edge + 1) % 3], left)) return true;
  }
  return coplanarTrianglesOverlap(left, right);
};

/**
 * 以 X 轴扫描 AABB，只有包围盒重叠的非相邻三角形才进入精确相交测试。
 * 若候选对过多则保守降级，避免恶意网格把拓扑审计拖成无界二次复杂度。
 */
const inspectSelfIntersection = (geometry: MeshGeometry) => {
  const entries = Array.from(
    { length: geometry.indices.length / 3 },
    (_, triangleIndex) => triangleIntersectionEntry(geometry, triangleIndex),
  ).sort((left, right) => left.min[0] - right.min[0] || left.triangleIndex - right.triangleIndex);
  const active: TriangleIntersectionEntry[] = [];
  let pairTests = 0;

  for (const current of entries) {
    for (let index = active.length - 1; index >= 0; index -= 1) {
      if (active[index].max[0] < current.min[0] - SELF_INTERSECTION_EPSILON) {
        active[index] = active[active.length - 1];
        active.pop();
      }
    }
    for (const candidate of active) {
      if (sharesVertex(candidate, current) || !overlapsTriangleBounds(candidate, current)) continue;
      pairTests += 1;
      if (pairTests > MAX_SELF_INTERSECTION_PAIR_TESTS) return "unverified" as const;
      if (trianglesIntersect(candidate.vertices, current.vertices)) return "intersecting" as const;
    }
    active.push(current);
  }
  return "clear" as const;
};

const inspectMeshTopology = (geometry: MeshGeometry, edges: Map<string, MeshEdge>): MeshTopology => {
  if (geometry.triangleAreas.some((area) => area <= 1e-8)) {
    return { closed: false, reason: "degenerate" };
  }
  for (const edge of edges.values()) {
    if (edge.triangleCount === 1) return { closed: false, reason: "open" };
    if (edge.triangleCount !== 2) return { closed: false, reason: "non-manifold" };
    if (edge.windingBalance !== 0) return { closed: false, reason: "inconsistent-winding" };
  }
  // 高细分网格的相邻共面面片会放大精确检测成本；预算耗尽时保守转为壳层。
  const selfIntersection = inspectSelfIntersection(geometry);
  if (selfIntersection === "intersecting") {
    return { closed: false, reason: "self-intersecting" };
  }
  if (selfIntersection === "unverified") {
    return { closed: false, reason: "self-intersection-unverified" };
  }
  return { closed: true, reason: "closed" };
};

const SILHOUETTE_DIRECTIONS: Point[] = [
  [0, 0, 1],
  [1, 0, 0],
  normalize([1, 0.04, 1]),
];

const edgeNormal = (geometry: MeshGeometry, edge: MeshEdge) => {
  const first = triangleNormal(geometry, edge.firstTriangle);
  if (edge.secondTriangle === -1) return first;
  const second = triangleNormal(geometry, edge.secondTriangle);
  const combined = add(first, second);
  return Math.hypot(...combined) > 1e-5 ? normalize(combined) : first;
};

const collectEdgeSegments = (geometry: MeshGeometry, options: HologramOptions) => {
  const edges = buildMeshEdges(geometry);
  const segments: FeatureSegment[] = [];
  const sharpDotThreshold = Math.cos(THREE_DEGREES_55);

  for (const edge of edges.values()) {
    const start = pointFromBuffer(geometry.positions, edge.a);
    const end = pointFromBuffer(geometry.positions, edge.b);
    if (distance(start, end) < 0.08) continue;

    const firstNormal = triangleNormal(geometry, edge.firstTriangle);
    const secondNormal = edge.secondTriangle === -1
      ? firstNormal
      : triangleNormal(geometry, edge.secondTriangle);
    const isBoundary = edge.secondTriangle === -1;
    const isMaterialSeam = !isBoundary
      && geometry.triangleMaterials[edge.firstTriangle] !== geometry.triangleMaterials[edge.secondTriangle];
    const isSharp = !isBoundary && dot(firstNormal, secondNormal) < sharpDotThreshold;
    let silhouetteViews = 0;
    let silhouetteStrength = 0;
    if (!isBoundary) {
      for (const view of SILHOUETTE_DIRECTIONS) {
        const firstFacing = dot(firstNormal, view);
        const secondFacing = dot(secondNormal, view);
        const strength = Math.min(Math.abs(firstFacing), Math.abs(secondFacing));
        if (firstFacing * secondFacing < 0 && strength >= 0.075) {
          silhouetteViews += 1;
          silhouetteStrength = Math.max(silhouetteStrength, strength);
        }
      }
    }
    const isSilhouette = silhouetteViews > 0;

    let priority = 0;
    let stepMultiplier = 1;
    let kind: FeatureKind = "outline";
    if (isBoundary) priority = 1.08;
    else if (isMaterialSeam) priority = 1.02;
    else if (isSharp) priority = 0.92;
    else if (isSilhouette) {
      const primary = silhouetteViews >= 2 || silhouetteStrength >= 0.28;
      priority = primary ? 0.8 : 0.62;
      stepMultiplier = primary ? 1.2 : 1.85;
      kind = primary ? "outline" : "depth";
    } else {
      continue;
    }

    const center = midpoint(start, end);
    const face = options.preserveFace
      ? classifyFacePoint(geometry, center, [edge.firstTriangle, edge.secondTriangle])
      : { inside: false };
    if (face.feature) {
      priority += 0.32 + faceFeaturePriority(face.feature) * 0.04;
      stepMultiplier *= 0.48;
      kind = "face";
    } else if (face.inside) {
      priority += 0.13;
      stepMultiplier *= 0.72;
      kind = "face";
    }
    segments.push({
      start,
      end,
      normal: edgeNormal(geometry, edge),
      kind,
      priority,
      stepMultiplier,
    });
  }

  return segments;
};

const THREE_DEGREES_55 = 55 * Math.PI / 180;

const trianglePlaneIntersection = (
  a: Point,
  b: Point,
  c: Point,
  planeY: number,
): [Point, Point] | null => {
  const intersections: Point[] = [];
  const addIntersection = (start: Point, end: Point) => {
    const crosses = (start[1] < planeY && end[1] >= planeY)
      || (end[1] < planeY && start[1] >= planeY);
    if (!crosses) return;
    const deltaY = end[1] - start[1];
    if (Math.abs(deltaY) < 1e-8) return;
    const t = (planeY - start[1]) / deltaY;
    intersections.push([
      start[0] + (end[0] - start[0]) * t,
      planeY,
      start[2] + (end[2] - start[2]) * t,
    ]);
  };
  addIntersection(a, b);
  addIntersection(b, c);
  addIntersection(c, a);
  return intersections.length >= 2 ? [intersections[0], intersections[1]] : null;
};

const collectSliceSegments = (geometry: MeshGeometry, options: HologramOptions) => {
  const segments: FeatureSegment[] = [];
  const sparseRatios = [0.1, 0.3, 0.5, 0.7, 0.82, 0.92];
  const standardRatios = [0.08, 0.18, 0.32, 0.48, 0.61, 0.72, 0.8, 0.87, 0.94];
  const detailRatios = [0.13, 0.25, 0.4, 0.55, 0.67, 0.76, 0.84, 0.9, 0.97];
  const ratios = options.sampleSpacing >= 4
    ? sparseRatios
    : options.sampleSpacing <= 1
      ? [...standardRatios, ...detailRatios]
      : standardRatios;
  const planes = [...new Set(ratios.map((ratio) => Math.round(ratio * geometry.height * 1000) / 1000))]
    .sort((left, right) => left - right);

  const triangleCount = geometry.indices.length / 3;
  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
    if (geometry.triangleAreas[triangleIndex] < 0.015) continue;
    const a = pointFromBuffer(geometry.positions, geometry.indices[triangleIndex * 3]);
    const b = pointFromBuffer(geometry.positions, geometry.indices[triangleIndex * 3 + 1]);
    const c = pointFromBuffer(geometry.positions, geometry.indices[triangleIndex * 3 + 2]);
    const minY = Math.min(a[1], b[1], c[1]);
    const maxY = Math.max(a[1], b[1], c[1]);
    const normal = triangleNormal(geometry, triangleIndex);

    for (const planeY of planes) {
      if (planeY < minY || planeY > maxY) continue;
      const intersection = trianglePlaneIntersection(a, b, c, planeY);
      if (!intersection || distance(intersection[0], intersection[1]) < 0.05) continue;
      const center = midpoint(intersection[0], intersection[1]);
      const face = options.preserveFace
        ? classifyFacePoint(geometry, center, [triangleIndex])
        : { inside: false };
      const isFeature = Boolean(face.feature);
      segments.push({
        start: intersection[0],
        end: intersection[1],
        normal,
        kind: face.inside ? "face" : "slice",
        priority: isFeature ? 0.96 : face.inside ? 0.71 : 0.57,
        stepMultiplier: isFeature ? 0.55 : face.inside ? 0.82 : 1.22,
      });
    }
  }
  return segments;
};

const appendSegmentSamples = (
  segments: FeatureSegment[],
  options: HologramOptions,
  budget: number,
  rawSamples: Sample[],
) => {
  segments.sort((left, right) => right.priority - left.priority);
  let appended = 0;
  for (const segment of segments) {
    const segmentLength = distance(segment.start, segment.end);
    const step = Math.max(0.75, options.sampleSpacing * segment.stepMultiplier);
    const sampleCount = Math.max(1, Math.ceil(segmentLength / step));
    for (let sampleIndex = 0; sampleIndex <= sampleCount; sampleIndex += 1) {
      if (appended >= budget) {
        throw new RangeError(`Hologram contour candidates exceed the allocated limit ${budget}`);
      }
      const t = sampleIndex / sampleCount;
      const position: Point = [
        segment.start[0] + (segment.end[0] - segment.start[0]) * t,
        segment.start[1] + (segment.end[1] - segment.start[1]) * t,
        segment.start[2] + (segment.end[2] - segment.start[2]) * t,
      ];
      rawSamples.push({
        position: quantize(position),
        facing: VERTICAL_FACING,
        material: materialForFeature(options.material, segment.kind),
        priority: segment.priority,
        tier: sampleTierForFeature(segment.kind),
        stableScore: 0,
      });
      appended += 1;
    }
  }
};

const appendSurfaceAnchors = (
  geometry: MeshGeometry,
  options: HologramOptions,
  budget: number,
  rawSamples: Sample[],
) => {
  const occupied = new Set<string>();
  const baseCellSize = Math.max(3, options.sampleSpacing * 3.2);
  const triangleCount = geometry.indices.length / 3;
  let appended = 0;

  const appendPass = (featureOnly: boolean) => {
    for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
      const a = pointFromBuffer(geometry.positions, geometry.indices[triangleIndex * 3]);
      const b = pointFromBuffer(geometry.positions, geometry.indices[triangleIndex * 3 + 1]);
      const c = pointFromBuffer(geometry.positions, geometry.indices[triangleIndex * 3 + 2]);
      const center = multiply(add(add(a, b), c), 1 / 3);
      const face = options.preserveFace
        ? classifyFacePoint(geometry, center, [triangleIndex])
        : { inside: false };
      const isFeature = Boolean(face.feature);
      if (isFeature !== featureOnly) continue;
      const minimumArea = baseCellSize * (isFeature ? 0.012 : 0.08);
      if (geometry.triangleAreas[triangleIndex] < minimumArea) continue;

      const cellSize = isFeature
        ? Math.max(1, baseCellSize * 0.34)
        : face.inside
          ? Math.max(2, baseCellSize * 0.62)
          : baseCellSize;
      const key = `${Math.round(center[0] / cellSize)},${Math.round(center[1] / cellSize)},${Math.round(center[2] / cellSize)}`;
      if (occupied.has(key)) continue;
      if (appended >= budget) {
        throw new RangeError(`Hologram surface candidates exceed the allocated limit ${budget}`);
      }
      occupied.add(key);
      rawSamples.push({
        position: quantize(center),
        facing: VERTICAL_FACING,
        material: materialForFeature(options.material, face.inside ? "face" : "depth"),
        priority: isFeature ? 1.05 : face.inside ? 0.66 : 0.38,
        tier: isFeature ? "critical" : face.inside ? "outline" : "surface",
        stableScore: 0,
      });
      appended += 1;
    }
  };

  appendPass(true);
  appendPass(false);
};

const triangleAt = (geometry: MeshGeometry, triangleIndex: number): [Point, Point, Point] => [
  pointFromBuffer(geometry.positions, geometry.indices[triangleIndex * 3]),
  pointFromBuffer(geometry.positions, geometry.indices[triangleIndex * 3 + 1]),
  pointFromBuffer(geometry.positions, geometry.indices[triangleIndex * 3 + 2]),
];

const buildScanlineLayerIndex = (
  geometry: MeshGeometry,
  minY: number,
  maxY: number,
  stride: number,
) => {
  const layerCount = Math.floor((maxY - minY) / stride) + 1;
  const layers = Array.from({ length: Math.max(0, layerCount) }, () => [] as ScanlineTriangle[]);
  const triangleCount = geometry.indices.length / 3;

  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
    const [a, b, c] = triangleAt(geometry, triangleIndex);
    const edge1 = subtract(b, a);
    const edge2 = subtract(c, a);
    const yzDeterminant = edge1[1] * edge2[2] - edge1[2] * edge2[1];
    // X 射线与 YZ 投影退化的三角形不会产生奇偶交点。
    if (Math.abs(yzDeterminant) <= 1e-10) continue;

    const triangle: ScanlineTriangle = {
      a,
      edge1,
      edge2,
      yzDeterminant,
      minY: Math.min(a[1], b[1], c[1]),
      maxY: Math.max(a[1], b[1], c[1]),
      minZ: Math.min(a[2], b[2], c[2]),
      maxZ: Math.max(a[2], b[2], c[2]),
    };
    const firstLayer = Math.max(0, Math.ceil((triangle.minY - minY) / stride));
    const lastLayer = Math.min(layerCount - 1, Math.floor((triangle.maxY - minY) / stride));
    for (let layerIndex = firstLayer; layerIndex <= lastLayer; layerIndex += 1) {
      layers[layerIndex].push(triangle);
    }
  }

  return layers;
};

const scanlineIntersectionX = (triangle: ScanlineTriangle, y: number, z: number) => {
  if (
    y < triangle.minY - 1e-8
    || y > triangle.maxY + 1e-8
    || z < triangle.minZ - 1e-8
    || z > triangle.maxZ + 1e-8
  ) return undefined;

  const deltaY = y - triangle.a[1];
  const deltaZ = z - triangle.a[2];
  const inverse = 1 / triangle.yzDeterminant;
  const u = (deltaY * triangle.edge2[2] - deltaZ * triangle.edge2[1]) * inverse;
  const v = (triangle.edge1[1] * deltaZ - triangle.edge1[2] * deltaY) * inverse;
  if (u < -1e-8 || v < -1e-8 || u + v > 1 + 1e-8) return undefined;
  return triangle.a[0] + u * triangle.edge1[0] + v * triangle.edge2[0];
};

const scanlineInteriorRanges = (
  triangles: readonly ScanlineTriangle[],
  y: number,
  z: number,
) => {
  const intersections: number[] = [];
  // 固定非整数偏移使扫描线避开共用边与顶点，并保持重复生成确定。
  const sampleY = y + 0.000_131;
  const sampleZ = z + 0.000_271;
  for (const triangle of triangles) {
    const x = scanlineIntersectionX(triangle, sampleY, sampleZ);
    if (x !== undefined) intersections.push(x);
  }
  intersections.sort((left, right) => left - right);

  const ranges: Array<[number, number]> = [];
  for (let index = 0; index + 1 < intersections.length; index += 2) {
    const start = Math.ceil(intersections[index] + 1e-7);
    const end = Math.floor(intersections[index + 1] - 1e-7);
    if (start <= end) ranges.push([start, end]);
  }
  return ranges;
};

const candidateSeed = (geometry: MeshGeometry, options: HologramDensityOptions) => {
  let hash = hashString(options.contentHash ?? "MELY");
  hash ^= hashString(options.minecraftVersion ?? "unknown-version");
  for (let index = 0; index < geometry.positions.length; index += 1) {
    hash ^= Math.imul(Math.round(geometry.positions[index] * 1_000), 0x85ebca6b);
    hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35) >>> 0;
  }
  for (const index of geometry.indices) {
    hash ^= Math.imul(index, 0x27d4eb2d);
    hash = Math.imul(hash ^ (hash >>> 15), 0x165667b1) >>> 0;
  }
  return (hash ^ (hash >>> 16)) >>> 0;
};

const interiorMaterial = (options: HologramDensityOptions, score: number) => {
  if (options.material === "end_rod") return 0;
  if (options.material === "white_pane") return 1;
  return score & 1;
};

const samplingBounds = (geometry: MeshGeometry) => ({
  min: geometry.bounds.min.map(Math.ceil) as Point,
  max: geometry.bounds.max.map(Math.floor) as Point,
});

const volumeOfBounds = (min: Point, max: Point) => Math.max(0, max[0] - min[0] + 1)
  * Math.max(0, max[1] - min[1] + 1)
  * Math.max(0, max[2] - min[2] + 1);

const interiorSamplingStride = (geometry: MeshGeometry) => {
  const { min, max } = samplingBounds(geometry);
  const volume = volumeOfBounds(min, max);
  const safeInteriorBudget = Math.floor(MAX_HOLOGRAM_BLOCKS * 0.7);
  return Math.max(1, Math.ceil(Math.cbrt(volume / safeInteriorBudget)));
};

const appendInteriorCandidate = (
  samples: Sample[],
  position: Point,
  options: HologramDensityOptions,
  seed: number,
) => {
  const stableScore = hashCoordinate(position, seed);
  samples.push({
    position,
    facing: VERTICAL_FACING,
    material: interiorMaterial(options, stableScore),
    priority: 0.1,
    tier: "interior",
    stableScore,
  });
};

const collectClosedInteriorCandidates = (
  geometry: MeshGeometry,
  options: HologramDensityOptions,
  seed: number,
  stride: number,
) => {
  const { min, max } = samplingBounds(geometry);
  const samples: Sample[] = [];
  const layers = buildScanlineLayerIndex(geometry, min[1], max[1], stride);
  let layerIndex = 0;
  for (let y = min[1]; y <= max[1]; y += stride, layerIndex += 1) {
    const triangles = layers[layerIndex];
    for (let z = min[2]; z <= max[2]; z += stride) {
      for (const [rangeStart, rangeEnd] of scanlineInteriorRanges(triangles, y, z)) {
        const firstX = min[0] + Math.max(0, Math.ceil((rangeStart - min[0]) / stride)) * stride;
        const lastX = Math.min(max[0], rangeEnd);
        for (let x = firstX; x <= lastX; x += stride) {
          appendInteriorCandidate(samples, [x, y, z], options, seed);
          if (samples.length > MAX_HOLOGRAM_CANDIDATES) {
            throw new RangeError(
              `Hologram interior candidates exceed the safe limit ${MAX_HOLOGRAM_CANDIDATES}`,
            );
          }
        }
      }
    }
  }
  return samples;
};

const collectShellFallbackCandidates = (
  geometry: MeshGeometry,
  options: HologramDensityOptions,
  seed: number,
) => {
  const samples: Sample[] = [];
  const seen = new Set<string>();
  const triangleCount = geometry.indices.length / 3;
  const shellDepth = Math.max(1, Math.min(3, Math.round(options.sampleSpacing)));
  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
    const [a, b, c] = triangleAt(geometry, triangleIndex);
    const center = multiply(add(add(a, b), c), 1 / 3);
    const normal = triangleNormal(geometry, triangleIndex);
    for (let depth = 1; depth <= shellDepth; depth += 1) {
      const forward = quantize(subtract(center, multiply(normal, depth)));
      const reverse = quantize(add(center, multiply(normal, depth)));
      const position = hashCoordinate(forward, seed) <= hashCoordinate(reverse, seed) ? forward : reverse;
      const key = pointKey(position);
      if (seen.has(key)) continue;
      seen.add(key);
      appendInteriorCandidate(samples, position, options, seed);
      if (samples.length > MAX_HOLOGRAM_CANDIDATES) {
        throw new RangeError(
          `Hologram shell candidates exceed the safe limit ${MAX_HOLOGRAM_CANDIDATES}`,
        );
      }
    }
  }
  return samples;
};

const collectInteriorSamples = (
  geometry: MeshGeometry,
  options: HologramDensityOptions,
  topology: MeshTopology,
): InteriorSampling => {
  const density = normalizeInteriorDensity(options.interiorDensity);
  if (density <= 0) return emptyInteriorSampling();

  const seed = candidateSeed(geometry, options);
  const stride = topology.closed ? interiorSamplingStride(geometry) : 1;
  const candidates = topology.closed
    ? collectClosedInteriorCandidates(geometry, options, seed, stride)
    : collectShellFallbackCandidates(geometry, options, seed);
  if (candidates.length > MAX_HOLOGRAM_CANDIDATES) {
    throw new RangeError(
      `Hologram interior candidates ${candidates.length} exceed the safe limit ${MAX_HOLOGRAM_CANDIDATES}`,
    );
  }

  const threshold = density >= 100 ? HASH_RANGE : Math.floor(HASH_RANGE * density / 100);
  // 先在密度无关的全候选集上做固定隔离，再用阈值截取，
  // 保证密度增大时只会增加内部坐标，不会重新排列并抢占旧点。
  candidates.sort(compareSamples);
  const acceptedUniverse = new Map<string, Sample>();
  for (const candidate of candidates) {
    if (!acceptedUniverse.has(pointKey(candidate.position))
      && !hasIsolationConflict(candidate, acceptedUniverse)) {
      acceptedUniverse.set(pointKey(candidate.position), candidate);
    }
  }
  const selected = [...acceptedUniverse.values()]
    .filter((candidate) => candidate.stableScore < threshold);
  return {
    samples: selected,
    mode: topology.closed ? "closed-volume" : "shell-fallback",
    candidateCount: candidates.length,
    selectedCount: selected.length,
    samplingStride: stride,
    warnings: topology.closed ? [] : [`hologram.interior.shellFallback.${topology.reason}`],
  };
};

export const generateMeshHologram = (
  snapshot: HologramMeshSnapshot,
  options: HologramDensityOptions,
  onProgress?: HologramProgress,
): HologramDensityResult => {
  const geometry = normalizeMesh(snapshot, options.targetHeight);
  onProgress?.("tracing", 0.22);
  const edges = buildMeshEdges(geometry);
  const topology = normalizeInteriorDensity(options.interiorDensity) > 0
    ? inspectMeshTopology(geometry, edges)
    : { closed: true, reason: "closed" } as const;
  const edgeSegments = collectEdgeSegments(geometry, options);
  onProgress?.("tracing", 0.4);
  const sliceSegments = collectSliceSegments(geometry, options);
  onProgress?.("sampling", 0.55);

  const rawSamples: Sample[] = [];
  const totalBudget = Math.max(
    12_000,
    Math.min(320_000, Math.round(options.targetHeight ** 2 * (11 / Math.max(1, options.sampleSpacing)))),
  );
  appendSegmentSamples(edgeSegments, options, Math.round(totalBudget * 0.68), rawSamples);
  appendSegmentSamples(sliceSegments, options, Math.round(totalBudget * 0.25), rawSamples);
  appendSurfaceAnchors(geometry, options, Math.round(totalBudget * 0.07), rawSamples);
  const interior = collectInteriorSamples(geometry, options, topology);
  for (const sample of interior.samples) rawSamples.push(sample);
  if (rawSamples.length > MAX_HOLOGRAM_CANDIDATES) {
    throw new RangeError(
      `Hologram candidates ${rawSamples.length} exceed the safe limit ${MAX_HOLOGRAM_CANDIDATES}`,
    );
  }
  onProgress?.("sampling", 0.78);
  const result = finalizeSamples(rawSamples, options, interior);
  onProgress?.("isolation", 0.94);
  return {
    ...result,
    ...(geometry.faceFrame ? { faceFrame: geometry.faceFrame } : {}),
  };
};

export const generateHologram = (
  options: HologramDensityOptions,
): HologramDensityResult => {
  const features = buildDemoFeatures(options.preserveFace);
  const rawSamples: Sample[] = [];
  const scale = Math.max(1, Math.round(options.targetHeight) - 1);
  const step = Math.max(1, options.sampleSpacing);

  for (const feature of features) {
    for (let segmentIndex = 0; segmentIndex < feature.points.length - 1; segmentIndex += 1) {
      const start = feature.points[segmentIndex];
      const end = feature.points[segmentIndex + 1];
      const startScaled: Point = [start[0] * scale, start[1] * scale, start[2] * scale];
      const endScaled: Point = [end[0] * scale, end[1] * scale, end[2] * scale];
      const segmentLength = distance(startScaled, endScaled);
      const sampleCount = Math.max(1, Math.ceil(segmentLength / step));
      for (let sampleIndex = 0; sampleIndex <= sampleCount; sampleIndex += 1) {
        const t = sampleIndex / sampleCount;
        const position: Point = [
          startScaled[0] + (endScaled[0] - startScaled[0]) * t,
          startScaled[1] + (endScaled[1] - startScaled[1]) * t,
          startScaled[2] + (endScaled[2] - startScaled[2]) * t,
        ];
        rawSamples.push({
          position: quantize(position),
          facing: VERTICAL_FACING,
          material: materialForFeature(options.material, feature.kind),
          priority: feature.priority,
          tier: sampleTierForFeature(feature.kind),
          stableScore: 0,
        });
      }
    }
  }

  const interior = normalizeInteriorDensity(options.interiorDensity) > 0
    ? {
        ...emptyInteriorSampling(),
        mode: "unavailable" as const,
        warnings: ["hologram.interior.unavailable.noMesh"],
      }
    : emptyInteriorSampling();
  return finalizeSamples(rawSamples, options, interior);
};
