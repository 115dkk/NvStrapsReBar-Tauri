# Rust UEFI port status

The repository can now build a stable-Rust AMD64 UEFI boot-service driver and package it as an
FFS file without EDK2, Python, `pefile`, `GenSec`, or `GenFfs`.

> **Do not flash the Rust artifact yet.** The current entry point proves the image, linker, shared
> `no_std` contract, and FFS pipeline only. It does not yet install the PCI host-bridge hook or
> program hardware. The existing `ReBarDxe` build remains the deployable implementation until the
> parity gates below pass.

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

## Deletion gates for the C DXE

The C firmware implementation and its EDK2 workflow must remain until all of these are true:

1. Rust owns config/status variable access and exact status reporting.
2. Rust locates and hooks the PCI host-bridge resource-allocation protocol.
3. PCI discovery, resizable-BAR programming, NVIDIA strap MMIO, and bridge guards match the C
   behavior against golden vectors.
4. S3 resume writes and setup-variable/CMOS reset guards have Rust implementations.
5. A QEMU/OVMF load test proves the driver remains resident and installs its hook.
6. A recoverable hardware trial proves boot, write, reboot, and status readback on a pinned machine
   profile.

CI deliberately does not upload the Rust FFS as a deployable artifact before those gates pass.
