import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  BABYLON_ANGULAR_SENSIBILITY,
  BABYLON_CAMERA_INERTIA,
  BABYLON_DEFAULT_CAMERA_ALPHA,
  BABYLON_DEFAULT_CAMERA_BETA,
  BABYLON_PANNING_INERTIA,
  applyBabylonCameraPanningProfile,
  babylonPanningSensibilityForRadius,
  resetBabylonCameraView,
  syncBabylonCameraPanningSensibility,
} from "../src/core/babylonCameraControls.ts";

test("Babylon panning sensibility scales with radius and stays within limits", () => {
  assert.equal(babylonPanningSensibilityForRadius(-10), 120);
  assert.equal(babylonPanningSensibilityForRadius(Number.NaN), 120);
  assert.equal(babylonPanningSensibilityForRadius(15), 120);
  assert.equal(babylonPanningSensibilityForRadius(30), 240);
  assert.equal(babylonPanningSensibilityForRadius(81.25), 650);
  assert.equal(babylonPanningSensibilityForRadius(1_000), 650);
});

test("Babylon panning profile sets independent inertia and can resync after zoom", () => {
  const camera = {
    radius: 45,
    panningSensibility: 1_000,
    panningInertia: 0.9,
    angularSensibilityX: 1_000,
    angularSensibilityY: 1_000,
    inertia: 0.9,
  };

  assert.equal(applyBabylonCameraPanningProfile(camera), 360);
  assert.equal(camera.panningSensibility, 360);
  assert.equal(camera.panningInertia, BABYLON_PANNING_INERTIA);
  assert.equal(camera.angularSensibilityX, BABYLON_ANGULAR_SENSIBILITY);
  assert.equal(camera.angularSensibilityY, BABYLON_ANGULAR_SENSIBILITY);
  assert.equal(camera.inertia, BABYLON_CAMERA_INERTIA);

  camera.radius = 10;
  assert.equal(syncBabylonCameraPanningSensibility(camera), 120);
  assert.equal(camera.panningSensibility, 120);
  assert.equal(camera.panningInertia, BABYLON_PANNING_INERTIA);
});

test("Babylon camera reset restores framing and clears all inertial offsets", () => {
  let copiedTarget: unknown = null;
  const camera = {
    alpha: 4,
    beta: 0.2,
    radius: 90,
    target: { copyFrom: (value: unknown) => { copiedTarget = value; } },
    panningSensibility: 650,
    panningInertia: 0.86,
    angularSensibilityX: 720,
    angularSensibilityY: 720,
    inertia: 0.86,
    inertialAlphaOffset: 1,
    inertialBetaOffset: 2,
    inertialRadiusOffset: 3,
    inertialPanningX: 4,
    inertialPanningY: 5,
  };
  const target = { x: 1, y: 2, z: 3 };

  resetBabylonCameraView(camera, target, 40);

  assert.equal(camera.alpha, BABYLON_DEFAULT_CAMERA_ALPHA);
  assert.equal(camera.beta, BABYLON_DEFAULT_CAMERA_BETA);
  assert.equal(camera.radius, 40);
  assert.equal(copiedTarget, target);
  assert.equal(camera.panningSensibility, 320);
  assert.deepEqual([
    camera.inertialAlphaOffset,
    camera.inertialBetaOffset,
    camera.inertialRadiusOffset,
    camera.inertialPanningX,
    camera.inertialPanningY,
  ], [0, 0, 0, 0, 0]);
});

test("Babylon viewport wires dynamic panning without changing source transforms", () => {
  const runtime = readFileSync("src/core/babylonMmdRuntime.ts", "utf8");
  const viewport = readFileSync("src/components/BabylonViewport.tsx", "utf8");

  assert.match(runtime, /applyBabylonCameraPanningProfile\(camera\)/);
  assert.match(runtime, /camera\.attachControl\(false, true, 2\)/);
  assert.match(
    viewport,
    /runtime\.frameTarget\.copyFrom\(center\);[\s\S]*runtime\.frameRadius = perspectiveFrameDistance\(/,
  );
  assert.match(runtime, /camera\.fov = MMD_PREVIEW_VERTICAL_FOV_RADIANS/);
  assert.match(
    viewport,
    /current\.frameRadius = perspectiveFrameDistance\([\s\S]*current\.camera\.radius = current\.frameRadius/,
  );
  assert.match(
    viewport,
    /syncBabylonCameraPanningSensibility\(camera\);[\s\S]{0,120}selectionOutline\.sync\(\);\s*scene\.render\(\)/,
  );
  assert.match(viewport, /canvas\.addEventListener\("contextmenu", preventContextMenu\)/);
  assert.match(viewport, /canvas\.removeEventListener\("contextmenu", preventContextMenu\)/);
  assert.match(
    viewport,
    /const gl = canvas\.getContext\("webgl2"\) \?\? canvas\.getContext\("webgl"\);\s*gl\?\.finish\(\)/,
  );
  assert.match(viewport, /if \(!probeWindow\.__MELY_E2E_CAMERA_PROBE__\) return/);
  assert.match(viewport, /publishBabylonCameraProbe\(camera, sourceRoot\)/);
  assert.match(
    viewport,
    /resetBabylonCameraView\(runtime\.camera, runtime\.frameTarget, runtime\.frameRadius\);\s*\}, \[props\.resetToken\]\)/,
  );

  assert.match(viewport, /source\.scaling\.copyFrom\(runtime\.baseScaling\)/);
  assert.match(viewport, /source\.position\.copyFrom\(runtime\.basePosition\)/);
  assert.match(viewport, /source\.rotationQuaternion = runtime\.baseRotation\.clone\(\)/);
});
