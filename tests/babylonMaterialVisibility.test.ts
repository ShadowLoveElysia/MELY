import assert from "node:assert/strict";
import test from "node:test";
import { Material } from "@babylonjs/core";
import {
  createBabylonMaterialIndexResolver,
  createBabylonMaterialVisibilityController,
  createBabylonVisibilityMaterialProxy,
  resolveCanonicalBabylonMaterials,
} from "../src/core/babylonMaterialVisibility";

interface TestMaterial extends Material {
  alpha: number;
  transparencyMode: number | null;
  renderOutline: boolean;
  outlineAlpha: number;
}

const createMaterial = (name: string, alpha = 1) => {
  return {
    name,
    alpha,
    transparencyMode: Material.MATERIAL_OPAQUE,
    renderOutline: true,
    outlineAlpha: 0.75,
    disableColorWrite: false,
    disableDepthWrite: false,
  } as TestMaterial;
};

test("Babylon visibility survives morph evaluation and restores the current dynamic state", () => {
  const material = createMaterial("body", 0.8);
  const controller = createBabylonMaterialVisibilityController([material]);

  controller.setVisible(0, false);
  assert.equal(material.alpha, 0);
  assert.equal(material.transparencyMode, Material.MATERIAL_ALPHABLEND);
  assert.equal(material.disableColorWrite, true);
  assert.equal(material.disableDepthWrite, true);
  assert.equal(material.renderOutline, false);
  assert.equal(material.outlineAlpha, 0);
  assert.equal(controller.isRuntimeVisible(0), false);

  // Material proxy 的 super.applyChanges() 在 Morph 后会更新这些动态值。
  controller.restoreDynamicState(material);
  material.alpha = 0.35;
  material.transparencyMode = Material.MATERIAL_ALPHABLEND;
  material.outlineAlpha = 0.2;
  controller.captureDynamicState(material);
  controller.applyMaterial(material);
  assert.equal(material.alpha, 0);
  assert.equal(material.disableColorWrite, true);

  controller.setVisible(0, true);
  assert.equal(material.alpha, 0.35);
  assert.equal(material.transparencyMode, Material.MATERIAL_ALPHABLEND);
  assert.equal(material.disableColorWrite, false);
  assert.equal(material.disableDepthWrite, false);
  assert.equal(material.renderOutline, true);
  assert.equal(material.outlineAlpha, 0.2);
  assert.equal(controller.isRuntimeVisible(0), true);
});

test("Babylon visibility proxy reapplies hidden state after its base proxy updates morph values", () => {
  class FakeMaterialProxy {
    public readonly diffuse = [1, 1, 1, 1];
    public readonly edgeColor = [0, 0, 0, 1];

    public constructor(
      private readonly material: TestMaterial,
      _referencedMeshes: readonly unknown[],
    ) {}

    public applyChanges() {
      this.material.alpha = this.diffuse[3];
      this.material.outlineAlpha = this.edgeColor[3];
    }
  }

  const material = createMaterial("body", 0.8);
  material.alpha = 0.8;
  material.renderOutline = true;
  material.outlineAlpha = 0.75;
  const controller = createBabylonMaterialVisibilityController([material]);
  const VisibilityProxy = createBabylonVisibilityMaterialProxy(controller, FakeMaterialProxy);
  const proxy = new VisibilityProxy(material, []);

  controller.setVisible(0, false);
  proxy.diffuse[3] = 0.35;
  proxy.edgeColor[3] = 0.2;
  proxy.applyChanges();
  assert.equal(material.alpha, 0);
  assert.equal(material.disableColorWrite, true);
  assert.equal(material.renderOutline, false);

  controller.setVisible(0, true);
  assert.equal(material.alpha, 0.35);
  assert.equal(material.disableColorWrite, false);
  assert.equal(material.renderOutline, true);
  assert.equal(material.outlineAlpha, 0.2);
});

test("Babylon visibility keeps user-hidden and runtime-transparent states distinct", () => {
  const material = createMaterial("morph-hidden");
  const controller = createBabylonMaterialVisibilityController([material]);

  material.alpha = 0;
  controller.captureDynamicState(material);
  assert.equal(controller.isUserVisible(0), true);
  assert.equal(controller.isRuntimeVisible(0), false);

  material.alpha = 0.5;
  controller.captureDynamicState(material);
  assert.equal(controller.isRuntimeVisible(0), true);
  assert.throws(() => controller.setVisible(1, false), RangeError);
});

test("Babylon canonical material resolver follows metadata order", () => {
  const first = createMaterial("first");
  const second = createMaterial("second");
  assert.deepEqual(
    resolveCanonicalBabylonMaterials({ materials: [second, first] }, [first, second]),
    [second, first],
  );
  assert.deepEqual(
    resolveCanonicalBabylonMaterials(undefined, [first, second, first]),
    [first, second],
  );
});

test("Babylon pick resolver maps MultiMaterial submesh ids to canonical indices", () => {
  const first = createMaterial("first");
  const second = createMaterial("second");
  const mesh = {
    material: { subMaterials: [first, second] },
    subMeshes: [
      { _id: 4, materialIndex: 0 },
      { _id: 9, materialIndex: 1 },
    ],
  };
  const resolve = createBabylonMaterialIndexResolver([mesh], [second, first]);

  assert.equal(resolve(mesh, 4), 1);
  assert.equal(resolve(mesh, 9), 0);
  assert.equal(resolve(mesh, 0), null);
  assert.equal(resolve({ ...mesh }, 4), null);
  assert.equal(resolve(mesh, Number.NaN), null);

  const unknown = createMaterial("unknown");
  const sparseMesh = {
    material: { subMaterials: [first, null, unknown] },
    subMeshes: [
      { _id: 1, materialIndex: 1 },
      { _id: 2, materialIndex: 2 },
    ],
  };
  const resolveSparse = createBabylonMaterialIndexResolver([sparseMesh], [first, second]);
  assert.equal(resolveSparse(sparseMesh, 1), null);
  assert.equal(resolveSparse(sparseMesh, 2), null);
});
