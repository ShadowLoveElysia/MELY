import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { getBlockDefinition } from "../core/blockRegistry";
import type { LoadedMmdModel } from "../core/mmdModel";
import { createMmdFaceFrameSnapshot } from "../core/mmdSnapshot";
import { useI18n } from "../i18n/I18nProvider";
import type { CameraMode, MmdMotionTimes, PreviewMode, ProjectionResult } from "../types";

interface Viewport3DProps {
  result: ProjectionResult | null;
  model: LoadedMmdModel | null;
  previewMode: PreviewMode;
  targetHeight: number;
  modelLoading: boolean;
  glow: number;
  nightMode: boolean;
  cameraMode: CameraMode;
  showGrid: boolean;
  showBounds: boolean;
  resetToken: number;
  focusFaceToken: number;
  poseRevision: number;
  poseEditing: boolean;
  selectedBoneIndex: number | null;
  onBoneSelected: (index: number | null) => void;
  onPoseCommitted: () => void;
  onBeforeRender?: (now: number) => MmdMotionTimes | null;
  onAfterRender?: (now: number, evaluatedMotionTimes: MmdMotionTimes | null, gpuSynchronized: boolean) => void;
  onReady?: () => void;
}

interface ViewportRuntime {
  mount: HTMLDivElement;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  perspective: THREE.PerspectiveCamera;
  orthographic: THREE.OrthographicCamera;
  orthographicHalfHeight: number;
  controls: OrbitControls;
  transformControls: TransformControls;
  sourceContent: THREE.Group;
  hologramContent: THREE.Group;
  skeletonHelper: THREE.SkeletonHelper | null;
  boneMarkers: THREE.InstancedMesh | null;
  selectedBoneMarker: THREE.Mesh | null;
  markerBoneIndices: number[];
  sourceBounds: THREE.Box3;
  hologramBounds: THREE.Box3;
  activeMode: PreviewMode;
  grid: THREE.GridHelper;
  bounds: THREE.Box3Helper;
  keyLight: THREE.DirectionalLight;
  rimLight: THREE.DirectionalLight;
  hemisphereLight: THREE.HemisphereLight;
  animationFrame: number;
}

type ProjectionMaterialRole = "solid" | "endRod" | "endRodCap" | "pane";

interface ProjectionMaterialMetadata {
  role: ProjectionMaterialRole;
  lightLevel?: number;
}

const DAY_BACKGROUND = "#111314";
const NIGHT_BACKGROUND = "#050811";
const DAY_FOG = "#111314";
const NIGHT_FOG = "#070b16";
const MATERIAL_METADATA_KEY = "melyProjectionMaterial";

const FALLBACK_LIGHT_LEVELS = new Map<string, number>([
  ["beacon", 15],
  ["campfire", 15],
  ["fire", 15],
  ["jack_o_lantern", 15],
  ["lantern", 15],
  ["lava", 15],
  ["light", 15],
  ["magma_block", 3],
  ["redstone_lamp", 15],
  ["respawn_anchor", 15],
  ["shroomlight", 15],
  ["soul_campfire", 10],
  ["soul_fire", 10],
  ["soul_lantern", 10],
  ["soul_torch", 10],
  ["torch", 14],
]);

const normalizedBlockName = (blockId: string) => blockId
  .normalize("NFKC")
  .trim()
  .toLowerCase()
  .replace(/^minecraft:/, "")
  .replace(/\[.*$/, "");

const previewLightLevel = (blockId: string) => {
  const blockName = normalizedBlockName(blockId);
  const registeredLevel = getBlockDefinition(blockName).lightLevel;
  if (registeredLevel > 0) return registeredLevel;

  const exactFallback = FALLBACK_LIGHT_LEVELS.get(blockName);
  if (exactFallback !== undefined) return exactFallback;
  if (blockName.endsWith("_froglight") || blockName.endsWith("_candle")) return 15;
  return 0;
};

const tagProjectionMaterial = (
  material: THREE.Material,
  metadata: ProjectionMaterialMetadata,
) => {
  material.userData[MATERIAL_METADATA_KEY] = metadata;
};

const projectionMaterialMetadata = (
  material: THREE.Material,
): ProjectionMaterialMetadata | null => {
  const value = material.userData[MATERIAL_METADATA_KEY] as ProjectionMaterialMetadata | undefined;
  return value?.role ? value : null;
};

const markerGeometry = new THREE.SphereGeometry(0.52, 10, 8);
const markerMaterial = new THREE.MeshBasicMaterial({
  color: "#54cedd",
  depthTest: false,
  depthWrite: false,
  transparent: true,
  opacity: 0.96,
  toneMapped: false,
});
const selectedMarkerMaterial = new THREE.MeshBasicMaterial({
  color: "#f0b45e",
  depthTest: false,
  depthWrite: false,
  transparent: true,
  opacity: 1,
  toneMapped: false,
});
const markerMatrix = new THREE.Matrix4();
const markerPosition = new THREE.Vector3();
const markerScale = new THREE.Vector3(1, 1, 1);
const markerQuaternion = new THREE.Quaternion();

const DEFAULT_BOUNDS = new THREE.Box3(
  new THREE.Vector3(-28, 0, -18),
  new THREE.Vector3(28, 96, 18),
);

const disposeGeneratedContent = (group: THREE.Group) => {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    const meshMaterials = Array.isArray(object.material) ? object.material : [object.material];
    meshMaterials.forEach((material) => materials.add(material));
    if (object instanceof THREE.InstancedMesh) object.dispose();
  });
  group.clear();
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
};

const updateProjectionMaterials = (
  group: THREE.Group,
  nightMode: boolean,
  glow: number,
) => {
  const glowRatio = THREE.MathUtils.clamp(glow / 100, 0, 1);
  group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach((material) => {
      const metadata = projectionMaterialMetadata(material);
      if (!metadata) return;

      if (metadata.role === "solid" && material instanceof THREE.MeshStandardMaterial) {
        const lightRatio = THREE.MathUtils.clamp((metadata.lightLevel ?? 0) / 15, 0, 1);
        if (lightRatio > 0) {
          material.emissive.copy(material.color);
          material.emissiveIntensity = nightMode
            ? 0.7 + lightRatio * 1.3
            : 0.04 * lightRatio;
        } else {
          material.emissive.setRGB(0, 0, 0);
          material.emissiveIntensity = 0;
        }
        return;
      }

      if (!(material instanceof THREE.MeshBasicMaterial)) return;
      if (metadata.role === "endRod") {
        const low = nightMode ? "#d6f3ec" : "#b9d8d0";
        material.color.set(low).lerp(new THREE.Color("#f5fff9"), glowRatio);
      } else if (metadata.role === "endRodCap") {
        const low = nightMode ? "#e7faf5" : "#d8eee8";
        material.color.set(low).lerp(new THREE.Color("#ffffff"), glowRatio);
      } else if (metadata.role === "pane") {
        const low = nightMode ? "#dae8f2" : "#c9d8d5";
        material.color.set(low).lerp(new THREE.Color("#ffffff"), glowRatio);
        material.opacity = (nightMode ? 0.58 : 0.48) + glowRatio * 0.28;
      }
    });
  });
};

const updateNightPreview = (
  runtime: ViewportRuntime,
  nightMode: boolean,
  glow: number,
) => {
  const background = runtime.scene.background;
  if (background instanceof THREE.Color) {
    background.set(nightMode ? NIGHT_BACKGROUND : DAY_BACKGROUND);
  } else {
    runtime.scene.background = new THREE.Color(nightMode ? NIGHT_BACKGROUND : DAY_BACKGROUND);
  }

  if (runtime.scene.fog instanceof THREE.FogExp2) {
    runtime.scene.fog.color.set(nightMode ? NIGHT_FOG : DAY_FOG);
    runtime.scene.fog.density = nightMode ? 0.00075 : 0.00055;
  }

  runtime.keyLight.color.set(nightMode ? "#7f91c9" : "#e7f6ff");
  runtime.keyLight.intensity = nightMode ? 0.42 : 2.7;
  runtime.rimLight.color.set(nightMode ? "#397f92" : "#67e6cb");
  runtime.rimLight.intensity = nightMode ? 0.5 : 1.9;
  runtime.hemisphereLight.color.set(nightMode ? "#27375f" : "#a7cbd8");
  runtime.hemisphereLight.groundColor.set(nightMode ? "#04060c" : "#181b1d");
  runtime.hemisphereLight.intensity = nightMode ? 0.24 : 1.15;
  runtime.renderer.toneMappingExposure = nightMode ? 0.78 : 1.08;
  updateProjectionMaterials(runtime.hologramContent, nightMode, glow);
};

const disposePoseHelpers = (runtime: ViewportRuntime) => {
  runtime.transformControls.detach();
  if (runtime.skeletonHelper) {
    runtime.scene.remove(runtime.skeletonHelper);
    runtime.skeletonHelper.dispose();
    runtime.skeletonHelper = null;
  }
  if (runtime.boneMarkers) {
    runtime.scene.remove(runtime.boneMarkers);
    runtime.boneMarkers.dispose();
    runtime.boneMarkers = null;
  }
  if (runtime.selectedBoneMarker) {
    runtime.scene.remove(runtime.selectedBoneMarker);
    runtime.selectedBoneMarker = null;
  }
  runtime.markerBoneIndices = [];
};

const collectMarkerBoneIndices = (model: LoadedMmdModel) => {
  const indices = new Set<number>();
  const skinIndex = model.mesh.geometry.getAttribute("skinIndex");
  const skinWeight = model.mesh.geometry.getAttribute("skinWeight");
  if (skinIndex && skinWeight) {
    const componentValue = (
      attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
      index: number,
      component: number,
    ) => component === 0
      ? attribute.getX(index)
      : component === 1
        ? attribute.getY(index)
        : component === 2
          ? attribute.getZ(index)
          : attribute.getW(index);
    for (let vertex = 0; vertex < skinIndex.count; vertex += 1) {
      for (let component = 0; component < 4; component += 1) {
        if (componentValue(skinWeight, vertex, component) <= 0.001) continue;
        const boneIndex = Math.round(componentValue(skinIndex, vertex, component));
        if (model.bones[boneIndex]) indices.add(boneIndex);
      }
    }
  }
  model.bones.forEach((bone) => {
    if (bone.isIkGoal || bone.parentIndex < 0) indices.add(bone.index);
  });
  return [...indices].sort((left, right) => left - right);
};

const refreshBoneMarkers = (
  runtime: ViewportRuntime,
  model: LoadedMmdModel | null,
  selectedBoneIndex: number | null,
) => {
  const markers = runtime.boneMarkers;
  if (!markers || !model) return;
  runtime.markerBoneIndices.forEach((boneIndex, instanceIndex) => {
    const bone = model.mesh.skeleton.bones[boneIndex];
    if (!bone) return;
    bone.getWorldPosition(markerPosition);
    markerMatrix.compose(markerPosition, markerQuaternion, markerScale);
    markers.setMatrixAt(instanceIndex, markerMatrix);
  });
  markers.instanceMatrix.needsUpdate = true;
  markers.computeBoundingSphere();

  const selectedMarker = runtime.selectedBoneMarker;
  if (!selectedMarker) return;
  const selectedBone = selectedBoneIndex === null
    ? null
    : model.mesh.skeleton.bones[selectedBoneIndex];
  selectedMarker.userData.hasSelection = Boolean(selectedBone);
  if (selectedBone) {
    selectedBone.getWorldPosition(selectedMarker.position);
    selectedMarker.updateMatrixWorld(true);
  } else {
    selectedMarker.visible = false;
  }
};

const refreshPoseToolVisibility = (
  runtime: ViewportRuntime,
  enabled: boolean,
) => {
  const visible = enabled && runtime.activeMode === "source";
  if (runtime.skeletonHelper) runtime.skeletonHelper.visible = visible;
  if (runtime.boneMarkers) runtime.boneMarkers.visible = visible;
  if (runtime.selectedBoneMarker) {
    runtime.selectedBoneMarker.visible = visible && Boolean(runtime.selectedBoneMarker.userData.hasSelection);
  }
  runtime.transformControls.enabled = visible;
  runtime.transformControls.getHelper().visible = visible && Boolean(runtime.transformControls.object);
  if (!visible) runtime.controls.enabled = true;
};

const activeBounds = (runtime: ViewportRuntime) => {
  const selected = runtime.activeMode === "source" ? runtime.sourceBounds : runtime.hologramBounds;
  return selected.isEmpty() ? DEFAULT_BOUNDS : selected;
};

const updateOrthographicProjection = (runtime: ViewportRuntime) => {
  const aspect = runtime.mount.clientWidth / Math.max(1, runtime.mount.clientHeight);
  runtime.orthographic.left = -runtime.orthographicHalfHeight * aspect;
  runtime.orthographic.right = runtime.orthographicHalfHeight * aspect;
  runtime.orthographic.top = runtime.orthographicHalfHeight;
  runtime.orthographic.bottom = -runtime.orthographicHalfHeight;
  runtime.orthographic.updateProjectionMatrix();
};

const fitCameraToBounds = (
  runtime: ViewportRuntime,
  bounds: THREE.Box3,
  resetDirection = false,
) => {
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const camera = runtime.controls.object;
  const aspect = runtime.mount.clientWidth / Math.max(1, runtime.mount.clientHeight);
  const direction = resetDirection
    ? new THREE.Vector3(1.05, 0.58, 1.35)
    : camera.position.clone().sub(runtime.controls.target);

  if (direction.lengthSq() < 0.001) direction.set(1.05, 0.58, 1.35);
  direction.normalize();
  runtime.controls.target.copy(center);

  if (camera instanceof THREE.PerspectiveCamera) {
    const verticalFov = THREE.MathUtils.degToRad(camera.fov);
    const fitHeight = size.y / (2 * Math.tan(verticalFov / 2));
    const fitWidth = size.x / (2 * Math.tan(verticalFov / 2) * Math.max(aspect, 0.1));
    const distance = Math.max(fitHeight, fitWidth, size.z) * 1.28 + size.z * 0.45;
    camera.position.copy(center).addScaledVector(direction, Math.max(distance, 28));
    camera.near = Math.max(0.05, distance / 200);
    camera.far = Math.max(1200, distance * 8);
    camera.updateProjectionMatrix();
  } else {
    const orthographic = runtime.orthographic;
    runtime.orthographicHalfHeight = Math.max(
      10,
      size.y * 0.62,
      size.x / Math.max(aspect, 0.1) * 0.62,
    );
    const distance = Math.max(size.length() * 1.4, 120);
    orthographic.position.copy(center).addScaledVector(direction, distance);
    orthographic.near = 0.05;
    orthographic.far = Math.max(1200, distance * 8);
    updateOrthographicProjection(runtime);
  }

  runtime.controls.minDistance = Math.max(4, size.length() * 0.08);
  runtime.controls.maxDistance = Math.max(420, size.length() * 6);
  runtime.controls.update();
};

const focusCameraOnFace = (
  runtime: ViewportRuntime,
  model: LoadedMmdModel,
  result: ProjectionResult | null,
) => {
  const projectionFrame = runtime.activeMode === "hologram" ? result?.faceFrame : undefined;
  const faceFrame = projectionFrame ?? createMmdFaceFrameSnapshot(model);
  if (!faceFrame) return false;

  const origin = new THREE.Vector3().fromArray(faceFrame.origin);
  const toWorld = projectionFrame
    ? (point: THREE.Vector3) => point.clone()
    : (point: THREE.Vector3) => model.root.localToWorld(point.clone());
  if (!projectionFrame) model.root.updateMatrixWorld(true);
  const center = toWorld(origin);
  const axisEndpoint = (
    axis: [number, number, number],
    length: number,
  ) => toWorld(origin.clone().addScaledVector(new THREE.Vector3().fromArray(axis), length));
  const rightEndpoint = axisEndpoint(faceFrame.right, faceFrame.eyeDistance);
  const upEndpoint = axisEndpoint(faceFrame.up, faceFrame.eyeDistance);
  const forwardEndpoint = axisEndpoint(faceFrame.forward, faceFrame.eyeDistance);
  const eyeDistance = Math.max(center.distanceTo(rightEndpoint), 0.01);
  const up = upEndpoint.sub(center).normalize();
  const forward = forwardEndpoint.sub(center).normalize();
  const target = center.clone().addScaledVector(up, -eyeDistance * 0.48);
  const portraitHeight = eyeDistance * 4.4;
  const portraitWidth = eyeDistance * 3.6;
  const aspect = runtime.mount.clientWidth / Math.max(1, runtime.mount.clientHeight);
  const camera = runtime.controls.object;
  const sceneSize = activeBounds(runtime).getSize(new THREE.Vector3());

  runtime.controls.target.copy(target);
  if (camera instanceof THREE.PerspectiveCamera) {
    const verticalFov = THREE.MathUtils.degToRad(camera.fov);
    const fitHeight = portraitHeight / (2 * Math.tan(verticalFov / 2));
    const fitWidth = portraitWidth / (2 * Math.tan(verticalFov / 2) * Math.max(aspect, 0.1));
    const distance = Math.max(fitHeight, fitWidth) * 1.08;
    camera.position.copy(target).addScaledVector(forward, distance);
    camera.up.copy(up);
    camera.near = Math.max(0.05, distance / 250);
    camera.far = Math.max(1200, distance + sceneSize.length() * 2);
    camera.updateProjectionMatrix();
  } else if (camera instanceof THREE.OrthographicCamera) {
    const distance = Math.max(eyeDistance * 8, sceneSize.length() * 0.25, 24);
    runtime.orthographicHalfHeight = Math.max(
      portraitHeight * 0.54,
      portraitWidth / Math.max(aspect, 0.1) * 0.54,
    );
    camera.position.copy(target).addScaledVector(forward, distance);
    camera.up.copy(up);
    camera.near = 0.05;
    camera.far = Math.max(1200, distance + sceneSize.length() * 2);
    camera.zoom = 1;
    updateOrthographicProjection(runtime);
  } else {
    return false;
  }

  runtime.controls.minDistance = Math.max(0.5, eyeDistance * 0.7);
  runtime.controls.maxDistance = Math.max(420, sceneSize.length() * 6);
  runtime.controls.update();
  return true;
};

const refreshActiveScene = (
  runtime: ViewportRuntime,
  mode: PreviewMode,
  showBounds: boolean,
  fit: boolean,
) => {
  runtime.activeMode = mode;
  runtime.sourceContent.visible = mode === "source";
  runtime.hologramContent.visible = mode === "hologram";
  const selectedBounds = activeBounds(runtime);
  runtime.bounds.box.copy(selectedBounds);
  runtime.bounds.visible = showBounds && !selectedBounds.isEmpty();
  runtime.bounds.updateMatrixWorld(true);
  if (fit) fitCameraToBounds(runtime, selectedBounds);
};

const MAX_RENDER_PIXEL_RATIO = 1.5;
const MAX_RENDER_PIXEL_COUNT = 3_200_000;

const updateRendererSize = (
  renderer: THREE.WebGLRenderer,
  width: number,
  height: number,
) => {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const pixelBudgetRatio = Math.sqrt(MAX_RENDER_PIXEL_COUNT / (safeWidth * safeHeight));
  renderer.setPixelRatio(Math.max(1, Math.min(
    window.devicePixelRatio,
    MAX_RENDER_PIXEL_RATIO,
    pixelBudgetRatio,
  )));
  renderer.setSize(safeWidth, safeHeight);
};

export function Viewport3D({
  result,
  model,
  previewMode,
  targetHeight,
  modelLoading,
  glow,
  nightMode,
  cameraMode,
  showGrid,
  showBounds,
  resetToken,
  focusFaceToken,
  poseRevision,
  poseEditing,
  selectedBoneIndex,
  onBoneSelected,
  onPoseCommitted,
  onBeforeRender,
  onAfterRender,
  onReady,
}: Viewport3DProps) {
  const { t } = useI18n();
  const mountRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<ViewportRuntime | null>(null);
  const modelRef = useRef(model);
  const attachedModelRef = useRef<LoadedMmdModel | null>(null);
  const resultRef = useRef(result);
  const poseEditingRef = useRef(poseEditing);
  const selectedBoneIndexRef = useRef(selectedBoneIndex);
  const onBoneSelectedRef = useRef(onBoneSelected);
  const onPoseCommittedRef = useRef(onPoseCommitted);
  const onBeforeRenderRef = useRef(onBeforeRender);
  const onAfterRenderRef = useRef(onAfterRender);

  modelRef.current = model;
  resultRef.current = result;
  poseEditingRef.current = poseEditing;
  selectedBoneIndexRef.current = selectedBoneIndex;
  onBoneSelectedRef.current = onBoneSelected;
  onPoseCommittedRef.current = onPoseCommitted;
  onBeforeRenderRef.current = onBeforeRender;
  onAfterRenderRef.current = onAfterRender;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(DAY_BACKGROUND);
    scene.fog = new THREE.FogExp2(DAY_FOG, 0.00055);

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    updateRendererSize(renderer, mount.clientWidth, mount.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    mount.appendChild(renderer.domElement);

    const aspect = mount.clientWidth / Math.max(1, mount.clientHeight);
    const perspective = new THREE.PerspectiveCamera(34, aspect, 0.1, 1200);
    const orthographic = new THREE.OrthographicCamera(-135 * aspect, 135 * aspect, 135, -135, 0.1, 1200);
    perspective.position.set(118, 77, 145);
    orthographic.position.copy(perspective.position);

    const controls = new OrbitControls(perspective, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.075;
    controls.target.set(0, 40, 0);

    const transformControls = new TransformControls(perspective, renderer.domElement);
    transformControls.setMode("rotate");
    transformControls.setSpace("local");
    transformControls.setSize(0.64);
    transformControls.enabled = false;
    transformControls.getHelper().visible = false;
    scene.add(transformControls.getHelper());

    const grid = new THREE.GridHelper(240, 48, "#28505a", "#242b2d");
    grid.position.y = -0.05;
    scene.add(grid);

    const sourceContent = new THREE.Group();
    const hologramContent = new THREE.Group();
    scene.add(sourceContent, hologramContent);

    const bounds = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color("#24b6cb"));
    const boundsMaterials = Array.isArray(bounds.material) ? bounds.material : [bounds.material];
    boundsMaterials.forEach((material) => {
      material.transparent = true;
      material.opacity = 0.48;
    });
    scene.add(bounds);

    const keyLight = new THREE.DirectionalLight("#e7f6ff", 2.7);
    keyLight.position.set(55, 120, 95);
    scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight("#67e6cb", 1.9);
    rimLight.position.set(-90, 48, -65);
    scene.add(rimLight);
    const hemisphereLight = new THREE.HemisphereLight("#a7cbd8", "#181b1d", 1.15);
    scene.add(hemisphereLight);

    const runtime: ViewportRuntime = {
      mount,
      renderer,
      scene,
      perspective,
      orthographic,
      orthographicHalfHeight: 135,
      controls,
      transformControls,
      sourceContent,
      hologramContent,
      skeletonHelper: null,
      boneMarkers: null,
      selectedBoneMarker: null,
      markerBoneIndices: [],
      sourceBounds: new THREE.Box3(),
      hologramBounds: new THREE.Box3(),
      activeMode: previewMode,
      grid,
      bounds,
      keyLight,
      rimLight,
      hemisphereLight,
      animationFrame: 0,
    };
    runtimeRef.current = runtime;
    updateNightPreview(runtime, nightMode, glow);
    refreshActiveScene(runtime, previewMode, showBounds, false);
    fitCameraToBounds(runtime, DEFAULT_BOUNDS, true);

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const updatePointer = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(
        ((event.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1,
        -((event.clientY - rect.top) / Math.max(rect.height, 1)) * 2 + 1,
      );
    };
    const selectBoneAtPointer = (event: PointerEvent) => {
      if (event.button !== 0 || transformControls.dragging || transformControls.axis) return;
      const activeModel = modelRef.current;
      if (!poseEditingRef.current || runtime.activeMode !== "source" || !activeModel || !runtime.boneMarkers) return;
      updatePointer(event);
      raycaster.setFromCamera(pointer, controls.object as THREE.Camera);
      const hit = raycaster.intersectObject(runtime.boneMarkers, false)[0];
      const markerIndex = hit?.instanceId;
      const boneIndex = markerIndex === undefined ? null : runtime.markerBoneIndices[markerIndex] ?? null;
      onBoneSelectedRef.current(boneIndex);
    };
    const beginTransform = () => {
      const activeModel = modelRef.current;
      const boneIndex = selectedBoneIndexRef.current;
      if (!activeModel || boneIndex === null) return;
      activeModel.beginBoneEdit(boneIndex);
      controls.enabled = false;
    };
    const updateTransform = () => {
      const activeModel = modelRef.current;
      const boneIndex = selectedBoneIndexRef.current;
      if (!activeModel || boneIndex === null) return;
      activeModel.updateBoneEdit(boneIndex);
      runtime.sourceContent.updateMatrixWorld(true);
      runtime.sourceBounds.setFromObject(runtime.sourceContent, false);
      runtime.bounds.box.copy(runtime.sourceBounds);
      runtime.bounds.updateMatrixWorld(true);
      refreshBoneMarkers(runtime, activeModel, boneIndex);
    };
    const commitTransform = () => {
      const activeModel = modelRef.current;
      const boneIndex = selectedBoneIndexRef.current;
      controls.enabled = true;
      if (!activeModel || boneIndex === null) return;
      if (activeModel.endBoneEdit(boneIndex)) onPoseCommittedRef.current();
    };
    renderer.domElement.addEventListener("pointerdown", selectBoneAtPointer);
    transformControls.addEventListener("mouseDown", beginTransform);
    transformControls.addEventListener("objectChange", updateTransform);
    transformControls.addEventListener("mouseUp", commitTransform);

    const animate = (now: number) => {
      const evaluatedMotionTimes = onBeforeRenderRef.current?.(now) ?? null;
      controls.update();
      if (poseEditingRef.current && runtime.activeMode === "source") {
        refreshBoneMarkers(runtime, modelRef.current, selectedBoneIndexRef.current);
      }
      renderer.render(scene, controls.object as THREE.Camera);
      const gpuSynchronized = Boolean((window as Window & {
        __MELY_E2E_GPU_PROBE__?: boolean;
      }).__MELY_E2E_GPU_PROBE__);
      if (gpuSynchronized) renderer.getContext().finish();
      onAfterRenderRef.current?.(performance.now(), evaluatedMotionTimes, gpuSynchronized);
      runtime.animationFrame = requestAnimationFrame(animate);
    };
    runtime.animationFrame = requestAnimationFrame(animate);

    const resizeObserver = new ResizeObserver(() => {
      const width = mount.clientWidth;
      const height = Math.max(1, mount.clientHeight);
      perspective.aspect = width / height;
      perspective.updateProjectionMatrix();
      updateOrthographicProjection(runtime);
      updateRendererSize(renderer, width, height);
    });
    resizeObserver.observe(mount);
    onReady?.();

    return () => {
      resizeObserver.disconnect();
      cancelAnimationFrame(runtime.animationFrame);
      renderer.domElement.removeEventListener("pointerdown", selectBoneAtPointer);
      transformControls.removeEventListener("mouseDown", beginTransform);
      transformControls.removeEventListener("objectChange", updateTransform);
      transformControls.removeEventListener("mouseUp", commitTransform);
      disposePoseHelpers(runtime);
      scene.remove(transformControls.getHelper());
      transformControls.dispose();
      controls.dispose();
      sourceContent.clear();
      disposeGeneratedContent(hologramContent);
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      bounds.geometry.dispose();
      boundsMaterials.forEach((material) => material.dispose());
      renderer.dispose();
      renderer.domElement.remove();
      runtimeRef.current = null;
    };
  }, []);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const previousCamera = runtime.controls.object;
    const nextCamera = cameraMode === "orthographic" ? runtime.orthographic : runtime.perspective;
    nextCamera.position.copy(previousCamera.position);
    nextCamera.quaternion.copy(previousCamera.quaternion);
    runtime.controls.object = nextCamera;
    runtime.transformControls.camera = nextCamera;
    fitCameraToBounds(runtime, activeBounds(runtime));
  }, [cameraMode]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const modeChanged = runtime.activeMode !== previewMode;
    runtime.grid.visible = showGrid;
    refreshActiveScene(runtime, previewMode, showBounds, modeChanged);
    refreshPoseToolVisibility(runtime, poseEditing);
  }, [poseEditing, previewMode, showBounds, showGrid]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    updateNightPreview(runtime, nightMode, glow);
  }, [glow, nightMode]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    fitCameraToBounds(runtime, activeBounds(runtime), true);
  }, [resetToken]);

  useEffect(() => {
    if (focusFaceToken <= 0) return;
    const runtime = runtimeRef.current;
    const activeModel = modelRef.current;
    if (!runtime || !activeModel) return;
    focusCameraOnFace(runtime, activeModel, resultRef.current);
  }, [focusFaceToken]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;

    if (attachedModelRef.current !== model) runtime.renderer.renderLists.dispose();
    attachedModelRef.current = model;
    runtime.sourceContent.clear();
    runtime.sourceBounds.makeEmpty();
    if (!model) return;

    runtime.sourceContent.add(model.root);

    return () => {
      if (model.root.parent === runtime.sourceContent) runtime.sourceContent.remove(model.root);
    };
  }, [model]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    if (!model || model.root.parent !== runtime.sourceContent) {
      runtime.sourceBounds.makeEmpty();
      refreshActiveScene(runtime, previewMode, showBounds, previewMode === "source");
      return;
    }

    runtime.sourceContent.position.set(0, 0, 0);
    runtime.sourceContent.scale.setScalar(1);
    model.root.updateMatrixWorld(true);

    const rawBounds = new THREE.Box3().setFromObject(model.root, false);
    const rawSize = rawBounds.getSize(new THREE.Vector3());
    const rawCenter = rawBounds.getCenter(new THREE.Vector3());
    const targetSpan = Math.max(1, Math.round(targetHeight) - 1);
    const scale = targetSpan / Math.max(rawSize.y, 0.001);
    runtime.sourceContent.scale.setScalar(scale);
    runtime.sourceContent.position.set(-rawCenter.x * scale, -rawBounds.min.y * scale, -rawCenter.z * scale);
    runtime.sourceContent.updateMatrixWorld(true);
    runtime.sourceBounds.setFromObject(runtime.sourceContent, false);
    refreshActiveScene(runtime, previewMode, showBounds, previewMode === "source");
  }, [model, previewMode, showBounds, targetHeight]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    disposePoseHelpers(runtime);
    if (!model) return;

    const skeletonHelper = new THREE.SkeletonHelper(model.root);
    skeletonHelper.renderOrder = 20;
    skeletonHelper.setColors(new THREE.Color("#3c91a1"), new THREE.Color("#83e5d1"));
    const helperMaterial = skeletonHelper.material as THREE.LineBasicMaterial;
    helperMaterial.opacity = 0.7;
    helperMaterial.transparent = true;
    runtime.scene.add(skeletonHelper);
    runtime.skeletonHelper = skeletonHelper;

    const markerBoneIndices = collectMarkerBoneIndices(model);
    const markers = new THREE.InstancedMesh(markerGeometry, markerMaterial, markerBoneIndices.length);
    markers.name = "MELY bone markers";
    markers.renderOrder = 21;
    markers.frustumCulled = false;
    runtime.scene.add(markers);
    runtime.boneMarkers = markers;

    const selectedMarker = new THREE.Mesh(markerGeometry, selectedMarkerMaterial);
    selectedMarker.name = "MELY selected bone marker";
    selectedMarker.renderOrder = 22;
    selectedMarker.scale.setScalar(1.45);
    selectedMarker.visible = false;
    runtime.scene.add(selectedMarker);
    runtime.selectedBoneMarker = selectedMarker;
    runtime.markerBoneIndices = markerBoneIndices;
    refreshBoneMarkers(runtime, model, selectedBoneIndex);
    refreshPoseToolVisibility(runtime, poseEditing);

    return () => disposePoseHelpers(runtime);
  }, [model]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const bone = model && selectedBoneIndex !== null
      ? model.mesh.skeleton.bones[selectedBoneIndex]
      : null;
    const boneInfo = model && selectedBoneIndex !== null ? model.bones[selectedBoneIndex] : null;
    if (!poseEditing || previewMode !== "source" || !bone || !boneInfo) {
      runtime.transformControls.detach();
      refreshBoneMarkers(runtime, model, selectedBoneIndex);
      refreshPoseToolVisibility(runtime, poseEditing);
      return;
    }

    runtime.transformControls.setMode(boneInfo.controlMode);
    runtime.transformControls.setSpace(boneInfo.controlMode === "rotate" ? "local" : "world");
    runtime.transformControls.setTranslationSnap(null);
    runtime.transformControls.setRotationSnap(null);
    runtime.transformControls.attach(bone);
    refreshBoneMarkers(runtime, model, selectedBoneIndex);
    refreshPoseToolVisibility(runtime, true);
  }, [model, poseEditing, previewMode, selectedBoneIndex]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || !model || model.root.parent !== runtime.sourceContent) return;
    runtime.sourceContent.updateMatrixWorld(true);
    runtime.sourceBounds.setFromObject(runtime.sourceContent, false);
    refreshActiveScene(runtime, previewMode, showBounds, false);
    refreshBoneMarkers(runtime, model, selectedBoneIndex);
  }, [model, poseRevision, previewMode, selectedBoneIndex, showBounds]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const { hologramContent } = runtime;
    disposeGeneratedContent(hologramContent);
    runtime.hologramBounds.makeEmpty();

    if (!result) {
      refreshActiveScene(runtime, previewMode, showBounds, previewMode === "hologram");
      return;
    }

    if (result.kind === "solid") {
      const blockGeometry = new THREE.BoxGeometry(0.94, 0.94, 0.94);
      const counts = new Uint32Array(result.palette.length);
      result.blockIndices.forEach((paletteIndex) => {
        if (paletteIndex < counts.length) counts[paletteIndex] += 1;
      });
      const meshes = result.palette.map((entry, paletteIndex) => {
        const [red, green, blue] = entry.color;
        const material = new THREE.MeshStandardMaterial({
          color: new THREE.Color(red / 255, green / 255, blue / 255),
          roughness: 0.82,
          metalness: entry.blockId.includes("iron_block") ? 0.18 : 0,
        });
        tagProjectionMaterial(material, {
          role: "solid",
          lightLevel: previewLightLevel(entry.blockId),
        });
        const mesh = new THREE.InstancedMesh(blockGeometry, material, counts[paletteIndex]);
        mesh.name = entry.blockId;
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        return mesh;
      });
      const offsets = new Uint32Array(result.palette.length);
      const transform = new THREE.Matrix4();
      const position = new THREE.Vector3();
      const quaternion = new THREE.Quaternion();
      const scale = new THREE.Vector3(1, 1, 1);
      for (let index = 0; index < result.blockIndices.length; index += 1) {
        const paletteIndex = result.blockIndices[index];
        const mesh = meshes[paletteIndex];
        if (!mesh) continue;
        position.fromArray(result.positions, index * 3);
        transform.compose(position, quaternion, scale);
        mesh.setMatrixAt(offsets[paletteIndex], transform);
        offsets[paletteIndex] += 1;
      }
      meshes.forEach((mesh) => {
        mesh.instanceMatrix.needsUpdate = true;
        hologramContent.add(mesh);
      });
      updateProjectionMaterials(hologramContent, nightMode, glow);
      runtime.hologramBounds.set(
        new THREE.Vector3(...result.bounds.min),
        new THREE.Vector3(...result.bounds.max),
      );
      refreshActiveScene(runtime, previewMode, showBounds, previewMode === "hologram");
      return;
    }

    const endRodGeometry = new THREE.CylinderGeometry(0.13, 0.13, 0.94, 6, 1, false);
    const capGeometry = new THREE.CylinderGeometry(0.18, 0.18, 0.18, 8);
    const paneGeometry = new THREE.BoxGeometry(0.14, 0.98, 0.14);
    const glowRatio = THREE.MathUtils.clamp(glow / 100, 0, 1);
    const endRodColor = new THREE.Color("#b9d8d0").lerp(new THREE.Color("#f5fff9"), glowRatio);
    const capColor = new THREE.Color("#d8eee8").lerp(new THREE.Color("#ffffff"), glowRatio);
    const paneColor = new THREE.Color("#c9d8d5").lerp(new THREE.Color("#ffffff"), glowRatio);
    const endRodMaterial = new THREE.MeshBasicMaterial({
      color: endRodColor,
      fog: false,
      toneMapped: false,
    });
    const capMaterial = new THREE.MeshBasicMaterial({
      color: capColor,
      fog: false,
      toneMapped: false,
    });
    const paneMaterial = new THREE.MeshBasicMaterial({
      color: paneColor,
      transparent: true,
      opacity: 0.48 + glowRatio * 0.28,
      side: THREE.DoubleSide,
      depthWrite: true,
      fog: false,
      toneMapped: false,
    });
    tagProjectionMaterial(endRodMaterial, { role: "endRod", lightLevel: 14 });
    tagProjectionMaterial(capMaterial, { role: "endRodCap", lightLevel: 14 });
    tagProjectionMaterial(paneMaterial, { role: "pane" });

    const endRods = new THREE.InstancedMesh(endRodGeometry, endRodMaterial, result.stats.endRodCount);
    const caps = new THREE.InstancedMesh(capGeometry, capMaterial, result.stats.endRodCount);
    const panes = new THREE.InstancedMesh(paneGeometry, paneMaterial, result.stats.paneCount);
    const transform = new THREE.Matrix4();
    const capTransform = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3(1, 1, 1);
    const capOffset = new THREE.Vector3(0, 0.47, 0);
    let endRodIndex = 0;
    let paneIndex = 0;

    for (let index = 0; index < result.materials.length; index += 1) {
      position.fromArray(result.positions, index * 3);
      const quaternion = new THREE.Quaternion();
      transform.compose(position, quaternion, scale);

      if (result.materials[index] === 0) {
        endRods.setMatrixAt(endRodIndex, transform);
        const offset = capOffset.clone().applyQuaternion(quaternion).add(position);
        capTransform.compose(offset, quaternion, scale);
        caps.setMatrixAt(endRodIndex, capTransform);
        endRodIndex += 1;
      } else {
        transform.compose(position, new THREE.Quaternion(), scale);
        panes.setMatrixAt(paneIndex, transform);
        paneIndex += 1;
      }
    }

    endRods.instanceMatrix.needsUpdate = true;
    caps.instanceMatrix.needsUpdate = true;
    panes.instanceMatrix.needsUpdate = true;
    hologramContent.add(endRods, caps, panes);
    updateProjectionMaterials(hologramContent, nightMode, glow);
    runtime.hologramBounds.set(
      new THREE.Vector3(...result.bounds.min),
      new THREE.Vector3(...result.bounds.max),
    );
    refreshActiveScene(runtime, previewMode, showBounds, previewMode === "hologram");
  }, [result]);

  return (
    <div
      ref={mountRef}
      className={`viewport-canvas ${poseEditing ? "viewport-canvas--pose" : ""}`}
      aria-label={t(previewMode === "source" ? "viewport.aria.source" : "viewport.aria.projection")}
      aria-busy={modelLoading}
    />
  );
}
