use std::{error::Error, fmt};

use serde::{Deserialize, Serialize};

use super::{
    palette::{BlockPaletteOptions, MaterialTheme, PalettePreset},
    texture::{
        MaterialTextureState, TextureError, TextureTransform, TextureView,
        THREE_CLAMP_TO_EDGE_WRAPPING,
    },
};

const MINIMUM_SOURCE_HEIGHT: f64 = 1.0e-6;

/// 解码后的网格快照。大型数组后续由二进制 IPC 填充，不应作为 JSON 数字数组传输。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SolidMeshSnapshot {
    pub positions: Vec<f32>,
    pub indices: Vec<u32>,
    #[serde(default)]
    pub triangle_materials: Vec<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uvs: Option<Vec<f32>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub face_frame: Option<SolidFaceFrameSnapshot>,
    #[serde(default)]
    pub materials: Vec<SolidMaterialSnapshot>,
    #[serde(default)]
    pub textures: Vec<SolidTextureSnapshot>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SolidFaceFrameSnapshot {
    pub origin: [f64; 3],
    pub right: [f64; 3],
    pub up: [f64; 3],
    pub forward: [f64; 3],
    pub eye_distance: f64,
    pub confidence: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SolidMaterialSnapshot {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub english_name: String,
    pub base_color: [f64; 4],
    pub texture_factor: [f64; 4],
    #[serde(default = "zero_texture_factor")]
    pub texture_additive_factor: [f64; 4],
    #[serde(default)]
    pub has_texture: bool,
    pub texture_index: i32,
    pub texture_matrix: [f64; 9],
    pub wrap_s: i32,
    pub wrap_t: i32,
    pub flip_y: bool,
    pub ambient: [f64; 3],
    #[serde(default)]
    pub emissive: bool,
}

impl SolidMaterialSnapshot {
    pub fn default_material() -> Self {
        Self {
            name: "default".to_owned(),
            english_name: "default".to_owned(),
            base_color: [0.72, 0.72, 0.72, 1.0],
            texture_factor: [1.0, 1.0, 1.0, 1.0],
            texture_additive_factor: [0.0; 4],
            has_texture: false,
            texture_index: -1,
            texture_matrix: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
            wrap_s: THREE_CLAMP_TO_EDGE_WRAPPING,
            wrap_t: THREE_CLAMP_TO_EDGE_WRAPPING,
            flip_y: false,
            ambient: [0.0; 3],
            emissive: false,
        }
    }

    pub fn texture_state(&self) -> Result<MaterialTextureState, TextureError> {
        if self.base_color.iter().any(|value| !value.is_finite())
            || self.texture_factor.iter().any(|value| !value.is_finite())
            || self
                .texture_additive_factor
                .iter()
                .any(|value| !value.is_finite())
        {
            return Err(TextureError::NonFiniteMaterialColor);
        }
        Ok(MaterialTextureState {
            base_color: self.base_color,
            texture_factor: self.texture_factor,
            texture_additive_factor: self.texture_additive_factor,
            has_texture: self.has_texture,
            texture_index: self.texture_index,
            texture_transform: TextureTransform::from_three_snapshot(
                self.texture_matrix,
                self.wrap_s,
                self.wrap_t,
                self.flip_y,
            )?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SolidTextureSnapshot {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

impl SolidTextureSnapshot {
    pub fn view(&self) -> Result<TextureView<'_>, TextureError> {
        TextureView::try_new(self.width, self.height, &self.pixels)
    }
}

const fn zero_texture_factor() -> [f64; 4] {
    [0.0; 4]
}

const fn default_emissive_mapping() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SolidShellOptions {
    pub target_height: u32,
    pub alpha_threshold: f64,
    pub thickness_compensation: f64,
    pub fill_mode: SolidFillMode,
    #[serde(default)]
    pub palette_preset: SolidPalettePreset,
    pub face_detail: SolidFaceDetail,
    #[serde(default)]
    pub material_theme: SolidMaterialTheme,
    pub dithering: f64,
    #[serde(default)]
    pub skin_protection: bool,
    #[serde(default)]
    pub skin_material_indices: Vec<u16>,
    #[serde(default = "default_emissive_mapping")]
    pub emissive_mapping: bool,
    #[serde(default)]
    pub emissive_material_indices: Vec<u16>,
    pub ruin_decoration: f64,
    #[serde(default)]
    pub exclude_gravity: bool,
    #[serde(default)]
    pub exclude_rare: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SolidFillMode {
    #[default]
    Shell,
    Filled,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SolidFaceDetail {
    #[default]
    Off,
    Balanced,
    Strong,
}

impl SolidShellOptions {
    pub fn block_palette_options(&self) -> BlockPaletteOptions {
        BlockPaletteOptions {
            theme: self.material_theme.into(),
            preset: self.palette_preset.into(),
            exclude_gravity: self.exclude_gravity,
            exclude_rare: self.exclude_rare,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SolidPalettePreset {
    Balanced,
    #[default]
    Clean,
}

impl From<SolidPalettePreset> for PalettePreset {
    fn from(value: SolidPalettePreset) -> Self {
        match value {
            SolidPalettePreset::Balanced => Self::Balanced,
            SolidPalettePreset::Clean => Self::Clean,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SolidMaterialTheme {
    #[default]
    Original,
    GreekMarble,
    Steampunk,
    AncientRuins,
}

impl From<SolidMaterialTheme> for MaterialTheme {
    fn from(value: SolidMaterialTheme) -> Self {
        match value {
            SolidMaterialTheme::Original => Self::Original,
            SolidMaterialTheme::GreekMarble => Self::GreekMarble,
            SolidMaterialTheme::Steampunk => Self::Steampunk,
            SolidMaterialTheme::AncientRuins => Self::AncientRuins,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SolidShellInput {
    pub mesh: SolidMeshSnapshot,
    pub options: SolidShellOptions,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ValidatedSolidShellInput {
    pub vertex_count: usize,
    pub triangle_count: usize,
    pub source_minimum: [f64; 3],
    pub source_maximum: [f64; 3],
    pub source_height: f64,
    pub target_span: f64,
    pub voxel_half_size: f64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InputValidationError {
    EmptyPositions,
    MisalignedPositions {
        length: usize,
    },
    NonFinitePosition {
        offset: usize,
    },
    SourceHeightTooSmall,
    EmptyIndices,
    MisalignedIndices {
        length: usize,
    },
    IndexOutOfBounds {
        triangle_index: usize,
        corner: usize,
        vertex_index: u32,
        vertex_count: usize,
    },
    InvalidTriangleMaterialCount {
        actual: usize,
        expected: usize,
    },
    InvalidUvCount {
        actual: usize,
        expected: usize,
    },
    NonFiniteUv {
        offset: usize,
    },
    MissingMaterialForTriangle {
        triangle_index: usize,
        material_index: u16,
        material_count: usize,
    },
    InvalidMaterial {
        material_index: usize,
        reason: TextureError,
    },
    NonFiniteMaterialAmbient {
        material_index: usize,
    },
    InvalidTexture {
        texture_index: usize,
        reason: TextureError,
    },
    TextureIndexOutOfBounds {
        material_index: usize,
        texture_index: i32,
        texture_count: usize,
    },
    InvalidTextureIndex {
        material_index: usize,
        texture_index: i32,
    },
    ZeroTargetHeight,
    InvalidAlphaThreshold,
    NonFiniteThicknessCompensation,
}

impl fmt::Display for InputValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyPositions => formatter.write_str("solid voxel mesh positions must not be empty"),
            Self::MisalignedPositions { length } => write!(
                formatter,
                "solid voxel position length must be divisible by 3, got {length}",
            ),
            Self::NonFinitePosition { offset } => write!(
                formatter,
                "solid voxel position at offset {offset} must be finite",
            ),
            Self::SourceHeightTooSmall => {
                formatter.write_str("solid voxel source mesh height is too small")
            }
            Self::EmptyIndices => formatter.write_str("solid voxel indices must not be empty"),
            Self::MisalignedIndices { length } => write!(
                formatter,
                "solid voxel index length must be divisible by 3, got {length}",
            ),
            Self::IndexOutOfBounds {
                triangle_index,
                corner,
                vertex_index,
                vertex_count,
            } => write!(
                formatter,
                "solid voxel triangle {triangle_index} corner {corner} references vertex {vertex_index}, but vertex count is {vertex_count}",
            ),
            Self::InvalidTriangleMaterialCount { actual, expected } => write!(
                formatter,
                "solid voxel triangle material count must be zero or {expected}, got {actual}",
            ),
            Self::InvalidUvCount { actual, expected } => write!(
                formatter,
                "solid voxel UV length must be {expected}, got {actual}",
            ),
            Self::NonFiniteUv { offset } => write!(
                formatter,
                "solid voxel UV at offset {offset} must be finite",
            ),
            Self::MissingMaterialForTriangle {
                triangle_index,
                material_index,
                material_count,
            } => write!(
                formatter,
                "solid voxel triangle {triangle_index} references material {material_index}, but material count is {material_count}",
            ),
            Self::InvalidMaterial {
                material_index,
                reason,
            } => write!(
                formatter,
                "solid voxel material {material_index} is invalid: {reason}",
            ),
            Self::NonFiniteMaterialAmbient { material_index } => write!(
                formatter,
                "solid voxel material {material_index} ambient color must be finite",
            ),
            Self::InvalidTexture {
                texture_index,
                reason,
            } => write!(
                formatter,
                "solid voxel texture {texture_index} is invalid: {reason}",
            ),
            Self::TextureIndexOutOfBounds {
                material_index,
                texture_index,
                texture_count,
            } => write!(
                formatter,
                "solid voxel material {material_index} references texture {texture_index}, but texture count is {texture_count}",
            ),
            Self::InvalidTextureIndex {
                material_index,
                texture_index,
            } => write!(
                formatter,
                "solid voxel material {material_index} has invalid texture index {texture_index}; expected -1 or a valid texture index",
            ),
            Self::ZeroTargetHeight => {
                formatter.write_str("solid voxel target height must be greater than zero")
            }
            Self::InvalidAlphaThreshold => formatter
                .write_str("solid voxel alpha threshold must be finite and between 0 and 1"),
            Self::NonFiniteThicknessCompensation => formatter
                .write_str("solid voxel thickness compensation must be finite"),
        }
    }
}

impl Error for InputValidationError {}

impl SolidShellInput {
    pub fn validate(&self) -> Result<ValidatedSolidShellInput, InputValidationError> {
        let positions = &self.mesh.positions;
        if positions.is_empty() {
            return Err(InputValidationError::EmptyPositions);
        }
        if !positions.len().is_multiple_of(3) {
            return Err(InputValidationError::MisalignedPositions {
                length: positions.len(),
            });
        }

        let mut source_minimum = [f64::INFINITY; 3];
        let mut source_maximum = [f64::NEG_INFINITY; 3];
        for (offset, value) in positions.iter().copied().enumerate() {
            if !value.is_finite() {
                return Err(InputValidationError::NonFinitePosition { offset });
            }
            let axis = offset % 3;
            let value = f64::from(value);
            source_minimum[axis] = source_minimum[axis].min(value);
            source_maximum[axis] = source_maximum[axis].max(value);
        }

        let source_height = source_maximum[1] - source_minimum[1];
        if source_height <= MINIMUM_SOURCE_HEIGHT {
            return Err(InputValidationError::SourceHeightTooSmall);
        }

        let indices = &self.mesh.indices;
        if indices.is_empty() {
            return Err(InputValidationError::EmptyIndices);
        }
        if !indices.len().is_multiple_of(3) {
            return Err(InputValidationError::MisalignedIndices {
                length: indices.len(),
            });
        }

        let vertex_count = positions.len() / 3;
        for (offset, vertex_index) in indices.iter().copied().enumerate() {
            if vertex_index as usize >= vertex_count {
                return Err(InputValidationError::IndexOutOfBounds {
                    triangle_index: offset / 3,
                    corner: offset % 3,
                    vertex_index,
                    vertex_count,
                });
            }
        }

        let triangle_count = indices.len() / 3;
        let material_count = self.mesh.triangle_materials.len();
        if material_count != 0 && material_count != triangle_count {
            return Err(InputValidationError::InvalidTriangleMaterialCount {
                actual: material_count,
                expected: triangle_count,
            });
        }

        if let Some(uvs) = &self.mesh.uvs {
            let expected = vertex_count
                .checked_mul(2)
                .expect("vertex-backed UV length must fit usize");
            if uvs.len() != expected {
                return Err(InputValidationError::InvalidUvCount {
                    actual: uvs.len(),
                    expected,
                });
            }
            for (offset, value) in uvs.iter().copied().enumerate() {
                if !value.is_finite() {
                    return Err(InputValidationError::NonFiniteUv { offset });
                }
            }
        }

        for (texture_index, texture) in self.mesh.textures.iter().enumerate() {
            texture
                .view()
                .map_err(|reason| InputValidationError::InvalidTexture {
                    texture_index,
                    reason,
                })?;
        }
        for (material_index, material) in self.mesh.materials.iter().enumerate() {
            material
                .texture_state()
                .map_err(|reason| InputValidationError::InvalidMaterial {
                    material_index,
                    reason,
                })?;
            if material.ambient.iter().any(|value| !value.is_finite()) {
                return Err(InputValidationError::NonFiniteMaterialAmbient { material_index });
            }
            if material.texture_index < -1 {
                return Err(InputValidationError::InvalidTextureIndex {
                    material_index,
                    texture_index: material.texture_index,
                });
            }
            if material.texture_index >= 0
                && usize::try_from(material.texture_index)
                    .map_or(true, |index| index >= self.mesh.textures.len())
            {
                return Err(InputValidationError::TextureIndexOutOfBounds {
                    material_index,
                    texture_index: material.texture_index,
                    texture_count: self.mesh.textures.len(),
                });
            }
        }
        if !self.mesh.materials.is_empty() {
            let material_indices: Box<dyn Iterator<Item = (usize, u16)> + '_> =
                if self.mesh.triangle_materials.is_empty() {
                    Box::new((0..triangle_count).map(|triangle_index| (triangle_index, 0)))
                } else {
                    Box::new(self.mesh.triangle_materials.iter().copied().enumerate())
                };
            for (triangle_index, material_index) in material_indices {
                if usize::from(material_index) >= self.mesh.materials.len() {
                    return Err(InputValidationError::MissingMaterialForTriangle {
                        triangle_index,
                        material_index,
                        material_count: self.mesh.materials.len(),
                    });
                }
            }
        }

        if self.options.target_height == 0 {
            return Err(InputValidationError::ZeroTargetHeight);
        }
        if !self.options.alpha_threshold.is_finite()
            || !(0.0..=1.0).contains(&self.options.alpha_threshold)
        {
            return Err(InputValidationError::InvalidAlphaThreshold);
        }
        if !self.options.thickness_compensation.is_finite() {
            return Err(InputValidationError::NonFiniteThicknessCompensation);
        }

        // 与 TypeScript 的 Math.max(1, Math.round(targetHeight) - 1) 保持一致；本合同已限定整数高度。
        let target_span = f64::from(self.options.target_height.saturating_sub(1).max(1));
        let voxel_half_size = 0.5 + self.options.thickness_compensation.max(0.0);

        Ok(ValidatedSolidShellInput {
            vertex_count,
            triangle_count,
            source_minimum,
            source_maximum,
            source_height,
            target_span,
            voxel_half_size,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_input() -> SolidShellInput {
        SolidShellInput {
            mesh: SolidMeshSnapshot {
                positions: vec![-1.0, 0.0, 0.0, 1.0, 2.0, 0.0, 0.0, 1.0, 1.0],
                indices: vec![0, 1, 2],
                triangle_materials: vec![0],
                uvs: Some(vec![0.0, 0.0, 1.0, 0.0, 0.5, 1.0]),
                face_frame: None,
                materials: vec![SolidMaterialSnapshot::default_material()],
                textures: vec![],
            },
            options: SolidShellOptions {
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
            },
        }
    }

    #[test]
    fn validates_a_4064_shell_input_without_a_height_policy_cap() {
        let validated = valid_input().validate().unwrap();

        assert_eq!(validated.vertex_count, 3);
        assert_eq!(validated.triangle_count, 1);
        assert_eq!(validated.target_span, 4_063.0);
        assert_eq!(validated.voxel_half_size, 0.58);
    }

    #[test]
    fn clamps_negative_thickness_like_the_typescript_kernel() {
        let mut input = valid_input();
        input.options.thickness_compensation = -3.0;

        assert_eq!(input.validate().unwrap().voxel_half_size, 0.5);
    }

    #[test]
    fn rejects_non_finite_vertices_before_calculating_bounds() {
        let mut input = valid_input();
        input.mesh.positions[4] = f32::NAN;

        assert_eq!(
            input.validate(),
            Err(InputValidationError::NonFinitePosition { offset: 4 }),
        );
    }

    #[test]
    fn rejects_out_of_bounds_triangle_indices_with_context() {
        let mut input = valid_input();
        input.mesh.indices[2] = 3;

        assert_eq!(
            input.validate(),
            Err(InputValidationError::IndexOutOfBounds {
                triangle_index: 0,
                corner: 2,
                vertex_index: 3,
                vertex_count: 3,
            }),
        );
    }

    #[test]
    fn accepts_an_empty_material_array_as_the_default_material_mapping() {
        let mut input = valid_input();
        input.mesh.triangle_materials.clear();

        assert!(input.validate().is_ok());
    }

    #[test]
    fn validates_texture_shape_wrap_modes_and_references() {
        let mut input = valid_input();
        input.mesh.textures.push(SolidTextureSnapshot {
            width: 1,
            height: 1,
            pixels: vec![255, 255, 255, 255],
        });
        input.mesh.materials[0].has_texture = true;
        input.mesh.materials[0].texture_index = 0;
        assert!(input.validate().is_ok());

        input.mesh.textures[0].pixels.pop();
        assert_eq!(
            input.validate(),
            Err(InputValidationError::InvalidTexture {
                texture_index: 0,
                reason: TextureError::InvalidPixelLength {
                    actual: 3,
                    expected: 4,
                },
            }),
        );
    }

    #[test]
    fn rejects_out_of_range_material_and_texture_indices() {
        let mut input = valid_input();
        input.mesh.materials[0].texture_index = 4;
        assert_eq!(
            input.validate(),
            Err(InputValidationError::TextureIndexOutOfBounds {
                material_index: 0,
                texture_index: 4,
                texture_count: 0,
            }),
        );

        let mut input = valid_input();
        input.mesh.triangle_materials[0] = 1;
        assert_eq!(
            input.validate(),
            Err(InputValidationError::MissingMaterialForTriangle {
                triangle_index: 0,
                material_index: 1,
                material_count: 1,
            }),
        );
    }

    #[test]
    fn rejects_non_finite_uv_color_and_ambient_values() {
        let mut input = valid_input();
        input.mesh.uvs.as_mut().unwrap()[1] = f32::NAN;
        assert_eq!(
            input.validate(),
            Err(InputValidationError::NonFiniteUv { offset: 1 }),
        );

        let mut input = valid_input();
        input.mesh.materials[0].base_color[2] = f64::INFINITY;
        assert_eq!(
            input.validate(),
            Err(InputValidationError::InvalidMaterial {
                material_index: 0,
                reason: TextureError::NonFiniteMaterialColor,
            }),
        );

        let mut input = valid_input();
        input.mesh.materials[0].ambient[0] = f64::NAN;
        assert_eq!(
            input.validate(),
            Err(InputValidationError::NonFiniteMaterialAmbient { material_index: 0 }),
        );
    }

    #[test]
    fn uses_camel_case_for_the_serialized_boundary() {
        let value = serde_json::to_value(valid_input()).unwrap();
        let options = value.get("options").unwrap();
        let mesh = value.get("mesh").unwrap();

        assert!(options.get("targetHeight").is_some());
        assert!(options.get("alphaThreshold").is_some());
        assert!(options.get("thicknessCompensation").is_some());
        assert_eq!(options.get("fillMode"), Some(&serde_json::json!("shell")));
        assert_eq!(options.get("faceDetail"), Some(&serde_json::json!("off")));
        assert_eq!(options.get("dithering"), Some(&serde_json::json!(0.0)));
        assert_eq!(options.get("ruinDecoration"), Some(&serde_json::json!(0.0)));
        assert_eq!(
            options.get("emissiveMapping"),
            Some(&serde_json::json!(true))
        );
        assert!(options.get("emissiveMaterialIndices").is_some());
        assert!(mesh.get("triangleMaterials").is_some());
    }

    #[test]
    fn missing_emissive_options_keep_the_frontend_default() {
        let mut value = serde_json::to_value(valid_input()).unwrap();
        let options = value
            .get_mut("options")
            .and_then(serde_json::Value::as_object_mut)
            .unwrap();
        options.remove("emissiveMapping");
        options.remove("emissiveMaterialIndices");

        let decoded: SolidShellInput = serde_json::from_value(value).unwrap();
        assert!(decoded.options.emissive_mapping);
        assert!(decoded.options.emissive_material_indices.is_empty());
    }

    #[test]
    fn rejects_unknown_native_option_fields_instead_of_silently_ignoring_them() {
        let mut value = serde_json::to_value(valid_input()).unwrap();
        value
            .get_mut("options")
            .and_then(serde_json::Value::as_object_mut)
            .expect("serialized options should be an object")
            .insert("futureOption".to_owned(), serde_json::json!(true));

        assert!(serde_json::from_value::<SolidShellInput>(value).is_err());
    }
}
