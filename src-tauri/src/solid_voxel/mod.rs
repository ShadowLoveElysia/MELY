//! 桌面端实体体素化的 Rust 参考内核。
//!
//! 当前阶段包含输入合同、几何/材质参考语义、32³ chunk 并行子集，
//! 以及原生 Litematic 流式编码基础。完整任务接线仍由 manager 负责。

pub mod chunk;
pub mod contract;
pub mod geometry;
#[cfg(test)]
mod job;
pub mod litematic;
pub mod manager;
pub mod palette;
pub mod parallel;
pub mod preview;
pub mod result_batch;
pub mod snapshot;
pub mod texture;
pub mod voxelize;
