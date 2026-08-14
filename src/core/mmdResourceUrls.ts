import { LoadingManager } from "three";
import { normalizeAssetPath } from "./mmdAssets";

const decodedPath = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const directoryOf = (path: string) => {
  const normalized = normalizeAssetPath(path);
  const slash = normalized.lastIndexOf("/");
  return slash < 0 ? "" : normalized.slice(0, slash + 1);
};

const joinPath = (base: string, relative: string) => {
  const segments = `${base}${relative}`.replaceAll("\\", "/").split("/");
  const resolved: string[] = [];
  segments.forEach((segment) => {
    if (!segment || segment === ".") return;
    if (segment === "..") resolved.pop();
    else resolved.push(segment);
  });
  return resolved.join("/");
};

export interface MmdResourceUrlBundle {
  readonly modelUrl: string;
  readonly manager: LoadingManager;
  createFileUrl: (file: File) => string;
  createVirtualFileUrl: (file: File) => string;
  dispose: () => void;
}

/**
 * Binds a local MMD package to Three.js loaders. URL modifiers resolve texture
 * paths from PMX/PMD files and every created Blob URL is revoked on disposal.
 */
export const createMmdResourceUrlBundle = (
  files: readonly File[],
  modelFile: File,
): MmdResourceUrlBundle => {
  const urls = new Map<File, string>();
  const virtualUrls = new Map<File, string>();
  const virtualUrlFiles = new Map<string, File>();
  const pathToFile = new Map<string, File>();
  const virtualRoot = `mely-mmd/${crypto.randomUUID()}/`;
  const baseDirectory = directoryOf(modelFile.webkitRelativePath || modelFile.name);

  files.forEach((file) => {
    const path = normalizeAssetPath(file.webkitRelativePath || file.name);
    pathToFile.set(path.toLowerCase(), file);
    const baseName = path.split("/").pop();
    if (baseName && !pathToFile.has(baseName.toLowerCase())) {
      pathToFile.set(baseName.toLowerCase(), file);
    }
  });

  const createFileUrl = (file: File) => {
    const existing = urls.get(file);
    if (existing) return existing;
    const url = URL.createObjectURL(file);
    urls.set(file, url);
    return url;
  };
  const createVirtualFileUrl = (file: File) => {
    const existing = virtualUrls.get(file);
    if (existing) return existing;
    const suffix = normalizeAssetPath(file.name).split("/").pop() || "asset";
    const url = `${virtualRoot}${virtualUrls.size}-${encodeURIComponent(suffix)}`;
    virtualUrls.set(file, url);
    virtualUrlFiles.set(url, file);
    return url;
  };
  const modelUrl = createVirtualFileUrl(modelFile);
  const manager = new LoadingManager();
  manager.setURLModifier((requestedUrl) => {
    const virtualFile = virtualUrlFiles.get(requestedUrl);
    if (virtualFile) return createFileUrl(virtualFile);
    if (/^(?:blob:|data:|https?:)/i.test(requestedUrl)) return requestedUrl;
    const decoded = decodedPath(requestedUrl).split(/[?#]/, 1)[0] ?? requestedUrl;
    const clean = decoded.startsWith(virtualRoot) ? decoded.slice(virtualRoot.length) : decoded;
    const normalized = normalizeAssetPath(clean);
    const relativeToModel = joinPath(baseDirectory, normalized);
    const file = pathToFile.get(relativeToModel.toLowerCase())
      ?? pathToFile.get(normalized.toLowerCase())
      ?? pathToFile.get((normalized.split("/").pop() ?? normalized).toLowerCase());
    return file ? createFileUrl(file) : requestedUrl;
  });

  return {
    modelUrl,
    manager,
    createFileUrl,
    createVirtualFileUrl,
    dispose: () => {
      manager.setURLModifier(undefined);
      urls.forEach((url) => URL.revokeObjectURL(url));
      urls.clear();
      virtualUrls.clear();
      virtualUrlFiles.clear();
      pathToFile.clear();
    },
  };
};
