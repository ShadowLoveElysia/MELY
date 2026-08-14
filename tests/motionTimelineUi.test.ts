import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("loaded VMD tracks render conditionally below the viewport and share one render RAF", () => {
  const app = readFileSync("src/App.tsx", "utf8");
  const sidebar = readFileSync("src/components/Sidebar.tsx", "utf8");
  const viewport = readFileSync("src/components/Viewport3D.tsx", "utf8");
  const styles = readFileSync("src/index.css", "utf8");

  assert.match(app, /<RendererViewport[\s\S]*onBeforeRender=\{advanceMotionPreview\}[\s\S]*onAfterRender=\{publishRenderedMotionPreview\}[\s\S]*MOTION_TRACK_KINDS\.map[\s\S]*motionTracks\[kind\] \? \([\s\S]*<MotionTimeline/);
  assert.doesNotMatch(sidebar, /className="motion-control"/);
  assert.match(viewport, /onBeforeRenderRef\.current\?\.\(now\)[\s\S]*renderer\.render[\s\S]*onAfterRenderRef\.current\?\.\(performance\.now\(\), evaluatedMotionTimes, gpuSynchronized\)/);
  assert.match(app, /runtime\.pendingSeconds = seconds[\s\S]*scheduleMotionScrubCommit/);
  assert.match(app, /<div className="viewport-stage">[\s\S]*<RendererViewport[\s\S]*<MotionTimeline/);
  assert.match(styles, /\.viewport-panel--with-motion[\s\S]*grid-template-rows: minmax\(0, 1fr\) auto/);
  assert.match(styles, /\.viewport-motion-stack[\s\S]*display: grid[\s\S]*\.viewport-motion/);
  assert.match(app, /const hasMotion = MOTION_TRACK_KINDS\.some[\s\S]*\{hasMotion \? \([\s\S]*motionTracks\[kind\] \? \(/);
});

test("renderer viewport forwards shared lifecycle callbacks to every backend", () => {
  const renderer = readFileSync("src/components/RendererViewport.tsx", "utf8");
  const sharedProps = readFileSync("src/components/rendererViewportTypes.ts", "utf8");
  const vanilla = readFileSync("src/components/ThreeVanillaViewport.tsx", "utf8");
  const moeru = readFileSync("src/components/ThreeMoeruViewport.tsx", "utf8");

  assert.match(sharedProps, /onReady\?: \(binding\?: RendererViewportBinding\) => void;/);
  assert.match(sharedProps, /onUnmount\?: \(binding\?: RendererViewportBinding\) => void;/);
  assert.match(sharedProps, /onReady: props\.onReady/);
  assert.match(sharedProps, /onUnmount: props\.onUnmount/);
  assert.match(renderer, /<ThreeVanillaViewport \{\.\.\.props\} \/>/);
  assert.match(renderer, /<ThreeMoeruViewport \{\.\.\.props\} \/>/);
  assert.match(renderer, /<BabylonViewport \{\.\.\.props\} \/>/);
  assert.match(vanilla, /<Viewport3D \{\.\.\.defaults\} model=\{model\} \/>/);
  assert.match(moeru, /<Viewport3D \{\.\.\.defaults\} model=\{model\} \/>/);
});
