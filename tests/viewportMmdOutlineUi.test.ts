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

test("Three viewport selects materials on click without treating Orbit drags as selection", () => {
  const viewport = readFileSync("src/components/Viewport3D.tsx", "utf8");

  assert.match(viewport, /createThreeMaterialPointerCandidate\(event, activeModel\.id\)/);
  assert.match(viewport, /updateThreeMaterialPointerCandidate\(materialPointerCandidate, event\)/);
  assert.match(viewport, /completesThreeMaterialPointerClick\(candidate, event\)/);
  assert.match(viewport, /const materialPointerDocument = renderer\.domElement\.ownerDocument/);
  for (const type of ["pointermove", "pointerup", "pointercancel"]) {
    assert.match(
      viewport,
      new RegExp(`materialPointerDocument\\.addEventListener\\("${type}",[\\s\\S]{0,80}, true\\)`),
    );
    assert.match(
      viewport,
      new RegExp(`materialPointerDocument\\.removeEventListener\\("${type}",[\\s\\S]{0,80}, true\\)`),
    );
  }
  assert.match(viewport, /renderer\.domElement\.addEventListener\("pointerdown"/);
  assert.match(viewport, /renderer\.domElement\.addEventListener\("lostpointercapture"/);
  assert.doesNotMatch(
    viewport,
    /renderer\.domElement\.addEventListener\("pointer(?:move|up|cancel)"/,
  );
  assert.match(viewport, /poseEditingRef\.current[\s\S]{0,160}onBoneSelectedRef\.current\(pickBoneAtPointer\(event\)\)/);
  assert.match(viewport, /collectThreeMmdMaterialPickMeshes\(activeModel\.root, activeModel\.mesh\)/);
  assert.match(viewport, /resolveThreeMmdMaterialHit\([\s\S]{0,220}hiddenMaterialIndexSetRef\.current/);
  assert.match(viewport, /createThreeMmdSelectionOutlinePass/);
  assert.match(viewport, /runtime\.mmdSelectionOutlinePass\?\.render/);
  assert.match(viewport, /runtime\.mmdSelectionOutlinePass\?\.dispose\(\)/);
});
