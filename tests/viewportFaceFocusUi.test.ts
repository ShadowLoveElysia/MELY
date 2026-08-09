import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("the face-focus toolbar action is wired to the viewport camera", () => {
  const appSource = readFileSync("src/App.tsx", "utf8");
  const viewportSource = readFileSync("src/components/Viewport3D.tsx", "utf8");

  assert.match(appSource, /\bScanFace\b/);
  assert.match(appSource, /label=\{t\("toolbar\.focusFace"\)\}/);
  assert.match(appSource, /setFocusFaceToken\(\(value\) => value \+ 1\)/);
  assert.match(appSource, /focusFaceToken=\{focusFaceToken\}/);
  assert.doesNotMatch(appSource, /disabled=\{!mmdModel \|\| previewMode !== "source"\}/);

  assert.match(viewportSource, /createMmdFaceFrameSnapshot\(model\)/);
  assert.match(viewportSource, /result\?\.faceFrame/);
  assert.match(viewportSource, /const projectionFrame = runtime\.activeMode === "hologram"/);
  assert.match(viewportSource, /activeBounds\(runtime\)\.getSize/);
  assert.match(viewportSource, /runtime\.controls\.target\.copy\(target\)/);
  assert.match(
    viewportSource,
    /if \(focusFaceToken <= 0\) return;[\s\S]*if \(!runtime \|\| !activeModel\) return;[\s\S]*focusCameraOnFace\(runtime, activeModel, resultRef\.current\);[\s\S]*\[focusFaceToken\]/,
  );
});
