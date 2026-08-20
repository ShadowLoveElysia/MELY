//! 32³ chunk 独占的 Rayon shell 路径。
//!
//! 该路径与 `voxelize` 的单线程参考内核共享材质语义，
//! 但每个 chunk 仅由一个 Rayon 任务写入，避免全局热锁。

use std::{
    collections::{btree_map::Entry, BTreeMap},
    error::Error,
    fmt,
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use rayon::{prelude::*, ThreadPoolBuilder};

use super::{
    chunk::{
        encode_local_position, split_axis, CandidateWinnerKey, ChunkCoordinate, CHUNK_SIZE,
        CHUNK_VOLUME,
    },
    contract::{
        SolidFaceDetail, SolidFillMode, SolidMaterialSnapshot, SolidShellInput, SolidShellOptions,
        ValidatedSolidShellInput,
    },
    geometry::{
        closest_triangle_point, cross, length_squared, normalize_positions_js_equivalent, subtract,
        triangle_intersects_box, Point3,
    },
    palette::{create_block_palette, BlockPaletteOptions, PaletteRole},
    texture::{alpha_passes_threshold, MaterialSampleError, MaterialTextureState, TextureView},
    voxelize::{
        material_uses_emissive_mapping, validate_shell_reference_support, SolidShellBounds,
        SolidShellChunk, SolidShellPaletteEntry, SolidShellResult, SolidShellStats,
        SolidVoxelizeError,
    },
};

const DEGENERATE_NORMAL_SQUARED: f64 = 1.0e-12;
const PROJECTION_AXIS_EPSILON_SQUARED: f64 = 1.0e-20;
const CANCELLATION_CHECK_INTERVAL: u64 = 4_096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParallelReferenceProgress {
    pub completed_chunks: u64,
    pub total_chunks: u64,
    pub candidate_tests: u64,
}

#[derive(Clone, Debug, Default)]
pub struct ParallelReferenceCancellationToken {
    cancelled: Arc<AtomicBool>,
}

impl ParallelReferenceCancellationToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParallelReferenceError {
    InvalidThreadCount,
    ThreadPoolBuild(String),
    Panicked(String),
    Unsupported(ParallelReferenceUnsupported),
    Voxelize(SolidVoxelizeError),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParallelReferenceUnsupported {
    FilledMode,
    FaceDetail,
    Dithering,
    RuinDecoration,
}

impl fmt::Display for ParallelReferenceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidThreadCount => {
                formatter.write_str("parallel reference worker count must be positive")
            }
            Self::ThreadPoolBuild(message) => {
                write!(
                    formatter,
                    "failed to build private reference pool: {message}"
                )
            }
            Self::Panicked(message) => {
                write!(formatter, "parallel reference task panicked: {message}")
            }
            Self::Unsupported(feature) => write!(
                formatter,
                "unsupported parallel reference subset: {feature:?}"
            ),
            Self::Voxelize(error) => error.fmt(formatter),
        }
    }
}

impl Error for ParallelReferenceError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Voxelize(error) => Some(error),
            _ => None,
        }
    }
}

impl From<SolidVoxelizeError> for ParallelReferenceError {
    fn from(error: SolidVoxelizeError) -> Self {
        Self::Voxelize(error)
    }
}

#[derive(Debug, Clone, Copy)]
struct PreparedTriangle {
    triangle_index: u32,
    vertex_indices: [u32; 3],
    vertices: [Point3; 3],
    material_index: u16,
    uv: [[f64; 2]; 3],
    palette_role: PaletteRole,
    emissive: bool,
    candidate_bounds: CandidateBounds,
}

#[derive(Debug, Clone, Copy)]
enum CandidateScanKind {
    Plane {
        w: usize,
        u: usize,
        v: usize,
        normal: Point3,
    },
    Line {
        axis: usize,
        u: usize,
        v: usize,
        start: Point3,
        direction: Point3,
    },
    Point,
}

#[derive(Debug, Clone, Copy)]
struct CandidateBounds {
    minimum: [i32; 3],
    maximum: [i32; 3],
    scan: CandidateScanKind,
}

#[derive(Debug, Clone)]
struct PreparedChunk {
    coordinate: ChunkCoordinate,
    triangle_indices: Vec<u32>,
}

#[derive(Debug, Clone)]
struct CompletedChunk {
    coordinate: ChunkCoordinate,
    voxels: Vec<CompletedVoxel>,
    triangle_box_tests: u64,
    alpha_rejected: u64,
}

#[derive(Debug, Clone, Copy)]
struct CompletedVoxel {
    local_index: u16,
    rgb: [u8; 3],
    palette_role: PaletteRole,
    emissive: bool,
}

#[derive(Debug, Clone, Copy)]
struct ChunkWinner {
    winner: CandidateWinnerKey,
    rgb: [u8; 3],
    palette_role: PaletteRole,
    emissive: bool,
}

/// Rayon worker 内复用的 chunk 暂存区。
///
/// 一个 chunk 的候选扫描只需要 32³ 个 winner 槽位。将它绑定到 Rayon
/// worker 后，连续处理 chunk 时只清理上一次实际触碰过的槽位，避免为每个
/// chunk 重复分配并初始化完整的 dense buffer。
#[derive(Debug)]
struct ChunkScratch {
    winners: Vec<Option<ChunkWinner>>,
    touched: Vec<u16>,
}

impl ChunkScratch {
    fn new() -> Self {
        Self {
            winners: vec![None; usize::from(CHUNK_VOLUME)],
            touched: Vec::with_capacity(usize::from(CHUNK_VOLUME)),
        }
    }

    fn reset(&mut self) {
        for local_index in self.touched.drain(..) {
            self.winners[usize::from(local_index)] = None;
        }
    }
}

#[derive(Debug, Default)]
struct ParallelProgressState {
    completed_chunks: u64,
    candidate_tests: u64,
}

/// 创建任务私有 Rayon pool，并以 chunk 独占模式体素化参考子集。
pub fn voxelize_shell_parallel_reference_subset(
    input: &SolidShellInput,
    worker_threads: usize,
) -> Result<SolidShellResult, ParallelReferenceError> {
    voxelize_shell_parallel_reference_subset_with_control(
        input,
        worker_threads,
        ParallelReferenceCancellationToken::new(),
        |_| {},
    )
}

/// 取消 token 与进度回调均可在 Rayon 工作线程中并发使用。
pub fn voxelize_shell_parallel_reference_subset_with_control<Progress>(
    input: &SolidShellInput,
    worker_threads: usize,
    cancellation: ParallelReferenceCancellationToken,
    progress: Progress,
) -> Result<SolidShellResult, ParallelReferenceError>
where
    Progress: Fn(ParallelReferenceProgress) + Sync + Send,
{
    if worker_threads == 0 {
        return Err(ParallelReferenceError::InvalidThreadCount);
    }

    let validated = input.validate().map_err(SolidVoxelizeError::from)?;
    validate_parallel_reference_support(input)?;
    let normalized =
        normalize_positions_js_equivalent(&input.mesh.positions, input.options.target_height)
            .map_err(SolidVoxelizeError::from)?;
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
    let triangles = prepare_triangles(&normalized.positions, input, validated.voxel_half_size)?;
    let chunks = bin_triangles_by_chunk(&triangles)?;
    let total_chunks =
        u64::try_from(chunks.len()).map_err(|_| SolidVoxelizeError::ArithmeticOverflow)?;
    let progress_state = Mutex::new(ParallelProgressState::default());

    progress(ParallelReferenceProgress {
        completed_chunks: 0,
        total_chunks,
        candidate_tests: 0,
    });
    if cancellation.is_cancelled() {
        return Err(SolidVoxelizeError::Cancelled.into());
    }

    let pool = ThreadPoolBuilder::new()
        .num_threads(worker_threads)
        .thread_name(|index| format!("mely-solid-reference-{index}"))
        .build()
        .map_err(|error| ParallelReferenceError::ThreadPoolBuild(error.to_string()))?;
    let outcomes = catch_unwind(AssertUnwindSafe(|| {
        pool.install(|| {
            chunks
                .par_iter()
                .map_init(ChunkScratch::new, |scratch, chunk| {
                    if cancellation.is_cancelled() {
                        return Err(SolidVoxelizeError::Cancelled);
                    }
                    let completed = process_chunk(
                        chunk,
                        &triangles,
                        &materials,
                        &textures,
                        input.options.alpha_threshold,
                        &validated,
                        &cancellation,
                        scratch,
                    )?;
                    // 每个 chunk 完成时才串行化一次，保证跨 Rayon 线程的回调值单调。
                    let mut progress_state = progress_state
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    progress_state.completed_chunks = progress_state
                        .completed_chunks
                        .checked_add(1)
                        .ok_or(SolidVoxelizeError::ArithmeticOverflow)?;
                    progress_state.candidate_tests = progress_state
                        .candidate_tests
                        .checked_add(completed.triangle_box_tests)
                        .ok_or(SolidVoxelizeError::ArithmeticOverflow)?;
                    progress(ParallelReferenceProgress {
                        completed_chunks: progress_state.completed_chunks,
                        total_chunks,
                        candidate_tests: progress_state.candidate_tests,
                    });
                    Ok(completed)
                })
                .collect::<Vec<Result<CompletedChunk, SolidVoxelizeError>>>()
        })
    }))
    .map_err(|payload| ParallelReferenceError::Panicked(panic_payload_message(payload)))?;

    let mut completed = Vec::with_capacity(outcomes.len());
    for outcome in outcomes {
        completed.push(outcome?);
    }
    completed.sort_by_key(|chunk| chunk.coordinate);
    build_result(completed, input.options.block_palette_options())
}

fn panic_payload_message(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        (*message).to_owned()
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else {
        "non-string panic payload".to_owned()
    }
}

/// 供 manager 在进入 Running 状态前预检并行参考子集边界。
pub fn validate_parallel_reference_support(
    input: &SolidShellInput,
) -> Result<(), ParallelReferenceError> {
    validate_shell_reference_support(input).map_err(ParallelReferenceError::from)?;
    validate_parallel_solid_options(&input.options).map_err(ParallelReferenceError::Unsupported)?;
    Ok(())
}

/// 检查原生 Rayon 子集的选项合同，不依赖网格内容。
///
/// 该函数会在创建任务时调用，避免不支持的选项先占用 manager 的单任务槽；
/// 上传阶段仍会再次通过 `validate_parallel_reference_support` 校验完整输入。
pub fn validate_parallel_solid_options(
    options: &SolidShellOptions,
) -> Result<(), ParallelReferenceUnsupported> {
    if options.fill_mode != SolidFillMode::Shell {
        return Err(ParallelReferenceUnsupported::FilledMode);
    }
    if options.face_detail != SolidFaceDetail::Off {
        return Err(ParallelReferenceUnsupported::FaceDetail);
    }
    if !options.dithering.is_finite() || options.dithering != 0.0 {
        return Err(ParallelReferenceUnsupported::Dithering);
    }
    if !options.ruin_decoration.is_finite() || options.ruin_decoration != 0.0 {
        return Err(ParallelReferenceUnsupported::RuinDecoration);
    }
    Ok(())
}

fn prepare_triangles(
    positions: &[f32],
    input: &SolidShellInput,
    half_size: f64,
) -> Result<Vec<PreparedTriangle>, SolidVoxelizeError> {
    input
        .mesh
        .indices
        .chunks_exact(3)
        .enumerate()
        .map(|(triangle_index, indices)| {
            let triangle_index = u32::try_from(triangle_index)
                .map_err(|_| SolidVoxelizeError::ArithmeticOverflow)?;
            let vertex_indices = [indices[0], indices[1], indices[2]];
            let vertices = [
                point_at(positions, vertex_indices[0]),
                point_at(positions, vertex_indices[1]),
                point_at(positions, vertex_indices[2]),
            ];
            let material_index = input
                .mesh
                .triangle_materials
                .get(triangle_index as usize)
                .copied()
                .unwrap_or(0);
            Ok(PreparedTriangle {
                triangle_index,
                vertex_indices,
                material_index,
                uv: [
                    uv_at(input.mesh.uvs.as_deref(), vertex_indices[0]),
                    uv_at(input.mesh.uvs.as_deref(), vertex_indices[1]),
                    uv_at(input.mesh.uvs.as_deref(), vertex_indices[2]),
                ],
                palette_role: if input.options.skin_protection
                    && input
                        .options
                        .skin_material_indices
                        .contains(&material_index)
                {
                    PaletteRole::SkinBase
                } else {
                    PaletteRole::General
                },
                emissive: material_uses_emissive_mapping(input, material_index),
                candidate_bounds: candidate_bounds(vertices, half_size)?,
                vertices,
            })
        })
        .collect()
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

fn candidate_bounds(
    [a, b, c]: [Point3; 3],
    half_size: f64,
) -> Result<CandidateBounds, SolidVoxelizeError> {
    let normal = cross(subtract(b, a), subtract(c, a));
    let normal_squared = length_squared(normal);
    if !normal_squared.is_finite() || normal_squared < DEGENERATE_NORMAL_SQUARED {
        return degenerate_candidate_bounds(a, b, c, half_size);
    }

    let w = dominant_axis(normal);
    let [u, v] = projected_axes(w);
    let mut minimum = [0_i32; 3];
    let mut maximum = [0_i32; 3];
    for axis in [u, v] {
        (minimum[axis], maximum[axis]) = coordinate_bounds(
            a[axis].min(b[axis]).min(c[axis]) - half_size,
            a[axis].max(b[axis]).max(c[axis]) + half_size,
            axis,
        )?;
    }

    let projected_corners = [
        [minimum[u] as f64, minimum[v] as f64],
        [minimum[u] as f64, maximum[v] as f64],
        [maximum[u] as f64, minimum[v] as f64],
        [maximum[u] as f64, maximum[v] as f64],
    ];
    let mut minimum_plane_w = f64::INFINITY;
    let mut maximum_plane_w = f64::NEG_INFINITY;
    for [center_u, center_v] in projected_corners {
        for corner_u in [center_u - half_size, center_u + half_size] {
            for corner_v in [center_v - half_size, center_v + half_size] {
                let plane_w = a[w]
                    - normal[u] / normal[w] * (corner_u - a[u])
                    - normal[v] / normal[w] * (corner_v - a[v]);
                minimum_plane_w = minimum_plane_w.min(plane_w);
                maximum_plane_w = maximum_plane_w.max(plane_w);
            }
        }
    }
    (minimum[w], maximum[w]) =
        coordinate_bounds(minimum_plane_w - half_size, maximum_plane_w + half_size, w)?;
    Ok(CandidateBounds {
        minimum,
        maximum,
        scan: CandidateScanKind::Plane { w, u, v, normal },
    })
}

fn degenerate_candidate_bounds(
    a: Point3,
    b: Point3,
    c: Point3,
    half_size: f64,
) -> Result<CandidateBounds, SolidVoxelizeError> {
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
        return Ok(CandidateBounds {
            minimum: coordinate_vector(
                [a[0] - half_size, a[1] - half_size, a[2] - half_size],
                true,
            )?,
            maximum: coordinate_vector(
                [a[0] + half_size, a[1] + half_size, a[2] + half_size],
                false,
            )?,
            scan: CandidateScanKind::Point,
        });
    }

    let start = longest.0;
    let end = longest.1;
    let direction = subtract(end, start);
    let axis = dominant_axis(direction);
    let [u, v] = projected_axes(axis);
    let mut minimum = [0_i32; 3];
    let mut maximum = [0_i32; 3];
    (minimum[axis], maximum[axis]) = coordinate_bounds(
        start[axis].min(end[axis]) - half_size,
        start[axis].max(end[axis]) + half_size,
        axis,
    )?;
    for projected in [u, v] {
        let source_minimum = start[projected].min(end[projected]);
        let source_maximum = start[projected].max(end[projected]);
        (minimum[projected], maximum[projected]) = coordinate_bounds(
            source_minimum - half_size * 2.0,
            source_maximum + half_size * 2.0,
            projected,
        )?;
    }
    Ok(CandidateBounds {
        minimum,
        maximum,
        scan: CandidateScanKind::Line {
            axis,
            u,
            v,
            start,
            direction,
        },
    })
}

fn coordinate_vector(values: Point3, minimum: bool) -> Result<[i32; 3], SolidVoxelizeError> {
    let mut result = [0_i32; 3];
    for axis in 0..3 {
        result[axis] = rounded_coordinate(
            if minimum {
                values[axis].ceil()
            } else {
                values[axis].floor()
            },
            axis,
        )?;
    }
    Ok(result)
}

fn bin_triangles_by_chunk(
    triangles: &[PreparedTriangle],
) -> Result<Vec<PreparedChunk>, SolidVoxelizeError> {
    let mut bins = BTreeMap::<ChunkCoordinate, Vec<u32>>::new();
    for triangle in triangles {
        let bounds = triangle.candidate_bounds;
        let minimum_chunk = bounds.minimum.map(|value| split_axis(value).0);
        let maximum_chunk = bounds.maximum.map(|value| split_axis(value).0);
        for chunk_y in minimum_chunk[1]..=maximum_chunk[1] {
            for chunk_z in minimum_chunk[2]..=maximum_chunk[2] {
                for chunk_x in minimum_chunk[0]..=maximum_chunk[0] {
                    bins.entry(ChunkCoordinate::new(chunk_x, chunk_y, chunk_z))
                        .or_default()
                        .push(triangle.triangle_index);
                }
            }
        }
    }
    if bins.is_empty() {
        return Err(SolidVoxelizeError::EmptySurface);
    }
    Ok(bins
        .into_iter()
        .map(|(coordinate, triangle_indices)| PreparedChunk {
            coordinate,
            triangle_indices,
        })
        .collect())
}

// 热路径需要同时接收只读几何/材质视图、取消控制和 worker 局部 scratch；
// 拆成共享上下文会增加间接访问，保留显式参数以便编译器内联和审计。
#[allow(clippy::too_many_arguments)]
fn process_chunk(
    chunk: &PreparedChunk,
    triangles: &[PreparedTriangle],
    materials: &[MaterialTextureState],
    textures: &[TextureView<'_>],
    alpha_threshold: f64,
    validated: &ValidatedSolidShellInput,
    cancellation: &ParallelReferenceCancellationToken,
    scratch: &mut ChunkScratch,
) -> Result<CompletedChunk, SolidVoxelizeError> {
    scratch.reset();
    let mut triangle_box_tests = 0_u64;
    let mut alpha_rejected = 0_u64;

    for triangle_index in &chunk.triangle_indices {
        let triangle = triangles
            .get(*triangle_index as usize)
            .ok_or(SolidVoxelizeError::ArithmeticOverflow)?;
        visit_triangle_candidates_in_chunk(
            triangle,
            chunk.coordinate,
            validated.voxel_half_size,
            |position| {
                triangle_box_tests = triangle_box_tests
                    .checked_add(1)
                    .ok_or(SolidVoxelizeError::ArithmeticOverflow)?;
                if triangle_box_tests.is_multiple_of(CANCELLATION_CHECK_INTERVAL)
                    && cancellation.is_cancelled()
                {
                    return Err(SolidVoxelizeError::Cancelled);
                }
                let [a, b, c] = triangle.vertices;
                let center = position.map(|value| value as f64);
                if !triangle_intersects_box(a, b, c, center, validated.voxel_half_size) {
                    return Ok(());
                }
                let closest = closest_triangle_point(center, a, b, c);
                let uv = [
                    triangle.uv[0][0] * closest.barycentric[0]
                        + triangle.uv[1][0] * closest.barycentric[1]
                        + triangle.uv[2][0] * closest.barycentric[2],
                    triangle.uv[0][1] * closest.barycentric[0]
                        + triangle.uv[1][1] * closest.barycentric[1]
                        + triangle.uv[2][1] * closest.barycentric[2],
                ];
                let material_index = usize::from(triangle.material_index);
                let material = if materials.len() == 1 {
                    &materials[0]
                } else {
                    materials
                        .get(material_index)
                        .expect("validated material index must resolve")
                };
                let sampled = material.sample(textures, uv).map_err(|reason| {
                    SolidVoxelizeError::MaterialSample {
                        material_index,
                        reason,
                    }
                })?;
                if !alpha_passes_threshold(sampled.alpha, alpha_threshold) {
                    alpha_rejected = alpha_rejected
                        .checked_add(1)
                        .ok_or(SolidVoxelizeError::ArithmeticOverflow)?;
                    return Ok(());
                }
                let distance_sq = length_squared(subtract(center, closest.point));
                let winner = CandidateWinnerKey::new(
                    0,
                    distance_sq,
                    triangle.triangle_index,
                    u32::from(triangle.material_index),
                    triangle.vertex_indices,
                )
                .map_err(|_| SolidVoxelizeError::InvalidCandidateDistance {
                    triangle_index: triangle.triangle_index as usize,
                })?;
                let local_index = local_index_in_chunk(position, chunk.coordinate)?;
                let slot = usize::from(local_index);
                let candidate = ChunkWinner {
                    winner,
                    rgb: sampled.rgb,
                    palette_role: triangle.palette_role,
                    emissive: triangle.emissive,
                };
                match scratch.winners[slot] {
                    None => {
                        scratch.winners[slot] = Some(candidate);
                        scratch.touched.push(local_index);
                    }
                    Some(existing) if winner.wins_over(existing.winner) => {
                        scratch.winners[slot] = Some(candidate);
                    }
                    Some(_) => {}
                }
                Ok(())
            },
        )?;
    }
    if cancellation.is_cancelled() {
        return Err(SolidVoxelizeError::Cancelled);
    }
    scratch.touched.sort_unstable();
    let voxels = scratch
        .touched
        .iter()
        .map(|local_index| {
            let winner = scratch.winners[usize::from(*local_index)]
                .expect("every touched chunk slot must retain an opaque winner");
            CompletedVoxel {
                local_index: *local_index,
                rgb: winner.rgb,
                palette_role: winner.palette_role,
                emissive: winner.emissive,
            }
        })
        .collect();
    Ok(CompletedChunk {
        coordinate: chunk.coordinate,
        voxels,
        triangle_box_tests,
        alpha_rejected,
    })
}

fn local_index_in_chunk(
    world: [i32; 3],
    chunk: ChunkCoordinate,
) -> Result<u16, SolidVoxelizeError> {
    let local = [
        checked_local_axis(world[0], chunk.x())?,
        checked_local_axis(world[1], chunk.y())?,
        checked_local_axis(world[2], chunk.z())?,
    ];
    encode_local_position(local).map_err(|_| SolidVoxelizeError::ArithmeticOverflow)
}

fn checked_local_axis(world: i32, chunk: i32) -> Result<u8, SolidVoxelizeError> {
    let base = chunk
        .checked_mul(CHUNK_SIZE)
        .ok_or(SolidVoxelizeError::ArithmeticOverflow)?;
    let local = world
        .checked_sub(base)
        .ok_or(SolidVoxelizeError::ArithmeticOverflow)?;
    u8::try_from(local).map_err(|_| SolidVoxelizeError::ArithmeticOverflow)
}

fn chunk_world_bounds(chunk: ChunkCoordinate) -> Result<([i32; 3], [i32; 3]), SolidVoxelizeError> {
    let minimum = [
        chunk_axis_minimum(chunk.x())?,
        chunk_axis_minimum(chunk.y())?,
        chunk_axis_minimum(chunk.z())?,
    ];
    let maximum = [
        minimum[0]
            .checked_add(CHUNK_SIZE - 1)
            .ok_or(SolidVoxelizeError::ArithmeticOverflow)?,
        minimum[1]
            .checked_add(CHUNK_SIZE - 1)
            .ok_or(SolidVoxelizeError::ArithmeticOverflow)?,
        minimum[2]
            .checked_add(CHUNK_SIZE - 1)
            .ok_or(SolidVoxelizeError::ArithmeticOverflow)?,
    ];
    Ok((minimum, maximum))
}

fn chunk_axis_minimum(chunk: i32) -> Result<i32, SolidVoxelizeError> {
    chunk
        .checked_mul(CHUNK_SIZE)
        .ok_or(SolidVoxelizeError::ArithmeticOverflow)
}

fn visit_triangle_candidates_in_chunk<Visitor>(
    triangle: &PreparedTriangle,
    chunk: ChunkCoordinate,
    half_size: f64,
    mut visitor: Visitor,
) -> Result<(), SolidVoxelizeError>
where
    Visitor: FnMut([i32; 3]) -> Result<(), SolidVoxelizeError>,
{
    let (chunk_minimum, chunk_maximum) = chunk_world_bounds(chunk)?;
    let minimum: [i32; 3] = std::array::from_fn(|axis| {
        triangle.candidate_bounds.minimum[axis].max(chunk_minimum[axis])
    });
    let maximum: [i32; 3] = std::array::from_fn(|axis| {
        triangle.candidate_bounds.maximum[axis].min(chunk_maximum[axis])
    });
    if (0..3).any(|axis| minimum[axis] > maximum[axis]) {
        return Ok(());
    }

    match triangle.candidate_bounds.scan {
        CandidateScanKind::Point => {
            for y in minimum[1]..=maximum[1] {
                for z in minimum[2]..=maximum[2] {
                    for x in minimum[0]..=maximum[0] {
                        visitor([x, y, z])?;
                    }
                }
            }
        }
        CandidateScanKind::Line {
            axis,
            u,
            v,
            start,
            direction,
        } => {
            for center_axis in minimum[axis]..=maximum[axis] {
                let t = ((center_axis as f64 - start[axis]) / direction[axis]).clamp(0.0, 1.0);
                let center_u = start[u] + direction[u] * t;
                let center_v = start[v] + direction[v] * t;
                let (line_minimum_u, line_maximum_u) =
                    coordinate_bounds(center_u - half_size * 2.0, center_u + half_size * 2.0, u)?;
                let (line_minimum_v, line_maximum_v) =
                    coordinate_bounds(center_v - half_size * 2.0, center_v + half_size * 2.0, v)?;
                let minimum_v = line_minimum_v.max(minimum[v]);
                let maximum_v = line_maximum_v.min(maximum[v]);
                let minimum_u = line_minimum_u.max(minimum[u]);
                let maximum_u = line_maximum_u.min(maximum[u]);
                if minimum_v > maximum_v || minimum_u > maximum_u {
                    continue;
                }
                for voxel_v in minimum_v..=maximum_v {
                    for voxel_u in minimum_u..=maximum_u {
                        let mut point = [0_i32; 3];
                        point[axis] = center_axis;
                        point[u] = voxel_u;
                        point[v] = voxel_v;
                        visitor(point)?;
                    }
                }
            }
        }
        CandidateScanKind::Plane { w, u, v, normal } => {
            let [a, b, c] = triangle.vertices;
            let projected = [[a[u], a[v]], [b[u], b[v]], [c[u], c[v]]];
            for center_v in minimum[v]..=maximum[v] {
                for center_u in minimum[u]..=maximum[u] {
                    if !projection_overlaps_cell(
                        &projected,
                        center_u as f64,
                        center_v as f64,
                        half_size,
                    ) {
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
                    let minimum_w = minimum_center_w.max(minimum[w]);
                    let maximum_w = maximum_center_w.min(maximum[w]);
                    if minimum_w > maximum_w {
                        continue;
                    }
                    for center_w in minimum_w..=maximum_w {
                        let mut point = [0_i32; 3];
                        point[u] = center_u;
                        point[v] = center_v;
                        point[w] = center_w;
                        visitor(point)?;
                    }
                }
            }
        }
    }
    Ok(())
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
        if axis[0] * axis[0] + axis[1] * axis[1] < PROJECTION_AXIS_EPSILON_SQUARED {
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

fn distance_squared(a: Point3, b: Point3) -> f64 {
    length_squared(subtract(b, a))
}

fn build_result(
    chunks: Vec<CompletedChunk>,
    palette_options: BlockPaletteOptions,
) -> Result<SolidShellResult, ParallelReferenceError> {
    let mut result_chunks = Vec::new();
    let source_palette = create_block_palette(palette_options);
    let mut palette_match_cache = source_palette.match_cache();
    let mut compact_palette = Vec::<SolidShellPaletteEntry>::new();
    let mut compact_indices = BTreeMap::<&'static str, u16>::new();
    let mut minimum = [i32::MAX; 3];
    let mut maximum = [i32::MIN; 3];
    let mut block_count = 0_u64;
    let mut skin_block_count = 0_u64;
    let mut alpha_rejected = 0_u64;
    let mut triangle_box_tests = 0_u64;

    for chunk in chunks {
        triangle_box_tests = triangle_box_tests
            .checked_add(chunk.triangle_box_tests)
            .ok_or(SolidVoxelizeError::ArithmeticOverflow)?;
        alpha_rejected = alpha_rejected
            .checked_add(chunk.alpha_rejected)
            .ok_or(SolidVoxelizeError::ArithmeticOverflow)?;
        if chunk.voxels.is_empty() {
            continue;
        }
        block_count = block_count
            .checked_add(
                u64::try_from(chunk.voxels.len())
                    .map_err(|_| SolidVoxelizeError::ArithmeticOverflow)?,
            )
            .ok_or(SolidVoxelizeError::ArithmeticOverflow)?;
        let mut positions = Vec::with_capacity(chunk.voxels.len());
        let mut block_indices = Vec::with_capacity(chunk.voxels.len());
        for voxel in chunk.voxels {
            let address = super::chunk::VoxelAddress {
                chunk: chunk.coordinate,
                local_index: voxel.local_index,
            };
            let world = address
                .to_world()
                .map_err(|_| SolidVoxelizeError::ArithmeticOverflow)?;
            for axis in 0..3 {
                minimum[axis] = minimum[axis].min(world[axis]);
                maximum[axis] = maximum[axis].max(world[axis]);
            }
            let source_entry = if voxel.emissive {
                palette_match_cache.match_emissive(voxel.rgb)
            } else {
                let source_index = palette_match_cache.match_color(voxel.rgb, voxel.palette_role);
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
            if voxel.palette_role == PaletteRole::SkinBase {
                skin_block_count = skin_block_count
                    .checked_add(1)
                    .ok_or(SolidVoxelizeError::ArithmeticOverflow)?;
            }
            positions.push(voxel.local_index);
            block_indices.push(compact_index);
        }
        result_chunks.push(SolidShellChunk {
            chunk: chunk.coordinate,
            positions,
            block_indices,
        });
    }
    if result_chunks.is_empty() {
        return Err(SolidVoxelizeError::EmptySurface.into());
    }
    let dimensions = [
        inclusive_dimension(minimum[0], maximum[0])?,
        inclusive_dimension(minimum[1], maximum[1])?,
        inclusive_dimension(minimum[2], maximum[2])?,
    ];
    Ok(SolidShellResult {
        chunks: result_chunks,
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
    let value = i64::from(maximum)
        .checked_sub(i64::from(minimum))
        .and_then(|span| span.checked_add(1))
        .ok_or(SolidVoxelizeError::ArithmeticOverflow)?;
    u64::try_from(value).map_err(|_| SolidVoxelizeError::ArithmeticOverflow)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::solid_voxel::{
        contract::{
            SolidMaterialSnapshot, SolidMaterialTheme, SolidMeshSnapshot, SolidPalettePreset,
            SolidShellOptions, SolidTextureSnapshot,
        },
        texture::THREE_CLAMP_TO_EDGE_WRAPPING,
        voxelize::voxelize_shell_reference,
    };

    fn input(positions: Vec<f32>, indices: Vec<u32>, target_height: u32) -> SolidShellInput {
        SolidShellInput {
            mesh: SolidMeshSnapshot {
                positions,
                indices,
                triangle_materials: Vec::new(),
                uvs: None,
                face_frame: None,
                materials: Vec::new(),
                textures: Vec::new(),
            },
            options: SolidShellOptions {
                target_height,
                alpha_threshold: 0.3,
                thickness_compensation: 0.0,
                fill_mode: SolidFillMode::Shell,
                palette_preset: Default::default(),
                face_detail: SolidFaceDetail::Off,
                material_theme: Default::default(),
                dithering: 0.0,
                skin_protection: false,
                skin_material_indices: Vec::new(),
                emissive_mapping: true,
                emissive_material_indices: Vec::new(),
                ruin_decoration: 0.0,
                exclude_gravity: true,
                exclude_rare: true,
            },
        }
    }

    fn cross_chunk_cube() -> SolidShellInput {
        let positions = vec![
            -1.0, 0.0, -1.0, 1.0, 0.0, -1.0, 1.0, 2.0, -1.0, -1.0, 2.0, -1.0, -1.0, 0.0, 1.0, 1.0,
            0.0, 1.0, 1.0, 2.0, 1.0, -1.0, 2.0, 1.0,
        ];
        let indices = vec![
            0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7,
            3, 1, 2, 6, 1, 6, 5,
        ];
        input(positions, indices, 66)
    }

    fn negative_cross_chunk_triangle() -> SolidShellInput {
        input(
            vec![-2.0, 0.0, -2.0, 2.0, 2.0, -2.0, 2.0, 0.0, 2.0],
            vec![0, 1, 2],
            66,
        )
    }

    fn flat_material(color: [f64; 4]) -> SolidMaterialSnapshot {
        SolidMaterialSnapshot {
            base_color: color,
            ..SolidMaterialSnapshot::default_material()
        }
    }

    fn textured_material(texture_index: i32) -> SolidMaterialSnapshot {
        SolidMaterialSnapshot {
            has_texture: true,
            texture_index,
            wrap_s: THREE_CLAMP_TO_EDGE_WRAPPING,
            ..flat_material([1.0, 1.0, 1.0, 1.0])
        }
    }

    fn textured_skin_input() -> SolidShellInput {
        let mut input = input(
            vec![
                -3.0, 0.0, 0.0, -1.0, 0.0, 0.0, -2.0, 2.0, 0.0, 1.0, 0.0, 0.0, 3.0, 0.0, 0.0, 2.0,
                2.0, 0.0,
            ],
            vec![0, 1, 2, 3, 4, 5],
            9,
        );
        input.mesh.triangle_materials = vec![0, 1];
        input.mesh.uvs = Some(vec![0.0; 12]);
        input.mesh.textures = vec![
            SolidTextureSnapshot {
                width: 1,
                height: 1,
                pixels: vec![255, 128, 64, 128],
            },
            SolidTextureSnapshot {
                width: 1,
                height: 1,
                pixels: vec![0, 0, 255, 127],
            },
        ];
        input.mesh.materials = vec![textured_material(0), textured_material(1)];
        input.options.alpha_threshold = 128.0 / 255.0;
        input.options.skin_protection = true;
        input.options.skin_material_indices = vec![0];
        input.options.palette_preset = SolidPalettePreset::Balanced;
        input.options.material_theme = SolidMaterialTheme::Original;
        input
    }

    #[test]
    fn one_two_four_and_eight_threads_match_the_reference() {
        let input = cross_chunk_cube();
        let reference = voxelize_shell_reference(&input).unwrap();

        for threads in [1, 2, 4, 8] {
            let parallel = voxelize_shell_parallel_reference_subset(&input, threads).unwrap();
            assert_eq!(parallel, reference, "worker_threads={threads}");
        }
    }

    #[test]
    fn textured_alpha_skin_and_palette_options_match_the_reference() {
        let input = textured_skin_input();
        let reference = voxelize_shell_reference(&input).unwrap();

        assert!(reference.stats.alpha_rejected > 0);
        assert_eq!(
            reference.stats.skin_block_count,
            reference.stats.block_count
        );
        for threads in [1, 2, 4, 8] {
            let parallel = voxelize_shell_parallel_reference_subset(&input, threads).unwrap();
            assert_eq!(parallel, reference, "worker_threads={threads}");
        }
    }

    #[test]
    fn material_color_compaction_matches_the_reference() {
        let mut input = input(
            vec![
                -3.0, 0.0, 0.0, -1.0, 0.0, 0.0, -2.0, 2.0, 0.0, 1.0, 0.0, 0.0, 3.0, 0.0, 0.0, 2.0,
                2.0, 0.0,
            ],
            vec![0, 1, 2, 3, 4, 5],
            9,
        );
        input.mesh.triangle_materials = vec![0, 1];
        input.mesh.materials = vec![
            flat_material([1.0, 0.0, 0.0, 1.0]),
            flat_material([0.0, 0.0, 1.0, 1.0]),
        ];
        let reference = voxelize_shell_reference(&input).unwrap();

        assert_eq!(reference.stats.palette_size, 2);
        for threads in [1, 2, 4, 8] {
            assert_eq!(
                voxelize_shell_parallel_reference_subset(&input, threads).unwrap(),
                reference,
                "worker_threads={threads}",
            );
        }
    }

    #[test]
    fn snapshot_and_manual_emissive_mapping_match_the_reference() {
        let mut snapshot_input = input(
            vec![-1.0, 0.0, 0.0, 1.0, 2.0, 0.0, 1.0, 0.0, 0.0],
            vec![0, 1, 2],
            5,
        );
        snapshot_input.mesh.triangle_materials = vec![0];
        snapshot_input.mesh.materials = vec![SolidMaterialSnapshot {
            base_color: [238.0 / 255.0, 209.0 / 255.0, 228.0 / 255.0, 1.0],
            emissive: true,
            ..SolidMaterialSnapshot::default_material()
        }];
        let reference = voxelize_shell_reference(&snapshot_input).unwrap();
        assert_eq!(
            reference.palette[0].block_id,
            "minecraft:pearlescent_froglight",
        );

        for threads in [1, 2, 4, 8] {
            assert_eq!(
                voxelize_shell_parallel_reference_subset(&snapshot_input, threads).unwrap(),
                reference,
                "worker_threads={threads}",
            );
        }

        let mut manual_input = snapshot_input;
        manual_input.mesh.materials[0].emissive = false;
        manual_input.options.emissive_material_indices = vec![0];
        let manual_reference = voxelize_shell_reference(&manual_input).unwrap();
        assert_eq!(manual_reference, reference);
        assert_eq!(
            voxelize_shell_parallel_reference_subset(&manual_input, 4).unwrap(),
            manual_reference,
        );
    }

    #[test]
    fn disabled_emissive_mapping_uses_the_normal_palette() {
        let mut input = input(
            vec![-1.0, 0.0, 0.0, 1.0, 2.0, 0.0, 1.0, 0.0, 0.0],
            vec![0, 1, 2],
            5,
        );
        input.mesh.materials = vec![SolidMaterialSnapshot {
            emissive: true,
            ..SolidMaterialSnapshot::default_material()
        }];
        input.options.emissive_mapping = false;

        let reference = voxelize_shell_reference(&input).unwrap();
        let parallel = voxelize_shell_parallel_reference_subset(&input, 4).unwrap();
        assert_eq!(parallel, reference);
        assert!(parallel.palette.iter().all(|entry| !matches!(
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
    fn negative_coordinates_keep_floor_chunk_layout() {
        let input = negative_cross_chunk_triangle();
        let reference = voxelize_shell_reference(&input).unwrap();
        let parallel = voxelize_shell_parallel_reference_subset(&input, 4).unwrap();

        assert_eq!(parallel, reference);
        assert!(parallel.bounds.min[0] < -32);
        assert!(parallel.chunks.iter().any(|chunk| chunk.chunk.x() < 0));
        assert!(parallel
            .chunks
            .windows(2)
            .all(|pair| pair[0].chunk < pair[1].chunk));
    }

    #[test]
    fn chunk_local_positions_are_strictly_increasing_and_unique() {
        let result = voxelize_shell_parallel_reference_subset(&cross_chunk_cube(), 8).unwrap();

        assert!(result.chunks.len() > 1);
        for chunk in result.chunks {
            assert!(chunk.positions.windows(2).all(|pair| pair[0] < pair[1]));
            assert_eq!(chunk.positions.len(), chunk.block_indices.len());
        }
    }

    #[test]
    fn chunk_scratch_reset_clears_touched_slots_and_reuses_capacity() {
        let mut scratch = ChunkScratch::new();
        let candidate = ChunkWinner {
            winner: CandidateWinnerKey::new(0, 0.0, 0, 0, [0, 1, 2]).unwrap(),
            rgb: [12, 34, 56],
            palette_role: PaletteRole::General,
            emissive: false,
        };
        scratch.winners[17] = Some(candidate);
        scratch.touched.push(17);
        let winners_capacity = scratch.winners.capacity();
        let touched_capacity = scratch.touched.capacity();

        scratch.reset();

        assert!(scratch.touched.is_empty());
        assert!(scratch.winners[17].is_none());
        assert_eq!(scratch.winners.capacity(), winners_capacity);
        assert_eq!(scratch.touched.capacity(), touched_capacity);
    }

    #[test]
    fn rejects_zero_threads_without_initializing_a_global_pool() {
        assert_eq!(
            voxelize_shell_parallel_reference_subset(&cross_chunk_cube(), 0),
            Err(ParallelReferenceError::InvalidThreadCount),
        );
    }

    #[test]
    fn preflight_rejects_unimplemented_content_modes() {
        let mut input = cross_chunk_cube();
        input.options.fill_mode = SolidFillMode::Filled;
        assert_eq!(
            validate_parallel_reference_support(&input),
            Err(ParallelReferenceError::Unsupported(
                ParallelReferenceUnsupported::FilledMode,
            )),
        );

        input.options.fill_mode = SolidFillMode::Shell;
        input.options.face_detail = SolidFaceDetail::Balanced;
        assert_eq!(
            validate_parallel_reference_support(&input),
            Err(ParallelReferenceError::Unsupported(
                ParallelReferenceUnsupported::FaceDetail,
            )),
        );

        input.options.face_detail = SolidFaceDetail::Off;
        input.options.dithering = f64::NAN;
        assert_eq!(
            validate_parallel_reference_support(&input),
            Err(ParallelReferenceError::Unsupported(
                ParallelReferenceUnsupported::Dithering,
            )),
        );

        input.options.dithering = 0.0;
        input.options.ruin_decoration = 0.25;
        assert_eq!(
            validate_parallel_reference_support(&input),
            Err(ParallelReferenceError::Unsupported(
                ParallelReferenceUnsupported::RuinDecoration,
            )),
        );
    }

    #[test]
    fn option_only_preflight_matches_the_supported_capability_subset() {
        let mut input = cross_chunk_cube();

        assert_eq!(validate_parallel_solid_options(&input.options), Ok(()),);

        input.options.fill_mode = SolidFillMode::Filled;
        assert_eq!(
            validate_parallel_solid_options(&input.options),
            Err(ParallelReferenceUnsupported::FilledMode),
        );

        input.options.fill_mode = SolidFillMode::Shell;
        input.options.face_detail = SolidFaceDetail::Strong;
        assert_eq!(
            validate_parallel_solid_options(&input.options),
            Err(ParallelReferenceUnsupported::FaceDetail),
        );

        input.options.face_detail = SolidFaceDetail::Off;
        input.options.dithering = f64::NAN;
        assert_eq!(
            validate_parallel_solid_options(&input.options),
            Err(ParallelReferenceUnsupported::Dithering),
        );

        input.options.dithering = 0.0;
        input.options.ruin_decoration = f64::INFINITY;
        assert_eq!(
            validate_parallel_solid_options(&input.options),
            Err(ParallelReferenceUnsupported::RuinDecoration),
        );
    }

    #[test]
    fn cancellation_is_observed_before_parallel_work() {
        let token = ParallelReferenceCancellationToken::new();
        token.cancel();

        assert_eq!(
            voxelize_shell_parallel_reference_subset_with_control(
                &cross_chunk_cube(),
                2,
                token,
                |_| {},
            ),
            Err(ParallelReferenceError::Voxelize(
                SolidVoxelizeError::Cancelled,
            )),
        );
    }

    #[test]
    fn progress_callback_panics_are_reported_as_task_errors() {
        let result = voxelize_shell_parallel_reference_subset_with_control(
            &cross_chunk_cube(),
            2,
            ParallelReferenceCancellationToken::new(),
            |state| {
                if state.completed_chunks > 0 {
                    panic!("progress callback failed");
                }
            },
        );

        assert!(matches!(
            result,
            Err(ParallelReferenceError::Panicked(message))
                if message == "progress callback failed"
        ));
    }
}
