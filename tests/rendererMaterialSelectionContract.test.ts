import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  defaultRendererViewportProps,
  type RendererMaterialSelection,
  type RendererViewportProps,
} from "../src/components/rendererViewportTypes";

test("renderer material selection props have safe standalone defaults", () => {
  const defaults = defaultRendererViewportProps({});

  assert.equal(defaults.selectedMaterialIndex, null);
  assert.deepEqual(defaults.hiddenMaterialIndices, []);
  assert.equal(defaults.materialSelectionRequestId, 0);
  assert.doesNotThrow(() => defaults.onMaterialSelected(null));
});

test("renderer material selection preserves canonical identity and supplied props", () => {
  const hiddenMaterialIndices = [1, 4] as const;
  const selections: Array<RendererMaterialSelection | null> = [];
  const props: RendererViewportProps = {
    selectedMaterialIndex: 4,
    hiddenMaterialIndices,
    materialSelectionRequestId: 7,
    onMaterialSelected: (selection) => selections.push(selection),
  };
  const defaults = defaultRendererViewportProps(props);
  const selection: RendererMaterialSelection = {
    modelId: "model-current",
    materialIndex: 4,
  };

  assert.equal(defaults.selectedMaterialIndex, 4);
  assert.equal(defaults.hiddenMaterialIndices, hiddenMaterialIndices);
  assert.equal(defaults.materialSelectionRequestId, 7);
  defaults.onMaterialSelected(selection);
  assert.deepEqual(selections, [selection]);
});

test("renderer dispatch and both Three wrappers forward the shared selection contract", () => {
  const renderer = readFileSync("src/components/RendererViewport.tsx", "utf8");
  const vanilla = readFileSync("src/components/ThreeVanillaViewport.tsx", "utf8");
  const moeru = readFileSync("src/components/ThreeMoeruViewport.tsx", "utf8");

  assert.match(renderer, /RendererMaterialSelection/);
  assert.match(renderer, /<BabylonViewport \{\.\.\.props\} \/>/);
  assert.match(renderer, /<ThreeMoeruViewport \{\.\.\.props\} \/>/);
  assert.match(renderer, /<ThreeVanillaViewport \{\.\.\.props\} \/>/);

  for (const wrapper of [vanilla, moeru]) {
    assert.match(wrapper, /defaultRendererViewportProps\(props\)/);
    assert.match(wrapper, /<Viewport3D \{\.\.\.defaults\} model=\{model\} \/>/);
  }
});

test("Babylon viewport source exposes an engine-neutral canonical material resolver", () => {
  const runtimeContract = readFileSync("src/core/mmdRuntime.ts", "utf8");

  assert.match(
    runtimeContract,
    /resolveMaterialIndex: \(mesh: unknown, subMeshId: number\) => number \| null;/,
  );
});
