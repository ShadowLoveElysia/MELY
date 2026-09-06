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

test("Babylon static pose settling evaluates kinematically before one explicit reset/settle", () => {
  const runtime = readFileSync("src/core/babylonMmdRuntime.ts", "utf8");
  const settle = runtime.match(/const settlePhysics = \(\) => \{[\s\S]*?\n    \};/)?.[0] ?? "";
  const updatePose = runtime.match(/updatePose: \(times\) => \{[\s\S]*?\n      \},\n      createSnapshot:/)?.[0] ?? "";

  assert.match(updatePose, /evaluate\(times, false\)/);
  assert.match(updatePose, /settlePhysics\(\)/);
  assert.doesNotMatch(updatePose, /beforePhysics\(/);
  assert.match(settle, /mmdRuntime\.initializeMmdModelPhysics\(mmdModel\)/);
  assert.doesNotMatch(settle, /mmdModel\.initializePhysics\(\)/);
  assert.match(settle, /for \(let step = 0; step < BABYLON_PHYSICS_SETTLE_STEPS; step \+= 1\)/);
  assert.match(settle, /mmdRuntime\.beforePhysics\(BABYLON_PHYSICS_FIXED_STEP \* 1000\)/);
  assert.match(settle, /mmdRuntime\.afterPhysics\(\)/);
});
