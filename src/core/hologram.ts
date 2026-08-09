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

type Point = [number, number, number];
type FeatureKind = "outline" | "garment" | "face" | "depth" | "slice";

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
  firstTriangle: number;
  secondTriangle: number;
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

const materialForFeature = (material: HologramMaterial, kind: FeatureKind) => {
  if (material === "end_rod") return 0;
  if (material === "white_pane") return 1;
  return kind === "garment" || kind === "depth" || kind === "slice" ? 1 : 0;
};

const quantize = (point: Point): Point => [Math.round(point[0]), Math.round(point[1]), Math.round(point[2])];

const pointKey = ([x, y, z]: Point) => `${x},${y},${z}`;

const hasPaneConflict = (sample: Sample, accepted: Map<string, Sample>) => {
  const [x, y, z] = sample.position;
  const neighbours: Point[] = [
    [x + 1, y, z],
    [x - 1, y, z],
    [x, y, z + 1],
    [x, y, z - 1],
  ];

  return neighbours.some((position) => accepted.get(pointKey(position))?.material === 1);
};

const finalizeSamples = (rawSamples: Sample[], options: HologramOptions): HologramResult => {
  rawSamples.sort((left, right) => right.priority - left.priority);
  const accepted = new Map<string, Sample>();
  let removedConflicts = 0;

  for (const sample of rawSamples) {
    const key = pointKey(sample.position);
    if (accepted.has(key)) continue;

    if (sample.material === 1 && hasPaneConflict(sample, accepted)) {
      if (options.material === "mixed") {
        sample.material = 0;
      } else {
        removedConflicts += 1;
        continue;
      }
    }

    accepted.set(key, sample);
  }

  const samples = [...accepted.values()];
  if (samples.length === 0) throw appError("error.hologram.empty");

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
      if (existing.secondTriangle === -1) existing.secondTriangle = triangleIndex;
      return;
    }
    edges.set(key, { a, b, firstTriangle: triangleIndex, secondTriangle: -1 });
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
    if (appended >= budget) break;
    const segmentLength = distance(segment.start, segment.end);
    const step = Math.max(0.75, options.sampleSpacing * segment.stepMultiplier);
    const sampleCount = Math.max(1, Math.ceil(segmentLength / step));
    for (let sampleIndex = 0; sampleIndex <= sampleCount && appended < budget; sampleIndex += 1) {
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
    for (let triangleIndex = 0; triangleIndex < triangleCount && appended < budget; triangleIndex += 1) {
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
      occupied.add(key);
      rawSamples.push({
        position: quantize(center),
        facing: VERTICAL_FACING,
        material: materialForFeature(options.material, face.inside ? "face" : "depth"),
        priority: isFeature ? 1.05 : face.inside ? 0.66 : 0.38,
      });
      appended += 1;
    }
  };

  appendPass(true);
  appendPass(false);
};

export const generateMeshHologram = (
  snapshot: HologramMeshSnapshot,
  options: HologramOptions,
  onProgress?: HologramProgress,
): HologramResult => {
  const geometry = normalizeMesh(snapshot, options.targetHeight);
  onProgress?.("tracing", 0.22);
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
  onProgress?.("sampling", 0.78);
  const result = finalizeSamples(rawSamples, options);
  onProgress?.("isolation", 0.94);
  return {
    ...result,
    ...(geometry.faceFrame ? { faceFrame: geometry.faceFrame } : {}),
  };
};

export const generateHologram = (
  options: HologramOptions,
): HologramResult => {
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
        });
      }
    }
  }

  return finalizeSamples(rawSamples, options);
};
