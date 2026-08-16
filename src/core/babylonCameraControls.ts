export const BABYLON_PANNING_SENSIBILITY_MIN = 120;
export const BABYLON_PANNING_SENSIBILITY_MAX = 650;
export const BABYLON_PANNING_SENSIBILITY_RADIUS_SCALE = 8;
export const BABYLON_PANNING_INERTIA = 0.86;
export const BABYLON_ANGULAR_SENSIBILITY = 720;
export const BABYLON_CAMERA_INERTIA = 0.86;
export const BABYLON_DEFAULT_CAMERA_ALPHA = -Math.PI / 2;
export const BABYLON_DEFAULT_CAMERA_BETA = Math.PI / 2.4;

export interface BabylonPanningCamera {
  radius: number;
  panningSensibility: number;
  panningInertia: number;
  angularSensibilityX: number;
  angularSensibilityY: number;
  inertia: number;
}

export interface BabylonResettableCamera<TTarget = unknown> extends BabylonPanningCamera {
  alpha: number;
  beta: number;
  target?: {
    copyFrom?: (value: TTarget) => void;
  };
  inertialAlphaOffset?: number;
  inertialBetaOffset?: number;
  inertialRadiusOffset?: number;
  inertialPanningX?: number;
  inertialPanningY?: number;
}

export const babylonPanningSensibilityForRadius = (radius: number) => {
  const safeRadius = Number.isFinite(radius) ? Math.max(radius, 1) : 1;
  return Math.min(
    BABYLON_PANNING_SENSIBILITY_MAX,
    Math.max(
      BABYLON_PANNING_SENSIBILITY_MIN,
      safeRadius * BABYLON_PANNING_SENSIBILITY_RADIUS_SCALE,
    ),
  );
};

export const syncBabylonCameraPanningSensibility = (
  camera: BabylonPanningCamera,
) => {
  const sensibility = babylonPanningSensibilityForRadius(camera.radius);
  if (camera.panningSensibility !== sensibility) camera.panningSensibility = sensibility;
  return sensibility;
};

export const applyBabylonCameraPanningProfile = (
  camera: BabylonPanningCamera,
) => {
  camera.panningInertia = BABYLON_PANNING_INERTIA;
  camera.angularSensibilityX = BABYLON_ANGULAR_SENSIBILITY;
  camera.angularSensibilityY = BABYLON_ANGULAR_SENSIBILITY;
  camera.inertia = BABYLON_CAMERA_INERTIA;
  return syncBabylonCameraPanningSensibility(camera);
};

/** Restores preview framing without changing the source model transform. */
export const resetBabylonCameraView = <TTarget>(
  camera: BabylonResettableCamera<TTarget>,
  target: TTarget,
  radius: number,
) => {
  camera.alpha = BABYLON_DEFAULT_CAMERA_ALPHA;
  camera.beta = BABYLON_DEFAULT_CAMERA_BETA;
  camera.radius = Math.max(3, radius);
  camera.target?.copyFrom?.(target);
  camera.inertialAlphaOffset = 0;
  camera.inertialBetaOffset = 0;
  camera.inertialRadiusOffset = 0;
  camera.inertialPanningX = 0;
  camera.inertialPanningY = 0;
  syncBabylonCameraPanningSensibility(camera);
};
