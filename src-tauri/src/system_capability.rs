use serde::Serialize;

use crate::solid_voxel::snapshot::SNAPSHOT_PROTOCOL_VERSION;

const SOLID_VOXEL_JOB_API_VERSION: u8 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SolidVoxelNumericRange {
    pub minimum: u8,
    pub maximum: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportedSolidOptions {
    pub fill_modes: [&'static str; 1],
    pub face_details: [&'static str; 1],
    pub dithering: SolidVoxelNumericRange,
    pub ruin_decoration: SolidVoxelNumericRange,
    pub texture_sampling: bool,
    pub skin_protection: bool,
    pub emissive_mapping: bool,
}

/// 当前原生子集的能力形状是封闭合同。迁移新选项前，必须同时加入此合同
/// 与原生预检，确认完成后才能向 WebView 宣布支持。

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SolidVoxelJobApiCapabilities {
    pub version: u8,
    pub raw_snapshot_version: u16,
    pub native_result_handles: bool,
    pub features: [&'static str; 5],
    pub supported_solid_options: SupportedSolidOptions,
}

pub(crate) const COMPLETE_SOLID_VOXEL_JOB_API: SolidVoxelJobApiCapabilities =
    SolidVoxelJobApiCapabilities {
        version: SOLID_VOXEL_JOB_API_VERSION,
        raw_snapshot_version: SNAPSHOT_PROTOCOL_VERSION,
        native_result_handles: true,
        features: [
            "rawSnapshotUpload",
            "nativeResultHandles",
            "limitedPreview",
            "chunkBatchPull",
            "litematicWrite",
        ],
        supported_solid_options: SupportedSolidOptions {
            fill_modes: ["shell"],
            face_details: ["off"],
            dithering: SolidVoxelNumericRange {
                minimum: 0,
                maximum: 0,
            },
            ruin_decoration: SolidVoxelNumericRange {
                minimum: 0,
                maximum: 0,
            },
            texture_sampling: true,
            skin_protection: true,
            emissive_mapping: true,
        },
    };

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SolidVoxelCpuCapabilities {
    pub physical_cores: usize,
    pub logical_processors: usize,
    pub available_parallelism: usize,
    pub recommended_threads: usize,
    pub physical_count_reliable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_memory_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub available_memory_bytes: Option<u64>,
    pub job_api: SolidVoxelJobApiCapabilities,
}

/// 将平台探测结果收敛到 UI 可安全使用的范围，并在物理核心数失真时保守回退。
pub fn normalize_cpu_capabilities(
    detected_physical_cores: Option<usize>,
    detected_logical_processors: usize,
    detected_available_parallelism: Option<usize>,
) -> SolidVoxelCpuCapabilities {
    let available_hint = detected_available_parallelism.unwrap_or(0);
    let logical_processors = detected_logical_processors.max(available_hint).max(1);
    let available_parallelism = detected_available_parallelism
        .unwrap_or(logical_processors)
        .clamp(1, logical_processors);

    let detected_physical_is_valid =
        detected_physical_cores.is_some_and(|count| count > 0 && count <= logical_processors);
    let estimated_physical_cores = (logical_processors / 2).max(1);
    let physical_cores = detected_physical_cores
        .filter(|_| detected_physical_is_valid)
        .unwrap_or(estimated_physical_cores)
        .min(logical_processors)
        .max(1);
    let maximum_threads = physical_cores.min(available_parallelism);
    let recommended_threads = (physical_cores / 2).max(1).min(maximum_threads);

    SolidVoxelCpuCapabilities {
        physical_cores,
        logical_processors,
        available_parallelism,
        recommended_threads,
        physical_count_reliable: detected_physical_is_valid,
        total_memory_bytes: None,
        available_memory_bytes: None,
        job_api: COMPLETE_SOLID_VOXEL_JOB_API,
    }
}

#[cfg(target_os = "windows")]
pub fn detect_physical_cores() -> Option<usize> {
    use std::{mem, ptr};
    use windows_sys::Win32::System::SystemInformation::{
        GetLogicalProcessorInformationEx, RelationProcessorCore,
        SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX,
    };

    let mut required_bytes = 0_u32;
    unsafe {
        GetLogicalProcessorInformationEx(
            RelationProcessorCore,
            ptr::null_mut(),
            &mut required_bytes,
        );
    }

    let header_bytes = mem::size_of::<i32>() + mem::size_of::<u32>();
    if (required_bytes as usize) < header_bytes {
        return None;
    }

    // usize 缓冲区保证 WinAPI 所需的指针对齐，解析时仍按记录自带的 Size 前进。
    let word_bytes = mem::size_of::<usize>();
    let word_count = (required_bytes as usize).div_ceil(word_bytes);
    let mut buffer = vec![0_usize; word_count];
    let mut returned_bytes = required_bytes;
    let succeeded = unsafe {
        GetLogicalProcessorInformationEx(
            RelationProcessorCore,
            buffer
                .as_mut_ptr()
                .cast::<SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX>(),
            &mut returned_bytes,
        )
    };
    let returned_bytes = returned_bytes as usize;
    if succeeded == 0 || returned_bytes > buffer.len() * word_bytes {
        return None;
    }

    let bytes = buffer.as_ptr().cast::<u8>();
    let mut offset = 0_usize;
    let mut physical_cores = 0_usize;
    while offset < returned_bytes {
        if returned_bytes - offset < header_bytes {
            return None;
        }

        let relationship = unsafe { ptr::read_unaligned(bytes.add(offset).cast::<i32>()) };
        let record_bytes = unsafe {
            ptr::read_unaligned(bytes.add(offset + mem::size_of::<i32>()).cast::<u32>()) as usize
        };
        if record_bytes < header_bytes || record_bytes > returned_bytes - offset {
            return None;
        }

        if relationship == RelationProcessorCore {
            physical_cores += 1;
        }
        offset += record_bytes;
    }

    (physical_cores > 0).then_some(physical_cores)
}

#[cfg(target_os = "windows")]
fn detect_memory_bytes() -> Option<(u64, u64)> {
    use std::mem;
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};

    let mut status = MEMORYSTATUSEX {
        dwLength: mem::size_of::<MEMORYSTATUSEX>() as u32,
        ..Default::default()
    };
    let succeeded = unsafe { GlobalMemoryStatusEx(&mut status) };
    if succeeded == 0 || status.ullTotalPhys == 0 {
        return None;
    }

    Some((
        status.ullTotalPhys,
        status.ullAvailPhys.min(status.ullTotalPhys),
    ))
}

#[cfg(not(target_os = "windows"))]
pub fn detect_physical_cores() -> Option<usize> {
    // num_cpus 在部分平台失败时会返回逻辑处理器数，无法给出可靠性保证。
    None
}

#[cfg(not(target_os = "windows"))]
fn detect_memory_bytes() -> Option<(u64, u64)> {
    None
}

#[tauri::command]
pub fn solid_voxel_capabilities() -> SolidVoxelCpuCapabilities {
    let mut capabilities = normalize_cpu_capabilities(
        detect_physical_cores(),
        num_cpus::get(),
        std::thread::available_parallelism().ok().map(usize::from),
    );
    if let Some((total_memory_bytes, available_memory_bytes)) = detect_memory_bytes() {
        capabilities.total_memory_bytes = Some(total_memory_bytes);
        capabilities.available_memory_bytes = Some(available_memory_bytes);
    }
    capabilities
}

#[cfg(test)]
mod tests {
    use super::{
        normalize_cpu_capabilities, SolidVoxelCpuCapabilities, COMPLETE_SOLID_VOXEL_JOB_API,
    };

    #[test]
    fn recommends_half_of_a_reliable_physical_count() {
        assert_eq!(
            normalize_cpu_capabilities(Some(16), 32, Some(32)),
            SolidVoxelCpuCapabilities {
                physical_cores: 16,
                logical_processors: 32,
                available_parallelism: 32,
                recommended_threads: 8,
                physical_count_reliable: true,
                total_memory_bytes: None,
                available_memory_bytes: None,
                job_api: COMPLETE_SOLID_VOXEL_JOB_API,
            }
        );
    }

    #[test]
    fn limits_the_recommendation_without_hiding_machine_topology() {
        assert_eq!(
            normalize_cpu_capabilities(Some(16), 32, Some(6)),
            SolidVoxelCpuCapabilities {
                physical_cores: 16,
                logical_processors: 32,
                available_parallelism: 6,
                recommended_threads: 6,
                physical_count_reliable: true,
                total_memory_bytes: None,
                available_memory_bytes: None,
                job_api: COMPLETE_SOLID_VOXEL_JOB_API,
            }
        );
    }

    #[test]
    fn estimates_conservatively_when_physical_detection_fails() {
        assert_eq!(
            normalize_cpu_capabilities(None, 32, Some(32)),
            SolidVoxelCpuCapabilities {
                physical_cores: 16,
                logical_processors: 32,
                available_parallelism: 32,
                recommended_threads: 8,
                physical_count_reliable: false,
                total_memory_bytes: None,
                available_memory_bytes: None,
                job_api: COMPLETE_SOLID_VOXEL_JOB_API,
            }
        );
    }

    #[test]
    fn rejects_an_impossible_physical_count() {
        let capabilities = normalize_cpu_capabilities(Some(33), 32, Some(32));

        assert_eq!(capabilities.physical_cores, 16);
        assert_eq!(capabilities.recommended_threads, 8);
        assert!(!capabilities.physical_count_reliable);
    }

    #[test]
    fn uses_available_parallelism_when_logical_detection_fails() {
        let capabilities = normalize_cpu_capabilities(None, 0, Some(8));

        assert_eq!(capabilities.logical_processors, 8);
        assert_eq!(capabilities.available_parallelism, 8);
        assert_eq!(capabilities.physical_cores, 4);
        assert_eq!(capabilities.recommended_threads, 2);
        assert!(!capabilities.physical_count_reliable);
    }

    #[test]
    fn keeps_all_values_valid_on_a_single_core_process() {
        assert_eq!(
            normalize_cpu_capabilities(Some(1), 1, Some(1)),
            SolidVoxelCpuCapabilities {
                physical_cores: 1,
                logical_processors: 1,
                available_parallelism: 1,
                recommended_threads: 1,
                physical_count_reliable: true,
                total_memory_bytes: None,
                available_memory_bytes: None,
                job_api: COMPLETE_SOLID_VOXEL_JOB_API,
            }
        );
    }

    #[test]
    fn serializes_the_tauri_contract_with_camel_case_fields() {
        let serialized = serde_json::to_value(normalize_cpu_capabilities(Some(16), 32, Some(4)))
            .expect("capabilities should serialize");

        assert_eq!(serialized["physicalCores"], 16);
        assert_eq!(serialized["logicalProcessors"], 32);
        assert_eq!(serialized["availableParallelism"], 4);
        assert_eq!(serialized["recommendedThreads"], 4);
        assert_eq!(serialized["physicalCountReliable"], true);
        assert!(serialized.get("totalMemoryBytes").is_none());
        assert!(serialized.get("availableMemoryBytes").is_none());
        assert_eq!(serialized["jobApi"]["version"], 1);
        assert_eq!(serialized["jobApi"]["rawSnapshotVersion"], 1);
        assert_eq!(serialized["jobApi"]["nativeResultHandles"], true);
        assert_eq!(
            serialized["jobApi"]["features"],
            serde_json::json!([
                "rawSnapshotUpload",
                "nativeResultHandles",
                "limitedPreview",
                "chunkBatchPull",
                "litematicWrite",
            ]),
        );
        assert_eq!(
            serialized["jobApi"]["supportedSolidOptions"],
            serde_json::json!({
                "fillModes": ["shell"],
                "faceDetails": ["off"],
                "dithering": { "minimum": 0, "maximum": 0 },
                "ruinDecoration": { "minimum": 0, "maximum": 0 },
                "textureSampling": true,
                "skinProtection": true,
                "emissiveMapping": true,
            }),
        );
        assert!(!serialized["jobApi"]["features"]
            .as_array()
            .expect("features should serialize as an array")
            .iter()
            .any(|feature| feature == "fullSolidOptions"));
    }
}
