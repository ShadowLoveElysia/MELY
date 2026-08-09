import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("the single mcfunction export streams to desktop and bounded web sinks", () => {
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
  assert.match(branch, /maxOutputBytes: DEFAULT_WEB_BUNDLE_OUTPUT_BUDGET_BYTES/);
  assert.match(branch, /downloadBinaryChunks\(chunks, `\$\{request\.name\}\.zip`, "application\/zip"\)/);

  assert.doesNotMatch(source, /createMcfunctionBehaviorPack\(request\.document/);
  assert.doesNotMatch(source, /\bzipSync\b/);
});
