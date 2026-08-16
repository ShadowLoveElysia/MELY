import {
  Color,
  MeshToonMaterial,
  SRGBColorSpace,
  type Material,
  type SkinnedMesh,
  Texture,
} from "three";

export const VANILLA_MMD_COLOR_CALIBRATION_VERSION = 1;

export interface VanillaMmdMaterialColorInput {
  readonly diffuse?: readonly number[];
  readonly ambient?: readonly number[];
  readonly texturePath?: string;
  readonly sphereTexturePath?: string;
  readonly sphereMode?: VanillaMmdSphereMode;
}

export interface VanillaMmdMaterialCalibrationOptions {
  readonly format?: "pmx" | "pmd";
  readonly resolveSphereTexture?: (path: string) => Texture | undefined;
}

export interface VanillaMmdLoaderTextureCapture {
  resolve: (path: string) => Texture | undefined;
  restore: () => void;
  disposeDetached: (mesh?: SkinnedMesh | null) => void;
}

export type VanillaMmdSphereMode = "none" | "multiply" | "add" | "subTexture";

interface VanillaMmdColorCalibrationMarker {
  readonly version: typeof VANILLA_MMD_COLOR_CALIBRATION_VERSION;
  readonly colorTextureSlots: readonly VanillaMmdColorTextureSlot[];
}

type VanillaMmdColorTextureSlot = "map" | "gradientMap" | "melyMmdSphereMap";

type VanillaMmdToonMaterial = MeshToonMaterial & {
  melyMmdSphereMap?: Texture | null;
};

type VanillaMmdSphereShader = Parameters<MeshToonMaterial["onBeforeCompile"]>[0];

// MMD toon BMPs encode an illumination color ramp, unlike generic numeric toon thresholds.
const COLOR_TEXTURE_SLOTS: readonly VanillaMmdColorTextureSlot[] = [
  "map",
  "gradientMap",
  "melyMmdSphereMap",
];
const COLOR_TEXTURE_SLOT_SET = new Set<string>(COLOR_TEXTURE_SLOTS);

const SPHERE_FRAGMENT_SEAM = "#include <opaque_fragment>";
const SPHERE_PARS_SEAM = "#include <map_pars_fragment>";

const normalizedTexturePath = (value: string) => value
  .replaceAll("\\", "/")
  .replace(/^\.\/+/, "")
  .toLowerCase();

const textureBaseName = (value: string) => normalizedTexturePath(value).split("/").pop() ?? "";

const disposeTextureSource = (value: unknown) => {
  try {
    if (typeof ImageBitmap !== "undefined" && value instanceof ImageBitmap) {
      value.close();
    } else if (typeof HTMLImageElement !== "undefined" && value instanceof HTMLImageElement) {
      value.onload = null;
      value.onerror = null;
      value.removeAttribute("src");
      value.removeAttribute("srcset");
    } else if (typeof HTMLCanvasElement !== "undefined" && value instanceof HTMLCanvasElement) {
      value.width = 0;
      value.height = 0;
    }
  } catch {
    // Source cleanup is best effort; Texture.dispose() has already released GPU state.
  }
};

const collectMaterialTextures = (material: Material, target: Set<Texture>) => {
  Object.values(material).forEach((value) => {
    if (value instanceof Texture) target.add(value);
  });
  const descriptor = (material as Material & { descriptor?: Record<string, unknown> }).descriptor;
  Object.values(descriptor ?? {}).forEach((value) => {
    if (value instanceof Texture) target.add(value);
  });
};

/**
 * Captures textures created by the pinned three-stdlib MMDLoader before r185's
 * MeshToonMaterial drops its legacy envMap/combine constructor parameters.
 */
export const captureVanillaMmdLoaderTextures = (
  loader: unknown,
): VanillaMmdLoaderTextureCapture => {
  const materialBuilder = (loader as {
    meshBuilder?: {
      materialBuilder?: {
        _loadTexture?: (filePath: string, ...args: unknown[]) => Texture;
      };
    };
  }).meshBuilder?.materialBuilder;
  const original = materialBuilder?._loadTexture;
  if (!materialBuilder || typeof original !== "function") {
    throw new Error("Unsupported three-stdlib MMDLoader texture internals");
  }

  const exact = new Map<string, Texture | null>();
  const byBaseName = new Map<string, Texture | null>();
  const captured = new Set<Texture>();
  const wrapped = function wrappedMmdTextureLoad(
    this: unknown,
    filePath: string,
    ...args: unknown[]
  ) {
    const texture = original.call(this, filePath, ...args);
    captured.add(texture);
    const key = normalizedTexturePath(filePath);
    const exactPrevious = exact.get(key);
    if (exactPrevious === undefined || exactPrevious === texture) exact.set(key, texture);
    else exact.set(key, null);
    const baseName = textureBaseName(key);
    const previous = byBaseName.get(baseName);
    if (previous === undefined || previous === texture) byBaseName.set(baseName, texture);
    else byBaseName.set(baseName, null);
    return texture;
  };
  materialBuilder._loadTexture = wrapped;

  return {
    resolve: (path) => {
      const key = normalizedTexturePath(path);
      const exactMatch = exact.get(key);
      if (exactMatch !== undefined) return exactMatch ?? undefined;
      return byBaseName.get(textureBaseName(key)) ?? undefined;
    },
    restore: () => {
      if (materialBuilder._loadTexture === wrapped) materialBuilder._loadTexture = original;
    },
    disposeDetached: (mesh) => {
      const attached = new Set<Texture>();
      if (mesh) {
        materialList(mesh).forEach((material) => collectMaterialTextures(material, attached));
        if (mesh.customDepthMaterial) collectMaterialTextures(mesh.customDepthMaterial, attached);
        if (mesh.customDistanceMaterial) collectMaterialTextures(mesh.customDistanceMaterial, attached);
      }
      const attachedSources = new Set([...attached].map((texture) => texture.source));
      const disposedSources = new Set<Texture["source"]>();
      captured.forEach((texture) => {
        if (attached.has(texture)) return;
        const source = texture.source;
        const sourceData = source.data ?? texture.image;
        texture.dispose();
        texture.mipmaps.length = 0;
        if (!attachedSources.has(source) && !disposedSources.has(source)) {
          disposedSources.add(source);
          disposeTextureSource(sourceData);
          source.data = null;
        }
      });
      captured.clear();
      exact.clear();
      byBaseName.clear();
    },
  };
};

export const patchVanillaMmdSphereFragmentShader = (
  source: string,
  mode: Extract<VanillaMmdSphereMode, "multiply" | "add">,
) => {
  const seamCount = (seam: string) => source.split(seam).length - 1;
  if (seamCount(SPHERE_PARS_SEAM) !== 1 || seamCount(SPHERE_FRAGMENT_SEAM) !== 1) {
    throw new Error("Vanilla MMD sphere shader is incompatible with this Three revision");
  }
  const composite = mode === "multiply"
    ? "outgoingLight *= melyMmdSphereColor;"
    : "outgoingLight += melyMmdSphereColor;";
  return source
    .replace(SPHERE_PARS_SEAM, [
      SPHERE_PARS_SEAM,
      "uniform sampler2D melyMmdSphereMap;",
    ].join("\n"))
    .replace(SPHERE_FRAGMENT_SEAM, [
      "vec2 melyMmdSphereUv = normal.xy * 0.5 + 0.5;",
      "vec3 melyMmdSphereColor = texture2D( melyMmdSphereMap, melyMmdSphereUv ).rgb;",
      // MMD sphere maps are modulated by the lit diffuse term before blending.
      "melyMmdSphereColor *= reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;",
      composite,
      SPHERE_FRAGMENT_SEAM,
    ].join("\n"));
};

const attachSphereTexture = (
  material: VanillaMmdToonMaterial,
  input: VanillaMmdMaterialColorInput | undefined,
  resolveTexture: VanillaMmdMaterialCalibrationOptions["resolveSphereTexture"],
) => {
  const mode = input?.sphereMode;
  const path = input?.sphereTexturePath;
  if ((mode !== "multiply" && mode !== "add") || !path || !resolveTexture) return;
  const texture = resolveTexture(path);
  if (!texture) return;

  const previousOnBeforeCompile = material.onBeforeCompile.bind(material);
  const previousProgramCacheKey = material.customProgramCacheKey.bind(material);
  material.melyMmdSphereMap = texture;
  material.userData.melyVanillaMmdSphere = { mode, path, shaderApplied: true };
  material.onBeforeCompile = (shader, renderer) => {
    previousOnBeforeCompile(shader, renderer);
    shader.uniforms.melyMmdSphereMap = { value: material.melyMmdSphereMap };
    shader.fragmentShader = patchVanillaMmdSphereFragmentShader(shader.fragmentShader, mode);
    material.userData.melyVanillaMmdSphereShader = shader as VanillaMmdSphereShader;
  };
  material.customProgramCacheKey = () => `${previousProgramCacheKey()}-mely-mmd-sphere-${mode}`;
};

const materialList = (mesh: SkinnedMesh) => (
  Array.isArray(mesh.material) ? mesh.material : [mesh.material]
) as Material[];

const isCalibrated = (material: Material) => {
  const marker = material.userData.melyVanillaMmdColorCalibration as
    | VanillaMmdColorCalibrationMarker
    | undefined;
  return marker?.version === VANILLA_MMD_COLOR_CALIBRATION_VERSION;
};

const textureAt = (
  material: VanillaMmdToonMaterial,
  slot: VanillaMmdColorTextureSlot,
) => {
  const value = material[slot];
  return value instanceof Texture ? value : null;
};

const writeTexture = (
  material: VanillaMmdToonMaterial,
  slot: VanillaMmdColorTextureSlot,
  texture: Texture,
) => {
  (material as unknown as Record<string, unknown>)[slot] = texture;
  if (slot === "melyMmdSphereMap") {
    const shader = material.userData.melyVanillaMmdSphereShader as
      | VanillaMmdSphereShader
      | undefined;
    if (shader) shader.uniforms.melyMmdSphereMap.value = texture;
  }
};

const collectNonColorTextures = (materials: readonly Material[]) => {
  const textures = new Set<Texture>();
  materials.forEach((material) => {
    Object.entries(material).forEach(([slot, value]) => {
      if (value instanceof Texture && !COLOR_TEXTURE_SLOT_SET.has(slot)) textures.add(value);
    });
  });
  return textures;
};

const collectColorTextureUsage = (materials: readonly Material[]) => {
  const usage = new Map<Texture, Set<Material>>();
  materials.forEach((material) => {
    const toonMaterial = material as VanillaMmdToonMaterial;
    COLOR_TEXTURE_SLOTS.forEach((slot) => {
      const texture = textureAt(toonMaterial, slot);
      if (!texture) return;
      const owners = usage.get(texture) ?? new Set<Material>();
      owners.add(material);
      usage.set(texture, owners);
    });
  });
  return usage;
};

const setSrgbColor = (target: Color, source: readonly number[]) => {
  target.setRGB(source[0] ?? 0, source[1] ?? 0, source[2] ?? 0, SRGBColorSpace);
};

const calibrateMaterialColors = (
  material: VanillaMmdToonMaterial,
  input: VanillaMmdMaterialColorInput | undefined,
) => {
  if (input?.diffuse && input.diffuse.length >= 3) {
    setSrgbColor(material.color, input.diffuse);
  } else {
    material.color.convertSRGBToLinear();
  }

  if (input?.ambient && input.ambient.length >= 3) {
    setSrgbColor(material.emissive, input.ambient);
    // three-stdlib attenuates ambient only for textured stock MMD materials.
    if (material.map instanceof Texture) material.emissive.multiplyScalar(0.2);
  } else if (material.map instanceof Texture) {
    // Recover the loader's pre-attenuation value before applying the transfer function.
    material.emissive.multiplyScalar(5).convertSRGBToLinear().multiplyScalar(0.2);
  } else {
    material.emissive.convertSRGBToLinear();
  }
};

/**
 * Normalizes stock three-stdlib MMD material color inputs for Three's linear
 * working space without mutating parser metadata or non-color texture slots.
 */
export const calibrateVanillaMmdMaterials = (
  mesh: SkinnedMesh,
  inputs: readonly VanillaMmdMaterialColorInput[] = [],
  options: VanillaMmdMaterialCalibrationOptions = {},
): void => {
  const materials = materialList(mesh);
  const pending = materials
    .map((material, index) => ({ material, index }))
    .filter((entry): entry is { material: VanillaMmdToonMaterial; index: number } => (
      entry.material instanceof MeshToonMaterial && !isCalibrated(entry.material)
    ));
  if (!pending.length) return;

  const pendingMaterials = new Set<Material>(pending.map((entry) => entry.material));

  pending.forEach(({ material, index }) => {
    const input = inputs[index];
    attachSphereTexture(material, input, options.resolveSphereTexture);
    if (
      options.format === "pmd"
      && !input?.texturePath
      && input?.sphereTexturePath
      && material.map === material.melyMmdSphereMap
    ) {
      // three-stdlib assigns a PMD sphere-only filename to map before parsing its suffix.
      material.map = null;
    }
  });

  const nonColorTextures = collectNonColorTextures(materials);
  const colorUsage = collectColorTextureUsage(materials);
  const colorClones = new Map<Texture, Texture>();
  const colorTextures = new Set<Texture>();

  pending.forEach(({ material, index }) => {
    const input = inputs[index];
    const calibratedSlots: VanillaMmdColorTextureSlot[] = [];
    COLOR_TEXTURE_SLOTS.forEach((slot) => {
      const source = textureAt(material, slot);
      if (!source) return;
      const sharedWithUncalibratedOwner = [...(colorUsage.get(source) ?? [])]
        .some((owner) => !pendingMaterials.has(owner));
      const mustClone = nonColorTextures.has(source)
        || sharedWithUncalibratedOwner;
      const target = mustClone
        ? (() => {
            const existing = colorClones.get(source);
            if (existing) return existing;
            const clone = source.clone();
            colorClones.set(source, clone);
            return clone;
          })()
        : source;
      if (target !== source) writeTexture(material, slot, target);
      colorTextures.add(target);
      calibratedSlots.push(slot);
    });

    calibrateMaterialColors(material, input);
    material.userData.melyVanillaMmdColorCalibration = {
      version: VANILLA_MMD_COLOR_CALIBRATION_VERSION,
      colorTextureSlots: calibratedSlots,
    } satisfies VanillaMmdColorCalibrationMarker;
    material.needsUpdate = true;
  });

  colorTextures.forEach((texture) => {
    texture.colorSpace = SRGBColorSpace;
    texture.needsUpdate = true;
  });
};
