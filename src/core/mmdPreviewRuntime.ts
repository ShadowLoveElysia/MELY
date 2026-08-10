import type { ThreeMmdModel } from "@yohawing/three-mmd-loader";
import type { SwitchableMmdPhysicsBackend } from "./mmdPhysics";
import type { MmdFrameState } from "@yohawing/three-mmd-loader/runtime";
import type { Object3D, Skeleton } from "three";

export interface PreviewRuntimeDiagnostics {
  skinnedMeshCount: number;
  uniqueSkeletonCount: number;
}

interface RuntimeWithOptionalDebugCapture {
  debugCaptureEnabled?: boolean;
  debugCapture?: boolean;
  captureDebugStages?: boolean;
  setDebugCaptureEnabled?: (enabled: boolean) => void;
}

const noOpDebugCapture = () => undefined;
const debugCaptureDisabled = new WeakSet<object>();

const disableUnusedDebugCapture = (runtime: RuntimeWithOptionalDebugCapture) => {
  const mutableRuntime = runtime as RuntimeWithOptionalDebugCapture & Record<string, unknown>;
  if (!debugCaptureDisabled.has(runtime)) {
    debugCaptureDisabled.add(runtime);
    runtime.setDebugCaptureEnabled?.(false);
    if ("debugCaptureEnabled" in runtime) runtime.debugCaptureEnabled = false;
    if ("debugCapture" in runtime) runtime.debugCapture = false;
    if ("captureDebugStages" in runtime) runtime.captureDebugStages = false;
    if (typeof mutableRuntime.captureDebugStage === "function") {
      mutableRuntime.captureDebugStage = noOpDebugCapture;
    }
    if (typeof mutableRuntime.capturePhysicsDebugStage === "function") {
      mutableRuntime.capturePhysicsDebugStage = noOpDebugCapture;
    }
  }
  const parsedRuntime = mutableRuntime.parsedTrackRuntime;
  if (parsedRuntime && typeof parsedRuntime === "object") {
    disableUnusedDebugCapture(parsedRuntime as RuntimeWithOptionalDebugCapture);
  }
};

export const evaluateMmdPreviewFrame = (
  model: ThreeMmdModel,
  seconds: number,
  physics = false,
): MmdFrameState => {
  disableUnusedDebugCapture(model.runtime as RuntimeWithOptionalDebugCapture);
  // Vertex deformation remains GPU-side; this only synchronizes the current
  // bone matrices and morph state for the visible SkinnedMesh hierarchy.
  return model.update(seconds, { physics, ik: true });
};

const PHYSICS_SETTLE_SECONDS = 1;
const PHYSICS_FIXED_STEP = 1 / 60;

export const settleMmdPreviewFrame = (
  model: ThreeMmdModel,
  seconds: number,
  physics: Pick<SwitchableMmdPhysicsBackend, "setFixedStepOverride">,
): MmdFrameState => {
  const targetSeconds = Math.max(0, seconds);
  evaluateMmdPreviewFrame(model, targetSeconds, false);
  physics.setFixedStepOverride(PHYSICS_FIXED_STEP);
  try {
    let state = evaluateMmdPreviewFrame(model, targetSeconds, true);
    const stepCount = Math.ceil(PHYSICS_SETTLE_SECONDS / PHYSICS_FIXED_STEP);
    for (let index = 0; index < stepCount; index += 1) {
      state = evaluateMmdPreviewFrame(model, targetSeconds, true);
    }
    return state;
  } finally {
    physics.setFixedStepOverride(null);
  }
};

export const syncMmdSkeletonForCpuRead = (model: ThreeMmdModel) => {
  model.root.updateMatrixWorld(true);
  model.mesh.skeleton.update();
  if (model.mesh.skeleton.boneTexture) {
    model.mesh.skeleton.boneTexture.needsUpdate = true;
  }
};

export const inspectMmdPreviewRuntime = (root: Object3D): PreviewRuntimeDiagnostics => {
  const skeletons = new Set<Skeleton>();
  let skinnedMeshCount = 0;
  root.traverse((object) => {
    if (!("isSkinnedMesh" in object) || object.isSkinnedMesh !== true) return;
    const skeleton = (object as Object3D & { skeleton?: Skeleton }).skeleton;
    if (!skeleton) return;
    skinnedMeshCount += 1;
    skeletons.add(skeleton);
  });
  return { skinnedMeshCount, uniqueSkeletonCount: skeletons.size };
};
