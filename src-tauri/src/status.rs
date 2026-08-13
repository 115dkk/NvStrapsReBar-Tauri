use serde::Serialize;

use nvstraps_core::status::DecodedStatus;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverStatus {
    pub raw: String,
    pub code: u32,
    pub kind: &'static str,
    pub label: &'static str,
    pub severity: &'static str,
    pub pci_location: Option<String>,
    pub efi_error_location: Option<u8>,
    pub efi_status: Option<u8>,
}

impl DriverStatus {
    pub fn from_raw(raw: u64) -> Self {
        let decoded = DecodedStatus::decode(raw);
        let code = decoded.code;
        let (kind, label, severity) = status_description(code);
        let pci_location = decoded.pci_location.map(|location| {
            format!(
                "{:02X}:{:02X}.{}",
                location.bus, location.device, location.function
            )
        });
        Self {
            raw: format!("0x{raw:016X}"),
            code,
            kind,
            label,
            severity,
            pci_location,
            efi_error_location: decoded.efi_error_location,
            efi_status: decoded.efi_status,
        }
    }
}

fn status_description(code: u32) -> (&'static str, &'static str, &'static str) {
    match code {
        10 => ("not_loaded", "Not loaded", "neutral"),
        20 => ("configured", "Configured", "success"),
        30 => ("gpu_unconfigured", "GPU unconfigured", "warning"),
        40 => ("unconfigured", "Unconfigured", "neutral"),
        50 => ("cleared", "Cleared", "neutral"),
        60 => ("bridge_found", "Bridge found", "progress"),
        70 => ("gpu_found", "GPU found", "progress"),
        80 => ("straps_configured", "GPU-side ReBAR configured", "success"),
        90 => (
            "straps_preconfigured",
            "GPU side already configured",
            "success",
        ),
        100 => (
            "straps_confirmed",
            "GPU-side ReBAR configured with PCI confirmation",
            "success",
        ),
        110 => ("delay_elapsed", "GPU PCI delay elapsed", "progress"),
        120 => (
            "pci_rebar_configured",
            "GPU PCI ReBAR configured",
            "success",
        ),
        130 => (
            "straps_unconfirmed",
            "GPU-side ReBAR configured without PCI confirmation",
            "warning",
        ),
        135 => (
            "size_override",
            "GPU-side ReBAR configured with PCI size override",
            "success",
        ),
        140 => (
            "capability_missing",
            "ReBAR capability not advertised",
            "warning",
        ),
        150 => ("gpu_excluded", "GPU excluded", "neutral"),
        159 => ("missing_bridge", "Missing bridge configuration", "error"),
        160 => ("bad_bridge", "Bad PCI bridge configuration", "error"),
        161 => ("bridge_order", "GPU enumerated before its bridge", "error"),
        162 => ("missing_gpu", "Missing GPU BAR0 configuration", "error"),
        163 => ("bad_gpu", "Improper GPU BAR configuration", "error"),
        164 => (
            "bad_setup_attributes",
            "Bad Setup variable attributes",
            "error",
        ),
        165 => ("ambiguous_setup", "Ambiguous Setup variable", "error"),
        166 => ("missing_setup", "Setup variable missing", "error"),
        170 => ("allocation_error", "EFI allocation error", "error"),
        180 => ("efi_error", "Internal EFI error", "error"),
        190 => ("nvar_api_error", "Firmware variable API error", "error"),
        200 => ("parse_error", "Configuration parse error", "error"),
        _ => ("unknown", "Unknown driver status", "error"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_status_and_pci_location() {
        let raw = (0x0108_u64 << 48) | 120;
        let status = DriverStatus::from_raw(raw);
        assert_eq!(status.kind, "pci_rebar_configured");
        assert_eq!(status.pci_location.as_deref(), Some("01:01.0"));
    }
}
