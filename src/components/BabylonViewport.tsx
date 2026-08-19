import { useEffect, useRef } from "react";
import {
  AbstractMesh,
  Color3,
  Matrix,
  MeshBuilder,
  Quaternion,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import type { BabylonMmdViewportSource, LoadedMmdModel } from "../core/mmdRuntime";
import {
  BABYLON_DEFAULT_CAMERA_ALPHA,
  BABYLON_DEFAULT_CAMERA_BETA,
  resetBabylonCameraView,
  syncBabylonCameraPanningSensibility,
  type BabylonResettableCamera,
} from "../core/babylonCameraControls";
import { babylonToThreePosition, reflectMmdQuaternionZ } from "../core/mmdCoordinates";
import { perspectiveFrameDistance, transformFrameBounds } from "../core/perspectiveFraming";
import {
  babylonMaterialPointerMovedPastThreshold,
  createBabylonVisibleMaterialTrianglePredicate,
  resolveBabylonMaterialPick,
  type BabylonMaterialPointerCandidate,
} from "../core/babylonMaterialSelection";
import {
  createBabylonSelectionOutline,
  type BabylonSelectionOutline,
} from "../core/babylonSelectionOutline";
import { useI18n } from "../i18n/I18nProvider";
import type { MmdMotionTimes, ProjectionResult } from "../types";
import {
  createProjectionPreviewSamplePlan,
  createSolidPreviewSource,
  type SolidPreviewPoint,
} from "./projectionPreviewLod";
import type { RendererViewportBinding, RendererViewportProps } from "./rendererViewportTypes";

interface BabylonEngineLike {
  runRenderLoop: (callback: () => void) => void;
  stopRenderLoop: (callback?: () => void) => void;
  resize: () => void;
  dispose: () => void;
  getRenderHeight?: () => number;
  getRenderWidth?: () => number;
}

interface BabylonSceneLike {
  render: () => void;
  dispose: () => void;
  activeCamera?: BabylonCameraLike | null;
}

interface BabylonCameraLike extends BabylonResettableCamera<Vector3> {
  fov: number;
  position?: { x: number; y: number; z: number };
  getViewMatrix?: () => unknown;
  target?: {
    x?: number;
    y?: number;
    z?: number;
    set?: (x: number, y: number, z: number) => void;
    copyFrom?: (value: Vector3) => void;
  };
  setTarget?: (target: unknown) => void;
}

interface BabylonSceneRuntime {
  scene: Scene;
  sourceRoot: AbstractMesh;
  generatedRoot: TransformNode;
  camera: BabylonCameraLike;
  baseScaling: Vector3;
  basePosition: Vector3;
  baseRotation: Quaternion | null;
  frameTarget: Vector3;
  frameRadius: number;
  frameSize: Vector3;
  frameAspect: number;
  framedPreviewMode: RendererViewportProps["previewMode"] | null;
  framedResult: ProjectionResult | null;
  modelId: string;
  selectionOutline: BabylonSelectionOutline;
}

interface BabylonCanvasViewportProps extends RendererViewportProps {
  /** Stop rendering while the projection (rather than the source model) is visible. */
  active?: boolean;
}

const isBabylonSource = (
  model: LoadedMmdModel | null,
): model is LoadedMmdModel & { viewport: BabylonMmdViewportSource } => (
  Boolean(model && model.viewport.kind === "babylon")
);

const asBabylonEngine = (value: unknown) => value as BabylonEngineLike;
const asBabylonScene = (value: unknown) => value as BabylonSceneLike;

const publishBabylonCameraProbe = (
  camera: BabylonCameraLike,
  sourceRoot: AbstractMesh,
) => {
  const probeWindow = window as Window & { __MELY_E2E_CAMERA_PROBE__?: boolean };
  if (!probeWindow.__MELY_E2E_CAMERA_PROBE__) return;
  probeWindow.dispatchEvent(new CustomEvent("mely:babylon-camera-state", {
    detail: {
      timestamp: performance.now(),
      alpha: camera.alpha ?? null,
      beta: camera.beta ?? null,
      radius: camera.radius,
      fovRadians: camera.fov,
      target: [
        camera.target?.x ?? null,
        camera.target?.y ?? null,
        camera.target?.z ?? null,
      ],
      panningSensibility: camera.panningSensibility,
      panningInertia: camera.panningInertia,
      angularSensibilityX: camera.angularSensibilityX,
      angularSensibilityY: camera.angularSensibilityY,
      inertia: camera.inertia,
      sourceTransform: {
        scaling: sourceRoot.scaling.asArray(),
        position: sourceRoot.position.asArray(),
        rotationQuaternion: sourceRoot.rotationQuaternion?.asArray() ?? null,
      },
    },
  }));
};

const disposeGeneratedProjection = (root: TransformNode) => {
  root.getChildMeshes().forEach((mesh) => {
    // Thin-instance buffers are discarded together with the mesh. Babylon's
    // public AbstractMesh type does not expose a clear-buffer helper.
    mesh.dispose(false, true);
  });
  root.getChildren().forEach((child) => child.dispose());
};

const createThinInstanceMesh = (
  scene: Scene,
  root: TransformNode,
  name: string,
  color: Color3,
  size: Vector3,
  sourcePositions: ArrayLike<number>,
  sourceIndices: readonly number[],
) => {
  if (!sourceIndices.length) return;
  const mesh = MeshBuilder.CreateBox(name, {
    width: size.x,
    height: size.y,
    depth: size.z,
  }, scene);
  mesh.parent = root;
  const material = new StandardMaterial(`${name}-material`, scene);
  material.diffuseColor = color;
  material.specularColor = Color3.Black();
  mesh.material = material;
  const matrices = new Float32Array(sourceIndices.length * 16);
  const matrix = Matrix.Identity();
  sourceIndices.forEach((sourceIndex, previewIndex) => {
    const offset = sourceIndex * 3;
    Matrix.TranslationToRef(
      sourcePositions[offset] ?? 0,
      sourcePositions[offset + 1] ?? 0,
      -(sourcePositions[offset + 2] ?? 0),
      matrix,
    );
    matrix.copyToArray(matrices, previewIndex * 16);
  });
  mesh.thinInstanceSetBuffer("matrix", matrices, 16, true);
};

const createSolidThinInstanceMesh = (
  scene: Scene,
  root: TransformNode,
  name: string,
  color: Color3,
  source: ReturnType<typeof createSolidPreviewSource>,
  sourceIndices: readonly number[],
) => {
  if (!sourceIndices.length) return;
  const mesh = MeshBuilder.CreateBox(name, { size: 0.94 }, scene);
  mesh.parent = root;
  const material = new StandardMaterial(`${name}-material`, scene);
  material.diffuseColor = color;
  material.specularColor = Color3.Black();
  mesh.material = material;
  const matrices = new Float32Array(sourceIndices.length * 16);
  const matrix = Matrix.Identity();
  const point: SolidPreviewPoint = { x: 0, y: 0, z: 0, paletteIndex: 0 };
  sourceIndices.forEach((sourceIndex, previewIndex) => {
    source.pointAt(sourceIndex, point);
    Matrix.TranslationToRef(point.x, point.y, -point.z, matrix);
    matrix.copyToArray(matrices, previewIndex * 16);
  });
  mesh.thinInstanceSetBuffer("matrix", matrices, 16, true);
};

const rebuildGeneratedProjection = (
  runtime: BabylonSceneRuntime,
  result: ProjectionResult | null,
) => {
  disposeGeneratedProjection(runtime.generatedRoot);
  if (!result) return;
  const scene = runtime.scene;
  if (result.kind === "solid") {
    const previewSource = createSolidPreviewSource(result);
    const previewPoint: SolidPreviewPoint = { x: 0, y: 0, z: 0, paletteIndex: 0 };
    const samplePlan = createProjectionPreviewSamplePlan(previewSource.pointCount);
    const grouped = new Map<number, number[]>();
    for (let sampleIndex = 0; sampleIndex < samplePlan.samplePointCount; sampleIndex += 1) {
      const sourceIndex = samplePlan.sourceIndexAt(sampleIndex);
      const paletteIndex = previewSource.pointAt(sourceIndex, previewPoint).paletteIndex;
      const values = grouped.get(paletteIndex) ?? [];
      values.push(sourceIndex);
      grouped.set(paletteIndex, values);
    }
    grouped.forEach((sourceIndices, paletteIndex) => {
      const entry = result.palette[paletteIndex];
      const color = entry
        ? Color3.FromInts(entry.color[0], entry.color[1], entry.color[2]).toLinearSpace(true)
        : new Color3(0.7, 0.7, 0.7);
      createSolidThinInstanceMesh(
        scene,
        runtime.generatedRoot,
        `mely-solid-${paletteIndex}`,
        color,
        previewSource,
        sourceIndices,
      );
    });
    return;
  }

  const sourcePointCount = Math.min(
    result.materials.length,
    Math.floor(result.positions.length / 3),
  );
  const samplePlan = createProjectionPreviewSamplePlan(sourcePointCount, 2);
  const grouped = new Map<number, number[]>();
  for (let sampleIndex = 0; sampleIndex < samplePlan.samplePointCount; sampleIndex += 1) {
    const sourceIndex = samplePlan.sourceIndexAt(sampleIndex);
    const materialIndex = result.materials[sourceIndex] ?? 0;
    const values = grouped.get(materialIndex) ?? [];
    values.push(sourceIndex);
    grouped.set(materialIndex, values);
  }
  grouped.forEach((sourceIndices, materialIndex) => {
    const isRod = materialIndex === 0;
    createThinInstanceMesh(
      scene,
      runtime.generatedRoot,
      `mely-hologram-${materialIndex}`,
      isRod ? new Color3(0.72, 0.92, 0.88) : new Color3(0.72, 0.86, 0.92),
      isRod ? new Vector3(0.18, 0.94, 0.18) : new Vector3(0.14, 0.98, 0.14),
      result.positions,
      sourceIndices,
    );
  });
};

/**
 * Babylon owns a separate WebGL context. The viewport appends the runtime's
 * canvas, starts its render loop, and stops/disposes the engine before the DOM
 * node is emptied. Model disposal remains idempotent and is handled by the
 * renderer transaction in the parent.
 */
export function BabylonViewport({ active = true, ...props }: BabylonCanvasViewportProps) {
  const { t } = useI18n();
  const viewportAriaLabel = t(
    props.previewMode === "hologram" ? "viewport.aria.projection" : "viewport.aria.source",
  );
  const mountRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef(props.model);
  const activeRef = useRef(active);
  const loopRef = useRef<{ engine: BabylonEngineLike; renderFrame: () => void } | null>(null);
  const sceneRuntimeRef = useRef<BabylonSceneRuntime | null>(null);
  const isPlayingRef = useRef(Boolean(props.isPlaying));
  const onBeforeRenderRef = useRef(props.onBeforeRender);
  const onAfterRenderRef = useRef(props.onAfterRender);
  const onReadyRef = useRef(props.onReady);
  const onUnmountRef = useRef(props.onUnmount);
  const backendBusyRef = useRef(Boolean(props.backendBusy));
  const modelLoadingRef = useRef(Boolean(props.modelLoading));
  const previewModeRef = useRef(props.previewMode ?? "source");
  const poseEditingRef = useRef(Boolean(props.poseEditing));
  const hiddenMaterialIndicesRef = useRef(props.hiddenMaterialIndices ?? []);
  const onMaterialSelectedRef = useRef(props.onMaterialSelected);
  const fallbackTimeRef = useRef(0);
  const previousNowRef = useRef<number | null>(null);

  modelRef.current = props.model;
  activeRef.current = active;
  isPlayingRef.current = Boolean(props.isPlaying);
  onBeforeRenderRef.current = props.onBeforeRender;
  onAfterRenderRef.current = props.onAfterRender;
  onReadyRef.current = props.onReady;
  onUnmountRef.current = props.onUnmount;
  backendBusyRef.current = Boolean(props.backendBusy);
  modelLoadingRef.current = Boolean(props.modelLoading);
  previewModeRef.current = props.previewMode ?? "source";
  poseEditingRef.current = Boolean(props.poseEditing);
  hiddenMaterialIndicesRef.current = props.hiddenMaterialIndices ?? [];
  onMaterialSelectedRef.current = props.onMaterialSelected;

  useEffect(() => {
    const model = props.model ?? null;
    if (!isBabylonSource(model)) return;
    const mount = mountRef.current;
    if (!mount) return;
    // Lifecycle acknowledgements belong to this mounted viewport instance;
    // capture them so an old cleanup cannot resolve a later transaction.
    const readyCallback = onReadyRef.current;
    const unmountCallback = onUnmountRef.current;
    const instanceBinding = props.lifecycleBinding;

    const viewport = model.viewport;
    const canvas = viewport.canvas;
    const engine = asBabylonEngine(viewport.engine);
    const scene = asBabylonScene(viewport.scene);
    if (!canvas || !engine || !scene) return;

    const sourceRoot = viewport.sourceRoot as AbstractMesh;
    const camera = viewport.camera as BabylonCameraLike;
    const babylonScene = scene as unknown as Scene;
    const generatedRoot = new TransformNode("mely-generated-projection", babylonScene);
    const selectionOutline = createBabylonSelectionOutline(babylonScene, viewport);
    const sourceTransform = {
      scaling: sourceRoot.scaling?.clone?.() ?? Vector3.One(),
      position: sourceRoot.position?.clone?.() ?? Vector3.Zero(),
      rotation: sourceRoot.rotationQuaternion?.clone?.() ?? null,
    };
    sceneRuntimeRef.current = {
      scene: babylonScene,
      sourceRoot,
      generatedRoot,
      camera,
      baseScaling: sourceTransform.scaling,
      basePosition: sourceTransform.position,
      baseRotation: sourceTransform.rotation,
      frameTarget: Vector3.Zero(),
      frameRadius: camera.radius,
      frameSize: Vector3.Zero(),
      frameAspect: 1,
      framedPreviewMode: null,
      framedResult: null,
      modelId: model.id,
      selectionOutline,
    };

    if (canvas.parentElement !== mount) mount.appendChild(canvas);
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.setAttribute("aria-label", viewportAriaLabel);
    const preventContextMenu = (event: MouseEvent) => event.preventDefault();
    canvas.addEventListener("contextmenu", preventContextMenu);
    let materialPointerCandidate: BabylonMaterialPointerCandidate | null = null;
    const materialSelectionEnabled = () => (
      activeRef.current
      && previewModeRef.current === "source"
      && !backendBusyRef.current
      && !modelLoadingRef.current
      && !poseEditingRef.current
    );
    const selectMaterialAtPointer = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const hiddenMaterialIndices = new Set(hiddenMaterialIndicesRef.current);
      const picks = viewport.sourceMeshes.flatMap((sourceMesh) => (
        babylonScene.multiPick(
          event.clientX - rect.left,
          event.clientY - rect.top,
          (mesh) => mesh === sourceMesh,
          babylonScene.activeCamera ?? undefined,
          createBabylonVisibleMaterialTrianglePredicate(
            sourceMesh as never,
            viewport,
            model.materials.length,
            hiddenMaterialIndices,
          ) ?? undefined,
        ) ?? []
      ));
      const materialIndex = resolveBabylonMaterialPick(
        picks,
        viewport,
        model.materials.length,
        hiddenMaterialIndices,
      );
      onMaterialSelectedRef.current?.(materialIndex === null
        ? null
        : { modelId: model.id, materialIndex });
    };
    const onMaterialPointerDown = (event: PointerEvent) => {
      if (!event.isPrimary || event.button !== 0 || !materialSelectionEnabled()) {
        materialPointerCandidate = null;
        return;
      }
      materialPointerCandidate = {
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
        dragged: false,
      };
    };
    const onMaterialPointerMove = (event: PointerEvent) => {
      const candidate = materialPointerCandidate;
      if (!candidate || candidate.pointerId !== event.pointerId || candidate.dragged) return;
      candidate.dragged = babylonMaterialPointerMovedPastThreshold(candidate, event);
    };
    const onMaterialPointerUp = (event: PointerEvent) => {
      const candidate = materialPointerCandidate;
      materialPointerCandidate = null;
      if (
        !candidate
        || candidate.pointerId !== event.pointerId
        || candidate.dragged
        || babylonMaterialPointerMovedPastThreshold(candidate, event)
        || event.button !== 0
        || !materialSelectionEnabled()
      ) return;
      window.setTimeout(() => {
        if (!materialSelectionEnabled() || modelRef.current?.id !== model.id) return;
        selectMaterialAtPointer(event);
      }, 0);
    };
    const cancelMaterialPointer = (event: PointerEvent) => {
      if (materialPointerCandidate?.pointerId === event.pointerId) materialPointerCandidate = null;
    };
    canvas.addEventListener("pointerdown", onMaterialPointerDown);
    canvas.addEventListener("pointermove", onMaterialPointerMove);
    canvas.addEventListener("pointerup", onMaterialPointerUp);
    canvas.addEventListener("pointercancel", cancelMaterialPointer);
    canvas.addEventListener("lostpointercapture", cancelMaterialPointer);
    const probeWindow = window as Window & { __MELY_E2E_VIEW_PROBE__?: boolean };
    const applyE2eView = (event: Event) => {
      if (!probeWindow.__MELY_E2E_VIEW_PROBE__) return;
      const view = (event as CustomEvent<{ view?: "front" | "oblique" }>).detail?.view;
      if (view !== "front" && view !== "oblique") return;
      const current = sceneRuntimeRef.current;
      if (!current || current.modelId !== model.id) return;
      resetBabylonCameraView(current.camera, current.frameTarget, current.frameRadius);
      current.camera.alpha = view === "front" ? BABYLON_DEFAULT_CAMERA_ALPHA : -Math.PI / 4;
      current.camera.beta = BABYLON_DEFAULT_CAMERA_BETA;
      current.camera.getViewMatrix?.();
      const renderWidth = engine.getRenderWidth?.() ?? canvas.width;
      const renderHeight = engine.getRenderHeight?.() ?? canvas.height;
      window.dispatchEvent(new CustomEvent("mely:e2e-view-applied", {
        detail: {
          backend: "babylon",
          view,
          alpha: current.camera.alpha,
          beta: current.camera.beta,
          radius: current.camera.radius,
          distance: current.camera.radius,
          target: current.frameTarget.asArray(),
          eye: [
            current.camera.position?.x ?? null,
            current.camera.position?.y ?? null,
            current.camera.position?.z ?? null,
          ],
          fovRadians: current.camera.fov,
          aspect: current.frameAspect,
          actualAspect: renderWidth / Math.max(1, renderHeight),
          frameSize: current.frameSize.asArray(),
        },
      }));
    };
    if (probeWindow.__MELY_E2E_VIEW_PROBE__) {
      window.addEventListener("mely:e2e-set-view", applyE2eView);
    }

    let disposed = false;
    let readyNotified = false;
    const renderFrame = () => {
      if (disposed || !activeRef.current) return;
      const now = performance.now();
      const previous = previousNowRef.current;
      previousNowRef.current = now;
      const delta = previous === null ? 0 : Math.max(0, Math.min(0.1, (now - previous) / 1000));
      let evaluated: MmdMotionTimes | null = onBeforeRenderRef.current?.(now) ?? null;
      if (!onBeforeRenderRef.current && modelRef.current && isPlayingRef.current) {
        fallbackTimeRef.current += delta;
        const seconds = fallbackTimeRef.current;
        evaluated = { dance: seconds, expression: seconds };
        modelRef.current.updatePreviewPose(evaluated);
      }
      syncBabylonCameraPanningSensibility(camera);
      sceneRuntimeRef.current?.selectionOutline.sync();
      scene.render();
      publishBabylonCameraProbe(camera, sourceRoot);
      const gpuSynchronized = Boolean((window as Window & {
        __MELY_E2E_GPU_PROBE__?: boolean;
      }).__MELY_E2E_GPU_PROBE__);
      if (gpuSynchronized) {
        const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
        gl?.finish();
      }
      if (!readyNotified) {
        readyNotified = true;
        try {
          readyCallback?.(instanceBinding);
        } catch {
          // A host readiness callback must not stop Babylon's render loop.
        }
      }
      onAfterRenderRef.current?.(performance.now(), evaluated, gpuSynchronized);
    };

    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
        engine.resize();
        const current = sceneRuntimeRef.current;
        if (!current || current.modelId !== model.id) return;
        const width = mount.clientWidth;
        const aspect = width / Math.max(1, mount.clientHeight);
        if (!Number.isFinite(aspect) || aspect <= 0 || Math.abs(aspect - current.frameAspect) < 1e-6) {
          return;
        }
        current.frameAspect = aspect;
        current.frameRadius = perspectiveFrameDistance({
          width: current.frameSize.x,
          height: current.frameSize.y,
          depth: current.frameSize.z,
        }, aspect, current.camera.fov);
        current.camera.radius = current.frameRadius;
        syncBabylonCameraPanningSensibility(current.camera);
      });
    resizeObserver?.observe(mount);
    engine.resize();
    loopRef.current = { engine, renderFrame };
    if (activeRef.current) engine.runRenderLoop(renderFrame);

    return () => {
      disposed = true;
      const attempt = (cleanup: () => void) => {
        try {
          cleanup();
        } catch {
          // Cleanup is best effort; all remaining releases must still run.
        }
      };
      try {
        attempt(() => { previousNowRef.current = null; });
        attempt(() => engine.stopRenderLoop(renderFrame));
        attempt(() => {
          if (loopRef.current?.engine === engine) loopRef.current = null;
        });
        attempt(() => resizeObserver?.disconnect());
        attempt(() => canvas.removeEventListener("contextmenu", preventContextMenu));
        attempt(() => canvas.removeEventListener("pointerdown", onMaterialPointerDown));
        attempt(() => canvas.removeEventListener("pointermove", onMaterialPointerMove));
        attempt(() => canvas.removeEventListener("pointerup", onMaterialPointerUp));
        attempt(() => canvas.removeEventListener("pointercancel", cancelMaterialPointer));
        attempt(() => canvas.removeEventListener("lostpointercapture", cancelMaterialPointer));
        attempt(() => window.removeEventListener("mely:e2e-set-view", applyE2eView));
        attempt(() => {
          if (sceneRuntimeRef.current?.modelId === model.id) {
            sceneRuntimeRef.current.selectionOutline.dispose();
            disposeGeneratedProjection(sceneRuntimeRef.current.generatedRoot);
            sceneRuntimeRef.current.generatedRoot.dispose();
            sceneRuntimeRef.current = null;
          }
        });
        // The model owns the Babylon runtime, Scene and Engine. The viewport
        // only stops its loop and detaches the canvas; this keeps disposal
        // ordering single-owner during renderer transitions.
        attempt(() => {
          if (canvas.parentElement === mount) mount.removeChild(canvas);
        });
        // Do not let a delayed old cleanup clear a replacement renderer's
        // canvas from the shared mount node.
        attempt(() => {
          if (mount.childElementCount === 0) mount.replaceChildren();
        });
      } finally {
        try {
          unmountCallback?.(instanceBinding);
        } catch {
          // Acknowledgement errors must not escape React's cleanup phase.
        }
      }
    };
  }, [props.model]);

  useEffect(() => {
    const model = props.model ?? null;
    const runtime = sceneRuntimeRef.current;
    if (!runtime || !model || runtime.modelId !== model.id) return;
    const source = runtime.sourceRoot;
    // Keep the source root in the loader's native coordinate system. Scaling
    // or translating this node would also change the world matrix consumed by
    // babylon-mmd physics and would leak preview framing into snapshots.
    source.scaling.copyFrom(runtime.baseScaling);
    source.position.copyFrom(runtime.basePosition);
    if (runtime.baseRotation) source.rotationQuaternion = runtime.baseRotation.clone();
    const bounds = model.visibleBounds();
    source.computeWorldMatrix(true);

    const camera = runtime.camera;
    const isHologram = props.previewMode === "hologram";
    const projectionBounds = isHologram ? props.result?.bounds : null;
    const transformedSourceBounds = transformFrameBounds({
      min: [bounds.min.x, bounds.min.y, bounds.min.z],
      max: [bounds.max.x, bounds.max.y, bounds.max.z],
    }, {
      scale: runtime.baseScaling.asArray(),
      position: babylonToThreePosition([
        runtime.basePosition.x,
        runtime.basePosition.y,
        runtime.basePosition.z,
      ]),
      rotationQuaternion: runtime.baseRotation
        ? reflectMmdQuaternionZ([
          runtime.baseRotation.x,
          runtime.baseRotation.y,
          runtime.baseRotation.z,
          runtime.baseRotation.w,
        ])
        : null,
    });
    const size = projectionBounds
      ? new Vector3(
        Math.max(0, projectionBounds.max[0] - projectionBounds.min[0]),
        Math.max(0, projectionBounds.max[1] - projectionBounds.min[1]),
        Math.max(0, projectionBounds.max[2] - projectionBounds.min[2]),
      )
      : new Vector3(
        transformedSourceBounds.max[0] - transformedSourceBounds.min[0],
        transformedSourceBounds.max[1] - transformedSourceBounds.min[1],
        transformedSourceBounds.max[2] - transformedSourceBounds.min[2],
      );
    const center = projectionBounds
      ? new Vector3(
        (projectionBounds.min[0] + projectionBounds.max[0]) / 2,
        (projectionBounds.min[1] + projectionBounds.max[1]) / 2,
        -(projectionBounds.min[2] + projectionBounds.max[2]) / 2,
      )
      : new Vector3(
        (transformedSourceBounds.min[0] + transformedSourceBounds.max[0]) / 2,
        (transformedSourceBounds.min[1] + transformedSourceBounds.max[1]) / 2,
        -(transformedSourceBounds.min[2] + transformedSourceBounds.max[2]) / 2,
      );
    const aspect = mountRef.current?.clientWidth
      ? mountRef.current.clientWidth / Math.max(1, mountRef.current.clientHeight)
      : 1;
    const shouldFrame = runtime.framedPreviewMode === null
      || runtime.framedPreviewMode !== props.previewMode
      || (
        props.previewMode === "hologram"
        && runtime.framedResult !== (props.result ?? null)
      );
    runtime.frameTarget.copyFrom(center);
    runtime.frameSize.copyFrom(size);
    runtime.frameAspect = aspect;
    runtime.frameRadius = perspectiveFrameDistance({
      width: size.x,
      height: size.y,
      depth: size.z,
    }, aspect, camera.fov);
    runtime.framedPreviewMode = props.previewMode;
    runtime.framedResult = props.result ?? null;
    if (shouldFrame) {
      camera.target?.copyFrom?.(center);
      camera.radius = runtime.frameRadius;
      syncBabylonCameraPanningSensibility(camera);
    }
    runtime.generatedRoot.setEnabled(props.previewMode === "hologram");
    source.setEnabled(props.previewMode !== "hologram");
    rebuildGeneratedProjection(runtime, props.result ?? null);
  }, [props.model, props.partsRevision, props.previewMode, props.result]);

  useEffect(() => {
    const model = props.model ?? null;
    if (!isBabylonSource(model)) return;
    model.viewport.canvas.setAttribute("aria-label", viewportAriaLabel);
  }, [props.model, viewportAriaLabel]);

  useEffect(() => {
    const runtime = sceneRuntimeRef.current;
    if (!runtime) return;
    resetBabylonCameraView(runtime.camera, runtime.frameTarget, runtime.frameRadius);
  }, [props.resetToken]);

  useEffect(() => {
    const runtime = sceneRuntimeRef.current;
    const model = props.model;
    if (!runtime || !model || runtime.modelId !== model.id) return;
    const selectedMaterialIndex = props.selectedMaterialIndex ?? null;
    const hidden = selectedMaterialIndex !== null
      && (props.hiddenMaterialIndices ?? []).includes(selectedMaterialIndex);
    runtime.selectionOutline.setSelection(
      selectedMaterialIndex,
      active && props.previewMode !== "hologram" && !hidden,
    );
  }, [
    active,
    props.hiddenMaterialIndices,
    props.model,
    props.previewMode,
    props.selectedMaterialIndex,
  ]);

  useEffect(() => {
    activeRef.current = active;
    const loop = loopRef.current;
    if (!loop) return;
    loop.engine.stopRenderLoop(loop.renderFrame);
    if (active) loop.engine.runRenderLoop(loop.renderFrame);
  }, [active]);

  useEffect(() => {
    if (props.isPlaying) return;
    previousNowRef.current = null;
  }, [props.isPlaying]);

  return (
    <div
      ref={mountRef}
      className="viewport-canvas viewport-canvas--babylon"
      aria-busy={props.modelLoading ?? false}
    />
  );
}
