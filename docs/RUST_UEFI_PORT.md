# Rust UEFI port status

The repository can now build a stable-Rust AMD64 UEFI boot-service driver, package it as an FFS
file, and inject it into supported firmware volumes without EDK2, Python, `pefile`, `GenSec`, or
`GenFfs`.

> **Do not flash the Rust artifact yet.** OVMF proves automatic DXE dispatch, configuration-variable
> decoding, and host-bridge hook installation, but no recoverable trial has verified real NVIDIA
> hardware or a vendor firmware image. The injector creates a new output and never overwrites its
> input; it is an artifact-preparation tool, not a flasher.

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

## Deletion gates for the C DXE

The C firmware implementation and its EDK2 workflow must remain until all of these are true:

1. Rust owns config/status variable access and exact status reporting. **Passed.**
2. Rust locates and hooks the PCI host-bridge resource-allocation protocol. **Passed in OVMF.**
3. PCI discovery, resizable-BAR programming, NVIDIA strap MMIO, and bridge guards match the C
   behavior against golden vectors.
4. S3 resume writes and setup-variable/CMOS reset guards have Rust implementations. **Passed in
   host-side tests; hardware behavior remains unverified.**
5. A QEMU/OVMF load test proves the driver remains resident and installs its hook. **Passed.**
6. A recoverable hardware trial proves boot, write, reboot, and status readback on a pinned machine
   profile.

CI uploads validation evidence, not a deployable firmware image, until the hardware gate passes.
