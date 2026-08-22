use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::process::ExitCode;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("nvstraps-ffs: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut arguments = env::args_os().skip(1);
    let command = arguments.next().ok_or(usage())?;
    let input = arguments.next().ok_or(usage())?;

    match command.to_string_lossy().as_ref() {
        "pack" => {
            let output = arguments.next().ok_or(usage())?;
            if arguments.next().is_some() {
                return Err(usage().into());
            }
            let image = fs::read(&input)?;
            let ffs = nvstraps_ffs::build_ffs(&image)?;
            nvstraps_ffs::inspect_bundled_ffs(&ffs)?;
            fs::write(&output, ffs)?;
            let inspection = nvstraps_ffs::inspect_bundled_ffs(&fs::read(&output)?)?;
            println!(
                "wrote {}: {} ({:?})",
                Path::new(&output).display(),
                inspection.ui_name,
                inspection.section_types
            );
        }
        "inspect" => {
            if arguments.next().is_some() {
                return Err(usage().into());
            }
            let inspection = nvstraps_ffs::inspect_ffs(&fs::read(&input)?)?;
            println!("{inspection:#?}");
        }
        "inject" | "inject-all" => {
            let patch_every_dxe_domain = command == "inject-all";
            let ffs_path = arguments.next().ok_or(usage())?;
            let output = arguments.next().ok_or(usage())?;
            if arguments.next().is_some() {
                return Err(usage().into());
            }
            let firmware = fs::read(&input)?;
            let ffs = fs::read(&ffs_path)?;
            let (patched, report) = if patch_every_dxe_domain {
                nvstraps_ffs::inject_ffs_all_targets(&firmware, &ffs)?
            } else {
                nvstraps_ffs::inject_ffs(&firmware, &ffs)?
            };
            let mut output_file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&output)?;
            output_file.write_all(&patched)?;
            println!(
                "wrote {}: patched_targets={}",
                Path::new(&output).display(),
                report.targets.len()
            );
            for (index, target) in report.targets.iter().enumerate() {
                println!(
                    "target {}: path={:?} -> FV {:#x}, driver {:#x}, container FV {:#x}, file {:#x}, replaced_pad={}, encapsulated_fv={}, recompressed_guided={}, grew_fv={}, growth_bytes={}",
                    index + 1,
                    target.target.container_file_offsets,
                    target.target.firmware_volume_offset,
                    target.driver_file_offset,
                    target.firmware_volume_offset,
                    target.file_offset,
                    target.replaced_pad_file,
                    target.encapsulated_volume_image,
                    target.recompressed_guided_section,
                    target.grew_firmware_volume,
                    target.firmware_volume_growth_bytes
                );
            }
        }
        _ => return Err(usage().into()),
    }
    Ok(())
}

fn usage() -> &'static str {
    "usage: nvstraps-ffs pack <NvStrapsReBar.efi> <NvStrapsReBar.ffs> | inspect <NvStrapsReBar.ffs> | inject <firmware.fd> <NvStrapsReBar.ffs> <patched.fd> | inject-all <firmware.fd> <NvStrapsReBar.ffs> <patched.fd>"
}
