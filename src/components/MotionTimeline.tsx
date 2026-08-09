import {
  Lock,
  Pause,
  Play,
  StepBack,
  StepForward,
  Unlock,
} from "lucide-react";
import { useSyncExternalStore } from "react";
import { formatMotionFrame, motionFrameStepState } from "../core/motionUi";
import type {
  MotionPlaybackSource,
  MotionTimeSource,
} from "../core/motionTimeStore";
import { useI18n } from "../i18n/I18nProvider";
import type { MmdMotionInfo } from "../types";

interface MotionTimelineProps {
  motion: MmdMotionInfo;
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
  const expressionOnly = motion.matchedBoneTrackCount === 0 && motion.matchedMorphTrackCount > 0;

  return (
    <section className="motion-control viewport-motion" aria-label={t("sidebar.motion.timeline")}> 
      <div className="viewport-motion__identity">
        <Play size={14} />
        <span>
          <strong>{motion.name}</strong>
          <small>{t("sidebar.motion.frames", { count: number(motion.maxFrame) })}</small>
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
          aria-label={playing ? t("sidebar.motion.pause") : t("sidebar.motion.play")}
          title={playing ? t("sidebar.motion.pause") : t("sidebar.motion.play")}
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
          value={Math.min(motion.maxFrame, Math.round(currentFrame))}
          aria-label={t("sidebar.motion.frame")}
          disabled={locked || disabled}
          onChange={(event) => onFrameChange(Number(event.target.value))}
        />
        <output>{t("sidebar.motion.frameCounter", {
          current: number(Number(currentFrame.toFixed(3))),
          total: number(motion.maxFrame),
        })}</output>
      </div>

      <div className="viewport-motion__meta">
        <span className={expressionOnly ? "viewport-motion__warning" : ""}>
          {t("sidebar.motion.matchedBones", {
            matched: number(motion.matchedBoneTrackCount),
            total: number(motion.boneTrackCount),
          })}
        </span>
        <span>{t("sidebar.motion.matchedMorphs", {
          matched: number(motion.matchedMorphTrackCount),
          total: number(motion.morphTrackCount),
        })}</span>
        <span>{t("sidebar.motion.frameRate", { rate: number(motion.frameRate) })}</span>
      </div>

      <button
        type="button"
        className={`viewport-motion__lock ${locked ? "viewport-motion__lock--active" : ""}`}
        aria-label={locked ? t("sidebar.motion.unlock") : t("sidebar.motion.lock")}
        title={locked ? t("sidebar.motion.unlock") : t("sidebar.motion.lock")}
        aria-pressed={locked}
        disabled={disabled}
        onClick={onLockToggle}
      >
        {locked ? <Unlock size={15} /> : <Lock size={15} />}
        <span>{locked ? t("sidebar.motion.unlock") : t("sidebar.motion.lock")}</span>
      </button>
    </section>
  );
}

interface MotionFrameReadoutProps {
  motion: MmdMotionInfo;
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

export function MotionFrameReadout(props: MotionFrameReadoutProps) {
  return <span>F{formatMotionFrame(useDisplayedMotionFrame(props))}</span>;
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
  return <>{t(frameProps.lockedFrame !== null
    ? "app.status.motionLocked"
    : playing
      ? "app.status.motionPlaying"
      : "app.status.motionPaused", {
    frame: formatMotionFrame(frame),
  })}</>;
}
