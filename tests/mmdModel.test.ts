import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { disposeMmdModel } from "@yohawing/three-mmd-loader";
import {
  disposeMmdModelResources,
  isSuggestedEmissiveMaterial,
  isSuggestedSkinMaterial,
  isMmdTextureResourceLabel,
  loadMmdModel,
  MMD_MODEL_LOAD_OPTIONS,
  releaseMmdLoaderReferences,
} from "../src/core/mmdModel";
import {
  evaluateMmdPreviewFrame,
  settleMmdPreviewFrame,
} from "../src/core/mmdPreviewRuntime";
import type { ThreeMmdModel } from "@yohawing/three-mmd-loader";

test("model loading uses sparse morph bodies without preview proxy geometry", () => {
  assert.deepEqual(MMD_MODEL_LOAD_OPTIONS, {
    outline: false,
    materialRenderOrder: false,
    morphSplit: true,
    morphAttributes: true,
    frustumCulled: false,
  });
});

test("suggested skin recognizes common Chinese, Japanese, and English material names", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["脸", ""],
    ["皮肤 / 裸足", ""],
    ["皮膚", ""],
    ["臉", ""],
    ["肌", ""],
    ["顔", ""],
    ["顔肌", ""],
    ["素体", ""],
    ["身体", ""],
    ["", "Skin"],
    ["", "body_01"],
    ["", "FaceSkin"],
    ["", "MMDHead.001"],
  ];

  for (const [name, englishName] of cases) {
    assert.equal(
      isSuggestedSkinMaterial(name, englishName),
      true,
      `${name || englishName} should be suggested as skin`,
    );
  }
});

test("facial feature semantics override broad skin labels", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["眼睛", "skin"],
    ["眼白", "Face"],
    ["眉毛", "body"],
    ["口腔", "skin"],
    ["牙齿", "face"],
    ["舌头", "body"],
    ["表情", "face"],
    ["左目", "skin"],
    ["瞳", "face"],
    ["まつげ", "skin"],
    ["目", "face"],
    ["口", "skin"],
    ["顔", "FaceEye"],
    ["肌", "body_eyebrow"],
    ["皮肤", "mouth"],
    ["顔肌", "expression"],
  ];

  for (const [name, englishName] of cases) {
    assert.equal(
      isSuggestedSkinMaterial(name, englishName),
      false,
      `${name} / ${englishName} should remain a facial feature material`,
    );
  }
});

test("suggested skin matches the material semantics used by the Elysia test model", () => {
  const materials = [
    ["脸", true],
    ["眉毛", false],
    ["牙齿", false],
    ["舌头", false],
    ["口腔", false],
    ["眼白", false],
    ["眼睛", false],
    ["眼睛1", false],
    ["眼睛2", false],
    ["眼睛3", false],
    ["表情", false],
    ["皮肤 / 裸足", true],
  ] as const;

  for (const [name, expected] of materials) {
    assert.equal(isSuggestedSkinMaterial(name, ""), expected, name);
  }
});

test("suggested skin matching avoids incidental English substrings and clothing", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["", "interface"],
    ["", "skinny dress"],
    ["", "headwear"],
    ["", "body suit"],
    ["肌着", "body"],
    ["皮肤_手套", "skin glove"],
    ["頭髮", "head hair"],
    ["普通材质", "material_01"],
  ];

  for (const [name, englishName] of cases) {
    assert.equal(
      isSuggestedSkinMaterial(name, englishName),
      false,
      `${name} / ${englishName} should not be suggested as skin`,
    );
  }
});

test("emissive suggestions require explicit glow data or material semantics", () => {
  assert.equal(isSuggestedEmissiveMaterial("脸", "", undefined), false);
  assert.equal(isSuggestedEmissiveMaterial("头发", "Hair", undefined), false);
  assert.equal(isSuggestedEmissiveMaterial("背饰兔子灯笼", "", undefined), true);
  assert.equal(isSuggestedEmissiveMaterial("武器", "weapon_glow", undefined), true);
  assert.equal(isSuggestedEmissiveMaterial("普通材质", "highlight", undefined), false);
  assert.equal(isSuggestedEmissiveMaterial("普通材质", "", [0.8, 0.7, 0.6]), true);
  assert.equal(isSuggestedEmissiveMaterial("普通材质", "", [0.1, 0.1, 0.1]), false);
});

test("texture resource filenames are not treated as model part labels", () => {
  assert.equal(isMmdTextureResourceLabel("mc1.png"), true);
  assert.equal(isMmdTextureResourceLabel("toon01.bmp"), true);
  assert.equal(isMmdTextureResourceLabel("body.png*body.sph"), true);
  assert.equal(isMmdTextureResourceLabel("textures/dress.TGA"), true);
  assert.equal(isMmdTextureResourceLabel("裙摆"), false);
  assert.equal(isMmdTextureResourceLabel("Dress"), false);
  assert.equal(isMmdTextureResourceLabel("cloth.png detail"), false);
});

test("model disposal releases owned decoded sources and severs CPU geometry references", () => {
  const previousImageBitmap = globalThis.ImageBitmap;
  class TestImageBitmap {
    width = 64;
    height = 64;
    closeCount = 0;
    close() { this.closeCount += 1; }
  }
  Object.defineProperty(globalThis, "ImageBitmap", {
    configurable: true,
    value: TestImageBitmap,
  });

  try {
    const image = new TestImageBitmap();
    const ownedTexture = new THREE.Texture(image as unknown as ImageBitmap);
    ownedTexture.userData.mmdTextureOwnership = "loader";
    const fallbackTexture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    fallbackTexture.userData.mmdTextureOwnership = "loader";
    fallbackTexture.userData.mmdFallbackToonGradient = true;
    const material = new THREE.MeshStandardMaterial({ map: ownedTexture });
    material.userData.fallbackTexture = fallbackTexture;
    const uniformImage = new TestImageBitmap();
    const uniformTexture = new THREE.Texture(uniformImage as unknown as ImageBitmap);
    uniformTexture.userData.mmdTextureOwnership = "loader";
    let uniformTextureDisposeCount = 0;
    uniformTexture.addEventListener("dispose", () => { uniformTextureDisposeCount += 1; });
    const depthMaterial = new THREE.ShaderMaterial({
      uniforms: { diffuseMap: { value: uniformTexture } },
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    geometry.setIndex([0, 1, 2]);
    geometry.morphAttributes.position = [new THREE.Float32BufferAttribute(new Float32Array(9), 3)];
    const mesh = new THREE.SkinnedMesh(geometry, material);
    mesh.customDepthMaterial = depthMaterial;
    const bone = new THREE.Bone();
    mesh.add(bone);
    mesh.bind(new THREE.Skeleton([bone]));
    const root = new THREE.Group();
    root.add(mesh);
    const runtime = { dispose() {} };
    const model = {
      root,
      mesh,
      outlineMeshes: [],
      renderOrderMeshes: [],
      runtime,
    } as unknown as ThreeMmdModel;

    disposeMmdModelResources(model, disposeMmdModel);

    assert.equal(image.closeCount, 1);
    assert.equal(uniformImage.closeCount, 1);
    assert.equal(uniformTextureDisposeCount, 1);
    assert.equal(ownedTexture.source.data, null);
    assert.equal(uniformTexture.source.data, null);
    assert.equal(depthMaterial.uniforms.diffuseMap.value, null);
    assert.notEqual(fallbackTexture.source.data, null);
    assert.equal(mesh.geometry.getAttribute("position"), undefined);
    assert.equal(mesh.geometry.getIndex(), null);
    assert.deepEqual(mesh.material, []);
    assert.equal(mesh.skeleton.bones.length, 0);
    assert.equal(root.children.length, 0);
  } finally {
    if (previousImageBitmap === undefined) delete (globalThis as { ImageBitmap?: unknown }).ImageBitmap;
    else Object.defineProperty(globalThis, "ImageBitmap", {
      configurable: true,
      value: previousImageBitmap,
    });
  }
});

test("loader release clears texture caches and package file mappings", () => {
  const textureMap = { "texture.png": new Blob([new Uint8Array(1024)]) };
  const textureCache = new Map([["texture.png", Promise.resolve(new THREE.Texture())]]);
  const options: Record<string, unknown> = {
    textureMap,
    textureResolver: {},
    textureLoader: {},
    ddsLoader: {},
    runtime: { physics: "none" },
  };

  releaseMmdLoaderReferences({ textureCache, options });

  assert.equal(textureCache.size, 0);
  assert.equal("textureMap" in options, false);
  assert.equal("textureResolver" in options, false);
  assert.equal("textureLoader" in options, false);
  assert.equal("ddsLoader" in options, false);
  assert.deepEqual(options.runtime, { physics: "none" });
});

test("disposed model pose methods no longer retain a usable pose controller", async () => {
  const bytes = await import("node:fs/promises").then(({ readFile }) => (
    readFile(new URL("./fixtures/mely-input-e2e.pmd", import.meta.url))
  ));
  const file = new File([bytes], "mely-input-e2e.pmd");
  const model = await loadMmdModel([file], file);
  const readPoseState = model.poseState;
  const nudgeBone = model.nudgeBone;

  model.dispose();

  assert.throws(readPoseState, /disposed/);
  assert.throws(() => nudgeBone(0, "x", 1), /disposed/);
});

test("hidden model materials stay hidden across runtime pose evaluation", async () => {
  const bytes = await import("node:fs/promises").then(({ readFile }) => (
    readFile(new URL("./fixtures/mely-input-e2e.pmd", import.meta.url))
  ));
  const file = new File([bytes], "mely-input-e2e.pmd");
  const model = await loadMmdModel([file], file);
  const materials = Array.isArray(model.mesh.material) ? model.mesh.material : [model.mesh.material];

  try {
    assert.ok(materials.length > 0);
    model.setMaterialVisible(0, false);
    assert.equal(materials[0].visible, false);

    model.updatePreviewPose({ dance: 0, expression: 0 });
    assert.equal(materials[0].visible, false);
    model.updatePose({ dance: 0, expression: 0 });
    assert.equal(materials[0].visible, false);

    model.setMaterialVisible(0, true);
    assert.equal(materials[0].visible, true);
  } finally {
    model.dispose();
  }
});

test("dance and expression tracks sample independent frames from one VMD", async () => {
  const { readFile } = await import("node:fs/promises");
  const [modelBytes, motionBytes] = await Promise.all([
    readFile(new URL("./fixtures/mely-input-e2e.pmd", import.meta.url)),
    readFile(new URL("./fixtures/mely-complex-motion-e2e.vmd", import.meta.url)),
  ]);
  const modelFile = new File([modelBytes], "mely-input-e2e.pmd");
  const motionFile = new File([motionBytes], "mely-complex-motion-e2e.vmd");
  const model = await loadMmdModel([modelFile], modelFile);

  try {
    const dance = await model.loadMotion(motionFile, "dance");
    const expression = await model.loadMotion(motionFile, "expression");
    assert.equal(dance.kind, "dance");
    assert.equal(dance.boneTrackCount, 4);
    assert.equal(dance.matchedBoneTrackCount, 4);
    assert.equal(expression.kind, "expression");
    assert.equal(expression.morphTrackCount, 1);
    assert.equal(expression.matchedMorphTrackCount, 1);

    const evaluated = model.updatePose({ dance: 1, expression: 0.5 });
    const root = model.mesh.skeleton.bones.find((bone) => bone.name === "root");
    const smileIndex = model.mesh.morphTargetDictionary?.smile;
    assert.deepEqual(evaluated, { dance: 1, expression: 0.5 });
    assert.ok(root);
    assert.ok(Math.abs(root.position.x - 0.55) < 1e-5);
    assert.equal(smileIndex === undefined ? undefined : model.mesh.morphTargetInfluences?.[smileIndex], 0.5);
  } finally {
    model.dispose();
  }
});

test("imported pose survives model reevaluation without compounding manual edits", async () => {
  const bytes = await import("node:fs/promises").then(({ readFile }) => (
    readFile(new URL("./fixtures/mely-input-e2e.pmd", import.meta.url))
  ));
  const file = new File([bytes], "mely-input-e2e.pmd");
  const model = await loadMmdModel([file], file);

  try {
    const upperIndex = model.bones.findIndex((bone) => bone.name === "upper");
    const smileIndex = model.mesh.morphTargetDictionary?.smile;
    const importedRotation = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      Math.PI / 5,
    );
    model.importMelyPose({
      generator: "MELY",
      version: "1.0",
      bones: [
        { name: "root", pos: [0.35, 0.2, -0.15], rot: [0, 0, 0, 1] },
        { name: "upper", pos: [0, 0, 0], rot: importedRotation.toArray() },
      ],
      morphs: [{ name: "smile", weight: 0.6 }],
    });
    assert.ok(upperIndex >= 0);
    assert.ok(model.nudgeBone(upperIndex, "x", Math.PI / 12));
    const expectedRoot = new THREE.Vector3(0.35, 0.2, -0.15);
    const expectedUpper = importedRotation.clone().multiply(
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 12),
    );

    for (let index = 0; index < 3; index += 1) {
      model.updatePose({ dance: 0, expression: 0 });
      const root = model.mesh.skeleton.bones.find((bone) => bone.name === "root");
      const upper = model.mesh.skeleton.bones[upperIndex];
      assert.ok(root?.position.distanceTo(expectedRoot) ?? Number.POSITIVE_INFINITY < 1e-5);
      assert.ok(upper?.quaternion.angleTo(expectedUpper) ?? Number.POSITIVE_INFINITY < 1e-5);
      const smileWeight = smileIndex === undefined
        ? undefined
        : model.mesh.morphTargetInfluences?.[smileIndex];
      assert.ok(smileWeight !== undefined && Math.abs(smileWeight - 0.6) < 1e-6);
    }
  } finally {
    model.dispose();
  }
});

test("preview runtime reports shared morph-split skeletons without duplicating ownership", async () => {
  const bytes = await import("node:fs/promises").then(({ readFile }) => (
    readFile(new URL("./fixtures/mely-input-e2e.pmd", import.meta.url))
  ));
  const file = new File([bytes], "mely-input-e2e.pmd");
  const model = await loadMmdModel([file], file);

  try {
    assert.ok(model.previewRuntime.skinnedMeshCount >= 1);
    assert.equal(model.previewRuntime.uniqueSkeletonCount, 1);
  } finally {
    model.dispose();
  }
});

test("preview evaluation synchronizes renderer-facing bones without CPU skinning", () => {
  const skeleton = new THREE.Skeleton();
  const mesh = new THREE.SkinnedMesh();
  mesh.skeleton = skeleton;
  let matrixWorldUpdates = 0;
  let skeletonUpdates = 0;
  let debugCaptures = 0;
  mesh.updateMatrixWorld = () => { matrixWorldUpdates += 1; };
  skeleton.update = () => { skeletonUpdates += 1; };
  const runtime = {
    captureDebugStage: () => { debugCaptures += 1; },
    tick() {
      this.captureDebugStage();
      mesh.updateMatrixWorld(true);
      skeleton.update();
      return { seconds: 1, frame: 30, frameRate: 30 };
    },
  };
  const model = {
    mesh,
    runtime,
    update(seconds: number) {
      return runtime.tick(seconds);
    },
  } as unknown as ThreeMmdModel;

  const state = evaluateMmdPreviewFrame(model, 1);

  assert.equal(state.frame, 30);
  assert.equal(debugCaptures, 0);
  assert.equal(matrixWorldUpdates, 1);
  assert.equal(skeletonUpdates, 1);
});

test("exact physics settling seeds once and advances sixty fixed steps at the target frame", () => {
  const evaluations: Array<{ seconds: number; physics: boolean }> = [];
  const fixedSteps: Array<number | null> = [];
  const model = {
    runtime: {},
    update(seconds: number, options?: { physics?: boolean }) {
      evaluations.push({ seconds, physics: options?.physics === true });
      return { seconds, frame: seconds * 30, frameRate: 30 };
    },
  } as unknown as ThreeMmdModel;

  const state = settleMmdPreviewFrame(model, 0, {
    setFixedStepOverride: (value) => fixedSteps.push(value),
  });

  assert.equal(state.seconds, 0);
  assert.deepEqual(fixedSteps, [1 / 60, null]);
  assert.deepEqual(evaluations[0], { seconds: 0, physics: false });
  assert.equal(evaluations.filter((entry) => entry.physics).length, 61);
  assert.equal(evaluations.every((entry) => entry.seconds === 0), true);
});
