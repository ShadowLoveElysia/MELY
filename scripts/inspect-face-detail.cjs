const { readFile } = require("node:fs/promises");
const nbt = require("prismarine-nbt");

const files = process.argv.slice(2);
if (files.length < 2) {
  throw new Error("Usage: node scripts/inspect-face-detail.cjs <baseline.litematic> <variant...>");
}

const unpackLong = (value) =>
  (BigInt(value[0] >>> 0) << 32n) | BigInt(value[1] >>> 0);

const unpackState = (longs, index, bitsPerBlock) => {
  const mask = (1n << BigInt(bitsPerBlock)) - 1n;
  const bitOffset = index * bitsPerBlock;
  const longIndex = Math.floor(bitOffset / 64);
  const innerOffset = bitOffset & 63;
  const first = unpackLong(longs[longIndex]);
  const available = 64 - innerOffset;
  if (available >= bitsPerBlock) {
    return Number((first >> BigInt(innerOffset)) & mask);
  }
  const second = unpackLong(longs[longIndex + 1]);
  return Number(((first >> BigInt(innerOffset)) | (second << BigInt(available))) & mask);
};

const stateKey = (state) => {
  const properties = state.Properties
    ? Object.entries(state.Properties)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join(",")
    : "";
  return properties ? `${state.Name}[${properties}]` : state.Name;
};

const decode = async (path) => {
  const bytes = await readFile(path);
  const parsed = await nbt.parse(bytes, "big");
  const root = nbt.simplify(parsed.parsed);
  const blocks = new Map();
  for (const region of Object.values(root.Regions)) {
    const palette = region.BlockStatePalette.map(stateKey);
    const bitsPerBlock = Math.max(2, Math.ceil(Math.log2(palette.length)));
    const { x: sizeX, y: sizeY, z: sizeZ } = region.Size;
    const { x: originX, y: originY, z: originZ } = region.Position;
    const volume = sizeX * sizeY * sizeZ;
    for (let index = 0; index < volume; index += 1) {
      const paletteIndex = unpackState(region.BlockStates, index, bitsPerBlock);
      if (paletteIndex === 0) continue;
      const x = index % sizeX;
      const yz = Math.floor(index / sizeX);
      const z = yz % sizeZ;
      const y = Math.floor(yz / sizeZ);
      blocks.set(`${originX + x},${originY + y},${originZ + z}`, palette[paletteIndex]);
    }
  }
  return { path, blocks };
};

const compare = (baseline, variant) => {
  const missing = [];
  const added = [];
  const changed = [];
  for (const [position, state] of baseline.blocks) {
    const next = variant.blocks.get(position);
    if (next === undefined) missing.push(position);
    else if (next !== state) changed.push({ position, from: state, to: next });
  }
  for (const position of variant.blocks.keys()) {
    if (!baseline.blocks.has(position)) added.push(position);
  }

  const yHistogram = new Map();
  const transitions = new Map();
  for (const entry of changed) {
    const y = Number(entry.position.split(",")[1]);
    yHistogram.set(y, (yHistogram.get(y) ?? 0) + 1);
    const transition = `${entry.from} -> ${entry.to}`;
    transitions.set(transition, (transitions.get(transition) ?? 0) + 1);
  }
  const sortedY = [...yHistogram.entries()].sort((left, right) => left[0] - right[0]);
  const changedBounds = changed.length
    ? changed.reduce((bounds, entry) => {
        const point = entry.position.split(",").map(Number);
        for (let axis = 0; axis < 3; axis += 1) {
          bounds.min[axis] = Math.min(bounds.min[axis], point[axis]);
          bounds.max[axis] = Math.max(bounds.max[axis], point[axis]);
        }
        return bounds;
      }, { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] })
    : null;
  return {
    file: variant.path,
    baselineBlocks: baseline.blocks.size,
    variantBlocks: variant.blocks.size,
    missingCoordinates: missing.length,
    addedCoordinates: added.length,
    changedStates: changed.length,
    changedBounds,
    changedYRange: sortedY.length ? [sortedY[0][0], sortedY.at(-1)[0]] : null,
    busiestYLayers: sortedY
      .sort((left, right) => right[1] - left[1] || left[0] - right[0])
      .slice(0, 20),
    transitions: [...transitions.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 30),
    samples: changed.slice(0, 20),
  };
};

const run = async () => {
  const decoded = [];
  for (const file of files) decoded.push(await decode(file));
  const baseline = decoded[0];
  const report = decoded.slice(1).map((variant) => compare(baseline, variant));
  process.stdout.write(`${JSON.stringify({ baseline: baseline.path, comparisons: report }, null, 2)}\n`);
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
