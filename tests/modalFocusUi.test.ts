import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("all modal surfaces use the shared focus lifecycle", () => {
  const windows = readFileSync("src/components/Windows.tsx", "utf8");
  const survivalTools = readFileSync("src/components/SurvivalTools.tsx", "utf8");
  const hook = readFileSync("src/components/useModalFocus.ts", "utf8");
  const controls = readFileSync("src/components/Controls.tsx", "utf8");

  assert.match(windows, /useModalFocus<HTMLDivElement>/);
  assert.match(survivalTools, /useModalFocus<HTMLElement>/);
  assert.match(survivalTools, /restoreFocusTo/);
  assert.match(survivalTools, /role="dialog"/);
  assert.match(survivalTools, /aria-modal="true"/);
  assert.match(survivalTools, /tabIndex=\{-1\}/);

  assert.match(hook, /event\.key === "Escape"/);
  assert.match(hook, /event\.key !== "Tab"/);
  assert.match(hook, /event\.shiftKey/);
  assert.match(hook, /previousFocus\.focus\(\)/);
  assert.match(hook, /restoreFocusTo/);
  assert.match(hook, /isTopmostModal/);
  assert.match(controls, /aria-label=\{label\}/);
  assert.match(controls, /title=\{label\}/);
});
