fn main() {
    println!("cargo:rerun-if-changed=build.rs");

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("uefi") {
        // A driver image must remain resident after its entry point returns.
        println!("cargo:rustc-link-arg=/SUBSYSTEM:EFI_BOOT_SERVICE_DRIVER");
        println!("cargo:rustc-link-arg=/NXCOMPAT");
        println!("cargo:rustc-link-arg=/DYNAMICBASE");
    }
}
