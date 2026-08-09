import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import {
  parsePmdMetadata,
  parsePmdSectionInventory,
  parseVmd,
  parseVmdMetadata,
} from "@yohawing/three-mmd-loader/parser";

const require = createRequire(import.meta.url);
const { createMinimalPmd } = require("../scripts/fixtures/generate-minimal-pmd.cjs") as {
  createMinimalPmd: (options?: Record<string, unknown>) => Uint8Array;
};
const { createComplexVmd } = require("../scripts/fixtures/generate-complex-vmd.cjs") as {
  createComplexVmd: () => Uint8Array;
};

const pmdFixture = Uint8Array.from(readFileSync(new URL("./fixtures/mely-input-e2e.pmd", import.meta.url)));
const vmdFixture = Uint8Array.from(readFileSync(new URL("./fixtures/mely-complex-motion-e2e.vmd", import.meta.url)));

test("PMD fixture is deterministic and contains material, morph, and two-link IK data", () => {
  assert.deepEqual(pmdFixture, createMinimalPmd());
  const metadata = parsePmdMetadata(pmdFixture);
  const inventory = parsePmdSectionInventory(pmdFixture);

  assert.equal(metadata.format, "pmd");
  assert.equal(metadata.counts.vertices, 16);
  assert.equal(metadata.counts.faces, 28);
  assert.equal(metadata.counts.materials, 1);
  assert.equal(metadata.counts.bones, 5);
  assert.equal(metadata.counts.iks, 1);
  assert.equal(metadata.counts.morphs, 2);
  assert.equal(inventory.sections.find((section) => section.name === "iks")?.count, 1);
  assert.equal(inventory.sections.find((section) => section.name === "morphs")?.count, 2);
  assert.equal(metadata.trailingBytes, 0);
});

test("complex VMD fixture is deterministic with four bone tracks and a smile morph", () => {
  assert.deepEqual(vmdFixture, createComplexVmd());
  const animation = parseVmd(vmdFixture);
  const metadata = parseVmdMetadata(vmdFixture);

  assert.equal(animation.metadata.maxFrame, 30);
  assert.equal(metadata.counts.bones, 12);
  assert.equal(metadata.counts.morphs, 3);
  assert.deepEqual(Object.keys(animation.boneTracks), ["root", "upper", "lower", "ik_goal"]);
  assert.deepEqual([...animation.morphTracks.smile.frames], [0, 15, 30]);
  assert.deepEqual([...animation.morphTracks.smile.weights], [0, 0.5, 1]);
  assert.equal(metadata.trailingBytes, 0);
});
