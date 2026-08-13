pub const NVIDIA_VENDOR_ID: u16 = 0x10DE;
pub const MAX_BAR_SIZE_SELECTOR: u8 = 10;
pub const BAR_SIZE_EXCLUDED: u8 = 0xFE;
pub const BAR_SIZE_NONE: u8 = 0xFF;

const TURING_SKIP: &[u16] = &[
    0x1E30, 0x1E36, 0x1E37, 0x1E38, 0x1E3C, 0x1E3D, 0x1E3E, 0x1E78, 0x1EB9, 0x1EBA, 0x1EBE,
];
const TURING_2_GIB: &[u16] = &[0x1F97, 0x1F98, 0x1F9C, 0x1F9F, 0x1FA0];
const TURING_4_GIB: &[u16] = &[
    0x1F0A, 0x1F82, 0x1F83, 0x1F91, 0x1F92, 0x1F94, 0x1F95, 0x1F96, 0x1F99, 0x1F9D, 0x1FB0, 0x1FB1,
    0x1FB2, 0x1FB6, 0x1FB7, 0x1FB8, 0x1FB9, 0x1FBA, 0x1FBB, 0x1FBC, 0x1FD9, 0x1FDD, 0x1FF2, 0x1FF9,
    0x2187, 0x2188, 0x2192,
];
const TURING_8_GIB: &[u16] = &[
    0x1E81, 0x1E82, 0x1E84, 0x1E87, 0x1E89, 0x1E90, 0x1E91, 0x1E93, 0x1EAB, 0x1EAE, 0x1EB1, 0x1EB6,
    0x1EC2, 0x1EC7, 0x1ED0, 0x1ED1, 0x1ED3, 0x1F02, 0x1F06, 0x1F07, 0x1F08, 0x1F09, 0x1F0B, 0x1F10,
    0x1F11, 0x1F12, 0x1F14, 0x1F15, 0x1F36, 0x1F42, 0x1F47, 0x1F50, 0x1F51, 0x1F54, 0x1F55, 0x1F76,
    0x1FF0, 0x21C4, 0x2189, 0x2191, 0x2182, 0x2183, 0x2184,
];
const TURING_16_GIB: &[u16] = &[
    0x1E03, 0x1E04, 0x1E07, 0x1E09, 0x1E2D, 0x1E2E, 0x1EB0, 0x1EB4, 0x1EB5, 0x1EB8, 0x1EF5, 0x1F03,
];
const TURING_32_GIB: &[u16] = &[0x1E02];

const GROUPS: &[(&[u16], u8)] = &[
    (TURING_SKIP, BAR_SIZE_EXCLUDED),
    (TURING_2_GIB, 5),
    (TURING_4_GIB, 6),
    (TURING_8_GIB, 7),
    (TURING_16_GIB, 8),
    (TURING_32_GIB, 9),
];

pub const fn is_turing(device_id: u16) -> bool {
    matches!(
        device_id,
        0x1E00..=0x1E7F
            | 0x1E80..=0x1EFF
            | 0x1F00..=0x1F7F
            | 0x2180..=0x21FF
            | 0x1F80..=0x1FFF
    )
}

pub fn registry_bar_size(device_id: u16) -> Option<u8> {
    GROUPS
        .iter()
        .find_map(|(devices, selector)| devices.contains(&device_id).then_some(*selector))
}

pub fn automatic_bar_size(device_id: u16) -> Option<u8> {
    registry_bar_size(device_id).or_else(|| is_turing(device_id).then_some(5))
}

pub const fn bar_size_bytes(selector: u8) -> Option<u64> {
    if selector <= MAX_BAR_SIZE_SELECTOR {
        Some((64_u64 * 1024 * 1024) << selector)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use alloc::vec::Vec;

    use super::*;

    #[test]
    fn registry_is_the_complete_c_source_snapshot() {
        let entries: usize = GROUPS.iter().map(|(devices, _)| devices.len()).sum();
        assert_eq!(entries, 99);
        let mut ids = GROUPS
            .iter()
            .flat_map(|(devices, _)| devices.iter().copied())
            .collect::<Vec<_>>();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), entries, "registry IDs must be unique");
    }

    #[test]
    fn preserves_known_registry_values_and_comment_exclusions() {
        assert_eq!(registry_bar_size(0x1E84), Some(7));
        assert_eq!(registry_bar_size(0x1E04), Some(8));
        assert_eq!(registry_bar_size(0x1E30), Some(BAR_SIZE_EXCLUDED));
        assert_eq!(registry_bar_size(0x1F81), None);
    }

    #[test]
    fn fallback_applies_only_to_unlisted_turing_devices() {
        assert_eq!(automatic_bar_size(0x1F81), Some(5));
        assert_eq!(automatic_bar_size(0x2684), None);
    }
}
