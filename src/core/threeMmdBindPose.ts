import type { SkinnedMesh } from "three";

/**
 * Runs setup against the skeleton's bind pose without replacing the pose
 * currently produced by animation, IK, or manual editing.
 */
export const withThreeMmdBindPose = <Result>(
  mesh: SkinnedMesh,
  callback: () => Result,
): Result => {
  const transforms = mesh.skeleton.bones.map((bone) => ({
    position: bone.position.clone(),
    quaternion: bone.quaternion.clone(),
    scale: bone.scale.clone(),
  }));
  try {
    mesh.pose();
    mesh.updateMatrixWorld(true);
    return callback();
  } finally {
    mesh.skeleton.bones.forEach((bone, index) => {
      const transform = transforms[index];
      if (!transform) return;
      bone.position.copy(transform.position);
      bone.quaternion.copy(transform.quaternion);
      bone.scale.copy(transform.scale);
    });
    mesh.updateMatrixWorld(true);
    mesh.skeleton.update();
  }
};
