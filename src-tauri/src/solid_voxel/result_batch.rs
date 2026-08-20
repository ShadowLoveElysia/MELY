//! 原生实体结果的有界二进制 chunk batch 编码。
//!
//! 批次只在 chunk 边界切分，首批携带完整 palette；游标由 manager 生成，
//! 编码器只负责把它作为受 CRC 保护的 opaque ASCII 数据写入 envelope。

use std::{collections::BTreeSet, error::Error, fmt};

use super::voxelize::SolidShellResult;

pub const RESULT_BATCH_MAGIC: [u8; 8] = *b"MLYRBAT\0";
pub const RESULT_BATCH_VERSION: u16 = 1;
pub const RESULT_BATCH_HEADER_SIZE: usize = 72;
pub const RESULT_BATCH_ALIGNMENT: usize = 8;
pub const MIN_RESULT_BATCH_BYTES: usize = 8 * 1024 * 1024;
pub const DEFAULT_RESULT_BATCH_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_RESULT_BATCH_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_RESULT_BATCH_CURSOR_BYTES: usize = 4_096;
pub const MAX_RESULT_BATCH_STRING_BYTES: usize = 1 << 20;

const FLAG_FIRST: u32 = 1;
const FLAG_LAST: u32 = 2;
const CHECKSUM_OFFSET: usize = 20;
const PALETTE_RECORD_FIXED_SIZE: usize = 12;
const CHUNK_RECORD_FIXED_SIZE: usize = 24;
const CHUNK_VOLUME: u16 = 32 * 32 * 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResultBatchHandle {
    pub id: u64,
    pub generation: u64,
}

#[derive(Debug, Clone, Copy)]
pub struct ResultBatchRequest<'a> {
    pub handle: ResultBatchHandle,
    pub start_chunk_index: u64,
    pub max_bytes: usize,
    pub next_cursor: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncodedResultBatch {
    pub bytes: Vec<u8>,
    pub start_chunk_index: u64,
    pub chunk_count: u32,
    pub total_chunk_count: u32,
    pub done: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResultBatchError {
    InvalidByteLimit {
        value: usize,
    },
    InvalidHandle,
    StartChunkOutOfRange {
        start: u64,
        total: u32,
    },
    MissingNextCursor,
    UnexpectedNextCursor,
    InvalidCursor,
    EmptyResult,
    EmptyPalette,
    PaletteTooLarge,
    InvalidPaletteEntry {
        index: usize,
    },
    DuplicatePaletteEntry {
        index: usize,
    },
    EmptyChunk {
        index: usize,
    },
    InconsistentChunkBuffers {
        index: usize,
    },
    InvalidLocalPosition {
        chunk_index: usize,
        value: u16,
    },
    LocalPositionsNotStrictlyIncreasing {
        chunk_index: usize,
        index: usize,
    },
    UnknownPaletteIndex {
        chunk_index: usize,
        value: u16,
    },
    ResultNotCanonicallyOrdered {
        chunk_index: usize,
    },
    ChunkExceedsBatchLimit {
        chunk_index: usize,
        required_bytes: usize,
    },
    ArithmeticOverflow,
}

impl fmt::Display for ResultBatchError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidByteLimit { value } => write!(formatter, "result batch byte limit must be within {MIN_RESULT_BATCH_BYTES}..={MAX_RESULT_BATCH_BYTES}, got {value}"),
            Self::InvalidHandle => formatter.write_str("result batch handle values must be non-zero"),
            Self::StartChunkOutOfRange { start, total } => write!(formatter, "result batch start chunk {start} exceeds total chunk count {total}"),
            Self::MissingNextCursor => formatter.write_str("a non-final result batch requires a next cursor"),
            Self::UnexpectedNextCursor => formatter.write_str("a final result batch must not contain a next cursor"),
            Self::InvalidCursor => formatter.write_str("result batch cursor must contain 1..=4096 printable ASCII bytes"),
            Self::EmptyResult => formatter.write_str("solid voxel result must contain at least one chunk"),
            Self::EmptyPalette => formatter.write_str("solid voxel result palette must not be empty"),
            Self::PaletteTooLarge => formatter.write_str("solid voxel result palette exceeds u16 addressability"),
            Self::InvalidPaletteEntry { index } => write!(formatter, "solid voxel palette entry {index} has an empty or oversized block id"),
            Self::DuplicatePaletteEntry { index } => write!(formatter, "solid voxel palette entry {index} duplicates an earlier block id"),
            Self::EmptyChunk { index } => write!(formatter, "solid voxel result chunk {index} must not be empty"),
            Self::InconsistentChunkBuffers { index } => write!(formatter, "solid voxel result chunk {index} has inconsistent position and palette buffers"),
            Self::InvalidLocalPosition { chunk_index, value } => write!(formatter, "solid voxel result chunk {chunk_index} contains invalid local position {value}"),
            Self::LocalPositionsNotStrictlyIncreasing { chunk_index, index } => write!(formatter, "solid voxel result chunk {chunk_index} local positions stop increasing at index {index}"),
            Self::UnknownPaletteIndex { chunk_index, value } => write!(formatter, "solid voxel result chunk {chunk_index} references unknown palette index {value}"),
            Self::ResultNotCanonicallyOrdered { chunk_index } => write!(formatter, "solid voxel result chunks stop following Y/Z/X order at index {chunk_index}"),
            Self::ChunkExceedsBatchLimit { chunk_index, required_bytes } => write!(formatter, "solid voxel result chunk {chunk_index} needs {required_bytes} bytes and cannot fit the requested batch"),
            Self::ArithmeticOverflow => formatter.write_str("solid voxel result batch exceeds supported integer arithmetic"),
        }
    }
}

impl Error for ResultBatchError {}

#[derive(Debug, Clone, Copy)]
struct BatchLayout {
    cursor_end: usize,
    palette_start: usize,
    palette_end: usize,
    chunk_end: usize,
    chunk_count: u32,
    total_chunk_count: u32,
    total_palette_count: u32,
    first: bool,
    last: bool,
}

/// 将规范化结果编码为不超过调用方上限的完整 chunk 批次。
pub fn encode_result_batch(
    result: &SolidShellResult,
    request: ResultBatchRequest<'_>,
) -> Result<EncodedResultBatch, ResultBatchError> {
    validate_request(request)?;
    let total_chunk_count =
        u32::try_from(result.chunks.len()).map_err(|_| ResultBatchError::ArithmeticOverflow)?;
    let total_palette_count =
        u32::try_from(result.palette.len()).map_err(|_| ResultBatchError::PaletteTooLarge)?;
    if total_chunk_count == 0 {
        return Err(ResultBatchError::EmptyResult);
    }
    if total_palette_count == 0 {
        return Err(ResultBatchError::EmptyPalette);
    }
    if total_palette_count > u32::from(u16::MAX) + 1 {
        return Err(ResultBatchError::PaletteTooLarge);
    }
    if request.start_chunk_index > u64::from(total_chunk_count) {
        return Err(ResultBatchError::StartChunkOutOfRange {
            start: request.start_chunk_index,
            total: total_chunk_count,
        });
    }
    validate_result(result, total_palette_count)?;

    let first = request.start_chunk_index == 0;
    let cursor_end = RESULT_BATCH_HEADER_SIZE
        .checked_add(request.next_cursor.map_or(0, str::len))
        .ok_or(ResultBatchError::ArithmeticOverflow)?;
    let palette_start = align8(cursor_end)?;
    let palette_length = if first {
        encoded_palette_length(result)?
    } else {
        0
    };
    let palette_end = palette_start
        .checked_add(palette_length)
        .ok_or(ResultBatchError::ArithmeticOverflow)?;
    if palette_end > request.max_bytes {
        return Err(ResultBatchError::ChunkExceedsBatchLimit {
            chunk_index: usize::try_from(request.start_chunk_index)
                .map_err(|_| ResultBatchError::ArithmeticOverflow)?,
            required_bytes: palette_end,
        });
    }

    let start = usize::try_from(request.start_chunk_index)
        .map_err(|_| ResultBatchError::ArithmeticOverflow)?;
    let mut chunk_end = palette_end;
    let mut end = start;
    while end < result.chunks.len() {
        let next_end = chunk_end
            .checked_add(encoded_chunk_length(result, end)?)
            .ok_or(ResultBatchError::ArithmeticOverflow)?;
        if next_end > request.max_bytes {
            break;
        }
        chunk_end = next_end;
        end += 1;
    }
    if end == start && start < result.chunks.len() {
        let required_bytes = chunk_end
            .checked_add(encoded_chunk_length(result, start)?)
            .ok_or(ResultBatchError::ArithmeticOverflow)?;
        return Err(ResultBatchError::ChunkExceedsBatchLimit {
            chunk_index: start,
            required_bytes,
        });
    }
    let chunk_count =
        u32::try_from(end - start).map_err(|_| ResultBatchError::ArithmeticOverflow)?;
    let last = end == result.chunks.len();
    match (last, request.next_cursor) {
        (true, Some(_)) => return Err(ResultBatchError::UnexpectedNextCursor),
        (false, None) => return Err(ResultBatchError::MissingNextCursor),
        _ => {}
    }

    let layout = BatchLayout {
        cursor_end,
        palette_start,
        palette_end,
        chunk_end,
        chunk_count,
        total_chunk_count,
        total_palette_count,
        first,
        last,
    };
    let bytes = write_batch(result, request, layout, start, end)?;
    Ok(EncodedResultBatch {
        bytes,
        start_chunk_index: request.start_chunk_index,
        chunk_count,
        total_chunk_count,
        done: last,
    })
}

fn validate_request(request: ResultBatchRequest<'_>) -> Result<(), ResultBatchError> {
    if !(MIN_RESULT_BATCH_BYTES..=MAX_RESULT_BATCH_BYTES).contains(&request.max_bytes) {
        return Err(ResultBatchError::InvalidByteLimit {
            value: request.max_bytes,
        });
    }
    if request.handle.id == 0 || request.handle.generation == 0 {
        return Err(ResultBatchError::InvalidHandle);
    }
    if let Some(cursor) = request.next_cursor {
        let bytes = cursor.as_bytes();
        if bytes.is_empty()
            || bytes.len() > MAX_RESULT_BATCH_CURSOR_BYTES
            || bytes.iter().any(|value| !(0x21..=0x7e).contains(value))
        {
            return Err(ResultBatchError::InvalidCursor);
        }
    }
    Ok(())
}

fn validate_result(result: &SolidShellResult, palette_count: u32) -> Result<(), ResultBatchError> {
    let mut block_ids = BTreeSet::new();
    for (index, entry) in result.palette.iter().enumerate() {
        if entry.block_id.is_empty() || entry.block_id.len() > MAX_RESULT_BATCH_STRING_BYTES {
            return Err(ResultBatchError::InvalidPaletteEntry { index });
        }
        if !block_ids.insert(entry.block_id.as_str()) {
            return Err(ResultBatchError::DuplicatePaletteEntry { index });
        }
    }
    for (chunk_index, chunk) in result.chunks.iter().enumerate() {
        if chunk_index > 0 && result.chunks[chunk_index - 1].chunk >= chunk.chunk {
            return Err(ResultBatchError::ResultNotCanonicallyOrdered { chunk_index });
        }
        if chunk.positions.is_empty() {
            return Err(ResultBatchError::EmptyChunk { index: chunk_index });
        }
        if chunk.positions.len() != chunk.block_indices.len() {
            return Err(ResultBatchError::InconsistentChunkBuffers { index: chunk_index });
        }
        let mut previous = None;
        for (position_index, (&position, &palette_index)) in chunk
            .positions
            .iter()
            .zip(chunk.block_indices.iter())
            .enumerate()
        {
            if position >= CHUNK_VOLUME {
                return Err(ResultBatchError::InvalidLocalPosition {
                    chunk_index,
                    value: position,
                });
            }
            if previous.is_some_and(|value| value >= position) {
                return Err(ResultBatchError::LocalPositionsNotStrictlyIncreasing {
                    chunk_index,
                    index: position_index,
                });
            }
            if u32::from(palette_index) >= palette_count {
                return Err(ResultBatchError::UnknownPaletteIndex {
                    chunk_index,
                    value: palette_index,
                });
            }
            previous = Some(position);
        }
    }
    Ok(())
}

fn encoded_palette_length(result: &SolidShellResult) -> Result<usize, ResultBatchError> {
    result.palette.iter().try_fold(0_usize, |total, entry| {
        let logical = PALETTE_RECORD_FIXED_SIZE
            .checked_add(entry.block_id.len())
            .ok_or(ResultBatchError::ArithmeticOverflow)?;
        total
            .checked_add(align8(logical)?)
            .ok_or(ResultBatchError::ArithmeticOverflow)
    })
}

fn encoded_chunk_length(
    result: &SolidShellResult,
    index: usize,
) -> Result<usize, ResultBatchError> {
    let values = result.chunks[index]
        .positions
        .len()
        .checked_mul(4)
        .ok_or(ResultBatchError::ArithmeticOverflow)?;
    align8(
        CHUNK_RECORD_FIXED_SIZE
            .checked_add(values)
            .ok_or(ResultBatchError::ArithmeticOverflow)?,
    )
}

fn write_batch(
    result: &SolidShellResult,
    request: ResultBatchRequest<'_>,
    layout: BatchLayout,
    start: usize,
    end: usize,
) -> Result<Vec<u8>, ResultBatchError> {
    let mut bytes = vec![0_u8; layout.chunk_end];
    bytes[..8].copy_from_slice(&RESULT_BATCH_MAGIC);
    put_u16(&mut bytes, 8, RESULT_BATCH_VERSION);
    put_u16(&mut bytes, 10, RESULT_BATCH_HEADER_SIZE as u16);
    put_u32(
        &mut bytes,
        12,
        (if layout.first { FLAG_FIRST } else { 0 }) | (if layout.last { FLAG_LAST } else { 0 }),
    );
    put_u32(
        &mut bytes,
        16,
        u32::try_from(layout.chunk_end).map_err(|_| ResultBatchError::ArithmeticOverflow)?,
    );
    put_u64(&mut bytes, 24, request.handle.id);
    put_u64(&mut bytes, 32, request.handle.generation);
    put_u64(&mut bytes, 40, request.start_chunk_index);
    put_u32(&mut bytes, 48, layout.chunk_count);
    put_u32(&mut bytes, 52, layout.total_chunk_count);
    put_u32(&mut bytes, 56, layout.total_palette_count);
    put_u32(
        &mut bytes,
        60,
        u32::try_from(layout.palette_end - layout.palette_start)
            .map_err(|_| ResultBatchError::ArithmeticOverflow)?,
    );
    put_u32(
        &mut bytes,
        64,
        u32::try_from(layout.cursor_end - RESULT_BATCH_HEADER_SIZE)
            .map_err(|_| ResultBatchError::ArithmeticOverflow)?,
    );
    if let Some(cursor) = request.next_cursor {
        bytes[RESULT_BATCH_HEADER_SIZE..layout.cursor_end].copy_from_slice(cursor.as_bytes());
    }

    let mut offset = layout.palette_start;
    if layout.first {
        for entry in &result.palette {
            let logical = PALETTE_RECORD_FIXED_SIZE
                .checked_add(entry.block_id.len())
                .ok_or(ResultBatchError::ArithmeticOverflow)?;
            put_u32(
                &mut bytes,
                offset,
                u32::try_from(logical).map_err(|_| ResultBatchError::ArithmeticOverflow)?,
            );
            put_u32(
                &mut bytes,
                offset + 4,
                u32::try_from(entry.block_id.len())
                    .map_err(|_| ResultBatchError::ArithmeticOverflow)?,
            );
            bytes[offset + 8..offset + 11].copy_from_slice(&entry.color);
            bytes[offset + PALETTE_RECORD_FIXED_SIZE..offset + logical]
                .copy_from_slice(entry.block_id.as_bytes());
            offset = offset
                .checked_add(align8(logical)?)
                .ok_or(ResultBatchError::ArithmeticOverflow)?;
        }
    }
    debug_assert_eq!(offset, layout.palette_end);
    for chunk in &result.chunks[start..end] {
        let block_count = chunk.positions.len();
        let logical = CHUNK_RECORD_FIXED_SIZE
            .checked_add(
                block_count
                    .checked_mul(4)
                    .ok_or(ResultBatchError::ArithmeticOverflow)?,
            )
            .ok_or(ResultBatchError::ArithmeticOverflow)?;
        put_u32(
            &mut bytes,
            offset,
            u32::try_from(logical).map_err(|_| ResultBatchError::ArithmeticOverflow)?,
        );
        for (axis, coordinate) in chunk.chunk.0.into_iter().enumerate() {
            put_i32(&mut bytes, offset + 4 + axis * 4, coordinate);
        }
        put_u32(
            &mut bytes,
            offset + 16,
            u32::try_from(block_count).map_err(|_| ResultBatchError::ArithmeticOverflow)?,
        );
        let positions_start = offset + CHUNK_RECORD_FIXED_SIZE;
        let indices_start = positions_start + block_count * 2;
        for (index, value) in chunk.positions.iter().copied().enumerate() {
            put_u16(&mut bytes, positions_start + index * 2, value);
        }
        for (index, value) in chunk.block_indices.iter().copied().enumerate() {
            put_u16(&mut bytes, indices_start + index * 2, value);
        }
        offset = offset
            .checked_add(align8(logical)?)
            .ok_or(ResultBatchError::ArithmeticOverflow)?;
    }
    debug_assert_eq!(offset, bytes.len());
    let checksum = crc32_with_zero_checksum_field(&bytes);
    put_u32(&mut bytes, CHECKSUM_OFFSET, checksum);
    Ok(bytes)
}

fn align8(value: usize) -> Result<usize, ResultBatchError> {
    value
        .checked_add(RESULT_BATCH_ALIGNMENT - 1)
        .map(|aligned| aligned & !(RESULT_BATCH_ALIGNMENT - 1))
        .ok_or(ResultBatchError::ArithmeticOverflow)
}

fn put_u16(bytes: &mut [u8], offset: usize, value: u16) {
    bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}
fn put_u32(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}
fn put_i32(bytes: &mut [u8], offset: usize, value: i32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}
fn put_u64(bytes: &mut [u8], offset: usize, value: u64) {
    bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}

/// CRC-32/ISO-HDLC；checksum 字段 20..23 始终视为零。
pub fn crc32_with_zero_checksum_field(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffff_u32;
    for (index, value) in bytes.iter().copied().enumerate() {
        let value = if (CHECKSUM_OFFSET..CHECKSUM_OFFSET + 4).contains(&index) {
            0
        } else {
            value
        };
        crc ^= u32::from(value);
        for _ in 0..8 {
            crc = if crc & 1 == 0 {
                crc >> 1
            } else {
                (crc >> 1) ^ 0xedb8_8320
            };
        }
    }
    !crc
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::solid_voxel::{
        chunk::ChunkCoordinate,
        voxelize::{SolidShellBounds, SolidShellChunk, SolidShellPaletteEntry, SolidShellStats},
    };

    fn result(
        chunks: Vec<SolidShellChunk>,
        palette: Vec<SolidShellPaletteEntry>,
    ) -> SolidShellResult {
        SolidShellResult {
            stats: SolidShellStats {
                block_count: chunks
                    .iter()
                    .map(|chunk| chunk.positions.len() as u64)
                    .sum(),
                surface_block_count: 0,
                filled_block_count: 0,
                skin_block_count: 0,
                alpha_rejected: 0,
                triangle_box_tests: 0,
                palette_size: palette.len() as u32,
                dimensions: [1, 1, 1],
            },
            bounds: SolidShellBounds {
                min: [0, 0, 0],
                max: [0, 0, 0],
            },
            chunks,
            palette,
        }
    }

    fn fixture() -> SolidShellResult {
        result(
            vec![SolidShellChunk {
                chunk: ChunkCoordinate::new(0, -1, 2),
                positions: vec![0, 32_767],
                block_indices: vec![0, 0],
            }],
            vec![SolidShellPaletteEntry {
                block_id: "minecraft:stone".to_owned(),
                color: [125, 125, 125],
            }],
        )
    }

    fn u32_at(bytes: &[u8], offset: usize) -> u32 {
        u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
    }

    #[test]
    fn matches_the_typescript_single_page_golden() {
        let encoded = encode_result_batch(
            &fixture(),
            ResultBatchRequest {
                handle: ResultBatchHandle {
                    id: 0x0102_0304_0506_0708,
                    generation: 9,
                },
                start_chunk_index: 0,
                max_bytes: MIN_RESULT_BATCH_BYTES,
                next_cursor: None,
            },
        )
        .unwrap();
        assert_eq!(encoded.bytes.len(), 136);
        assert_eq!(u32_at(&encoded.bytes, 20), 0xfc8b_9e4e);
        assert_eq!(u32_at(&encoded.bytes, 12), FLAG_FIRST | FLAG_LAST);
        assert_eq!(u32_at(&encoded.bytes, 60), 32);
        assert_eq!(u32_at(&encoded.bytes, 64), 0);
    }

    #[test]
    fn non_final_batch_embeds_cursor_and_obeys_the_limit() {
        let positions: Vec<u16> = (0..CHUNK_VOLUME).collect();
        let template = SolidShellChunk {
            chunk: ChunkCoordinate::new(0, 0, 0),
            positions,
            block_indices: vec![0; usize::from(CHUNK_VOLUME)],
        };
        let chunks = (0..80)
            .map(|index| {
                let mut chunk = template.clone();
                chunk.chunk = ChunkCoordinate::new(index, 0, 0);
                chunk
            })
            .collect();
        let many = result(chunks, fixture().palette);
        let encoded = encode_result_batch(
            &many,
            ResultBatchRequest {
                handle: ResultBatchHandle {
                    id: 1,
                    generation: 1,
                },
                start_chunk_index: 0,
                max_bytes: MIN_RESULT_BATCH_BYTES,
                next_cursor: Some("v1.opaque-signature"),
            },
        )
        .unwrap();
        assert!(!encoded.done);
        assert_eq!(u32_at(&encoded.bytes, 64), 19);
        assert_eq!(&encoded.bytes[72..91], b"v1.opaque-signature");
        assert!(encoded.bytes[91..96].iter().all(|value| *value == 0));
        assert!(encoded.bytes.len() <= MIN_RESULT_BATCH_BYTES);
    }

    #[test]
    fn rejects_invalid_bounds_cursor_and_result_buffers() {
        assert!(matches!(
            encode_result_batch(
                &fixture(),
                ResultBatchRequest {
                    handle: ResultBatchHandle {
                        id: 1,
                        generation: 1
                    },
                    start_chunk_index: 0,
                    max_bytes: MIN_RESULT_BATCH_BYTES - 1,
                    next_cursor: None
                }
            ),
            Err(ResultBatchError::InvalidByteLimit { .. })
        ));
        assert!(matches!(
            encode_result_batch(
                &fixture(),
                ResultBatchRequest {
                    handle: ResultBatchHandle {
                        id: 1,
                        generation: 1
                    },
                    start_chunk_index: 0,
                    max_bytes: MIN_RESULT_BATCH_BYTES,
                    next_cursor: Some("bad cursor")
                }
            ),
            Err(ResultBatchError::InvalidCursor)
        ));
        let mut invalid = fixture();
        invalid.chunks[0].block_indices[0] = 1;
        assert!(matches!(
            encode_result_batch(
                &invalid,
                ResultBatchRequest {
                    handle: ResultBatchHandle {
                        id: 1,
                        generation: 1
                    },
                    start_chunk_index: 0,
                    max_bytes: MIN_RESULT_BATCH_BYTES,
                    next_cursor: None
                }
            ),
            Err(ResultBatchError::UnknownPaletteIndex { .. })
        ));
    }
}
