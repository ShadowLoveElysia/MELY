import {
  ArcRotateCamera,
  Color3,
  Color4,
  DirectionalLight,
  Engine,
  GetTextureDataAsync,
  HemisphericLight,
  Matrix,
  Mesh,
  Quaternion,
  Scene,
  Vector3,
  VertexBuffer,
  type AbstractMesh,
  type AssetContainer,
  type BaseTexture,
  type Bone,
  type Material,
  type MorphTargetManager,
  type Skeleton,
} from "@babylonjs/core";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import {
  Box3,
  ClampToEdgeWrapping,
  MirroredRepeatWrapping,
  RepeatWrapping,
  Vector3 as ThreeVector3,
} from "three";
import {
  GetMmdWasmInstance,
  MmdAnimation,
  MmdBufferKind,
  MmdModelAnimationContainer,
  MmdStandardMaterialProxy,
  MmdStandardMaterialBuilder,
  MmdWasmPhysics,
  MmdWasmRuntime,
  SdefInjector,
  VmdLoader,
  type IMmdRuntimeModelAnimation,
  type MmdAnimationBase,
  type MmdMorphAnimationTrack,
  type MmdMovableBoneAnimationTrack,
  type MmdBoneAnimationTrack,
  type MmdWasmModel,
  type MmdWasmRuntime as MmdWasmRuntimeType,
} from "babylon-mmd";
import * as MmdWasmSpr from "babylon-mmd/esm/Runtime/Optimized/wasm/spr";
import mmdWasmSprUrl from "babylon-mmd/esm/Runtime/Optimized/wasm/spr/index_bg.wasm?url";
import type {
  MelyPoseApplyResult,
  MelyPoseDocument,
  MmdBoneInfo,
  MmdMaterialInfo,
  MmdMeshSnapshot,
  MmdModelStats,
  MmdMotionTimes,
  MmdMotionTrackInfo,
  MmdMotionTrackKind,
  MmdPoseState,
  MeshMaterialSnapshot,
  MeshTextureSnapshot,
} from "../types";
import { appError } from "./appError";
import type {
  BabylonMmdViewportSource,
  LoadedMmdModel,
  MmdPoseTransferState,
  MmdSnapshotOptions,
} from "./mmdRuntime";
import { normalizeMelyBoneName } from "./melyPose";
import {
  babylonToThreePosition,
  reflectMmdQuaternionZ,
  threeToBabylonPosition,
} from "./mmdCoordinates";
import { createBabylonMmdReferenceFiles } from "./babylonMmdResources";
import { builtinToonFile } from "./mmdBuiltinToon";
import { applyBabylonCameraPanningProfile } from "./babylonCameraControls";
import { isSuggestedEmissiveMaterial, isSuggestedSkinMaterial } from "./mmdModel";
import { MMD_PREVIEW_VERTICAL_FOV_RADIANS } from "./perspectiveFraming";
import { createRetryableAsyncSingleton } from "./retryableAsyncSingleton";
import {
  createBabylonMaterialIndexResolver,
  createBabylonMaterialVisibilityController,
  createBabylonVisibilityMaterialProxy,
  resolveCanonicalBabylonMaterials,
  type BabylonMaterialVisibilityController,
} from "./babylonMaterialVisibility";

type BabylonModel = MmdWasmModel;

const getBabylonMmdWasmInstance = createRetryableAsyncSingleton(() => {
  // A fresh binding key lets babylon-mmd retry after its WeakMap cached a failed attempt.
  const wasmBinding = {
    ...MmdWasmSpr,
    default: () => MmdWasmSpr.default(mmdWasmSprUrl),
  };
  return GetMmdWasmInstance({
    getWasmInstanceInner: () => wasmBinding,
  });
});
type BabylonRuntime = MmdWasmRuntimeType;
type RuntimeAnimation = IMmdRuntimeModelAnimation & {
  animation: MmdAnimationBase;
  wasmAnimate?: (frameTime: number) => void;
};

const BABYLON_PHYSICS_FIXED_STEP = 1 / 120;
const BABYLON_PHYSICS_SETTLE_STEPS = 120;

interface MutablePhysicsClock {
  deltaSeconds: number;
  getDeltaTime: () => number;
}

/**
 * babylon-mmd normally derives its physics delta from Engine.getDeltaTime().
 * The application evaluates poses explicitly, so a mutable clock keeps live
 * evaluation and deterministic snapshot settling on the same runtime without
 * mutating Babylon's private engine timing fields.
 */
class ApplicationMmdWasmPhysics extends MmdWasmPhysics {
  public constructor(scene: Scene, private readonly clock: MutablePhysicsClock) {
    super(scene);
  }

  public override createPhysicsClock() {
    return this.clock;
  }
}

interface BabylonBoneState {
  position: Vector3;
  rotation: Quaternion;
}

interface BabylonOffset {
  position: Vector3;
  rotation: Quaternion;
}

interface BabylonMotionState {
  info: MmdMotionTrackInfo | null;
  animation: MmdAnimation | null;
  danceHandle: ReturnType<BabylonModel["createRuntimeAnimation"]> | null;
  expressionTracks: readonly MmdMorphAnimationTrack[];
}

const emptyMotion = (): BabylonMotionState => ({
  info: null,
  animation: null,
  danceHandle: null,
  expressionTracks: [],
});

class DiagnosticMmdMaterialBuilder extends MmdStandardMaterialBuilder {
  public constructor(private readonly warnings: string[]) {
    super();
  }

  private warn(kind: string, path: string) {
    const warning = `${kind}: ${path}`;
    if (!this.warnings.includes(warning)) this.warnings.push(warning);
  }

  public override async loadDiffuseTexture(
    ...args: Parameters<MmdStandardMaterialBuilder["loadDiffuseTexture"]>
  ) {
    await super.loadDiffuseTexture(...args);
    const [, material, , imagePathTable, textureInfo] = args;
    const path = imagePathTable[textureInfo?.imagePathIndex ?? -1];
    if (path !== undefined && (!material.diffuseTexture || material.diffuseTexture.loadingError)) {
      this.warn("diffuse", path);
    }
  }

  public override async loadSphereTexture(
    ...args: Parameters<MmdStandardMaterialBuilder["loadSphereTexture"]>
  ) {
    await super.loadSphereTexture(...args);
    const [, material, materialInfo, imagePathTable, textureInfo] = args;
    const path = imagePathTable[textureInfo?.imagePathIndex ?? -1];
    if (
      materialInfo.sphereTextureMode !== 0
      && path !== undefined
      && (!material.sphereTexture || material.sphereTexture.loadingError)
    ) this.warn("sphere", path);
  }

  public override async loadToonTexture(
    ...args: Parameters<MmdStandardMaterialBuilder["loadToonTexture"]>
  ) {
    const [, , materialInfo, imagePathTable, textureInfo, , , , referenceFileResolver] = args;
    const path = imagePathTable[textureInfo?.imagePathIndex ?? -1];
    const resolved = path === undefined
      ? undefined
      : referenceFileResolver.resolve(referenceFileResolver.createFullPath(path));
    const effectiveArgs = resolved || path === undefined || materialInfo.isSharedToonTexture
      ? args
      : [
        args[0], args[1], args[2],
        Object.assign([...imagePathTable], {
          [textureInfo?.imagePathIndex ?? -1]: `toon/${builtinToonFile(path).name}`,
        }),
        args[4], args[5], args[6], args[7], args[8], args[9], args[10],
      ] as Parameters<MmdStandardMaterialBuilder["loadToonTexture"]>;
    await super.loadToonTexture(...effectiveArgs);
    const [, material, effectiveMaterialInfo] = effectiveArgs;
    if (
      !effectiveMaterialInfo.isSharedToonTexture
      && path !== undefined
      && (!material.toonTexture || material.toonTexture.loadingError)
    ) this.warn("toon", path);
  }
}

/**
 * Evaluate a bound Babylon animation at an explicit MMD frame. The normal
 * For WASM-backed animations, `wasmAnimate` must run before `animate`, matching
 * babylon-mmd's seek/runtime path: the WASM pass updates bone/IK state first,
 * then the JS pass updates morphs, materials and visibility. Keeping that order
 * makes manual seeking and snapshot generation consistent with scene-driven
 * playback.
 */
const evaluateRuntimeAnimation = (animation: RuntimeAnimation | undefined, frameTime: number) => {
  if (!animation) return;
  animation.wasmAnimate?.(frameTime);
  animation.animate(frameTime);
};

const asBabylonMesh = (value: AbstractMesh): Mesh => value as Mesh;

const materialSubMaterials = (value: unknown): Material[] => {
  if (!value || typeof value !== "object") return [];
  const subMaterials = (value as { subMaterials?: readonly (Material | null)[] }).subMaterials;
  return Array.isArray(subMaterials)
    ? subMaterials.filter((material): material is Material => Boolean(material))
    : [];
};

const materialArray = (mesh: AbstractMesh): Material[] => {
  const value = mesh.material;
  if (!value) return [];
  if (Array.isArray(value)) return value.filter((material): material is Material => Boolean(material));
  const subMaterials = materialSubMaterials(value);
  return subMaterials.length ? subMaterials : [value];
};

/** Resolve a Babylon sub-mesh material slot to the canonical MMD material list. */
const materialIndexForSubMesh = (
  mesh: AbstractMesh,
  subMeshMaterialIndex: number,
  materials: readonly Material[],
) : number | null => {
  if (!Number.isSafeInteger(subMeshMaterialIndex) || subMeshMaterialIndex < 0) return null;
  const value = mesh.material;
  const slots = Array.isArray(value)
    ? value
    : (value as { subMaterials?: readonly (Material | null)[] } | null)?.subMaterials ?? [];
  const candidate = slots.length
    ? slots[subMeshMaterialIndex] ?? null
    : subMeshMaterialIndex === 0 && value && !Array.isArray(value)
      ? value as Material
      : null;
  const identityIndex = candidate ? materials.indexOf(candidate) : -1;
  return identityIndex >= 0 ? identityIndex : null;
};

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const component = (data: Float32Array | Uint32Array | Uint8Array, index: number, offset: number) => (
  Number(data[index * 4 + offset] ?? 0)
);

const normalizeMmdName = (value: string) => normalizeMelyBoneName(value);

/** Convert Babylon address modes to the Three.js constants consumed by the voxelizer. */
const toThreeWrapMode = (value: number | undefined) => {
  switch (value) {
    case 1:
      return RepeatWrapping;
    case 2:
      return MirroredRepeatWrapping;
    case 0:
    default:
      return ClampToEdgeWrapping;
  }
};

const boneControlMode = (name: string, englishName: string): "rotate" | "translate" => {
  const names = [name, englishName].map(normalizeMmdName);
  return names.some((value) => ["root", "master", "center", "groove", "allparent", "全ての親", "全親", "センター", "グルーブ"].includes(value))
    ? "translate"
    : "rotate";
};

const capturePoseDocument = (
  bones: readonly MmdBoneInfo[],
  rest: readonly BabylonBoneState[],
  _current: readonly { position: Vector3; rotationQuaternion?: Quaternion | null }[],
  offsetsOnly: readonly [number, BabylonOffset][],
): MelyPoseDocument => ({
  generator: "MELY",
  version: "1.0",
  bones: offsetsOnly.map(([index, offset]) => ({
    name: bones[index]?.name ?? "",
    pos: babylonToThreePosition([offset.position.x, offset.position.y, offset.position.z]),
    rot: reflectMmdQuaternionZ([
      offset.rotation.x,
      offset.rotation.y,
      offset.rotation.z,
      offset.rotation.w,
    ]),
  })).filter((bone) => Boolean(bone.name)),
});

const clonePoseDocument = (value: MelyPoseDocument | null): MelyPoseDocument | null => value
  ? {
      generator: "MELY",
      version: "1.0",
      bones: value.bones.map((bone) => ({
        name: bone.name,
        pos: [...bone.pos] as [number, number, number],
        rot: [...bone.rot] as [number, number, number, number],
      })),
      ...(value.morphs?.length ? { morphs: value.morphs.map((morph) => ({ ...morph })) } : {}),
    }
  : null;

const cloneOffsets = (offsets: Map<number, BabylonOffset>) => new Map(
  [...offsets.entries()].map(([index, offset]) => [index, {
    position: offset.position.clone(),
    rotation: offset.rotation.clone(),
  }]),
);

const offsetsEqual = (left: Map<number, BabylonOffset>, right: Map<number, BabylonOffset>) => {
  if (left.size !== right.size) return false;
  const epsilon = 1e-6;
  for (const [index, value] of left) {
    const other = right.get(index);
    if (!other) return false;
    if (
      Math.abs(value.position.x - other.position.x) > epsilon
      || Math.abs(value.position.y - other.position.y) > epsilon
      || Math.abs(value.position.z - other.position.z) > epsilon
      || Math.abs(value.rotation.x - other.rotation.x) > epsilon
      || Math.abs(value.rotation.y - other.rotation.y) > epsilon
      || Math.abs(value.rotation.z - other.rotation.z) > epsilon
      || Math.abs(value.rotation.w - other.rotation.w) > epsilon
    ) return false;
  }
  return true;
};

const trackHasBone = (track: MmdBoneAnimationTrack | MmdMovableBoneAnimationTrack, names: Set<string>) => (
  names.has(normalizeMmdName(track.name))
);

const trackHasMorph = (track: MmdMorphAnimationTrack, names: Set<string>) => (
  names.has(normalizeMmdName(track.name))
);

/**
 * Build the name map expected by babylon-mmd's runtime binder.
 *
 * Bone retargeting is keyed by the model bone name and points to the animation
 * track name, while morph retargeting is keyed by the animation track name and
 * points to the model morph name. Keeping this distinction here prevents a
 * normalized compatibility match from being reported as matched while the
 * runtime binder silently fails its exact-name lookup.
 */
const createRuntimeRetargetingMap = (
  boneTracks: readonly (MmdBoneAnimationTrack | MmdMovableBoneAnimationTrack)[],
  propertyBoneNames: readonly string[],
  morphTracks: readonly MmdMorphAnimationTrack[],
  boneLookup: ReadonlyMap<string, number>,
  boneInfos: readonly MmdBoneInfo[],
  babylonBones: readonly Bone[],
  morphLookup: ReadonlyMap<string, readonly number[]>,
  runtimeMorphs: readonly { name: string }[],
) => {
  const retargetingMap: Record<string, string> = {};
  const addBoneAlias = (animationName: string) => {
    const index = boneLookup.get(normalizeMmdName(animationName));
    if (index === undefined) return;
    const modelName = babylonBones[index]?.name || boneInfos[index]?.name;
    if (!modelName || modelName === animationName || retargetingMap[modelName] !== undefined) return;
    retargetingMap[modelName] = animationName;
  };
  boneTracks.forEach((track) => addBoneAlias(track.name));
  // Property tracks carry IK toggles by bone name and use the same exact-name
  // binding path as rotation/translation tracks inside babylon-mmd.
  propertyBoneNames.forEach(addBoneAlias);
  morphTracks.forEach((track) => {
    const indices = morphLookup.get(normalizeMmdName(track.name));
    const modelName = indices === undefined ? undefined : runtimeMorphs[indices[0] ?? -1]?.name;
    if (!modelName || modelName === track.name || retargetingMap[track.name] !== undefined) return;
    retargetingMap[track.name] = modelName;
  });
  return Object.keys(retargetingMap).length ? retargetingMap : undefined;
};

const sampleLinear = (frames: Uint32Array, values: Float32Array, frame: number, width: number) => {
  if (!frames.length) return 0;
  if (frame <= frames[0]) return values[0] ?? 0;
  const last = frames.length - 1;
  if (frame >= frames[last]) return values[last * width] ?? 0;
  let high = 1;
  while (high < frames.length && frame > frames[high]) high += 1;
  const low = Math.max(0, high - 1);
  const start = frames[low] ?? 0;
  const end = frames[high] ?? start;
  const ratio = end === start ? 0 : (frame - start) / (end - start);
  return (values[low * width] ?? 0) + ((values[high * width] ?? values[low * width] ?? 0) - (values[low * width] ?? 0)) * ratio;
};

const sampleMorph = (track: MmdMorphAnimationTrack, frame: number) => (
  sampleLinear(track.frameNumbers, track.weights, frame, 1)
);

const toMelyPosition = (x: number, y: number, z: number): [number, number, number] => [x, y, -z];

const textureSize = (texture: BaseTexture | null | undefined) => {
  if (!texture) return null;
  try {
    const size = texture.getSize();
    return size.width > 0 && size.height > 0 ? size : null;
  } catch {
    return null;
  }
};

const materialColor = (material: Material) => {
  const candidate = material as Material & { diffuseColor?: Color3; alpha?: number };
  const color = candidate.diffuseColor ?? Color3.White();
  return [clamp01(color.r), clamp01(color.g), clamp01(color.b), clamp01(candidate.alpha ?? 1)] as [number, number, number, number];
};

const materialTexture = (material: Material) => {
  const candidate = material as Material & { diffuseTexture?: BaseTexture | null };
  return candidate.diffuseTexture ?? null;
};

const captureTexture = async (
  texture: BaseTexture,
  maxEdge: number,
  byteBudget: number,
): Promise<MeshTextureSnapshot | null> => {
  const size = textureSize(texture);
  if (!size) return null;
  const budgetPixels = Math.max(1, Math.floor(byteBudget / 4));
  const scale = Math.min(1, maxEdge / Math.max(size.width, size.height), Math.sqrt(budgetPixels / (size.width * size.height)));
  const width = Math.max(1, Math.floor(size.width * scale));
  const height = Math.max(1, Math.floor(size.height * scale));
  try {
    const raw = await GetTextureDataAsync(texture, width, height);
    if (raw.length !== width * height * 4) return null;
    return { width, height, pixels: Uint8ClampedArray.from(raw) };
  } catch {
    // Some browser texture backends do not expose texture readback before a frame is rendered.
  }
  return null;
};

const createBabylonMaterialSnapshots = async (
  materials: readonly Material[],
  visibility: BabylonMaterialVisibilityController,
  options: MmdSnapshotOptions,
) => {
  const maxEdge = Math.max(1, Math.floor(options.textureMaxEdge ?? 512));
  const budget = Math.max(4, Math.floor(options.textureByteBudget ?? 64 * 1024 * 1024));
  const textures: MeshTextureSnapshot[] = [];
  const textureIndices = new Map<BaseTexture, number>();
  const snapshots: MeshMaterialSnapshot[] = [];
  let capturedTextureBytes = 0;
  for (let index = 0; index < materials.length; index += 1) {
    const material = materials[index];
    const color = materialColor(material);
    const texture = materialTexture(material);
    let textureIndex = -1;
    if (texture && visibility.isRuntimeVisible(index)) {
      textureIndex = textureIndices.get(texture) ?? -1;
      if (textureIndex < 0 && capturedTextureBytes < budget) {
        const captured = await captureTexture(texture, maxEdge, budget - capturedTextureBytes);
        if (captured) {
          textureIndex = textures.length;
          textures.push(captured);
          capturedTextureBytes += captured.pixels.byteLength;
          textureIndices.set(texture, textureIndex);
        }
      }
    }
    const named = `${material.name ?? ""}`;
    if (texture && visibility.isRuntimeVisible(index) && textureIndex < 0) {
      throw appError("error.snapshot.textureCaptureFailed", { material: named || index });
    }
    const candidate = material as Material & {
      emissiveColor?: Color3;
      diffuseColor?: Color3;
      textureMultiplicativeColor?: Color4;
      textureAdditiveColor?: Color4;
    };
    const textureTransform = texture as (BaseTexture & {
      uScale?: number;
      vScale?: number;
      uOffset?: number;
      vOffset?: number;
    }) | null;
    const emissiveColor = candidate.emissiveColor;
    const textureMultiplicativeColor = candidate.textureMultiplicativeColor;
    const textureAdditiveColor = candidate.textureAdditiveColor;
    const textureFactor: [number, number, number, number] = textureMultiplicativeColor
      ? [
          textureMultiplicativeColor.r,
          textureMultiplicativeColor.g,
          textureMultiplicativeColor.b,
          textureMultiplicativeColor.a,
        ]
      : [1, 1, 1, 1];
    snapshots.push({
      name: named,
      englishName: "",
      baseColor: color,
      textureFactor,
      textureAdditiveFactor: textureAdditiveColor
        ? [
            textureAdditiveColor.r,
            textureAdditiveColor.g,
            textureAdditiveColor.b,
            textureAdditiveColor.a,
          ]
        : [0, 0, 0, 0],
      hasTexture: texture !== null,
      textureIndex,
      textureMatrix: [textureTransform?.uScale ?? 1, 0, textureTransform?.uOffset ?? 0, 0, textureTransform?.vScale ?? 1, textureTransform?.vOffset ?? 0, 0, 0, 1],
      wrapS: toThreeWrapMode(Number((texture as BaseTexture & { wrapU?: number } | null)?.wrapU)),
      wrapT: toThreeWrapMode(Number((texture as BaseTexture & { wrapV?: number } | null)?.wrapV)),
      // babylon-mmd flips model UV V coordinates while building geometry. The
      // snapshot therefore already uses the same orientation as Three.js MMD,
      // whose textures are loaded with flipY=false.
      flipY: false,
      ambient: [0, 0, 0],
      emissive: Boolean(emissiveColor && (emissiveColor.r + emissiveColor.g + emissiveColor.b > 0.001)) || isSuggestedEmissiveMaterial(named, "", undefined),
    });
  }
  return { materials: snapshots, textures: textures.length ? textures : undefined };
};

const setBabylonBone = (bone: { position: Vector3; rotationQuaternion?: Quaternion | null }, state: BabylonBoneState) => {
  bone.position.copyFrom(state.position);
  if (bone.rotationQuaternion) bone.rotationQuaternion.copyFrom(state.rotation);
  else (bone as { rotationQuaternion: Quaternion }).rotationQuaternion = state.rotation.clone();
};

const getBoneRotation = (bone: { rotationQuaternion?: Quaternion | null }) => bone.rotationQuaternion?.clone() ?? Quaternion.Identity();

const getRootMesh = (container: AssetContainer): Mesh => {
  const candidate = container.meshes.find((mesh) => Boolean((mesh.metadata as { isMmdModel?: boolean } | null)?.isMmdModel));
  if (!candidate) throw new Error("Babylon MMD loader returned no MMD root mesh");
  return asBabylonMesh(candidate);
};

const getModelMeshes = (root: Mesh): Mesh[] => {
  const metadata = root.metadata as { meshes?: readonly Mesh[] } | null;
  const meshes = metadata?.meshes?.length ? [...metadata.meshes] : [root];
  return [...new Set(meshes.map(asBabylonMesh))];
};

const disposeMeshResources = (container: AssetContainer | null, scene: Scene, root: Mesh | null) => {
  try { container?.removeAllFromScene(); } catch { /* best effort */ }
  const meshes = root ? getModelMeshes(root) : [];
  meshes.forEach((mesh) => {
    try { mesh.dispose(false, true); } catch { /* best effort */ }
  });
  try { container?.dispose(); } catch { /* best effort */ }
  try { scene.dispose(); } catch { /* best effort */ }
};

const readIndices = (mesh: Mesh) => {
  const indices = mesh.getIndices();
  if (indices) return Array.from(indices as ArrayLike<number>, (value) => Number(value));
  const count = mesh.getTotalVertices();
  return Number.isSafeInteger(count) && count >= 0
    ? Array.from({ length: count }, (_value, index) => index)
    : [];
};

const readSkinData = (mesh: Mesh) => ({
  indices: mesh.getVerticesData(VertexBuffer.MatricesIndicesKind) as Float32Array | Uint32Array | Uint8Array | null,
  weights: mesh.getVerticesData(VertexBuffer.MatricesWeightsKind) as Float32Array | null,
  extraIndices: mesh.getVerticesData(VertexBuffer.MatricesIndicesExtraKind) as Float32Array | Uint32Array | Uint8Array | null,
  extraWeights: mesh.getVerticesData(VertexBuffer.MatricesWeightsExtraKind) as Float32Array | null,
  sdefC: mesh.getVerticesData(MmdBufferKind.MatricesSdefCKind) as Float32Array | null,
  sdefRW0: mesh.getVerticesData(MmdBufferKind.MatricesSdefRW0Kind) as Float32Array | null,
  sdefRW1: mesh.getVerticesData(MmdBufferKind.MatricesSdefRW1Kind) as Float32Array | null,
});

const isFiniteVector = (value: Vector3) => (
  Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z)
);

const isFiniteMatrix = (matrix: Matrix) => matrix.m.every((value) => Number.isFinite(value));

const readFiniteInteger = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) && Number.isSafeInteger(number) && number >= 0 ? number : null;
};

const readSafeMatrix = (matrices: Float32Array, boneIndex: unknown) => {
  const index = readFiniteInteger(boneIndex);
  const offset = index === null ? -1 : index * 16;
  if (offset < 0 || offset + 16 > matrices.length) return null;
  for (let componentIndex = 0; componentIndex < 16; componentIndex += 1) {
    if (!Number.isFinite(matrices[offset + componentIndex])) return null;
  }
  return Matrix.FromArray(matrices, offset);
};

const readFiniteVector3 = (data: ArrayLike<number> | null, offset: number) => {
  if (!data || offset < 0 || offset + 3 > data.length) return null;
  const x = Number(data[offset]);
  const y = Number(data[offset + 1]);
  const z = Number(data[offset + 2]);
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)
    ? new Vector3(x, y, z)
    : null;
};

const readBabylonVertexPosition = (sourcePositions: ArrayLike<number>, vertexIndex: number) => (
  Number.isSafeInteger(vertexIndex) && vertexIndex >= 0
    ? readFiniteVector3(sourcePositions, vertexIndex * 3)
    : null
);

const validBabylonVertexIndex = (value: unknown, vertexCount: number) => {
  const index = readFiniteInteger(value);
  return index !== null && index < vertexCount ? index : null;
};

interface BabylonVisibleGroup {
  start: number;
  end: number;
  material: number;
}

type BabylonVisibleTriangleVisitor = (a: number, b: number, c: number, material: number) => void;

const collectBabylonVisibleGroups = (
  mesh: Mesh,
  sourceIndices: readonly number[],
  materials: readonly Material[],
  visibility: BabylonMaterialVisibilityController,
): BabylonVisibleGroup[] => {
  if (!mesh.isVisible || !Number.isFinite(mesh.visibility) || mesh.visibility <= 0) return [];
  const rawGroups = mesh.subMeshes?.length
    ? mesh.subMeshes.map((subMesh) => ({
        start: subMesh.indexStart,
        count: subMesh.indexCount,
        material: materialIndexForSubMesh(mesh, subMesh.materialIndex, materials),
      }))
    : [{
        start: 0,
        count: sourceIndices.length,
        material: materialIndexForSubMesh(mesh, 0, materials),
      }];
  return rawGroups.flatMap((group) => {
    const material = group.material;
    if (material === null) return [];
    const candidate = materials[material] as (Material & { isDisposed?: () => boolean }) | undefined;
    if (!candidate || candidate.isDisposed?.() || !visibility.isRuntimeVisible(material)) return [];
    if (!Number.isSafeInteger(group.start) || group.start < 0
      || !Number.isSafeInteger(group.count) || group.count < 0
      || group.start > sourceIndices.length) return [];
    const end = group.count > sourceIndices.length - group.start
      ? sourceIndices.length
      : group.start + group.count;
    return end - group.start >= 3 ? [{ start: group.start, end, material }] : [];
  });
};

const visitBabylonVisibleTriangles = (
  mesh: Mesh,
  sourceIndices: readonly number[],
  vertexCount: number,
  materials: readonly Material[],
  visibility: BabylonMaterialVisibilityController,
  visitor: BabylonVisibleTriangleVisitor,
) => {
  collectBabylonVisibleGroups(mesh, sourceIndices, materials, visibility).forEach((group) => {
    for (let cursor = group.start; cursor + 2 < group.end; cursor += 3) {
      const a = validBabylonVertexIndex(sourceIndices[cursor], vertexCount);
      const b = validBabylonVertexIndex(sourceIndices[cursor + 1], vertexCount);
      const c = validBabylonVertexIndex(sourceIndices[cursor + 2], vertexCount);
      if (a === null || b === null || c === null) continue;
      visitor(a, b, c, group.material);
    }
  });
};

/**
 * Babylon's public position helper can apply MorphTargetManager position
 * morphs, but there is no equivalent public UV helper. Reproduce Babylon's
 * absolute-target blend for UVs so the CPU snapshot matches the rendered
 * frame when a UV morph is active.
 */
const readMorphedUvs = (mesh: Mesh, source: Float32Array | null) => {
  if (!source) return null;
  const manager = mesh.morphTargetManager;
  if (!manager || !manager.enableUVMorphing || manager.numTargets === 0) {
    return source;
  }
  const output = Float32Array.from(source);
  for (let targetIndex = 0; targetIndex < manager.numTargets; targetIndex += 1) {
    const target = manager.getTarget(targetIndex);
    const influence = target.influence;
    if (influence === 0) continue;
    const targetUvs = target.getUVs();
    if (!targetUvs) continue;
    const length = Math.min(output.length, targetUvs.length, source.length);
    for (let componentIndex = 0; componentIndex < length; componentIndex += 1) {
      output[componentIndex] += (Number(targetUvs[componentIndex] ?? source[componentIndex])
        - source[componentIndex]) * influence;
    }
  }
  return output;
};

const skinPosition = (
  position: Vector3,
  vertexIndex: number,
  mesh: Mesh,
  matrices: Float32Array,
  data: ReturnType<typeof readSkinData>,
  target: Vector3,
) => {
  if (!isFiniteVector(position) || !Number.isSafeInteger(vertexIndex) || vertexIndex < 0) return false;
  const weights = data.weights;
  const indices = data.indices;
  if (!weights && !indices) {
    target.copyFrom(position);
    return true;
  }
  if (!weights || !indices) return false;
  const base = vertexIndex * 4;
  if (base + 4 > weights.length || base + 4 > indices.length) return false;
  const sdefC = data.sdefC;
  const sdefRW0 = data.sdefRW0;
  const sdefRW1 = data.sdefRW1;
  // SDEF vectors are xyz tuples, while bone indices/weights remain vec4s.
  const sdefBase = vertexIndex * 3;
  const matrixFor = (source: ArrayLike<number>, offset: number) => {
    const matrix = readSafeMatrix(matrices, source[offset]);
    return matrix && isFiniteMatrix(matrix) ? matrix : null;
  };
  const weightsFor = (source: ArrayLike<number>, offset: number) => Number(source[offset]);
  const baseWeights = Array.from({ length: 4 }, (_value, slot) => weightsFor(weights, base + slot));
  if (baseWeights.some((weight) => !Number.isFinite(weight) || weight < 0)) return false;
  const hasSdefData = Boolean(
    sdefC && sdefRW0 && sdefRW1
    && sdefBase + 3 <= sdefC.length
    && sdefBase + 3 <= sdefRW0.length
    && sdefBase + 3 <= sdefRW1.length,
  );
  if ((sdefC || sdefRW0 || sdefRW1) && !hasSdefData) return false;
  const sdefSentinel = hasSdefData ? Number(sdefRW0?.[sdefBase]) : 0;
  if (hasSdefData) {
    const c = readFiniteVector3(sdefC, sdefBase);
    const rw0 = readFiniteVector3(sdefRW0, sdefBase);
    const rw1 = readFiniteVector3(sdefRW1, sdefBase);
    if (!c || !rw0 || !rw1 || !Number.isFinite(sdefSentinel)) return false;
  }
  // Match babylon-mmd's shader branch exactly: only an exact zero RW0.x
  // selects linear skinning; any non-zero value selects the SDEF influence.
  const sdef = hasSdefData && sdefSentinel !== 0;
  if (sdef) {
    if (!sdefC || !sdefRW0 || !sdefRW1) return false;
    const w0 = baseWeights[0];
    const w1 = baseWeights[1];
    if (w0 + w1 <= 1e-8) return false;
    const m0 = w0 > 0 ? matrixFor(indices, base) : Matrix.Identity();
    const m1 = w1 > 0 ? matrixFor(indices, base + 1) : Matrix.Identity();
    if ((w0 > 0 && !m0) || (w1 > 0 && !m1)) return false;
    const q0 = Quaternion.FromRotationMatrix(m0!);
    const q1 = Quaternion.FromRotationMatrix(m1!);
    const rotation = Quaternion.Slerp(q0, q1, w1);
    const rotationMatrix = Matrix.FromQuaternionToRef(rotation, Matrix.Identity());
    const c = readFiniteVector3(sdefC, sdefBase);
    const rw0 = readFiniteVector3(sdefRW0, sdefBase);
    const rw1 = readFiniteVector3(sdefRW1, sdefBase);
    if (!c || !rw0 || !rw1 || !isFiniteMatrix(rotationMatrix)) return false;
    target.copyFrom(Vector3.TransformCoordinates(position.subtract(c), rotationMatrix));
    const p0 = Vector3.TransformCoordinates(rw0, m0!);
    const p1 = Vector3.TransformCoordinates(rw1, m1!);
    if (!isFiniteVector(p0) || !isFiniteVector(p1)) return false;
    target.addInPlace(p0.scale(w0)).addInPlace(p1.scale(w1));
    return isFiniteVector(target);
  }

  const baseMatrices: Matrix[] = [];
  let totalWeight = 0;
  for (let slot = 0; slot < 4; slot += 1) {
    const offset = base + slot;
    const weight = baseWeights[slot];
    const matrix = weight > 0 ? matrixFor(indices, offset) : null;
    if (weight > 0 && !matrix) return false;
    baseMatrices.push(matrix ?? Matrix.Identity());
    totalWeight += weight;
  }
  const extraMatrices: Matrix[] = [];
  const extraWeights: number[] = [];
  if (mesh.numBoneInfluencers > 4) {
    if (!data.extraIndices || !data.extraWeights) return false;
    const extraBase = vertexIndex * 4;
    if (extraBase + 4 > data.extraIndices.length || extraBase + 4 > data.extraWeights.length) return false;
    for (let slot = 0; slot < 4; slot += 1) {
      const offset = extraBase + slot;
      const weight = Number(data.extraWeights[offset]);
      if (!Number.isFinite(weight) || weight < 0) return false;
      const matrix = weight > 0 ? matrixFor(data.extraIndices, offset) : null;
      if (weight > 0 && !matrix) return false;
      extraMatrices.push(matrix ?? Matrix.Identity());
      extraWeights.push(weight);
      totalWeight += weight;
    }
  }
  if (!Number.isFinite(totalWeight) || totalWeight <= 1e-8) return false;
  target.set(0, 0, 0);
  let valid = true;
  const add = (matrix: Matrix, weight: number) => {
    if (weight <= 0) return;
    const transformed = Vector3.TransformCoordinates(position, matrix);
    if (!isFiniteVector(transformed)) {
      valid = false;
      return;
    }
    target.addInPlace(transformed.scale(weight));
  };
  baseMatrices.forEach((matrix, slot) => add(matrix, baseWeights[slot]));
  extraMatrices.forEach((matrix, slot) => add(matrix, extraWeights[slot] ?? 0));
  return valid && isFiniteVector(target);
};

const createBabylonSkinMatrices = (
  worldTransformMatrices: Float32Array,
  bones: readonly Bone[],
) => {
  // Keep the CPU snapshot on babylon-mmd's official inverse-bind call order.
  // Babylon's multiplyToRef semantics produce the same matrix consumed by
  // the renderer from `inverseBind.multiplyToRef(world, skin)`.
  const availableMatrixCount = Math.floor(worldTransformMatrices.length / 16);
  if (availableMatrixCount < bones.length) {
    throw appError("error.mesh.invalidVertices");
  }
  const matrices = new Float32Array(bones.length * 16);
  const world = Matrix.Identity();
  const skin = Matrix.Identity();
  bones.forEach((bone, index) => {
    const worldMatrix = readSafeMatrix(worldTransformMatrices, index);
    if (!worldMatrix) {
      throw appError("error.mesh.nonFiniteVertex");
    }
    world.copyFrom(worldMatrix);
    const inverseBind = bone.getAbsoluteInverseBindMatrix();
    if (!isFiniteMatrix(inverseBind)) throw appError("error.mesh.invalidVertices");
    inverseBind.multiplyToRef(world, skin);
    if (!isFiniteMatrix(skin)) throw appError("error.mesh.nonFiniteVertex");
    skin.copyToArray(matrices, index * 16);
  });
  return matrices;
};

const createBabylonSnapshot = async (
  rootMesh: Mesh,
  sourceMeshes: readonly Mesh[],
  materials: readonly Material[],
  visibility: BabylonMaterialVisibilityController,
  skinMatrices: Float32Array,
  options: MmdSnapshotOptions,
): Promise<MmdMeshSnapshot> => {
  const positions: number[] = [];
  const indices: number[] = [];
  const triangleMaterials: number[] = [];
  const uvs: number[] = [];
  let hasUvs = false;
  const temp = new Vector3();
  const rootWorldInverse = rootMesh.computeWorldMatrix(true).clone().invert();
  for (const mesh of sourceMeshes) {
    if (options.isCancelled?.()) {
      const error = appError("error.snapshot.cancelled");
      error.name = "AbortError";
      throw error;
    }
    const sourcePositions = mesh.getPositionData(false, true);
    if (!sourcePositions) continue;
    const vertexCount = Math.floor(sourcePositions.length / 3);
    if (!Number.isSafeInteger(vertexCount) || vertexCount <= 0) continue;
    const sourceUvs = mesh.getVerticesData(VertexBuffer.UVKind) as Float32Array | null;
    const morphedUvs = readMorphedUvs(mesh, sourceUvs);
    const skin = readSkinData(mesh);
    const matrices = skinMatrices;
    // Babylon's multiply helper composes matrices in reverse operand order.
    const meshToRoot = mesh.computeWorldMatrix(true).multiply(rootWorldInverse);
    const sourceIndices = readIndices(mesh);
    // Filter materials before emitting vertices. Keeping a vertex-only list
    // for hidden triangles would still expand the worker's bounds and change
    // the final normalization even though those triangles are not exported.
    const vertexMap = new Map<number, number>();
    const emitVertex = (sourceIndex: number): number | null => {
      const validIndex = validBabylonVertexIndex(sourceIndex, vertexCount);
      if (validIndex === null) return null;
      sourceIndex = validIndex;
      const existing = vertexMap.get(sourceIndex);
      if (existing !== undefined) return existing;
      const position = readBabylonVertexPosition(sourcePositions, sourceIndex);
      if (!position) return null;
      if (!skinPosition(position, sourceIndex, mesh, matrices, skin, temp)) return null;
      if (!isFiniteMatrix(meshToRoot)) return null;
      const rootRelative = Vector3.TransformCoordinates(temp, meshToRoot);
      if (!isFiniteVector(rootRelative)) return null;
      const mapped = toMelyPosition(rootRelative.x, rootRelative.y, rootRelative.z);
      if (!mapped.every(Number.isFinite)) return null;
      const outputIndex = positions.length / 3;
      positions.push(mapped[0], mapped[1], mapped[2]);
      if (morphedUvs) {
        hasUvs = true;
        uvs.push(morphedUvs[sourceIndex * 2] ?? 0, morphedUvs[sourceIndex * 2 + 1] ?? 0);
      } else {
        uvs.push(0, 0);
      }
      vertexMap.set(sourceIndex, outputIndex);
      return outputIndex;
    };
    visitBabylonVisibleTriangles(mesh, sourceIndices, vertexCount, materials, visibility, (a, b, c, material) => {
      const outputA = emitVertex(a);
      const outputB = emitVertex(b);
      const outputC = emitVertex(c);
      if (outputA === null || outputB === null || outputC === null) return;
      indices.push(outputA, outputB, outputC);
      triangleMaterials.push(material);
    });
  }
  if (!indices.length) throw appError("error.snapshot.noVisibleTriangles");
  options.onProgress?.(0.86);
  const materialData = options.includeTextures === false
    ? {}
    : await createBabylonMaterialSnapshots(materials, visibility, options);
  options.onProgress?.(1);
  return {
    positions: Float32Array.from(positions),
    indices: Uint32Array.from(indices),
    triangleMaterials: Uint16Array.from(triangleMaterials),
    ...(hasUvs ? { uvs: Float32Array.from(uvs) } : {}),
    ...materialData,
  };
};

/** Compute posed, root-local bounds using the same visible-submesh filter as snapshots. */
const computeBabylonVisibleBounds = (
  rootMesh: Mesh,
  sourceMeshes: readonly Mesh[],
  materials: readonly Material[],
  visibility: BabylonMaterialVisibilityController,
  skinMatrices: Float32Array,
  target: Box3,
) => {
  target.makeEmpty();
  const rootWorldInverse = rootMesh.computeWorldMatrix(true).clone().invert();
  const temp = new Vector3();
  sourceMeshes.forEach((mesh) => {
    const sourcePositions = mesh.getPositionData(false, true);
    if (!sourcePositions) return;
    const skin = readSkinData(mesh);
    const meshToRoot = mesh.computeWorldMatrix(true).multiply(rootWorldInverse);
    const sourceIndices = readIndices(mesh);
    if (!isFiniteMatrix(meshToRoot)) return;
    const vertexCount = Math.floor(sourcePositions.length / 3);
    if (!Number.isSafeInteger(vertexCount) || vertexCount <= 0) return;
    visitBabylonVisibleTriangles(mesh, sourceIndices, vertexCount, materials, visibility, (a, b, c) => {
      for (const sourceIndex of [a, b, c]) {
        const position = readBabylonVertexPosition(sourcePositions, sourceIndex);
        if (!position || !skinPosition(position, sourceIndex, mesh, skinMatrices, skin, temp)) continue;
        const rootRelative = Vector3.TransformCoordinates(temp, meshToRoot);
        if (!isFiniteVector(rootRelative)) continue;
        const mapped = toMelyPosition(rootRelative.x, rootRelative.y, rootRelative.z);
        if (!mapped.every(Number.isFinite)) continue;
        target.expandByPoint(new ThreeVector3(mapped[0], mapped[1], mapped[2]));
      }
    });
  });
  return target;
};

/**
 * Loads a PMX/PMD model into a dedicated Babylon.js context. The returned
 * model owns the engine, scene, WASM runtime and asset container; disposal is
 * idempotent so renderer transactions can await it before creating another
 * WebGL context.
 */
export const loadBabylonMmdModel = async (
  files: readonly File[],
  modelFile: File,
): Promise<LoadedMmdModel> => {
  let canvas: HTMLCanvasElement | null = null;
  let engine: Engine | null = null;
  let scene: Scene | null = null;
  let container: AssetContainer | null = null;
  let rootMesh: Mesh | null = null;
  let sourceMeshes: Mesh[] = [];
  let mmdRuntime: BabylonRuntime | null = null;
  let wasmInstance: Awaited<ReturnType<typeof GetMmdWasmInstance>> | null = null;
  let mmdModel: BabylonModel | null = null;
  let disposed = false;
  let loadStage = "create-canvas";
  try {
    canvas = document.createElement("canvas");
    canvas.width = 960;
    canvas.height = 540;
    engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
    loadStage = "configure-scene";
    SdefInjector.OverrideEngineCreateEffect(engine);
    scene = new Scene(engine);
    scene.clearColor = new Color4(0.04, 0.05, 0.06, 1);
    const camera = new ArcRotateCamera("mely-babylon-camera", -Math.PI / 2, Math.PI / 2.4, 45, new Vector3(0, 10, 0), scene);
    camera.fov = MMD_PREVIEW_VERTICAL_FOV_RADIANS;
    camera.minZ = 0.1;
    camera.maxZ = 20000;
    applyBabylonCameraPanningProfile(camera);
    camera.attachControl(false, true, 2);
    const light = new DirectionalLight("mely-babylon-key", new Vector3(-0.3, -1, -0.4), scene);
    light.intensity = 1.8;
    const hemi = new HemisphericLight("mely-babylon-hemi", new Vector3(0, 1, 0), scene);
    hemi.intensity = 0.65;
    const referenceBundle = createBabylonMmdReferenceFiles(files, modelFile, {
      includeBuiltinToon: true,
    });
    const textureWarnings = [...referenceBundle.warnings];
    const materialBuilder = new DiagnosticMmdMaterialBuilder(textureWarnings);

    loadStage = "load-asset-container";
    const loadedContainer = await LoadAssetContainerAsync(modelFile, scene, {
      pluginOptions: {
        mmdmodel: {
          referenceFiles: referenceBundle.referenceFiles,
          materialBuilder,
          optimizeSubmeshes: false,
          optimizeSingleMaterialModel: false,
          useSdef: true,
          preserveSerializationData: true,
          buildSkeleton: true,
          buildMorph: true,
        },
      },
    });
    container = loadedContainer;
    loadStage = "attach-asset-container";
    loadedContainer.addAllToScene();
    rootMesh = getRootMesh(loadedContainer);
    sourceMeshes = getModelMeshes(rootMesh);
    const loadedMetadata = (rootMesh.metadata ?? {}) as {
      materials?: readonly Material[];
    };
    const fallbackMaterials = sourceMeshes.flatMap(materialArray);
    const materials = resolveCanonicalBabylonMaterials(loadedMetadata, fallbackMaterials);
    const materialVisibility = createBabylonMaterialVisibilityController(materials);
    const VisibilityMaterialProxy = createBabylonVisibilityMaterialProxy(
      materialVisibility,
      MmdStandardMaterialProxy,
    );
    loadStage = "load-wasm-runtime";
    wasmInstance = await getBabylonMmdWasmInstance();
    const physicsClock: MutablePhysicsClock = {
      deltaSeconds: 0,
      getDeltaTime() {
        return this.deltaSeconds;
      },
    };
    const physicsBuilder = new ApplicationMmdWasmPhysics(scene, physicsClock);
    mmdRuntime = new MmdWasmRuntime(wasmInstance, null, physicsBuilder);
    const physicsAvailable = Boolean((rootMesh.metadata as { rigidBodies?: readonly unknown[] } | null)?.rigidBodies?.length);
    loadStage = "create-mmd-runtime-model";
    mmdModel = mmdRuntime.createMmdModel(rootMesh as never, {
      materialProxyConstructor: VisibilityMaterialProxy,
      buildPhysics: physicsAvailable,
      trimMetadata: false,
    });
    if (mmdRuntime.physics) {
      mmdRuntime.physics.fixedTimeStep = BABYLON_PHYSICS_FIXED_STEP;
      mmdRuntime.physics.maxSubSteps = 10;
    }
    mmdRuntime.pauseAnimation();
    // Timeline evaluation is driven explicitly by the application. Registering
    // the runtime on scene observables would evaluate the same model again when
    // BabylonViewport calls scene.render().
    if (mmdModel.rigidBodyStates.length) mmdModel.rigidBodyStates.fill(0);

    loadStage = "build-runtime-metadata";
    const metadata = (rootMesh.metadata ?? {}) as {
      header?: { modelName?: string; englishModelName?: string };
      bones?: readonly { name: string; englishName: string; parentBoneIndex: number; ik?: unknown }[];
      morphs?: readonly { name: string; englishName: string }[];
      materials?: readonly Material[];
      materialsMetadata?: readonly { englishName?: string }[];
      rigidBodies?: readonly unknown[];
      joints?: readonly unknown[];
    };
    const skeleton = rootMesh.skeleton as Skeleton | null;
    const babylonBones = skeleton?.bones ?? [];
    const boneInfos: MmdBoneInfo[] = babylonBones.map((bone, index) => {
      const info = metadata.bones?.[index];
      const name = info?.name || bone.name || `bone_${index}`;
      const englishName = info?.englishName || bone.name || "";
      return {
        index,
        name,
        englishName,
        displayName: englishName && englishName !== name ? `${name} / ${englishName}` : name,
        parentIndex: info?.parentBoneIndex ?? (bone.getParent() ? babylonBones.indexOf(bone.getParent() as typeof bone) : -1),
        controlMode: boneControlMode(name, englishName),
        isIkGoal: false,
      };
    });
    const runtimeMorphs = mmdModel.morph.morphs;
    // Runtime morphs remain available even when a loader or serialized asset
    // omits the optional metadata block. Metadata names add English aliases
    // when present, while the runtime list stays the index source of truth.
    const morphNames = Array.from(new Set([
      ...runtimeMorphs.map((morph) => morph.name),
      ...(metadata.morphs ?? []).flatMap((morph, index) => (
        runtimeMorphs[index] ? [morph.name, morph.englishName] : []
      )),
    ])).filter((name): name is string => Boolean(name));
    const textureNameMap = (rootMesh.metadata as {
      textureNameMap?: Map<BaseTexture, string>;
    } | null)?.textureNameMap;
    const textureWarningKeys = new Set(textureWarnings);
    textureNameMap?.forEach((path, texture) => {
      if (!texture.loadingError) return;
      const warning = path || texture.name;
      if (textureWarningKeys.has(warning)) return;
      textureWarningKeys.add(warning);
      textureWarnings.push(warning);
    });
    const materialInfo: MmdMaterialInfo[] = materials.map((material, index) => {
      const color = materialColor(material);
      const name = material.name || `material_${index}`;
      const englishName = metadata.materialsMetadata?.[index]?.englishName ?? "";
      const texture = materialTexture(material);
      return {
        index,
        name,
        englishName,
        displayName: englishName || name,
        color: [color[0], color[1], color[2]],
        opacity: color[3],
        hasTexture: Boolean(texture),
        suggestedSkin: isSuggestedSkinMaterial(name, englishName),
        ambient: [0, 0, 0],
        suggestedEmissive: isSuggestedEmissiveMaterial(name, englishName, undefined),
      };
    });
    const restBones: BabylonBoneState[] = babylonBones.map((bone) => ({
      position: bone.getRestMatrix().getTranslation(),
      rotation: Quaternion.Identity(),
    }));
    const importedBones: BabylonBoneState[] = restBones.map((state) => ({ position: state.position.clone(), rotation: state.rotation.clone() }));
    const importedMorphs = new Map<number, number>();
    const manualOffsets = new Map<number, BabylonOffset>();
    const undoStack: Map<number, BabylonOffset>[] = [];
    const redoStack: Map<number, BabylonOffset>[] = [];
    let editStart: Map<number, BabylonOffset> | null = null;
    const editBaseStates = new Map<number, BabylonBoneState>();
    let importedPose: MelyPoseDocument | null = null;
    let active = true;
    // Keep the user-level switch independent from VMD's per-frame physics
    // toggles, which are stored in the same rigidBodyStates buffer.
    let physicsEnabledState = false;
    // Integrated Babylon physics queues reset requests in the WASM runtime and
    // consumes them during beforePhysics. Keep the request pending across a
    // kinematic preview evaluation so the first live step initializes bodies
    // after their dynamic state has been committed.
    let physicsInitializationPending = false;
    // A later preview/edit evaluation can make bodies kinematic after a live
    // physics step. Remember that transition so the next live step does not
    // reuse the old dynamic transforms and velocities.
    let physicsStepActive = false;
  let dance = emptyMotion();
  let expression = emptyMotion();
    const motionTimes: MmdMotionTimes = { dance: 0, expression: 0 };
    const morphLookup = new Map<string, number[]>();
    runtimeMorphs.forEach((morph, index) => {
      const normalized = normalizeMmdName(morph.name);
      if (!normalized) return;
      const indices = morphLookup.get(normalized) ?? [];
      indices.push(index);
      morphLookup.set(normalized, indices);
    });
    (metadata.morphs ?? []).forEach((morph, index) => {
      if (!runtimeMorphs[index]) return;
      const aliases = [morph.name, morph.englishName];
      aliases.forEach((name) => {
        const normalized = normalizeMmdName(name);
        if (!normalized) return;
        const indices = morphLookup.get(normalized) ?? [];
        if (!indices.includes(index)) indices.push(index);
        morphLookup.set(normalized, indices);
      });
    });
    const boneLookup = new Map<string, number>();
    boneInfos.forEach((bone, index) => [bone.name, bone.englishName].forEach((name) => {
      const normalized = normalizeMmdName(name);
      if (normalized && !boneLookup.has(normalized)) boneLookup.set(normalized, index);
    }));

    const activeDanceBoneIndices = () => {
      const indices = new Set<number>();
      dance.animation?.boneTracks.forEach((track) => {
        const index = boneLookup.get(normalizeMmdName(track.name));
        if (index !== undefined) indices.add(index);
      });
      dance.animation?.movableBoneTracks.forEach((track) => {
        const index = boneLookup.get(normalizeMmdName(track.name));
        if (index !== undefined) indices.add(index);
      });
      return indices;
    };

    const activeExpressionMorphIndices = () => {
      const indices = new Set<number>();
      expression.expressionTracks.forEach((track) => {
        morphLookup.get(normalizeMmdName(track.name))?.forEach((index) => indices.add(index));
      });
      return indices;
    };

    const applyImportedAndManual = (
      animatedBoneIndices: ReadonlySet<number>,
      animatedMorphIndices: ReadonlySet<number>,
    ) => {
      const runtimeModel = mmdModel;
      if (!runtimeModel || !skeleton) return;
      babylonBones.forEach((bone, index) => {
        if (animatedBoneIndices.has(index)) return;
        const state = importedBones[index] ?? restBones[index];
        setBabylonBone(bone, state);
      });
      manualOffsets.forEach((offset, index) => {
        const bone = babylonBones[index];
        if (!bone) return;
        bone.position.addInPlace(offset.position);
        const current = getBoneRotation(bone);
        bone.rotationQuaternion = current.multiply(offset.rotation);
      });
      // Keep VMD expression weights intact. Imported morph values only fill
      // slots that are not driven by the active expression track.
      runtimeMorphs.forEach((_morph, index) => {
        if (animatedMorphIndices.has(index)) return;
        runtimeModel.morph.setMorphWeightFromIndex(index, importedMorphs.get(index) ?? 0);
      });
      runtimeModel.morph.update();
      skeleton._markAsDirty();
    };

    const resetAnimationBase = () => {
      if (!mmdModel) return;
      mmdModel.morph.resetMorphWeights();
      babylonBones.forEach((bone, index) => setBabylonBone(bone, restBones[index] ?? { position: Vector3.Zero(), rotation: Quaternion.Identity() }));
      skeleton?._markAsDirty();
    };

    const evaluate = (
      times: MmdMotionTimes,
      physics: boolean,
      physicsDeltaSeconds = 0,
    ) => {
      if (!active || !mmdModel || !mmdRuntime) return;
      const physicsDelta = Number.isFinite(physicsDeltaSeconds)
        ? Math.max(0, physicsDeltaSeconds)
        : 0;
      const effectivePhysics = Boolean(
        physics
        && physicsEnabledState
        && physicsAvailable
        && physicsDelta > 0,
      );
      if (!effectivePhysics && physicsEnabledState && physicsAvailable && physicsStepActive) {
        physicsInitializationPending = true;
      }
      motionTimes.dance = Math.max(0, Math.min(dance.info?.durationSeconds ?? 0, times.dance));
      motionTimes.expression = Math.max(0, Math.min(expression.info?.durationSeconds ?? 0, times.expression));
      resetAnimationBase();
      const animatedBoneIndices = activeDanceBoneIndices();
      const animatedMorphIndices = activeExpressionMorphIndices();
      const danceAnimation = dance.danceHandle !== null ? mmdModel.runtimeAnimations.get(dance.danceHandle) as RuntimeAnimation | undefined : undefined;
      // A preview evaluation deliberately leaves every body kinematic. Prime
      // the state buffer again when a physical evaluation follows so toggling
      // preview/physics cannot strand the model in its previous disabled state.
      // The animation pass below may then apply VMD's per-frame toggles.
      if (effectivePhysics) mmdModel.rigidBodyStates.fill(1);
      else mmdModel.rigidBodyStates.fill(0);
      evaluateRuntimeAnimation(danceAnimation, motionTimes.dance * 30);
      expression.expressionTracks.forEach((track) => {
        const weight = sampleMorph(track, motionTimes.expression * 30);
        morphLookup.get(normalizeMmdName(track.name))?.forEach((index) => {
          mmdModel?.morph.setMorphWeightFromIndex(index, weight);
        });
      });
      mmdModel.morph.update();
      applyImportedAndManual(animatedBoneIndices, animatedMorphIndices);
      // Always run the complete Babylon MMD evaluation stage. The runtime's
      // WASM pass is responsible for IK/append transforms and refreshing the
      // authoritative world matrices even when rigid-body physics is off.
      // `physics` is an operation-level choice (preview vs. physical pose),
      // while `physicsEnabledState` is the user-level capability switch.
      // Both must be true before any rigid body is allowed to become dynamic.
      physicsClock.deltaSeconds = physicsDelta;
      if (effectivePhysics && physicsInitializationPending) {
        mmdRuntime.initializeMmdModelPhysics(mmdModel);
      }
      mmdRuntime.beforePhysics(physicsDelta * 1000);
      mmdRuntime.afterPhysics();
      if (effectivePhysics && physicsInitializationPending) {
        physicsInitializationPending = false;
      }
      if (effectivePhysics) physicsStepActive = true;
      materialVisibility.applyAll();
      // A VMD property track can rewrite rigidBodyStates during animation.
      // The operation-level switch remains authoritative for preview and
      // snapshot generation, so force the disabled state back after evaluation.
      if (!effectivePhysics) mmdModel.rigidBodyStates.fill(0);
      skeleton?._markAsDirty();
    };

    const settlePhysics = () => {
      if (!mmdModel || !mmdRuntime) return;
      // The target pose is evaluated once with kinematic bodies before the
      // deterministic settle. Resetting after that evaluation prevents the
      // zero-delta evaluation from becoming an extra physics step.
      mmdModel.rigidBodyStates.fill(1);
      mmdRuntime.initializeMmdModelPhysics(mmdModel);
      physicsInitializationPending = false;
      const previousPhysicsDelta = physicsClock.deltaSeconds;
      physicsClock.deltaSeconds = BABYLON_PHYSICS_FIXED_STEP;
      try {
        for (let step = 0; step < BABYLON_PHYSICS_SETTLE_STEPS; step += 1) {
          mmdRuntime.beforePhysics(BABYLON_PHYSICS_FIXED_STEP * 1000);
          mmdRuntime.afterPhysics();
        }
      } finally {
        physicsClock.deltaSeconds = previousPhysicsDelta;
      }
      physicsStepActive = true;
    };

    const loadMotion = async (file: File, kind: MmdMotionTrackKind): Promise<MmdMotionTrackInfo> => {
      if (!active || !scene || !mmdModel) throw new Error("Babylon MMD model has been disposed");
      const animation = await new VmdLoader(scene).loadFromBufferAsync(file.name, await file.arrayBuffer());
      const boneNames = new Set(boneInfos.flatMap((bone) => [normalizeMmdName(bone.name), normalizeMmdName(bone.englishName)]));
      const morphNamesSet = new Set([...morphLookup.keys()]);
      const matchedBoneTrackCount = [...animation.boneTracks, ...animation.movableBoneTracks].filter((track) => trackHasBone(track, boneNames)).length;
      const matchedMorphTrackCount = animation.morphTracks.filter((track) => trackHasMorph(track, morphNamesSet)).length;
      if ((kind === "dance" ? matchedBoneTrackCount : matchedMorphTrackCount) === 0) throw appError("error.motion.noCompatibleTracks");
      if (kind === "dance") {
        if (dance.danceHandle !== null) mmdModel.destroyRuntimeAnimation(dance.danceHandle);
        const filtered = new MmdAnimation(
          `${kind}:${file.name}`,
          animation.boneTracks.filter((track) => trackHasBone(track, boneNames)),
          animation.movableBoneTracks.filter((track) => trackHasBone(track, boneNames)),
          [],
          animation.propertyTrack,
          animation.cameraTrack,
        );
        const retargetingMap = createRuntimeRetargetingMap(
          [...filtered.boneTracks, ...filtered.movableBoneTracks],
          filtered.propertyTrack.ikBoneNames,
          [],
          boneLookup,
          boneInfos,
          babylonBones,
          morphLookup,
          runtimeMorphs,
        );
        const handle = mmdModel.createRuntimeAnimation(filtered, retargetingMap);
        // Keep the handle bound as the model's current animation so the WASM
        // runtime owns the same animation state used by the renderer. Evaluation
        // remains explicit below because the application controls independent
        // dance/expression timelines and seeks by frame.
        mmdModel.setRuntimeAnimation(handle);
        dance = { info: null, animation: filtered, danceHandle: handle, expressionTracks: [] };
      } else {
        expression = { info: null, animation, danceHandle: null, expressionTracks: animation.morphTracks.filter((track) => trackHasMorph(track, morphNamesSet)) };
      }
      const info: MmdMotionTrackInfo = {
        kind,
        name: file.name.replace(/\.[^.]+$/, ""),
        modelName: animation.name,
        maxFrame: animation.endFrame,
        frameRate: 30,
        durationSeconds: animation.endFrame / 30,
        boneTrackCount: animation.boneTracks.length + animation.movableBoneTracks.length,
        morphTrackCount: animation.morphTracks.length,
        matchedBoneTrackCount,
        matchedMorphTrackCount,
      };
      if (kind === "dance") dance.info = info;
      else expression.info = info;
      evaluate(motionTimes, false);
      return info;
    };

    const viewport: BabylonMmdViewportSource = {
      kind: "babylon",
      canvas,
      engine,
      scene,
      camera,
      sourceRoot: rootMesh,
      sourceMeshes,
      resolveMaterialIndex: createBabylonMaterialIndexResolver(sourceMeshes, materials),
    };
    const stats: MmdModelStats = {
      name: metadata.header?.englishModelName || metadata.header?.modelName || modelFile.name,
      format: modelFile.name.toLowerCase().endsWith(".pmd") ? "pmd" : "pmx",
      vertexCount: sourceMeshes.reduce((sum, mesh) => sum + mesh.getTotalVertices(), 0),
      triangleCount: sourceMeshes.reduce((sum, mesh) => sum + Math.floor(mesh.getTotalIndices() / 3), 0),
      materialCount: materials.length,
      boneCount: boneInfos.length,
      morphCount: runtimeMorphs.length,
      rigidBodyCount: metadata.rigidBodies?.length ?? 0,
      jointCount: metadata.joints?.length ?? 0,
      textureWarnings: textureWarnings.length,
    };
    const visibleBounds = (target?: Box3) => {
      const matrices = mmdModel
        ? createBabylonSkinMatrices(mmdModel.worldTransformMatrices, babylonBones)
        : new Float32Array(babylonBones.length * 16);
      return computeBabylonVisibleBounds(
        rootMesh!,
        sourceMeshes,
        materials,
        materialVisibility,
        matrices,
        target ?? new Box3(),
      );
    };
    const pushHistory = (snapshot: Map<number, BabylonOffset> = manualOffsets) => {
      undoStack.push(cloneOffsets(snapshot));
      if (undoStack.length > 80) undoStack.shift();
      redoStack.length = 0;
    };

    const captureEditBase = (index: number) => {
      const bone = babylonBones[index];
      if (!bone) return false;
      const currentPosition = bone.position.clone();
      const currentRotation = getBoneRotation(bone);
      const existing = manualOffsets.get(index);
      if (existing) {
        currentPosition.subtractInPlace(existing.position);
        currentRotation.multiplyInPlace(existing.rotation.clone().invert()).normalize();
      }
      editBaseStates.set(index, { position: currentPosition, rotation: currentRotation });
      return true;
    };

    const captureEditOffset = (index: number) => {
      const bone = babylonBones[index];
      const base = editBaseStates.get(index);
      const info = boneInfos[index];
      if (!bone || !base || !info) return false;
      const next: BabylonOffset = {
        position: Vector3.Zero(),
        rotation: Quaternion.Identity(),
      };
      if (info.controlMode === "translate") {
        next.position.copyFrom(bone.position).subtractInPlace(base.position);
      } else {
        next.rotation.copyFrom(base.rotation).invertInPlace();
        next.rotation.multiplyInPlace(getBoneRotation(bone)).normalize();
      }
      const isIdentity = next.position.lengthSquared() <= 1e-12
        && Math.abs(next.rotation.x) <= 1e-6
        && Math.abs(next.rotation.y) <= 1e-6
        && Math.abs(next.rotation.z) <= 1e-6
        && Math.abs(Math.abs(next.rotation.w) - 1) <= 1e-6;
      if (isIdentity) manualOffsets.delete(index);
      else manualOffsets.set(index, next);
      return true;
    };

    const finishBoneEdit = (index: number) => {
      if (!editStart) return false;
      captureEditOffset(index);
      const before = editStart;
      editStart = null;
      editBaseStates.clear();
      if (offsetsEqual(before, manualOffsets)) return false;
      pushHistory(before);
      return true;
    };
    const resolvePose = (document: MelyPoseDocument) => {
      const missingBoneNames: string[] = [];
      const missingMorphNames: string[] = [];
      let appliedBoneCount = 0;
      let appliedMorphCount = 0;
      document.bones.forEach((entry) => {
        const index = boneLookup.get(normalizeMmdName(entry.name));
        if (index === undefined) { missingBoneNames.push(entry.name); return; }
        const position = threeToBabylonPosition(entry.pos);
        const rotation = reflectMmdQuaternionZ(entry.rot);
        importedBones[index] = {
          position: (restBones[index]?.position ?? Vector3.Zero()).add(new Vector3(...position)),
          rotation: (restBones[index]?.rotation ?? Quaternion.Identity()).multiply(new Quaternion(...rotation)),
        };
        appliedBoneCount += 1;
      });
      document.morphs?.forEach((entry) => {
        const indices = morphLookup.get(normalizeMmdName(entry.name));
        if (indices === undefined) { missingMorphNames.push(entry.name); return; }
        indices.forEach((index) => importedMorphs.set(index, entry.weight));
        appliedMorphCount += 1;
      });
      return { appliedBoneCount, missingBoneNames, appliedMorphCount, missingMorphNames };
    };
    const resolveManualOffsets = (document: MelyPoseDocument) => {
      const missingBoneNames: string[] = [];
      let appliedBoneCount = 0;
      document.bones.forEach((entry) => {
        const index = boneLookup.get(normalizeMmdName(entry.name));
        if (index === undefined) {
          missingBoneNames.push(entry.name);
          return;
        }
        manualOffsets.set(index, {
          position: new Vector3(...threeToBabylonPosition(entry.pos)),
          rotation: new Quaternion(...reflectMmdQuaternionZ(entry.rot)),
        });
        appliedBoneCount += 1;
      });
      return { appliedBoneCount, missingBoneNames };
    };
    const model: LoadedMmdModel = {
      id: crypto.randomUUID(),
      rendererMode: "babylon",
      fileName: modelFile.name,
      viewport,
      stats,
      textureWarnings,
      bones: boneInfos,
      morphNames,
      materials: materialInfo,
      translationStep: 0.15,
      physicsAvailable,
      physicsEnabled: () => Boolean(mmdModel && physicsAvailable && physicsEnabledState),
      setPhysicsEnabled: async (enabled) => {
        if (!mmdModel || !physicsAvailable) return;
        physicsEnabledState = enabled;
        if (enabled) {
          // Do not queue the reset before the kinematic preview pass: the
          // runtime would consume it with disabled bodies. The request is
          // consumed by the first live step or by settlePhysics instead.
          physicsInitializationPending = true;
        } else {
          // Process a reset while bodies are kinematic so disabling physics
          // cannot leave stale velocities, forces or dynamic transforms to be
          // reused when physics is enabled again.
          mmdRuntime?.initializeMmdModelPhysics(mmdModel);
          physicsInitializationPending = false;
          physicsStepActive = false;
        }
        // A zero-delta evaluation keeps every rigid body kinematic.
        evaluate(motionTimes, false);
      },
      setMaterialVisible: (index, visible) => {
        materialVisibility.setVisible(index, visible);
      },
      visibleBounds,
      visibleTriangleCount: () => sourceMeshes.reduce((sum, mesh) => {
        const sourcePositions = mesh.getPositionData(false, true);
        if (!sourcePositions) return sum;
        const sourceIndices = readIndices(mesh);
        const vertexCount = Math.floor(sourcePositions.length / 3);
        if (!Number.isSafeInteger(vertexCount) || vertexCount <= 0) return sum;
        let count = 0;
        visitBabylonVisibleTriangles(
          mesh,
          sourceIndices,
          vertexCount,
          materials,
          materialVisibility,
          () => { count += 1; },
        );
        return sum + count;
      }, 0),
      textureByteEstimate: () => {
        const seenTextures = new Set<BaseTexture>();
        return materials.reduce((sum, material, index) => {
          if (!materialVisibility.isRuntimeVisible(index)) return sum;
          const texture = materialTexture(material);
          if (!texture || seenTextures.has(texture)) return sum;
          seenTextures.add(texture);
          const size = textureSize(texture);
          return sum + (size ? size.width * size.height * 4 : 0);
        }, 0);
      },
      loadMotion,
      updatePreviewPose: (times) => { evaluate(times, false); return { ...motionTimes }; },
      updateLivePose: (times, deltaSeconds) => {
        evaluate(times, physicsEnabledState, deltaSeconds);
        return { ...motionTimes };
      },
      updatePose: (times) => {
        // Static seeks first evaluate with kinematic bodies. Physics is
        // advanced only by the explicit deterministic settle below.
        evaluate(times, false);
        if (physicsEnabledState && physicsAvailable) {
          settlePhysics();
        }
        return { ...motionTimes };
      },
      createSnapshot: async (options = {}) => {
        if (disposed) throw new Error("Babylon MMD model has been disposed");
        const runtimeModel = mmdModel;
        const runtime = mmdRuntime;
        if (!runtimeModel || !runtime) throw new Error("Babylon MMD model is unavailable");
        const skinMatrices = createBabylonSkinMatrices(runtimeModel.worldTransformMatrices, babylonBones);
        return createBabylonSnapshot(
          rootMesh!,
          sourceMeshes,
          materials,
          materialVisibility,
          skinMatrices,
          options,
        );
      },
      clearMotion: (kind) => {
        if (!kind || kind === "dance") {
          if (dance.danceHandle !== null && mmdModel) mmdModel.destroyRuntimeAnimation(dance.danceHandle);
          dance = emptyMotion();
        }
        if (!kind || kind === "expression") expression = emptyMotion();
        evaluate({ dance: 0, expression: 0 }, false);
      },
      beginBoneEdit: (index) => {
        if (!active || !babylonBones[index]) return;
        if (!editStart) editStart = cloneOffsets(manualOffsets);
        captureEditBase(index);
      },
      updateBoneEdit: (index) => {
        if (!active || !editStart || !babylonBones[index]) return;
        if (!editBaseStates.has(index)) captureEditBase(index);
        captureEditOffset(index);
        evaluate(motionTimes, physicsEnabledState);
      },
      endBoneEdit: (index) => finishBoneEdit(index),
      nudgeBone: (index, axis, amount) => {
        const bone = babylonBones[index];
        if (!bone || !Number.isFinite(amount) || amount === 0) return false;
        pushHistory();
        const offset = manualOffsets.get(index) ?? { position: Vector3.Zero(), rotation: Quaternion.Identity() };
        if (boneInfos[index]?.controlMode === "translate") {
          if (axis === "x") offset.position.x += amount;
          else if (axis === "y") offset.position.y += amount;
          else offset.position.z -= amount;
        } else {
          const direction = axis === "x"
            ? new Vector3(-1, 0, 0)
            : axis === "y"
              ? new Vector3(0, -1, 0)
              : Vector3.Forward();
          offset.rotation = offset.rotation.multiply(Quaternion.RotationAxis(direction, amount));
        }
        manualOffsets.set(index, offset);
        evaluate(motionTimes, physicsEnabledState);
        return true;
      },
      resetBone: (index) => {
        if (!manualOffsets.has(index)) return false;
        pushHistory();
        manualOffsets.delete(index);
        evaluate(motionTimes, physicsEnabledState);
        return true;
      },
      undoPose: () => {
        const previous = undoStack.pop();
        if (!previous) return false;
        redoStack.push(cloneOffsets(manualOffsets));
        manualOffsets.clear();
        cloneOffsets(previous).forEach((value, key) => manualOffsets.set(key, value));
        evaluate(motionTimes, physicsEnabledState);
        return true;
      },
      redoPose: () => {
        const next = redoStack.pop();
        if (!next) return false;
        undoStack.push(cloneOffsets(manualOffsets));
        manualOffsets.clear();
        cloneOffsets(next).forEach((value, key) => manualOffsets.set(key, value));
        evaluate(motionTimes, physicsEnabledState);
        return true;
      },
      resetPoseEdits: (recordHistory = true) => {
        if (!manualOffsets.size) return false;
        if (recordHistory) pushHistory();
        manualOffsets.clear();
        evaluate(motionTimes, physicsEnabledState);
        return true;
      },
      exportMelyPose: () => capturePoseDocument(boneInfos, restBones, babylonBones, [...manualOffsets.entries()]),
      importMelyPose: (document) => {
        importedBones.splice(0, importedBones.length, ...restBones.map((state) => ({ position: state.position.clone(), rotation: state.rotation.clone() })));
        importedMorphs.clear();
        manualOffsets.clear();
        importedPose = clonePoseDocument(document);
        const applied = resolvePose(document);
        evaluate(motionTimes, physicsEnabledState);
        return applied;
      },
      exportPoseTransferState: () => ({
        importedPose: clonePoseDocument(importedPose),
        manualOffsets: capturePoseDocument(boneInfos, restBones, babylonBones, [...manualOffsets.entries()]),
      }),
      importPoseTransferState: (state: MmdPoseTransferState) => {
        importedBones.splice(0, importedBones.length, ...restBones.map((value) => ({ position: value.position.clone(), rotation: value.rotation.clone() })));
        importedMorphs.clear();
        manualOffsets.clear();
        importedPose = clonePoseDocument(state.importedPose);
        const imported = state.importedPose ? resolvePose(state.importedPose) : { appliedBoneCount: 0, missingBoneNames: [], appliedMorphCount: 0, missingMorphNames: [] };
        const manual = resolveManualOffsets(state.manualOffsets);
        evaluate(motionTimes, physicsEnabledState);
        return {
          appliedBoneCount: imported.appliedBoneCount + manual.appliedBoneCount,
          missingBoneNames: [...imported.missingBoneNames, ...manual.missingBoneNames],
          appliedMorphCount: imported.appliedMorphCount,
          missingMorphNames: imported.missingMorphNames,
        };
      },
      poseState: (): MmdPoseState => ({ editCount: manualOffsets.size, canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 }),
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        active = false;
        try { mmdRuntime?.unregister(scene!); } catch { /* best effort */ }
        try { if (mmdModel && mmdRuntime) mmdRuntime.destroyMmdModel(mmdModel); } catch { /* best effort */ }
        try { mmdRuntime?.dispose(scene!); } catch { /* best effort */ }
        disposeMeshResources(container, scene!, rootMesh);
        try { engine?.stopRenderLoop(); } catch { /* best effort */ }
        try { engine?.dispose(); } catch { /* best effort */ }
        canvas?.remove();
        canvas = null;
        engine = null;
        scene = null;
        container = null;
        rootMesh = null;
        sourceMeshes = [];
        mmdRuntime = null;
        mmdModel = null;
      },
    };
    loadStage = "evaluate-initial-pose";
    evaluate({ dance: 0, expression: 0 }, false);
    return model;
  } catch (error) {
    const probeWindow = window as Window & { __MELY_E2E_RENDERER_DIAGNOSTICS__?: boolean };
    if (probeWindow.__MELY_E2E_RENDERER_DIAGNOSTICS__) {
      probeWindow.dispatchEvent(new CustomEvent("mely:babylon-load-error", {
        detail: {
          stage: loadStage,
          category: error instanceof Error ? "error" : "unknown",
        },
      }));
    }
    try { mmdRuntime?.dispose(scene!); } catch { /* best effort */ }
    disposeMeshResources(container, scene!, rootMesh);
    try { engine?.dispose(); } catch { /* best effort */ }
    canvas?.remove();
    throw appError("error.model.loadFailed", undefined, error);
  }
};
