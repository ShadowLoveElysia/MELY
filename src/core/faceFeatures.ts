import type { FaceFrameSnapshot, MeshMaterialSnapshot } from "../types";

export type FaceFeatureKind = "eye" | "brow" | "mouth" | "overlay";

export interface LocalFacePoint {
  horizontal: number;
  vertical: number;
  depth: number;
}

type Point = readonly [number, number, number];

const dot = (left: Point, right: Point) =>
  left[0] * right[0] + left[1] * right[1] + left[2] * right[2];

const normalizedMaterialName = (material: MeshMaterialSnapshot) =>
  `${material.name} ${material.englishName}`
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s_.:\-]+/g, "");

export const materialFaceFeatureKind = (
  material: MeshMaterialSnapshot,
): FaceFeatureKind | undefined => {
  const name = normalizedMaterialName(material);
  if (["眉", "eyebrow", "brow"].some((keyword) => name.includes(keyword))) return "brow";
  if ([
    "眼", "瞳", "眼睛", "眼白", "右目", "左目", "両目", "黑目", "白目", "目玉",
    "睫毛", "まつげ", "eye", "iris", "pupil", "sclera", "lash",
  ].some((keyword) => name.includes(keyword))) return "eye";
  if ([
    "嘴", "唇", "舌", "牙", "口腔", "口内", "口中", "口红", "口紅",
    "mouth", "lip", "tongue", "teeth", "tooth", "oral",
  ].some((keyword) => name.includes(keyword))) return "mouth";
  if (["表情", "チーク", "涙", "facialexpression", "faceexpression", "expression", "blush", "tear"]
    .some((keyword) => name.includes(keyword))) return "overlay";
  return undefined;
};

export const faceFeaturePriority = (kind: FaceFeatureKind | undefined) => {
  if (kind === "eye") return 4;
  if (kind === "brow") return 3;
  if (kind === "mouth") return 2;
  if (kind === "overlay") return 1;
  return 0;
};

export const faceLocalPoint = (
  position: Point,
  frame: FaceFrameSnapshot,
): LocalFacePoint => {
  const scale = 1 / frame.eyeDistance;
  const relative: [number, number, number] = [
    position[0] - frame.origin[0],
    position[1] - frame.origin[1],
    position[2] - frame.origin[2],
  ];
  return {
    horizontal: dot(relative, frame.right) * scale,
    vertical: dot(relative, frame.up) * scale,
    depth: dot(relative, frame.forward) * scale,
  };
};

export const pointInsideFaceRegion = (point: LocalFacePoint) =>
  Math.abs(point.horizontal) <= 1.75
  && point.vertical >= -2.05
  && point.vertical <= 1.2
  && point.depth >= -1.5
  && point.depth <= 1.45;

export const featureInsideFace = (
  kind: FaceFeatureKind,
  point: LocalFacePoint,
) => {
  if (!pointInsideFaceRegion(point)) return false;
  if (kind === "eye" || kind === "brow") {
    return point.vertical >= -0.75 && point.vertical <= 0.9;
  }
  if (kind === "mouth") return point.vertical >= -1.8 && point.vertical <= 0.3;
  return point.vertical >= -1.9 && point.vertical <= 1;
};

export const validFaceFrame = (
  frame: FaceFrameSnapshot | undefined,
): frame is FaceFrameSnapshot => Boolean(
  frame
  && frame.confidence >= 0.55
  && Number.isFinite(frame.eyeDistance)
  && frame.eyeDistance > 1e-5,
);

const normalizeDirection = (direction: Point): [number, number, number] => {
  const length = Math.hypot(direction[0], direction[1], direction[2]) || 1;
  return [direction[0] / length, direction[1] / length, direction[2] / length];
};

export const normalizeFaceFrameSnapshot = (
  frame: FaceFrameSnapshot | undefined,
  centerX: number,
  minY: number,
  centerZ: number,
  scale: number,
): FaceFrameSnapshot | undefined => frame
  ? {
      origin: [
        (frame.origin[0] - centerX) * scale,
        (frame.origin[1] - minY) * scale,
        (frame.origin[2] - centerZ) * scale,
      ],
      right: normalizeDirection(frame.right),
      up: normalizeDirection(frame.up),
      forward: normalizeDirection(frame.forward),
      eyeDistance: frame.eyeDistance * scale,
      confidence: frame.confidence,
    }
  : undefined;
