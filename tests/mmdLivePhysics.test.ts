import assert from "node:assert/strict";
import test from "node:test";
import {
  AnimationMixer,
  Bone,
  BufferGeometry,
  Euler,
  Float32BufferAttribute,
  Group,
  MeshBasicMaterial,
  Quaternion,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
  Vector3,
} from "three";
import {
  computeMmdLivePhysicsDeltaSeconds,
  MMD_LIVE_PHYSICS_MAX_DELTA_SECONDS,
} from "../src/core/mmdRuntime";
import {
  createThreeMmdModel,
  THREE_MMD_PHYSICS_FIXED_STEP,
  THREE_MMD_PHYSICS_SETTLE_STEPS,
  type ThreeMmdBackendDriver,
} from "../src/core/threeMmdRuntime";
import { withThreeMmdBindPose } from "../src/core/threeMmdBindPose";

const boneTransform = (bone: Bone) => ({
  position: bone.position.toArray(),
  quaternion: bone.quaternion.toArray(),
  scale: bone.scale.toArray(),
});

const assertBoneTransform = (
  bone: Bone,
  expected: ReturnType<typeof boneTransform>,
) => {
  bone.position.toArray().forEach((value, index) => {
    assert.ok(Math.abs(value - expected.position[index]) < 1e-10);
  });
  const expectedQuaternion = new Quaternion().fromArray(expected.quaternion);
  assert.ok(Math.abs(Math.abs(bone.quaternion.dot(expectedQuaternion)) - 1) < 1e-10);
  bone.scale.toArray().forEach((value, index) => {
    assert.ok(Math.abs(value - expected.scale[index]) < 1e-10);
  });
};

const createBindPoseHarness = () => {
  const parent = new Bone();
  parent.position.set(1.25, 3.5, -0.75);
  parent.quaternion.setFromEuler(new Euler(0.2, -0.35, 0.1));
  parent.scale.setScalar(1.15);
  const child = new Bone();
  child.position.set(-0.4, 2.75, 0.65);
  child.quaternion.setFromEuler(new Euler(-0.15, 0.25, 0.3));
  child.scale.setScalar(0.9);
  parent.add(child);

  const mesh = new SkinnedMesh(new BufferGeometry(), new MeshBasicMaterial());
  mesh.add(parent);
  mesh.bind(new Skeleton([parent, child]));
  mesh.updateMatrixWorld(true);
  const bindPose = [boneTransform(parent), boneTransform(child)];

  parent.position.set(-4, 8, 2);
  parent.quaternion.setFromEuler(new Euler(-0.45, 0.15, 0.6));
  parent.scale.set(0.8, 1.2, 0.95);
  child.position.set(3, -1, 5);
  child.quaternion.setFromEuler(new Euler(0.4, -0.2, -0.55));
  child.scale.set(1.4, 0.75, 1.1);
  mesh.updateMatrixWorld(true);

  return {
    mesh,
    bones: [parent, child] as const,
    bindPose,
    animatedPose: [boneTransform(parent), boneTransform(child)],
  };
};

test("vanilla physics is constructed in bind pose and restores animation", () => {
  const harness = createBindPoseHarness();
  const result = withThreeMmdBindPose(harness.mesh, () => {
    harness.bones.forEach((bone, index) => {
      assertBoneTransform(bone, harness.bindPose[index]);
    });
    return "initialized";
  });

  assert.equal(result, "initialized");
  harness.bones.forEach((bone, index) => {
    assertBoneTransform(bone, harness.animatedPose[index]);
  });
});

test("vanilla bind-pose setup restores animation when construction throws", () => {
  const harness = createBindPoseHarness();
  const failure = new Error("physics setup failed");

  assert.throws(() => withThreeMmdBindPose(harness.mesh, () => {
    harness.bones.forEach((bone, index) => {
      assertBoneTransform(bone, harness.bindPose[index]);
    });
    throw failure;
  }), failure);
  harness.bones.forEach((bone, index) => {
    assertBoneTransform(bone, harness.animatedPose[index]);
  });
});

test("vanilla bind-pose constraints remain stable with the real Ammo solver", async () => {
  const imported = await import("ammojs-typed");
  const ammoFactory = imported.default as unknown as (
    target?: unknown,
  ) => Promise<Record<string, unknown>>;
  const ammo = await ammoFactory();
  const globalScope = globalThis as typeof globalThis & { Ammo?: Record<string, unknown> };
  const previousAmmo = globalScope.Ammo;
  globalScope.Ammo = ammo;

  try {
    const { MMDPhysics } = await import("three-stdlib");
    const parent = new Bone();
    const child = new Bone();
    child.position.set(0, 2, 0);
    parent.add(child);
    const mesh = new SkinnedMesh(new BufferGeometry(), new MeshBasicMaterial());
    mesh.add(parent);
    mesh.bind(new Skeleton([parent, child]));
    parent.quaternion.setFromEuler(new Euler(0, 0, 1.2));
    mesh.updateMatrixWorld(true);
    const expectedPosition = child.getWorldPosition(new Vector3());

    const rigidBodyBase = {
      shapeType: 0,
      width: 0.3,
      height: 0.3,
      depth: 0.3,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      friction: 0.5,
      restitution: 0,
      positionDamping: 0.5,
      rotationDamping: 0.5,
      groupIndex: 0,
      groupTarget: 0xffff,
    };
    const rigidBodies = [
      { ...rigidBodyBase, boneIndex: 0, type: 0, weight: 0 },
      { ...rigidBodyBase, boneIndex: 1, type: 1, weight: 1 },
    ];
    const constraints = [{
      rigidBodyIndex1: 0,
      rigidBodyIndex2: 1,
      position: [0, 2, 0],
      rotation: [0, 0, 0],
      translationLimitation1: [0, 0, 0],
      translationLimitation2: [0, 0, 0],
      rotationLimitation1: [-0.2, -0.2, -0.2],
      rotationLimitation2: [0.2, 0.2, 0.2],
      springPosition: [0, 0, 0],
      springRotation: [0, 0, 0],
    }];

    let physics: InstanceType<typeof MMDPhysics> | undefined;
    withThreeMmdBindPose(mesh, () => {
      physics = new MMDPhysics(mesh, rigidBodies, constraints, {
        unitStep: THREE_MMD_PHYSICS_FIXED_STEP,
        maxStepNum: 10,
      });
    });
    assert.ok(physics);
    physics.reset();
    for (let step = 0; step < THREE_MMD_PHYSICS_SETTLE_STEPS; step += 1) {
      physics.update(THREE_MMD_PHYSICS_FIXED_STEP);
    }

    const settledPosition = child.getWorldPosition(new Vector3());
    assert.ok(settledPosition.distanceTo(expectedPosition) < 1e-4);
    assert.ok(child.quaternion.toArray().every(Number.isFinite));
  } finally {
    globalScope.Ammo = previousAmmo;
  }
});

const createPhysicsHarness = (
  materialNames?: ThreeMmdBackendDriver["metadata"]["materialNames"],
) => {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
  ], 3));
  geometry.setAttribute("skinIndex", new Uint16BufferAttribute([
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ], 4));
  geometry.setAttribute("skinWeight", new Float32BufferAttribute([
    1, 0, 0, 0,
    1, 0, 0, 0,
    1, 0, 0, 0,
  ], 4));
  const bone = new Bone();
  bone.name = "root";
  const mesh = new SkinnedMesh(geometry, new MeshBasicMaterial());
  mesh.add(bone);
  mesh.bind(new Skeleton([bone]));
  const root = new Group();
  root.add(mesh);
  const evaluations: Array<{ deltaSeconds: number; physics: boolean }> = [];
  let resetCount = 0;
  let enabled = true;
  const driver: ThreeMmdBackendDriver = {
    rendererMode: "vanilla",
    root,
    mesh,
    mixer: new AnimationMixer(mesh),
    metadata: {
      fileName: "physics-test.pmx",
      name: "Physics Test",
      englishName: "Physics Test",
      format: "pmx",
      rigidBodyCount: 1,
      jointCount: 0,
      materialNames,
    },
    textureWarnings: [],
    physicsAvailable: true,
    loadMotionClip: async () => { throw new Error("not used"); },
    evaluate: (deltaSeconds, physics) => evaluations.push({ deltaSeconds, physics }),
    resetPhysics: () => { resetCount += 1; },
    setPhysicsEnabled: async (next) => { enabled = next; },
    physicsEnabled: () => enabled,
    dispose: () => undefined,
  };
  const model = createThreeMmdModel({ driver });
  evaluations.length = 0;
  return {
    model,
    evaluations,
    resetCount: () => resetCount,
  };
};

test("live physics uses one solver step per rendered frame without resetting", async () => {
  const harness = createPhysicsHarness();
  try {
    harness.model.updateLivePose({ dance: 0, expression: 0 }, 0.016);
    harness.model.updateLivePose({ dance: 0, expression: 0 }, 0.018);
    harness.model.updateLivePose({ dance: 0, expression: 0 }, 0.012);

    assert.equal(harness.resetCount(), 0);
    assert.deepEqual(harness.evaluations, [
      { deltaSeconds: 0.016, physics: true },
      { deltaSeconds: 0.018, physics: true },
      { deltaSeconds: 0.012, physics: true },
    ]);
  } finally {
    await harness.model.dispose();
  }
});

test("static pose settling resets once and advances deterministic fixed steps", async () => {
  const harness = createPhysicsHarness();
  try {
    harness.model.updatePose({ dance: 0, expression: 0 });

    assert.equal(harness.resetCount(), 1);
    assert.equal(harness.evaluations.length, THREE_MMD_PHYSICS_SETTLE_STEPS + 1);
    assert.deepEqual(harness.evaluations[0], { deltaSeconds: 0, physics: false });
    harness.evaluations.slice(1).forEach((entry) => {
      assert.deepEqual(entry, {
        deltaSeconds: THREE_MMD_PHYSICS_FIXED_STEP,
        physics: true,
      });
    });
  } finally {
    await harness.model.dispose();
  }
});

test("live physics delta follows the render clock and clamps long frames", () => {
  assert.equal(computeMmdLivePhysicsDeltaSeconds(1000, null), 0);
  assert.equal(computeMmdLivePhysicsDeltaSeconds(1016, 1000), 0.016);
  assert.equal(
    computeMmdLivePhysicsDeltaSeconds(2000, 1000),
    MMD_LIVE_PHYSICS_MAX_DELTA_SECONDS,
  );
  assert.equal(computeMmdLivePhysicsDeltaSeconds(999, 1000), 0);
  assert.equal(computeMmdLivePhysicsDeltaSeconds(Number.NaN, 1000), 0);
});

test("Three material adapters do not treat MMD ambient color as emissive", async () => {
  const ordinary = createPhysicsHarness([{
    name: "普通材质",
    englishName: "regular material",
    diffuse: [0.7, 0.6, 0.5, 1],
    ambient: [0.9, 0.8, 0.7],
  }]);
  const namedLight = createPhysicsHarness([{
    name: "背饰灯笼",
    englishName: "lantern",
    diffuse: [0.7, 0.6, 0.5, 1],
    ambient: [0.9, 0.8, 0.7],
  }]);
  try {
    assert.equal(ordinary.model.materials[0].suggestedEmissive, false);
    assert.equal(namedLight.model.materials[0].suggestedEmissive, true);
    assert.equal(
      (ordinary.model.mesh.material as MeshBasicMaterial).userData.mmdMaterial.emissive,
      undefined,
    );
  } finally {
    await ordinary.model.dispose();
    await namedLight.model.dispose();
  }
});
