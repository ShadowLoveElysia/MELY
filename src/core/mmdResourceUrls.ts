import { LoadingManager } from "three";
import { normalizeAssetPath } from "./mmdAssets";

const decodeResourcePath = (value: string) => {
  let decoded = value;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
};

const canonicalPath = (value: string) => normalizeAssetPath(
  decodeResourcePath(value).normalize("NFC"),
).replace(/\/+/g, "/");

const pathKey = (value: string) => canonicalPath(value).toLowerCase();

const isExternalOrAbsolutePath = (value: string) => (
  /^(?:[a-z][a-z\d+.-]*:|[\\/]|[a-z]:[\\/])/i.test(value)
);

const addCandidate = (
  index: Map<string, Set<File>>,
  key: string,
  file: File,
) => {
  if (!key) return;
  const candidates = index.get(key) ?? new Set<File>();
  candidates.add(file);
  index.set(key, candidates);
};

const uniqueCandidate = (
  index: ReadonlyMap<string, ReadonlySet<File>>,
  key: string,
) => {
  const candidates = index.get(key);
  return candidates?.size === 1 ? candidates.values().next().value : undefined;
};

const ambiguousCandidate = (
  index: ReadonlyMap<string, ReadonlySet<File>>,
  key: string,
) => (index.get(key)?.size ?? 0) > 1;

const directoryOf = (path: string) => {
  const normalized = canonicalPath(path);
  const slash = normalized.lastIndexOf("/");
  return slash < 0 ? "" : normalized.slice(0, slash + 1);
};

const joinPath = (base: string, relative: string) => {
  const segments = `${base}${relative}`.split("/");
  const resolved: string[] = [];
  let escaped = false;
  segments.forEach((segment) => {
    if (!segment || segment === ".") return;
    if (segment === "..") {
      if (resolved.length === 0) escaped = true;
      else resolved.pop();
    }
    else resolved.push(segment);
  });
  return escaped ? null : resolved.join("/");
};

const safeAssetPath = (value: string) => {
  const decoded = decodeResourcePath(value).normalize("NFC");
  if (isExternalOrAbsolutePath(decoded)) return null;
  const normalized = canonicalPath(decoded);
  return normalized ? joinPath("", normalized) : null;
};

const stripVirtualRoot = (value: string, root: string) => {
  const rootWithoutTrailingSlash = root.endsWith("/") ? root.slice(0, -1) : root;
  if (value === rootWithoutTrailingSlash) return "";
  return value.startsWith(root) ? value.slice(root.length) : value;
};

const pathAfterVirtualRoot = (value: string, root?: string) => {
  const pathWithoutQuery = value.split(/[?#]/, 1)[0] ?? value;
  const decoded = decodeResourcePath(pathWithoutQuery).normalize("NFC");
  return root ? stripVirtualRoot(decoded, root) : decoded;
};

const isVirtualModelUrl = (value: string, root: string) => value.startsWith(root);

const recordMissingPath = (
  missingPaths: string[],
  missingKeys: Set<string>,
  path: string,
) => {
  const key = pathKey(path);
  if (missingKeys.has(key)) return;
  missingKeys.add(key);
  missingPaths.push(canonicalPath(path));
};

export interface MmdResourceUrlBundle {
  readonly modelUrl: string;
  readonly manager: LoadingManager;
  createFileUrl: (file: File) => string;
  createVirtualFileUrl: (file: File) => string;
  resolveFile: (requestedPath: string, modelUrl?: string) => File | undefined;
  /** Waits until all requests in the current LoadingManager batch have ended. */
  waitForLoadCompletion: () => Promise<void>;
  /** Resource issues are reported without turning a missing texture into a model-load failure. */
  readonly warnings: readonly string[];
  readonly missingPaths: readonly string[];
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
  const pathToFiles = new Map<string, Set<File>>();
  const basenameToFiles = new Map<string, Set<File>>();
  const warnings: string[] = [];
  const missingPaths: string[] = [];
  const warningKeys = new Set<string>();
  const missingKeys = new Set<string>();
  const virtualRoot = `mely-mmd/${crypto.randomUUID()}/`;
  let pendingRequests = 0;
  let disposed = false;
  const completionWaiters = new Set<() => void>();
  const modelPath = safeAssetPath(modelFile.webkitRelativePath || modelFile.name) ?? "";
  const baseDirectory = directoryOf(modelPath);

  files.forEach((file) => {
    const rawPath = file.webkitRelativePath || file.name;
    const path = safeAssetPath(rawPath);
    if (!path) return;
    addCandidate(pathToFiles, pathKey(path), file);
    const baseName = path.split("/").pop();
    if (baseName) addCandidate(basenameToFiles, pathKey(baseName), file);
  });

  const reportAmbiguous = (kind: "path" | "basename", value: string) => {
    const warning = `ambiguous ${kind}: ${value}`;
    if (warningKeys.has(warning)) return;
    warningKeys.add(warning);
    warnings.push(warning);
  };

  const createFileUrl = (file: File) => {
    if (disposed) throw new Error("MMD resource URL bundle has been disposed");
    const existing = urls.get(file);
    if (existing) return existing;
    const url = URL.createObjectURL(file);
    urls.set(file, url);
    return url;
  };
  const createVirtualFileUrl = (file: File) => {
    if (disposed) throw new Error("MMD resource URL bundle has been disposed");
    const existing = virtualUrls.get(file);
    if (existing) return existing;
    const suffix = normalizeAssetPath(file.name).split("/").pop() || "asset";
    const url = `${virtualRoot}${virtualUrls.size}-${encodeURIComponent(suffix)}`;
    virtualUrls.set(file, url);
    virtualUrlFiles.set(url, file);
    return url;
  };
  const resolveFile = (requestedPath: string, modelUrl?: string) => {
    if (disposed) return undefined;
    const clean = pathAfterVirtualRoot(
      requestedPath,
      modelUrl && isVirtualModelUrl(modelUrl, virtualRoot) ? virtualRoot : undefined,
    );
    if (isExternalOrAbsolutePath(clean)) return undefined;
    const normalized = canonicalPath(clean);
    if (!normalized) return undefined;
    const relativeToModel = joinPath(baseDirectory, normalized);
    if (relativeToModel === null) {
      const warning = `invalid: ${normalized}`;
      if (!warningKeys.has(warning)) {
        warningKeys.add(warning);
        warnings.push(warning);
      }
      return undefined;
    }
    const relativeKey = pathKey(relativeToModel);
    if (ambiguousCandidate(pathToFiles, relativeKey)) {
      reportAmbiguous("path", relativeKey);
      return undefined;
    }
    let file = uniqueCandidate(pathToFiles, relativeKey);
    if (!file) {
      const normalizedKey = pathKey(normalized);
      if (ambiguousCandidate(pathToFiles, normalizedKey)) {
        reportAmbiguous("path", normalizedKey);
        return undefined;
      }
      file = uniqueCandidate(pathToFiles, normalizedKey);
    }
    if (!file) {
      const basename = normalized.split("/").pop() ?? normalized;
      const basenameKey = pathKey(basename);
      if (ambiguousCandidate(basenameToFiles, basenameKey)) {
        reportAmbiguous("basename", basenameKey);
        return undefined;
      }
      file = uniqueCandidate(basenameToFiles, basenameKey);
    }
    if (!file) recordMissingPath(missingPaths, missingKeys, normalized);
    return file;
  };
  const modelUrl = createVirtualFileUrl(modelFile);
  const manager = new LoadingManager();
  const originalItemStart = manager.itemStart.bind(manager);
  const originalItemEnd = manager.itemEnd.bind(manager);
  manager.itemStart = (url) => {
    pendingRequests += 1;
    originalItemStart(url);
  };
  manager.itemEnd = (url) => {
    try {
      originalItemEnd(url);
    } finally {
      pendingRequests = Math.max(0, pendingRequests - 1);
      if (pendingRequests === 0) {
        completionWaiters.forEach((resolve) => resolve());
        completionWaiters.clear();
      }
    }
  };
  manager.setURLModifier((requestedUrl) => {
    const virtualFile = virtualUrlFiles.get(requestedUrl);
    if (virtualFile) return createFileUrl(virtualFile);
    if (/^(?:blob:|data:|https?:)/i.test(requestedUrl)) return requestedUrl;
    const file = resolveFile(requestedUrl, requestedUrl);
    return file ? createFileUrl(file) : requestedUrl;
  });

  return {
    modelUrl,
    manager,
    createFileUrl,
    createVirtualFileUrl,
    resolveFile,
    waitForLoadCompletion: () => {
      if (disposed || pendingRequests === 0) return Promise.resolve();
      return new Promise<void>((resolve) => completionWaiters.add(resolve));
    },
    warnings,
    missingPaths,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      manager.setURLModifier(undefined);
      completionWaiters.forEach((resolve) => resolve());
      completionWaiters.clear();
      urls.forEach((url) => URL.revokeObjectURL(url));
      urls.clear();
      virtualUrls.clear();
      virtualUrlFiles.clear();
      pathToFiles.clear();
      basenameToFiles.clear();
    },
  };
};
