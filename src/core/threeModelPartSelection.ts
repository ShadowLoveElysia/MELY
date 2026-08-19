import * as THREE from "three";

const MATERIAL_VISIBILITY_EPSILON = 0.01;
export const THREE_MATERIAL_PICK_DRAG_THRESHOLD_PX = 4;

export interface ThreeMaterialPointerCandidate {
  pointerId: number;
  modelId: string;
  clientX: number;
  clientY: number;
  dragged: boolean;
}

interface PointerCandidateEvent {
  pointerId: number;
  button: number;
  clientX: number;
  clientY: number;
  isPrimary: boolean;
}

export const createThreeMaterialPointerCandidate = (
  event: PointerCandidateEvent,
  modelId: string,
): ThreeMaterialPointerCandidate | null => (
  event.isPrimary && event.button === 0
    ? {
        pointerId: event.pointerId,
        modelId,
        clientX: event.clientX,
        clientY: event.clientY,
        dragged: false,
      }
    : null
);

export const updateThreeMaterialPointerCandidate = (
  candidate: ThreeMaterialPointerCandidate,
  event: Pick<PointerCandidateEvent, "pointerId" | "clientX" | "clientY">,
) => {
  if (candidate.dragged || candidate.pointerId !== event.pointerId) return candidate;
  const deltaX = event.clientX - candidate.clientX;
  const deltaY = event.clientY - candidate.clientY;
  if (deltaX * deltaX + deltaY * deltaY <= THREE_MATERIAL_PICK_DRAG_THRESHOLD_PX ** 2) {
    return candidate;
  }
  return { ...candidate, dragged: true };
};

export const completesThreeMaterialPointerClick = (
  candidate: ThreeMaterialPointerCandidate | null,
  event: Pick<PointerCandidateEvent, "pointerId" | "button" | "clientX" | "clientY" | "isPrimary">,
) => Boolean(
  candidate
  && candidate.pointerId === event.pointerId
  && event.isPrimary
  && event.button === 0
  // pointermove may be coalesced or skipped, so the release position must also
  // participate in drag detection before a gesture is accepted as a click.
  && !updateThreeMaterialPointerCandidate(candidate, event).dragged
);

type ThreeMaterialIntersection = Pick<
  THREE.Intersection<THREE.Object3D>,
  "distance" | "face" | "faceIndex" | "object"
>;

const isSkinnedMesh = (value: unknown): value is THREE.SkinnedMesh => Boolean(
  value
  && typeof value === "object"
  && (value as { isSkinnedMesh?: boolean }).isSkinnedMesh,
);

const canonicalOverride = (mesh: THREE.SkinnedMesh) => {
  const splitIndex = mesh.userData.mmdMorphSplitBody?.materialIndex;
  if (Number.isInteger(splitIndex)) return splitIndex as number;

  const proxyIndex = mesh.userData.mmdMaterialRenderProxy?.materialIndex;
  return Number.isInteger(proxyIndex) ? proxyIndex as number : null;
};

const meshIsSelectionSource = (mesh: THREE.SkinnedMesh) => !(
  mesh.userData.mmdOutlineProxy
  || mesh.userData.mmdShadowOnlyRenderProxy
  || mesh.userData.melyMmdSelectionOutlineProxy
);

/**
 * Recursively collects actual MMD body meshes. Vanilla's large-model path can
 * leave the primary mesh draw range empty and render one morph-split body per
 * material, so the primary mesh alone is not a sufficient raycast target.
 */
export const collectThreeMmdMaterialPickMeshes = (
  root: THREE.Object3D,
  primaryMesh: THREE.SkinnedMesh,
) => {
  const meshes: THREE.SkinnedMesh[] = [];
  const seen = new Set<string>();
  const add = (candidate: unknown) => {
    if (!isSkinnedMesh(candidate) || !meshIsSelectionSource(candidate)) return;
    if (seen.has(candidate.uuid)) return;
    seen.add(candidate.uuid);
    meshes.push(candidate);
  };

  root.traverse(add);
  add(primaryMesh);
  const splitBodies = primaryMesh.userData.mmdMorphSplitBodyMeshes;
  if (Array.isArray(splitBodies)) splitBodies.forEach(add);
  return meshes;
};

const faceMaterialIndex = (intersection: ThreeMaterialIntersection) => {
  const directIndex = intersection.face?.materialIndex;
  if (Number.isInteger(directIndex)) return directIndex as number;
  if (!Number.isInteger(intersection.faceIndex)) return null;

  const offset = (intersection.faceIndex as number) * 3;
  const geometry = (intersection.object as THREE.Mesh).geometry;
  const group = geometry.groups.find((candidate) => (
    offset >= candidate.start && offset < candidate.start + candidate.count
  ));
  return group?.materialIndex ?? (geometry.groups.length === 0 ? 0 : null);
};

export const canonicalThreeMmdMaterialIndex = (
  intersection: ThreeMaterialIntersection,
) => {
  if (!isSkinnedMesh(intersection.object)) return null;
  return canonicalOverride(intersection.object) ?? faceMaterialIndex(intersection);
};

const objectHierarchyIsVisible = (object: THREE.Object3D) => {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (!current.visible) return false;
    current = current.parent;
  }
  return true;
};

export const threeMmdMaterialIsSelectable = (
  material: THREE.Material | undefined,
  materialIndex: number,
  materialCount: number,
  hiddenMaterialIndices: ReadonlySet<number>,
) => {
  const surface = material as (THREE.Material & { wireframe?: boolean }) | undefined;
  return Boolean(
    Number.isInteger(materialIndex)
    && materialIndex >= 0
    && materialIndex < materialCount
    && !hiddenMaterialIndices.has(materialIndex)
    && surface?.visible
    && surface.opacity > MATERIAL_VISIBILITY_EPSILON
    && surface.colorWrite
  );
};

/** Returns the nearest visible canonical material while allowing hidden hits to pass through. */
export const resolveThreeMmdMaterialHit = (
  intersections: readonly ThreeMaterialIntersection[],
  canonicalMaterials: readonly THREE.Material[],
  hiddenMaterialIndices: ReadonlySet<number>,
) => {
  const ordered = intersections.length > 1
    ? [...intersections].sort((left, right) => left.distance - right.distance)
    : intersections;
  for (const intersection of ordered) {
    if (!isSkinnedMesh(intersection.object) || !meshIsSelectionSource(intersection.object)) continue;
    if (!objectHierarchyIsVisible(intersection.object)) continue;
    const materialIndex = canonicalThreeMmdMaterialIndex(intersection);
    if (materialIndex === null) continue;
    if (!threeMmdMaterialIsSelectable(
      canonicalMaterials[materialIndex],
      materialIndex,
      canonicalMaterials.length,
      hiddenMaterialIndices,
    )) continue;
    return materialIndex;
  }
  return null;
};

export const materialListForThreeMmdMesh = (mesh: THREE.SkinnedMesh) => (
  (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.Material[]
);
