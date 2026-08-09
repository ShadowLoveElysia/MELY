export interface MotionTimeSource {
  getSnapshot: () => number;
  subscribe: (listener: () => void) => () => void;
}

export interface MotionTimeStore extends MotionTimeSource {
  set: (seconds: number) => void;
}

export interface MotionPlaybackSource {
  getSnapshot: () => boolean;
  subscribe: (listener: () => void) => () => void;
}

export interface MotionPlaybackStore extends MotionPlaybackSource {
  set: (playing: boolean) => void;
}

const normalizeSeconds = (seconds: number) => (
  Number.isFinite(seconds) ? Math.max(0, seconds) : 0
);

export const createMotionTimeStore = (initialSeconds = 0): MotionTimeStore => {
  let currentSeconds = normalizeSeconds(initialSeconds);
  const listeners = new Set<() => void>();

  return {
    getSnapshot: () => currentSeconds,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (seconds) => {
      const nextSeconds = normalizeSeconds(seconds);
      if (Object.is(nextSeconds, currentSeconds)) return;
      currentSeconds = nextSeconds;
      listeners.forEach((listener) => listener());
    },
  };
};

export const createMotionPlaybackStore = (initialPlaying = false): MotionPlaybackStore => {
  let playing = initialPlaying;
  const listeners = new Set<() => void>();

  return {
    getSnapshot: () => playing,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (nextPlaying) => {
      if (nextPlaying === playing) return;
      playing = nextPlaying;
      listeners.forEach((listener) => listener());
    },
  };
};
