import {
  Color3,
  Constants,
  Material,
  Mesh,
  MultiMaterial,
  SceneComponentConstants,
  SubMesh,
  type BaseTexture,
  type Scene,
} from "@babylonjs/core";
import { MmdOutlineRenderer, MmdStandardMaterial } from "babylon-mmd";
import type { BabylonMmdViewportSource } from "./mmdRuntime";

interface BabylonSelectionOutline {
  setSelection: (materialIndex: number | null, visible: boolean) => void;
  sync: () => void;
  dispose: () => void;
}

class BabylonSelectionOutlineRenderer extends MmdOutlineRenderer {
  public override name = "MelySelectionOutline";

  private disposed = false;

  public override register() {
    if (this.disposed) return;
    this.scene._afterRenderingMeshStage.registerStep(
      SceneComponentConstants.STEP_AFTERRENDERINGMESH_OUTLINE,
      this,
      this.renderSelectionOutline,
    );
  }

  private renderSelectionOutline(
    mesh: Mesh,
    subMesh: SubMesh,
    batch: Parameters<MmdOutlineRenderer["render"]>[1],
  ) {
    const metadata = mesh.metadata as { melySelectionProxy?: boolean } | null;
    if (!metadata?.melySelectionProxy) return;
    const material = subMesh.getMaterial();
    if (!(material instanceof MmdStandardMaterial)) return;

    const engine = this.scene.getEngine();
    const depthState = engine.depthCullingState;
    const savedDepthState = {
      cull: depthState.cull,
      cullFace: depthState.cullFace,
      depthFunc: depthState.depthFunc,
      depthMask: depthState.depthMask,
      depthTest: depthState.depthTest,
      frontFace: depthState.frontFace,
      zOffset: depthState.zOffset,
      zOffsetUnits: depthState.zOffsetUnits,
    };
    const savedAlphaMode = engine.getAlphaMode();
    const savedAlphaBlend = engine.alphaState.alphaBlend;
    const savedColorWrite = engine.getColorWrite();

    try {
      engine.setColorWrite(true);
      engine.setDepthBuffer(true);
      engine.setDepthWrite(false);
      engine.setAlphaMode(Constants.ALPHA_COMBINE, true);
      engine.setState(
        true,
        undefined,
        true,
        false,
        this.scene._mirroredCameraPosition ? true : false,
      );
      super.render(subMesh, batch);
    } finally {
      engine.setAlphaMode(savedAlphaMode, true);
      engine.alphaState.setAlphaBlend(savedAlphaBlend);
      engine.setColorWrite(savedColorWrite);
      depthState.cull = savedDepthState.cull;
      depthState.cullFace = savedDepthState.cullFace;
      depthState.depthFunc = savedDepthState.depthFunc;
      depthState.depthMask = savedDepthState.depthMask;
      depthState.depthTest = savedDepthState.depthTest;
      depthState.frontFace = savedDepthState.frontFace;
      depthState.zOffset = savedDepthState.zOffset;
      depthState.zOffsetUnits = savedDepthState.zOffsetUnits;
    }
  }

  public override dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const stage = this.scene._afterRenderingMeshStage;
    for (let index = stage.length - 1; index >= 0; index -= 1) {
      if (stage[index]?.component === this) stage.splice(index, 1);
    }
    super.dispose();
  }
}

/**
 * 选择层只克隆目标 submesh；几何、骨骼和 Morph manager 与源 mesh 共享，
 * 因此动画与 SDEF/Morph 会与正文保持同步，也不会进入 runtime 快照。
 */
export const createBabylonSelectionOutline = (
  scene: Scene,
  viewport: BabylonMmdViewportSource,
): BabylonSelectionOutline => {
  const selectionRenderer = new BabylonSelectionOutlineRenderer(scene);
  const outlineMultiMaterial = new MultiMaterial("mely-selection-outline-multi", scene);
  const outlineMaterials = new Map<Material, MmdStandardMaterial>();
  let disposed = false;

  const selectionMaterialFor = (sourceMaterial: Material | null, sourceMesh: Mesh) => {
    if (!sourceMaterial) return null;
    const existing = outlineMaterials.get(sourceMaterial);
    if (existing) return existing;
    const material = new MmdStandardMaterial(
      `mely-selection-outline-material-${outlineMaterials.size}`,
      scene,
    );
    const sourceWithAlpha = sourceMaterial as Material & {
      diffuseTexture?: BaseTexture | null;
      useAlphaFromDiffuseTexture?: boolean;
      alphaCutOff?: number;
      needAlphaTesting?: () => boolean;
      needAlphaTestingForMesh?: (mesh: Mesh) => boolean;
      getAlphaTestTexture?: () => BaseTexture | null;
    };
    material.alpha = 1;
    material.diffuseColor = Color3.White();
    material.emissiveColor = Color3.White();
    material.specularColor = Color3.Black();
    material.disableLighting = true;
    material.disableColorWrite = true;
    material.disableDepthWrite = true;
    material.backFaceCulling = true;
    material.renderOutline = false;
    material.outlineColor = new Color3(1, 0.72, 0.16);
    material.outlineWidth = 1.25;
    material.outlineAlpha = 1;
    const needsAlphaTest = sourceWithAlpha.needAlphaTestingForMesh?.(sourceMesh)
      ?? sourceWithAlpha.needAlphaTesting?.()
      ?? false;
    const alphaTestTexture = needsAlphaTest
      ? sourceWithAlpha.getAlphaTestTexture?.()
        ?? sourceWithAlpha.diffuseTexture
        ?? null
      : null;
    if (alphaTestTexture) {
      material.diffuseTexture = alphaTestTexture;
      material.useAlphaFromDiffuseTexture = sourceWithAlpha.useAlphaFromDiffuseTexture
        ?? true;
      material.alphaCutOff = sourceWithAlpha.alphaCutOff ?? 0.4;
      material.transparencyMode = Material.MATERIAL_ALPHATESTANDBLEND;
    } else {
      // 透明队列位于正文不透明/裁剪队列之后，确保轮廓只读取完整正文深度。
      material.transparencyMode = Material.MATERIAL_ALPHABLEND;
    }
    outlineMaterials.set(sourceMaterial, material);
    outlineMultiMaterial.subMaterials.push(material);
    return material;
  };

  const entries = viewport.sourceMeshes.flatMap((value, meshIndex) => {
    if (!(value instanceof Mesh)) return [];
    const source = value;
    const proxy = source.clone(`mely-selection-outline-${meshIndex}`, null, true, false);
    proxy.parent = source.parent;
    proxy.skeleton = source.skeleton;
    proxy.morphTargetManager = source.morphTargetManager;
    proxy.material = outlineMultiMaterial;
    proxy.isPickable = false;
    proxy.metadata = {
      ...(proxy.metadata && typeof proxy.metadata === "object" ? proxy.metadata : {}),
      melySelectionProxy: true,
    };
    proxy.checkCollisions = false;
    proxy.receiveShadows = false;
    proxy.alwaysSelectAsActiveMesh = false;
    proxy.releaseSubMeshes();
    proxy.setEnabled(false);
    return [{ source, proxy }];
  });

  const syncEntries = () => {
    if (disposed) return;
    entries.forEach(({ source, proxy }) => {
      proxy.parent = source.parent;
      proxy.position.copyFrom(source.position);
      proxy.scaling.copyFrom(source.scaling);
      proxy.rotation.copyFrom(source.rotation);
      if (source.rotationQuaternion) {
        if (proxy.rotationQuaternion) proxy.rotationQuaternion.copyFrom(source.rotationQuaternion);
        else proxy.rotationQuaternion = source.rotationQuaternion.clone();
      } else {
        proxy.rotationQuaternion = null;
      }
      if (proxy.skeleton !== source.skeleton) proxy.skeleton = source.skeleton;
      if (proxy.morphTargetManager !== source.morphTargetManager) {
        proxy.morphTargetManager = source.morphTargetManager;
      }
      proxy.visibility = source.visibility;
      if (proxy.subMeshes.length > 0) {
        const hasRuntimeVisibleMaterial = proxy.subMeshes.some((subMesh) => {
          const outlineMaterial = subMesh.getMaterial();
          if (!outlineMaterial) return false;
          for (const [sourceMaterial, candidate] of outlineMaterials) {
            if (candidate !== outlineMaterial) continue;
            const alpha = Number((sourceMaterial as Material & { alpha?: number }).alpha ?? 1);
            return Number.isFinite(alpha) && alpha > 0.01;
          }
          return false;
        });
        proxy.setEnabled(
          source.isEnabled()
          && source.isVisible
          && source.visibility > 0
          && hasRuntimeVisibleMaterial,
        );
      }
    });
  };
  const setSelection = (materialIndex: number | null, visible: boolean) => {
    if (disposed) return;
    entries.forEach(({ source, proxy }) => {
      proxy.setEnabled(false);
      proxy.releaseSubMeshes();
      if (
        materialIndex === null
        || !visible
        || !source.isEnabled()
        || !source.isVisible
        || source.visibility <= 0
      ) return;
      source.subMeshes.forEach((sourceSubMesh) => {
        if (viewport.resolveMaterialIndex(source, sourceSubMesh._id) !== materialIndex) return;
        const selectionMaterial = selectionMaterialFor(sourceSubMesh.getMaterial(), source);
        if (!selectionMaterial) return;
        new SubMesh(
          outlineMultiMaterial.subMaterials.indexOf(selectionMaterial),
          sourceSubMesh.verticesStart,
          sourceSubMesh.verticesCount,
          sourceSubMesh.indexStart,
          sourceSubMesh.indexCount,
          proxy,
          undefined,
          true,
        );
      });
      proxy.setEnabled(proxy.subMeshes.length > 0);
    });
    syncEntries();
  };

  return {
    setSelection,
    sync: syncEntries,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      selectionRenderer.dispose();
      entries.forEach(({ proxy }) => {
        // 先解除共享 geometry，避免 Mesh.dispose() 清空 Morph manager 时移除源模型的 Morph 缓冲。
        proxy.geometry?.releaseForMesh(proxy, false);
        // Skeleton may retain meshes that use an initial pose matrix; detach before disposal.
        proxy.skeleton = null;
        proxy.morphTargetManager = null;
        proxy.dispose(true, false);
      });
      outlineMaterials.forEach((material) => material.dispose(false, false));
      outlineMultiMaterial.dispose(false, false);
    },
  };
};

export type { BabylonSelectionOutline };
