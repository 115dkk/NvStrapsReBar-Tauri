# Rust UEFI implementation status

The repository builds a stable-Rust AMD64 UEFI boot-service driver, packages it as an FFS file, and
injects it into supported firmware volumes without C/C++, EDK2, Python, `pefile`, `GenSec`, or
`GenFfs`. The former C DXE implementation and native build path have been removed; Rust is the
canonical implementation.

> **Hardware-verified on one board.** The Rust DXE has run on a physical machine: an MSI MAG B660
> TOMAHAWK WIFI DDR5 (MS-7D41, BIOS 7D41vAO) with an RTX 2060 12GB accepted the injected image
> through M-FLASH, reported status 40 before configuration, and exposed a 16 GiB BAR1 after the app
> configured it ([issue #39](https://github.com/115dkk/NvStrapsReBar-Tauri/issues/39)). OVMF proves
> automatic DXE dispatch, configuration-variable decoding, host-bridge hook installation, S3 Save
> State protocol access and a complete S3 suspend/resume cycle on every CI run. Each further board
> is its own trial. The injector creates a new output and never overwrites its input; it is an
> artifact-preparation tool, not a flasher.

## Reproducible validation

Install the stable UEFI target once:

```text
rustup target add x86_64-unknown-uefi
```

Then run:

```text
npm run check:firmware
```

The command builds `target/x86_64-unknown-uefi/release/NvStrapsReBar.efi`, rejects images that are
not AMD64 PE32+ boot-service drivers or lack `NX_COMPAT`, writes `NvStrapsReBar.ffs`, and parses the
result back. The parser verifies the historical file GUID, DRIVER type, PE32 and UI sections,
UTF-16 name, alignment, size fields, state, header checksum, and file checksum.

The FFS writer follows the same standard-header order as EDK2 `GenFfs`: calculate the header
checksum while checksum/state fields are zero, calculate the body checksum, and finally set the
three valid-state bits. Unit tests pin the resulting standard header and section layout.

## Miri unsafe-code validation

Install nightly Miri and run the same command used by the dedicated Windows CI job:

```text
rustup toolchain install nightly --component miri --profile minimal
npm run check:miri
```

The gate interprets `nvstraps-core` and the host build of `nvstraps-uefi`. In particular, its tests
execute the exact volatile reads and writes used for NVIDIA BAR1 strap MMIO against live, aligned
Rust allocations, so Miri checks pointer provenance, alignment, initialization, and access rules
inside that unsafe boundary. The production adapter supplies the physical MMIO addresses only
after the existing BAR0 validation and temporary mapping transaction.

Miri does not emulate UEFI boot services, protocol callbacks, PCI configuration space, or Windows
SetupAPI/EFI-variable calls. Those target-only unsafe blocks remain under UEFI/Windows compilation,
warning-free Clippy, native tests, transaction simulations, and the QEMU/OVMF dispatch test. A
passing Miri job is dynamic evidence for the interpreted paths, not a claim that every external
firmware or operating-system call ran under Miri.

## OVMF integration test

On Linux, install QEMU and OVMF and run:

```text
sudo apt-get install ovmf qemu-system-x86
npm run test:qemu
```

The harness builds the release driver, injects it into a copied OVMF image, and rejects a second
injection of the same file GUID. It then boots four times against an isolated copy of the OVMF
variable store, each boot driven by a UEFI shell `startup.nsh` from `tests/qemu/`:

1. The first boot proves status 40 (unconfigured), then writes the smallest valid 14-byte test
   configuration.
2. The second boot requires the exact status value 30 with no encoded EFI error, which proves
   that the configured path installed the PCI host-bridge hook. It then writes the same
   configuration with global mode 1, the registry-driven mode the app uses for "Automatic".
3. The third boot requires status 20 (configured) with no encoded EFI error. With a GPU mode set,
   the driver locates and opens the PI S3 Save State protocol before it installs the hook, and a
   failure there would land in the status variable as EFI error location 19 or 20.
4. The fourth boot runs `NvStrapsS3Probe.efi`, the test application in `crates/nvstraps-s3-probe`.
   It reads the status variable, parses the ACPI tables for the FACS, the PM1a control port and the
   `_S3`/`_S5` sleep types, copies a 32-bit protected-mode stub into a page below 1 MiB, publishes
   it as `FACS.XFirmwareWakingVector`, and writes `SLP_TYP=S3 | SLP_EN` to the PM1a control port.
   QEMU suspends; `scripts/qemu-s3-wakeup.mjs` watches the QMP socket, sends `system_wakeup` after
   the `SUSPEND` event, and requires `WAKEUP` followed by a guest-initiated `SHUTDOWN`. On resume
   OVMF's PEI phase replays the saved boot script and jumps to the stub, which prints
   `S3-PROBE: resumed from S3` on the serial port and requests S5.

The probe uses the 32-bit waking vector on purpose. OVMF's X64 PEI phase enters a 16-bit
real-mode vector through transition code that lives above 1 MiB, and under QEMU's TCG that code
faults as soon as the instruction pointer is truncated to 16 bits. EDK2 enters the 32-bit vector
with paging off, flat segments and a valid stack, which needs no mode switch in the stub.

QEMU has no NVIDIA GPU, so the boot script holds no NvStrapsReBar BAR writes; the cycle proves the
driver's S3 Save State integration and the firmware's own suspend/resume path with the driver
present, not the BAR restore itself. Logs, QMP events, hashes, and a receipt remain under
`target/qemu-smoke/`; CI uploads that directory on every Linux run.

Alternative OVMF paths can be supplied through `NVSTRAPS_OVMF_CODE` and
`NVSTRAPS_OVMF_VARS`. This test never reads or writes the host machine's NVRAM.

## Desktop packaging

`npm run prepare:desktop` installs the stable Rust UEFI target idempotently, builds the release
driver, packages and independently inspects its FFS, and leaves the verified artifact at
`target/x86_64-unknown-uefi/release/NvStrapsReBar.ffs`. Tauri runs this preparation automatically
before development and release builds and bundles the FFS under the fixed resource name
`NvStrapsReBar.ffs`. End users therefore do not need Rust, EDK2, Python, or firmware packaging
tools; those are build-time concerns only.

## RIIR and validation gates

`npm run check:riir` rejects tracked C/C++ source, the deleted C/EDK2 trees, and their superseded
build helpers. CI runs that gate on Windows and Linux.

The following implementation gates are complete:

1. Rust owns config/status variable access and exact status reporting.
2. Rust locates and hooks the PCI host-bridge resource-allocation protocol.
3. PCI discovery, resizable-BAR programming, NVIDIA strap MMIO, and bridge guards have canonical
   Rust implementations and host-side vectors.
4. S3 resume writes and setup-variable/CMOS reset guards have Rust implementations and host tests.
5. QEMU/OVMF proves that the driver is dispatched, remains resident, installs its hook, opens the
   S3 Save State protocol, and survives an ACPI S3 suspend/resume cycle.
6. FFS generation and injection are parsed back independently and duplicate injection is rejected.

Deployment evidence exists for one machine profile. The MSI MAG B660 TOMAHAWK WIFI DDR5 trial in
issue #39 covered the vendor image, M-FLASH, the first boot (status 40), the EFI configuration
write and readback through the app, the restart, the configured DXE status and the 16 GiB BAR1
result. That trial does not transfer to other boards: CI artifacts prove their recorded software
checks only, and each new board needs its own recoverable trial before its image is treated as safe
to flash. Sleep and resume with the expanded BAR has not been reported from physical hardware;
the QEMU S3 cycle below covers the firmware side of that path without a GPU.
