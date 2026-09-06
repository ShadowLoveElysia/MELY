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
    // Keep Vanilla on the parser/geometry/runtime path that owns the same
    // Yohawing model representation end to end. The legacy stock
    // three-stdlib adapter used a separate metadata parser and could silently
    // lose PMX skinning and morph semantics between those stages.
    const { loadMmdModel } = await import("./mmdModel");
    return loadMmdModel(files, modelFile);
  }
  if (mode === "moeru") {
    const { loadThreeMoeruMmdModel } = await import("./threeMoeruMmdDriver");
    return loadThreeMoeruMmdModel(files, modelFile);
  }
  const { loadBabylonMmdModel } = await import("./babylonMmdRuntime");
  return loadBabylonMmdModel(files, modelFile);
};
