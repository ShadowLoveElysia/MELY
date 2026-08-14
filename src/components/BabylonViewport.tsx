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
import type { MmdMotionTimes, ProjectionResult } from "../types";
import { Vector3 as ThreeVector3 } from "three";
import type { RendererViewportBinding, RendererViewportProps } from "./rendererViewportTypes";

interface BabylonEngineLike {
  runRenderLoop: (callback: () => void) => void;
  stopRenderLoop: (callback?: () => void) => void;
  resize: () => void;
  dispose: () => void;
}

interface BabylonSceneLike {
  render: () => void;
  dispose: () => void;
  activeCamera?: BabylonCameraLike | null;
}

interface BabylonCameraLike {
  alpha?: number;
  beta?: number;
  radius?: number;
  target?: {
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
  modelId: string;
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
  positions: readonly Vector3[],
) => {
  if (!positions.length) return;
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
  const matrices = new Float32Array(positions.length * 16);
  const matrix = Matrix.Identity();
  positions.forEach((position, index) => {
    Matrix.TranslationToRef(position.x, position.y, position.z, matrix);
    matrix.copyToArray(matrices, index * 16);
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
    const grouped = new Map<number, Vector3[]>();
    result.blockIndices.forEach((paletteIndex, index) => {
      const position = new Vector3(
        result.positions[index * 3] ?? 0,
        result.positions[index * 3 + 1] ?? 0,
        -(result.positions[index * 3 + 2] ?? 0),
      );
      const values = grouped.get(paletteIndex) ?? [];
      values.push(position);
      grouped.set(paletteIndex, values);
    });
    grouped.forEach((positions, paletteIndex) => {
      const entry = result.palette[paletteIndex];
      const color = entry
        ? Color3.FromInts(entry.color[0], entry.color[1], entry.color[2]).toLinearSpace(true)
        : new Color3(0.7, 0.7, 0.7);
      createThinInstanceMesh(scene, runtime.generatedRoot, `mely-solid-${paletteIndex}`, color, new Vector3(0.94, 0.94, 0.94), positions);
    });
    return;
  }

  const grouped = new Map<number, Vector3[]>();
  result.positions.forEach((_value, index) => {
    if (index % 3 !== 0) return;
    const pointIndex = index / 3;
    const materialIndex = result.materials[pointIndex] ?? 0;
    const values = grouped.get(materialIndex) ?? [];
    values.push(new Vector3(
      result.positions[index] ?? 0,
      result.positions[index + 1] ?? 0,
      -(result.positions[index + 2] ?? 0),
    ));
    grouped.set(materialIndex, values);
  });
  grouped.forEach((positions, materialIndex) => {
    const isRod = materialIndex === 0;
    createThinInstanceMesh(
      scene,
      runtime.generatedRoot,
      `mely-hologram-${materialIndex}`,
      isRod ? new Color3(0.72, 0.92, 0.88) : new Color3(0.72, 0.86, 0.92),
      isRod ? new Vector3(0.18, 0.94, 0.18) : new Vector3(0.14, 0.98, 0.14),
      positions,
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
  const fallbackTimeRef = useRef(0);
  const previousNowRef = useRef<number | null>(null);

  modelRef.current = props.model;
  activeRef.current = active;
  isPlayingRef.current = Boolean(props.isPlaying);
  onBeforeRenderRef.current = props.onBeforeRender;
  onAfterRenderRef.current = props.onAfterRender;
  onReadyRef.current = props.onReady;
  onUnmountRef.current = props.onUnmount;

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
      modelId: model.id,
    };

    if (canvas.parentElement !== mount) mount.appendChild(canvas);
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.setAttribute("aria-label", "Babylon.js MMD viewport");

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
      scene.render();
      const gpuSynchronized = Boolean((window as Window & {
        __MELY_E2E_GPU_PROBE__?: boolean;
      }).__MELY_E2E_GPU_PROBE__);
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
      : new ResizeObserver(() => engine.resize());
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
        attempt(() => {
          if (sceneRuntimeRef.current?.modelId === model.id) {
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
    const model = props.model;
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
    const size = bounds.getSize(new ThreeVector3());
    const centerBounds = bounds.getCenter(new ThreeVector3());
    source.computeWorldMatrix(true);

    const camera = runtime.camera as BabylonCameraLike & { target?: Vector3; radius?: number };
    const isHologram = props.previewMode === "hologram";
    // Projection coordinates are already normalized to targetHeight. Source
    // coordinates stay native, so frame each mode without changing the model
    // transform seen by the runtime.
    const center = isHologram
      ? new Vector3(0, Math.max(0, (props.targetHeight ?? 96) * 0.45), 0)
      : new Vector3(centerBounds.x, centerBounds.y, -centerBounds.z);
    const frameHeight = isHologram
      ? Math.max(1, props.targetHeight ?? 96)
      : Math.max(1, size.y);
    camera.target?.copyFrom?.(center);
    camera.radius = Math.max(3, frameHeight * 1.45);
    runtime.generatedRoot.setEnabled(props.previewMode === "hologram");
    source.setEnabled(props.previewMode !== "hologram");
    rebuildGeneratedProjection(runtime, props.result ?? null);
  }, [props.model, props.previewMode, props.result, props.targetHeight, props.glow]);

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

  return <div ref={mountRef} className="viewport-canvas viewport-canvas--babylon" aria-busy={props.modelLoading ?? false} />;
}
