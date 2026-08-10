import {
  createCustomBulletMmdPhysicsBackend,
  type CustomBulletMmdModule,
  type MmdPhysicsBackend,
  type MmdPhysicsResetContext,
  type MmdPhysicsStepContext,
  type MmdPhysicsStepResult,
} from "@yohawing/three-mmd-loader/physics";

interface MmdBulletFactoryOptions {
  locateFile?: (path: string) => string;
}

type MmdBulletFactory = (
  options?: MmdBulletFactoryOptions,
) => CustomBulletMmdModule | Promise<CustomBulletMmdModule>;

declare global {
  var MmdBullet: MmdBulletFactory | undefined;
}

let modulePromise: Promise<CustomBulletMmdModule> | null = null;

const installMmdBulletFactory = async () => {
  if (typeof globalThis.MmdBullet === "function") return globalThis.MmdBullet;
  if (typeof document === "undefined") {
    throw new Error("MMD Bullet physics requires a browser document.");
  }

  const { default: source } = await import(
    "../../node_modules/@yohawing/three-mmd-loader/dist/physics/mmd/mmd_bullet.js?raw"
  );
  const scriptUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.async = true;
      script.src = scriptUrl;
      script.onload = () => {
        script.remove();
        resolve();
      };
      script.onerror = () => {
        script.remove();
        reject(new Error("Failed to initialize the MMD Bullet script."));
      };
      document.head.appendChild(script);
    });
  } finally {
    URL.revokeObjectURL(scriptUrl);
  }

  if (typeof globalThis.MmdBullet !== "function") {
    throw new Error("MMD Bullet factory was not registered.");
  }
  return globalThis.MmdBullet;
};

const loadMmdBulletModule = () => {
  modulePromise ??= (async () => {
    const [{ default: wasmUrl }, factory] = await Promise.all([
      import("../../node_modules/@yohawing/three-mmd-loader/dist/physics/mmd/mmd_bullet.wasm?url"),
      installMmdBulletFactory(),
    ]);
    return factory({
      locateFile: (path) => path.endsWith(".wasm") ? wasmUrl : path,
    });
  })().catch((error) => {
    modulePromise = null;
    throw error;
  });
  return modulePromise;
};

export interface SwitchableMmdPhysicsBackend extends MmdPhysicsBackend {
  readonly enabled: boolean;
  setEnabled: (enabled: boolean) => Promise<void>;
  setFixedStepOverride: (deltaSeconds: number | null) => void;
}

export const createSwitchableMmdPhysicsBackend = (): SwitchableMmdPhysicsBackend => {
  let active = false;
  let disposed = false;
  let backend: MmdPhysicsBackend | null = null;
  let fixedStepOverride: number | null = null;

  return {
    name: "mely-switchable-bullet",
    get enabled() {
      return active;
    },
    get disabled() {
      return !active || backend === null || backend.disabled;
    },
    get disposed() {
      return disposed;
    },
    setEnabled: async (enabled) => {
      if (disposed) throw new Error("MMD physics backend has been disposed.");
      if (!enabled) {
        active = false;
        backend?.reset?.();
        return;
      }
      if (!backend) {
        const module = await loadMmdBulletModule();
        if (disposed) return;
        backend = createCustomBulletMmdPhysicsBackend(module, {
          fixedTimeStep: 1 / 60,
          maxSubSteps: 5,
        });
      }
      backend.reset?.();
      active = true;
    },
    setFixedStepOverride: (deltaSeconds) => {
      fixedStepOverride = deltaSeconds === null
        ? null
        : Math.max(0, deltaSeconds);
    },
    step: (context: MmdPhysicsStepContext): MmdPhysicsStepResult => {
      if (!active || !backend || disposed) return { simulated: false };
      return backend.step(fixedStepOverride === null
        ? context
        : { ...context, deltaSeconds: fixedStepOverride });
    },
    reset: (context?: MmdPhysicsResetContext) => {
      if (!disposed) backend?.reset?.(context);
    },
    diagnostics: () => backend?.diagnostics?.() ?? [],
    debugRigidBodyWorldTransformsColumnMajor: () => (
      backend?.debugRigidBodyWorldTransformsColumnMajor?.() ?? []
    ),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      active = false;
      fixedStepOverride = null;
      backend?.dispose?.();
      backend = null;
    },
  };
};
