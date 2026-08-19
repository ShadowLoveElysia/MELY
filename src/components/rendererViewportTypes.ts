import type { LoadedMmdModel, MmdRendererMode } from "../core/mmdRuntime";
import type { CameraMode, MmdMotionTimes, PreviewMode, ProjectionResult } from "../types";

/** Identifies one mounted viewport instance across renderer transitions. */
export interface RendererViewportBinding {
  generation: number;
  modelId: string;
}

/** Engine-neutral identity for a material selected from the model viewport. */
export interface RendererMaterialSelection {
  modelId: string;
  materialIndex: number;
}

/**
 * Common surface used by every renderer viewport. The optional URL fields keep
 * the component usable as a small standalone player, while the remaining
 * fields mirror the application's existing preview controls.
 */
export interface RendererViewportProps {
  model?: LoadedMmdModel | null;
  modelUrl?: string;
  motionUrl?: string;
  isPlaying?: boolean;
  /** True while an async operation owns the active backend model. */
  backendBusy?: boolean;
  /** Binding captured by the viewport instance for lifecycle acknowledgements. */
  lifecycleBinding?: RendererViewportBinding;
  renderMode?: MmdRendererMode;
  result?: ProjectionResult | null;
  previewMode?: PreviewMode;
  targetHeight?: number;
  modelLoading?: boolean;
  glow?: number;
  nightMode?: boolean;
  cameraMode?: CameraMode;
  showGrid?: boolean;
  showBounds?: boolean;
  resetToken?: number;
  focusFaceToken?: number;
  partsRevision?: number;
  poseRevision?: number;
  poseEditing?: boolean;
  selectedBoneIndex?: number | null;
  onBoneSelected?: (index: number | null) => void;
  /** Canonical material index selected for the active model. */
  selectedMaterialIndex?: number | null;
  /** Canonical material indices excluded from picking and selection feedback. */
  hiddenMaterialIndices?: readonly number[];
  /** Increments for each viewport selection request, including repeated selections. */
  materialSelectionRequestId?: number;
  onMaterialSelected?: (selection: RendererMaterialSelection | null) => void;
  onPoseCommitted?: () => void;
  onBeforeRender?: (now: number) => MmdMotionTimes | null;
  onAfterRender?: (
    now: number,
    evaluatedMotionTimes: MmdMotionTimes | null,
    gpuSynchronized: boolean,
  ) => void;
  /**
   * Called once after the viewport has created its canvas and completed a
   * render-loop initialization that is capable of drawing a frame.
   */
  onReady?: (binding?: RendererViewportBinding) => void;
  /**
   * Called after the viewport has stopped its render loop and attempted all
   * canvas/resource cleanup. It is delivered even when one cleanup operation
   * throws, so an owner can safely advance its renderer transaction.
   */
  onUnmount?: (binding?: RendererViewportBinding) => void;
}

export const defaultRendererViewportProps = (
  props: RendererViewportProps,
) => ({
  result: props.result ?? null,
  previewMode: props.previewMode ?? "source",
  targetHeight: props.targetHeight ?? 96,
  modelLoading: props.modelLoading ?? false,
  glow: props.glow ?? 50,
  nightMode: props.nightMode ?? false,
  cameraMode: props.cameraMode ?? "perspective",
  showGrid: props.showGrid ?? true,
  showBounds: props.showBounds ?? true,
  resetToken: props.resetToken ?? 0,
  focusFaceToken: props.focusFaceToken ?? 0,
  partsRevision: props.partsRevision ?? 0,
  poseRevision: props.poseRevision ?? 0,
  poseEditing: props.poseEditing ?? false,
  selectedBoneIndex: props.selectedBoneIndex ?? null,
  onBoneSelected: props.onBoneSelected ?? (() => undefined),
  selectedMaterialIndex: props.selectedMaterialIndex ?? null,
  hiddenMaterialIndices: props.hiddenMaterialIndices ?? [],
  materialSelectionRequestId: props.materialSelectionRequestId ?? 0,
  onMaterialSelected: props.onMaterialSelected ?? (() => undefined),
  onPoseCommitted: props.onPoseCommitted ?? (() => undefined),
  onBeforeRender: props.onBeforeRender,
  onAfterRender: props.onAfterRender,
  onReady: props.onReady,
  onUnmount: props.onUnmount,
  isPlaying: props.isPlaying ?? false,
  backendBusy: props.backendBusy ?? false,
  lifecycleBinding: props.lifecycleBinding,
});
