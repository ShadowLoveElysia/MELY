import assert from "node:assert/strict";
import { test } from "node:test";
import { DefaultMmdRuntime } from "@yohawing/three-mmd-loader";
import * as THREE from "three";
import { parseMelyPoseJson, stringifyMelyPose } from "../src/core/melyPose";
import { createMmdPoseController } from "../src/core/mmdPose";
import { createMmdMeshSnapshot } from "../src/core/mmdSnapshot";
import type { LoadedMmdModel } from "../src/core/mmdModel";

const createRig = () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    -1, 0, 0,
    1, 1, 0,
    0, 3, 0,
  ], 3));
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute([
    0, 0, 0, 0,
    1, 0, 0, 0,
    1, 0, 0, 0,
  ], 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute([
    1, 0, 0, 0,
    1, 0, 0, 0,
    1, 0, 0, 0,
  ], 4));
  geometry.setIndex([0, 1, 2]);
  geometry.addGroup(0, 3, 0);
  geometry.computeBoundingBox();
  geometry.morphTargetsRelative = true;
  geometry.morphAttributes.position = [new THREE.Float32BufferAttribute([
    0, 0, 0,
    0, 0.5, 0,
    0, 1, 0,
  ], 3)];

  const root = new THREE.Bone();
  root.name = "Root";
  root.userData.mmdBoneName = "全ての親";
  root.userData.mmdEnglishBoneName = "Root";
  const arm = new THREE.Bone();
  arm.name = "Arm_L";
  arm.userData.mmdBoneName = "左腕";
  arm.userData.mmdEnglishBoneName = "Arm_L";
  arm.position.set(0, 1, 0);
  root.add(arm);

  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
  mesh.morphTargetDictionary = { まばたき: 0, Blink: 0 };
  mesh.morphTargetInfluences = [0];
  mesh.userData.mmdMorphs = [{ name: "まばたき", englishName: "Blink" }];
  mesh.add(root);
  mesh.bind(new THREE.Skeleton([root, arm]));
  const modelRoot = new THREE.Group();
  modelRoot.add(mesh);
  modelRoot.updateMatrixWorld(true);
  return {
    mesh,
    root,
    arm,
    model: { root: modelRoot, mesh } as unknown as LoadedMmdModel,
  };
};

test("manual rotation remains layered over a new animation frame", () => {
  const { mesh, arm } = createRig();
  const pose = createMmdPoseController(mesh);

  assert.equal(pose.bones[0]?.controlMode, "translate");
  assert.equal(pose.bones[1]?.controlMode, "rotate");
  assert.ok(pose.nudgeBone(1, "x", Math.PI / 4));

  const manualOffset = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0),
    Math.PI / 4,
  );
  assert.ok(arm.quaternion.angleTo(manualOffset) < 1e-6);

  const animationFrame = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    Math.PI / 6,
  );
  arm.quaternion.copy(animationFrame);
  pose.syncAfterRuntimeUpdate();

  const expected = animationFrame.clone().multiply(manualOffset);
  assert.ok(arm.quaternion.angleTo(expected) < 1e-6);
  assert.equal(pose.state().editCount, 1);
});

test("pose history supports undo, redo, per-bone reset and full reset", () => {
  const { mesh, root, arm } = createRig();
  const pose = createMmdPoseController(mesh);

  assert.ok(pose.nudgeBone(0, "y", pose.translationStep));
  assert.ok(pose.nudgeBone(1, "z", Math.PI / 12));
  assert.equal(pose.state().editCount, 2);
  assert.equal(root.position.y, pose.translationStep);

  assert.ok(pose.undo());
  assert.equal(pose.state().editCount, 1);
  assert.ok(arm.quaternion.angleTo(new THREE.Quaternion()) < 1e-6);
  assert.ok(pose.redo());
  assert.equal(pose.state().editCount, 2);

  assert.ok(pose.resetBone(1));
  assert.equal(pose.state().editCount, 1);
  assert.ok(pose.reset());
  assert.deepEqual(pose.state(), { editCount: 0, canUndo: true, canRedo: false });
  assert.ok(root.position.distanceTo(new THREE.Vector3()) < 1e-6);
});

test("a non-zero animation pose changes CPU vertices and survives Pose JSON round-trip", async () => {
  const source = createRig();
  const sourcePose = createMmdPoseController(source.mesh);
  const restSnapshot = await createMmdMeshSnapshot(source.model, { includeTextures: false });

  source.root.position.set(0.25, 0.5, -0.125);
  source.arm.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 3);
  source.mesh.morphTargetInfluences![0] = 0.8;
  sourcePose.syncAfterRuntimeUpdate();
  const animatedSnapshot = await createMmdMeshSnapshot(source.model, { includeTextures: false });
  assert.notDeepEqual([...animatedSnapshot.positions], [...restSnapshot.positions]);

  const serialized = stringifyMelyPose(sourcePose.exportMelyPose());
  const importedDocument = parseMelyPoseJson(serialized);
  const target = createRig();
  target.mesh.morphTargetInfluences![0] = 0.15;
  const targetPose = createMmdPoseController(target.mesh);
  const applied = targetPose.importMelyPose(importedDocument);
  const importedSnapshot = await createMmdMeshSnapshot(target.model, { includeTextures: false });

  assert.equal(applied.appliedBoneCount, 2);
  assert.deepEqual(applied.missingBoneNames, []);
  assert.equal(applied.appliedMorphCount, 1);
  assert.deepEqual(applied.missingMorphNames, []);
  assert.equal(target.mesh.morphTargetInfluences?.[0], 0.8);
  assert.ok(target.root.position.distanceTo(source.root.position) < 1e-6);
  assert.ok(target.arm.quaternion.angleTo(source.arm.quaternion) < 1e-6);
  assert.equal(importedSnapshot.positions.length, animatedSnapshot.positions.length);
  importedSnapshot.positions.forEach((value, index) => {
    assert.ok(Math.abs(value - animatedSnapshot.positions[index]) < 1e-5, `${index}: ${value}`);
  });
});

test("pose import clears morphs that are absent from the imported document", () => {
  const target = createRig();
  target.mesh.morphTargetInfluences![0] = 0.9;
  const pose = createMmdPoseController(target.mesh);

  const applied = pose.importMelyPose({
    generator: "MELY",
    version: "1.0",
    bones: [],
  });

  assert.equal(target.mesh.morphTargetInfluences?.[0], 0);
  assert.equal(applied.appliedMorphCount, 0);
  assert.deepEqual(applied.missingMorphNames, []);
});

test("imported pose remains stable across runtime evaluation and manual offsets apply once", () => {
  const target = createRig();
  const pose = createMmdPoseController(target.mesh);
  const importedRotation = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 0, 1),
    Math.PI / 3,
  );

  pose.importMelyPose({
    generator: "MELY",
    version: "1.0",
    bones: [
      { name: "Root", pos: [0.4, 0.25, -0.1], rot: [0, 0, 0, 1] },
      { name: "Arm_L", pos: [0, 0, 0], rot: importedRotation.toArray() },
    ],
    morphs: [{ name: "Blink", weight: 0.65 }],
  });
  const animation = pose.importedPoseAnimation();
  assert.ok(animation);

  target.root.position.set(0, 0, 0);
  target.root.quaternion.identity();
  target.arm.position.set(0, 1, 0);
  target.arm.quaternion.identity();
  target.mesh.morphTargetInfluences!.fill(0);
  const runtime = new DefaultMmdRuntime();
  runtime.setAnimation(animation, target.mesh);
  runtime.evaluate(0, { physics: false, ik: false });
  pose.syncAfterRuntimeUpdate();

  assert.ok(target.root.position.distanceTo(new THREE.Vector3(0.4, 0.25, -0.1)) < 1e-6);
  assert.ok(target.arm.quaternion.angleTo(importedRotation) < 5e-4);
  assert.ok(Math.abs((target.mesh.morphTargetInfluences?.[0] ?? 0) - 0.65) < 1e-6);

  const manualRotation = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0),
    Math.PI / 6,
  );
  assert.ok(pose.nudgeBone(1, "x", Math.PI / 6));
  const expected = importedRotation.clone().multiply(manualRotation);
  assert.ok(target.arm.quaternion.angleTo(expected) < 5e-4);

  for (let index = 0; index < 3; index += 1) {
    runtime.evaluate(0, { physics: false, ik: false });
    pose.syncAfterRuntimeUpdate();
    assert.ok(target.root.position.distanceTo(new THREE.Vector3(0.4, 0.25, -0.1)) < 1e-6);
    assert.ok(target.arm.quaternion.angleTo(expected) < 5e-4);
    assert.ok(Math.abs((target.mesh.morphTargetInfluences?.[0] ?? 0) - 0.65) < 1e-6);
  }
});
