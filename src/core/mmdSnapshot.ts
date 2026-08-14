import * as THREE from "three";
import { isSuggestedEmissiveMaterial } from "./mmdModel";
import type { MmdSnapshotOptions } from "./mmdRuntime";
import type {
  FaceFrameSnapshot,
  MeshMaterialSnapshot,
  MeshTextureSnapshot,
  MmdMeshSnapshot,
} from "../types";
import { appError } from "./appError";

type FourNumbers = [number, number, number, number];
type FourMatrices = [THREE.Matrix4, THREE.Matrix4, THREE.Matrix4, THREE.Matrix4];

export interface ThreeMmdSnapshotSource {
  root: THREE.Group;
  mesh: THREE.SkinnedMesh;
}

const SNAPSHOT_CHUNK_SIZE = 12_000;
export const MMD_SNAPSHOT_MAX_TEXTURE_EDGE = 512;
export const MMD_SNAPSHOT_TEXTURE_BUDGET = 64 * 1024 * 1024;
const FACE_FRAME_EPSILON = 1e-6;

const yieldToMainThread = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));

const throwIfCancelled = (options: MmdSnapshotOptions) => {
  if (!options.isCancelled?.()) return;
  const error = appError("error.snapshot.cancelled");
  error.name = "AbortError";
  throw error;
};

const normalizeBoneName = (value: string) => value
  .normalize("NFKC")
  .trim()
  .toLowerCase()
  .replace(/[\s_.:\-]+/g, "");

const boneNames = (bone: THREE.Bone) => [
  bone.name,
  typeof bone.userData.mmdBoneName === "string" ? bone.userData.mmdBoneName : "",
  typeof bone.userData.mmdEnglishBoneName === "string" ? bone.userData.mmdEnglishBoneName : "",
].map(normalizeBoneName).filter(Boolean);

const findBone = (bones: readonly THREE.Bone[], aliases: readonly string[]) => {
  const normalizedAliases = new Set(aliases.map(normalizeBoneName));
  return bones.find((bone) => boneNames(bone).some((name) => normalizedAliases.has(name)));
};

const vectorTuple = (vector: THREE.Vector3): [number, number, number] => [
  vector.x,
  vector.y,
  vector.z,
];

interface FaceBoneBinding {
  bone: THREE.Bone;
  inverse: THREE.Matrix4;
}

const faceBoneBinding = (
  bones: readonly THREE.Bone[],
  boneInverses: readonly THREE.Matrix4[],
  aliases: readonly string[],
): FaceBoneBinding | undefined => {
  const bone = findBone(bones, aliases);
  if (!bone) return undefined;
  const inverse = boneInverses[bones.indexOf(bone)];
  return inverse ? { bone, inverse } : undefined;
};

const matrixPosition = (matrix: THREE.Matrix4) =>
  new THREE.Vector3().setFromMatrixPosition(matrix);

const orthogonalize = (
  vector: THREE.Vector3,
  axes: readonly THREE.Vector3[],
) => {
  axes.forEach((axis) => vector.addScaledVector(axis, -vector.dot(axis)));
  const length = vector.length();
  return Number.isFinite(length) && length > FACE_FRAME_EPSILON
    ? vector.multiplyScalar(1 / length)
    : undefined;
};

export const createMmdFaceFrameSnapshot = (
  model: ThreeMmdSnapshotSource,
): FaceFrameSnapshot | undefined => {
  const bones = model.mesh.skeleton.bones;
  const boneInverses = model.mesh.skeleton.boneInverses;
  const leftEye = faceBoneBinding(
    bones,
    boneInverses,
    ["左目", "left eye", "eye left", "eye_l", "l eye"],
  );
  const rightEye = faceBoneBinding(
    bones,
    boneInverses,
    ["右目", "right eye", "eye right", "eye_r", "r eye"],
  );
  const head = faceBoneBinding(bones, boneInverses, ["頭", "head", "head bone"]);
  const neck = faceBoneBinding(bones, boneInverses, ["首", "neck", "neck bone"]);
  if (!leftEye || !rightEye || !head || !neck) return undefined;

  model.root.updateMatrixWorld(true);
  const rootWorldInverse = new THREE.Matrix4().copy(model.root.matrixWorld).invert();
  const rootPosition = (bone: THREE.Bone) => bone
    .getWorldPosition(new THREE.Vector3())
    .applyMatrix4(rootWorldInverse);
  const left = rootPosition(leftEye.bone);
  const rightEyePosition = rootPosition(rightEye.bone);
  const headPosition = rootPosition(head.bone);
  const origin = left.clone().add(rightEyePosition).multiplyScalar(0.5);
  const right = rightEyePosition.clone().sub(left);
  const eyeDistance = right.length();
  if (!Number.isFinite(eyeDistance) || eyeDistance <= FACE_FRAME_EPSILON) return undefined;
  right.multiplyScalar(1 / eyeDistance);

  const leftEyeRestMatrix = new THREE.Matrix4().copy(leftEye.inverse).invert();
  const rightEyeRestMatrix = new THREE.Matrix4().copy(rightEye.inverse).invert();
  const headRestMatrix = new THREE.Matrix4().copy(head.inverse).invert();
  const neckRestMatrix = new THREE.Matrix4().copy(neck.inverse).invert();
  const restLeft = matrixPosition(leftEyeRestMatrix);
  const restRightEye = matrixPosition(rightEyeRestMatrix);
  const restHead = matrixPosition(headRestMatrix);
  const restNeck = matrixPosition(neckRestMatrix);
  const restOrigin = restLeft.clone().add(restRightEye).multiplyScalar(0.5);
  const restRight = orthogonalize(restRightEye.clone().sub(restLeft), []);
  if (!restRight) return undefined;
  const restUp = orthogonalize(restHead.clone().sub(restNeck), [restRight]);
  if (!restUp) return undefined;
  const restForward = orthogonalize(
    new THREE.Vector3().crossVectors(restRight, restUp),
    [restRight, restUp],
  );
  if (!restForward) return undefined;
  const restForwardCue = restOrigin.clone().sub(restHead);
  orthogonalize(restForwardCue, [restRight, restUp]);
  if (
    restForwardCue.lengthSq() > FACE_FRAME_EPSILON * FACE_FRAME_EPSILON
    && restForward.dot(restForwardCue) < 0
  ) {
    restForward.negate();
  }

  // Map bind-world face directions through the head's current bind-relative transform,
  // then remove the model root transform to match CPU-skinned snapshot coordinates.
  const restToCurrentRoot = new THREE.Matrix4()
    .copy(rootWorldInverse)
    .multiply(head.bone.matrixWorld)
    .multiply(head.inverse);
  const predictedUp = restUp.clone().transformDirection(restToCurrentRoot);
  const predictedForward = restForward.clone().transformDirection(restToCurrentRoot);
  const up = orthogonalize(predictedUp, [right]);
  if (!up) return undefined;
  const forward = orthogonalize(predictedForward, [right, up]);
  if (!forward) return undefined;

  const forwardCue = origin.clone().sub(headPosition);
  forwardCue.addScaledVector(right, -forwardCue.dot(right));
  forwardCue.addScaledVector(up, -forwardCue.dot(up));
  const cueLength = forwardCue.length();
  if (!Number.isFinite(cueLength)) return undefined;
  if (cueLength > FACE_FRAME_EPSILON && forward.dot(forwardCue) < 0) forward.negate();

  const cueRatio = cueLength / eyeDistance;
  const confidence = THREE.MathUtils.clamp(0.6 + cueRatio * 0.8, 0.6, 1);
  return {
    origin: vectorTuple(origin),
    right: vectorTuple(right),
    up: vectorTuple(up),
    forward: vectorTuple(forward),
    eyeDistance,
    confidence,
  };
};

const readFourNumbers = (
  attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  index: number,
): FourNumbers => [
  attribute.getX(index),
  attribute.getY(index),
  attribute.getZ(index),
  attribute.getW(index),
];

const readVector3 = (
  attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  index: number,
  target: THREE.Vector3,
) => target.set(attribute.getX(index), attribute.getY(index), attribute.getZ(index));

const getMorphedPosition = (
  mesh: THREE.SkinnedMesh,
  vertexIndex: number,
  target: THREE.Vector3,
  base: THREE.Vector3,
  offset: THREE.Vector3,
  morphed: THREE.Vector3,
) => {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute("position");
  target.fromBufferAttribute(position, vertexIndex);

  const morphPositions = geometry.morphAttributes.position;
  const influences = mesh.morphTargetInfluences;
  if (!morphPositions?.length || !influences) return target;

  base.copy(target);
  offset.set(0, 0, 0);
  for (let morphIndex = 0; morphIndex < morphPositions.length; morphIndex += 1) {
    const influence = influences[morphIndex] ?? 0;
    if (influence === 0) continue;
    morphed.fromBufferAttribute(morphPositions[morphIndex], vertexIndex);
    if (!geometry.morphTargetsRelative) morphed.sub(base);
    offset.addScaledVector(morphed, influence);
  }
  return target.add(offset);
};

const materialIsVisible = (material: THREE.Material | undefined) =>
  Boolean(material?.visible && material.opacity > 0.01);

const collectVisibleTriangles = (mesh: THREE.SkinnedMesh) => {
  const geometry = mesh.geometry;
  const vertexCount = geometry.getAttribute("position").count;
  const sourceIndex = geometry.getIndex();
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const ranges = geometry.groups.length
    ? geometry.groups.map((group) => ({
        start: group.start,
        count: group.count,
        materialIndex: group.materialIndex ?? 0,
      }))
    : [{ start: 0, count: sourceIndex?.count ?? vertexCount, materialIndex: 0 }];
  const visibleRanges = ranges.flatMap((range) => {
    if (!materialIsVisible(materials[range.materialIndex] ?? materials[0])) return [];
    const end = Math.min(range.start + range.count, sourceIndex?.count ?? vertexCount);
    const triangleCount = Math.max(0, Math.floor((end - range.start) / 3));
    return triangleCount > 0 ? [{ ...range, triangleCount }] : [];
  });
  const triangleCount = visibleRanges.reduce((sum, range) => sum + range.triangleCount, 0);
  if (triangleCount === 0) throw appError("error.snapshot.noVisibleTriangles");
  const indices = new Uint32Array(triangleCount * 3);
  const triangleMaterials = new Uint16Array(triangleCount);
  let indexOffset = 0;
  let triangleOffset = 0;
  for (const range of visibleRanges) {
    for (let triangle = 0; triangle < range.triangleCount; triangle += 1) {
      const sourceOffset = range.start + triangle * 3;
      indices[indexOffset++] = sourceIndex ? sourceIndex.getX(sourceOffset) : sourceOffset;
      indices[indexOffset++] = sourceIndex ? sourceIndex.getX(sourceOffset + 1) : sourceOffset + 1;
      indices[indexOffset++] = sourceIndex ? sourceIndex.getX(sourceOffset + 2) : sourceOffset + 2;
      triangleMaterials[triangleOffset++] = range.materialIndex;
    }
  }
  const sourceToVisible = new Int32Array(vertexCount);
  sourceToVisible.fill(-1);
  const sourceVertexIndices: number[] = [];
  for (let offset = 0; offset < indices.length; offset += 1) {
    const sourceVertexIndex = indices[offset];
    let visibleVertexIndex = sourceToVisible[sourceVertexIndex];
    if (visibleVertexIndex < 0) {
      visibleVertexIndex = sourceVertexIndices.length;
      sourceToVisible[sourceVertexIndex] = visibleVertexIndex;
      sourceVertexIndices.push(sourceVertexIndex);
    }
    indices[offset] = visibleVertexIndex;
  }
  return {
    indices,
    triangleMaterials,
    sourceVertexIndices: Uint32Array.from(sourceVertexIndices),
  };
};

const textureImageSize = (image: unknown) => {
  if (!image || typeof image !== "object") return null;
  const candidate = image as {
    width?: number;
    height?: number;
    naturalWidth?: number;
    naturalHeight?: number;
    videoWidth?: number;
    videoHeight?: number;
  };
  const width = candidate.naturalWidth ?? candidate.videoWidth ?? candidate.width ?? 0;
  const height = candidate.naturalHeight ?? candidate.videoHeight ?? candidate.height ?? 0;
  return width > 0 && height > 0 ? { width, height } : null;
};

const captureDataTexture = (
  image: unknown,
  maxEdge: number,
  byteBudget: number,
): MeshTextureSnapshot | null => {
  if (!image || typeof image !== "object") return null;
  const candidate = image as { data?: ArrayLike<number>; width?: number; height?: number };
  if (!candidate.data || !candidate.width || !candidate.height) return null;
  const sourcePixelCount = candidate.width * candidate.height;
  const channels = Math.max(1, Math.round(candidate.data.length / sourcePixelCount));
  const budgetPixels = Math.max(1, Math.floor(byteBudget / 4));
  const scale = Math.min(
    1,
    maxEdge / Math.max(candidate.width, candidate.height),
    Math.sqrt(budgetPixels / sourcePixelCount),
  );
  const width = Math.max(1, Math.floor(candidate.width * scale));
  const height = Math.max(1, Math.floor(candidate.height * scale));
  const rgba = new Uint8ClampedArray(width * height * 4);
  const floatData = candidate.data instanceof Float32Array || candidate.data instanceof Float64Array;
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(candidate.height - 1, Math.floor((y + 0.5) / scale));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(candidate.width - 1, Math.floor((x + 0.5) / scale));
      const sourceOffset = (sourceY * candidate.width + sourceX) * channels;
      const targetOffset = (y * width + x) * 4;
      const read = (component: number, fallback: number) => {
        if (component >= channels) return fallback;
        const value = Number(candidate.data?.[sourceOffset + component] ?? fallback);
        return Math.max(0, Math.min(255, Math.round(floatData ? value * 255 : value)));
      };
      rgba[targetOffset] = read(0, 255);
      rgba[targetOffset + 1] = read(1, rgba[targetOffset]);
      rgba[targetOffset + 2] = read(2, rgba[targetOffset]);
      rgba[targetOffset + 3] = read(3, 255);
    }
  }
  return { width, height, pixels: rgba };
};

const captureTexture = (
  texture: THREE.Texture,
  maxEdge: number,
  byteBudget: number,
): MeshTextureSnapshot | null => {
  const sourceImage = texture.source.data ?? texture.image;
  const dataTexture = captureDataTexture(sourceImage, maxEdge, byteBudget);
  if (dataTexture) return dataTexture;
  const size = textureImageSize(sourceImage);
  if (!size) return null;
  const budgetPixels = Math.max(1, Math.floor(byteBudget / 4));
  const scale = Math.min(
    1,
    maxEdge / Math.max(size.width, size.height),
    Math.sqrt(budgetPixels / (size.width * size.height)),
  );
  const width = Math.max(1, Math.floor(size.width * scale));
  const height = Math.max(1, Math.floor(size.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  try {
    context.drawImage(sourceImage as CanvasImageSource, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    canvas.width = 1;
    canvas.height = 1;
    return { width, height, pixels };
  } catch {
    return null;
  }
};

const readMaterialSnapshot = (
  material: THREE.Material,
  hasTexture: boolean,
  textureIndex: number,
): MeshMaterialSnapshot => {
  const metadata = material.userData.mmdMaterial as {
    name?: string;
    englishName?: string;
    diffuse?: number[];
    ambient?: number[];
    emissive?: number[];
  } | undefined;
  const state = material.userData.mmdMaterialState as {
    diffuse?: number[];
    textureFactor?: number[];
    ambient?: number[];
    emissive?: number[];
  } | undefined;
  const liveMaterial = material as THREE.Material & {
    isMMDMaterial?: boolean;
    color?: THREE.Color;
    ambient?: THREE.Color;
    textureMultiplicativeColor?: THREE.Vector4;
    textureAdditiveColor?: THREE.Vector4;
  };
  const stateDiffuse = state?.diffuse;
  const isMoeruMaterial = liveMaterial.isMMDMaterial === true;
  const liveColor = liveMaterial.color?.clone().convertLinearToSRGB();
  const metadataDiffuse = metadata?.diffuse;
  const baseColor: [number, number, number, number] = stateDiffuse && stateDiffuse.length >= 4
    ? [stateDiffuse[0], stateDiffuse[1], stateDiffuse[2], stateDiffuse[3]]
    : isMoeruMaterial && liveColor
      ? [liveColor.r, liveColor.g, liveColor.b, material.opacity]
      : metadataDiffuse && metadataDiffuse.length >= 4
        ? [metadataDiffuse[0], metadataDiffuse[1], metadataDiffuse[2], metadataDiffuse[3]]
        : liveColor
          ? [liveColor.r, liveColor.g, liveColor.b, material.opacity]
          : [1, 1, 1, material.opacity];
  const factor = state?.textureFactor;
  const liveMultiplicative = liveMaterial.textureMultiplicativeColor;
  const textureFactor: [number, number, number, number] = factor && factor.length >= 4
    ? [factor[0], factor[1], factor[2], factor[3]]
    : liveMultiplicative
      ? [liveMultiplicative.x, liveMultiplicative.y, liveMultiplicative.z, liveMultiplicative.w]
    : [1, 1, 1, 1];
  const liveAdditive = liveMaterial.textureAdditiveColor;
  const textureAdditiveFactor: [number, number, number, number] = liveAdditive
    ? [liveAdditive.x, liveAdditive.y, liveAdditive.z, liveAdditive.w]
    : [0, 0, 0, 0];
  const ambientSource = state?.ambient;
  const liveAmbient = liveMaterial.ambient?.clone().convertLinearToSRGB();
  const metadataAmbient = metadata?.ambient;
  const ambient: [number, number, number] = ambientSource && ambientSource.length >= 3
    ? [ambientSource[0], ambientSource[1], ambientSource[2]]
    : isMoeruMaterial && liveAmbient
      ? [liveAmbient.r, liveAmbient.g, liveAmbient.b]
      : metadataAmbient && metadataAmbient.length >= 3
        ? [metadataAmbient[0], metadataAmbient[1], metadataAmbient[2]]
        : liveAmbient
          ? [liveAmbient.r, liveAmbient.g, liveAmbient.b]
          : [0, 0, 0];
  const name = metadata?.name || material.name || "";
  const englishName = metadata?.englishName || "";
  const map = "map" in material && material.map instanceof THREE.Texture ? material.map : null;
  if (map?.matrixAutoUpdate) map.updateMatrix();
  const matrix = map?.matrix.elements ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
  return {
    name,
    englishName,
    baseColor,
    textureFactor,
    textureAdditiveFactor,
    hasTexture,
    textureIndex,
    textureMatrix: [
      matrix[0], matrix[1], matrix[2],
      matrix[3], matrix[4], matrix[5],
      matrix[6], matrix[7], matrix[8],
    ],
    wrapS: map?.wrapS ?? THREE.ClampToEdgeWrapping,
    wrapT: map?.wrapT ?? THREE.ClampToEdgeWrapping,
    flipY: map?.flipY ?? false,
    ambient,
    emissive: isSuggestedEmissiveMaterial(
      name,
      englishName,
      state?.emissive ?? metadata?.emissive,
    ),
  };
};

const captureMaterials = (
  mesh: THREE.SkinnedMesh,
  maxTextureEdge: number,
  textureByteBudget: number,
) => {
  const materialList = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.Material[];
  const textureIndices = new Map<string, number>();
  const textures: MeshTextureSnapshot[] = [];
  let capturedTextureBytes = 0;
  const materials = materialList.map((material, materialIndex) => {
    const map = "map" in material && material.map instanceof THREE.Texture ? material.map : null;
    let textureIndex = -1;
    if (map && materialIsVisible(material)) {
      const cached = textureIndices.get(map.uuid);
      if (cached !== undefined) {
        textureIndex = cached;
      } else if (capturedTextureBytes < textureByteBudget) {
        const captured = captureTexture(
          map,
          maxTextureEdge,
          textureByteBudget - capturedTextureBytes,
        );
        if (captured) {
          textureIndex = textures.length;
          textures.push(captured);
          capturedTextureBytes += captured.pixels.byteLength;
          textureIndices.set(map.uuid, textureIndex);
        }
      }
    }
    if (map && materialIsVisible(material) && textureIndex < 0) {
      const metadata = material.userData.mmdMaterial as { name?: string } | undefined;
      throw appError("error.snapshot.textureCaptureFailed", {
        material: metadata?.name || material.name || materialIndex,
      });
    }
    return readMaterialSnapshot(material, map !== null, textureIndex);
  });
  return { materials, textures };
};

interface SplitMorphBindings {
  meshes: THREE.SkinnedMesh[];
  meshIndices: Int16Array;
  localIndices: Uint32Array;
}

const splitMorphBindings = (mesh: THREE.SkinnedMesh): SplitMorphBindings | undefined => {
  const candidates = mesh.userData.mmdMorphSplitBodyMeshes;
  if (!Array.isArray(candidates)) return undefined;
  const meshes = candidates.filter((candidate): candidate is THREE.SkinnedMesh =>
    Boolean(candidate && typeof candidate === "object" && candidate.isSkinnedMesh));
  if (!meshes.length || meshes.length >= 0x7fff) return undefined;
  const sourceIndex = mesh.geometry.getIndex();
  if (!sourceIndex) return undefined;
  const vertexCount = mesh.geometry.getAttribute("position").count;
  const meshIndices = new Int16Array(vertexCount);
  meshIndices.fill(-1);
  const localIndices = new Uint32Array(vertexCount);
  const seenAt = new Uint32Array(vertexCount);

  meshes.forEach((body, bodyIndex) => {
    const materialIndex = body.userData.mmdMorphSplitBody?.materialIndex;
    if (!Number.isInteger(materialIndex)) return;
    const group = mesh.geometry.groups.find((candidate) => candidate.materialIndex === materialIndex);
    if (!group) return;
    let localIndex = 0;
    const stamp = bodyIndex + 1;
    const end = Math.min(group.start + group.count, sourceIndex.count);
    for (let offset = group.start; offset < end; offset += 1) {
      const sourceVertex = sourceIndex.getX(offset);
      if (seenAt[sourceVertex] === stamp) continue;
      seenAt[sourceVertex] = stamp;
      if (meshIndices[sourceVertex] < 0) {
        meshIndices[sourceVertex] = bodyIndex;
        localIndices[sourceVertex] = localIndex;
      }
      localIndex += 1;
    }
  });
  return { meshes, meshIndices, localIndices };
};

const morphMeshForVertex = (
  mesh: THREE.SkinnedMesh,
  vertexIndex: number,
  bindings: SplitMorphBindings | undefined,
) => {
  if (!bindings) return { mesh, vertexIndex };
  const bodyIndex = bindings.meshIndices[vertexIndex];
  const body = bodyIndex >= 0 ? bindings.meshes[bodyIndex] : undefined;
  return body
    ? { mesh: body, vertexIndex: bindings.localIndices[vertexIndex] }
    : { mesh, vertexIndex };
};

export const createMmdMeshSnapshot = async (
  model: ThreeMmdSnapshotSource,
  options: MmdSnapshotOptions = {},
): Promise<MmdMeshSnapshot> => {
  const { computeMmdSdefSkinnedPosition, computeQdefSkinnedPosition } = await import(
    "@yohawing/three-mmd-loader"
  );
  const mesh = model.mesh;
  const geometry = mesh.geometry;
  const position = geometry.getAttribute("position");
  const skinIndex = geometry.getAttribute("skinIndex");
  const skinWeight = geometry.getAttribute("skinWeight");
  const sdefEnabled = geometry.getAttribute("matricesSdefEnabled")
    ?? geometry.getAttribute("mmdSdefMask");
  const sdefC = geometry.getAttribute("matricesSdefC")
    ?? geometry.getAttribute("mmdSdefC");
  const sdefRW0 = geometry.getAttribute("matricesSdefRW0")
    ?? geometry.getAttribute("mmdSdefRW0");
  const sdefRW1 = geometry.getAttribute("matricesSdefRW1")
    ?? geometry.getAttribute("mmdSdefRW1");
  const qdefEnabled = geometry.getAttribute("matricesQdefEnabled");
  const triangles = collectVisibleTriangles(mesh);
  const sourceVertexIndices = triangles.sourceVertexIndices;

  model.root.updateMatrixWorld(true);
  mesh.skeleton.update();
  mesh.skeleton.bones.forEach((bone) => bone.updateMatrixWorld(true));
  const faceFrame = createMmdFaceFrameSnapshot(model);
  const meshToRoot = new THREE.Matrix4()
    .copy(model.root.matrixWorld)
    .invert()
    .multiply(mesh.matrixWorld);

  const boneMatrices = mesh.skeleton.bones.map((bone, index) =>
    new THREE.Matrix4().multiplyMatrices(bone.matrixWorld, mesh.skeleton.boneInverses[index]),
  );
  const identityMatrix = new THREE.Matrix4();
  const splitBindings = splitMorphBindings(mesh);
  const positions = new Float32Array(sourceVertexIndices.length * 3);
  const morphedPosition = new THREE.Vector3();
  const morphBase = new THREE.Vector3();
  const morphOffset = new THREE.Vector3();
  const morphTarget = new THREE.Vector3();
  const linearSkinned = new THREE.Vector3();
  const sdefCenter = new THREE.Vector3();
  const sdefWeighted0 = new THREE.Vector3();
  const sdefWeighted1 = new THREE.Vector3();

  for (let visibleVertexIndex = 0; visibleVertexIndex < sourceVertexIndices.length; visibleVertexIndex += 1) {
    if (visibleVertexIndex > 0 && visibleVertexIndex % SNAPSHOT_CHUNK_SIZE === 0) {
      throwIfCancelled(options);
      options.onProgress?.(visibleVertexIndex / sourceVertexIndices.length);
      await yieldToMainThread();
    }
    const vertexIndex = sourceVertexIndices[visibleVertexIndex];

    const morphSource = morphMeshForVertex(mesh, vertexIndex, splitBindings);
    getMorphedPosition(
      morphSource.mesh,
      morphSource.vertexIndex,
      morphedPosition,
      morphBase,
      morphOffset,
      morphTarget,
    );
    let skinned: THREE.Vector3;

    if (skinIndex && skinWeight) {
      const boneIndices = readFourNumbers(skinIndex, vertexIndex);
      const weights = readFourNumbers(skinWeight, vertexIndex);
      const matrices = boneIndices.map((boneIndex) =>
        boneMatrices[Math.max(0, Math.min(boneMatrices.length - 1, Math.round(boneIndex)))]
          ?? identityMatrix,
      ) as FourMatrices;

      if ((qdefEnabled?.getX(vertexIndex) ?? 0) >= 0.5) {
        skinned = computeQdefSkinnedPosition({
          position: morphedPosition,
          skinWeights: weights,
          boneMatrices: matrices,
          bindMatrix: mesh.bindMatrix,
          bindMatrixInverse: mesh.bindMatrixInverse,
        });
      } else if ((sdefEnabled?.getX(vertexIndex) ?? 0) >= 0.5 && sdefC && sdefRW0 && sdefRW1) {
        skinned = computeMmdSdefSkinnedPosition({
          position: morphedPosition,
          skinWeights: weights,
          boneMatrices: matrices,
          sdefEnabled: 1,
          sdefC: readVector3(sdefC, vertexIndex, sdefCenter),
          sdefRW0: readVector3(sdefRW0, vertexIndex, sdefWeighted0),
          sdefRW1: readVector3(sdefRW1, vertexIndex, sdefWeighted1),
          bindMatrix: mesh.bindMatrix,
          bindMatrixInverse: mesh.bindMatrixInverse,
        });
      } else {
        skinned = mesh.applyBoneTransform(vertexIndex, linearSkinned.copy(morphedPosition)) as THREE.Vector3;
      }
    } else {
      skinned = linearSkinned.copy(morphedPosition);
    }

    skinned.applyMatrix4(meshToRoot);
    positions[visibleVertexIndex * 3] = skinned.x;
    positions[visibleVertexIndex * 3 + 1] = skinned.y;
    positions[visibleVertexIndex * 3 + 2] = skinned.z;
  }

  throwIfCancelled(options);
  options.onProgress?.(1);
  const visibleTriangles = {
    indices: triangles.indices,
    triangleMaterials: triangles.triangleMaterials,
  };
  if (options.includeTextures === false) return { positions, ...visibleTriangles, faceFrame };
  const uvAttribute = geometry.getAttribute("uv");
  const uvs = uvAttribute
    ? Float32Array.from({ length: sourceVertexIndices.length * 2 }, (_, offset) => {
        const sourceVertexIndex = sourceVertexIndices[Math.floor(offset / 2)];
        return offset % 2 === 0
          ? uvAttribute.getX(sourceVertexIndex)
          : uvAttribute.getY(sourceVertexIndex);
      })
    : undefined;
  const materialData = captureMaterials(
    mesh,
    Math.max(1, Math.min(MMD_SNAPSHOT_MAX_TEXTURE_EDGE, Math.floor(
      options.textureMaxEdge ?? MMD_SNAPSHOT_MAX_TEXTURE_EDGE,
    ))),
    Math.max(4, Math.min(MMD_SNAPSHOT_TEXTURE_BUDGET, Math.floor(
      options.textureByteBudget ?? MMD_SNAPSHOT_TEXTURE_BUDGET,
    ))),
  );
  return { positions, uvs, ...visibleTriangles, ...materialData, faceFrame };
};

export const releaseMmdMeshSnapshot = (snapshot: MmdMeshSnapshot) => {
  snapshot.positions = new Float32Array(0);
  snapshot.indices = new Uint32Array(0);
  snapshot.triangleMaterials = new Uint16Array(0);
  snapshot.uvs = undefined;
  snapshot.materials = undefined;
  snapshot.textures?.forEach((texture) => {
    texture.pixels = new Uint8ClampedArray(0);
  });
  snapshot.textures = undefined;
  snapshot.faceFrame = undefined;
};
