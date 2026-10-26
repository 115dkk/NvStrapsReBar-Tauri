use alloc::{format, string::String, vec::Vec};
use core::{
    ffi::c_void,
    ptr::{self, NonNull},
    slice,
};
use nvstraps_external::{
    execute::{Machine, Register},
    *,
};
use uefi::{
    Guid, Handle, Identify, Status, StatusExt,
    boot::{self, OpenProtocolAttributes, OpenProtocolParams, ScopedProtocol, SearchType},
    proto::{pci::root_bridge::PciRootBridgeIo, unsafe_protocol},
};

type PciRead = unsafe extern "efiapi" fn(*mut PciIo, u32, u32, usize, *mut c_void) -> Status;
type PciWrite = unsafe extern "efiapi" fn(*mut PciIo, u32, u32, usize, *const c_void) -> Status;
type MemRead = unsafe extern "efiapi" fn(*mut PciIo, u32, u8, u64, usize, *mut c_void) -> Status;
type MemWrite = unsafe extern "efiapi" fn(*mut PciIo, u32, u8, u64, usize, *const c_void) -> Status;

/// UEFI 2.11 PCI_IO ABI, including unused slots to preserve offsets.
#[repr(C)]
#[unsafe_protocol("4cf5b200-68b8-4ca5-9eec-b23e3f50029a")]
pub struct PciIo {
    poll_mem: usize,
    poll_io: usize,
    mem_read: MemRead,
    mem_write: MemWrite,
    io: [usize; 2],
    pci_read: PciRead,
    pci_write: PciWrite,
    copy: usize,
    map: usize,
    unmap: usize,
    allocate: usize,
    free: usize,
    flush: usize,
    location: unsafe extern "efiapi" fn(
        *const Self,
        *mut usize,
        *mut usize,
        *mut usize,
        *mut usize,
    ) -> Status,
    attributes: usize,
    bar: unsafe extern "efiapi" fn(*const Self, u8, *mut u64, *mut *mut u8) -> Status,
    set_bar: usize,
    rom_size: u64,
    rom_image: *const c_void,
}

pub fn open<T: uefi::proto::ProtocolPointer + ?Sized>(
    h: Handle,
) -> Result<ScopedProtocol<T>, &'static str> {
    // SAFETY: The enumerated handle supports T; GET_PROTOCOL does not start/stop its driver.
    unsafe {
        boot::open_protocol::<T>(
            OpenProtocolParams {
                handle: h,
                agent: boot::image_handle(),
                controller: None,
            },
            OpenProtocolAttributes::GetProtocol,
        )
    }
    .map_err(|_| "open protocol failed")
}
pub fn handles<T: uefi::proto::ProtocolPointer + ?Sized>() -> Result<Vec<Handle>, &'static str> {
    match boot::locate_handle_buffer(SearchType::from_proto::<T>()) {
        Ok(h) if h.len() <= 1024 => Ok(h.iter().copied().collect()),
        Err(e) if e.status() == Status::NOT_FOUND => Ok(Vec::new()),
        _ => Err("protocol handle census failed"),
    }
}
fn cfg(io: &mut PciIo, offset: u32) -> Result<u32, &'static str> {
    let mut value = 0;
    // SAFETY: PCI config read is one aligned u32 into a live stack value.
    unsafe { (io.pci_read)(io, 2, offset, 1, ptr::from_mut(&mut value).cast()) }
        .to_result()
        .map_err(|_| "PCI read failed")?;
    Ok(value)
}
fn cfg_write(io: &mut PciIo, offset: u32, value: u32, width: u32) -> Result<(), &'static str> {
    // SAFETY: Callers select Command u16 or aligned BAR u32, after plan validation.
    unsafe { (io.pci_write)(io, width, offset, 1, ptr::from_ref(&value).cast()) }
        .to_result()
        .map_err(|_| "PCI write failed")
}
fn strap(io: &mut PciIo, offset: u64) -> Result<u32, &'static str> {
    let mut value = 0;
    // SAFETY: Only called after BAR0 bounds and Turing identity validation.
    unsafe { (io.mem_read)(io, 2, 0, offset, 1, ptr::from_mut(&mut value).cast()) }
        .to_result()
        .map_err(|_| "BAR0 strap read failed")?;
    Ok(value)
}
fn location(io: &PciIo) -> Result<Slot, &'static str> {
    let (mut s, mut b, mut d, mut f) = (0, 0, 0, 0);
    // SAFETY: Four writable usize outputs match GetLocation ABI.
    unsafe { (io.location)(io, &mut s, &mut b, &mut d, &mut f) }
        .to_result()
        .map_err(|_| "PCI location failed")?;
    Ok(Slot {
        segment: s.try_into().map_err(|_| "segment overflow")?,
        bus: b.try_into().map_err(|_| "bus overflow")?,
        device: d.try_into().map_err(|_| "device overflow")?,
        function: f.try_into().map_err(|_| "function overflow")?,
    })
}
fn bar(io: &PciIo, index: u8, raw: u32) -> Result<Option<Bar>, &'static str> {
    let mut buffer = ptr::null_mut();
    let mut supported = 0;
    // SAFETY: Firmware returns its allocated resource descriptor buffer. We consume
    // only one complete QWORD descriptor and release the returned pool allocation.
    let result = unsafe { (io.bar)(io, index, &mut supported, &mut buffer) };
    if result == Status::UNSUPPORTED && raw == 0 {
        return Ok(None);
    }
    result
        .to_result()
        .map_err(|_| "BAR attributes unavailable")?;
    let p = NonNull::new(buffer).ok_or("null BAR descriptor")?;
    // SAFETY: successful GetBarAttributes supplies an ACPI resource descriptor;
    // inspect its 3-byte prefix before reading the specified fixed 46-byte record.
    let parsed = unsafe {
        let head = slice::from_raw_parts(p.as_ptr(), 3);
        if head != [0x8a, 0x2b, 0] {
            Err("unsupported BAR descriptor")
        } else {
            let bytes = slice::from_raw_parts(p.as_ptr(), 46);
            let base = u64::from_le_bytes(bytes[14..22].try_into().unwrap());
            let len = u64::from_le_bytes(bytes[38..46].try_into().unwrap());
            let translation = u64::from_le_bytes(bytes[30..38].try_into().unwrap());
            if translation != 0 {
                Err("translated BAR unsupported")
            } else {
                Span::from_size(base, len)
                    .map(|span| {
                        Some(Bar {
                            index,
                            span,
                            memory: bytes[3] == 0,
                            prefetchable: raw & 8 != 0,
                            width64: raw & 7 == 4,
                            raw_low: raw,
                        })
                    })
                    .ok_or("invalid BAR extent")
            }
        }
    };
    // SAFETY: buffer is exactly the allocation returned by GetBarAttributes.
    unsafe { boot::free_pool(p) }.map_err(|_| "BAR descriptor release failed")?;
    parsed
}
fn drivers(handle: Handle) -> Result<u32, &'static str> {
    let mut entries = ptr::null();
    let mut count = 0;
    let st = uefi::table::system_table_raw().ok_or("system table absent")?;
    // SAFETY: Boot Services are active; successful OpenProtocolInformation returns
    // count records in an allocated buffer, bounded before iteration and freed once.
    unsafe {
        let bs = st
            .as_ref()
            .boot_services
            .as_ref()
            .ok_or("boot services absent")?;
        (bs.open_protocol_information)(handle.as_ptr(), &PciIo::GUID, &mut entries, &mut count)
            .to_result()
            .map_err(|_| "PCI ownership unavailable")?;
        let p = NonNull::new(entries.cast_mut().cast::<u8>());
        if count > 4096 || (count > 0 && p.is_none()) {
            return Err("invalid PCI ownership records");
        }
        let owners = if count == 0 {
            0
        } else {
            slice::from_raw_parts(entries, count)
                .iter()
                .filter(|e| e.attributes & 0x10 != 0)
                .count() as u32
        };
        if let Some(p) = p {
            boot::free_pool(p).map_err(|_| "PCI ownership buffer release failed")?;
        }
        Ok(owners)
    }
}

#[repr(C)]
struct GcdEntry {
    base: u64,
    len: u64,
    capabilities: u64,
    attributes: u64,
    kind: u32,
    image: *mut c_void,
    device: *mut c_void,
}
#[repr(C)]
struct Dxe {
    header: [u64; 3],
    add: usize,
    allocate: unsafe extern "efiapi" fn(
        u32,
        u32,
        usize,
        u64,
        *mut u64,
        *mut c_void,
        *mut c_void,
    ) -> Status,
    free: unsafe extern "efiapi" fn(u64, u64) -> Status,
    remove: usize,
    descriptor: usize,
    attributes: usize,
    map: unsafe extern "efiapi" fn(*mut usize, *mut *mut GcdEntry) -> Status,
}
fn table(guid: Guid) -> Option<NonNull<u8>> {
    uefi::system::with_config_table(|t| {
        t.iter()
            .find(|x| x.guid == guid)
            .and_then(|e| NonNull::new(e.address.cast_mut().cast()))
    })
}
fn dxe() -> Result<&'static Dxe, &'static str> {
    let p =
        table(uefi::guid!("05ad34ba-6f02-4214-952e-4da0398e2bb9")).ok_or("DXE services absent")?;
    // SAFETY: PI configuration table owns the service table for Boot Services lifetime.
    let d = unsafe { p.cast::<Dxe>().as_ref() };
    if d.header[0] != 0x565245535f455844 || (d.header[1] >> 32) < core::mem::size_of::<Dxe>() as u64
    {
        return Err("invalid DXE services table");
    }
    Ok(d)
}
fn free_mmio() -> Result<Vec<Span>, &'static str> {
    let d = dxe()?;
    let mut count = 0;
    let mut p = ptr::null_mut();
    // SAFETY: GetMemorySpaceMap returns an allocated array of count descriptors;
    // bound the count before iteration and return the pool to its owner once.
    unsafe {
        (d.map)(&mut count, &mut p)
            .to_result()
            .map_err(|_| "GCD map failed")?;
        let ptr = NonNull::new(p).ok_or("null GCD map")?;
        if count > 4096 {
            boot::free_pool(ptr.cast()).map_err(|_| "GCD release failed")?;
            return Err("GCD map exceeds limit");
        }
        let mut out = Vec::new();
        for e in slice::from_raw_parts(ptr.as_ptr(), count) {
            if e.kind == 3 && e.image.is_null() && e.device.is_null() {
                out.push(Span::from_size(e.base, e.len).ok_or("invalid GCD span")?);
            }
        }
        boot::free_pool(ptr.cast()).map_err(|_| "GCD release failed")?;
        Ok(out)
    }
}

fn machine_identity() -> Result<String, &'static str> {
    let p = table(uefi::table::cfg::ConfigTableEntry::SMBIOS3_GUID)
        .ok_or("SMBIOS3 machine identity unavailable")?;
    // SAFETY: the system configuration table provides the SMBIOS3 entry. Validate
    // its anchor, checksum and bounded table size before walking firmware records.
    unsafe {
        let entry = slice::from_raw_parts(p.as_ptr(), 24);
        if &entry[..5] != b"_SM3_"
            || entry[6] != 24
            || entry.iter().fold(0u8, |a, b| a.wrapping_add(*b)) != 0
        {
            return Err("invalid SMBIOS3 entry");
        }
        let len = u32::from_le_bytes(entry[12..16].try_into().unwrap()) as usize;
        let addr = u64::from_le_bytes(entry[16..24].try_into().unwrap());
        if len == 0 || len > 1024 * 1024 || addr == 0 {
            return Err("invalid SMBIOS bounds");
        }
        let bytes = slice::from_raw_parts(addr as *const u8, len);
        let mut at = 0;
        let mut selected = Vec::new();
        let mut board = false;
        for _ in 0..4096 {
            if at + 4 > bytes.len() {
                break;
            }
            let kind = bytes[at];
            let head = usize::from(bytes[at + 1]);
            if head < 4 || at + head > bytes.len() {
                return Err("invalid SMBIOS record");
            }
            let mut end = at + head;
            while end + 1 < bytes.len() && bytes[end..end + 2] != [0, 0] {
                end += 1;
            }
            if end + 1 >= bytes.len() {
                return Err("unterminated SMBIOS strings");
            }
            end += 2;
            if kind == 0 || kind == 1 || kind == 2 {
                selected.extend_from_slice(&bytes[at..end]);
                board |= kind == 2;
            }
            if kind == 127 {
                break;
            }
            at = end;
        }
        if !board {
            return Err("SMBIOS board record missing");
        }
        Ok(format!("smbios-sha256:{:02x?}", digest(&selected)))
    }
}

pub fn capture() -> Snapshot {
    let mut s = Snapshot {
        schema: SCHEMA,
        environment: Environment::Physical,
        machine: String::new(),
        firmware: format!(
            "{}:{}",
            uefi::system::firmware_vendor(),
            uefi::system::firmware_revision()
        ),
        enumeration_complete: false,
        secure_boot: None,
        s3_save_state: false,
        roots: Vec::new(),
        devices: Vec::new(),
        available_mmio: Vec::new(),
        errors: Vec::new(),
    };
    match machine_identity() {
        Ok(id) => s.machine = id,
        Err(e) => s.errors.push(e.into()),
    }
    let mut enabled = [0u8; 1];
    s.secure_boot = uefi::runtime::get_variable(
        uefi::cstr16!("SecureBoot"),
        &uefi::runtime::VariableVendor::GLOBAL_VARIABLE,
        &mut enabled,
    )
    .ok()
    .and_then(|(b, _)| (b.len() == 1).then_some(b[0] != 0));
    s.enumeration_complete = boot::locate_handle_buffer(SearchType::ByProtocol(&uefi::guid!(
        "30cfe3e7-3de1-4586-be20-deaba1b3b793"
    )))
    .is_ok();
    s.s3_save_state = boot::locate_handle_buffer(SearchType::ByProtocol(&uefi::guid!(
        "e857caf6-c046-45dc-be3f-ee0765fba887"
    )))
    .is_ok();
    let mut gop_spans = Vec::new();
    if let Ok(list) = handles::<uefi::proto::console::gop::GraphicsOutput>() {
        for h in list {
            if let Ok(g) = open::<uefi::proto::console::gop::GraphicsOutput>(h) {
                let mode = g.current_mode_info();
                let _ = mode; /* GOP ownership below also excludes bound targets. */
                gop_spans.push(h);
            }
        }
    }
    match handles::<PciIo>() {
        Err(e) => s.errors.push(e.into()),
        Ok(list) => {
            for h in list {
                match capture_device(h, &gop_spans) {
                    Ok(d) => s.devices.push(d),
                    Err(e) => s.errors.push(format!("PCI: {e}")),
                }
            }
        }
    }
    match handles::<PciRootBridgeIo>() {
        Err(e) => s.errors.push(e.into()),
        Ok(list) => {
            for h in list {
                let result = (|| {
                    let mut root = open::<PciRootBridgeIo>(h)?;
                    let segment = root.segment_nr();
                    let config = root
                        .configuration()
                        .map_err(|_| "root configuration unavailable")?;
                    if config.len() > 256 {
                        return Err("too many root descriptors");
                    }
                    let mut memory = Vec::new();
                    let mut bus = None;
                    for d in config {
                        if d.translation_offset != 0 {
                            return Err("translated root unsupported");
                        }
                        match d.resource_range_type {
                            uefi::proto::pci::configuration::ResourceRangeType::Memory => memory
                                .push(
                                    Span::from_size(d.address_min, d.address_length)
                                        .ok_or("invalid root span")?,
                                ),
                            uefi::proto::pci::configuration::ResourceRangeType::Bus => {
                                if bus.is_some() || d.address_max > 255 {
                                    return Err("ambiguous root buses");
                                }
                                bus = Some((d.address_min as u8, d.address_max as u8));
                            }
                            _ => {}
                        }
                    }
                    let (first_bus, last_bus) = bus.ok_or("root bus range missing")?;
                    let tree = root.enumerate().map_err(|_| "root PCI census failed")?;
                    for a in tree.iter() {
                        if !s.devices.iter().any(|d| {
                            d.slot
                                == Slot {
                                    segment,
                                    bus: a.bus,
                                    device: a.dev,
                                    function: a.fun,
                                }
                        }) {
                            return Err("PCI function lacks readable PCI_IO resources");
                        }
                    }
                    Ok(Root {
                        segment,
                        first_bus,
                        last_bus,
                        memory,
                    })
                })();
                match result {
                    Ok(root) => s.roots.push(root),
                    Err(e) => s.errors.push(e.into()),
                }
            }
        }
    }
    match free_mmio() {
        Ok(v) => s.available_mmio = v,
        Err(e) => s.errors.push(e.into()),
    }
    s.devices.sort_by_key(|d| d.slot);
    s.roots.sort_by_key(|r| (r.segment, r.first_bus));
    s.available_mmio.sort_by_key(|s| s.start);
    s
}

fn capture_device(h: Handle, gops: &[Handle]) -> Result<Device, &'static str> {
    let mut io = open::<PciIo>(h)?;
    let io = io.get_mut().ok_or("null PCI_IO")?;
    let slot = location(io)?;
    let id = cfg(io, 0)?;
    let class = cfg(io, 8)? >> 8;
    let header = (cfg(io, 12)? >> 16) as u8 & 0x7f;
    let command = cfg(io, 4)? as u16;
    let mut bars = Vec::new();
    let mut index = 0;
    while index < if header == 1 { 2 } else { 6 } {
        let raw = cfg(io, 0x10 + u32::from(index) * 4)?;
        if let Some(b) = bar(io, index, raw)? {
            let wide = b.width64;
            bars.push(b);
            index += if wide { 2 } else { 1 };
        } else {
            index += 1;
        }
    }
    let bridge = if header == 1 {
        let buses = cfg(io, 0x18)?;
        let prefetch = cfg(io, 0x24)?;
        let base = u64::from(prefetch & 0xfff0) << 16 | u64::from(cfg(io, 0x28)?) << 32;
        let limit = u64::from(prefetch & 0xfff00000) | 0xfffff | u64::from(cfg(io, 0x2c)?) << 32;
        Some(Bridge {
            secondary: (buses >> 8) as u8,
            subordinate: (buses >> 16) as u8,
            prefetch: limit
                .checked_add(1)
                .map(|end| Span { start: base, end })
                .filter(|s| s.valid()),
        })
    } else {
        None
    };
    let vendor = id as u16;
    let product = (id >> 16) as u16;
    let straps = if vendor == 0x10de
        && nvstraps_core::registry::is_turing(product)
        && bars
            .iter()
            .any(|b| b.index == 0 && b.memory && b.span.end - b.span.start >= 0x101010)
        && command & 2 != 0
    {
        Some([strap(io, 0x101000)?, strap(io, 0x10100c)?])
    } else {
        None
    };
    Ok(Device {
        slot,
        vendor,
        product,
        subsystem: if header == 0 { cfg(io, 0x2c)? } else { 0 },
        class,
        command,
        bars,
        bridge,
        driver_count: drivers(h)?,
        console: gops.contains(&h),
        straps,
    })
}

pub struct NativeMachine {
    slot: Slot,
    io: ScopedProtocol<PciIo>,
}
impl NativeMachine {
    pub fn new(slot: Slot) -> Result<Self, &'static str> {
        for h in handles::<PciIo>()? {
            let io = open::<PciIo>(h)?;
            if location(&io)? == slot {
                return Ok(Self { slot, io });
            }
        }
        Err("target PCI_IO missing")
    }
}
impl Machine for NativeMachine {
    fn snapshot(&mut self) -> Result<Snapshot, &'static str> {
        Ok(capture())
    }
    fn reserve(&mut self, span: Span) -> Result<(), &'static str> {
        let d = dxe()?;
        let mut address = span.start;
        // SAFETY: the validated plan selected free GCD MMIO; exact-address allocation
        // rechecks ownership atomically in firmware before any device write.
        unsafe {
            (d.allocate)(
                2,
                3,
                0,
                span.end - span.start,
                &mut address,
                boot::image_handle().as_ptr(),
                ptr::null_mut(),
            )
        }
        .to_result()
        .map_err(|_| "MMIO reservation failed")?;
        if address != span.start {
            return Err("MMIO reservation moved");
        }
        Ok(())
    }
    fn release(&mut self, span: Span) -> Result<(), &'static str> {
        // SAFETY: only our successful exact reservation is passed after complete rollback.
        unsafe { (dxe()?.free)(span.start, span.end - span.start) }
            .to_result()
            .map_err(|_| "MMIO reservation release failed")
    }
    fn read(&mut self, r: Register) -> Result<u32, &'static str> {
        let io = self.io.get_mut().ok_or("null PCI_IO")?;
        if location(io)? != self.slot {
            return Err("PCI target changed");
        }
        match r {
            Register::Command => cfg(io, 4).map(|v| v & 0xffff),
            Register::Bar1Low => cfg(io, 0x14),
            Register::Bar1High => cfg(io, 0x18),
            Register::Strap0 => strap(io, 0x101000),
            Register::Strap1 => strap(io, 0x10100c),
        }
    }
    fn write(&mut self, r: Register, value: u32) -> Result<(), &'static str> {
        let io = self.io.get_mut().ok_or("null PCI_IO")?;
        match r {
            Register::Command => cfg_write(io, 4, value, 1),
            Register::Bar1Low => cfg_write(io, 0x14, value, 2),
            Register::Bar1High => cfg_write(io, 0x18, value, 2),
            Register::Strap0 | Register::Strap1 => {
                let offset = if r == Register::Strap0 {
                    0x101000
                } else {
                    0x10100c
                };
                // SAFETY: the shared executor has validated this Turing BAR0 and reserved
                // BAR1's destination; no bound UEFI driver may own this GPU during mutation.
                unsafe { (io.mem_write)(io, 2, 0, offset, 1, ptr::from_ref(&value).cast()) }
                    .to_result()
                    .map_err(|_| "strap write failed")
            }
        }
    }
    fn aperture(&mut self) -> Result<u64, &'static str> {
        let io = self.io.get_mut().ok_or("null PCI_IO")?;
        if cfg(io, 4)? & 6 != 0 {
            return Err("size measurement requires disabled decoding and DMA");
        }
        let low = cfg(io, 0x14)?;
        let high = cfg(io, 0x18)?;
        let result = (|| {
            cfg_write(io, 0x14, u32::MAX, 2)?;
            cfg_write(io, 0x18, u32::MAX, 2)?;
            Ok((u64::from(cfg(io, 0x18)?) << 32) | u64::from(cfg(io, 0x14)? & !15))
        })();
        let a = cfg_write(io, 0x18, high, 2);
        let b = cfg_write(io, 0x14, low, 2);
        a?;
        b?;
        let mask: u64 = result?;
        (!mask)
            .checked_add(1)
            .filter(|s| s.is_power_of_two())
            .ok_or("invalid BAR mask")
    }
}
