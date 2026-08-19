import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  adaptMoeruMmdOutlineParameters,
  createThreeMmdOutlinePass,
  createThreeMmdSelectionOutlinePass,
  MELY_MMD_OUTLINE_VERTEX_SHADER,
  readThreeMmdOutlineParameters,
  syncThreeMmdOutlineMaterials,
  THREE_MMD_OUTLINE_LAYER,
  THREE_MMD_SELECTION_OUTLINE_COLOR,
  THREE_MMD_SELECTION_OUTLINE_LAYER,
  THREE_MMD_SELECTION_OUTLINE_THICKNESS,
  updateThreeMmdOutlineMaterial,
  updateThreeMmdSelectionOutlineMaterial,
  validateThreeMmdOutlineShaderChunks,
} from "../src/core/threeMmdOutline.ts";

const createSkinnedMesh = (material: THREE.Material) => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
  ], 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute([
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
  ], 3));
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute([
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ], 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute([
    1, 0, 0, 0,
    1, 0, 0, 0,
    1, 0, 0, 0,
  ], 4));
  geometry.setIndex([0, 1, 2]);
  geometry.addGroup(0, 3, 0);
  const mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.add(new THREE.Bone());
  mesh.bind(new THREE.Skeleton(mesh.children as THREE.Bone[]));
  return mesh;
};

test("reads vanilla OutlineEffect parameters without changing their MMD values", () => {
  const material = new THREE.MeshToonMaterial();
  material.userData.outlineParameters = {
    thickness: 0.004,
    color: [0.1, 0.2, 0.3],
    alpha: 0.75,
    visible: true,
  };

  assert.deepEqual(readThreeMmdOutlineParameters(material), {
    thickness: 0.004,
    color: [0.1, 0.2, 0.3],
    alpha: 0.75,
    visible: true,
  });
});

test("outline shaders only reference chunks provided by the installed Three revision", () => {
  assert.deepEqual(validateThreeMmdOutlineShaderChunks(), []);
});

test("maps Moeru descriptor outlines and follows material-morph edge state", () => {
  const material = new THREE.MeshPhongMaterial() as THREE.MeshPhongMaterial & {
    isMMDMaterial: true;
    descriptor: {
      outline: {
        alpha: number;
        color: THREE.Color;
        visible: boolean;
        width: number;
      };
    };
    applyMMDMaterialState: (state: {
      edgeAlpha: number;
      edgeColor: THREE.Color;
      edgeWidth: number;
    }) => void;
  };
  material.isMMDMaterial = true;
  material.descriptor = {
    outline: {
      alpha: 0.6,
      color: new THREE.Color(0.1, 0.2, 0.3),
      visible: true,
      width: 0.005,
    },
  };
  let originalApplyCount = 0;
  material.applyMMDMaterialState = () => {
    originalApplyCount += 1;
  };
  const mesh = createSkinnedMesh(material);

  adaptMoeruMmdOutlineParameters(mesh);
  assert.deepEqual(readThreeMmdOutlineParameters(material), {
    thickness: 0.005,
    color: [0.1, 0.2, 0.3],
    alpha: 0.6,
    visible: true,
  });

  material.applyMMDMaterialState({
    edgeAlpha: 0.25,
    edgeColor: new THREE.Color(0.7, 0.5, 0.2),
    edgeWidth: 0.009,
  });
  assert.equal(originalApplyCount, 1);
  const pass = createThreeMmdOutlinePass(mesh);
  const root = new THREE.Group();
  root.add(mesh);
  syncThreeMmdOutlineMaterials(pass.materials, [material]);
  assert.deepEqual(readThreeMmdOutlineParameters(material), {
    thickness: 0.009,
    color: [0.7, 0.5, 0.2],
    alpha: 0.25,
    visible: true,
  });
  pass.dispose();
});

test("creates a disposable source-only outline pass with explicit SDEF deformation", () => {
  const material = new THREE.MeshPhongMaterial();
  material.userData.outlineParameters = {
    thickness: 0.003,
    color: [0, 0, 0],
    alpha: 1,
    visible: true,
  };
  const mesh = createSkinnedMesh(material);
  mesh.geometry.setAttribute("matricesSdefEnabled", new THREE.Float32BufferAttribute([1, 0, 0], 1));
  mesh.geometry.setAttribute("matricesSdefC", new THREE.Float32BufferAttribute(new Array(9).fill(0), 3));
  mesh.geometry.setAttribute("matricesSdefRW0", new THREE.Float32BufferAttribute(new Array(9).fill(0), 3));
  mesh.geometry.setAttribute("matricesSdefRW1", new THREE.Float32BufferAttribute(new Array(9).fill(0), 3));
  const originalMask = mesh.layers.mask;

  const pass = createThreeMmdOutlinePass(mesh);
  assert.equal(mesh.layers.isEnabled(THREE_MMD_OUTLINE_LAYER), true);
  assert.equal(pass.outlineMesh.layers.isEnabled(THREE_MMD_OUTLINE_LAYER), true);
  assert.equal(pass.outlineMesh.layers.isEnabled(0), false);
  assert.equal(pass.outlineMesh.geometry, mesh.geometry);
  assert.equal(pass.outlineMesh.skeleton, mesh.skeleton);
  assert.equal(pass.sdefVertexCount, 1);
  assert.equal(pass.sdefAttributeContract, "canonical");
  assert.equal(pass.materials[0].defines?.MELY_USE_SDEF, 1);
  assert.equal(pass.materials[0].defines?.MELY_SDEF_CANONICAL, 1);
  assert.match(MELY_MMD_OUTLINE_VERTEX_SHADER, /attribute float matricesSdefEnabled/);
  assert.match(MELY_MMD_OUTLINE_VERTEX_SHADER, /attribute vec3 matricesSdefRW0/);
  assert.match(MELY_MMD_OUTLINE_VERTEX_SHADER, /#define MELY_SDEF_ENABLED matricesSdefEnabled/);
  assert.match(MELY_MMD_OUTLINE_VERTEX_SHADER, /objectNormal = mix\( linearNormal, normalRotation \* objectNormal, step\( 0\.5, MELY_SDEF_ENABLED \) \)/);
  assert.match(MELY_MMD_OUTLINE_VERTEX_SHADER, /transformed = mix\( linearTransformed, sdefTransformed, step\( 0\.5, MELY_SDEF_ENABLED \) \)/);

  pass.dispose();
  assert.equal(mesh.layers.mask, originalMask);
  assert.deepEqual(pass.outlineMesh.material, []);
});

test("keeps the Moeru SDEF attribute contract as a separate shader variant", () => {
  const material = new THREE.MeshPhongMaterial();
  material.userData.outlineParameters = {
    thickness: 0.003,
    color: [0, 0, 0],
    alpha: 1,
    visible: true,
  };
  const mesh = createSkinnedMesh(material);
  mesh.geometry.setAttribute("mmdSdefMask", new THREE.Float32BufferAttribute([1, 0, 0], 1));
  mesh.geometry.setAttribute("mmdSdefC", new THREE.Float32BufferAttribute(new Array(9).fill(0), 3));
  mesh.geometry.setAttribute("mmdSdefRW0", new THREE.Float32BufferAttribute(new Array(9).fill(0), 3));
  mesh.geometry.setAttribute("mmdSdefRW1", new THREE.Float32BufferAttribute(new Array(9).fill(0), 3));

  const pass = createThreeMmdOutlinePass(mesh);

  assert.equal(pass.sdefVertexCount, 1);
  assert.equal(pass.sdefAttributeContract, "moeru");
  assert.equal(pass.materials[0].defines?.MELY_USE_SDEF, 1);
  assert.equal(pass.materials[0].defines?.MELY_SDEF_CANONICAL, undefined);
  assert.match(MELY_MMD_OUTLINE_VERTEX_SHADER, /#define MELY_SDEF_ENABLED mmdSdefMask/);
  pass.dispose();
});

test("does not enable SDEF for an incomplete attribute contract", () => {
  const material = new THREE.MeshPhongMaterial();
  material.userData.outlineParameters = {
    thickness: 0.003,
    color: [0, 0, 0],
    alpha: 1,
    visible: true,
  };
  const mesh = createSkinnedMesh(material);
  mesh.geometry.setAttribute("matricesSdefEnabled", new THREE.Float32BufferAttribute([1, 0, 0], 1));

  const pass = createThreeMmdOutlinePass(mesh);

  assert.equal(pass.sdefVertexCount, 0);
  assert.equal(pass.sdefAttributeContract, null);
  assert.equal(pass.materials[0].defines?.MELY_USE_SDEF, undefined);
  pass.dispose();
});

test("outline visibility follows source visibility, opacity and edge alpha", () => {
  const transparentMap = new THREE.Texture();
  const source = new THREE.MeshPhongMaterial({
    map: transparentMap,
    opacity: 0.8,
    transparent: true,
  });
  source.userData.outlineParameters = {
    thickness: 0.003,
    color: [0, 0, 0],
    alpha: 0.5,
    visible: true,
  };
  const mesh = createSkinnedMesh(source);
  const pass = createThreeMmdOutlinePass(mesh);
  const outline = pass.materials[0];

  updateThreeMmdOutlineMaterial(outline, source);
  assert.equal(outline.visible, true);
  assert.equal(outline.transparent, true);
  assert.equal(outline.depthWrite, false);
  assert.equal(outline.map, transparentMap);
  assert.equal(outline.uniforms.map.value, transparentMap);
  assert.equal(outline.uniforms.outlineAlpha.value, 0.4);
  assert.equal(outline.uniformsNeedUpdate, true);

  source.visible = false;
  updateThreeMmdOutlineMaterial(outline, source);
  assert.equal(outline.visible, false);

  source.visible = true;
  source.opacity = 0;
  updateThreeMmdOutlineMaterial(outline, source);
  assert.equal(outline.visible, false);

  source.opacity = 1;
  source.userData.outlineParameters.alpha = 0;
  updateThreeMmdOutlineMaterial(outline, source);
  assert.equal(outline.visible, false);
  pass.dispose();
});

test("outline samples an opaque material map when the loader detected PNG alpha", () => {
  const alphaMap = new THREE.Texture() as THREE.Texture & { transparent?: boolean };
  alphaMap.transparent = true;
  const source = new THREE.MeshPhongMaterial({ map: alphaMap });
  source.userData.outlineParameters = {
    thickness: 0.003,
    color: [0, 0, 0],
    alpha: 1,
    visible: true,
  };
  const pass = createThreeMmdOutlinePass(createSkinnedMesh(source));

  updateThreeMmdOutlineMaterial(pass.materials[0], source);

  assert.equal(source.transparent, false);
  assert.equal(pass.materials[0].map, alphaMap);
  assert.equal(pass.materials[0].transparent, true);
  assert.equal(pass.materials[0].depthWrite, false);
  assert.equal(pass.materials[0].uniforms.map.value, alphaMap);
  pass.dispose();
});

test("selection outline uses fixed semantic styling without changing source outline state", () => {
  const source = new THREE.MeshPhongMaterial();
  source.userData.outlineParameters = {
    thickness: 0.002,
    color: [0.1, 0.2, 0.3],
    alpha: 0.4,
    visible: false,
  };
  const nativePass = createThreeMmdOutlinePass(createSkinnedMesh(source));
  const target = nativePass.materials[0];

  updateThreeMmdSelectionOutlineMaterial(target, source, true);

  assert.equal(target.visible, true);
  assert.equal(target.uniforms.outlineThickness.value, THREE_MMD_SELECTION_OUTLINE_THICKNESS);
  assert.deepEqual(target.uniforms.outlineColor.value.toArray(), [...THREE_MMD_SELECTION_OUTLINE_COLOR]);
  assert.deepEqual(readThreeMmdOutlineParameters(source), {
    thickness: 0.002,
    color: [0.1, 0.2, 0.3],
    alpha: 0.4,
    visible: false,
  });

  source.visible = false;
  updateThreeMmdSelectionOutlineMaterial(target, source, true);
  assert.equal(target.visible, false);
  nativePass.dispose();
});

test("selection pass has an independent layer, follows morph-split identity and disposes symmetrically", () => {
  const sourceMaterials = [
    new THREE.MeshPhongMaterial(),
    new THREE.MeshPhongMaterial(),
  ];
  const primary = createSkinnedMesh(sourceMaterials[0]);
  const split = createSkinnedMesh(sourceMaterials[1]);
  split.material = sourceMaterials;
  split.userData.mmdMorphSplitBody = { materialIndex: 1 };
  split.morphTargetInfluences = [0.25];
  const root = new THREE.Group();
  root.add(primary, split);
  const primaryMask = primary.layers.mask;
  const splitMask = split.layers.mask;

  const selectionPass = createThreeMmdSelectionOutlinePass([primary, split]);

  assert.equal(primary.layers.mask, primaryMask);
  assert.equal(split.layers.mask, splitMask);
  assert.equal(selectionPass.outlineMeshes.length, 2);
  selectionPass.outlineMeshes.forEach((outline) => {
    assert.equal(outline.layers.isEnabled(THREE_MMD_SELECTION_OUTLINE_LAYER), true);
    assert.equal(outline.layers.isEnabled(THREE_MMD_OUTLINE_LAYER), false);
    assert.equal(outline.userData.melyMmdSelectionOutlineProxy, true);
  });
  selectionPass.maskMeshes.forEach((mask) => {
    assert.equal(mask.layers.isEnabled(THREE_MMD_SELECTION_OUTLINE_LAYER), true);
    assert.equal(mask.userData.melyMmdSelectionOutlineProxy, true);
  });
  assert.equal(selectionPass.outlineMeshes[1].skeleton, split.skeleton);
  assert.equal(selectionPass.outlineMeshes[1].morphTargetInfluences, split.morphTargetInfluences);

  selectionPass.dispose();
  assert.equal(primary.layers.mask, primaryMask);
  assert.equal(split.layers.mask, splitMask);
  selectionPass.outlineMeshes.forEach((outline) => assert.deepEqual(outline.material, []));
  selectionPass.maskMeshes.forEach((mask) => assert.deepEqual(mask.material, []));
});

test("morph-split selection renders its canonical slot through mask then outline", () => {
  const sourceMaterials = [
    new THREE.MeshPhongMaterial(),
    new THREE.MeshPhongMaterial(),
  ];
  const primary = createSkinnedMesh(sourceMaterials[0]);
  primary.material = sourceMaterials;
  primary.geometry.clearGroups();
  primary.geometry.addGroup(0, 3, 0);
  primary.geometry.addGroup(0, 3, 1);
  primary.geometry.setDrawRange(0, 0);

  const split = createSkinnedMesh(sourceMaterials[1]);
  split.geometry.clearGroups();
  split.geometry.addGroup(0, 3, 0);
  split.userData.mmdMorphSplitBody = { materialIndex: 1 };
  const root = new THREE.Group();
  root.add(primary, split);

  const selectionPass = createThreeMmdSelectionOutlinePass([primary, split]);
  const calls: string[] = [];
  const renderedScenes: THREE.Scene[] = [];
  const renderedFogs: Array<THREE.Fog | THREE.FogExp2 | null> = [];
  const renderer = {
    autoClear: true,
    shadowMap: { enabled: true },
    clearStencil: () => calls.push("clearStencil"),
    render: (renderScene: THREE.Scene) => {
      const isMask = renderScene.children.every(
        (child) => child.name === "MELY MMD selection stencil mask",
      );
      const isOutline = renderScene.children.every(
        (child) => child.name === "MELY MMD selection outline",
      );
      assert.notEqual(isMask, isOutline);
      calls.push(isMask ? "render:mask" : "render:outline");
      renderedScenes.push(renderScene);
      renderedFogs.push(renderScene.fog);
      assert.equal(renderer.autoClear, false);
      assert.equal(renderer.shadowMap.enabled, false);
    },
  } as unknown as THREE.WebGLRenderer;
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x101820, 1, 10);

  selectionPass.render(renderer, scene, new THREE.PerspectiveCamera(), 1);

  assert.deepEqual(calls, [
    "clearStencil",
    "render:mask",
    "render:outline",
    "clearStencil",
  ]);
  assert.deepEqual(selectionPass.materials.map((material) => material.visible), [false, true, true]);
  assert.deepEqual(selectionPass.maskMaterials.map((material) => material.visible), [false, true, true]);
  assert.equal(selectionPass.outlineMeshes[0].geometry.drawRange.count, 0);
  assert.equal(selectionPass.maskMeshes[0].geometry.drawRange.count, 0);
  assert.equal(selectionPass.outlineMeshes[1].material.length, 1);
  assert.equal(selectionPass.maskMeshes[1].material.length, 1);
  assert.deepEqual(selectionPass.outlineMeshes[1].geometry.groups, [
    { start: 0, count: 3, materialIndex: 0 },
  ]);
  assert.deepEqual(renderedFogs, [scene.fog, scene.fog]);
  assert.equal(renderedScenes.every((renderedScene) => renderedScene.fog === null), true);
  assert.equal(renderer.autoClear, true);
  assert.equal(renderer.shadowMap.enabled, true);

  selectionPass.dispose();
});

test("selection rendering enables only the requested slot and hidden state clears it", () => {
  const sources = [new THREE.MeshPhongMaterial(), new THREE.MeshPhongMaterial()];
  const mesh = createSkinnedMesh(sources[0]);
  mesh.material = sources;
  const root = new THREE.Group();
  root.add(mesh);
  const sourceMask = mesh.layers.mask;
  const nativePass = createThreeMmdOutlinePass(mesh);
  const nativeMask = mesh.layers.mask;
  const selectionPass = createThreeMmdSelectionOutlinePass([mesh]);
  const renderer = {
    autoClear: true,
    shadowMap: { enabled: true },
    clearStencil: () => undefined,
    render: () => undefined,
  } as unknown as THREE.WebGLRenderer;

  selectionPass.render(renderer, new THREE.Scene(), new THREE.PerspectiveCamera(), 1);
  assert.equal(selectionPass.materials[0].visible, false);
  assert.equal(selectionPass.materials[1].visible, true);
  assert.equal(selectionPass.maskMaterials[0].visible, false);
  assert.equal(selectionPass.maskMaterials[1].visible, true);
  assert.equal(selectionPass.materials[1].stencilFunc, THREE.NotEqualStencilFunc);
  assert.equal(selectionPass.materials[1].depthWrite, false);
  assert.equal(selectionPass.maskMaterials[1].stencilFunc, THREE.AlwaysStencilFunc);
  assert.equal(selectionPass.maskMaterials[1].stencilZPass, THREE.ReplaceStencilOp);
  assert.equal(selectionPass.maskMaterials[1].colorWrite, false);
  assert.equal(selectionPass.maskMaterials[1].uniforms.outlineThickness.value, 0);

  selectionPass.render(renderer, new THREE.Scene(), new THREE.PerspectiveCamera(), 1, new Set([1]));
  assert.equal(selectionPass.materials.every((material) => !material.visible), true);

  selectionPass.dispose();
  assert.equal(mesh.layers.mask, nativeMask);
  nativePass.dispose();
  assert.equal(mesh.layers.mask, sourceMask);
});
