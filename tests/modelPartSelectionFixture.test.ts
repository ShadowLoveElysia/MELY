import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import {
  parsePmdMetadata,
  parsePmdSectionInventory,
} from "@yohawing/three-mmd-loader/parser";

const require = createRequire(import.meta.url);
const {
  MODEL_PART_SELECTION_PROFILE,
  createMinimalPmd,
  createModelPartSelectionPmd,
} = require("../scripts/fixtures/generate-minimal-pmd.cjs") as {
  MODEL_PART_SELECTION_PROFILE: {
    materialCount: number;
    targetMaterialIndex: number;
    preservedMaterialIndex: number;
    clickRois: Record<number, { xMin: number; xMax: number; yMin: number; yMax: number }>;
    validationRois: Record<string, { xMin: number; xMax: number; yMin: number; yMax: number }>;
  };
  createMinimalPmd: (options?: Record<string, unknown>) => Uint8Array;
  createModelPartSelectionPmd: (options?: Record<string, unknown>) => Uint8Array;
};

const readUint32 = (bytes: Uint8Array, offset: number) => (
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true)
);

const locateMaterialSection = (bytes: Uint8Array) => {
  const vertexCountOffset = 3 + 4 + 20 + 256;
  const vertexCount = readUint32(bytes, vertexCountOffset);
  const indexCountOffset = vertexCountOffset + 4 + vertexCount * 38;
  const indexCount = readUint32(bytes, indexCountOffset);
  const materialCountOffset = indexCountOffset + 4 + indexCount * 2;
  return {
    materialCountOffset,
    materialCount: readUint32(bytes, materialCountOffset),
    firstMaterialOffset: materialCountOffset + 4,
  };
};

test("model-part selection PMD is deterministic with two separated material groups", () => {
  const first = createModelPartSelectionPmd();
  const second = createModelPartSelectionPmd();
  assert.deepEqual(first, second);

  const metadata = parsePmdMetadata(first);
  const inventory = parsePmdSectionInventory(first);
  assert.equal(metadata.counts.vertices, 32);
  assert.equal(metadata.counts.faces, 56);
  assert.equal(metadata.counts.materials, 2);
  assert.equal(metadata.counts.bones, 5);
  assert.equal(metadata.counts.morphs, 2);
  assert.equal(metadata.trailingBytes, 0);
  assert.equal(inventory.sections.find((section) => section.name === "materials")?.count, 2);

  const { materialCount, firstMaterialOffset } = locateMaterialSection(first);
  assert.equal(materialCount, 2);
  const view = new DataView(first.buffer, first.byteOffset, first.byteLength);
  const materialRecordSize = 70;
  const indexCountOffset = 46;
  const firstIndexCount = view.getUint32(firstMaterialOffset + indexCountOffset, true);
  const secondIndexCount = view.getUint32(
    firstMaterialOffset + materialRecordSize + indexCountOffset,
    true,
  );
  assert.equal(firstIndexCount, 84);
  assert.equal(secondIndexCount, 84);
  assert.equal(firstIndexCount + secondIndexCount, metadata.counts.faces * 3);

  const firstDiffuseRed = view.getFloat32(firstMaterialOffset, true);
  const firstDiffuseBlue = view.getFloat32(firstMaterialOffset + 8, true);
  const secondDiffuseRed = view.getFloat32(firstMaterialOffset + materialRecordSize, true);
  const secondDiffuseBlue = view.getFloat32(firstMaterialOffset + materialRecordSize + 8, true);
  assert.ok(firstDiffuseRed > firstDiffuseBlue);
  assert.ok(secondDiffuseBlue > secondDiffuseRed);
});

test("selection fixture exposes stable non-overlapping click ROIs", () => {
  assert.equal(MODEL_PART_SELECTION_PROFILE.materialCount, 2);
  assert.equal(MODEL_PART_SELECTION_PROFILE.targetMaterialIndex, 0);
  assert.equal(MODEL_PART_SELECTION_PROFILE.preservedMaterialIndex, 1);
  const target = MODEL_PART_SELECTION_PROFILE.clickRois[0];
  const preserved = MODEL_PART_SELECTION_PROFILE.clickRois[1];
  for (const roi of [target, preserved]) {
    assert.ok(roi.xMin >= 0 && roi.xMax <= 1 && roi.xMin < roi.xMax);
    assert.ok(roi.yMin >= 0 && roi.yMax <= 1 && roi.yMin < roi.yMax);
  }
  assert.ok(target.xMax <= preserved.xMin);
  for (const roi of Object.values(MODEL_PART_SELECTION_PROFILE.validationRois)) {
    assert.ok(roi.xMin >= 0 && roi.xMax <= 1 && roi.xMin < roi.xMax);
    assert.ok(roi.yMin >= 0 && roi.yMax <= 1 && roi.yMin < roi.yMax);
  }
  assert.ok(
    MODEL_PART_SELECTION_PROFILE.validationRois.targetInterior.xMax
      < MODEL_PART_SELECTION_PROFILE.validationRois.preserved.xMin,
  );
});

test("the legacy minimal PMD output stays on its one-material contract", () => {
  const metadata = parsePmdMetadata(createMinimalPmd());
  assert.equal(metadata.counts.vertices, 16);
  assert.equal(metadata.counts.faces, 28);
  assert.equal(metadata.counts.materials, 1);
});
