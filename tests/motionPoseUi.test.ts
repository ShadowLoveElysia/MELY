import assert from "node:assert/strict";
import { test } from "node:test";
import {
  areMotionTracksReadyForGeneration,
  canToggleMotionPlayback,
  formatMotionFrame,
  getAdjacentMotionFrame,
  isMotionReadyForGeneration,
  motionFrameStepState,
  normalizeMotionFrame,
  shouldIgnoreMotionShortcut,
} from "../src/core/motionUi";
import {
  createMotionPlaybackStore,
  createMotionTimeStore,
} from "../src/core/motionTimeStore";

const shortcutTarget = (matchesSelector: boolean, isContentEditable = false) => ({
  isContentEditable,
  closest: (selector: string) => {
    assert.match(selector, /dialog/);
    assert.match(selector, /button/);
    assert.match(selector, /input/);
    return matchesSelector ? {} : null;
  },
});

test("motion shortcuts ignore interactive and dialog-contained focus", () => {
  assert.equal(shouldIgnoreMotionShortcut(shortcutTarget(true) as unknown as EventTarget), true);
  assert.equal(shouldIgnoreMotionShortcut(shortcutTarget(false, true) as unknown as EventTarget), true);
  assert.equal(shouldIgnoreMotionShortcut(shortcutTarget(false) as unknown as EventTarget), false);
  assert.equal(shouldIgnoreMotionShortcut(null), false);
});

test("VMD generation requires a locked frame while static poses do not", () => {
  assert.equal(isMotionReadyForGeneration(false, null), true);
  assert.equal(isMotionReadyForGeneration(true, null), false);
  assert.equal(isMotionReadyForGeneration(true, 0), true);
  assert.equal(isMotionReadyForGeneration(true, 12.375), true);
});

test("dual-track generation requires every loaded track to be locked", () => {
  assert.equal(areMotionTracksReadyForGeneration([
    { loaded: false, lockedFrame: null },
    { loaded: false, lockedFrame: null },
  ]), true);
  assert.equal(areMotionTracksReadyForGeneration([
    { loaded: true, lockedFrame: 12 },
    { loaded: false, lockedFrame: null },
  ]), true);
  assert.equal(areMotionTracksReadyForGeneration([
    { loaded: true, lockedFrame: 12 },
    { loaded: true, lockedFrame: null },
  ]), false);
  assert.equal(areMotionTracksReadyForGeneration([
    { loaded: true, lockedFrame: 12 },
    { loaded: true, lockedFrame: 7.5 },
  ]), true);
});

test("space playback is available only for an unlocked VMD motion", () => {
  assert.equal(canToggleMotionPlayback(false, null), false);
  assert.equal(canToggleMotionPlayback(true, null), true);
  assert.equal(canToggleMotionPlayback(true, 0), false);
  assert.equal(canToggleMotionPlayback(true, 42.5), false);
});

test("single-frame navigation rounds the displayed frame and clamps both ends", () => {
  assert.equal(normalizeMotionFrame(12.49, 30), 12);
  assert.equal(normalizeMotionFrame(12.5, 30), 13);
  assert.equal(getAdjacentMotionFrame(12.49, 30, -1), 11);
  assert.equal(getAdjacentMotionFrame(12.49, 30, 1), 13);
  assert.equal(getAdjacentMotionFrame(-100, 30, -1), 0);
  assert.equal(getAdjacentMotionFrame(100, 30, 1), 30);

  assert.deepEqual(motionFrameStepState(0, 30), {
    current: 0,
    previous: 0,
    next: 1,
    canStepBackward: false,
    canStepForward: true,
  });
  assert.deepEqual(motionFrameStepState(30, 30), {
    current: 30,
    previous: 29,
    next: 30,
    canStepBackward: true,
    canStepForward: false,
  });
});

test("motion frame formatting keeps fractional lock positions compact", () => {
  assert.equal(formatMotionFrame(12), "12");
  assert.equal(formatMotionFrame(12.5), "12.5");
  assert.equal(formatMotionFrame(12.3754), "12.375");
});

test("motion time store updates only active local subscribers", () => {
  const store = createMotionTimeStore();
  let updates = 0;
  const unsubscribe = store.subscribe(() => {
    updates += 1;
  });

  store.set(0);
  store.set(1.25);
  store.set(1.25);
  assert.equal(store.getSnapshot(), 1.25);
  assert.equal(updates, 1);

  unsubscribe();
  store.set(2);
  assert.equal(store.getSnapshot(), 2);
  assert.equal(updates, 1);
});

test("motion playback store isolates transport updates from the app tree", () => {
  const store = createMotionPlaybackStore();
  let updates = 0;
  const unsubscribe = store.subscribe(() => {
    updates += 1;
  });

  store.set(false);
  store.set(true);
  store.set(true);
  assert.equal(store.getSnapshot(), true);
  assert.equal(updates, 1);

  unsubscribe();
  store.set(false);
  assert.equal(store.getSnapshot(), false);
  assert.equal(updates, 1);
});
