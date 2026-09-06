import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview, type DragDropEvent } from "@tauri-apps/api/webview";
import { basename, dirname, join } from "@tauri-apps/api/path";
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

const desktopMimeType = (name: string) => {
  switch (name.split(".").pop()?.toLowerCase()) {
    case "bmp": return "image/bmp";
    case "dds": return "image/vnd-ms.dds";
    case "gif": return "image/gif";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "png": return "image/png";
    case "tga": return "image/x-tga";
    case "webp": return "image/webp";
    default: return "application/octet-stream";
  }
};

const toDesktopFile = async (path: string, relativePath?: string): Promise<File> => {
  const fileName = await basename(path);
  const file = new File([await readFile(path)], fileName, {
    type: desktopMimeType(fileName),
  });
  if (relativePath) {
    Object.defineProperty(file, "webkitRelativePath", {
      configurable: true,
      value: relativePath.replaceAll("\\", "/"),
    });
  }
  return file;
};

const sourcePathKey = (path: string) => path.replaceAll("\\", "/").toLowerCase();

const readDesktopDirectory = async (
  path: string,
  prefix = "",
  seenSourcePaths?: Set<string>,
): Promise<File[]> => {
  const files: File[] = [];
  for (const entry of await readDir(path)) {
    // Do not follow junctions/symlinks while recursively importing a folder.
    // On Windows a directory link can otherwise escape the user-selected tree
    // or point back to an ancestor and recurse indefinitely.
    if (entry.isSymlink) continue;
    const entryPath = await join(path, entry.name);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory) {
      files.push(...await readDesktopDirectory(entryPath, relativePath, seenSourcePaths));
    } else if (entry.isFile) {
      const sourceKey = sourcePathKey(entryPath);
      if (seenSourcePaths?.has(sourceKey)) continue;
      seenSourcePaths?.add(sourceKey);
      files.push(await toDesktopFile(entryPath, relativePath));
    }
  }
  return files;
};

const MMD_MODEL_PATTERN = /\.(?:pmx|pmd)$/i;
const MMD_RESOURCE_PATTERN = /\.(?:bmp|dds|gif|jpe?g|png|spa|sph|tga|webp|vmd)$/i;
const MMD_RESOURCE_DIRECTORY_PATTERN = /^(?:asset|assets|image|images|material|materials|mmd|resource|resources|spa|sph|tex|texture|textures|toon|toons)$/i;

const isMmdModelPath = (path: string) => MMD_MODEL_PATTERN.test(path.split(/[\\/]/).pop() ?? path);

/**
 * A dropped model file is an explicit grant for that file, not its whole
 * directory tree. Read only sibling MMD resources so relative PMX references
 * such as `tex/body.png` can resolve without recursively importing unrelated
 * files from the user's directory.
 */
const readDesktopModelWithSiblings = async (
  path: string,
  seenSourcePaths?: Set<string>,
): Promise<File[]> => {
  const modelName = await basename(path);
  const parentPath = await dirname(path);
  const siblings: File[] = [];
  const appendFile = async (entryPath: string, relativePath: string) => {
    const key = sourcePathKey(entryPath);
    if (seenSourcePaths?.has(key)) return;
    seenSourcePaths?.add(key);
    siblings.push(await toDesktopFile(entryPath, relativePath));
  };
  await appendFile(path, modelName);
  const appendResourceDirectory = async (directoryPath: string, relativePrefix: string) => {
    try {
      for (const resourceEntry of await readDir(directoryPath)) {
        if (resourceEntry.isSymlink) continue;
        const resourcePath = await join(directoryPath, resourceEntry.name);
        const resourceRelativePath = `${relativePrefix}/${resourceEntry.name}`;
        if (resourceEntry.isDirectory) {
          await appendResourceDirectory(resourcePath, resourceRelativePath);
        } else if (resourceEntry.isFile && MMD_RESOURCE_PATTERN.test(resourceEntry.name)) {
          try {
            await appendFile(resourcePath, resourceRelativePath);
          } catch {
            // A supplementary resource may disappear or be unreadable while the model remains valid.
          }
        }
      }
    } catch {
      // Reading an optional resource directory must not prevent the model from loading.
    }
  };
  let parentEntries;
  try {
    parentEntries = await readDir(parentPath);
  } catch {
    return siblings;
  }
  for (const entry of parentEntries) {
    if (entry.isSymlink) continue;
    if (entry.isFile && MMD_RESOURCE_PATTERN.test(entry.name)) {
      const siblingPath = await join(parentPath, entry.name);
      try {
        await appendFile(siblingPath, entry.name);
      } catch {
        // Keep the explicitly dropped model even when an optional sibling cannot be read.
      }
      continue;
    }
    if (!entry.isDirectory) continue;
    const resourceDirectory = await join(parentPath, entry.name);
    if (MMD_RESOURCE_DIRECTORY_PATTERN.test(entry.name)) {
      await appendResourceDirectory(resourceDirectory, entry.name);
    }
  }
  return siblings;
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
    const seenSourcePaths = new Set<string>();
    const roots: Array<{ path: string; info: Awaited<ReturnType<typeof stat>> }> = [];
    for (const path of paths) {
      roots.push({ path, info: await stat(path) });
    }
    const normalizedRootPath = (path: string) => path
      .replaceAll("\\", "/")
      .replace(/\/+$/, "")
      .toLowerCase();
    const pathIsInsideDirectory = (filePath: string, directoryPath: string) => {
      const file = normalizedRootPath(filePath);
      const directory = normalizedRootPath(directoryPath);
      return file === directory || file.startsWith(`${directory}/`);
    };
    const modelRoots = roots.filter((root) => root.info.isFile && isMmdModelPath(root.path));
    const containsModel = (root: (typeof roots)[number]) => root.info.isDirectory
      && modelRoots.some((model) => pathIsInsideDirectory(model.path, root.path));
    // A selected package directory carries authoritative package-relative
    // paths and must be processed before its explicit model root. A standalone
    // resource directory must instead follow the model, otherwise `tex/foo`
    // would be flattened to `foo` and deduplicated before sibling scanning can
    // restore the PMX-relative path.
    const rootPriority = (root: (typeof roots)[number]) => containsModel(root)
      ? 0
      : root.info.isFile && isMmdModelPath(root.path)
        ? 1
        : root.info.isDirectory
          ? 2
          : 3;
    roots.sort((left, right) => {
      const priorityDifference = rootPriority(left) - rootPriority(right);
      if (priorityDifference !== 0) return priorityDifference;
      if (left.info.isDirectory && right.info.isDirectory) {
        const leftDepth = left.path.replaceAll("\\", "/").split("/").filter(Boolean).length;
        const rightDepth = right.path.replaceAll("\\", "/").split("/").filter(Boolean).length;
        if (leftDepth !== rightDepth) return leftDepth - rightDepth;
      }
      return 0;
    });
    for (const { path, info } of roots) {
      if (info.isDirectory) files.push(...await readDesktopDirectory(path, "", seenSourcePaths));
      else if (info.isFile) {
        if (isMmdModelPath(path)) {
          files.push(...await readDesktopModelWithSiblings(path, seenSourcePaths));
        } else {
          const key = sourcePathKey(path);
          if (seenSourcePaths.has(key)) continue;
          seenSourcePaths.add(key);
          files.push(await toDesktopFile(path));
        }
      }
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
