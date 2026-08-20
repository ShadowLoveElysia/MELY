//! 原生实体体素结果的有界预览采样。
//!
//! 预览只按全局索引等距读取必要体素，不会展平或复制完整的
//! chunk 结果。导出始终使用 manager 中的全量原生结果。

use std::{error::Error, fmt};

use serde::Serialize;

use super::{
    chunk::{ChunkLayoutError, VoxelAddress},
    manager::{ManagerError, ResultHandle, SolidVoxelManager},
    voxelize::SolidShellResult,
};

pub const MAX_SOLID_VOXEL_PREVIEW_POINTS: usize = 200_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SolidVoxelLimitedPreview {
    pub handle: ResultHandle,
    pub points: Vec<[i32; 3]>,
    pub block_indices: Vec<u16>,
    pub total_points: u64,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LimitedPreviewError {
    InvalidMaxPoints {
        requested: usize,
        maximum: usize,
    },
    InconsistentChunkBuffers {
        chunk_index: usize,
        position_count: usize,
        block_index_count: usize,
    },
    PointCountOverflow,
    BlockCountMismatch {
        declared: u64,
        actual: u64,
    },
    InvalidWorldPosition {
        chunk_index: usize,
        point_index: usize,
        source: ChunkLayoutError,
    },
    InvalidPaletteIndex {
        chunk_index: usize,
        point_index: usize,
        palette_index: u16,
        palette_size: usize,
    },
    SamplingInvariant,
    Manager(ManagerError),
}

impl fmt::Display for LimitedPreviewError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidMaxPoints { requested, maximum } => write!(
                formatter,
                "solid voxel preview maxPoints must be between 1 and {maximum}, got {requested}",
            ),
            Self::InconsistentChunkBuffers {
                chunk_index,
                position_count,
                block_index_count,
            } => write!(
                formatter,
                "solid voxel preview chunk {chunk_index} has {position_count} positions but {block_index_count} block indices",
            ),
            Self::PointCountOverflow => {
                formatter.write_str("solid voxel preview point count overflows u64")
            }
            Self::BlockCountMismatch { declared, actual } => write!(
                formatter,
                "solid voxel preview block count mismatch: result declares {declared}, chunks contain {actual}",
            ),
            Self::InvalidWorldPosition {
                chunk_index,
                point_index,
                source,
            } => write!(
                formatter,
                "solid voxel preview point {point_index} in chunk {chunk_index} has an invalid world position: {source}",
            ),
            Self::InvalidPaletteIndex {
                chunk_index,
                point_index,
                palette_index,
                palette_size,
            } => write!(
                formatter,
                "solid voxel preview point {point_index} in chunk {chunk_index} uses palette index {palette_index}, but palette size is {palette_size}",
            ),
            Self::SamplingInvariant => formatter.write_str(
                "solid voxel preview sampling could not resolve every selected source point",
            ),
            Self::Manager(error) => error.fmt(formatter),
        }
    }
}

impl Error for LimitedPreviewError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::InvalidWorldPosition { source, .. } => Some(source),
            Self::Manager(error) => Some(error),
            _ => None,
        }
    }
}

impl From<ManagerError> for LimitedPreviewError {
    fn from(error: ManagerError) -> Self {
        Self::Manager(error)
    }
}

/// 通过 manager 的只读结果句柄生成有界预览。
pub fn limited_preview_for_handle(
    manager: &SolidVoxelManager,
    handle: ResultHandle,
    max_points: usize,
) -> Result<SolidVoxelLimitedPreview, LimitedPreviewError> {
    validate_max_points(max_points)?;
    let result = manager.result_for_handle(handle.clone())?;
    build_limited_preview(handle, &result, max_points)
}

fn build_limited_preview(
    handle: ResultHandle,
    result: &SolidShellResult,
    max_points: usize,
) -> Result<SolidVoxelLimitedPreview, LimitedPreviewError> {
    validate_max_points(max_points)?;
    let total_points = validated_point_count(result)?;
    let maximum_points =
        u64::try_from(max_points).map_err(|_| LimitedPreviewError::PointCountOverflow)?;
    let sample_count_u64 = total_points.min(maximum_points);
    let sample_count =
        usize::try_from(sample_count_u64).map_err(|_| LimitedPreviewError::PointCountOverflow)?;
    let mut points = Vec::with_capacity(sample_count);
    let mut block_indices = Vec::with_capacity(sample_count);
    let mut chunk_start = 0_u64;
    let mut sample_index = 0_u64;

    for (chunk_index, chunk) in result.chunks.iter().enumerate() {
        if sample_index == sample_count_u64 {
            break;
        }
        let chunk_count = u64::try_from(chunk.positions.len())
            .map_err(|_| LimitedPreviewError::PointCountOverflow)?;
        let chunk_end = chunk_start
            .checked_add(chunk_count)
            .ok_or(LimitedPreviewError::PointCountOverflow)?;

        while sample_index < sample_count_u64 {
            let source_index = sampled_source_index(sample_index, sample_count_u64, total_points);
            if source_index >= chunk_end {
                break;
            }
            if source_index < chunk_start {
                return Err(LimitedPreviewError::SamplingInvariant);
            }
            let local_offset = usize::try_from(source_index - chunk_start)
                .map_err(|_| LimitedPreviewError::PointCountOverflow)?;
            let palette_index = chunk.block_indices[local_offset];
            if usize::from(palette_index) >= result.palette.len() {
                return Err(LimitedPreviewError::InvalidPaletteIndex {
                    chunk_index,
                    point_index: local_offset,
                    palette_index,
                    palette_size: result.palette.len(),
                });
            }
            let world = VoxelAddress {
                chunk: chunk.chunk,
                local_index: chunk.positions[local_offset],
            }
            .to_world()
            .map_err(|source| LimitedPreviewError::InvalidWorldPosition {
                chunk_index,
                point_index: local_offset,
                source,
            })?;
            points.push(world);
            block_indices.push(palette_index);
            sample_index += 1;
        }
        chunk_start = chunk_end;
    }

    if sample_index != sample_count_u64 {
        return Err(LimitedPreviewError::SamplingInvariant);
    }
    Ok(SolidVoxelLimitedPreview {
        handle,
        points,
        block_indices,
        total_points,
        truncated: sample_count_u64 < total_points,
    })
}

fn validate_max_points(max_points: usize) -> Result<(), LimitedPreviewError> {
    if max_points == 0 || max_points > MAX_SOLID_VOXEL_PREVIEW_POINTS {
        return Err(LimitedPreviewError::InvalidMaxPoints {
            requested: max_points,
            maximum: MAX_SOLID_VOXEL_PREVIEW_POINTS,
        });
    }
    Ok(())
}

fn validated_point_count(result: &SolidShellResult) -> Result<u64, LimitedPreviewError> {
    let mut total_points = 0_u64;
    for (chunk_index, chunk) in result.chunks.iter().enumerate() {
        if chunk.positions.len() != chunk.block_indices.len() {
            return Err(LimitedPreviewError::InconsistentChunkBuffers {
                chunk_index,
                position_count: chunk.positions.len(),
                block_index_count: chunk.block_indices.len(),
            });
        }
        let chunk_count = u64::try_from(chunk.positions.len())
            .map_err(|_| LimitedPreviewError::PointCountOverflow)?;
        total_points = total_points
            .checked_add(chunk_count)
            .ok_or(LimitedPreviewError::PointCountOverflow)?;
    }
    if total_points != result.stats.block_count {
        return Err(LimitedPreviewError::BlockCountMismatch {
            declared: result.stats.block_count,
            actual: total_points,
        });
    }
    Ok(total_points)
}

fn sampled_source_index(sample_index: u64, sample_count: u64, total_points: u64) -> u64 {
    if sample_count <= 1 {
        return 0;
    }
    let numerator = u128::from(sample_index) * u128::from(total_points - 1);
    let denominator = u128::from(sample_count - 1);
    u64::try_from(numerator / denominator).expect("sampled source index never exceeds u64")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::solid_voxel::{
        chunk::{ChunkCoordinate, CHUNK_VOLUME},
        voxelize::{SolidShellBounds, SolidShellChunk, SolidShellPaletteEntry, SolidShellStats},
    };

    fn palette(size: usize) -> Vec<SolidShellPaletteEntry> {
        (0..size)
            .map(|index| SolidShellPaletteEntry {
                block_id: format!("minecraft:test_{index}"),
                color: [index as u8; 3],
            })
            .collect()
    }

    fn result(chunks: Vec<SolidShellChunk>, declared_count: u64) -> SolidShellResult {
        SolidShellResult {
            chunks,
            palette: palette(16),
            stats: SolidShellStats {
                block_count: declared_count,
                surface_block_count: declared_count,
                filled_block_count: 0,
                skin_block_count: 0,
                alpha_rejected: 0,
                triangle_box_tests: 0,
                palette_size: 16,
                dimensions: [1, 1, 1],
            },
            bounds: SolidShellBounds {
                min: [0, 0, 0],
                max: [0, 0, 0],
            },
        }
    }

    fn handle() -> ResultHandle {
        ResultHandle {
            id: "7".to_owned(),
            generation: "1".to_owned(),
        }
    }

    #[test]
    fn small_results_keep_every_point_without_flattening_chunks() {
        let source = result(
            vec![
                SolidShellChunk {
                    chunk: ChunkCoordinate::new(-1, 2, 3),
                    positions: vec![0, 31 + 32 * (4 + 32 * 5)],
                    block_indices: vec![7, 8],
                },
                SolidShellChunk {
                    chunk: ChunkCoordinate::new(1, -1, 0),
                    positions: vec![2 + 32 * (6 + 32 * 9)],
                    block_indices: vec![4],
                },
            ],
            3,
        );

        let preview = build_limited_preview(handle(), &source, 10).unwrap();

        assert_eq!(
            preview.points,
            vec![[-32, 64, 96], [-1, 69, 100], [34, -23, 6]]
        );
        assert_eq!(preview.block_indices, vec![7, 8, 4]);
        assert_eq!(preview.total_points, 3);
        assert!(!preview.truncated);
    }

    #[test]
    fn sampling_is_deterministic_and_covers_first_and_last_points() {
        let source = result(
            vec![
                SolidShellChunk {
                    chunk: ChunkCoordinate::new(0, 0, 0),
                    positions: (0..5).collect(),
                    block_indices: (0..5).collect(),
                },
                SolidShellChunk {
                    chunk: ChunkCoordinate::new(9, 9, 9),
                    positions: Vec::new(),
                    block_indices: Vec::new(),
                },
                SolidShellChunk {
                    chunk: ChunkCoordinate::new(1, 0, 0),
                    positions: (0..5).collect(),
                    block_indices: (5..10).collect(),
                },
            ],
            10,
        );

        let first = build_limited_preview(handle(), &source, 4).unwrap();
        let second = build_limited_preview(handle(), &source, 4).unwrap();

        assert_eq!(first, second);
        assert_eq!(
            first.points,
            vec![[0, 0, 0], [3, 0, 0], [33, 0, 0], [36, 0, 0]]
        );
        assert_eq!(first.block_indices, vec![0, 3, 6, 9]);
        assert_eq!(first.total_points, 10);
        assert!(first.truncated);
    }

    #[test]
    fn one_point_budget_selects_the_first_point_deterministically() {
        let source = result(
            vec![SolidShellChunk {
                chunk: ChunkCoordinate::new(0, 0, 0),
                positions: vec![2, 8],
                block_indices: vec![1, 2],
            }],
            2,
        );

        let preview = build_limited_preview(handle(), &source, 1).unwrap();

        assert_eq!(preview.points, vec![[2, 0, 0]]);
        assert_eq!(preview.block_indices, vec![1]);
        assert!(preview.truncated);
    }

    #[test]
    fn preview_limit_is_strictly_bounded() {
        let source = result(Vec::new(), 0);

        assert!(matches!(
            build_limited_preview(handle(), &source, 0),
            Err(LimitedPreviewError::InvalidMaxPoints { requested: 0, .. })
        ));
        assert!(matches!(
            build_limited_preview(handle(), &source, MAX_SOLID_VOXEL_PREVIEW_POINTS + 1,),
            Err(LimitedPreviewError::InvalidMaxPoints { .. })
        ));
        let empty = build_limited_preview(handle(), &source, 1).unwrap();
        assert!(empty.points.is_empty());
        assert!(!empty.truncated);
    }

    #[test]
    fn malformed_chunk_storage_is_rejected_before_sampling() {
        let inconsistent = result(
            vec![SolidShellChunk {
                chunk: ChunkCoordinate::new(0, 0, 0),
                positions: vec![0, 1],
                block_indices: vec![0],
            }],
            2,
        );
        assert!(matches!(
            build_limited_preview(handle(), &inconsistent, 1),
            Err(LimitedPreviewError::InconsistentChunkBuffers { chunk_index: 0, .. })
        ));

        let mismatched_count = result(
            vec![SolidShellChunk {
                chunk: ChunkCoordinate::new(0, 0, 0),
                positions: vec![0],
                block_indices: vec![0],
            }],
            2,
        );
        assert!(matches!(
            build_limited_preview(handle(), &mismatched_count, 1),
            Err(LimitedPreviewError::BlockCountMismatch {
                declared: 2,
                actual: 1,
            })
        ));
    }

    #[test]
    fn sampled_positions_and_palette_indices_are_validated() {
        let invalid_position = result(
            vec![SolidShellChunk {
                chunk: ChunkCoordinate::new(0, 0, 0),
                positions: vec![CHUNK_VOLUME],
                block_indices: vec![0],
            }],
            1,
        );
        assert!(matches!(
            build_limited_preview(handle(), &invalid_position, 1),
            Err(LimitedPreviewError::InvalidWorldPosition { .. })
        ));

        let invalid_palette = result(
            vec![SolidShellChunk {
                chunk: ChunkCoordinate::new(0, 0, 0),
                positions: vec![0],
                block_indices: vec![16],
            }],
            1,
        );
        assert!(matches!(
            build_limited_preview(handle(), &invalid_palette, 1),
            Err(LimitedPreviewError::InvalidPaletteIndex {
                palette_index: 16,
                palette_size: 16,
                ..
            })
        ));
    }

    #[test]
    fn sampling_math_handles_u64_range_without_intermediate_overflow() {
        assert_eq!(sampled_source_index(0, 200_000, u64::MAX), 0);
        assert_eq!(
            sampled_source_index(199_999, 200_000, u64::MAX),
            u64::MAX - 1,
        );
        let middle = sampled_source_index(100_000, 200_000, u64::MAX);
        assert!(middle > 0 && middle < u64::MAX - 1);
    }

    #[test]
    fn response_serializes_with_the_frontend_protocol_field_names() {
        let response = SolidVoxelLimitedPreview {
            handle: handle(),
            points: vec![[0, -2_032, 0], [0, 2_031, 0]],
            block_indices: vec![0, 1],
            total_points: 4_064,
            truncated: true,
        };

        assert_eq!(
            serde_json::to_value(response).unwrap(),
            serde_json::json!({
                "handle": { "id": "7", "generation": "1" },
                "points": [[0, -2_032, 0], [0, 2_031, 0]],
                "blockIndices": [0, 1],
                "totalPoints": 4_064,
                "truncated": true,
            }),
        );
    }
}
