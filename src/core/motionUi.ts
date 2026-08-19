interface ShortcutTarget {
  closest?: (selector: string) => unknown;
  isContentEditable?: boolean;
}

export const shouldIgnoreMotionShortcut = (target: EventTarget | null) => {
  const element = target as ShortcutTarget | null;
  if (!element) return false;
  if (element.isContentEditable) return true;
  return Boolean(element.closest?.(
    "input, select, textarea, button, [contenteditable]:not([contenteditable='false']), dialog",
  ));
};

export const isMotionReadyForGeneration = (
  hasMotion: boolean,
  lockedFrame: number | null,
) => !hasMotion || lockedFrame !== null;

export const areMotionTracksReadyForGeneration = (
  tracks: readonly { loaded: boolean; lockedFrame: number | null }[],
) => tracks.every((track) => !track.loaded || track.lockedFrame !== null);

export const canToggleMotionPlayback = (
  hasMotion: boolean,
  lockedFrame: number | null,
) => hasMotion && lockedFrame === null;

export const formatMotionFrame = (frame: number) => (
  Number.isInteger(frame) ? String(frame) : frame.toFixed(3).replace(/\.?0+$/, "")
);

const normalizedMaxFrame = (maxFrame: number) => (
  Number.isFinite(maxFrame) ? Math.max(0, Math.floor(maxFrame)) : 0
);

export const normalizeMotionFrame = (frame: number, maxFrame: number) => {
  const maximum = normalizedMaxFrame(maxFrame);
  const rounded = Number.isFinite(frame) ? Math.round(frame) : 0;
  return Math.max(0, Math.min(maximum, rounded));
};

export const parseMotionFrameInput = (
  value: string,
  maxFrame: number,
): number | null => {
  const normalized = value.trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? normalizeMotionFrame(parsed, maxFrame) : null;
};

export const getAdjacentMotionFrame = (
  frame: number,
  maxFrame: number,
  direction: -1 | 1,
) => {
  const maximum = normalizedMaxFrame(maxFrame);
  return Math.max(0, Math.min(maximum, normalizeMotionFrame(frame, maximum) + direction));
};

export const motionFrameStepState = (frame: number, maxFrame: number) => {
  const maximum = normalizedMaxFrame(maxFrame);
  const current = normalizeMotionFrame(frame, maximum);
  return {
    current,
    previous: getAdjacentMotionFrame(current, maximum, -1),
    next: getAdjacentMotionFrame(current, maximum, 1),
    canStepBackward: current > 0,
    canStepForward: current < maximum,
  };
};
