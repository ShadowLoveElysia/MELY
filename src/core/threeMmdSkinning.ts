import {
  Matrix4,
  Vector3,
  type BufferAttribute,
  type InterleavedBufferAttribute,
  type SkinnedMesh,
} from "three";
import {
  computeMmdSdefSkinnedPosition,
  computeQdefSkinnedPosition,
} from "@yohawing/three-mmd-loader/three";

type MmdAttribute = BufferAttribute | InterleavedBufferAttribute;

export interface ThreeMmdSkinningContext {
  readonly boneMatrices: readonly Matrix4[];
  readonly bindMatrix: Matrix4;
  readonly bindMatrixInverse: Matrix4;
}

const finiteVector = (value: Vector3) => (
  Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z)
);

const finiteMatrix = (value: Matrix4) => value.elements.every(Number.isFinite);

const validAttributeIndex = (attribute: MmdAttribute | undefined, index: number) => (
  Boolean(attribute && Number.isSafeInteger(index) && index >= 0 && index < attribute.count)
);

const readVector3 = (
  attribute: MmdAttribute,
  index: number,
  target: Vector3,
) => target.set(attribute.getX(index), attribute.getY(index), attribute.getZ(index));

const readMorphPosition = (
  mesh: SkinnedMesh,
  vertexIndex: number,
  target: Vector3,
  morphBase: Vector3,
  morphValue: Vector3,
) => {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute("position") as MmdAttribute | undefined;
  if (!position || !validAttributeIndex(position, vertexIndex)) return false;
  target.fromBufferAttribute(position, vertexIndex);
  if (!finiteVector(target)) return false;

  const morphPositions = geometry.morphAttributes.position;
  const influences = mesh.morphTargetInfluences;
  if (!morphPositions?.length || !influences) return true;

  morphBase.copy(target);
  morphValue.set(0, 0, 0);
  for (let morphIndex = 0; morphIndex < morphPositions.length; morphIndex += 1) {
    const influence = influences[morphIndex] ?? 0;
    if (!Number.isFinite(influence)) return false;
    if (influence === 0) continue;
    const morph = morphPositions[morphIndex] as MmdAttribute | undefined;
    if (!morph || !validAttributeIndex(morph, vertexIndex)) return false;
    readVector3(morph, vertexIndex, target);
    if (!finiteVector(target)) return false;
    if (!geometry.morphTargetsRelative) target.sub(morphBase);
    morphValue.addScaledVector(target, influence);
  }
  target.copy(morphBase).add(morphValue);
  return finiteVector(target);
};

const readFiniteScalar = (
  attribute: MmdAttribute | undefined,
  index: number,
) => {
  if (!attribute || !validAttributeIndex(attribute, index)) return undefined;
  const value = attribute.getX(index);
  return Number.isFinite(value) ? value : undefined;
};

const readFiniteVector3 = (
  attribute: MmdAttribute | undefined,
  index: number,
  target: Vector3,
) => {
  if (!attribute || !validAttributeIndex(attribute, index)) return false;
  readVector3(attribute, index, target);
  return finiteVector(target);
};

const identityMatrix = new Matrix4();

/**
 * Captures the current bone matrices used by Three's skinning shader. The
 * context is reusable for all vertices of one mesh until the pose changes.
 */
export const createThreeMmdSkinningContext = (
  mesh: SkinnedMesh,
): ThreeMmdSkinningContext | undefined => {
  const skinIndex = mesh.geometry.getAttribute("skinIndex");
  const skinWeight = mesh.geometry.getAttribute("skinWeight");
  if (!skinIndex && !skinWeight) return undefined;
  if (!skinIndex || !skinWeight) return undefined;

  const boneMatrices: Matrix4[] = [];
  for (let index = 0; index < mesh.skeleton.bones.length; index += 1) {
    const bone = mesh.skeleton.bones[index];
    const inverse = mesh.skeleton.boneInverses[index];
    if (!bone || !inverse) return undefined;
    const matrix = new Matrix4().multiplyMatrices(bone.matrixWorld, inverse);
    if (!finiteMatrix(matrix)) return undefined;
    boneMatrices.push(matrix);
  }
  if (!finiteMatrix(mesh.bindMatrix) || !finiteMatrix(mesh.bindMatrixInverse)) return undefined;
  return {
    boneMatrices,
    bindMatrix: mesh.bindMatrix,
    bindMatrixInverse: mesh.bindMatrixInverse,
  };
};

/**
 * Evaluates one vertex in the same order as the Yohawing Three material:
 * morphs, bind matrix, QDEF/SDEF/LBS, then bind-matrix inverse.
 *
 * Undefined is returned for malformed data so callers that enumerate visible
 * geometry can omit only the invalid vertex instead of manufacturing a point.
 */
export const computeThreeMmdPosedVertex = (
  mesh: SkinnedMesh,
  vertexIndex: number,
  target: Vector3,
  context: ThreeMmdSkinningContext | undefined = createThreeMmdSkinningContext(mesh),
) => {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute("position") as MmdAttribute | undefined;
  if (!validAttributeIndex(position, vertexIndex)) return undefined;

  const morphBase = new Vector3();
  const morphValue = new Vector3();
  if (!readMorphPosition(mesh, vertexIndex, target, morphBase, morphValue)) return undefined;

  const skinIndex = geometry.getAttribute("skinIndex") as MmdAttribute | undefined;
  const skinWeight = geometry.getAttribute("skinWeight") as MmdAttribute | undefined;
  if (!skinIndex && !skinWeight) return target;
  if (!skinIndex || !skinWeight || !context
    || !validAttributeIndex(skinIndex, vertexIndex)
    || !validAttributeIndex(skinWeight, vertexIndex)) return undefined;

  if (skinIndex.itemSize < 4 || skinWeight.itemSize < 4) return undefined;
  const weights = [
    skinWeight.getX(vertexIndex),
    skinWeight.getY(vertexIndex),
    skinWeight.getZ(vertexIndex),
    skinWeight.getW(vertexIndex),
  ];
  const boneIndices = [
    skinIndex.getX(vertexIndex),
    skinIndex.getY(vertexIndex),
    skinIndex.getZ(vertexIndex),
    skinIndex.getW(vertexIndex),
  ];
  let totalWeight = 0;
  let hasWeight = false;
  for (let slot = 0; slot < 4; slot += 1) {
    const weight = weights[slot];
    if (!Number.isFinite(weight) || weight < 0) return undefined;
    if (weight === 0) continue;
    hasWeight = true;
    totalWeight += weight;
    const boneIndex = boneIndices[slot];
    if (!Number.isSafeInteger(boneIndex)
      || boneIndex < 0
      || boneIndex >= context.boneMatrices.length) return undefined;
  }
  if (!hasWeight || !Number.isFinite(totalWeight) || totalWeight <= 1e-8) return undefined;

  const matrices = boneIndices.map((boneIndex, slot) => (
    weights[slot] === 0 ? identityMatrix : context.boneMatrices[boneIndex]
  )) as [Matrix4, Matrix4, Matrix4, Matrix4];
  if (matrices.some((matrix) => !matrix)) return undefined;

  const qdefEnabled = geometry.getAttribute("matricesQdefEnabled") as MmdAttribute | undefined;
  const sdefEnabled = (
    geometry.getAttribute("matricesSdefEnabled")
      ?? geometry.getAttribute("mmdSdefMask")
  ) as MmdAttribute | undefined;
  const qdef = qdefEnabled ? readFiniteScalar(qdefEnabled, vertexIndex) : 0;
  const sdef = sdefEnabled ? readFiniteScalar(sdefEnabled, vertexIndex) : 0;
  if (qdef === undefined || sdef === undefined) return undefined;

  const sdefCenter = new Vector3();
  const sdefWeighted0 = new Vector3();
  const sdefWeighted1 = new Vector3();
  if (qdef >= 0.5) {
    target.copy(computeQdefSkinnedPosition({
      position: target,
      skinWeights: weights as [number, number, number, number],
      boneMatrices: matrices,
      bindMatrix: context.bindMatrix,
      bindMatrixInverse: context.bindMatrixInverse,
    }));
  } else if (sdef >= 0.5) {
    const sdefC = geometry.getAttribute("matricesSdefC") as MmdAttribute | undefined
      ?? geometry.getAttribute("mmdSdefC") as MmdAttribute | undefined;
    const sdefRW0 = geometry.getAttribute("matricesSdefRW0") as MmdAttribute | undefined
      ?? geometry.getAttribute("mmdSdefRW0") as MmdAttribute | undefined;
    const sdefRW1 = geometry.getAttribute("matricesSdefRW1") as MmdAttribute | undefined
      ?? geometry.getAttribute("mmdSdefRW1") as MmdAttribute | undefined;
    if (!readFiniteVector3(sdefC, vertexIndex, sdefCenter)
      || !readFiniteVector3(sdefRW0, vertexIndex, sdefWeighted0)
      || !readFiniteVector3(sdefRW1, vertexIndex, sdefWeighted1)) return undefined;
    target.copy(computeMmdSdefSkinnedPosition({
      position: target,
      skinWeights: weights as [number, number, number, number],
      boneMatrices: matrices,
      sdefEnabled: 1,
      sdefC: sdefCenter,
      sdefRW0: sdefWeighted0,
      sdefRW1: sdefWeighted1,
      bindMatrix: context.bindMatrix,
      bindMatrixInverse: context.bindMatrixInverse,
    }));
  } else {
    const linear = new Matrix4();
    linear.elements.fill(0);
    for (let slot = 0; slot < 4; slot += 1) {
      const matrix = matrices[slot];
      const weight = weights[slot];
      for (let element = 0; element < 16; element += 1) {
        linear.elements[element] += matrix.elements[element] * weight;
      }
    }
    target.applyMatrix4(context.bindMatrix).applyMatrix4(linear).applyMatrix4(context.bindMatrixInverse);
  }
  return finiteVector(target) ? target : undefined;
};
