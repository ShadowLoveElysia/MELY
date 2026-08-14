/**
 * Canonical pose coordinates used by MELY are the same right-handed space as
 * the Three.js MMD pipeline. Babylon's MMD runtime keeps the original MMD
 * left-handed space, so crossing the backend boundary reflects the Z axis.
 */
export type QuaternionTuple = [number, number, number, number];
export type PositionTuple = [number, number, number];

export const normalizeMmdQuaternion = (value: QuaternionTuple): QuaternionTuple => {
  const length = Math.hypot(value[0], value[1], value[2], value[3]);
  if (length <= 1e-12) return [0, 0, 0, 1];
  const normalized: QuaternionTuple = [
    value[0] / length,
    value[1] / length,
    value[2] / length,
    value[3] / length,
  ];
  if (normalized[3] < 0) {
    normalized[0] = -normalized[0];
    normalized[1] = -normalized[1];
    normalized[2] = -normalized[2];
    normalized[3] = -normalized[3];
  }
  return normalized;
};

/** Convert a canonical Three/MELY position to Babylon's MMD space. */
export const threeToBabylonPosition = (value: PositionTuple): PositionTuple => [
  value[0],
  value[1],
  -value[2],
];

/** Convert a Babylon MMD position to canonical Three/MELY space. */
export const babylonToThreePosition = (value: PositionTuple): PositionTuple => [
  value[0],
  value[1],
  -value[2],
];

/**
 * Reflection through Z maps quaternions as [-x, -y, z, w]. The transform is
 * involutive, so the same operation is used in both directions.
 */
export const reflectMmdQuaternionZ = (value: QuaternionTuple): QuaternionTuple => (
  normalizeMmdQuaternion([-value[0], -value[1], value[2], value[3]])
);

