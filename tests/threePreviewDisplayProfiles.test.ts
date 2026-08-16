import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  applyThreePreviewDisplayProfile,
  resolveThreePreviewDisplayProfile,
  type ThreePreviewDisplayTarget,
} from "../src/core/threePreviewDisplayProfiles.ts";

test("source preview uses the same neutral MMD display profile in day and night state", () => {
  const day = resolveThreePreviewDisplayProfile("source", false);
  const night = resolveThreePreviewDisplayProfile("source", true);

  assert.strictEqual(day, night);
  assert.equal(day.renderer.outputColorSpace, THREE.SRGBColorSpace);
  assert.equal(day.renderer.toneMapping, THREE.NoToneMapping);
  assert.equal(day.renderer.toneMappingExposure, 1);
  assert.deepEqual(day.keyLight, {
    color: "#ffffff",
    intensity: 1.8,
    position: [30, 100, 40],
  });
  assert.equal(day.rimLight.intensity, 0);
  assert.equal(day.rimLight.color, "#ffffff");
  assert.deepEqual(day.rimLight.position, [-90, 48, -65]);
  assert.deepEqual(day.hemisphereLight, {
    color: "#ffffff",
    groundColor: "#000000",
    intensity: 0.65,
  });
});

test("projection preview retains its established day and night display profiles", () => {
  const day = resolveThreePreviewDisplayProfile("hologram", false);
  const night = resolveThreePreviewDisplayProfile("hologram", true);

  assert.deepEqual(day.renderer, {
    outputColorSpace: THREE.SRGBColorSpace,
    toneMapping: THREE.ACESFilmicToneMapping,
    toneMappingExposure: 1.08,
  });
  assert.deepEqual(day.keyLight, {
    color: "#e7f6ff",
    intensity: 2.7,
    position: [55, 120, 95],
  });
  assert.deepEqual(day.rimLight, {
    color: "#67e6cb",
    intensity: 1.9,
    position: [-90, 48, -65],
  });
  assert.deepEqual(day.hemisphereLight, {
    color: "#a7cbd8",
    groundColor: "#181b1d",
    intensity: 1.15,
  });

  assert.deepEqual(night.renderer, {
    outputColorSpace: THREE.SRGBColorSpace,
    toneMapping: THREE.ACESFilmicToneMapping,
    toneMappingExposure: 0.78,
  });
  assert.equal(night.background, "#050811");
  assert.deepEqual(night.fog, { color: "#070b16", density: 0.00075 });
  assert.deepEqual(night.keyLight, {
    color: "#7f91c9",
    intensity: 0.42,
    position: [55, 120, 95],
  });
  assert.deepEqual(night.rimLight, {
    color: "#397f92",
    intensity: 0.5,
    position: [-90, 48, -65],
  });
  assert.deepEqual(night.hemisphereLight, {
    color: "#27375f",
    groundColor: "#04060c",
    intensity: 0.24,
  });
});

const assertTargetMatchesProfile = (
  target: ThreePreviewDisplayTarget,
  profile: ReturnType<typeof resolveThreePreviewDisplayProfile>,
) => {
  assert.equal(target.renderer.outputColorSpace, profile.renderer.outputColorSpace);
  assert.equal(target.renderer.toneMapping, profile.renderer.toneMapping);
  assert.equal(target.renderer.toneMappingExposure, profile.renderer.toneMappingExposure);
  assert.ok(target.scene.background instanceof THREE.Color);
  assert.ok(target.scene.background.equals(new THREE.Color(profile.background)));
  assert.ok(target.scene.fog instanceof THREE.FogExp2);
  assert.ok(target.scene.fog.color.equals(new THREE.Color(profile.fog.color)));
  assert.equal(target.scene.fog.density, profile.fog.density);
  assert.ok(target.keyLight.color.equals(new THREE.Color(profile.keyLight.color)));
  assert.deepEqual(target.keyLight.position.toArray(), profile.keyLight.position);
  assert.equal(target.keyLight.intensity, profile.keyLight.intensity);
  assert.ok(target.rimLight.color.equals(new THREE.Color(profile.rimLight.color)));
  assert.deepEqual(target.rimLight.position.toArray(), profile.rimLight.position);
  assert.equal(target.rimLight.intensity, profile.rimLight.intensity);
  assert.ok(target.hemisphereLight.color.equals(new THREE.Color(profile.hemisphereLight.color)));
  assert.ok(target.hemisphereLight.groundColor.equals(new THREE.Color(profile.hemisphereLight.groundColor)));
  assert.equal(target.hemisphereLight.intensity, profile.hemisphereLight.intensity);
};

test("display profile application follows projection transitions and restores source state", () => {
  const target: ThreePreviewDisplayTarget = {
    renderer: {
      outputColorSpace: THREE.NoColorSpace,
      toneMapping: THREE.CustomToneMapping,
      toneMappingExposure: 4,
    },
    scene: new THREE.Scene(),
    keyLight: new THREE.DirectionalLight("#ff0000", 9),
    rimLight: new THREE.DirectionalLight("#00ff00", 9),
    hemisphereLight: new THREE.HemisphereLight("#0000ff", "#ff00ff", 9),
  };

  applyThreePreviewDisplayProfile(target, "source", false);
  assertTargetMatchesProfile(target, resolveThreePreviewDisplayProfile("source", false));
  applyThreePreviewDisplayProfile(target, "hologram", false);
  assertTargetMatchesProfile(target, resolveThreePreviewDisplayProfile("hologram", false));
  applyThreePreviewDisplayProfile(target, "hologram", true);
  assertTargetMatchesProfile(target, resolveThreePreviewDisplayProfile("hologram", true));
  applyThreePreviewDisplayProfile(target, "source", true);
  assertTargetMatchesProfile(target, resolveThreePreviewDisplayProfile("source", true));
});
