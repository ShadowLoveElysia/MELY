import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  adaptMoeruMmdOutlineParameters,
  createThreeMmdOutlinePass,
  MELY_MMD_OUTLINE_VERTEX_SHADER,
  readThreeMmdOutlineParameters,
  syncThreeMmdOutlineMaterials,
  THREE_MMD_OUTLINE_LAYER,
  updateThreeMmdOutlineMaterial,
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
