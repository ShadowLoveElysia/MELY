import type { MmdMeshSnapshot } from "../types";

export type SolidVoxelPoint = readonly [number, number, number];
export type SolidVoxelAxis = 0 | 1 | 2;
export type SolidVoxelCandidateVisitor = (x: number, y: number, z: number) => void | boolean;

export interface SolidVoxelScanControls {
  onWork?: (workUnits: number) => void | boolean;
  interval?: number;
}

export interface TriangleVoxelBounds {
  minimum: [number, number, number];
  maximum: [number, number, number];
  candidateCount: number;
  saturated: boolean;
}

export interface TriangleVoxelScanResult {
  candidateCount: number;
  dominantAxis: SolidVoxelAxis | null;
  saturated: boolean;
  completed: boolean;
  workUnits: number;
}

export interface SolidVoxelWorkEstimate {
  triangleCandidateUpperBounds: Float64Array;
  totalCandidateUpperBound: number;
  maxTriangleCandidateUpperBound: number;
  maxTriangleIndex: number;
  legacyAabbCandidateTests: number;
  maxLegacyAabbCandidateTests: number;
  saturated: boolean;
}

const SATURATION_LIMIT = Number.MAX_SAFE_INTEGER;
const DEGENERATE_NORMAL_SQUARED = 1e-12;

const checkedPositiveSpan = (minimum: number, maximum: number) => {
  if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum)) {
    throw new RangeError("Solid voxel triangle bounds exceed safe coordinates");
  }
  const span = maximum - minimum + 1;
  if (!Number.isSafeInteger(span) || span <= 0) {
    throw new RangeError("Solid voxel triangle bounds exceed safe arithmetic");
  }
  return span;
};

const saturatingProduct = (spans: readonly number[]) => {
  let product = 1;
  for (const span of spans) {
    if (product > SATURATION_LIMIT / span) {
      return { value: SATURATION_LIMIT, saturated: true };
    }
    product *= span;
  }
  return { value: product, saturated: false };
};

const saturatingAdd = (left: number, right: number) => left > SATURATION_LIMIT - right
  ? { value: SATURATION_LIMIT, saturated: true }
  : { value: left + right, saturated: false };

/** 旧版三维扫描的候选边界，仅用于退化回退和性能诊断。 */
export const triangleVoxelBounds = (
  a: SolidVoxelPoint,
  b: SolidVoxelPoint,
  c: SolidVoxelPoint,
  halfSize: number,
): TriangleVoxelBounds => {
  if (!Number.isFinite(halfSize) || halfSize < 0) {
    throw new RangeError("Solid voxel half size must be finite and non-negative");
  }
  for (const vertex of [a, b, c]) {
    if (vertex.some(value => !Number.isFinite(value))) {
      throw new RangeError("Solid voxel triangle contains a non-finite vertex");
    }
  }
  const minimum: [number, number, number] = [
    Math.ceil(Math.min(a[0], b[0], c[0]) - halfSize),
    Math.ceil(Math.min(a[1], b[1], c[1]) - halfSize),
    Math.ceil(Math.min(a[2], b[2], c[2]) - halfSize),
  ];
  const maximum: [number, number, number] = [
    Math.floor(Math.max(a[0], b[0], c[0]) + halfSize),
    Math.floor(Math.max(a[1], b[1], c[1]) + halfSize),
    Math.floor(Math.max(a[2], b[2], c[2]) + halfSize),
  ];
  const spans = minimum.map((value, axis) => checkedPositiveSpan(value, maximum[axis]));
  const product = saturatingProduct(spans);
  return {
    minimum,
    maximum,
    candidateCount: product.value,
    saturated: product.saturated,
  };
};

const cross = (a: SolidVoxelPoint, b: SolidVoxelPoint, c: SolidVoxelPoint) => {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const;
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]] as const;
  return [
    ab[1] * ac[2] - ab[2] * ac[1],
    ab[2] * ac[0] - ab[0] * ac[2],
    ab[0] * ac[1] - ab[1] * ac[0],
  ] as const;
};

const dominantAxis = (normal: SolidVoxelPoint): SolidVoxelAxis => {
  const absolute = normal.map(Math.abs);
  return absolute[0] >= absolute[1] && absolute[0] >= absolute[2]
    ? 0
    : absolute[1] >= absolute[2] ? 1 : 2;
};

const projectedAxes = (w: SolidVoxelAxis): readonly [SolidVoxelAxis, SolidVoxelAxis] => (
  w === 0 ? [1, 2] : w === 1 ? [0, 2] : [0, 1]
);

const projectionOverlapsCell = (
  triangle: readonly (readonly [number, number])[],
  centerU: number,
  centerV: number,
  halfSize: number,
) => {
  const axes: [number, number][] = [[1, 0], [0, 1]];
  for (let index = 0; index < 3; index += 1) {
    const first = triangle[index];
    const second = triangle[(index + 1) % 3];
    axes.push([-(second[1] - first[1]), second[0] - first[0]]);
  }
  for (const [axisU, axisV] of axes) {
    const lengthSquared = axisU * axisU + axisV * axisV;
    if (lengthSquared < 1e-20) continue;
    let minimum = Infinity;
    let maximum = -Infinity;
    for (const point of triangle) {
      const projection = point[0] * axisU + point[1] * axisV;
      minimum = Math.min(minimum, projection);
      maximum = Math.max(maximum, projection);
    }
    const center = centerU * axisU + centerV * axisV;
    const radius = halfSize * (Math.abs(axisU) + Math.abs(axisV));
    const tolerance = Number.EPSILON * 32 * Math.max(
      1,
      Math.abs(minimum),
      Math.abs(maximum),
      Math.abs(center),
      radius,
    );
    if (minimum > center + radius + tolerance || maximum < center - radius - tolerance) {
      return false;
    }
  }
  return true;
};

const visitAabbCandidates = (
  bounds: TriangleVoxelBounds,
  visitor?: SolidVoxelCandidateVisitor,
  controls?: SolidVoxelScanControls,
): TriangleVoxelScanResult => {
  if (!visitor) {
    return {
      candidateCount: bounds.candidateCount,
      dominantAxis: null,
      saturated: bounds.saturated,
      completed: true,
      workUnits: bounds.candidateCount,
    };
  }
  const interval = Math.max(1, Math.floor(controls?.interval ?? 4_096));
  let candidateCount = 0;
  let workUnits = 0;
  let nextControlAt = interval;
  for (let y = bounds.minimum[1]; y <= bounds.maximum[1]; y += 1) {
    for (let z = bounds.minimum[2]; z <= bounds.maximum[2]; z += 1) {
      for (let x = bounds.minimum[0]; x <= bounds.maximum[0]; x += 1) {
        workUnits += 1;
        if (workUnits >= nextControlAt) {
          if (controls?.onWork?.(workUnits) === false) {
            return {
              candidateCount,
              dominantAxis: null,
              saturated: false,
              completed: false,
              workUnits,
            };
          }
          nextControlAt = workUnits + interval;
        }
        candidateCount += 1;
        if (visitor(x, y, z) === false) {
          return {
            candidateCount,
            dominantAxis: null,
            saturated: false,
            completed: false,
            workUnits,
          };
        }
      }
    }
  }
  controls?.onWork?.(workUnits);
  return { candidateCount, dominantAxis: null, saturated: false, completed: true, workUnits };
};

const distanceSquared = (a: SolidVoxelPoint, b: SolidVoxelPoint) => (
  (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2 + (b[2] - a[2]) ** 2
);

const visitDegenerateCandidates = (
  a: SolidVoxelPoint,
  b: SolidVoxelPoint,
  c: SolidVoxelPoint,
  halfSize: number,
  visitor?: SolidVoxelCandidateVisitor,
  controls?: SolidVoxelScanControls,
): TriangleVoxelScanResult => {
  const pairs = [
    [a, b, distanceSquared(a, b)],
    [b, c, distanceSquared(b, c)],
    [c, a, distanceSquared(c, a)],
  ] as const;
  const longest = pairs.reduce((best, candidate) => candidate[2] > best[2] ? candidate : best);
  if (longest[2] < DEGENERATE_NORMAL_SQUARED) {
    return visitAabbCandidates(triangleVoxelBounds(a, a, a, halfSize), visitor, controls);
  }
  const start = longest[0];
  const end = longest[1];
  const direction = [
    end[0] - start[0],
    end[1] - start[1],
    end[2] - start[2],
  ] as const;
  const axis = dominantAxis(direction);
  const [u, v] = projectedAxes(axis);
  const minimumAxis = Math.ceil(Math.min(start[axis], end[axis]) - halfSize);
  const maximumAxis = Math.floor(Math.max(start[axis], end[axis]) + halfSize);
  checkedPositiveSpan(minimumAxis, maximumAxis);
  const interval = Math.max(1, Math.floor(controls?.interval ?? 4_096));
  let nextControlAt = interval;
  let candidateCount = 0;
  let workUnits = 0;
  for (let centerAxis = minimumAxis; centerAxis <= maximumAxis; centerAxis += 1) {
    const t = Math.max(0, Math.min(1, (centerAxis - start[axis]) / direction[axis]));
    const centerU = start[u] + direction[u] * t;
    const centerV = start[v] + direction[v] * t;
    const minimumU = Math.ceil(centerU - halfSize * 2);
    const maximumU = Math.floor(centerU + halfSize * 2);
    const minimumV = Math.ceil(centerV - halfSize * 2);
    const maximumV = Math.floor(centerV + halfSize * 2);
    for (let voxelV = minimumV; voxelV <= maximumV; voxelV += 1) {
      for (let voxelU = minimumU; voxelU <= maximumU; voxelU += 1) {
        workUnits += 1;
        if (workUnits >= nextControlAt) {
          if (controls?.onWork?.(workUnits) === false) {
            return { candidateCount, dominantAxis: axis, saturated: false, completed: false, workUnits };
          }
          nextControlAt = workUnits + interval;
        }
        candidateCount += 1;
        if (visitor) {
          const point: [number, number, number] = [0, 0, 0];
          point[axis] = centerAxis;
          point[u] = voxelU;
          point[v] = voxelV;
          if (visitor(point[0], point[1], point[2]) === false) {
            return { candidateCount, dominantAxis: axis, saturated: false, completed: false, workUnits };
          }
        }
      }
    }
  }
  controls?.onWork?.(workUnits);
  return { candidateCount, dominantAxis: axis, saturated: false, completed: true, workUnits };
};

/**
 * 沿三角形主法线轴做二维保守扫描，再从平面范围恢复第三轴。
 * visitor 返回 false 时可在大三角形内部立即取消。
 */
export const visitTriangleVoxelCandidates = (
  a: SolidVoxelPoint,
  b: SolidVoxelPoint,
  c: SolidVoxelPoint,
  halfSize: number,
  visitor?: SolidVoxelCandidateVisitor,
  controls?: SolidVoxelScanControls,
): TriangleVoxelScanResult => {
  const legacyBounds = triangleVoxelBounds(a, b, c, halfSize);
  const normal = cross(a, b, c);
  const normalSquared = normal[0] ** 2 + normal[1] ** 2 + normal[2] ** 2;
  if (!Number.isFinite(normalSquared) || normalSquared < DEGENERATE_NORMAL_SQUARED) {
    return visitDegenerateCandidates(a, b, c, halfSize, visitor, controls);
  }
  const w = dominantAxis(normal);
  const [u, v] = projectedAxes(w);
  const triangle = [a, b, c].map(point => [point[u], point[v]] as const);
  const minimumU = Math.ceil(Math.min(...triangle.map(point => point[0])) - halfSize);
  const maximumU = Math.floor(Math.max(...triangle.map(point => point[0])) + halfSize);
  const minimumV = Math.ceil(Math.min(...triangle.map(point => point[1])) - halfSize);
  const maximumV = Math.floor(Math.max(...triangle.map(point => point[1])) + halfSize);
  checkedPositiveSpan(minimumU, maximumU);
  checkedPositiveSpan(minimumV, maximumV);

  let candidateCount = 0;
  let saturated = false;
  let workUnits = 0;
  const interval = Math.max(1, Math.floor(controls?.interval ?? 4_096));
  let nextControlAt = interval;
  const advanceWork = (amount: number) => {
    workUnits += amount;
    if (workUnits < nextControlAt) return true;
    const keepGoing = controls?.onWork?.(workUnits) !== false;
    nextControlAt = workUnits + interval;
    return keepGoing;
  };
  for (let centerV = minimumV; centerV <= maximumV; centerV += 1) {
    for (let centerU = minimumU; centerU <= maximumU; centerU += 1) {
      if (!advanceWork(1)) {
        return { candidateCount, dominantAxis: w, saturated, completed: false, workUnits };
      }
      if (!projectionOverlapsCell(triangle, centerU, centerV, halfSize)) continue;
      let minimumW = Infinity;
      let maximumW = -Infinity;
      for (const cornerU of [centerU - halfSize, centerU + halfSize]) {
        for (const cornerV of [centerV - halfSize, centerV + halfSize]) {
          const planeW = a[w]
            - normal[u] / normal[w] * (cornerU - a[u])
            - normal[v] / normal[w] * (cornerV - a[v]);
          minimumW = Math.min(minimumW, planeW);
          maximumW = Math.max(maximumW, planeW);
        }
      }
      const minimumCenterW = Math.ceil(minimumW - halfSize);
      const maximumCenterW = Math.floor(maximumW + halfSize);
      const span = checkedPositiveSpan(minimumCenterW, maximumCenterW);
      if (!visitor) {
        const next = saturatingAdd(candidateCount, span);
        candidateCount = next.value;
        saturated ||= next.saturated;
        workUnits += span;
        continue;
      }
      for (let centerW = minimumCenterW; centerW <= maximumCenterW; centerW += 1) {
        const point: [number, number, number] = [0, 0, 0];
        point[u] = centerU;
        point[v] = centerV;
        point[w] = centerW;
        if (!advanceWork(1)) {
          return { candidateCount, dominantAxis: w, saturated, completed: false, workUnits };
        }
        candidateCount += 1;
        if (visitor(point[0], point[1], point[2]) === false) {
          return { candidateCount, dominantAxis: w, saturated, completed: false, workUnits };
        }
      }
    }
  }
  controls?.onWork?.(workUnits);
  return { candidateCount, dominantAxis: w, saturated, completed: true, workUnits };
};

const estimateTriangleCandidateUpperBound = (
  a: SolidVoxelPoint,
  b: SolidVoxelPoint,
  c: SolidVoxelPoint,
  halfSize: number,
) => {
  const legacy = triangleVoxelBounds(a, b, c, halfSize);
  const normal = cross(a, b, c);
  const normalSquared = normal[0] ** 2 + normal[1] ** 2 + normal[2] ** 2;
  if (!Number.isFinite(normalSquared) || normalSquared < DEGENERATE_NORMAL_SQUARED) {
    const edges = [distanceSquared(a, b), distanceSquared(b, c), distanceSquared(c, a)];
    const longestPair = edges[0] >= edges[1] && edges[0] >= edges[2]
      ? [a, b] as const
      : edges[1] >= edges[2] ? [b, c] as const : [c, a] as const;
    if (Math.max(...edges) < DEGENERATE_NORMAL_SQUARED) {
      return { upperBound: legacy.candidateCount, legacy, saturated: legacy.saturated };
    }
    const direction = longestPair[1].map((value, axis) => value - longestPair[0][axis]);
    const axis = dominantAxis(direction as [number, number, number]);
    const axisSpan = checkedPositiveSpan(legacy.minimum[axis], legacy.maximum[axis]);
    const radialSpan = Math.max(1, Math.ceil(halfSize * 4) + 1);
    const product = saturatingProduct([axisSpan, radialSpan, radialSpan]);
    return { upperBound: product.value, legacy, saturated: product.saturated || legacy.saturated };
  }
  const w = dominantAxis(normal);
  const [u, v] = projectedAxes(w);
  const spans = [u, v].map(axis => checkedPositiveSpan(
    Math.ceil(Math.min(a[axis], b[axis], c[axis]) - halfSize),
    Math.floor(Math.max(a[axis], b[axis], c[axis]) + halfSize),
  ));
  // 每个投影格的平面高度差只由两个斜率和方块半径决定，
  // 因此用固定 W 跨度可在 O(三角形数) 内给出保守上界。
  const planeSpan = 2 * halfSize * (
    Math.abs(normal[u] / normal[w])
    + Math.abs(normal[v] / normal[w])
    + 1
  );
  const wSpanUpperBound = Math.max(1, Math.ceil(planeSpan) + 1);
  spans.push(wSpanUpperBound);
  const product = saturatingProduct(spans);
  return { upperBound: product.value, legacy, saturated: product.saturated || legacy.saturated };
};

const pointAt = (positions: Float32Array, vertexIndex: number): SolidVoxelPoint => [
  positions[vertexIndex * 3],
  positions[vertexIndex * 3 + 1],
  positions[vertexIndex * 3 + 2],
];

export const estimateNormalizedSolidVoxelWork = (
  positions: Float32Array,
  indices: Uint32Array,
  halfSize: number,
): SolidVoxelWorkEstimate => {
  const vertexCount = positions.length / 3;
  if (!Number.isSafeInteger(vertexCount) || vertexCount <= 0) {
    throw new RangeError("Solid voxel work estimate requires valid positions");
  }
  if (indices.length === 0 || indices.length % 3 !== 0) {
    throw new RangeError("Solid voxel work estimate requires triangle indices");
  }
  const triangleCount = indices.length / 3;
  const triangleCandidateUpperBounds = new Float64Array(triangleCount);
  let totalCandidateUpperBound = 0;
  let maxTriangleCandidateUpperBound = 0;
  let maxTriangleIndex = -1;
  let legacyAabbCandidateTests = 0;
  let maxLegacyAabbCandidateTests = 0;
  let saturated = false;

  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
    const aIndex = indices[triangleIndex * 3];
    const bIndex = indices[triangleIndex * 3 + 1];
    const cIndex = indices[triangleIndex * 3 + 2];
    if (aIndex >= vertexCount || bIndex >= vertexCount || cIndex >= vertexCount) {
      throw new RangeError("Solid voxel triangle index is out of bounds");
    }
    const a = pointAt(positions, aIndex);
    const b = pointAt(positions, bIndex);
    const c = pointAt(positions, cIndex);
    const estimate = estimateTriangleCandidateUpperBound(a, b, c, halfSize);
    const legacy = estimate.legacy;
    triangleCandidateUpperBounds[triangleIndex] = estimate.upperBound;
    if (estimate.upperBound > maxTriangleCandidateUpperBound) {
      maxTriangleCandidateUpperBound = estimate.upperBound;
      maxTriangleIndex = triangleIndex;
    }
    maxLegacyAabbCandidateTests = Math.max(maxLegacyAabbCandidateTests, legacy.candidateCount);
    const total = saturatingAdd(totalCandidateUpperBound, estimate.upperBound);
    const legacyTotal = saturatingAdd(legacyAabbCandidateTests, legacy.candidateCount);
    totalCandidateUpperBound = total.value;
    legacyAabbCandidateTests = legacyTotal.value;
    saturated ||= estimate.saturated || total.saturated || legacyTotal.saturated;
  }

  return {
    triangleCandidateUpperBounds,
    totalCandidateUpperBound,
    maxTriangleCandidateUpperBound,
    maxTriangleIndex,
    legacyAabbCandidateTests,
    maxLegacyAabbCandidateTests,
    saturated,
  };
};

export const estimateSolidVoxelizationWork = (
  snapshot: MmdMeshSnapshot,
  targetHeight: number,
  thicknessCompensation: number,
): SolidVoxelWorkEstimate => {
  if (!Number.isSafeInteger(targetHeight) || targetHeight <= 0) {
    throw new RangeError("Solid voxel target height must be a positive safe integer");
  }
  if (snapshot.positions.length === 0 || snapshot.positions.length % 3 !== 0) {
    throw new RangeError("Solid voxel work estimate requires valid positions");
  }
  const minimum: [number, number, number] = [Infinity, Infinity, Infinity];
  const maximum: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < snapshot.positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = snapshot.positions[offset + axis];
      if (!Number.isFinite(value)) {
        throw new RangeError("Solid voxel work estimate contains a non-finite vertex");
      }
      minimum[axis] = Math.min(minimum[axis], value);
      maximum[axis] = Math.max(maximum[axis], value);
    }
  }
  const sourceHeight = maximum[1] - minimum[1];
  if (!(sourceHeight > 1e-6)) {
    throw new RangeError("Solid voxel work estimate mesh height is too small");
  }
  const scale = Math.max(1, Math.round(targetHeight) - 1) / sourceHeight;
  const centerX = (minimum[0] + maximum[0]) * 0.5;
  const centerZ = (minimum[2] + maximum[2]) * 0.5;
  const normalized = new Float32Array(snapshot.positions.length);
  for (let offset = 0; offset < snapshot.positions.length; offset += 3) {
    normalized[offset] = (snapshot.positions[offset] - centerX) * scale;
    normalized[offset + 1] = (snapshot.positions[offset + 1] - minimum[1]) * scale;
    normalized[offset + 2] = (snapshot.positions[offset + 2] - centerZ) * scale;
  }
  return estimateNormalizedSolidVoxelWork(
    normalized,
    snapshot.indices,
    0.5 + Math.max(0, thicknessCompensation),
  );
};
