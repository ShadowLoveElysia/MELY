import { CcdIkSolver } from "@yohawing/three-mmd-loader";
import type {
  MmdAnimation,
  VmdBoneTrack,
  VmdMorphTrack,
} from "@yohawing/three-mmd-loader/parser";
import * as THREE from "three";
import type {
  BoneControlMode,
  MelyPoseApplyResult,
  MelyPoseDocument,
  MmdBoneInfo,
  MmdPoseState,
} from "../types";
import type { MmdPoseTransferState } from "./mmdRuntime";
import {
  captureMelyPose,
  resolveMelyPose,
  type MelyPoseBinding,
  type MelyPoseMorphBinding,
} from "./melyPose";

type VectorTuple = [number, number, number];
type QuaternionTuple = [number, number, number, number];

interface PoseOffset {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

interface SerializedOffset {
  index: number;
  position: VectorTuple;
  quaternion: QuaternionTuple;
}

interface RuntimeIkLink {
  boneIndex: number;
  enabled?: boolean;
  fixedAxis?: readonly [number, number, number];
  localAxisBasis?: readonly [number, number, number, number];
  angleLimit?: {
    minimumAngle: readonly [number, number, number];
    maximumAngle: readonly [number, number, number];
  };
  limitsKind?: "pmdKnee" | "pmxLinkLimit";
}

interface RuntimeIkChain {
  goalBoneIndex: number;
  effectorBoneIndex: number;
  links: RuntimeIkLink[];
  iterationCount: number;
  maxAnglePerIteration?: number;
  tolerance?: number;
}

export interface MmdPoseController {
  readonly bones: readonly MmdBoneInfo[];
  readonly translationStep: number;
  syncAfterRuntimePreview: () => void;
  syncAfterRuntimeUpdate: () => void;
  beginBoneEdit: (index: number) => void;
  updateBoneEdit: (index: number) => void;
  endBoneEdit: (index: number) => boolean;
  nudgeBone: (index: number, axis: "x" | "y" | "z", amount: number) => boolean;
  resetBone: (index: number) => boolean;
  undo: () => boolean;
  redo: () => boolean;
  reset: (recordHistory?: boolean) => boolean;
  exportMelyPose: () => MelyPoseDocument;
  importMelyPose: (pose: MelyPoseDocument) => MelyPoseApplyResult;
  exportTransferState: () => MmdPoseTransferState;
  importTransferState: (state: MmdPoseTransferState) => MelyPoseApplyResult;
  importedPoseAnimation: () => MmdAnimation | null;
  importedPoseClip: () => THREE.AnimationClip | null;
  state: () => MmdPoseState;
}

const EPSILON = 1e-7;
const HISTORY_LIMIT = 80;

const normalizeBoneName = (value: string) =>
  value.normalize("NFKC").trim().toLowerCase().replace(/[\s_-]+/g, "");

const translationBoneNames = new Set([
  "root",
  "master",
  "center",
  "groove",
  "allparent",
  "全ての親",
  "全親",
  "センター",
  "グルーブ",
]);

const isTranslationBone = (bone: THREE.Bone, isIkGoal: boolean) => {
  if (isIkGoal) return true;
  const names = [
    bone.name,
    typeof bone.userData.mmdBoneName === "string" ? bone.userData.mmdBoneName : "",
    typeof bone.userData.mmdEnglishBoneName === "string" ? bone.userData.mmdEnglishBoneName : "",
  ];
  return names.some((name) => translationBoneNames.has(normalizeBoneName(name)));
};

const readIkChains = (mesh: THREE.SkinnedMesh): RuntimeIkChain[] => {
  const raw = mesh.userData.mmdIkChains;
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is RuntimeIkChain => {
    if (!value || typeof value !== "object") return false;
    const chain = value as Partial<RuntimeIkChain>;
    return Number.isInteger(chain.goalBoneIndex)
      && Number.isInteger(chain.effectorBoneIndex)
      && Number.isFinite(chain.iterationCount)
      && Array.isArray(chain.links);
  });
};

const createBoneInfos = (
  bones: readonly THREE.Bone[],
  ikGoalIndices: ReadonlySet<number>,
): MmdBoneInfo[] => bones.map((bone, index) => {
  const mmdName = typeof bone.userData.mmdBoneName === "string"
    ? bone.userData.mmdBoneName
    : "";
  const name = mmdName || bone.name || `mely_bone_${index}`;
  const englishName = typeof bone.userData.mmdEnglishBoneName === "string"
    ? bone.userData.mmdEnglishBoneName
    : bone.name;
  const isIkGoal = ikGoalIndices.has(index);
  const controlMode: BoneControlMode = isTranslationBone(bone, isIkGoal) ? "translate" : "rotate";
  const parentIndex = bone.parent instanceof THREE.Bone ? bones.indexOf(bone.parent) : -1;
  const displayName = englishName && normalizeBoneName(englishName) !== normalizeBoneName(name)
    ? `${name} / ${englishName}`
    : mmdName || bone.name;
  return { index, name, englishName, displayName, parentIndex, controlMode, isIkGoal };
});

const cloneSerialized = (pose: readonly SerializedOffset[]): SerializedOffset[] => pose.map((offset) => ({
  index: offset.index,
  position: [...offset.position],
  quaternion: [...offset.quaternion],
}));

const posesEqual = (left: readonly SerializedOffset[], right: readonly SerializedOffset[]) => {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (!a || !b || a.index !== b.index) return false;
    for (let component = 0; component < 3; component += 1) {
      if (Math.abs(a.position[component] - b.position[component]) > EPSILON) return false;
    }
    for (let component = 0; component < 4; component += 1) {
      if (Math.abs(a.quaternion[component] - b.quaternion[component]) > EPSILON) return false;
    }
  }
  return true;
};

const canonicalizeQuaternion = (quaternion: THREE.Quaternion) => {
  quaternion.normalize();
  if (quaternion.w < 0) quaternion.set(-quaternion.x, -quaternion.y, -quaternion.z, -quaternion.w);
  return quaternion;
};

const isIdentityOffset = (offset: PoseOffset) =>
  offset.position.lengthSq() <= EPSILON * EPSILON
  && Math.abs(1 - Math.abs(offset.quaternion.w)) <= EPSILON
  && Math.abs(offset.quaternion.x) <= EPSILON
  && Math.abs(offset.quaternion.y) <= EPSILON
  && Math.abs(offset.quaternion.z) <= EPSILON;

const createStaticBoneTrack = (
  positionOffset: THREE.Vector3,
  restQuaternion: THREE.Quaternion,
  quaternionOffset: THREE.Quaternion,
): VmdBoneTrack => {
  const quaternion = restQuaternion.clone().multiply(quaternionOffset).normalize();
  return {
    packed: "bone",
    frames: new Uint32Array([0]),
    translations: new Float32Array([
      positionOffset.x,
      positionOffset.y,
      -positionOffset.z,
    ]),
    rotations: new Float32Array([
      -quaternion.x,
      -quaternion.y,
      quaternion.z,
      quaternion.w,
    ]),
    interpolations: new Float32Array(16),
    physicsToggles: new Int8Array([-1]),
  };
};

const createStaticMorphTrack = (weight: number): VmdMorphTrack => ({
  packed: "morph",
  frames: new Uint32Array([0]),
  weights: new Float32Array([weight]),
});

export const createMmdPoseController = (mesh: THREE.SkinnedMesh): MmdPoseController => {
  const skeletonBones = mesh.skeleton.bones;
  const ikChains = readIkChains(mesh);
  const ikGoalIndices = new Set(ikChains.map((chain) => chain.goalBoneIndex));
  const boneInfos = createBoneInfos(skeletonBones, ikGoalIndices);
  const restPositions = skeletonBones.map((bone) => bone.position.clone());
  const restQuaternions = skeletonBones.map((bone) => bone.quaternion.clone());
  const basePositions = restPositions.map((position) => position.clone());
  const baseQuaternions = restQuaternions.map((quaternion) => quaternion.clone());
  const poseBindings: MelyPoseBinding[] = skeletonBones.map((bone, index) => ({
    index,
    info: boneInfos[index],
    bone,
    restPosition: restPositions[index],
    restQuaternion: restQuaternions[index],
  }));
  const rawMorphs = Array.isArray(mesh.userData.mmdMorphs)
    ? mesh.userData.mmdMorphs as Array<{ name?: unknown; englishName?: unknown }>
    : [];
  const morphInfluences = mesh.morphTargetInfluences ?? [];
  const morphBindings = (): MelyPoseMorphBinding[] => morphInfluences.map((weight, index) => {
    const metadata = rawMorphs[index];
    const dictionaryName = Object.entries(mesh.morphTargetDictionary ?? {})
      .find(([, value]) => value === index)?.[0] ?? "";
    const name = typeof metadata?.name === "string" ? metadata.name : dictionaryName;
    const englishName = typeof metadata?.englishName === "string" ? metadata.englishName : dictionaryName;
    return { index, name, englishName, weight };
  });
  const offsets = new Map<number, PoseOffset>();
  const undoStack: SerializedOffset[][] = [];
  const redoStack: SerializedOffset[][] = [];
  const ikSolver = new CcdIkSolver();
  if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
  const sourceHeight = mesh.geometry.boundingBox?.getSize(new THREE.Vector3()).y ?? 1;
  const translationStep = THREE.MathUtils.clamp(sourceHeight * 0.015, 0.05, 0.75);
  let editStart: SerializedOffset[] | null = null;
  let runtimeBaseDirty = false;
  let importedAnimation: MmdAnimation | null = null;
  let importedClip: THREE.AnimationClip | null = null;
  let importedPose: MelyPoseDocument | null = null;

  const clonePoseDocument = (document: MelyPoseDocument): MelyPoseDocument => ({
    generator: "MELY",
    version: "1.0",
    bones: document.bones.map((bone) => ({
      name: bone.name,
      pos: [...bone.pos],
      rot: [...bone.rot],
    })),
    ...(document.morphs?.length ? {
      morphs: document.morphs.map((morph) => ({ ...morph })),
    } : {}),
  });

  const applyImportedPose = (document: MelyPoseDocument | null) => {
    skeletonBones.forEach((_bone, index) => {
      basePositions[index].copy(restPositions[index]);
      baseQuaternions[index].copy(restQuaternions[index]);
    });
    morphInfluences.fill(0);

    if (!document) {
      importedAnimation = null;
      importedClip = null;
      importedPose = null;
      syncMorphSplitTargets();
      return null;
    }

    const currentMorphBindings = morphBindings();
    const resolved = resolveMelyPose(document, poseBindings, currentMorphBindings);
    resolved.bones.forEach((bone) => {
      basePositions[bone.index].add(bone.positionOffset);
      baseQuaternions[bone.index].multiply(bone.quaternionOffset).normalize();
    });
    resolved.morphs.forEach((morph) => {
      morphInfluences[morph.index] = morph.weight;
    });

    const boneTracks = Object.fromEntries(resolved.bones.flatMap((bone) => {
      const name = boneInfos[bone.index]?.name;
      if (!name) return [];
      return [[name, createStaticBoneTrack(
        bone.positionOffset,
        restQuaternions[bone.index],
        bone.quaternionOffset,
      )]];
    })) as Record<string, VmdBoneTrack>;
    const morphNames = new Map(currentMorphBindings.map((binding) => [
      binding.index,
      binding.name || binding.englishName,
    ]));
    const morphTracks = Object.fromEntries(resolved.morphs.flatMap((morph) => {
      const name = morphNames.get(morph.index);
      return name ? [[name, createStaticMorphTrack(morph.weight)]] : [];
    })) as Record<string, VmdMorphTrack>;
    importedAnimation = Object.keys(boneTracks).length || Object.keys(morphTracks).length
      ? {
          kind: "vmd",
          bytes: new Uint8Array(),
          metadata: {
            modelName: "MELY Pose",
            counts: {
              bones: Object.keys(boneTracks).length,
              morphs: Object.keys(morphTracks).length,
              cameras: 0,
              lights: 0,
              selfShadows: 0,
              properties: 0,
            },
            maxFrame: 0,
          },
          boneTracks,
          morphTracks,
          cameraFrames: [],
          lightFrames: [],
          selfShadowFrames: [],
          propertyFrames: [],
        }
      : null;
    const clipTracks: THREE.KeyframeTrack[] = [];
    resolved.bones.forEach((bone) => {
      const info = boneInfos[bone.index];
      if (!info) return;
      const position = restPositions[bone.index].clone().add(bone.positionOffset);
      const quaternion = restQuaternions[bone.index]
        .clone()
        .multiply(bone.quaternionOffset)
        .normalize();
      clipTracks.push(
        new THREE.VectorKeyframeTrack(
          `.bones[${info.name}].position`,
          [0],
          position.toArray(),
        ),
        new THREE.QuaternionKeyframeTrack(
          `.bones[${info.name}].quaternion`,
          [0],
          quaternion.toArray(),
        ),
      );
    });
    resolved.morphs.forEach((morph) => {
      clipTracks.push(new THREE.NumberKeyframeTrack(
        `.morphTargetInfluences[${morph.index}]`,
        [0],
        [morph.weight],
      ));
    });
    importedClip = clipTracks.length
      ? new THREE.AnimationClip("MELY Pose", 0, clipTracks)
      : null;
    importedPose = clonePoseDocument(document);
    syncMorphSplitTargets();
    return resolved;
  };

  const captureRuntimeBase = () => {
    skeletonBones.forEach((bone, index) => {
      basePositions[index].copy(bone.position);
      baseQuaternions[index].copy(bone.quaternion);
    });
    runtimeBaseDirty = false;
  };

  const ensureRuntimeBase = () => {
    if (runtimeBaseDirty) captureRuntimeBase();
  };

  const serialize = (): SerializedOffset[] => [...offsets.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, offset]) => ({
      index,
      position: offset.position.toArray() as VectorTuple,
      quaternion: offset.quaternion.toArray() as QuaternionTuple,
    }));

  const replaceOffsets = (serialized: readonly SerializedOffset[]) => {
    offsets.clear();
    serialized.forEach((offset) => {
      if (!skeletonBones[offset.index]) return;
      offsets.set(offset.index, {
        position: new THREE.Vector3(...offset.position),
        quaternion: canonicalizeQuaternion(new THREE.Quaternion(...offset.quaternion)),
      });
    });
  };

  const manualOffsetDocument = (): MelyPoseDocument => ({
    generator: "MELY",
    version: "1.0",
    bones: serialize().flatMap((offset) => {
      const info = boneInfos[offset.index];
      return info ? [{
        name: info.name,
        pos: [...offset.position],
        rot: [...offset.quaternion],
      }] : [];
    }),
  });

  const applyManualOffsetDocument = (document: MelyPoseDocument) => {
    const resolved = resolveMelyPose(document, poseBindings);
    replaceOffsets(resolved.bones.map((bone) => ({
      index: bone.index,
      position: bone.positionOffset.toArray() as VectorTuple,
      quaternion: bone.quaternionOffset.toArray() as QuaternionTuple,
    })));
    undoStack.length = 0;
    redoStack.length = 0;
    editStart = null;
    applyOffsets();
    return resolved;
  };

  const pushHistory = (snapshot: SerializedOffset[]) => {
    undoStack.push(cloneSerialized(snapshot));
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack.length = 0;
  };

  const solveManualIk = () => {
    const activeChains = ikChains.filter((chain) => {
      const offset = offsets.get(chain.goalBoneIndex);
      return Boolean(offset && offset.position.lengthSq() > EPSILON * EPSILON);
    });
    if (!activeChains.length) return;

    const bones = skeletonBones.map((bone, index) => ({
      parentIndex: boneInfos[index]?.parentIndex ?? -1,
      translation: [bone.position.x, bone.position.y, -bone.position.z] as const,
    }));
    const rotations = skeletonBones.map((bone) => [
      -bone.quaternion.x,
      -bone.quaternion.y,
      bone.quaternion.z,
      bone.quaternion.w,
    ] as [number, number, number, number]);

    ikSolver.solve({ bones, pose: { rotations }, chains: activeChains });
    rotations.forEach((rotation, index) => {
      skeletonBones[index]?.quaternion.set(-rotation[0], -rotation[1], rotation[2], rotation[3]);
    });
  };

  const applyOffsets = () => {
    skeletonBones.forEach((bone, index) => {
      bone.position.copy(basePositions[index]);
      bone.quaternion.copy(baseQuaternions[index]);
      const offset = offsets.get(index);
      if (offset) {
        bone.position.add(offset.position);
        bone.quaternion.multiply(offset.quaternion).normalize();
      }
      bone.updateMatrix();
    });
    solveManualIk();
    mesh.updateMatrixWorld(true);
    mesh.skeleton.update();
    if (mesh.skeleton.boneTexture) mesh.skeleton.boneTexture.needsUpdate = true;
  };

  const applyPreviewOffsets = () => {
    offsets.forEach((offset, index) => {
      const bone = skeletonBones[index];
      if (!bone) return;
      bone.position.add(offset.position);
      bone.quaternion.multiply(offset.quaternion).normalize();
      bone.updateMatrix();
    });
    solveManualIk();
  };

  const syncMorphSplitTargets = () => {
    const bodyMeshes = mesh.userData.mmdMorphSplitBodyMeshes;
    if (!Array.isArray(bodyMeshes)) return;
    bodyMeshes.forEach((value) => {
      if (!(value instanceof THREE.SkinnedMesh)) return;
      const targetInfluences = value.morphTargetInfluences;
      const split = value.userData.mmdMorphSplitBody as {
        morphTargetIndices?: ArrayLike<number>;
      } | undefined;
      if (!targetInfluences || !split?.morphTargetIndices) return;
      for (let index = 0; index < split.morphTargetIndices.length; index += 1) {
        targetInfluences[index] = morphInfluences[split.morphTargetIndices[index] ?? -1] ?? 0;
      }
    });
  };

  const captureOffsetFromBone = (index: number) => {
    const bone = skeletonBones[index];
    const info = boneInfos[index];
    if (!bone || !info) return;
    const previous = offsets.get(index);
    const next: PoseOffset = {
      position: previous?.position.clone() ?? new THREE.Vector3(),
      quaternion: previous?.quaternion.clone() ?? new THREE.Quaternion(),
    };

    if (info.controlMode === "translate") {
      next.position.copy(bone.position).sub(basePositions[index]);
    } else {
      next.quaternion.copy(baseQuaternions[index]).invert().multiply(bone.quaternion);
      canonicalizeQuaternion(next.quaternion);
    }

    if (isIdentityOffset(next)) offsets.delete(index);
    else offsets.set(index, next);
  };

  const restoreWithHistory = (target: SerializedOffset[], destination: SerializedOffset[][]) => {
    destination.push(serialize());
    if (destination.length > HISTORY_LIMIT) destination.shift();
    replaceOffsets(target);
    applyOffsets();
  };

  const finishEdit = (index: number) => {
    captureOffsetFromBone(index);
    applyOffsets();
    const before = editStart;
    editStart = null;
    const after = serialize();
    if (!before || posesEqual(before, after)) return false;
    pushHistory(before);
    return true;
  };

  return {
    bones: boneInfos,
    translationStep,
    syncAfterRuntimePreview: () => {
      runtimeBaseDirty = true;
      if (offsets.size > 0) applyPreviewOffsets();
    },
    syncAfterRuntimeUpdate: () => {
      if (offsets.size === 0) {
        runtimeBaseDirty = true;
        return;
      }
      captureRuntimeBase();
      applyOffsets();
    },
    beginBoneEdit: () => {
      ensureRuntimeBase();
      if (!editStart) editStart = serialize();
    },
    updateBoneEdit: (index) => {
      captureOffsetFromBone(index);
      applyOffsets();
    },
    endBoneEdit: (index) => {
      return finishEdit(index);
    },
    nudgeBone: (index, axis, amount) => {
      const bone = skeletonBones[index];
      const info = boneInfos[index];
      if (!bone || !info || !Number.isFinite(amount) || amount === 0) return false;
      ensureRuntimeBase();
      editStart = serialize();
      const direction = axis === "x"
        ? new THREE.Vector3(1, 0, 0)
        : axis === "y"
          ? new THREE.Vector3(0, 1, 0)
          : new THREE.Vector3(0, 0, 1);
      if (info.controlMode === "translate") bone.position.addScaledVector(direction, amount);
      else bone.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(direction, amount));
      return finishEdit(index);
    },
    resetBone: (index) => {
      if (!offsets.has(index)) return false;
      const before = serialize();
      offsets.delete(index);
      pushHistory(before);
      applyOffsets();
      return true;
    },
    undo: () => {
      const previous = undoStack.pop();
      if (!previous) return false;
      restoreWithHistory(previous, redoStack);
      return true;
    },
    redo: () => {
      const next = redoStack.pop();
      if (!next) return false;
      restoreWithHistory(next, undoStack);
      return true;
    },
    reset: (recordHistory = true) => {
      if (offsets.size === 0) {
        if (!recordHistory) {
          undoStack.length = 0;
          redoStack.length = 0;
        }
        return false;
      }
      const before = serialize();
      offsets.clear();
      if (recordHistory) pushHistory(before);
      else {
        undoStack.length = 0;
        redoStack.length = 0;
      }
      applyOffsets();
      return true;
    },
    exportMelyPose: () => captureMelyPose(poseBindings, morphBindings()),
    importMelyPose: (document) => {
      const resolved = applyImportedPose(document);
      if (!resolved) throw new Error("Imported pose resolution unexpectedly returned no result.");
      offsets.clear();
      undoStack.length = 0;
      redoStack.length = 0;
      editStart = null;
      runtimeBaseDirty = false;
      applyOffsets();
      return {
        appliedBoneCount: resolved.appliedBoneCount,
        missingBoneNames: resolved.missingBoneNames,
        appliedMorphCount: resolved.appliedMorphCount,
        missingMorphNames: resolved.missingMorphNames,
      };
    },
    exportTransferState: () => ({
      importedPose: importedPose ? clonePoseDocument(importedPose) : null,
      manualOffsets: manualOffsetDocument(),
    }),
    importTransferState: (state) => {
      const baseResult = applyImportedPose(state.importedPose);
      const manualResult = applyManualOffsetDocument(state.manualOffsets);
      runtimeBaseDirty = false;
      return {
        appliedBoneCount: (baseResult?.appliedBoneCount ?? 0) + manualResult.appliedBoneCount,
        missingBoneNames: [
          ...(baseResult?.missingBoneNames ?? []),
          ...manualResult.missingBoneNames,
        ],
        appliedMorphCount: baseResult?.appliedMorphCount ?? 0,
        missingMorphNames: baseResult?.missingMorphNames ?? [],
      };
    },
    importedPoseAnimation: () => importedAnimation,
    importedPoseClip: () => importedClip,
    state: () => ({
      editCount: offsets.size,
      canUndo: undoStack.length > 0,
      canRedo: redoStack.length > 0,
    }),
  };
};
