const MMD_TEXTURE_FILE_PATTERN = /\.(?:bmp|dds|gif|jpe?g|png|spa|sph|tga|webp)$/i;

const normalizeReferencePath = (path: string) => path
  .replaceAll("\\", "/")
  .replace(/^\.\/+/, "")
  .replace(/^\/+/, "");

const assetPath = (file: File) => normalizeReferencePath(
  file.webkitRelativePath || file.name,
).replace(/\/+$/, "");

const directorySegments = (path: string) => {
  const segments = path.split("/").filter(Boolean);
  segments.pop();
  return segments;
};

const relativeToDirectory = (path: string, directory: readonly string[]) => {
  const segments = path.split("/").filter(Boolean);
  let shared = 0;
  while (
    shared < directory.length
    && shared < segments.length
    && directory[shared].toUpperCase() === segments[shared].toUpperCase()
  ) shared += 1;
  return [
    ...Array.from({ length: directory.length - shared }, () => ".."),
    ...segments.slice(shared),
  ].join("/");
};

const withRelativePath = (source: File, relativePath: string) => {
  const file = new File([source], source.name, {
    type: source.type,
    lastModified: source.lastModified,
  });
  Object.defineProperty(file, "webkitRelativePath", {
    configurable: true,
    value: relativePath,
  });
  return file;
};

export interface BabylonMmdReferenceFiles {
  referenceFiles: File[];
  warnings: string[];
}

/**
 * babylon-mmd resolves File references exclusively through webkitRelativePath.
 * SceneLoader supplies an empty rootUrl for an in-memory model File, so paths
 * must be rebased to the model directory before they reach its resolver.
 */
export const createBabylonMmdReferenceFiles = (
  files: readonly File[],
  modelFile: File,
): BabylonMmdReferenceFiles => {
  const modelDirectory = directorySegments(assetPath(modelFile));
  const referenceFiles: File[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  files.forEach((file) => {
    if (!MMD_TEXTURE_FILE_PATTERN.test(file.name)) return;
    const rebased = file.webkitRelativePath
      ? relativeToDirectory(assetPath(file), modelDirectory)
      : normalizeReferencePath(file.name);
    const key = rebased.toUpperCase();
    if (seen.has(key)) {
      warnings.push(`ambiguous: ${rebased}`);
      return;
    }
    seen.add(key);
    referenceFiles.push(withRelativePath(file, rebased));
  });

  return { referenceFiles, warnings };
};
