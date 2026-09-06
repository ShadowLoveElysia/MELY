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
import { syncMmdUvMorphAttributes } from "./mmdUvMorphs";
import {
  collectVisibleMmdTriangles,
  createMmdMorphSplitBindings,
  mmdMaterialIsVisible,
  resolveMmdMorphSplitVertex,
  type MmdMorphSplitBindings,
} from "./threeMmdVisibleGeometry";
import {
  computeThreeMmdPosedVertex,
  createThreeMmdSkinningContext,
} from "./threeMmdSkinning";

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

const finiteVector = (value: THREE.Vector3) => (
  Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z)
);

const validAttributeIndex = (
  attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined,
  index: number,
) => Boolean(attribute && Number.isInteger(index) && index >= 0 && index < attribute.count);

const finiteMatrix = (matrix: THREE.Matrix4) => matrix.elements.every(Number.isFinite);

const materialIsVisible = mmdMaterialIsVisible;

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

const morphMeshForVertex = (
  mesh: THREE.SkinnedMesh,
  vertexIndex: number,
  sourceElementOffset: number,
  materialIndex: number,
  bindings: MmdMorphSplitBindings | undefined,
) => resolveMmdMorphSplitVertex(
  bindings,
  vertexIndex,
  sourceElementOffset,
  materialIndex,
) ?? { mesh, vertexIndex };

export const createMmdMeshSnapshot = async (
  model: ThreeMmdSnapshotSource,
  options: MmdSnapshotOptions = {},
): Promise<MmdMeshSnapshot> => {
  const mesh = model.mesh;
  // Snapshot UVs are read from live geometry attributes. Keep them in sync
  // here as well as after runtime updates so callers that changed morph
  // influences directly still capture the current UV expression.
  syncMmdUvMorphAttributes(model.root);
  const geometry = mesh.geometry;
  const position = geometry.getAttribute("position");
  if (!position || !Number.isInteger(position.count) || position.count <= 0) {
    throw appError("error.mesh.invalidVertices");
  }
  const triangles = collectVisibleMmdTriangles(mesh);
  if (triangles.indices.length === 0) throw appError("error.snapshot.noVisibleTriangles");
  const sourceVertexIndices = triangles.sourceVertexIndices;

  model.root.updateMatrixWorld(true);
  mesh.skeleton.update();
  mesh.skeleton.bones.forEach((bone) => bone.updateMatrixWorld(true));
  const faceFrame = createMmdFaceFrameSnapshot(model);
  const meshToRoot = new THREE.Matrix4()
    .copy(model.root.matrixWorld)
    .invert()
    .multiply(mesh.matrixWorld);
  const meshToRootByMesh = new Map<THREE.SkinnedMesh, THREE.Matrix4>([[mesh, meshToRoot]]);
  const transformForMesh = (candidate: THREE.SkinnedMesh) => {
    const cached = meshToRootByMesh.get(candidate);
    if (cached) return cached;
    const transform = new THREE.Matrix4()
      .copy(model.root.matrixWorld)
      .invert()
      .multiply(candidate.matrixWorld);
    meshToRootByMesh.set(candidate, transform);
    return transform;
  };

  if (!finiteMatrix(meshToRoot)) {
    throw appError("error.mesh.nonFiniteVertex");
  }
  const splitBindings = createMmdMorphSplitBindings(mesh);
  const skinningContexts = new Map<THREE.SkinnedMesh, ReturnType<typeof createThreeMmdSkinningContext>>();
  const contextFor = (candidate: THREE.SkinnedMesh) => {
    if (skinningContexts.has(candidate)) return skinningContexts.get(candidate);
    const context = createThreeMmdSkinningContext(candidate);
    skinningContexts.set(candidate, context);
    return context;
  };
  const positions = new Float32Array(sourceVertexIndices.length * 3);
  const posedPosition = new THREE.Vector3();

  for (let visibleVertexIndex = 0; visibleVertexIndex < sourceVertexIndices.length; visibleVertexIndex += 1) {
    if (visibleVertexIndex > 0 && visibleVertexIndex % SNAPSHOT_CHUNK_SIZE === 0) {
      throwIfCancelled(options);
      options.onProgress?.(visibleVertexIndex / sourceVertexIndices.length);
      await yieldToMainThread();
    }
    const vertexIndex = sourceVertexIndices[visibleVertexIndex];

    const sourceElementOffset = triangles.sourceElementOffsets[visibleVertexIndex] ?? vertexIndex;
    const materialIndex = triangles.sourceMaterialIndices[visibleVertexIndex] ?? 0;
    const morphSource = morphMeshForVertex(
      mesh,
      vertexIndex,
      sourceElementOffset,
      materialIndex,
      splitBindings,
    );
    const posed = computeThreeMmdPosedVertex(
      morphSource.mesh,
      morphSource.vertexIndex,
      posedPosition,
      contextFor(morphSource.mesh),
    );
    if (!posed) throw appError("error.mesh.invalidVertices");
    const meshToRootTransform = transformForMesh(morphSource.mesh);
    if (!finiteMatrix(meshToRootTransform)) throw appError("error.mesh.nonFiniteVertex");
    posed.applyMatrix4(meshToRootTransform);
    if (!finiteVector(posed)) throw appError("error.mesh.nonFiniteVertex");
    positions[visibleVertexIndex * 3] = posed.x;
    positions[visibleVertexIndex * 3 + 1] = posed.y;
    positions[visibleVertexIndex * 3 + 2] = posed.z;
  }

  throwIfCancelled(options);
  options.onProgress?.(1);
  const visibleTriangles = {
    indices: triangles.indices,
    triangleMaterials: triangles.triangleMaterials,
  };
  if (options.includeTextures === false) return { positions, ...visibleTriangles, faceFrame };
  const readUv = (visibleVertexIndex: number, sourceVertexIndex: number) => {
    const sourceElementOffset = triangles.sourceElementOffsets[visibleVertexIndex] ?? sourceVertexIndex;
    const materialIndex = triangles.sourceMaterialIndices[visibleVertexIndex] ?? 0;
    const source = morphMeshForVertex(
      mesh,
      sourceVertexIndex,
      sourceElementOffset,
      materialIndex,
      splitBindings,
    );
    const attribute = source.mesh.geometry.getAttribute("uv");
    if (!validAttributeIndex(attribute, source.vertexIndex)) return undefined;
    return [attribute.getX(source.vertexIndex), attribute.getY(source.vertexIndex)] as const;
  };
  const uvValues: Array<readonly [number, number] | undefined> = [];
  for (let index = 0; index < sourceVertexIndices.length; index += 1) {
    uvValues.push(readUv(index, sourceVertexIndices[index] ?? -1));
  }
  const uvs = uvValues.every((value): value is readonly [number, number] => Boolean(value))
    ? Float32Array.from(uvValues.reduce<number[]>((values, value) => {
        if (value) values.push(value[0], value[1]);
        return values;
      }, []))
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
