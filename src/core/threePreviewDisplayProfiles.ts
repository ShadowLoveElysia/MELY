import * as THREE from "three";
import type { PreviewMode } from "../types";

type LightPosition = readonly [number, number, number];

interface DirectionalLightProfile {
  readonly color: THREE.ColorRepresentation;
  readonly intensity: number;
  readonly position: LightPosition;
}

interface HemisphereLightProfile {
  readonly color: THREE.ColorRepresentation;
  readonly groundColor: THREE.ColorRepresentation;
  readonly intensity: number;
}

export interface ThreePreviewDisplayProfile {
  readonly background: THREE.ColorRepresentation;
  readonly fog: {
    readonly color: THREE.ColorRepresentation;
    readonly density: number;
  };
  readonly renderer: {
    readonly outputColorSpace: THREE.ColorSpace;
    readonly toneMapping: THREE.ToneMapping;
    readonly toneMappingExposure: number;
  };
  readonly keyLight: DirectionalLightProfile;
  readonly rimLight: DirectionalLightProfile;
  readonly hemisphereLight: HemisphereLightProfile;
}

export interface ThreePreviewDisplayTarget {
  renderer: {
    outputColorSpace: string;
    toneMapping: THREE.ToneMapping;
    toneMappingExposure: number;
  };
  scene: THREE.Scene;
  keyLight: THREE.DirectionalLight;
  rimLight: THREE.DirectionalLight;
  hemisphereLight: THREE.HemisphereLight;
}

const SOURCE_PROFILE: ThreePreviewDisplayProfile = {
  background: "#111314",
  fog: {
    color: "#111314",
    density: 0.00055,
  },
  renderer: {
    outputColorSpace: THREE.SRGBColorSpace,
    toneMapping: THREE.NoToneMapping,
    toneMappingExposure: 1,
  },
  keyLight: {
    color: "#ffffff",
    intensity: 1.8,
    position: [30, 100, 40],
  },
  rimLight: {
    color: "#ffffff",
    intensity: 0,
    position: [-90, 48, -65],
  },
  hemisphereLight: {
    color: "#ffffff",
    groundColor: "#000000",
    intensity: 0.65,
  },
};

const PROJECTION_DAY_PROFILE: ThreePreviewDisplayProfile = {
  background: "#111314",
  fog: {
    color: "#111314",
    density: 0.00055,
  },
  renderer: {
    outputColorSpace: THREE.SRGBColorSpace,
    toneMapping: THREE.ACESFilmicToneMapping,
    toneMappingExposure: 1.08,
  },
  keyLight: {
    color: "#e7f6ff",
    intensity: 2.7,
    position: [55, 120, 95],
  },
  rimLight: {
    color: "#67e6cb",
    intensity: 1.9,
    position: [-90, 48, -65],
  },
  hemisphereLight: {
    color: "#a7cbd8",
    groundColor: "#181b1d",
    intensity: 1.15,
  },
};

const PROJECTION_NIGHT_PROFILE: ThreePreviewDisplayProfile = {
  background: "#050811",
  fog: {
    color: "#070b16",
    density: 0.00075,
  },
  renderer: {
    outputColorSpace: THREE.SRGBColorSpace,
    toneMapping: THREE.ACESFilmicToneMapping,
    toneMappingExposure: 0.78,
  },
  keyLight: {
    color: "#7f91c9",
    intensity: 0.42,
    position: [55, 120, 95],
  },
  rimLight: {
    color: "#397f92",
    intensity: 0.5,
    position: [-90, 48, -65],
  },
  hemisphereLight: {
    color: "#27375f",
    groundColor: "#04060c",
    intensity: 0.24,
  },
};

export const resolveThreePreviewDisplayProfile = (
  previewMode: PreviewMode,
  nightMode: boolean,
): ThreePreviewDisplayProfile => {
  if (previewMode === "source") return SOURCE_PROFILE;
  return nightMode ? PROJECTION_NIGHT_PROFILE : PROJECTION_DAY_PROFILE;
};

export const applyThreePreviewDisplayProfile = (
  target: ThreePreviewDisplayTarget,
  previewMode: PreviewMode,
  nightMode: boolean,
) => {
  const profile = resolveThreePreviewDisplayProfile(previewMode, nightMode);
  const { renderer, scene, keyLight, rimLight, hemisphereLight } = target;

  renderer.outputColorSpace = profile.renderer.outputColorSpace;
  renderer.toneMapping = profile.renderer.toneMapping;
  renderer.toneMappingExposure = profile.renderer.toneMappingExposure;

  if (scene.background instanceof THREE.Color) scene.background.set(profile.background);
  else scene.background = new THREE.Color(profile.background);

  if (scene.fog instanceof THREE.FogExp2) {
    scene.fog.color.set(profile.fog.color);
    scene.fog.density = profile.fog.density;
  } else {
    scene.fog = new THREE.FogExp2(profile.fog.color, profile.fog.density);
  }

  keyLight.color.set(profile.keyLight.color);
  keyLight.intensity = profile.keyLight.intensity;
  keyLight.position.set(...profile.keyLight.position);

  rimLight.color.set(profile.rimLight.color);
  rimLight.intensity = profile.rimLight.intensity;
  rimLight.position.set(...profile.rimLight.position);

  hemisphereLight.color.set(profile.hemisphereLight.color);
  hemisphereLight.groundColor.set(profile.hemisphereLight.groundColor);
  hemisphereLight.intensity = profile.hemisphereLight.intensity;
};
