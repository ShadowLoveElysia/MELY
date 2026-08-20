use std::{cmp::Ordering, error::Error, fmt};

use serde::{Deserialize, Serialize};

pub const CHUNK_SIZE: i32 = 32;
pub const CHUNK_VOLUME: u16 = 32 * 32 * 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ChunkCoordinate(pub [i32; 3]);

impl ChunkCoordinate {
    pub const fn new(x: i32, y: i32, z: i32) -> Self {
        Self([x, y, z])
    }

    pub const fn x(self) -> i32 {
        self.0[0]
    }

    pub const fn y(self) -> i32 {
        self.0[1]
    }

    pub const fn z(self) -> i32 {
        self.0[2]
    }
}

// ProjectionDocument 的规范顺序为 Y、Z、X，不是数组的默认 X、Y、Z 顺序。
impl Ord for ChunkCoordinate {
    fn cmp(&self, other: &Self) -> Ordering {
        self.y()
            .cmp(&other.y())
            .then_with(|| self.z().cmp(&other.z()))
            .then_with(|| self.x().cmp(&other.x()))
    }
}

impl PartialOrd for ChunkCoordinate {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct VoxelAddress {
    pub chunk: ChunkCoordinate,
    pub local_index: u16,
}

impl VoxelAddress {
    pub fn from_world(position: [i32; 3]) -> Self {
        let (chunk_x, local_x) = split_axis(position[0]);
        let (chunk_y, local_y) = split_axis(position[1]);
        let (chunk_z, local_z) = split_axis(position[2]);
        Self {
            chunk: ChunkCoordinate::new(chunk_x, chunk_y, chunk_z),
            local_index: encode_local_position([local_x, local_y, local_z])
                .expect("split coordinates are always inside a chunk"),
        }
    }

    pub fn to_world(self) -> Result<[i32; 3], ChunkLayoutError> {
        let [local_x, local_y, local_z] = decode_local_position(self.local_index)?;
        Ok([
            checked_world_axis(self.chunk.x(), local_x)?,
            checked_world_axis(self.chunk.y(), local_y)?,
            checked_world_axis(self.chunk.z(), local_z)?,
        ])
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CandidateWinnerKey {
    feature_priority: u8,
    distance_sq: f64,
    triangle_index: u32,
    material_index: u32,
    vertex_indices: [u32; 3],
}

impl CandidateWinnerKey {
    pub fn new(
        feature_priority: u8,
        distance_sq: f64,
        triangle_index: u32,
        material_index: u32,
        vertex_indices: [u32; 3],
    ) -> Result<Self, WinnerKeyError> {
        if !distance_sq.is_finite() || distance_sq < 0.0 {
            return Err(WinnerKeyError::InvalidDistanceSquared);
        }
        Ok(Self {
            feature_priority,
            // JavaScript 的数值比较将 -0 与 +0 视为相等，因此进入全序前统一零值。
            distance_sq: if distance_sq == 0.0 { 0.0 } else { distance_sq },
            triangle_index,
            material_index,
            vertex_indices,
        })
    }

    pub const fn feature_priority(self) -> u8 {
        self.feature_priority
    }

    pub const fn distance_sq(self) -> f64 {
        self.distance_sq
    }

    pub const fn triangle_index(self) -> u32 {
        self.triangle_index
    }

    pub fn wins_over(self, other: Self) -> bool {
        self > other
    }
}

impl Eq for CandidateWinnerKey {}

impl Ord for CandidateWinnerKey {
    fn cmp(&self, other: &Self) -> Ordering {
        self.feature_priority
            .cmp(&other.feature_priority)
            // 距离、三角形和稳定兜底索引越小，候选者的优先级越高。
            .then_with(|| other.distance_sq.total_cmp(&self.distance_sq))
            .then_with(|| other.triangle_index.cmp(&self.triangle_index))
            .then_with(|| other.material_index.cmp(&self.material_index))
            .then_with(|| other.vertex_indices.cmp(&self.vertex_indices))
    }
}

impl PartialOrd for CandidateWinnerKey {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WinnerKeyError {
    InvalidDistanceSquared,
}

impl fmt::Display for WinnerKeyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("voxel candidate distance squared must be finite and non-negative")
    }
}

impl Error for WinnerKeyError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChunkLayoutError {
    LocalCoordinateOutOfRange {
        axis: usize,
        value: u8,
    },
    LocalIndexOutOfRange {
        value: u16,
    },
    LocalPositionsNotStrictlyIncreasing {
        index: usize,
        previous: u16,
        current: u16,
    },
    WorldCoordinateOverflow,
}

impl fmt::Display for ChunkLayoutError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::LocalCoordinateOutOfRange { axis, value } => write!(
                formatter,
                "chunk local coordinate axis {axis} must be below 32, got {value}",
            ),
            Self::LocalIndexOutOfRange { value } => {
                write!(formatter, "chunk local index must be below 32768, got {value}")
            }
            Self::LocalPositionsNotStrictlyIncreasing {
                index,
                previous,
                current,
            } => write!(
                formatter,
                "chunk positions must be strictly increasing at index {index}: {previous}, {current}",
            ),
            Self::WorldCoordinateOverflow => {
                formatter.write_str("chunk coordinate cannot be represented as an i32 world position")
            }
        }
    }
}

impl Error for ChunkLayoutError {}

pub fn split_axis(value: i32) -> (i32, u8) {
    (
        value.div_euclid(CHUNK_SIZE),
        value.rem_euclid(CHUNK_SIZE) as u8,
    )
}

pub fn encode_local_position(local: [u8; 3]) -> Result<u16, ChunkLayoutError> {
    for (axis, value) in local.iter().copied().enumerate() {
        if i32::from(value) >= CHUNK_SIZE {
            return Err(ChunkLayoutError::LocalCoordinateOutOfRange { axis, value });
        }
    }
    let [x, y, z] = local;
    Ok(u16::from(x) + 32 * (u16::from(z) + 32 * u16::from(y)))
}

pub fn decode_local_position(local_index: u16) -> Result<[u8; 3], ChunkLayoutError> {
    if local_index >= CHUNK_VOLUME {
        return Err(ChunkLayoutError::LocalIndexOutOfRange { value: local_index });
    }
    let x = local_index % 32;
    let yz = local_index / 32;
    let z = yz % 32;
    let y = yz / 32;
    Ok([x as u8, y as u8, z as u8])
}

pub fn validate_local_position_order(positions: &[u16]) -> Result<(), ChunkLayoutError> {
    for (index, pair) in positions.windows(2).enumerate() {
        if pair[0] >= pair[1] {
            return Err(ChunkLayoutError::LocalPositionsNotStrictlyIncreasing {
                index: index + 1,
                previous: pair[0],
                current: pair[1],
            });
        }
    }
    if let Some(value) = positions.last().copied() {
        if value >= CHUNK_VOLUME {
            return Err(ChunkLayoutError::LocalIndexOutOfRange { value });
        }
    }
    Ok(())
}

fn checked_world_axis(chunk: i32, local: u8) -> Result<i32, ChunkLayoutError> {
    chunk
        .checked_mul(CHUNK_SIZE)
        .and_then(|base| base.checked_add(i32::from(local)))
        .ok_or(ChunkLayoutError::WorldCoordinateOverflow)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_negative_coordinates_with_floor_division() {
        assert_eq!(split_axis(-1), (-1, 31));
        assert_eq!(split_axis(-32), (-1, 0));
        assert_eq!(split_axis(-33), (-2, 31));
        assert_eq!(split_axis(32), (1, 0));
    }

    #[test]
    fn local_index_matches_the_typescript_yzx_layout() {
        assert_eq!(encode_local_position([1, 2, 3]).unwrap(), 2_145);
        assert_eq!(decode_local_position(2_145).unwrap(), [1, 2, 3]);
        assert_eq!(encode_local_position([31, 31, 31]).unwrap(), 32_767);
    }

    #[test]
    fn voxel_addresses_round_trip_across_negative_chunk_edges() {
        for position in [[-33, -32, -1], [-1, 0, 31], [32, 63, 64]] {
            let address = VoxelAddress::from_world(position);
            assert_eq!(address.to_world().unwrap(), position);
        }
    }

    #[test]
    fn sorts_chunks_by_y_then_z_then_x() {
        let mut chunks = [
            ChunkCoordinate::new(-2, 1, 0),
            ChunkCoordinate::new(5, 0, 2),
            ChunkCoordinate::new(3, 0, -1),
            ChunkCoordinate::new(-4, 0, -1),
        ];
        chunks.sort();

        assert_eq!(
            chunks,
            [
                ChunkCoordinate::new(-4, 0, -1),
                ChunkCoordinate::new(3, 0, -1),
                ChunkCoordinate::new(5, 0, 2),
                ChunkCoordinate::new(-2, 1, 0),
            ],
        );
    }

    #[test]
    fn rejects_duplicate_or_unsorted_local_positions() {
        assert!(validate_local_position_order(&[0, 1, 32_767]).is_ok());
        assert_eq!(
            validate_local_position_order(&[0, 2, 2]),
            Err(ChunkLayoutError::LocalPositionsNotStrictlyIncreasing {
                index: 2,
                previous: 2,
                current: 2,
            }),
        );
    }

    #[test]
    fn stable_winner_order_is_independent_of_arrival_order() {
        let base = CandidateWinnerKey::new(0, 0.25, 9, 3, [8, 9, 10]).unwrap();
        let feature = CandidateWinnerKey::new(1, 5.0, 20, 4, [20, 21, 22]).unwrap();
        let closer = CandidateWinnerKey::new(0, 0.125, 12, 4, [12, 13, 14]).unwrap();
        let earlier = CandidateWinnerKey::new(0, 0.25, 2, 7, [2, 3, 4]).unwrap();

        assert!(feature.wins_over(base));
        assert!(closer.wins_over(base));
        assert!(earlier.wins_over(base));
        assert_eq!(std::cmp::max(base, earlier), earlier);
    }

    #[test]
    fn winner_key_treats_signed_zero_like_javascript_comparisons() {
        let negative_zero = CandidateWinnerKey::new(0, -0.0, 1, 0, [0, 1, 2]).unwrap();
        let positive_zero = CandidateWinnerKey::new(0, 0.0, 1, 0, [0, 1, 2]).unwrap();

        assert_eq!(negative_zero, positive_zero);
        assert_eq!(negative_zero.cmp(&positive_zero), Ordering::Equal);
    }
}
