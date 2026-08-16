import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Three viewport wires display profiles independently from projection material updates", () => {
  const viewport = readFileSync("src/components/Viewport3D.tsx", "utf8");

  assert.match(viewport, /import \{ applyThreePreviewDisplayProfile \} from "\.\.\/core\/threePreviewDisplayProfiles"/);
  assert.match(viewport, /applyThreePreviewDisplayProfile\(runtime, previewMode, nightMode\)/);
  assert.match(viewport, /__MELY_E2E_DISPLAY_PROFILE_PROBE__/);
  assert.match(viewport, /mely:three-display-profile-state/);
  assert.match(
    viewport,
    /useEffect\(\(\) => \{\s*const runtime = runtimeRef\.current;\s*if \(!runtime\) return;\s*applyThreePreviewDisplayProfile\(runtime, previewMode, nightMode\);\s*\}, \[previewMode, nightMode\]\)/,
  );
  assert.match(
    viewport,
    /useEffect\(\(\) => \{\s*const runtime = runtimeRef\.current;\s*if \(!runtime\) return;\s*updateProjectionMaterials\(runtime\.hologramContent, nightMode, glow\);\s*\}, \[glow, nightMode\]\)/,
  );
  assert.doesNotMatch(viewport, /updateNightPreview/);
});
