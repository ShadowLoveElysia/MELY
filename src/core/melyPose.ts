import * as THREE from "three";
import type {
  MelyPoseApplyResult,
  MelyPoseBone,
  MelyPoseDocument,
  MelyPoseMorph,
  MmdBoneInfo,
} from "../types";
import { appError } from "./appError";

type VectorTuple = [number, number, number];
type QuaternionTuple = [number, number, number, number];

export interface MelyPoseBinding {
  index: number;
  info: MmdBoneInfo;
  bone: THREE.Bone;
  restPosition: THREE.Vector3;
  restQuaternion: THREE.Quaternion;
}

export interface MelyPoseMorphBinding {
  index: number;
  name: string;
  englishName: string;
  weight: number;
}

export interface ResolvedMelyPoseBone {
  index: number;
  positionOffset: THREE.Vector3;
  quaternionOffset: THREE.Quaternion;
}

export interface ResolvedMelyPoseMorph {
  index: number;
  weight: number;
}

export interface ResolvedMelyPose extends MelyPoseApplyResult {
  bones: ResolvedMelyPoseBone[];
  morphs: ResolvedMelyPoseMorph[];
}

export const MAX_MELY_POSE_BYTES = 2 * 1024 * 1024;
export const MAX_MELY_POSE_BONES = 4096;
export const MAX_MELY_POSE_MORPHS = 4096;

const POSITION_EPSILON = 1e-5;
const ROTATION_EPSILON = 1e-6;
const MORPH_EPSILON = 1e-6;
const MAX_BONE_NAME_LENGTH = 256;
const MAX_MORPH_NAME_LENGTH = 256;
const MAX_COMPONENT_MAGNITUDE = 1_000_000;

export const normalizeMelyBoneName = (value: string) =>
  value.normalize("NFKC").trim().toLowerCase().replace(/[\s_-]+/g, "");

const canonicalizeQuaternion = (quaternion: THREE.Quaternion) => {
  quaternion.normalize();
  if (quaternion.w < 0) {
    quaternion.set(-quaternion.x, -quaternion.y, -quaternion.z, -quaternion.w);
  }
  return quaternion;
};

const roundComponent = (value: number) => {
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return Object.is(rounded, -0) ? 0 : rounded;
};

const vectorTuple = (vector: THREE.Vector3): VectorTuple => [
  roundComponent(vector.x),
  roundComponent(vector.y),
  roundComponent(vector.z),
];

const quaternionTuple = (quaternion: THREE.Quaternion): QuaternionTuple => [
  roundComponent(quaternion.x),
  roundComponent(quaternion.y),
  roundComponent(quaternion.z),
  roundComponent(quaternion.w),
];

const isIdentityPoseOffset = (
  position: THREE.Vector3,
  quaternion: THREE.Quaternion,
) => position.lengthSq() <= POSITION_EPSILON * POSITION_EPSILON
  && Math.abs(quaternion.x) <= ROTATION_EPSILON
  && Math.abs(quaternion.y) <= ROTATION_EPSILON
  && Math.abs(quaternion.z) <= ROTATION_EPSILON
  && Math.abs(1 - Math.abs(quaternion.w)) <= ROTATION_EPSILON;

export const captureMelyPose = (
  bindings: readonly MelyPoseBinding[],
  morphBindings: readonly MelyPoseMorphBinding[] = [],
): MelyPoseDocument => {
  const positionOffset = new THREE.Vector3();
  const quaternionOffset = new THREE.Quaternion();
  const bones: MelyPoseBone[] = [];

  bindings.forEach((binding) => {
    positionOffset.copy(binding.bone.position).sub(binding.restPosition);
    quaternionOffset
      .copy(binding.restQuaternion)
      .invert()
      .multiply(binding.bone.quaternion);
    canonicalizeQuaternion(quaternionOffset);
    if (isIdentityPoseOffset(positionOffset, quaternionOffset)) return;
    bones.push({
      name: binding.info.name,
      pos: vectorTuple(positionOffset),
      rot: quaternionTuple(quaternionOffset),
    });
  });

  const morphs: MelyPoseMorph[] = morphBindings
    .filter((binding) => Number.isFinite(binding.weight) && Math.abs(binding.weight) > MORPH_EPSILON)
    .map((binding) => ({
      name: binding.name || binding.englishName,
      weight: roundComponent(binding.weight),
    }))
    .filter((morph) => Boolean(morph.name));

  return {
    generator: "MELY",
    version: "1.0",
    bones,
    ...(morphs.length ? { morphs } : {}),
  };
};

const isFiniteTuple = (value: unknown, length: number): value is number[] =>
  Array.isArray(value)
  && value.length === length
  && value.every((component) => Number.isFinite(component)
    && Math.abs(component) <= MAX_COMPONENT_MAGNITUDE);

const parseBone = (value: unknown, index: number): MelyPoseBone => {
  if (!value || typeof value !== "object") {
    throw appError("error.pose.invalidBone", { index: index + 1 });
  }
  const bone = value as { name?: unknown; pos?: unknown; rot?: unknown };
  if (typeof bone.name !== "string" || !bone.name.trim() || bone.name.length > MAX_BONE_NAME_LENGTH) {
    throw appError("error.pose.invalidBoneName", { index: index + 1 });
  }
  if (!isFiniteTuple(bone.pos, 3)) {
    throw appError("error.pose.invalidPosition", { name: bone.name });
  }
  if (!isFiniteTuple(bone.rot, 4)) {
    throw appError("error.pose.invalidRotation", { name: bone.name });
  }
  const quaternion = new THREE.Quaternion(...bone.rot as QuaternionTuple);
  if (quaternion.lengthSq() <= 1e-12) {
    throw appError("error.pose.zeroQuaternion", { name: bone.name });
  }
  canonicalizeQuaternion(quaternion);
  return {
    name: bone.name.trim(),
    pos: [...bone.pos] as VectorTuple,
    rot: quaternion.toArray() as QuaternionTuple,
  };
};

const parseMorph = (value: unknown, index: number): MelyPoseMorph => {
  if (!value || typeof value !== "object") {
    throw appError("error.pose.invalidMorph", { index: index + 1 });
  }
  const morph = value as { name?: unknown; weight?: unknown };
  if (
    typeof morph.name !== "string"
    || !morph.name.trim()
    || morph.name.length > MAX_MORPH_NAME_LENGTH
  ) {
    throw appError("error.pose.invalidMorphName", { index: index + 1 });
  }
  if (
    typeof morph.weight !== "number"
    || !Number.isFinite(morph.weight)
    || Math.abs(morph.weight) > MAX_COMPONENT_MAGNITUDE
  ) {
    throw appError("error.pose.invalidMorphWeight", { name: morph.name });
  }
  return {
    name: morph.name.trim(),
    weight: roundComponent(morph.weight),
  };
};

export const parseMelyPoseJson = (text: string): MelyPoseDocument => {
  if (new TextEncoder().encode(text).byteLength > MAX_MELY_POSE_BYTES) {
    throw appError("error.pose.tooLarge", { limit: 2 });
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw appError("error.pose.invalidJson");
  }
  if (!value || typeof value !== "object") throw appError("error.pose.invalidRoot");
  const document = value as {
    generator?: unknown;
    version?: unknown;
    bones?: unknown;
    morphs?: unknown;
  };
  if (document.generator !== "MELY") throw appError("error.pose.invalidGenerator");
  if (document.version !== "1.0") {
    throw appError("error.pose.unsupportedVersion", { version: String(document.version) });
  }
  if (!Array.isArray(document.bones)) throw appError("error.pose.missingBones");
  if (document.bones.length > MAX_MELY_POSE_BONES) {
    throw appError("error.pose.tooManyBones", { limit: MAX_MELY_POSE_BONES });
  }
  if (document.morphs !== undefined && !Array.isArray(document.morphs)) {
    throw appError("error.pose.invalidMorph", { index: 1 });
  }
  if (Array.isArray(document.morphs) && document.morphs.length > MAX_MELY_POSE_MORPHS) {
    throw appError("error.pose.tooManyMorphs", { limit: MAX_MELY_POSE_MORPHS });
  }

  const seenNames = new Set<string>();
  const bones = document.bones.map((bone, index) => {
    const parsed = parseBone(bone, index);
    const normalized = normalizeMelyBoneName(parsed.name);
    if (seenNames.has(normalized)) throw appError("error.pose.duplicateBone", { name: parsed.name });
    seenNames.add(normalized);
    return parsed;
  });
  const seenMorphNames = new Set<string>();
  const morphs = Array.isArray(document.morphs)
    ? document.morphs.map((morph, index) => {
        const parsed = parseMorph(morph, index);
        const normalized = normalizeMelyBoneName(parsed.name);
        if (seenMorphNames.has(normalized)) {
          throw appError("error.pose.duplicateMorph", { name: parsed.name });
        }
        seenMorphNames.add(normalized);
        return parsed;
      })
    : [];
  return {
    generator: "MELY",
    version: "1.0",
    bones,
    ...(morphs.length ? { morphs } : {}),
  };
};

export const stringifyMelyPose = (pose: MelyPoseDocument) => JSON.stringify(pose);

export const resolveMelyPose = (
  pose: MelyPoseDocument,
  bindings: readonly MelyPoseBinding[],
  morphBindings: readonly MelyPoseMorphBinding[] = [],
): ResolvedMelyPose => {
  const boneLookup = new Map<string, MelyPoseBinding>();
  bindings.forEach((binding) => {
    const aliases = [binding.info.name, binding.info.englishName, binding.bone.name];
    aliases.forEach((alias) => {
      const normalized = normalizeMelyBoneName(alias);
      if (normalized && !boneLookup.has(normalized)) boneLookup.set(normalized, binding);
    });
  });

  const usedIndices = new Set<number>();
  const missingBoneNames: string[] = [];
  const bones: ResolvedMelyPoseBone[] = [];
  pose.bones.forEach((bone) => {
    const binding = boneLookup.get(normalizeMelyBoneName(bone.name));
    if (!binding || usedIndices.has(binding.index)) {
      missingBoneNames.push(bone.name);
      return;
    }
    usedIndices.add(binding.index);
    bones.push({
      index: binding.index,
      positionOffset: new THREE.Vector3(...bone.pos),
      quaternionOffset: canonicalizeQuaternion(new THREE.Quaternion(...bone.rot)),
    });
  });

  const morphLookup = new Map<string, MelyPoseMorphBinding>();
  morphBindings.forEach((binding) => {
    [binding.name, binding.englishName].forEach((alias) => {
      const normalized = normalizeMelyBoneName(alias);
      if (normalized && !morphLookup.has(normalized)) morphLookup.set(normalized, binding);
    });
  });
  const usedMorphIndices = new Set<number>();
  const missingMorphNames: string[] = [];
  const morphs: ResolvedMelyPoseMorph[] = [];
  pose.morphs?.forEach((morph) => {
    const binding = morphLookup.get(normalizeMelyBoneName(morph.name));
    if (!binding || usedMorphIndices.has(binding.index)) {
      missingMorphNames.push(morph.name);
      return;
    }
    usedMorphIndices.add(binding.index);
    morphs.push({ index: binding.index, weight: morph.weight });
  });

  return {
    bones,
    morphs,
    appliedBoneCount: bones.length,
    missingBoneNames,
    appliedMorphCount: morphs.length,
    missingMorphNames,
  };
};
