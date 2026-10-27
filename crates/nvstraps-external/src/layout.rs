/// Directory containing NvStrapsReBar's external-boot state.
pub const FOLDER: &str = "\\EFI\\NvStraps";
/// Ownership record for files managed by the host application.
pub const OWNER: &str = "\\EFI\\NvStraps\\owner.json";
/// Snapshot written by the diagnostic application.
pub const REPORT: &str = "\\EFI\\NvStraps\\diagnostic.json";
/// Deployment plan consumed by the loader application.
pub const PLAN: &str = "\\EFI\\NvStraps\\plan.json";
/// Prefix of loader receipt file names.
pub const RECEIPT_PREFIX: &str = "\\EFI\\NvStraps\\receipt-";
/// Suffix of loader receipt file names.
pub const RECEIPT_SUFFIX: &str = ".txt";
/// Most recent diagnostic or loader failure.
pub const LAST_ERROR: &str = "\\EFI\\NvStraps\\last-error.txt";
/// Diagnostic image stored on an EFI System Partition.
pub const ESP_DIAGNOSTIC: &str = "\\EFI\\NvStraps\\NvStrapsDiagnostic.efi";
/// Loader image stored on an EFI System Partition.
pub const ESP_LOADER: &str = "\\EFI\\NvStraps\\NvStrapsLoader.efi";
/// Removable-media fallback image used by firmware.
pub const REMOVABLE_BOOT: &str = "\\EFI\\BOOT\\BOOTX64.EFI";
/// Windows Boot Manager, read and authenticated by the external loader.
pub const WINDOWS_BOOT_MANAGER: &str = "\\EFI\\Microsoft\\Boot\\bootmgfw.efi";
