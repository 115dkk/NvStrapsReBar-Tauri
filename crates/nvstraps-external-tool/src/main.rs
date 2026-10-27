use std::{
    io::Write,
    path::Path,
    process::{Command, Stdio},
};

use nvstraps_external::*;
use nvstraps_external_tool::*;

const USAGE: &str = "usage: nvstraps-external-tool inspect <diagnostic.json> | plan <diagnostic.json> <segment> <bus> <device> <function> <MiB> <UEFI-next-path> <next.efi> --cold-boot-experimental <plan.json> | package <diagnostic.efi> <loader.efi> <plan.json> <new-output-dir> | inject <source.fd> <driver.ffs> <new-output.fd> | sign <in.efi> <certificate.der> <key.pem> <out.efi> | check-signed <image.efi> <certificate.der>";
const GUIDED: &str =
    "The guided version is in NvStrapsReBar → \"Without changing the BIOS (experimental)\".";

fn run(arguments: &[String]) -> Result<(), String> {
    match arguments.first().map(String::as_str) {
        Some("inspect") if arguments.len() == 2 => {
            let snapshot = read_snapshot(Path::new(&arguments[1]))?;
            println!(
                "{}",
                serde_json::to_string_pretty(&snapshot).map_err(|error| error.to_string())?
            );
        }
        Some("plan") if arguments.len() == 11 => {
            let snapshot = read_snapshot(Path::new(&arguments[1]))?;
            let parse = |index: usize| {
                arguments[index]
                    .parse::<u64>()
                    .map_err(|_| format!("invalid integer: {}", arguments[index]))
            };
            let target = Slot {
                segment: parse(2)?.try_into().map_err(|_| "segment overflow")?,
                bus: parse(3)?.try_into().map_err(|_| "bus overflow")?,
                device: parse(4)?.try_into().map_err(|_| "device overflow")?,
                function: parse(5)?.try_into().map_err(|_| "function overflow")?,
            };
            let successor = read_bounded(Path::new(&arguments[8]), 32 * 1024 * 1024)?;
            validate_application(&successor)?;
            let size = parse(6)?.checked_mul(1024 * 1024).ok_or("size overflow")?;
            if arguments[9] != "--cold-boot-experimental" {
                return Err("explicit --cold-boot-experimental is required".to_owned());
            }
            let plan = make_plan(
                &snapshot,
                target,
                size,
                Handoff {
                    path: arguments[7].clone(),
                    sha256: digest(&successor),
                },
            )
            .map_err(|error| format!("no external plan: {error:?}"))?;
            write_immutable(
                Path::new(&arguments[10]),
                &serde_json::to_vec_pretty(&plan).map_err(|error| error.to_string())?,
            )?;
            println!(
                "planned BAR1 {:#x}..{:#x}; environment={:?}",
                plan.destination.start, plan.destination.end, snapshot.environment
            );
        }
        Some("package") if arguments.len() == 5 => {
            let plan = read_plan(Path::new(&arguments[3]))?;
            let receipt = package(
                Path::new(&arguments[1]),
                Path::new(&arguments[2]),
                &plan,
                Path::new(&arguments[4]),
            )?;
            println!("{receipt}");
        }
        Some("inject") if arguments.len() == 4 => inject(
            Path::new(&arguments[1]),
            Path::new(&arguments[2]),
            Path::new(&arguments[3]),
        )?,
        Some("sign") if arguments.len() == 5 => {
            let input = Path::new(&arguments[1]);
            let certificate_path = Path::new(&arguments[2]);
            let key = Path::new(&arguments[3]);
            let output = Path::new(&arguments[4]);
            refuse_same_file(input, output)?;
            let image = read_bounded(input, 32 * 1024 * 1024)?;
            let certificate = read_bounded(certificate_path, 1024 * 1024)?;
            let prepared = authenticode::prepare(&image, &certificate)?;
            let signature = openssl_sign(key, prepared.to_be_signed())?;
            let signed = authenticode::finish(prepared, &signature)?;
            authenticode::check_signed(&signed, &certificate)?;
            write_immutable(output, &signed)?;
        }
        Some("check-signed") if arguments.len() == 3 => {
            let image = read_bounded(Path::new(&arguments[1]), 32 * 1024 * 1024)?;
            let certificate = read_bounded(Path::new(&arguments[2]), 1024 * 1024)?;
            authenticode::check_signed(&image, &certificate)?;
        }
        _ => return Err(USAGE.to_owned()),
    }
    Ok(())
}

fn refuse_same_file(input: &Path, output: &Path) -> Result<(), String> {
    if input == output {
        return Err("signing output must differ from the input".to_owned());
    }
    let input = std::fs::canonicalize(input).map_err(|error| error.to_string())?;
    let output = if output.exists() {
        std::fs::canonicalize(output).map_err(|error| error.to_string())?
    } else {
        let parent = output.parent().unwrap_or_else(|| Path::new("."));
        let parent = std::fs::canonicalize(parent).map_err(|error| error.to_string())?;
        parent.join(
            output
                .file_name()
                .ok_or("signing output has no file name")?,
        )
    };
    if input == output {
        return Err("signing output must differ from the input".to_owned());
    }
    Ok(())
}

fn openssl_sign(key: &Path, to_be_signed: &[u8]) -> Result<Vec<u8>, String> {
    let executable = std::env::var_os("NVSTRAPS_OPENSSL").unwrap_or_else(|| "openssl".into());
    let mut child = Command::new(executable)
        .args(["dgst", "-sha256", "-sign"])
        .arg(key)
        .arg("-binary")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("cannot start openssl: {error}"))?;
    child
        .stdin
        .take()
        .ok_or("cannot open openssl stdin")?
        .write_all(to_be_signed)
        .map_err(|error| format!("cannot write to openssl: {error}"))?;
    let output = child
        .wait_with_output()
        .map_err(|error| format!("cannot wait for openssl: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("openssl signing failed: {}", stderr.trim()));
    }
    if output.stdout.is_empty() {
        return Err("openssl returned an empty signature".to_owned());
    }
    Ok(output.stdout)
}

fn main() {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    if arguments.is_empty() {
        println!("{USAGE}");
        println!("{GUIDED}");
        if console_belongs_to_this_process() {
            println!("Press Enter to close.");
            let mut line = String::new();
            let _ = std::io::stdin().read_line(&mut line);
        }
        return;
    }
    if let Err(error) = run(&arguments) {
        eprintln!("nvstraps-external-tool: {error}");
        std::process::exit(1);
    }
}

#[cfg(windows)]
fn console_belongs_to_this_process() -> bool {
    use windows_sys::Win32::System::Console::GetConsoleProcessList;

    let mut process_id = 0;
    // SAFETY: `process_id` is a writable one-element buffer, and the count matches it.
    unsafe { GetConsoleProcessList(&mut process_id, 1) == 1 }
}

#[cfg(not(windows))]
fn console_belongs_to_this_process() -> bool {
    false
}
