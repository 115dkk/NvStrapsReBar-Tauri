use crate::{Plan, Snapshot, Span, validate_plan};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Register {
    Command,
    Bar1Low,
    Bar1High,
    Strap0,
    Strap1,
}

pub trait Machine {
    fn snapshot(&mut self) -> Result<Snapshot, &'static str>;
    fn reserve(&mut self, span: Span) -> Result<(), &'static str>;
    fn release(&mut self, span: Span) -> Result<(), &'static str>;
    fn read(&mut self, register: Register) -> Result<u32, &'static str>;
    fn write(&mut self, register: Register, value: u32) -> Result<(), &'static str>;
    /// Must quiesce memory decoding and measure the actual hardware mask, not a cached PCI_IO length.
    fn aperture(&mut self) -> Result<u64, &'static str>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Saved {
    pub command: u32,
    pub low: u32,
    pub high: u32,
    pub straps: [u32; 2],
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Applied {
    pub saved: Saved,
    pub destination: Span,
    pub measured_bytes: u64,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Failure {
    pub reason: &'static str,
    pub rollback_failed: bool,
}

pub fn apply(machine: &mut impl Machine, plan: &Plan) -> Result<Applied, Failure> {
    let fail = |reason| Failure {
        reason,
        rollback_failed: false,
    };
    let current = machine.snapshot().map_err(fail)?;
    validate_plan(plan, &current).map_err(|_| fail("stale or invalid deployment plan"))?;
    let saved = Saved {
        command: machine.read(Register::Command).map_err(fail)?,
        low: machine.read(Register::Bar1Low).map_err(fail)?,
        high: machine.read(Register::Bar1High).map_err(fail)?,
        straps: [
            machine.read(Register::Strap0).map_err(fail)?,
            machine.read(Register::Strap1).map_err(fail)?,
        ],
    };
    let gpu = current
        .devices
        .iter()
        .find(|d| d.slot == plan.target)
        .ok_or_else(|| fail("target disappeared"))?;
    let bar = gpu
        .bars
        .iter()
        .find(|b| b.index == 1)
        .ok_or_else(|| fail("BAR1 disappeared"))?;
    if saved.command != u32::from(gpu.command)
        || saved.straps != gpu.straps.unwrap_or([0; 2])
        || (u64::from(saved.high) << 32 | u64::from(saved.low & !15)) != bar.span.start
    {
        return Err(fail("live registers differ from diagnostic"));
    }
    machine.reserve(plan.destination).map_err(fail)?;
    let operation = (|| {
        write_checked(machine, Register::Command, saved.command & !6)?;
        write_checked(
            machine,
            Register::Bar1High,
            (plan.destination.start >> 32) as u32,
        )?;
        write_checked(
            machine,
            Register::Bar1Low,
            plan.destination.start as u32 | (saved.low & 15),
        )?;
        // BAR0 must decode while programming straps. BAR1 already points into an
        // exclusively reserved, non-overlapping destination; DMA remains disabled.
        write_checked(machine, Register::Command, (saved.command & !4) | 2)?;
        let selector = plan.size.trailing_zeros() as u8 - 26;
        let straps =
            nvstraps_core::straps::plan_bar1_straps(saved.straps[0], saved.straps[1], selector)
                .map_err(|_| "invalid strap size")?;
        if let Some(s) = straps.set0 {
            write_checked(machine, Register::Strap0, s.register_value)?;
        }
        if let Some(s) = straps.set1 {
            write_checked(machine, Register::Strap1, s.register_value)?;
        }
        write_checked(machine, Register::Command, saved.command & !6)?;
        let size = machine.aperture()?;
        if size != plan.size {
            return Err("hardware aperture readback mismatch");
        }
        write_checked(
            machine,
            Register::Bar1High,
            (plan.destination.start >> 32) as u32,
        )?;
        write_checked(
            machine,
            Register::Bar1Low,
            plan.destination.start as u32 | (saved.low & 15),
        )?;
        write_checked(machine, Register::Command, saved.command & !4)?;
        Ok(size)
    })();
    match operation {
        Ok(measured_bytes) => Ok(Applied {
            saved,
            destination: plan.destination,
            measured_bytes,
        }),
        Err(reason) => Err(Failure {
            reason,
            rollback_failed: restore(machine, saved, plan.destination).is_err(),
        }),
    }
}

pub fn restore(
    machine: &mut impl Machine,
    saved: Saved,
    reserved: Span,
) -> Result<(), &'static str> {
    // Never restore the old address while the enlarged aperture still decodes there.
    // If quiescing or restoring straps fails, retain the reservation and stop.
    write_checked(machine, Register::Command, saved.command & !6)?;
    write_checked(machine, Register::Bar1High, (reserved.start >> 32) as u32)?;
    write_checked(
        machine,
        Register::Bar1Low,
        reserved.start as u32 | (saved.low & 15),
    )?;
    write_checked(machine, Register::Command, (saved.command & !4) | 2)?;
    write_checked(machine, Register::Strap0, saved.straps[0])?;
    write_checked(machine, Register::Strap1, saved.straps[1])?;
    write_checked(machine, Register::Command, saved.command & !6)?;
    write_checked(machine, Register::Bar1High, saved.high)?;
    write_checked(machine, Register::Bar1Low, saved.low)?;
    write_checked(machine, Register::Command, saved.command)?;
    machine.release(reserved)
}

fn write_checked(m: &mut impl Machine, r: Register, value: u32) -> Result<(), &'static str> {
    m.write(r, value)?;
    if m.read(r)? != value {
        return Err("register write readback mismatch");
    }
    Ok(())
}
