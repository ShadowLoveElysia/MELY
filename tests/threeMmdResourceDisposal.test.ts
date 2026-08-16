import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { disposeThreeMmdResources } from "../src/core/threeMmdRuntime";

test("Three MMD disposal releases texture clones that share one source", () => {
  const shared = new THREE.DataTexture(new Uint8Array([128, 64, 255, 255]), 1, 1);
  const clone = shared.clone();
  const material = new THREE.MeshToonMaterial({ map: clone, normalMap: shared });
  const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), material);
  const bone = new THREE.Bone();
  mesh.add(bone);
  mesh.bind(new THREE.Skeleton([bone]));
  const boneTexture = new THREE.DataTexture(new Float32Array(16), 4, 1);
  mesh.skeleton.boneTexture = boneTexture;
  const root = new THREE.Group();
  root.add(mesh);
  let sharedDisposals = 0;
  let cloneDisposals = 0;
  shared.addEventListener("dispose", () => { sharedDisposals += 1; });
  clone.addEventListener("dispose", () => { cloneDisposals += 1; });
  let boneTextureDisposals = 0;
  boneTexture.addEventListener("dispose", () => { boneTextureDisposals += 1; });

  disposeThreeMmdResources(root, mesh);

  assert.equal(sharedDisposals, 1);
  assert.equal(cloneDisposals, 1);
  assert.equal(boneTextureDisposals, 1);
  assert.equal(shared.source, clone.source);
  assert.equal(shared.source.data, null);
});

test("Three MMD disposal is idempotent after replacing the owned skeleton", () => {
  const material = new THREE.MeshToonMaterial();
  const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), material);
  const bone = new THREE.Bone();
  mesh.add(bone);
  mesh.bind(new THREE.Skeleton([bone]));
  const boneTexture = new THREE.DataTexture(new Float32Array(16), 4, 1);
  mesh.skeleton.boneTexture = boneTexture;
  const root = new THREE.Group();
  root.add(mesh);
  let boneTextureDisposals = 0;
  boneTexture.addEventListener("dispose", () => { boneTextureDisposals += 1; });

  disposeThreeMmdResources(root, mesh);
  disposeThreeMmdResources(root, mesh);

  assert.equal(boneTextureDisposals, 1);
  assert.equal(mesh.skeleton.boneTexture, null);
});
