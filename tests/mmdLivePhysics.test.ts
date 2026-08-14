import assert from "node:assert/strict";
import test from "node:test";
import {
  AnimationMixer,
  Bone,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  MeshBasicMaterial,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
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
