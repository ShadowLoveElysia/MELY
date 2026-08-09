import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import {
  parseVmd,
  parseVmdMetadata,
  parseVmdSectionInventory,
} from "@yohawing/three-mmd-loader/parser";

const require = createRequire(import.meta.url);
const { createMinimalVmd } = require("../scripts/fixtures/generate-minimal-vmd.cjs") as {
  createMinimalVmd: () => Uint8Array;
};
const fixtureBytes = Uint8Array.from(readFileSync(new URL("./fixtures/mely-motion-e2e.vmd", import.meta.url)));

const approximately = (actual: number, expected: number, epsilon = 1e-6) => {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
};

test("minimal MELY VMD is a complete VMD 2.0 file with no trailing data", () => {
  const bytes = createMinimalVmd();
  assert.deepEqual(fixtureBytes, bytes);
  const metadata = parseVmdMetadata(bytes);
  const inventory = parseVmdSectionInventory(bytes);

  assert.equal(bytes.byteLength, 518);
  assert.equal(metadata.signature, "Vocaloid Motion Data 0002");
  assert.equal(metadata.modelName, "MELY E2E");
  assert.deepEqual(metadata.counts, {
    bones: 4,
    morphs: 0,
    cameras: 0,
    lights: 0,
    selfShadows: 0,
    properties: 0,
  });
  assert.equal(metadata.trailingBytes, 0);
  assert.deepEqual(inventory.sections.map(({ name, count }) => [name, count]), [
    ["bone", 4],
    ["morph", 0],
    ["camera", 0],
    ["light", 0],
    ["selfShadow", 0],
    ["property", 0],
  ]);
  assert.equal(inventory.trailingBytes, 0);
});

test("minimal MELY VMD has distinct F0 and F30 center and upper-body poses", () => {
  const animation = parseVmd(createMinimalVmd());
  const center = animation.boneTracks["センター"];
  const upperBody = animation.boneTracks["上半身"];

  assert.equal(animation.metadata.maxFrame, 30);
  assert.deepEqual(Object.keys(animation.boneTracks).sort(), ["センター", "上半身"].sort());
  assert.deepEqual([...center.frames], [0, 30]);
  assert.deepEqual([...upperBody.frames], [0, 30]);
  assert.deepEqual([...center.translations.slice(0, 3)], [0, 0, 0]);
  assert.deepEqual([...center.translations.slice(3, 6)], [2, 0.75, 0]);
  assert.deepEqual([...upperBody.rotations.slice(0, 4)], [0, 0, 0, 1]);
  approximately(upperBody.rotations[6], Math.sin(35 * Math.PI / 360));
  approximately(upperBody.rotations[7], Math.cos(35 * Math.PI / 360));
});
