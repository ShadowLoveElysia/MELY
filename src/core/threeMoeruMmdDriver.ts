import { AnimationMixer, Group } from "three";
import {
  buildAnimation,
  MMDLoader,
  VMDLoader,
  type MMD,
  type VmdObject,
} from "@moeru/three-mmd";
import { MMDAmmoPhysics, initAmmo } from "@moeru/three-mmd-physics-ammo";
import { appError } from "./appError";
import { createMmdResourceUrlBundle } from "./mmdResourceUrls";
import { normalizeMelyBoneName } from "./melyPose";
import {
  createThreeMmdModel,
  type LoadedThreeMmdModel,
  type ThreeMmdBackendDriver,
} from "./threeMmdRuntime";

/**
 * Moeru's animation builder binds tracks by the model's native names. Some VMD
 * files use the PMX English names instead, so remap those names before handing
 * the parsed motion to `buildAnimation`.
 */
const mapVmdTrackNames = (motion: VmdObject, mmd: MMD): VmdObject => {
  const boneNames = new Map<string, string>();
  mmd.pmx.bones.forEach((bone) => {
    if (!bone.name) return;
    [bone.name, bone.englishName].forEach((name) => {
      if (name) boneNames.set(normalizeMelyBoneName(name), bone.name);
    });
  });
  const morphNames = new Map<string, string>();
  mmd.pmx.morphs.forEach((morph) => {
    if (!morph.name) return;
    [morph.name, morph.englishName].forEach((name) => {
      if (name) morphNames.set(normalizeMelyBoneName(name), morph.name);
    });
  });

  const boneFrames = motion.boneKeyFrames;
  const morphFrames = motion.morphKeyFrames;
  const mappedBones = {
    length: boneFrames.length,
    get: (index: number) => {
      const frame = boneFrames.get(index);
      const name = boneNames.get(normalizeMelyBoneName(frame.boneName));
      return name ? { ...frame, boneName: name } : frame;
    },
  } as VmdObject["boneKeyFrames"];
  const mappedMorphs = {
    length: morphFrames.length,
    get: (index: number) => {
      const frame = morphFrames.get(index);
      const name = morphNames.get(normalizeMelyBoneName(frame.morphName));
      return name ? { ...frame, morphName: name } : frame;
    },
  } as VmdObject["morphKeyFrames"];

  return new Proxy(motion, {
    get(target, property, receiver) {
      if (property === "boneKeyFrames") return mappedBones;
      if (property === "morphKeyFrames") return mappedMorphs;
      return Reflect.get(target, property, receiver);
    },
  });
};

/**
 * Loads the Moeru backend. Its rewritten toon material, IK/grant ordering and
 * optional Ammo service remain owned by this driver and are disposed before
 * the shared Three resources are released.
 */
export const loadThreeMoeruMmdModel = async (
  files: readonly File[],
  modelFile: File,
): Promise<LoadedThreeMmdModel> => {
  const resources = createMmdResourceUrlBundle(files, modelFile);
  const textureWarnings: string[] = [];
  resources.manager.onError = (url) => textureWarnings.push(url);
  let mmd: MMD | null = null;
  try {
    mmd = await new MMDLoader(resources.manager).loadAsync(resources.modelUrl);
    const root = new Group();
    root.name = modelFile.name.replace(/\.[^.]+$/, "") || "MMD Model";
    root.add(mmd.mesh);
    const mixer = new AnimationMixer(mmd.mesh);
    let physicsEnabled = false;
    let physicsRequestId = 0;
    let disposed = false;
    const pmx = mmd.pmx;

    const driver: ThreeMmdBackendDriver = {
      rendererMode: "moeru",
      root,
      mesh: mmd.mesh,
      mixer,
      metadata: {
        fileName: modelFile.name,
        name: pmx.header.modelName,
        englishName: pmx.header.englishModelName,
        format: modelFile.name.toLowerCase().endsWith(".pmd") ? "pmd" : "pmx",
        rigidBodyCount: pmx.rigidBodies.length,
        jointCount: pmx.joints.length,
        boneEnglishNames: pmx.bones.map((bone) => bone.englishName),
        morphEnglishNames: pmx.morphs.map((morph) => morph.englishName),
          materialNames: pmx.materials.map((material) => ({
            name: material.name,
            englishName: material.englishName,
            diffuse: material.diffuse,
            ambient: material.ambient,
          })),
      },
      textureWarnings,
      physicsAvailable: pmx.rigidBodies.length > 0,
      loadMotionClip: async (file) => {
        const motion = await new VMDLoader(resources.manager).loadAsync(
          resources.createVirtualFileUrl(file),
        );
        return buildAnimation(mapVmdTrackNames(motion, mmd!), mmd!.mesh);
      },
      evaluate: (deltaSeconds, physics) => {
        if (disposed || !mmd) return;
        mmd.beforeUpdate();
        mixer.update(Math.max(0, deltaSeconds));
        mmd.update(Math.max(0, deltaSeconds), { physics: Boolean(physics && physicsEnabled) });
      },
      resetPhysics: () => mmd?.physics?.reset?.(),
      setPhysicsEnabled: async (enabled) => {
        if (disposed || !mmd || !driver.physicsAvailable) return;
        const requestId = ++physicsRequestId;
        physicsEnabled = enabled;
        if (!enabled) return;
        if (enabled && !mmd.physics) {
          try {
            await initAmmo();
          } catch (error) {
            if (requestId !== physicsRequestId || disposed || !mmd) return;
            physicsEnabled = false;
            throw error;
          }
          if (requestId !== physicsRequestId || disposed || !mmd || !physicsEnabled) return;
          mmd.setPhysics(MMDAmmoPhysics);
        }
        if (requestId === physicsRequestId && physicsEnabled) mmd.physics?.reset?.();
      },
      physicsEnabled: () => physicsEnabled,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        ++physicsRequestId;
        physicsEnabled = false;
        mmd?.dispose();
        mmd = null;
        resources.dispose();
      },
    };
    return createThreeMmdModel({ driver });
  } catch (error) {
    mmd?.dispose();
    resources.dispose();
    throw appError("error.model.loadFailed", undefined, error);
  }
};
