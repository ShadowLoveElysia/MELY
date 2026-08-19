import assert from "node:assert/strict";
import test from "node:test";
import {
  assertWorkerMaterialCapabilities,
  assertWorkerResources,
  preflightWorkerResources,
} from "../src/core/workerResourcePreflight";
import {
  DEFAULT_MINECRAFT_VERSION,
  JAVA_VERSION_PROFILES,
  type JavaVersionProfile,
} from "../src/core/minecraftVersions";
import type { MmdMeshSnapshot, SolidOptions, WorkerCommand } from "../src/types";

const mesh = (
  width: number,
  height: number,
  depth: number,
  textureBytes = 0,
): MmdMeshSnapshot => ({
  positions: Float32Array.from([
    0, 0, 0,
    width, 0, 0,
    0, height, depth,
  ]),
  indices: Uint32Array.from([0, 1, 2]),
  triangleMaterials: Uint16Array.from([0]),
  ...(textureBytes > 0 ? {
    textures: [{
      width: textureBytes,
      height: 1,
      pixels: new Uint8ClampedArray(textureBytes),
    }],
  } : {}),
});

const solidOptions = (targetHeight: number, fillMode: "shell" | "filled"): SolidOptions => ({
  targetHeight,
  alphaThreshold: 0.3,
  thicknessCompensation: 0.08,
  fillMode,
  palettePreset: "clean",
  faceDetail: "off",
  materialTheme: "original",
  dithering: 0,
  emissiveMapping: true,
  emissiveMaterialIndices: [],
  ruinDecoration: 0,
  skinProtection: true,
  skinMaterialIndices: [],
  excludeGravity: true,
  excludeRare: true,
});

const solidCommand = (
  source: MmdMeshSnapshot,
  targetHeight: number,
  fillMode: "shell" | "filled",
): WorkerCommand => ({
  type: "GENERATE_SOLID",
  jobId: "solid",
  options: solidOptions(targetHeight, fillMode),
  source: { kind: "mesh", mesh: source },
});

test("Worker resource preflight derives normalized dimensions from transferred mesh data", () => {
  const result = preflightWorkerResources(solidCommand(mesh(2, 4, 1, 1_024), 101, "shell"));

  assert.deepEqual([result.width, result.height, result.depth], [51, 101, 26]);
  assert.equal(result.triangleCount, 1);
  assert.equal(result.textureBytes, 1_024);
  assert.equal(result.allowed, true);
  assert.equal(result.solidWorkEstimate?.triangleCandidateUpperBounds.length, 1);
  assert.ok((result.solidWorkEstimate?.totalCandidateUpperBound ?? 0) > 0);
  assert.ok(
    (result.solidWorkEstimate?.legacyAabbCandidateTests ?? 0)
      >= (result.solidWorkEstimate?.maxLegacyAabbCandidateTests ?? 0),
  );
});

test("Worker resource preflight reports a filled 4064 workload as a confirmation risk", () => {
  const result = preflightWorkerResources(solidCommand(mesh(2, 4, 2), 4_064, "filled"));

  assert.equal(result.height, 4_064);
  assert.equal(result.allowed, true);
  assert.equal(result.reason, "volume");
  assert.equal(result.requiresConfirmation, true);
  assert.ok(result.risks.includes("volume"));
});

test("Worker resource assertions return budget risks instead of hard-rejecting confirmed work", () => {
  const command = solidCommand(mesh(2, 4, 2), 4_064, "filled");
  const result = assertWorkerResources(command);

  assert.equal(result.allowed, true);
  assert.equal(result.reason, "volume");
  assert.equal(result.requiresConfirmation, true);
  assert.equal(result.height, 4_064);
  assert.ok((result.solidWorkEstimate?.totalCandidateUpperBound ?? 0) > 0);
});

test("Worker hologram preflight mirrors the generator's sparse 4064 interior plan", () => {
  const command: WorkerCommand = {
    type: "GENERATE_HOLOGRAM",
    jobId: "hologram",
    options: {
      targetHeight: 4_064,
      sampleSpacing: 3,
      interiorDensity: 100,
      material: "mixed",
      directionMode: "vertical",
      preserveFace: true,
      glow: 70,
    },
    generationSeed: { contentHash: "fixture", minecraftVersion: "1.20.1" },
    source: { kind: "mesh", mesh: mesh(2, 4, 2) },
  };
  const result = preflightWorkerResources(command);

  assert.equal(result.allowed, true);
  assert.ok(result.estimatedBlocks > 320_000);
  assert.equal(result.requiresConfirmation, true);
  assert.ok(result.risks.includes("blocks"));
});

test("Worker resource preflight rejects malformed geometry instead of trusting UI estimates", () => {
  const invalid = mesh(2, 4, 1);
  invalid.positions[1] = Number.NaN;
  assert.throws(
    () => preflightWorkerResources(solidCommand(invalid, 320, "shell")),
    /non-finite vertex/,
  );
});

test("Worker resource preflight rejects damaged triangle indices", () => {
  const invalid = mesh(2, 4, 1);
  invalid.indices[2] = 99;
  assert.throws(
    () => preflightWorkerResources(solidCommand(invalid, 320, "shell")),
    /out of bounds/,
  );
});

test("all registered Java profiles may generate sparse 2032 and 4064 holograms", () => {
  for (const profile of JAVA_VERSION_PROFILES) {
    for (const targetHeight of [2_032, 4_064]) {
      const command: WorkerCommand = {
        type: "GENERATE_HOLOGRAM",
        jobId: `${profile.id}-${targetHeight}`,
        versionId: profile.id,
        options: {
          targetHeight,
          sampleSpacing: 12,
          interiorDensity: 0,
          material: "mixed",
          directionMode: "vertical",
          preserveFace: true,
          glow: 70,
        },
        generationSeed: { contentHash: "fixture", minecraftVersion: profile.id },
        source: { kind: "mesh", mesh: mesh(0.001, 4, 0.001) },
      };

      assert.doesNotThrow(() => assertWorkerMaterialCapabilities(command), profile.id);
      assert.equal(assertWorkerResources(command).allowed, true, `${profile.id} ${targetHeight}`);
    }
  }
});

test("Worker treats profile test status and audited block flags as advisory", () => {
  const command: WorkerCommand = {
    type: "GENERATE_HOLOGRAM",
    jobId: "untested-profile",
    versionId: DEFAULT_MINECRAFT_VERSION.id,
    options: {
      targetHeight: 320,
      sampleSpacing: 3,
      material: "mixed",
      directionMode: "vertical",
      preserveFace: true,
      glow: 70,
    },
    generationSeed: {
      contentHash: "fixture",
      minecraftVersion: DEFAULT_MINECRAFT_VERSION.id,
    },
    source: { kind: "mesh", mesh: mesh(2, 4, 2) },
  };
  const untested: JavaVersionProfile = {
    ...DEFAULT_MINECRAFT_VERSION,
    releaseStatus: "unavailable",
    verification: null,
    blocks: { whiteStainedGlassPane: false, endRod: false },
  };

  assert.doesNotThrow(() => assertWorkerMaterialCapabilities(command, untested));
});

test("Worker generation still rejects an unregistered version identifier", () => {
  const command: WorkerCommand = {
    type: "GENERATE_HOLOGRAM",
    jobId: "unknown-version",
    versionId: "community-unknown",
    options: {
      targetHeight: 320,
      sampleSpacing: 3,
      material: "mixed",
      directionMode: "vertical",
      preserveFace: true,
      glow: 70,
    },
    generationSeed: { contentHash: "fixture", minecraftVersion: "community-unknown" },
    source: { kind: "mesh", mesh: mesh(2, 4, 2) },
  };

  assert.throws(() => assertWorkerMaterialCapabilities(command), /PROFILE_UNKNOWN/);
});
