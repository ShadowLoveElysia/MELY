import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("resource clearing is only exposed through the viewport trash dialog", () => {
  const app = readFileSync("src/App.tsx", "utf8");
  const sidebar = readFileSync("src/components/Sidebar.tsx", "utf8");
  const styles = readFileSync("src/index.css", "utf8");

  assert.doesNotMatch(sidebar, /resource-candidate-select/);
  assert.doesNotMatch(sidebar, /onModelSelected|onMotionSelected/);
  assert.doesNotMatch(sidebar, /sidebar\.packageModels|sidebar\.motion\.danceSelect|sidebar\.motion\.expressionSelect/);

  assert.match(app, /ref=\{clearResourcesTriggerRef\}[\s\S]*className="icon-button--destructive"[\s\S]*<Trash2/);
  assert.match(app, /open=\{clearResourcesOpen\}[\s\S]*restoreFocusTo=\{clearResourcesTriggerRef\.current\}/);
  assert.match(app, /checked=\{clearResourceSelection\.dance\}[\s\S]*toggleClearResource\("dance"/);
  assert.match(app, /checked=\{clearResourceSelection\.expression\}[\s\S]*toggleClearResource\("expression"/);
  assert.match(app, /checked=\{clearResourceSelection\.model\}[\s\S]*toggleClearResource\("model"/);
  assert.match(app, /\? \{ model: true, dance: true, expression: true \}/);

  const closeHandler = app.match(/const closeClearResources = \(\) => \{[\s\S]*?\n  \};/)?.[0] ?? "";
  assert.match(closeHandler, /setClearResourcesOpen\(false\)/);
  assert.match(closeHandler, /setClearResourceSelection\(emptyClearResourceSelection\(\)\)/);
  assert.doesNotMatch(closeHandler, /clearCurrentModel|clearMotion/);

  assert.match(app, /if \(selection\.model\) \{[\s\S]*await clearCurrentModel\(\)/);
  assert.match(app, /model\.clearMotion\(\)[\s\S]*kinds\.forEach\(resetMotionTrack\)/);
  assert.match(styles, /\.icon-button--destructive[\s\S]*background: #b52d37/);
  assert.match(styles, /\.window-action--destructive[\s\S]*background: #b52d37/);

  assert.match(app, /inspectMmdModels\(expanded\)/);
  assert.match(app, /inspectMmdMotionCandidates\(packageFiles, loaded\)/);
  assert.match(app, /await loadModelFromPackage\(expanded, modelFile, modelPath, requestId\)/);
  assert.match(app, /installMotionTrack\(kind, loadedMotion, candidate\.path\)/);
  assert.match(app, /model\.clearMotion\(\);[\s\S]*resetMotionTracks\(\);[\s\S]*model\.importMelyPose/);
  assert.doesNotMatch(app, /expandedAssetsRef\.current = expandedAssetsRef\.current\.filter[\s\S]{0,180}endsWith\("\.vmd"\)/);
});

test("physics is explicit, lazy, and settled before generation snapshots", () => {
  const app = readFileSync("src/App.tsx", "utf8");
  const model = readFileSync("src/core/mmdModel.ts", "utf8");
  const physics = readFileSync("src/core/mmdPhysics.ts", "utf8");

  assert.match(app, /const \[physicsEnabled, setPhysicsEnabled\] = useState\(false\)/);
  assert.match(app, /await model\.setPhysicsEnabled\(enabled\)/);
  assert.match(app, /setStageKey\("app\.stage\.capturePose"\);[\s\S]*if \(model\.physicsEnabled\(\)\) model\.updatePose\(currentMotionTimes\(\)\);[\s\S]*createMmdMeshSnapshot/);
  assert.match(model, /physics: "external"/);
  assert.match(model, /model\.setAnimation\(emptyRuntimeAnimation\)/);
  assert.match(physics, /mmd_bullet\.js\?raw/);
  assert.match(physics, /mmd_bullet\.wasm\?url/);
});

test("sidebar resizing persists its width while numeric readouts remain visible", () => {
  const app = readFileSync("src/App.tsx", "utf8");
  const sidebar = readFileSync("src/components/Sidebar.tsx", "utf8");
  const styles = readFileSync("src/index.css", "utf8");

  assert.match(app, /SIDEBAR_WIDTH_STORAGE_KEY = "mely\.sidebarWidth"/);
  assert.match(app, /window\.addEventListener\("pointermove", onPointerMove\)/);
  assert.match(app, /localStorage\.setItem\(SIDEBAR_WIDTH_STORAGE_KEY, String\(sidebarWidth\)\)/);
  assert.match(sidebar, /className="sidebar-resize-handle"/);
  assert.match(sidebar, /role="separator"/);
  assert.match(styles, /flex: 0 0 var\(--sidebar-width, 372px\)/);
  assert.match(styles, /\.model-stat-grid[\s\S]*repeat\(auto-fit, minmax\(64px, 1fr\)\)/);
  assert.match(styles, /\.model-stat-grid strong[\s\S]*overflow-wrap: anywhere[\s\S]*white-space: normal/);
  assert.match(styles, /\.viewport-motion__scrubber output[\s\S]*min-width: max-content[\s\S]*white-space: nowrap/);
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]*\.sidebar-resize-handle[\s\S]*display: none/);
});
