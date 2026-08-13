# RIIR and one-click deployment boundaries

This document deliberately treats two different goals separately:

1. replacing repository-owned C/C++ with Rust; and
2. reducing deployment to the shortest truthful, recoverable workflow.

They overlap, but neither one proves the other. A Rust implementation can still require manual
firmware work, and a one-click adapter can still invoke a separately maintained executable.

## 1. RIIR boundary

### Repository-owned code

The tracked runtime and build pipeline are Rust, TypeScript, shell, and data. The former Windows
C++ configurator, C DXE driver, EDK2 descriptors, C headers, Python FFS tooling, and native build
workflows have been removed. `npm run check:riir` rejects any tracked C/C++ source, the superseded
`ReBarState/` or `ReBarDxe/` trees, and their old build helpers.

Rust now owns:

- the canonical no-std configuration, status, PCI, strap, registry, CRC, and boot-policy contract;
- the AMD64 UEFI boot-service driver, PCI host-bridge hook, setup guards, and S3 script adapter;
- PE/COFF validation, FFS construction, firmware-volume injection, EFI/Tiano/LZMA handling, and
  the pinned legacy patch catalogs;
- Windows device discovery, EFI variable access, validation, verified write/readback, elevation,
  machine identity, deployment plans, artifact storage, and reboot policy; and
- verified adapters for `nvidia-smi` evidence and NVIDIA Profile Inspector installation, backup,
  and launch.

CI enforces this source boundary on Windows and Linux. It also builds the `x86_64-unknown-uefi`
target, independently parses the generated FFS, runs the host tests, and boots an injected copy of
OVMF under QEMU. The QEMU harness uses copied variable storage and never touches host NVRAM.

### What RIIR does not mean

The project does not and should not claim to have rewritten code it does not own. Windows,
WebView2, the NVIDIA display driver and NVAPI, vendor UEFI firmware, motherboard flash logic, GPU
microcode/vBIOS, QEMU/OVMF, and optional third-party tools remain outside this repository.

The Windows client may execute two narrowly pinned external capabilities:

- the installed NVIDIA `nvidia-smi.exe`, read-only, to collect BAR1 evidence; and
- a content-addressed official NVIDIA Profile Inspector release, after archive and file hashes are
  verified. Before its UI is opened, customized NVIDIA profiles are exported to an immutable
  backup.

Those are adapter boundaries, not hidden source dependencies. Reimplementing either proprietary
NVIDIA interface in Rust would add reverse-engineering and driver-compatibility risk without
removing the underlying proprietary driver.

### Remaining proof gap

Rust source replacement is complete at the repository boundary. Real motherboard deployment is
not thereby proven. The Rust DXE path has host tests and an OVMF boot test, but a recoverable trial
on the pinned physical machine is still required before claiming that a prepared image is safe to
flash. Until that trial exists, hardware behavior remains explicitly unverified.

## 2. One-click boundary

### Automated in the application

The intended top-level workflow is a `MachineProfile` plus an append-only `DeploymentPlan`. The
application can perform these steps without an external build environment:

1. inventory the exact board, BIOS, GPU, PCI bridge, and BAR0 topology;
2. inspect and hash a user-selected vendor firmware image;
3. pin the board path, recovery route, vendor install route, source image, and current topology;
4. reject a changed board, BIOS, GPU, BAR0 range, source image, or built-in patch catalog;
5. apply selected legacy-board patches when the profile explicitly requires them;
6. inject the bundled Rust FFS into a new immutable output without overwriting the source;
7. export a verified package containing the flash artifact, original recovery image, manifests,
   receipts, operator instructions, and SHA-256 list;
8. validate and write the NvStrapsReBar EFI configuration with byte-for-byte readback;
9. preview and, after a saved-work acknowledgement, request the next Windows restart into the
   firmware UI; and
10. collect NVIDIA BAR1 evidence, install the pinned official Profile Inspector release, back up
    customized profiles, and open its UI.

Windows supports directing the next restart to the firmware UI with `shutdown /r /fw`. The adapter
uses a zero-second timeout without `/f`: Microsoft documents that `/f` can lose unsaved data and
that a positive timeout implies `/f`. See the
[Microsoft `shutdown` command](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/shutdown).

NVIDIA documents BAR1 total, used, and free memory in `nvidia-smi -q`; this is evidence reported by
the installed driver, not proof that every application uses ReBAR. See the
[NVIDIA System Management Interface documentation](https://docs.nvidia.com/deploy/nvidia-smi/index.html).

### Still manual or physical

No generic application can truthfully or safely collapse the following steps into one button:

- obtain the exact official firmware image for the exact board revision;
- confirm that the selected recovery route is documented or has actually been tested;
- review the prepared image and hashes before crossing the flash boundary;
- enable native ReBAR or Above 4G Decoding, disable CSM where required, and inspect any other
  board-specific firmware settings;
- use the vendor firmware flasher or a physical flashback mechanism;
- wait through the firmware update without interrupting power;
- press a rear-panel button, move a USB drive, clear CMOS, attach an SPI programmer, or change a
  GPU; and
- recover a machine that no longer reaches POST.

For the detected MSI PRO Z690-A DDR4 (MS-7D25), the vendor-documented route is M-FLASH and the
documented recovery-capable physical route is the Flash BIOS Button. MSI requires the flashback
image to be named `MSI.ROM`, placed at the USB-drive root, and activated through the rear-panel
port and button. These are physical gates, not missing UI controls. See the
[official MSI PRO Z690-A DDR4 manual](https://download.msi.com/archive/mnu_exe/mb/PROZ690-AWIFIDDR4_PROZ690-ADDR4100x150.pdf).

The application may prefill this exact board's documented route, open the instructions, prepare
the correctly named artifact, and take the user directly to firmware setup. It must still stop for
human confirmation before flashing or any physical action.

### External tools covered by adapters

End users no longer need EDK2, BaseTools, Python, `pefile`, `GenSec`, `GenFfs`, a C/C++ compiler, or
a separate firmware-volume editor for the supported preparation path. These functions are in Rust
and ship with the desktop application.

NVIDIA Profile Inspector remains an external UI because NVIDIA's per-application policy database
is not this project's data model. The app downloads one pinned official release, verifies every
installed file, records a manifest, exports a backup, and launches it. It does not silently choose
per-game policies. The official tool documents its import/export command line and advanced-setting
risks in the
[NVIDIA Profile Inspector repository](https://github.com/Orbmu2k/nvidiaProfileInspector).

### Product definition

Here, “one click” should mean one guided, resumable deployment plan with automatic preflight,
artifact preparation, evidence collection, and direct handoff to the next real owner. It must not
mean bypassing firmware signatures, invoking an unpinned flasher, pretending a reboot completed a
manual UEFI change, or hiding the recovery boundary.

The safest maximum for this machine is therefore:

`select official image -> confirm detected profile/recovery -> prepare and export -> reboot to
firmware UI -> perform vendor flash/settings -> boot Windows -> verify status and BAR1 -> open
backed-up Profile Inspector`

Every mismatch is a hard stop. Manual gates stay visible in the plan until evidence from their
actual owner exists.
