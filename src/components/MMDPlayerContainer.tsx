import { Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MmdRendererMode } from "../core/mmdRuntime";
import { RendererViewport, type RendererViewportProps } from "./RendererViewport";
import { useI18n } from "../i18n/I18nProvider";

export type RendererModeChangeResult = void | boolean;
export type RendererModeChangeHandler = (
  mode: MmdRendererMode,
) => RendererModeChangeResult | Promise<RendererModeChangeResult>;

export interface MMDPlayerContainerProps extends Omit<RendererViewportProps, "renderMode" | "isPlaying"> {
  initialRenderMode?: MmdRendererMode;
  onRenderModeChange?: RendererModeChangeHandler;
}

/**
 * Small standalone orchestrator for embedding the multi-renderer player. It
 * mounts one renderer at a time. When a host supplies an asynchronous mode
 * change handler, the old mode remains committed until that handler resolves;
 * a rejection or an explicit `false` result leaves the old viewport intact.
 * The host owns the actual model/resource transaction and should reject only
 * after restoring its previous backend when a target renderer cannot load.
 */
export function MMDPlayerContainer({
  initialRenderMode = "vanilla",
  onRenderModeChange,
  model,
  ...props
}: MMDPlayerContainerProps) {
  const { t } = useI18n();
  const [renderMode, setRenderMode] = useState<MmdRendererMode>(initialRenderMode);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);
  const switchRequestRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => () => {
    mountedRef.current = false;
    switchRequestRef.current += 1;
  }, []);

  const changeMode = async (next: MmdRendererMode) => {
    // A mode change without a host transaction would only swap the viewport
    // component while keeping the old engine-owned model, which is unsafe for
    // Babylon and misleading for the two Three backends.
    if (!onRenderModeChange || next === renderMode || isSwitching) return;
    const requestId = switchRequestRef.current + 1;
    switchRequestRef.current = requestId;
    const previousPlaying = isPlaying;
    setIsSwitching(true);

    try {
      const outcome = await onRenderModeChange?.(next);
      if (!mountedRef.current || switchRequestRef.current !== requestId) return;
      if (outcome === false) return;
      setRenderMode(next);
      setIsPlaying(false);
    } catch {
      // The host owns resource rollback. Keeping local state unchanged keeps
      // this component on the last known-good viewport after a rejected load.
      if (mountedRef.current && switchRequestRef.current === requestId) {
        setIsPlaying(previousPlaying);
      }
    } finally {
      if (mountedRef.current && switchRequestRef.current === requestId) {
        setIsSwitching(false);
      }
    }
  };

  return (
    <div className="mmd-player-container">
      <RendererViewport
        {...props}
        model={model}
        renderMode={renderMode}
        isPlaying={isPlaying}
      />
      <div
        className="mmd-player-container__overlay"
        role="toolbar"
        aria-label={t("toolbar.renderer")}
      >
        <label className="mmd-player-container__mode">
          <span className="sr-only">{t("toolbar.renderer")}</span>
          <select
            value={renderMode}
            disabled={isSwitching || !onRenderModeChange}
            aria-busy={isSwitching}
            onChange={(event) => { void changeMode(event.target.value as MmdRendererMode); }}
          >
            <option value="vanilla">{t("renderer.vanilla")}</option>
            <option value="moeru">{t("renderer.moeru")}</option>
            <option value="babylon">{t("renderer.babylon")}</option>
          </select>
        </label>
        <button
          type="button"
          className="mmd-player-container__play"
          disabled={isSwitching}
          aria-busy={isSwitching}
          aria-label={t(isPlaying ? "sidebar.motion.pause" : "sidebar.motion.play", { track: "MMD" })}
          title={t(isPlaying ? "sidebar.motion.pause" : "sidebar.motion.play", { track: "MMD" })}
          onClick={() => setIsPlaying((value) => !value)}
        >
          {isPlaying ? <Pause size={16} /> : <Play size={16} />}
        </button>
      </div>
    </div>
  );
}
