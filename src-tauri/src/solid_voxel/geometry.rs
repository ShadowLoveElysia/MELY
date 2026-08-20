use std::{error::Error, fmt};

pub type Point3 = [f64; 3];

const AXIS_EPSILON_SQUARED: f64 = 1.0e-12;
const MINIMUM_SOURCE_HEIGHT: f64 = 1.0e-6;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ClosestTrianglePoint {
    pub barycentric: Point3,
    pub point: Point3,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NormalizedPositions {
    pub positions: Vec<f32>,
    pub source_minimum: Point3,
    pub source_maximum: Point3,
    pub center_x: f64,
    pub center_z: f64,
    pub scale: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GeometryError {
    EmptyPositions,
    MisalignedPositions { length: usize },
    NonFinitePosition { offset: usize },
    SourceHeightTooSmall,
    ZeroTargetHeight,
    NonFiniteGeometry,
}

impl fmt::Display for GeometryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyPositions => formatter.write_str("geometry positions must not be empty"),
            Self::MisalignedPositions { length } => write!(
                formatter,
                "geometry position length must be divisible by 3, got {length}",
            ),
            Self::NonFinitePosition { offset } => {
                write!(
                    formatter,
                    "geometry position at offset {offset} must be finite"
                )
            }
            Self::SourceHeightTooSmall => {
                formatter.write_str("geometry source height is too small")
            }
            Self::ZeroTargetHeight => {
                formatter.write_str("geometry target height must be positive")
            }
            Self::NonFiniteGeometry => formatter
                .write_str("normalized geometry cannot be represented as finite f32 values"),
        }
    }
}

impl Error for GeometryError {}

pub fn subtract(left: Point3, right: Point3) -> Point3 {
    [left[0] - right[0], left[1] - right[1], left[2] - right[2]]
}

pub fn dot(left: Point3, right: Point3) -> f64 {
    left[0] * right[0] + left[1] * right[1] + left[2] * right[2]
}

pub fn cross(left: Point3, right: Point3) -> Point3 {
    [
        left[1] * right[2] - left[2] * right[1],
        left[2] * right[0] - left[0] * right[2],
        left[0] * right[1] - left[1] * right[0],
    ]
}

pub fn length_squared(point: Point3) -> f64 {
    dot(point, point)
}

fn projections_overlap(axis: Point3, vertices: &[Point3; 3], half: Point3) -> bool {
    if length_squared(axis) < AXIS_EPSILON_SQUARED {
        return true;
    }
    let first = dot(vertices[0], axis);
    let mut minimum = first;
    let mut maximum = first;
    for vertex in &vertices[1..] {
        let projection = dot(*vertex, axis);
        minimum = minimum.min(projection);
        maximum = maximum.max(projection);
    }
    let radius = half[0] * axis[0].abs() + half[1] * axis[1].abs() + half[2] * axis[2].abs();
    minimum <= radius && maximum >= -radius
}

/// 与 TypeScript `triangleIntersectsBox` 使用相同的 SAT 轴、边界包含关系与退化轴阈值。
pub fn triangle_intersects_box(
    a: Point3,
    b: Point3,
    c: Point3,
    center: Point3,
    half_size: f64,
) -> bool {
    let vertices = [
        subtract(a, center),
        subtract(b, center),
        subtract(c, center),
    ];
    let half = [half_size; 3];
    for ((&a_axis, &b_axis), &c_axis) in vertices[0]
        .iter()
        .zip(vertices[1].iter())
        .zip(vertices[2].iter())
    {
        let minimum = a_axis.min(b_axis).min(c_axis);
        let maximum = a_axis.max(b_axis).max(c_axis);
        if minimum > half_size || maximum < -half_size {
            return false;
        }
    }

    let edges = [
        subtract(vertices[1], vertices[0]),
        subtract(vertices[2], vertices[1]),
        subtract(vertices[0], vertices[2]),
    ];
    let normal = cross(edges[0], subtract(vertices[2], vertices[0]));
    if !projections_overlap(normal, &vertices, half) {
        return false;
    }
    let box_axes = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    for edge in edges {
        for box_axis in box_axes {
            if !projections_overlap(cross(edge, box_axis), &vertices, half) {
                return false;
            }
        }
    }
    true
}

/// 返回三角形上距给定点最近的点及其重心坐标，分支顺序与现有 TypeScript 内核一致。
pub fn closest_triangle_point(
    point: Point3,
    a: Point3,
    b: Point3,
    c: Point3,
) -> ClosestTrianglePoint {
    let ab = subtract(b, a);
    let ac = subtract(c, a);
    let ap = subtract(point, a);
    let d1 = dot(ab, ap);
    let d2 = dot(ac, ap);
    if d1 <= 0.0 && d2 <= 0.0 {
        return ClosestTrianglePoint {
            barycentric: [1.0, 0.0, 0.0],
            point: a,
        };
    }

    let bp = subtract(point, b);
    let d3 = dot(ab, bp);
    let d4 = dot(ac, bp);
    if d3 >= 0.0 && d4 <= d3 {
        return ClosestTrianglePoint {
            barycentric: [0.0, 1.0, 0.0],
            point: b,
        };
    }

    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        let v = d1 / (d1 - d3);
        return ClosestTrianglePoint {
            barycentric: [1.0 - v, v, 0.0],
            point: [a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v],
        };
    }

    let cp = subtract(point, c);
    let d5 = dot(ab, cp);
    let d6 = dot(ac, cp);
    if d6 >= 0.0 && d5 <= d6 {
        return ClosestTrianglePoint {
            barycentric: [0.0, 0.0, 1.0],
            point: c,
        };
    }

    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        let w = d2 / (d2 - d6);
        return ClosestTrianglePoint {
            barycentric: [1.0 - w, 0.0, w],
            point: [a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w],
        };
    }

    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && d4 - d3 >= 0.0 && d5 - d6 >= 0.0 {
        let edge = subtract(c, b);
        let w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return ClosestTrianglePoint {
            barycentric: [0.0, 1.0 - w, w],
            point: [b[0] + edge[0] * w, b[1] + edge[1] * w, b[2] + edge[2] * w],
        };
    }

    let denominator = 1.0 / (va + vb + vc);
    let v = vb * denominator;
    let w = vc * denominator;
    let u = 1.0 - v - w;
    ClosestTrianglePoint {
        barycentric: [u, v, w],
        point: [
            a[0] * u + b[0] * v + c[0] * w,
            a[1] * u + b[1] * v + c[1] * w,
            a[2] * u + b[2] * v + c[2] * w,
        ],
    }
}

/// 计算使用 f64，每个结果再单独转回 f32，复刻 JS Number 计算后写入 Float32Array 的语义。
pub fn normalize_positions_js_equivalent(
    positions: &[f32],
    target_height: u32,
) -> Result<NormalizedPositions, GeometryError> {
    if positions.is_empty() {
        return Err(GeometryError::EmptyPositions);
    }
    if !positions.len().is_multiple_of(3) {
        return Err(GeometryError::MisalignedPositions {
            length: positions.len(),
        });
    }
    if target_height == 0 {
        return Err(GeometryError::ZeroTargetHeight);
    }

    let mut source_minimum = [f64::INFINITY; 3];
    let mut source_maximum = [f64::NEG_INFINITY; 3];
    for (offset, value) in positions.iter().copied().enumerate() {
        if !value.is_finite() {
            return Err(GeometryError::NonFinitePosition { offset });
        }
        let axis = offset % 3;
        let value = f64::from(value);
        source_minimum[axis] = source_minimum[axis].min(value);
        source_maximum[axis] = source_maximum[axis].max(value);
    }

    let source_height = source_maximum[1] - source_minimum[1];
    if source_height <= MINIMUM_SOURCE_HEIGHT {
        return Err(GeometryError::SourceHeightTooSmall);
    }
    let target_span = f64::from(target_height.saturating_sub(1).max(1));
    let scale = target_span / source_height;
    let center_x = (source_minimum[0] + source_maximum[0]) * 0.5;
    let center_z = (source_minimum[2] + source_maximum[2]) * 0.5;
    let mut normalized = Vec::with_capacity(positions.len());
    for vertex in positions.chunks_exact(3) {
        normalized.push(((f64::from(vertex[0]) - center_x) * scale) as f32);
        normalized.push(((f64::from(vertex[1]) - source_minimum[1]) * scale) as f32);
        normalized.push(((f64::from(vertex[2]) - center_z) * scale) as f32);
    }
    if normalized.iter().any(|value| !value.is_finite()) {
        return Err(GeometryError::NonFiniteGeometry);
    }

    Ok(NormalizedPositions {
        positions: normalized,
        source_minimum,
        source_maximum,
        center_x,
        center_z,
        scale,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_point_close(actual: Point3, expected: Point3) {
        for axis in 0..3 {
            assert!(
                (actual[axis] - expected[axis]).abs() < 1.0e-12,
                "axis {axis}: {} != {}",
                actual[axis],
                expected[axis],
            );
        }
    }

    #[test]
    fn triangle_box_sat_includes_touching_boundaries() {
        let triangle = [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.0, 0.5, 0.5]];

        assert!(triangle_intersects_box(
            triangle[0],
            triangle[1],
            triangle[2],
            [0.0, 0.0, 0.0],
            0.5,
        ));
    }

    #[test]
    fn triangle_box_sat_rejects_a_separated_triangle() {
        assert!(!triangle_intersects_box(
            [2.0, 2.0, 2.0],
            [3.0, 2.0, 2.0],
            [2.0, 3.0, 2.0],
            [0.0, 0.0, 0.0],
            0.5,
        ));
    }

    #[test]
    fn closest_point_preserves_barycentric_coordinates_inside_the_face() {
        let closest = closest_triangle_point(
            [0.25, 0.25, 2.0],
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
        );

        assert_point_close(closest.barycentric, [0.5, 0.25, 0.25]);
        assert_point_close(closest.point, [0.25, 0.25, 0.0]);
    }

    #[test]
    fn closest_point_uses_the_nearest_vertex_outside_the_face() {
        let closest = closest_triangle_point(
            [-2.0, -1.0, 0.0],
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
        );

        assert_eq!(closest.barycentric, [1.0, 0.0, 0.0]);
        assert_eq!(closest.point, [0.0, 0.0, 0.0]);
    }

    #[test]
    fn normalization_matches_number_then_float32array_semantics() {
        let source = [-1.0, 0.0, -2.0, 1.0, 2.0, 2.0, 0.0, 1.0, 0.0];
        let normalized = normalize_positions_js_equivalent(&source, 16).unwrap();

        assert_eq!(
            normalized.positions[0..6],
            [-7.5, 0.0, -15.0, 7.5, 15.0, 15.0]
        );
        assert_eq!(normalized.scale, 7.5);
        assert_eq!(normalized.center_x, 0.0);
        assert_eq!(normalized.center_z, 0.0);
    }

    #[test]
    fn height_one_keeps_the_existing_minimum_one_block_span() {
        let source = [0.0, 2.0, 0.0, 1.0, 4.0, 1.0, -1.0, 3.0, -1.0];
        let normalized = normalize_positions_js_equivalent(&source, 1).unwrap();

        assert_eq!(normalized.positions[1], 0.0);
        assert_eq!(normalized.positions[4], 1.0);
    }
}
