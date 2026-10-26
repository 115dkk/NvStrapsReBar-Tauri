# External EFI diagnostic and experimental loader

The release's `external/` directory contains `NvStrapsDiagnostic.efi`,
`NvStrapsLoader.efi`, and `nvstraps-external-tool.exe`. This is an **experimental
cold-boot route**, separate from the desktop's firmware-injected DXE workflow.
It does not flash a BIOS or install a boot entry.

The diagnostic reads PCI configuration, PCI_IO BAR descriptors, root resources,
free GCD MMIO, driver ownership, firmware identity and Turing straps. It writes
`NvStrapsDiagnostic.json` on its source volume, preserving existing different output.
It never probes BAR sizes by writing all ones. SMBIOS identity is hashed.

## Execution boundary

The loader moves BAR1 into an aligned, exclusively reserved GCD MMIO extent inside
all existing root and ancestor-bridge decode windows. It validates a fresh diagnostic,
reserves the exact destination, disables DMA, relocates BAR1, changes the straps,
disables decoding, measures the actual BAR mask, and verifies register readback.
Failure restores the registers. Failed restoration retains the reservation and stops.

The target must have no bound UEFI driver and no GOP on its PCI_IO handle. Active
display/GOP targets are refused. Missing SMBIOS3 identity, incomplete resource census,
translated resources and insufficient MMIO also prevent execution. This version does
not detach GOP, expand bridge windows, rewrite ACPI or restart the whole PCI bus.
A primary display GPU may therefore produce a diagnostic but no external plan.
Physical HJ0/2070 Super compatibility has not been established.

Evaluate cold boot only. S3 sleep, hibernation and Windows Fast Startup are outside the
supported lifecycle: the loader does not install a resume script. Secure Boot must
accept the EFI images through the configured trust policy; the loader leaves it intact.

## Prepare a package

Run the diagnostic from a FAT USB using a UEFI Shell, then retain its JSON. If a prior
report occupies the output path, keep it separately and use an empty output location.
Choose the exact target from the report. PCI address numbers below are decimal examples.

```powershell
.\nvstraps-external-tool.exe inspect .\NvStrapsDiagnostic.json
.\nvstraps-external-tool.exe plan .\NvStrapsDiagnostic.json 0 1 0 0 8192 `
  '\EFI\Microsoft\Boot\bootmgfw.efi' .\bootmgfw.efi `
  --cold-boot-experimental .\plan.json
.\nvstraps-external-tool.exe package .\NvStrapsDiagnostic.efi .\NvStrapsLoader.efi `
  .\plan.json .\external-package
```

The successor file is read only to pin its SHA-256. The packager does not copy Windows
Boot Manager or its BCD store to the USB. It creates `EFI/BOOT/BOOTX64.EFI`, the diagnostic,
the plan and a hash manifest. Copy a successful package onto a dedicated FAT USB and
select it for a one-time boot; preserve the normal Windows entry.

The loader requires exactly one file-system handle with the pinned successor path/hash.
It uses the complete device path in real `LoadImage` before GPU writes, then calls
`StartImage` after hardware verification and receipt persistence. If the successor
returns, it restores the GPU before returning to firmware. A receipt records
`before-handoff`, not Windows success. Verify Windows/NVIDIA aperture and workload
behavior separately. Prerequisite failures do not authorize guessed register changes.

## Firmware-image injection

```powershell
.\nvstraps-external-tool.exe inject .\original.fd .\NvStrapsReBar.ffs .\patched.fd
```

This no-overwrite entry point retains the existing injector's structural/census checks
and rejects recognized signed-update overlap. Unknown signature layouts do not prove
an image unsigned. Installation and physical boot are separate from image preparation.
The external loader is an EFI application; the original early DXE FFS remains the
firmware-injected driver.

## CI proof

`npm run test:qemu:external` boots unmodified OVMF with disk-loaded EFI files:

- Production diagnostic enumerates actual QEMU PCI/root resources and writes JSON.
- A debug-only GPU model produces a diagnostic for the real host planner/packager.
- The external EFI runs the shared transaction against that model, decodes the strap
  fields to measure 8 GiB, and uses actual `LoadImage`/`StartImage` to run a successor.
  Return from the successor exercises restoration.
- Production rejects synthetic plans; a changed successor is refused before mutation.
- Portable tests cover stale identity, collisions, bridge limits, each write-failure
  position and failed restoration. Miri interprets these portable tests.
- The original OVMF hash stays unchanged. Uploaded evidence contains only logs/reports.

`qemu-model` cannot compile without debug assertions. Model evidence does not emulate
NVIDIA silicon or exercise native PCI writes. Native adapter evidence is UEFI target
compilation and the read-only QEMU diagnostic. Physical Turing writes, Windows and
sleep/resume require hardware trials. The existing injected-driver/S3 suite is retained.

Build with `npm run build:external`. Source owners:
[planner/executor](../crates/nvstraps-external/src/lib.rs),
[UEFI adapter](../crates/nvstraps-external-efi/src/native.rs),
[package/injection tool](../crates/nvstraps-external-tool/src/lib.rs).
