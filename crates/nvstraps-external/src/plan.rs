use crate::*;
use alloc::vec::Vec;

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PlanError {
    InvalidReport,
    IncompleteReport,
    NoTarget,
    UnsupportedGpu,
    ActiveDriver,
    ConsoleInUse,
    InvalidBar,
    InvalidSize,
    NoRoot,
    AmbiguousTopology,
    NoAddressSpace,
    InvalidHandoff,
    StaleSnapshot,
    InvalidPlan,
}

pub fn make_plan(
    source: &Snapshot,
    target: Slot,
    size: u64,
    handoff: Handoff,
) -> Result<Plan, PlanError> {
    validate_snapshot(source)?;
    if !valid_handoff(&handoff) {
        return Err(PlanError::InvalidHandoff);
    }
    if !size.is_power_of_two() || !(512 * 1024 * 1024..=32 * 1024 * 1024 * 1024).contains(&size) {
        return Err(PlanError::InvalidSize);
    }
    let gpu = source
        .devices
        .iter()
        .find(|d| d.slot == target)
        .ok_or(PlanError::NoTarget)?;
    if gpu.vendor != 0x10de
        || !nvstraps_core::registry::is_turing(gpu.product)
        || gpu.class >> 16 != 3
        || nvstraps_core::registry::registry_bar_size(gpu.product)
            == Some(nvstraps_core::registry::BAR_SIZE_EXCLUDED)
    {
        return Err(PlanError::UnsupportedGpu);
    }
    if gpu.console {
        return Err(PlanError::ConsoleInUse);
    }
    if gpu.driver_count != 0 {
        return Err(PlanError::ActiveDriver);
    }
    let bar0 = gpu
        .bars
        .iter()
        .find(|b| b.index == 0)
        .ok_or(PlanError::InvalidBar)?;
    let bar1 = gpu
        .bars
        .iter()
        .find(|b| b.index == 1)
        .ok_or(PlanError::InvalidBar)?;
    if !bar0.memory
        || !bar1.memory
        || !bar1.width64
        || !bar1.prefetchable
        || gpu.straps.is_none()
        || bar0.span.end - bar0.span.start < 0x101010
        || size <= bar1.span.end - bar1.span.start
    {
        return Err(PlanError::InvalidBar);
    }
    let roots: Vec<_> = source
        .roots
        .iter()
        .filter(|r| {
            r.segment == target.segment && r.first_bus <= target.bus && target.bus <= r.last_bus
        })
        .collect();
    if roots.len() != 1 {
        return Err(PlanError::NoRoot);
    }
    let mut windows = roots[0].memory.clone();
    let mut parents: Vec<_> = source
        .devices
        .iter()
        .filter(|d| d.slot.segment == target.segment)
        .filter_map(|d| {
            d.bridge
                .as_ref()
                .filter(|b| {
                    b.secondary > d.slot.bus
                        && b.secondary <= target.bus
                        && target.bus <= b.subordinate
                })
                .map(|b| (d, b))
        })
        .collect();
    parents.sort_by_key(|(_, b)| b.secondary);
    if parents
        .first()
        .map_or(target.bus != roots[0].first_bus, |(d, _)| {
            d.slot.bus != roots[0].first_bus
        })
        || parents
            .last()
            .is_some_and(|(_, b)| b.secondary != target.bus)
    {
        return Err(PlanError::AmbiguousTopology);
    }
    for pair in parents.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        if a.0.slot == b.0.slot
            || a.1.secondary != b.0.slot.bus
            || b.0.slot.bus > a.1.subordinate
            || a.1.secondary == b.1.secondary
        {
            return Err(PlanError::AmbiguousTopology);
        }
    }
    for (_, bridge) in parents {
        let aperture = bridge.prefetch.ok_or(PlanError::NoAddressSpace)?;
        windows = windows
            .into_iter()
            .filter_map(|w| w.intersection(aperture))
            .collect();
    }
    // Never enlarge a root/bridge aperture from guessed ACPI capacity. Only allocate
    // inside existing decode windows and GCD space that the firmware can reserve for us.
    let mut candidates = Vec::new();
    for window in windows {
        for free in &source.available_mmio {
            let Some(span) = window.intersection(*free) else {
                continue;
            };
            let Some(rounded) = span.start.max(1_u64 << 32).checked_add(size - 1) else {
                continue;
            };
            let mut base = rounded & !(size - 1);
            while let Some(candidate) = Span::from_size(base, size).filter(|s| span.contains(*s)) {
                let collision = source
                    .devices
                    .iter()
                    .flat_map(|d| &d.bars)
                    .filter(|b| b.memory)
                    .filter(|b| b.span.overlaps(candidate))
                    .map(|b| b.span.end)
                    .max();
                if let Some(end) = collision {
                    let Some(next) = end.checked_add(size - 1) else {
                        break;
                    };
                    base = next & !(size - 1);
                } else {
                    candidates.push(candidate);
                    break;
                }
            }
        }
    }
    candidates.sort_by_key(|s| s.start);
    let destination = *candidates.first().ok_or(PlanError::NoAddressSpace)?;
    Ok(Plan {
        schema: SCHEMA,
        source: source.clone(),
        source_sha256: snapshot_digest(source).map_err(|_| PlanError::InvalidReport)?,
        target,
        size,
        destination,
        handoff,
    })
}

pub fn validate_plan(plan: &Plan, current: &Snapshot) -> Result<(), PlanError> {
    if plan.schema != SCHEMA
        || snapshot_digest(current).map_err(|_| PlanError::InvalidReport)? != plan.source_sha256
        || current != &plan.source
    {
        return Err(PlanError::StaleSnapshot);
    }
    let expected = make_plan(current, plan.target, plan.size, plan.handoff.clone())?;
    if &expected != plan {
        return Err(PlanError::InvalidPlan);
    }
    Ok(())
}

pub fn valid_handoff(h: &Handoff) -> bool {
    h.path.starts_with('\\')
        && h.path.to_ascii_lowercase().ends_with(".efi")
        && h.path.len() <= 240
        && !h.path.contains('/')
        && !h.path.contains(':')
        && !h.path.contains("..")
        && !h.path.contains('\0')
        && h.sha256 != [0; 32]
}

pub fn validate_snapshot(s: &Snapshot) -> Result<(), PlanError> {
    if s.schema != SCHEMA
        || s.machine.is_empty()
        || s.firmware.is_empty()
        || s.machine.len() > 1024
        || s.firmware.len() > 1024
        || s.devices.len() > 1024
        || s.roots.len() > 64
        || s.available_mmio.len() > 4096
    {
        return Err(PlanError::InvalidReport);
    }
    if !s.errors.is_empty() || !s.enumeration_complete {
        return Err(PlanError::IncompleteReport);
    }
    for (i, d) in s.devices.iter().enumerate() {
        if d.slot.device > 31
            || d.slot.function > 7
            || d.bars.len() > 6
            || s.devices[..i].iter().any(|x| x.slot == d.slot)
        {
            return Err(PlanError::InvalidReport);
        }
        for (j, b) in d.bars.iter().enumerate() {
            if b.index > 5
                || !b.span.valid()
                || d.bars[..j].iter().any(|x| x.index == b.index)
                || !(b.span.end - b.span.start).is_power_of_two()
                || !b.span.start.is_multiple_of(b.span.end - b.span.start)
                || (b.width64 && (!b.memory || b.index == 5))
            {
                return Err(PlanError::InvalidReport);
            }
        }
    }
    if s.available_mmio.iter().any(|s| !s.valid())
        || s.roots.iter().any(|r| {
            r.first_bus > r.last_bus || r.memory.len() > 256 || r.memory.iter().any(|s| !s.valid())
        })
    {
        return Err(PlanError::InvalidReport);
    }
    Ok(())
}
