import { isThreeMmdModel } from "../core/mmdRuntime";
import type { LoadedThreeMmdModel } from "../core/mmdModel";
import { Viewport3D } from "./Viewport3D";
import {
  defaultRendererViewportProps,
  type RendererViewportProps,
} from "./rendererViewportTypes";

/**
 * Three.js compatibility viewport. The stock MMDLoader runtime owns the model
 * and snapshot; this component only binds its scene to the shared preview UI.
 */
export function ThreeVanillaViewport(props: RendererViewportProps) {
  const { targetHeight: _targetHeight, ...defaults } = defaultRendererViewportProps(props);
  const model = props.model && isThreeMmdModel(props.model)
    ? props.model as LoadedThreeMmdModel
    : null;
  return <Viewport3D {...defaults} model={model} />;
}
