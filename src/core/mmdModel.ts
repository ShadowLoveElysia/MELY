import {
  BufferGeometry,
  Skeleton,
  Texture,
  type Color,
  type Group,
  type Material,
  type SkinnedMesh,
} from "three";
import type { ThreeMmdModel } from "@yohawing/three-mmd-loader";
import type { MmdAnimation, VmdMorphTrack } from "@yohawing/three-mmd-loader/parser";
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
import { createMmdPoseController, type MmdPoseController } from "./mmdPose";
import {
  evaluateMmdPreviewFrame,
  inspectMmdPreviewRuntime,
  settleMmdPreviewFrame,
  syncMmdSkeletonForCpuRead,
  type PreviewRuntimeDiagnostics,
} from "./mmdPreviewRuntime";
import { createSwitchableMmdPhysicsBackend } from "./mmdPhysics";

export interface LoadedMmdModel {
  id: string;
  fileName: string;
  root: Group;
  mesh: SkinnedMesh;
  stats: MmdModelStats;
  previewRuntime: PreviewRuntimeDiagnostics;
  textureWarnings: readonly string[];
  bones: readonly MmdBoneInfo[];
  materials: readonly MmdMaterialInfo[];
  translationStep: number;
  physicsAvailable: boolean;
  physicsEnabled: () => boolean;
  setPhysicsEnabled: (enabled: boolean) => Promise<void>;
  loadMotion: (file: File, kind: MmdMotionTrackKind) => Promise<MmdMotionTrackInfo>;
  updatePreviewPose: (times: MmdMotionTimes) => MmdMotionTimes;
  updatePose: (times: MmdMotionTimes) => MmdMotionTimes;
  clearMotion: (kind?: MmdMotionTrackKind) => void;
  beginBoneEdit: (index: number) => void;
  updateBoneEdit: (index: number) => void;
  endBoneEdit: (index: number) => boolean;
  nudgeBone: (index: number, axis: "x" | "y" | "z", amount: number) => boolean;
  resetBone: (index: number) => boolean;
  undoPose: () => boolean;
  redoPose: () => boolean;
  resetPoseEdits: (recordHistory?: boolean) => boolean;
  exportMelyPose: () => MelyPoseDocument;
  importMelyPose: (document: MelyPoseDocument) => MelyPoseApplyResult;
  poseState: () => MmdPoseState;
  dispose: () => void;
}

type DisposeMmdModel = (
  model: ThreeMmdModel,
  options: { textures: "owned" },
) => void;

interface LoaderWithRetainedResources {
  textureCache?: Map<unknown, unknown>;
  options?: Record<string, unknown>;
}

const isSkinnedMesh = (value: unknown): value is SkinnedMesh => Boolean(
  value
  && typeof value === "object"
  && (value as { isSkinnedMesh?: boolean }).isSkinnedMesh,
);

const collectModelMeshes = (model: ThreeMmdModel) => {
  const meshes = new Set<SkinnedMesh>();
  model.root.traverse((object) => {
    if (isSkinnedMesh(object)) meshes.add(object);
  });
  meshes.add(model.mesh);
  model.outlineMeshes.forEach((mesh) => meshes.add(mesh));
  model.renderOrderMeshes.forEach((mesh) => meshes.add(mesh));
  const splitMeshes = model.mesh.userData.mmdMorphSplitBodyMeshes;
  if (Array.isArray(splitMeshes)) {
    splitMeshes.forEach((mesh) => {
      if (isSkinnedMesh(mesh)) meshes.add(mesh);
    });
  }
  return meshes;
};

const collectMaterialTextures = (material: Material) => {
  const textures = new Set<Texture>();
  const collectUniformTextures = (uniforms: unknown) => {
    if (!uniforms || typeof uniforms !== "object") return;
    Object.values(uniforms).forEach((uniform) => {
      const value = (uniform as { value?: unknown } | null)?.value;
      if (value instanceof Texture) textures.add(value);
    });
  };
  Object.values(material).forEach((value) => {
    if (value instanceof Texture) textures.add(value);
  });
  collectUniformTextures((material as Material & { uniforms?: unknown }).uniforms);
  Object.values(material.userData).forEach((value) => {
    if (value instanceof Texture) textures.add(value);
    collectUniformTextures((value as { uniforms?: unknown } | null)?.uniforms);
  });
  return textures;
};

const releaseDecodedImage = (value: unknown) => {
  if (typeof ImageBitmap !== "undefined" && value instanceof ImageBitmap) {
    value.close();
    return true;
  }
  if (typeof VideoFrame !== "undefined" && value instanceof VideoFrame) {
    value.close();
    return true;
  }
  if (typeof HTMLImageElement !== "undefined" && value instanceof HTMLImageElement) {
    value.onload = null;
    value.onerror = null;
    value.removeAttribute("src");
    value.removeAttribute("srcset");
    return true;
  }
  if (typeof HTMLCanvasElement !== "undefined" && value instanceof HTMLCanvasElement) {
    value.width = 0;
    value.height = 0;
    return true;
  }
  if (typeof OffscreenCanvas !== "undefined" && value instanceof OffscreenCanvas) {
    value.width = 0;
    value.height = 0;
    return true;
  }
  return false;
};

export const releaseOwnedMmdTextureSources = (textures: Iterable<Texture>) => {
  const releasedSources = new Set<unknown>();
  for (const texture of textures) {
    if (
      texture.userData.mmdTextureOwnership !== "loader"
      || texture.userData.mmdFallbackToonGradient === true
    ) {
      continue;
    }
    texture.dispose();
    const source = texture.source.data;
    if (source && !releasedSources.has(source)) {
      if (Array.isArray(source)) {
        source.forEach((entry) => releaseDecodedImage(entry));
      } else {
        releaseDecodedImage(source);
      }
      releasedSources.add(source);
    }
    texture.source.data = null;
    texture.mipmaps.length = 0;
  }
};

const clearUniformTextureReferences = (uniforms: unknown) => {
  if (!uniforms || typeof uniforms !== "object") return;
  Object.values(uniforms).forEach((uniform) => {
    if ((uniform as { value?: unknown } | null)?.value instanceof Texture) {
      (uniform as { value: unknown }).value = null;
    }
  });
};

export const releaseMmdLoaderReferences = (loader: unknown) => {
  const retained = loader as LoaderWithRetainedResources;
  retained.textureCache?.clear();
  if (!retained.options) return;
  delete retained.options.textureMap;
  delete retained.options.textureResolver;
  delete retained.options.textureLoader;
  delete retained.options.ddsLoader;
};

export const disposeMmdModelResources = (
  model: ThreeMmdModel,
  disposeMmdModel: DisposeMmdModel,
) => {
  const meshes = collectModelMeshes(model);
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  meshes.forEach((mesh) => {
    const meshMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    meshMaterials.forEach((material) => materials.add(material));
    if (mesh.customDepthMaterial) materials.add(mesh.customDepthMaterial);
    if (mesh.customDistanceMaterial) materials.add(mesh.customDistanceMaterial);
  });
  materials.forEach((material) => {
    collectMaterialTextures(material).forEach((texture) => textures.add(texture));
  });

  disposeMmdModel(model, { textures: "owned" });
  releaseOwnedMmdTextureSources(textures);

  materials.forEach((material) => {
    Object.entries(material).forEach(([key, value]) => {
      if (value instanceof Texture) {
        (material as unknown as Record<string, unknown>)[key] = null;
      }
    });
    clearUniformTextureReferences((material as Material & { uniforms?: unknown }).uniforms);
    Object.values(material.userData).forEach((value) => {
      clearUniformTextureReferences((value as { uniforms?: unknown } | null)?.uniforms);
    });
    material.userData = {};
  });
  meshes.forEach((mesh) => {
    mesh.clear();
    mesh.geometry = new BufferGeometry();
    mesh.material = [];
    mesh.customDepthMaterial = undefined;
    mesh.customDistanceMaterial = undefined;
    mesh.skeleton = new Skeleton();
    mesh.morphTargetDictionary = {};
    mesh.morphTargetInfluences = [];
    mesh.userData = {};
  });
  model.root.clear();
};

export const MMD_MODEL_LOAD_OPTIONS = {
  outline: false,
  materialRenderOrder: false,
  morphSplit: true,
  morphAttributes: true,
  frustumCulled: false,
} as const;

const materialCount = (mesh: SkinnedMesh) =>
  Array.isArray(mesh.material) ? mesh.material.length : 1;

const materialList = (mesh: SkinnedMesh) =>
  (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as Material[];

interface ExpressionTrackState {
  animation: MmdAnimation;
  bindings: readonly {
    name: string;
    source: VmdMorphTrack;
    sampled: VmdMorphTrack;
  }[];
  morphTracks: Record<string, VmdMorphTrack>;
}

const maxPackedTrackFrame = (
  tracks: readonly { frames: Uint32Array }[],
) => tracks.reduce((maximum, track) => (
  Math.max(maximum, track.frames[track.frames.length - 1] ?? 0)
), 0);

const sampleMorphTrack = (track: VmdMorphTrack, frame: number) => {
  const frames = track.frames;
  if (frames.length === 0) return 0;
  if (frame <= (frames[0] ?? 0)) return track.weights[0] ?? 0;
  let low = 1;
  let high = frames.length - 1;
  let nextIndex = frames.length;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (frame < (frames[middle] ?? Number.POSITIVE_INFINITY)) {
      nextIndex = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  if (nextIndex >= frames.length) return track.weights[frames.length - 1] ?? 0;
  const previousIndex = nextIndex - 1;
  const previousFrame = frames[previousIndex] ?? 0;
  const nextFrame = frames[nextIndex] ?? previousFrame;
  const ratio = nextFrame === previousFrame ? 0 : (frame - previousFrame) / (nextFrame - previousFrame);
  const previousWeight = track.weights[previousIndex] ?? 0;
  return previousWeight + ((track.weights[nextIndex] ?? previousWeight) - previousWeight) * ratio;
};

const expressionBindings = (
  mesh: SkinnedMesh,
  animation: MmdAnimation,
) => {
  const names = new Set(Object.keys(mesh.morphTargetDictionary ?? {}));
  const runtimeMorphs = mesh.userData.mmdMorphs;
  if (Array.isArray(runtimeMorphs)) {
    runtimeMorphs.forEach((morph) => {
      if (!morph || typeof morph !== "object") return;
      const name = (morph as { name?: unknown }).name;
      const englishName = (morph as { englishName?: unknown }).englishName;
      if (typeof name === "string" && name) names.add(name);
      if (typeof englishName === "string" && englishName) names.add(englishName);
    });
  }
  return Object.entries(animation.morphTracks).flatMap(([name, source]) => {
    if (!names.has(name)) return [];
    const sampled: VmdMorphTrack = {
      packed: "morph",
      frames: new Uint32Array([0]),
      weights: new Float32Array([0]),
    };
    return [{ name, source, sampled }];
  });
};

const sampleExpressionTrack = (
  state: ExpressionTrackState | null,
  frame: number,
) => {
  state?.bindings.forEach(({ source, sampled }) => {
    sampled.weights[0] = sampleMorphTrack(source, frame);
  });
};

const combinedMotionAnimation = (
  dance: MmdAnimation | null,
  expression: ExpressionTrackState | null,
  importedPose: MmdAnimation | null,
): MmdAnimation | null => {
  const source = dance ?? expression?.animation ?? importedPose;
  if (!source) return null;
  const boneTracks = dance?.boneTracks ?? importedPose?.boneTracks ?? {};
  const morphTracks = expression?.morphTracks ?? importedPose?.morphTracks ?? {};
  return {
    ...source,
    bytes: new Uint8Array(),
    metadata: {
      ...source.metadata,
      counts: {
        ...source.metadata.counts,
        bones: Object.keys(boneTracks).length,
        morphs: Object.keys(morphTracks).length,
        cameras: 0,
        lights: 0,
        selfShadows: 0,
      },
      maxFrame: maxPackedTrackFrame(Object.values(boneTracks)),
    },
    boneTracks,
    morphTracks,
    cameraFrames: [],
    lightFrames: [],
    selfShadowFrames: [],
    propertyFrames: dance?.propertyFrames ?? [],
  };
};

const createEmptyRuntimeAnimation = (modelName: string): MmdAnimation => ({
  kind: "vmd",
  bytes: new Uint8Array(),
  metadata: {
    modelName,
    counts: {
      bones: 0,
      morphs: 0,
      cameras: 0,
      lights: 0,
      selfShadows: 0,
      properties: 0,
    },
    maxFrame: 0,
  },
  boneTracks: {},
  morphTracks: {},
  cameraFrames: [],
  lightFrames: [],
  selfShadowFrames: [],
  propertyFrames: [],
});

const SKIN_KEYWORDS = [
  "皮肤",
  "皮膚",
  "肌肤",
  "肌膚",
  "脸",
  "臉",
  "顔",
  "肌",
  "素体",
  "素體",
  "身体",
  "身體",
  "人体",
  "人體",
  "头部",
  "頭部",
  "裸足",
] as const;

const FACIAL_FEATURE_KEYWORDS = [
  "眼睛",
  "眼白",
  "眼球",
  "眼珠",
  "瞳孔",
  "虹膜",
  "瞳",
  "黑目",
  "白目",
  "目玉",
  "右目",
  "左目",
  "両目",
  "眉毛",
  "眉",
  "まゆ",
  "睫毛",
  "まつげ",
  "眼线",
  "眼線",
  "口腔",
  "口内",
  "口中",
  "嘴唇",
  "嘴",
  "唇",
  "口紅",
  "牙齿",
  "牙齒",
  "歯",
  "舌头",
  "舌頭",
  "舌",
  "表情",
  "腮红",
  "腮紅",
  "化粧",
] as const;

const FACIAL_FEATURE_EXACT_LABELS = ["目", "口"] as const;

const NON_SKIN_KEYWORDS = [
  "肌着",
  "头发",
  "頭髮",
  "髪",
  "发饰",
  "髪飾",
  "服装",
  "服裝",
  "衣装",
  "衣服",
  "裙",
  "鞋",
  "靴",
  "袜",
  "襪",
  "手套",
  "饰品",
  "飾品",
  "配件",
  "装饰",
  "裝飾",
] as const;

const LATIN_SKIN_PATTERN = /(?:^|[^a-z])(?:face|skin|body|head)(?:[^a-z]|$)/;
const LATIN_FEATURE_PATTERN = /(?:^|[^a-z])(?:eyes?|eyeballs?|eye[\s_-]*whites?|eyewhites?|irises?|pupils?|sclera|brows?|eyebrows?|eyelashes?|lashes?|mouth|oral|teeth|tooth|tongues?|lips?|expressions?|make[\s_-]*up|makeup|blush|freckles?)(?:[^a-z]|$)/;
const LATIN_NON_SKIN_PATTERN = /(?:^|[^a-z])(?:hair|wig|headwear|hats?|clothes?|clothing|costumes?|suits?|dresses?|skirts?|shirts?|coats?|jackets?|pants|trousers?|shoes?|boots?|stockings?|socks?|gloves?|sleeves?|accessories|ornaments?|ribbons?|bows?)(?:[^a-z]|$)/;
const EMISSIVE_KEYWORDS = [
  "自发光",
  "自發光",
  "发光",
  "發光",
  "荧光",
  "螢光",
  "辉光",
  "輝光",
  "光源",
  "灯笼",
  "燈籠",
  "霓虹",
  "発光",
  "蛍光",
  "ライト",
  "ランプ",
  "提灯",
] as const;
const LATIN_EMISSIVE_PATTERN = /(?:^|[^a-z])(?:emissive|glow(?:ing)?|luminous|luminescent|neon|light|lamp|lantern)(?:[^a-z]|$)/;

const normalizeMaterialLabel = (value: string) => value
  .normalize("NFKC")
  .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
  .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
  .toLowerCase();

export const isSuggestedSkinMaterial = (name: string, englishName: string) => {
  const labels = [name, englishName]
    .map(normalizeMaterialLabel)
    .filter(Boolean);
  const normalized = labels.join(" ");

  // Feature and clothing labels take precedence over broad names such as "face" or "body".
  if (
    labels.some((label) => FACIAL_FEATURE_EXACT_LABELS.some((feature) => label === feature))
    || FACIAL_FEATURE_KEYWORDS.some((keyword) => normalized.includes(keyword))
    || NON_SKIN_KEYWORDS.some((keyword) => normalized.includes(keyword))
    || LATIN_FEATURE_PATTERN.test(normalized)
    || LATIN_NON_SKIN_PATTERN.test(normalized)
  ) {
    return false;
  }

  return SKIN_KEYWORDS.some((keyword) => normalized.includes(keyword))
    || LATIN_SKIN_PATTERN.test(normalized);
};

export const isSuggestedEmissiveMaterial = (
  name: string,
  englishName: string,
  emissive?: readonly number[],
) => {
  const explicitStrength = emissive?.slice(0, 3)
    .reduce((sum, value) => sum + Math.max(0, value), 0) ?? 0;
  if (explicitStrength / 3 >= 0.35) return true;
  const normalized = [name, englishName]
    .map(normalizeMaterialLabel)
    .filter(Boolean)
    .join(" ");
  return EMISSIVE_KEYWORDS.some((keyword) => normalized.includes(keyword))
    || LATIN_EMISSIVE_PATTERN.test(normalized);
};

const colorTuple = (material: Material): [number, number, number] => {
  const metadata = material.userData.mmdMaterial as { diffuse?: number[] } | undefined;
  const state = material.userData.mmdMaterialState as { diffuse?: number[] } | undefined;
  const diffuse = state?.diffuse ?? metadata?.diffuse;
  if (diffuse && diffuse.length >= 3) return [diffuse[0], diffuse[1], diffuse[2]];
  const color = (material as Material & { color?: Color }).color;
  if (!color) return [1, 1, 1];
  const srgb = color.clone().convertLinearToSRGB();
  return [srgb.r, srgb.g, srgb.b];
};

const ambientTuple = (material: Material): [number, number, number] => {
  const metadata = material.userData.mmdMaterial as { ambient?: number[] } | undefined;
  const state = material.userData.mmdMaterialState as { ambient?: number[] } | undefined;
  const ambient = state?.ambient ?? metadata?.ambient;
  return ambient && ambient.length >= 3
    ? [ambient[0], ambient[1], ambient[2]]
    : [0, 0, 0];
};

const collectMaterialInfo = (mesh: SkinnedMesh): MmdMaterialInfo[] =>
  materialList(mesh).map((material, index) => {
    const metadata = material.userData.mmdMaterial as {
      name?: string;
      englishName?: string;
      diffuse?: number[];
      emissive?: number[];
    } | undefined;
    const state = material.userData.mmdMaterialState as {
      diffuse?: number[];
      emissive?: number[];
    } | undefined;
    const name = metadata?.name || material.name || "";
    const englishName = metadata?.englishName || "";
    const color = colorTuple(material);
    const opacity = state?.diffuse?.[3] ?? metadata?.diffuse?.[3] ?? material.opacity;
    const ambient = ambientTuple(material);
    return {
      index,
      name,
      englishName,
      displayName: englishName || name,
      color,
      opacity,
      hasTexture: "map" in material && Boolean(material.map),
      suggestedSkin: isSuggestedSkinMaterial(name, englishName),
      ambient,
      suggestedEmissive: isSuggestedEmissiveMaterial(
        name,
        englishName,
        state?.emissive ?? metadata?.emissive,
      ),
    };
  });

export const loadMmdModel = async (
  files: readonly File[],
  modelFile: File,
): Promise<LoadedMmdModel> => {
  const {
    ThreeMmdLoader,
    createMmdTextureMapFromFiles,
    disposeMmdModel,
  } = await import("@yohawing/three-mmd-loader");

  const loader = new ThreeMmdLoader({
    textureMap: createMmdTextureMapFromFiles(files, modelFile),
    geometryAwareAlpha: true,
    runtime: {
      physics: "external",
      physicsBackend: createSwitchableMmdPhysicsBackend(),
    },
  });
  let model: ThreeMmdModel;
  try {
    model = await loader.loadModel(modelFile, MMD_MODEL_LOAD_OPTIONS);
  } finally {
    releaseMmdLoaderReferences(loader);
  }
  evaluateMmdPreviewFrame(model, 0);
  syncMmdSkeletonForCpuRead(model);

  const position = model.mesh.geometry.getAttribute("position");
  const index = model.mesh.geometry.getIndex();
  const metadata = model.mesh.userData.mmdModel as {
    format?: "pmx" | "pmd";
    name?: string;
    englishName?: string;
    rigidBodyCount?: number;
    jointCount?: number;
  } | undefined;
  const morphs = model.mesh.userData.mmdMorphs;
  const textureWarnings = model.diagnostics.textures.map((diagnostic) =>
    `${diagnostic.textureKind}: ${diagnostic.path}`,
  );
  let activeModel: ThreeMmdModel | null = model;
  let pose: MmdPoseController | null = createMmdPoseController(model.mesh);
  const bones = pose.bones;
  const translationStep = pose.translationStep;
  const motionInfo: Record<MmdMotionTrackKind, MmdMotionTrackInfo | null> = {
    dance: null,
    expression: null,
  };
  let danceAnimation: MmdAnimation | null = null;
  let expressionTrack: ExpressionTrackState | null = null;
  let importedPoseAnimation: MmdAnimation | null = null;
  const physics = (loader.options.runtime?.physicsBackend ?? null) as ReturnType<
    typeof createSwitchableMmdPhysicsBackend
  > | null;
  const physicsAvailable = (metadata?.rigidBodyCount ?? 0) > 0;
  const emptyRuntimeAnimation = createEmptyRuntimeAnimation(
    metadata?.englishName || metadata?.name || modelFile.name,
  );
  model.setAnimation(emptyRuntimeAnimation);
  evaluateMmdPreviewFrame(model, 0);

  const currentModel = () => {
    if (!activeModel) throw new Error("MMD model has been disposed");
    return activeModel;
  };
  const currentPose = () => {
    if (!pose) throw new Error("MMD model has been disposed");
    return pose;
  };
  const installCurrentAnimation = (target: ThreeMmdModel) => {
    const animation = combinedMotionAnimation(
      danceAnimation,
      expressionTrack,
      importedPoseAnimation,
    );
    target.runtime.resetPose();
    target.setAnimation(animation ?? emptyRuntimeAnimation);
    return evaluateMmdPreviewFrame(target, 0);
  };

  return {
    id: crypto.randomUUID(),
    fileName: modelFile.name,
    root: model.root,
    mesh: model.mesh,
    bones,
    materials: collectMaterialInfo(model.mesh),
    translationStep,
    physicsAvailable,
    physicsEnabled: () => Boolean(physicsAvailable && physics?.enabled),
    setPhysicsEnabled: async (enabled) => {
      if (!physics || !physicsAvailable) return;
      try {
        await physics.setEnabled(enabled);
      } catch (error) {
        throw appError("error.physics.loadFailed", undefined, error);
      }
    },
    textureWarnings,
    stats: {
      name: metadata?.englishName || metadata?.name || modelFile.name.replace(/\.[^.]+$/, ""),
      format: metadata?.format ?? (modelFile.name.toLowerCase().endsWith(".pmd") ? "pmd" : "pmx"),
      vertexCount: position?.count ?? 0,
      triangleCount: index ? index.count / 3 : Math.floor((position?.count ?? 0) / 3),
      materialCount: materialCount(model.mesh),
      boneCount: model.mesh.skeleton.bones.length,
      morphCount: Array.isArray(morphs) ? morphs.length : Object.keys(model.mesh.morphTargetDictionary ?? {}).length,
      rigidBodyCount: metadata?.rigidBodyCount ?? 0,
      jointCount: metadata?.jointCount ?? 0,
      textureWarnings: textureWarnings.length,
    },
    previewRuntime: inspectMmdPreviewRuntime(model.root),
    loadMotion: async (file, kind) => {
      const target = currentModel();
      const motionLoader = new ThreeMmdLoader();
      let motion;
      try {
        motion = await motionLoader.loadAnimation(file);
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw appError("error.motion.loadFailed", undefined, error);
      } finally {
        releaseMmdLoaderReferences(motionLoader);
      }
      if (activeModel !== target) throw new Error("MMD model was disposed while loading motion");
      const boneNames = new Set<string>();
      target.mesh.skeleton.bones.forEach((bone) => {
        if (bone.name) boneNames.add(bone.name);
        const mmdName = bone.userData.mmdBoneName;
        const englishName = bone.userData.mmdEnglishBoneName;
        if (typeof mmdName === "string" && mmdName) boneNames.add(mmdName);
        if (typeof englishName === "string" && englishName) boneNames.add(englishName);
      });
      const morphNames = new Set(Object.keys(target.mesh.morphTargetDictionary ?? {}));
      const runtimeMorphs = target.mesh.userData.mmdMorphs;
      if (Array.isArray(runtimeMorphs)) {
        runtimeMorphs.forEach((morph) => {
          if (!morph || typeof morph !== "object") return;
          const name = (morph as { name?: unknown }).name;
          const englishName = (morph as { englishName?: unknown }).englishName;
          if (typeof name === "string" && name) morphNames.add(name);
          if (typeof englishName === "string" && englishName) morphNames.add(englishName);
        });
      }
      const motionBoneNames = Object.keys(motion.animation.boneTracks);
      const motionMorphNames = Object.keys(motion.animation.morphTracks);
      const matchedBoneTrackCount = motionBoneNames.filter((name) => boneNames.has(name)).length;
      const matchedMorphTrackCount = motionMorphNames.filter((name) => morphNames.has(name)).length;
      const matchedTrackCount = kind === "dance" ? matchedBoneTrackCount : matchedMorphTrackCount;
      if (matchedTrackCount === 0) {
        throw appError("error.motion.noCompatibleTracks");
      }
      if (kind === "dance") {
        danceAnimation = motion.animation;
      } else {
        const bindings = expressionBindings(target.mesh, motion.animation);
        expressionTrack = {
          animation: motion.animation,
          bindings,
          morphTracks: Object.fromEntries(bindings.map(({ name, sampled }) => [name, sampled])),
        };
      }
      sampleExpressionTrack(expressionTrack, 0);
      const frameState = installCurrentAnimation(target);
      syncMmdSkeletonForCpuRead(target);
      currentPose().syncAfterRuntimeUpdate();
      const maxFrame = kind === "dance"
        ? maxPackedTrackFrame(Object.values(motion.animation.boneTracks))
        : maxPackedTrackFrame(Object.values(motion.animation.morphTracks));
      const loadedInfo: MmdMotionTrackInfo = {
        kind,
        name: file.name.replace(/\.[^.]+$/, ""),
        modelName: motion.animation.metadata.modelName,
        maxFrame,
        frameRate: frameState.frameRate,
        durationSeconds: maxFrame / frameState.frameRate,
        boneTrackCount: motionBoneNames.length,
        morphTrackCount: motionMorphNames.length,
        matchedBoneTrackCount,
        matchedMorphTrackCount,
      };
      motionInfo[kind] = loadedInfo;
      return loadedInfo;
    },
    updatePreviewPose: (times) => {
      const target = currentModel();
      const danceDuration = motionInfo.dance?.durationSeconds ?? 0;
      const expressionDuration = motionInfo.expression?.durationSeconds ?? 0;
      const dance = danceDuration > 0 ? Math.max(0, Math.min(danceDuration, times.dance)) : 0;
      const expression = expressionDuration > 0
        ? Math.max(0, Math.min(expressionDuration, times.expression))
        : 0;
      sampleExpressionTrack(expressionTrack, expression * (motionInfo.expression?.frameRate ?? 30));
      evaluateMmdPreviewFrame(target, dance, Boolean(physics?.enabled));
      currentPose().syncAfterRuntimePreview();
      return { dance, expression };
    },
    updatePose: (times) => {
      const target = currentModel();
      const danceDuration = motionInfo.dance?.durationSeconds ?? 0;
      const expressionDuration = motionInfo.expression?.durationSeconds ?? 0;
      const dance = danceDuration > 0 ? Math.max(0, Math.min(danceDuration, times.dance)) : 0;
      const expression = expressionDuration > 0
        ? Math.max(0, Math.min(expressionDuration, times.expression))
        : 0;
      sampleExpressionTrack(expressionTrack, expression * (motionInfo.expression?.frameRate ?? 30));
      if (physics?.enabled) settleMmdPreviewFrame(target, dance, physics);
      else evaluateMmdPreviewFrame(target, dance);
      currentPose().syncAfterRuntimeUpdate();
      syncMmdSkeletonForCpuRead(target);
      return { dance, expression };
    },
    clearMotion: (kind) => {
      const target = currentModel();
      if (!kind || kind === "dance") {
        motionInfo.dance = null;
        danceAnimation = null;
      }
      if (!kind || kind === "expression") {
        motionInfo.expression = null;
        expressionTrack = null;
      }
      installCurrentAnimation(target);
      syncMmdSkeletonForCpuRead(target);
      currentPose().syncAfterRuntimeUpdate();
    },
    beginBoneEdit: (index) => currentPose().beginBoneEdit(index),
    updateBoneEdit: (index) => currentPose().updateBoneEdit(index),
    endBoneEdit: (index) => currentPose().endBoneEdit(index),
    nudgeBone: (index, axis, amount) => currentPose().nudgeBone(index, axis, amount),
    resetBone: (index) => currentPose().resetBone(index),
    undoPose: () => currentPose().undo(),
    redoPose: () => currentPose().redo(),
    resetPoseEdits: (recordHistory) => currentPose().reset(recordHistory),
    exportMelyPose: () => currentPose().exportMelyPose(),
    importMelyPose: (document) => {
      const target = currentModel();
      const applied = currentPose().importMelyPose(document);
      importedPoseAnimation = currentPose().importedPoseAnimation();
      installCurrentAnimation(target);
      currentPose().syncAfterRuntimeUpdate();
      syncMmdSkeletonForCpuRead(target);
      return applied;
    },
    poseState: () => currentPose().state(),
    dispose: () => {
      if (!activeModel) return;
      const disposedModel = activeModel;
      activeModel = null;
      motionInfo.dance = null;
      motionInfo.expression = null;
      danceAnimation = null;
      expressionTrack = null;
      importedPoseAnimation = null;
      pose = null;
      physics?.dispose?.();
      disposeMmdModelResources(disposedModel, disposeMmdModel);
    },
  };
};
