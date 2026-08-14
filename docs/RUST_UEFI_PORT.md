# Rust UEFI implementation status

The repository builds a stable-Rust AMD64 UEFI boot-service driver, packages it as an FFS file, and
injects it into supported firmware volumes without C/C++, EDK2, Python, `pefile`, `GenSec`, or
`GenFfs`. The former C DXE implementation and native build path have been removed; Rust is the
canonical implementation.

> **The artifact is not hardware-verified.** OVMF proves automatic DXE dispatch,
> configuration-variable decoding, and host-bridge hook installation, but no recoverable trial has
> verified the complete path on real NVIDIA hardware and a pinned vendor firmware image. The
> injector creates a new output and never overwrites its input; it is an artifact-preparation tool,
> not a flasher.

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
injection of the same file GUID. It boots twice against an isolated copy of the OVMF variable
store. The first boot proves status 40 (unconfigured), then writes the smallest valid 14-byte test
configuration. The second boot requires the exact status value 30 with no encoded EFI error,
which proves that the configured path installed the PCI host-bridge hook. Logs, hashes, and a
receipt remain under `target/qemu-smoke/`; CI uploads that directory on every Linux run.

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
5. QEMU/OVMF proves that the driver is dispatched, remains resident, and installs its hook.
6. FFS generation and injection are parsed back independently and duplicate injection is rejected.

The remaining gate is deployment evidence, not a source-porting task: a recoverable physical trial
must prove the pinned vendor image, boot, EFI configuration write/readback, restart, DXE status, and
BAR1 result on the exact machine profile. CI artifacts prove their recorded software checks only;
they are not approval to flash a physical board.
