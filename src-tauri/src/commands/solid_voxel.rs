//! Tauri 原生实体体素任务的薄命令层。

use std::{path::PathBuf, time::Duration};

use serde::{Deserialize, Serialize};
use tauri::{
    ipc::{InvokeBody, Response},
    State,
};

use crate::solid_voxel::{
    contract::SolidShellOptions,
    litematic::{
        write_solid_litematic_atomic_with_control, LitematicError, LitematicFileError,
        LitematicOptions, LITEMATIC_DATA_VERSION, LITEMATIC_FORMAT_VERSION, LITEMATIC_SUB_VERSION,
    },
    manager::{
        CancelSolidVoxelJobResponse, CreateSolidVoxelJobRequest, CreateSolidVoxelJobResponse,
        ManagerError, ResultHandle, SolidVoxelJobStatus, SolidVoxelManager,
        UploadSolidVoxelSnapshotResponse,
    },
    preview::{limited_preview_for_handle, LimitedPreviewError, SolidVoxelLimitedPreview},
    result_batch::ResultBatchError,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SolidVoxelCommandError {
    pub code: &'static str,
    pub category: &'static str,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl From<ManagerError> for SolidVoxelCommandError {
    fn from(error: ManagerError) -> Self {
        let (code, category, retryable) = match &error {
            ManagerError::InvalidJobId
            | ManagerError::InvalidThreadCount
            | ManagerError::InvalidRawBody
            | ManagerError::SnapshotJobMismatch { .. }
            | ManagerError::SnapshotValidation(_) => {
                ("SOLID_VOXEL_INVALID_REQUEST", "validation", false)
            }
            ManagerError::Unsupported(_) => {
                ("SOLID_VOXEL_UNSUPPORTED_OPTIONS", "unsupported", false)
            }
            ManagerError::Busy { .. } => ("SOLID_VOXEL_BUSY", "busy", true),
            ManagerError::JobNotFound { .. }
            | ManagerError::JobMismatch { .. }
            | ManagerError::InvalidState { .. }
            | ManagerError::ResultHandleNotFound
            | ManagerError::ResultNotReady
            | ManagerError::InvalidResultCursor => ("SOLID_VOXEL_STALE_STATE", "validation", true),
            ManagerError::ResultBatch(
                ResultBatchError::InvalidByteLimit { .. }
                | ResultBatchError::InvalidHandle
                | ResultBatchError::StartChunkOutOfRange { .. }
                | ResultBatchError::InvalidCursor,
            ) => ("SOLID_VOXEL_INVALID_REQUEST", "validation", false),
            ManagerError::ResultBatch(_) => ("SOLID_VOXEL_RESULT_BATCH_FAILED", "internal", true),
            ManagerError::HandleSpaceExhausted => {
                ("SOLID_VOXEL_HANDLE_SPACE_EXHAUSTED", "internal", false)
            }
            ManagerError::Internal(_) => ("SOLID_VOXEL_INTERNAL", "internal", true),
        };
        Self {
            code,
            category,
            retryable,
            message: Some(error.to_string()),
        }
    }
}

impl From<LimitedPreviewError> for SolidVoxelCommandError {
    fn from(error: LimitedPreviewError) -> Self {
        if let LimitedPreviewError::Manager(manager_error) = error {
            return manager_error.into();
        }

        let message = error.to_string();
        let (code, category, retryable) = match error {
            LimitedPreviewError::InvalidMaxPoints { .. } => {
                ("SOLID_VOXEL_INVALID_REQUEST", "validation", false)
            }
            LimitedPreviewError::InconsistentChunkBuffers { .. }
            | LimitedPreviewError::PointCountOverflow
            | LimitedPreviewError::BlockCountMismatch { .. }
            | LimitedPreviewError::InvalidWorldPosition { .. }
            | LimitedPreviewError::InvalidPaletteIndex { .. }
            | LimitedPreviewError::SamplingInvariant => {
                ("SOLID_VOXEL_PREVIEW_FAILED", "internal", true)
            }
            LimitedPreviewError::Manager(_) => unreachable!("manager error handled above"),
        };
        Self {
            code,
            category,
            retryable,
            message: Some(message),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeLitematicTargetDimension {
    pub min_y: i32,
    pub height: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeLitematicSafety {
    pub height_mode: String,
    pub target_height: u32,
    pub target_dimension: NativeLitematicTargetDimension,
    pub placement_bottom_y: i32,
    pub target_minecraft_version: String,
    pub serializer_minecraft_version: String,
    pub data_version: i32,
    pub format_version: i32,
    pub sub_version: i32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum NativeRegionMaxSize {
    Scalar(u32),
    Axes([u32; 3]),
}

impl NativeRegionMaxSize {
    fn into_axes(self) -> [u32; 3] {
        match self {
            Self::Scalar(value) => [value; 3],
            Self::Axes(values) => values,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteSolidVoxelLitematicRequest {
    pub handle: ResultHandle,
    pub output_path: String,
    #[serde(default)]
    pub overwrite_existing: bool,
    pub name: String,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    pub region_max_size: NativeRegionMaxSize,
    pub safety: NativeLitematicSafety,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteSolidVoxelLitematicResponse {
    pub output_path: String,
    pub byte_length: u64,
    pub block_count: u64,
    pub region_count: u32,
    pub palette_size: u32,
    pub dimensions: [u32; 3],
    pub data_version: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseSolidVoxelJobResponse {
    pub job_id: String,
    pub fully_released: bool,
}

const RELEASE_SETTLE_TIMEOUT: Duration = Duration::from_secs(2);

fn litematic_validation_error(message: impl Into<String>) -> SolidVoxelCommandError {
    SolidVoxelCommandError {
        code: "SOLID_VOXEL_INVALID_REQUEST",
        category: "validation",
        retryable: false,
        message: Some(message.into()),
    }
}

fn litematic_write_error(error: LitematicFileError) -> SolidVoxelCommandError {
    let message = error.to_string();
    let (code, category, retryable) = match error {
        LitematicFileError::Encode(LitematicError::Cancelled) => {
            ("SOLID_VOXEL_CANCELLED", "cancelled", true)
        }
        LitematicFileError::Io(ref io_error)
            if io_error.kind() == std::io::ErrorKind::AlreadyExists =>
        {
            (
                "SOLID_VOXEL_OVERWRITE_CONFIRMATION_REQUIRED",
                "validation",
                false,
            )
        }
        LitematicFileError::Encode(LitematicError::EmptyDocument)
        | LitematicFileError::Encode(LitematicError::EmptyPalette)
        | LitematicFileError::Encode(LitematicError::InvalidBounds { .. })
        | LitematicFileError::Encode(LitematicError::BoundsMismatch { .. })
        | LitematicFileError::Encode(LitematicError::BlockCountMismatch { .. })
        | LitematicFileError::Encode(LitematicError::UnknownPaletteIndex { .. })
        | LitematicFileError::Encode(LitematicError::InvalidLocalPosition { .. })
        | LitematicFileError::Encode(LitematicError::LocalPositionsNotStrictlyIncreasing {
            ..
        })
        | LitematicFileError::Encode(LitematicError::InconsistentChunkBuffers { .. })
        | LitematicFileError::Encode(LitematicError::EmptyChunk { .. }) => {
            ("SOLID_VOXEL_INVALID_REQUEST", "validation", false)
        }
        _ => ("SOLID_VOXEL_LITEMATIC_WRITE_FAILED", "internal", true),
    };
    SolidVoxelCommandError {
        code,
        category,
        retryable,
        message: Some(message),
    }
}

const DEFAULT_WORLD_MIN_Y: i32 = -64;
const DEFAULT_WORLD_HEIGHT: u32 = 384;
const EXTENDED_WORLD_HEIGHT: u32 = 2_032;
const EXPERIMENTAL_WORLD_MIN_Y: i32 = -2_032;
const EXPERIMENTAL_WORLD_HEIGHT: u32 = 4_064;

fn validate_height_mode_contract(
    safety: &NativeLitematicSafety,
) -> Result<(), SolidVoxelCommandError> {
    match safety.height_mode.as_str() {
        "default" => {
            if safety.target_height > DEFAULT_WORLD_HEIGHT
                || safety.target_dimension.min_y != DEFAULT_WORLD_MIN_Y
                || safety.target_dimension.height != DEFAULT_WORLD_HEIGHT
            {
                return Err(litematic_validation_error(
                    "default requires targetHeight<=384, minY=-64 and height=384",
                ));
            }
        }
        "extended_2032" => {
            if safety.target_height > EXTENDED_WORLD_HEIGHT
                || safety.target_dimension.height > EXTENDED_WORLD_HEIGHT
                || safety.target_dimension.height < safety.target_height
            {
                return Err(litematic_validation_error(
                    "extended_2032 requires targetHeight<=2032 and a declared dimension no taller than 2032",
                ));
            }
        }
        "experimental_4064" => {
            if safety.target_dimension.min_y != EXPERIMENTAL_WORLD_MIN_Y
                || safety.target_dimension.height != EXPERIMENTAL_WORLD_HEIGHT
                || safety.placement_bottom_y != EXPERIMENTAL_WORLD_MIN_Y
            {
                return Err(litematic_validation_error(
                    "experimental_4064 requires minY=-2032, height=4064 and placementBottomY=-2032",
                ));
            }
        }
        _ => {
            return Err(litematic_validation_error(
                "heightMode must be default, extended_2032 or experimental_4064",
            ));
        }
    }

    if safety.target_height == EXPERIMENTAL_WORLD_HEIGHT
        && safety.height_mode != "experimental_4064"
    {
        return Err(litematic_validation_error(
            "targetHeight=4064 requires heightMode=experimental_4064",
        ));
    }

    Ok(())
}

fn validate_litematic_safety(
    safety: &NativeLitematicSafety,
    output_path: &str,
) -> Result<(), SolidVoxelCommandError> {
    if output_path.trim().is_empty() {
        return Err(litematic_validation_error("outputPath must not be empty"));
    }
    if safety.target_height == 0 || safety.target_dimension.height == 0 {
        return Err(litematic_validation_error(
            "Litematic dimensions must be positive",
        ));
    }
    if safety.target_minecraft_version.trim().is_empty()
        || safety.serializer_minecraft_version.trim().is_empty()
    {
        return Err(litematic_validation_error(
            "Minecraft version metadata must not be empty",
        ));
    }
    if safety.data_version != LITEMATIC_DATA_VERSION
        || safety.format_version != LITEMATIC_FORMAT_VERSION
        || safety.sub_version != LITEMATIC_SUB_VERSION
    {
        return Err(litematic_validation_error(
            "native Litematic writer requires Version 6, SubVersion 1 and DataVersion 3465",
        ));
    }
    if safety.target_height > safety.target_dimension.height {
        return Err(litematic_validation_error(
            "targetHeight must not exceed targetDimension.height",
        ));
    }
    validate_height_mode_contract(safety)?;
    let target_top = i64::from(safety.target_dimension.min_y)
        .checked_add(i64::from(safety.target_dimension.height) - 1)
        .ok_or_else(|| litematic_validation_error("target dimension overflows"))?;
    let placement_top = i64::from(safety.placement_bottom_y)
        .checked_add(i64::from(safety.target_height) - 1)
        .ok_or_else(|| litematic_validation_error("placement range overflows"))?;
    if target_top < i64::from(i32::MIN)
        || target_top > i64::from(i32::MAX)
        || placement_top < i64::from(i32::MIN)
        || placement_top > i64::from(i32::MAX)
    {
        return Err(litematic_validation_error(
            "placement range exceeds supported coordinates",
        ));
    }
    Ok(())
}

fn validate_result_placement(
    result: &crate::solid_voxel::voxelize::SolidShellResult,
    safety: &NativeLitematicSafety,
) -> Result<(), SolidVoxelCommandError> {
    let result_min_y = i64::from(result.bounds.min[1]);
    let result_max_y = i64::from(result.bounds.max[1]);
    let placed_min_y = i64::from(safety.placement_bottom_y)
        .checked_add(result_min_y)
        .ok_or_else(|| litematic_validation_error("result placement range overflows"))?;
    let placed_max_y = i64::from(safety.placement_bottom_y)
        .checked_add(result_max_y)
        .ok_or_else(|| litematic_validation_error("result placement range overflows"))?;
    let target_min_y = i64::from(safety.target_dimension.min_y);
    let target_max_y = target_min_y
        .checked_add(i64::from(safety.target_dimension.height) - 1)
        .ok_or_else(|| litematic_validation_error("target dimension overflows"))?;
    if placed_min_y < target_min_y || placed_max_y > target_max_y {
        return Err(litematic_validation_error(
            "result Y bounds are outside the declared target dimension",
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn create_solid_voxel_job(
    manager: State<'_, SolidVoxelManager>,
    worker_threads: usize,
    options: SolidShellOptions,
) -> Result<CreateSolidVoxelJobResponse, SolidVoxelCommandError> {
    manager
        .create_job(CreateSolidVoxelJobRequest {
            worker_threads,
            options,
        })
        .map_err(Into::into)
}

#[tauri::command]
pub fn upload_solid_voxel_snapshot(
    manager: State<'_, SolidVoxelManager>,
    request: tauri::ipc::Request<'_>,
) -> Result<UploadSolidVoxelSnapshotResponse, SolidVoxelCommandError> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(ManagerError::InvalidRawBody.into());
    };
    manager.upload_raw_snapshot(bytes).map_err(Into::into)
}

#[tauri::command]
pub fn solid_voxel_job_status(
    manager: State<'_, SolidVoxelManager>,
    job_id: String,
) -> Result<SolidVoxelJobStatus, SolidVoxelCommandError> {
    manager.status(parse_job_id(&job_id)?).map_err(Into::into)
}

#[tauri::command]
pub fn cancel_solid_voxel_job(
    manager: State<'_, SolidVoxelManager>,
    job_id: String,
) -> Result<CancelSolidVoxelJobResponse, SolidVoxelCommandError> {
    manager
        .cancel_job(parse_job_id(&job_id)?)
        .map_err(Into::into)
}

#[tauri::command]
pub async fn release_solid_voxel_job(
    manager: State<'_, SolidVoxelManager>,
    job_id: String,
) -> Result<ReleaseSolidVoxelJobResponse, SolidVoxelCommandError> {
    let numeric_job_id = parse_job_id(&job_id)?;
    let manager = manager.inner().clone();
    let fully_released = tauri::async_runtime::spawn_blocking(move || {
        manager.release_job_and_wait(numeric_job_id, RELEASE_SETTLE_TIMEOUT)
    })
    .await
    .map_err(|error| SolidVoxelCommandError {
        code: "SOLID_VOXEL_INTERNAL",
        category: "internal",
        retryable: true,
        message: Some(format!("native release settle task failed: {error}")),
    })?
    .map_err(SolidVoxelCommandError::from)?;
    Ok(ReleaseSolidVoxelJobResponse {
        job_id,
        fully_released,
    })
}

#[tauri::command]
pub fn get_solid_voxel_preview(
    manager: State<'_, SolidVoxelManager>,
    handle: ResultHandle,
    max_points: usize,
) -> Result<SolidVoxelLimitedPreview, SolidVoxelCommandError> {
    limited_preview_for_handle(&manager, handle, max_points).map_err(Into::into)
}

#[tauri::command]
pub fn pull_solid_voxel_chunks(
    manager: State<'_, SolidVoxelManager>,
    handle: ResultHandle,
    cursor: Option<String>,
    max_bytes: usize,
) -> Result<Response, SolidVoxelCommandError> {
    let batch = manager
        .pull_result_batch(handle, cursor.as_deref(), max_bytes)
        .map_err(SolidVoxelCommandError::from)?;
    Ok(Response::new(batch.bytes))
}

#[tauri::command]
pub async fn write_solid_voxel_litematic(
    manager: State<'_, SolidVoxelManager>,
    request: WriteSolidVoxelLitematicRequest,
) -> Result<WriteSolidVoxelLitematicResponse, SolidVoxelCommandError> {
    validate_litematic_safety(&request.safety, &request.output_path)?;
    let region_max_size = request.region_max_size.into_axes();
    if region_max_size.contains(&0) {
        return Err(litematic_validation_error(
            "regionMaxSize values must be positive",
        ));
    }
    let (result, lease) = manager
        .begin_litematic_write(request.handle)
        .map_err(SolidVoxelCommandError::from)?;
    validate_result_placement(&result, &request.safety)?;
    let output_path = PathBuf::from(&request.output_path);
    let options = LitematicOptions {
        name: request.name,
        author: request.author.unwrap_or_else(|| "MELY".to_owned()),
        description: request
            .description
            .unwrap_or_else(|| "MELY | Minecraft 1.20.1".to_owned()),
        software: "MELY".to_owned(),
        target_minecraft_version: request.safety.target_minecraft_version,
        serializer_minecraft_version: request.safety.serializer_minecraft_version,
        compatibility_level: "exact".to_owned(),
        compatibility_warning: String::new(),
        timestamp_millis: 0,
        region_max_size,
    };
    let result_for_write = result.clone();
    let overwrite_existing = request.overwrite_existing;
    let output_path_for_response = request.output_path;
    let summary = tauri::async_runtime::spawn_blocking(move || {
        // lease 必须与 blocking writer 同寿命；invoke future 被丢弃也不得
        // 让 manager 提前删除仍在写盘的任务。
        write_solid_litematic_atomic_with_control(
            &result_for_write,
            &output_path,
            &options,
            lease.cancellation(),
            overwrite_existing,
        )
    })
    .await
    .map_err(|error| SolidVoxelCommandError {
        code: "SOLID_VOXEL_LITEMATIC_WRITE_FAILED",
        category: "internal",
        retryable: true,
        message: Some(format!("native Litematic writer task failed: {error}")),
    })?
    .map_err(litematic_write_error)?;

    Ok(WriteSolidVoxelLitematicResponse {
        output_path: output_path_for_response,
        byte_length: summary.compressed_bytes,
        block_count: summary.block_count,
        region_count: summary.region_count,
        palette_size: summary.palette_size,
        dimensions: summary.dimensions,
        data_version: summary.data_version,
    })
}

fn parse_job_id(value: &str) -> Result<u64, SolidVoxelCommandError> {
    if value.is_empty()
        || value.starts_with('0')
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(ManagerError::InvalidJobId.into());
    }
    value
        .parse::<u64>()
        .ok()
        .filter(|job_id| *job_id > 0)
        .ok_or_else(|| ManagerError::InvalidJobId.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn safety(
        height_mode: &str,
        target_height: u32,
        min_y: i32,
        dimension_height: u32,
        placement_bottom_y: i32,
    ) -> NativeLitematicSafety {
        NativeLitematicSafety {
            height_mode: height_mode.to_owned(),
            target_height,
            target_dimension: NativeLitematicTargetDimension {
                min_y,
                height: dimension_height,
            },
            placement_bottom_y,
            target_minecraft_version: "1.20.1".to_owned(),
            serializer_minecraft_version: "1.20.1".to_owned(),
            data_version: LITEMATIC_DATA_VERSION,
            format_version: LITEMATIC_FORMAT_VERSION,
            sub_version: LITEMATIC_SUB_VERSION,
        }
    }

    #[test]
    fn normal_height_can_fit_inside_the_default_world_dimension() {
        assert!(validate_litematic_safety(
            &safety("default", 320, -64, 384, -64),
            "C:\\exports\\normal.litematic",
        )
        .is_ok());
    }

    #[test]
    fn height_mode_must_be_one_of_the_registered_values() {
        let error = validate_litematic_safety(
            &safety("experimental_8192", 320, -64, 384, -64),
            "C:\\exports\\unknown-mode.litematic",
        )
        .unwrap_err();

        assert_eq!(error.code, "SOLID_VOXEL_INVALID_REQUEST");
        assert_eq!(error.category, "validation");
        assert!(error
            .message
            .as_deref()
            .is_some_and(|message| message.contains("heightMode must be")));
    }

    #[test]
    fn default_mode_keeps_the_registered_world_contract() {
        for invalid in [
            safety("default", 385, -64, 384, -64),
            safety("default", 320, 0, 384, 0),
            safety("default", 320, -64, 383, -64),
        ] {
            assert!(
                validate_litematic_safety(&invalid, "C:\\exports\\invalid-default.litematic",)
                    .is_err()
            );
        }
    }

    #[test]
    fn extended_mode_accepts_declared_dimensions_without_resource_caps() {
        assert!(validate_litematic_safety(
            &safety("extended_2032", 2_032, -1_024, 2_032, -1_024),
            "C:\\exports\\extended.litematic",
        )
        .is_ok());
        assert!(validate_litematic_safety(
            &safety("extended_2032", 1_024, -512, 1_024, -512),
            "C:\\exports\\declared-extended.litematic",
        )
        .is_ok());

        for invalid in [
            safety("extended_2032", 2_033, -1_024, 2_033, -1_024),
            safety("extended_2032", 2_032, -1_024, 2_033, -1_024),
        ] {
            assert!(
                validate_litematic_safety(&invalid, "C:\\exports\\invalid-extended.litematic",)
                    .is_err()
            );
        }
    }

    #[test]
    fn experimental_4064_keeps_its_exact_contract() {
        assert!(validate_litematic_safety(
            &safety("experimental_4064", 4_064, -2_032, 4_064, -2_032),
            "C:\\exports\\4064.litematic",
        )
        .is_ok());

        for invalid in [
            safety("experimental_4064", 4_064, -2_031, 4_064, -2_031),
            safety("experimental_4064", 4_064, -2_032, 4_063, -2_032),
            safety("experimental_4064", 4_064, -2_032, 4_064, -2_031),
        ] {
            assert!(
                validate_litematic_safety(&invalid, "C:\\exports\\invalid-4064.litematic",)
                    .is_err()
            );
        }
    }

    #[test]
    fn target_height_4064_cannot_be_relabelled_as_a_lower_mode() {
        for height_mode in ["default", "extended_2032"] {
            let error = validate_litematic_safety(
                &safety(height_mode, 4_064, -2_032, 4_064, -2_032),
                "C:\\exports\\relabelled-4064.litematic",
            )
            .unwrap_err();

            assert_eq!(error.code, "SOLID_VOXEL_INVALID_REQUEST");
        }
    }
}
