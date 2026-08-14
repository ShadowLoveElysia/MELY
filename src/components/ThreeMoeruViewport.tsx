import { isThreeMmdModel } from "../core/mmdRuntime";
import type { LoadedThreeMmdModel } from "../core/mmdModel";
import { Viewport3D } from "./Viewport3D";
import {
  defaultRendererViewportProps,
  type RendererViewportProps,
} from "./rendererViewportTypes";

/**
 * Moeru's modern Three.js viewport. It deliberately shares the interaction
 * shell with the vanilla backend, while the active model supplies Moeru's
 * toon, IK, physics and CPU snapshot behavior.
 */
export function ThreeMoeruViewport(props: RendererViewportProps) {
  const { targetHeight: _targetHeight, ...defaults } = defaultRendererViewportProps(props);
  const model = props.model && isThreeMmdModel(props.model)
    ? props.model as LoadedThreeMmdModel
    : null;
  return <Viewport3D {...defaults} model={model} />;
}
