import * as THREE from "three";
import { FallbackCore } from "@yohawing/three-mmd-loader/parser";
import { OutlineEffect } from "three/examples/jsm/effects/OutlineEffect.js";
import {
  choosePrimaryMmdModel,
  expandMmdAssets,
  inspectMmdModels,
} from "../../src/core/mmdAssets";
import { loadThreeVanillaMmdModel } from "../../src/core/threeVanillaMmdDriver";
import { createThreeMmdOutlinePass } from "../../src/core/threeMmdOutline";
import { calibrateVanillaMmdMaterials } from "../../src/core/threeVanillaMmdMaterials";
import { attachMmdSdefSkinning } from "@yohawing/three-mmd-loader";

declare global {
  interface Window {
    __melyGpuProbeReady?: boolean;
    __melyRunGpuProbes?: () => Promise<unknown>;
  }
}

type SphereMode = "multiply" | "add";

interface ShaderSnapshot {
  fragmentShader: string;
  uniforms: Record<string, THREE.IUniform>;
  vertexShader: string;
}

const SIZE = 192;
const BACKGROUND = new THREE.Color(0x000000);
const CENTER = Math.floor(SIZE / 2);
const SAMPLE_RADIUS = 44;

const createRenderer = () => {
  const canvas = document.createElement("canvas");
  const renderer = new THREE.WebGLRenderer({
    alpha: false,
    antialias: false,
    canvas,
    powerPreference: "high-performance",
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(SIZE, SIZE, false);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = false;
  renderer.debug.checkShaderErrors = true;
  return renderer;
};

const camera = () => {
  const value = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 20);
  value.position.set(0, 0, 5);
  value.lookAt(0, 0, 0);
  value.updateMatrixWorld(true);
  return value;
};

const dataTexture = (red: number, green: number, blue: number) => {
  const texture = new THREE.DataTexture(
    new Uint8Array([red, green, blue, 255]),
    1,
    1,
    THREE.RGBAFormat,
  );
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  return texture;
};

const readPixels = (renderer: THREE.WebGLRenderer) => {
  const gl = renderer.getContext();
  const pixels = new Uint8Array(SIZE * SIZE * 4);
  gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  const error = gl.getError();
  if (error !== gl.NO_ERROR) throw new Error(`gl.readPixels failed with 0x${error.toString(16)}`);
  return pixels;
};

const pixelAt = (pixels: Uint8Array, x: number, y: number) => {
  const offset = (y * SIZE + x) * 4;
  return [pixels[offset], pixels[offset + 1], pixels[offset + 2], pixels[offset + 3]] as const;
};

const foregroundBounds = (pixels: Uint8Array, predicate: (pixel: readonly number[]) => boolean) => {
  let minimumX = SIZE;
  let minimumY = SIZE;
  let maximumX = -1;
  let maximumY = -1;
  let count = 0;
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const pixel = pixelAt(pixels, x, y);
      if (!predicate(pixel)) continue;
      minimumX = Math.min(minimumX, x);
      minimumY = Math.min(minimumY, y);
      maximumX = Math.max(maximumX, x);
      maximumY = Math.max(maximumY, y);
      count += 1;
    }
  }
  return { count, maximumX, maximumY, minimumX, minimumY };
};

const boundsCenterDistance = (
  before: ReturnType<typeof foregroundBounds>,
  after: ReturnType<typeof foregroundBounds>,
) => {
  if (before.count === 0 || after.count === 0) return 0;
  return Math.hypot(
    (after.minimumX + after.maximumX - before.minimumX - before.maximumX) * 0.5,
    (after.minimumY + after.maximumY - before.minimumY - before.maximumY) * 0.5,
  );
};

const programEvidence = (renderer: THREE.WebGLRenderer) => {
  const gl = renderer.getContext();
  const programs = renderer.info.programs ?? [];
  programs.forEach((entry) => gl.validateProgram(entry.program));
  return {
    count: programs.length,
    allRunnable: programs.length > 0 && programs.every((entry) => {
      const program = entry.program;
      return gl.getProgramParameter(program, gl.LINK_STATUS) === true
        && gl.getProgramParameter(program, gl.VALIDATE_STATUS) === true;
    }),
    diagnostics: programs.map((entry) => ({
      cacheKey: entry.cacheKey,
      linked: gl.getProgramParameter(entry.program, gl.LINK_STATUS) === true,
      validated: gl.getProgramParameter(entry.program, gl.VALIDATE_STATUS) === true,
    })),
  };
};

const renderSphereFixture = (mode: SphereMode) => {
  const renderer = createRenderer();
  const scene = new THREE.Scene();
  scene.background = BACKGROUND;
  const sourceColor = [0.24, 0.32, 0.40] as const;
  const sphereColor = [0.50, 0.25, 0.75] as const;
  const material = new THREE.MeshToonMaterial({
    color: new THREE.Color(...sourceColor),
    emissive: new THREE.Color(0, 0, 0),
  });
  const sphereTexture = dataTexture(
    Math.round(sphereColor[0] * 255),
    Math.round(sphereColor[1] * 255),
    Math.round(sphereColor[2] * 255),
  );
  let shader: ShaderSnapshot | null = null;
  calibrateVanillaMmdMaterials(
    new THREE.SkinnedMesh(new THREE.BufferGeometry(), material),
    [{ ambient: [0, 0, 0], diffuse: sourceColor, sphereMode: mode, sphereTexturePath: "fixture.sph" }],
    { resolveSphereTexture: () => sphereTexture },
  );
  const previous = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (value, activeRenderer) => {
    previous(value, activeRenderer);
    shader = value as ShaderSnapshot;
  };
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.4), material);
  scene.add(mesh);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x000000, Math.PI));
  renderer.compile(scene, camera());
  renderer.render(scene, camera());
  const pixels = readPixels(renderer);
  const actual = pixelAt(pixels, CENTER, CENTER).slice(0, 3);
  const originalUniformBound = shader?.uniforms.melyMmdSphereMap?.value === sphereTexture;
  const sphereSlot = material as THREE.MeshToonMaterial & { melyMmdSphereMap?: THREE.Texture | null };
  const whiteTexture = dataTexture(255, 255, 255);
  const blackTexture = dataTexture(0, 0, 0);
  sphereSlot.melyMmdSphereMap = whiteTexture;
  if (shader) shader.uniforms.melyMmdSphereMap.value = whiteTexture;
  renderer.render(scene, camera());
  const whiteSphere = pixelAt(readPixels(renderer), CENTER, CENTER).slice(0, 3);
  sphereSlot.melyMmdSphereMap = blackTexture;
  if (shader) shader.uniforms.melyMmdSphereMap.value = blackTexture;
  renderer.render(scene, camera());
  const blackSphere = pixelAt(readPixels(renderer), CENTER, CENTER).slice(0, 3);
  const expected = actual.map((_value, index) => (
    mode === "multiply"
      ? Math.round(blackSphere[index] + (whiteSphere[index] - blackSphere[index]) * sphereColor[index])
      : Math.round(blackSphere[index] + (whiteSphere[index] - blackSphere[index]) * sphereColor[index])
  ));
  const maximumError = Math.max(...actual.map((value, index) => Math.abs(value - expected[index])));
  const evidence = {
    actual,
    blackSphere,
    expected,
    maximumError,
    mode,
    program: programEvidence(renderer),
    shaderHasLightWeightedSphere: Boolean(
      shader?.fragmentShader.includes("reflectedLight.directDiffuse")
      && shader.fragmentShader.includes("reflectedLight.indirectDiffuse"),
    ),
    uniformBound: originalUniformBound,
    whiteSphere,
  };
  mesh.geometry.dispose();
  material.dispose();
  whiteTexture.dispose();
  blackTexture.dispose();
  sphereTexture.dispose();
  renderer.dispose();
  return evidence;
};

interface RigOptions {
  sdef: boolean;
}

const createRig = ({ sdef }: RigOptions) => {
  // A smooth closed surface gives BackSide inverted-hull extrusion a visible
  // screen-space silhouette; a hard-edged front-facing box does not.
  const geometry = new THREE.SphereGeometry(0.52, 24, 16);
  geometry.clearGroups();
  geometry.addGroup(0, geometry.getIndex()?.count ?? 0, 0);
  const vertexCount = geometry.getAttribute("position").count;
  const skinIndices = new Uint16Array(vertexCount * 4);
  const skinWeights = new Float32Array(vertexCount * 4);
  for (let index = 0; index < vertexCount; index += 1) {
    skinIndices[index * 4 + 1] = 1;
    skinWeights[index * 4] = 0.5;
    skinWeights[index * 4 + 1] = 0.5;
  }
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeights, 4));
  if (sdef) {
    geometry.setAttribute(
      "matricesSdefEnabled",
      new THREE.Float32BufferAttribute(new Float32Array(vertexCount).fill(1), 1),
    );
    geometry.setAttribute(
      "matricesSdefC",
      new THREE.Float32BufferAttribute(new Float32Array(vertexCount * 3), 3),
    );
    geometry.setAttribute(
      "matricesSdefRW0",
      new THREE.Float32BufferAttribute(new Float32Array(vertexCount * 3), 3),
    );
    geometry.setAttribute(
      "matricesSdefRW1",
      new THREE.Float32BufferAttribute(new Float32Array(vertexCount * 3), 3),
    );
  }
  const material = new THREE.MeshBasicMaterial({ color: 0xf04030, side: THREE.FrontSide });
  if (sdef) attachMmdSdefSkinning(material);
  material.depthWrite = false;
  material.userData.outlineParameters = {
    alpha: 1,
    color: [0.05, 0.9, 0.1],
    thickness: 0.07,
    visible: true,
  };
  const mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.frustumCulled = false;
  const bone0 = new THREE.Bone();
  const bone1 = new THREE.Bone();
  mesh.add(bone0, bone1);
  mesh.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton([bone0, bone1]));
  const root = new THREE.Group();
  root.add(mesh);
  root.updateMatrixWorld(true);
  return { bone0, bone1, geometry, material, mesh, root };
};

const renderRig = (
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  pass: ReturnType<typeof createThreeMmdOutlinePass>,
  sourceCamera: THREE.Camera,
) => {
  renderer.clear();
  renderer.render(scene, sourceCamera);
  pass.render(renderer, scene, sourceCamera);
  return readPixels(renderer);
};

const renderOutlineOnly = (
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  pass: ReturnType<typeof createThreeMmdOutlinePass>,
  sourceCamera: THREE.Camera,
) => {
  renderer.setClearColor(BACKGROUND, 0);
  renderer.clear(true, true, true);
  pass.render(renderer, scene, sourceCamera);
  return readPixels(renderer);
};

const renderSkinningFixture = (sdef: boolean) => {
  const renderer = createRenderer();
  const sourceCamera = camera();
  const scene = new THREE.Scene();
  scene.background = null;
  const rig = createRig({ sdef });
  scene.add(rig.root);
  const pass = createThreeMmdOutlinePass(rig.mesh);
  pass.outlineMesh.frustumCulled = false;
  rig.root.updateMatrixWorld(true);
  rig.mesh.skeleton.update();
  renderer.compile(scene, sourceCamera);
  renderRig(renderer, scene, pass, sourceCamera);
  const beforeOutlinePixels = renderOutlineOnly(renderer, scene, pass, sourceCamera);
  renderer.clear();
  renderer.render(scene, sourceCamera);
  const beforeSourcePixels = readPixels(renderer);
  rig.bone0.position.x = -0.30;
  rig.bone1.position.x = 0.62;
  rig.bone1.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
  rig.root.updateMatrixWorld(true);
  rig.mesh.skeleton.update();
  renderRig(renderer, scene, pass, sourceCamera);
  const afterOutlinePixels = renderOutlineOnly(renderer, scene, pass, sourceCamera);
  renderer.clear();
  renderer.render(scene, sourceCamera);
  const afterSourcePixels = readPixels(renderer);
  const sourcePredicate = (pixel: readonly number[]) => pixel[0] > 120 && pixel[0] > pixel[1] * 1.5;
  const outlinePredicate = (pixel: readonly number[]) => pixel[1] > 8 && pixel[1] > pixel[0] * 1.7;
  const beforeSource = foregroundBounds(beforeSourcePixels, sourcePredicate);
  const afterSource = foregroundBounds(afterSourcePixels, sourcePredicate);
  const beforeOutline = foregroundBounds(beforeOutlinePixels, outlinePredicate);
  const afterOutline = foregroundBounds(afterOutlinePixels, outlinePredicate);
  const outlineCenterDistance = boundsCenterDistance(beforeOutline, afterOutline);
  const sourceCenterDistance = boundsCenterDistance(beforeSource, afterSource);
  rig.material.visible = false;
  const hidden = renderRig(renderer, scene, pass, sourceCamera);
  const hiddenForeground = foregroundBounds(hidden, (pixel) => (
    pixel[0] > 0 || pixel[1] > 0 || pixel[2] > 0
  ));
  const evidence = {
    afterOutline,
    afterSource,
    beforeOutline,
    beforeSource,
    outlineExpandedBeyondSource: afterOutline.minimumX < afterSource.minimumX
      && afterOutline.maximumX > afterSource.maximumX
      && afterOutline.minimumY < afterSource.minimumY
      && afterOutline.maximumY > afterSource.maximumY,
    outlineCenterDistance,
    outlineMoved: outlineCenterDistance >= 8,
    program: programEvidence(renderer),
    hiddenForegroundPixels: hiddenForeground.count,
    hiddenMatchesBackground: hiddenForeground.count === 0,
    materialState: pass.materials.map((material) => ({
      depthTest: material.depthTest,
      depthWrite: material.depthWrite,
      side: material.side,
    })),
    sdef,
    sdefAttributeContract: pass.sdefAttributeContract,
    sdefVertexCount: pass.sdefVertexCount,
    sourceCenterDistance,
    sourceMoved: sourceCenterDistance >= 8,
  };
  pass.dispose();
  rig.geometry.dispose();
  rig.material.dispose();
  rig.mesh.skeleton.dispose();
  renderer.dispose();
  return evidence;
};

const renderStockOutlineReference = () => {
  const renderer = createRenderer();
  const sourceCamera = camera();
  const scene = new THREE.Scene();
  scene.background = null;
  const geometry = new THREE.SphereGeometry(0.52, 24, 16);
  const material = new THREE.MeshBasicMaterial({ color: 0xf04030, side: THREE.FrontSide });
  material.userData.outlineParameters = {
    alpha: 1,
    color: [0.05, 0.9, 0.1],
    thickness: 0.07,
    visible: true,
  };
  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);
  const effect = new OutlineEffect(renderer, { defaultThickness: 0.07 });
  effect.render(scene, sourceCamera);
  const combined = readPixels(renderer);
  const sourcePredicate = (pixel: readonly number[]) => pixel[0] > 120 && pixel[0] > pixel[1] * 1.5;
  const outlinePredicate = (pixel: readonly number[]) => pixel[1] > 8 && pixel[1] > pixel[0] * 1.7;
  const source = foregroundBounds(combined, sourcePredicate);
  const outline = foregroundBounds(combined, outlinePredicate);
  const evidence = {
    outline,
    outlineExpandedBeyondSource: outline.minimumX < source.minimumX
      && outline.maximumX > source.maximumX
      && outline.minimumY < source.minimumY
      && outline.maximumY > source.maximumY,
    program: programEvidence(renderer),
    source,
  };
  geometry.dispose();
  material.dispose();
  renderer.dispose();
  return evidence;
};

const realModelFiles = () => {
  const input = document.getElementById("real-model");
  if (!(input instanceof HTMLInputElement) || !input.files?.length) {
    throw new Error("Real-model file input is empty");
  }
  return Array.from(input.files);
};

const renderRealSphereAdd = async () => {
  const files = await expandMmdAssets(realModelFiles());
  const candidates = await inspectMmdModels(files);
  const modelFile = choosePrimaryMmdModel(files, candidates);
  if (!modelFile) throw new Error("Real-model ZIP has no PMX/PMD candidate");
  const parsed = new FallbackCore().loadModel(
    new Uint8Array(await modelFile.arrayBuffer()),
    { format: modelFile.name.toLowerCase().endsWith(".pmd") ? "pmd" : "pmx" },
  );
  const metadata = parsed.materials();
  parsed.dispose?.();
  const expectedAdd = new Map(metadata.flatMap((material, index) => (
    material.sphereMode === "add" ? [[index, material]] : []
  )));
  const model = await loadThreeVanillaMmdModel(files, modelFile);
  const renderer = createRenderer();
  try {
    const scene = new THREE.Scene();
    scene.background = BACKGROUND;
    if (!model.root.parent) scene.add(model.root);
    scene.add(new THREE.AmbientLight(0xffffff, 1));
    model.root.updateMatrixWorld(true);
    model.mesh.skeleton.update();
    const bounds = new THREE.Box3().setFromObject(model.root);
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const sourceCamera = new THREE.OrthographicCamera(
      -Math.max(size.x, size.y) * 0.65,
      Math.max(size.x, size.y) * 0.65,
      Math.max(size.x, size.y) * 0.65,
      -Math.max(size.x, size.y) * 0.65,
      0.1,
      Math.max(size.length() * 4, 100),
    );
    sourceCamera.position.set(center.x, center.y, center.z + Math.max(size.length() * 2, 50));
    sourceCamera.lookAt(center);
    sourceCamera.updateMatrixWorld(true);
    renderer.compile(scene, sourceCamera);
    renderer.render(scene, sourceCamera);
    const materials = (Array.isArray(model.mesh.material)
      ? model.mesh.material
      : [model.mesh.material]) as Array<THREE.MeshToonMaterial & {
        melyMmdSphereMap?: THREE.Texture | null;
      }>;
    const addMaterials = [...expectedAdd].map(([index, materialMetadata]) => {
      const material = materials[index];
      const shader = material?.userData.melyVanillaMmdSphereShader as ShaderSnapshot | undefined;
      return {
        index,
        materialName: materialMetadata.name,
        spherePath: materialMetadata.sphereTexturePath,
        shaderCaptured: Boolean(shader),
        shaderHasAddBranch: Boolean(
          shader?.fragmentShader.includes("outgoingLight += melyMmdSphereColor;"),
        ),
        shaderHasLightWeightedSphere: Boolean(
          shader?.fragmentShader.includes("reflectedLight.directDiffuse")
          && shader.fragmentShader.includes("reflectedLight.indirectDiffuse"),
        ),
        uniformBound: Boolean(
          shader
          && material.melyMmdSphereMap
          && shader.uniforms.melyMmdSphereMap?.value === material.melyMmdSphereMap,
        ),
      };
    });
    return {
      addMaterialCount: addMaterials.length,
      addMaterials,
      modelFile: modelFile.name,
      program: programEvidence(renderer),
    };
  } finally {
    renderer.dispose();
    await model.dispose();
  }
};

window.__melyRunGpuProbes = async () => ({
  fixtures: {
    skinning: renderSkinningFixture(false),
    sdef: renderSkinningFixture(true),
    stockOutline: renderStockOutlineReference(),
    sphereAdd: renderSphereFixture("add"),
    sphereMultiply: renderSphereFixture("multiply"),
  },
  realModel: await renderRealSphereAdd(),
});
window.__melyGpuProbeReady = true;
