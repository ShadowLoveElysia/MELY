import type { LoadedMmdModel, MmdRendererMode } from "./mmdRuntime";

/**
 * Creates exactly one renderer runtime. Callers must await disposal of the
 * previous model before invoking this factory so WebGL contexts never overlap.
 */
export const loadMmdModelForRenderer = async (
  mode: MmdRendererMode,
  files: readonly File[],
  modelFile: File,
): Promise<LoadedMmdModel> => {
  if (mode === "vanilla") {
    const { loadThreeVanillaMmdModel } = await import("./threeVanillaMmdDriver");
    return loadThreeVanillaMmdModel(files, modelFile);
  }
  if (mode === "moeru") {
    const { loadThreeMoeruMmdModel } = await import("./threeMoeruMmdDriver");
    return loadThreeMoeruMmdModel(files, modelFile);
  }
  const { loadBabylonMmdModel } = await import("./babylonMmdRuntime");
  return loadBabylonMmdModel(files, modelFile);
};
