import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("vanilla Ammo loader reuses Moeru's correctly initialized shared runtime", () => {
  const driver = readFileSync("src/core/threeVanillaMmdDriver.ts", "utf8");

  assert.match(driver, /createRetryableAsyncSingleton\(async \(\) => \{/);
  assert.match(driver, /initAmmo as initSharedThreeAmmo/);
  assert.match(driver, /await initSharedThreeAmmo\(\)/);
  assert.match(driver, /candidate\.btDiscreteDynamicsWorld/);
  assert.doesNotMatch(driver, /vanillaAmmoModulePromise/);
  assert.doesNotMatch(driver, /import\("ammojs-typed"\)/);
});
