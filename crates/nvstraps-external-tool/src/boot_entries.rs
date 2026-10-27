use std::collections::HashSet;

use nvstraps_external::{ESP_DIAGNOSTIC, ESP_LOADER, WINDOWS_BOOT_MANAGER};

use crate::load_option::{
    LOAD_OPTION_ACTIVE, LoadOption, encode_load_option, file_path, hard_drive_node,
    partition_file_device_path,
};

pub const LOADER_DESCRIPTION: &str = "NvStrapsReBar";
pub const DIAGNOSTIC_DESCRIPTION: &str = "NvStrapsReBar diagnostic";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryKind {
    Diagnostic,
    Loader,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BootEntry {
    pub number: u16,
    pub option: LoadOption,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BootState {
    pub order: Vec<u16>,
    pub next: Option<u16>,
    pub current: Option<u16>,
    pub entries: Vec<BootEntry>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BootChange {
    pub write: Vec<(u16, Vec<u8>)>,
    pub delete: Vec<u16>,
    pub order: Option<Vec<u16>>,
    pub next: Option<Option<u16>>,
}

/// Finds the first active Windows Boot Manager in BootOrder on a GPT partition.
pub fn windows_boot_manager(state: &BootState) -> Option<&BootEntry> {
    state.order.iter().find_map(|number| {
        let entry = state.entries.iter().find(|entry| entry.number == *number)?;
        ((entry.option.attributes & LOAD_OPTION_ACTIVE != 0)
            && file_path(&entry.option.device_path)
                .is_some_and(|path| path.eq_ignore_ascii_case(WINDOWS_BOOT_MANAGER))
            && hard_drive_node(&entry.option.device_path)
                .is_some_and(|drive| drive.partition_guid().is_some()))
        .then_some(entry)
    })
}

/// Finds an entry with NvStrapsReBar's exact description and file path.
pub fn owned_entry(state: &BootState, kind: EntryKind) -> Option<u16> {
    state
        .entries
        .iter()
        .find(|entry| entry_kind(entry) == Some(kind))
        .map(|entry| entry.number)
}

/// Creates or rewrites an entry on Windows Boot Manager's partition and schedules it once.
pub fn schedule(state: &BootState, kind: EntryKind) -> Result<(u16, BootChange), String> {
    let windows = windows_boot_manager(state).ok_or("Windows Boot Manager entry is unavailable")?;
    let drive = hard_drive_node(&windows.option.device_path)
        .ok_or("Windows Boot Manager has no GPT hard-drive node")?;
    let number = match owned_entry(state, kind) {
        Some(number) => number,
        None => free_number(state).ok_or("no free Boot#### number remains")?,
    };
    let option = LoadOption {
        attributes: LOAD_OPTION_ACTIVE,
        description: description(kind).to_owned(),
        device_path: partition_file_device_path(&drive, entry_path(kind)),
        optional_data: Vec::new(),
    };
    let mut order = state.order.clone();
    let order_change = if order.contains(&number) {
        None
    } else {
        order.push(number);
        Some(order)
    };
    Ok((
        number,
        BootChange {
            write: vec![(number, encode_load_option(&option))],
            order: order_change,
            next: Some(Some(number)),
            ..BootChange::default()
        },
    ))
}

/// Moves the owned loader entry to the beginning of BootOrder.
pub fn make_first(state: &BootState) -> Result<BootChange, String> {
    let loader = owned_entry(state, EntryKind::Loader).ok_or("loader boot entry is unavailable")?;
    let mut order = state.order.clone();
    order.retain(|number| *number != loader);
    order.insert(0, loader);
    Ok(BootChange {
        order: (order != state.order).then_some(order),
        ..BootChange::default()
    })
}

/// Deletes all owned entries without modifying foreign Boot#### variables.
pub fn remove_owned(state: &BootState) -> BootChange {
    let owned = state
        .entries
        .iter()
        .filter(|entry| entry_kind(entry).is_some())
        .map(|entry| entry.number)
        .collect::<HashSet<_>>();
    let mut delete = owned.iter().copied().collect::<Vec<_>>();
    delete.sort_unstable();
    let order = state
        .order
        .iter()
        .copied()
        .filter(|number| !owned.contains(number))
        .collect::<Vec<_>>();
    BootChange {
        delete,
        order: (order != state.order).then_some(order),
        next: state
            .next
            .is_some_and(|number| owned.contains(&number))
            .then_some(None),
        ..BootChange::default()
    }
}

pub fn loader_first(state: &BootState) -> bool {
    owned_entry(state, EntryKind::Loader).is_some_and(|loader| state.order.first() == Some(&loader))
}

pub fn scheduled(state: &BootState) -> Option<EntryKind> {
    let next = state.next?;
    state
        .entries
        .iter()
        .find(|entry| entry.number == next)
        .and_then(entry_kind)
}

fn entry_kind(entry: &BootEntry) -> Option<EntryKind> {
    [EntryKind::Diagnostic, EntryKind::Loader]
        .into_iter()
        .find(|kind| {
            entry.option.description == description(*kind)
                && file_path(&entry.option.device_path)
                    .is_some_and(|path| path.eq_ignore_ascii_case(entry_path(*kind)))
        })
}

fn description(kind: EntryKind) -> &'static str {
    match kind {
        EntryKind::Diagnostic => DIAGNOSTIC_DESCRIPTION,
        EntryKind::Loader => LOADER_DESCRIPTION,
    }
}

fn entry_path(kind: EntryKind) -> &'static str {
    match kind {
        EntryKind::Diagnostic => ESP_DIAGNOSTIC,
        EntryKind::Loader => ESP_LOADER,
    }
}

fn free_number(state: &BootState) -> Option<u16> {
    let used = state
        .order
        .iter()
        .copied()
        .chain(state.entries.iter().map(|entry| entry.number))
        .collect::<HashSet<_>>();
    (u16::MIN..=u16::MAX).find(|number| !used.contains(number))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::load_option::{HardDrive, decode_load_option};

    fn drive() -> HardDrive {
        HardDrive {
            partition_number: 2,
            start_lba: 2048,
            size_lba: 500_000,
            signature: [
                0x78, 0x56, 0x34, 0x12, 0xbc, 0x9a, 0xf0, 0xde, 1, 2, 3, 4, 5, 6, 7, 8,
            ],
            mbr_type: 2,
            signature_type: 2,
        }
    }

    fn option(description: &str, path: &str) -> LoadOption {
        LoadOption {
            attributes: LOAD_OPTION_ACTIVE,
            description: description.to_owned(),
            device_path: partition_file_device_path(&drive(), path),
            optional_data: Vec::new(),
        }
    }

    fn initial() -> BootState {
        BootState {
            order: vec![7, 4, 9],
            next: None,
            current: Some(4),
            entries: vec![
                BootEntry {
                    number: 4,
                    option: option("Windows Boot Manager", WINDOWS_BOOT_MANAGER),
                },
                BootEntry {
                    number: 7,
                    option: option("Foreign first", "\\EFI\\Other\\first.efi"),
                },
                BootEntry {
                    number: 9,
                    option: option("Foreign last", "\\EFI\\Other\\last.efi"),
                },
            ],
        }
    }

    fn apply(state: &mut BootState, change: &BootChange) {
        for number in &change.delete {
            state.entries.retain(|entry| entry.number != *number);
        }
        for (number, bytes) in &change.write {
            let option = decode_load_option(bytes).unwrap();
            state.entries.retain(|entry| entry.number != *number);
            state.entries.push(BootEntry {
                number: *number,
                option,
            });
        }
        if let Some(order) = &change.order {
            state.order.clone_from(order);
        }
        if let Some(next) = change.next {
            state.next = next;
        }
    }

    #[test]
    fn schedule_and_remove_never_write_or_delete_foreign_numbers() {
        let mut state = initial();
        let foreign = state
            .entries
            .iter()
            .map(|entry| (entry.number, entry.option.clone()))
            .collect::<Vec<_>>();
        let (_, schedule) = schedule(&state, EntryKind::Loader).unwrap();
        assert!(schedule.write.iter().all(|(number, _)| *number == 0));
        assert!(schedule.delete.is_empty());
        apply(&mut state, &schedule);
        let removal = remove_owned(&state);
        assert_eq!(removal.delete, vec![0]);
        assert!(removal.write.is_empty());
        apply(&mut state, &removal);
        for (number, option) in foreign {
            assert_eq!(
                state
                    .entries
                    .iter()
                    .find(|entry| entry.number == number)
                    .map(|entry| &entry.option),
                Some(&option)
            );
        }
    }

    #[test]
    fn boot_order_keeps_every_foreign_number_in_relative_order() {
        let mut state = initial();
        let (_, diagnostic) = schedule(&state, EntryKind::Diagnostic).unwrap();
        apply(&mut state, &diagnostic);
        let (_, loader) = schedule(&state, EntryKind::Loader).unwrap();
        apply(&mut state, &loader);
        let first = make_first(&state).unwrap();
        apply(&mut state, &first);
        let foreign = state
            .order
            .iter()
            .copied()
            .filter(|number| [7, 4, 9].contains(number))
            .collect::<Vec<_>>();
        assert_eq!(foreign, vec![7, 4, 9]);
    }

    #[test]
    fn repeated_schedule_reuses_and_rewrites_the_same_number() {
        let mut state = initial();
        let (first_number, first) = schedule(&state, EntryKind::Loader).unwrap();
        apply(&mut state, &first);
        let (second_number, second) = schedule(&state, EntryKind::Loader).unwrap();
        assert_eq!(first_number, second_number);
        assert_eq!(second.write[0].0, first_number);
        assert_eq!(second.order, None);
    }

    #[test]
    fn removing_a_newly_scheduled_entry_restores_original_boot_order() {
        let mut state = initial();
        let original = state.order.clone();
        let (_, change) = schedule(&state, EntryKind::Loader).unwrap();
        apply(&mut state, &change);
        let removal = remove_owned(&state);
        apply(&mut state, &removal);
        assert_eq!(state.order, original);
        assert_eq!(state.next, None);
    }
}
