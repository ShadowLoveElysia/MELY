import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Babylon MMD loads SPR WASM through a stable explicit Vite asset URL", () => {
  const runtime = readFileSync("src/core/babylonMmdRuntime.ts", "utf8");

  assert.match(runtime, /spr\/index_bg\.wasm\?url/);
  assert.match(runtime, /default: \(\) => MmdWasmSpr\.default\(mmdWasmSprUrl\)/);
  assert.match(runtime, /createRetryableAsyncSingleton\(\(\) => \{/);
  assert.match(runtime, /getWasmInstanceInner: \(\) => wasmBinding/);
  assert.match(runtime, /await getBabylonMmdWasmInstance\(\)/);
  assert.doesNotMatch(runtime, /GetMmdWasmInstance\(new /);
});
