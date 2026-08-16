import {
  AnimationClip,
  AnimationMixer,
  Box3,
  BufferGeometry,
  Color,
  Group,
  Material,
  Mesh,
  MeshPhongMaterial,
  MeshStandardMaterial,
  MeshToonMaterial,
  NumberKeyframeTrack,
  QuaternionKeyframeTrack,
  Skeleton,
  SkinnedMesh,
  Texture,
  Vector3,
  VectorKeyframeTrack,
} from "three";
import type {
  MelyPoseApplyResult,
  MelyPoseDocument,
  MmdBoneInfo,
  MmdMaterialInfo,
  MmdModelStats,
  MmdMotionTimes,
  MmdMotionTrackInfo,
  MmdMotionTrackKind,
  MmdPoseState,
} from "../types";
import { AppError, appError } from "./appError";
import {
  computeVisibleMmdBounds,
  isMmdTextureResourceLabel,
  isSuggestedEmissiveMaterial,
  isSuggestedSkinMaterial,
} from "./mmdModel";
import { createMmdPoseController, type MmdPoseController } from "./mmdPose";
import { normalizeMelyBoneName } from "./melyPose";
import type {
  LoadedMmdModel,
  MmdRendererMode,
  MmdSnapshotOptions,
  ThreeMmdViewportSource,
} from "./mmdRuntime";

export interface LoadedThreeMmdModel extends LoadedMmdModel {
  rendererMode: "vanilla" | "moeru";
  viewport: ThreeMmdViewportSource;
  root: Group;
  mesh: SkinnedMesh;
}

export interface ThreeMmdBackendMetadata {
  fileName: string;
  name: string;
  englishName: string;
  format: "pmx" | "pmd";
  rigidBodyCount: number;
  jointCount: number;
  boneEnglishNames?: readonly string[];
  morphEnglishNames?: readonly string[];
  materialNames?: readonly {
    name: string;
    englishName: string;
    diffuse?: readonly number[];
    ambient?: readonly number[];
    emissive?: readonly number[];
  }[];
}

export interface ThreeMmdBackendDriver {
  readonly rendererMode: "vanilla" | "moeru";
  readonly root: Group;
  readonly mesh: SkinnedMesh;
  readonly mixer: AnimationMixer;
  readonly metadata: ThreeMmdBackendMetadata;
  readonly textureWarnings: readonly string[];
  readonly physicsAvailable: boolean;
  loadMotionClip: (file: File) => Promise<AnimationClip>;
  evaluate: (deltaSeconds: number, physics: boolean) => void;
  resetPhysics: () => void;
  setPhysicsEnabled: (enabled: boolean) => Promise<void>;
  physicsEnabled: () => boolean;
  dispose: () => void | Promise<void>;
}

export const THREE_MMD_PHYSICS_FIXED_STEP = 1 / 120;
export const THREE_MMD_PHYSICS_SETTLE_STEPS = 120;

const materialList = (mesh: SkinnedMesh) => (
  Array.isArray(mesh.material) ? mesh.material : [mesh.material]
) as Material[];

const materialIsVisible = (material: Material | undefined) =>
  Boolean(material?.visible && material.opacity > 0.01);

const materialColor = (material: Material) => {
  const color = (
    material instanceof MeshStandardMaterial
    || material instanceof MeshPhongMaterial
    || material instanceof MeshToonMaterial
  ) ? material.color : null;
  if (!color) return [1, 1, 1] as [number, number, number];
  const srgb = color.clone().convertLinearToSRGB();
  return [srgb.r, srgb.g, srgb.b] as [number, number, number];
};

const materialAmbient = (material: Material, fallback?: readonly number[]) => {
  const candidate = material as Material & {
    ambient?: Color;
    emissive?: Color;
  };
  const color = candidate.ambient ?? candidate.emissive;
  if (color) {
    const srgb = color.clone().convertLinearToSRGB();
    return [srgb.r, srgb.g, srgb.b] as [number, number, number];
  }
  return fallback?.length && fallback.length >= 3
    ? [fallback[0], fallback[1], fallback[2]] as [number, number, number]
    : [0, 0, 0] as [number, number, number];
};

const collectMaterialInfo = (
  mesh: SkinnedMesh,
  metadata: ThreeMmdBackendMetadata,
): MmdMaterialInfo[] => materialList(mesh).map((material, index) => {
  const source = metadata.materialNames?.[index];
  const descriptor = (material as Material & {
    descriptor?: {
      name?: string;
      ambient?: Color;
      diffuse?: Color;
      opacity?: number;
      map?: Texture;
    };
  }).descriptor;
  const name = source?.name || descriptor?.name || material.name || "";
  const englishName = source?.englishName || "";
  const displayName = [englishName, name].find((label) => (
    label && !isMmdTextureResourceLabel(label)
  )) ?? "";
  const descriptorColor = descriptor?.diffuse?.clone().convertLinearToSRGB();
  const color = source?.diffuse && source.diffuse.length >= 3
    ? [source.diffuse[0], source.diffuse[1], source.diffuse[2]] as [number, number, number]
    : descriptorColor
      ? [descriptorColor.r, descriptorColor.g, descriptorColor.b] as [number, number, number]
      : materialColor(material);
  const opacity = source?.diffuse?.[3] ?? descriptor?.opacity ?? material.opacity;
  const map = "map" in material && material.map instanceof Texture
    ? material.map
    : descriptor?.map;
  const ambient = descriptor?.ambient
    ? (() => {
        const srgb = descriptor.ambient.clone().convertLinearToSRGB();
        return [srgb.r, srgb.g, srgb.b] as [number, number, number];
      })()
    : materialAmbient(material, source?.ambient);
  material.userData.mmdMaterial = {
    ...material.userData.mmdMaterial,
    name,
    englishName,
    diffuse: [color[0], color[1], color[2], opacity],
    ambient,
    ...(source?.emissive ? { emissive: [...source.emissive] } : {}),
  };
  return {
    index,
    name,
    englishName,
    displayName,
    color,
    opacity,
    hasTexture: Boolean(map),
    suggestedSkin: isSuggestedSkinMaterial(name, englishName),
    ambient,
    suggestedEmissive: isSuggestedEmissiveMaterial(
      name,
      englishName,
      source?.emissive,
    ),
  };
});

const collectBoneInfo = (
  mesh: SkinnedMesh,
  metadata: ThreeMmdBackendMetadata,
) => {
  mesh.skeleton.bones.forEach((bone, index) => {
    const englishName = metadata.boneEnglishNames?.[index] ?? "";
    bone.userData.mmdBoneName = bone.name;
    bone.userData.mmdEnglishBoneName = englishName;
  });
};

const collectMorphNames = (
  mesh: SkinnedMesh,
  metadata: ThreeMmdBackendMetadata,
) => Array.from(new Set([
  ...Object.keys(mesh.morphTargetDictionary ?? {}),
  ...(metadata.morphEnglishNames ?? []),
])).filter(Boolean);

const countVisibleTriangles = (mesh: SkinnedMesh) => {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute("position");
  const sourceIndex = geometry.getIndex();
  const materials = materialList(mesh);
  const groups = geometry.groups.length
    ? geometry.groups
    : [{ start: 0, count: sourceIndex?.count ?? position.count, materialIndex: 0 }];
  return groups.reduce((count, group) => {
    if (!materialIsVisible(materials[group.materialIndex ?? 0] ?? materials[0])) return count;
    const end = Math.min(group.start + group.count, sourceIndex?.count ?? position.count);
    return count + Math.max(0, Math.floor((end - group.start) / 3));
  }, 0);
};

const estimateTextureBytes = (materials: readonly Material[]) => {
  const seen = new Set<string>();
  return materials.reduce((bytes, material) => {
    if (!materialIsVisible(material)) return bytes;
    const map = "map" in material && material.map instanceof Texture ? material.map : null;
    if (!map || seen.has(map.uuid)) return bytes;
    seen.add(map.uuid);
    const image = map.source.data ?? map.image;
    if (!image || typeof image !== "object") return bytes;
    const dimensions = image as {
      width?: number;
      height?: number;
      naturalWidth?: number;
      naturalHeight?: number;
    };
    const width = dimensions.naturalWidth ?? dimensions.width ?? 0;
    const height = dimensions.naturalHeight ?? dimensions.height ?? 0;
    return bytes + Math.max(0, width) * Math.max(0, height) * 4;
  }, 0);
};

const disposeTextureSource = (value: unknown) => {
  if (typeof ImageBitmap !== "undefined" && value instanceof ImageBitmap) {
    value.close();
  } else if (typeof HTMLImageElement !== "undefined" && value instanceof HTMLImageElement) {
    value.onload = null;
    value.onerror = null;
    value.removeAttribute("src");
    value.removeAttribute("srcset");
  } else if (typeof HTMLCanvasElement !== "undefined" && value instanceof HTMLCanvasElement) {
    value.width = 0;
    value.height = 0;
  }
};

export const disposeThreeMmdResources = (root: Group, mesh: SkinnedMesh) => {
  const skeleton = mesh.skeleton;
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  const textureSources = new Set<Texture["source"]>();
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    geometries.add(object.geometry);
    const entries = Array.isArray(object.material) ? object.material : [object.material];
    entries.forEach((material) => materials.add(material));
    if (object.customDepthMaterial) materials.add(object.customDepthMaterial);
    if (object.customDistanceMaterial) materials.add(object.customDistanceMaterial);
  });
  geometries.add(mesh.geometry);
  materials.forEach((material) => {
    Object.values(material).forEach((value) => {
      if (value instanceof Texture) textures.add(value);
    });
    const descriptor = (material as Material & { descriptor?: Record<string, unknown> }).descriptor;
    Object.values(descriptor ?? {}).forEach((value) => {
      if (value instanceof Texture) textures.add(value);
    });
  });
  textures.forEach((texture) => {
    const source = texture.source.data ?? texture.image;
    texture.dispose();
    // Texture.clone() shares Source; release that image once while disposing every GPU texture.
    if (!textureSources.has(texture.source)) {
      textureSources.add(texture.source);
      disposeTextureSource(source);
      texture.source.data = null;
    }
    texture.mipmaps.length = 0;
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  skeleton?.dispose();
  root.clear();
  mesh.geometry = new BufferGeometry();
  mesh.material = [];
  mesh.skeleton = new Skeleton();
  mesh.morphTargetDictionary = {};
  mesh.morphTargetInfluences = [];
  mesh.userData = {};
};

const cloneFilteredClip = (
  clip: AnimationClip,
  name: string,
  filter: (trackName: string) => boolean,
) => new AnimationClip(
  name,
  clip.duration,
  clip.tracks.filter((track) => filter(track.name)).map((track) => track.clone()),
);

const isBoneTrack = (trackName: string) => trackName.includes(".bones[");
const isMorphTrack = (trackName: string) => trackName.includes(".morphTargetInfluences[");

const maxTrackFrame = async (file: File) => {
  const { parseVmd } = await import("@yohawing/three-mmd-loader/parser");
  const parsed = parseVmd(await file.arrayBuffer());
  return {
    modelName: parsed.metadata.modelName,
    maxFrame: parsed.metadata.maxFrame,
    boneNames: Object.keys(parsed.boneTracks),
    morphNames: Object.keys(parsed.morphTracks),
  };
};

interface ThreeRuntimeOptions {
  driver: ThreeMmdBackendDriver;
}

/**
 * Wraps a concrete Three MMD engine with the application contract. Animation
 * actions, pose edits and snapshots are owned here so both Three backends use
 * identical resource and state semantics.
 */
export const createThreeMmdModel = ({ driver }: ThreeRuntimeOptions): LoadedThreeMmdModel => {
  const { mesh, root, metadata, mixer } = driver;
  collectBoneInfo(mesh, metadata);
  let pose: MmdPoseController | null = createMmdPoseController(mesh);
  const bones = pose.bones;
  const morphNames = collectMorphNames(mesh, metadata);
  const materials = materialList(mesh);
  const materialInfo = collectMaterialInfo(mesh, metadata);
  const hiddenMaterialIndices = new Set<number>();
  const motionInfo: Record<MmdMotionTrackKind, MmdMotionTrackInfo | null> = {
    dance: null,
    expression: null,
  };
  const motionClips: Record<MmdMotionTrackKind, AnimationClip | null> = {
    dance: null,
    expression: null,
  };
  let danceAction: ReturnType<AnimationMixer["clipAction"]> | null = null;
  let expressionAction: ReturnType<AnimationMixer["clipAction"]> | null = null;
  let importedBoneAction: ReturnType<AnimationMixer["clipAction"]> | null = null;
  let importedMorphAction: ReturnType<AnimationMixer["clipAction"]> | null = null;
  let active = true;

  const currentPose = () => {
    if (!active || !pose) throw new Error("MMD model has been disposed");
    return pose;
  };
  const assertActive = () => {
    if (!active) throw new Error("MMD model has been disposed");
  };
  const applyMaterialVisibility = () => {
    hiddenMaterialIndices.forEach((index) => {
      if (materials[index]) materials[index].visible = false;
    });
  };
  const stopAction = (action: typeof danceAction) => {
    if (!action) return;
    action.stop();
    mixer.uncacheAction(action.getClip(), mesh);
  };
  const makeAction = (clip: AnimationClip | null) => {
    if (!clip?.tracks.length) return null;
    const action = mixer.clipAction(clip, mesh);
    action.enabled = true;
    action.clampWhenFinished = true;
    action.paused = true;
    action.play();
    return action;
  };
  const installActions = () => {
    [danceAction, expressionAction, importedBoneAction, importedMorphAction].forEach(stopAction);
    danceAction = null;
    expressionAction = null;
    importedBoneAction = null;
    importedMorphAction = null;
    mixer.stopAllAction();
    mesh.pose();
    mesh.morphTargetInfluences?.fill(0);

    const imported = currentPose().importedPoseClip();
    if (motionClips.dance) danceAction = makeAction(motionClips.dance);
    else if (imported) {
      importedBoneAction = makeAction(cloneFilteredClip(
        imported,
        "MELY imported bone pose",
        isBoneTrack,
      ));
    }
    if (motionClips.expression) expressionAction = makeAction(motionClips.expression);
    else if (imported) {
      importedMorphAction = makeAction(cloneFilteredClip(
        imported,
        "MELY imported morph pose",
        isMorphTrack,
      ));
    }
  };
  const clampTimes = (times: MmdMotionTimes) => ({
    dance: motionInfo.dance?.durationSeconds
      ? Math.max(0, Math.min(motionInfo.dance.durationSeconds, times.dance))
      : 0,
    expression: motionInfo.expression?.durationSeconds
      ? Math.max(0, Math.min(motionInfo.expression.durationSeconds, times.expression))
      : 0,
  });
  const setActionTimes = (times: MmdMotionTimes) => {
    if (danceAction) danceAction.time = times.dance;
    if (expressionAction) expressionAction.time = times.expression;
    if (importedBoneAction) importedBoneAction.time = 0;
    if (importedMorphAction) importedMorphAction.time = 0;
  };
  const finishEvaluation = (clamped: MmdMotionTimes) => {
    root.updateMatrixWorld(true);
    mesh.skeleton.update();
    if (mesh.skeleton.boneTexture) mesh.skeleton.boneTexture.needsUpdate = true;
    applyMaterialVisibility();
    return clamped;
  };
  const evaluateFrame = (
    times: MmdMotionTimes,
    deltaSeconds: number,
    physics: boolean,
  ) => {
    const clamped = clampTimes(times);
    setActionTimes(clamped);
    const delta = Number.isFinite(deltaSeconds) ? Math.max(0, deltaSeconds) : 0;
    driver.evaluate(delta, Boolean(physics && driver.physicsEnabled() && delta > 0));
    return finishEvaluation(clamped);
  };
  const settleFrame = (times: MmdMotionTimes) => {
    const clamped = clampTimes(times);
    setActionTimes(clamped);
    driver.evaluate(0, false);
    if (driver.physicsEnabled()) {
      driver.resetPhysics();
      for (let step = 0; step < THREE_MMD_PHYSICS_SETTLE_STEPS; step += 1) {
        setActionTimes(clamped);
        driver.evaluate(THREE_MMD_PHYSICS_FIXED_STEP, true);
      }
    }
    return finishEvaluation(clamped);
  };

  installActions();
  driver.evaluate(0, false);
  currentPose().syncAfterRuntimeUpdate();

  const position = mesh.geometry.getAttribute("position");
  const index = mesh.geometry.getIndex();
  const stats: MmdModelStats = {
    name: metadata.englishName || metadata.name || "MMD Model",
    format: metadata.format,
    vertexCount: position?.count ?? 0,
    triangleCount: index ? index.count / 3 : Math.floor((position?.count ?? 0) / 3),
    materialCount: materials.length,
    boneCount: bones.length,
    morphCount: morphNames.length,
    rigidBodyCount: metadata.rigidBodyCount,
    jointCount: metadata.jointCount,
    textureWarnings: driver.textureWarnings.length,
  };

  let loadedModel: LoadedThreeMmdModel;
  loadedModel = {
    id: crypto.randomUUID(),
    rendererMode: driver.rendererMode,
    fileName: metadata.fileName,
    viewport: { kind: "three", root, mesh },
    root,
    mesh,
    stats,
    textureWarnings: driver.textureWarnings,
    bones,
    morphNames,
    materials: materialInfo,
    translationStep: pose.translationStep,
    physicsAvailable: driver.physicsAvailable,
    physicsEnabled: driver.physicsEnabled,
    setPhysicsEnabled: async (enabled) => {
      assertActive();
      try {
        await driver.setPhysicsEnabled(enabled);
      } catch (error) {
        throw appError("error.physics.loadFailed", undefined, error);
      }
    },
    setMaterialVisible: (materialIndex, visible) => {
      assertActive();
      const material = materials[materialIndex];
      if (!material) throw new RangeError(`MMD material index is out of range: ${materialIndex}`);
      if (visible) {
        hiddenMaterialIndices.delete(materialIndex);
        material.visible = material.opacity > 0.01;
      } else {
        hiddenMaterialIndices.add(materialIndex);
        material.visible = false;
      }
    },
    visibleBounds: (target?: Box3) => {
      assertActive();
      return computeVisibleMmdBounds(root, mesh, target);
    },
    visibleTriangleCount: () => {
      assertActive();
      return countVisibleTriangles(mesh);
    },
    textureByteEstimate: () => {
      assertActive();
      return estimateTextureBytes(materials);
    },
    loadMotion: async (file, kind) => {
      assertActive();
      try {
        const [clip, parsed] = await Promise.all([
          driver.loadMotionClip(file),
          maxTrackFrame(file),
        ]);
        assertActive();
        const boneNames = new Set(
          bones.flatMap((bone) => [bone.name, bone.englishName])
            .map(normalizeMelyBoneName)
            .filter(Boolean),
        );
        const targetMorphNames = new Set(morphNames.map(normalizeMelyBoneName).filter(Boolean));
        const matchedBoneTrackCount = parsed.boneNames
          .filter((name) => boneNames.has(normalizeMelyBoneName(name))).length;
        const matchedMorphTrackCount = parsed.morphNames
          .filter((name) => targetMorphNames.has(normalizeMelyBoneName(name))).length;
        if ((kind === "dance" ? matchedBoneTrackCount : matchedMorphTrackCount) === 0) {
          throw appError("error.motion.noCompatibleTracks");
        }
        const filtered = cloneFilteredClip(
          clip,
          `${kind}:${file.name}`,
          kind === "dance" ? isBoneTrack : isMorphTrack,
        );
        motionClips[kind] = filtered;
        const info: MmdMotionTrackInfo = {
          kind,
          name: file.name.replace(/\.[^.]+$/, ""),
          modelName: parsed.modelName,
          maxFrame: parsed.maxFrame,
          frameRate: 30,
          durationSeconds: parsed.maxFrame / 30,
          boneTrackCount: parsed.boneNames.length,
          morphTrackCount: parsed.morphNames.length,
          matchedBoneTrackCount,
          matchedMorphTrackCount,
        };
        motionInfo[kind] = info;
        installActions();
        evaluateFrame({ dance: 0, expression: 0 }, 0, false);
        currentPose().syncAfterRuntimeUpdate();
        return info;
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw appError("error.motion.loadFailed", undefined, error);
      }
    },
    updatePreviewPose: (times) => {
      assertActive();
      const evaluated = evaluateFrame(times, 0, false);
      currentPose().syncAfterRuntimePreview();
      return evaluated;
    },
    updateLivePose: (times, deltaSeconds) => {
      assertActive();
      const evaluated = evaluateFrame(times, deltaSeconds, true);
      currentPose().syncAfterRuntimePreview();
      return evaluated;
    },
    updatePose: (times) => {
      assertActive();
      const evaluated = settleFrame(times);
      currentPose().syncAfterRuntimeUpdate();
      return evaluated;
    },
    createSnapshot: async (options: MmdSnapshotOptions = {}) => {
      assertActive();
      const { createMmdMeshSnapshot } = await import("./mmdSnapshot");
      return createMmdMeshSnapshot(loadedModel, options);
    },
    clearMotion: (kind) => {
      assertActive();
      if (!kind || kind === "dance") {
        motionInfo.dance = null;
        motionClips.dance = null;
      }
      if (!kind || kind === "expression") {
        motionInfo.expression = null;
        motionClips.expression = null;
      }
      installActions();
      evaluateFrame({ dance: 0, expression: 0 }, 0, false);
      currentPose().syncAfterRuntimeUpdate();
    },
    beginBoneEdit: (boneIndex) => currentPose().beginBoneEdit(boneIndex),
    updateBoneEdit: (boneIndex) => currentPose().updateBoneEdit(boneIndex),
    endBoneEdit: (boneIndex) => currentPose().endBoneEdit(boneIndex),
    nudgeBone: (boneIndex, axis, amount) => currentPose().nudgeBone(boneIndex, axis, amount),
    resetBone: (boneIndex) => currentPose().resetBone(boneIndex),
    undoPose: () => currentPose().undo(),
    redoPose: () => currentPose().redo(),
    resetPoseEdits: (recordHistory) => currentPose().reset(recordHistory),
    exportMelyPose: () => currentPose().exportMelyPose(),
    importMelyPose: (document: MelyPoseDocument): MelyPoseApplyResult => {
      const applied = currentPose().importMelyPose(document);
      installActions();
      evaluateFrame({ dance: 0, expression: 0 }, 0, false);
      currentPose().syncAfterRuntimeUpdate();
      return applied;
    },
    exportPoseTransferState: () => currentPose().exportTransferState(),
    importPoseTransferState: (state) => {
      const applied = currentPose().importTransferState(state);
      installActions();
      evaluateFrame({ dance: 0, expression: 0 }, 0, false);
      currentPose().syncAfterRuntimeUpdate();
      return applied;
    },
    poseState: (): MmdPoseState => currentPose().state(),
    dispose: async () => {
      if (!active) return;
      active = false;
      [danceAction, expressionAction, importedBoneAction, importedMorphAction].forEach(stopAction);
      mixer.stopAllAction();
      mixer.uncacheRoot(mesh);
      motionClips.dance = null;
      motionClips.expression = null;
      motionInfo.dance = null;
      motionInfo.expression = null;
      pose = null;
      try {
        await driver.dispose();
      } finally {
        // Driver-specific disposal (Ammo, Moeru helpers, blob URLs) may throw;
        // Three resources still need to be released so the renderer lease can
        // safely advance to the next backend.
        disposeThreeMmdResources(root, mesh);
      }
    },
  };
  return loadedModel;
};

export const createThreeBoneTrack = (
  name: string,
  position: Vector3,
  quaternion: readonly [number, number, number, number],
) => [
  new VectorKeyframeTrack(`.bones[${name}].position`, [0], position.toArray()),
  new QuaternionKeyframeTrack(`.bones[${name}].quaternion`, [0], quaternion),
];

export const createThreeMorphTrack = (index: number, weight: number) =>
  new NumberKeyframeTrack(`.morphTargetInfluences[${index}]`, [0], [weight]);

export const rendererModeIsThree = (
  mode: MmdRendererMode,
): mode is "vanilla" | "moeru" => mode !== "babylon";
