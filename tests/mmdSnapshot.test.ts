import assert from "node:assert/strict";
import { test } from "node:test";
import * as THREE from "three";
import {
  createMmdFaceFrameSnapshot,
  createMmdMeshSnapshot,
  releaseMmdMeshSnapshot,
} from "../src/core/mmdSnapshot";
import type { LoadedMmdModel } from "../src/core/mmdModel";

const vectorFromTuple = (tuple: readonly [number, number, number]) =>
  new THREE.Vector3(tuple[0], tuple[1], tuple[2]);

const assertDirection = (
  actual: readonly [number, number, number],
  expected: THREE.Vector3,
) => {
  const direction = vectorFromTuple(actual);
  assert.ok(direction.distanceTo(expected) < 1e-6, `${direction.toArray()} != ${expected.toArray()}`);
};

const assertPosition = (
  positions: Float32Array,
  vertexIndex: number,
  expected: THREE.Vector3,
  epsilon = 1e-5,
) => {
  const actual = new THREE.Vector3().fromArray(positions, vertexIndex * 3);
  assert.ok(actual.distanceTo(expected) < epsilon, `${actual.toArray()} != ${expected.toArray()}`);
};

interface DeformRigOptions {
  positions: number[];
  skinIndices: number[];
  skinWeights: number[];
  morphOffset?: number[];
  sdef?: {
    enabled: number[];
    center: number[];
    weighted0: number[];
    weighted1: number[];
  };
  qdefEnabled?: number[];
}

const createDeformRig = (options: DeformRigOptions) => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(options.positions, 3));
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(options.skinIndices, 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(options.skinWeights, 4));
  geometry.setIndex([0, 1, 2]);
  geometry.addGroup(0, 3, 0);
  if (options.morphOffset) {
    geometry.morphTargetsRelative = true;
    geometry.morphAttributes.position = [new THREE.Float32BufferAttribute(options.morphOffset, 3)];
  }
  if (options.sdef) {
    geometry.setAttribute("matricesSdefEnabled", new THREE.Float32BufferAttribute(options.sdef.enabled, 1));
    geometry.setAttribute("matricesSdefC", new THREE.Float32BufferAttribute(options.sdef.center, 3));
    geometry.setAttribute("matricesSdefRW0", new THREE.Float32BufferAttribute(options.sdef.weighted0, 3));
    geometry.setAttribute("matricesSdefRW1", new THREE.Float32BufferAttribute(options.sdef.weighted1, 3));
  }
  if (options.qdefEnabled) {
    geometry.setAttribute("matricesQdefEnabled", new THREE.Float32BufferAttribute(options.qdefEnabled, 1));
  }

  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
  const bones = Array.from({ length: 4 }, (_, index) => {
    const bone = new THREE.Bone();
    bone.name = `Bone_${index}`;
    mesh.add(bone);
    return bone;
  });
  mesh.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(bones));
  if (options.morphOffset) mesh.morphTargetInfluences = [1];
  const root = new THREE.Group();
  root.add(mesh);
  return {
    bones,
    mesh,
    model: { root, mesh } as unknown as LoadedMmdModel,
  };
};

const createFaceRig = () => {
  const root = new THREE.Group();
  const mesh = new THREE.SkinnedMesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial(),
  );
  root.add(mesh);

  const neck = new THREE.Bone();
  neck.name = "首";
  neck.position.set(0, 1, 0);
  const head = new THREE.Bone();
  head.name = "頭";
  head.position.set(0, 1, 0);
  const leftEye = new THREE.Bone();
  leftEye.name = "左目";
  leftEye.position.set(-0.5, 0.3, 0.4);
  const rightEye = new THREE.Bone();
  rightEye.name = "右目";
  rightEye.position.set(0.5, 0.3, 0.4);

  mesh.add(neck);
  neck.add(head);
  head.add(leftEye, rightEye);
  root.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton([neck, head, leftEye, rightEye]));
  root.updateMatrixWorld(true);

  return {
    root,
    head,
    model: { root, mesh } as unknown as LoadedMmdModel,
  };
};

const rotationCases = [
  ["pitch", new THREE.Vector3(1, 0, 0), Math.PI / 5],
  ["yaw", new THREE.Vector3(0, 1, 0), -Math.PI / 4],
  ["roll", new THREE.Vector3(0, 0, 1), Math.PI / 6],
] as const;

for (const [label, axis, angle] of rotationCases) {
  test(`face frame follows current head ${label}`, () => {
    const { model, head } = createFaceRig();
    const rotation = new THREE.Quaternion().setFromAxisAngle(axis, angle);
    head.quaternion.copy(rotation);

    const frame = createMmdFaceFrameSnapshot(model);
    assert.ok(frame);
    assertDirection(frame.right, new THREE.Vector3(1, 0, 0).applyQuaternion(rotation));
    assertDirection(frame.up, new THREE.Vector3(0, 1, 0).applyQuaternion(rotation));
    assertDirection(frame.forward, new THREE.Vector3(0, 0, 1).applyQuaternion(rotation));
  });
}

test("face frame directions remain local to a transformed model root", () => {
  const { model, root, head } = createFaceRig();
  root.position.set(4, -3, 7);
  root.rotation.set(0.3, -0.5, 0.2);
  root.scale.set(1.4, 0.8, 1.7);
  const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.25, -0.4, 0.3));
  head.quaternion.copy(rotation);

  const frame = createMmdFaceFrameSnapshot(model);
  assert.ok(frame);
  assertDirection(frame.right, new THREE.Vector3(1, 0, 0).applyQuaternion(rotation));
  assertDirection(frame.up, new THREE.Vector3(0, 1, 0).applyQuaternion(rotation));
  assertDirection(frame.forward, new THREE.Vector3(0, 0, 1).applyQuaternion(rotation));
});

test("CPU snapshots preserve the current sparse morph-split expression", async () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
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
  const material = new THREE.MeshBasicMaterial();
  const mesh = new THREE.SkinnedMesh(geometry, material);
  const bone = new THREE.Bone();
  mesh.add(bone);
  mesh.bind(new THREE.Skeleton([bone]));

  const splitGeometry = geometry.clone();
  splitGeometry.morphTargetsRelative = true;
  splitGeometry.morphAttributes.position = [new THREE.Float32BufferAttribute([
    0.75, 0, 0,
    0, 0, 0,
    0, 0, 0,
  ], 3)];
  const split = new THREE.SkinnedMesh(splitGeometry, material);
  split.bind(mesh.skeleton, mesh.bindMatrix);
  split.morphTargetInfluences = [1];
  split.userData.mmdMorphSplitBody = { materialIndex: 0, morphTargetIndices: Uint16Array.of(0) };
  mesh.userData.mmdMorphSplitBodyMeshes = [split];

  const root = new THREE.Group();
  root.add(mesh, split);
  const model = { root, mesh } as unknown as LoadedMmdModel;
  const snapshot = await createMmdMeshSnapshot(model, { includeTextures: false });
  assert.ok(Math.abs(snapshot.positions[0] - 0.75) < 1e-6);
  assert.equal(snapshot.indices.length, 3);

  releaseMmdMeshSnapshot(snapshot);
  assert.equal(snapshot.positions.byteLength, 0);
  assert.equal(snapshot.indices.byteLength, 0);
});

test("CPU snapshots evaluate BDEF1, BDEF2, and BDEF4 weights at the current pose", async () => {
  const { bones, model } = createDeformRig({
    positions: [
      0, 0, 0,
      0, 0, 0,
      0, 0, 0,
    ],
    skinIndices: [
      0, 0, 0, 0,
      0, 1, 0, 0,
      0, 1, 2, 3,
    ],
    skinWeights: [
      1, 0, 0, 0,
      0.25, 0.75, 0, 0,
      0.1, 0.2, 0.3, 0.4,
    ],
  });
  bones.forEach((bone, index) => bone.position.set(index + 1, 0, 0));

  const snapshot = await createMmdMeshSnapshot(model, { includeTextures: false });
  assertPosition(snapshot.positions, 0, new THREE.Vector3(1, 0, 0));
  assertPosition(snapshot.positions, 1, new THREE.Vector3(1.75, 0, 0));
  assertPosition(snapshot.positions, 2, new THREE.Vector3(3, 0, 0));
});

test("CPU snapshots evaluate SDEF spherical rotation instead of linear collapse", async () => {
  const zeros = Array(9).fill(0);
  const { bones, model } = createDeformRig({
    positions: [
      1, 0, 0,
      0, 0, 0,
      0, 1, 0,
    ],
    skinIndices: [
      0, 1, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
    ],
    skinWeights: [
      0.5, 0.5, 0, 0,
      1, 0, 0, 0,
      1, 0, 0, 0,
    ],
    sdef: {
      enabled: [1, 0, 0],
      center: zeros,
      weighted0: zeros,
      weighted1: zeros,
    },
  });
  bones[1].quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);

  const snapshot = await createMmdMeshSnapshot(model, { includeTextures: false });
  assertPosition(
    snapshot.positions,
    0,
    new THREE.Vector3(Math.SQRT1_2, Math.SQRT1_2, 0),
  );
});

test("CPU snapshots evaluate QDEF dual-quaternion blending", async () => {
  const { bones, model } = createDeformRig({
    positions: [
      0, 1, 0,
      0, 0, 0,
      1, 0, 0,
    ],
    skinIndices: [
      0, 1, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
    ],
    skinWeights: [
      0.5, 0.5, 0, 0,
      1, 0, 0, 0,
      1, 0, 0, 0,
    ],
    qdefEnabled: [1, 0, 0],
  });
  bones[0].quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  bones[1].quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);

  const snapshot = await createMmdMeshSnapshot(model, { includeTextures: false });
  assertPosition(snapshot.positions, 0, new THREE.Vector3(0, 1, 0));
});

test("CPU snapshots apply active vertex morphs before bone deformation", async () => {
  const { bones, model } = createDeformRig({
    positions: [
      0, 0, 0,
      0, 1, 0,
      1, 0, 0,
    ],
    skinIndices: [
      0, 0, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
    ],
    skinWeights: [
      1, 0, 0, 0,
      1, 0, 0, 0,
      1, 0, 0, 0,
    ],
    morphOffset: [
      0.5, 0, 0,
      0, 0, 0,
      0, 0, 0,
    ],
  });
  bones[0].position.set(1, 0, 0);

  const snapshot = await createMmdMeshSnapshot(model, { includeTextures: false });
  assertPosition(snapshot.positions, 0, new THREE.Vector3(1.5, 0, 0));
});

test("material snapshots do not treat ambient light as emissive", async () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
    2, 0, 0,
    3, 0, 0,
    2, 1, 0,
  ], 3));
  geometry.setIndex([0, 1, 2, 3, 4, 5]);
  geometry.addGroup(0, 3, 0);
  geometry.addGroup(3, 3, 1);

  const regular = new THREE.MeshBasicMaterial();
  regular.userData.mmdMaterial = {
    name: "爱莉普通材质",
    ambient: [1, 1, 1],
  };
  const lantern = new THREE.MeshBasicMaterial();
  lantern.userData.mmdMaterial = {
    name: "背饰兔子灯笼",
    ambient: [0, 0, 0],
  };

  const mesh = new THREE.SkinnedMesh(geometry, [regular, lantern]);
  const bone = new THREE.Bone();
  mesh.add(bone);
  mesh.bind(new THREE.Skeleton([bone]));
  const root = new THREE.Group();
  root.add(mesh);

  const snapshot = await createMmdMeshSnapshot(
    { root, mesh } as unknown as LoadedMmdModel,
    { includeTextures: true },
  );
  assert.equal(snapshot.materials?.[0].emissive, false);
  assert.equal(snapshot.materials?.[1].emissive, true);
});
