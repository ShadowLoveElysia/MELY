import type { AppErrorCode } from "./core/appError";

export type HologramMaterial = "end_rod" | "white_pane" | "mixed";
export type DirectionMode = "vertical";
export type CameraMode = "perspective" | "orthographic";
export type PreviewMode = "source" | "hologram";
export type BoneControlMode = "rotate" | "translate";
export type GenerationMode = "hologram" | "solid";
export type SolidFillMode = "shell" | "filled";
export type SolidPalettePreset = "balanced" | "clean";
export type SolidFaceDetail = "off" | "balanced" | "strong";
export type MaterialTheme = "original" | "greekMarble" | "steampunk" | "ancientRuins";

export interface MmdBoneInfo {
  index: number;
  name: string;
  englishName: string;
  displayName: string;
  parentIndex: number;
  controlMode: BoneControlMode;
  isIkGoal: boolean;
}

export interface MmdPoseState {
  editCount: number;
  canUndo: boolean;
  canRedo: boolean;
}

export interface MelyPoseBone {
  name: string;
  pos: [number, number, number];
  rot: [number, number, number, number];
}

export interface MelyPoseMorph {
  name: string;
  weight: number;
}

export interface MelyPoseDocument {
  generator: "MELY";
  version: "1.0";
  bones: MelyPoseBone[];
  morphs?: MelyPoseMorph[];
}

export interface MelyPoseApplyResult {
  appliedBoneCount: number;
  missingBoneNames: string[];
  appliedMorphCount: number;
  missingMorphNames: string[];
}

export interface MmdMaterialInfo {
  index: number;
  name: string;
  englishName: string;
  displayName: string;
  color: [number, number, number];
  opacity: number;
  hasTexture: boolean;
  suggestedSkin: boolean;
  ambient: [number, number, number];
  suggestedEmissive: boolean;
}

export interface MmdModelStats {
  name: string;
  format: "pmx" | "pmd";
  vertexCount: number;
  triangleCount: number;
  materialCount: number;
  boneCount: number;
  morphCount: number;
  rigidBodyCount: number;
  jointCount: number;
  textureWarnings: number;
}

export interface MmdMotionInfo {
  name: string;
  modelName: string;
  maxFrame: number;
  frameRate: number;
  durationSeconds: number;
  boneTrackCount: number;
  morphTrackCount: number;
  matchedBoneTrackCount: number;
  matchedMorphTrackCount: number;
}

export type MmdMotionTrackKind = "dance" | "expression";

export interface MmdMotionTimes {
  dance: number;
  expression: number;
}

export type MmdMotionTrackInfo = MmdMotionInfo & {
  kind: MmdMotionTrackKind;
};

export type MmdMotionTracks = Record<MmdMotionTrackKind, MmdMotionTrackInfo | null>;

export interface HologramOptions {
  targetHeight: number;
  sampleSpacing: number;
  material: HologramMaterial;
  directionMode: DirectionMode;
  isolatePanes: boolean;
  preserveFace: boolean;
  glow: number;
}

export interface HologramStats {
  blockCount: number;
  endRodCount: number;
  paneCount: number;
  removedConflicts: number;
  dimensions: [number, number, number];
}

export interface HologramResult {
  kind?: "hologram";
  positions: Float32Array;
  facings: Uint8Array;
  materials: Uint8Array;
  faceFrame?: FaceFrameSnapshot;
  stats: HologramStats;
  bounds: {
    min: [number, number, number];
    max: [number, number, number];
  };
}

export interface MeshTextureSnapshot {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
}

export interface MeshMaterialSnapshot {
  name: string;
  englishName: string;
  baseColor: [number, number, number, number];
  textureFactor: [number, number, number, number];
  textureIndex: number;
  textureMatrix: [number, number, number, number, number, number, number, number, number];
  wrapS: number;
  wrapT: number;
  flipY: boolean;
  ambient: [number, number, number];
  emissive: boolean;
}

export interface FaceFrameSnapshot {
  origin: [number, number, number];
  right: [number, number, number];
  up: [number, number, number];
  forward: [number, number, number];
  eyeDistance: number;
  confidence: number;
}

export interface MmdMeshSnapshot {
  positions: Float32Array;
  indices: Uint32Array;
  triangleMaterials: Uint16Array;
  faceFrame?: FaceFrameSnapshot;
  uvs?: Float32Array;
  materials?: MeshMaterialSnapshot[];
  textures?: MeshTextureSnapshot[];
}

export type HologramMeshSnapshot = MmdMeshSnapshot;

export interface SolidOptions {
  targetHeight: number;
  alphaThreshold: number;
  thicknessCompensation: number;
  fillMode: SolidFillMode;
  palettePreset: SolidPalettePreset;
  faceDetail: SolidFaceDetail;
  materialTheme: MaterialTheme;
  dithering: number;
  emissiveMapping: boolean;
  emissiveMaterialIndices: number[];
  ruinDecoration: number;
  skinProtection: boolean;
  skinMaterialIndices: number[];
  excludeGravity: boolean;
  excludeRare: boolean;
}

export interface VoxelPaletteEntry {
  blockId: string;
  color: [number, number, number];
}

export interface SolidVoxelStats {
  blockCount: number;
  surfaceBlockCount: number;
  filledBlockCount: number;
  skinBlockCount: number;
  alphaRejected: number;
  triangleBoxTests: number;
  paletteSize: number;
  dimensions: [number, number, number];
}

export interface SolidVoxelResult {
  kind: "solid";
  positions: Float32Array;
  blockIndices: Uint16Array;
  palette: VoxelPaletteEntry[];
  faceFrame?: FaceFrameSnapshot;
  stats: SolidVoxelStats;
  bounds: {
    min: [number, number, number];
    max: [number, number, number];
  };
}

export type ProjectionResult = HologramResult | SolidVoxelResult;
export type ProjectionStats = HologramStats | SolidVoxelStats;

export type ProjectionEdition = "java" | "bedrock";
export type ProjectionAxis = "x" | "y" | "z";
export type ProjectionMetadataValue = string | number | boolean;

export interface ProjectionBlockState {
  blockId: string;
  properties?: Record<string, string>;
  color?: [number, number, number];
  emissive?: boolean;
}

export interface ProjectionBlock {
  position: [number, number, number];
  paletteIndex: number;
}

export interface ProjectionBounds {
  min: [number, number, number];
  max: [number, number, number];
  dimensions: [number, number, number];
}

export interface ProjectionChunk {
  chunk: [number, number, number];
  positions: Uint16Array;
  paletteIndices: Uint16Array | Uint32Array;
}

export interface ProjectionDocumentV1 {
  format: "MELYProjection";
  version: 1;
  edition: ProjectionEdition;
  minecraftVersion: string;
  metadata?: Record<string, ProjectionMetadataValue>;
  palette: ProjectionBlockState[];
  chunks: ProjectionChunk[];
  bounds: ProjectionBounds | null;
  blockCount: number;
}

export type ProjectionDocument = ProjectionDocumentV1;

export interface ProjectionDocumentOptions {
  edition?: ProjectionEdition;
  minecraftVersion?: string;
  metadata?: Record<string, ProjectionMetadataValue>;
}

export interface ProjectionMaterialCount {
  paletteIndex: number;
  state: ProjectionBlockState;
  count: number;
}

export interface ProjectionView {
  index: [number, number, number];
  bounds: ProjectionBounds;
  occupiedBounds: ProjectionBounds;
  blockCount: number;
}

export type HologramSource =
  | { kind: "demo" }
  | { kind: "mesh"; mesh: MmdMeshSnapshot };

export type WorkerCommand =
  | {
      type: "GENERATE_HOLOGRAM";
      jobId: string;
      options: HologramOptions;
      source: HologramSource;
    }
  | {
      type: "GENERATE_SOLID";
      jobId: string;
      options: SolidOptions;
      source: { kind: "mesh"; mesh: MmdMeshSnapshot };
    };

export type WorkerStage =
  | "tracing"
  | "sampling"
  | "isolation"
  | "voxelizing"
  | "texturing"
  | "filling"
  | "matching"
  | "complete";

export type WorkerEvent =
  | {
      type: "PROGRESS";
      jobId: string;
      stage: WorkerStage;
      progress: number;
    }
  | {
      type: "RESULT";
      jobId: string;
      result: ProjectionResult;
    }
  | {
      type: "ERROR";
      jobId: string;
      code: AppErrorCode;
      params?: Record<string, string | number>;
    };
