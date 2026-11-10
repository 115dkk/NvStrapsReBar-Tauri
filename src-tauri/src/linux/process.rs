use std::{fs, path::Path};

use super::SystemRoots;
use crate::error::{BackendError, BackendResult};

fn failure(path: &Path, reason: impl std::fmt::Display) -> BackendError {
    BackendError::Deployment(format!("failed to read {}: {reason}", path.display()))
}

/// Effective user id from the `Uid:` line (real, effective, saved, fs).
pub(crate) fn effective_uid(roots: &SystemRoots) -> BackendResult<u32> {
    let path = roots.proc.join("self/status");
    let text = fs::read_to_string(&path).map_err(|error| failure(&path, error))?;
    let fields = text
        .lines()
        .find_map(|line| line.strip_prefix("Uid:"))
        .ok_or_else(|| failure(&path, "missing Uid line"))?;
    let ids = fields
        .split_whitespace()
        .map(str::parse::<u32>)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| failure(&path, error))?;
    if ids.len() != 4 {
        return Err(failure(&path, "Uid line must contain four user IDs"));
    }
    Ok(ids[1])
}

/// `btime` (seconds since the epoch) from `/proc/stat`, in milliseconds.
pub(crate) fn boot_time_unix_ms(roots: &SystemRoots) -> BackendResult<u64> {
    let path = roots.proc.join("stat");
    let text = fs::read_to_string(&path).map_err(|error| failure(&path, error))?;
    for line in text.lines() {
        let mut fields = line.split_whitespace();
        if fields.next() != Some("btime") {
            continue;
        }
        let seconds = fields.next().and_then(|value| value.parse::<u64>().ok());
        if fields.next().is_none()
            && let Some(milliseconds) = seconds.and_then(|value| value.checked_mul(1000))
        {
            return Ok(milliseconds);
        }
        return Err(failure(&path, "malformed or overflowing btime"));
    }
    Err(failure(&path, "missing btime"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::linux::tests::Fixture;

    #[test]
    fn reads_effective_not_real_uid_and_boot_milliseconds() {
        let fixture = Fixture::new();
        fixture.write(
            fixture.roots.proc.join("self/status"),
            "Name:\ttest\nUid:\t1000\t0\t0\t0\n",
        );
        fixture.write(
            fixture.roots.proc.join("stat"),
            "cpu 1 2 3\nbtime 1794264812\n",
        );
        assert_eq!(effective_uid(&fixture.roots).unwrap(), 0);
        assert_eq!(
            boot_time_unix_ms(&fixture.roots).unwrap(),
            1_794_264_812_000
        );
    }

    #[test]
    fn missing_malformed_and_overflowing_process_data_are_errors() {
        let fixture = Fixture::new();
        assert!(matches!(
            effective_uid(&fixture.roots),
            Err(BackendError::Deployment(_))
        ));
        assert!(matches!(
            boot_time_unix_ms(&fixture.roots),
            Err(BackendError::Deployment(_))
        ));
        for text in ["", "Uid: 0", "Uid: 1 nope 2 3", "Uid: 1 2 3 4 5"] {
            fixture.write(fixture.roots.proc.join("self/status"), text);
            let error = effective_uid(&fixture.roots).unwrap_err().to_string();
            assert!(error.contains("self/status"));
        }
        for text in ["", "btime nope", "btime 1 2", "btime 18446744073709551615"] {
            fixture.write(fixture.roots.proc.join("stat"), text);
            let error = boot_time_unix_ms(&fixture.roots).unwrap_err().to_string();
            assert!(error.contains("/stat"));
        }
    }
}
