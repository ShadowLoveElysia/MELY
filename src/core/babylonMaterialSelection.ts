import type {
  Material,
  PickingInfo,
  TrianglePickingPredicate,
} from "@babylonjs/core";

export interface BabylonMaterialSelectionViewport {
  readonly sourceMeshes: readonly unknown[];
  resolveMaterialIndex: (mesh: unknown, subMeshId: number) => number | null;
}

export interface BabylonMaterialPointerCandidate {
  pointerId: number;
  clientX: number;
  clientY: number;
  dragged: boolean;
}

export const BABYLON_MATERIAL_CLICK_DRAG_THRESHOLD_PX = 4;

export const babylonMaterialPointerMovedPastThreshold = (
  candidate: BabylonMaterialPointerCandidate,
  event: Pick<PointerEvent, "clientX" | "clientY">,
) => Math.hypot(
  event.clientX - candidate.clientX,
  event.clientY - candidate.clientY,
) > BABYLON_MATERIAL_CLICK_DRAG_THRESHOLD_PX;

type BabylonMaterialLike = Material & { alpha?: number };

interface BabylonSubMeshLike {
  _id: number;
  materialIndex: number;
  indexStart: number;
  indexCount: number;
  getMaterial?: () => Material | null;
}

interface BabylonMeshLike {
  material: Material | null;
  subMeshes: BabylonSubMeshLike[];
  getIndices?: () => ArrayLike<number> | null;
}

const materialRuntimeVisible = (material: Material | null | undefined) => {
  if (!material) return false;
  const alpha = (material as BabylonMaterialLike).alpha;
  return Number.isFinite(alpha) ? Number(alpha) > 0.01 : true;
};

/** PickingInfo.subMeshId 是 Babylon 内部 `_id`，不保证等于数组下标。 */
export const findBabylonSubMeshById = (
  mesh: Pick<BabylonMeshLike, "subMeshes">,
  subMeshId: number,
) => mesh.subMeshes.find((subMesh) => subMesh._id === subMeshId) ?? null;

export const babylonPickMaterialVisible = (
  mesh: Pick<BabylonMeshLike, "subMeshes">,
  subMeshId: number,
) => materialRuntimeVisible(findBabylonSubMeshById(mesh, subMeshId)?.getMaterial?.());

const triangleKey = (first: number, second: number, third: number) => (
  `${first}:${second}:${third}`
);

/**
 * Babylon multiPick 每个 mesh 只保留最近三角形。因此用户隐藏必须在
 * 三角形相交阶段被排除，不能等拾取结果返回后再过滤。
 */
export const createBabylonVisibleMaterialTrianglePredicate = (
  mesh: BabylonMeshLike,
  viewport: BabylonMaterialSelectionViewport,
  materialCount: number,
  hiddenMaterialIndices: ReadonlySet<number>,
): TrianglePickingPredicate | null => {
  const indices = mesh.getIndices?.();
  if (!indices || mesh.subMeshes.length === 0) return null;

  const allowedTriangles = new Set<string>();
  mesh.subMeshes.forEach((subMesh) => {
    const materialIndex = viewport.resolveMaterialIndex(mesh, subMesh._id);
    if (
      materialIndex === null
      || !Number.isInteger(materialIndex)
      || materialIndex < 0
      || materialIndex >= materialCount
      || hiddenMaterialIndices.has(materialIndex)
      || !materialRuntimeVisible(subMesh.getMaterial?.())
    ) return;

    const end = Math.min(indices.length, subMesh.indexStart + subMesh.indexCount);
    for (let offset = subMesh.indexStart; offset + 2 < end; offset += 3) {
      allowedTriangles.add(triangleKey(
        Number(indices[offset]),
        Number(indices[offset + 1]),
        Number(indices[offset + 2]),
      ));
    }
  });

  // 可见组全部无效时仍返回拒绝 predicate，避免回退为整 mesh 可拾取。
  return (_p0, _p1, _p2, _ray, first, second, third) => (
    allowedTriangles.has(triangleKey(first, second, third))
  );
};

export const resolveBabylonMaterialPick = (
  picks: readonly PickingInfo[] | null | undefined,
  viewport: BabylonMaterialSelectionViewport,
  materialCount: number,
  hiddenMaterialIndices: ReadonlySet<number>,
) => {
  const sourceMeshes = new Set(viewport.sourceMeshes);
  const orderedPicks = [...(picks ?? [])].sort((left, right) => left.distance - right.distance);
  for (const pick of orderedPicks) {
    const mesh = pick.pickedMesh;
    if (!pick.hit || !mesh || !sourceMeshes.has(mesh)) continue;
    const materialIndex = viewport.resolveMaterialIndex(mesh, pick.subMeshId);
    if (
      materialIndex === null
      || !Number.isInteger(materialIndex)
      || materialIndex < 0
      || materialIndex >= materialCount
      || hiddenMaterialIndices.has(materialIndex)
    ) continue;
    if (!babylonPickMaterialVisible(mesh as BabylonMeshLike, pick.subMeshId)) continue;
    return materialIndex;
  }
  return null;
};
