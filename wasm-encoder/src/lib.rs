use wasm_bindgen::prelude::*;

const PCV_TEXTURE_KEYFRAME: u8 = 1;
const PCV_TEXTURE_DELTA: u8 = 2;
const PCV_TEXTURE_KEYFRAME_RLE: u8 = 3;
const PCV_TEXTURE_DELTA_RLE: u8 = 4;
const PCV_TEXTURE_DELTA_MOTION: u8 = 5;
const PCV_TEXTURE_DELTA_XOR_RLE: u8 = 6;

struct EncodedTile {
    x: u16,
    y: u16,
    width: u8,
    height: u8,
    motion: Option<(i16, i16)>,
    data: Vec<u8>,
    raw_data: Vec<u8>,
    xor_data: Vec<u8>,
    xor_raw_data: Vec<u8>,
    rle: bool,
}

#[wasm_bindgen]
pub struct WasmTextureEncoder {
    width: usize,
    height: usize,
    tile_size: usize,
    color_bits: u8,
    previous_texture: Option<Vec<u16>>,
}

#[wasm_bindgen]
pub fn zstd_compress(data: &[u8], level: i32) -> Vec<u8> {
    use ruzstd::encoding::{compress_to_vec, CompressionLevel};
    // ruzstd 0.8 currently only supports Fastest (level ~1) and Uncompressed
    // Map user levels to the available CompressionLevel enum
    let compression_level = if level <= 0 {
        CompressionLevel::Uncompressed
    } else {
        CompressionLevel::Fastest
    };
    compress_to_vec(data, compression_level)
}

#[wasm_bindgen]
pub fn zstd_decompress(data: &[u8]) -> Vec<u8> {
    use ruzstd::decoding::StreamingDecoder;
    use ruzstd::io::Read;
    let mut source = data;
    let mut decoder = match StreamingDecoder::new(&mut source) {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };
    let mut result = Vec::new();
    let _ = decoder.read_to_end(&mut result);
    result
}

#[wasm_bindgen]
impl WasmTextureEncoder {
    #[wasm_bindgen(constructor)]
    pub fn new(width: usize, height: usize, tile_size: usize, color_bits: u8) -> Self {
        WasmTextureEncoder {
            width,
            height,
            tile_size,
            color_bits,
            previous_texture: None,
        }
    }

    pub fn encode_frame(
        &mut self,
        rgba: &[u8],
        frame_index: usize,
        keyframe_interval: usize,
        changed_threshold: f32,
        motion_search_radius: usize,
        motion_mismatch_threshold: f32,
    ) -> Vec<u8> {
        let current = rgba_to_rgb565(rgba, self.color_bits);
        let keyframe = self.previous_texture.is_none() || frame_index % keyframe_interval == 0;

        if keyframe {
            let rle = encode_rgb565_rle(&current);
            let raw_byte_len = current.len() * 2;
            let result = if rle.len() >= raw_byte_len {
                let mut payload = Vec::with_capacity(1 + raw_byte_len);
                payload.push(PCV_TEXTURE_KEYFRAME);
                // Safety/Cast raw u16 buffer to bytes
                let u8_slice = unsafe {
                    std::slice::from_raw_parts(current.as_ptr() as *const u8, raw_byte_len)
                };
                payload.extend_from_slice(u8_slice);
                payload
            } else {
                let mut payload = Vec::with_capacity(5 + rle.len());
                payload.push(PCV_TEXTURE_KEYFRAME_RLE);
                let current_len_u32 = current.len() as u32;
                payload.extend_from_slice(&current_len_u32.to_le_bytes());
                payload.extend_from_slice(&rle);
                payload
            };
            self.previous_texture = Some(current);
            return result;
        }

        let previous = self.previous_texture.as_ref().unwrap();
        let mut tiles = Vec::new();
        let mut tile_count = 0u16;

        for y in (0..self.height).step_by(self.tile_size) {
            for x in (0..self.width).step_by(self.tile_size) {
                let tile_width = std::cmp::min(self.tile_size, self.width - x);
                let tile_height = std::cmp::min(self.tile_size, self.height - y);

                if !tile_changed(
                    &current,
                    previous,
                    x,
                    y,
                    tile_width,
                    tile_height,
                    self.width,
                    self.height,
                    changed_threshold,
                ) {
                    continue;
                }

                let mut tile_pixels = Vec::with_capacity(tile_width * tile_height);
                let mut xor_pixels = Vec::with_capacity(tile_width * tile_height);
                for row in 0..tile_height {
                    let start = (y + row) * self.width + x;
                    for col in 0..tile_width {
                        tile_pixels.push(current[start + col]);
                        xor_pixels.push(current[start + col] ^ previous[start + col]);
                    }
                }

                let motion = find_motion_tile(
                    &current,
                    previous,
                    x,
                    y,
                    tile_width,
                    tile_height,
                    self.width,
                    self.height,
                    motion_search_radius,
                    motion_mismatch_threshold,
                );

                let rle = encode_rgb565_rle(&tile_pixels);
                let xor_rle = encode_rgb565_rle(&xor_pixels);
                let raw_byte_len = tile_pixels.len() * 2;
                let raw_data = unsafe {
                    std::slice::from_raw_parts(tile_pixels.as_ptr() as *const u8, raw_byte_len)
                }.to_vec();
                let xor_raw_data = unsafe {
                    std::slice::from_raw_parts(xor_pixels.as_ptr() as *const u8, raw_byte_len)
                }.to_vec();

                // Pick the best encoding: RLE vs raw for standard tile delta
                let is_rle = rle.len() < raw_byte_len;
                let data = if is_rle { rle } else { raw_data.clone() };

                // For XOR delta tiles, we always force RLE encoding since decoder expects it
                let xor_data = xor_rle;

                tiles.push(EncodedTile {
                    x: x as u16,
                    y: y as u16,
                    width: tile_width as u8,
                    height: tile_height as u8,
                    motion,
                    data,
                    raw_data,
                    xor_data,
                    xor_raw_data,
                    rle: is_rle,
                });
                tile_count += 1;
            }
        }

        let has_motion = tiles.iter().any(|t| t.motion.is_some());
        let result = if has_motion {
            encode_motion_delta_tiles(&tiles, tile_count)
        } else if tiles.iter().all(|t| !t.rle) {
            encode_raw_delta_tiles(&tiles, tile_count)
        } else {
            encode_xor_rle_delta_tiles(&tiles, tile_count)
        };

        self.previous_texture = Some(current);
        result
    }
}

fn rgba_to_rgb565(rgba: &[u8], color_bits: u8) -> Vec<u16> {
    let mut pixels = Vec::with_capacity(rgba.len() / 4);
    for chunk in rgba.chunks_exact(4) {
        let r8 = if color_bits == 12 { chunk[0] & 0xf0 } else { chunk[0] };
        let g8 = if color_bits == 12 { chunk[1] & 0xf0 } else { chunk[1] };
        let b8 = if color_bits == 12 { chunk[2] & 0xf0 } else { chunk[2] };
        let r = (r8 >> 3) as u16;
        let g = (g8 >> 2) as u16;
        let b = (b8 >> 3) as u16;
        pixels.push((r << 11) | (g << 5) | b);
    }
    pixels
}

fn encode_rgb565_rle(pixels: &[u16]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(pixels.len() * 4);
    let mut index = 0;
    while index < pixels.len() {
        let value = pixels[index];
        let mut run = 1;
        while index + run < pixels.len() && pixels[index + run] == value && run < 65535 {
            run += 1;
        }
        bytes.push((run & 0xff) as u8);
        bytes.push((run >> 8) as u8);
        bytes.push((value & 0xff) as u8);
        bytes.push((value >> 8) as u8);
        index += run;
    }
    bytes
}

fn tile_changed(
    current: &[u16],
    previous: &[u16],
    x: usize,
    y: usize,
    tile_width: usize,
    tile_height: usize,
    width: usize,
    _height: usize,
    changed_threshold: f32,
) -> bool {
    let mut changed = 0;
    let pixels = tile_width * tile_height;
    for row in 0..tile_height {
        let start = (y + row) * width + x;
        for col in 0..tile_width {
            if current[start + col] != previous[start + col] {
                changed += 1;
            }
        }
    }
    (changed as f32) / (pixels as f32) >= changed_threshold
}

fn tile_mismatch(
    current: &[u16],
    previous: &[u16],
    x: usize,
    y: usize,
    sx: usize,
    sy: usize,
    tile_width: usize,
    tile_height: usize,
    width: usize,
) -> f32 {
    let mut changed = 0;
    let pixels = tile_width * tile_height;
    for row in 0..tile_height {
        let current_start = (y + row) * width + x;
        let previous_start = (sy + row) * width + sx;
        for col in 0..tile_width {
            if current[current_start + col] != previous[previous_start + col] {
                changed += 1;
            }
        }
    }
    (changed as f32) / (pixels as f32)
}

fn find_motion_tile(
    current: &[u16],
    previous: &[u16],
    x: usize,
    y: usize,
    tile_width: usize,
    tile_height: usize,
    width: usize,
    height: usize,
    motion_search_radius: usize,
    motion_mismatch_threshold: f32,
) -> Option<(i16, i16)> {
    let mut best: Option<(i16, i16, f32)> = None;
    let radius = motion_search_radius as i16;
    let search_step = 2;

    for dy in (-radius..=radius).step_by(search_step) {
        for dx in (-radius..=radius).step_by(search_step) {
            if dx == 0 && dy == 0 {
                continue;
            }
            let sx = (x as i32) + (dx as i32);
            let sy = (y as i32) + (dy as i32);
            if sx < 0 || sy < 0 || sx + (tile_width as i32) > (width as i32) || sy + (tile_height as i32) > (height as i32) {
                continue;
            }
            let mismatch = tile_mismatch(
                current,
                previous,
                x,
                y,
                sx as usize,
                sy as usize,
                tile_width,
                tile_height,
                width,
            );
            if best.is_none() || mismatch < best.unwrap().2 {
                best = Some((sx as i16, sy as i16, mismatch));
            }
        }
    }

    if let Some((sx, sy, mismatch)) = best {
        if mismatch <= motion_mismatch_threshold {
            return Some((sx, sy));
        }
    }
    None
}

fn encode_motion_delta_tiles(tiles: &[EncodedTile], tile_count: u16) -> Vec<u8> {
    let mut byte_length = 3;
    for tile in tiles {
        if tile.motion.is_some() {
            byte_length += 9;
        } else if tile.rle {
            byte_length += 9 + tile.data.len();
        } else {
            byte_length += 7 + tile.raw_data.len();
        }
    }

    let mut payload = vec![0u8; byte_length];
    payload[0] = PCV_TEXTURE_DELTA_MOTION;
    payload[1..3].copy_from_slice(&tile_count.to_le_bytes());

    let mut offset = 3;
    for tile in tiles {
        if let Some((mx, my)) = tile.motion {
            payload[offset] = 1;
            payload[offset + 1..offset + 3].copy_from_slice(&tile.x.to_le_bytes());
            payload[offset + 3..offset + 5].copy_from_slice(&tile.y.to_le_bytes());
            payload[offset + 5] = tile.width;
            payload[offset + 6] = tile.height;
            let dx = (mx - tile.x as i16) as i8;
            let dy = (my - tile.y as i16) as i8;
            payload[offset + 7] = dx as u8;
            payload[offset + 8] = dy as u8;
            offset += 9;
        } else if tile.rle {
            payload[offset] = 2;
            payload[offset + 1..offset + 3].copy_from_slice(&tile.x.to_le_bytes());
            payload[offset + 3..offset + 5].copy_from_slice(&tile.y.to_le_bytes());
            payload[offset + 5] = tile.width;
            payload[offset + 6] = tile.height;
            let data_len_u16 = tile.data.len() as u16;
            payload[offset + 7..offset + 9].copy_from_slice(&data_len_u16.to_le_bytes());
            offset += 9;
            payload[offset..offset + tile.data.len()].copy_from_slice(&tile.data);
            offset += tile.data.len();
        } else {
            payload[offset] = 0;
            payload[offset + 1..offset + 3].copy_from_slice(&tile.x.to_le_bytes());
            payload[offset + 3..offset + 5].copy_from_slice(&tile.y.to_le_bytes());
            payload[offset + 5] = tile.width;
            payload[offset + 6] = tile.height;
            offset += 7;
            payload[offset..offset + tile.raw_data.len()].copy_from_slice(&tile.raw_data);
            offset += tile.raw_data.len();
        }
    }
    payload
}

fn encode_raw_delta_tiles(tiles: &[EncodedTile], tile_count: u16) -> Vec<u8> {
    let mut byte_length = 3;
    for tile in tiles {
        byte_length += 6 + tile.raw_data.len();
    }

    let mut payload = vec![0u8; byte_length];
    payload[0] = PCV_TEXTURE_DELTA;
    payload[1..3].copy_from_slice(&tile_count.to_le_bytes());

    let mut offset = 3;
    for tile in tiles {
        payload[offset..offset + 2].copy_from_slice(&tile.x.to_le_bytes());
        payload[offset + 2..offset + 4].copy_from_slice(&tile.y.to_le_bytes());
        payload[offset + 4] = tile.width;
        payload[offset + 5] = tile.height;
        offset += 6;
        payload[offset..offset + tile.raw_data.len()].copy_from_slice(&tile.raw_data);
        offset += tile.raw_data.len();
    }
    payload
}

fn encode_rle_delta_tiles(tiles: &[EncodedTile], tile_count: u16) -> Vec<u8> {
    let mut byte_length = 3;
    for tile in tiles {
        byte_length += 8 + tile.data.len();
    }

    let mut payload = vec![0u8; byte_length];
    payload[0] = PCV_TEXTURE_DELTA_RLE;
    payload[1..3].copy_from_slice(&tile_count.to_le_bytes());

    let mut offset = 3;
    for tile in tiles {
        payload[offset..offset + 2].copy_from_slice(&tile.x.to_le_bytes());
        payload[offset + 2..offset + 4].copy_from_slice(&tile.y.to_le_bytes());
        payload[offset + 4] = tile.width;
        payload[offset + 5] = tile.height;
        let data_len_u16 = tile.data.len() as u16;
        payload[offset + 6..offset + 8].copy_from_slice(&data_len_u16.to_le_bytes());
        offset += 8;
        payload[offset..offset + tile.data.len()].copy_from_slice(&tile.data);
        offset += tile.data.len();
    }
    payload
}

fn encode_xor_rle_delta_tiles(tiles: &[EncodedTile], tile_count: u16) -> Vec<u8> {
    let mut byte_length = 3;
    for tile in tiles {
        byte_length += 8 + tile.xor_data.len();
    }

    let mut payload = vec![0u8; byte_length];
    payload[0] = PCV_TEXTURE_DELTA_XOR_RLE;
    payload[1..3].copy_from_slice(&tile_count.to_le_bytes());

    let mut offset = 3;
    for tile in tiles {
        payload[offset..offset + 2].copy_from_slice(&tile.x.to_le_bytes());
        payload[offset + 2..offset + 4].copy_from_slice(&tile.y.to_le_bytes());
        payload[offset + 4] = tile.width;
        payload[offset + 5] = tile.height;
        let data_len_u16 = tile.xor_data.len() as u16;
        payload[offset + 6..offset + 8].copy_from_slice(&data_len_u16.to_le_bytes());
        offset += 8;
        payload[offset..offset + tile.xor_data.len()].copy_from_slice(&tile.xor_data);
        offset += tile.xor_data.len();
    }
    payload
}
