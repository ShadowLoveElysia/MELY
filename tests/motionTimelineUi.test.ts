import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("VMD controls live below the viewport and animation evaluation shares the render RAF", () => {
  const app = readFileSync("src/App.tsx", "utf8");
  const sidebar = readFileSync("src/components/Sidebar.tsx", "utf8");
  const viewport = readFileSync("src/components/Viewport3D.tsx", "utf8");
  const styles = readFileSync("src/index.css", "utf8");

  assert.match(app, /<Viewport3D[\s\S]*onBeforeRender=\{advanceMotionPreview\}[\s\S]*onAfterRender=\{publishRenderedMotionPreview\}[\s\S]*<MotionTimeline/);
  assert.doesNotMatch(sidebar, /className="motion-control"/);
  assert.match(viewport, /onBeforeRenderRef\.current\?\.\(now\)[\s\S]*renderer\.render[\s\S]*onAfterRenderRef\.current\?\.\(performance\.now\(\), evaluatedMotionSeconds, gpuSynchronized\)/);
  assert.match(app, /pendingMotionSecondsRef\.current = seconds[\s\S]*scheduleMotionScrubCommit/);
  assert.match(app, /<div className="viewport-stage">[\s\S]*<Viewport3D[\s\S]*<MotionTimeline/);
  assert.match(styles, /\.viewport-panel--with-motion[\s\S]*grid-template-rows: minmax\(0, 1fr\) auto/);
  assert.match(styles, /\.viewport-motion[\s\S]*border-width: 1px 0 0[\s\S]*border-radius: 0/);
});
