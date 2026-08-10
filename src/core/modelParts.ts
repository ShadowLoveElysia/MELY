import type { MmdMaterialInfo } from "../types";

export const orderModelParts = (
  materials: readonly MmdMaterialInfo[],
  hiddenMaterialIndices: ReadonlySet<number>,
) => [...materials].sort((left, right) => {
  const visibilityOrder = Number(hiddenMaterialIndices.has(right.index))
    - Number(hiddenMaterialIndices.has(left.index));
  return visibilityOrder || left.index - right.index;
});
