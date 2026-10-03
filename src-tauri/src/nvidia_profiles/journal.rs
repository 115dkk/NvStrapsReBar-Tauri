//! Diagnostic log for the driver settings commands. Every failed NVAPI call, every write, every
//! read-back, and every skipped profile or backup gets one line, so a run on a real PC leaves a
//! record of what the driver did. Logging never stops a command: a line that cannot reach the
//! file goes to stderr instead.

use std::{
    fmt::{self, Display},
    fs::{self, OpenOptions},
    io::Write as _,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

/// The log rolls over to `<name>.1` past this size, keeping one previous file.
const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Info,
    Warn,
    Error,
}

impl Display for Level {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Info => "INFO",
            Self::Warn => "WARN",
            Self::Error => "ERROR",
        })
    }
}

enum Sink {
    File(PathBuf),
    #[cfg(test)]
    Memory(Mutex<Vec<String>>),
}

pub struct Journal {
    sink: Sink,
    /// Serializes appends from concurrent commands.
    write: Mutex<()>,
}

impl Journal {
    pub fn file(path: PathBuf) -> Self {
        Self {
            sink: Sink::File(path),
            write: Mutex::new(()),
        }
    }

    #[cfg(test)]
    pub fn memory() -> Self {
        Self {
            sink: Sink::Memory(Mutex::new(Vec::new())),
            write: Mutex::new(()),
        }
    }

    pub fn path(&self) -> Option<&Path> {
        match &self.sink {
            Sink::File(path) => Some(path),
            #[cfg(test)]
            Sink::Memory(_) => None,
        }
    }

    pub fn info(&self, event: &str, detail: impl Display) {
        self.record(Level::Info, event, detail);
    }

    pub fn warn(&self, event: &str, detail: impl Display) {
        self.record(Level::Warn, event, detail);
    }

    pub fn error(&self, event: &str, detail: impl Display) {
        self.record(Level::Error, event, detail);
    }

    pub fn record(&self, level: Level, event: &str, detail: impl Display) {
        let line = format!("{} {level} {event} {detail}", utc_timestamp(now_ms()));
        let _guard = self
            .write
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match &self.sink {
            Sink::File(path) => {
                if let Err(error) = append(path, &line) {
                    eprintln!(
                        "NvStrapsReBar driver settings log {} failed ({error}): {line}",
                        path.display()
                    );
                }
            }
            #[cfg(test)]
            Sink::Memory(lines) => lines
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(line),
        }
    }

    #[cfg(test)]
    pub fn lines(&self) -> Vec<String> {
        match &self.sink {
            Sink::Memory(lines) => lines
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone(),
            Sink::File(path) => fs::read_to_string(path)
                .unwrap_or_default()
                .lines()
                .map(str::to_owned)
                .collect(),
        }
    }
}

/// Release builds abort on panic, which leaves no trace. The hook writes the panic message and
/// location to `path` first, then runs the default hook.
pub fn install_panic_log(path: PathBuf) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        Journal::file(path.clone()).error(
            "panic",
            format_args!("thread={:?} {info}", thread.name().unwrap_or("unnamed")),
        );
        previous(info);
    }));
}

fn append(path: &Path, line: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    if fs::metadata(path).is_ok_and(|metadata| metadata.len() > MAX_LOG_BYTES) {
        let mut previous = path.as_os_str().to_owned();
        previous.push(".1");
        fs::rename(path, PathBuf::from(previous))?;
    }
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(file, "{line}")
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ` from Unix milliseconds (proleptic Gregorian calendar).
pub fn utc_timestamp(unix_ms: u128) -> String {
    let millis = unix_ms % 1000;
    let seconds = unix_ms / 1000;
    let (days, day_seconds) = ((seconds / 86_400) as i64, seconds % 86_400);
    // Howard Hinnant's days-to-civil conversion.
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        day_seconds / 3600,
        day_seconds % 3600 / 60,
        day_seconds % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_are_utc_iso_8601() {
        assert_eq!(utc_timestamp(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(utc_timestamp(1_791_084_011_123), "2026-10-04T03:20:11.123Z");
        assert_eq!(utc_timestamp(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn lines_carry_level_event_and_detail() {
        let journal = Journal::memory();
        journal.warn("backup.skipped", "damaged.json: hash mismatch");
        let lines = journal.lines();
        assert_eq!(lines.len(), 1);
        assert!(lines[0].ends_with(" WARN backup.skipped damaged.json: hash mismatch"));
    }

    #[test]
    fn the_file_rolls_over_and_keeps_one_previous_file() {
        let directory = std::env::temp_dir().join(format!(
            "nvstraps-journal-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let path = directory.join("driver-settings.log");
        let journal = Journal::file(path.clone());
        journal.info("first", "x".repeat(MAX_LOG_BYTES as usize + 1));
        journal.info("second", "after roll-over");
        let previous = directory.join("driver-settings.log.1");
        assert!(
            fs::read_to_string(&previous)
                .unwrap()
                .contains(" INFO first ")
        );
        assert!(
            fs::read_to_string(&path)
                .unwrap()
                .contains(" INFO second after roll-over")
        );
        assert!(directory.starts_with(std::env::temp_dir()));
        let _ = fs::remove_dir_all(&directory);
    }
}
