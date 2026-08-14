import {
  ClampToEdgeWrapping,
  MirroredRepeatWrapping,
  RepeatWrapping,
} from "three";
import {
  createBlockPalette,
  matchBlockColor,
  type PaletteRole,
} from "./blockPalette";
import type {
  FaceFrameSnapshot,
  MeshMaterialSnapshot,
  MmdMeshSnapshot,
  SolidOptions,
  SolidVoxelResult,
} from "../types";
import { appError } from "./appError";
import { ditherPixels } from "./dithering";
import { matchEmissiveBlock } from "./emissiveMapping";
import { MAX_FILLED_VOXEL_VOLUME } from "./resourceBudget";
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
type Uv = [number, number];
type Rgba = [number, number, number, number];
type LinearRgba = [number, number, number, number];
interface VoxelSample {
  x: number;
  y: number;
  z: number;
  rgb: [number, number, number];
  paletteRole: PaletteRole;
  faceBase: boolean;
  featureKind?: FaceFeatureKind;
  emissive: boolean;
  distanceSq: number;
}

interface NormalizedMesh {
  positions: Float32Array;
  indices: Uint32Array;
  triangleMaterials: Uint16Array;
  uvs?: Float32Array;
  materials: MeshMaterialSnapshot[];
  textures: NonNullable<MmdMeshSnapshot["textures"]>;
  faceFrame?: FaceFrameSnapshot;
}

interface VoxelKeyCodec {
  origin: Point;
  size: Point;
  volume: number;
  encode: (x: number, y: number, z: number) => number;
}

export type SolidProgress = (
  stage: "voxelizing" | "texturing" | "filling" | "matching",
  progress: number,
) => void;

const pointAt = (positions: Float32Array, index: number): Point => [
  positions[index * 3],
  positions[index * 3 + 1],
  positions[index * 3 + 2],
];

const uvAt = (uvs: Float32Array | undefined, index: number): Uv => uvs
  ? [uvs[index * 2], uvs[index * 2 + 1]]
  : [0, 0];

const subtract = (left: Point, right: Point): Point => [
  left[0] - right[0],
  left[1] - right[1],
  left[2] - right[2],
];

const dot = (left: Point, right: Point) =>
  left[0] * right[0] + left[1] * right[1] + left[2] * right[2];

const cross = (left: Point, right: Point): Point => [
  left[1] * right[2] - left[2] * right[1],
  left[2] * right[0] - left[0] * right[2],
  left[0] * right[1] - left[1] * right[0],
];

const lengthSq = (point: Point) => dot(point, point);

const normalizePoint = (point: Point): Point => {
  const magnitude = Math.sqrt(lengthSq(point));
  return magnitude > 1e-8
    ? [point[0] / magnitude, point[1] / magnitude, point[2] / magnitude]
    : [0, 0, 0];
};

const normalizeMesh = (snapshot: MmdMeshSnapshot, targetHeight: number): NormalizedMesh => {
  const vertexCount = snapshot.positions.length / 3;
  if (!Number.isInteger(vertexCount) || vertexCount <= 0) throw appError("error.mesh.invalidVertices");
  if (snapshot.indices.length === 0 || snapshot.indices.length % 3 !== 0) {
    throw appError("error.mesh.invalidTriangles");
  }
  const min: Point = [Infinity, Infinity, Infinity];
  const max: Point = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < vertexCount; index += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = snapshot.positions[index * 3 + axis];
      if (!Number.isFinite(value)) throw appError("error.mesh.nonFiniteVertex");
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    }
  }
  const height = max[1] - min[1];
  if (height <= 1e-6) throw appError("error.mesh.zeroHeight");
  const targetSpan = Math.max(1, Math.round(targetHeight) - 1);
  const scale = targetSpan / height;
  const centerX = (min[0] + max[0]) * 0.5;
  const centerZ = (min[2] + max[2]) * 0.5;
  const positions = new Float32Array(snapshot.positions.length);
  for (let index = 0; index < vertexCount; index += 1) {
    positions[index * 3] = (snapshot.positions[index * 3] - centerX) * scale;
    positions[index * 3 + 1] = (snapshot.positions[index * 3 + 1] - min[1]) * scale;
    positions[index * 3 + 2] = (snapshot.positions[index * 3 + 2] - centerZ) * scale;
  }
  const triangleCount = snapshot.indices.length / 3;
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
    triangleMaterials: snapshot.triangleMaterials.length === triangleCount
      ? snapshot.triangleMaterials
      : new Uint16Array(triangleCount),
    uvs: snapshot.uvs?.length === vertexCount * 2 ? snapshot.uvs : undefined,
    materials: snapshot.materials?.length ? snapshot.materials : [{
      name: "default",
      englishName: "default",
      baseColor: [0.72, 0.72, 0.72, 1],
      textureFactor: [1, 1, 1, 1],
      hasTexture: false,
      textureIndex: -1,
      textureMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      wrapS: ClampToEdgeWrapping,
      wrapT: ClampToEdgeWrapping,
      flipY: false,
      ambient: [0, 0, 0],
      emissive: false,
    }],
    textures: snapshot.textures ?? [],
    faceFrame,
  };
};

const projectionsOverlap = (
  axis: Point,
  vertices: readonly Point[],
  half: Point,
) => {
  if (lengthSq(axis) < 1e-12) return true;
  const first = dot(vertices[0], axis);
  let min = first;
  let max = first;
  for (let index = 1; index < vertices.length; index += 1) {
    const projection = dot(vertices[index], axis);
    min = Math.min(min, projection);
    max = Math.max(max, projection);
  }
  const radius = half[0] * Math.abs(axis[0])
    + half[1] * Math.abs(axis[1])
    + half[2] * Math.abs(axis[2]);
  return min <= radius && max >= -radius;
};

export const triangleIntersectsBox = (
  a: Point,
  b: Point,
  c: Point,
  center: Point,
  halfSize: number,
) => {
  const vertices = [subtract(a, center), subtract(b, center), subtract(c, center)] as const;
  const half: Point = [halfSize, halfSize, halfSize];
  for (let axis = 0; axis < 3; axis += 1) {
    const min = Math.min(vertices[0][axis], vertices[1][axis], vertices[2][axis]);
    const max = Math.max(vertices[0][axis], vertices[1][axis], vertices[2][axis]);
    if (min > halfSize || max < -halfSize) return false;
  }
  const edges = [
    subtract(vertices[1], vertices[0]),
    subtract(vertices[2], vertices[1]),
    subtract(vertices[0], vertices[2]),
  ];
  const normal = cross(edges[0], subtract(vertices[2], vertices[0]));
  if (!projectionsOverlap(normal, vertices, half)) return false;
  const boxAxes: Point[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (const edge of edges) {
    for (const boxAxis of boxAxes) {
      if (!projectionsOverlap(cross(edge, boxAxis), vertices, half)) return false;
    }
  }
  return true;
};

const closestBarycentric = (point: Point, a: Point, b: Point, c: Point) => {
  const ab = subtract(b, a);
  const ac = subtract(c, a);
  const ap = subtract(point, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return { barycentric: [1, 0, 0] as Point, point: a };

  const bp = subtract(point, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return { barycentric: [0, 1, 0] as Point, point: b };

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return {
      barycentric: [1 - v, v, 0] as Point,
      point: [a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v] as Point,
    };
  }

  const cp = subtract(point, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return { barycentric: [0, 0, 1] as Point, point: c };

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return {
      barycentric: [1 - w, 0, w] as Point,
      point: [a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w] as Point,
    };
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const edge = subtract(c, b);
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return {
      barycentric: [0, 1 - w, w] as Point,
      point: [b[0] + edge[0] * w, b[1] + edge[1] * w, b[2] + edge[2] * w] as Point,
    };
  }

  const denominator = 1 / (va + vb + vc);
  const v = vb * denominator;
  const w = vc * denominator;
  const u = 1 - v - w;
  return {
    barycentric: [u, v, w] as Point,
    point: [
      a[0] * u + b[0] * v + c[0] * w,
      a[1] * u + b[1] * v + c[1] * w,
      a[2] * u + b[2] * v + c[2] * w,
    ] as Point,
  };
};

const wrapCoordinate = (value: number, mode: number) => {
  if (mode === RepeatWrapping) return value - Math.floor(value);
  if (mode === MirroredRepeatWrapping) {
    const floor = Math.floor(value);
    const fraction = value - floor;
    return Math.abs(floor % 2) === 1 ? 1 - fraction : fraction;
  }
  return Math.max(0, Math.min(1, value));
};

const transformUv = (uv: Uv, material: MeshMaterialSnapshot): Uv => {
  const matrix = material.textureMatrix;
  let u = matrix[0] * uv[0] + matrix[3] * uv[1] + matrix[6];
  let v = matrix[1] * uv[0] + matrix[4] * uv[1] + matrix[7];
  u = wrapCoordinate(u, material.wrapS);
  v = wrapCoordinate(v, material.wrapT);
  if (material.flipY) v = 1 - v;
  return [u, v];
};

const pixel = (
  texture: NonNullable<MmdMeshSnapshot["textures"]>[number],
  x: number,
  y: number,
): Rgba => {
  const clampedX = Math.max(0, Math.min(texture.width - 1, x));
  const clampedY = Math.max(0, Math.min(texture.height - 1, y));
  const offset = (clampedY * texture.width + clampedX) * 4;
  return [
    texture.pixels[offset],
    texture.pixels[offset + 1],
    texture.pixels[offset + 2],
    texture.pixels[offset + 3],
  ];
};

const srgbToLinear = (value: number) => value <= 0.04045
  ? value / 12.92
  : ((value + 0.055) / 1.055) ** 2.4;

const linearToSrgb = (value: number) => value <= 0.0031308
  ? value * 12.92
  : 1.055 * value ** (1 / 2.4) - 0.055;

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const normalizedToByte = (value: number) => Math.round(clamp01(value) * 255);
const linearToSrgbByte = (value: number) => normalizedToByte(linearToSrgb(clamp01(value)));
const SRGB_BYTE_TO_LINEAR = Float32Array.from(
  { length: 256 },
  (_, value) => srgbToLinear(value / 255),
);
const srgbByteToLinear = (value: number) => SRGB_BYTE_TO_LINEAR[value];
const byteToNormalized = (value: number) => value / 255;

const sampleTexture = (
  texture: NonNullable<MmdMeshSnapshot["textures"]>[number],
  uv: Uv,
): LinearRgba => {
  const x = uv[0] * Math.max(0, texture.width - 1);
  const y = uv[1] * Math.max(0, texture.height - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(texture.width - 1, x0 + 1);
  const y1 = Math.min(texture.height - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const topLeft = pixel(texture, x0, y0);
  const topRight = pixel(texture, x1, y0);
  const bottomLeft = pixel(texture, x0, y1);
  const bottomRight = pixel(texture, x1, y1);
  const interpolate = (channel: number, decode: (value: number) => number) => {
    const top = decode(topLeft[channel]) * (1 - tx) + decode(topRight[channel]) * tx;
    const bottom = decode(bottomLeft[channel]) * (1 - tx) + decode(bottomRight[channel]) * tx;
    return top * (1 - ty) + bottom * ty;
  };
  return [
    interpolate(0, srgbByteToLinear),
    interpolate(1, srgbByteToLinear),
    interpolate(2, srgbByteToLinear),
    interpolate(3, byteToNormalized),
  ];
};

const applyMmdTextureColorLinear = (
  baseColor: readonly [number, number, number],
  texel: readonly [number, number, number],
  multiplicative: readonly [number, number, number, number],
  additive: readonly [number, number, number, number],
): [number, number, number] => [0, 1, 2].map((channel) => {
  const textureMul = 1 - multiplicative[3]
    + texel[channel] * multiplicative[channel] * multiplicative[3];
  const textureColor = Math.max(
    0,
    Math.min(1, textureMul + (textureMul - 1) * additive[3]),
  ) + additive[channel];
  return linearToSrgbByte(srgbToLinear(baseColor[channel]) * textureColor);
}) as [number, number, number];

export const applyMmdTextureColor = (
  baseColor: readonly [number, number, number],
  texel: readonly [number, number, number],
  multiplicative: readonly [number, number, number, number],
  additive: readonly [number, number, number, number] = [0, 0, 0, 0],
): [number, number, number] => applyMmdTextureColorLinear(
  baseColor,
  [srgbToLinear(texel[0]), srgbToLinear(texel[1]), srgbToLinear(texel[2])],
  multiplicative,
  additive,
);

const materialSample = (
  mesh: NormalizedMesh,
  materialIndex: number,
  uv: Uv,
) => {
  const material = mesh.materials[materialIndex] ?? mesh.materials[0];
  const texture = material.textureIndex >= 0 ? mesh.textures[material.textureIndex] : undefined;
  if (!texture) {
    if (material.hasTexture || material.textureIndex >= 0) {
      throw appError("error.snapshot.textureCaptureFailed", { material: material.name || materialIndex });
    }
    return {
      rgb: [
        normalizedToByte(material.baseColor[0]),
        normalizedToByte(material.baseColor[1]),
        normalizedToByte(material.baseColor[2]),
      ] as [number, number, number],
      alpha: material.baseColor[3],
    };
  }
  const sampled = sampleTexture(texture, transformUv(uv, material));
  const factor = material.textureFactor;
  const additive = material.textureAdditiveFactor ?? [0, 0, 0, 0];
  const rgb = applyMmdTextureColorLinear(
    [material.baseColor[0], material.baseColor[1], material.baseColor[2]],
    [sampled[0], sampled[1], sampled[2]],
    factor,
    additive,
  );
  return { rgb, alpha: material.baseColor[3] * sampled[3] };
};

const createVoxelKeyCodec = (
  positions: Float32Array,
  margin: number,
): VoxelKeyCodec => {
  const min: Point = [Infinity, Infinity, Infinity];
  const max: Point = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < positions.length; offset += 3) {
    min[0] = Math.min(min[0], positions[offset]);
    min[1] = Math.min(min[1], positions[offset + 1]);
    min[2] = Math.min(min[2], positions[offset + 2]);
    max[0] = Math.max(max[0], positions[offset]);
    max[1] = Math.max(max[1], positions[offset + 1]);
    max[2] = Math.max(max[2], positions[offset + 2]);
  }
  const origin: Point = [
    Math.ceil(min[0] - margin),
    Math.ceil(min[1] - margin),
    Math.ceil(min[2] - margin),
  ];
  const upper: Point = [
    Math.floor(max[0] + margin),
    Math.floor(max[1] + margin),
    Math.floor(max[2] + margin),
  ];
  const size: Point = [
    upper[0] - origin[0] + 1,
    upper[1] - origin[1] + 1,
    upper[2] - origin[2] + 1,
  ];
  const volume = size[0] * size[1] * size[2];
  if (!Number.isSafeInteger(volume) || volume <= 0) throw appError("error.solid.volumeTooLarge");
  return {
    origin,
    size,
    volume,
    encode: (x, y, z) =>
      ((y - origin[1]) * size[2] + (z - origin[2])) * size[0] + (x - origin[0]),
  };
};

const featureSalience = (rgb: readonly number[]) => {
  const maximum = Math.max(rgb[0], rgb[1], rgb[2]);
  const minimum = Math.min(rgb[0], rgb[1], rgb[2]);
  const luminance = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  return maximum - minimum + (255 - luminance) * 0.55;
};

interface FaceTangentOffset {
  horizontal: number;
  vertical: number;
  distance: number;
}

interface VisibleFaceCell {
  horizontal: number;
  vertical: number;
  local: ReturnType<typeof faceLocalPoint>;
  voxel: VoxelSample;
}

interface ProjectedFaceFeature {
  cell: VisibleFaceCell;
  source: VoxelSample;
  sourceLocal: ReturnType<typeof faceLocalPoint>;
  score: number;
}

const faceFeatureRadii = (
  kind: FaceFeatureKind,
  detail: Exclude<SolidOptions["faceDetail"], "off">,
): [number, number] => {
  if (kind === "eye") return detail === "strong" ? [3.6, 2.2] : [2.4, 1.35];
  if (kind === "brow") return detail === "strong" ? [3.2, 1.45] : [2.2, 1];
  if (kind === "mouth") return detail === "strong" ? [2.7, 1.55] : [1.8, 1.05];
  return detail === "strong" ? [2.5, 1.8] : [1.65, 1.2];
};

const faceTangentOffsets = (
  kind: FaceFeatureKind,
  detail: Exclude<SolidOptions["faceDetail"], "off">,
) => {
  const [horizontalRadius, verticalRadius] = faceFeatureRadii(kind, detail);
  const offsets: FaceTangentOffset[] = [];
  for (let vertical = -Math.ceil(verticalRadius); vertical <= Math.ceil(verticalRadius); vertical += 1) {
    for (let horizontal = -Math.ceil(horizontalRadius); horizontal <= Math.ceil(horizontalRadius); horizontal += 1) {
      if (horizontal === 0 && vertical === 0) continue;
      const normalizedDistance = (horizontal / horizontalRadius) ** 2
        + (vertical / verticalRadius) ** 2;
      if (normalizedDistance > 1) continue;
      offsets.push({ horizontal, vertical, distance: normalizedDistance });
    }
  }
  return offsets;
};

const faceCellKey = (horizontal: number, vertical: number) => `${horizontal},${vertical}`;

const faceCellCoordinate = (value: number, frame: FaceFrameSnapshot) =>
  Math.round(value * frame.eyeDistance);

const staysOnFeatureSide = (
  kind: FaceFeatureKind,
  sourceHorizontal: number,
  targetHorizontal: number,
  frame: FaceFrameSnapshot,
) => {
  if (kind !== "eye" && kind !== "brow") return true;
  const centerTolerance = 0.25 / frame.eyeDistance;
  if (Math.abs(targetHorizontal) <= centerTolerance) return false;
  if (sourceHorizontal < -centerTolerance) return targetHorizontal < 0;
  if (sourceHorizontal > centerTolerance) return targetHorizontal > 0;
  return false;
};

const buildVisibleFaceCells = (
  surfaceVoxels: readonly VoxelSample[],
  frame: FaceFrameSnapshot,
) => {
  const cells = new Map<string, VisibleFaceCell>();
  for (const voxel of surfaceVoxels) {
    if (!voxel.faceBase || voxel.featureKind) continue;
    const local = faceLocalPoint([voxel.x, voxel.y, voxel.z], frame);
    if (!pointInsideFaceRegion(local)) continue;
    const horizontal = faceCellCoordinate(local.horizontal, frame);
    const vertical = faceCellCoordinate(local.vertical, frame);
    const key = faceCellKey(horizontal, vertical);
    const existing = cells.get(key);
    if (!existing || local.depth > existing.local.depth) {
      cells.set(key, { horizontal, vertical, local, voxel });
    }
  }
  return cells;
};

const nearestVisibleFaceCell = (
  cells: ReadonlyMap<string, VisibleFaceCell>,
  kind: FaceFeatureKind,
  sourceLocal: ReturnType<typeof faceLocalPoint>,
  frame: FaceFrameSnapshot,
) => {
  const sourceHorizontal = sourceLocal.horizontal * frame.eyeDistance;
  const sourceVertical = sourceLocal.vertical * frame.eyeDistance;
  const centerHorizontal = Math.round(sourceHorizontal);
  const centerVertical = Math.round(sourceVertical);
  let nearest: VisibleFaceCell | undefined;
  let nearestDistance = Infinity;

  for (let vertical = centerVertical - 2; vertical <= centerVertical + 2; vertical += 1) {
    for (let horizontal = centerHorizontal - 2; horizontal <= centerHorizontal + 2; horizontal += 1) {
      const cell = cells.get(faceCellKey(horizontal, vertical));
      if (
        !cell
        || !featureInsideFace(kind, cell.local)
        || !staysOnFeatureSide(kind, sourceLocal.horizontal, cell.local.horizontal, frame)
      ) continue;
      const deltaHorizontal = cell.local.horizontal * frame.eyeDistance - sourceHorizontal;
      const deltaVertical = cell.local.vertical * frame.eyeDistance - sourceVertical;
      const distance = deltaHorizontal ** 2 + deltaVertical ** 2;
      if (distance < nearestDistance) {
        nearest = cell;
        nearestDistance = distance;
      }
    }
  }
  return nearest;
};

const faceFeatureClaimScore = (
  source: VoxelSample,
  distance: number,
) => faceFeaturePriority(source.featureKind) * 1_000
  + featureSalience(source.rgb)
  - distance * 48;

const enhanceFaceSurface = (
  surfaceVoxels: readonly VoxelSample[],
  frame: FaceFrameSnapshot | undefined,
  detail: SolidOptions["faceDetail"],
) => {
  if (detail === "off" || !validFaceFrame(frame)) return;

  const visibleCells = buildVisibleFaceCells(surfaceVoxels, frame);
  if (visibleCells.size === 0) return;
  const projected = new Map<string, ProjectedFaceFeature>();
  for (const voxel of surfaceVoxels) {
    const featureKind = voxel.featureKind;
    if (!featureKind) continue;
    const sourceLocal = faceLocalPoint([voxel.x, voxel.y, voxel.z], frame);
    if (!featureInsideFace(featureKind, sourceLocal)) continue;
    const cell = nearestVisibleFaceCell(visibleCells, featureKind, sourceLocal, frame);
    if (!cell) continue;
    const deltaHorizontal = cell.local.horizontal - sourceLocal.horizontal;
    const deltaVertical = cell.local.vertical - sourceLocal.vertical;
    const score = faceFeatureClaimScore(
      voxel,
      (deltaHorizontal ** 2 + deltaVertical ** 2) * frame.eyeDistance ** 2,
    );
    const key = faceCellKey(cell.horizontal, cell.vertical);
    const existing = projected.get(key);
    if (!existing || score > existing.score) {
      projected.set(key, { cell, source: voxel, sourceLocal, score });
    }
  }

  const claims = new Map(projected);
  const offsetCache = new Map<FaceFeatureKind, FaceTangentOffset[]>();
  for (const projection of projected.values()) {
    const featureKind = projection.source.featureKind!;
    let offsets = offsetCache.get(featureKind);
    if (!offsets) {
      offsets = faceTangentOffsets(featureKind, detail);
      offsetCache.set(featureKind, offsets);
    }
    for (const offset of offsets) {
      const key = faceCellKey(
        projection.cell.horizontal + offset.horizontal,
        projection.cell.vertical + offset.vertical,
      );
      const cell = visibleCells.get(key);
      if (
        !cell
        || !featureInsideFace(featureKind, cell.local)
        || !staysOnFeatureSide(
          featureKind,
          projection.sourceLocal.horizontal,
          cell.local.horizontal,
          frame,
        )
      ) continue;
      const score = projection.score - offset.distance * 48;
      const existing = claims.get(key);
      if (!existing || score > existing.score) {
        claims.set(key, {
          cell,
          source: projection.source,
          sourceLocal: projection.sourceLocal,
          score,
        });
      }
    }
  }

  for (const claim of claims.values()) {
    claim.cell.voxel.rgb = claim.source.rgb;
    claim.cell.voxel.paletteRole = "faceFeature";
    claim.cell.voxel.featureKind = claim.source.featureKind;
  }
};

const fillInterior = (surface: VoxelSample[]) => {
  const min: Point = [Infinity, Infinity, Infinity];
  const max: Point = [-Infinity, -Infinity, -Infinity];
  for (const voxel of surface) {
    min[0] = Math.min(min[0], voxel.x);
    min[1] = Math.min(min[1], voxel.y);
    min[2] = Math.min(min[2], voxel.z);
    max[0] = Math.max(max[0], voxel.x);
    max[1] = Math.max(max[1], voxel.y);
    max[2] = Math.max(max[2], voxel.z);
  }
  const origin: Point = [min[0] - 1, min[1] - 1, min[2] - 1];
  const size: Point = [max[0] - min[0] + 3, max[1] - min[1] + 3, max[2] - min[2] + 3];
  const volume = size[0] * size[1] * size[2];
  if (volume > MAX_FILLED_VOXEL_VOLUME) throw appError("error.solid.volumeTooLarge");
  const occupied = new Uint8Array(volume);
  const linear = (x: number, y: number, z: number) =>
    ((y - origin[1]) * size[2] + (z - origin[2])) * size[0] + (x - origin[0]);
  for (const voxel of surface) occupied[linear(voxel.x, voxel.y, voxel.z)] = 1;

  const exterior = new Uint8Array(volume);
  const queue = new Int32Array(volume);
  let read = 0;
  let write = 0;
  queue[write++] = 0;
  exterior[0] = 1;
  const neighbours = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const;
  while (read < write) {
    const index = queue[read++];
    const localX = index % size[0];
    const yz = Math.floor(index / size[0]);
    const localZ = yz % size[2];
    const localY = Math.floor(yz / size[2]);
    for (const [dx, dy, dz] of neighbours) {
      const x = localX + dx;
      const y = localY + dy;
      const z = localZ + dz;
      if (x < 0 || x >= size[0] || y < 0 || y >= size[1] || z < 0 || z >= size[2]) continue;
      const next = (y * size[2] + z) * size[0] + x;
      if (occupied[next] || exterior[next]) continue;
      exterior[next] = 1;
      queue[write++] = next;
    }
  }

  const sourceIds = new Uint32Array(volume);
  read = 0;
  write = 0;
  for (let surfaceIndex = 0; surfaceIndex < surface.length; surfaceIndex += 1) {
    const voxel = surface[surfaceIndex];
    const index = linear(voxel.x, voxel.y, voxel.z);
    sourceIds[index] = surfaceIndex + 1;
    if (voxel.featureKind) continue;
    queue[write++] = index;
  }
  if (write === 0) for (const voxel of surface) queue[write++] = linear(voxel.x, voxel.y, voxel.z);
  while (read < write) {
    const index = queue[read++];
    const sourceId = sourceIds[index];
    if (sourceId === 0) continue;
    const localX = index % size[0];
    const yz = Math.floor(index / size[0]);
    const localZ = yz % size[2];
    const localY = Math.floor(yz / size[2]);
    for (const [dx, dy, dz] of neighbours) {
      const x = localX + dx;
      const y = localY + dy;
      const z = localZ + dz;
      if (x < 0 || x >= size[0] || y < 0 || y >= size[1] || z < 0 || z >= size[2]) continue;
      const next = (y * size[2] + z) * size[0] + x;
      if (exterior[next] || sourceIds[next]) continue;
      sourceIds[next] = sourceId;
      queue[write++] = next;
    }
  }

  const deferred: number[] = [];
  for (const voxel of surface) {
    if (voxel.featureKind) deferred.push(linear(voxel.x, voxel.y, voxel.z));
  }
  read = 0;
  write = deferred.length;
  queue.set(deferred);
  while (read < write) {
    const index = queue[read++];
    const sourceId = sourceIds[index];
    if (sourceId === 0) continue;
    const localX = index % size[0];
    const yz = Math.floor(index / size[0]);
    const localZ = yz % size[2];
    const localY = Math.floor(yz / size[2]);
    for (const [dx, dy, dz] of neighbours) {
      const x = localX + dx;
      const y = localY + dy;
      const z = localZ + dz;
      if (x < 0 || x >= size[0] || y < 0 || y >= size[1] || z < 0 || z >= size[2]) continue;
      const next = (y * size[2] + z) * size[0] + x;
      if (exterior[next] || sourceIds[next]) continue;
      sourceIds[next] = sourceId;
      queue[write++] = next;
    }
  }

  let filledCount = 0;
  for (let index = 0; index < volume; index += 1) {
    if (!occupied[index] && !exterior[index] && sourceIds[index]) filledCount += 1;
  }
  const filled = new Array<VoxelSample>(filledCount);
  let filledIndex = 0;
  for (let index = 0; index < volume; index += 1) {
    const sourceId = sourceIds[index];
    if (occupied[index] || exterior[index] || sourceId === 0) continue;
    const localX = index % size[0];
    const yz = Math.floor(index / size[0]);
    const localZ = yz % size[2];
    const localY = Math.floor(yz / size[2]);
    const source = surface[sourceId - 1];
    filled[filledIndex++] = {
      x: localX + origin[0],
      y: localY + origin[1],
      z: localZ + origin[2],
      rgb: source.rgb,
      paletteRole: source.paletteRole,
      faceBase: source.faceBase,
      featureKind: source.featureKind,
      emissive: source.emissive,
      distanceSq: Infinity,
    };
  }
  return filled;
};

const RUIN_DIRECTIONS = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 0, 1],
  [0, 0, -1],
] as const;

const RUIN_COLORS: Record<string, [number, number, number]> = {
  "minecraft:moss_block": [89, 109, 45],
  "minecraft:mossy_stone_bricks": [115, 121, 105],
  "minecraft:vine": [72, 91, 36],
  "minecraft:glow_lichen": [127, 153, 85],
};

const LIGHT_BLOCKS = new Set([
  "minecraft:end_rod",
  "minecraft:glowstone",
  "minecraft:sea_lantern",
  "minecraft:ochre_froglight",
  "minecraft:verdant_froglight",
  "minecraft:pearlescent_froglight",
  "minecraft:redstone_lamp",
]);

const ruinHash = (x: number, y: number, z: number) => {
  let hash = (0x4d454c59 ^ 0x9e3779b9) >>> 0;
  for (const value of [x, y, z]) {
    hash ^= Math.imul(value | 0, 0x85ebca6b);
    hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35) >>> 0;
  }
  return (hash ^ (hash >>> 16)) >>> 0;
};

const directionAt = (mask: number, target: number) => {
  let remaining = target;
  for (let index = 0; index < RUIN_DIRECTIONS.length; index += 1) {
    if ((mask & (1 << index)) === 0) continue;
    if (remaining === 0) return index;
    remaining -= 1;
  }
  return 0;
};

export const decorateSolidAncientRuins = (
  result: SolidVoxelResult,
  amount: number,
): SolidVoxelResult => {
  const strength = Math.max(0, Math.min(1, amount / 100));
  if (strength === 0 || result.stats.blockCount === 0) return result;
  const codec = createVoxelKeyCodec(result.positions, 1.5);
  const occupied = new Set<number>();
  for (let index = 0; index < result.stats.blockCount; index += 1) {
    occupied.add(codec.encode(
      result.positions[index * 3],
      result.positions[index * 3 + 1],
      result.positions[index * 3 + 2],
    ));
  }
  const palette = result.palette.map((entry) => ({
    blockId: entry.blockId,
    color: [...entry.color] as [number, number, number],
  }));
  const paletteMap = new Map(palette.map((entry, index) => [entry.blockId, index]));
  const paletteIndexFor = (blockId: string) => {
    const existing = paletteMap.get(blockId);
    if (existing !== undefined) return existing;
    const index = palette.length;
    palette.push({ blockId, color: RUIN_COLORS[blockId] ?? [125, 125, 125] });
    paletteMap.set(blockId, index);
    return index;
  };
  const additions: number[] = [];
  const additionPalette: number[] = [];
  const added = new Set<number>();

  for (let index = 0; index < result.stats.blockCount; index += 1) {
    const x = result.positions[index * 3];
    const y = result.positions[index * 3 + 1];
    const z = result.positions[index * 3 + 2];
    const hash = ruinHash(x, y, z);
    let exposedMask = 0;
    let exposedCount = 0;
    for (let directionIndex = 0; directionIndex < RUIN_DIRECTIONS.length; directionIndex += 1) {
      const direction = RUIN_DIRECTIONS[directionIndex];
      if (occupied.has(codec.encode(x + direction[0], y, z + direction[2]))) continue;
      exposedMask |= 1 << directionIndex;
      exposedCount += 1;
    }
    if (exposedCount === 0) continue;
    const sourceId = palette[result.blockIndices[index]]?.blockId ?? "";
    if (
      !LIGHT_BLOCKS.has(sourceId)
      && sourceId !== "minecraft:vine"
      && sourceId !== "minecraft:glow_lichen"
      && (hash & 0xffff) / 0xffff < strength * 0.22
    ) {
      result.blockIndices[index] = paletteIndexFor(
        hash % 4 === 0 ? "minecraft:moss_block" : "minecraft:mossy_stone_bricks",
      );
    }
    if (((hash >>> 16) & 0xffff) / 0xffff >= strength * 0.16) continue;
    const direction = RUIN_DIRECTIONS[directionAt(exposedMask, hash % exposedCount)];
    const nextX = x + direction[0];
    const nextY = y;
    const nextZ = z + direction[2];
    const nextKey = codec.encode(nextX, nextY, nextZ);
    if (occupied.has(nextKey) || added.has(nextKey)) continue;
    additions.push(nextX, nextY, nextZ);
    additionPalette.push(paletteIndexFor(
      hash % 5 === 0 ? "minecraft:glow_lichen" : "minecraft:vine",
    ));
    added.add(nextKey);
  }

  if (additionPalette.length === 0) {
    return {
      ...result,
      palette,
      stats: { ...result.stats, paletteSize: palette.length },
    };
  }
  const originalCount = result.stats.blockCount;
  const blockCount = originalCount + additionPalette.length;
  const positions = new Float32Array(blockCount * 3);
  positions.set(result.positions);
  positions.set(additions, originalCount * 3);
  const blockIndices = new Uint16Array(blockCount);
  blockIndices.set(result.blockIndices);
  blockIndices.set(additionPalette, originalCount);
  const min: Point = [...result.bounds.min];
  const max: Point = [...result.bounds.max];
  for (let offset = 0; offset < additions.length; offset += 3) {
    min[0] = Math.min(min[0], additions[offset]);
    min[1] = Math.min(min[1], additions[offset + 1]);
    min[2] = Math.min(min[2], additions[offset + 2]);
    max[0] = Math.max(max[0], additions[offset]);
    max[1] = Math.max(max[1], additions[offset + 1]);
    max[2] = Math.max(max[2], additions[offset + 2]);
  }
  return {
    ...result,
    positions,
    blockIndices,
    palette,
    bounds: { min, max },
    stats: {
      ...result.stats,
      blockCount,
      surfaceBlockCount: result.stats.surfaceBlockCount + additionPalette.length,
      paletteSize: palette.length,
      dimensions: [
        max[0] - min[0] + 1,
        max[1] - min[1] + 1,
        max[2] - min[2] + 1,
      ],
    },
  };
};

export const generateSolidVoxels = (
  snapshot: MmdMeshSnapshot,
  options: SolidOptions,
  onProgress?: SolidProgress,
): SolidVoxelResult => {
  const mesh = normalizeMesh(snapshot, options.targetHeight);
  const halfSize = 0.5 + Math.max(0, options.thicknessCompensation);
  const voxelCodec = createVoxelKeyCodec(mesh.positions, halfSize + 1);
  if (options.fillMode === "filled" && voxelCodec.volume > MAX_FILLED_VOXEL_VOLUME) {
    throw appError("error.solid.volumeTooLarge");
  }
  const surface = new Map<number, VoxelSample>();
  const skinMaterials = new Set(options.skinMaterialIndices);
  const emissiveMaterials = new Set(options.emissiveMaterialIndices);
  const featureKinds = options.faceDetail === "off"
    ? []
    : mesh.materials.map(materialFaceFeatureKind);
  const triangleCount = mesh.indices.length / 3;
  let triangleBoxTests = 0;
  let alphaRejected = 0;

  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
    if (triangleIndex % 128 === 0) {
      onProgress?.("voxelizing", 0.08 + triangleIndex / triangleCount * 0.52);
    }
    const aIndex = mesh.indices[triangleIndex * 3];
    const bIndex = mesh.indices[triangleIndex * 3 + 1];
    const cIndex = mesh.indices[triangleIndex * 3 + 2];
    const a = pointAt(mesh.positions, aIndex);
    const b = pointAt(mesh.positions, bIndex);
    const c = pointAt(mesh.positions, cIndex);
    const minimum: Point = [
      Math.ceil(Math.min(a[0], b[0], c[0]) - halfSize),
      Math.ceil(Math.min(a[1], b[1], c[1]) - halfSize),
      Math.ceil(Math.min(a[2], b[2], c[2]) - halfSize),
    ];
    const maximum: Point = [
      Math.floor(Math.max(a[0], b[0], c[0]) + halfSize),
      Math.floor(Math.max(a[1], b[1], c[1]) + halfSize),
      Math.floor(Math.max(a[2], b[2], c[2]) + halfSize),
    ];
    const materialIndex = mesh.triangleMaterials[triangleIndex] ?? 0;
    const faceBase = skinMaterials.has(materialIndex);
    const featureKind = featureKinds[materialIndex];
    const material = mesh.materials[materialIndex] ?? mesh.materials[0];
    const emissive = options.emissiveMapping
      && (emissiveMaterials.has(materialIndex) || material.emissive);
    const paletteRole: PaletteRole = featureKind
      ? "faceFeature"
      : options.skinProtection && faceBase
        ? "skinBase"
        : "general";
    const uvA = uvAt(mesh.uvs, aIndex);
    const uvB = uvAt(mesh.uvs, bIndex);
    const uvC = uvAt(mesh.uvs, cIndex);
    for (let y = minimum[1]; y <= maximum[1]; y += 1) {
      for (let z = minimum[2]; z <= maximum[2]; z += 1) {
        for (let x = minimum[0]; x <= maximum[0]; x += 1) {
          triangleBoxTests += 1;
          const center: Point = [x, y, z];
          if (!triangleIntersectsBox(a, b, c, center, halfSize)) continue;
          const closest = closestBarycentric(center, a, b, c);
          const uv: Uv = [
            uvA[0] * closest.barycentric[0] + uvB[0] * closest.barycentric[1] + uvC[0] * closest.barycentric[2],
            uvA[1] * closest.barycentric[0] + uvB[1] * closest.barycentric[1] + uvC[1] * closest.barycentric[2],
          ];
          const sampled = materialSample(mesh, materialIndex, uv);
          if (sampled.alpha < options.alphaThreshold) {
            alphaRejected += 1;
            continue;
          }
          const delta = subtract(center, closest.point);
          const distanceSq = lengthSq(delta);
          const key = voxelCodec.encode(x, y, z);
          const existing = surface.get(key);
          const featurePriority = featureKind ? 1 : 0;
          const existingPriority = existing?.featureKind ? 1 : 0;
          if (
            existing
            && (existingPriority > featurePriority
              || (existingPriority === featurePriority && existing.distanceSq <= distanceSq))
          ) continue;
          surface.set(key, {
            x,
            y,
            z,
            rgb: sampled.rgb,
            paletteRole,
            faceBase,
            featureKind,
            emissive,
            distanceSq,
          });
        }
      }
    }
  }
  onProgress?.("texturing", 0.64);
  const surfaceVoxels = [...surface.values()];
  if (surfaceVoxels.length === 0) throw appError("error.solid.empty");
  const filledVoxels = options.fillMode === "filled" ? fillInterior(surfaceVoxels) : [];
  enhanceFaceSurface(surfaceVoxels, mesh.faceFrame, options.faceDetail);
  surface.clear();
  onProgress?.("filling", 0.76);
  const voxels = filledVoxels.length > 0 ? surfaceVoxels.concat(filledVoxels) : surfaceVoxels;
  const sourcePalette = createBlockPalette(options);
  const compactPalette: SolidVoxelResult["palette"] = [];
  const compactMap = new Map<string, number>();
  const positions = new Float32Array(voxels.length * 3);
  const blockIndices = new Uint16Array(voxels.length);
  const min: Point = [Infinity, Infinity, Infinity];
  const max: Point = [-Infinity, -Infinity, -Infinity];
  let skinBlockCount = 0;
  let matchedSourceIndices: Uint16Array | undefined;
  if (options.dithering > 0) {
    matchedSourceIndices = new Uint16Array(voxels.length);
    let ditherMinY = Infinity;
    let ditherMaxY = -Infinity;
    let ditherCount = 0;
    voxels.forEach((voxel, index) => {
      matchedSourceIndices![index] = matchBlockColor(voxel.rgb, sourcePalette, voxel.paletteRole);
      if (voxel.paletteRole === "general" && !voxel.emissive) {
        ditherMinY = Math.min(ditherMinY, voxel.y);
        ditherMaxY = Math.max(ditherMaxY, voxel.y);
        ditherCount += 1;
      }
    });
    const layerCount = ditherCount > 0 ? ditherMaxY - ditherMinY + 1 : 0;
    const counts = new Uint32Array(layerCount);
    voxels.forEach((voxel) => {
      if (voxel.paletteRole === "general" && !voxel.emissive) counts[voxel.y - ditherMinY] += 1;
    });
    const starts = new Uint32Array(layerCount + 1);
    for (let index = 0; index < layerCount; index += 1) starts[index + 1] = starts[index] + counts[index];
    const cursors = starts.slice(0, layerCount);
    const groupedIndices = new Uint32Array(ditherCount);
    voxels.forEach((voxel, index) => {
      if (voxel.paletteRole !== "general" || voxel.emissive) return;
      const layer = voxel.y - ditherMinY;
      groupedIndices[cursors[layer]++] = index;
    });
    for (let layer = 0; layer < layerCount; layer += 1) {
      const indices = groupedIndices.subarray(starts[layer], starts[layer + 1]);
      if (indices.length === 0) continue;
      const dithered = ditherPixels(
        Array.from(indices, (index) => ({
          x: voxels[index].x,
          y: voxels[index].z,
          color: voxels[index].rgb,
        })),
        sourcePalette.entries,
        options.dithering,
      );
      for (let ditherIndex = 0; ditherIndex < indices.length; ditherIndex += 1) {
        matchedSourceIndices[indices[ditherIndex]] = dithered.paletteIndices[ditherIndex];
      }
    }
  }
  voxels.forEach((voxel, index) => {
    if (index % 2048 === 0) onProgress?.("matching", 0.78 + index / voxels.length * 0.2);
    const matchedEntry = voxel.emissive
      ? matchEmissiveBlock(voxel.rgb)
      : sourcePalette.entries[matchedSourceIndices
        ? matchedSourceIndices[index]
        : matchBlockColor(voxel.rgb, sourcePalette, voxel.paletteRole)];
    const compactKey = matchedEntry.blockId;
    let compactIndex = compactMap.get(compactKey);
    if (compactIndex === undefined) {
      compactIndex = compactPalette.length;
      compactMap.set(compactKey, compactIndex);
      compactPalette.push({ blockId: matchedEntry.blockId, color: [...matchedEntry.color] });
    }
    positions[index * 3] = voxel.x;
    positions[index * 3 + 1] = voxel.y;
    positions[index * 3 + 2] = voxel.z;
    blockIndices[index] = compactIndex;
    if (voxel.paletteRole === "skinBase") skinBlockCount += 1;
    min[0] = Math.min(min[0], voxel.x);
    min[1] = Math.min(min[1], voxel.y);
    min[2] = Math.min(min[2], voxel.z);
    max[0] = Math.max(max[0], voxel.x);
    max[1] = Math.max(max[1], voxel.y);
    max[2] = Math.max(max[2], voxel.z);
  });
  const dimensions: [number, number, number] = [
    max[0] - min[0] + 1,
    max[1] - min[1] + 1,
    max[2] - min[2] + 1,
  ];
  const result: SolidVoxelResult = {
    kind: "solid",
    positions,
    blockIndices,
    palette: compactPalette,
    ...(mesh.faceFrame ? { faceFrame: mesh.faceFrame } : {}),
    stats: {
      blockCount: voxels.length,
      surfaceBlockCount: surfaceVoxels.length,
      filledBlockCount: filledVoxels.length,
      skinBlockCount,
      alphaRejected,
      triangleBoxTests,
      paletteSize: compactPalette.length,
      dimensions,
    },
    bounds: { min, max },
  };
  return options.materialTheme === "ancientRuins" && options.ruinDecoration > 0
    ? decorateSolidAncientRuins(result, options.ruinDecoration)
    : result;
};
