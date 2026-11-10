use std::process::ExitCode;

fn main() -> ExitCode {
    if std::env::args_os().nth(1).is_some() {
        eprintln!(
            "usage: nvstraps-rebar-helper (no arguments; it is started by NvStrapsReBar and speaks JSON lines on stdin/stdout)"
        );
        return ExitCode::from(2);
    }
    run()
}

#[cfg(target_os = "linux")]
fn run() -> ExitCode {
    use nvstraps_linux_helper::efivarfs::{EfiVarFs, effective_user_is_root};
    use nvstraps_linux_helper::serve::serve;

    match serve(
        std::io::stdin().lock(),
        std::io::stdout().lock(),
        effective_user_is_root(),
        &mut EfiVarFs::system(),
    ) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn run() -> ExitCode {
    eprintln!("nvstraps-rebar-helper runs on Linux only");
    ExitCode::from(2)
}
