import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync("src/App.tsx", "utf8");

test("App owns material selection and forwards the common renderer contract", () => {
  assert.match(
    app,
    /const \[selectedMaterialIndex, setSelectedMaterialIndex\] = useState<number \| null>\(null\)/,
  );
  assert.match(
    app,
    /const \[materialSelectionRequestId, setMaterialSelectionRequestId\] = useState\(0\)/,
  );

  const sidebar = app.match(/<Sidebar[\s\S]*?\/>/)?.[0] ?? "";
  assert.match(sidebar, /selectedMaterialIndex=\{selectedMaterialIndex\}/);
  assert.match(sidebar, /materialSelectionRequestId=\{materialSelectionRequestId\}/);
  assert.match(sidebar, /onMaterialSelectionChange=\{changeMaterialSelection\}/);

  const viewport = app.match(/<RendererViewport[\s\S]*?\/>/)?.[0] ?? "";
  assert.match(viewport, /selectedMaterialIndex=\{selectedMaterialIndex\}/);
  assert.match(viewport, /hiddenMaterialIndices=\{hiddenMaterialIndices\}/);
  assert.match(viewport, /materialSelectionRequestId=\{materialSelectionRequestId\}/);
  assert.match(viewport, /onMaterialSelected=\{\(selection\) => \{/);
  assert.match(
    viewport,
    /handleRendererMaterialSelection\(selection, viewportBinding\?\.modelId \?\? ""\)/,
  );
});

test("viewport material events reject stale, invalid, projected, and busy input", () => {
  const handler = app.match(
    /const handleRendererMaterialSelection = useCallback\([\s\S]*?\n  \}, \[[^\]]*\]\);/,
  )?.[0] ?? "";

  assert.match(handler, /sourceModelId !== model\.id/);
  assert.match(handler, /previewMode !== "source"/);
  assert.match(handler, /backendOperationRef\.current/);
  assert.match(handler, /modelLoading/);
  assert.match(handler, /processing/);
  assert.match(handler, /exporting/);
  assert.match(handler, /physicsLoading/);
  assert.match(handler, /selection\.modelId !== model\.id/);
  assert.match(handler, /Number\.isInteger\(selection\.materialIndex\)/);
  assert.match(
    handler,
    /model\.materials\[selection\.materialIndex\]\?\.index !== selection\.materialIndex/,
  );

  const emptySelection = handler.match(/if \(selection === null\) \{[\s\S]*?\n    \}/)?.[0] ?? "";
  assert.match(emptySelection, /setSelectedMaterialIndex\(null\)/);
  assert.doesNotMatch(emptySelection, /setSidebarOpen|setMaterialSelectionRequestId/);

  assert.match(handler, /setSidebarOpen\(true\)/);
  assert.match(handler, /setMaterialSelectionRequestId\(\(current\) => current \+ 1\)/);
  assert.doesNotMatch(handler, /invalidateProjection|setPartsRevision/);
});

test("selection clears on ordinary release and restores without a focus request on renderer switch", () => {
  const capture = app.match(
    /const captureMmdRuntimeRestoreState = useCallback\([\s\S]*?\n  \}\), \[[^\]]*\]\);/,
  )?.[0] ?? "";
  assert.match(capture, /selectedMaterialIndex,/);

  const release = app.match(
    /const releaseCurrentModel = useCallback\([\s\S]*?\n  \}, \[[^\]]*\]\);/,
  )?.[0] ?? "";
  assert.match(release, /setSelectedMaterialIndex\(null\)/);

  const restoreStart = app.indexOf("const restoredSelectedMaterialIndex");
  const restoreEnd = app.indexOf("activeMmdSourceRef.current", restoreStart);
  const restore = restoreStart >= 0 && restoreEnd >= 0
    ? app.slice(restoreStart, restoreEnd)
    : "";
  assert.match(restore, /restoreState\?\.selectedMaterialIndex \?\? null/);
  assert.match(restore, /Number\.isInteger\(restoredSelectedMaterialIndex\)/);
  assert.match(restore, /loaded\.materials\[restoredSelectedMaterialIndex\]\?\.index/);
  assert.match(restore, /setSelectedMaterialIndex/);
  assert.doesNotMatch(restore, /setMaterialSelectionRequestId|setSidebarOpen/);
});

test("visibility changes preserve material selection and remain the only parts mutation", () => {
  const visibility = app.match(
    /const changeMaterialVisibility = useCallback\([\s\S]*?\n  \}, \[[^\]]*\]\);/,
  )?.[0] ?? "";
  assert.match(visibility, /model\.setMaterialVisible\(index, visible\)/);
  assert.match(visibility, /invalidateProjection\("material-visibility"\)/);
  assert.match(visibility, /setPartsRevision\(\(value\) => value \+ 1\)/);
  assert.doesNotMatch(visibility, /setSelectedMaterialIndex/);

  const selection = app.match(
    /const changeMaterialSelection = useCallback\([\s\S]*?\n  \}, \[\]\);/,
  )?.[0] ?? "";
  assert.match(selection, /setSelectedMaterialIndex/);
  assert.doesNotMatch(selection, /invalidateProjection|setPartsRevision|setPreviewMode/);
});

test("global Escape clears material selection without consuming editable controls", () => {
  const shortcutStart = app.indexOf('event.key !== "Escape"');
  const shortcutEnd = app.indexOf(
    "useEffect(() => {\n    if (!poseEditing) return;",
    shortcutStart,
  );
  const shortcut = shortcutStart >= 0 && shortcutEnd >= 0
    ? app.slice(shortcutStart, shortcutEnd)
    : "";

  assert.match(shortcut, /event\.repeat/);
  assert.match(shortcut, /event\.defaultPrevented/);
  assert.match(shortcut, /selectedMaterialIndex === null/);
  assert.match(shortcut, /shouldIgnoreMotionShortcut\(event\.target\)/);
  assert.match(shortcut, /event\.preventDefault\(\)/);
  assert.match(shortcut, /changeMaterialSelection\(null\)/);
  assert.match(shortcut, /window\.addEventListener\("keydown", onKeyDown\)/);
  assert.match(shortcut, /window\.removeEventListener\("keydown", onKeyDown\)/);
  assert.doesNotMatch(shortcut, /setMotionPlayingState|undoPose|redoPose/);
});
