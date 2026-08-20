use std::collections::HashMap;

pub type Rgb8 = [u8; 3];
pub type Lab = [f64; 3];

const PALETTE_CACHE_MAX_ENTRIES_PER_ROLE: usize = 65_536;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaletteRole {
    General,
    SkinBase,
    FaceFeature,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PalettePreset {
    Balanced,
    Clean,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MaterialTheme {
    Original,
    GreekMarble,
    Steampunk,
    AncientRuins,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlockPaletteOptions {
    pub theme: MaterialTheme,
    pub preset: PalettePreset,
    pub exclude_gravity: bool,
    pub exclude_rare: bool,
}

impl Default for BlockPaletteOptions {
    fn default() -> Self {
        Self {
            theme: MaterialTheme::Original,
            preset: PalettePreset::Balanced,
            exclude_gravity: false,
            exclude_rare: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PaletteEntry {
    pub block_id: &'static str,
    pub color: Rgb8,
}

const EMISSIVE_BLOCKS: &[PaletteEntry] = &[
    PaletteEntry {
        block_id: "minecraft:end_rod",
        color: [232, 227, 212],
    },
    PaletteEntry {
        block_id: "minecraft:glowstone",
        color: [206, 153, 77],
    },
    PaletteEntry {
        block_id: "minecraft:sea_lantern",
        color: [172, 199, 190],
    },
    PaletteEntry {
        block_id: "minecraft:ochre_froglight",
        color: [246, 225, 157],
    },
    PaletteEntry {
        block_id: "minecraft:verdant_froglight",
        color: [211, 234, 208],
    },
    PaletteEntry {
        block_id: "minecraft:pearlescent_froglight",
        color: [238, 209, 228],
    },
];

pub fn emissive_block_choices() -> &'static [PaletteEntry] {
    EMISSIVE_BLOCKS
}

pub fn match_emissive_block(rgb: Rgb8) -> PaletteEntry {
    let target = rgb_to_lab(rgb);
    let mut best = EMISSIVE_BLOCKS[0];
    let mut best_distance = f64::INFINITY;
    for candidate in EMISSIVE_BLOCKS.iter().copied() {
        let distance = ciede2000(target, rgb_to_lab(candidate.color));
        // 与 TypeScript 一致：完全同距时保留固定列表中更早的方块。
        if distance < best_distance {
            best = candidate;
            best_distance = distance;
        }
    }
    best
}

#[derive(Debug, Clone, PartialEq)]
pub struct PreparedBlockPalette {
    entries: Vec<PaletteEntry>,
    labs: Vec<Lab>,
    skin_indices: Vec<usize>,
    face_feature_indices: Vec<usize>,
}

impl PreparedBlockPalette {
    pub fn entries(&self) -> &[PaletteEntry] {
        &self.entries
    }

    pub fn labs(&self) -> &[Lab] {
        &self.labs
    }

    pub fn skin_indices(&self) -> &[usize] {
        &self.skin_indices
    }

    pub fn face_feature_indices(&self) -> &[usize] {
        &self.face_feature_indices
    }

    pub fn match_color(&self, rgb: Rgb8, role: PaletteRole) -> usize {
        let target = rgb_to_lab(rgb);
        let restricted = match role {
            PaletteRole::General => None,
            PaletteRole::SkinBase => Some(self.skin_indices.as_slice()),
            PaletteRole::FaceFeature => Some(self.face_feature_indices.as_slice()),
        }
        .filter(|indices| !indices.is_empty());
        let mut best_index = restricted.map_or(0, |indices| indices[0]);
        let mut best_distance = f64::INFINITY;
        if let Some(candidates) = restricted {
            for index in candidates.iter().copied() {
                let distance = ciede2000(target, self.labs[index]);
                // 严格小于保证完全同距时保留源调色板顺序。
                if distance < best_distance {
                    best_distance = distance;
                    best_index = index;
                }
            }
        } else {
            for index in 0..self.entries.len() {
                let distance = ciede2000(target, self.labs[index]);
                if distance < best_distance {
                    best_distance = distance;
                    best_index = index;
                }
            }
        }
        best_index
    }

    pub fn match_cache(&self) -> PaletteMatchCache<'_> {
        PaletteMatchCache::new(self)
    }
}

#[derive(Debug)]
pub struct PaletteMatchCache<'palette> {
    palette: &'palette PreparedBlockPalette,
    role_sparse: [HashMap<u32, usize>; 3],
    emissive_sparse: HashMap<u32, usize>,
}

impl<'palette> PaletteMatchCache<'palette> {
    fn new(palette: &'palette PreparedBlockPalette) -> Self {
        Self {
            palette,
            role_sparse: std::array::from_fn(|_| HashMap::new()),
            emissive_sparse: HashMap::new(),
        }
    }

    pub fn match_color(&mut self, rgb: Rgb8, role: PaletteRole) -> usize {
        let key = rgb_key(rgb);
        let role_index = role_index(role);
        if let Some(&cached) = self.role_sparse[role_index].get(&key) {
            return cached;
        }

        let matched = self.palette.match_color(rgb, role);
        remember(&mut self.role_sparse[role_index], key, matched);
        matched
    }

    pub fn match_emissive(&mut self, rgb: Rgb8) -> PaletteEntry {
        let key = rgb_key(rgb);
        if let Some(&cached) = self.emissive_sparse.get(&key) {
            return EMISSIVE_BLOCKS[cached];
        }

        let matched = match_emissive_block(rgb);
        let index = EMISSIVE_BLOCKS
            .iter()
            .position(|entry| *entry == matched)
            .expect("emissive match must return a registered palette entry");
        remember(&mut self.emissive_sparse, key, index);
        matched
    }

    #[cfg(test)]
    fn cached_entry_count(&self) -> usize {
        self.role_sparse
            .iter()
            .map(|cache| cache.len())
            .sum::<usize>()
            + self.emissive_sparse.len()
    }
}

fn role_index(role: PaletteRole) -> usize {
    match role {
        PaletteRole::General => 0,
        PaletteRole::SkinBase => 1,
        PaletteRole::FaceFeature => 2,
    }
}

fn rgb_key(rgb: Rgb8) -> u32 {
    (u32::from(rgb[0]) << 16) | (u32::from(rgb[1]) << 8) | u32::from(rgb[2])
}

fn remember<T>(cache: &mut HashMap<u32, T>, key: u32, value: T) {
    if cache.len() >= PALETTE_CACHE_MAX_ENTRIES_PER_ROLE {
        cache.clear();
    }
    cache.insert(key, value);
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct SourceFlags {
    skin_safe: bool,
    face_feature_safe: bool,
    gravity: bool,
    rare: bool,
    noisy: bool,
}

const fn flags(
    skin_safe: bool,
    face_feature_safe: bool,
    gravity: bool,
    rare: bool,
    noisy: bool,
) -> SourceFlags {
    SourceFlags {
        skin_safe,
        face_feature_safe,
        gravity,
        rare,
        noisy,
    }
}

const NONE: SourceFlags = flags(false, false, false, false, false);
const SKIN: SourceFlags = flags(true, false, false, false, false);
const FACE: SourceFlags = flags(false, true, false, false, false);
const SKIN_FACE: SourceFlags = flags(true, true, false, false, false);
const NOISY: SourceFlags = flags(false, false, false, false, true);
const SKIN_NOISY: SourceFlags = flags(true, false, false, false, true);
const RARE: SourceFlags = flags(false, false, false, true, false);
const GRAVITY_NOISY: SourceFlags = flags(false, false, true, false, true);
const THEME: SourceFlags = SKIN_FACE;
const THEME_NOISY: SourceFlags = flags(true, true, false, false, true);
const THEME_RARE: SourceFlags = flags(true, true, false, true, false);
const THEME_RARE_NOISY: SourceFlags = flags(true, true, false, true, true);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SourceEntry {
    palette: PaletteEntry,
    flags: SourceFlags,
}

const fn block(block_id: &'static str, color: Rgb8, entry_flags: SourceFlags) -> SourceEntry {
    SourceEntry {
        palette: PaletteEntry { block_id, color },
        flags: entry_flags,
    }
}

const ORIGINAL_BLOCKS: &[SourceEntry] = &[
    block("minecraft:white_concrete", [207, 213, 214], SKIN_FACE),
    block("minecraft:light_gray_concrete", [125, 125, 115], SKIN_FACE),
    block("minecraft:gray_concrete", [54, 57, 61], FACE),
    block("minecraft:black_concrete", [8, 10, 15], FACE),
    block("minecraft:brown_concrete", [96, 59, 31], FACE),
    block("minecraft:red_concrete", [142, 32, 32], FACE),
    block("minecraft:orange_concrete", [224, 97, 0], FACE),
    block("minecraft:yellow_concrete", [241, 175, 21], FACE),
    block("minecraft:lime_concrete", [94, 168, 24], FACE),
    block("minecraft:green_concrete", [73, 91, 36], FACE),
    block("minecraft:cyan_concrete", [21, 119, 136], FACE),
    block("minecraft:light_blue_concrete", [36, 137, 199], FACE),
    block("minecraft:blue_concrete", [44, 46, 143], FACE),
    block("minecraft:purple_concrete", [100, 31, 156], FACE),
    block("minecraft:magenta_concrete", [169, 48, 159], FACE),
    block("minecraft:pink_concrete", [214, 101, 143], SKIN_FACE),
    block("minecraft:white_wool", [234, 236, 237], NONE),
    block("minecraft:light_gray_wool", [142, 142, 135], NONE),
    block("minecraft:gray_wool", [62, 68, 71], NONE),
    block("minecraft:black_wool", [20, 21, 25], NONE),
    block("minecraft:brown_wool", [114, 72, 41], NONE),
    block("minecraft:red_wool", [161, 39, 35], NONE),
    block("minecraft:orange_wool", [240, 118, 19], NONE),
    block("minecraft:yellow_wool", [248, 198, 39], NONE),
    block("minecraft:lime_wool", [112, 185, 25], NONE),
    block("minecraft:green_wool", [84, 109, 27], NONE),
    block("minecraft:cyan_wool", [21, 137, 145], NONE),
    block("minecraft:light_blue_wool", [58, 175, 217], NONE),
    block("minecraft:blue_wool", [53, 57, 157], NONE),
    block("minecraft:purple_wool", [121, 42, 172], NONE),
    block("minecraft:magenta_wool", [189, 68, 179], NONE),
    block("minecraft:pink_wool", [237, 141, 172], NONE),
    block("minecraft:white_terracotta", [209, 178, 161], SKIN),
    block("minecraft:light_gray_terracotta", [135, 107, 98], SKIN),
    block("minecraft:gray_terracotta", [58, 42, 36], NONE),
    block("minecraft:black_terracotta", [37, 23, 16], NONE),
    block("minecraft:brown_terracotta", [77, 51, 36], SKIN),
    block("minecraft:red_terracotta", [143, 61, 47], SKIN),
    block("minecraft:orange_terracotta", [161, 83, 37], SKIN),
    block("minecraft:yellow_terracotta", [186, 133, 35], SKIN),
    block("minecraft:lime_terracotta", [103, 117, 52], NONE),
    block("minecraft:green_terracotta", [76, 83, 42], NONE),
    block("minecraft:cyan_terracotta", [86, 91, 91], NONE),
    block("minecraft:light_blue_terracotta", [113, 108, 137], NONE),
    block("minecraft:blue_terracotta", [74, 59, 91], NONE),
    block("minecraft:purple_terracotta", [118, 70, 86], NONE),
    block("minecraft:magenta_terracotta", [149, 88, 108], NONE),
    block("minecraft:pink_terracotta", [161, 78, 78], SKIN),
    block("minecraft:terracotta", [152, 94, 67], SKIN),
    block("minecraft:smooth_quartz", [231, 226, 218], SKIN),
    block("minecraft:quartz_block", [235, 229, 222], SKIN),
    block("minecraft:calcite", [223, 224, 217], SKIN),
    block("minecraft:smooth_sandstone", [220, 203, 145], SKIN),
    block("minecraft:cut_sandstone", [217, 199, 137], SKIN),
    block("minecraft:sandstone", [216, 200, 143], SKIN_NOISY),
    block("minecraft:smooth_red_sandstone", [181, 97, 31], SKIN),
    block("minecraft:stone", [125, 125, 125], NONE),
    block("minecraft:smooth_stone", [158, 158, 158], NONE),
    block("minecraft:polished_diorite", [192, 193, 190], NONE),
    block("minecraft:diorite", [188, 188, 183], NOISY),
    block("minecraft:polished_andesite", [132, 134, 133], NONE),
    block("minecraft:andesite", [136, 136, 136], NOISY),
    block("minecraft:polished_deepslate", [72, 72, 74], NONE),
    block("minecraft:deepslate_tiles", [54, 54, 56], NONE),
    block("minecraft:polished_blackstone", [53, 48, 56], NONE),
    block("minecraft:blackstone", [42, 36, 41], NOISY),
    block("minecraft:coal_block", [16, 15, 15], NONE),
    block("minecraft:obsidian", [15, 10, 24], NONE),
    block("minecraft:clay", [160, 166, 179], NONE),
    block("minecraft:packed_mud", [142, 106, 79], NONE),
    block("minecraft:mud_bricks", [137, 103, 79], NONE),
    block("minecraft:bricks", [150, 97, 83], NOISY),
    block("minecraft:nether_bricks", [45, 22, 27], NONE),
    block("minecraft:red_nether_bricks", [69, 7, 9], NONE),
    block("minecraft:purpur_block", [169, 126, 169], NONE),
    block("minecraft:prismarine_bricks", [99, 171, 158], NONE),
    block("minecraft:dark_prismarine", [52, 91, 75], NONE),
    block("minecraft:oak_planks", [162, 130, 79], NONE),
    block("minecraft:spruce_planks", [114, 84, 48], NONE),
    block("minecraft:birch_planks", [196, 179, 123], NONE),
    block("minecraft:jungle_planks", [160, 115, 80], NONE),
    block("minecraft:acacia_planks", [169, 91, 51], NONE),
    block("minecraft:dark_oak_planks", [67, 43, 20], NONE),
    block("minecraft:mangrove_planks", [117, 54, 48], NONE),
    block("minecraft:cherry_planks", [226, 178, 172], NONE),
    block("minecraft:bamboo_planks", [193, 173, 70], NONE),
    block("minecraft:crimson_planks", [101, 48, 70], NONE),
    block("minecraft:warped_planks", [43, 104, 99], NONE),
    block("minecraft:moss_block", [89, 109, 45], NOISY),
    block("minecraft:snow_block", [249, 254, 254], NONE),
    block("minecraft:iron_block", [221, 221, 216], RARE),
    block("minecraft:gold_block", [246, 208, 61], RARE),
    block("minecraft:diamond_block", [98, 237, 228], RARE),
    block("minecraft:emerald_block", [42, 203, 87], RARE),
    block("minecraft:lapis_block", [30, 67, 140], RARE),
    block("minecraft:redstone_block", [176, 24, 9], RARE),
    block("minecraft:sand", [219, 207, 163], GRAVITY_NOISY),
    block("minecraft:red_sand", [191, 103, 33], GRAVITY_NOISY),
    block("minecraft:gravel", [132, 128, 127], GRAVITY_NOISY),
];

const GREEK_MARBLE_BLOCKS: &[SourceEntry] = &[
    block("minecraft:smooth_quartz", [231, 226, 218], THEME),
    block("minecraft:quartz_block", [235, 229, 222], THEME),
    block("minecraft:calcite", [223, 224, 217], THEME),
    block("minecraft:polished_diorite", [192, 193, 190], THEME),
    block("minecraft:smooth_sandstone", [220, 203, 145], THEME),
];

const STEAMPUNK_BLOCKS: &[SourceEntry] = &[
    block("minecraft:copper_block", [192, 107, 79], THEME),
    block("minecraft:cut_copper", [191, 106, 80], THEME),
    block("minecraft:exposed_copper", [161, 125, 103], THEME),
    block("minecraft:weathered_copper", [108, 153, 110], THEME),
    block("minecraft:oxidized_copper", [82, 162, 132], THEME),
    block("minecraft:raw_iron_block", [166, 135, 107], THEME_RARE),
    block("minecraft:iron_block", [221, 221, 216], THEME_RARE),
    block(
        "minecraft:deepslate_gold_ore",
        [77, 75, 71],
        THEME_RARE_NOISY,
    ),
];

const ANCIENT_RUINS_BLOCKS: &[SourceEntry] = &[
    block("minecraft:stone_bricks", [122, 121, 122], THEME),
    block("minecraft:mossy_stone_bricks", [115, 121, 105], THEME_NOISY),
    block("minecraft:calcite", [223, 224, 217], THEME),
    block("minecraft:moss_block", [89, 109, 45], THEME_NOISY),
];

pub fn create_block_palette(options: BlockPaletteOptions) -> PreparedBlockPalette {
    let source = source_for_theme(options.theme);
    let mut filtered: Vec<SourceEntry> = source
        .iter()
        .copied()
        .filter(|entry| {
            if options.exclude_gravity && entry.flags.gravity {
                return false;
            }
            if options.exclude_rare && entry.flags.rare {
                return false;
            }
            if options.theme == MaterialTheme::Original
                && options.preset == PalettePreset::Clean
                && entry.flags.noisy
            {
                return false;
            }
            true
        })
        .collect();
    if filtered.is_empty() {
        filtered.push(
            source
                .iter()
                .copied()
                .find(|entry| !entry.flags.gravity)
                .unwrap_or(ORIGINAL_BLOCKS[0]),
        );
    }
    prepare_palette(&filtered)
}

fn source_for_theme(theme: MaterialTheme) -> &'static [SourceEntry] {
    match theme {
        MaterialTheme::Original => ORIGINAL_BLOCKS,
        MaterialTheme::GreekMarble => GREEK_MARBLE_BLOCKS,
        MaterialTheme::Steampunk => STEAMPUNK_BLOCKS,
        MaterialTheme::AncientRuins => ANCIENT_RUINS_BLOCKS,
    }
}

fn prepare_palette(source: &[SourceEntry]) -> PreparedBlockPalette {
    debug_assert!(!source.is_empty());
    let mut entries = Vec::with_capacity(source.len());
    let mut labs = Vec::with_capacity(source.len());
    let mut skin_indices = Vec::new();
    let mut face_feature_indices = Vec::new();
    for (index, source_entry) in source.iter().copied().enumerate() {
        entries.push(source_entry.palette);
        labs.push(rgb_to_lab(source_entry.palette.color));
        if source_entry.flags.skin_safe && !source_entry.flags.noisy {
            skin_indices.push(index);
        }
        if source_entry.flags.face_feature_safe && !source_entry.flags.noisy {
            face_feature_indices.push(index);
        }
    }
    PreparedBlockPalette {
        entries,
        labs,
        skin_indices,
        face_feature_indices,
    }
}

pub fn rgb_to_lab([red, green, blue]: Rgb8) -> Lab {
    let r = srgb_channel_to_linear(red);
    let g = srgb_channel_to_linear(green);
    let b = srgb_channel_to_linear(blue);
    let x = (r * 0.412_456_4 + g * 0.357_576_1 + b * 0.180_437_5) / 0.950_47;
    let y = r * 0.212_672_9 + g * 0.715_152_2 + b * 0.072_175;
    let z = (r * 0.019_333_9 + g * 0.119_192 + b * 0.950_304_1) / 1.088_83;
    let fx = lab_pivot(x);
    let fy = lab_pivot(y);
    let fz = lab_pivot(z);
    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

pub fn ciede2000(left: Lab, right: Lab) -> f64 {
    let [l1, a1, b1] = left;
    let [l2, a2, b2] = right;
    let c1 = a1.hypot(b1);
    let c2 = a2.hypot(b2);
    let average_c = (c1 + c2) / 2.0;
    let average_c7 = average_c.powi(7);
    let g = 0.5 * (1.0 - (average_c7 / (average_c7 + 25_f64.powi(7))).sqrt());
    let adjusted_a1 = (1.0 + g) * a1;
    let adjusted_a2 = (1.0 + g) * a2;
    let adjusted_c1 = adjusted_a1.hypot(b1);
    let adjusted_c2 = adjusted_a2.hypot(b2);
    let h1 = hue_degrees(adjusted_a1, b1);
    let h2 = hue_degrees(adjusted_a2, b2);
    let delta_l = l2 - l1;
    let delta_c = adjusted_c2 - adjusted_c1;
    let hue_difference = if adjusted_c1 * adjusted_c2 == 0.0 {
        0.0
    } else if (h2 - h1).abs() <= 180.0 {
        h2 - h1
    } else if h2 <= h1 {
        h2 - h1 + 360.0
    } else {
        h2 - h1 - 360.0
    };
    let delta_h =
        2.0 * (adjusted_c1 * adjusted_c2).sqrt() * degrees_to_radians(hue_difference / 2.0).sin();
    let average_l = (l1 + l2) / 2.0;
    let adjusted_average_c = (adjusted_c1 + adjusted_c2) / 2.0;
    let average_h = if adjusted_c1 * adjusted_c2 == 0.0 {
        h1 + h2
    } else if (h1 - h2).abs() <= 180.0 {
        (h1 + h2) / 2.0
    } else if h1 + h2 < 360.0 {
        (h1 + h2 + 360.0) / 2.0
    } else {
        (h1 + h2 - 360.0) / 2.0
    };
    let t = 1.0 - 0.17 * degrees_to_radians(average_h - 30.0).cos()
        + 0.24 * degrees_to_radians(2.0 * average_h).cos()
        + 0.32 * degrees_to_radians(3.0 * average_h + 6.0).cos()
        - 0.2 * degrees_to_radians(4.0 * average_h - 63.0).cos();
    let delta_theta = 30.0 * (-((average_h - 275.0) / 25.0).powi(2)).exp();
    let adjusted_average_c7 = adjusted_average_c.powi(7);
    let rc = 2.0 * (adjusted_average_c7 / (adjusted_average_c7 + 25_f64.powi(7))).sqrt();
    let lightness_term = average_l - 50.0;
    let sl = 1.0 + 0.015 * lightness_term.powi(2) / (20.0 + lightness_term.powi(2)).sqrt();
    let sc = 1.0 + 0.045 * adjusted_average_c;
    let sh = 1.0 + 0.015 * adjusted_average_c * t;
    let rt = -degrees_to_radians(2.0 * delta_theta).sin() * rc;
    let normalized_l = delta_l / sl;
    let normalized_c = delta_c / sc;
    let normalized_h = delta_h / sh;
    (normalized_l.powi(2)
        + normalized_c.powi(2)
        + normalized_h.powi(2)
        + rt * normalized_c * normalized_h)
        .sqrt()
}

fn srgb_channel_to_linear(value: u8) -> f64 {
    let channel = f64::from(value) / 255.0;
    if channel <= 0.040_45 {
        channel / 12.92
    } else {
        ((channel + 0.055) / 1.055).powf(2.4)
    }
}

fn lab_pivot(value: f64) -> f64 {
    if value > 216.0 / 24_389.0 {
        value.cbrt()
    } else {
        (24_389.0 / 27.0 * value + 16.0) / 116.0
    }
}

fn hue_degrees(a: f64, b: f64) -> f64 {
    if a == 0.0 && b == 0.0 {
        return 0.0;
    }
    let hue = b.atan2(a).to_degrees();
    if hue >= 0.0 {
        hue
    } else {
        hue + 360.0
    }
}

fn degrees_to_radians(value: f64) -> f64 {
    value * std::f64::consts::PI / 180.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(palette: &PreparedBlockPalette) -> Vec<&'static str> {
        palette
            .entries()
            .iter()
            .map(|entry| entry.block_id)
            .collect()
    }

    #[test]
    fn ciede2000_matches_published_sharma_reference_pairs() {
        for (left, right, expected) in [
            ([50.0, 2.6772, -79.7751], [50.0, 0.0, -82.7485], 2.0425),
            ([50.0, 3.1571, -77.2803], [50.0, 0.0, -82.7485], 2.8615),
            ([50.0, 2.8361, -74.02], [50.0, 0.0, -82.7485], 3.4412),
            ([50.0, -1.3802, -84.2814], [50.0, 0.0, -82.7485], 1.0),
        ] {
            assert!((ciede2000(left, right) - expected).abs() < 0.0002);
        }
    }

    #[test]
    fn rgb_to_lab_matches_typescript_white_and_lightness_order() {
        let black = rgb_to_lab([0, 0, 0]);
        let gray = rgb_to_lab([128, 128, 128]);
        let white = rgb_to_lab([255, 255, 255]);
        assert!(black[0] < gray[0] && gray[0] < white[0]);
        assert!((white[0] - 100.0).abs() < 0.001);
    }

    #[test]
    fn emissive_choices_keep_the_typescript_order() {
        assert_eq!(
            emissive_block_choices()
                .iter()
                .map(|entry| entry.block_id)
                .collect::<Vec<_>>(),
            vec![
                "minecraft:end_rod",
                "minecraft:glowstone",
                "minecraft:sea_lantern",
                "minecraft:ochre_froglight",
                "minecraft:verdant_froglight",
                "minecraft:pearlescent_froglight",
            ],
        );
    }

    #[test]
    fn emissive_matching_matches_the_typescript_golden() {
        assert_eq!(
            match_emissive_block([235, 210, 225]).block_id,
            "minecraft:pearlescent_froglight",
        );
        for expected in emissive_block_choices() {
            assert_eq!(match_emissive_block(expected.color), *expected);
        }
    }

    #[test]
    fn original_palette_exclusions_match_typescript_rules() {
        let balanced = create_block_palette(BlockPaletteOptions::default());
        let clean = create_block_palette(BlockPaletteOptions {
            preset: PalettePreset::Clean,
            exclude_gravity: true,
            exclude_rare: true,
            ..BlockPaletteOptions::default()
        });
        let balanced_ids = ids(&balanced);
        let clean_ids = ids(&clean);

        assert!(balanced_ids.contains(&"minecraft:diorite"));
        assert!(balanced_ids.contains(&"minecraft:sand"));
        assert!(balanced_ids.contains(&"minecraft:diamond_block"));
        for excluded in [
            "minecraft:diorite",
            "minecraft:sand",
            "minecraft:red_sand",
            "minecraft:gravel",
            "minecraft:diamond_block",
        ] {
            assert!(
                !clean_ids.contains(&excluded),
                "{excluded} was not filtered"
            );
        }
    }

    #[test]
    fn clean_preset_does_not_remove_noisy_blocks_from_non_original_themes() {
        let palette = create_block_palette(BlockPaletteOptions {
            theme: MaterialTheme::AncientRuins,
            preset: PalettePreset::Clean,
            ..BlockPaletteOptions::default()
        });
        let palette_ids = ids(&palette);

        assert!(palette_ids.contains(&"minecraft:mossy_stone_bricks"));
        assert!(palette_ids.contains(&"minecraft:moss_block"));
        assert_eq!(palette.skin_indices().len(), 2);
        assert_eq!(palette.face_feature_indices().len(), 2);
    }

    #[test]
    fn rare_exclusion_applies_to_theme_registry_flags() {
        let palette = create_block_palette(BlockPaletteOptions {
            theme: MaterialTheme::Steampunk,
            exclude_rare: true,
            ..BlockPaletteOptions::default()
        });
        let palette_ids = ids(&palette);

        assert!(!palette_ids.contains(&"minecraft:raw_iron_block"));
        assert!(!palette_ids.contains(&"minecraft:iron_block"));
        assert!(!palette_ids.contains(&"minecraft:deepslate_gold_ore"));
        assert!(palette_ids.contains(&"minecraft:copper_block"));
    }

    #[test]
    fn face_feature_matching_is_restricted_to_clean_concrete_colors() {
        let palette = create_block_palette(BlockPaletteOptions::default());
        for (rgb, expected) in [
            ([8, 10, 15], "minecraft:black_concrete"),
            ([207, 213, 214], "minecraft:white_concrete"),
            ([44, 46, 143], "minecraft:blue_concrete"),
            ([21, 119, 136], "minecraft:cyan_concrete"),
            ([100, 31, 156], "minecraft:purple_concrete"),
            ([214, 101, 143], "minecraft:pink_concrete"),
            ([142, 32, 32], "minecraft:red_concrete"),
        ] {
            let index = palette.match_color(rgb, PaletteRole::FaceFeature);
            assert_eq!(palette.entries()[index].block_id, expected);
        }
    }

    #[test]
    fn role_without_safe_candidates_falls_back_to_the_full_palette() {
        let palette = prepare_palette(&[
            block("minecraft:first", [255, 0, 0], NONE),
            block("minecraft:second", [0, 0, 255], NONE),
        ]);

        let index = palette.match_color([0, 0, 255], PaletteRole::SkinBase);
        assert_eq!(palette.entries()[index].block_id, "minecraft:second");
    }

    #[test]
    fn exact_distance_ties_keep_the_first_source_entry() {
        let palette = prepare_palette(&[
            block("minecraft:first", [20, 40, 60], NONE),
            block("minecraft:second", [20, 40, 60], NONE),
        ]);

        assert_eq!(palette.match_color([20, 40, 60], PaletteRole::General), 0);
    }

    #[test]
    fn themed_palette_order_remains_canonical() {
        let palette = create_block_palette(BlockPaletteOptions {
            theme: MaterialTheme::GreekMarble,
            ..BlockPaletteOptions::default()
        });

        assert_eq!(
            ids(&palette),
            vec![
                "minecraft:smooth_quartz",
                "minecraft:quartz_block",
                "minecraft:calcite",
                "minecraft:polished_diorite",
                "minecraft:smooth_sandstone",
            ],
        );
    }

    #[test]
    fn palette_match_cache_is_role_scoped_and_reuses_emissive_results() {
        let palette = create_block_palette(BlockPaletteOptions::default());
        let mut cache = palette.match_cache();
        let rgb = [207, 213, 214];

        let general = cache.match_color(rgb, PaletteRole::General);
        let skin = cache.match_color(rgb, PaletteRole::SkinBase);
        let face = cache.match_color(rgb, PaletteRole::FaceFeature);
        assert_eq!(cache.match_color(rgb, PaletteRole::General), general);
        assert_eq!(cache.match_color(rgb, PaletteRole::SkinBase), skin);
        assert_eq!(cache.match_color(rgb, PaletteRole::FaceFeature), face);

        let emissive = cache.match_emissive(rgb);
        assert_eq!(cache.match_emissive(rgb), emissive);
        assert_eq!(cache.cached_entry_count(), 4);
    }

    #[test]
    fn palette_match_cache_clears_a_bucket_at_the_fixed_capacity() {
        let palette = prepare_palette(&[block("minecraft:first", [0, 0, 0], NONE)]);
        let mut cache = palette.match_cache();

        for value in 0..=PALETTE_CACHE_MAX_ENTRIES_PER_ROLE {
            let key = value as u32;
            let rgb = [
                ((key >> 16) & 0xff) as u8,
                ((key >> 8) & 0xff) as u8,
                (key & 0xff) as u8,
            ];
            cache.match_color(rgb, PaletteRole::General);
        }

        assert_eq!(cache.cached_entry_count(), 1);
    }
}
