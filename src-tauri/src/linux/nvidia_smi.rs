use std::path::PathBuf;

use crate::error::{BackendError, BackendResult};

/// The driver's own nvidia-smi from fixed system locations, never from PATH.
pub(crate) fn nvidia_smi_path() -> BackendResult<PathBuf> {
    let candidates = [
        PathBuf::from("/usr/bin/nvidia-smi"),
        PathBuf::from("/usr/local/bin/nvidia-smi"),
        PathBuf::from("/run/current-system/sw/bin/nvidia-smi"),
    ];
    super::trusted::trusted_executable(&candidates).ok_or_else(|| BackendError::Deployment(
        "nvidia-smi was not found in /usr/bin, /usr/local/bin or /run/current-system/sw/bin; the NVIDIA driver provides it".into()
    ))
}
