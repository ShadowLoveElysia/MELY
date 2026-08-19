import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Babylon selection outline uses one depth-safe MMD outline pass", () => {
  const source = readFileSync("src/core/babylonSelectionOutline.ts", "utf8");

  assert.match(source, /class BabylonSelectionOutlineRenderer extends MmdOutlineRenderer/);
  assert.match(source, /STEP_AFTERRENDERINGMESH_OUTLINE/);
  assert.match(source, /engine\.setDepthBuffer\(true\)/);
  assert.match(source, /engine\.setDepthWrite\(false\)/);
  assert.match(source, /super\.render\(subMesh, batch\)/);
  assert.match(source, /finally \{/);
  assert.match(source, /depthState\.depthMask = savedDepthState\.depthMask/);
  assert.match(source, /engine\.setColorWrite\(savedColorWrite\)/);
  assert.match(source, /engine\.setAlphaMode\(savedAlphaMode, true\)/);
  assert.match(source, /material\.disableColorWrite = true/);
  assert.match(source, /material\.disableDepthWrite = true/);
  assert.match(source, /material\.renderOutline = false/);
  assert.doesNotMatch(source, /material\.renderOutline = true/);
});

test("Babylon selection outline stays material scoped and releases shared resources safely", () => {
  const source = readFileSync("src/core/babylonSelectionOutline.ts", "utf8");

  assert.match(source, /viewport\.resolveMaterialIndex\(source, sourceSubMesh\._id\)/);
  assert.match(source, /proxy\.isPickable = false/);
  assert.match(source, /melySelectionProxy: true/);
  assert.match(source, /proxy\.releaseSubMeshes\(\)/);
  assert.match(source, /new SubMesh\(/);
  assert.match(source, /proxy\.skeleton = source\.skeleton/);
  assert.match(source, /proxy\.morphTargetManager = source\.morphTargetManager/);
  assert.match(source, /sync: syncEntries/);
  assert.match(source, /sourceMaterial[\s\S]*alpha > 0\.01/);
  assert.match(source, /proxy\.setEnabled\(proxy\.subMeshes\.length > 0\);\s*\}\);\s*syncEntries\(\)/);
  assert.match(
    source,
    /proxy\.geometry\?\.releaseForMesh\(proxy, false\);\s*[\s\S]*proxy\.morphTargetManager = null/,
  );
  assert.match(source, /proxy\.skeleton = null/);
  assert.match(source, /proxy\.morphTargetManager = null/);
  assert.match(source, /proxy\.dispose\(true, false\)/);
  assert.match(source, /if \(disposed\) return;\s*disposed = true;\s*selectionRenderer\.dispose\(\)/);
  assert.doesNotMatch(source, /HighlightLayer|SelectionOutlineLayer/);
});

test("Babylon selection outline preserves cutouts only when an alpha texture exists", () => {
  const source = readFileSync("src/core/babylonSelectionOutline.ts", "utf8");

  assert.match(source, /needAlphaTestingForMesh\?\.\(sourceMesh\)/);
  assert.match(source, /const alphaTestTexture = needsAlphaTest/);
  assert.match(source, /if \(alphaTestTexture\) \{/);
  assert.match(source, /material\.diffuseTexture = alphaTestTexture/);
  assert.match(source, /material\.transparencyMode = Material\.MATERIAL_ALPHATESTANDBLEND/);
  assert.match(source, /else \{[\s\S]*material\.transparencyMode = Material\.MATERIAL_ALPHABLEND/);
});

test("Babylon viewport picks only source meshes and pairs pointer listeners", () => {
  const source = readFileSync("src/components/BabylonViewport.tsx", "utf8");

  assert.match(source, /babylonScene\.multiPick\(/);
  assert.match(source, /viewport\.sourceMeshes\.flatMap/);
  assert.match(source, /\(mesh\) => mesh === sourceMesh/);
  assert.match(source, /createBabylonVisibleMaterialTrianglePredicate/);
  assert.match(source, /previewModeRef\.current === "source"/);
  assert.match(source, /!backendBusyRef\.current/);
  assert.match(source, /!modelLoadingRef\.current/);
  assert.match(source, /!poseEditingRef\.current/);
  assert.match(source, /selectionOutline\.sync\(\);\s*scene\.render\(\)/);
  assert.match(source, /props\.partsRevision/);
  assert.match(source, /if \(shouldFrame\) \{[\s\S]*camera\.radius = runtime\.frameRadius/);
  assert.match(source, /viewport\.aria\.source/);
  assert.match(source, /viewport\.aria\.projection/);
  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture"]) {
    assert.match(source, new RegExp(`addEventListener\\(\"${type}\"`));
    assert.match(source, new RegExp(`removeEventListener\\(\"${type}\"`));
  }
});
