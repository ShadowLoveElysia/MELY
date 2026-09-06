import assert from "node:assert/strict";
import test from "node:test";
import { createMmdResourceUrlBundle } from "../src/core/mmdResourceUrls.ts";

const fileAt = (path: string, contents = path) => {
  const name = path.replaceAll("\\", "/").split("/").pop() ?? path;
  const file = new File([contents], name);
  Object.defineProperty(file, "webkitRelativePath", {
    configurable: true,
    value: path,
  });
  return file;
};

test("Three resource URLs resolve model-relative and URL-encoded local paths", async () => {
  const model = fileAt("package/角色/model.pmx", "model-bytes");
  const texture = fileAt("package/角色/纹理/脸 image.png", "texture-bytes");
  const bundle = createMmdResourceUrlBundle([model, texture], model);

  try {
    const modelUrl = bundle.manager.resolveURL(bundle.modelUrl);
    const textureUrl = bundle.manager.resolveURL("纹理/%E8%84%B8%20image.png");

    assert.match(modelUrl, /^blob:/);
    assert.match(textureUrl, /^blob:/);
    assert.equal(await fetch(modelUrl).then((response) => response.text()), "model-bytes");
    assert.equal(await fetch(textureUrl).then((response) => response.text()), "texture-bytes");
    assert.deepEqual(bundle.missingPaths, []);
  } finally {
    bundle.dispose();
  }
});

test("Three resource URLs resolve a sibling package path before basename fallback", async () => {
  const model = fileAt("pack/models/character/model.pmx", "model-bytes");
  const sibling = fileAt("pack/shared/toon.bmp", "sibling-bytes");
  const sameName = fileAt("pack/models/character/toon.bmp", "local-bytes");
  const bundle = createMmdResourceUrlBundle([model, sibling, sameName], model);

  try {
    const siblingUrl = bundle.manager.resolveURL("../../shared/toon.bmp");
    const localUrl = bundle.manager.resolveURL("toon.bmp");

    assert.equal(await fetch(siblingUrl).then((response) => response.text()), "sibling-bytes");
    assert.equal(await fetch(localUrl).then((response) => response.text()), "local-bytes");
    assert.deepEqual(bundle.missingPaths, []);
  } finally {
    bundle.dispose();
  }
});

test("Three resource URLs do not overwrite duplicate paths or guess an ambiguous basename", () => {
  const model = fileAt("pack/model.pmx", "model-bytes");
  const first = fileAt("pack/body/shared.png", "first");
  const second = fileAt("pack/dress/shared.png", "second");
  const duplicatePath = fileAt("pack/body/shared.png", "duplicate");
  const bundle = createMmdResourceUrlBundle([model, first, second, duplicatePath], model);

  try {
    assert.deepEqual(bundle.warnings, []);

    const duplicatePathRequest = "pack/body/shared.png";
    assert.equal(bundle.manager.resolveURL(duplicatePathRequest), duplicatePathRequest);
    assert.deepEqual(bundle.warnings, ["ambiguous path: pack/body/shared.png"]);

    const basenameRequest = "materials/shared.png";
    assert.equal(bundle.manager.resolveURL(basenameRequest), basenameRequest);
    assert.deepEqual(bundle.missingPaths, []);
    assert.deepEqual(bundle.warnings, [
      "ambiguous path: pack/body/shared.png",
      "ambiguous basename: shared.png",
    ]);
  } finally {
    bundle.dispose();
  }
});

test("Three resource URLs report missing local paths once and retain the original request", () => {
  const model = fileAt("model.pmx", "model-bytes");
  const bundle = createMmdResourceUrlBundle([model], model);

  try {
    const requested = "textures/missing%20face.png?cache=1";
    assert.equal(bundle.manager.resolveURL(requested), requested);
    assert.equal(bundle.manager.resolveURL("textures/missing face.png"), "textures/missing face.png");
    assert.deepEqual(bundle.missingPaths, ["textures/missing face.png"]);
  } finally {
    bundle.dispose();
  }
});

test("Three resource URLs keep external and package-out requests untouched", () => {
  const model = fileAt("model.pmx", "model-bytes");
  const bundle = createMmdResourceUrlBundle([model], model);

  try {
    for (const requested of [
      "../outside.png",
      "/outside.png",
      "\\\\outside.png",
      "C:\\\\outside.png",
      "file:///outside.png",
      "https://example.test/outside.png",
    ]) {
      assert.equal(bundle.manager.resolveURL(requested), requested);
    }
    assert.deepEqual(bundle.missingPaths, []);
  } finally {
    bundle.dispose();
  }
});

test("disposing a resource URL bundle revokes every created Blob URL", async () => {
  const model = fileAt("model.pmx", "model-bytes");
  const texture = fileAt("textures/face.png", "texture-bytes");
  const bundle = createMmdResourceUrlBundle([model, texture], model);
  const modelUrl = bundle.manager.resolveURL(bundle.modelUrl);
  const textureUrl = bundle.manager.resolveURL("textures/face.png");

  assert.equal(await fetch(modelUrl).then((response) => response.text()), "model-bytes");
  assert.equal(await fetch(textureUrl).then((response) => response.text()), "texture-bytes");

  bundle.dispose();

  await assert.rejects(fetch(modelUrl));
  await assert.rejects(fetch(textureUrl));
});

test("resource bundle waits for manager requests that outlive model assembly", async () => {
  const model = fileAt("model.pmx", "model-bytes");
  const bundle = createMmdResourceUrlBundle([model], model);

  let completed = false;
  bundle.manager.itemStart("texture.png");
  const completion = bundle.waitForLoadCompletion().then(() => {
    completed = true;
  });
  await Promise.resolve();
  assert.equal(completed, false);

  bundle.manager.itemEnd("texture.png");
  await completion;
  assert.equal(completed, true);
  bundle.dispose();
});

test("disposing a resource bundle releases completion waiters", async () => {
  const model = fileAt("model.pmx", "model-bytes");
  const bundle = createMmdResourceUrlBundle([model], model);

  bundle.manager.itemStart("texture.png");
  const completion = bundle.waitForLoadCompletion();
  bundle.dispose();
  await completion;
});
