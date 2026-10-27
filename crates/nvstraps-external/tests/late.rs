use nvstraps_external::execute::*;
use nvstraps_external::*;

fn slot(bus: u8, device: u8) -> Slot {
    Slot {
        segment: 0,
        bus,
        device,
        function: 0,
    }
}
fn span(start: u64, end: u64) -> Span {
    Span { start, end }
}
fn snapshot() -> Snapshot {
    Snapshot {
        schema: SCHEMA,
        environment: Environment::QemuModel,
        machine: "test-board".into(),
        firmware: "test-bios".into(),
        enumeration_complete: true,
        secure_boot: Some(false),
        s3_save_state: false,
        roots: vec![Root {
            segment: 0,
            first_bus: 0,
            last_bus: 255,
            memory: vec![span(0x100000000, 0x1000000000)],
        }],
        devices: vec![
            Device {
                slot: slot(1, 0),
                vendor: 0x10de,
                product: 0x1e84,
                subsystem: 0x1234,
                class: 0x030000,
                command: 6,
                bars: vec![
                    Bar {
                        index: 0,
                        span: span(0xc0000000, 0xc1000000),
                        memory: true,
                        prefetchable: false,
                        width64: false,
                        raw_low: 0xc0000000,
                    },
                    Bar {
                        index: 1,
                        span: span(0x100000000, 0x110000000),
                        memory: true,
                        prefetchable: true,
                        width64: true,
                        raw_low: 12,
                    },
                ],
                bridge: None,
                driver_count: 0,
                console: false,
                straps: Some([0x80008000, 0x80000000]),
            },
            Device {
                slot: slot(0, 1),
                vendor: 0x8086,
                product: 1,
                subsystem: 0,
                class: 0x060400,
                command: 6,
                bars: vec![],
                bridge: Some(Bridge {
                    secondary: 1,
                    subordinate: 1,
                    prefetch: Some(span(0x100000000, 0x1000000000)),
                }),
                driver_count: 1,
                console: false,
                straps: None,
            },
        ],
        available_mmio: vec![span(0x200000000, 0x1000000000)],
        errors: vec![],
    }
}
fn handoff() -> Handoff {
    Handoff {
        path: "\\EFI\\Microsoft\\Boot\\bootmgfw.efi".into(),
        sha256: [1; 32],
    }
}

#[test]
fn plan_errors_serialize_as_frontend_codes() {
    assert_eq!(
        serde_json::to_string(&PlanError::ConsoleInUse).unwrap(),
        "\"consoleInUse\""
    );
}
fn plan(s: &Snapshot) -> Plan {
    make_plan(s, slot(1, 0), 8 << 30, handoff()).unwrap()
}

#[test]
fn plan_respects_alignment_other_functions_and_every_parent() {
    let mut s = snapshot();
    assert_eq!(plan(&s).destination, span(0x200000000, 0x400000000));
    let mut sibling = s.devices[0].clone();
    sibling.slot.function = 1;
    sibling.product = 42;
    sibling.bars = vec![Bar {
        index: 0,
        span: span(0x200000000, 0x201000000),
        memory: true,
        prefetchable: true,
        width64: true,
        raw_low: 12,
    }];
    s.devices.push(sibling);
    assert_eq!(plan(&s).destination.start, 0x400000000);
    s.devices[1].bridge.as_mut().unwrap().prefetch = Some(span(0x100000000, 0x400000000));
    assert_eq!(
        make_plan(&s, slot(1, 0), 8 << 30, handoff()),
        Err(PlanError::NoAddressSpace)
    );
}
#[test]
fn active_console_incomplete_and_unknown_reports_never_authorize_writes() {
    for mutate in [0, 1, 2, 3] {
        let mut s = snapshot();
        match mutate {
            0 => s.devices[0].console = true,
            1 => s.devices[0].driver_count = 1,
            2 => s.errors.push("read failed".into()),
            _ => s.devices[0].vendor = 0x1002,
        }
        assert!(make_plan(&s, slot(1, 0), 8 << 30, handoff()).is_err());
    }
}

#[test]
fn missing_bridge_in_the_path_is_not_treated_as_an_unrestricted_root_window() {
    let mut s = snapshot();
    s.devices.pop();
    assert_eq!(
        make_plan(&s, slot(1, 0), 8 << 30, handoff()),
        Err(PlanError::AmbiguousTopology)
    );
    s.roots[0].first_bus = 1;
    assert!(make_plan(&s, slot(1, 0), 8 << 30, handoff()).is_ok());
}
#[test]
fn stale_identity_and_forged_destination_are_rejected() {
    let s = snapshot();
    let mut p = plan(&s);
    p.destination.start += 0x1000;
    assert_eq!(validate_plan(&p, &s), Err(PlanError::InvalidPlan));
    let p = plan(&s);
    let mut changed = s.clone();
    changed.firmware.push('x');
    assert_eq!(validate_plan(&p, &changed), Err(PlanError::StaleSnapshot));
}

struct Fake {
    source: Snapshot,
    regs: [u32; 5],
    reserved: bool,
    writes: usize,
    fail: Option<usize>,
    fail_restore: bool,
}
impl Fake {
    fn new() -> Self {
        Self {
            source: snapshot(),
            regs: [6, 12, 1, 0x80008000, 0x80000000],
            reserved: false,
            writes: 0,
            fail: None,
            fail_restore: false,
        }
    }
}
fn index(r: Register) -> usize {
    match r {
        Register::Command => 0,
        Register::Bar1Low => 1,
        Register::Bar1High => 2,
        Register::Strap0 => 3,
        Register::Strap1 => 4,
    }
}
impl Machine for Fake {
    fn snapshot(&mut self) -> Result<Snapshot, &'static str> {
        Ok(self.source.clone())
    }
    fn reserve(&mut self, _: Span) -> Result<(), &'static str> {
        assert!(!self.reserved);
        self.reserved = true;
        Ok(())
    }
    fn release(&mut self, _: Span) -> Result<(), &'static str> {
        self.reserved = false;
        Ok(())
    }
    fn read(&mut self, r: Register) -> Result<u32, &'static str> {
        Ok(self.regs[index(r)])
    }
    fn write(&mut self, r: Register, v: u32) -> Result<(), &'static str> {
        self.writes += 1;
        if self.fail == Some(self.writes) || (self.fail_restore && self.writes >= 5) {
            return Err("injected write failure");
        }
        self.regs[index(r)] = v;
        Ok(())
    }
    fn aperture(&mut self) -> Result<u64, &'static str> {
        assert_eq!(self.regs[0] & 6, 0);
        // Independently decode the Turing register fields; do not return the plan's size.
        let part1 = (self.regs[3] >> 14) & 3;
        let part2 = (self.regs[4] >> 20) & 7;
        Ok((64_u64 << 20) << (part1 + part2))
    }
}
#[test]
fn actual_transaction_relocates_and_measures_eight_gib_then_restores() {
    let mut m = Fake::new();
    let old = m.regs;
    let p = plan(&m.source);
    let applied = apply(&mut m, &p).unwrap();
    assert_eq!(applied.measured_bytes, 8 << 30);
    assert_eq!(m.regs[2], 2);
    assert_eq!(m.regs[4] & 0x700000, 0x500000);
    assert_eq!(m.regs[0] & 4, 0);
    assert!(m.reserved);
    restore(&mut m, applied.saved, applied.destination).unwrap();
    assert_eq!(m.regs, old);
    assert!(!m.reserved);
}
#[test]
fn every_single_write_failure_restores_and_releases() {
    let mut baseline = Fake::new();
    let p = plan(&baseline.source);
    apply(&mut baseline, &p).unwrap();
    for fail in 1..=baseline.writes {
        let mut m = Fake::new();
        let old = m.regs;
        m.fail = Some(fail);
        let error = apply(&mut m, &p).unwrap_err();
        assert!(!error.rollback_failed, "write {fail}");
        assert_eq!(m.regs, old, "write {fail}");
        assert!(!m.reserved);
    }
}
#[test]
fn failed_rollback_retains_destination_reservation() {
    let mut m = Fake::new();
    m.fail_restore = true;
    let p = plan(&m.source);
    assert!(apply(&mut m, &p).unwrap_err().rollback_failed);
    assert!(m.reserved);
}
#[test]
fn stale_snapshot_performs_no_write_or_reservation() {
    let mut m = Fake::new();
    let p = plan(&m.source);
    m.source.devices[0].subsystem += 1;
    assert!(apply(&mut m, &p).is_err());
    assert_eq!(m.writes, 0);
    assert!(!m.reserved);
}
