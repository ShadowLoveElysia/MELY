//! 实体 shell 的单线程 Rust 参考内核。
//!
//! 参考路径覆盖 shell 的材质基色、UV 纹理、MMD 混色、Alpha、
//! 发光方块和普通调色板匹配。面部增强、抖动与遗迹装饰仍不在此子集。

use std::{
    collections::{btree_map::Entry, BTreeMap},
    error::Error,
    fmt,
};

use serde::{Deserialize, Serialize};

use super::{
    chunk::{CandidateWinnerKey, ChunkCoordinate, VoxelAddress},
    contract::{InputValidationError, SolidMaterialSnapshot, SolidShellInput},
    geometry::{
        closest_triangle_point, cross, length_squared, normalize_positions_js_equivalent, subtract,
        triangle_intersects_box, GeometryError, Point3,
    },
    palette::{create_block_palette, match_emissive_block, PaletteRole},
    texture::{alpha_passes_threshold, MaterialSampleError, MaterialTextureState, TextureView},
};

const DEGENERATE_NORMAL_SQUARED: f64 = 1.0e-12;
const PROJECTION_AXIS_EPSILON_SQUARED: f64 = 1.0e-20;
const CONTROL_CHECK_INTERVAL: u64 = 4_096;

/// 默认材质 `0.72` sRGB 在 clean/original 色板中的 TypeScript 匹配结果。
pub const DEFAULT_BLOCK_ID: &str = "minecraft:polished_diorite";
pub const DEFAULT_BLOCK_COLOR: [u8; 3] = [192, 193, 190];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SolidShellPaletteEntry {
    pub block_id: String,
    pub color: [u8; 3],
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SolidShellChunk {
    pub chunk: ChunkCoordinate,
    pub positions: Vec<u16>,
    pub block_indices: Vec<u16>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SolidShellBounds {
    pub min: [i32; 3],
    pub max: [i32; 3],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SolidShellStats {
    pub block_count: u64,
    pub surface_block_count: u64,
    pub filled_block_count: u64,
    pub skin_block_count: u64,
    pub alpha_rejected: u64,
    pub triangle_box_tests: u64,
    pub palette_size: u32,
    pub dimensions: [u64; 3],
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SolidShellResult {
    pub chunks: Vec<SolidShellChunk>,
    pub palette: Vec<SolidShellPaletteEntry>,
    pub stats: SolidShellStats,
    pub bounds: SolidShellBounds,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SolidVoxelizeProgress {
    pub completed_triangles: u64,
    pub total_triangles: u64,
    pub candidate_tests: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnsupportedSolidShellFeature {
    EmissiveMapping,
    TextureSamplingContractMissing,
    NonDefaultMaterial {
        triangle_index: usize,
        material_index: u16,
    },
}

impl fmt::Display for UnsupportedSolidShellFeature {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmissiveMapping => formatter.write_str(
                "solid shell emissive block mapping is not part of the parallel reference subset",
            ),
            Self::TextureSamplingContractMissing => formatter.write_str(
                "solid shell texture sampling is not part of the parallel reference subset",
            ),
            Self::NonDefaultMaterial {
                triangle_index,
                material_index,
            } => write!(
                formatter,
                "solid shell parallel reference subset does not support material {material_index} on triangle {triangle_index}",
            ),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SolidVoxelizeError {
    InvalidInput(InputValidationError),
    Geometry(GeometryError),
    Unsupported(UnsupportedSolidShellFeature),
    CoordinateOutOfRange {
        axis: usize,
    },
    InvalidCandidateBounds {
        axis: usize,
    },
    InvalidCandidateDistance {
        triangle_index: usize,
    },
    MaterialSample {
        material_index: usize,
        reason: MaterialSampleError,
    },
    ArithmeticOverflow,
    EmptySurface,
    Cancelled,
}

impl fmt::Display for SolidVoxelizeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidInput(error) => error.fmt(formatter),
            Self::Geometry(error) => error.fmt(formatter),
            Self::Unsupported(error) => write!(formatter, "unsupported solid shell input: {error}"),
            Self::CoordinateOutOfRange { axis } => write!(
                formatter,
                "solid voxel candidate on axis {axis} cannot be represented as i32",
            ),
            Self::InvalidCandidateBounds { axis } => write!(
                formatter,
                "solid voxel candidate bounds on axis {axis} are empty or invalid",
            ),
            Self::InvalidCandidateDistance { triangle_index } => write!(
                formatter,
                "solid voxel triangle {triangle_index} produced a non-finite candidate distance",
            ),
            Self::MaterialSample {
                material_index,
                reason,
            } => write!(
                formatter,
                "solid voxel material {material_index} could not be sampled: {reason}",
            ),
            Self::ArithmeticOverflow => {
                formatter.write_str("solid voxel result exceeds supported integer arithmetic")
            }
            Self::EmptySurface => formatter.write_str("solid voxel shell contains no blocks"),
            Self::Cancelled => formatter.write_str("solid voxel shell generation was cancelled"),
        }
    }
}

impl Error for SolidVoxelizeError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::InvalidInput(error) => Some(error),
            Self::Geometry(error) => Some(error),
            _ => None,
        }
    }
}

impl From<InputValidationError> for SolidVoxelizeError {
    fn from(error: InputValidationError) -> Self {
        Self::InvalidInput(error)
    }
}

impl From<GeometryError> for SolidVoxelizeError {
    fn from(error: GeometryError) -> Self {
        Self::Geometry(error)
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct SurfaceCandidate {
    winner: CandidateWinnerKey,
    rgb: [u8; 3],
    palette_role: PaletteRole,
    emissive: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CandidateScanStats {
    candidate_count: u64,
    dominant_axis: Option<usize>,
}

/// 生成确定性 chunked shell。该参考路径不包含任何高度政策上限。
pub fn voxelize_shell_reference(
    input: &SolidShellInput,
) -> Result<SolidShellResult, SolidVoxelizeError> {
    voxelize_shell_reference_with_control(input, |_| true)
}

/// 为任务 manager 提供热循环内的协作取消与单调进度检查点。
///
/// 控制器返回 `false` 时立即结束任务；旧入口仍使用永不取消的控制器，
/// 保持原有单线程参考语义。
pub fn voxelize_shell_reference_with_control<Control>(
    input: &SolidShellInput,
    mut control: Control,
) -> Result<SolidShellResult, SolidVoxelizeError>
where
    Control: FnMut(SolidVoxelizeProgress) -> bool,
{
    let validated = input.validate()?;
    validate_shell_reference_support(input)?;
    let normalized =
        normalize_positions_js_equivalent(&input.mesh.positions, input.options.target_height)?;
    let default_material = SolidMaterialSnapshot::default_material();
    let material_snapshots = if input.mesh.materials.is_empty() {
        std::slice::from_ref(&default_material)
    } else {
        input.mesh.materials.as_slice()
    };
    let materials = material_snapshots
        .iter()
        .map(SolidMaterialSnapshot::texture_state)
        .collect::<Result<Vec<MaterialTextureState>, _>>()
        .map_err(|reason| SolidVoxelizeError::MaterialSample {
            material_index: 0,
            reason: MaterialSampleError::Texture(reason),
        })?;
    let textures = input
        .mesh
        .textures
        .iter()
        .map(|texture| texture.view())
        .collect::<Result<Vec<TextureView<'_>>, _>>()
        .map_err(|reason| SolidVoxelizeError::MaterialSample {
            material_index: 0,
            reason: MaterialSampleError::Texture(reason),
        })?;

    let triangle_count = input.mesh.indices.len() / 3;
    let total_triangles =
        u64::try_from(triangle_count).map_err(|_| SolidVoxelizeError::ArithmeticOverflow)?;

    let mut surface = BTreeMap::<VoxelAddress, SurfaceCandidate>::new();
    let mut triangle_box_tests = 0_u64;
    let mut alpha_rejected = 0_u64;

    if !control(SolidVoxelizeProgress {
        completed_triangles: 0,
        total_triangles,
        candidate_tests: 0,
    }) {
        return Err(SolidVoxelizeError::Cancelled);
    }

    for triangle_index in 0..triangle_count {
        let vertex_indices = [
            input.mesh.indices[triangle_index * 3],
            input.mesh.indices[triangle_index * 3 + 1],
            input.mesh.indices[triangle_index * 3 + 2],
        ];
        let a = point_at(&normalized.positions, vertex_indices[0]);
        let b = point_at(&normalized.positions, vertex_indices[1]);
        let c = point_at(&normalized.positions, vertex_indices[2]);
        let material_index = input
            .mesh
            .triangle_materials
            .get(triangle_index)
            .copied()
            .unwrap_or(0);
        let material_index_usize = usize::from(material_index);
        let material = materials.get(material_index_usize).unwrap_or(&materials[0]);
        let emissive = material_uses_emissive_mapping(input, material_index);
        let palette_role = if input.options.skin_protection
            && input
                .options
                .skin_material_indices
                .contains(&material_index)
        {
            PaletteRole::SkinBase
        } else {
            PaletteRole::General
        };
        let uv_a = uv_at(input.mesh.uvs.as_deref(), vertex_indices[0]);
        let uv_b = uv_at(input.mesh.uvs.as_deref(), vertex_indices[1]);
        let uv_c = uv_at(input.mesh.uvs.as_deref(), vertex_indices[2]);
        let triangle_index_u32 =
            u32::try_from(triangle_index).map_err(|_| SolidVoxelizeError::ArithmeticOverflow)?;
        let mut visit = |position: [i32; 3]| -> Result<(), SolidVoxelizeError> {
            triangle_box_tests = triangle_box_tests
                .checked_add(1)
                .ok_or(SolidVoxelizeError::ArithmeticOverflow)?;
            if triangle_box_tests.is_multiple_of(CONTROL_CHECK_INTERVAL)
                && !control(SolidVoxelizeProgress {
                    completed_triangles: triangle_index as u64,
                    total_triangles,
                    candidate_tests: triangle_box_tests,
                })
            {
                return Err(SolidVoxelizeError::Cancelled);
            }
            let center = position.map(|value| value as f64);
            if !triangle_intersects_box(a, b, c, center, validated.voxel_half_size) {
                return Ok(());
            }

            let closest = closest_triangle_point(center, a, b, c);
            let uv = [
                uv_a[0] * closest.barycentric[0]
                    + uv_b[0] * closest.barycentric[1]
                    + uv_c[0] * closest.barycentric[2],
                uv_a[1] * closest.barycentric[0]
                    + uv_b[1] * closest.barycentric[1]
                    + uv_c[1] * closest.barycentric[2],
            ];
            let sampled = material.sample(&textures, uv).map_err(|reason| {
                SolidVoxelizeError::MaterialSample {
                    material_index: material_index_usize,
                    reason,
                }
            })?;
            if !alpha_passes_threshold(sampled.alpha, input.options.alpha_threshold) {
                alpha_rejected = alpha_rejected
                    .checked_add(1)
                    .ok_or(SolidVoxelizeError::ArithmeticOverflow)?;
                return Ok(());
            }
            let distance_sq = length_squared(subtract(center, closest.point));
            let winner = CandidateWinnerKey::new(
                0,
                distance_sq,
                triangle_index_u32,
                u32::from(material_index),
                vertex_indices,
            )
            .map_err(|_| SolidVoxelizeError::InvalidCandidateDistance { triangle_index })?;
            insert_candidate(
                &mut surface,
                VoxelAddress::from_world(position),
                SurfaceCandidate {
                    winner,
                    rgb: sampled.rgb,
                    palette_role,
                    emissive,
                },
            );
            Ok(())
        };
        visit_triangle_voxel_candidates(a, b, c, validated.voxel_half_size, &mut visit)?;
        if !control(SolidVoxelizeProgress {
            completed_triangles: triangle_index as u64 + 1,
            total_triangles,
            candidate_tests: triangle_box_tests,
        }) {
            return Err(SolidVoxelizeError::Cancelled);
        }
    }

    build_result(
        surface,
        triangle_box_tests,
        alpha_rejected,
        input.options.block_palette_options(),
    )
}

/// 供任务 manager 在进入 running 状态前可以独立调用的支持边界。
pub fn validate_shell_reference_support(
    _input: &SolidShellInput,
) -> Result<(), SolidVoxelizeError> {
    Ok(())
}

/// 与 TypeScript 一致地合并用户指定材质和快照中的发光标记。
pub fn material_uses_emissive_mapping(input: &SolidShellInput, material_index: u16) -> bool {
    if !input.options.emissive_mapping {
        return false;
    }
    input
        .options
        .emissive_material_indices
        .contains(&material_index)
        || input
            .mesh
            .materials
            .get(usize::from(material_index))
            .or_else(|| input.mesh.materials.first())
            .is_some_and(|material| material.emissive)
}

fn point_at(positions: &[f32], vertex_index: u32) -> Point3 {
    let offset = vertex_index as usize * 3;
    [
        f64::from(positions[offset]),
        f64::from(positions[offset + 1]),
        f64::from(positions[offset + 2]),
    ]
}

fn uv_at(uvs: Option<&[f32]>, vertex_index: u32) -> [f64; 2] {
    let Some(uvs) = uvs else {
        return [0.0, 0.0];
    };
    let offset = vertex_index as usize * 2;
    [f64::from(uvs[offset]), f64::from(uvs[offset + 1])]
}

fn insert_candidate(
    surface: &mut BTreeMap<VoxelAddress, SurfaceCandidate>,
    address: VoxelAddress,
    candidate: SurfaceCandidate,
) {
    match surface.entry(address) {
        Entry::Vacant(entry) => {
            entry.insert(candidate);
        }
        Entry::Occupied(mut entry) => {
            if candidate.winner.wins_over(entry.get().winner) {
                entry.insert(candidate);
            }
        }
    }
}

fn build_result(
    surface: BTreeMap<VoxelAddress, SurfaceCandidate>,
    triangle_box_tests: u64,
    alpha_rejected: u64,
    palette_options: super::palette::BlockPaletteOptions,
) -> Result<SolidShellResult, SolidVoxelizeError> {
    if surface.is_empty() {
        return Err(SolidVoxelizeError::EmptySurface);
    }

    let block_count =
        u64::try_from(surface.len()).map_err(|_| SolidVoxelizeError::ArithmeticOverflow)?;
    let mut minimum = [i32::MAX; 3];
    let mut maximum = [i32::MIN; 3];
    let mut chunks = Vec::<SolidShellChunk>::new();
    let source_palette = create_block_palette(palette_options);
    let mut compact_palette = Vec::<SolidShellPaletteEntry>::new();
    let mut compact_indices = BTreeMap::<&'static str, u16>::new();
    let mut skin_block_count = 0_u64;

    for (address, candidate) in surface {
        let world = address
            .to_world()
            .map_err(|_| SolidVoxelizeError::ArithmeticOverflow)?;
        for axis in 0..3 {
            minimum[axis] = minimum[axis].min(world[axis]);
            maximum[axis] = maximum[axis].max(world[axis]);
        }

        let needs_chunk = chunks
            .last()
            .map(|chunk| chunk.chunk != address.chunk)
            .unwrap_or(true);
        if needs_chunk {
            chunks.push(SolidShellChunk {
                chunk: address.chunk,
                positions: Vec::new(),
                block_indices: Vec::new(),
            });
        }
        let chunk = chunks
            .last_mut()
            .expect("a result chunk was inserted before appending the voxel");
        let source_entry = if candidate.emissive {
            match_emissive_block(candidate.rgb)
        } else {
            let source_index = source_palette.match_color(candidate.rgb, candidate.palette_role);
            source_palette.entries()[source_index]
        };
        let compact_index = match compact_indices.entry(source_entry.block_id) {
            Entry::Occupied(entry) => *entry.get(),
            Entry::Vacant(entry) => {
                let index = u16::try_from(compact_palette.len())
                    .map_err(|_| SolidVoxelizeError::ArithmeticOverflow)?;
                compact_palette.push(SolidShellPaletteEntry {
                    block_id: source_entry.block_id.to_owned(),
                    color: source_entry.color,
                });
                entry.insert(index);
                index
            }
        };
        if candidate.palette_role == PaletteRole::SkinBase {
            skin_block_count = skin_block_count
                .checked_add(1)
                .ok_or(SolidVoxelizeError::ArithmeticOverflow)?;
        }
        chunk.positions.push(address.local_index);
        chunk.block_indices.push(compact_index);
    }

    let dimensions = [
        inclusive_dimension(minimum[0], maximum[0])?,
        inclusive_dimension(minimum[1], maximum[1])?,
        inclusive_dimension(minimum[2], maximum[2])?,
    ];
    Ok(SolidShellResult {
        chunks,
        palette: compact_palette,
        stats: SolidShellStats {
            block_count,
            surface_block_count: block_count,
            filled_block_count: 0,
            skin_block_count,
            alpha_rejected,
            triangle_box_tests,
            palette_size: u32::try_from(compact_indices.len())
                .map_err(|_| SolidVoxelizeError::ArithmeticOverflow)?,
            dimensions,
        },
        bounds: SolidShellBounds {
            min: minimum,
            max: maximum,
        },
    })
}

fn inclusive_dimension(minimum: i32, maximum: i32) -> Result<u64, SolidVoxelizeError> {
    let dimension = i64::from(maximum)
        .checked_sub(i64::from(minimum))
        .and_then(|span| span.checked_add(1))
        .ok_or(SolidVoxelizeError::ArithmeticOverflow)?;
    u64::try_from(dimension).map_err(|_| SolidVoxelizeError::ArithmeticOverflow)
}

fn visit_triangle_voxel_candidates<Visitor>(
    a: Point3,
    b: Point3,
    c: Point3,
    half_size: f64,
    visitor: &mut Visitor,
) -> Result<CandidateScanStats, SolidVoxelizeError>
where
    Visitor: FnMut([i32; 3]) -> Result<(), SolidVoxelizeError>,
{
    let normal = triangle_normal(a, b, c);
    let normal_squared = length_squared(normal);
    if !normal_squared.is_finite() || normal_squared < DEGENERATE_NORMAL_SQUARED {
        return visit_degenerate_candidates(a, b, c, half_size, visitor);
    }

    let w = dominant_axis(normal);
    let [u, v] = projected_axes(w);
    let triangle = [[a[u], a[v]], [b[u], b[v]], [c[u], c[v]]];
    let (minimum_u, maximum_u) = coordinate_bounds(
        a[u].min(b[u]).min(c[u]) - half_size,
        a[u].max(b[u]).max(c[u]) + half_size,
        u,
    )?;
    let (minimum_v, maximum_v) = coordinate_bounds(
        a[v].min(b[v]).min(c[v]) - half_size,
        a[v].max(b[v]).max(c[v]) + half_size,
        v,
    )?;
    let mut candidate_count = 0_u64;

    for center_v in minimum_v..=maximum_v {
        for center_u in minimum_u..=maximum_u {
            if !projection_overlaps_cell(&triangle, center_u as f64, center_v as f64, half_size) {
                continue;
            }

            let mut minimum_w = f64::INFINITY;
            let mut maximum_w = f64::NEG_INFINITY;
            for corner_u in [center_u as f64 - half_size, center_u as f64 + half_size] {
                for corner_v in [center_v as f64 - half_size, center_v as f64 + half_size] {
                    let plane_w = a[w]
                        - normal[u] / normal[w] * (corner_u - a[u])
                        - normal[v] / normal[w] * (corner_v - a[v]);
                    minimum_w = minimum_w.min(plane_w);
                    maximum_w = maximum_w.max(plane_w);
                }
            }
            let (minimum_center_w, maximum_center_w) =
                coordinate_bounds(minimum_w - half_size, maximum_w + half_size, w)?;
            for center_w in minimum_center_w..=maximum_center_w {
                let mut point = [0_i32; 3];
                point[u] = center_u;
                point[v] = center_v;
                point[w] = center_w;
                emit_candidate(point, &mut candidate_count, visitor)?;
            }
        }
    }

    Ok(CandidateScanStats {
        candidate_count,
        dominant_axis: Some(w),
    })
}

fn visit_degenerate_candidates<Visitor>(
    a: Point3,
    b: Point3,
    c: Point3,
    half_size: f64,
    visitor: &mut Visitor,
) -> Result<CandidateScanStats, SolidVoxelizeError>
where
    Visitor: FnMut([i32; 3]) -> Result<(), SolidVoxelizeError>,
{
    let pairs = [
        (a, b, distance_squared(a, b)),
        (b, c, distance_squared(b, c)),
        (c, a, distance_squared(c, a)),
    ];
    let mut longest = pairs[0];
    for candidate in &pairs[1..] {
        if candidate.2 > longest.2 {
            longest = *candidate;
        }
    }
    if longest.2 < DEGENERATE_NORMAL_SQUARED {
        return visit_point_aabb_candidates(a, half_size, visitor);
    }

    let start = longest.0;
    let end = longest.1;
    let direction = subtract(end, start);
    let axis = dominant_axis(direction);
    let [u, v] = projected_axes(axis);
    let (minimum_axis, maximum_axis) = coordinate_bounds(
        start[axis].min(end[axis]) - half_size,
        start[axis].max(end[axis]) + half_size,
        axis,
    )?;
    let mut candidate_count = 0_u64;

    for center_axis in minimum_axis..=maximum_axis {
        let t = ((center_axis as f64 - start[axis]) / direction[axis]).clamp(0.0, 1.0);
        let center_u = start[u] + direction[u] * t;
        let center_v = start[v] + direction[v] * t;
        let (minimum_u, maximum_u) =
            coordinate_bounds(center_u - half_size * 2.0, center_u + half_size * 2.0, u)?;
        let (minimum_v, maximum_v) =
            coordinate_bounds(center_v - half_size * 2.0, center_v + half_size * 2.0, v)?;
        for voxel_v in minimum_v..=maximum_v {
            for voxel_u in minimum_u..=maximum_u {
                let mut point = [0_i32; 3];
                point[axis] = center_axis;
                point[u] = voxel_u;
                point[v] = voxel_v;
                emit_candidate(point, &mut candidate_count, visitor)?;
            }
        }
    }

    Ok(CandidateScanStats {
        candidate_count,
        dominant_axis: Some(axis),
    })
}

fn visit_point_aabb_candidates<Visitor>(
    point: Point3,
    half_size: f64,
    visitor: &mut Visitor,
) -> Result<CandidateScanStats, SolidVoxelizeError>
where
    Visitor: FnMut([i32; 3]) -> Result<(), SolidVoxelizeError>,
{
    let bounds = [
        coordinate_bounds(point[0] - half_size, point[0] + half_size, 0)?,
        coordinate_bounds(point[1] - half_size, point[1] + half_size, 1)?,
        coordinate_bounds(point[2] - half_size, point[2] + half_size, 2)?,
    ];
    let mut candidate_count = 0_u64;
    for y in bounds[1].0..=bounds[1].1 {
        for z in bounds[2].0..=bounds[2].1 {
            for x in bounds[0].0..=bounds[0].1 {
                emit_candidate([x, y, z], &mut candidate_count, visitor)?;
            }
        }
    }
    Ok(CandidateScanStats {
        candidate_count,
        dominant_axis: None,
    })
}

fn emit_candidate<Visitor>(
    point: [i32; 3],
    candidate_count: &mut u64,
    visitor: &mut Visitor,
) -> Result<(), SolidVoxelizeError>
where
    Visitor: FnMut([i32; 3]) -> Result<(), SolidVoxelizeError>,
{
    *candidate_count = candidate_count
        .checked_add(1)
        .ok_or(SolidVoxelizeError::ArithmeticOverflow)?;
    visitor(point)
}

fn triangle_normal(a: Point3, b: Point3, c: Point3) -> Point3 {
    cross(subtract(b, a), subtract(c, a))
}

fn distance_squared(a: Point3, b: Point3) -> f64 {
    length_squared(subtract(b, a))
}

fn dominant_axis(vector: Point3) -> usize {
    let absolute = vector.map(f64::abs);
    if absolute[0] >= absolute[1] && absolute[0] >= absolute[2] {
        0
    } else if absolute[1] >= absolute[2] {
        1
    } else {
        2
    }
}

fn projected_axes(w: usize) -> [usize; 2] {
    match w {
        0 => [1, 2],
        1 => [0, 2],
        2 => [0, 1],
        _ => unreachable!("dominant axes are limited to three dimensions"),
    }
}

fn projection_overlaps_cell(
    triangle: &[[f64; 2]; 3],
    center_u: f64,
    center_v: f64,
    half_size: f64,
) -> bool {
    let edge_axes = [
        [
            -(triangle[1][1] - triangle[0][1]),
            triangle[1][0] - triangle[0][0],
        ],
        [
            -(triangle[2][1] - triangle[1][1]),
            triangle[2][0] - triangle[1][0],
        ],
        [
            -(triangle[0][1] - triangle[2][1]),
            triangle[0][0] - triangle[2][0],
        ],
    ];
    for axis in [[1.0_f64, 0.0_f64], [0.0_f64, 1.0_f64]]
        .into_iter()
        .chain(edge_axes.into_iter())
    {
        let length_squared = axis[0] * axis[0] + axis[1] * axis[1];
        if length_squared < PROJECTION_AXIS_EPSILON_SQUARED {
            continue;
        }
        let first = triangle[0][0] * axis[0] + triangle[0][1] * axis[1];
        let mut minimum = first;
        let mut maximum = first;
        for point in &triangle[1..] {
            let projection = point[0] * axis[0] + point[1] * axis[1];
            minimum = minimum.min(projection);
            maximum = maximum.max(projection);
        }
        let center = center_u * axis[0] + center_v * axis[1];
        let radius = half_size * (axis[0].abs() + axis[1].abs());
        let tolerance = f64::EPSILON
            * 32.0
            * 1.0_f64
                .max(minimum.abs())
                .max(maximum.abs())
                .max(center.abs())
                .max(radius);
        if minimum > center + radius + tolerance || maximum < center - radius - tolerance {
            return false;
        }
    }
    true
}

fn coordinate_bounds(
    minimum: f64,
    maximum: f64,
    axis: usize,
) -> Result<(i32, i32), SolidVoxelizeError> {
    let minimum = rounded_coordinate(minimum.ceil(), axis)?;
    let maximum = rounded_coordinate(maximum.floor(), axis)?;
    if minimum > maximum {
        return Err(SolidVoxelizeError::InvalidCandidateBounds { axis });
    }
    Ok((minimum, maximum))
}

fn rounded_coordinate(value: f64, axis: usize) -> Result<i32, SolidVoxelizeError> {
    if !value.is_finite() || value < i32::MIN as f64 || value > i32::MAX as f64 {
        return Err(SolidVoxelizeError::CoordinateOutOfRange { axis });
    }
    Ok(value as i32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::solid_voxel::contract::{
        SolidFaceDetail, SolidFillMode, SolidMaterialSnapshot, SolidMaterialTheme,
        SolidMeshSnapshot, SolidPalettePreset, SolidShellOptions, SolidTextureSnapshot,
    };
    use crate::solid_voxel::texture::{
        THREE_CLAMP_TO_EDGE_WRAPPING, THREE_MIRRORED_REPEAT_WRAPPING, THREE_REPEAT_WRAPPING,
    };

    fn input(
        positions: Vec<f32>,
        indices: Vec<u32>,
        triangle_materials: Vec<u16>,
        target_height: u32,
    ) -> SolidShellInput {
        SolidShellInput {
            mesh: SolidMeshSnapshot {
                positions,
                indices,
                triangle_materials,
                uvs: None,
                face_frame: None,
                materials: vec![],
                textures: vec![],
            },
            options: SolidShellOptions {
                target_height,
                alpha_threshold: 0.3,
                thickness_compensation: 0.0,
                fill_mode: SolidFillMode::Shell,
                palette_preset: SolidPalettePreset::Clean,
                face_detail: SolidFaceDetail::Off,
                material_theme: SolidMaterialTheme::Original,
                dithering: 0.0,
                skin_protection: false,
                skin_material_indices: vec![],
                emissive_mapping: true,
                emissive_material_indices: vec![],
                ruin_decoration: 0.0,
                exclude_gravity: true,
                exclude_rare: true,
            },
        }
    }

    fn triangle_input() -> SolidShellInput {
        input(
            vec![-1.0, 0.0, 0.0, 1.0, 2.0, 0.0, 1.0, 0.0, 0.0],
            vec![0, 1, 2],
            vec![0],
            5,
        )
    }

    #[test]
    fn computes_a_real_default_material_shell() {
        let result = voxelize_shell_reference(&triangle_input()).unwrap();

        assert!(result.stats.block_count > 0);
        assert_eq!(result.stats.block_count, result.stats.surface_block_count);
        assert_eq!(result.stats.filled_block_count, 0);
        assert_eq!(result.stats.alpha_rejected, 0);
        assert!(result.stats.triangle_box_tests >= result.stats.block_count);
        assert_eq!(result.palette.len(), 1);
        assert_eq!(result.palette[0].block_id, DEFAULT_BLOCK_ID);
        assert_eq!(result.palette[0].color, DEFAULT_BLOCK_COLOR);
    }

    #[test]
    fn chunk_output_is_canonical_and_repeatable() {
        let first = voxelize_shell_reference(&triangle_input()).unwrap();
        let second = voxelize_shell_reference(&triangle_input()).unwrap();

        assert_eq!(first, second);
        for pair in first.chunks.windows(2) {
            assert!(pair[0].chunk < pair[1].chunk);
        }
        for chunk in &first.chunks {
            assert_eq!(chunk.positions.len(), chunk.block_indices.len());
            assert!(chunk.positions.windows(2).all(|pair| pair[0] < pair[1]));
            assert!(chunk.block_indices.iter().all(|index| *index == 0));
        }
    }

    #[test]
    fn controlled_entry_reports_monotonic_triangle_progress() {
        let mut snapshots = Vec::new();
        let result = voxelize_shell_reference_with_control(&triangle_input(), |progress| {
            snapshots.push(progress);
            true
        })
        .unwrap();

        assert!(result.stats.block_count > 0);
        assert_eq!(snapshots.first().unwrap().completed_triangles, 0);
        assert_eq!(snapshots.last().unwrap().completed_triangles, 1);
        assert!(snapshots.windows(2).all(|pair| {
            pair[0].completed_triangles <= pair[1].completed_triangles
                && pair[0].candidate_tests <= pair[1].candidate_tests
        }));
    }

    #[test]
    fn controlled_entry_can_cancel_before_allocating_the_surface() {
        let result = voxelize_shell_reference_with_control(&triangle_input(), |_| false);

        assert_eq!(result, Err(SolidVoxelizeError::Cancelled));
    }

    #[test]
    fn support_preflight_accepts_migrated_emissive_mapping() {
        let mut input = triangle_input();
        input.mesh.materials = vec![SolidMaterialSnapshot {
            emissive: true,
            ..SolidMaterialSnapshot::default_material()
        }];

        assert_eq!(validate_shell_reference_support(&input), Ok(()));
    }

    #[test]
    fn accepts_empty_or_zero_default_material_mappings() {
        let mut empty = triangle_input();
        empty.mesh.triangle_materials.clear();
        let empty_result = voxelize_shell_reference(&empty).unwrap();
        let zero_result = voxelize_shell_reference(&triangle_input()).unwrap();

        assert_eq!(empty_result, zero_result);
    }

    fn flat_material(color: [f64; 4]) -> SolidMaterialSnapshot {
        SolidMaterialSnapshot {
            base_color: color,
            ..SolidMaterialSnapshot::default_material()
        }
    }

    fn pearlescent_material(emissive: bool) -> SolidMaterialSnapshot {
        SolidMaterialSnapshot {
            base_color: [238.0 / 255.0, 209.0 / 255.0, 228.0 / 255.0, 1.0],
            emissive,
            ..SolidMaterialSnapshot::default_material()
        }
    }

    #[test]
    fn material_emissive_flag_maps_to_the_typescript_light_block() {
        let mut input = triangle_input();
        input.mesh.materials = vec![pearlescent_material(true)];

        let result = voxelize_shell_reference(&input).unwrap();
        assert_eq!(result.palette.len(), 1);
        assert_eq!(
            result.palette[0].block_id,
            "minecraft:pearlescent_froglight",
        );
        assert_eq!(result.palette[0].color, [238, 209, 228]);
    }

    #[test]
    fn disabling_emissive_mapping_only_changes_the_matched_palette() {
        let mut emissive_input = triangle_input();
        emissive_input.mesh.materials = vec![pearlescent_material(true)];
        let emissive = voxelize_shell_reference(&emissive_input).unwrap();

        let mut normal_input = emissive_input;
        normal_input.options.emissive_mapping = false;
        let normal = voxelize_shell_reference(&normal_input).unwrap();

        assert_eq!(normal.stats.block_count, emissive.stats.block_count);
        assert_eq!(normal.bounds, emissive.bounds);
        assert_eq!(normal.chunks, emissive.chunks);
        assert!(normal.palette.iter().all(|entry| !matches!(
            entry.block_id.as_str(),
            "minecraft:end_rod"
                | "minecraft:glowstone"
                | "minecraft:sea_lantern"
                | "minecraft:ochre_froglight"
                | "minecraft:verdant_froglight"
                | "minecraft:pearlescent_froglight"
        )));
    }

    #[test]
    fn manually_selected_material_maps_even_without_the_snapshot_flag() {
        let mut input = triangle_input();
        input.mesh.materials = vec![pearlescent_material(false)];
        input.options.emissive_material_indices = vec![0];

        let result = voxelize_shell_reference(&input).unwrap();
        assert_eq!(
            result.palette[0].block_id,
            "minecraft:pearlescent_froglight",
        );
    }

    #[test]
    fn material_colors_match_and_compact_in_canonical_voxel_order() {
        let mut input = input(
            vec![
                -3.0, 0.0, 0.0, -1.0, 0.0, 0.0, -2.0, 2.0, 0.0, 1.0, 0.0, 0.0, 3.0, 0.0, 0.0, 2.0,
                2.0, 0.0,
            ],
            vec![0, 1, 2, 3, 4, 5],
            vec![0, 1],
            9,
        );
        input.mesh.materials = vec![
            flat_material([1.0, 0.0, 0.0, 1.0]),
            flat_material([0.0, 0.0, 1.0, 1.0]),
        ];

        let result = voxelize_shell_reference(&input).unwrap();
        assert_eq!(
            result
                .palette
                .iter()
                .map(|entry| entry.block_id.as_str())
                .collect::<Vec<_>>(),
            ["minecraft:orange_concrete", "minecraft:blue_wool"],
        );
        assert_eq!(result.stats.palette_size, 2);
        assert!(result
            .chunks
            .iter()
            .flat_map(|chunk| chunk.block_indices.iter())
            .all(|index| *index <= 1));
    }

    #[test]
    fn texture_alpha_equal_to_threshold_survives_while_previous_byte_is_rejected() {
        let mut input = input(
            vec![
                -3.0, 0.0, 0.0, -1.0, 0.0, 0.0, -2.0, 2.0, 0.0, 1.0, 0.0, 0.0, 3.0, 0.0, 0.0, 2.0,
                2.0, 0.0,
            ],
            vec![0, 1, 2, 3, 4, 5],
            vec![0, 1],
            9,
        );
        input.mesh.uvs = Some(vec![0.0; 12]);
        input.mesh.textures = vec![
            SolidTextureSnapshot {
                width: 1,
                height: 1,
                pixels: vec![255, 0, 0, 128],
            },
            SolidTextureSnapshot {
                width: 1,
                height: 1,
                pixels: vec![0, 0, 255, 127],
            },
        ];
        input.mesh.materials = vec![
            textured_material(0, THREE_CLAMP_TO_EDGE_WRAPPING),
            textured_material(1, THREE_CLAMP_TO_EDGE_WRAPPING),
        ];
        input.options.alpha_threshold = 128.0 / 255.0;

        let result = voxelize_shell_reference(&input).unwrap();
        assert_eq!(result.palette.len(), 1);
        assert_eq!(result.palette[0].block_id, "minecraft:orange_concrete");
        assert!(result.stats.alpha_rejected > 0);
        for chunk in &result.chunks {
            for local_index in &chunk.positions {
                let address = VoxelAddress {
                    chunk: chunk.chunk,
                    local_index: *local_index,
                };
                assert!(address.to_world().unwrap()[0] < 0);
            }
        }
    }

    #[test]
    fn repeat_mirror_and_clamp_keep_distinct_texture_samples() {
        let mut input = input(
            vec![
                -5.0, 0.0, 0.0, -3.0, 0.0, 0.0, -4.0, 2.0, 0.0, -1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0,
                2.0, 0.0, 3.0, 0.0, 0.0, 5.0, 0.0, 0.0, 4.0, 2.0, 0.0,
            ],
            vec![0, 1, 2, 3, 4, 5, 6, 7, 8],
            vec![0, 1, 2],
            9,
        );
        input.mesh.uvs = Some(vec![
            -0.25, 0.0, -0.25, 0.0, -0.25, 0.0, -0.25, 0.0, -0.25, 0.0, -0.25, 0.0, -0.25, 0.0,
            -0.25, 0.0, -0.25, 0.0,
        ]);
        input.mesh.textures = vec![SolidTextureSnapshot {
            width: 5,
            height: 1,
            pixels: vec![
                255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
            ],
        }];
        input.mesh.materials = vec![
            textured_material(0, THREE_REPEAT_WRAPPING),
            textured_material(0, THREE_MIRRORED_REPEAT_WRAPPING),
            textured_material(0, THREE_CLAMP_TO_EDGE_WRAPPING),
        ];

        let result = voxelize_shell_reference(&input).unwrap();
        let ids = result
            .palette
            .iter()
            .map(|entry| entry.block_id.as_str())
            .collect::<Vec<_>>();
        assert!(ids.contains(&"minecraft:blue_wool"));
        assert!(ids.contains(&"minecraft:lime_wool"));
        assert!(ids.contains(&"minecraft:orange_concrete"));
    }

    fn textured_material(texture_index: i32, wrap_s: i32) -> SolidMaterialSnapshot {
        SolidMaterialSnapshot {
            has_texture: true,
            texture_index,
            wrap_s,
            ..flat_material([1.0, 1.0, 1.0, 1.0])
        }
    }

    #[test]
    fn a_4064_height_line_is_not_rejected_by_a_policy_cap() {
        let tall_line = input(
            vec![0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.5, 0.0],
            vec![0, 1, 2],
            vec![],
            4_064,
        );

        let result = voxelize_shell_reference(&tall_line).unwrap();

        assert_eq!(result.stats.block_count, 4_064);
        assert_eq!(result.stats.dimensions, [1, 4_064, 1]);
        assert_eq!(result.bounds.min, [0, 0, 0]);
        assert_eq!(result.bounds.max, [0, 4_063, 0]);
        assert_eq!(result.chunks.len(), 127);
    }

    #[test]
    fn dominant_axis_scan_uses_projected_candidates_before_sat() {
        let mut candidates = Vec::new();
        let scan = visit_triangle_voxel_candidates(
            [0.0, 0.0, 0.0],
            [2.0, 0.0, 0.0],
            [0.0, 2.0, 0.0],
            0.5,
            &mut |point| {
                candidates.push(point);
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(scan.dominant_axis, Some(2));
        assert_eq!(scan.candidate_count as usize, candidates.len());
        assert!(!candidates.is_empty());
        assert!(candidates.iter().all(|point| (-1..=1).contains(&point[2])));
    }

    #[test]
    fn winner_selection_is_independent_of_insertion_order() {
        let address = VoxelAddress::from_world([0, 0, 0]);
        let later = SurfaceCandidate {
            winner: CandidateWinnerKey::new(0, 0.0, 9, 0, [3, 4, 5]).unwrap(),
            rgb: [0; 3],
            palette_role: PaletteRole::General,
            emissive: false,
        };
        let earlier = SurfaceCandidate {
            winner: CandidateWinnerKey::new(0, 0.0, 2, 0, [0, 1, 2]).unwrap(),
            rgb: [0; 3],
            palette_role: PaletteRole::General,
            emissive: false,
        };
        let mut surface = BTreeMap::new();

        insert_candidate(&mut surface, address, later);
        insert_candidate(&mut surface, address, earlier);

        assert_eq!(surface[&address], earlier);
    }

    #[test]
    fn stable_winner_prefers_feature_then_distance_then_triangle() {
        let base = SurfaceCandidate {
            winner: CandidateWinnerKey::new(0, 0.25, 8, 0, [0, 1, 2]).unwrap(),
            rgb: [0; 3],
            palette_role: PaletteRole::General,
            emissive: false,
        };
        let feature = SurfaceCandidate {
            winner: CandidateWinnerKey::new(1, 9.0, 9, 0, [3, 4, 5]).unwrap(),
            rgb: [0; 3],
            palette_role: PaletteRole::General,
            emissive: false,
        };
        let closer = SurfaceCandidate {
            winner: CandidateWinnerKey::new(0, 0.125, 10, 0, [6, 7, 8]).unwrap(),
            rgb: [0; 3],
            palette_role: PaletteRole::General,
            emissive: false,
        };
        let earlier = SurfaceCandidate {
            winner: CandidateWinnerKey::new(0, 0.25, 2, 0, [9, 10, 11]).unwrap(),
            rgb: [0; 3],
            palette_role: PaletteRole::General,
            emissive: false,
        };
        let address = VoxelAddress::from_world([0, 0, 0]);

        for winner in [feature, closer, earlier] {
            let mut surface = BTreeMap::new();
            insert_candidate(&mut surface, address, base);
            insert_candidate(&mut surface, address, winner);
            assert_eq!(surface[&address], winner);
        }
    }

    #[test]
    fn degenerate_point_scan_matches_the_typescript_yzx_order() {
        let mut candidates = Vec::new();
        let scan = visit_triangle_voxel_candidates(
            [0.5, 0.5, 0.5],
            [0.5, 0.5, 0.5],
            [0.5, 0.5, 0.5],
            0.5,
            &mut |point| {
                candidates.push(point);
                Ok(())
            },
        )
        .unwrap();

        assert_eq!(scan.dominant_axis, None);
        assert_eq!(scan.candidate_count, 8);
        assert_eq!(
            candidates,
            vec![
                [0, 0, 0],
                [1, 0, 0],
                [0, 0, 1],
                [1, 0, 1],
                [0, 1, 0],
                [1, 1, 0],
                [0, 1, 1],
                [1, 1, 1],
            ],
        );
    }
}
