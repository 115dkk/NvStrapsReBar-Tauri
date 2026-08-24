# UEFI unsafe review map

The DXE crate denies `unsafe_code` by default. Seven reviewed files receive a
local exception, and `npm run check:unsafe` rejects unsafe syntax in any other
DXE source or growth beyond the per-file budget.

The gate's syntax count fell from 46 sites on the parent `master` revision to
32 sites here. Excluding the two `unsafe_protocol` declarations, the literal
Rust `unsafe` count fell from 44 to 30. `setup_variable.rs`, `straps.rs`, and
`uefi_adapter.rs` are now unsafe-free.

| Module implementation | Unsafe obligation hidden behind its Interface |
|---|---|
| `exclusive.rs` | One `UnsafeCell` dereference is admitted only after an atomic claim. Reentrant callback access returns `Busy`; a drop guard releases the claim on every returning or unwinding path. |
| `host_bridge.rs` | PI owns the opened protocol interfaces and invokes the declared ABI while boot services are active. The context is fully initialized before publication and retained for that lifetime. Nullable callback slots are represented as `Option<extern fn>` and rejected before installation. |
| `main.rs` | The allocation-free panic path checks each raw UEFI table pointer before calling console, stall, or reset services. Its final `hlt` loop is reached only when firmware cannot reset the machine. |
| `mmio.rs` | `MappedBar0` can be created only after the matching PCI remap succeeds. Its private volatile reads and writes use aligned register addresses proven to lie inside a `ValidatedGpuWindow`. |
| `pci.rs` | UEFI supplies the live root-bridge handle. All PCI register widths, alignment, and 4 KiB configuration-space bounds are checked before protocol access; MMIO proof creation occurs only after the BAR0 and command writes succeed. |
| `pool.rs` | One owner tracks the initialized prefix of each UEFI pool allocation. Only the private `u8`/`u16` zero-valid types can expose a zero-filled slice; partial construction drops only initialized values and frees exactly once. |
| `s3.rs` | The PI variadic calls use fixed opcodes, widths, argument counts, and synchronously live data pointers. A null protocol interface or write function is rejected as `UNSUPPORTED`. |

## Inputs absorbed before unsafe code

- BAR0 must be nonzero, below 4 GiB, power-of-two sized, aligned to its full
  aperture, and large enough to contain both NVIDIA strap registers.
- Device transactions reject malformed PCI device/function values and strap
  selectors before calling an Adapter.
- The UEFI Adapter refuses strap programming without a live `MappedBar0` and
  consumes that proof before restoring BAR0.
- Setup-variable data is capped at 1 MiB. Variable names are capped at 16,384
  UTF-16 units and enumeration at 4,096 successful entries.
- Host-bridge protocol count is capped at 256. Invalid phases and malformed PCI
  device/function callback fields never reach the Firmware device transaction.

## Residual trust

No DXE driver can prove that a non-null function address supplied by the
platform points to honest executable firmware, or that a successfully mapped
physical BAR belongs to correctly functioning hardware. Those are PI/UEFI and
machine trust assumptions, not facts Rust can validate. The code instead
rejects representable malformed inputs, prevents Rust aliasing on callback
reentry, confines raw operations to the table above, and verifies the remaining
contracts with Miri, target Clippy, OVMF/QEMU, and retail-image packing tests.
