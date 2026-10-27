use alloc::{string::String, vec::Vec};
use serde::{Deserialize, Serialize};

pub const SCHEMA: u32 = 1;
pub const MAX_REPORT_BYTES: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Slot {
    pub segment: u32,
    pub bus: u8,
    pub device: u8,
    pub function: u8,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Span {
    pub start: u64,
    /// Exclusive upper bound, unlike PCI base/limit registers.
    pub end: u64,
}

impl Span {
    pub fn from_size(start: u64, size: u64) -> Option<Self> {
        (size > 0).then_some(Self {
            start,
            end: start.checked_add(size)?,
        })
    }
    pub fn valid(self) -> bool {
        self.start < self.end
    }
    pub fn contains(self, other: Self) -> bool {
        self.valid() && other.valid() && self.start <= other.start && other.end <= self.end
    }
    pub fn overlaps(self, other: Self) -> bool {
        self.start < other.end && other.start < self.end
    }
    pub fn intersection(self, other: Self) -> Option<Self> {
        let s = Self {
            start: self.start.max(other.start),
            end: self.end.min(other.end),
        };
        s.valid().then_some(s)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Bar {
    pub index: u8,
    pub span: Span,
    pub memory: bool,
    pub prefetchable: bool,
    pub width64: bool,
    pub raw_low: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Bridge {
    pub secondary: u8,
    pub subordinate: u8,
    pub prefetch: Option<Span>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Device {
    pub slot: Slot,
    pub vendor: u16,
    pub product: u16,
    pub subsystem: u32,
    pub class: u32,
    pub command: u16,
    pub bars: Vec<Bar>,
    pub bridge: Option<Bridge>,
    pub driver_count: u32,
    pub console: bool,
    pub straps: Option<[u32; 2]>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Root {
    pub segment: u32,
    pub first_bus: u8,
    pub last_bus: u8,
    pub memory: Vec<Span>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Environment {
    Physical,
    QemuModel,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Snapshot {
    pub schema: u32,
    pub environment: Environment,
    pub machine: String,
    pub firmware: String,
    pub enumeration_complete: bool,
    pub secure_boot: Option<bool>,
    pub s3_save_state: bool,
    pub roots: Vec<Root>,
    pub devices: Vec<Device>,
    /// Unallocated GCD MMIO only. RAM and allocated/unknown GCD descriptors are excluded.
    pub available_mmio: Vec<Span>,
    pub errors: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Handoff {
    /// Absolute UEFI path, searched on file-system handles; exactly one hash match is required.
    pub path: String,
    pub sha256: [u8; 32],
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Plan {
    pub schema: u32,
    pub source: Snapshot,
    pub source_sha256: [u8; 32],
    pub target: Slot,
    pub size: u64,
    pub destination: Span,
    pub handoff: Handoff,
}
