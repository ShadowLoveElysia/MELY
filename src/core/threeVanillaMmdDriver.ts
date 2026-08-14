import {
  AnimationClip,
  AnimationMixer,
  Group,
  type SkinnedMesh,
} from "three";
import {
  MMDAnimationHelper,
  MMDLoader,
  type MMDPhysics,
} from "three-stdlib";
import type { MmdModel } from "@yohawing/three-mmd-loader/parser";
import { FallbackCore } from "@yohawing/three-mmd-loader/parser";
import { appError } from "./appError";
import { createMmdResourceUrlBundle } from "./mmdResourceUrls";
import { normalizeMelyBoneName } from "./melyPose";
import {
  createThreeMmdModel,
  type LoadedThreeMmdModel,
  type ThreeMmdBackendDriver,
} from "./threeMmdRuntime";

interface VanillaHelperObject {
  mixer?: AnimationMixer;
  physics?: MMDPhysics;
}

interface VanillaHelperInternals {
  objects: WeakMap<SkinnedMesh, VanillaHelperObject>;
  _setupMeshPhysics: (mesh: SkinnedMesh, params: {
    physics: true;
    warmup: number;
    unitStep: number;
    maxStepNum: number;
  }) => void;
}

interface AmmoModule {
  destroy: (object: unknown) => void;
  btVector3?: new (x: number, y: number, z: number) => unknown;
  [key: string]: unknown;
}

type AmmoGlobal = AmmoModule | undefined;

interface AmmoPhysicsCapture {
  readonly objects: unknown[];
}

const EMPTY_ANIMATION = new AnimationClip("MELY vanilla runtime", 0, []);

const loadModelMetadata = async (modelFile: File) => {
  const parsed = new FallbackCore().loadModel(
    new Uint8Array(await modelFile.arrayBuffer()),
    { format: modelFile.name.toLowerCase().endsWith(".pmd") ? "pmd" : "pmx" },
  );
  return parsed;
};

interface VanillaAnimationAliases {
  bones: ReadonlyMap<string, string>;
  morphs: ReadonlyMap<string, string>;
}

const remapVmdNames = (value: object, aliases: VanillaAnimationAliases) => {
  const source = value as {
    motions?: readonly { boneName: string }[];
    morphs?: readonly { morphName: string }[];
  };
  return {
    ...source,
    motions: source.motions?.map((motion) => ({
      ...motion,
      boneName: aliases.bones.get(normalizeMelyBoneName(motion.boneName)) ?? motion.boneName,
    })),
    morphs: source.morphs?.map((morph) => ({
      ...morph,
      morphName: aliases.morphs.get(normalizeMelyBoneName(morph.morphName)) ?? morph.morphName,
    })),
  };
};

const loadAnimation = (
  loader: MMDLoader,
  url: string,
  mesh: SkinnedMesh,
  aliases: VanillaAnimationAliases,
) => new Promise<AnimationClip>((resolve, reject) => {
  loader.loadVMD(
    url,
    (vmd) => {
      try {
        const builder = (loader as unknown as {
          animationBuilder?: { build?: (value: object, target: SkinnedMesh) => unknown };
        }).animationBuilder;
        const animation = builder?.build?.(remapVmdNames(vmd, aliases), mesh);
        if (animation instanceof AnimationClip) resolve(animation);
        else reject(new Error("MMDLoader returned an unexpected animation object"));
      } catch (error) {
        reject(error);
      }
    },
    undefined,
    reject,
  );
});

const installAmmoCapture = (ammo: AmmoModule): AmmoPhysicsCapture => {
  const constructorNames = [
    "btDefaultCollisionConfiguration",
    "btCollisionDispatcher",
    "btDbvtBroadphase",
    "btSequentialImpulseConstraintSolver",
  ] as const;
  const originals = new Map<string, unknown>();
  const objects: unknown[] = [];
  constructorNames.forEach((name) => {
    const original = ammo[name];
    if (typeof original !== "function") return;
    originals.set(name, original);
    const wrapped = function wrappedAmmoConstructor(this: unknown, ...args: unknown[]) {
      const value = Reflect.construct(original, args);
      objects.push(value);
      return value;
    };
    Object.setPrototypeOf(wrapped, original);
    (wrapped as { prototype?: unknown }).prototype = (original as { prototype?: unknown }).prototype;
    ammo[name] = wrapped;
  });
  return {
    objects,
    restore: () => originals.forEach((value, name) => {
      ammo[name] = value;
    }),
  } as AmmoPhysicsCapture & { restore: () => void };
};

const destroyAmmoObjects = (
  ammo: AmmoModule,
  physics: MMDPhysics | undefined,
  capture: AmmoPhysicsCapture | null,
) => {
  if (!physics) return;
  const destroyed = new Set<unknown>();
  const destroy = (value: unknown) => {
    if (!value || destroyed.has(value)) return;
    destroyed.add(value);
    try {
      ammo.destroy(value);
    } catch {
      // Ammo builds differ in which wrapper objects are independently owned.
    }
  };
  const world = physics.world as {
    removeConstraint?: (constraint: unknown) => void;
    removeRigidBody?: (body: unknown) => void;
  } | null;
  [...physics.constraints].reverse().forEach((entry) => {
    const constraint = (entry as unknown as { constraint?: unknown }).constraint;
    if (constraint) world?.removeConstraint?.(constraint);
    destroy(constraint);
  });
  [...physics.bodies].reverse().forEach((entry) => {
    const body = (entry as unknown as {
      body?: {
        getMotionState?: () => unknown;
        getCollisionShape?: () => unknown;
      };
      boneOffsetForm?: unknown;
      boneOffsetFormInverse?: unknown;
    }).body;
    if (body) world?.removeRigidBody?.(body);
    destroy(body?.getMotionState?.());
    destroy(body?.getCollisionShape?.());
    destroy(body);
    destroy((entry as unknown as { boneOffsetForm?: unknown }).boneOffsetForm);
    destroy((entry as unknown as { boneOffsetFormInverse?: unknown }).boneOffsetFormInverse);
  });
  const manager = physics.manager as unknown as {
    transforms?: unknown[];
    quaternions?: unknown[];
    vector3s?: unknown[];
  };
  manager.transforms?.forEach(destroy);
  manager.quaternions?.forEach(destroy);
  manager.vector3s?.forEach(destroy);
  destroy(world);
  [...(capture?.objects ?? [])].reverse().forEach(destroy);
  physics.constraints.length = 0;
  physics.bodies.length = 0;
  physics.world = null;
};

const hardResetAmmoPhysics = (ammo: AmmoModule | null, physics: MMDPhysics | undefined) => {
  if (!physics) return;
  if (!ammo || typeof ammo.btVector3 !== "function") {
    physics.reset();
    return;
  }
  const zero = new ammo.btVector3(0, 0, 0);
  try {
    physics.bodies.forEach((entry) => {
      const candidate = entry as unknown as {
        params?: { type?: number };
        body?: {
          activate?: () => void;
          clearForces?: () => void;
          setAngularVelocity?: (value: unknown) => void;
          setLinearVelocity?: (value: unknown) => void;
        };
      };
      if (!candidate.body || (candidate.params?.type !== 1 && candidate.params?.type !== 2)) return;
      candidate.body.clearForces?.();
      candidate.body.setLinearVelocity?.(zero);
      candidate.body.setAngularVelocity?.(zero);
    });
    physics.reset();
    const world = physics.world as unknown as {
      updateSingleAabb?: (body: unknown) => void;
    } | null;
    physics.bodies.forEach((entry) => {
      const candidate = entry as unknown as {
        params?: { type?: number };
        body?: { activate?: () => void };
      };
      if (!candidate.body) return;
      world?.updateSingleAabb?.(candidate.body);
      if (candidate.params?.type === 1 || candidate.params?.type === 2) {
        candidate.body.activate?.();
      }
    });
  } finally {
    ammo.destroy(zero);
  }
};

/**
 * Loads the compatibility backend with Three.js' stock MMDLoader and helper.
 * Blob URLs, helper state, Ammo bodies and parser metadata are all released by
 * the returned model's dispose method before another renderer can be mounted.
 */
export const loadThreeVanillaMmdModel = async (
  files: readonly File[],
  modelFile: File,
): Promise<LoadedThreeMmdModel> => {
  const resources = createMmdResourceUrlBundle(files, modelFile);
  const textureWarnings: string[] = [];
  resources.manager.onError = (url) => textureWarnings.push(url);
  let parsed: MmdModel | null = null;
  let mesh: SkinnedMesh | null = null;
  try {
    parsed = await loadModelMetadata(modelFile);
    const loader = new MMDLoader(resources.manager);
    mesh = await loader.loadAsync(resources.modelUrl);
    const loadedMesh = mesh;
    const root = new Group();
    root.name = modelFile.name.replace(/\.[^.]+$/, "") || "MMD Model";
    root.add(loadedMesh);

    const helper = new MMDAnimationHelper({ sync: false, resetPhysicsOnLoop: false });
    helper.add(loadedMesh, { animation: EMPTY_ANIMATION, physics: false });
    helper.enable("physics", false);
    const helperInternals = helper as unknown as VanillaHelperInternals;
    const helperObject = helperInternals.objects.get(loadedMesh);
    const mixer = helperObject?.mixer;
    if (!mixer) throw new Error("MMDAnimationHelper did not create an animation mixer");

    const metadata = parsed.metadata();
    const skeleton = parsed.skeleton();
    const morphs = parsed.morphs();
    const boneAliases = new Map<string, string>();
    loadedMesh.skeleton.bones.forEach((bone, index) => {
      boneAliases.set(normalizeMelyBoneName(bone.name), bone.name);
      const englishName = skeleton.bones[index]?.englishName;
      if (englishName) boneAliases.set(normalizeMelyBoneName(englishName), bone.name);
    });
    const morphAliases = new Map<string, string>();
    Object.entries(loadedMesh.morphTargetDictionary ?? {}).forEach(([name]) => {
      morphAliases.set(normalizeMelyBoneName(name), name);
    });
    morphs.forEach((morph, index) => {
      const nativeName = Object.entries(loadedMesh.morphTargetDictionary ?? {})
        .find(([, morphIndex]) => morphIndex === index)?.[0];
      if (!nativeName) return;
      [morph.name, morph.englishName].forEach((name) => {
        if (name) morphAliases.set(normalizeMelyBoneName(name), nativeName);
      });
    });
    const materialMetadata = parsed.materials();
    let ammo: AmmoModule | null = null;
    let capture: AmmoPhysicsCapture | null = null;
    let physicsEnabled = false;
    let physicsRequestId = 0;
    let previousGlobalAmmo: AmmoGlobal;
    let ownsGlobalAmmo = false;
    let disposed = false;

    const driver: ThreeMmdBackendDriver = {
      rendererMode: "vanilla",
      root,
      mesh: loadedMesh,
      mixer,
      metadata: {
        fileName: modelFile.name,
        name: metadata.name,
        englishName: metadata.englishName,
        format: metadata.format,
        rigidBodyCount: metadata.counts.rigidBodies,
        jointCount: metadata.counts.joints,
        boneEnglishNames: skeleton.bones.map((bone) => bone.englishName),
        morphEnglishNames: morphs.map((morph) => morph.englishName),
          materialNames: materialMetadata.map((material) => ({
            name: material.name,
            englishName: material.englishName,
            diffuse: material.diffuse,
            ambient: material.ambient,
          })),
      },
      textureWarnings,
      physicsAvailable: metadata.counts.rigidBodies > 0,
      loadMotionClip: async (file) => loadAnimation(
        new MMDLoader(resources.manager),
        resources.createVirtualFileUrl(file),
        loadedMesh,
        { bones: boneAliases, morphs: morphAliases },
      ),
      evaluate: (deltaSeconds, physics) => {
        if (disposed) return;
        helper.enable("physics", Boolean(physics && physicsEnabled));
        helper.update(Math.max(0, deltaSeconds));
      },
      resetPhysics: () => hardResetAmmoPhysics(ammo, helperObject?.physics),
      setPhysicsEnabled: async (enabled) => {
        if (disposed || !driver.physicsAvailable) return;
        const requestId = ++physicsRequestId;
        physicsEnabled = false;
        helper.enable("physics", false);
        if (!enabled) return;
        if (enabled && !helperObject?.physics) {
          const imported = await import("ammojs-typed");
          if (disposed || requestId !== physicsRequestId) return;
          const ammoFactory = imported.default as unknown as (
            target?: unknown,
          ) => Promise<AmmoModule>;
          const candidate = ammoFactory as unknown as AmmoModule;
          ammo = typeof candidate.btDiscreteDynamicsWorld === "function"
            ? candidate
            : await ammoFactory(candidate);
          if (disposed || requestId !== physicsRequestId || !ammo) return;
          const globalScope = globalThis as typeof globalThis & { Ammo?: AmmoModule };
          if (globalScope.Ammo !== ammo) {
            previousGlobalAmmo = globalScope.Ammo;
            globalScope.Ammo = ammo;
            ownsGlobalAmmo = true;
          }
          const pendingCapture = installAmmoCapture(ammo) as AmmoPhysicsCapture & { restore: () => void };
          try {
            if (disposed || requestId !== physicsRequestId) return;
            helperInternals._setupMeshPhysics(loadedMesh, {
              physics: true,
              warmup: 0,
              unitStep: 1 / 120,
              maxStepNum: 10,
            });
            if (disposed || requestId !== physicsRequestId) {
              helper.enable("physics", false);
              return;
            }
            capture = pendingCapture;
          } finally {
            pendingCapture.restore();
          }
        }
        if (disposed || requestId !== physicsRequestId) return;
        physicsEnabled = enabled;
        helper.enable("physics", enabled);
        if (enabled) hardResetAmmoPhysics(ammo, helperObject?.physics);
      },
      physicsEnabled: () => physicsEnabled,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        ++physicsRequestId;
        physicsEnabled = false;
        helper.enable("physics", false);
        if (ammo) destroyAmmoObjects(ammo, helperObject?.physics, capture);
        const globalScope = globalThis as typeof globalThis & { Ammo?: AmmoModule };
        if (ownsGlobalAmmo && globalScope.Ammo === ammo) {
          globalScope.Ammo = previousGlobalAmmo;
        }
        ownsGlobalAmmo = false;
        helper.remove(loadedMesh);
        parsed?.dispose?.();
        parsed = null;
        resources.dispose();
      },
    };
    return createThreeMmdModel({ driver });
  } catch (error) {
    parsed?.dispose?.();
    resources.dispose();
    throw appError("error.model.loadFailed", undefined, error);
  }
};
