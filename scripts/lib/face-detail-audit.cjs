const { Buffer } = require("node:buffer");
const { readFile } = require("node:fs/promises");
const nbt = require("prismarine-nbt");

const FACE_REGION = {
  horizontal: 1.75,
  verticalMin: -2.05,
  verticalMax: 1.2,
  depthMin: -1.5,
  depthMax: 1.45,
};

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

const pointKey = (point) => point.join(",");

const decodeLitematicBytes = async (bytes, path = "<buffer>") => {
  const { parsed } = await nbt.parse(Buffer.from(bytes), "big");
  const root = nbt.simplify(parsed);
  const blocks = new Map();

  for (const [regionName, region] of Object.entries(root.Regions || {})) {
    const signedSize = [region.Size.x, region.Size.y, region.Size.z];
    if (signedSize.some((value) => !Number.isInteger(value) || value <= 0)) {
      throw new Error(`${path}: region ${regionName} has unsupported non-positive dimensions`);
    }
    const size = signedSize;
    const origin = [region.Position.x, region.Position.y, region.Position.z];
    const palette = region.BlockStatePalette.map(stateKey);
    const bitsPerBlock = Math.max(2, Math.ceil(Math.log2(Math.max(1, palette.length))));
    const volume = size[0] * size[1] * size[2];

    for (let index = 0; index < volume; index += 1) {
      const paletteIndex = unpackState(region.BlockStates, index, bitsPerBlock);
      if (paletteIndex === 0) continue;
      const x = index % size[0];
      const yz = Math.floor(index / size[0]);
      const z = yz % size[2];
      const y = Math.floor(yz / size[2]);
      const position = [origin[0] + x, origin[1] + y, origin[2] + z];
      const key = pointKey(position);
      if (blocks.has(key)) throw new Error(`${path}: overlapping regions contain ${key}`);
      const state = palette[paletteIndex];
      if (!state) throw new Error(`${path}: invalid palette index ${paletteIndex} at ${key}`);
      blocks.set(key, { position, state });
    }
  }

  return {
    path,
    blocks,
    metadata: {
      version: root.Version,
      dataVersion: root.MinecraftDataVersion,
      totalBlocks: root.Metadata?.TotalBlocks,
      dimensions: root.Metadata?.EnclosingSize,
      regionCount: root.Metadata?.RegionCount,
    },
  };
};

const decodeLitematicFile = async (path) =>
  decodeLitematicBytes(await readFile(path), path);

const finiteTuple = (value, length) => Array.isArray(value)
  && value.length === length
  && value.every(Number.isFinite);

const faceFrameFromSidecar = (sidecar) => {
  const source = sidecar?.projectionResult || sidecar;
  const frame = source?.faceFrame;
  if (
    !frame
    || !finiteTuple(frame.origin, 3)
    || !finiteTuple(frame.right, 3)
    || !finiteTuple(frame.up, 3)
    || !finiteTuple(frame.forward, 3)
    || !Number.isFinite(frame.eyeDistance)
    || frame.eyeDistance <= 0
  ) {
    throw new Error("The face sidecar does not contain a valid faceFrame");
  }

  const coordinateSpace = source.coordinateSpace || sidecar.coordinateSpace || "projection-result";
  let origin = [...frame.origin];
  if (coordinateSpace === "projection-result") {
    const bounds = source.bounds || sidecar.bounds;
    if (!bounds || !finiteTuple(bounds.min, 3)) {
      throw new Error("A projection-result faceFrame requires bounds.min for Litematica alignment");
    }
    origin = origin.map((value, axis) => value - bounds.min[axis]);
  } else if (coordinateSpace !== "litematic-local") {
    throw new Error(`Unsupported face sidecar coordinateSpace: ${coordinateSpace}`);
  }

  return {
    origin,
    right: [...frame.right],
    up: [...frame.up],
    forward: [...frame.forward],
    eyeDistance: frame.eyeDistance,
    confidence: frame.confidence,
  };
};

const dot = (left, right) =>
  left[0] * right[0] + left[1] * right[1] + left[2] * right[2];

const faceLocalPoint = (position, frame) => {
  const relative = position.map((value, axis) => value - frame.origin[axis]);
  return {
    horizontal: dot(relative, frame.right) / frame.eyeDistance,
    vertical: dot(relative, frame.up) / frame.eyeDistance,
    depth: dot(relative, frame.forward) / frame.eyeDistance,
  };
};

const insideFaceRegion = (point) =>
  Math.abs(point.horizontal) <= FACE_REGION.horizontal
  && point.vertical >= FACE_REGION.verticalMin
  && point.vertical <= FACE_REGION.verticalMax
  && point.depth >= FACE_REGION.depthMin
  && point.depth <= FACE_REGION.depthMax;

const faceCellKey = (point, frame) =>
  `${Math.round(point.horizontal * frame.eyeDistance)},${Math.round(point.vertical * frame.eyeDistance)}`;

const buildFrontFaceCells = (projection, frame) => {
  const cells = new Map();
  for (const block of projection.blocks.values()) {
    const local = faceLocalPoint(block.position, frame);
    if (!insideFaceRegion(local)) continue;
    const key = faceCellKey(local, frame);
    const existing = cells.get(key);
    if (!existing || local.depth > existing.local.depth) {
      cells.set(key, { ...block, local, cellKey: key });
    }
  }
  return cells;
};

const featureZone = (point) => {
  if (point.vertical > 0.3 && point.vertical <= 0.9) return "brow";
  if (point.vertical >= -0.65 && point.vertical <= 0.3) return "eye";
  if (point.vertical >= -1.8 && point.vertical < -0.65) return "mouth";
  return "overlay";
};

const sideOfFace = (horizontal, frame) => {
  const tolerance = 0.25 / frame.eyeDistance;
  if (horizontal < -tolerance) return "negative";
  if (horizontal > tolerance) return "positive";
  return "center";
};

const increment = (map, key) => map.set(key, (map.get(key) || 0) + 1);

const sortedCounts = (map) => [...map.entries()]
  .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
  .map(([value, count]) => ({ value, count }));

const candidateSummary = (offCells, variantCells, frame) => {
  const changed = [];
  const zoneCounts = new Map();
  const stateCounts = new Map();
  const zoneStateCounts = new Map();
  const transitionCounts = new Map();
  const sideCounts = new Map();

  for (const [key, baseline] of offCells) {
    const variant = variantCells.get(key);
    if (!variant || baseline.state === variant.state) continue;
    const zone = featureZone(variant.local);
    const side = sideOfFace(variant.local.horizontal, frame);
    const entry = {
      cellKey: key,
      position: variant.position,
      horizontal: variant.local.horizontal,
      vertical: variant.local.vertical,
      depth: variant.local.depth,
      zone,
      side,
      from: baseline.state,
      to: variant.state,
    };
    changed.push(entry);
    increment(zoneCounts, zone);
    increment(stateCounts, variant.state);
    let statesForZone = zoneStateCounts.get(zone);
    if (!statesForZone) {
      statesForZone = new Map();
      zoneStateCounts.set(zone, statesForZone);
    }
    increment(statesForZone, variant.state);
    increment(transitionCounts, `${baseline.state} -> ${variant.state}`);
    increment(sideCounts, side);
  }

  return {
    changed,
    changedVisibleFaceCells: changed.length,
    zones: Object.fromEntries(["eye", "brow", "mouth", "overlay"].map((zone) => [
      zone,
      zoneCounts.get(zone) || 0,
    ])),
    sides: Object.fromEntries(["negative", "center", "positive"].map((side) => [
      side,
      sideCounts.get(side) || 0,
    ])),
    candidateStates: sortedCounts(stateCounts),
    candidateStatesByZone: Object.fromEntries(
      ["eye", "brow", "mouth", "overlay"].map((zone) => [
        zone,
        sortedCounts(zoneStateCounts.get(zone) || new Map()),
      ]),
    ),
    transitions: sortedCounts(transitionCounts),
    samples: changed.slice(0, 24),
  };
};

const midlineCrossingComponents = (changed) => {
  const eyeSideThreshold = 0.4;
  const candidates = changed.filter(({ zone }) => zone === "eye" || zone === "brow");
  const byState = new Map();
  for (const candidate of candidates) {
    let stateCells = byState.get(candidate.to);
    if (!stateCells) {
      stateCells = new Map();
      byState.set(candidate.to, stateCells);
    }
    stateCells.set(candidate.cellKey, candidate);
  }

  const crossings = [];
  for (const [state, stateCells] of byState) {
    const remaining = new Set(stateCells.keys());
    while (remaining.size) {
      const first = remaining.values().next().value;
      remaining.delete(first);
      const queue = [first];
      const component = [];
      while (queue.length) {
        const key = queue.pop();
        const cell = stateCells.get(key);
        component.push(cell);
        const [horizontal, vertical] = key.split(",").map(Number);
        for (let dv = -1; dv <= 1; dv += 1) {
          for (let dh = -1; dh <= 1; dh += 1) {
            if (dh === 0 && dv === 0) continue;
            const neighbor = `${horizontal + dh},${vertical + dv}`;
            if (!remaining.delete(neighbor)) continue;
            queue.push(neighbor);
          }
        }
      }
      const horizontalBounds = component.reduce(
        ([minimum, maximum], cell) => [
          Math.min(minimum, cell.horizontal),
          Math.max(maximum, cell.horizontal),
        ],
        [Infinity, -Infinity],
      );
      if (
        horizontalBounds[0] <= -eyeSideThreshold
        && horizontalBounds[1] >= eyeSideThreshold
      ) {
        crossings.push({
          state,
          cellCount: component.length,
          bounds: component.reduce((bounds, cell) => ({
            horizontal: [
              Math.min(bounds.horizontal[0], cell.horizontal),
              Math.max(bounds.horizontal[1], cell.horizontal),
            ],
            vertical: [
              Math.min(bounds.vertical[0], cell.vertical),
              Math.max(bounds.vertical[1], cell.vertical),
            ],
          }), { horizontal: [Infinity, -Infinity], vertical: [Infinity, -Infinity] }),
        });
      }
    }
  }
  return crossings;
};

const compareCoordinateSets = (baseline, variant) => {
  const missing = [];
  const added = [];
  for (const key of baseline.blocks.keys()) {
    if (!variant.blocks.has(key) && missing.length < 24) missing.push(key);
  }
  for (const key of variant.blocks.keys()) {
    if (!baseline.blocks.has(key) && added.length < 24) added.push(key);
  }
  return {
    equal: baseline.blocks.size === variant.blocks.size && missing.length === 0 && added.length === 0,
    baselineCount: baseline.blocks.size,
    variantCount: variant.blocks.size,
    missingCount: [...baseline.blocks.keys()].filter((key) => !variant.blocks.has(key)).length,
    addedCount: [...variant.blocks.keys()].filter((key) => !baseline.blocks.has(key)).length,
    missingSamples: missing,
    addedSamples: added,
  };
};

const auditFaceDetailVariants = ({ off, balanced, strong, faceFrame }) => {
  const balancedCoordinates = compareCoordinateSets(off, balanced);
  const strongCoordinates = compareCoordinateSets(off, strong);
  const structuralAssertions = {
    balancedCoordinatesMatchOff: balancedCoordinates.equal,
    strongCoordinatesMatchOff: strongCoordinates.equal,
  };

  if (!faceFrame) {
    return {
      conclusive: false,
      passed: false,
      reason: "faceFrame sidecar is required for visible-face analysis",
      coordinates: { balanced: balancedCoordinates, strong: strongCoordinates },
      assertions: structuralAssertions,
    };
  }

  const offCells = buildFrontFaceCells(off, faceFrame);
  const balancedCells = buildFrontFaceCells(balanced, faceFrame);
  const strongCells = buildFrontFaceCells(strong, faceFrame);
  const balancedCandidates = candidateSummary(offCells, balancedCells, faceFrame);
  const strongCandidates = candidateSummary(offCells, strongCells, faceFrame);
  const balancedCrossings = midlineCrossingComponents(balancedCandidates.changed);
  const strongCrossings = midlineCrossingComponents(strongCandidates.changed);
  const assertions = {
    ...structuralAssertions,
    frontFaceCellCountsMatch:
      offCells.size === balancedCells.size && offCells.size === strongCells.size,
    balancedHasVisibleCandidates: balancedCandidates.changedVisibleFaceCells > 0,
    strongHasVisibleCandidates: strongCandidates.changedVisibleFaceCells > 0,
    strongAtLeastBalanced:
      strongCandidates.changedVisibleFaceCells >= balancedCandidates.changedVisibleFaceCells,
    strongEyeBrowAtLeastBalanced:
      strongCandidates.zones.eye + strongCandidates.zones.brow
        >= balancedCandidates.zones.eye + balancedCandidates.zones.brow,
    balancedEyeBrowDoesNotCrossMidline: balancedCrossings.length === 0,
    strongEyeBrowDoesNotCrossMidline: strongCrossings.length === 0,
  };

  return {
    conclusive: true,
    passed: Object.values(assertions).every(Boolean),
    faceFrame,
    coordinates: { balanced: balancedCoordinates, strong: strongCoordinates },
    visibleFace: {
      offCellCount: offCells.size,
      balanced: { ...balancedCandidates, changed: undefined },
      strong: { ...strongCandidates, changed: undefined },
      midlineCrossings: {
        balanced: balancedCrossings,
        strong: strongCrossings,
      },
    },
    assertions,
    interpretation: {
      candidateDefinition:
        "Candidate colors are block-state changes from off on the foremost faceFrame tangent cell.",
      zones:
        "Eye, brow, mouth, and overlay are spatial diagnostic bands, not recovered PMX material semantics.",
      midline:
        "The midline assertion detects same-state eye/brow components that bridge both normalized eye-side regions across the face center.",
      visualConclusion:
        "This audit proves structural invariants and candidate distribution; it does not prove that the face is aesthetically better.",
    },
  };
};

module.exports = {
  auditFaceDetailVariants,
  buildFrontFaceCells,
  decodeLitematicBytes,
  decodeLitematicFile,
  faceFrameFromSidecar,
};
