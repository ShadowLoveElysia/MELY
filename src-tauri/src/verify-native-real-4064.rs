//! 真实 PMX/VMD 原生验收的最小 Rust runner。
//!
//! Node 驱动负责生成一次跨语言 raw snapshot envelope；本程序只走正式
//! `SolidVoxelManager`、结果句柄和原生 Litematic writer，避免验收绕过产品路径。

use std::{
    env, io,
    path::PathBuf,
    thread,
    time::{Duration, Instant},
};

use mely_lib::solid_voxel::{
    contract::SolidShellOptions,
    litematic::{
        write_solid_litematic_atomic_with_control, LitematicError, LitematicFileError,
        LitematicOptions, LITEMATIC_DATA_VERSION, LITEMATIC_FORMAT_VERSION, LITEMATIC_SUB_VERSION,
    },
    manager::{
        CreateSolidVoxelJobRequest, SolidVoxelJobState, SolidVoxelManager, SolidVoxelManifest,
    },
    voxelize::SolidShellResult,
};
use serde::Serialize;

use mely_lib::system_capability::{detect_physical_cores, normalize_cpu_capabilities};

#[derive(Debug)]
struct Cli {
    snapshot: PathBuf,
    options: PathBuf,
    threads: usize,
    target_height: u32,
    output: PathBuf,
    overwrite: bool,
    smoke: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunnerOutput {
    status: &'static str,
    worker_threads: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    job_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result_handle: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    manifest: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    litematic: Option<LitematicOutput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    placement: Option<PlacementOutput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cpu_capabilities: Option<RunnerCpuCapabilities>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<RunnerError>,
    timings: RunnerTimings,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LitematicOutput {
    byte_length: u64,
    block_count: u64,
    region_count: u32,
    palette_size: u32,
    dimensions: [u32; 3],
    data_version: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlacementOutput {
    relative_min_y: i32,
    relative_max_y: i32,
    placement_bottom_y: i32,
    placed_min_y: i32,
    placed_max_y: i32,
    target_min_y: i32,
    target_max_y: i32,
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunnerTimings {
    input_read_ms: u64,
    create_upload_ms: u64,
    voxelize_ms: u64,
    validate_ms: u64,
    litematic_write_ms: u64,
    total_ms: u64,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunnerCpuCapabilities {
    physical_cores: usize,
    logical_processors: usize,
    available_parallelism: usize,
    recommended_threads: usize,
    maximum_threads: usize,
    physical_count_reliable: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunnerError {
    code: String,
    category: String,
    retryable: bool,
    message: String,
}

fn usage_error(message: impl Into<String>) -> RunnerError {
    runner_error_with_metadata("INVALID_ARGUMENT", "validation", false, message)
}

fn parse_positive(label: &str, value: Option<String>) -> Result<usize, RunnerError> {
    let value = value.ok_or_else(|| usage_error(format!("{label} requires a value")))?;
    let parsed = value
        .parse::<usize>()
        .map_err(|_| usage_error(format!("{label} must be a positive integer")))?;
    if parsed == 0 {
        return Err(usage_error(format!("{label} must be positive")));
    }
    Ok(parsed)
}

fn parse_positive_u32(label: &str, value: Option<String>) -> Result<u32, RunnerError> {
    let value = value.ok_or_else(|| usage_error(format!("{label} requires a value")))?;
    let parsed = value
        .parse::<u32>()
        .map_err(|_| usage_error(format!("{label} must be a positive u32 integer")))?;
    if parsed == 0 {
        return Err(usage_error(format!("{label} must be positive")));
    }
    Ok(parsed)
}

fn parse_cli() -> Result<Cli, RunnerError> {
    let mut snapshot = None;
    let mut options = None;
    let mut threads = None;
    let mut target_height = None;
    let mut output = None;
    let mut overwrite = false;
    let mut smoke = false;
    let mut args = env::args().skip(1);
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--snapshot" => {
                snapshot = Some(PathBuf::from(
                    args.next()
                        .ok_or_else(|| usage_error("--snapshot requires a path"))?,
                ))
            }
            "--options" => {
                options = Some(PathBuf::from(
                    args.next()
                        .ok_or_else(|| usage_error("--options requires a path"))?,
                ))
            }
            "--threads" => threads = Some(parse_positive("--threads", args.next())?),
            "--target-height" => {
                target_height = Some(parse_positive_u32("--target-height", args.next())?)
            }
            "--output" => {
                output = Some(PathBuf::from(
                    args.next()
                        .ok_or_else(|| usage_error("--output requires a path"))?,
                ))
            }
            "--overwrite" => overwrite = true,
            "--smoke" => smoke = true,
            "--json" => {}
            "--help" | "-h" => {
                println!("verify-native-real-4064 --snapshot <file> --threads <n> --target-height <n> --output <file> --json");
                std::process::exit(0);
            }
            unknown => return Err(usage_error(format!("unknown argument {unknown}"))),
        }
    }
    let snapshot = snapshot.ok_or_else(|| usage_error("--snapshot is required"))?;
    let options = options.ok_or_else(|| usage_error("--options is required"))?;
    let threads = threads.ok_or_else(|| usage_error("--threads is required"))?;
    let target_height = target_height.ok_or_else(|| usage_error("--target-height is required"))?;
    if target_height == 0 {
        return Err(usage_error("--target-height must be positive"));
    }
    let output = output.ok_or_else(|| usage_error("--output is required"))?;
    Ok(Cli {
        snapshot,
        options,
        threads,
        target_height,
        output,
        overwrite,
        smoke,
    })
}

fn litematic_options(target_height: u32) -> LitematicOptions {
    LitematicOptions {
        name: format!("MELY Native Solid {target_height}"),
        author: "MELY validation".to_owned(),
        description: format!("Native solid validation; target height {target_height}"),
        timestamp_millis: 1,
        region_max_size: [32, 32, 32],
        ..LitematicOptions::default()
    }
}

fn io_error(error: io::Error) -> RunnerError {
    runner_error_with_metadata("IO_ERROR", "io", true, error.to_string())
}

fn output_error(cli: &Cli, error: RunnerError, job_id: Option<String>) -> RunnerOutput {
    output_error_with_context(cli, error, job_id, None, RunnerTimings::default())
}

fn output_error_with_context(
    cli: &Cli,
    error: RunnerError,
    job_id: Option<String>,
    cpu_capabilities: Option<RunnerCpuCapabilities>,
    timings: RunnerTimings,
) -> RunnerOutput {
    RunnerOutput {
        status: "failed",
        worker_threads: cli.threads,
        job_id,
        result_handle: None,
        manifest: None,
        output_path: Some(cli.output.to_string_lossy().into_owned()),
        litematic: None,
        placement: None,
        cpu_capabilities,
        error: Some(error),
        timings,
    }
}

fn failure_output(
    cli: &Cli,
    error: RunnerError,
    job_id: Option<String>,
    cpu_capabilities: Option<RunnerCpuCapabilities>,
    mut timings: RunnerTimings,
    total_started: Instant,
) -> RunnerOutput {
    timings.total_ms = elapsed_millis(total_started);
    output_error_with_context(cli, error, job_id, cpu_capabilities, timings)
}

fn runner_error(code: &str, message: impl Into<String>) -> RunnerError {
    runner_error_with_metadata(code, "validation", false, message)
}

fn runner_error_with_metadata(
    code: &str,
    category: &str,
    retryable: bool,
    message: impl Into<String>,
) -> RunnerError {
    RunnerError {
        code: code.to_owned(),
        category: category.to_owned(),
        retryable,
        message: message.into(),
    }
}

fn litematic_file_error(error: LitematicFileError) -> RunnerError {
    let message = error.to_string();
    match error {
        LitematicFileError::Encode(LitematicError::Cancelled) => {
            runner_error_with_metadata("SOLID_VOXEL_CANCELLED", "cancelled", true, message)
        }
        LitematicFileError::Io(ref io_error) if io_error.kind() == io::ErrorKind::AlreadyExists => {
            runner_error_with_metadata(
                "SOLID_VOXEL_OVERWRITE_CONFIRMATION_REQUIRED",
                "validation",
                false,
                message,
            )
        }
        LitematicFileError::Encode(
            LitematicError::EmptyDocument
            | LitematicError::EmptyPalette
            | LitematicError::InvalidBounds { .. }
            | LitematicError::BoundsMismatch { .. }
            | LitematicError::BlockCountMismatch { .. }
            | LitematicError::UnknownPaletteIndex { .. }
            | LitematicError::InvalidLocalPosition { .. }
            | LitematicError::LocalPositionsNotStrictlyIncreasing { .. }
            | LitematicError::InconsistentChunkBuffers { .. }
            | LitematicError::EmptyChunk { .. },
        ) => {
            runner_error_with_metadata("SOLID_VOXEL_INVALID_REQUEST", "validation", false, message)
        }
        _ => runner_error_with_metadata(
            "SOLID_VOXEL_LITEMATIC_WRITE_FAILED",
            "internal",
            true,
            message,
        ),
    }
}

fn elapsed_millis(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

fn validate_export_contract(
    target_height: u32,
    smoke: bool,
    manifest: &SolidVoxelManifest,
    result: &SolidShellResult,
    options: &LitematicOptions,
) -> Result<PlacementOutput, RunnerError> {
    if LITEMATIC_FORMAT_VERSION != 6
        || LITEMATIC_SUB_VERSION != 1
        || LITEMATIC_DATA_VERSION != 3_465
    {
        return Err(runner_error(
            "LITEMATIC_CONTRACT_MISMATCH",
            "native validation requires Litematic v6.1 and Minecraft DataVersion 3465",
        ));
    }
    if options.target_minecraft_version != "1.20.1"
        || options.serializer_minecraft_version != "1.20.1"
    {
        return Err(runner_error(
            "MINECRAFT_VERSION_MISMATCH",
            "native validation requires target and serializer Minecraft version 1.20.1",
        ));
    }
    let (target_min_y, placement_bottom_y): (i32, i32) = match (target_height, smoke) {
        (4_064, _) => (-2_032, -2_032),
        (_, true) => (0, 0),
        _ => {
            return Err(runner_error(
                "UNSUPPORTED_HEIGHT_CONTRACT",
                "full native acceptance requires experimental_4064 targetHeight=4064",
            ))
        }
    };
    let relative_min_y = result.bounds.min[1];
    let relative_max_y = result.bounds.max[1];
    let expected_relative_max = i32::try_from(target_height)
        .ok()
        .and_then(|height| height.checked_sub(1))
        .ok_or_else(|| runner_error("HEIGHT_OVERFLOW", "target height exceeds i32 coordinates"))?;
    if manifest.dimensions[1] != u64::from(target_height)
        || relative_min_y != 0
        || relative_max_y != expected_relative_max
    {
        return Err(runner_error(
            "RELATIVE_HEIGHT_MISMATCH",
            format!(
                "native result must span relative Y=0..{expected_relative_max}; got {relative_min_y}..{relative_max_y} with dimension {}",
                manifest.dimensions[1]
            ),
        ));
    }
    let target_max_y = target_min_y
        .checked_add(expected_relative_max)
        .ok_or_else(|| runner_error("HEIGHT_OVERFLOW", "target Y range overflows i32"))?;
    let placed_min_y = placement_bottom_y
        .checked_add(relative_min_y)
        .ok_or_else(|| runner_error("HEIGHT_OVERFLOW", "placed minimum Y overflows i32"))?;
    let placed_max_y = placement_bottom_y
        .checked_add(relative_max_y)
        .ok_or_else(|| runner_error("HEIGHT_OVERFLOW", "placed maximum Y overflows i32"))?;
    if placed_min_y != target_min_y || placed_max_y != target_max_y {
        return Err(runner_error(
            "PLACEMENT_MISMATCH",
            format!(
                "placed result Y={placed_min_y}..{placed_max_y} does not fill target Y={target_min_y}..{target_max_y}"
            ),
        ));
    }
    Ok(PlacementOutput {
        relative_min_y,
        relative_max_y,
        placement_bottom_y,
        placed_min_y,
        placed_max_y,
        target_min_y,
        target_max_y,
    })
}

struct JobReleaseGuard<'a> {
    manager: &'a SolidVoxelManager,
    job_id: u64,
}

impl Drop for JobReleaseGuard<'_> {
    fn drop(&mut self) {
        let _ = self.manager.release_job(self.job_id);
    }
}

fn execute(cli: &Cli) -> Result<RunnerOutput, Box<RunnerOutput>> {
    let total_started = Instant::now();
    let input_started = Instant::now();
    let raw = std::fs::read(&cli.snapshot)
        .map_err(|error| Box::new(output_error(cli, io_error(error), None)))?;
    let options_bytes = std::fs::read(&cli.options)
        .map_err(|error| Box::new(output_error(cli, io_error(error), None)))?;
    let options: SolidShellOptions = serde_json::from_slice(&options_bytes).map_err(|error| {
        Box::new(output_error(
            cli,
            runner_error("INVALID_OPTIONS", error.to_string()),
            None,
        ))
    })?;
    let input_read_ms = elapsed_millis(input_started);
    if !cli.smoke && cli.target_height != 4_064 {
        return Err(Box::new(output_error(
            cli,
            runner_error(
                "UNSUPPORTED_HEIGHT_CONTRACT",
                "the native acceptance runner requires experimental_4064 targetHeight=4064",
            ),
            None,
        )));
    }
    if options.target_height != cli.target_height {
        return Err(Box::new(output_error(
            cli,
            runner_error(
                "HEIGHT_MISMATCH",
                format!(
                    "options target height {} does not match CLI {}",
                    options.target_height, cli.target_height
                ),
            ),
            None,
        )));
    }
    if cli.output.exists() && !cli.overwrite {
        return Err(Box::new(output_error(
            cli,
            runner_error(
                "OUTPUT_EXISTS",
                "native validation output already exists; use a new path or pass --overwrite",
            ),
            None,
        )));
    }
    let capabilities = normalize_cpu_capabilities(
        detect_physical_cores(),
        num_cpus::get(),
        std::thread::available_parallelism().ok().map(usize::from),
    );
    let maximum_threads = capabilities
        .physical_cores
        .min(capabilities.available_parallelism);
    let runner_capabilities = RunnerCpuCapabilities {
        physical_cores: capabilities.physical_cores,
        logical_processors: capabilities.logical_processors,
        available_parallelism: capabilities.available_parallelism,
        recommended_threads: capabilities.recommended_threads,
        maximum_threads,
        physical_count_reliable: capabilities.physical_count_reliable,
    };
    if cli.threads > maximum_threads {
        return Err(Box::new(output_error_with_context(
            cli,
            runner_error(
                "THREAD_COUNT_EXCEEDS_CAPABILITY",
                format!(
                    "requested {} threads exceeds detected normal maximum {maximum_threads}",
                    cli.threads
                ),
            ),
            None,
            Some(runner_capabilities),
            RunnerTimings {
                input_read_ms,
                total_ms: elapsed_millis(total_started),
                ..RunnerTimings::default()
            },
        )));
    }
    let create_started = Instant::now();
    let manager = SolidVoxelManager::new();
    let created = manager
        .create_job(CreateSolidVoxelJobRequest {
            worker_threads: cli.threads,
            options,
        })
        .map_err(|error| {
            Box::new(failure_output(
                cli,
                runner_error_with_metadata(
                    "CREATE_JOB_FAILED",
                    "internal",
                    true,
                    error.to_string(),
                ),
                None,
                Some(runner_capabilities),
                RunnerTimings {
                    input_read_ms,
                    ..RunnerTimings::default()
                },
                total_started,
            ))
        })?;
    let job_id = created.job_id.clone();
    let numeric_job_id = job_id.parse::<u64>().map_err(|_| {
        Box::new(failure_output(
            cli,
            usage_error("manager returned an invalid job id"),
            Some(job_id.clone()),
            Some(runner_capabilities),
            RunnerTimings {
                input_read_ms,
                ..RunnerTimings::default()
            },
            total_started,
        ))
    })?;
    let _release_guard = JobReleaseGuard {
        manager: &manager,
        job_id: numeric_job_id,
    };
    manager.upload_raw_snapshot(&raw).map_err(|error| {
        Box::new(failure_output(
            cli,
            runner_error_with_metadata("UPLOAD_FAILED", "validation", false, error.to_string()),
            Some(job_id.clone()),
            Some(runner_capabilities),
            RunnerTimings {
                input_read_ms,
                ..RunnerTimings::default()
            },
            total_started,
        ))
    })?;
    let create_upload_ms = elapsed_millis(create_started);
    let started = Instant::now();
    let status = loop {
        let status = manager.status(numeric_job_id).map_err(|error| {
            Box::new(failure_output(
                cli,
                runner_error_with_metadata("STATUS_FAILED", "internal", true, error.to_string()),
                Some(job_id.clone()),
                Some(runner_capabilities),
                RunnerTimings {
                    input_read_ms,
                    create_upload_ms,
                    voxelize_ms: elapsed_millis(started),
                    ..RunnerTimings::default()
                },
                total_started,
            ))
        })?;
        match status.state {
            SolidVoxelJobState::Completed => break status,
            SolidVoxelJobState::Failed | SolidVoxelJobState::Cancelled => {
                let native_error = status.error.as_ref();
                return Err(Box::new(failure_output(
                    cli,
                    runner_error_with_metadata(
                        native_error
                            .map(|error| error.code.as_str())
                            .unwrap_or("VOXELIZE_FAILED"),
                        native_error
                            .map(|error| error.category.as_str())
                            .unwrap_or("internal"),
                        native_error.map(|error| error.retryable).unwrap_or(true),
                        native_error
                            .and_then(|error| error.message.clone())
                            .unwrap_or_else(|| format!("native job ended in {:?}", status.state)),
                    ),
                    Some(job_id.clone()),
                    Some(runner_capabilities),
                    RunnerTimings {
                        input_read_ms,
                        create_upload_ms,
                        voxelize_ms: elapsed_millis(started),
                        ..RunnerTimings::default()
                    },
                    total_started,
                )));
            }
            SolidVoxelJobState::AwaitingUpload | SolidVoxelJobState::Running => {
                if started.elapsed() > Duration::from_secs(86_400) {
                    let _ = manager.cancel_job(numeric_job_id);
                    return Err(Box::new(failure_output(
                        cli,
                        runner_error_with_metadata(
                            "TIMEOUT",
                            "timeout",
                            true,
                            "native validation exceeded 24 hours",
                        ),
                        Some(job_id.clone()),
                        Some(runner_capabilities),
                        RunnerTimings {
                            input_read_ms,
                            create_upload_ms,
                            voxelize_ms: elapsed_millis(started),
                            ..RunnerTimings::default()
                        },
                        total_started,
                    )));
                }
                thread::sleep(Duration::from_millis(25));
            }
        }
    };
    let voxelize_ms = elapsed_millis(started);
    let validate_started = Instant::now();
    let handle = status.result_handle.clone().ok_or_else(|| {
        Box::new(failure_output(
            cli,
            runner_error_with_metadata(
                "MISSING_RESULT_HANDLE",
                "internal",
                true,
                "completed job did not return a result handle",
            ),
            Some(job_id.clone()),
            Some(runner_capabilities),
            RunnerTimings {
                input_read_ms,
                create_upload_ms,
                voxelize_ms,
                ..RunnerTimings::default()
            },
            total_started,
        ))
    })?;
    let (result, write_lease) = manager
        .begin_litematic_write(handle.clone())
        .map_err(|error| {
            Box::new(failure_output(
                cli,
                runner_error_with_metadata(
                    "RESULT_HANDLE_FAILED",
                    "internal",
                    true,
                    error.to_string(),
                ),
                Some(job_id.clone()),
                Some(runner_capabilities),
                RunnerTimings {
                    input_read_ms,
                    create_upload_ms,
                    voxelize_ms,
                    ..RunnerTimings::default()
                },
                total_started,
            ))
        })?;
    let manifest = status.manifest.as_ref().ok_or_else(|| {
        Box::new(failure_output(
            cli,
            runner_error(
                "MISSING_MANIFEST",
                "completed job did not return a result manifest",
            ),
            Some(job_id.clone()),
            Some(runner_capabilities),
            RunnerTimings {
                input_read_ms,
                create_upload_ms,
                voxelize_ms,
                ..RunnerTimings::default()
            },
            total_started,
        ))
    })?;
    let litematic_options = litematic_options(cli.target_height);
    let placement = validate_export_contract(
        cli.target_height,
        cli.smoke,
        manifest,
        &result,
        &litematic_options,
    )
    .map_err(|error| {
        Box::new(failure_output(
            cli,
            error,
            Some(job_id.clone()),
            Some(runner_capabilities),
            RunnerTimings {
                input_read_ms,
                create_upload_ms,
                voxelize_ms,
                validate_ms: elapsed_millis(validate_started),
                ..RunnerTimings::default()
            },
            total_started,
        ))
    })?;
    let validate_ms = elapsed_millis(validate_started);
    let write_started = Instant::now();
    let summary = write_solid_litematic_atomic_with_control(
        &result,
        &cli.output,
        &litematic_options,
        write_lease.cancellation(),
        cli.overwrite,
    )
    .map_err(|error| {
        Box::new(failure_output(
            cli,
            litematic_file_error(error),
            Some(job_id.clone()),
            Some(runner_capabilities),
            RunnerTimings {
                input_read_ms,
                create_upload_ms,
                voxelize_ms,
                validate_ms,
                litematic_write_ms: elapsed_millis(write_started),
                ..RunnerTimings::default()
            },
            total_started,
        ))
    })?;
    let litematic_write_ms = elapsed_millis(write_started);
    let output = RunnerOutput {
        status: "passed",
        worker_threads: cli.threads,
        job_id: Some(job_id.clone()),
        result_handle: Some(serde_json::to_value(handle).unwrap_or(serde_json::Value::Null)),
        manifest: Some(serde_json::to_value(status.manifest).unwrap_or(serde_json::Value::Null)),
        output_path: Some(cli.output.to_string_lossy().into_owned()),
        litematic: Some(LitematicOutput {
            byte_length: summary.compressed_bytes,
            block_count: summary.block_count,
            region_count: summary.region_count,
            palette_size: summary.palette_size,
            dimensions: summary.dimensions,
            data_version: summary.data_version,
        }),
        placement: Some(placement),
        cpu_capabilities: Some(runner_capabilities),
        error: None,
        timings: RunnerTimings {
            input_read_ms,
            create_upload_ms,
            voxelize_ms,
            validate_ms,
            litematic_write_ms,
            total_ms: elapsed_millis(total_started),
        },
    };
    Ok(output)
}

fn main() {
    let cli = match parse_cli() {
        Ok(cli) => cli,
        Err(error) => {
            let serialized = serde_json::to_string(&RunnerOutput {
                status: "failed",
                worker_threads: 0,
                job_id: None,
                result_handle: None,
                manifest: None,
                output_path: None,
                litematic: None,
                placement: None,
                cpu_capabilities: None,
                error: Some(error),
                timings: RunnerTimings::default(),
            })
            .unwrap_or_else(|_| "{\"status\":\"failed\"}".to_owned());
            eprintln!("{serialized}");
            println!("{serialized}");
            std::process::exit(1);
        }
    };
    match execute(&cli) {
        Ok(output) => println!(
            "{}",
            serde_json::to_string(&output).expect("runner output is serializable")
        ),
        Err(output) => {
            let serialized = serde_json::to_string(&output)
                .unwrap_or_else(|_| "{\"status\":\"failed\"}".to_owned());
            eprintln!("{serialized}");
            println!("{serialized}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mely_lib::solid_voxel::{
        manager::SolidVoxelBoundsDto,
        voxelize::{SolidShellBounds, SolidShellStats},
    };

    fn result(height: u64) -> (SolidVoxelManifest, SolidShellResult) {
        let maximum_y = i32::try_from(height - 1).unwrap();
        let manifest = SolidVoxelManifest {
            block_count: height,
            surface_block_count: height,
            filled_block_count: 0,
            skin_block_count: 0,
            alpha_rejected: 0,
            triangle_box_tests: 0,
            palette_size: 1,
            dimensions: [1, height, 1],
            bounds: SolidVoxelBoundsDto {
                min: [0, 0, 0],
                max: [0, maximum_y, 0],
            },
            chunk_count: 1,
        };
        let result = SolidShellResult {
            chunks: Vec::new(),
            palette: Vec::new(),
            stats: SolidShellStats {
                block_count: height,
                surface_block_count: height,
                filled_block_count: 0,
                skin_block_count: 0,
                alpha_rejected: 0,
                triangle_box_tests: 0,
                palette_size: 1,
                dimensions: [1, height, 1],
            },
            bounds: SolidShellBounds {
                min: [0, 0, 0],
                max: [0, maximum_y, 0],
            },
        };
        (manifest, result)
    }

    #[test]
    fn validates_the_exact_experimental_4064_placement() {
        let (manifest, result) = result(4_064);
        assert_eq!(
            validate_export_contract(4_064, false, &manifest, &result, &litematic_options(4_064),)
                .unwrap(),
            PlacementOutput {
                relative_min_y: 0,
                relative_max_y: 4_063,
                placement_bottom_y: -2_032,
                placed_min_y: -2_032,
                placed_max_y: 2_031,
                target_min_y: -2_032,
                target_max_y: 2_031,
            }
        );
    }

    #[test]
    fn rejects_a_declared_4064_result_that_does_not_fill_the_height() {
        let (mut manifest, result) = result(4_063);
        manifest.dimensions[1] = 4_064;
        let error =
            validate_export_contract(4_064, false, &manifest, &result, &litematic_options(4_064))
                .unwrap_err();
        assert_eq!(error.code, "RELATIVE_HEIGHT_MISMATCH");
    }
}
