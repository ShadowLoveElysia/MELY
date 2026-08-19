import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("worker errors release the active job and clear stale generation progress", () => {
  const source = readFileSync("src/App.tsx", "utf8");
  const errorBranch = source.match(
    /else if \(event\.type === "ERROR"\) \{([\s\S]*?)\n\s*\}/,
  )?.[1] ?? "";

  assert.match(errorBranch, /currentJobRef\.current = ""/);
  assert.match(errorBranch, /workerLifecycleRef\.current\?\.cancel\(\)/);
  assert.match(errorBranch, /setProcessing\(false\)/);
  assert.match(errorBranch, /setProgress\(0\)/);
  assert.match(errorBranch, /setStageKey\("app\.stage\.prepareGeneration"\)/);
  assert.match(errorBranch, /setPreviewMode\("source"\)/);
});
