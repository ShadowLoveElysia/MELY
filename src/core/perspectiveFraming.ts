export const MMD_PREVIEW_VERTICAL_FOV_DEGREES = 45;
export const MMD_PREVIEW_VERTICAL_FOV_RADIANS = Math.PI / 4;
export const MMD_PREVIEW_FRAME_PADDING = 1.28;
export const MMD_PREVIEW_DEPTH_PADDING = 0.45;
export const MMD_PREVIEW_MIN_DISTANCE = 3;

export interface PerspectiveFrameSize {
  width: number;
  height: number;
  depth: number;
}

export interface PerspectiveFrameBounds {
  min: readonly [number, number, number];
  max: readonly [number, number, number];
}

export interface FrameTransform {
  scale: readonly [number, number, number];
  position: readonly [number, number, number];
  rotationQuaternion?: readonly [number, number, number, number] | null;
}

const finiteNonNegative = (value: number) => (
  Number.isFinite(value) ? Math.max(0, value) : 0
);

/** Computes a renderer-neutral camera distance from vertical FOV and model bounds. */
export const perspectiveFrameDistance = (
  size: PerspectiveFrameSize,
  aspect: number,
  verticalFovRadians = MMD_PREVIEW_VERTICAL_FOV_RADIANS,
) => {
  const safeAspect = Number.isFinite(aspect) ? Math.max(0.1, aspect) : 1;
  const safeFov = Number.isFinite(verticalFovRadians)
    ? Math.min(Math.PI - 0.01, Math.max(0.01, verticalFovRadians))
    : MMD_PREVIEW_VERTICAL_FOV_RADIANS;
  const width = finiteNonNegative(size.width);
  const height = finiteNonNegative(size.height);
  const depth = finiteNonNegative(size.depth);
  const halfVerticalSpan = Math.tan(safeFov / 2);
  const fitHeight = height / (2 * halfVerticalSpan);
  const fitWidth = width / (2 * halfVerticalSpan * safeAspect);
  const distance = Math.max(fitHeight, fitWidth, depth) * MMD_PREVIEW_FRAME_PADDING
    + depth * MMD_PREVIEW_DEPTH_PADDING;
  return Math.max(MMD_PREVIEW_MIN_DISTANCE, distance);
};

const rotatePointByQuaternion = (
  point: readonly [number, number, number],
  quaternion: readonly [number, number, number, number],
) => {
  const [x, y, z] = point;
  const [qx, qy, qz, qw] = quaternion;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [
    x + qw * tx + (qy * tz - qz * ty),
    y + qw * ty + (qz * tx - qx * tz),
    z + qw * tz + (qx * ty - qy * tx),
  ] as const;
};

/** Applies the source root's native transform to all eight bounds corners. */
export const transformFrameBounds = (
  bounds: PerspectiveFrameBounds,
  transform: FrameTransform,
): PerspectiveFrameBounds => {
  const rotation = transform.rotationQuaternion ?? [0, 0, 0, 1];
  const minimum = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const maximum = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) {
        const rotated = rotatePointByQuaternion([
          x * transform.scale[0],
          y * transform.scale[1],
          z * transform.scale[2],
        ], rotation);
        rotated.forEach((value, axis) => {
          const worldValue = value + transform.position[axis];
          minimum[axis] = Math.min(minimum[axis], worldValue);
          maximum[axis] = Math.max(maximum[axis], worldValue);
        });
      }
    }
  }
  return {
    min: minimum as [number, number, number],
    max: maximum as [number, number, number],
  };
};
