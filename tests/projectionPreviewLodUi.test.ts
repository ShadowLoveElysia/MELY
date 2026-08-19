import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("Three and Babylon projection previews use the bounded sample plan", () => {
  const three = readFileSync("src/components/Viewport3D.tsx", "utf8");
  const babylon = readFileSync("src/components/BabylonViewport.tsx", "utf8");

  for (const source of [three, babylon]) {
    assert.match(source, /createProjectionPreviewSamplePlan/);
    assert.match(source, /samplePlan\.samplePointCount/);
    assert.match(source, /samplePlan\.sourceIndexAt\(sampleIndex\)/);
    assert.match(source, /createSolidPreviewSource\(result\)/);
  }

  assert.match(three, /result\.bounds\.min/);
  assert.match(three, /result\.bounds\.max/);
  assert.match(babylon, /props\.result\?\.bounds/);
  assert.doesNotMatch(three, /new THREE\.InstancedMesh\([^\n]+result\.stats\.(?:blockCount|endRodCount|paneCount)/);
  assert.doesNotMatch(babylon, /result\.positions\.forEach/);
  assert.doesNotMatch(babylon, /new Map<number, Vector3\[\]>/);
});

test("renderer selection forwards the untouched result to exactly one backend", () => {
  const renderer = readFileSync("src/components/RendererViewport.tsx", "utf8");

  assert.match(renderer, /return <BabylonViewport \{\.\.\.props\} \/>/);
  assert.match(renderer, /return <ThreeMoeruViewport \{\.\.\.props\} \/>/);
  assert.match(renderer, /return <ThreeVanillaViewport \{\.\.\.props\} \/>/);
  assert.doesNotMatch(renderer, /positions\s*=/);
});
