import { BabylonViewport } from "./BabylonViewport";
import { ThreeMoeruViewport } from "./ThreeMoeruViewport";
import { ThreeVanillaViewport } from "./ThreeVanillaViewport";
import type { RendererViewportProps } from "./rendererViewportTypes";

/**
 * Selects exactly one active backend. Babylon uses its own canvas for source
 * rendering. Generated projection geometry is also built inside the Babylon
 * scene, so no hidden Three model is used as a compatibility calculator.
 */
export function RendererViewport(props: RendererViewportProps) {
  const mode = props.renderMode ?? props.model?.rendererMode ?? "vanilla";
  if (mode === "babylon") {
    return <BabylonViewport {...props} />;
  }
  if (mode === "moeru") return <ThreeMoeruViewport {...props} />;
  return <ThreeVanillaViewport {...props} />;
}

export type { RendererViewportProps } from "./rendererViewportTypes";
export { BabylonViewport } from "./BabylonViewport";
export { ThreeMoeruViewport } from "./ThreeMoeruViewport";
export { ThreeVanillaViewport } from "./ThreeVanillaViewport";
