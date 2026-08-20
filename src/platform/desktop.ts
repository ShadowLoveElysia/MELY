import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview, type DragDropEvent } from "@tauri-apps/api/webview";
import { basename, join } from "@tauri-apps/api/path";
import { open as openDialog, save, type DialogFilter } from "@tauri-apps/plugin-dialog";
import {
  open as openFile,
  readDir,
  readFile,
  stat,
  writeFile,
  type FileHandle,
} from "@tauri-apps/plugin-fs";
import { appError } from "../core/appError";

export interface DesktopSaveOptions {
  defaultPath?: string;
  filters?: DialogFilter[];
}

export interface DesktopOpenOptions {
  defaultPath?: string;
  directory?: boolean;
  filters?: DialogFilter[];
  multiple?: boolean;
  recursive?: boolean;
}

export type DesktopDragDropHandler = (event: DragDropEvent) => void;

export type DesktopSavePathSelector = (options: DesktopSaveOptions) => Promise<string | null>;
export type DesktopByteWriter = (path: string, bytes: Uint8Array) => Promise<void>;

export interface DesktopChunkWriter {
  path: string;
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

export type DesktopFileHandleFactory = (path: string) => Promise<Pick<FileHandle, "write" | "close">>;

const toDesktopFile = async (path: string, relativePath?: string): Promise<File> => {
  const file = new File([await readFile(path)], await basename(path));
  if (relativePath) {
    Object.defineProperty(file, "webkitRelativePath", {
      configurable: true,
      value: relativePath.replaceAll("\\", "/"),
    });
  }
  return file;
};

const readDesktopDirectory = async (path: string, prefix = ""): Promise<File[]> => {
  const files: File[] = [];
  for (const entry of await readDir(path)) {
    const entryPath = await join(path, entry.name);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory) files.push(...await readDesktopDirectory(entryPath, relativePath));
    else if (entry.isFile) files.push(await toDesktopFile(entryPath, relativePath));
  }
  return files;
};

export const isDesktopRuntime = () => isTauri();

export const saveBytesToSelectedPath = async (
  bytes: Uint8Array,
  options: DesktopSaveOptions,
  selectPath: DesktopSavePathSelector,
  writeBytes: DesktopByteWriter,
): Promise<boolean> => {
  let targetPath: string | null;
  try {
    targetPath = await selectPath(options);
  } catch (error) {
    throw appError("error.desktop.selectSavePath", undefined, error);
  }
  if (!targetPath) return false;
  try {
    await writeBytes(targetPath, bytes);
  } catch (error) {
    throw appError("error.desktop.writeFile", undefined, error);
  }
  return true;
};

export const saveBytesWithDesktopDialog = async (
  bytes: Uint8Array,
  options: DesktopSaveOptions = {},
): Promise<boolean> => (
  isDesktopRuntime()
    ? saveBytesToSelectedPath(bytes, options, save, writeFile)
    : false
);

/** 仅选择桌面端保存路径；实际写入可由持有原生结果句柄的 Rust command 完成。 */
export const selectDesktopSavePath = async (
  options: DesktopSaveOptions = {},
): Promise<string | null> => {
  if (!isDesktopRuntime()) return null;
  try {
    return await save(options);
  } catch (error) {
    throw appError("error.desktop.selectSavePath", undefined, error);
  }
};

const writeCompleteChunk = async (
  handle: Pick<FileHandle, "write">,
  chunk: Uint8Array,
) => {
  let written: number;
  try {
    written = await handle.write(chunk);
  } catch (error) {
    throw appError("error.desktop.writeFile", undefined, error);
  }
  if (written !== chunk.byteLength) {
    throw appError("error.desktop.incompleteWrite", {
      written,
      expected: chunk.byteLength,
    });
  }
};

export const openDesktopChunkWriter = async (
  options: DesktopSaveOptions,
  selectPath: DesktopSavePathSelector,
  openHandle: DesktopFileHandleFactory,
): Promise<DesktopChunkWriter | null> => {
  let path: string | null;
  try {
    path = await selectPath(options);
  } catch (error) {
    throw appError("error.desktop.selectSavePath", undefined, error);
  }
  if (!path) return null;
  let handle: Pick<FileHandle, "write" | "close">;
  try {
    handle = await openHandle(path);
  } catch (error) {
    throw appError("error.desktop.openFile", undefined, error);
  }
  let closed = false;
  let queue = Promise.resolve();
  const closeOnce = async () => {
    if (closed) return;
    closed = true;
    await queue.catch(() => undefined);
    try {
      await handle.close();
    } catch (error) {
      throw appError("error.desktop.closeFile", undefined, error);
    }
  };
  return {
    path,
    write: async (chunk) => {
      if (closed) throw appError("error.desktop.streamClosed");
      queue = queue.then(() => writeCompleteChunk(handle, chunk));
      return queue;
    },
    close: closeOnce,
    abort: closeOnce,
  };
};

export const openDesktopChunkWriterWithDialog = async (
  options: DesktopSaveOptions = {},
): Promise<DesktopChunkWriter | null> => {
  if (!isDesktopRuntime()) return null;
  return openDesktopChunkWriter(options, save, (path) => openFile(path, {
    write: true,
    create: true,
    truncate: true,
  }));
};

export const openDesktopPaths = async (
  options: DesktopOpenOptions = {},
): Promise<string[]> => {
  if (!isDesktopRuntime()) return [];
  const selected = await openDialog({
    defaultPath: options.defaultPath,
    directory: options.directory,
    filters: options.filters,
    multiple: options.multiple,
    recursive: options.recursive,
  });
  if (!selected) return [];
  return Array.isArray(selected) ? selected : [selected];
};

export const readDesktopFile = async (path: string): Promise<Uint8Array> => {
  if (!isDesktopRuntime()) {
    throw appError("error.desktop.runtimeRequired");
  }
  try {
    return await readFile(path);
  } catch (error) {
    throw appError("error.desktop.readFile", undefined, error);
  }
};

export const readDesktopAssets = async (paths: readonly string[]): Promise<File[]> => {
  if (!isDesktopRuntime()) {
    throw appError("error.desktop.runtimeRequired");
  }
  try {
    const files: File[] = [];
    for (const path of paths) {
      const info = await stat(path);
      if (info.isDirectory) files.push(...await readDesktopDirectory(path));
      else if (info.isFile) files.push(await toDesktopFile(path));
    }
    return files;
  } catch (error) {
    throw appError("error.desktop.readAssets", undefined, error);
  }
};

export const listenForDesktopDragDrop = async (
  handler: DesktopDragDropHandler,
): Promise<() => void> => {
  if (!isDesktopRuntime()) return () => undefined;
  return getCurrentWebview().onDragDropEvent((event) => handler(event.payload));
};
