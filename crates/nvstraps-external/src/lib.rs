#![no_std]
#![forbid(unsafe_code)]

extern crate alloc;

pub mod execute;
pub mod model;
pub mod plan;

pub use model::*;
pub use plan::{PlanError, make_plan, validate_plan};

pub fn digest(bytes: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).into()
}

pub fn snapshot_digest(snapshot: &Snapshot) -> Result<[u8; 32], serde_json::Error> {
    serde_json::to_vec(snapshot).map(|bytes| digest(&bytes))
}
