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
  MmdStandardMaterialBuilder,
  MmdStandardMaterialProxy,
  MmdWasmInstanceTypeSPR,
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
import { isSuggestedEmissiveMaterial, isSuggestedSkinMaterial } from "./mmdModel";

type BabylonModel = MmdWasmModel;
type BabylonRuntime = MmdWasmRuntimeType;
type RuntimeAnimation = IMmdRuntimeModelAnimation & {
  animation: MmdAnimationBase;
  wasmAnimate?: (frameTime: number) => void;
};

const BABYLON_PHYSICS_FIXED_STEP = 1 / 120;

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
    await super.loadToonTexture(...args);
    const [, material, materialInfo, imagePathTable, textureInfo] = args;
    const path = imagePathTable[textureInfo?.imagePathIndex ?? -1];
    if (
      !materialInfo.isSharedToonTexture
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
) => {
  const value = mesh.material;
  const slots = Array.isArray(value)
    ? value.filter((material): material is Material => Boolean(material))
    : materialSubMaterials(value);
  const candidate = slots[subMeshMaterialIndex] ?? slots[0] ?? (!Array.isArray(value) ? value : null);
  const identityIndex = candidate ? materials.indexOf(candidate) : -1;
  return identityIndex >= 0 ? identityIndex : Math.max(0, subMeshMaterialIndex);
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

const materialIsVisible = (material: Material | undefined) => {
  if (!material) return false;
  const alpha = (material as Material & { alpha?: number }).alpha;
  return Number.isFinite(alpha) ? (alpha as number) > 0.01 : true;
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
    if (texture && materialIsVisible(material)) {
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
    if (texture && materialIsVisible(material) && textureIndex < 0) {
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
  if (indices) return Uint32Array.from(indices as ArrayLike<number>);
  const count = mesh.getTotalVertices();
  return Uint32Array.from({ length: count }, (_value, index) => index);
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
  const weights = data.weights;
  const indices = data.indices;
  if (!weights || !indices) return target.copyFrom(position);
  const base = vertexIndex * 4;
  const sdefC = data.sdefC;
  const sdefRW0 = data.sdefRW0;
  const sdefRW1 = data.sdefRW1;
  // SDEF vectors are xyz tuples, while bone indices/weights remain vec4s.
  const sdefBase = vertexIndex * 3;
  // babylon-mmd uses RW0.x as the per-vertex linear-skinning sentinel.
  const sdef = sdefC && sdefRW0 && sdefRW1 && Math.abs(sdefRW0[sdefBase] ?? 0) > 1e-8;
  if (sdef) {
    const i0 = Math.round(Number(indices[base] ?? 0));
    const i1 = Math.round(Number(indices[base + 1] ?? 0));
    const w0 = Number(weights[base] ?? 0);
    const w1 = Number(weights[base + 1] ?? 0);
    const m0 = Matrix.FromArray(matrices, i0 * 16);
    const m1 = Matrix.FromArray(matrices, i1 * 16);
    const q0 = Quaternion.FromRotationMatrix(m0);
    const q1 = Quaternion.FromRotationMatrix(m1);
    const rotation = Quaternion.Slerp(q0, q1, w1);
    const rotationMatrix = Matrix.FromQuaternionToRef(rotation, Matrix.Identity());
    const c = new Vector3(sdefC[sdefBase] ?? 0, sdefC[sdefBase + 1] ?? 0, sdefC[sdefBase + 2] ?? 0);
    const rw0 = new Vector3(sdefRW0[sdefBase] ?? 0, sdefRW0[sdefBase + 1] ?? 0, sdefRW0[sdefBase + 2] ?? 0);
    const rw1 = new Vector3(sdefRW1[sdefBase] ?? 0, sdefRW1[sdefBase + 1] ?? 0, sdefRW1[sdefBase + 2] ?? 0);
    target.copyFrom(Vector3.TransformCoordinates(position.subtract(c), rotationMatrix));
    const p0 = Vector3.TransformCoordinates(rw0, m0);
    const p1 = Vector3.TransformCoordinates(rw1, m1);
    target.scaleInPlace(1);
    target.addInPlace(p0.scale(w0)).addInPlace(p1.scale(w1));
    return target;
  }
  target.set(0, 0, 0);
  const add = (slot: number, extra = false) => {
    const sourceIndex = extra ? data.extraIndices : indices;
    const sourceWeight = extra ? data.extraWeights : weights;
    if (!sourceIndex || !sourceWeight) return;
    const offset = extra ? vertexIndex * 4 : base;
    const weight = Number(sourceWeight[offset + slot] ?? 0);
    if (weight <= 0) return;
    const boneIndex = Math.max(0, Math.round(Number(sourceIndex[offset + slot] ?? 0)));
    const matrix = Matrix.FromArray(matrices, boneIndex * 16);
    const transformed = Vector3.TransformCoordinates(position, matrix);
    target.addInPlace(transformed.scale(weight));
  };
  for (let slot = 0; slot < 4; slot += 1) add(slot);
  if (mesh.numBoneInfluencers > 4) for (let slot = 0; slot < 4; slot += 1) add(slot, true);
  return target;
};

const createBabylonSkinMatrices = (
  worldTransformMatrices: Float32Array,
  bones: readonly Bone[],
) => {
  // babylon-mmd exposes MMD world matrices, while Babylon's shader skin
  // buffer is inverse-bind * world. Keep the CPU snapshot on that same path.
  const matrices = new Float32Array(worldTransformMatrices.length);
  const world = Matrix.Identity();
  const skin = Matrix.Identity();
  bones.forEach((bone, index) => {
    Matrix.FromArrayToRef(worldTransformMatrices, index * 16, world);
    bone.getAbsoluteInverseBindMatrix().multiplyToRef(world, skin);
    skin.copyToArray(matrices, index * 16);
  });
  return matrices;
};

const createBabylonSnapshot = async (
  rootMesh: Mesh,
  sourceMeshes: readonly Mesh[],
  materials: readonly Material[],
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
    if (!mesh.isVisible || mesh.visibility <= 0) continue;
    const sourcePositions = mesh.getPositionData(false, true);
    if (!sourcePositions) continue;
    const sourceUvs = mesh.getVerticesData(VertexBuffer.UVKind) as Float32Array | null;
    const morphedUvs = readMorphedUvs(mesh, sourceUvs);
    const skin = readSkinData(mesh);
    const matrices = skinMatrices;
    // Babylon's Matrix.multiply applies the left operand after the right
    // operand (A.multiply(B) yields B * A). Build root^-1 * meshWorld so the
    // CPU snapshot remains in the same root-relative space as the renderer.
    const meshToRoot = mesh.computeWorldMatrix(true).multiply(rootWorldInverse);
    const sourceIndices = readIndices(mesh);
    const groups = mesh.subMeshes?.length
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
    // Filter materials before emitting vertices. Keeping a vertex-only list
    // for hidden triangles would still expand the worker's bounds and change
    // the final normalization even though those triangles are not exported.
    const visibleGroups = groups.filter((group) => {
      const material = group.material;
      const candidate = materials[material] as (Material & { isDisposed?: () => boolean }) | undefined;
      return !candidate?.isDisposed?.() && materialIsVisible(candidate);
    });
    const vertexMap = new Map<number, number>();
    const emitVertex = (sourceIndex: number) => {
      const existing = vertexMap.get(sourceIndex);
      if (existing !== undefined) return existing;
      const position = new Vector3(
        sourcePositions[sourceIndex * 3] ?? 0,
        sourcePositions[sourceIndex * 3 + 1] ?? 0,
        sourcePositions[sourceIndex * 3 + 2] ?? 0,
      );
      skinPosition(position, sourceIndex, mesh, matrices, skin, temp);
      const rootRelative = Vector3.TransformCoordinates(temp, meshToRoot);
      const mapped = toMelyPosition(rootRelative.x, rootRelative.y, rootRelative.z);
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
    visibleGroups.forEach((group) => {
      const material = group.material;
      const end = Math.min(sourceIndices.length, group.start + group.count);
      for (let cursor = group.start; cursor + 2 < end; cursor += 3) {
        indices.push(
          emitVertex(sourceIndices[cursor] ?? 0),
          emitVertex(sourceIndices[cursor + 1] ?? 0),
          emitVertex(sourceIndices[cursor + 2] ?? 0),
        );
        triangleMaterials.push(Math.max(0, material));
      }
    });
  }
  if (!indices.length) throw appError("error.snapshot.noVisibleTriangles");
  options.onProgress?.(0.86);
  const materialData = options.includeTextures === false
    ? {}
    : await createBabylonMaterialSnapshots(materials, options);
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
  skinMatrices: Float32Array,
  target: Box3,
) => {
  target.makeEmpty();
  const rootWorldInverse = rootMesh.computeWorldMatrix(true).clone().invert();
  const temp = new Vector3();
  sourceMeshes.forEach((mesh) => {
    if (!mesh.isVisible || mesh.visibility <= 0) return;
    const sourcePositions = mesh.getPositionData(false, true);
    if (!sourcePositions) return;
    const skin = readSkinData(mesh);
    const meshToRoot = mesh.computeWorldMatrix(true).multiply(rootWorldInverse);
    const sourceIndices = readIndices(mesh);
    const groups = mesh.subMeshes?.length
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
    groups.forEach((group) => {
      const material = materials[group.material];
      if (!materialIsVisible(material)) return;
      const end = Math.min(sourceIndices.length, group.start + group.count);
      for (let cursor = group.start; cursor < end; cursor += 1) {
        const sourceIndex = sourceIndices[cursor] ?? 0;
        const position = new Vector3(
          sourcePositions[sourceIndex * 3] ?? 0,
          sourcePositions[sourceIndex * 3 + 1] ?? 0,
          sourcePositions[sourceIndex * 3 + 2] ?? 0,
        );
        skinPosition(position, sourceIndex, mesh, skinMatrices, skin, temp);
        const rootRelative = Vector3.TransformCoordinates(temp, meshToRoot);
        const mapped = toMelyPosition(rootRelative.x, rootRelative.y, rootRelative.z);
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
  try {
    canvas = document.createElement("canvas");
    canvas.width = 960;
    canvas.height = 540;
    engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
    SdefInjector.OverrideEngineCreateEffect(engine);
    scene = new Scene(engine);
    scene.clearColor = new Color4(0.04, 0.05, 0.06, 1);
    const camera = new ArcRotateCamera("mely-babylon-camera", -Math.PI / 2, Math.PI / 2.4, 45, new Vector3(0, 10, 0), scene);
    camera.minZ = 0.1;
    camera.maxZ = 20000;
    camera.attachControl(canvas, true);
    const light = new DirectionalLight("mely-babylon-key", new Vector3(-0.3, -1, -0.4), scene);
    light.intensity = 1.8;
    const hemi = new HemisphericLight("mely-babylon-hemi", new Vector3(0, 1, 0), scene);
    hemi.intensity = 0.65;
    const referenceBundle = createBabylonMmdReferenceFiles(files, modelFile);
    const textureWarnings = [...referenceBundle.warnings];
    const materialBuilder = new DiagnosticMmdMaterialBuilder(textureWarnings);

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
    loadedContainer.addAllToScene();
    rootMesh = getRootMesh(loadedContainer);
    sourceMeshes = getModelMeshes(rootMesh);
    wasmInstance = await GetMmdWasmInstance(new MmdWasmInstanceTypeSPR());
    const physicsClock: MutablePhysicsClock = {
      deltaSeconds: 0,
      getDeltaTime() {
        return this.deltaSeconds;
      },
    };
    const physicsBuilder = new ApplicationMmdWasmPhysics(scene, physicsClock);
    mmdRuntime = new MmdWasmRuntime(wasmInstance, null, physicsBuilder);
    const physicsAvailable = Boolean((rootMesh.metadata as { rigidBodies?: readonly unknown[] } | null)?.rigidBodies?.length);
    mmdModel = mmdRuntime.createMmdModel(rootMesh as never, {
      materialProxyConstructor: MmdStandardMaterialProxy,
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

    const metadata = (rootMesh.metadata ?? {}) as {
      header?: { modelName?: string; englishModelName?: string };
      bones?: readonly { name: string; englishName: string; parentBoneIndex: number; ik?: unknown }[];
      morphs?: readonly { name: string; englishName: string }[];
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
    const materials = [...new Set(sourceMeshes.flatMap(materialArray))];
    const textureNameMap = (rootMesh.metadata as {
      textureNameMap?: Map<BaseTexture, string>;
    } | null)?.textureNameMap;
    textureNameMap?.forEach((path, texture) => {
      if (texture.loadingError) textureWarnings.push(path || texture.name);
    });
    // Keep the loader-provided alpha separate from the application visibility
    // toggle. A hide/show cycle must not turn an originally translucent MMD
    // material into an opaque one.
    const materialBaseAlpha = new Map<Material, number>();
    materials.forEach((material) => {
      const alpha = (material as Material & { alpha?: number }).alpha;
      materialBaseAlpha.set(material, Number.isFinite(alpha) ? Number(alpha) : 1);
    });
    const materialInfo: MmdMaterialInfo[] = materials.map((material, index) => {
      const color = materialColor(material);
      const name = material.name || `material_${index}`;
      const texture = materialTexture(material);
      return {
        index,
        name,
        englishName: "",
        displayName: name,
        color: [color[0], color[1], color[2]],
        opacity: color[3],
        hasTexture: Boolean(texture),
        suggestedSkin: isSuggestedSkinMaterial(name, ""),
        ambient: [0, 0, 0],
        suggestedEmissive: isSuggestedEmissiveMaterial(name, "", undefined),
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
      const effectivePhysics = Boolean(physics && physicsEnabledState && physicsAvailable);
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
      const physicsDelta = Number.isFinite(physicsDeltaSeconds)
        ? Math.max(0, physicsDeltaSeconds)
        : 0;
      physicsClock.deltaSeconds = physicsDelta;
      mmdRuntime.beforePhysics(physicsDelta * 1000);
      mmdRuntime.afterPhysics();
      // A VMD property track can rewrite rigidBodyStates during animation.
      // The operation-level switch remains authoritative for preview and
      // snapshot generation, so force the disabled state back after evaluation.
      if (!effectivePhysics) mmdModel.rigidBodyStates.fill(0);
      skeleton?._markAsDirty();
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
        mmdModel.rigidBodyStates.fill(enabled ? 1 : 0);
        if (enabled) {
          mmdRuntime?.initializeMmdModelPhysics(mmdModel);
          mmdModel.initializePhysics();
        }
        evaluate(motionTimes, physicsEnabledState);
      },
      setMaterialVisible: (index, visible) => {
        const material = materials[index];
        if (!material) throw new RangeError(`MMD material index is out of range: ${index}`);
        (material as Material & { alpha?: number }).alpha = visible
          ? materialBaseAlpha.get(material) ?? 1
          : 0;
      },
      visibleBounds,
      visibleTriangleCount: () => sourceMeshes.reduce((sum, mesh) => {
        if (!mesh.isVisible || mesh.visibility <= 0) return sum;
        if (!mesh.subMeshes?.length) {
          return sum + (materialArray(mesh).some(materialIsVisible)
            ? Math.floor(mesh.getTotalIndices() / 3)
            : 0);
        }
        return sum + mesh.subMeshes.reduce((meshSum, subMesh) => (
          materialIsVisible(materials[materialIndexForSubMesh(mesh, subMesh.materialIndex, materials)])
            ? meshSum + Math.floor(subMesh.indexCount / 3)
            : meshSum
        ), 0);
      }, 0),
      textureByteEstimate: () => {
        const seenTextures = new Set<BaseTexture>();
        return materials.reduce((sum, material) => {
          if (!materialIsVisible(material)) return sum;
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
        evaluate(times, physicsEnabledState);
        if (physicsEnabledState && physicsAvailable) {
          mmdRuntime?.initializeMmdModelPhysics(mmdModel!);
          mmdModel?.initializePhysics();
          const previousPhysicsDelta = physicsClock.deltaSeconds;
          physicsClock.deltaSeconds = BABYLON_PHYSICS_FIXED_STEP;
          try {
            for (let step = 0; step < 120; step += 1) {
              mmdRuntime?.beforePhysics(BABYLON_PHYSICS_FIXED_STEP * 1000);
              mmdRuntime?.afterPhysics();
            }
          } finally {
            physicsClock.deltaSeconds = previousPhysicsDelta;
          }
        }
        return { ...motionTimes };
      },
      createSnapshot: async (options = {}) => {
        if (disposed) throw new Error("Babylon MMD model has been disposed");
        const runtimeModel = mmdModel;
        const runtime = mmdRuntime;
        if (!runtimeModel || !runtime) throw new Error("Babylon MMD model is unavailable");
        const skinMatrices = createBabylonSkinMatrices(runtimeModel.worldTransformMatrices, babylonBones);
        return createBabylonSnapshot(rootMesh!, sourceMeshes, materials, skinMatrices, options);
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
    evaluate({ dance: 0, expression: 0 }, false);
    return model;
  } catch (error) {
    try { mmdRuntime?.dispose(scene!); } catch { /* best effort */ }
    disposeMeshResources(container, scene!, rootMesh);
    try { engine?.dispose(); } catch { /* best effort */ }
    canvas?.remove();
    throw appError("error.model.loadFailed", undefined, error);
  }
};
