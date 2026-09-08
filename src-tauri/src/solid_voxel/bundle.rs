//! Native result-handle bundle writer.
//!
//! The writer keeps the large voxel result in the manager and emits a ZIP32
//! archive directly to a single temporary file. Litematic entries are already
//! gzip streams, so they are stored without a second compression pass.

use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};

use serde_json::json;
use sha2::{Digest, Sha256};

use super::{
    litematic::{
        commit_temporary_file, write_litematic_with_control, write_solid_litematic_with_control,
        LitematicBlockState, LitematicBounds, LitematicCancellationToken, LitematicChunk,
        LitematicDocument, LitematicError, LitematicOptions, LitematicSummary,
    },
    voxelize::SolidShellResult,
};

const ZIP_LOCAL_SIGNATURE: u32 = 0x0403_4b50;
const ZIP_CENTRAL_SIGNATURE: u32 = 0x0201_4b50;
const ZIP_END_SIGNATURE: u32 = 0x0605_4b50;
const ZIP_DESCRIPTOR_SIGNATURE: u32 = 0x0807_4b50;
const ZIP_DATA_DESCRIPTOR_FLAG: u16 = 0x0008;
const ZIP_STORE_METHOD: u16 = 0;
const ZIP32_MAX: u64 = u32::MAX as u64;
const ZIP32_MAX_ENTRIES: usize = u16::MAX as usize;
const PART_SIZE: i32 = 32;

static BUNDLE_TEMP_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Debug)]
pub enum BundleError {
    Io(io::Error),
    Encode(LitematicError),
    Cancelled,
    Invalid(String),
}

impl std::fmt::Display for BundleError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => error.fmt(formatter),
            Self::Encode(error) => error.fmt(formatter),
            Self::Cancelled => formatter.write_str("native bundle writing was cancelled"),
            Self::Invalid(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for BundleError {}

impl From<io::Error> for BundleError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<LitematicError> for BundleError {
    fn from(error: LitematicError) -> Self {
        Self::Encode(error)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NativeBundleSummary {
    pub compressed_bytes: u64,
    pub file_count: u32,
    pub part_count: u32,
    pub block_count: u64,
    pub data_version: i32,
}

#[derive(Debug, Clone)]
pub struct NativeBundleOptions {
    pub name: String,
    pub guide_locale: String,
    pub height_mode: String,
    pub target_height: u32,
    pub target_dimension_min_y: i32,
    pub target_dimension_height: u32,
    pub placement_bottom_y: i32,
    pub litematic: LitematicOptions,
    pub overwrite_existing: bool,
}

#[derive(Debug, Clone)]
struct PartData {
    index: [i32; 3],
    blocks: Vec<([i32; 3], u16)>,
    min: [i32; 3],
    max: [i32; 3],
}

#[derive(Debug, Clone)]
struct ZipEntryRecord {
    name: Vec<u8>,
    offset: u64,
    compressed_size: u64,
    uncompressed_size: u64,
    crc32: u32,
    method: u16,
}

struct Crc32 {
    value: u32,
}

impl Crc32 {
    fn new() -> Self {
        Self { value: 0xffff_ffff }
    }

    fn update(&mut self, bytes: &[u8]) {
        for byte in bytes {
            let mut value = self.value ^ u32::from(*byte);
            for _ in 0..8 {
                value = if value & 1 != 0 {
                    (value >> 1) ^ 0xedb8_8320
                } else {
                    value >> 1
                };
            }
            self.value = value;
        }
    }

    fn finish(&self) -> u32 {
        !self.value
    }
}

struct ZipEntryWriter<'a, W: Write> {
    archive: &'a mut Zip32Writer<W>,
    crc: Crc32,
    compressed_size: u64,
    uncompressed_size: u64,
}

impl<W: Write> Write for ZipEntryWriter<'_, W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.archive.writer.write_all(bytes)?;
        self.archive.offset = self
            .archive
            .offset
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| io::Error::other("ZIP offset overflow"))?;
        if self.archive.offset > ZIP32_MAX {
            return Err(io::Error::other("ZIP archive exceeds ZIP32 size"));
        }
        self.crc.update(bytes);
        self.compressed_size = self
            .compressed_size
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| io::Error::other("ZIP entry exceeds ZIP32 size"))?;
        self.uncompressed_size = self.compressed_size;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.archive.writer.flush()
    }
}

struct Zip32Writer<W: Write> {
    writer: W,
    entries: Vec<ZipEntryRecord>,
    offset: u64,
}

impl<W: Write> Zip32Writer<W> {
    fn new(writer: W) -> Self {
        Self {
            writer,
            entries: Vec::new(),
            offset: 0,
        }
    }

    fn write_bytes(&mut self, bytes: &[u8]) -> Result<(), BundleError> {
        self.writer.write_all(bytes)?;
        self.offset = self
            .offset
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| BundleError::Invalid("ZIP offset overflow".to_owned()))?;
        if self.offset > ZIP32_MAX {
            return Err(BundleError::Invalid(
                "ZIP32 archive exceeds 4 GiB".to_owned(),
            ));
        }
        Ok(())
    }

    fn start_entry<'a>(
        &'a mut self,
        name: &str,
        method: u16,
    ) -> Result<ZipEntryWriter<'a, W>, BundleError> {
        if self.entries.len() >= ZIP32_MAX_ENTRIES {
            return Err(BundleError::Invalid(
                "ZIP32 archive exceeds 65,535 entries".to_owned(),
            ));
        }
        let name = name.as_bytes().to_vec();
        if name.len() > u16::MAX as usize {
            return Err(BundleError::Invalid(
                "ZIP entry name exceeds 65,535 bytes".to_owned(),
            ));
        }
        let mut header = Vec::with_capacity(30 + name.len());
        put_u32(&mut header, ZIP_LOCAL_SIGNATURE);
        put_u16(&mut header, 20);
        put_u16(&mut header, ZIP_DATA_DESCRIPTOR_FLAG);
        put_u16(&mut header, method);
        put_u16(&mut header, 0);
        put_u16(&mut header, 0);
        put_u32(&mut header, 0);
        put_u32(&mut header, 0);
        put_u32(&mut header, 0);
        put_u16(&mut header, name.len() as u16);
        put_u16(&mut header, 0);
        header.extend_from_slice(&name);
        self.write_bytes(&header)?;
        Ok(ZipEntryWriter {
            archive: self,
            crc: Crc32::new(),
            compressed_size: 0,
            uncompressed_size: 0,
        })
    }

    fn finish_entry(
        &mut self,
        name: Vec<u8>,
        offset: u64,
        method: u16,
        crc32: u32,
        compressed_size: u64,
        uncompressed_size: u64,
    ) -> Result<(), BundleError> {
        if compressed_size > ZIP32_MAX || uncompressed_size > ZIP32_MAX || offset > ZIP32_MAX {
            return Err(BundleError::Invalid(
                "ZIP32 entry limit exceeded".to_owned(),
            ));
        }
        let mut descriptor = Vec::with_capacity(16);
        put_u32(&mut descriptor, ZIP_DESCRIPTOR_SIGNATURE);
        put_u32(&mut descriptor, crc32);
        put_u32(&mut descriptor, compressed_size as u32);
        put_u32(&mut descriptor, uncompressed_size as u32);
        self.write_bytes(&descriptor)?;
        self.entries.push(ZipEntryRecord {
            name,
            offset,
            compressed_size,
            uncompressed_size,
            crc32,
            method,
        });
        Ok(())
    }

    fn add_bytes(&mut self, name: &str, bytes: &[u8]) -> Result<(), BundleError> {
        let name_bytes = name.as_bytes().to_vec();
        let offset = self.offset;
        let mut entry = self.start_entry(name, ZIP_STORE_METHOD)?;
        entry.write_all(bytes)?;
        let crc = entry.crc.finish();
        let compressed = entry.compressed_size;
        let uncompressed = entry.uncompressed_size;
        drop(entry);
        self.finish_entry(
            name_bytes,
            offset,
            ZIP_STORE_METHOD,
            crc,
            compressed,
            uncompressed,
        )
    }

    fn finish(mut self) -> Result<(W, u64, u32), BundleError> {
        let central_offset = self.offset;
        let entries = std::mem::take(&mut self.entries);
        let mut central_size = 0_u64;
        for entry in &entries {
            let mut record = Vec::with_capacity(46 + entry.name.len());
            put_u32(&mut record, ZIP_CENTRAL_SIGNATURE);
            put_u16(&mut record, 20);
            put_u16(&mut record, 20);
            put_u16(&mut record, ZIP_DATA_DESCRIPTOR_FLAG);
            put_u16(&mut record, entry.method);
            put_u16(&mut record, 0);
            put_u16(&mut record, 0);
            put_u32(&mut record, entry.crc32);
            put_u32(&mut record, entry.compressed_size as u32);
            put_u32(&mut record, entry.uncompressed_size as u32);
            put_u16(&mut record, entry.name.len() as u16);
            put_u16(&mut record, 0);
            put_u16(&mut record, 0);
            put_u16(&mut record, 0);
            put_u16(&mut record, 0);
            put_u32(&mut record, 0);
            put_u32(&mut record, entry.offset as u32);
            record.extend_from_slice(&entry.name);
            central_size = central_size
                .checked_add(record.len() as u64)
                .ok_or_else(|| BundleError::Invalid("ZIP central directory overflow".to_owned()))?;
            self.write_bytes(&record)?;
        }
        if central_offset > ZIP32_MAX
            || central_size > ZIP32_MAX
            || entries.len() > ZIP32_MAX_ENTRIES
        {
            return Err(BundleError::Invalid(
                "ZIP32 central directory limit exceeded".to_owned(),
            ));
        }
        let mut end = Vec::with_capacity(22);
        put_u32(&mut end, ZIP_END_SIGNATURE);
        put_u16(&mut end, 0);
        put_u16(&mut end, 0);
        put_u16(&mut end, entries.len() as u16);
        put_u16(&mut end, entries.len() as u16);
        put_u32(&mut end, central_size as u32);
        put_u32(&mut end, central_offset as u32);
        put_u16(&mut end, 0);
        self.write_bytes(&end)?;
        let total = self.offset;
        self.writer.flush()?;
        Ok((self.writer, total, entries.len() as u32))
    }
}

fn put_u16(target: &mut Vec<u8>, value: u16) {
    target.extend_from_slice(&value.to_le_bytes());
}
fn put_u32(target: &mut Vec<u8>, value: u32) {
    target.extend_from_slice(&value.to_le_bytes());
}

fn floor_div(value: i32, divisor: i32) -> i32 {
    value.div_euclid(divisor)
}

fn world_position(chunk: [i32; 3], local: u16) -> [i32; 3] {
    let x = i32::from(local % 32);
    let yz = i32::from(local / 32);
    let z = yz % 32;
    let y = yz / 32;
    [chunk[0] * 32 + x, chunk[1] * 32 + y, chunk[2] * 32 + z]
}

fn collect_parts(
    result: &SolidShellResult,
    cancellation: &LitematicCancellationToken,
) -> Result<Vec<PartData>, BundleError> {
    let mut parts = BTreeMap::<[i32; 3], PartData>::new();
    for chunk in &result.chunks {
        if chunk.positions.len() != chunk.block_indices.len() {
            return Err(BundleError::Invalid(
                "native result chunk buffers are inconsistent".to_owned(),
            ));
        }
        for (position, palette_index) in chunk
            .positions
            .iter()
            .copied()
            .zip(chunk.block_indices.iter().copied())
        {
            if cancellation.is_cancelled() {
                return Err(BundleError::Cancelled);
            }
            let world = world_position(chunk.chunk.0, position);
            if usize::from(palette_index) >= result.palette.len() {
                return Err(BundleError::Invalid(
                    "native result references an unknown palette index".to_owned(),
                ));
            }
            let index = [
                floor_div(world[0] - result.bounds.min[0], PART_SIZE),
                floor_div(world[1] - result.bounds.min[1], PART_SIZE),
                floor_div(world[2] - result.bounds.min[2], PART_SIZE),
            ];
            let part = parts.entry(index).or_insert_with(|| PartData {
                index,
                blocks: Vec::new(),
                min: world,
                max: world,
            });
            part.min = [
                part.min[0].min(world[0]),
                part.min[1].min(world[1]),
                part.min[2].min(world[2]),
            ];
            part.max = [
                part.max[0].max(world[0]),
                part.max[1].max(world[1]),
                part.max[2].max(world[2]),
            ];
            part.blocks.push((world, palette_index));
        }
    }
    let mut parts: Vec<_> = parts.into_values().collect();
    parts.sort_by_key(|part| (part.index[1], part.index[2], part.index[0]));
    Ok(parts)
}

fn part_document(
    result: &SolidShellResult,
    part: &PartData,
) -> Result<LitematicDocument, BundleError> {
    let mut chunks = BTreeMap::<[i32; 3], LitematicChunk>::new();
    for (world, palette_index) in &part.blocks {
        let chunk = [
            floor_div(world[0], 32),
            floor_div(world[1], 32),
            floor_div(world[2], 32),
        ];
        let local_x = world[0].rem_euclid(32) as u16;
        let local_y = world[1].rem_euclid(32) as u16;
        let local_z = world[2].rem_euclid(32) as u16;
        let local = local_x + 32 * (local_z + 32 * local_y);
        let entry = chunks.entry(chunk).or_insert_with(|| LitematicChunk {
            chunk,
            positions: Vec::new(),
            palette_indices: Vec::new(),
        });
        entry.positions.push(local);
        entry.palette_indices.push(u32::from(*palette_index));
    }
    let mut chunks: Vec<_> = chunks.into_values().collect();
    chunks.sort_by_key(|chunk| (chunk.chunk[1], chunk.chunk[2], chunk.chunk[0]));
    for chunk in &mut chunks {
        let mut order: Vec<usize> = (0..chunk.positions.len()).collect();
        order.sort_unstable_by_key(|index| chunk.positions[*index]);
        let positions = order.iter().map(|index| chunk.positions[*index]).collect();
        let palette_indices = order
            .iter()
            .map(|index| chunk.palette_indices[*index])
            .collect();
        chunk.positions = positions;
        chunk.palette_indices = palette_indices;
    }
    let dimensions = [
        (part.max[0] - part.min[0] + 1) as u32,
        (part.max[1] - part.min[1] + 1) as u32,
        (part.max[2] - part.min[2] + 1) as u32,
    ];
    Ok(LitematicDocument {
        palette: result
            .palette
            .iter()
            .map(|entry| LitematicBlockState::new(entry.block_id.clone()))
            .collect(),
        chunks,
        bounds: LitematicBounds {
            min: part.min,
            max: part.max,
            dimensions,
        },
        block_count: part.blocks.len() as u64,
    })
}

fn slug(value: &str) -> String {
    let mut output = String::new();
    for character in value.chars().flat_map(|character| character.to_lowercase()) {
        if character.is_ascii_alphanumeric()
            || character == '_'
            || character == '-'
            || character == '.'
        {
            output.push(character);
        } else if !output.ends_with('_') {
            output.push('_');
        }
    }
    let trimmed = output.trim_matches(['_', '.', '-']).to_owned();
    if trimmed.is_empty() {
        "mely_projection".to_owned()
    } else {
        trimmed
    }
}

fn json_bytes(value: serde_json::Value) -> Vec<u8> {
    let mut bytes = serde_json::to_vec_pretty(&value).unwrap_or_else(|_| b"{}".to_vec());
    bytes.push(b'\n');
    bytes
}

fn partition_bounds(result: &SolidShellResult, part: &PartData) -> ([i32; 3], [i32; 3], [u32; 3]) {
    let min = [
        result.bounds.min[0] + part.index[0] * 32,
        result.bounds.min[1] + part.index[1] * 32,
        result.bounds.min[2] + part.index[2] * 32,
    ];
    let max = [
        (min[0] + 31).min(result.bounds.max[0]),
        (min[1] + 31).min(result.bounds.max[1]),
        (min[2] + 31).min(result.bounds.max[2]),
    ];
    let dimensions = [
        (max[0] - min[0] + 1) as u32,
        (max[1] - min[1] + 1) as u32,
        (max[2] - min[2] + 1) as u32,
    ];
    (min, max, dimensions)
}

fn part_content_hash(result: &SolidShellResult, part: &PartData, version: &str) -> String {
    let mut hasher = Sha256::new();
    let mut first = true;
    let mut update_line = |value: serde_json::Value| {
        if !first {
            hasher.update(b"\n");
        }
        first = false;
        hasher.update(serde_json::to_vec(&value).unwrap_or_default());
    };
    update_line(json!([
        "MELYProjectionPart",
        1,
        "java",
        version,
        part.blocks.len(),
    ]));
    let origin = part.min;
    let mut blocks: Vec<_> = part.blocks.iter().collect();
    blocks.sort_by_key(|(position, _)| (position[1], position[2], position[0]));
    for (position, palette_index) in blocks {
        let block_id = result.palette[usize::from(*palette_index)]
            .block_id
            .as_str();
        update_line(json!([
            position[0] - origin[0],
            position[1] - origin[1],
            position[2] - origin[2],
            [block_id, []],
        ]));
    }
    let digest = hasher.finalize();
    format!("sha256:{digest:x}")
}

fn write_entry_litematic<W: Write>(
    archive: &mut Zip32Writer<W>,
    name: &str,
    result: &SolidShellResult,
    options: &LitematicOptions,
    cancellation: &LitematicCancellationToken,
) -> Result<LitematicSummary, BundleError> {
    let name_bytes = name.as_bytes().to_vec();
    let offset = archive.offset;
    let mut entry = archive.start_entry(name, ZIP_STORE_METHOD)?;
    let summary = write_solid_litematic_with_control(result, &mut entry, options, || {
        cancellation.is_cancelled()
    })?;
    let crc = entry.crc.finish();
    let compressed = entry.compressed_size;
    let uncompressed = entry.uncompressed_size;
    drop(entry);
    archive.finish_entry(
        name_bytes,
        offset,
        ZIP_STORE_METHOD,
        crc,
        compressed,
        uncompressed,
    )?;
    Ok(summary)
}

fn write_entry_document<W: Write>(
    archive: &mut Zip32Writer<W>,
    name: &str,
    document: &LitematicDocument,
    options: &LitematicOptions,
    cancellation: &LitematicCancellationToken,
) -> Result<LitematicSummary, BundleError> {
    let name_bytes = name.as_bytes().to_vec();
    let offset = archive.offset;
    let mut entry = archive.start_entry(name, ZIP_STORE_METHOD)?;
    let summary = write_litematic_with_control(document, &mut entry, options, || {
        cancellation.is_cancelled()
    })?;
    let crc = entry.crc.finish();
    let compressed = entry.compressed_size;
    let uncompressed = entry.uncompressed_size;
    drop(entry);
    archive.finish_entry(
        name_bytes,
        offset,
        ZIP_STORE_METHOD,
        crc,
        compressed,
        uncompressed,
    )?;
    Ok(summary)
}

/// Write the default Litematica/guide bundle without copying the native result
/// into the WebView. Optional alternate formats deliberately stay on the TS
/// Worker path for now.
pub fn write_native_bundle(
    result: &SolidShellResult,
    output_path: &Path,
    options: &NativeBundleOptions,
    cancellation: &LitematicCancellationToken,
) -> Result<NativeBundleSummary, BundleError> {
    if options.litematic.region_max_size != [32, 32, 32] {
        return Err(BundleError::Invalid(
            "native bundle requires fixed 32³ partitions".to_owned(),
        ));
    }
    let parts = collect_parts(result, cancellation)?;
    if parts.is_empty() {
        return Err(BundleError::Invalid(
            "native bundle cannot be empty".to_owned(),
        ));
    }
    let parent = output_path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = output_path
        .file_name()
        .ok_or_else(|| {
            BundleError::Invalid("bundle output path must contain a file name".to_owned())
        })?
        .to_string_lossy();
    let mut temporary = None;
    for _ in 0..64 {
        let sequence = BUNDLE_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = parent.join(format!(
            ".{}.mely-bundle-{}-{}.tmp",
            file_name,
            std::process::id(),
            sequence
        ));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => {
                temporary = Some((path, file));
                break;
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(BundleError::Io(error)),
        }
    }
    let (temporary_path, file) = temporary.ok_or_else(|| {
        BundleError::Invalid("could not allocate native bundle temporary file".to_owned())
    })?;
    let write_result = (|| {
        let mut archive = Zip32Writer::new(file);
        let slug = slug(&options.name);
        let overall_path = format!("litematica/{slug}.litematic");
        let _overall = write_entry_litematic(
            &mut archive,
            &overall_path,
            result,
            &options.litematic,
            cancellation,
        )?;
        let mut part_json = Vec::new();
        for (part_index, part) in parts.iter().enumerate() {
            if cancellation.is_cancelled() {
                return Err(BundleError::Cancelled);
            }
            let part_id = format!("part_{part_index:04}");
            let part_root = format!("parts/{part_id}/{slug}_{part_id}");
            let document = part_document(result, part)?;
            let path = format!("{part_root}.litematic");
            let summary = write_entry_document(
                &mut archive,
                &path,
                &document,
                &options.litematic,
                cancellation,
            )?;
            part_json.push(json!({
                "id": part_id,
                "index": part.index,
                "bounds": { "min": partition_bounds(result, part).0, "max": partition_bounds(result, part).1, "dimensions": partition_bounds(result, part).2 },
                "occupiedBounds": { "min": part.min, "max": part.max, "dimensions": [part.max[0]-part.min[0]+1, part.max[1]-part.min[1]+1, part.max[2]-part.min[2]+1] },
                "blockCount": part.blocks.len(),
                "buildOrder": part_index + 1,
                "relativeOffset": [part.min[0]-result.bounds.min[0], part.min[1]-result.bounds.min[1], part.min[2]-result.bounds.min[2]],
                "files": { "litematic": path },
                "contentHash": part_content_hash(result, part, &options.litematic.target_minecraft_version),
                "byteLength": summary.compressed_bytes,
            }));
        }
        let material_plan = {
            let mut counts = vec![0_u64; result.palette.len()];
            for chunk in &result.chunks {
                for index in &chunk.block_indices {
                    counts[usize::from(*index)] += 1;
                }
            }
            let requirements: Vec<_> = result
                .palette
                .iter()
                .enumerate()
                .map(|(index, entry)| {
                    let count = counts[index];
                    json!({
                        "blockId": entry.block_id,
                        "count": count,
                        "stackSize": 64,
                        "category": "structure",
                        "shulkerBoxes": count / (64 * 27),
                        "stacks": (count % (64 * 27)) / 64,
                        "looseItems": count % 64,
                        "storageSlots": (count + 63) / 64,
                    })
                })
                .collect();
            json!({
                "generator": "MELY",
                "format": "MELYMaterialPlan",
                "version": 1,
                "totalBlocks": result.stats.block_count,
                "totalStorageSlots": requirements.iter().map(|item| item["storageSlots"].as_u64().unwrap_or(0)).sum::<u64>(),
                "totalLargeChests": 0,
                "totalShulkerBoxes": requirements.iter().map(|item| item["shulkerBoxes"].as_u64().unwrap_or(0)).sum::<u64>(),
                "requirements": requirements,
            })
        };
        let manifest = json!({
            "format": "MELYExportBundle",
            "version": 1,
            "name": options.name,
            "projection": {
                "format": "MELYProjection",
                "version": 1,
                "edition": "java",
                "minecraftVersion": options.litematic.target_minecraft_version,
                "bounds": { "min": result.bounds.min, "max": result.bounds.max, "dimensions": result.stats.dimensions },
                "blockCount": result.stats.block_count,
                "palette": result.palette.iter().map(|entry| json!({ "blockId": entry.block_id, "color": [f64::from(entry.color[0]) / 255.0, f64::from(entry.color[1]) / 255.0, f64::from(entry.color[2]) / 255.0] })).collect::<Vec<_>>(),
                "height": {
                    "mode": options.height_mode,
                    "targetHeight": options.target_height,
                    "actualHeight": result.stats.dimensions[1],
                    "recommendedBottomY": options.placement_bottom_y,
                    "highestOccupiedY": options.placement_bottom_y + result.stats.dimensions[1] as i32 - 1,
                    "targetDimensionMinY": options.target_dimension_min_y,
                    "targetDimensionMaxY": options.target_dimension_min_y + options.target_dimension_height as i32 - 1,
                    "thirdPartyDatapackDisclaimer": "",
                },
            },
            "anchor": result.bounds.min,
            "litematic": { "overall": overall_path, "targetMinecraftVersion": options.litematic.target_minecraft_version, "serializerMinecraftVersion": options.litematic.serializer_minecraft_version, "dataVersion": 3465, "formatVersion": 6, "subVersion": 1, "compatibilityLevel": "exact", "compatibilityWarningCode": null },
            "guides": { "locale": options.guide_locale, "readme": "README.txt", "coordinatesJson": "coordinates.json", "coordinatesText": "coordinates.txt", "materials": "planning/materials.json", "chests": "planning/chests.json" },
            "parts": part_json,
        });
        archive.add_bytes("bundle.json", &json_bytes(manifest.clone()))?;
        archive.add_bytes(
            "coordinates.json",
            &json_bytes(json!({ "anchor": result.bounds.min, "parts": part_json })),
        )?;
        archive.add_bytes(
            "coordinates.txt",
            format!(
                "MELY Export Bundle\nAnchor: {} {} {}\nParts: {}\n",
                result.bounds.min[0],
                result.bounds.min[1],
                result.bounds.min[2],
                parts.len()
            )
            .as_bytes(),
        )?;
        archive.add_bytes("planning/materials.json", &json_bytes(material_plan))?;
        archive.add_bytes("planning/chests.json", &json_bytes(json!({ "generator": "MELY", "format": "MELYChestPlan", "version": 1, "totalLargeChests": 0, "chests": [] })))?;
        archive.add_bytes(
            "README.txt",
            format!(
                "MELY Export Bundle\n{}\nBlocks: {}\nParts: {}\n",
                options.name,
                result.stats.block_count,
                parts.len()
            )
            .as_bytes(),
        )?;
        let (mut file, bytes, file_count) = archive.finish()?;
        file.flush()?;
        file.sync_all()?;
        Ok(NativeBundleSummary {
            compressed_bytes: bytes,
            file_count,
            part_count: parts.len() as u32,
            block_count: result.stats.block_count,
            data_version: 3465,
        })
    })();
    match write_result {
        Ok(summary) => {
            if cancellation.is_cancelled() {
                let _ = fs::remove_file(&temporary_path);
                return Err(BundleError::Cancelled);
            }
            commit_temporary_file(&temporary_path, output_path, options.overwrite_existing)
                .map_err(|error| {
                    BundleError::Invalid(format!("native bundle commit failed: {error}"))
                })?;
            Ok(summary)
        }
        Err(error) => {
            let _ = fs::remove_file(&temporary_path);
            Err(error)
        }
    }
}
