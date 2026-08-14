import type { Box3, Group, SkinnedMesh } from "three";
import type {
  MelyPoseApplyResult,
  MelyPoseDocument,
  MmdBoneInfo,
  MmdMaterialInfo,
  MmdMeshSnapshot,
  MmdModelStats,
  MmdMotionTimes,
  MmdMotionTrackInfo,
  MmdMotionTrackKind,
  MmdPoseState,
} from "../types";

export type MmdRendererMode = "vanilla" | "moeru" | "babylon";

export interface MmdSnapshotOptions {
  onProgress?: (progress: number) => void;
  isCancelled?: () => boolean;
  includeTextures?: boolean;
  textureMaxEdge?: number;
  textureByteBudget?: number;
}

export const MMD_LIVE_PHYSICS_MAX_DELTA_SECONDS = 1 / 30;

export const computeMmdLivePhysicsDeltaSeconds = (
  nowMilliseconds: number,
  previousMilliseconds: number | null,
) => {
  if (
    previousMilliseconds === null
    || !Number.isFinite(nowMilliseconds)
    || !Number.isFinite(previousMilliseconds)
    || nowMilliseconds <= previousMilliseconds
  ) return 0;
  return Math.min(
    MMD_LIVE_PHYSICS_MAX_DELTA_SECONDS,
    (nowMilliseconds - previousMilliseconds) / 1000,
  );
};

export interface MmdPoseTransferState {
  /** Static pose imported by the user, kept separate from VMD evaluation. */
  importedPose: MelyPoseDocument | null;
  /** Manual bone offsets authored after animation evaluation. */
  manualOffsets: MelyPoseDocument;
}

export interface ThreeMmdViewportSource {
  kind: "three";
  root: Group;
  mesh: SkinnedMesh;
}

export interface BabylonMmdViewportSource {
  kind: "babylon";
  canvas: HTMLCanvasElement;
  engine: unknown;
  scene: unknown;
  camera: unknown;
  sourceRoot: unknown;
  sourceMeshes: readonly unknown[];
}

export type MmdViewportSource = ThreeMmdViewportSource | BabylonMmdViewportSource;

/**
 * Engine-neutral contract used by the application, viewport and conversion flow.
 * The active implementation owns animation, IK, morphs, physics and snapshotting.
 */
export interface LoadedMmdModel {
  id: string;
  rendererMode: MmdRendererMode;
  fileName: string;
  viewport: MmdViewportSource;
  stats: MmdModelStats;
  textureWarnings: readonly string[];
  bones: readonly MmdBoneInfo[];
  morphNames: readonly string[];
  materials: readonly MmdMaterialInfo[];
  translationStep: number;
  physicsAvailable: boolean;
  physicsEnabled: () => boolean;
  setPhysicsEnabled: (enabled: boolean) => Promise<void>;
  setMaterialVisible: (index: number, visible: boolean) => void;
  visibleBounds: (target?: Box3) => Box3;
  visibleTriangleCount: () => number;
  textureByteEstimate: () => number;
  loadMotion: (file: File, kind: MmdMotionTrackKind) => Promise<MmdMotionTrackInfo>;
  updatePreviewPose: (times: MmdMotionTimes) => MmdMotionTimes;
  updateLivePose: (times: MmdMotionTimes, deltaSeconds: number) => MmdMotionTimes;
  updatePose: (times: MmdMotionTimes) => MmdMotionTimes;
  createSnapshot: (options?: MmdSnapshotOptions) => Promise<MmdMeshSnapshot>;
  clearMotion: (kind?: MmdMotionTrackKind) => void;
  beginBoneEdit: (index: number) => void;
  updateBoneEdit: (index: number) => void;
  endBoneEdit: (index: number) => boolean;
  nudgeBone: (index: number, axis: "x" | "y" | "z", amount: number) => boolean;
  resetBone: (index: number) => boolean;
  undoPose: () => boolean;
  redoPose: () => boolean;
  resetPoseEdits: (recordHistory?: boolean) => boolean;
  exportMelyPose: () => MelyPoseDocument;
  importMelyPose: (document: MelyPoseDocument) => MelyPoseApplyResult;
  exportPoseTransferState: () => MmdPoseTransferState;
  importPoseTransferState: (state: MmdPoseTransferState) => MelyPoseApplyResult;
  poseState: () => MmdPoseState;
  dispose: () => void | Promise<void>;
}

export const isThreeMmdModel = (
  model: LoadedMmdModel,
): model is LoadedMmdModel & { viewport: ThreeMmdViewportSource } => (
  model.viewport.kind === "three"
);

export const isBabylonMmdModel = (
  model: LoadedMmdModel,
): model is LoadedMmdModel & { viewport: BabylonMmdViewportSource } => (
  model.viewport.kind === "babylon"
);
