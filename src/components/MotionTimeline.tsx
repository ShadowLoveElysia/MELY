import {
  Lock,
  Pause,
  PersonStanding,
  Play,
  Smile,
  StepBack,
  StepForward,
  Unlock,
} from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  formatMotionFrame,
  motionFrameStepState,
  parseMotionFrameInput,
} from "../core/motionUi";
import type {
  MotionPlaybackSource,
  MotionTimeSource,
} from "../core/motionTimeStore";
import { useI18n } from "../i18n/I18nProvider";
import type { MmdMotionTrackInfo, MmdMotionTrackKind } from "../types";

interface MotionTimelineProps {
  kind: MmdMotionTrackKind;
  motion: MmdMotionTrackInfo;
  timeSource: MotionTimeSource;
  playbackSource: MotionPlaybackSource;
  lockedFrame: number | null;
  disabled: boolean;
  onPlayingChange: (playing: boolean) => void;
  onFrameChange: (frame: number) => void;
  onFrameStep: (direction: -1 | 1) => void;
  onLockToggle: () => void;
}

export function MotionTimeline({
  kind,
  motion,
  timeSource,
  playbackSource,
  lockedFrame,
  disabled,
  onPlayingChange,
  onFrameChange,
  onFrameStep,
  onLockToggle,
}: MotionTimelineProps) {
  const { t, number } = useI18n();
  const seconds = useSyncExternalStore(
    timeSource.subscribe,
    timeSource.getSnapshot,
    timeSource.getSnapshot,
  );
  const playing = useSyncExternalStore(
    playbackSource.subscribe,
    playbackSource.getSnapshot,
    playbackSource.getSnapshot,
  );
  const frame = seconds * motion.frameRate;
  const locked = lockedFrame !== null;
  const currentFrame = lockedFrame ?? frame;
  const stepState = motionFrameStepState(currentFrame, motion.maxFrame);
  const displayedFrame = Math.min(motion.maxFrame, Math.round(currentFrame));
  const [frameDraft, setFrameDraft] = useState(String(displayedFrame));
  const [frameInputFocused, setFrameInputFocused] = useState(false);
  const skipNextFrameInputBlurRef = useRef(false);
  const TrackIcon = kind === "dance" ? PersonStanding : Smile;
  const trackLabel = t(kind === "dance" ? "sidebar.motion.danceTrack" : "sidebar.motion.expressionTrack");

  useEffect(() => {
    if (!frameInputFocused) setFrameDraft(String(displayedFrame));
  }, [displayedFrame, frameInputFocused]);

  const cancelFrameInput = () => {
    setFrameInputFocused(false);
    setFrameDraft(String(displayedFrame));
  };
  const commitFrameInput = () => {
    if (disabled) {
      cancelFrameInput();
      return;
    }
    setFrameInputFocused(false);
    const target = parseMotionFrameInput(frameDraft, motion.maxFrame);
    if (target === null || Math.abs(target - currentFrame) <= 1e-6) {
      cancelFrameInput();
      return;
    }
    setFrameDraft(String(target));
    onFrameChange(target);
  };

  return (
    <section
      className={`motion-control viewport-motion viewport-motion--${kind}`}
      aria-label={t("sidebar.motion.trackTimeline", { track: trackLabel })}
    >
      <div className="viewport-motion__identity">
        <TrackIcon size={14} />
        <span>
          <small className="viewport-motion__track-label">{trackLabel}</small>
          <strong>{motion.name}</strong>
        </span>
      </div>

      <div className="viewport-motion__transport">
        <button
          type="button"
          className="motion-play-button"
          aria-label={t("sidebar.motion.previousFrame")}
          title={t("sidebar.motion.previousFrame")}
          disabled={locked || disabled || !stepState.canStepBackward}
          onClick={() => onFrameStep(-1)}
        >
          <StepBack size={15} />
        </button>
        <button
          type="button"
          className={`motion-play-button ${playing ? "motion-play-button--active" : ""}`}
          aria-label={playing
            ? t("sidebar.motion.pause", { track: trackLabel })
            : t("sidebar.motion.play", { track: trackLabel })}
          title={playing
            ? t("sidebar.motion.pause", { track: trackLabel })
            : t("sidebar.motion.play", { track: trackLabel })}
          disabled={locked || disabled}
          onClick={() => onPlayingChange(!playing)}
        >
          {playing ? <Pause size={15} /> : <Play size={15} />}
        </button>
        <button
          type="button"
          className="motion-play-button"
          aria-label={t("sidebar.motion.nextFrame")}
          title={t("sidebar.motion.nextFrame")}
          disabled={locked || disabled || !stepState.canStepForward}
          onClick={() => onFrameStep(1)}
        >
          <StepForward size={15} />
        </button>
      </div>

      <div className="viewport-motion__scrubber">
        <input
          type="range"
          min={0}
          max={motion.maxFrame}
          step={1}
          value={displayedFrame}
          aria-label={t("sidebar.motion.trackFrame", { track: trackLabel })}
          disabled={locked || disabled}
          onChange={(event) => onFrameChange(Number(event.target.value))}
        />
        <label className="viewport-motion__frame-input">
          <span>{t("sidebar.motion.jumpFrame", { track: trackLabel })}</span>
          <input
            type="number"
            min={0}
            max={motion.maxFrame}
            step={1}
            value={frameDraft}
            aria-label={t("sidebar.motion.jumpFrame", { track: trackLabel })}
            disabled={disabled}
            onFocus={() => {
              skipNextFrameInputBlurRef.current = false;
              setFrameInputFocused(true);
            }}
            onChange={(event) => setFrameDraft(event.currentTarget.value)}
            onBlur={() => {
              if (skipNextFrameInputBlurRef.current) {
                skipNextFrameInputBlurRef.current = false;
                return;
              }
              commitFrameInput();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                skipNextFrameInputBlurRef.current = true;
                cancelFrameInput();
                event.currentTarget.blur();
              }
            }}
          />
        </label>
        <output>{t("sidebar.motion.frameCounter", {
          current: number(Number(currentFrame.toFixed(3))),
          total: number(motion.maxFrame),
        })}</output>
      </div>

      <div className="viewport-motion__meta">
        {kind === "dance" ? (
          <span>{t("sidebar.motion.matchedBones", {
            matched: number(motion.matchedBoneTrackCount),
            total: number(motion.boneTrackCount),
          })}</span>
        ) : (
          <span>{t("sidebar.motion.matchedMorphs", {
          matched: number(motion.matchedMorphTrackCount),
          total: number(motion.morphTrackCount),
          })}</span>
        )}
        <span>{t("sidebar.motion.frames", { count: number(motion.maxFrame) })}</span>
        <span>{t("sidebar.motion.frameRate", { rate: number(motion.frameRate) })}</span>
      </div>

      <button
        type="button"
        className={`viewport-motion__lock ${locked ? "viewport-motion__lock--active" : ""}`}
        aria-label={locked
          ? t("sidebar.motion.unlock", { track: trackLabel })
          : t("sidebar.motion.lock", { track: trackLabel })}
        title={locked
          ? t("sidebar.motion.unlock", { track: trackLabel })
          : t("sidebar.motion.lock", { track: trackLabel })}
        aria-pressed={locked}
        disabled={disabled}
        onClick={onLockToggle}
      >
        {locked ? <Unlock size={15} /> : <Lock size={15} />}
        <span>{locked
          ? t("sidebar.motion.unlock", { track: trackLabel })
          : t("sidebar.motion.lock", { track: trackLabel })}</span>
      </button>
    </section>
  );
}

interface MotionFrameReadoutProps {
  kind: MmdMotionTrackKind;
  motion: MmdMotionTrackInfo;
  timeSource: MotionTimeSource;
  lockedFrame: number | null;
}

const useDisplayedMotionFrame = ({
  motion,
  timeSource,
  lockedFrame,
}: MotionFrameReadoutProps) => {
  const seconds = useSyncExternalStore(
    timeSource.subscribe,
    timeSource.getSnapshot,
    timeSource.getSnapshot,
  );
  return lockedFrame ?? seconds * motion.frameRate;
};

export function MotionTrackFrameReadout(props: MotionFrameReadoutProps) {
  return <span>{props.kind === "dance" ? "D" : "E"}{formatMotionFrame(useDisplayedMotionFrame(props))}</span>;
}

interface MotionStatusTextProps extends MotionFrameReadoutProps {
  playbackSource: MotionPlaybackSource;
}

export function MotionStatusText({ playbackSource, ...frameProps }: MotionStatusTextProps) {
  const { t } = useI18n();
  const frame = useDisplayedMotionFrame(frameProps);
  const playing = useSyncExternalStore(
    playbackSource.subscribe,
    playbackSource.getSnapshot,
    playbackSource.getSnapshot,
  );
  const track = t(frameProps.kind === "dance" ? "sidebar.motion.danceTrack" : "sidebar.motion.expressionTrack");
  return <>{t(frameProps.lockedFrame !== null
    ? "app.status.motionLocked"
    : playing
      ? "app.status.motionPlaying"
      : "app.status.motionPaused", {
    track,
    frame: `${frameProps.kind === "dance" ? "D" : "E"}${formatMotionFrame(frame)}`,
  })}</>;
}
