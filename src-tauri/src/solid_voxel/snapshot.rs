//! Raw IPC 快照 envelope 的严格解码器。
//!
//! 固定的八个 section 会直接解码为 `SolidMeshSnapshot`。输入始终保持二进制
//! 传输，不经过 JSON 数字数组，也不会虚构 normals 等协议外字段。

use std::{error::Error, fmt};

use super::contract::{
    SolidFaceFrameSnapshot, SolidMaterialSnapshot, SolidMeshSnapshot, SolidTextureSnapshot,
};

pub const SNAPSHOT_MAGIC: [u8; 8] = *b"MLYSVOX\0";
pub const SNAPSHOT_PROTOCOL_VERSION: u16 = 1;
pub const SNAPSHOT_HEADER_SIZE: usize = 40;
pub const SNAPSHOT_DESCRIPTOR_SIZE: usize = 24;
pub const SNAPSHOT_SECTION_COUNT: usize = 8;
pub const SNAPSHOT_ALIGNMENT: usize = 8;

const CHECKSUM_OFFSET: usize = 24;
const CHECKSUM_END: usize = 28;
const DATA_OFFSET: usize = 232;
const MAX_RECORDS: usize = 1 << 24;
const MAX_STRING_BYTES: usize = 1 << 20;
const MATERIAL_FIXED_SIZE: usize = 224;
const MATERIAL_NUMERIC_VALUES: usize = 24;
const TEXTURE_RECORD_SIZE: usize = 24;
const FACE_FRAME_VALUES: usize = 14;
const MATERIAL_ALLOWED_FLAGS: u32 = 0b111;
const EXPECTED_ELEMENT_TYPES: [u16; SNAPSHOT_SECTION_COUNT] = [1, 2, 3, 1, 8, 6, 7, 4];

#[derive(Debug, Clone, PartialEq)]
pub struct DecodedSolidVoxelSnapshot {
    pub job_id: u64,
    pub mesh: SolidMeshSnapshot,
}

#[derive(Debug, Clone, Copy)]
struct Section<'a> {
    kind: u16,
    count: u32,
    bytes: &'a [u8],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SnapshotDecodeError {
    Truncated,
    InvalidMagic,
    UnsupportedVersion(u16),
    InvalidHeader,
    InvalidTotalLength,
    InvalidChecksum,
    InvalidDescriptor { kind: u16 },
    NonCanonicalEmptySection { kind: u16 },
    MisalignedSection { kind: u16 },
    OverlappingSection { kind: u16 },
    NonCanonicalSectionOffset { kind: u16 },
    NonZeroPadding { offset: usize },
    LengthOverflow,
    InvalidSectionLength { kind: u16 },
    InvalidElementCount { kind: u16 },
    NonFiniteValue { kind: u16, offset: usize },
    InvalidIndex { offset: usize },
    InvalidMaterialIndex { triangle: usize },
    InvalidFaceFrame,
    InvalidMaterialRecord { index: usize },
    InvalidMaterialFlags { index: usize },
    InvalidUtf8 { index: usize, english: bool },
    InvalidTextureRecord { index: usize },
}

impl fmt::Display for SnapshotDecodeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Truncated => formatter.write_str("snapshot envelope is truncated"),
            Self::InvalidMagic => formatter.write_str("snapshot envelope magic is invalid"),
            Self::UnsupportedVersion(version) => {
                write!(formatter, "unsupported snapshot envelope version {version}")
            }
            Self::InvalidHeader => formatter.write_str("snapshot envelope header is invalid"),
            Self::InvalidTotalLength => {
                formatter.write_str("snapshot envelope total length is not canonical")
            }
            Self::InvalidChecksum => formatter.write_str("snapshot envelope checksum mismatch"),
            Self::InvalidDescriptor { kind } => {
                write!(formatter, "snapshot section {kind} descriptor is invalid")
            }
            Self::NonCanonicalEmptySection { kind } => write!(
                formatter,
                "empty snapshot section {kind} must have zero count, offset and length",
            ),
            Self::MisalignedSection { kind } => {
                write!(
                    formatter,
                    "snapshot section {kind} offset is not 8-byte aligned"
                )
            }
            Self::OverlappingSection { kind } => {
                write!(formatter, "snapshot section {kind} overlaps prior data")
            }
            Self::NonCanonicalSectionOffset { kind } => {
                write!(
                    formatter,
                    "snapshot section {kind} has a non-canonical offset"
                )
            }
            Self::NonZeroPadding { offset } => {
                write!(formatter, "snapshot padding byte at {offset} must be zero")
            }
            Self::LengthOverflow => formatter.write_str("snapshot length arithmetic overflowed"),
            Self::InvalidSectionLength { kind } => {
                write!(
                    formatter,
                    "snapshot section {kind} has an invalid byte length"
                )
            }
            Self::InvalidElementCount { kind } => {
                write!(
                    formatter,
                    "snapshot section {kind} has an invalid element count"
                )
            }
            Self::NonFiniteValue { kind, offset } => write!(
                formatter,
                "snapshot section {kind} contains a non-finite value at byte {offset}",
            ),
            Self::InvalidIndex { offset } => {
                write!(formatter, "snapshot index {offset} is out of bounds")
            }
            Self::InvalidMaterialIndex { triangle } => {
                write!(
                    formatter,
                    "snapshot triangle {triangle} has an invalid material index"
                )
            }
            Self::InvalidFaceFrame => formatter.write_str("snapshot face frame is invalid"),
            Self::InvalidMaterialRecord { index } => {
                write!(formatter, "snapshot material record {index} is invalid")
            }
            Self::InvalidMaterialFlags { index } => {
                write!(formatter, "snapshot material {index} has unsupported flags")
            }
            Self::InvalidUtf8 { index, english } => write!(
                formatter,
                "snapshot material {index} {} is not valid UTF-8",
                if *english { "English name" } else { "name" },
            ),
            Self::InvalidTextureRecord { index } => {
                write!(formatter, "snapshot texture record {index} is invalid")
            }
        }
    }
}

impl Error for SnapshotDecodeError {}

fn exact(bytes: &[u8], offset: usize, length: usize) -> Result<&[u8], SnapshotDecodeError> {
    let end = offset
        .checked_add(length)
        .ok_or(SnapshotDecodeError::LengthOverflow)?;
    bytes.get(offset..end).ok_or(SnapshotDecodeError::Truncated)
}

fn u16_at(bytes: &[u8], offset: usize) -> Result<u16, SnapshotDecodeError> {
    Ok(u16::from_le_bytes(
        exact(bytes, offset, 2)?.try_into().expect("two-byte read"),
    ))
}

fn u32_at(bytes: &[u8], offset: usize) -> Result<u32, SnapshotDecodeError> {
    Ok(u32::from_le_bytes(
        exact(bytes, offset, 4)?.try_into().expect("four-byte read"),
    ))
}

fn i32_at(bytes: &[u8], offset: usize) -> Result<i32, SnapshotDecodeError> {
    Ok(i32::from_le_bytes(
        exact(bytes, offset, 4)?.try_into().expect("four-byte read"),
    ))
}

fn u64_at(bytes: &[u8], offset: usize) -> Result<u64, SnapshotDecodeError> {
    Ok(u64::from_le_bytes(
        exact(bytes, offset, 8)?
            .try_into()
            .expect("eight-byte read"),
    ))
}

fn f32_at(bytes: &[u8], offset: usize) -> Result<f32, SnapshotDecodeError> {
    Ok(f32::from_le_bytes(
        exact(bytes, offset, 4)?.try_into().expect("four-byte read"),
    ))
}

fn f64_at(bytes: &[u8], offset: usize) -> Result<f64, SnapshotDecodeError> {
    Ok(f64::from_le_bytes(
        exact(bytes, offset, 8)?
            .try_into()
            .expect("eight-byte read"),
    ))
}

fn align8(value: usize) -> Result<usize, SnapshotDecodeError> {
    value
        .checked_add((SNAPSHOT_ALIGNMENT - value % SNAPSHOT_ALIGNMENT) % SNAPSHOT_ALIGNMENT)
        .ok_or(SnapshotDecodeError::LengthOverflow)
}

fn require_zero(bytes: &[u8], start: usize, end: usize) -> Result<(), SnapshotDecodeError> {
    for (index, value) in exact(bytes, start, end.saturating_sub(start))?
        .iter()
        .copied()
        .enumerate()
    {
        if value != 0 {
            return Err(SnapshotDecodeError::NonZeroPadding {
                offset: start + index,
            });
        }
    }
    Ok(())
}

/// CRC-32/ISO-HDLC；计算时 checksum 字段 24..27 始终按零处理。
pub fn crc32_with_zero_checksum_field(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffff_u32;
    for (index, value) in bytes.iter().copied().enumerate() {
        let value = if (CHECKSUM_OFFSET..CHECKSUM_END).contains(&index) {
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

fn parse_sections(
    bytes: &[u8],
) -> Result<[Section<'_>; SNAPSHOT_SECTION_COUNT], SnapshotDecodeError> {
    let mut sections = [Section {
        kind: 0,
        count: 0,
        bytes: &[],
    }; SNAPSHOT_SECTION_COUNT];
    let mut previous_end = DATA_OFFSET;

    for (index, section) in sections.iter_mut().enumerate() {
        let descriptor = SNAPSHOT_HEADER_SIZE + index * SNAPSHOT_DESCRIPTOR_SIZE;
        let kind = u16_at(bytes, descriptor)?;
        let expected_kind = u16::try_from(index + 1).expect("eight sections fit u16");
        let element_type = u16_at(bytes, descriptor + 2)?;
        let count = u32_at(bytes, descriptor + 4)?;
        let offset = u32_at(bytes, descriptor + 8)?;
        let length = u32_at(bytes, descriptor + 12)?;
        if kind != expected_kind
            || element_type != EXPECTED_ELEMENT_TYPES[index]
            || u32_at(bytes, descriptor + 16)? != 0
            || u32_at(bytes, descriptor + 20)? != 0
        {
            return Err(SnapshotDecodeError::InvalidDescriptor {
                kind: expected_kind,
            });
        }
        if count == 0 || length == 0 {
            if count != 0 || offset != 0 || length != 0 {
                return Err(SnapshotDecodeError::NonCanonicalEmptySection { kind });
            }
            *section = Section {
                kind,
                count,
                bytes: &[],
            };
            continue;
        }

        let offset_usize =
            usize::try_from(offset).map_err(|_| SnapshotDecodeError::LengthOverflow)?;
        let length_usize =
            usize::try_from(length).map_err(|_| SnapshotDecodeError::LengthOverflow)?;
        if offset_usize % SNAPSHOT_ALIGNMENT != 0 {
            return Err(SnapshotDecodeError::MisalignedSection { kind });
        }
        let expected_offset = align8(previous_end)?;
        if offset_usize < expected_offset {
            return Err(SnapshotDecodeError::OverlappingSection { kind });
        }
        if offset_usize != expected_offset {
            return Err(SnapshotDecodeError::NonCanonicalSectionOffset { kind });
        }
        require_zero(bytes, previous_end, expected_offset)?;
        let payload = exact(bytes, offset_usize, length_usize)?;
        previous_end = offset_usize
            .checked_add(length_usize)
            .ok_or(SnapshotDecodeError::LengthOverflow)?;
        *section = Section {
            kind,
            count,
            bytes: payload,
        };
    }

    let canonical_end = align8(previous_end)?;
    if canonical_end != bytes.len() {
        return Err(SnapshotDecodeError::InvalidTotalLength);
    }
    require_zero(bytes, previous_end, canonical_end)?;
    Ok(sections)
}

fn primitive_length(section: Section<'_>, width: usize) -> Result<usize, SnapshotDecodeError> {
    let count = usize::try_from(section.count).map_err(|_| SnapshotDecodeError::LengthOverflow)?;
    let expected = count
        .checked_mul(width)
        .ok_or(SnapshotDecodeError::LengthOverflow)?;
    if section.bytes.len() != expected {
        return Err(SnapshotDecodeError::InvalidSectionLength { kind: section.kind });
    }
    Ok(count)
}

fn f32_section(section: Section<'_>) -> Result<Vec<f32>, SnapshotDecodeError> {
    let count = primitive_length(section, 4)?;
    let mut values = Vec::with_capacity(count);
    for index in 0..count {
        let offset = index * 4;
        let value = f32_at(section.bytes, offset)?;
        if !value.is_finite() {
            return Err(SnapshotDecodeError::NonFiniteValue {
                kind: section.kind,
                offset,
            });
        }
        values.push(value);
    }
    Ok(values)
}

fn u32_section(section: Section<'_>) -> Result<Vec<u32>, SnapshotDecodeError> {
    let count = primitive_length(section, 4)?;
    (0..count)
        .map(|index| u32_at(section.bytes, index * 4))
        .collect()
}

fn u16_section(section: Section<'_>) -> Result<Vec<u16>, SnapshotDecodeError> {
    let count = primitive_length(section, 2)?;
    (0..count)
        .map(|index| u16_at(section.bytes, index * 2))
        .collect()
}

fn face_frame(section: Section<'_>) -> Result<Option<SolidFaceFrameSnapshot>, SnapshotDecodeError> {
    if section.bytes.is_empty() {
        return Ok(None);
    }
    if section.count != 1 || section.bytes.len() != FACE_FRAME_VALUES * 8 {
        return Err(SnapshotDecodeError::InvalidFaceFrame);
    }
    let mut values = [0.0; FACE_FRAME_VALUES];
    for (index, value) in values.iter_mut().enumerate() {
        *value = f64_at(section.bytes, index * 8)?;
        if !value.is_finite() {
            return Err(SnapshotDecodeError::NonFiniteValue {
                kind: section.kind,
                offset: index * 8,
            });
        }
    }
    if values[12] <= 0.0 {
        return Err(SnapshotDecodeError::InvalidFaceFrame);
    }
    Ok(Some(SolidFaceFrameSnapshot {
        origin: values[0..3].try_into().expect("three origin values"),
        right: values[3..6].try_into().expect("three right values"),
        up: values[6..9].try_into().expect("three up values"),
        forward: values[9..12].try_into().expect("three forward values"),
        eye_distance: values[12],
        confidence: values[13],
    }))
}

fn textures(
    metadata: Section<'_>,
    pixels: Section<'_>,
) -> Result<Vec<SolidTextureSnapshot>, SnapshotDecodeError> {
    if metadata.bytes.is_empty() {
        if !pixels.bytes.is_empty() {
            return Err(SnapshotDecodeError::InvalidSectionLength { kind: pixels.kind });
        }
        return Ok(Vec::new());
    }
    let count = primitive_length(metadata, TEXTURE_RECORD_SIZE)?;
    if count > MAX_RECORDS || usize::try_from(pixels.count).ok() != Some(pixels.bytes.len()) {
        return Err(SnapshotDecodeError::InvalidElementCount {
            kind: metadata.kind,
        });
    }
    let mut result = Vec::with_capacity(count);
    let mut expected_pixel_offset = 0_usize;
    for index in 0..count {
        let offset = index * TEXTURE_RECORD_SIZE;
        let width = u32_at(metadata.bytes, offset)?;
        let height = u32_at(metadata.bytes, offset + 4)?;
        let pixel_offset = usize::try_from(u32_at(metadata.bytes, offset + 8)?)
            .map_err(|_| SnapshotDecodeError::LengthOverflow)?;
        let pixel_length = usize::try_from(u32_at(metadata.bytes, offset + 12)?)
            .map_err(|_| SnapshotDecodeError::LengthOverflow)?;
        let expected_length = usize::try_from(width)
            .ok()
            .and_then(|width| {
                usize::try_from(height)
                    .ok()
                    .and_then(|height| width.checked_mul(height))
            })
            .and_then(|area| area.checked_mul(4))
            .ok_or(SnapshotDecodeError::LengthOverflow)?;
        let pixel_end = pixel_offset
            .checked_add(pixel_length)
            .ok_or(SnapshotDecodeError::LengthOverflow)?;
        if width == 0
            || height == 0
            || pixel_offset != expected_pixel_offset
            || pixel_length != expected_length
            || pixel_end > pixels.bytes.len()
            || u32_at(metadata.bytes, offset + 16)? != 0
            || u32_at(metadata.bytes, offset + 20)? != 0
        {
            return Err(SnapshotDecodeError::InvalidTextureRecord { index });
        }
        result.push(SolidTextureSnapshot {
            width,
            height,
            pixels: exact(pixels.bytes, pixel_offset, pixel_length)?.to_vec(),
        });
        expected_pixel_offset = pixel_end;
    }
    if expected_pixel_offset != pixels.bytes.len() {
        return Err(SnapshotDecodeError::InvalidSectionLength { kind: pixels.kind });
    }
    Ok(result)
}

fn materials(
    section: Section<'_>,
    texture_count: usize,
) -> Result<Vec<SolidMaterialSnapshot>, SnapshotDecodeError> {
    if section.bytes.is_empty() {
        return Ok(Vec::new());
    }
    let count = usize::try_from(section.count).map_err(|_| SnapshotDecodeError::LengthOverflow)?;
    if count == 0 || count > MAX_RECORDS {
        return Err(SnapshotDecodeError::InvalidElementCount { kind: section.kind });
    }
    let mut result = Vec::with_capacity(count);
    let mut cursor = 0_usize;
    for index in 0..count {
        if cursor
            .checked_add(MATERIAL_FIXED_SIZE)
            .is_none_or(|end| end > section.bytes.len())
        {
            return Err(SnapshotDecodeError::InvalidMaterialRecord { index });
        }
        let record_length = usize::try_from(u32_at(section.bytes, cursor)?)
            .map_err(|_| SnapshotDecodeError::LengthOverflow)?;
        let name_length = usize::try_from(u32_at(section.bytes, cursor + 4)?)
            .map_err(|_| SnapshotDecodeError::LengthOverflow)?;
        let english_length = usize::try_from(u32_at(section.bytes, cursor + 8)?)
            .map_err(|_| SnapshotDecodeError::LengthOverflow)?;
        let expected_length = MATERIAL_FIXED_SIZE
            .checked_add(name_length)
            .and_then(|length| length.checked_add(english_length))
            .ok_or(SnapshotDecodeError::LengthOverflow)?;
        let record_end = cursor
            .checked_add(record_length)
            .ok_or(SnapshotDecodeError::LengthOverflow)?;
        if name_length > MAX_STRING_BYTES
            || english_length > MAX_STRING_BYTES
            || record_length != expected_length
            || record_end > section.bytes.len()
        {
            return Err(SnapshotDecodeError::InvalidMaterialRecord { index });
        }
        let flags = u32_at(section.bytes, cursor + 12)?;
        if flags & !MATERIAL_ALLOWED_FLAGS != 0 {
            return Err(SnapshotDecodeError::InvalidMaterialFlags { index });
        }
        let texture_index = i32_at(section.bytes, cursor + 16)?;
        if texture_index < -1
            || usize::try_from(texture_index)
                .ok()
                .is_some_and(|texture| texture >= texture_count)
            || u32_at(section.bytes, cursor + 28)? != 0
        {
            return Err(SnapshotDecodeError::InvalidMaterialRecord { index });
        }
        let mut numeric = [0.0; MATERIAL_NUMERIC_VALUES];
        for (value_index, value) in numeric.iter_mut().enumerate() {
            *value = f64_at(section.bytes, cursor + 32 + value_index * 8)?;
            if !value.is_finite() {
                return Err(SnapshotDecodeError::NonFiniteValue {
                    kind: section.kind,
                    offset: cursor + 32 + value_index * 8,
                });
            }
        }
        let name_start = cursor + MATERIAL_FIXED_SIZE;
        let english_start = name_start + name_length;
        let name = std::str::from_utf8(exact(section.bytes, name_start, name_length)?)
            .map_err(|_| SnapshotDecodeError::InvalidUtf8 {
                index,
                english: false,
            })?
            .to_owned();
        let english_name =
            std::str::from_utf8(exact(section.bytes, english_start, english_length)?)
                .map_err(|_| SnapshotDecodeError::InvalidUtf8 {
                    index,
                    english: true,
                })?
                .to_owned();
        result.push(SolidMaterialSnapshot {
            name,
            english_name,
            base_color: numeric[0..4].try_into().expect("four base color values"),
            texture_factor: numeric[4..8]
                .try_into()
                .expect("four texture factor values"),
            texture_additive_factor: numeric[8..12]
                .try_into()
                .expect("four additive factor values"),
            has_texture: flags & 1 != 0,
            texture_index,
            texture_matrix: numeric[12..21]
                .try_into()
                .expect("nine texture matrix values"),
            wrap_s: i32_at(section.bytes, cursor + 20)?,
            wrap_t: i32_at(section.bytes, cursor + 24)?,
            flip_y: flags & 2 != 0,
            ambient: numeric[21..24].try_into().expect("three ambient values"),
            emissive: flags & 4 != 0,
        });
        cursor = record_end;
    }
    if cursor != section.bytes.len() {
        return Err(SnapshotDecodeError::InvalidSectionLength { kind: section.kind });
    }
    Ok(result)
}

/// 完整校验并解码 raw snapshot；job id 保持精确 u64，供 manager 匹配 active job。
pub fn decode_solid_voxel_snapshot_envelope(
    bytes: &[u8],
) -> Result<DecodedSolidVoxelSnapshot, SnapshotDecodeError> {
    if bytes.len() < SNAPSHOT_HEADER_SIZE {
        return Err(SnapshotDecodeError::Truncated);
    }
    if exact(bytes, 0, 8)? != SNAPSHOT_MAGIC {
        return Err(SnapshotDecodeError::InvalidMagic);
    }
    let version = u16_at(bytes, 8)?;
    if version != SNAPSHOT_PROTOCOL_VERSION {
        return Err(SnapshotDecodeError::UnsupportedVersion(version));
    }
    if usize::from(u16_at(bytes, 10)?) != SNAPSHOT_HEADER_SIZE
        || usize::from(u16_at(bytes, 12)?) != SNAPSHOT_DESCRIPTOR_SIZE
        || usize::from(u16_at(bytes, 14)?) != SNAPSHOT_SECTION_COUNT
        || u32_at(bytes, 16)? != 0
        || u32_at(bytes, 28)? != 0
    {
        return Err(SnapshotDecodeError::InvalidHeader);
    }
    let total_length =
        usize::try_from(u32_at(bytes, 20)?).map_err(|_| SnapshotDecodeError::LengthOverflow)?;
    if total_length != bytes.len() || total_length < DATA_OFFSET || total_length % 8 != 0 {
        return Err(SnapshotDecodeError::InvalidTotalLength);
    }
    if u32_at(bytes, CHECKSUM_OFFSET)? != crc32_with_zero_checksum_field(bytes) {
        return Err(SnapshotDecodeError::InvalidChecksum);
    }
    let job_id = u64_at(bytes, 32)?;
    let sections = parse_sections(bytes)?;

    let positions = f32_section(sections[0])?;
    let indices = u32_section(sections[1])?;
    if positions.is_empty() || positions.len() % 3 != 0 {
        return Err(SnapshotDecodeError::InvalidElementCount { kind: 1 });
    }
    if indices.is_empty() || indices.len() % 3 != 0 {
        return Err(SnapshotDecodeError::InvalidElementCount { kind: 2 });
    }
    let vertex_count = positions.len() / 3;
    for (offset, index) in indices.iter().copied().enumerate() {
        if index as usize >= vertex_count {
            return Err(SnapshotDecodeError::InvalidIndex { offset });
        }
    }
    let triangle_count = indices.len() / 3;
    let triangle_materials = u16_section(sections[2])?;
    if !triangle_materials.is_empty() && triangle_materials.len() != triangle_count {
        return Err(SnapshotDecodeError::InvalidElementCount { kind: 3 });
    }
    let uvs = if sections[3].bytes.is_empty() {
        None
    } else {
        let uvs = f32_section(sections[3])?;
        if uvs.len() != vertex_count * 2 {
            return Err(SnapshotDecodeError::InvalidElementCount { kind: 4 });
        }
        Some(uvs)
    };
    let face_frame = face_frame(sections[4])?;
    let textures = textures(sections[6], sections[7])?;
    let materials = materials(sections[5], textures.len())?;
    for (triangle, material) in triangle_materials.iter().copied().enumerate() {
        if (materials.is_empty() && material != 0)
            || (!materials.is_empty() && usize::from(material) >= materials.len())
        {
            return Err(SnapshotDecodeError::InvalidMaterialIndex { triangle });
        }
    }

    Ok(DecodedSolidVoxelSnapshot {
        job_id,
        mesh: SolidMeshSnapshot {
            positions,
            indices,
            triangle_materials,
            uvs,
            face_frame,
            materials,
            textures,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_hex(value: &str) -> Vec<u8> {
        value
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| {
                let digit = |byte: u8| match byte {
                    b'0'..=b'9' => byte - b'0',
                    b'a'..=b'f' => byte - b'a' + 10,
                    _ => panic!("invalid test hex"),
                };
                digit(pair[0]) << 4 | digit(pair[1])
            })
            .collect()
    }

    fn put_u16(bytes: &mut [u8], offset: usize, value: u16) {
        bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
    }

    fn put_u32(bytes: &mut [u8], offset: usize, value: u32) {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }

    fn put_u64(bytes: &mut [u8], offset: usize, value: u64) {
        bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
    }

    fn put_f32(bytes: &mut [u8], offset: usize, value: f32) {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }

    fn put_f64(bytes: &mut [u8], offset: usize, value: f64) {
        bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
    }

    fn material_payload() -> Vec<u8> {
        let name = "材质".as_bytes();
        let english = b"material";
        let length = MATERIAL_FIXED_SIZE + name.len() + english.len();
        let mut bytes = vec![0; length];
        put_u32(&mut bytes, 0, length as u32);
        put_u32(&mut bytes, 4, name.len() as u32);
        put_u32(&mut bytes, 8, english.len() as u32);
        put_u32(&mut bytes, 12, 0b111);
        bytes[16..20].copy_from_slice(&0_i32.to_le_bytes());
        bytes[20..24].copy_from_slice(&1000_i32.to_le_bytes());
        bytes[24..28].copy_from_slice(&1001_i32.to_le_bytes());
        let mut values = [0.0; MATERIAL_NUMERIC_VALUES];
        values[0..4].copy_from_slice(&[0.8, 0.7, 0.6, 1.0]);
        values[4..8].copy_from_slice(&[1.0; 4]);
        values[12..21].copy_from_slice(&[1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]);
        values[21..24].copy_from_slice(&[0.1, 0.2, 0.3]);
        for (index, value) in values.into_iter().enumerate() {
            put_f64(&mut bytes, 32 + index * 8, value);
        }
        bytes[MATERIAL_FIXED_SIZE..MATERIAL_FIXED_SIZE + name.len()].copy_from_slice(name);
        bytes[MATERIAL_FIXED_SIZE + name.len()..].copy_from_slice(english);
        bytes
    }

    fn valid_envelope() -> Vec<u8> {
        let mut positions = vec![0; 9 * 4];
        for (index, value) in [0.0, 0.0, 0.0, 1.0, 2.0, 0.0, 0.0, 1.0, 1.0]
            .into_iter()
            .enumerate()
        {
            put_f32(&mut positions, index * 4, value);
        }
        let mut indices = vec![0; 3 * 4];
        for (index, value) in [0_u32, 1, 2].into_iter().enumerate() {
            put_u32(&mut indices, index * 4, value);
        }
        let triangle_materials = vec![0, 0];
        let mut uvs = vec![0; 6 * 4];
        for (index, value) in [0.0, 0.0, 1.0, 0.0, 0.5, 1.0].into_iter().enumerate() {
            put_f32(&mut uvs, index * 4, value);
        }
        let mut frame = vec![0; FACE_FRAME_VALUES * 8];
        let frame_values = [
            0.0, 1.5, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.4, 0.9,
        ];
        for (index, value) in frame_values.into_iter().enumerate() {
            put_f64(&mut frame, index * 8, value);
        }
        let material = material_payload();
        let mut texture_meta = vec![0; TEXTURE_RECORD_SIZE];
        put_u32(&mut texture_meta, 0, 1);
        put_u32(&mut texture_meta, 4, 1);
        put_u32(&mut texture_meta, 12, 4);
        let texture_pixels = vec![1, 2, 3, 255];
        let payloads = [
            positions,
            indices,
            triangle_materials,
            uvs,
            frame,
            material,
            texture_meta,
            texture_pixels,
        ];
        let counts = [9, 3, 1, 6, 1, 1, 1, 4];
        let mut cursor = DATA_OFFSET;
        let mut descriptors = Vec::new();
        for (index, payload) in payloads.iter().enumerate() {
            cursor = align8(cursor).unwrap();
            descriptors.push((cursor, payload.len(), counts[index]));
            cursor += payload.len();
        }
        let total = align8(cursor).unwrap();
        let mut bytes = vec![0; total];
        bytes[..8].copy_from_slice(&SNAPSHOT_MAGIC);
        put_u16(&mut bytes, 8, 1);
        put_u16(&mut bytes, 10, 40);
        put_u16(&mut bytes, 12, 24);
        put_u16(&mut bytes, 14, 8);
        put_u32(&mut bytes, 20, total as u32);
        put_u64(&mut bytes, 32, 0x0102_0304_0506_0708);
        for index in 0..8 {
            let descriptor = SNAPSHOT_HEADER_SIZE + index * SNAPSHOT_DESCRIPTOR_SIZE;
            let (offset, length, count) = descriptors[index];
            put_u16(&mut bytes, descriptor, (index + 1) as u16);
            put_u16(&mut bytes, descriptor + 2, EXPECTED_ELEMENT_TYPES[index]);
            put_u32(&mut bytes, descriptor + 4, count);
            put_u32(&mut bytes, descriptor + 8, offset as u32);
            put_u32(&mut bytes, descriptor + 12, length as u32);
            bytes[offset..offset + length].copy_from_slice(&payloads[index]);
        }
        let checksum = crc32_with_zero_checksum_field(&bytes);
        put_u32(&mut bytes, CHECKSUM_OFFSET, checksum);
        bytes
    }

    fn refresh_checksum(bytes: &mut [u8]) {
        let checksum = crc32_with_zero_checksum_field(bytes);
        put_u32(bytes, CHECKSUM_OFFSET, checksum);
    }

    #[test]
    fn crc32_matches_the_standard_vector() {
        assert_eq!(crc32_with_zero_checksum_field(b"123456789"), 0xcbf4_3926);
    }

    #[test]
    fn decodes_the_typescript_encoder_compatibility_fixture() {
        let bytes = decode_hex(concat!(
            "4d4c5953564f58000100280018000800000000002001000025365eba00000000",
            "08070605040302010100010009000000e8000000240000000000000000000000",
            "0200020003000000100100000c00000000000000000000000300030000000000",
            "0000000000000000000000000000000004000100000000000000000000000000",
            "0000000000000000050008000000000000000000000000000000000000000000",
            "0600060000000000000000000000000000000000000000000700070000000000",
            "0000000000000000000000000000000008000400000000000000000000000000",
            "00000000000000000000000000000000000000000000803f00000000",
            "00000000000000000000803f0000000000000000000000000100000002000000",
            "00000000",
        ));
        assert_eq!(bytes.len(), 288);
        assert_eq!(u32_at(&bytes, CHECKSUM_OFFSET).unwrap(), 0xba5e_3625);
        let decoded = decode_solid_voxel_snapshot_envelope(&bytes).unwrap();
        assert_eq!(decoded.job_id, 0x0102_0304_0506_0708);
        assert_eq!(decoded.mesh.indices, [0, 1, 2]);
        assert_eq!(decoded.mesh.positions.len(), 9);
        assert!(decoded.mesh.face_frame.is_none());
        assert!(decoded.mesh.materials.is_empty());
        assert!(decoded.mesh.textures.is_empty());
    }

    #[test]
    fn decodes_job_mesh_face_material_and_texture_without_normals() {
        let decoded = decode_solid_voxel_snapshot_envelope(&valid_envelope()).unwrap();
        assert_eq!(decoded.job_id, 0x0102_0304_0506_0708);
        assert_eq!(decoded.mesh.positions.len(), 9);
        assert_eq!(decoded.mesh.indices, [0, 1, 2]);
        assert_eq!(decoded.mesh.triangle_materials, [0]);
        assert_eq!(decoded.mesh.uvs.as_ref().unwrap().len(), 6);
        assert_eq!(decoded.mesh.face_frame.unwrap().eye_distance, 0.4);
        assert_eq!(decoded.mesh.materials[0].name, "材质");
        assert_eq!(decoded.mesh.materials[0].english_name, "material");
        assert_eq!(decoded.mesh.textures[0].pixels, [1, 2, 3, 255]);
    }

    #[test]
    fn rejects_header_checksum_and_descriptor_tampering() {
        assert_eq!(
            decode_solid_voxel_snapshot_envelope(&[0; 39]),
            Err(SnapshotDecodeError::Truncated),
        );
        let mut bytes = valid_envelope();
        bytes[0] ^= 1;
        assert_eq!(
            decode_solid_voxel_snapshot_envelope(&bytes),
            Err(SnapshotDecodeError::InvalidMagic),
        );
        let mut bytes = valid_envelope();
        let last_index = bytes.len() - 1;
        bytes[last_index] ^= 1;
        assert_eq!(
            decode_solid_voxel_snapshot_envelope(&bytes),
            Err(SnapshotDecodeError::InvalidChecksum),
        );
        let mut bytes = valid_envelope();
        put_u16(&mut bytes, SNAPSHOT_HEADER_SIZE + 2, 9);
        refresh_checksum(&mut bytes);
        assert!(matches!(
            decode_solid_voxel_snapshot_envelope(&bytes),
            Err(SnapshotDecodeError::InvalidDescriptor { kind: 1 })
        ));
    }

    #[test]
    fn rejects_noncanonical_empty_offsets_alignment_and_padding() {
        let mut bytes = valid_envelope();
        let descriptor = SNAPSHOT_HEADER_SIZE + 3 * SNAPSHOT_DESCRIPTOR_SIZE;
        put_u32(&mut bytes, descriptor + 4, 0);
        refresh_checksum(&mut bytes);
        assert!(matches!(
            decode_solid_voxel_snapshot_envelope(&bytes),
            Err(SnapshotDecodeError::NonCanonicalEmptySection { kind: 4 })
        ));

        let mut bytes = valid_envelope();
        put_u32(
            &mut bytes,
            SNAPSHOT_HEADER_SIZE + 8,
            (DATA_OFFSET + 1) as u32,
        );
        refresh_checksum(&mut bytes);
        assert!(matches!(
            decode_solid_voxel_snapshot_envelope(&bytes),
            Err(SnapshotDecodeError::MisalignedSection { kind: 1 })
        ));

        let mut bytes = valid_envelope();
        let positions_length = u32_at(&bytes, SNAPSHOT_HEADER_SIZE + 12).unwrap() as usize;
        let padding_offset = DATA_OFFSET + positions_length;
        bytes[padding_offset] = 1;
        refresh_checksum(&mut bytes);
        assert!(matches!(
            decode_solid_voxel_snapshot_envelope(&bytes),
            Err(SnapshotDecodeError::NonZeroPadding { .. })
        ));
    }

    #[test]
    fn rejects_nonfinite_indices_utf8_flags_and_texture_ranges() {
        let mut bytes = valid_envelope();
        let position_offset = u32_at(&bytes, SNAPSHOT_HEADER_SIZE + 8).unwrap() as usize;
        put_f32(&mut bytes, position_offset, f32::NAN);
        refresh_checksum(&mut bytes);
        assert!(matches!(
            decode_solid_voxel_snapshot_envelope(&bytes),
            Err(SnapshotDecodeError::NonFiniteValue { kind: 1, .. })
        ));

        let mut bytes = valid_envelope();
        let index_descriptor = SNAPSHOT_HEADER_SIZE + SNAPSHOT_DESCRIPTOR_SIZE;
        let index_offset = u32_at(&bytes, index_descriptor + 8).unwrap() as usize;
        put_u32(&mut bytes, index_offset, 99);
        refresh_checksum(&mut bytes);
        assert!(matches!(
            decode_solid_voxel_snapshot_envelope(&bytes),
            Err(SnapshotDecodeError::InvalidIndex { offset: 0 })
        ));

        let mut bytes = valid_envelope();
        let material_descriptor = SNAPSHOT_HEADER_SIZE + 5 * SNAPSHOT_DESCRIPTOR_SIZE;
        let material_offset = u32_at(&bytes, material_descriptor + 8).unwrap() as usize;
        put_u32(&mut bytes, material_offset + 12, 8);
        refresh_checksum(&mut bytes);
        assert!(matches!(
            decode_solid_voxel_snapshot_envelope(&bytes),
            Err(SnapshotDecodeError::InvalidMaterialFlags { index: 0 })
        ));

        let mut bytes = valid_envelope();
        let material_offset = u32_at(&bytes, material_descriptor + 8).unwrap() as usize;
        bytes[material_offset + MATERIAL_FIXED_SIZE] = 0xff;
        refresh_checksum(&mut bytes);
        assert!(matches!(
            decode_solid_voxel_snapshot_envelope(&bytes),
            Err(SnapshotDecodeError::InvalidUtf8 { index: 0, .. })
        ));

        let mut bytes = valid_envelope();
        let texture_descriptor = SNAPSHOT_HEADER_SIZE + 6 * SNAPSHOT_DESCRIPTOR_SIZE;
        let texture_offset = u32_at(&bytes, texture_descriptor + 8).unwrap() as usize;
        put_u32(&mut bytes, texture_offset + 8, 1);
        refresh_checksum(&mut bytes);
        assert!(matches!(
            decode_solid_voxel_snapshot_envelope(&bytes),
            Err(SnapshotDecodeError::InvalidTextureRecord { index: 0 })
        ));
    }
}
