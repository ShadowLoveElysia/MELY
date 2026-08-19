import { Material } from "@babylonjs/core";

interface BabylonVisibilityMaterial extends Material {
  alpha: number;
  transparencyMode: number | null;
  renderOutline?: boolean;
  outlineAlpha?: number;
}

export interface BabylonMaterialDynamicState {
  alpha: number;
  transparencyMode: number | null;
  renderOutline: boolean;
  outlineAlpha: number;
  disableColorWrite: boolean;
  disableDepthWrite: boolean;
}

export interface BabylonMaterialVisibilityController {
  readonly hiddenMaterialIndices: ReadonlySet<number>;
  restoreDynamicState: (material: Material) => void;
  captureDynamicState: (material: Material) => void;
  applyMaterial: (material: Material) => void;
  applyAll: () => void;
  isUserVisible: (index: number) => boolean;
  isRuntimeVisible: (index: number) => boolean;
  setVisible: (index: number, visible: boolean) => void;
}

interface BabylonMaterialMetadataLike {
  materials?: readonly Material[];
}

interface BabylonSubMeshLike {
  _id: number;
  materialIndex: number;
}

interface BabylonMeshLike {
  material?: unknown;
  subMeshes?: readonly BabylonSubMeshLike[];
}

const subMaterials = (value: unknown): readonly (Material | null)[] => {
  if (!value || typeof value !== "object") return [];
  const candidates = (value as { subMaterials?: readonly (Material | null)[] }).subMaterials;
  return Array.isArray(candidates) ? candidates : [];
};

/** Prefer the loader's MMD order; runtime morphs use the same canonical array. */
export const resolveCanonicalBabylonMaterials = (
  metadata: BabylonMaterialMetadataLike | null | undefined,
  fallback: readonly Material[],
) => {
  const canonical = metadata?.materials?.filter(Boolean) ?? [];
  return canonical.length ? [...canonical] : [...new Set(fallback)];
};

export const createBabylonMaterialIndexResolver = (
  sourceMeshes: readonly BabylonMeshLike[],
  materials: readonly Material[],
) => {
  const sourceMeshSet = new Set<unknown>(sourceMeshes);
  const materialIndices = new Map(materials.map((material, index) => [material, index]));
  return (value: unknown, subMeshId: number): number | null => {
    if (!sourceMeshSet.has(value) || !Number.isInteger(subMeshId)) return null;
    const mesh = value as BabylonMeshLike;
    const subMesh = mesh.subMeshes?.find((candidate) => candidate._id === subMeshId);
    if (!subMesh) return null;
    const slots = subMaterials(mesh.material);
    const directMaterial = mesh.material as Material | null | undefined;
    const material = slots.length
      ? slots[subMesh.materialIndex]
      : subMesh.materialIndex === 0 && directMaterial && materials.includes(directMaterial)
        ? directMaterial
        : null;
    const index = material ? materialIndices.get(material) : undefined;
    return index === undefined ? null : index;
  };
};

const materialState = (material: Material): BabylonMaterialDynamicState => {
  const candidate = material as BabylonVisibilityMaterial;
  return {
    alpha: Number.isFinite(candidate.alpha) ? candidate.alpha : 1,
    transparencyMode: candidate.transparencyMode,
    renderOutline: candidate.renderOutline ?? false,
    outlineAlpha: Number.isFinite(candidate.outlineAlpha) ? Number(candidate.outlineAlpha) : 1,
    disableColorWrite: candidate.disableColorWrite,
    disableDepthWrite: candidate.disableDepthWrite,
  };
};

const applyDynamicState = (
  material: BabylonVisibilityMaterial,
  state: BabylonMaterialDynamicState,
) => {
  material.alpha = state.alpha;
  material.transparencyMode = state.transparencyMode;
  material.disableColorWrite = state.disableColorWrite;
  material.disableDepthWrite = state.disableDepthWrite;
  if (material.renderOutline !== undefined) material.renderOutline = state.renderOutline;
  if (material.outlineAlpha !== undefined) material.outlineAlpha = state.outlineAlpha;
};

/**
 * 用户隐藏是材质 Morph 之上的最终覆盖。禁用颜色和深度写入可跳过
 * MultiMaterial 的单个 submesh，而不会把共享它的整个 mesh 一起关闭。
 */
export const createBabylonMaterialVisibilityController = (
  materials: readonly Material[],
): BabylonMaterialVisibilityController => {
  const hiddenMaterialIndices = new Set<number>();
  const materialIndices = new Map(materials.map((material, index) => [material, index]));
  const dynamicStates = new Map(
    materials.map((material) => [material, materialState(material)]),
  );

  const requireIndex = (index: number) => {
    if (!Number.isInteger(index) || index < 0 || index >= materials.length) {
      throw new RangeError(`MMD material index is out of range: ${index}`);
    }
    return index;
  };

  const applyMaterial = (material: Material) => {
    const index = materialIndices.get(material);
    if (index === undefined) return;
    const candidate = material as BabylonVisibilityMaterial;
    const state = dynamicStates.get(material) ?? materialState(material);
    applyDynamicState(candidate, state);
    if (!hiddenMaterialIndices.has(index)) return;

    candidate.alpha = 0;
    candidate.transparencyMode = Material.MATERIAL_ALPHABLEND;
    candidate.disableColorWrite = true;
    candidate.disableDepthWrite = true;
    if (candidate.renderOutline !== undefined) candidate.renderOutline = false;
    if (candidate.outlineAlpha !== undefined) candidate.outlineAlpha = 0;
  };

  const captureDynamicState = (material: Material) => {
    const index = materialIndices.get(material);
    if (index === undefined) return;
    const next = materialState(material);
    const previous = dynamicStates.get(material);
    if (hiddenMaterialIndices.has(index) && previous) {
      // Proxy 不会重写这些静态开关，隐藏覆盖不能被误记成 Morph 状态。
      next.renderOutline = previous.renderOutline;
      next.disableColorWrite = previous.disableColorWrite;
      next.disableDepthWrite = previous.disableDepthWrite;
    }
    dynamicStates.set(material, next);
  };

  return {
    hiddenMaterialIndices,
    restoreDynamicState: (material) => {
      const state = dynamicStates.get(material);
      if (state) applyDynamicState(material as BabylonVisibilityMaterial, state);
    },
    captureDynamicState,
    applyMaterial,
    applyAll: () => materials.forEach(applyMaterial),
    isUserVisible: (index) => !hiddenMaterialIndices.has(requireIndex(index)),
    isRuntimeVisible: (index) => {
      const material = materials[requireIndex(index)];
      const state = dynamicStates.get(material);
      return !hiddenMaterialIndices.has(index) && (state?.alpha ?? 0) > 0.01;
    },
    setVisible: (index, visible) => {
      requireIndex(index);
      if (visible) hiddenMaterialIndices.delete(index);
      else hiddenMaterialIndices.add(index);
      applyMaterial(materials[index]);
    },
  };
};

type VisibilityProxyController = Pick<
  BabylonMaterialVisibilityController,
  "restoreDynamicState" | "captureDynamicState" | "applyMaterial"
>;

interface BabylonMaterialProxyLike {
  applyChanges(): void;
}

type BabylonMaterialProxyConstructor = new (...args: any[]) => BabylonMaterialProxyLike;

/** Bind an injected runtime material proxy to the controller created for this model. */
export const createBabylonVisibilityMaterialProxy = <
  BaseProxyConstructor extends BabylonMaterialProxyConstructor,
>(
  controller: VisibilityProxyController,
  BaseProxy: BaseProxyConstructor,
) => class BabylonVisibilityMaterialProxy extends BaseProxy {
  private readonly visibilityMaterial: Material;

  public constructor(...args: any[]) {
    super(...args);
    this.visibilityMaterial = args[0] as Material;
  }

  public override applyChanges() {
    controller.restoreDynamicState(this.visibilityMaterial);
    super.applyChanges();
    controller.captureDynamicState(this.visibilityMaterial);
    controller.applyMaterial(this.visibilityMaterial);
  }
};
