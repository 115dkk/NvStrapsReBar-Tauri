const LEGACY_ECMA_POLYNOMIAL: u64 = 0xc96c_5795_d787_0f42;

/// Computes the setup-variable guard used by the original firmware driver.
///
/// This intentionally preserves its word-oriented algorithm: little-endian
/// 64-bit words, complement before and after processing, and padding only for
/// a partial final word. It is not interchangeable with a conventional
/// byte-at-a-time CRC-64 implementation.
pub fn setup_variable_crc64(data: &[u8]) -> u64 {
    let mut crc = u64::MAX;
    let mut chunks = data.chunks_exact(8);
    for chunk in &mut chunks {
        let word: [u8; 8] = chunk.try_into().expect("chunks_exact yields eight bytes");
        crc = update_word(crc, word);
    }

    let remainder = chunks.remainder();
    if !remainder.is_empty() {
        let padding = (8 - remainder.len()) as u8;
        let mut word = [padding; 8];
        word[..remainder.len()].copy_from_slice(remainder);
        crc = update_word(crc, word);
    }
    !crc
}

fn update_word(mut crc: u64, word: [u8; 8]) -> u64 {
    crc ^= u64::from_le_bytes(word);
    for _ in 0..u64::BITS {
        let polynomial = if crc & (1_u64 << 63) != 0 {
            LEGACY_ECMA_POLYNOMIAL
        } else {
            0
        };
        crc = (crc << 1) ^ polynomial;
    }
    crc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_fixed_vectors_from_the_c_word_algorithm() {
        assert_eq!(setup_variable_crc64(&[]), 0);
        assert_eq!(setup_variable_crc64(b"123456789"), 0x9831_7a4c_7bc4_76bb);
        assert_eq!(
            setup_variable_crc64(&[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]),
            0xf622_dc29_e8e3_73bd
        );
    }

    #[test]
    fn pads_only_a_partial_final_word() {
        assert_eq!(
            setup_variable_crc64(&[1, 2, 3, 4, 5, 6, 7]),
            0x04b5_f6c6_be74_ec4d
        );
        assert_eq!(
            setup_variable_crc64(&[1, 2, 3, 4, 5, 6, 7, 8]),
            0x1b1c_f654_609c_8edf
        );
    }
}
