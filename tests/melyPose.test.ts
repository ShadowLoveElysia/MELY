import assert from "node:assert/strict";
import { test } from "node:test";
import * as THREE from "three";
import {
  captureMelyPose,
  parseMelyPoseJson,
  resolveMelyPose,
  stringifyMelyPose,
  type MelyPoseBinding,
} from "../src/core/melyPose";
import type { MmdBoneInfo } from "../src/types";

const createBinding = (
  index: number,
  name: string,
  englishName: string,
): MelyPoseBinding => {
  const bone = new THREE.Bone();
  bone.name = englishName;
  const info: MmdBoneInfo = {
    index,
    name,
    englishName,
    displayName: name,
    parentIndex: -1,
    controlMode: "rotate",
    isIkGoal: false,
  };
  return {
    index,
    info,
    bone,
    restPosition: bone.position.clone(),
    restQuaternion: bone.quaternion.clone(),
  };
};

test("MELY pose export stores only rest-relative non-default transforms", () => {
  const center = createBinding(0, "センター", "Center");
  const arm = createBinding(1, "左腕", "Arm_L");
  center.bone.position.set(0, 1.25, -0.5);
  arm.bone.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);

  const pose = captureMelyPose([center, arm]);
  assert.equal(pose.generator, "MELY");
  assert.equal(pose.version, "1.0");
  assert.equal(pose.bones.length, 2);
  assert.deepEqual(pose.bones[0], {
    name: "センター",
    pos: [0, 1.25, -0.5],
    rot: [0, 0, 0, 1],
  });
  assert.deepEqual(pose.bones[1]?.pos, [0, 0, 0]);
  assert.ok(Math.abs((pose.bones[1]?.rot[1] ?? 0) - Math.SQRT1_2) < 1e-6);
});

test("MELY pose captures optional non-default morphs and matches bilingual aliases", () => {
  const pose = captureMelyPose([], [
    { index: 0, name: "まばたき", englishName: "Blink", weight: 0.75 },
    { index: 1, name: "笑い", englishName: "Smile", weight: 0 },
  ]);
  assert.deepEqual(pose.morphs, [{ name: "まばたき", weight: 0.75 }]);

  const parsed = parseMelyPoseJson(stringifyMelyPose(pose));
  const resolved = resolveMelyPose(parsed, [], [
    { index: 4, name: "まばたき", englishName: "Blink", weight: 0 },
  ]);
  assert.deepEqual(resolved.morphs, [{ index: 4, weight: 0.75 }]);
  assert.equal(resolved.appliedMorphCount, 1);
  assert.deepEqual(resolved.missingMorphNames, []);

  const english = resolveMelyPose({
    generator: "MELY",
    version: "1.0",
    bones: [],
    morphs: [{ name: "blink", weight: 0.25 }],
  }, [], [
    { index: 4, name: "まばたき", englishName: "Blink", weight: 0 },
  ]);
  assert.deepEqual(english.morphs, [{ index: 4, weight: 0.25 }]);
});

test("MELY pose JSON validates and normalizes imported quaternions", () => {
  const pose = parseMelyPoseJson(JSON.stringify({
    generator: "MELY",
    version: "1.0",
    bones: [{ name: "Center", pos: [1, 2, 3], rot: [0, 0, 0, 2] }],
  }));
  assert.deepEqual(pose.bones[0]?.rot, [0, 0, 0, 1]);
  assert.equal(parseMelyPoseJson(stringifyMelyPose(pose)).bones.length, 1);

  assert.throws(() => parseMelyPoseJson(JSON.stringify({
    generator: "MELY",
    version: "1.0",
    bones: [
      { name: "Center", pos: [0, 0, 0], rot: [0, 0, 0, 1] },
      { name: " center ", pos: [0, 0, 0], rot: [0, 0, 0, 1] },
    ],
  })), /error\.pose\.duplicateBone/);

  assert.throws(() => parseMelyPoseJson(JSON.stringify({
    generator: "MELY",
    version: "1.0",
    bones: [],
    morphs: [
      { name: "Blink", weight: 0.5 },
      { name: " blink ", weight: 0.25 },
    ],
  })), /error\.pose\.duplicateMorph/);
});

test("MELY pose import matches Japanese and English bone aliases", () => {
  const center = createBinding(0, "センター", "Center");
  const arm = createBinding(1, "左腕", "Arm_L");
  const resolved = resolveMelyPose({
    generator: "MELY",
    version: "1.0",
    bones: [
      { name: "center", pos: [0, 2, 0], rot: [0, 0, 0, 1] },
      { name: "左腕", pos: [0, 0, 0], rot: [0, 0, 0.5, 0.5] },
      { name: "missing", pos: [0, 0, 0], rot: [0, 0, 0, 1] },
    ],
  }, [center, arm]);

  assert.equal(resolved.appliedBoneCount, 2);
  assert.deepEqual(resolved.missingBoneNames, ["missing"]);
  assert.equal(resolved.bones[0]?.index, 0);
  assert.equal(resolved.bones[0]?.positionOffset.y, 2);
  assert.ok(Math.abs((resolved.bones[1]?.quaternionOffset.length() ?? 0) - 1) < 1e-7);
});
