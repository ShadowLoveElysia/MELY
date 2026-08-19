import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  canonicalThreeMmdMaterialIndex,
  collectThreeMmdMaterialPickMeshes,
  completesThreeMaterialPointerClick,
  createThreeMaterialPointerCandidate,
  resolveThreeMmdMaterialHit,
  updateThreeMaterialPointerCandidate,
} from "../src/core/threeModelPartSelection.ts";

const createGeometry = (materialIndex = 0) => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
  ], 3));
  geometry.setIndex([0, 1, 2]);
  geometry.addGroup(0, 3, materialIndex);
  return geometry;
};

const pointerEvent = (
  clientX: number,
  clientY: number,
  overrides: Partial<{
    pointerId: number;
    button: number;
    isPrimary: boolean;
  }> = {},
) => ({
  pointerId: overrides.pointerId ?? 7,
  button: overrides.button ?? 0,
  isPrimary: overrides.isPrimary ?? true,
  clientX,
  clientY,
});

test("pointer gesture accepts up to 4px jitter and rejects camera drags", () => {
  const start = createThreeMaterialPointerCandidate(pointerEvent(10, 10), "model-a");
  assert.ok(start);

  const fourPixels = updateThreeMaterialPointerCandidate(start, pointerEvent(14, 10));
  assert.equal(fourPixels.dragged, false);
  assert.equal(completesThreeMaterialPointerClick(fourPixels, pointerEvent(14, 10)), true);

  const diagonalDrag = updateThreeMaterialPointerCandidate(start, pointerEvent(13, 13));
  assert.equal(diagonalDrag.dragged, true);
  assert.equal(completesThreeMaterialPointerClick(diagonalDrag, pointerEvent(13, 13)), false);
  assert.equal(
    completesThreeMaterialPointerClick(start, pointerEvent(30, 10)),
    false,
    "release coordinates must reject a drag even when no pointermove was observed",
  );
  assert.equal(completesThreeMaterialPointerClick(start, pointerEvent(10, 10, { pointerId: 8 })), false);
  assert.equal(createThreeMaterialPointerCandidate(pointerEvent(10, 10, { button: 2 }), "model-a"), null);
});

test("recursively collects primary and Vanilla morph-split bodies without proxies", () => {
  const primary = new THREE.SkinnedMesh(createGeometry(), new THREE.MeshBasicMaterial());
  const split = new THREE.SkinnedMesh(createGeometry(0), [
    new THREE.MeshBasicMaterial(),
    new THREE.MeshBasicMaterial(),
  ]);
  split.userData.mmdMorphSplitBody = { materialIndex: 1 };
  primary.userData.mmdMorphSplitBodyMeshes = [split];
  const proxy = new THREE.SkinnedMesh(createGeometry(), new THREE.MeshBasicMaterial());
  proxy.userData.mmdOutlineProxy = { sourceMaterialIndex: 0 };
  const nested = new THREE.Group();
  nested.add(primary, split, proxy);
  const root = new THREE.Group();
  root.add(nested);

  assert.deepEqual(collectThreeMmdMaterialPickMeshes(root, primary), [primary, split]);
});

test("maps regular groups and morph-split bodies to canonical material indices", () => {
  const regular = new THREE.SkinnedMesh(createGeometry(2), [
    new THREE.MeshBasicMaterial(),
    new THREE.MeshBasicMaterial(),
    new THREE.MeshBasicMaterial(),
  ]);
  const regularHit = {
    distance: 1,
    object: regular,
    faceIndex: 0,
    face: { a: 0, b: 1, c: 2, normal: new THREE.Vector3(), materialIndex: 2 },
  };
  assert.equal(canonicalThreeMmdMaterialIndex(regularHit), 2);

  const split = new THREE.SkinnedMesh(createGeometry(), regular.material);
  split.userData.mmdMorphSplitBody = { materialIndex: 1 };
  assert.equal(canonicalThreeMmdMaterialIndex({ ...regularHit, object: split }), 1);
});

test("skips hidden, transparent and invalid hits to select the nearest visible material", () => {
  const materials = [
    new THREE.MeshBasicMaterial(),
    new THREE.MeshBasicMaterial(),
    new THREE.MeshBasicMaterial(),
  ];
  const meshes = materials.map((_, materialIndex) => {
    const mesh = new THREE.SkinnedMesh(createGeometry(), materials);
    mesh.userData.mmdMorphSplitBody = { materialIndex };
    new THREE.Group().add(mesh);
    return mesh;
  });
  materials[1].opacity = 0;
  const hit = (materialIndex: number, distance: number) => ({
    distance,
    object: meshes[materialIndex],
    faceIndex: 0,
    face: { a: 0, b: 1, c: 2, normal: new THREE.Vector3(), materialIndex: 0 },
  });

  assert.equal(resolveThreeMmdMaterialHit(
    [hit(2, 3), hit(1, 2), hit(0, 1)],
    materials,
    new Set([0]),
  ), 2);
  assert.equal(resolveThreeMmdMaterialHit(
    [hit(0, 1)],
    materials,
    new Set([0]),
  ), null);
});
