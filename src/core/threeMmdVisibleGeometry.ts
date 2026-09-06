import type {
  BufferAttribute,
  InterleavedBufferAttribute,
  Material,
  SkinnedMesh,
} from "three";
import { mmdMaterialSuppressesColorAtAlpha } from "@yohawing/three-mmd-loader/three";

export interface VisibleMmdTriangles {
  /** Indices remapped to the compact visible-vertex list. */
  indices: Uint32Array;
  triangleMaterials: Uint16Array;
  /** Source position index for each compact visible vertex. */
  sourceVertexIndices: Uint32Array;
  /** Source index-buffer (or non-indexed vertex) offset for each compact vertex. */
  sourceElementOffsets: Uint32Array;
  /** Material index for each compact vertex. */
  sourceMaterialIndices: Uint16Array;
}

export interface MmdMorphSplitSourceGroup {
  start: number;
  count: number;
}

export interface MmdMorphSplitBodyBinding {
  mesh: SkinnedMesh;
  materialIndex: number;
  sourceGroup: MmdMorphSplitSourceGroup;
  sourceToLocal: ReadonlyMap<number, number>;
}

export interface MmdMorphSplitBindings {
  bodies: readonly MmdMorphSplitBodyBinding[];
}

type MmdIndexAttribute = BufferAttribute | InterleavedBufferAttribute;

/** Matches the renderability rule used by the Yohawing material synchronizer. */
export const mmdMaterialCanRender = (material: Material | undefined) => {
  if (!material) return false;
  const alpha = material.opacity ?? 0;
  const flags = material.userData.mmdMaterial?.flags as Parameters<
    typeof mmdMaterialSuppressesColorAtAlpha
  >[1] | undefined;
  return alpha > 0 || mmdMaterialSuppressesColorAtAlpha(alpha, flags);
};

/** Includes the user's explicit material visibility toggle. */
export const mmdMaterialIsVisible = (material: Material | undefined) => (
  Boolean(material?.visible && mmdMaterialCanRender(material))
);

const safeInteger = (value: number) => Number.isSafeInteger(value);

const sourceIndexAt = (
  sourceIndex: MmdIndexAttribute | undefined,
  offset: number,
) => sourceIndex ? sourceIndex.getX(offset) : offset;

const splitSourceVertexAt = (
  sourceIndex: MmdIndexAttribute | undefined,
  offset: number,
  elementOffset: number,
) => {
  if (!sourceIndex) return elementOffset;
  // createThreeBufferGeometry reverses the second and third index of every
  // triangle. Morph-split local vertices are allocated from the parser's
  // original winding, so restore that order while rebuilding sourceToLocal.
  const triangleOffset = elementOffset - offset;
  if (triangleOffset % 3 === 1) return sourceIndexAt(sourceIndex, offset + 2);
  if (triangleOffset % 3 === 2) return sourceIndexAt(sourceIndex, offset - 1);
  return sourceIndexAt(sourceIndex, elementOffset);
};

/**
 * Builds the exact triangle/vertex set rendered by the primary Three mesh.
 * Invalid faces are discarded before compact indices are written, avoiding
 * typed-array coercion of bad values into a valid vertex such as zero.
 */
export const collectVisibleMmdTriangles = (mesh: SkinnedMesh): VisibleMmdTriangles => {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute("position") as MmdIndexAttribute | undefined;
  if (!position || !safeInteger(position.count) || position.count <= 0) {
    return {
      indices: new Uint32Array(0),
      triangleMaterials: new Uint16Array(0),
      sourceVertexIndices: new Uint32Array(0),
      sourceElementOffsets: new Uint32Array(0),
      sourceMaterialIndices: new Uint16Array(0),
    };
  }

  const sourceIndex = geometry.getIndex() as MmdIndexAttribute | null;
  const elementCount = sourceIndex?.count ?? position.count;
  if (!safeInteger(elementCount) || elementCount < 0) {
    return {
      indices: new Uint32Array(0),
      triangleMaterials: new Uint16Array(0),
      sourceVertexIndices: new Uint32Array(0),
      sourceElementOffsets: new Uint32Array(0),
      sourceMaterialIndices: new Uint16Array(0),
    };
  }

  const materials = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]);
  const ranges = geometry.groups.length
    ? geometry.groups.map((group) => ({
        start: group.start,
        count: group.count,
        materialIndex: group.materialIndex ?? 0,
      }))
    : [{ start: 0, count: elementCount, materialIndex: 0 }];
  const sourceIndices: number[] = [];
  const sourceMaterials: number[] = [];
  const sourceElementOffsets: number[] = [];
  const sourceGroups: number[] = [];
  const splitBodies = mesh.userData.mmdMorphSplitBodyMeshes;
  const hasSplitBodies = Array.isArray(splitBodies)
    && splitBodies.some((candidate) => Boolean(
      candidate && typeof candidate === "object" && candidate.isSkinnedMesh,
    ));

  for (let rangeIndex = 0; rangeIndex < ranges.length; rangeIndex += 1) {
    const range = ranges[rangeIndex];
    const materialIndex = range.materialIndex;
    if (!safeInteger(materialIndex)
      || materialIndex < 0
      || materialIndex >= materials.length
      || materialIndex > 0xffff
      || !mmdMaterialIsVisible(materials[materialIndex])) continue;
    if (!safeInteger(range.start) || range.start < 0
      || !safeInteger(range.count) || range.count < 0
      || range.start > elementCount) continue;
    const count = Math.min(range.count, elementCount - range.start);
    const triangleCount = Math.floor(count / 3);
    for (let triangle = 0; triangle < triangleCount; triangle += 1) {
      const offset = range.start + triangle * 3;
      const first = sourceIndexAt(sourceIndex ?? undefined, offset);
      const second = sourceIndexAt(sourceIndex ?? undefined, offset + 1);
      const third = sourceIndexAt(sourceIndex ?? undefined, offset + 2);
      if (!safeInteger(first) || first < 0 || first >= position.count
        || !safeInteger(second) || second < 0 || second >= position.count
        || !safeInteger(third) || third < 0 || third >= position.count) continue;
      sourceIndices.push(first, second, third);
      sourceMaterials.push(materialIndex);
      sourceElementOffsets.push(offset, offset + 1, offset + 2);
      sourceGroups.push(rangeIndex, rangeIndex, rangeIndex);
    }
  }

  const indices = new Uint32Array(sourceIndices.length);
  // A source vertex can occur in more than one material group. Morph-split
  // bodies keep one local vertex per group, so the compact snapshot identity
  // must retain the source element offset as well as the source vertex index.
  const sourceToVisible = new Map<string, number>();
  const sourceVertexIndices: number[] = [];
  const visibleSourceElementOffsets: number[] = [];
  const sourceMaterialIndices: number[] = [];
  for (let offset = 0; offset < sourceIndices.length; offset += 1) {
    const sourceVertexIndex = sourceIndices[offset];
    const sourceMaterial = sourceMaterials[Math.floor(offset / 3)] ?? 0;
    const sourceGroup = sourceGroups[offset] ?? 0;
    const key = hasSplitBodies
      ? `${sourceGroup}:${sourceVertexIndex}`
      : `${sourceVertexIndex}`;
    let visibleVertexIndex = sourceToVisible.get(key);
    if (visibleVertexIndex === undefined) {
      visibleVertexIndex = sourceVertexIndices.length;
      sourceToVisible.set(key, visibleVertexIndex);
      sourceVertexIndices.push(sourceVertexIndex);
      visibleSourceElementOffsets.push(sourceElementOffsets[offset] ?? 0);
      sourceMaterialIndices.push(sourceMaterial);
    }
    indices[offset] = visibleVertexIndex;
  }

  return {
    indices,
    triangleMaterials: Uint16Array.from(sourceMaterials),
    sourceVertexIndices: Uint32Array.from(sourceVertexIndices),
    sourceElementOffsets: Uint32Array.from(visibleSourceElementOffsets),
    sourceMaterialIndices: Uint16Array.from(sourceMaterialIndices),
  };
};

export const countVisibleMmdTriangles = (mesh: SkinnedMesh) => (
  collectVisibleMmdTriangles(mesh).triangleMaterials.length
);

const validSourceGroup = (value: unknown): value is MmdMorphSplitSourceGroup => {
  if (!value || typeof value !== "object") return false;
  const sourceGroup = value as Partial<MmdMorphSplitSourceGroup>;
  return Number.isSafeInteger(sourceGroup.start)
    && (sourceGroup.start ?? -1) >= 0
    && Number.isSafeInteger(sourceGroup.count)
    && (sourceGroup.count ?? -1) >= 0;
};

const sourceGroupForBody = (
  mesh: SkinnedMesh,
  body: SkinnedMesh,
  materialIndex: number,
) => {
  const embedded = (body.geometry.userData.mmdMorphSplit as {
    sourceGroup?: unknown;
  } | undefined)?.sourceGroup;
  if (validSourceGroup(embedded)) return { group: embedded, parserWinding: true };
  const candidates = mesh.geometry.groups.filter((group) => group.materialIndex === materialIndex);
  return candidates.length === 1 && validSourceGroup(candidates[0])
    ? { group: candidates[0], parserWinding: false }
    : undefined;
};

/**
 * Builds the source-to-local maps used by morph-split render bodies. Keeping
 * one map per source group is important when a source vertex is shared by
 * multiple material groups with distinct local morph attributes.
 */
export const createMmdMorphSplitBindings = (
  mesh: SkinnedMesh,
): MmdMorphSplitBindings | undefined => {
  const candidates = mesh.userData.mmdMorphSplitBodyMeshes;
  if (!Array.isArray(candidates)) return undefined;
  const bodies = candidates.filter((candidate): candidate is SkinnedMesh => (
    Boolean(candidate && typeof candidate === "object" && candidate.isSkinnedMesh)
  ));
  if (!bodies.length) return undefined;

  const position = mesh.geometry.getAttribute("position") as MmdIndexAttribute | undefined;
  if (!position || !safeInteger(position.count) || position.count <= 0) return undefined;
  const sourceIndex = mesh.geometry.getIndex() as MmdIndexAttribute | null;
  const elementCount = sourceIndex?.count ?? position.count;
  const sourceVertexAt = (offset: number) => sourceIndex ? sourceIndex.getX(offset) : offset;
  const result: MmdMorphSplitBodyBinding[] = [];

  bodies.forEach((body) => {
    const materialIndex = body.userData.mmdMorphSplitBody?.materialIndex;
    if (!Number.isSafeInteger(materialIndex) || materialIndex < 0) return;
    const sourceGroupData = sourceGroupForBody(mesh, body, materialIndex);
    if (!sourceGroupData || sourceGroupData.group.start > elementCount) return;
    const sourceGroup = sourceGroupData.group;
    const count = Math.min(sourceGroup.count, elementCount - sourceGroup.start);
    const bodyPosition = body.geometry.getAttribute("position") as MmdIndexAttribute | undefined;
    if (!bodyPosition || !safeInteger(bodyPosition.count) || bodyPosition.count <= 0) return;
    const bodyElementCount = body.geometry.getIndex()?.count ?? bodyPosition.count;
    const sourceToLocal = new Map<number, number>();
    const mappedCount = Math.min(count, bodyElementCount);
    for (let localOffset = 0; localOffset < mappedCount; localOffset += 1) {
      const offset = sourceGroup.start + localOffset;
      const sourceVertex = sourceGroupData.parserWinding
        ? splitSourceVertexAt(sourceIndex ?? undefined, sourceGroup.start, offset)
        : sourceIndexAt(sourceIndex ?? undefined, offset);
      if (!safeInteger(sourceVertex) || sourceVertex < 0 || sourceVertex >= position.count) continue;
      // Rebuild the first-occurrence mapping from the source group instead of
      // reading the split geometry's reversed index buffer.
      const localIndex = sourceToLocal.size;
      if (localIndex >= bodyPosition.count) continue;
      if (!sourceToLocal.has(sourceVertex)) sourceToLocal.set(sourceVertex, localIndex);
    }
    if (sourceToLocal.size === 0) return;
    result.push({ mesh: body, materialIndex, sourceGroup, sourceToLocal });
  });

  return result.length > 0 ? { bodies: result } : undefined;
};

const sourceOffsetInGroup = (
  offset: number,
  group: MmdMorphSplitSourceGroup,
) => offset >= group.start && offset < group.start + group.count;

export const resolveMmdMorphSplitVertex = (
  bindings: MmdMorphSplitBindings | undefined,
  sourceVertexIndex: number,
  sourceElementOffset: number,
  materialIndex: number,
) => {
  if (!bindings) return undefined;
  const body = bindings.bodies.find((candidate) => (
    candidate.materialIndex === materialIndex
      && sourceOffsetInGroup(sourceElementOffset, candidate.sourceGroup)
  ));
  if (!body) return undefined;
  const localIndex = body.sourceToLocal.get(sourceVertexIndex);
  if (localIndex === undefined) return undefined;
  return { mesh: body.mesh, vertexIndex: localIndex };
};
