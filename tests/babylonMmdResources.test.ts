import assert from "node:assert/strict";
import test from "node:test";
import { createBabylonMmdReferenceFiles } from "../src/core/babylonMmdResources.ts";

const fileAt = (path: string, contents = path) => {
  const name = path.replaceAll("\\", "/").split("/").pop() ?? path;
  const file = new File([contents], name);
  Object.defineProperty(file, "webkitRelativePath", {
    configurable: true,
    value: path,
  });
  return file;
};

test("Babylon reference files fall back to names for ordinary File inputs", () => {
  const model = new File(["model"], "model.pmx");
  const texture = new File(["texture"], "face.png", { type: "image/png" });
  const result = createBabylonMmdReferenceFiles([model, texture], model);

  assert.deepEqual(result.referenceFiles.map((file) => file.webkitRelativePath), ["face.png"]);
  assert.deepEqual(result.warnings, []);
  assert.notEqual(result.referenceFiles[0], texture);
  assert.equal(result.referenceFiles[0]?.type, "image/png");
});

test("Babylon reference files are rebased to a nested model directory", () => {
  const model = fileAt("package/角色/model.pmx");
  const local = fileAt("package/角色/纹理/脸.png");
  const sibling = fileAt("package/shared/toon.bmp");
  const result = createBabylonMmdReferenceFiles([model, local, sibling], model);

  assert.deepEqual(result.referenceFiles.map((file) => file.webkitRelativePath), [
    "纹理/脸.png",
    "../shared/toon.bmp",
  ]);
});

test("Babylon reference paths normalize backslashes without losing Unicode", () => {
  const model = fileAt("根目录\\模型\\人物.pmd");
  const texture = fileAt("根目录\\模型\\材质\\衣服.TGA");
  const result = createBabylonMmdReferenceFiles([model, texture], model);

  assert.equal(result.referenceFiles[0]?.webkitRelativePath, "材质/衣服.TGA");
});

test("same-name textures in distinct directories keep distinct resolver keys", () => {
  const model = fileAt("pack/model.pmx");
  const first = fileAt("pack/body/shared.png", "body");
  const second = fileAt("pack/dress/shared.png", "dress");
  const result = createBabylonMmdReferenceFiles([model, first, second], model);

  assert.deepEqual(result.referenceFiles.map((file) => file.webkitRelativePath), [
    "body/shared.png",
    "dress/shared.png",
  ]);
  assert.deepEqual(result.warnings, []);
});

test("ambiguous resolver keys are rejected and surfaced as warnings", () => {
  const model = new File(["model"], "model.pmx");
  const first = new File(["first"], "shared.png");
  const second = new File(["second"], "SHARED.PNG");
  const result = createBabylonMmdReferenceFiles([model, first, second], model);

  assert.equal(result.referenceFiles.length, 1);
  assert.deepEqual(result.warnings, ["ambiguous: SHARED.PNG"]);
});
