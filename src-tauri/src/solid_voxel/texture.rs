use std::{error::Error, fmt};

pub const THREE_REPEAT_WRAPPING: i32 = 1_000;
pub const THREE_CLAMP_TO_EDGE_WRAPPING: i32 = 1_001;
pub const THREE_MIRRORED_REPEAT_WRAPPING: i32 = 1_002;

pub type Uv = [f64; 2];
pub type LinearRgba = [f64; 4];
pub type Rgb8 = [u8; 3];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WrapMode {
    Repeat,
    ClampToEdge,
    MirroredRepeat,
}

impl WrapMode {
    /// 快照中的原始数值对应 Three.js 公开常量。
    pub fn from_three_constant(value: i32) -> Result<Self, TextureError> {
        match value {
            THREE_REPEAT_WRAPPING => Ok(Self::Repeat),
            THREE_CLAMP_TO_EDGE_WRAPPING => Ok(Self::ClampToEdge),
            THREE_MIRRORED_REPEAT_WRAPPING => Ok(Self::MirroredRepeat),
            _ => Err(TextureError::UnsupportedWrapMode(value)),
        }
    }

    pub const fn three_constant(self) -> i32 {
        match self {
            Self::Repeat => THREE_REPEAT_WRAPPING,
            Self::ClampToEdge => THREE_CLAMP_TO_EDGE_WRAPPING,
            Self::MirroredRepeat => THREE_MIRRORED_REPEAT_WRAPPING,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TextureTransform {
    pub matrix: [f64; 9],
    pub wrap_s: WrapMode,
    pub wrap_t: WrapMode,
    pub flip_y: bool,
}

impl TextureTransform {
    pub const fn identity() -> Self {
        Self {
            matrix: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
            wrap_s: WrapMode::ClampToEdge,
            wrap_t: WrapMode::ClampToEdge,
            flip_y: false,
        }
    }

    pub fn from_three_snapshot(
        matrix: [f64; 9],
        wrap_s: i32,
        wrap_t: i32,
        flip_y: bool,
    ) -> Result<Self, TextureError> {
        if matrix.iter().any(|value| !value.is_finite()) {
            return Err(TextureError::NonFiniteTransform);
        }
        Ok(Self {
            matrix,
            wrap_s: WrapMode::from_three_constant(wrap_s)?,
            wrap_t: WrapMode::from_three_constant(wrap_t)?,
            flip_y,
        })
    }

    pub fn apply(self, uv: Uv) -> Result<Uv, TextureError> {
        if uv.iter().any(|value| !value.is_finite())
            || self.matrix.iter().any(|value| !value.is_finite())
        {
            return Err(TextureError::NonFiniteUv);
        }

        // Three.js Matrix3 为列主序，这里保留现有 TS 的索引顺序。
        let mut u = self.matrix[0] * uv[0] + self.matrix[3] * uv[1] + self.matrix[6];
        let mut v = self.matrix[1] * uv[0] + self.matrix[4] * uv[1] + self.matrix[7];
        u = wrap_coordinate(u, self.wrap_s);
        v = wrap_coordinate(v, self.wrap_t);
        if self.flip_y {
            v = 1.0 - v;
        }
        Ok([u, v])
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TextureView<'a> {
    width: usize,
    height: usize,
    pixels: &'a [u8],
}

impl<'a> TextureView<'a> {
    pub fn try_new(width: u32, height: u32, pixels: &'a [u8]) -> Result<Self, TextureError> {
        if width == 0 || height == 0 {
            return Err(TextureError::ZeroDimension);
        }
        let width = usize::try_from(width).map_err(|_| TextureError::DimensionOverflow)?;
        let height = usize::try_from(height).map_err(|_| TextureError::DimensionOverflow)?;
        let expected = width
            .checked_mul(height)
            .and_then(|area| area.checked_mul(4))
            .ok_or(TextureError::DimensionOverflow)?;
        if pixels.len() != expected {
            return Err(TextureError::InvalidPixelLength {
                actual: pixels.len(),
                expected,
            });
        }
        Ok(Self {
            width,
            height,
            pixels,
        })
    }

    pub const fn width(self) -> usize {
        self.width
    }

    pub const fn height(self) -> usize {
        self.height
    }

    pub fn sample_bilinear_linear(self, uv: Uv) -> Result<LinearRgba, TextureError> {
        if uv.iter().any(|value| !value.is_finite()) {
            return Err(TextureError::NonFiniteUv);
        }
        if uv.iter().any(|value| !(0.0..=1.0).contains(value)) {
            return Err(TextureError::UvOutsideNormalizedRange);
        }

        let x = uv[0] * self.width.saturating_sub(1) as f64;
        let y = uv[1] * self.height.saturating_sub(1) as f64;
        let x0 = x.floor() as usize;
        let y0 = y.floor() as usize;
        let x1 = (x0 + 1).min(self.width - 1);
        let y1 = (y0 + 1).min(self.height - 1);
        let tx = x - x0 as f64;
        let ty = y - y0 as f64;
        let top_left = self.pixel(x0, y0);
        let top_right = self.pixel(x1, y0);
        let bottom_left = self.pixel(x0, y1);
        let bottom_right = self.pixel(x1, y1);

        Ok(std::array::from_fn(|channel| {
            let decode = |value| {
                if channel == 3 {
                    byte_to_normalized(value)
                } else {
                    srgb_byte_to_linear(value)
                }
            };
            let top = decode(top_left[channel]) * (1.0 - tx) + decode(top_right[channel]) * tx;
            let bottom =
                decode(bottom_left[channel]) * (1.0 - tx) + decode(bottom_right[channel]) * tx;
            top * (1.0 - ty) + bottom * ty
        }))
    }

    fn pixel(self, x: usize, y: usize) -> [u8; 4] {
        let clamped_x = x.min(self.width - 1);
        let clamped_y = y.min(self.height - 1);
        let offset = (clamped_y * self.width + clamped_x) * 4;
        self.pixels[offset..offset + 4]
            .try_into()
            .expect("validated RGBA texture offsets are four-byte aligned")
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MaterialTextureState {
    pub base_color: [f64; 4],
    pub texture_factor: [f64; 4],
    pub texture_additive_factor: [f64; 4],
    pub has_texture: bool,
    pub texture_index: i32,
    pub texture_transform: TextureTransform,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MaterialSample {
    pub rgb: Rgb8,
    pub alpha: f64,
}

impl MaterialTextureState {
    pub fn sample(
        self,
        textures: &[TextureView<'_>],
        uv: Uv,
    ) -> Result<MaterialSample, MaterialSampleError> {
        if self.base_color.iter().any(|value| !value.is_finite())
            || self.texture_factor.iter().any(|value| !value.is_finite())
            || self
                .texture_additive_factor
                .iter()
                .any(|value| !value.is_finite())
        {
            return Err(MaterialSampleError::NonFiniteMaterialColor);
        }

        let texture = usize::try_from(self.texture_index)
            .ok()
            .and_then(|index| textures.get(index))
            .copied();
        let Some(texture) = texture else {
            if self.has_texture || self.texture_index >= 0 {
                return Err(MaterialSampleError::MissingTextureCapture {
                    texture_index: self.texture_index,
                });
            }
            return Ok(MaterialSample {
                rgb: [
                    normalized_to_byte(self.base_color[0]),
                    normalized_to_byte(self.base_color[1]),
                    normalized_to_byte(self.base_color[2]),
                ],
                alpha: self.base_color[3],
            });
        };

        let transformed_uv = self.texture_transform.apply(uv)?;
        let sampled = texture.sample_bilinear_linear(transformed_uv)?;
        Ok(MaterialSample {
            rgb: apply_mmd_texture_color_linear(
                [self.base_color[0], self.base_color[1], self.base_color[2]],
                [sampled[0], sampled[1], sampled[2]],
                self.texture_factor,
                self.texture_additive_factor,
            ),
            // 当前 TS 合同中，MMD 纹理 morph Alpha 只参与 RGB 合成。
            alpha: self.base_color[3] * sampled[3],
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextureError {
    ZeroDimension,
    DimensionOverflow,
    InvalidPixelLength { actual: usize, expected: usize },
    UnsupportedWrapMode(i32),
    NonFiniteTransform,
    NonFiniteMaterialColor,
    NonFiniteUv,
    UvOutsideNormalizedRange,
}

impl fmt::Display for TextureError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ZeroDimension => formatter.write_str("texture dimensions must be positive"),
            Self::DimensionOverflow => {
                formatter.write_str("texture dimensions exceed addressable memory")
            }
            Self::InvalidPixelLength { actual, expected } => write!(
                formatter,
                "RGBA texture length must be {expected} bytes, got {actual}",
            ),
            Self::UnsupportedWrapMode(mode) => {
                write!(formatter, "unsupported Three.js texture wrap mode {mode}")
            }
            Self::NonFiniteTransform => {
                formatter.write_str("texture transform values must be finite")
            }
            Self::NonFiniteMaterialColor => {
                formatter.write_str("material colors and texture factors must be finite")
            }
            Self::NonFiniteUv => formatter.write_str("texture UV values must be finite"),
            Self::UvOutsideNormalizedRange => {
                formatter.write_str("transformed texture UV must be between zero and one")
            }
        }
    }
}

impl Error for TextureError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MaterialSampleError {
    MissingTextureCapture { texture_index: i32 },
    NonFiniteMaterialColor,
    Texture(TextureError),
}

impl fmt::Display for MaterialSampleError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingTextureCapture { texture_index } => write!(
                formatter,
                "declared material texture {texture_index} has no captured pixels",
            ),
            Self::NonFiniteMaterialColor => {
                formatter.write_str("material color and texture factors must be finite")
            }
            Self::Texture(error) => error.fmt(formatter),
        }
    }
}

impl Error for MaterialSampleError {}

impl From<TextureError> for MaterialSampleError {
    fn from(error: TextureError) -> Self {
        Self::Texture(error)
    }
}

pub fn wrap_coordinate(value: f64, mode: WrapMode) -> f64 {
    match mode {
        WrapMode::Repeat => value - value.floor(),
        WrapMode::MirroredRepeat => {
            let floor = value.floor();
            let fraction = value - floor;
            if floor.rem_euclid(2.0) == 1.0 {
                1.0 - fraction
            } else {
                fraction
            }
        }
        WrapMode::ClampToEdge => value.clamp(0.0, 1.0),
    }
}

pub fn srgb_to_linear(value: f64) -> f64 {
    if value <= 0.04045 {
        value / 12.92
    } else {
        ((value + 0.055) / 1.055).powf(2.4)
    }
}

pub fn linear_to_srgb(value: f64) -> f64 {
    if value <= 0.003_130_8 {
        value * 12.92
    } else {
        1.055 * value.powf(1.0 / 2.4) - 0.055
    }
}

pub fn srgb_byte_to_linear(value: u8) -> f64 {
    // TypeScript 先构造 Float32Array 查找表，取值后再提升为 Number。
    (srgb_to_linear(f64::from(value) / 255.0) as f32) as f64
}

pub fn apply_mmd_texture_color(
    base_color: [f64; 3],
    texel_srgb: [f64; 3],
    multiplicative: [f64; 4],
    additive: [f64; 4],
) -> Rgb8 {
    apply_mmd_texture_color_linear(
        base_color,
        texel_srgb.map(srgb_to_linear),
        multiplicative,
        additive,
    )
}

pub fn apply_mmd_texture_color_linear(
    base_color: [f64; 3],
    texel_linear: [f64; 3],
    multiplicative: [f64; 4],
    additive: [f64; 4],
) -> Rgb8 {
    std::array::from_fn(|channel| {
        let texture_mul = 1.0 - multiplicative[3]
            + texel_linear[channel] * multiplicative[channel] * multiplicative[3];
        let texture_color =
            (texture_mul + (texture_mul - 1.0) * additive[3]).clamp(0.0, 1.0) + additive[channel];
        linear_to_srgb_byte(srgb_to_linear(base_color[channel]) * texture_color)
    })
}

/// TypeScript 仅在 `alpha < threshold` 时拒绝，相等边界必须保留。
pub fn alpha_passes_threshold(alpha: f64, threshold: f64) -> bool {
    alpha >= threshold
}

fn clamp01(value: f64) -> f64 {
    value.clamp(0.0, 1.0)
}

fn normalized_to_byte(value: f64) -> u8 {
    (clamp01(value) * 255.0).round() as u8
}

fn linear_to_srgb_byte(value: f64) -> u8 {
    normalized_to_byte(linear_to_srgb(clamp01(value)))
}

fn byte_to_normalized(value: u8) -> f64 {
    f64::from(value) / 255.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn material(texture_index: i32) -> MaterialTextureState {
        MaterialTextureState {
            base_color: [1.0, 1.0, 1.0, 1.0],
            texture_factor: [1.0, 1.0, 1.0, 1.0],
            texture_additive_factor: [0.0; 4],
            has_texture: texture_index >= 0,
            texture_index,
            texture_transform: TextureTransform::identity(),
        }
    }

    fn assert_close(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() < 1.0e-12,
            "{actual} != {expected}",
        );
    }

    #[test]
    fn three_wrap_constants_are_explicit_and_round_trip() {
        for (constant, expected) in [
            (THREE_REPEAT_WRAPPING, WrapMode::Repeat),
            (THREE_CLAMP_TO_EDGE_WRAPPING, WrapMode::ClampToEdge),
            (THREE_MIRRORED_REPEAT_WRAPPING, WrapMode::MirroredRepeat),
        ] {
            let mode = WrapMode::from_three_constant(constant).unwrap();
            assert_eq!(mode, expected);
            assert_eq!(mode.three_constant(), constant);
        }
        assert_eq!(
            WrapMode::from_three_constant(999),
            Err(TextureError::UnsupportedWrapMode(999)),
        );
    }

    #[test]
    fn repeat_mirror_and_clamp_match_negative_three_uv_semantics() {
        assert_close(wrap_coordinate(-0.25, WrapMode::Repeat), 0.75);
        assert_close(wrap_coordinate(-0.25, WrapMode::MirroredRepeat), 0.25);
        assert_close(wrap_coordinate(-1.25, WrapMode::MirroredRepeat), 0.75);
        assert_close(wrap_coordinate(-0.25, WrapMode::ClampToEdge), 0.0);
        assert_close(wrap_coordinate(1.25, WrapMode::ClampToEdge), 1.0);
    }

    #[test]
    fn transform_uses_three_matrix_order_then_wraps_and_flips() {
        let transform = TextureTransform::from_three_snapshot(
            [2.0, 0.0, 0.0, 0.0, 0.5, 0.0, -0.25, 0.125, 1.0],
            THREE_REPEAT_WRAPPING,
            THREE_CLAMP_TO_EDGE_WRAPPING,
            true,
        )
        .unwrap();

        assert_eq!(transform.apply([0.75, 0.5]).unwrap(), [0.25, 0.625]);
    }

    #[test]
    fn bilinear_rgb_is_interpolated_in_linear_space_and_alpha_is_not() {
        let pixels = [
            255, 0, 0, 0, 0, 255, 0, 64, 0, 0, 255, 128, 255, 255, 255, 255,
        ];
        let texture = TextureView::try_new(2, 2, &pixels).unwrap();
        let sampled = texture.sample_bilinear_linear([0.5, 0.5]).unwrap();

        assert_close(sampled[0], 0.5);
        assert_close(sampled[1], 0.5);
        assert_close(sampled[2], 0.5);
        assert_close(sampled[3], 447.0 / (4.0 * 255.0));
        assert_eq!(
            material(0).sample(&[texture], [0.5, 0.5]).unwrap().rgb,
            [188; 3]
        );
    }

    #[test]
    fn mmd_multiplicative_and_additive_color_matches_typescript_golden() {
        assert_eq!(
            apply_mmd_texture_color(
                [0.5, 0.5, 0.5],
                [0.8, 0.9, 1.0],
                [1.0, 1.0, 1.0, 1.0],
                [0.1, 0.05, 0.0, 0.5],
            ),
            [93, 110, 128],
        );
    }

    #[test]
    fn untextured_materials_ignore_texture_morph_factors() {
        let state = MaterialTextureState {
            base_color: [0.8, 0.2, 0.1, 0.42],
            texture_factor: [0.0, 0.0, 0.0, 1.0],
            texture_additive_factor: [1.0, 0.0, 1.0, 1.0],
            has_texture: false,
            texture_index: -1,
            texture_transform: TextureTransform::identity(),
        };

        assert_eq!(
            state.sample(&[], [f64::NAN, f64::NAN]).unwrap(),
            MaterialSample {
                rgb: [204, 51, 26],
                alpha: 0.42,
            },
        );
    }

    #[test]
    fn declared_but_uncaptured_texture_fails_closed() {
        assert_eq!(
            material(0).sample(&[], [0.0, 0.0]),
            Err(MaterialSampleError::MissingTextureCapture { texture_index: 0 }),
        );
        let mut legacy_declared = material(-1);
        legacy_declared.has_texture = true;
        assert_eq!(
            legacy_declared.sample(&[], [0.0, 0.0]),
            Err(MaterialSampleError::MissingTextureCapture { texture_index: -1 }),
        );
    }

    #[test]
    fn alpha_equal_to_threshold_survives_and_the_previous_byte_does_not() {
        let accepted = 128.0 / 255.0;
        let rejected = 127.0 / 255.0;
        assert!(alpha_passes_threshold(accepted, accepted));
        assert!(!alpha_passes_threshold(rejected, accepted));
    }

    #[test]
    fn non_finite_alpha_or_threshold_fails_closed() {
        assert!(!alpha_passes_threshold(f64::NAN, 0.3));
        assert!(!alpha_passes_threshold(1.0, f64::NAN));
    }

    #[test]
    fn flip_y_selects_the_opposite_texture_row() {
        let pixels = [255, 0, 0, 255, 0, 0, 255, 255];
        let texture = TextureView::try_new(1, 2, &pixels).unwrap();
        let mut state = material(0);
        state.texture_transform.flip_y = true;

        assert_eq!(
            state.sample(&[texture], [0.0, 0.0]).unwrap().rgb,
            [0, 0, 255]
        );
    }

    #[test]
    fn texture_dimensions_and_pixel_length_are_validated_before_sampling() {
        assert_eq!(
            TextureView::try_new(0, 1, &[]),
            Err(TextureError::ZeroDimension)
        );
        assert_eq!(
            TextureView::try_new(2, 2, &[0; 15]),
            Err(TextureError::InvalidPixelLength {
                actual: 15,
                expected: 16,
            }),
        );
    }
}
