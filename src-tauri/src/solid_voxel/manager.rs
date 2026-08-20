//! 原生实体体素任务的状态、取消与结果句柄管理。
//!
//! 这一层负责严格解码 raw snapshot、驱动任务状态机并持有原生结果，
//! 不会把数千万个体素作为 JSON 返回 WebView。

use std::{
    collections::BTreeMap,
    fmt,
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Condvar, Mutex, MutexGuard,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

use super::{
    contract::{SolidMeshSnapshot, SolidShellInput, SolidShellOptions},
    litematic::LitematicCancellationToken,
    parallel::{
        validate_parallel_reference_support, validate_parallel_solid_options,
        voxelize_shell_parallel_reference_subset_with_control, ParallelReferenceCancellationToken,
        ParallelReferenceError, ParallelReferenceUnsupported,
    },
    result_batch::{
        encode_result_batch, EncodedResultBatch, ResultBatchError, ResultBatchHandle,
        ResultBatchRequest,
    },
    snapshot::decode_solid_voxel_snapshot_envelope,
    voxelize::SolidShellResult,
};

const RESULT_CURSOR_PREFIX: &str = "v1";
const RESULT_CURSOR_BYTES: usize = 79;
const RESULT_CURSOR_PLACEHOLDER: &str =
    "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
static NEXT_CURSOR_KEY_NONCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSolidVoxelJobRequest {
    pub worker_threads: usize,
    pub options: SolidShellOptions,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSolidVoxelJobResponse {
    pub job_id: String,
    pub worker_threads: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultHandle {
    pub id: String,
    pub generation: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SolidVoxelJobState {
    AwaitingUpload,
    Running,
    Completed,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SolidVoxelProgressDto {
    pub completed_units: u64,
    pub total_units: u64,
    pub fraction: Option<f64>,
}

impl SolidVoxelProgressDto {
    fn from_units(completed_units: u64, total_units: u64) -> Self {
        Self {
            completed_units,
            total_units,
            fraction: (total_units > 0)
                .then(|| completed_units.min(total_units) as f64 / total_units as f64),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SolidVoxelBoundsDto {
    pub min: [i32; 3],
    pub max: [i32; 3],
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SolidVoxelManifest {
    pub block_count: u64,
    pub surface_block_count: u64,
    pub filled_block_count: u64,
    pub skin_block_count: u64,
    pub alpha_rejected: u64,
    pub triangle_box_tests: u64,
    pub palette_size: u32,
    pub dimensions: [u64; 3],
    pub bounds: SolidVoxelBoundsDto,
    pub chunk_count: u64,
}

impl From<&SolidShellResult> for SolidVoxelManifest {
    fn from(result: &SolidShellResult) -> Self {
        Self {
            block_count: result.stats.block_count,
            surface_block_count: result.stats.surface_block_count,
            filled_block_count: result.stats.filled_block_count,
            skin_block_count: result.stats.skin_block_count,
            alpha_rejected: result.stats.alpha_rejected,
            triangle_box_tests: result.stats.triangle_box_tests,
            palette_size: result.stats.palette_size,
            dimensions: result.stats.dimensions,
            bounds: SolidVoxelBoundsDto {
                min: result.bounds.min,
                max: result.bounds.max,
            },
            chunk_count: result.chunks.len() as u64,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SolidVoxelErrorDto {
    pub code: String,
    pub category: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SolidVoxelJobStatus {
    pub job_id: String,
    pub worker_threads: usize,
    pub state: SolidVoxelJobState,
    pub progress: SolidVoxelProgressDto,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_handle: Option<ResultHandle>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest: Option<SolidVoxelManifest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<SolidVoxelErrorDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadSolidVoxelSnapshotResponse {
    pub job_id: String,
    pub state: SolidVoxelJobState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelSolidVoxelJobResponse {
    pub job_id: String,
    pub cancellation_requested: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManagerError {
    InvalidJobId,
    InvalidThreadCount,
    Busy {
        active_job_id: u64,
    },
    JobNotFound {
        job_id: u64,
    },
    JobMismatch {
        expected: u64,
        actual: u64,
    },
    InvalidState {
        job_id: u64,
        state: SolidVoxelJobState,
    },
    InvalidRawBody,
    SnapshotJobMismatch {
        expected: u64,
        actual: u64,
    },
    SnapshotValidation(String),
    Unsupported(ParallelReferenceUnsupported),
    ResultHandleNotFound,
    ResultNotReady,
    InvalidResultCursor,
    ResultBatch(ResultBatchError),
    HandleSpaceExhausted,
    Internal(String),
}

impl fmt::Display for ManagerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidJobId => formatter.write_str("solid voxel job id must be non-zero"),
            Self::InvalidThreadCount => {
                formatter.write_str("solid voxel worker thread count must be positive")
            }
            Self::Busy { active_job_id } => {
                write!(formatter, "solid voxel job {active_job_id} is still active",)
            }
            Self::JobNotFound { job_id } => {
                write!(formatter, "solid voxel job {job_id} was not found")
            }
            Self::JobMismatch { expected, actual } => write!(
                formatter,
                "solid voxel job mismatch: expected {expected}, got {actual}",
            ),
            Self::InvalidState { job_id, state } => {
                write!(formatter, "solid voxel job {job_id} is in state {state:?}")
            }
            Self::InvalidRawBody => {
                formatter.write_str("solid voxel upload requires a raw byte body")
            }
            Self::SnapshotJobMismatch { expected, actual } => write!(
                formatter,
                "raw snapshot belongs to job {actual}, but job {expected} was requested",
            ),
            Self::SnapshotValidation(message) => {
                write!(formatter, "solid voxel snapshot is invalid: {message}")
            }
            Self::Unsupported(feature) => {
                write!(
                    formatter,
                    "solid voxel options are not supported natively: {feature:?}"
                )
            }
            Self::ResultHandleNotFound => {
                formatter.write_str("solid voxel result handle was not found")
            }
            Self::ResultNotReady => formatter.write_str("solid voxel result is not ready"),
            Self::InvalidResultCursor => {
                formatter.write_str("solid voxel result cursor is invalid or stale")
            }
            Self::ResultBatch(error) => error.fmt(formatter),
            Self::HandleSpaceExhausted => {
                formatter.write_str("solid voxel result handle space is exhausted")
            }
            Self::Internal(message) => {
                write!(formatter, "solid voxel manager internal error: {message}")
            }
        }
    }
}

impl std::error::Error for ManagerError {}

impl From<ResultBatchError> for ManagerError {
    fn from(error: ResultBatchError) -> Self {
        Self::ResultBatch(error)
    }
}

#[derive(Debug)]
struct JobRecord {
    job_id: u64,
    worker_threads: usize,
    options: SolidShellOptions,
    state: SolidVoxelJobState,
    parallel_cancellation: ParallelReferenceCancellationToken,
    litematic_cancellation: Option<LitematicCancellationToken>,
    progress: Arc<ManagerProgress>,
    result_handle: Option<ResultHandle>,
    result: Option<Arc<SolidShellResult>>,
    error: Option<SolidVoxelErrorDto>,
    release_requested: bool,
}

#[derive(Debug, Default)]
struct ManagerProgress {
    completed_units: AtomicU64,
    total_units: AtomicU64,
}

impl ManagerProgress {
    fn report(&self, completed_units: u64, total_units: u64) {
        self.total_units.fetch_max(total_units, Ordering::AcqRel);
        self.completed_units
            .fetch_max(completed_units.min(total_units), Ordering::AcqRel);
    }

    fn snapshot(&self) -> SolidVoxelProgressDto {
        SolidVoxelProgressDto::from_units(
            self.completed_units.load(Ordering::Acquire),
            self.total_units.load(Ordering::Acquire),
        )
    }
}

#[derive(Debug, Default)]
struct ManagerInner {
    jobs: BTreeMap<u64, JobRecord>,
    active_job_id: Option<u64>,
    next_handle_id: u64,
    shutting_down: bool,
}

#[derive(Clone, Debug)]
pub struct SolidVoxelManager {
    inner: Arc<Mutex<ManagerInner>>,
    lifecycle_changed: Arc<Condvar>,
    next_job_id: Arc<AtomicU64>,
    cursor_signing_key: u64,
}

#[derive(Debug)]
pub struct LitematicWriteLease {
    manager: SolidVoxelManager,
    job_id: u64,
    cancellation: LitematicCancellationToken,
}

impl LitematicWriteLease {
    pub fn cancellation(&self) -> &LitematicCancellationToken {
        &self.cancellation
    }
}

impl Drop for LitematicWriteLease {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.manager.inner.lock() {
            let remove = inner.jobs.get_mut(&self.job_id).is_some_and(|record| {
                record.litematic_cancellation = None;
                record.release_requested
            });
            if remove {
                inner.jobs.remove(&self.job_id);
            }
            self.manager.lifecycle_changed.notify_all();
        }
    }
}

impl Default for SolidVoxelManager {
    fn default() -> Self {
        Self::new()
    }
}

impl SolidVoxelManager {
    pub fn new() -> Self {
        let nonce = NEXT_CURSOR_KEY_NONCE.fetch_add(1, Ordering::Relaxed);
        let time_seed = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |duration| {
                duration.as_secs() ^ u64::from(duration.subsec_nanos()).rotate_left(32)
            });
        let cursor_signing_key =
            mix_cursor_word(time_seed ^ u64::from(std::process::id()).rotate_left(17) ^ nonce);
        Self {
            inner: Arc::new(Mutex::new(ManagerInner {
                next_handle_id: 1,
                ..ManagerInner::default()
            })),
            lifecycle_changed: Arc::new(Condvar::new()),
            next_job_id: Arc::new(AtomicU64::new(1)),
            cursor_signing_key,
        }
    }

    fn lock(&self) -> Result<MutexGuard<'_, ManagerInner>, ManagerError> {
        self.inner
            .lock()
            .map_err(|_| ManagerError::Internal("manager mutex was poisoned".to_owned()))
    }

    fn allocate_job_id(&self) -> Result<u64, ManagerError> {
        let mut current = self.next_job_id.load(Ordering::Relaxed);
        loop {
            if current == 0 {
                return Err(ManagerError::InvalidJobId);
            }
            let next = current.checked_add(1).unwrap_or(0);
            match self.next_job_id.compare_exchange_weak(
                current,
                next,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => return Ok(current),
                Err(actual) => current = actual,
            }
        }
    }

    pub fn create_job(
        &self,
        request: CreateSolidVoxelJobRequest,
    ) -> Result<CreateSolidVoxelJobResponse, ManagerError> {
        if request.worker_threads == 0 {
            return Err(ManagerError::InvalidThreadCount);
        }
        validate_parallel_solid_options(&request.options).map_err(ManagerError::Unsupported)?;
        let mut inner = self.lock()?;
        if inner.shutting_down {
            return Err(ManagerError::Internal(
                "solid voxel manager is shutting down".to_owned(),
            ));
        }
        if let Some(active_job_id) = inner.active_job_id {
            return Err(ManagerError::Busy { active_job_id });
        }
        let job_id = self.allocate_job_id()?;
        inner.active_job_id = Some(job_id);
        inner.jobs.insert(
            job_id,
            JobRecord {
                job_id,
                worker_threads: request.worker_threads,
                options: request.options,
                state: SolidVoxelJobState::AwaitingUpload,
                parallel_cancellation: ParallelReferenceCancellationToken::new(),
                litematic_cancellation: None,
                progress: Arc::new(ManagerProgress::default()),
                result_handle: None,
                result: None,
                error: None,
                release_requested: false,
            },
        );
        Ok(CreateSolidVoxelJobResponse {
            job_id: job_id.to_string(),
            worker_threads: request.worker_threads,
        })
    }

    /// 严格解码 envelope 后再进入任务状态机，job id 只取自经过校验的二进制头。
    pub fn upload_raw_snapshot(
        &self,
        raw_bytes: &[u8],
    ) -> Result<UploadSolidVoxelSnapshotResponse, ManagerError> {
        let decoded = decode_solid_voxel_snapshot_envelope(raw_bytes)
            .map_err(|error| ManagerError::SnapshotValidation(error.to_string()))?;
        self.upload_decoded_snapshot(decoded.job_id, decoded.mesh)
    }

    /// 仅接受已经通过 raw envelope 解码和 job id 匹配的快照。
    pub fn upload_decoded_snapshot(
        &self,
        job_id: u64,
        mesh: SolidMeshSnapshot,
    ) -> Result<UploadSolidVoxelSnapshotResponse, ManagerError> {
        if job_id == 0 {
            return Err(ManagerError::InvalidJobId);
        }
        // 先只读取任务配置，再把 mesh 所有权交给待运行的 input。旧实现为
        // 预检 clone 整个快照；4064 大模型会因此瞬时保留两份完整几何/纹理。
        let (worker_threads, options, parallel_cancellation) = {
            let mut inner = self.lock()?;
            if inner.shutting_down {
                return Err(ManagerError::Internal(
                    "solid voxel manager is shutting down".to_owned(),
                ));
            }
            let active_job_id = inner
                .active_job_id
                .ok_or(ManagerError::JobNotFound { job_id })?;
            if active_job_id != job_id {
                return Err(ManagerError::SnapshotJobMismatch {
                    expected: active_job_id,
                    actual: job_id,
                });
            }
            let record = inner
                .jobs
                .get_mut(&job_id)
                .ok_or(ManagerError::JobNotFound { job_id })?;
            if record.state != SolidVoxelJobState::AwaitingUpload {
                return Err(ManagerError::InvalidState {
                    job_id,
                    state: record.state,
                });
            }
            (
                record.worker_threads,
                record.options.clone(),
                record.parallel_cancellation.clone(),
            )
        };

        let input = SolidShellInput { mesh, options };
        input
            .validate()
            .map_err(|error| ManagerError::SnapshotValidation(error.to_string()))?;
        validate_parallel_reference_support(&input).map_err(|error| match error {
            ParallelReferenceError::Unsupported(feature) => ManagerError::Unsupported(feature),
            other => ManagerError::SnapshotValidation(other.to_string()),
        })?;

        let progress = {
            let mut inner = self.lock()?;
            if inner.shutting_down {
                return Err(ManagerError::Internal(
                    "solid voxel manager is shutting down".to_owned(),
                ));
            }
            let active_job_id = inner
                .active_job_id
                .ok_or(ManagerError::JobNotFound { job_id })?;
            if active_job_id != job_id {
                return Err(ManagerError::SnapshotJobMismatch {
                    expected: active_job_id,
                    actual: job_id,
                });
            }
            let record = inner
                .jobs
                .get_mut(&job_id)
                .ok_or(ManagerError::JobNotFound { job_id })?;
            if record.state != SolidVoxelJobState::AwaitingUpload {
                return Err(ManagerError::InvalidState {
                    job_id,
                    state: record.state,
                });
            }
            if parallel_cancellation.is_cancelled() {
                record.state = SolidVoxelJobState::Cancelled;
                inner.active_job_id = None;
                return Err(ManagerError::InvalidState {
                    job_id,
                    state: SolidVoxelJobState::Cancelled,
                });
            }
            let progress = Arc::new(ManagerProgress::default());
            record.progress = progress.clone();
            record.state = SolidVoxelJobState::Running;
            progress
        };

        let manager = self.clone();
        tauri::async_runtime::spawn_blocking(move || {
            // 无论 panic 出现在输入准备、Rayon 建池还是 chunk 任务中，都必须
            // 经过 finish_job 释放 active slot；否则窗口会永久卡在 busy 状态。
            let execution = catch_unwind(AssertUnwindSafe(|| {
                voxelize_shell_parallel_reference_subset_with_control(
                    &input,
                    worker_threads,
                    parallel_cancellation,
                    |state| {
                        progress.report(state.completed_chunks, state.total_chunks);
                    },
                )
            }))
            .unwrap_or_else(|payload| {
                Err(ParallelReferenceError::Panicked(
                    Self::panic_payload_message(payload),
                ))
            });
            manager.finish_job(job_id, execution);
        });

        Ok(UploadSolidVoxelSnapshotResponse {
            job_id: job_id.to_string(),
            state: SolidVoxelJobState::Running,
        })
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

    fn finish_job(&self, job_id: u64, execution: Result<SolidShellResult, ParallelReferenceError>) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        let next_handle_id = inner.next_handle_id;
        let Some(record) = inner.jobs.get_mut(&job_id) else {
            return;
        };
        let mut consume_handle_id = false;
        match execution {
            Ok(result)
                if next_handle_id > 0
                    && !record.parallel_cancellation.is_cancelled()
                    && !record.release_requested =>
            {
                let handle = ResultHandle {
                    id: next_handle_id.to_string(),
                    generation: job_id.to_string(),
                };
                consume_handle_id = true;
                record.result_handle = Some(handle);
                record.result = Some(Arc::new(result));
                record.state = SolidVoxelJobState::Completed;
                record.error = None;
            }
            Ok(_) if next_handle_id == 0 => {
                record.state = SolidVoxelJobState::Failed;
                record.error = Some(SolidVoxelErrorDto {
                    code: "SOLID_VOXEL_HANDLE_SPACE_EXHAUSTED".to_owned(),
                    category: "internal".to_owned(),
                    retryable: false,
                    message: Some(ManagerError::HandleSpaceExhausted.to_string()),
                });
            }
            Ok(_)
            | Err(ParallelReferenceError::Voxelize(
                super::voxelize::SolidVoxelizeError::Cancelled,
            )) => {
                record.state = SolidVoxelJobState::Cancelled;
                record.error = Some(SolidVoxelErrorDto {
                    code: "SOLID_VOXEL_CANCELLED".to_owned(),
                    category: "cancelled".to_owned(),
                    retryable: true,
                    message: None,
                });
            }
            Err(error) => {
                record.state = SolidVoxelJobState::Failed;
                record.error = Some(SolidVoxelErrorDto {
                    code: if matches!(&error, ParallelReferenceError::Panicked(_)) {
                        "SOLID_VOXEL_PANICKED".to_owned()
                    } else {
                        "SOLID_VOXEL_FAILED".to_owned()
                    },
                    category: "internal".to_owned(),
                    retryable: true,
                    message: Some(error.to_string()),
                });
            }
        }
        let remove_record = record.release_requested;
        if consume_handle_id {
            // 0 是耗尽标记，绝不在 u64 回绕后复用旧句柄。
            inner.next_handle_id = next_handle_id.checked_add(1).unwrap_or(0);
        }
        if inner.active_job_id == Some(job_id) {
            inner.active_job_id = None;
        }
        if remove_record {
            inner.jobs.remove(&job_id);
        }
        self.lifecycle_changed.notify_all();
    }

    pub fn status(&self, job_id: u64) -> Result<SolidVoxelJobStatus, ManagerError> {
        let inner = self.lock()?;
        let record = inner
            .jobs
            .get(&job_id)
            .ok_or(ManagerError::JobNotFound { job_id })?;
        let (manifest, result_handle) = match &record.result {
            Some(result) => (
                Some(SolidVoxelManifest::from(result.as_ref())),
                record.result_handle.clone(),
            ),
            None => (None, None),
        };
        Ok(SolidVoxelJobStatus {
            job_id: record.job_id.to_string(),
            worker_threads: record.worker_threads,
            state: record.state,
            progress: record.progress.snapshot(),
            result_handle,
            manifest,
            error: record.error.clone(),
        })
    }

    pub fn cancel_job(&self, job_id: u64) -> Result<CancelSolidVoxelJobResponse, ManagerError> {
        let mut inner = self.lock()?;
        if inner.shutting_down {
            return Err(ManagerError::Internal(
                "solid voxel manager is shutting down".to_owned(),
            ));
        }
        let record = inner
            .jobs
            .get_mut(&job_id)
            .ok_or(ManagerError::JobNotFound { job_id })?;
        if let Some(cancellation) = &record.litematic_cancellation {
            let cancellation_requested = cancellation.cancel();
            return Ok(CancelSolidVoxelJobResponse {
                job_id: job_id.to_string(),
                cancellation_requested,
            });
        }
        match record.state {
            SolidVoxelJobState::AwaitingUpload | SolidVoxelJobState::Running => {
                record.parallel_cancellation.cancel();
                if record.state == SolidVoxelJobState::AwaitingUpload {
                    record.state = SolidVoxelJobState::Cancelled;
                    inner.active_job_id = None;
                }
                Ok(CancelSolidVoxelJobResponse {
                    job_id: job_id.to_string(),
                    cancellation_requested: true,
                })
            }
            state => Err(ManagerError::InvalidState { job_id, state }),
        }
    }

    pub fn release_job(&self, job_id: u64) -> Result<bool, ManagerError> {
        let mut inner = self.lock()?;
        let fully_released = Self::request_release(&mut inner, job_id)?;
        if fully_released {
            self.lifecycle_changed.notify_all();
        }
        Ok(fully_released)
    }

    /// 请求释放并在有界时间内等待计算任务或文件 writer 真正退出。
    ///
    /// 命令层必须在 blocking 线程调用；Condvar 等待期间会释放 manager 锁，
    /// 不会阻塞 `finish_job`、writer lease Drop 或窗口退出清理。
    pub fn release_job_and_wait(
        &self,
        job_id: u64,
        timeout: Duration,
    ) -> Result<bool, ManagerError> {
        let started = Instant::now();
        let mut inner = self.lock()?;
        // release 是幂等操作：第一次请求可能已在响应丢失或超时后完成。
        if !inner.jobs.contains_key(&job_id) {
            let next_job_id = self.next_job_id.load(Ordering::Acquire);
            if next_job_id == 0 || job_id < next_job_id {
                return Ok(true);
            }
            return Err(ManagerError::JobNotFound { job_id });
        }
        if Self::request_release(&mut inner, job_id)? {
            self.lifecycle_changed.notify_all();
            return Ok(true);
        }

        loop {
            if !inner.jobs.contains_key(&job_id) {
                return Ok(true);
            }
            let remaining = timeout.saturating_sub(started.elapsed());
            if remaining.is_zero() {
                return Ok(false);
            }
            let (next, wait_result) = self
                .lifecycle_changed
                .wait_timeout(inner, remaining)
                .map_err(|_| ManagerError::Internal("manager mutex was poisoned".to_owned()))?;
            inner = next;
            if wait_result.timed_out() && inner.jobs.contains_key(&job_id) {
                return Ok(false);
            }
        }
    }

    fn request_release(inner: &mut ManagerInner, job_id: u64) -> Result<bool, ManagerError> {
        let state = inner
            .jobs
            .get(&job_id)
            .ok_or(ManagerError::JobNotFound { job_id })?
            .state;
        if matches!(state, SolidVoxelJobState::Running) {
            let record = inner.jobs.get_mut(&job_id).expect("job checked above");
            record.release_requested = true;
            record.parallel_cancellation.cancel();
            return Ok(false);
        }
        if let Some(cancellation) = inner.jobs.get_mut(&job_id).and_then(|record| {
            record.release_requested = true;
            record.litematic_cancellation.as_ref()
        }) {
            cancellation.cancel();
            return Ok(false);
        }
        inner.jobs.remove(&job_id);
        if inner.active_job_id == Some(job_id) {
            inner.active_job_id = None;
        }
        Ok(true)
    }

    /// 将已完成的原生结果句柄解析为只读共享结果。
    ///
    /// 调用方必须在任务状态为 `Completed` 后使用该句柄；结果不会复制到
    /// WebView，原生 Litematic writer 可以直接消费这份共享存储。
    pub fn result_for_handle(
        &self,
        handle: ResultHandle,
    ) -> Result<Arc<SolidShellResult>, ManagerError> {
        let inner = self.lock()?;
        let result = inner
            .jobs
            .values()
            .find(|record| record.result_handle.as_ref() == Some(&handle))
            .and_then(|record| record.result.clone());
        result.ok_or(ManagerError::ResultHandleNotFound)
    }

    /// 注册一次原生写出，使 cancel/release/窗口退出能线性化地取消未提交文件。
    pub fn begin_litematic_write(
        &self,
        handle: ResultHandle,
    ) -> Result<(Arc<SolidShellResult>, LitematicWriteLease), ManagerError> {
        let mut inner = self.lock()?;
        if inner.shutting_down {
            return Err(ManagerError::Internal(
                "solid voxel manager is shutting down".to_owned(),
            ));
        }
        let record = inner
            .jobs
            .values_mut()
            .find(|record| record.result_handle.as_ref() == Some(&handle))
            .ok_or(ManagerError::ResultHandleNotFound)?;
        let result = record.result.clone().ok_or(ManagerError::ResultNotReady)?;
        if record.litematic_cancellation.is_some() {
            return Err(ManagerError::Internal(
                "a Litematic writer is already active for this result".to_owned(),
            ));
        }
        let cancellation = LitematicCancellationToken::new();
        record.litematic_cancellation = Some(cancellation.clone());
        Ok((
            result,
            LitematicWriteLease {
                manager: self.clone(),
                job_id: record.job_id,
                cancellation,
            },
        ))
    }

    /// 进程退出时禁止新任务，请求协作取消体素化，并等待文件
    /// writer 越过提交边界后再丢弃所有原生结果句柄。
    pub fn shutdown(&self) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        inner.shutting_down = true;
        for record in inner.jobs.values_mut() {
            record.parallel_cancellation.cancel();
            if let Some(cancellation) = &record.litematic_cancellation {
                cancellation.cancel();
            }
            record.release_requested = true;
        }
        inner.active_job_id = None;
        while inner
            .jobs
            .values()
            .any(|record| record.litematic_cancellation.is_some())
        {
            let Ok(next) = self.lifecycle_changed.wait(inner) else {
                return;
            };
            inner = next;
        }
        inner.jobs.clear();
    }

    /// 将已完成结果编码为有界 raw envelope。游标由 manager 签名，
    /// 绑定结果句柄和 chunk 总数，不信任 WebView 传回的分页位置。
    pub fn pull_result_batch(
        &self,
        handle: ResultHandle,
        cursor: Option<&str>,
        max_bytes: usize,
    ) -> Result<EncodedResultBatch, ManagerError> {
        let result = self.result_for_handle(handle.clone())?;
        let batch_handle = parse_result_handle(&handle)?;
        let total_chunk_count = u32::try_from(result.chunks.len())
            .map_err(|_| ManagerError::ResultBatch(ResultBatchError::ArithmeticOverflow))?;
        let start_chunk_index = match cursor {
            Some(value) => self.parse_result_cursor(value, batch_handle, total_chunk_count)?,
            None => 0,
        };

        let final_attempt = encode_result_batch(
            &result,
            ResultBatchRequest {
                handle: batch_handle,
                start_chunk_index,
                max_bytes,
                next_cursor: None,
            },
        );
        match final_attempt {
            Ok(batch) => return Ok(batch),
            Err(ResultBatchError::MissingNextCursor) => {}
            Err(error) => return Err(error.into()),
        }

        // 固定长度占位符先决定本批 chunk 数，实际签名游标长度相同，
        // 因此替换后不会改变背压边界或二进制布局。
        debug_assert_eq!(RESULT_CURSOR_PLACEHOLDER.len(), RESULT_CURSOR_BYTES);
        let planned = encode_result_batch(
            &result,
            ResultBatchRequest {
                handle: batch_handle,
                start_chunk_index,
                max_bytes,
                next_cursor: Some(RESULT_CURSOR_PLACEHOLDER),
            },
        )?;
        if planned.done || planned.chunk_count == 0 {
            return Err(ManagerError::Internal(
                "result batch cursor planning produced an invalid page".to_owned(),
            ));
        }
        let next_chunk_index = start_chunk_index
            .checked_add(u64::from(planned.chunk_count))
            .ok_or(ManagerError::ResultBatch(
                ResultBatchError::ArithmeticOverflow,
            ))?;
        let next_cursor =
            self.create_result_cursor(batch_handle, next_chunk_index, total_chunk_count);
        debug_assert_eq!(next_cursor.len(), RESULT_CURSOR_BYTES);
        encode_result_batch(
            &result,
            ResultBatchRequest {
                handle: batch_handle,
                start_chunk_index,
                max_bytes,
                next_cursor: Some(&next_cursor),
            },
        )
        .map_err(Into::into)
    }

    fn create_result_cursor(
        &self,
        handle: ResultBatchHandle,
        next_chunk_index: u64,
        total_chunk_count: u32,
    ) -> String {
        let signature = result_cursor_signature(
            self.cursor_signing_key,
            handle,
            next_chunk_index,
            total_chunk_count,
        );
        format!(
            "{RESULT_CURSOR_PREFIX}-{:016x}-{:016x}-{next_chunk_index:016x}-{total_chunk_count:08x}-{signature:016x}",
            handle.id, handle.generation,
        )
    }

    fn parse_result_cursor(
        &self,
        cursor: &str,
        expected_handle: ResultBatchHandle,
        expected_total_chunks: u32,
    ) -> Result<u64, ManagerError> {
        if cursor.len() != RESULT_CURSOR_BYTES || !cursor.is_ascii() {
            return Err(ManagerError::InvalidResultCursor);
        }
        let mut fields = cursor.split('-');
        if fields.next() != Some(RESULT_CURSOR_PREFIX) {
            return Err(ManagerError::InvalidResultCursor);
        }
        let id = parse_fixed_hex(fields.next(), 16)?;
        let generation = parse_fixed_hex(fields.next(), 16)?;
        let next_chunk_index = parse_fixed_hex(fields.next(), 16)?;
        let total_chunk_count = u32::try_from(parse_fixed_hex(fields.next(), 8)?)
            .map_err(|_| ManagerError::InvalidResultCursor)?;
        let signature = parse_fixed_hex(fields.next(), 16)?;
        if fields.next().is_some() {
            return Err(ManagerError::InvalidResultCursor);
        }
        let handle = ResultBatchHandle { id, generation };
        let expected_signature = result_cursor_signature(
            self.cursor_signing_key,
            handle,
            next_chunk_index,
            total_chunk_count,
        );
        if handle != expected_handle
            || total_chunk_count != expected_total_chunks
            || next_chunk_index == 0
            || next_chunk_index >= u64::from(total_chunk_count)
            || signature != expected_signature
        {
            return Err(ManagerError::InvalidResultCursor);
        }
        Ok(next_chunk_index)
    }
}

fn parse_result_handle(handle: &ResultHandle) -> Result<ResultBatchHandle, ManagerError> {
    fn parse(value: &str) -> Result<u64, ManagerError> {
        if value.is_empty()
            || value.starts_with('0')
            || !value.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(ManagerError::ResultHandleNotFound);
        }
        value
            .parse::<u64>()
            .ok()
            .filter(|parsed| *parsed > 0)
            .ok_or(ManagerError::ResultHandleNotFound)
    }
    Ok(ResultBatchHandle {
        id: parse(&handle.id)?,
        generation: parse(&handle.generation)?,
    })
}

fn parse_fixed_hex(value: Option<&str>, width: usize) -> Result<u64, ManagerError> {
    let value = value.ok_or(ManagerError::InvalidResultCursor)?;
    if value.len() != width
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(ManagerError::InvalidResultCursor);
    }
    u64::from_str_radix(value, 16).map_err(|_| ManagerError::InvalidResultCursor)
}

fn result_cursor_signature(
    signing_key: u64,
    handle: ResultBatchHandle,
    next_chunk_index: u64,
    total_chunk_count: u32,
) -> u64 {
    let mut value = mix_cursor_word(signing_key ^ 0x6d65_6c79_2d63_7572);
    for word in [
        handle.id,
        handle.generation,
        next_chunk_index,
        u64::from(total_chunk_count),
    ] {
        value = mix_cursor_word(value ^ word);
    }
    value
}

fn mix_cursor_word(mut value: u64) -> u64 {
    value ^= value >> 30;
    value = value.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value ^= value >> 27;
    value = value.wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::solid_voxel::{
        chunk::{ChunkCoordinate, CHUNK_VOLUME},
        contract::{SolidFaceDetail, SolidFillMode, SolidMaterialTheme, SolidPalettePreset},
        result_batch::{MAX_RESULT_BATCH_BYTES, MIN_RESULT_BATCH_BYTES, RESULT_BATCH_HEADER_SIZE},
        voxelize::{SolidShellBounds, SolidShellChunk, SolidShellPaletteEntry, SolidShellStats},
    };

    fn options() -> SolidShellOptions {
        SolidShellOptions {
            target_height: 4_064,
            alpha_threshold: 0.3,
            thickness_compensation: 0.08,
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
        }
    }

    fn mesh() -> SolidMeshSnapshot {
        SolidMeshSnapshot {
            positions: vec![-1.0, 0.0, 0.0, 1.0, 2.0, 0.0, 0.0, 1.0, 0.0],
            indices: vec![0, 1, 2],
            triangle_materials: vec![0],
            uvs: None,
            face_frame: None,
            materials: vec![],
            textures: vec![],
        }
    }

    fn completed_result(chunk_count: usize) -> SolidShellResult {
        let positions: Vec<u16> = (0..CHUNK_VOLUME).collect();
        let chunks = (0..chunk_count)
            .map(|index| SolidShellChunk {
                chunk: ChunkCoordinate::new(index as i32, 0, 0),
                positions: positions.clone(),
                block_indices: vec![0; usize::from(CHUNK_VOLUME)],
            })
            .collect::<Vec<_>>();
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
                palette_size: 1,
                dimensions: [1, 1, 1],
            },
            bounds: SolidShellBounds {
                min: [0, 0, 0],
                max: [0, 0, 0],
            },
            chunks,
            palette: vec![SolidShellPaletteEntry {
                block_id: "minecraft:stone".to_owned(),
                color: [125, 125, 125],
            }],
        }
    }

    fn manager_with_result(result: SolidShellResult) -> (SolidVoxelManager, ResultHandle) {
        let manager = SolidVoxelManager::new();
        let handle = ResultHandle {
            id: "7".to_owned(),
            generation: "1".to_owned(),
        };
        let record = JobRecord {
            job_id: 1,
            worker_threads: 1,
            options: options(),
            state: SolidVoxelJobState::Completed,
            parallel_cancellation: ParallelReferenceCancellationToken::new(),
            litematic_cancellation: None,
            progress: Arc::new(ManagerProgress::default()),
            result_handle: Some(handle.clone()),
            result: Some(Arc::new(result)),
            error: None,
            release_requested: false,
        };
        manager.inner.lock().unwrap().jobs.insert(1, record);
        manager.next_job_id.store(2, Ordering::Release);
        (manager, handle)
    }

    #[test]
    fn manager_allows_only_one_unfinished_job() {
        let manager = SolidVoxelManager::new();
        let first = manager
            .create_job(CreateSolidVoxelJobRequest {
                worker_threads: 8,
                options: options(),
            })
            .unwrap();
        let first_job_id = first.job_id.parse::<u64>().unwrap();

        assert_eq!(
            manager.create_job(CreateSolidVoxelJobRequest {
                worker_threads: 4,
                options: options(),
            }),
            Err(ManagerError::Busy {
                active_job_id: first_job_id
            })
        );
    }

    #[test]
    fn manager_rejects_unsupported_options_before_reserving_job_slot() {
        let manager = SolidVoxelManager::new();
        let mut unsupported = options();
        unsupported.fill_mode = SolidFillMode::Filled;
        assert_eq!(
            manager.create_job(CreateSolidVoxelJobRequest {
                worker_threads: 2,
                options: unsupported,
            }),
            Err(ManagerError::Unsupported(
                ParallelReferenceUnsupported::FilledMode,
            )),
        );
        assert!(manager
            .create_job(CreateSolidVoxelJobRequest {
                worker_threads: 2,
                options: options(),
            })
            .is_ok());
    }

    #[test]
    fn cancelling_before_upload_releases_the_active_slot() {
        let manager = SolidVoxelManager::new();
        let job = manager
            .create_job(CreateSolidVoxelJobRequest {
                worker_threads: 2,
                options: options(),
            })
            .unwrap();
        let job_id = job.job_id.parse::<u64>().unwrap();

        assert_eq!(
            manager.cancel_job(job_id).unwrap(),
            CancelSolidVoxelJobResponse {
                job_id: job.job_id,
                cancellation_requested: true,
            }
        );
        assert_eq!(
            manager.status(job_id).unwrap().state,
            SolidVoxelJobState::Cancelled
        );
        assert!(manager
            .create_job(CreateSolidVoxelJobRequest {
                worker_threads: 1,
                options: options(),
            })
            .is_ok());
    }

    #[test]
    fn malformed_raw_upload_is_rejected_before_starting_the_task() {
        let manager = SolidVoxelManager::new();
        let _job = manager
            .create_job(CreateSolidVoxelJobRequest {
                worker_threads: 2,
                options: options(),
            })
            .unwrap();

        assert!(matches!(
            manager.upload_raw_snapshot(&[0, 1, 2]),
            Err(ManagerError::SnapshotValidation(_))
        ));
    }

    #[test]
    fn decoded_snapshot_is_the_only_path_that_can_start_a_task() {
        let manager = SolidVoxelManager::new();
        let job = manager
            .create_job(CreateSolidVoxelJobRequest {
                worker_threads: 1,
                options: options(),
            })
            .unwrap();
        let job_id = job.job_id.parse::<u64>().unwrap();

        let response = manager.upload_decoded_snapshot(job_id, mesh()).unwrap();
        assert_eq!(response.state, SolidVoxelJobState::Running);
        assert_eq!(manager.status(job_id).unwrap().worker_threads, 1);
    }

    #[test]
    fn validation_failure_keeps_job_awaiting_upload_and_allows_retry() {
        let manager = SolidVoxelManager::new();
        let job = manager
            .create_job(CreateSolidVoxelJobRequest {
                worker_threads: 1,
                options: options(),
            })
            .unwrap();
        let job_id = job.job_id.parse::<u64>().unwrap();
        let mut invalid = mesh();
        invalid.positions[0] = f32::NAN;

        assert!(matches!(
            manager.upload_decoded_snapshot(job_id, invalid),
            Err(ManagerError::SnapshotValidation(_))
        ));
        assert_eq!(
            manager.status(job_id).unwrap().state,
            SolidVoxelJobState::AwaitingUpload
        );
        assert!(manager
            .create_job(CreateSolidVoxelJobRequest {
                worker_threads: 1,
                options: options(),
            })
            .is_err());
    }

    #[test]
    fn result_batches_embed_a_signed_cursor_and_resume_without_overlap() {
        let (manager, handle) = manager_with_result(completed_result(80));
        let first = manager
            .pull_result_batch(handle.clone(), None, MIN_RESULT_BATCH_BYTES)
            .unwrap();
        assert!(!first.done);
        assert!(first.bytes.len() <= MIN_RESULT_BATCH_BYTES);
        assert_eq!(first.start_chunk_index, 0);

        let cursor_length =
            u32::from_le_bytes(first.bytes[64..68].try_into().expect("cursor length field"))
                as usize;
        let cursor = std::str::from_utf8(
            &first.bytes[RESULT_BATCH_HEADER_SIZE..RESULT_BATCH_HEADER_SIZE + cursor_length],
        )
        .unwrap();
        let second = manager
            .pull_result_batch(handle, Some(cursor), MAX_RESULT_BATCH_BYTES)
            .unwrap();

        assert_eq!(second.start_chunk_index, u64::from(first.chunk_count),);
        assert!(second.done);
    }

    #[test]
    fn result_cursor_rejects_tampering_and_cross_manager_reuse() {
        let (manager, handle) = manager_with_result(completed_result(80));
        let first = manager
            .pull_result_batch(handle.clone(), None, MIN_RESULT_BATCH_BYTES)
            .unwrap();
        let cursor_length = u32::from_le_bytes(first.bytes[64..68].try_into().unwrap()) as usize;
        let cursor = std::str::from_utf8(
            &first.bytes[RESULT_BATCH_HEADER_SIZE..RESULT_BATCH_HEADER_SIZE + cursor_length],
        )
        .unwrap();
        let mut tampered = cursor.as_bytes().to_vec();
        let last = tampered.len() - 1;
        tampered[last] = if tampered[last] == b'a' { b'b' } else { b'a' };
        let tampered = std::str::from_utf8(&tampered).unwrap();

        assert_eq!(
            manager.pull_result_batch(handle.clone(), Some(tampered), MIN_RESULT_BATCH_BYTES,),
            Err(ManagerError::InvalidResultCursor),
        );

        let (other_manager, other_handle) = manager_with_result(completed_result(80));
        assert_eq!(
            other_manager.pull_result_batch(other_handle, Some(cursor), MIN_RESULT_BATCH_BYTES,),
            Err(ManagerError::InvalidResultCursor),
        );
    }

    #[test]
    fn litematic_write_lease_is_cancelled_and_removed_on_release() {
        let (manager, handle) = manager_with_result(completed_result(1));
        let (_result, lease) = manager.begin_litematic_write(handle).unwrap();

        assert!(!manager.release_job(1).unwrap());
        assert!(lease.cancellation().is_cancelled());
        drop(lease);
        assert!(matches!(
            manager.status(1),
            Err(ManagerError::JobNotFound { job_id: 1 })
        ));
    }

    #[test]
    fn release_wait_reports_timeout_then_succeeds_after_writer_settles() {
        let (manager, handle) = manager_with_result(completed_result(1));
        let (_result, lease) = manager.begin_litematic_write(handle).unwrap();

        assert!(!manager
            .release_job_and_wait(1, Duration::from_millis(1))
            .unwrap());
        assert!(lease.cancellation().is_cancelled());
        drop(lease);
        assert!(manager
            .release_job_and_wait(1, Duration::from_millis(1))
            .unwrap());
    }

    #[test]
    fn release_wait_is_idempotent_for_an_already_released_job() {
        let (manager, _handle) = manager_with_result(completed_result(1));

        assert!(manager
            .release_job_and_wait(1, Duration::from_millis(1))
            .unwrap());
        assert!(manager
            .release_job_and_wait(1, Duration::from_millis(1))
            .unwrap());
    }

    #[test]
    fn release_wait_does_not_treat_an_unknown_job_as_already_released() {
        let manager = SolidVoxelManager::new();

        assert_eq!(
            manager.release_job_and_wait(99, Duration::from_millis(1)),
            Err(ManagerError::JobNotFound { job_id: 99 }),
        );
    }

    #[test]
    fn release_wait_settles_a_running_job_before_the_next_create() {
        let manager = SolidVoxelManager::new();
        let created = manager
            .create_job(CreateSolidVoxelJobRequest {
                worker_threads: 1,
                options: options(),
            })
            .unwrap();
        let job_id = created.job_id.parse::<u64>().unwrap();
        {
            let mut inner = manager.inner.lock().unwrap();
            inner.jobs.get_mut(&job_id).unwrap().state = SolidVoxelJobState::Running;
        }
        let finishing_manager = manager.clone();
        let finishing_thread = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(5));
            finishing_manager.finish_job(
                job_id,
                Err(ParallelReferenceError::Voxelize(
                    super::super::voxelize::SolidVoxelizeError::Cancelled,
                )),
            );
        });

        assert!(manager
            .release_job_and_wait(job_id, Duration::from_secs(1))
            .unwrap());
        finishing_thread.join().unwrap();
        assert!(manager
            .create_job(CreateSolidVoxelJobRequest {
                worker_threads: 1,
                options: options(),
            })
            .is_ok());
    }

    #[test]
    fn shutdown_waits_for_the_file_writer_lease_before_clearing_handles() {
        let (manager, handle) = manager_with_result(completed_result(1));
        let (_result, lease) = manager.begin_litematic_write(handle).unwrap();
        let cancellation = lease.cancellation().clone();
        let shutdown_manager = manager.clone();
        let (completed_tx, completed_rx) = std::sync::mpsc::channel();
        let shutdown_thread = std::thread::spawn(move || {
            shutdown_manager.shutdown();
            completed_tx.send(()).unwrap();
        });

        for _ in 0..100 {
            if cancellation.is_cancelled() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        assert!(cancellation.is_cancelled());
        assert!(completed_rx.try_recv().is_err());

        drop(lease);
        completed_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        shutdown_thread.join().unwrap();
        assert!(matches!(
            manager.status(1),
            Err(ManagerError::JobNotFound { job_id: 1 })
        ));
        assert!(matches!(
            manager.create_job(CreateSolidVoxelJobRequest {
                worker_threads: 1,
                options: options(),
            }),
            Err(ManagerError::Internal(_))
        ));
    }

    #[test]
    fn handle_generation_is_bound_to_job_and_id_space_never_wraps() {
        let manager = SolidVoxelManager::new();
        let cancellation = ParallelReferenceCancellationToken::new();
        let progress = Arc::new(ManagerProgress::default());
        {
            let mut inner = manager.inner.lock().unwrap();
            inner.next_handle_id = u64::MAX;
            inner.jobs.insert(
                41,
                JobRecord {
                    job_id: 41,
                    worker_threads: 1,
                    options: options(),
                    state: SolidVoxelJobState::Running,
                    parallel_cancellation: cancellation.clone(),
                    litematic_cancellation: None,
                    progress,
                    result_handle: None,
                    result: None,
                    error: None,
                    release_requested: false,
                },
            );
            inner.active_job_id = Some(41);
        }
        manager.finish_job(41, Ok(completed_result(1)));
        let status = manager.status(41).unwrap();
        assert_eq!(
            status.result_handle,
            Some(ResultHandle {
                id: u64::MAX.to_string(),
                generation: "41".to_owned(),
            })
        );
        assert_eq!(manager.inner.lock().unwrap().next_handle_id, 0);

        let second_progress = Arc::new(ManagerProgress::default());
        {
            let mut inner = manager.inner.lock().unwrap();
            inner.jobs.insert(
                42,
                JobRecord {
                    job_id: 42,
                    worker_threads: 1,
                    options: options(),
                    state: SolidVoxelJobState::Running,
                    parallel_cancellation: ParallelReferenceCancellationToken::new(),
                    litematic_cancellation: None,
                    progress: second_progress,
                    result_handle: None,
                    result: None,
                    error: None,
                    release_requested: false,
                },
            );
            inner.active_job_id = Some(42);
        }
        manager.finish_job(42, Ok(completed_result(1)));
        let status = manager.status(42).unwrap();
        assert_eq!(status.state, SolidVoxelJobState::Failed);
        assert_eq!(
            status.error.unwrap().code,
            "SOLID_VOXEL_HANDLE_SPACE_EXHAUSTED"
        );
    }
}
