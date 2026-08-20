import type { InvokeArgs } from "@tauri-apps/api/core";
import { TauriSolidVoxelClientError } from "./tauriSolidVoxelError";

export { TauriSolidVoxelClientError } from "./tauriSolidVoxelError";
export type { TauriSolidVoxelClientErrorKind } from "./tauriSolidVoxelError";

export interface TauriSolidVoxelCoreApi {
  isTauri(): boolean;
  invoke<T>(command: string, args?: InvokeArgs): Promise<T>;
}

export type TauriSolidVoxelCoreLoader = () => Promise<TauriSolidVoxelCoreApi>;

export interface TauriSolidVoxelTransport {
  invokeJson(command: string, args?: Record<string, unknown>): Promise<unknown>;
  invokeRaw(command: string, bytes: Uint8Array): Promise<unknown>;
  invokeRawResponse(command: string, args?: Record<string, unknown>): Promise<Uint8Array>;
}

const RUNTIME_PROBE_COMMAND = "create_solid_voxel_job";

const defaultCoreLoader: TauriSolidVoxelCoreLoader = async () => {
  const core = await import("@tauri-apps/api/core");
  return {
    isTauri: core.isTauri,
    invoke: (command, args) => core.invoke(command, args),
  };
};

const requireRawResponse = (command: string, response: unknown): Uint8Array => {
  if (response instanceof Uint8Array) return response;
  throw new TauriSolidVoxelClientError(
    "protocol",
    command,
    "Raw Tauri responses must be a top-level Uint8Array. Encode metadata, cursor and bytes "
      + "inside one versioned binary envelope; Tauri v2 invoke does not provide a portable "
      + "metadata-plus-bytes response contract.",
  );
};

/**
 * Tauri v2 中 raw request 只能是顶层 typed array。raw response 同样只接受单一
 * Uint8Array envelope，游标与完成标志由版本化二进制协议承载。
 */
export const createTauriSolidVoxelTransport = (
  core: TauriSolidVoxelCoreApi,
): TauriSolidVoxelTransport => ({
  invokeJson: (command, args) => core.invoke<unknown>(command, args),

  invokeRaw: (command, bytes) => {
    return core.invoke<unknown>(command, bytes);
  },

  async invokeRawResponse(command, args) {
    const response = await core.invoke<unknown>(command, args);
    return requireRawResponse(command, response);
  },
});

export const createDefaultTauriSolidVoxelTransport = async (
  loadCore: TauriSolidVoxelCoreLoader = defaultCoreLoader,
): Promise<TauriSolidVoxelTransport> => {
  let core: TauriSolidVoxelCoreApi;
  try {
    core = await loadCore();
    if (!core.isTauri()) {
      throw new TauriSolidVoxelClientError(
        "runtime-unavailable",
        RUNTIME_PROBE_COMMAND,
        "Tauri native runtime is unavailable",
      );
    }
  } catch (error) {
    if (error instanceof TauriSolidVoxelClientError) throw error;
    throw new TauriSolidVoxelClientError(
      "runtime-unavailable",
      RUNTIME_PROBE_COMMAND,
      "Tauri native runtime is unavailable",
      { cause: error },
    );
  }
  return createTauriSolidVoxelTransport(core);
};
