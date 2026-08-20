import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/components/PerformanceSettings.tsx", "utf8");
const sidebar = readFileSync("src/components/Sidebar.tsx", "utf8");
const app = readFileSync("src/App.tsx", "utf8");
const styles = readFileSync("src/index.css", "utf8");

const sourceSection = (
  value: string,
  startMarker: string,
  endMarker: string,
) => {
  const start = value.indexOf(startMarker);
  assert.notEqual(start, -1, `Missing source marker: ${startMarker}`);
  const end = value.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `Missing source marker: ${endMarker}`);
  return value.slice(start, end + endMarker.length);
};

const assertInOrder = (value: string, markers: readonly string[]) => {
  let offset = 0;
  markers.forEach((marker) => {
    const index = value.indexOf(marker, offset);
    assert.notEqual(index, -1, `Missing ordered source marker: ${marker}`);
    offset = index + marker.length;
  });
};

test("thread settings expose the shared capability contract and controlled values", () => {
  assert.match(source, /import type \{ PerformanceCapabilities \} from "\.\.\/core\/performancePreferences"/);
  assert.match(source, /export type PerformanceSettingsCapabilities = Pick<[\s\S]*"maximumThreads"/);
  assert.match(source, /mode: "auto" \| "manual"/);
  assert.match(source, /configuredThreads: number/);
  assert.match(source, /activeThreads: number \| null/);
  assert.match(source, /nativeJobAvailable: boolean/);
  assert.match(source, /onThreadsChange: \(threads: number\) => void/);
  assert.match(source, /onRestoreAuto: \(\) => void/);
});

test("thread input rounds and clamps committed values while rejecting invalid drafts", () => {
  assert.match(source, /export function normalizePerformanceThreadInput/);
  assert.match(source, /Number\.isFinite\(value\)/);
  assert.match(source, /input\.trim\(\) === ""/);
  assert.match(source, /clampInteger\(value, 1, Math\.max\(1, Math\.floor\(maximumThreads\)\)\)/);
  assert.match(source, /Math\.round\(value\)/);
  assert.match(source, /const nextThreads = normalizePerformanceThreadInput\(numberDraft, maximumThreads\)/);
});

test("range and number controls have translated visible labels and persistent guidance", () => {
  assert.match(source, /<strong id=\{headingId\}>\{t\("performance\.title"\)\}<\/strong>/);
  assert.match(source, /id=\{helperId\}[\s\S]*t\("performance\.helper"\)/);
  assert.match(source, /htmlFor=\{rangeId\}>\{t\("performance\.selectThreads"\)\}<\/label>/);
  assert.match(source, /type="range"[\s\S]*min=\{1\}[\s\S]*max=\{maximumThreads\}[\s\S]*aria-valuetext/);
  assert.match(source, /htmlFor=\{numberId\}>[\s\S]*t\("performance\.exactThreads"\)/);
  assert.match(source, /type="number"[\s\S]*inputMode="numeric"[\s\S]*aria-describedby=\{helperId\}/);
});

test("number input commits on Enter or blur and restores the prior value on Escape", () => {
  assert.match(source, /onBlur=\{\(\) => \{[\s\S]*commitNumberInput\(\)/);
  assert.match(source, /event\.key === "Enter"[\s\S]*event\.currentTarget\.blur\(\)/);
  assert.match(source, /event\.key === "Escape"[\s\S]*skipNextNumberBlurRef\.current = true[\s\S]*cancelNumberInput\(\)/);
});

test("processing keeps controls editable and separates native current and next values", () => {
  assert.match(source, /processing && normalizedActiveThreads !== null \? \([\s\S]*performance\.status\.currentTask/);
  assert.match(source, /performance\.status\.appliesNext/);
  assert.match(source, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(source, /className="performance-settings__readout"[\s\S]*performance\.status\.nextTask/);
  assert.doesNotMatch(source, /disabled=\{processing\}/);
  assert.match(source, /processing && !nativeJobAvailable[\s\S]*performance\.status\.webWorkerCurrent/);
  const statusStart = source.indexOf('className="performance-settings__status"');
  const statusEnd = source.indexOf('className="performance-settings__readout"', statusStart);
  assert.doesNotMatch(source.slice(statusStart, statusEnd), /selectedThreads/);
  assert.match(app, /const changeWorkerThreads = \(threads: number\) => \{\s*setPerformancePreferences/);
  assert.match(app, /const restoreAutomaticWorkerThreads = \(\) => \{\s*setPerformancePreferences/);
});

test("UI derives native availability from the probed capability and saves native-only settings", () => {
  assert.match(source, /performance\.backend\.ready" : "performance\.backend\.pending/);
  assert.match(sidebar, /<PerformanceSettings[\s\S]*nativeJobAvailable=\{nativeSolidVoxelJobAvailable\}/);
  assert.match(app, /probeSolidVoxelBackend\(\)/);
  assert.match(app, /PERFORMANCE_PREFERENCES_STORAGE_KEY/);
  assert.match(app, /serializePerformancePreferences\(performancePreferences\)/);
  const nativeRiskAssessment = sourceSection(
    app,
    "const nativeThreadRisk = assessNativeThreadRisk({",
    "let nativeThreadExecutionSnapshot = acceptedNativeThreadExecution",
  );
  assert.ok(nativeRiskAssessment.includes("nativeJobAvailable: nativeSolidVoxelJobAvailable"));
  assert.ok(nativeRiskAssessment.includes('mode === "solid"'));
  assert.ok(nativeRiskAssessment.includes("canRunNativeSolidOptions("));
  assert.match(app, /setActiveWorkerThreads\(nativeThreadExecutionSnapshot\?\.workerThreads \?\? null\)/);
});

test("thread warnings use the independent native execution snapshot and never hard block", () => {
  assert.match(app, /assessNativeThreadRisk/);
  assert.match(app, /continueSelectedNativeThreadExecution/);
  assert.match(app, /useRecommendedNativeThreadExecution/);
  assert.match(app, /nativeThreadExecutionSnapshot: NativeThreadExecutionSnapshot \| null/);
  assert.match(app, /pending\.nativeThreadExecutionSnapshot/);
  const acceptedExecutionGuard = sourceSection(
    app,
    "let nativeThreadExecutionSnapshot = acceptedNativeThreadExecution",
    "const targetHeight",
  );
  assert.ok(acceptedExecutionGuard.includes("!nativeSolidVoxelJobAvailable"));
  assert.ok(acceptedExecutionGuard.includes('mode !== "solid"'));
  assert.ok(acceptedExecutionGuard.includes("!canRunNativeSolidOptions("));
  assert.ok(acceptedExecutionGuard.includes('setToast(t("threadResourceRisk.stale"))'));
  assert.match(app, /threadResourceRisk\.continue/);
  assert.match(app, /threadResourceRisk\.useRecommended/);
  assert.match(app, /generateTriggerRef\.current = document\.activeElement/);
  assert.match(app, /restoreFocusTo=\{generateTriggerRef\.current\}/);
  assert.doesNotMatch(app, /threadResourceRisk[\s\S]{0,300}throw new/);
});

test("solid generation uses the unified native orchestrator and releases the uploaded WebView snapshot", () => {
  assert.ok(app.includes('from "./platform/nativeSolidVoxelRunOrchestrator"'));
  assert.ok(app.includes("nativeRun = await runNativeSolidVoxelJob({"));
  assert.doesNotMatch(app, /\bcreateNativeSolidVoxel(?:Job|Result)Store\b/);

  const nativeRunCall = sourceSection(
    app,
    "nativeRun = await runNativeSolidVoxelJob({",
    "materialization: {",
  );
  assertInOrder(nativeRunCall, [
    "snapshot,",
    "signal: abortController.signal",
    "onSnapshotUploaded: () => releaseMmdMeshSnapshot(snapshot)",
  ]);
});

test("completed native ownership survives materialization for Litematic write and final release", () => {
  const completedBranch = sourceSection(
    app,
    "nativeResultOwnershipRef.current = ownership;",
    "setPreviewMode(\"hologram\");",
  );
  assert.ok(completedBranch.includes("materialized.result"));
  assert.doesNotMatch(completedBranch, /resultStore\.(?:cancel|release)\(/);

  const nativeLitematicBranch = sourceSection(
    app,
    "const nativeOwnership = nativeResultOwnershipRef.current;",
    "byteLength = summary.byteLength;",
  );
  assertInOrder(nativeLitematicBranch, [
    "cachedDocument?.result === nativeOwnership.materialized.result",
    "cachedDocument.document === request.document",
    "nativeOwnership.client.writeLitematic({",
    "handle: nativeOwnership.handle",
  ]);

  const releaseOwnership = sourceSection(
    app,
    "const releaseNativeSolidVoxelOwnership = useCallback(async () => {",
    "}, []);",
  );
  assertInOrder(releaseOwnership, [
    "const previousCleanup = nativeOwnershipCleanupPromiseRef.current.catch",
    "await previousCleanup",
    "const resultOwnership = nativeResultOwnershipRef.current",
    "while (!await resultOwnership.resultStore.release())",
    "nativeResultOwnershipRef.current === resultOwnership",
    "nativeResultOwnershipRef.current = null",
  ]);
  assert.match(app, /void releaseNativeSolidVoxelOwnership\(\)\.catch/);
  assert.match(app, /void cancelNativeSolidVoxelExecution\(\)\.catch/);
  assertInOrder(nativeLitematicBranch, [
    "nativeWriteOperationId = acquireBackendOperation()",
    "selectDesktopSavePath",
    "nativeResultOwnershipRef.current !== nativeOwnership",
    "nativeOwnership.client.writeLitematic({",
  ]);
  assert.match(app, /if \(nativeWriteOperationId\) releaseBackendOperation\(nativeWriteOperationId\)/);
  assert.match(app, /const updateSolidOptions = \(patch: Partial<SolidOptions>\) => \{\s*if \(backendOperationRef\.current\) return;/);
  // 导出中心准备与生成相互独立；高度确认流程必须保持生成按钮可用。
  assert.match(sidebar, /disabled=\{!modelStats \|\| processing \|\| modelLoading \|\| !motionReady\}/);
});

test("thread settings styles provide compact layout and visible focus states", () => {
  assert.match(styles, /\.performance-settings \{[\s\S]*display: grid/);
  assert.match(styles, /\.performance-settings__range:focus-visible/);
  assert.match(styles, /\.performance-settings__number-input:focus-within/);
  assert.match(styles, /\.performance-settings__restore:disabled/);
  assert.match(styles, /@media \(forced-colors: active\)[\s\S]*\.performance-settings__range[\s\S]*appearance: auto/);
});
