use std::env;
use std::fs;
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
            fs::write(&output, ffs)?;
            let inspection = nvstraps_ffs::inspect_ffs(&fs::read(&output)?)?;
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
        _ => return Err(usage().into()),
    }
    Ok(())
}

fn usage() -> &'static str {
    "usage: nvstraps-ffs pack <NvStrapsReBar.efi> <NvStrapsReBar.ffs> | inspect <NvStrapsReBar.ffs>"
}
