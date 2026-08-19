import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("the single mcfunction export streams without a resource-budget hard stop", () => {
  const source = readFileSync("src/App.tsx", "utf8");
  const start = source.indexOf('if (request.format === "mcfunction") {');
  const end = source.indexOf("let bytes: Uint8Array;", start);
  const branch = start >= 0 && end > start ? source.slice(start, end) : "";

  assert.ok(branch.length > 0, "mcfunction export branch is missing");
  assert.match(branch, /createMcfunctionBehaviorPackZipStream/);
  assert.match(branch, /openDesktopChunkWriterWithDialog/);
  assert.match(branch, /\(chunk\) => writer\.write\(chunk\)/);
  assert.match(branch, /await writer\.close\(\)/);
  assert.match(branch, /await writer\.abort\(\)/);
  assert.doesNotMatch(branch, /maxOutputBytes: DEFAULT_WEB_BUNDLE_OUTPUT_BUDGET_BYTES/);
  assert.match(source, /webRetentionWarningBytes > DEFAULT_WEB_BUNDLE_OUTPUT_BUDGET_BYTES/);
  assert.match(source, /resourceRiskReasons\.push\("webRetention"\)/);
  assert.match(branch, /downloadBinaryChunks\(chunks, `\$\{request\.name\}\.zip`, "application\/zip"\)/);

  assert.doesNotMatch(source, /createMcfunctionBehaviorPack\(request\.document/);
  assert.doesNotMatch(source, /\bzipSync\b/);
});
