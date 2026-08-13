# NvStrapsReBar

NvStrapsReBar is a Rust/Tauri toolchain for enabling and validating Resizable BAR on NVIDIA
Turing GPUs (GTX 1600 and RTX 2000). It includes a stable-Rust UEFI driver, firmware preparation,
an exact-machine deployment plan, Windows EFI-variable configuration, and post-boot evidence.

> **Physical deployment is not yet hardware-verified.** The Rust driver and firmware tooling are
> covered by host tests and an isolated OVMF/QEMU boot test. No recoverable trial has yet proved a
> prepared vendor image on the pinned physical machine. The application never flashes firmware,
> never overwrites the selected source image, and never bypasses vendor signatures.

Pascal and older NVIDIA GPUs are not supported. Their Windows driver does not accept the changed
BAR behavior required by this project.

## What is automated

The `Deploy` workspace provides one guarded, resumable journey:

1. inventory the exact board, BIOS, GPU, bridge, and BAR0 topology;
2. select and SHA-256 fingerprint an official vendor firmware image;
3. choose the modern native-ReBAR path or analyze an older image for pinned legacy patches;
4. pin the recovery and vendor-install routes in an immutable `MachineProfile`;
5. re-check the current machine and source image before every consequential operation;
6. build and verify the bundled Rust DXE FFS, apply selected legacy patches when required, and
   inject the driver into a new artifact;
7. export the artifact, preserved original, manifests, receipts, operator instructions, and
   checksums as a deployment package;
8. validate and save the NvStrapsReBar EFI configuration with byte-for-byte readback;
9. request the next Windows restart into firmware setup after a saved-work confirmation;
10. collect NVIDIA BAR1 evidence, install a pinned official NVIDIA Profile Inspector release,
    back up customized profiles, and open the external UI.

The application hard-stops on a changed board, BIOS, topology, BAR0 range, firmware hash, legacy
catalog, or patch match count. It reports preparation as preparation; it does not report a flash,
firmware-setting change, reboot, or physical recovery as complete on the user's behalf.

## Modern and legacy board paths

| Board path | Application work | Required firmware work |
| --- | --- | --- |
| Native ReBAR | Inject the Rust driver and use system-default PCI sizing | Enable ReBAR and Above 4G Decoding; disable CSM if the vendor requires it |
| Legacy Above 4G | Read-only scan of the exact image, authoritative match counts, selected pinned patches, then driver injection | Enable Above 4G Decoding, disable CSM, and use the documented vendor flash/recovery route |

Legacy analysis classifies every pinned rule as `applicable`, `absent`, or `blocked`. Only exact
applicable matches can be selected. Zero-risk matches may be recommended; chipset-specific or
DSDT changes require an explicit risk acknowledgment. Profile creation repeats the complete patch
operation in memory, so stale counts or incompatible combinations cannot be stored.

## Manual and physical boundary

These steps intentionally remain outside a generic one-click action:

- obtain the exact official image for the exact motherboard and revision;
- verify that the selected recovery route is documented or has actually been tested;
- review hashes and the prepared artifact before crossing the flash boundary;
- run the vendor flasher or physical flashback procedure;
- change UEFI settings, wait through the update, and confirm the next successful boot;
- move a USB drive, press a rear-panel button, clear CMOS, use an SPI programmer, or change a GPU;
- choose per-application NVIDIA policy values in Profile Inspector.

For the specifically detected MSI PRO Z690-A DDR4 (MS-7D25), the application can prefill the
documented M-FLASH route and Flash BIOS Button recovery route. It still requires the operator to
confirm the exact model, image, recovery capability, and physical actions. A different identity is
not treated as equivalent.

Before any GPU, PCI, or relevant UEFI-setting change, disable NvStrapsReBar, save the disabled
configuration, reboot, power down, and only then alter the topology. After the change, boot,
refresh inventory, validate the new topology, re-enable, save, and reboot again. BAR0 addresses
are allocated by firmware and must never be assumed stable across those changes.

See [RIIR and one-click deployment boundaries](docs/RIIR_AND_ONE_CLICK.md) for the complete
separation between source replacement, in-app automation, external adapters, and physical gates.

## Build and run

Requirements for developers are Node.js 24+, stable Rust with `rustfmt` and `clippy`, and the
`x86_64-unknown-uefi` Rust target. End users of a packaged build do not need Rust, EDK2, Python,
BaseTools, a C/C++ compiler, or a separate firmware-volume editor.

```powershell
npm ci
npm run check
npm run check:rust
npm run tauri dev
```

Build the Windows executable and bundled Rust FFS with:

```powershell
npm run tauri:ci
```

The outputs are `target/release/NvStrapsReBar.exe` and
`target/x86_64-unknown-uefi/release/NvStrapsReBar.ffs`. The Tauri build embeds the verified FFS.

Additional gates:

```powershell
npm run test:e2e
npm run check:firmware
npm run check:riir
```

On Linux with QEMU and OVMF installed, `npm run test:qemu` boots an injected copy of OVMF with an
isolated copied variable store. It never accesses host NVRAM.

## Windows configuration

The `Configure` workspace inventories NVIDIA adapters, reads the existing EFI configuration and
driver status, validates drafts against the current topology, and writes only after explicit
confirmation. A successful write is read back byte-for-byte and still requires a reboot before
the DXE driver can apply it. Administrator elevation is requested only for the privileged UEFI
variable boundary.

Newer boards normally use GPU-side Turing auto-configuration and system-default PCI sizing. Older
boards may also need an explicit PCI target size, but this must follow the exact analyzed board
profile rather than trial-and-error defaults.

## NVIDIA evidence and application profiles

The app invokes the installed `nvidia-smi.exe` read-only and records BAR1 totals matched to the
pinned Windows PCI inventory. This proves what the installed NVIDIA driver reports; it does not
prove that every application uses ReBAR.

Per-application enablement remains in the official
[NVIDIA Profile Inspector](https://github.com/Orbmu2k/nvidiaProfileInspector). The app downloads
one pinned release from its official GitHub repository, verifies its archive and installed files,
exports an immutable backup, and then launches the UI. It never silently chooses game profiles.

## Implementation and contracts

- [Rust UEFI implementation status](docs/RUST_UEFI_PORT.md)
- [Tauri backend contract](docs/TAURI_BACKEND.md)
- [RIIR and one-click deployment boundaries](docs/RIIR_AND_ONE_CLICK.md)

The repository-owned runtime and build path are Rust, TypeScript, shell, and data. CI rejects
tracked C/C++ and the removed C/EDK2 build trees. Windows, WebView2, vendor firmware, motherboard
flash logic, the NVIDIA driver, GPU vBIOS, QEMU/OVMF, and optional third-party tools remain
external owners rather than being misrepresented as rewritten code.

## Credits

This work builds on findings from [envytools](https://github.com/envytools/envytools), @mupuf,
@Xelafic, and the original [ReBarUEFI](https://github.com/xCuri0/ReBarUEFI) project. The pinned
legacy patch catalogs retain their upstream provenance and hashes.
