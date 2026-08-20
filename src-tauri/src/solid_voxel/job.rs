//! 原生实体体素任务的执行骨架。
//!
//! 该模块只管理任务生命周期、协作取消、单调进度和任务私有 Rayon
//! 线程池。具体体素算法会通过 `execute_in_private_pool` 注入，不在此处
//! 伪造已完成的计算结果。

use std::{
    any::Any,
    fmt,
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
};

use rayon::ThreadPoolBuilder;

/// 由上层任务管理器分配的唯一标识。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct SolidVoxelJobId(pub u64);

/// 任务启动时冻结的调度信息。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct JobDescriptor {
    pub id: SolidVoxelJobId,
    pub worker_threads: usize,
}

impl JobDescriptor {
    pub fn new(id: SolidVoxelJobId, worker_threads: usize) -> Result<Self, InvalidThreadCount> {
        if worker_threads == 0 {
            return Err(InvalidThreadCount);
        }

        Ok(Self { id, worker_threads })
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum JobLifecycleState {
    #[default]
    Idle,
    Running(JobDescriptor),
    CancellationRequested(JobDescriptor),
}

impl JobLifecycleState {
    pub fn active_job(self) -> Option<JobDescriptor> {
        match self {
            Self::Idle => None,
            Self::Running(job) | Self::CancellationRequested(job) => Some(job),
        }
    }
}

/// 不执行 IO 或加锁的单任务状态机，便于独立验证所有转移。
#[derive(Debug, Default)]
pub struct SingleJobLifecycle {
    state: JobLifecycleState,
}

impl SingleJobLifecycle {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn state(&self) -> JobLifecycleState {
        self.state
    }

    pub fn start(&mut self, job: JobDescriptor) -> Result<(), JobTransitionError> {
        if let Some(active) = self.state.active_job() {
            return Err(JobTransitionError::Busy { active });
        }

        self.state = JobLifecycleState::Running(job);
        Ok(())
    }

    /// 返回 `true` 表示本次调用首次将任务转为取消中。
    pub fn request_cancellation(
        &mut self,
        job_id: SolidVoxelJobId,
    ) -> Result<bool, JobTransitionError> {
        match self.state {
            JobLifecycleState::Idle => Err(JobTransitionError::NoActiveJob),
            JobLifecycleState::Running(active) => {
                ensure_same_job(active, job_id)?;
                self.state = JobLifecycleState::CancellationRequested(active);
                Ok(true)
            }
            JobLifecycleState::CancellationRequested(active) => {
                ensure_same_job(active, job_id)?;
                Ok(false)
            }
        }
    }

    /// 只有当执行线程真正退出后才能调用，避免新旧线程池重叠。
    pub fn finish(&mut self, job_id: SolidVoxelJobId) -> Result<JobDescriptor, JobTransitionError> {
        let active = self
            .state
            .active_job()
            .ok_or(JobTransitionError::NoActiveJob)?;
        ensure_same_job(active, job_id)?;

        self.state = JobLifecycleState::Idle;
        Ok(active)
    }
}

fn ensure_same_job(
    active: JobDescriptor,
    requested: SolidVoxelJobId,
) -> Result<(), JobTransitionError> {
    if active.id == requested {
        Ok(())
    } else {
        Err(JobTransitionError::JobMismatch {
            active: active.id,
            requested,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobTransitionError {
    Busy {
        active: JobDescriptor,
    },
    NoActiveJob,
    JobMismatch {
        active: SolidVoxelJobId,
        requested: SolidVoxelJobId,
    },
}

impl fmt::Display for JobTransitionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Busy { active } => {
                write!(formatter, "solid voxel job {} is still active", active.id.0)
            }
            Self::NoActiveJob => formatter.write_str("no solid voxel job is active"),
            Self::JobMismatch { active, requested } => write!(
                formatter,
                "solid voxel job {} is active, but job {} was requested",
                active.0, requested.0
            ),
        }
    }
}

impl std::error::Error for JobTransitionError {}

#[derive(Clone, Debug, Default)]
pub struct CancellationToken {
    cancelled: Arc<AtomicBool>,
}

impl CancellationToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    /// 热循环应定期调用此检查；仅取消前端 Future 不会终止 Rayon。
    pub fn checkpoint(&self) -> Result<(), JobCancelled> {
        if self.is_cancelled() {
            Err(JobCancelled)
        } else {
            Ok(())
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct JobCancelled;

impl fmt::Display for JobCancelled {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("solid voxel job was cancelled")
    }
}

impl std::error::Error for JobCancelled {}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ProgressSnapshot {
    pub completed_units: u64,
    pub total_units: u64,
}

impl ProgressSnapshot {
    pub fn fraction(self) -> Option<f64> {
        (self.total_units > 0)
            .then(|| self.completed_units.min(self.total_units) as f64 / self.total_units as f64)
    }
}

#[derive(Debug)]
struct ProgressInner {
    completed_units: AtomicU64,
    total_units: u64,
}

/// 多线程可共享的单调进度计数器。事件限频由上层 Tauri 转发器处理。
#[derive(Clone, Debug)]
pub struct ProgressTracker {
    inner: Arc<ProgressInner>,
}

impl ProgressTracker {
    pub fn new(total_units: u64) -> Self {
        Self {
            inner: Arc::new(ProgressInner {
                completed_units: AtomicU64::new(0),
                total_units,
            }),
        }
    }

    pub fn snapshot(&self) -> ProgressSnapshot {
        ProgressSnapshot {
            completed_units: self.inner.completed_units.load(Ordering::Acquire),
            total_units: self.inner.total_units,
        }
    }

    /// 已知总量时会裁剪到总量；总量为零表示未知，不做上界裁剪。
    pub fn report_completed(&self, completed_units: u64) -> ProgressSnapshot {
        let desired = self.clamp_to_total(completed_units);
        update_atomic_max(&self.inner.completed_units, desired);
        self.snapshot()
    }

    pub fn advance(&self, additional_units: u64) -> ProgressSnapshot {
        let mut current = self.inner.completed_units.load(Ordering::Acquire);

        loop {
            let desired = self.clamp_to_total(current.saturating_add(additional_units));
            match self.inner.completed_units.compare_exchange_weak(
                current,
                desired,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return self.snapshot(),
                Err(observed) => current = observed,
            }
        }
    }

    fn clamp_to_total(&self, completed_units: u64) -> u64 {
        if self.inner.total_units == 0 {
            completed_units
        } else {
            completed_units.min(self.inner.total_units)
        }
    }
}

fn update_atomic_max(target: &AtomicU64, desired: u64) {
    let mut current = target.load(Ordering::Acquire);
    while desired > current {
        match target.compare_exchange_weak(current, desired, Ordering::AcqRel, Ordering::Acquire) {
            Ok(_) => break,
            Err(observed) => current = observed,
        }
    }
}

#[derive(Clone, Debug)]
pub struct JobExecutionContext {
    pub cancellation: CancellationToken,
    pub progress: ProgressTracker,
}

impl JobExecutionContext {
    pub fn new(cancellation: CancellationToken, progress: ProgressTracker) -> Self {
        Self {
            cancellation,
            progress,
        }
    }

    pub fn checkpoint(&self) -> Result<(), JobCancelled> {
        self.cancellation.checkpoint()
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum JobTaskError<E> {
    Cancelled,
    Failed(E),
}

impl<E> From<JobCancelled> for JobTaskError<E> {
    fn from(_: JobCancelled) -> Self {
        Self::Cancelled
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InvalidThreadCount;

impl fmt::Display for InvalidThreadCount {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("worker thread count must be greater than zero")
    }
}

impl std::error::Error for InvalidThreadCount {}

#[derive(Debug, PartialEq, Eq)]
pub enum JobExecutionError<E> {
    InvalidThreadCount,
    ThreadPoolBuild(String),
    Cancelled,
    Task(E),
    Panicked(String),
}

impl<E: fmt::Display> fmt::Display for JobExecutionError<E> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidThreadCount => InvalidThreadCount.fmt(formatter),
            Self::ThreadPoolBuild(message) => {
                write!(
                    formatter,
                    "failed to build private Rayon thread pool: {message}"
                )
            }
            Self::Cancelled => formatter.write_str("solid voxel job was cancelled"),
            Self::Task(error) => write!(formatter, "solid voxel job failed: {error}"),
            Self::Panicked(message) => write!(formatter, "solid voxel job panicked: {message}"),
        }
    }
}

impl<E> std::error::Error for JobExecutionError<E> where E: std::error::Error + 'static {}

/// 为单次任务创建专属线程池，使 UI 选定的线程数只在下一任务启动时冻结。
///
/// 调用者应在 blocking 协调线程中调用本函数。函数会捕获体素任务中传播的
/// panic，并在返回前销毁私有线程池。
pub fn execute_in_private_pool<T, E, Operation>(
    worker_threads: usize,
    context: JobExecutionContext,
    operation: Operation,
) -> Result<T, JobExecutionError<E>>
where
    T: Send,
    E: Send,
    Operation: FnOnce(&JobExecutionContext) -> Result<T, JobTaskError<E>> + Send,
{
    if worker_threads == 0 {
        return Err(JobExecutionError::InvalidThreadCount);
    }

    let pool = ThreadPoolBuilder::new()
        .num_threads(worker_threads)
        .thread_name(|index| format!("mely-solid-voxel-{index}"))
        .build()
        .map_err(|error| JobExecutionError::ThreadPoolBuild(error.to_string()))?;

    let outcome = catch_unwind(AssertUnwindSafe(|| {
        pool.install(|| {
            context.checkpoint().map_err(JobTaskError::from)?;
            let result = operation(&context)?;
            context.checkpoint().map_err(JobTaskError::from)?;
            Ok(result)
        })
    }));

    match outcome {
        Ok(Ok(result)) => Ok(result),
        Ok(Err(JobTaskError::Cancelled)) => Err(JobExecutionError::Cancelled),
        Ok(Err(JobTaskError::Failed(error))) => Err(JobExecutionError::Task(error)),
        Err(payload) => Err(JobExecutionError::Panicked(panic_payload_message(payload))),
    }
}

fn panic_payload_message(payload: Box<dyn Any + Send>) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        (*message).to_owned()
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else {
        "non-string panic payload".to_owned()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;

    fn descriptor(id: u64, worker_threads: usize) -> JobDescriptor {
        JobDescriptor::new(SolidVoxelJobId(id), worker_threads).unwrap()
    }

    fn context(total_units: u64) -> JobExecutionContext {
        JobExecutionContext::new(CancellationToken::new(), ProgressTracker::new(total_units))
    }

    #[test]
    fn lifecycle_never_allows_two_active_jobs() {
        let mut lifecycle = SingleJobLifecycle::new();
        let first = descriptor(1, 4);
        let second = descriptor(2, 2);

        lifecycle.start(first).unwrap();

        assert_eq!(
            lifecycle.start(second),
            Err(JobTransitionError::Busy { active: first })
        );
        assert_eq!(lifecycle.state(), JobLifecycleState::Running(first));
    }

    #[test]
    fn lifecycle_waits_for_cancelled_job_to_finish_before_becoming_idle() {
        let mut lifecycle = SingleJobLifecycle::new();
        let job = descriptor(7, 8);
        lifecycle.start(job).unwrap();

        assert_eq!(
            lifecycle.request_cancellation(job.id),
            Ok(true),
            "the first request must transition to cancellation requested"
        );
        assert_eq!(lifecycle.request_cancellation(job.id), Ok(false));
        assert_eq!(
            lifecycle.state(),
            JobLifecycleState::CancellationRequested(job)
        );

        assert_eq!(lifecycle.finish(job.id), Ok(job));
        assert_eq!(lifecycle.state(), JobLifecycleState::Idle);
    }

    #[test]
    fn lifecycle_rejects_transitions_for_a_stale_job_id() {
        let mut lifecycle = SingleJobLifecycle::new();
        let active = descriptor(11, 3);
        let stale = SolidVoxelJobId(10);
        lifecycle.start(active).unwrap();

        let mismatch = JobTransitionError::JobMismatch {
            active: active.id,
            requested: stale,
        };
        assert_eq!(lifecycle.request_cancellation(stale), Err(mismatch));
        assert_eq!(lifecycle.finish(stale), Err(mismatch));
        assert_eq!(lifecycle.state(), JobLifecycleState::Running(active));
    }

    #[test]
    fn progress_is_monotonic_and_clamped_to_known_total() {
        let progress = ProgressTracker::new(100);

        assert_eq!(progress.report_completed(40).completed_units, 40);
        assert_eq!(progress.report_completed(20).completed_units, 40);
        assert_eq!(progress.advance(80).completed_units, 100);
        assert_eq!(progress.snapshot().fraction(), Some(1.0));
    }

    #[test]
    fn progress_updates_are_safe_across_threads() {
        let progress = ProgressTracker::new(8_000);
        let handles = (0..8)
            .map(|_| {
                let progress = progress.clone();
                std::thread::spawn(move || {
                    for _ in 0..1_000 {
                        progress.advance(1);
                    }
                })
            })
            .collect::<Vec<_>>();

        for handle in handles {
            handle.join().unwrap();
        }

        assert_eq!(progress.snapshot().completed_units, 8_000);
    }

    #[test]
    fn private_pool_uses_the_frozen_worker_count() {
        let actual_threads = execute_in_private_pool(3, context(1), |context| {
            context.progress.report_completed(1);
            Ok::<_, JobTaskError<()>>(rayon::current_num_threads())
        })
        .unwrap();

        assert_eq!(actual_threads, 3);
    }

    #[test]
    fn cancellation_before_execution_skips_the_operation() {
        let context = context(1);
        context.cancellation.cancel();
        let called = Arc::new(AtomicBool::new(false));
        let operation_called = called.clone();

        let result = execute_in_private_pool(2, context, move |_| {
            operation_called.store(true, Ordering::Release);
            Ok::<_, JobTaskError<()>>(())
        });

        assert_eq!(result, Err(JobExecutionError::Cancelled));
        assert!(!called.load(Ordering::Acquire));
    }

    #[test]
    fn explicit_task_error_is_preserved() {
        let result = execute_in_private_pool(2, context(1), |_| {
            Err::<(), _>(JobTaskError::Failed("invalid geometry"))
        });

        assert_eq!(result, Err(JobExecutionError::Task("invalid geometry")));
    }

    #[test]
    fn panic_is_converted_to_an_execution_error() {
        let result =
            execute_in_private_pool::<(), (), _>(2, context(1), |_| panic!("voxel worker failed"));

        assert_eq!(
            result,
            Err(JobExecutionError::Panicked(
                "voxel worker failed".to_owned()
            ))
        );
    }

    #[test]
    fn zero_worker_threads_are_rejected_without_running_the_operation() {
        let result = execute_in_private_pool(0, context(1), |_| Ok::<_, JobTaskError<()>>(()));

        assert_eq!(result, Err(JobExecutionError::InvalidThreadCount));
    }
}
