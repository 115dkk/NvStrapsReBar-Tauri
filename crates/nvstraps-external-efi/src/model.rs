//! Explicitly synthetic GPU. Debug-only; exercised by a real OVMF disk-loaded EFI.
use alloc::vec;
use nvstraps_external::{
    execute::{Machine, Register},
    *,
};
pub struct Model {
    pub source: Snapshot,
    regs: [u32; 5],
    reserved: bool,
}
impl Model {
    pub fn new() -> Self {
        let slot = Slot {
            segment: 0,
            bus: 1,
            device: 0,
            function: 0,
        };
        Self {
            source: Snapshot {
                schema: SCHEMA,
                environment: Environment::QemuModel,
                machine: "QEMU synthetic Turing model v1".into(),
                firmware: "model-v1".into(),
                enumeration_complete: true,
                secure_boot: Some(false),
                s3_save_state: false,
                roots: vec![Root {
                    segment: 0,
                    first_bus: 0,
                    last_bus: 255,
                    memory: vec![Span {
                        start: 0x100000000,
                        end: 0x1000000000,
                    }],
                }],
                devices: vec![Device {
                    slot,
                    vendor: 0x10de,
                    product: 0x1e84,
                    subsystem: 0x1234,
                    class: 0x030000,
                    command: 6,
                    bars: vec![
                        Bar {
                            index: 0,
                            span: Span {
                                start: 0xc0000000,
                                end: 0xc1000000,
                            },
                            memory: true,
                            prefetchable: false,
                            width64: false,
                            raw_low: 0xc0000000,
                        },
                        Bar {
                            index: 1,
                            span: Span {
                                start: 0x100000000,
                                end: 0x110000000,
                            },
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
                }],
                available_mmio: vec![Span {
                    start: 0x200000000,
                    end: 0x1000000000,
                }],
                errors: vec![],
            },
            regs: [6, 12, 1, 0x80008000, 0x80000000],
            reserved: false,
        }
    }
}
impl Default for Model {
    fn default() -> Self {
        Self::new()
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
impl Machine for Model {
    fn snapshot(&mut self) -> Result<Snapshot, &'static str> {
        Ok(self.source.clone())
    }
    fn reserve(&mut self, _: Span) -> Result<(), &'static str> {
        if self.reserved {
            return Err("model already reserved");
        }
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
        self.regs[index(r)] = v;
        Ok(())
    }
    fn aperture(&mut self) -> Result<u64, &'static str> {
        if self.regs[0] & 6 != 0 {
            return Err("model decoding still active");
        }
        Ok((64_u64 << 20) << (((self.regs[3] >> 14) & 3) + ((self.regs[4] >> 20) & 7)))
    }
}
