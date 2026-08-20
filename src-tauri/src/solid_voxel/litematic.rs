//! Litematica v6 的纯 Rust 流式编码基础。
//!
//! 输入保留 `ProjectionDocument` 的 32³ chunk 布局，输出通过 `Write`
//! 直接进入 gzip，不在内存中常驻完整 NBT 或压缩文件。

use std::{
    cmp::Ordering,
    collections::{BTreeMap, HashMap},
    error::Error,
    fmt,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, AtomicU8, Ordering as AtomicOrdering},
        Arc,
    },
};

use flate2::{Compression, GzBuilder};

use super::voxelize::SolidShellResult;

const TAG_END: u8 = 0;
const TAG_INT: u8 = 3;
const TAG_LONG: u8 = 4;
const TAG_STRING: u8 = 8;
const TAG_LIST: u8 = 9;
const TAG_COMPOUND: u8 = 10;
const TAG_INT_ARRAY: u8 = 11;
const TAG_LONG_ARRAY: u8 = 12;
const PROJECTION_CHUNK_SIZE: i32 = 32;
const PROJECTION_CHUNK_VOLUME: u16 = 32 * 32 * 32;

pub const LITEMATIC_FORMAT_VERSION: i32 = 6;
pub const LITEMATIC_SUB_VERSION: i32 = 1;
pub const LITEMATIC_DATA_VERSION: i32 = 3465;
pub const DEFAULT_REGION_MAX_SIZE: [u32; 3] = [32, 32, 32];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LitematicBlockState {
    /// 调用方必须先把内部方块 ID 解析为 Java 1.20.1 可写入的完整 ID。
    pub name: String,
    pub properties: BTreeMap<String, String>,
}

impl LitematicBlockState {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            properties: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LitematicChunk {
    /// 32³ chunk 坐标，轴顺序为 X/Y/Z。
    pub chunk: [i32; 3],
    /// `localIndex = x + 32 * (z + 32 * y)`，必须严格递增。
    pub positions: Vec<u16>,
    pub palette_indices: Vec<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LitematicBounds {
    pub min: [i32; 3],
    pub max: [i32; 3],
    pub dimensions: [u32; 3],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LitematicDocument {
    /// 不包含 air；序列化时会在索引 0 插入 `minecraft:air`。
    pub palette: Vec<LitematicBlockState>,
    pub chunks: Vec<LitematicChunk>,
    pub bounds: LitematicBounds,
    pub block_count: u64,
}

#[derive(Debug, Clone, Copy)]
enum PaletteIndexInput<'a> {
    U16(&'a [u16]),
    U32(&'a [u32]),
}

impl<'a> PaletteIndexInput<'a> {
    fn len(self) -> usize {
        match self {
            Self::U16(values) => values.len(),
            Self::U32(values) => values.len(),
        }
    }

    fn iter(self) -> PaletteIndexIter<'a> {
        match self {
            Self::U16(values) => PaletteIndexIter::U16(values.iter()),
            Self::U32(values) => PaletteIndexIter::U32(values.iter()),
        }
    }
}

enum PaletteIndexIter<'a> {
    U16(std::slice::Iter<'a, u16>),
    U32(std::slice::Iter<'a, u32>),
}

impl Iterator for PaletteIndexIter<'_> {
    type Item = u32;

    fn next(&mut self) -> Option<Self::Item> {
        match self {
            Self::U16(iter) => iter.next().copied().map(u32::from),
            Self::U32(iter) => iter.next().copied(),
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct LitematicChunkInput<'a> {
    chunk: [i32; 3],
    positions: &'a [u16],
    palette_indices: PaletteIndexInput<'a>,
}

#[derive(Debug)]
struct LitematicInput<'a> {
    palette: Vec<LitematicBlockState>,
    chunks: Vec<LitematicChunkInput<'a>>,
    bounds: LitematicBounds,
    block_count: u64,
}

impl<'a> LitematicInput<'a> {
    fn from_document(document: &'a LitematicDocument) -> Result<Self, LitematicError> {
        let mut chunks = Vec::new();
        chunks
            .try_reserve_exact(document.chunks.len())
            .map_err(|_| LitematicError::AllocationFailed {
                field: "Litematic chunk view table",
            })?;
        for chunk in &document.chunks {
            chunks.push(LitematicChunkInput {
                chunk: chunk.chunk,
                positions: &chunk.positions,
                palette_indices: PaletteIndexInput::U32(&chunk.palette_indices),
            });
        }
        Ok(Self {
            palette: document.palette.clone(),
            chunks,
            bounds: document.bounds,
            block_count: document.block_count,
        })
    }

    fn from_solid_result(result: &'a SolidShellResult) -> Result<Self, LitematicError> {
        let mut palette = Vec::new();
        palette
            .try_reserve_exact(result.palette.len())
            .map_err(|_| LitematicError::AllocationFailed {
                field: "Litematic solid palette",
            })?;
        for entry in &result.palette {
            palette.push(LitematicBlockState::new(entry.block_id.clone()));
        }

        let mut chunks = Vec::new();
        chunks.try_reserve_exact(result.chunks.len()).map_err(|_| {
            LitematicError::AllocationFailed {
                field: "Litematic solid chunk view table",
            }
        })?;
        for chunk in &result.chunks {
            chunks.push(LitematicChunkInput {
                chunk: chunk.chunk.0,
                positions: &chunk.positions,
                palette_indices: PaletteIndexInput::U16(&chunk.block_indices),
            });
        }
        let dimensions = [
            u32::try_from(result.stats.dimensions[0])
                .map_err(|_| LitematicError::InvalidBounds { axis: 0 })?,
            u32::try_from(result.stats.dimensions[1])
                .map_err(|_| LitematicError::InvalidBounds { axis: 1 })?,
            u32::try_from(result.stats.dimensions[2])
                .map_err(|_| LitematicError::InvalidBounds { axis: 2 })?,
        ];
        Ok(Self {
            palette,
            chunks,
            bounds: LitematicBounds {
                min: result.bounds.min,
                max: result.bounds.max,
                dimensions,
            },
            block_count: result.stats.block_count,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LitematicOptions {
    pub name: String,
    pub author: String,
    pub description: String,
    pub software: String,
    pub target_minecraft_version: String,
    pub serializer_minecraft_version: String,
    pub compatibility_level: String,
    pub compatibility_warning: String,
    pub timestamp_millis: i64,
    pub region_max_size: [u32; 3],
}

impl Default for LitematicOptions {
    fn default() -> Self {
        Self {
            name: "MELY_Projection".to_owned(),
            author: "MELY".to_owned(),
            description: "MELY | Minecraft 1.20.1".to_owned(),
            software: "MELY_1.0.0".to_owned(),
            target_minecraft_version: "1.20.1".to_owned(),
            serializer_minecraft_version: "1.20.1".to_owned(),
            compatibility_level: "exact".to_owned(),
            compatibility_warning: String::new(),
            timestamp_millis: 0,
            region_max_size: DEFAULT_REGION_MAX_SIZE,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LitematicSummary {
    pub compressed_bytes: u64,
    pub block_count: u64,
    pub volume: u64,
    /// 包含自动插入的 air。
    pub palette_size: u32,
    pub bits_per_block: u8,
    pub long_count: u64,
    pub dimensions: [u32; 3],
    pub data_version: i32,
    pub format_version: i32,
    pub sub_version: i32,
    pub region_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackedBlockStates {
    /// 每个 u64 在 NBT 中按相同位模式写为有符号 TAG_Long。
    pub longs: Vec<u64>,
    pub bits_per_block: u8,
}

#[derive(Debug)]
pub enum LitematicError {
    Io(io::Error),
    Cancelled,
    EmptyDocument,
    EmptyPalette,
    InvalidRegionMaxSize {
        axis: usize,
        value: u32,
    },
    PaletteTooLarge {
        size_with_air: u64,
    },
    BlockCountTooLarge {
        block_count: u64,
    },
    BlockCountMismatch {
        declared: u64,
        actual: u64,
    },
    InvalidBounds {
        axis: usize,
    },
    BoundsMismatch {
        axis: usize,
    },
    CoordinateOverflow {
        chunk: [i32; 3],
        axis: usize,
    },
    DuplicateChunk {
        chunk: [i32; 3],
    },
    EmptyChunk {
        chunk: [i32; 3],
    },
    InconsistentChunkBuffers {
        chunk: [i32; 3],
    },
    InvalidLocalPosition {
        chunk: [i32; 3],
        value: u16,
    },
    LocalPositionsNotStrictlyIncreasing {
        chunk: [i32; 3],
        index: usize,
    },
    UnknownPaletteIndex {
        chunk: [i32; 3],
        index: u32,
    },
    NbtStringTooLong {
        field: String,
        byte_length: usize,
    },
    NbtIntOverflow {
        field: &'static str,
        value: u64,
    },
    ArithmeticOverflow {
        field: &'static str,
    },
    AllocationFailed {
        field: &'static str,
    },
    PackedValueOutOfRange {
        index: usize,
        value: u32,
        palette_size: usize,
    },
    InvalidBitsPerBlock {
        bits_per_block: u8,
    },
    PackedIndexOutOfRange {
        index: usize,
    },
    RegionBlockCountMismatch {
        region: [i32; 3],
        expected: u64,
        actual: u64,
    },
}

impl fmt::Display for LitematicError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => error.fmt(formatter),
            Self::Cancelled => formatter.write_str("Litematic writing was cancelled"),
            Self::EmptyDocument => formatter.write_str("Litematic document must contain blocks"),
            Self::EmptyPalette => {
                formatter.write_str("Litematic document palette must not be empty")
            }
            Self::InvalidRegionMaxSize { axis, value } => write!(
                formatter,
                "Litematic region maximum size on axis {axis} must be in 1..=i32::MAX, got {value}",
            ),
            Self::PaletteTooLarge { size_with_air } => write!(
                formatter,
                "Litematic palette including air exceeds the NBT int range: {size_with_air}",
            ),
            Self::BlockCountTooLarge { block_count } => write!(
                formatter,
                "Litematic block count exceeds the NBT int range: {block_count}",
            ),
            Self::BlockCountMismatch { declared, actual } => write!(
                formatter,
                "Litematic block count {declared} does not match actual {actual}",
            ),
            Self::InvalidBounds { axis } => {
                write!(formatter, "Litematic bounds are invalid on axis {axis}")
            }
            Self::BoundsMismatch { axis } => write!(
                formatter,
                "Litematic declared bounds do not match blocks on axis {axis}",
            ),
            Self::CoordinateOverflow { chunk, axis } => write!(
                formatter,
                "Litematic chunk {chunk:?} overflows an i32 world coordinate on axis {axis}",
            ),
            Self::DuplicateChunk { chunk } => {
                write!(
                    formatter,
                    "Litematic document contains duplicate chunk {chunk:?}"
                )
            }
            Self::EmptyChunk { chunk } => {
                write!(formatter, "Litematic chunk {chunk:?} must not be empty")
            }
            Self::InconsistentChunkBuffers { chunk } => write!(
                formatter,
                "Litematic chunk {chunk:?} has inconsistent position and palette buffers",
            ),
            Self::InvalidLocalPosition { chunk, value } => write!(
                formatter,
                "Litematic chunk {chunk:?} contains invalid local position {value}",
            ),
            Self::LocalPositionsNotStrictlyIncreasing { chunk, index } => write!(
                formatter,
                "Litematic chunk {chunk:?} local positions stop increasing at index {index}",
            ),
            Self::UnknownPaletteIndex { chunk, index } => write!(
                formatter,
                "Litematic chunk {chunk:?} references unknown palette index {index}",
            ),
            Self::NbtStringTooLong { field, byte_length } => write!(
                formatter,
                "{field} exceeds the NBT UTF-8 string limit: {byte_length} bytes",
            ),
            Self::NbtIntOverflow { field, value } => {
                write!(
                    formatter,
                    "{field} exceeds the NBT signed int range: {value}"
                )
            }
            Self::ArithmeticOverflow { field } => {
                write!(formatter, "{field} exceeds supported integer arithmetic")
            }
            Self::AllocationFailed { field } => {
                write!(formatter, "could not allocate {field}")
            }
            Self::PackedValueOutOfRange {
                index,
                value,
                palette_size,
            } => write!(
                formatter,
                "block-state value {value} at index {index} exceeds palette size {palette_size}",
            ),
            Self::InvalidBitsPerBlock { bits_per_block } => write!(
                formatter,
                "Litematic bits per block must be in 1..=32, got {bits_per_block}",
            ),
            Self::PackedIndexOutOfRange { index } => {
                write!(
                    formatter,
                    "packed block-state index is out of range: {index}"
                )
            }
            Self::RegionBlockCountMismatch {
                region,
                expected,
                actual,
            } => write!(
                formatter,
                "Litematic region {region:?} expected {expected} blocks but encoded {actual}",
            ),
        }
    }
}

impl Error for LitematicError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            _ => None,
        }
    }
}

impl From<io::Error> for LitematicError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

/// 按 Litematica 的连续位流布局打包，允许单个值跨越两个 64-bit long。
pub fn pack_block_states(
    indices: &[u32],
    palette_size: usize,
) -> Result<PackedBlockStates, LitematicError> {
    let bits_per_block = bits_for_palette(palette_size)?;
    let long_count = packed_long_count(indices.len(), bits_per_block)?;
    ensure_nbt_int(long_count as u64, "Litematic BlockStates length")?;
    let mut longs = allocate_zeroed_longs(long_count)?;

    for (index, value) in indices.iter().copied().enumerate() {
        if value as usize >= palette_size {
            return Err(LitematicError::PackedValueOutOfRange {
                index,
                value,
                palette_size,
            });
        }
        set_packed_value(&mut longs, index, bits_per_block, value)?;
    }

    Ok(PackedBlockStates {
        longs,
        bits_per_block,
    })
}

pub fn unpack_block_state(
    packed: &[u64],
    index: usize,
    bits_per_block: u8,
) -> Result<u32, LitematicError> {
    validate_bits_per_block(bits_per_block)?;
    let bit_offset =
        index
            .checked_mul(bits_per_block as usize)
            .ok_or(LitematicError::ArithmeticOverflow {
                field: "Litematic block-state bit offset",
            })?;
    let start_long = bit_offset / 64;
    let start_bit = bit_offset & 63;
    let start_value = *packed
        .get(start_long)
        .ok_or(LitematicError::PackedIndexOutOfRange { index })?;
    let bits_in_start = 64 - start_bit;
    let mask = (1_u64 << bits_per_block) - 1;

    let value = if bits_in_start >= bits_per_block as usize {
        start_value >> start_bit
    } else {
        let end_value = *packed
            .get(start_long + 1)
            .ok_or(LitematicError::PackedIndexOutOfRange { index })?;
        (start_value >> start_bit) | (end_value << bits_in_start)
    };
    Ok((value & mask) as u32)
}

/// 将 Big-Endian NBT 边生成边压缩到调用方的 `Write`。
///
/// 本层不实施人为内存或文件大小上限；只拒绝无法用 Litematic/NBT
/// 结构表示的长度、坐标和溢出值。真实磁盘路径与临时文件清理由上层负责。
pub fn write_litematic<W: Write>(
    document: &LitematicDocument,
    output: &mut W,
    options: &LitematicOptions,
) -> Result<LitematicSummary, LitematicError> {
    let input = LitematicInput::from_document(document)?;
    write_litematic_input(&input, output, options)
}

/// 从原生体素结果直接流式写出，保留结果中的 chunk/position 存储，避免把
/// 数千万体素复制成另一份完整 `LitematicDocument`。
pub fn write_solid_litematic<W: Write>(
    result: &SolidShellResult,
    output: &mut W,
    options: &LitematicOptions,
) -> Result<LitematicSummary, LitematicError> {
    write_solid_litematic_with_control(result, output, options, || false)
}

/// 与 `write_solid_litematic` 内容一致，但在预处理、region 构造和
/// 大数组写出过程中定期检查协作取消。
pub fn write_solid_litematic_with_control<W, IsCancelled>(
    result: &SolidShellResult,
    output: &mut W,
    options: &LitematicOptions,
    is_cancelled: IsCancelled,
) -> Result<LitematicSummary, LitematicError>
where
    W: Write,
    IsCancelled: Fn() -> bool,
{
    let input = LitematicInput::from_solid_result(result)?;
    write_litematic_input_with_control(&input, output, options, &is_cancelled)
}

const WRITE_ACTIVE: u8 = 0;
const WRITE_CANCELLED: u8 = 1;
const WRITE_COMMITTING: u8 = 2;
const WRITE_FINISHED: u8 = 3;

#[derive(Clone, Debug)]
pub struct LitematicCancellationToken {
    state: Arc<AtomicU8>,
}

impl Default for LitematicCancellationToken {
    fn default() -> Self {
        Self {
            state: Arc::new(AtomicU8::new(WRITE_ACTIVE)),
        }
    }
}

impl LitematicCancellationToken {
    pub fn new() -> Self {
        Self::default()
    }

    /// 返回 `true` 表示取消在文件提交之前线性化；提交已开始时返回 `false`。
    pub fn cancel(&self) -> bool {
        self.state
            .compare_exchange(
                WRITE_ACTIVE,
                WRITE_CANCELLED,
                AtomicOrdering::AcqRel,
                AtomicOrdering::Acquire,
            )
            .is_ok()
    }

    pub fn is_cancelled(&self) -> bool {
        self.state.load(AtomicOrdering::Acquire) == WRITE_CANCELLED
    }

    fn begin_commit(&self) -> Result<(), LitematicFileError> {
        self.state
            .compare_exchange(
                WRITE_ACTIVE,
                WRITE_COMMITTING,
                AtomicOrdering::AcqRel,
                AtomicOrdering::Acquire,
            )
            .map(|_| ())
            .map_err(|state| {
                if state == WRITE_CANCELLED {
                    LitematicFileError::Encode(LitematicError::Cancelled)
                } else {
                    LitematicFileError::Io(io::Error::other(
                        "Litematic writer entered an invalid commit state",
                    ))
                }
            })
    }

    fn finish_commit(&self) {
        self.state.store(WRITE_FINISHED, AtomicOrdering::Release);
    }
}

#[derive(Debug)]
pub enum LitematicFileError {
    Io(io::Error),
    Encode(LitematicError),
}

impl fmt::Display for LitematicFileError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => error.fmt(formatter),
            Self::Encode(error) => error.fmt(formatter),
        }
    }
}

impl Error for LitematicFileError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Encode(error) => Some(error),
        }
    }
}

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(1);

/// 在目标目录内先写唯一临时文件，再以 rename 完成提交；失败时只清理临时文件。
pub fn write_solid_litematic_atomic(
    result: &SolidShellResult,
    output_path: &Path,
    options: &LitematicOptions,
) -> Result<LitematicSummary, LitematicFileError> {
    write_solid_litematic_atomic_with_control(
        result,
        output_path,
        options,
        &LitematicCancellationToken::new(),
        false,
    )
}

/// 在目标目录写入唯一临时文件，成功后再原子提交。
/// 只有调用方显式确认 `overwrite_existing` 时才会替换已有目标。
pub fn write_solid_litematic_atomic_with_control(
    result: &SolidShellResult,
    output_path: &Path,
    options: &LitematicOptions,
    cancellation: &LitematicCancellationToken,
    overwrite_existing: bool,
) -> Result<LitematicSummary, LitematicFileError> {
    check_cancelled(cancellation)?;
    let parent = output_path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = output_path
        .file_name()
        .ok_or_else(|| {
            LitematicFileError::Io(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Litematic output path must contain a file name",
            ))
        })?
        .to_string_lossy();
    let mut temporary = None;
    for _ in 0..64 {
        let sequence = TEMP_FILE_COUNTER.fetch_add(1, AtomicOrdering::Relaxed);
        let candidate = parent.join(format!(
            ".{}.mely-{}-{}.tmp",
            file_name,
            std::process::id(),
            sequence
        ));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => {
                temporary = Some((candidate, file));
                break;
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(LitematicFileError::Io(error)),
        }
    }
    let (temporary_path, file): (PathBuf, File) = temporary.ok_or_else(|| {
        LitematicFileError::Io(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "could not allocate a unique Litematic temporary file",
        ))
    })?;

    let mut temporary_guard = TemporaryFileGuard::new(temporary_path, file);
    let encoded =
        write_solid_litematic_with_control(result, temporary_guard.file_mut(), options, || {
            cancellation.is_cancelled()
        });
    let summary = match encoded {
        Ok(summary) => summary,
        Err(error) => return Err(LitematicFileError::Encode(error)),
    };
    check_cancelled(cancellation)?;
    if let Err(error) = temporary_guard
        .file_mut()
        .flush()
        .and_then(|_| temporary_guard.file_mut().sync_all())
    {
        return Err(LitematicFileError::Io(error));
    }
    temporary_guard.close();
    cancellation.begin_commit()?;
    let commit_result =
        commit_temporary_file(temporary_guard.path(), output_path, overwrite_existing);
    if commit_result.is_ok() {
        temporary_guard.commit();
    }
    cancellation.finish_commit();
    commit_result.map_err(LitematicFileError::Io)?;
    Ok(summary)
}

fn check_cancelled(cancellation: &LitematicCancellationToken) -> Result<(), LitematicFileError> {
    if cancellation.is_cancelled() {
        Err(LitematicFileError::Encode(LitematicError::Cancelled))
    } else {
        Ok(())
    }
}

struct TemporaryFileGuard {
    path: PathBuf,
    file: Option<File>,
    committed: bool,
}

impl TemporaryFileGuard {
    fn new(path: PathBuf, file: File) -> Self {
        Self {
            path,
            file: Some(file),
            committed: false,
        }
    }

    fn file_mut(&mut self) -> &mut File {
        self.file.as_mut().expect("temporary file is still open")
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn commit(&mut self) {
        self.committed = true;
    }

    fn close(&mut self) {
        self.file.take();
    }
}

impl Drop for TemporaryFileGuard {
    fn drop(&mut self) {
        self.file.take();
        if !self.committed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn commit_temporary_file(
    temporary_path: &Path,
    output_path: &Path,
    overwrite_existing: bool,
) -> io::Result<()> {
    replace_file_atomic(temporary_path, output_path, overwrite_existing)
}

#[cfg(not(windows))]
fn replace_file_atomic(
    temporary_path: &Path,
    output_path: &Path,
    overwrite_existing: bool,
) -> io::Result<()> {
    if overwrite_existing {
        fs::rename(temporary_path, output_path)
    } else {
        fs::hard_link(temporary_path, output_path)?;
        fs::remove_file(temporary_path)
    }
}

#[cfg(windows)]
fn replace_file_atomic(
    temporary_path: &Path,
    output_path: &Path,
    overwrite_existing: bool,
) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }

    let temporary = wide(temporary_path);
    let output = wide(output_path);
    let flags = MOVEFILE_WRITE_THROUGH
        | if overwrite_existing {
            MOVEFILE_REPLACE_EXISTING
        } else {
            0
        };
    let succeeded = unsafe { MoveFileExW(temporary.as_ptr(), output.as_ptr(), flags) };
    if succeeded == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn write_litematic_input<W: Write>(
    input: &LitematicInput<'_>,
    output: &mut W,
    options: &LitematicOptions,
) -> Result<LitematicSummary, LitematicError> {
    write_litematic_input_with_control(input, output, options, &|| false)
}

fn write_litematic_input_with_control<W: Write>(
    input: &LitematicInput<'_>,
    output: &mut W,
    options: &LitematicOptions,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<LitematicSummary, LitematicError> {
    check_encoding_cancelled(is_cancelled)?;
    let prepared = PreparedLitematic::new(input, options, is_cancelled)?;
    let counting = CountingWriter::new(output);
    // pako 的默认 gzip 头使用 mtime=0、OS=Unix；固定头部便于跨后端复现。
    let gzip = GzBuilder::new()
        .mtime(0)
        .operating_system(3)
        .write(counting, Compression::best());
    let mut writer = BigEndianNbtWriter::new(gzip);
    write_nbt(&mut writer, &prepared, options, is_cancelled)?;
    let gzip = writer.into_inner();
    let mut counting = gzip.finish()?;
    counting.flush()?;

    Ok(prepared.summary(counting.bytes_written))
}

fn check_encoding_cancelled(is_cancelled: &dyn Fn() -> bool) -> Result<(), LitematicError> {
    if is_cancelled() {
        Err(LitematicError::Cancelled)
    } else {
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct RegionIndex([i32; 3]);

impl Ord for RegionIndex {
    fn cmp(&self, other: &Self) -> Ordering {
        self.0[1]
            .cmp(&other.0[1])
            .then_with(|| self.0[2].cmp(&other.0[2]))
            .then_with(|| self.0[0].cmp(&other.0[0]))
    }
}

impl PartialOrd for RegionIndex {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RegionView {
    index: RegionIndex,
    bounds: LitematicBounds,
    block_count: u64,
    volume: usize,
    long_count: usize,
}

struct PreparedLitematic<'input, 'source> {
    document: &'input LitematicInput<'source>,
    views: Vec<RegionView>,
    chunk_index: HashMap<[i32; 3], LitematicChunkInput<'source>>,
    palette_size: usize,
    bits_per_block: u8,
    total_volume: u64,
    total_long_count: u64,
}

impl<'input, 'source> PreparedLitematic<'input, 'source> {
    fn new(
        document: &'input LitematicInput<'source>,
        options: &LitematicOptions,
        is_cancelled: &dyn Fn() -> bool,
    ) -> Result<Self, LitematicError> {
        check_encoding_cancelled(is_cancelled)?;
        validate_options(options)?;
        validate_bounds_shape(document.bounds)?;
        if document.block_count == 0 || document.chunks.is_empty() {
            return Err(LitematicError::EmptyDocument);
        }
        if document.palette.is_empty() {
            return Err(LitematicError::EmptyPalette);
        }
        ensure_nbt_int(document.block_count, "Litematic TotalBlocks").map_err(|_| {
            LitematicError::BlockCountTooLarge {
                block_count: document.block_count,
            }
        })?;

        let palette_size =
            document
                .palette
                .len()
                .checked_add(1)
                .ok_or(LitematicError::ArithmeticOverflow {
                    field: "Litematic palette size",
                })?;
        ensure_nbt_int(palette_size as u64, "Litematic palette length").map_err(|_| {
            LitematicError::PaletteTooLarge {
                size_with_air: palette_size as u64,
            }
        })?;
        validate_palette(&document.palette)?;
        let bits_per_block = bits_for_palette(palette_size)?;

        let mut chunk_index = HashMap::with_capacity(document.chunks.len());
        let mut region_counts = BTreeMap::<RegionIndex, u64>::new();
        let mut actual_min = [i32::MAX; 3];
        let mut actual_max = [i32::MIN; 3];
        let mut actual_block_count = 0_u64;

        for chunk in &document.chunks {
            check_encoding_cancelled(is_cancelled)?;
            if chunk_index.insert(chunk.chunk, *chunk).is_some() {
                return Err(LitematicError::DuplicateChunk { chunk: chunk.chunk });
            }
            validate_chunk_shape(
                chunk.chunk,
                chunk.positions,
                chunk.palette_indices,
                document.palette.len(),
            )?;

            for local_position in chunk.positions.iter().copied() {
                let world = world_position(chunk.chunk, local_position)?;
                for axis in 0..3 {
                    actual_min[axis] = actual_min[axis].min(world[axis]);
                    actual_max[axis] = actual_max[axis].max(world[axis]);
                    if world[axis] < document.bounds.min[axis]
                        || world[axis] > document.bounds.max[axis]
                    {
                        return Err(LitematicError::BoundsMismatch { axis });
                    }
                }
                actual_block_count = actual_block_count.checked_add(1).ok_or(
                    LitematicError::ArithmeticOverflow {
                        field: "Litematic block count",
                    },
                )?;
                let region = region_index(world, document.bounds.min, options.region_max_size)?;
                let count = region_counts.entry(region).or_insert(0);
                *count = count
                    .checked_add(1)
                    .ok_or(LitematicError::ArithmeticOverflow {
                        field: "Litematic region block count",
                    })?;
            }
        }

        if actual_block_count != document.block_count {
            return Err(LitematicError::BlockCountMismatch {
                declared: document.block_count,
                actual: actual_block_count,
            });
        }
        for axis in 0..3 {
            if actual_min[axis] != document.bounds.min[axis]
                || actual_max[axis] != document.bounds.max[axis]
            {
                return Err(LitematicError::BoundsMismatch { axis });
            }
        }
        ensure_nbt_int(region_counts.len() as u64, "Litematic RegionCount")?;

        let mut views = Vec::new();
        views.try_reserve_exact(region_counts.len()).map_err(|_| {
            LitematicError::AllocationFailed {
                field: "Litematic region table",
            }
        })?;
        let mut total_volume = 0_u64;
        let mut total_long_count = 0_u64;
        for (index, block_count) in region_counts {
            check_encoding_cancelled(is_cancelled)?;
            let bounds = region_bounds(index, document.bounds, options.region_max_size)?;
            let volume = bounds_volume(bounds)?;
            ensure_nbt_int(volume as u64, "Litematic region volume")?;
            let long_count = packed_long_count(volume, bits_per_block)?;
            ensure_nbt_int(long_count as u64, "Litematic BlockStates length")?;
            total_volume = total_volume.checked_add(volume as u64).ok_or(
                LitematicError::ArithmeticOverflow {
                    field: "Litematic TotalVolume",
                },
            )?;
            total_long_count = total_long_count.checked_add(long_count as u64).ok_or(
                LitematicError::ArithmeticOverflow {
                    field: "Litematic total long count",
                },
            )?;
            views.push(RegionView {
                index,
                bounds,
                block_count,
                volume,
                long_count,
            });
        }
        ensure_nbt_int(total_volume, "Litematic TotalVolume")?;

        Ok(Self {
            document,
            views,
            chunk_index,
            palette_size,
            bits_per_block,
            total_volume,
            total_long_count,
        })
    }

    fn summary(&self, compressed_bytes: u64) -> LitematicSummary {
        LitematicSummary {
            compressed_bytes,
            block_count: self.document.block_count,
            volume: self.total_volume,
            palette_size: self.palette_size as u32,
            bits_per_block: self.bits_per_block,
            long_count: self.total_long_count,
            dimensions: self.document.bounds.dimensions,
            data_version: LITEMATIC_DATA_VERSION,
            format_version: LITEMATIC_FORMAT_VERSION,
            sub_version: LITEMATIC_SUB_VERSION,
            region_count: self.views.len() as u32,
        }
    }
}

fn validate_options(options: &LitematicOptions) -> Result<(), LitematicError> {
    for (axis, value) in options.region_max_size.iter().copied().enumerate() {
        if value == 0 || value > i32::MAX as u32 {
            return Err(LitematicError::InvalidRegionMaxSize { axis, value });
        }
    }
    for (field, value) in [
        ("Litematic Name", options.name.as_str()),
        ("Litematic Author", options.author.as_str()),
        ("Litematic Description", options.description.as_str()),
        ("Litematic Software", options.software.as_str()),
        (
            "Litematic TargetMinecraftVersion",
            options.target_minecraft_version.as_str(),
        ),
        (
            "Litematic SerializerMinecraftVersion",
            options.serializer_minecraft_version.as_str(),
        ),
        (
            "Litematic CompatibilityLevel",
            options.compatibility_level.as_str(),
        ),
        (
            "Litematic CompatibilityWarning",
            options.compatibility_warning.as_str(),
        ),
    ] {
        validate_nbt_string(value, field)?;
    }
    Ok(())
}

fn validate_palette(palette: &[LitematicBlockState]) -> Result<(), LitematicError> {
    validate_nbt_string("minecraft:air", "Litematic air block name")?;
    for (index, state) in palette.iter().enumerate() {
        validate_nbt_string(&state.name, &format!("Litematic palette[{index}] Name"))?;
        for (key, value) in &state.properties {
            validate_nbt_string(key, &format!("Litematic palette[{index}] property name"))?;
            validate_nbt_string(value, &format!("Litematic palette[{index}] property {key}"))?;
        }
    }
    Ok(())
}

fn validate_bounds_shape(bounds: LitematicBounds) -> Result<(), LitematicError> {
    for axis in 0..3 {
        if bounds.min[axis] > bounds.max[axis] {
            return Err(LitematicError::InvalidBounds { axis });
        }
        let dimension = i64::from(bounds.max[axis])
            .checked_sub(i64::from(bounds.min[axis]))
            .and_then(|span| span.checked_add(1))
            .ok_or(LitematicError::InvalidBounds { axis })?;
        if dimension <= 0
            || dimension > i64::from(i32::MAX)
            || bounds.dimensions[axis] != dimension as u32
        {
            return Err(LitematicError::InvalidBounds { axis });
        }
    }
    Ok(())
}

fn validate_chunk_shape(
    chunk: [i32; 3],
    positions: &[u16],
    palette_indices: PaletteIndexInput<'_>,
    palette_size: usize,
) -> Result<(), LitematicError> {
    if positions.is_empty() {
        return Err(LitematicError::EmptyChunk { chunk });
    }
    if positions.len() != palette_indices.len() {
        return Err(LitematicError::InconsistentChunkBuffers { chunk });
    }
    let mut previous = None;
    for (index, (position, palette_index)) in positions
        .iter()
        .copied()
        .zip(palette_indices.iter())
        .enumerate()
    {
        if position >= PROJECTION_CHUNK_VOLUME {
            return Err(LitematicError::InvalidLocalPosition {
                chunk,
                value: position,
            });
        }
        if previous.is_some_and(|value| position <= value) {
            return Err(LitematicError::LocalPositionsNotStrictlyIncreasing { chunk, index });
        }
        if palette_index as usize >= palette_size {
            return Err(LitematicError::UnknownPaletteIndex {
                chunk,
                index: palette_index,
            });
        }
        previous = Some(position);
    }
    Ok(())
}

fn validate_nbt_string(value: &str, field: &str) -> Result<(), LitematicError> {
    if value.len() > u16::MAX as usize {
        return Err(LitematicError::NbtStringTooLong {
            field: field.to_owned(),
            byte_length: value.len(),
        });
    }
    Ok(())
}

fn ensure_nbt_int(value: u64, field: &'static str) -> Result<i32, LitematicError> {
    i32::try_from(value).map_err(|_| LitematicError::NbtIntOverflow { field, value })
}

fn world_position(chunk: [i32; 3], local_index: u16) -> Result<[i32; 3], LitematicError> {
    if local_index >= PROJECTION_CHUNK_VOLUME {
        return Err(LitematicError::InvalidLocalPosition {
            chunk,
            value: local_index,
        });
    }
    let x = local_index % 32;
    let yz = local_index / 32;
    let z = yz % 32;
    let y = yz / 32;
    let local = [x, y, z];
    let mut world = [0_i32; 3];
    for axis in 0..3 {
        world[axis] = chunk[axis]
            .checked_mul(PROJECTION_CHUNK_SIZE)
            .and_then(|base| base.checked_add(i32::from(local[axis])))
            .ok_or(LitematicError::CoordinateOverflow { chunk, axis })?;
    }
    Ok(world)
}

fn region_index(
    world: [i32; 3],
    document_min: [i32; 3],
    max_size: [u32; 3],
) -> Result<RegionIndex, LitematicError> {
    let mut index = [0_i32; 3];
    for axis in 0..3 {
        let relative = i64::from(world[axis])
            .checked_sub(i64::from(document_min[axis]))
            .ok_or(LitematicError::ArithmeticOverflow {
                field: "Litematic region coordinate",
            })?;
        if relative < 0 {
            return Err(LitematicError::BoundsMismatch { axis });
        }
        let value = relative / i64::from(max_size[axis]);
        index[axis] = i32::try_from(value).map_err(|_| LitematicError::ArithmeticOverflow {
            field: "Litematic region index",
        })?;
    }
    Ok(RegionIndex(index))
}

fn region_bounds(
    index: RegionIndex,
    document_bounds: LitematicBounds,
    max_size: [u32; 3],
) -> Result<LitematicBounds, LitematicError> {
    let mut min = [0_i32; 3];
    let mut max = [0_i32; 3];
    let mut dimensions = [0_u32; 3];
    for axis in 0..3 {
        let start = i64::from(document_bounds.min[axis])
            .checked_add(i64::from(index.0[axis]) * i64::from(max_size[axis]))
            .ok_or(LitematicError::ArithmeticOverflow {
                field: "Litematic region minimum",
            })?;
        let end = start
            .checked_add(i64::from(max_size[axis]) - 1)
            .ok_or(LitematicError::ArithmeticOverflow {
                field: "Litematic region maximum",
            })?
            .min(i64::from(document_bounds.max[axis]));
        min[axis] = i32::try_from(start).map_err(|_| LitematicError::ArithmeticOverflow {
            field: "Litematic region minimum",
        })?;
        max[axis] = i32::try_from(end).map_err(|_| LitematicError::ArithmeticOverflow {
            field: "Litematic region maximum",
        })?;
        dimensions[axis] =
            u32::try_from(end - start + 1).map_err(|_| LitematicError::ArithmeticOverflow {
                field: "Litematic region dimensions",
            })?;
    }
    Ok(LitematicBounds {
        min,
        max,
        dimensions,
    })
}

fn bounds_volume(bounds: LitematicBounds) -> Result<usize, LitematicError> {
    bounds
        .dimensions
        .iter()
        .copied()
        .try_fold(1_usize, |volume, value| {
            let value = usize::try_from(value).map_err(|_| LitematicError::ArithmeticOverflow {
                field: "Litematic region volume",
            })?;
            volume
                .checked_mul(value)
                .ok_or(LitematicError::ArithmeticOverflow {
                    field: "Litematic region volume",
                })
        })
}

fn bits_for_palette(palette_size: usize) -> Result<u8, LitematicError> {
    if palette_size == 0 || palette_size > i32::MAX as usize {
        return Err(LitematicError::PaletteTooLarge {
            size_with_air: palette_size as u64,
        });
    }
    let required = usize::BITS - (palette_size - 1).leading_zeros();
    Ok((required as u8).max(2))
}

fn validate_bits_per_block(bits_per_block: u8) -> Result<(), LitematicError> {
    if (1..=32).contains(&bits_per_block) {
        Ok(())
    } else {
        Err(LitematicError::InvalidBitsPerBlock { bits_per_block })
    }
}

fn packed_long_count(length: usize, bits_per_block: u8) -> Result<usize, LitematicError> {
    validate_bits_per_block(bits_per_block)?;
    let total_bits =
        length
            .checked_mul(bits_per_block as usize)
            .ok_or(LitematicError::ArithmeticOverflow {
                field: "Litematic block-state bit count",
            })?;
    total_bits
        .checked_add(63)
        .map(|value| value / 64)
        .ok_or(LitematicError::ArithmeticOverflow {
            field: "Litematic BlockStates length",
        })
}

fn allocate_zeroed_longs(long_count: usize) -> Result<Vec<u64>, LitematicError> {
    let mut longs = Vec::new();
    longs
        .try_reserve_exact(long_count)
        .map_err(|_| LitematicError::AllocationFailed {
            field: "Litematic BlockStates",
        })?;
    longs.resize(long_count, 0);
    Ok(longs)
}

fn set_packed_value(
    longs: &mut [u64],
    index: usize,
    bits_per_block: u8,
    value: u32,
) -> Result<(), LitematicError> {
    validate_bits_per_block(bits_per_block)?;
    let bit_offset =
        index
            .checked_mul(bits_per_block as usize)
            .ok_or(LitematicError::ArithmeticOverflow {
                field: "Litematic block-state bit offset",
            })?;
    let start_long = bit_offset / 64;
    let start_bit = bit_offset & 63;
    let mask = (1_u64 << bits_per_block) - 1;
    let value = u64::from(value) & mask;
    let start = longs
        .get_mut(start_long)
        .ok_or(LitematicError::PackedIndexOutOfRange { index })?;
    *start |= value << start_bit;

    let bits_in_start = 64 - start_bit;
    if bits_in_start < bits_per_block as usize {
        let end = longs
            .get_mut(start_long + 1)
            .ok_or(LitematicError::PackedIndexOutOfRange { index })?;
        *end |= value >> bits_in_start;
    }
    Ok(())
}

fn build_region_data(
    prepared: &PreparedLitematic<'_, '_>,
    view: RegionView,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<Vec<u64>, LitematicError> {
    check_encoding_cancelled(is_cancelled)?;
    let mut packed = allocate_zeroed_longs(view.long_count)?;
    let minimum_chunk = view.bounds.min.map(|value| value.div_euclid(32));
    let maximum_chunk = view.bounds.max.map(|value| value.div_euclid(32));
    let size_x = view.bounds.dimensions[0] as usize;
    let size_z = view.bounds.dimensions[2] as usize;
    let mut block_count = 0_u64;

    // 与 TypeScript 保持 Y/Z/X chunk 扫描顺序；输出结果不依赖 HashMap 迭代顺序。
    for chunk_y in minimum_chunk[1]..=maximum_chunk[1] {
        check_encoding_cancelled(is_cancelled)?;
        for chunk_z in minimum_chunk[2]..=maximum_chunk[2] {
            for chunk_x in minimum_chunk[0]..=maximum_chunk[0] {
                let chunk_coordinate = [chunk_x, chunk_y, chunk_z];
                let Some(chunk) = prepared.chunk_index.get(&chunk_coordinate) else {
                    continue;
                };
                for (local_position, palette_index) in chunk
                    .positions
                    .iter()
                    .copied()
                    .zip(chunk.palette_indices.iter())
                {
                    let world = world_position(chunk.chunk, local_position)?;
                    if (0..3).any(|axis| {
                        world[axis] < view.bounds.min[axis] || world[axis] > view.bounds.max[axis]
                    }) {
                        continue;
                    }
                    let x = (world[0] - view.bounds.min[0]) as usize;
                    let y = (world[1] - view.bounds.min[1]) as usize;
                    let z = (world[2] - view.bounds.min[2]) as usize;
                    let dense_index = y
                        .checked_mul(size_z)
                        .and_then(|value| value.checked_add(z))
                        .and_then(|value| value.checked_mul(size_x))
                        .and_then(|value| value.checked_add(x))
                        .ok_or(LitematicError::ArithmeticOverflow {
                            field: "Litematic dense block-state index",
                        })?;
                    if dense_index >= view.volume {
                        return Err(LitematicError::PackedIndexOutOfRange { index: dense_index });
                    }
                    let litematic_palette_index =
                        palette_index
                            .checked_add(1)
                            .ok_or(LitematicError::ArithmeticOverflow {
                                field: "Litematic air palette offset",
                            })?;
                    set_packed_value(
                        &mut packed,
                        dense_index,
                        prepared.bits_per_block,
                        litematic_palette_index,
                    )?;
                    block_count =
                        block_count
                            .checked_add(1)
                            .ok_or(LitematicError::ArithmeticOverflow {
                                field: "Litematic region block count",
                            })?;
                }
            }
        }
    }

    if block_count != view.block_count {
        return Err(LitematicError::RegionBlockCountMismatch {
            region: view.index.0,
            expected: view.block_count,
            actual: block_count,
        });
    }
    Ok(packed)
}

fn write_nbt<W: Write>(
    writer: &mut BigEndianNbtWriter<W>,
    prepared: &PreparedLitematic<'_, '_>,
    options: &LitematicOptions,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<(), LitematicError> {
    check_encoding_cancelled(is_cancelled)?;
    let document = prepared.document;
    writer.start_root_compound()?;
    writer.named_i32("Version", LITEMATIC_FORMAT_VERSION)?;
    writer.named_i32("SubVersion", LITEMATIC_SUB_VERSION)?;
    writer.named_i32("MinecraftDataVersion", LITEMATIC_DATA_VERSION)?;

    writer.start_compound("Metadata")?;
    writer.start_compound("EnclosingSize")?;
    writer.named_i32("x", document.bounds.dimensions[0] as i32)?;
    writer.named_i32("y", document.bounds.dimensions[1] as i32)?;
    writer.named_i32("z", document.bounds.dimensions[2] as i32)?;
    writer.end_compound()?;
    writer.named_string("Author", &options.author)?;
    writer.named_string("Description", &options.description)?;
    writer.named_string("Name", &options.name)?;
    writer.named_string("Software", &options.software)?;
    writer.named_string("TargetMinecraftVersion", &options.target_minecraft_version)?;
    writer.named_string(
        "SerializerMinecraftVersion",
        &options.serializer_minecraft_version,
    )?;
    writer.named_string("CompatibilityLevel", &options.compatibility_level)?;
    writer.named_string("CompatibilityWarning", &options.compatibility_warning)?;
    writer.named_i32("RegionCount", prepared.views.len() as i32)?;
    writer.named_i64("TimeCreated", options.timestamp_millis)?;
    writer.named_i64("TimeModified", options.timestamp_millis)?;
    writer.named_i32("TotalBlocks", document.block_count as i32)?;
    writer.named_i32("TotalVolume", prepared.total_volume as i32)?;
    writer.named_empty_i32_array("PreviewImageData")?;
    writer.end_compound()?;

    writer.start_compound("Regions")?;
    for view in prepared.views.iter().copied() {
        check_encoding_cancelled(is_cancelled)?;
        let region_name = if prepared.views.len() == 1 {
            "Hologram".to_owned()
        } else {
            format!(
                "R_{}_{}_{}",
                view.index.0[1], view.index.0[2], view.index.0[0]
            )
        };
        writer.start_compound(&region_name)?;
        writer.start_compound("Position")?;
        writer.named_i32("x", view.bounds.min[0] - document.bounds.min[0])?;
        writer.named_i32("y", view.bounds.min[1] - document.bounds.min[1])?;
        writer.named_i32("z", view.bounds.min[2] - document.bounds.min[2])?;
        writer.end_compound()?;
        writer.start_compound("Size")?;
        writer.named_i32("x", view.bounds.dimensions[0] as i32)?;
        writer.named_i32("y", view.bounds.dimensions[1] as i32)?;
        writer.named_i32("z", view.bounds.dimensions[2] as i32)?;
        writer.end_compound()?;
        write_palette(writer, &document.palette)?;
        let packed = build_region_data(prepared, view, is_cancelled)?;
        writer.named_long_array_with_control("BlockStates", &packed, is_cancelled)?;
        writer.named_empty_list("Entities")?;
        writer.named_empty_list("TileEntities")?;
        writer.named_empty_list("PendingBlockTicks")?;
        writer.named_empty_list("PendingFluidTicks")?;
        writer.end_compound()?;
    }
    writer.end_compound()?;
    writer.end_compound()?;
    Ok(())
}

fn write_palette<W: Write>(
    writer: &mut BigEndianNbtWriter<W>,
    palette: &[LitematicBlockState],
) -> Result<(), LitematicError> {
    writer.start_compound_list("BlockStatePalette", palette.len() + 1)?;
    writer.named_string("Name", "minecraft:air")?;
    writer.end_compound()?;
    for state in palette {
        writer.named_string("Name", &state.name)?;
        if !state.properties.is_empty() {
            writer.start_compound("Properties")?;
            for (key, value) in &state.properties {
                writer.named_string(key, value)?;
            }
            writer.end_compound()?;
        }
        writer.end_compound()?;
    }
    Ok(())
}

struct BigEndianNbtWriter<W: Write> {
    inner: W,
}

impl<W: Write> BigEndianNbtWriter<W> {
    fn new(inner: W) -> Self {
        Self { inner }
    }

    fn into_inner(self) -> W {
        self.inner
    }

    fn header(&mut self, tag: u8, name: &str) -> Result<(), LitematicError> {
        self.inner.write_all(&[tag])?;
        self.raw_string(name, &format!("NBT tag name {name}"))
    }

    fn raw_string(&mut self, value: &str, field: &str) -> Result<(), LitematicError> {
        validate_nbt_string(value, field)?;
        self.inner.write_all(&(value.len() as u16).to_be_bytes())?;
        self.inner.write_all(value.as_bytes())?;
        Ok(())
    }

    fn start_root_compound(&mut self) -> Result<(), LitematicError> {
        self.header(TAG_COMPOUND, "")
    }

    fn start_compound(&mut self, name: &str) -> Result<(), LitematicError> {
        self.header(TAG_COMPOUND, name)
    }

    fn end_compound(&mut self) -> Result<(), LitematicError> {
        self.inner.write_all(&[TAG_END])?;
        Ok(())
    }

    fn named_i32(&mut self, name: &str, value: i32) -> Result<(), LitematicError> {
        self.header(TAG_INT, name)?;
        self.inner.write_all(&value.to_be_bytes())?;
        Ok(())
    }

    fn named_i64(&mut self, name: &str, value: i64) -> Result<(), LitematicError> {
        self.header(TAG_LONG, name)?;
        self.inner.write_all(&value.to_be_bytes())?;
        Ok(())
    }

    fn named_string(&mut self, name: &str, value: &str) -> Result<(), LitematicError> {
        self.header(TAG_STRING, name)?;
        self.raw_string(value, name)
    }

    fn start_compound_list(&mut self, name: &str, length: usize) -> Result<(), LitematicError> {
        self.header(TAG_LIST, name)?;
        self.inner.write_all(&[TAG_COMPOUND])?;
        let length = ensure_nbt_int(length as u64, "NBT compound list length")?;
        self.inner.write_all(&length.to_be_bytes())?;
        Ok(())
    }

    fn named_empty_list(&mut self, name: &str) -> Result<(), LitematicError> {
        self.header(TAG_LIST, name)?;
        self.inner.write_all(&[TAG_END])?;
        self.inner.write_all(&0_i32.to_be_bytes())?;
        Ok(())
    }

    fn named_empty_i32_array(&mut self, name: &str) -> Result<(), LitematicError> {
        self.header(TAG_INT_ARRAY, name)?;
        self.inner.write_all(&0_i32.to_be_bytes())?;
        Ok(())
    }

    fn named_long_array_with_control(
        &mut self,
        name: &str,
        values: &[u64],
        is_cancelled: &dyn Fn() -> bool,
    ) -> Result<(), LitematicError> {
        self.header(TAG_LONG_ARRAY, name)?;
        let length = ensure_nbt_int(values.len() as u64, "NBT long array length")?;
        self.inner.write_all(&length.to_be_bytes())?;
        for chunk in values.chunks(4_096) {
            check_encoding_cancelled(is_cancelled)?;
            for value in chunk {
                self.inner.write_all(&value.to_be_bytes())?;
            }
        }
        Ok(())
    }
}

struct CountingWriter<W> {
    inner: W,
    bytes_written: u64,
}

impl<W> CountingWriter<W> {
    fn new(inner: W) -> Self {
        Self {
            inner,
            bytes_written: 0,
        }
    }
}

impl<W: Write> Write for CountingWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let written = self.inner.write(bytes)?;
        self.bytes_written = self
            .bytes_written
            .checked_add(written as u64)
            .ok_or_else(|| io::Error::other("Litematic compressed byte count overflow"))?;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use flate2::read::GzDecoder;

    use crate::solid_voxel::{
        chunk::ChunkCoordinate,
        voxelize::{SolidShellBounds, SolidShellChunk, SolidShellPaletteEntry, SolidShellStats},
    };

    use super::*;

    fn local_position(x: u16, y: u16, z: u16) -> u16 {
        x + 32 * (z + 32 * y)
    }

    fn block_state(name: &str) -> LitematicBlockState {
        LitematicBlockState::new(name)
    }

    fn small_document() -> LitematicDocument {
        LitematicDocument {
            palette: vec![
                block_state("minecraft:white_concrete"),
                block_state("minecraft:black_concrete"),
            ],
            chunks: vec![
                LitematicChunk {
                    chunk: [-1, 0, 0],
                    positions: vec![local_position(31, 0, 0)],
                    palette_indices: vec![0],
                },
                LitematicChunk {
                    chunk: [0, 0, 0],
                    positions: vec![local_position(1, 1, 1)],
                    palette_indices: vec![1],
                },
            ],
            bounds: LitematicBounds {
                min: [-1, 0, 0],
                max: [1, 1, 1],
                dimensions: [3, 2, 2],
            },
            block_count: 2,
        }
    }

    fn solid_result_fixture() -> SolidShellResult {
        SolidShellResult {
            chunks: vec![SolidShellChunk {
                chunk: ChunkCoordinate::new(0, 0, 0),
                positions: vec![local_position(0, 0, 0)],
                block_indices: vec![0],
            }],
            palette: vec![SolidShellPaletteEntry {
                block_id: "minecraft:stone".to_owned(),
                color: [125, 125, 125],
            }],
            stats: SolidShellStats {
                block_count: 1,
                surface_block_count: 1,
                filled_block_count: 0,
                skin_block_count: 0,
                alpha_rejected: 0,
                triangle_box_tests: 0,
                palette_size: 1,
                dimensions: [1, 1, 1],
            },
            bounds: SolidShellBounds {
                min: [0, 0, 0],
                max: [0, 0, 0],
            },
        }
    }

    #[test]
    fn solid_result_palette_preserves_propertyless_block_states() {
        let mut result = solid_result_fixture();
        result.palette = vec![
            SolidShellPaletteEntry {
                block_id: "minecraft:end_rod".to_owned(),
                color: [232, 227, 212],
            },
            SolidShellPaletteEntry {
                block_id: "minecraft:white_stained_glass_pane".to_owned(),
                color: [214, 229, 229],
            },
        ];
        result.chunks[0].positions = vec![local_position(0, 0, 0), local_position(1, 0, 0)];
        result.chunks[0].block_indices = vec![0, 1];
        result.stats.block_count = 2;
        result.stats.surface_block_count = 2;
        result.stats.palette_size = 2;
        result.stats.dimensions = [2, 1, 1];
        result.bounds.max = [1, 0, 0];

        let input = LitematicInput::from_solid_result(&result).unwrap();

        assert_eq!(
            input.palette,
            vec![
                block_state("minecraft:end_rod"),
                block_state("minecraft:white_stained_glass_pane"),
            ],
        );
        assert!(input
            .palette
            .iter()
            .all(|state| state.properties.is_empty()));
    }

    fn prepare_document(
        document: &LitematicDocument,
        options: &LitematicOptions,
    ) -> Result<(), LitematicError> {
        let input = LitematicInput::from_document(document)?;
        PreparedLitematic::new(&input, options, &|| false).map(|_| ())
    }

    #[test]
    fn continuous_palette_indices_survive_long_boundaries() {
        for palette_size in [2_usize, 3, 4, 5, 7, 16, 17, 33] {
            let indices = (0..257)
                .map(|index| ((index * 7 + index / 3) % palette_size) as u32)
                .collect::<Vec<_>>();
            let packed = pack_block_states(&indices, palette_size).unwrap();

            assert_eq!(
                packed.longs.len(),
                (indices.len() * packed.bits_per_block as usize).div_ceil(64),
            );
            for (index, expected) in indices.iter().copied().enumerate() {
                assert_eq!(
                    unpack_block_state(&packed.longs, index, packed.bits_per_block).unwrap(),
                    expected,
                );
            }
        }
    }

    #[test]
    fn dense_layout_uses_y_z_x_and_offsets_palette_for_air() {
        let document = small_document();
        let input = LitematicInput::from_document(&document).unwrap();
        let prepared =
            PreparedLitematic::new(&input, &LitematicOptions::default(), &|| false).unwrap();
        assert_eq!(prepared.views.len(), 1);
        let packed = build_region_data(&prepared, prepared.views[0], &|| false).unwrap();

        assert_eq!(unpack_block_state(&packed, 0, 2).unwrap(), 1);
        assert_eq!(unpack_block_state(&packed, 1, 2).unwrap(), 0);
        // (y * sizeZ + z) * sizeX + x = (1 * 2 + 1) * 3 + 2 = 11
        assert_eq!(unpack_block_state(&packed, 11, 2).unwrap(), 2);
    }

    #[test]
    fn sparse_regions_are_sorted_by_y_z_x_with_negative_world_coordinates() {
        let document = LitematicDocument {
            palette: vec![
                block_state("minecraft:white_concrete"),
                block_state("minecraft:black_concrete"),
            ],
            chunks: vec![
                LitematicChunk {
                    chunk: [1, 1, 2],
                    positions: vec![local_position(3, 1, 1)],
                    palette_indices: vec![1],
                },
                LitematicChunk {
                    chunk: [-2, -1, 0],
                    positions: vec![local_position(31, 30, 0)],
                    palette_indices: vec![0],
                },
                LitematicChunk {
                    chunk: [0, 0, 1],
                    positions: vec![local_position(0, 0, 0)],
                    palette_indices: vec![0],
                },
                LitematicChunk {
                    chunk: [-1, -1, 0],
                    positions: vec![local_position(31, 31, 31)],
                    palette_indices: vec![1],
                },
            ],
            bounds: LitematicBounds {
                min: [-33, -2, 0],
                max: [35, 33, 65],
                dimensions: [69, 36, 66],
            },
            block_count: 4,
        };
        let input = LitematicInput::from_document(&document).unwrap();
        let prepared =
            PreparedLitematic::new(&input, &LitematicOptions::default(), &|| false).unwrap();
        let order = prepared
            .views
            .iter()
            .map(|view| view.index.0)
            .collect::<Vec<_>>();

        assert_eq!(order, vec![[0, 0, 0], [1, 0, 0], [1, 0, 1], [2, 1, 2]]);
    }

    #[test]
    fn writes_big_endian_v6_nbt_through_a_gzip_stream() {
        let document = small_document();
        let mut compressed = Vec::new();
        let options = LitematicOptions {
            timestamp_millis: 1_786_000_000_000,
            ..LitematicOptions::default()
        };
        let summary = write_litematic(&document, &mut compressed, &options).unwrap();

        assert_eq!(&compressed[..2], &[0x1f, 0x8b]);
        assert_eq!(summary.compressed_bytes, compressed.len() as u64);
        assert_eq!(summary.format_version, 6);
        assert_eq!(summary.sub_version, 1);
        assert_eq!(summary.data_version, 3465);
        assert_eq!(summary.palette_size, 3);

        let mut nbt = Vec::new();
        GzDecoder::new(compressed.as_slice())
            .read_to_end(&mut nbt)
            .unwrap();
        // 该指纹由 src/core/litematic.ts 对同一 fixture 生成，用于锁定完整 NBT 内容一致性。
        assert_eq!(nbt.len(), 780);
        assert_eq!(fnv1a64(&nbt), 0xf249_09ff_3207_7550);
        assert_eq!(&nbt[..3], &[TAG_COMPOUND, 0, 0]);
        // 该树由现有 TypeScript writer 对同一 `small_document` fixture 解析得到；
        // 除了 hash 外逐字段比较，避免只更新指纹掩盖 NBT 结构差异。
        assert_eq!(parse_probe_nbt(&nbt).unwrap(), expected_small_nbt());
    }

    #[test]
    fn rejects_structural_damage_instead_of_wrapping_values() {
        let mut damaged = small_document();
        damaged.bounds.dimensions[0] = 4;
        assert!(matches!(
            prepare_document(&damaged, &LitematicOptions::default()),
            Err(LitematicError::InvalidBounds { axis: 0 }),
        ));

        let mut damaged = small_document();
        damaged.block_count = 3;
        assert!(matches!(
            prepare_document(&damaged, &LitematicOptions::default()),
            Err(LitematicError::BlockCountMismatch {
                declared: 3,
                actual: 2,
            }),
        ));

        let options = LitematicOptions {
            region_max_size: [32, 0, 32],
            ..LitematicOptions::default()
        };
        assert!(matches!(
            prepare_document(&small_document(), &options),
            Err(LitematicError::InvalidRegionMaxSize { axis: 1, value: 0 }),
        ));
    }

    #[test]
    fn rejects_coordinate_overflow_and_oversized_utf8() {
        let mut overflow = small_document();
        overflow.chunks[1].chunk = [i32::MAX, 0, 0];
        assert!(matches!(
            prepare_document(&overflow, &LitematicOptions::default()),
            Err(LitematicError::CoordinateOverflow { axis: 0, .. }),
        ));

        let options = LitematicOptions {
            author: "界".repeat(22_000),
            ..LitematicOptions::default()
        };
        assert!(matches!(
            prepare_document(&small_document(), &options),
            Err(LitematicError::NbtStringTooLong { .. }),
        ));
    }

    #[test]
    fn invalid_packed_values_are_not_silently_masked() {
        assert!(matches!(
            pack_block_states(&[0, 3], 3),
            Err(LitematicError::PackedValueOutOfRange {
                index: 1,
                value: 3,
                palette_size: 3,
            }),
        ));
        assert!(matches!(
            unpack_block_state(&[0], 0, 0),
            Err(LitematicError::InvalidBitsPerBlock { bits_per_block: 0 }),
        ));
    }

    fn temporary_test_path(label: &str) -> PathBuf {
        let sequence = TEMP_FILE_COUNTER.fetch_add(1, AtomicOrdering::Relaxed);
        std::env::temp_dir().join(format!(
            "mely-litematic-{label}-{}-{sequence}.litematic",
            std::process::id(),
        ))
    }

    fn temporary_artifacts_for(output_path: &Path) -> Vec<PathBuf> {
        let parent = output_path.parent().unwrap();
        let prefix = format!(
            ".{}.mely-",
            output_path.file_name().unwrap().to_string_lossy()
        );
        fs::read_dir(parent)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .is_some_and(|name| name.to_string_lossy().starts_with(&prefix))
            })
            .collect()
    }

    #[test]
    fn cancellation_preserves_existing_target_and_cleans_temporary_file() {
        let output = temporary_test_path("cancel");
        fs::write(&output, b"existing projection").unwrap();
        let token = LitematicCancellationToken::new();
        assert!(token.cancel());

        let error = write_solid_litematic_atomic_with_control(
            &solid_result_fixture(),
            &output,
            &LitematicOptions::default(),
            &token,
            true,
        )
        .unwrap_err();

        assert!(matches!(
            error,
            LitematicFileError::Encode(LitematicError::Cancelled)
        ));
        assert_eq!(fs::read(&output).unwrap(), b"existing projection");
        assert!(temporary_artifacts_for(&output).is_empty());
        fs::remove_file(output).unwrap();
    }

    #[test]
    fn overwrite_requires_confirmation_and_successful_commit_replaces_target() {
        let output = temporary_test_path("overwrite");
        fs::write(&output, b"existing projection").unwrap();

        let error = write_solid_litematic_atomic_with_control(
            &solid_result_fixture(),
            &output,
            &LitematicOptions::default(),
            &LitematicCancellationToken::new(),
            false,
        )
        .unwrap_err();
        assert!(matches!(
            error,
            LitematicFileError::Io(ref io_error)
                if io_error.kind() == io::ErrorKind::AlreadyExists
        ));
        assert_eq!(fs::read(&output).unwrap(), b"existing projection");
        assert!(temporary_artifacts_for(&output).is_empty());

        let summary = write_solid_litematic_atomic_with_control(
            &solid_result_fixture(),
            &output,
            &LitematicOptions::default(),
            &LitematicCancellationToken::new(),
            true,
        )
        .unwrap();
        assert!(summary.compressed_bytes > 0);
        assert_eq!(&fs::read(&output).unwrap()[..2], &[0x1f, 0x8b]);
        assert!(temporary_artifacts_for(&output).is_empty());
        fs::remove_file(output).unwrap();
    }

    #[test]
    fn commit_linearization_makes_late_cancellation_too_late() {
        let token = LitematicCancellationToken::new();
        token.begin_commit().unwrap();
        assert!(!token.cancel());
        token.finish_commit();
        assert!(!token.is_cancelled());
    }

    #[derive(Debug, PartialEq, Eq)]
    enum ProbeValue {
        Int(i32),
        Long(i64),
        String(String),
        List { element_type: u8, values: Vec<Self> },
        Compound(Vec<(String, Self)>),
        IntArray(Vec<i32>),
        LongArray(Vec<u64>),
    }

    struct ProbeCursor<'a> {
        bytes: &'a [u8],
        offset: usize,
    }

    impl<'a> ProbeCursor<'a> {
        fn new(bytes: &'a [u8]) -> Self {
            Self { bytes, offset: 0 }
        }

        fn take(&mut self, length: usize) -> Result<&'a [u8], String> {
            let end = self
                .offset
                .checked_add(length)
                .ok_or_else(|| "NBT probe offset overflow".to_owned())?;
            let value = self
                .bytes
                .get(self.offset..end)
                .ok_or_else(|| "NBT probe ended unexpectedly".to_owned())?;
            self.offset = end;
            Ok(value)
        }

        fn byte(&mut self) -> Result<u8, String> {
            Ok(self.take(1)?[0])
        }

        fn i32(&mut self) -> Result<i32, String> {
            Ok(i32::from_be_bytes(self.take(4)?.try_into().unwrap()))
        }

        fn i64(&mut self) -> Result<i64, String> {
            Ok(i64::from_be_bytes(self.take(8)?.try_into().unwrap()))
        }

        fn string(&mut self) -> Result<String, String> {
            let length = usize::from(u16::from_be_bytes(self.take(2)?.try_into().unwrap()));
            String::from_utf8(self.take(length)?.to_vec())
                .map_err(|_| "NBT probe encountered invalid UTF-8".to_owned())
        }
    }

    fn parse_probe_nbt(bytes: &[u8]) -> Result<ProbeValue, String> {
        let mut cursor = ProbeCursor::new(bytes);
        if cursor.byte()? != TAG_COMPOUND || !cursor.string()?.is_empty() {
            return Err("NBT probe root is not an unnamed compound".to_owned());
        }
        let value = parse_probe_payload(&mut cursor, TAG_COMPOUND)?;
        if cursor.offset != bytes.len() {
            return Err("NBT probe has trailing bytes".to_owned());
        }
        Ok(value)
    }

    fn parse_probe_payload(cursor: &mut ProbeCursor<'_>, tag: u8) -> Result<ProbeValue, String> {
        match tag {
            TAG_INT => Ok(ProbeValue::Int(cursor.i32()?)),
            TAG_LONG => Ok(ProbeValue::Long(cursor.i64()?)),
            TAG_STRING => Ok(ProbeValue::String(cursor.string()?)),
            TAG_LIST => {
                let element_type = cursor.byte()?;
                let length = cursor.i32()?;
                if length < 0 {
                    return Err("NBT probe list length is negative".to_owned());
                }
                let mut values = Vec::with_capacity(length as usize);
                for _ in 0..length {
                    values.push(parse_probe_payload(cursor, element_type)?);
                }
                Ok(ProbeValue::List {
                    element_type,
                    values,
                })
            }
            TAG_COMPOUND => {
                let mut values = Vec::new();
                loop {
                    let child_tag = cursor.byte()?;
                    if child_tag == TAG_END {
                        break;
                    }
                    let name = cursor.string()?;
                    values.push((name, parse_probe_payload(cursor, child_tag)?));
                }
                Ok(ProbeValue::Compound(values))
            }
            TAG_INT_ARRAY => {
                let length = cursor.i32()?;
                if length < 0 {
                    return Err("NBT probe int-array length is negative".to_owned());
                }
                let mut values = Vec::with_capacity(length as usize);
                for _ in 0..length {
                    values.push(cursor.i32()?);
                }
                Ok(ProbeValue::IntArray(values))
            }
            TAG_LONG_ARRAY => {
                let length = cursor.i32()?;
                if length < 0 {
                    return Err("NBT probe long-array length is negative".to_owned());
                }
                let mut values = Vec::with_capacity(length as usize);
                for _ in 0..length {
                    values.push(u64::from_be_bytes(cursor.take(8)?.try_into().unwrap()));
                }
                Ok(ProbeValue::LongArray(values))
            }
            other => Err(format!("NBT probe encountered unsupported tag {other}")),
        }
    }

    fn expected_small_nbt() -> ProbeValue {
        use ProbeValue::{
            Compound as C, Int as I, IntArray as IA, List as L, Long as G, LongArray as GA,
            String as S,
        };
        C(vec![
            ("Version".to_owned(), I(6)),
            ("SubVersion".to_owned(), I(1)),
            ("MinecraftDataVersion".to_owned(), I(3465)),
            (
                "Metadata".to_owned(),
                C(vec![
                    (
                        "EnclosingSize".to_owned(),
                        C(vec![
                            ("x".to_owned(), I(3)),
                            ("y".to_owned(), I(2)),
                            ("z".to_owned(), I(2)),
                        ]),
                    ),
                    ("Author".to_owned(), S("MELY".to_owned())),
                    (
                        "Description".to_owned(),
                        S("MELY | Minecraft 1.20.1".to_owned()),
                    ),
                    ("Name".to_owned(), S("MELY_Projection".to_owned())),
                    ("Software".to_owned(), S("MELY_1.0.0".to_owned())),
                    ("TargetMinecraftVersion".to_owned(), S("1.20.1".to_owned())),
                    (
                        "SerializerMinecraftVersion".to_owned(),
                        S("1.20.1".to_owned()),
                    ),
                    ("CompatibilityLevel".to_owned(), S("exact".to_owned())),
                    ("CompatibilityWarning".to_owned(), S(String::new())),
                    ("RegionCount".to_owned(), I(1)),
                    ("TimeCreated".to_owned(), G(1_786_000_000_000)),
                    ("TimeModified".to_owned(), G(1_786_000_000_000)),
                    ("TotalBlocks".to_owned(), I(2)),
                    ("TotalVolume".to_owned(), I(12)),
                    ("PreviewImageData".to_owned(), IA(Vec::new())),
                ]),
            ),
            (
                "Regions".to_owned(),
                C(vec![(
                    "Hologram".to_owned(),
                    C(vec![
                        (
                            "Position".to_owned(),
                            C(vec![
                                ("x".to_owned(), I(0)),
                                ("y".to_owned(), I(0)),
                                ("z".to_owned(), I(0)),
                            ]),
                        ),
                        (
                            "Size".to_owned(),
                            C(vec![
                                ("x".to_owned(), I(3)),
                                ("y".to_owned(), I(2)),
                                ("z".to_owned(), I(2)),
                            ]),
                        ),
                        (
                            "BlockStatePalette".to_owned(),
                            L {
                                element_type: TAG_COMPOUND,
                                values: vec![
                                    C(vec![("Name".to_owned(), S("minecraft:air".to_owned()))]),
                                    C(vec![(
                                        "Name".to_owned(),
                                        S("minecraft:white_concrete".to_owned()),
                                    )]),
                                    C(vec![(
                                        "Name".to_owned(),
                                        S("minecraft:black_concrete".to_owned()),
                                    )]),
                                ],
                            },
                        ),
                        ("BlockStates".to_owned(), GA(vec![8_388_609])),
                        (
                            "Entities".to_owned(),
                            L {
                                element_type: TAG_END,
                                values: Vec::new(),
                            },
                        ),
                        (
                            "TileEntities".to_owned(),
                            L {
                                element_type: TAG_END,
                                values: Vec::new(),
                            },
                        ),
                        (
                            "PendingBlockTicks".to_owned(),
                            L {
                                element_type: TAG_END,
                                values: Vec::new(),
                            },
                        ),
                        (
                            "PendingFluidTicks".to_owned(),
                            L {
                                element_type: TAG_END,
                                values: Vec::new(),
                            },
                        ),
                    ]),
                )]),
            ),
        ])
    }

    fn fnv1a64(bytes: &[u8]) -> u64 {
        bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x100_0000_01b3)
        })
    }
}
