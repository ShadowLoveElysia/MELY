import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Three viewport renders and disposes a source-only MMD outline pass", () => {
  const viewport = readFileSync("src/components/Viewport3D.tsx", "utf8");
  const moeru = readFileSync("src/core/threeMoeruMmdDriver.ts", "utf8");

  assert.match(viewport, /createThreeMmdOutlinePass/);
  assert.match(viewport, /runtime\.mmdOutlinePass = createThreeMmdOutlinePass\(model\.mesh\)/);
  assert.match(
    viewport,
    /renderer\.render\(scene, activeCamera\);[\s\S]{0,300}runtime\.activeMode === "source"[\s\S]{0,180}runtime\.mmdOutlinePass\?\.render\(renderer, scene, activeCamera\)/,
  );
  assert.match(viewport, /__MELY_E2E_DISABLE_MMD_OUTLINE__/);
  assert.match(viewport, /__MELY_E2E_OUTLINE_PROBE__/);
  assert.match(viewport, /mely:three-outline-state/);
  assert.match(viewport, /__MELY_E2E_MATERIAL_PROBE__/);
  assert.match(viewport, /mely:three-material-state/);
  assert.match(viewport, /__MELY_E2E_VIEW_PROBE__/);
  assert.match(viewport, /mely:e2e-set-view/);
  assert.match(viewport, /runtime\.mmdOutlinePass\?\.dispose\(\)/);
  assert.match(viewport, /runtime\.mmdOutlinePass\.dispose\(\)/);
  assert.match(moeru, /adaptMoeruMmdOutlineParameters\(mmd\.mesh\)/);
});
