import type {
  BufferAttribute,
  InterleavedBufferAttribute,
  Object3D,
  SkinnedMesh,
} from "three";

type MmdUvAttribute = (BufferAttribute | InterleavedBufferAttribute) & {
  getComponent: (index: number, component: number) => number;
  setComponent: (index: number, component: number, value: number) => unknown;
};

const baseValues = new WeakMap<object, Float32Array>();

const isSkinnedMesh = (value: Object3D): value is SkinnedMesh => (
  (value as Object3D & { isSkinnedMesh?: boolean }).isSkinnedMesh === true
);

const isAttribute = (value: unknown): value is MmdUvAttribute => (
  Boolean(
    value
    && typeof value === "object"
    && typeof (value as { count?: unknown }).count === "number"
    && typeof (value as { itemSize?: unknown }).itemSize === "number"
    && typeof (value as { getComponent?: unknown }).getComponent === "function"
    && typeof (value as { setComponent?: unknown }).setComponent === "function",
  )
);

const originalValuesFor = (attribute: MmdUvAttribute) => {
  const cached = baseValues.get(attribute);
  if (cached && cached.length === attribute.count * attribute.itemSize) return cached;
  const original = new Float32Array(attribute.count * attribute.itemSize);
  for (let index = 0; index < attribute.count; index += 1) {
    for (let component = 0; component < attribute.itemSize; component += 1) {
      original[index * attribute.itemSize + component] = attribute.getComponent(index, component);
    }
  }
  baseValues.set(attribute, original);
  return original;
};

const finiteInfluenceSum = (influences: readonly number[]) => influences.reduce((sum, influence) => (
  Number.isFinite(influence) ? sum + influence : sum
), 0);

const syncMorphAttribute = (
  target: MmdUvAttribute,
  morphAttributes: readonly unknown[],
  influences: readonly number[],
  relative: boolean,
) => {
  const itemSize = target.itemSize;
  const original = originalValuesFor(target);
  if (original.length !== target.count * itemSize) return;
  const influenceSum = relative ? 0 : finiteInfluenceSum(influences);

  for (let index = 0; index < target.count; index += 1) {
    for (let component = 0; component < itemSize; component += 1) {
      let value = relative
        ? original[index * itemSize + component] ?? 0
        : (original[index * itemSize + component] ?? 0) * (1 - influenceSum);
      for (let morphIndex = 0; morphIndex < morphAttributes.length; morphIndex += 1) {
        const influence = influences[morphIndex] ?? 0;
        const morph = morphAttributes[morphIndex];
        if (!Number.isFinite(influence) || influence === 0 || !isAttribute(morph)) continue;
        if (morph.itemSize !== itemSize || index >= morph.count) continue;
        const morphValue = morph.getComponent(index, component);
        if (Number.isFinite(morphValue)) value += morphValue * influence;
      }
      target.setComponent(index, component, value);
    }
  }
  target.needsUpdate = true;
};

const syncSplitMorphInfluences = (mesh: SkinnedMesh) => {
  const sourceInfluences = mesh.morphTargetInfluences;
  const splitBodies = mesh.userData.mmdMorphSplitBodyMeshes;
  if (!sourceInfluences || !Array.isArray(splitBodies)) return;
  splitBodies.forEach((candidate) => {
    if (!isSkinnedMesh(candidate)) return;
    const morphTargetIndices = candidate.userData.mmdMorphSplitBody?.morphTargetIndices;
    const targetInfluences = candidate.morphTargetInfluences;
    if (!morphTargetIndices || !targetInfluences) return;
    targetInfluences.fill(0);
    for (let index = 0; index < morphTargetIndices.length && index < targetInfluences.length; index += 1) {
      const influence = sourceInfluences[morphTargetIndices[index] ?? -1] ?? 0;
      targetInfluences[index] = Number.isFinite(influence) ? influence : 0;
    }
  });
};

const syncMeshUvMorphs = (mesh: SkinnedMesh) => {
  syncSplitMorphInfluences(mesh);
  const influences = mesh.morphTargetInfluences;
  if (!influences) return;

  Object.entries(mesh.geometry.morphAttributes).forEach(([name, morphAttributes]) => {
    if (name !== "uv" && !/^uv\d+$/.test(name)) return;
    const target = mesh.geometry.getAttribute(name);
    if (!isAttribute(target) || !Array.isArray(morphAttributes)) return;
    syncMorphAttribute(target, morphAttributes, influences, mesh.geometry.morphTargetsRelative);
  });
};

/**
 * Three's built-in morph shader only applies position, normal, and color morphs.
 * MMD UV and Additional UV morphs are represented as geometry morph attributes,
 * so material sampling needs the evaluated values copied into the live attributes.
 */
export const syncMmdUvMorphAttributes = (root: Object3D) => {
  const meshes = new Set<SkinnedMesh>();
  root.traverse((object) => {
    if (isSkinnedMesh(object)) meshes.add(object);
  });

  // Morph-split bodies are kept in userData by the loader and can be detached
  // from the traversal root while still participating in rendering/snapshot
  // evaluation. Include them explicitly and avoid applying an attribute more
  // than once when a loader also attaches them as children.
  const pending = Array.from(meshes);
  for (let index = 0; index < pending.length; index += 1) {
    const mesh = pending[index];
    const splitBodies = mesh.userData.mmdMorphSplitBodyMeshes;
    if (!Array.isArray(splitBodies)) continue;
    splitBodies.forEach((candidate) => {
      if (!isSkinnedMesh(candidate) || meshes.has(candidate)) return;
      meshes.add(candidate);
      pending.push(candidate);
    });
  }
  meshes.forEach(syncMeshUvMorphs);
};
