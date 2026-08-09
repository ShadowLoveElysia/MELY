import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("the final Web runner captures deterministic release stages", () => {
  const source = readFileSync("scripts/run-web-final.ps1", "utf8");

  assert.match(source, /typescript\\bin\\tsc/);
  assert.match(source, /Get-ChildItem[^\n]+tests/);
  assert.match(source, /Sort-Object Name/);
  assert.match(source, /--test-concurrency=1/);
  assert.match(source, /--test-reporter=tap/);
  assert.match(source, /vite\\bin\\vite\.js/);
  assert.match(source, /RedirectStandardOutput/);
  assert.match(source, /RedirectStandardError/);
  assert.match(source, /ConvertTo-Json/);
  assert.match(source, /failedStage/);
  assert.match(source, /testFileCount/);
  assert.match(source, /testSummary/);
});

test("release validation has stable Windows runners for the five-format height matrix and 320 bundle", () => {
  const height = readFileSync("scripts/run-height-export-audit.ps1", "utf8");
  const bundle = readFileSync("scripts/run-real-320-hologram-bundle.ps1", "utf8");

  assert.match(height, /verify-height-export-e2e\.cjs/);
  assert.match(height, /MELY_E2E_ONLY_FORMAT = ""/);
  assert.match(height, /MELY_E2E_STOP_AFTER_SAFE = "0"/);
  assert.match(height, /height-export-five-format/);
  assert.match(bundle, /verify-release-workload\.cjs/);
  assert.match(bundle, /MELY_TARGET_HEIGHT = "320"/);
  assert.match(bundle, /MELY_EXPORT_FORMAT = "bundle"/);
  assert.match(bundle, /bundle-320/);
});
