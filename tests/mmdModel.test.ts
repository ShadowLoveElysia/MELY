import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { disposeMmdModel } from "@yohawing/three-mmd-loader";
import {
  disposeMmdModelResources,
  isSuggestedEmissiveMaterial,
  isSuggestedSkinMaterial,
  loadMmdModel,
  MMD_MODEL_LOAD_OPTIONS,
  releaseMmdLoaderReferences,
} from "../src/core/mmdModel";
import { evaluateMmdPreviewFrame } from "../src/core/mmdPreviewRuntime";
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

test("loaded VMD reports tracks that actually match the model", async () => {
  const { readFile } = await import("node:fs/promises");
  const [modelBytes, motionBytes] = await Promise.all([
    readFile(new URL("./fixtures/mely-input-e2e.pmd", import.meta.url)),
    readFile(new URL("./fixtures/mely-complex-motion-e2e.vmd", import.meta.url)),
  ]);
  const modelFile = new File([modelBytes], "mely-input-e2e.pmd");
  const motionFile = new File([motionBytes], "mely-complex-motion-e2e.vmd");
  const model = await loadMmdModel([modelFile], modelFile);

  try {
    const motion = await model.loadMotion(motionFile);
    assert.equal(motion.boneTrackCount, 4);
    assert.equal(motion.matchedBoneTrackCount, 4);
    assert.equal(motion.morphTrackCount, 1);
    assert.equal(motion.matchedMorphTrackCount, 1);
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
