# Turning it on without changing the BIOS (external EFI route)

The firmware-injected driver needs a BIOS file that the board's updater accepts after NvStrapsReBar
changed it. Some updaters check the maker's signature over that part of the file and refuse it
(issue #54, MSI M-FLASH on the MAG Z790 TOMAHAWK WIFI). The external route leaves the BIOS alone: a
small EFI program starts before Windows, moves the GPU's BAR1 to a larger size, and then starts
Windows Boot Manager.

It is **experimental**. It has run on QEMU/OVMF only; no physical board has been tried yet.

## In the app

Home → "Without changing the BIOS" (also in the menu, and under the signed-BIOS warning). The page
offers two modes:

| Mode | Where the programs go | What changes on the PC | How a boot reaches the program |
|---|---|---|---|
| Try from a USB drive | a FAT32 USB drive, as `\EFI\BOOT\BOOTX64.EFI` | nothing in the firmware or on the disks | the user chooses the USB drive in the firmware boot menu |
| Install on this PC | the EFI system partition that holds Windows Boot Manager | two `Boot####` entries of its own, `BootNext`, and, after a good try, `BootOrder` | `BootNext` for the check and the try, then first in `BootOrder` |

Both modes go through the same steps:

1. **Check.** `NvStrapsDiagnostic.efi` runs once, reads PCI configuration, root and bridge decode
   windows, free GCD MMIO, driver bindings, GOP framebuffers and Turing straps, writes
   `\EFI\NvStraps\diagnostic.json` on its own volume and returns to the firmware, which starts
   Windows. It never sizes BARs by writing all ones.
2. **Try.** In Windows the app plans BAR1's new place for the chosen GPU and size, pins Windows Boot
   Manager by SHA-256, and writes `NvStrapsLoader.efi` with the plan. At the next start the loader
   compares a fresh diagnostic with the plan, reserves the destination, moves BAR1, programs the
   straps, verifies the readback, writes a receipt, and starts Windows Boot Manager with
   `LoadImage`/`StartImage`. The app then shows the size Windows sees.
3. **Every start** (install mode only). After a good try the loader goes first in `BootOrder`.
   Windows Boot Manager stays next, so when the loader refuses or fails it returns to the firmware
   and Windows starts as before.

The diagnostic and the loader of one mode always run from the same medium, because the loader
requires the fresh snapshot to equal the diagnostic's byte for byte, and driver bindings differ
between a USB boot and an EFI-system-partition boot.

The page reads its state from the medium and the firmware variables after every restart, so it
continues where it stopped; nothing about the route is kept in app storage.

### Files and boot entries

| Path on the medium | Written by |
|---|---|
| `\EFI\NvStraps\owner.json` | the app, with the stage and the time it wrote it |
| `\EFI\NvStraps\diagnostic.json` | the diagnostic |
| `\EFI\NvStraps\plan.json` | the app |
| `\EFI\NvStraps\receipt-xxxxxxxx.txt` | the loader, before it starts Windows |
| `\EFI\NvStraps\last-error.txt` | the diagnostic or the loader when they stop; a later success deletes it |
| `\EFI\NvStraps\NvStrapsDiagnostic.efi`, `NvStrapsLoader.efi` | the app (install mode) |
| `\EFI\BOOT\BOOTX64.EFI` | the app (USB mode: the current stage) |

On a USB drive the app writes `BOOTX64.EFI` only when the drive has none, or when `owner.json` proves
the existing one is the app's own (its SHA-256 matches). Removal deletes only these files. In install
mode the entries are `NvStrapsReBar diagnostic` and `NvStrapsReBar`, on the same partition as Windows
Boot Manager; removal deletes them, takes them out of `BootOrder` and clears a `BootNext` that names
them. No other `Boot####` variable is written or reordered.

### What the app refuses or asks first

- **Secure Boot on without the project certificate in `db`.** Release builds sign both programs; the
  page then walks the user through adding the certificate to BIOS once (see "Secure Boot" below).
  A development build has unsigned programs, so the page asks to turn Secure Boot off instead.
- **BitLocker on the system drive.** Every boot through an extra EFI program changes PCR 4, so a
  TPM-protected drive would ask for its recovery key. When protection is on, the restart dialog says
  so and the app pauses protection for that one restart (`Win32_EncryptableVolume.DisableKeyProtectors`,
  `DisableCount = 1`); Windows turns it back on by itself.
- **A GPU that shows the picture, or that a firmware driver uses.** Its BAR1 cannot be moved while
  the GOP framebuffer lives in it. The page says so under that GPU and suggests connecting the
  monitor to the motherboard and letting the BIOS use the built-in graphics first.
- **No room.** The loader only places BAR1 inside the existing root and bridge windows and free GCD
  MMIO. It does not enlarge bridge windows, rewrite ACPI or restart PCI enumeration.

### Known limits

- **Windows Boot Manager updates.** The plan pins `bootmgfw.efi` by SHA-256. When Windows replaces
  it (the 2023 Secure Boot certificate rollout does so at a restart), the loader refuses to start it,
  records why, and the firmware boots Windows normally without the larger BAR. The page shows
  "Windows Boot Manager was updated" and rewrites the plan with the new hash on request. With Secure
  Boot off, `LoadImage` does not check signatures, so the pin is the only check on what the loader
  starts; with Secure Boot on, the firmware also checks Windows Boot Manager's own signature.
- **Boot order.** Windows or a firmware update may move Windows Boot Manager back to the front of
  `BootOrder`; the loader then stops running until the app puts it first again.
- **Cold boot only.** The loader installs no S3 resume script. Sleep (S3), hibernation and Fast
  Startup are outside what it supports.
- **Physical boards.** Not tried yet; the receipt only says the loader reached the handoff. The app
  checks the size Windows reports afterwards.

## Secure Boot

Release builds sign `NvStrapsDiagnostic.efi` and `NvStrapsLoader.efi` with the project certificate
[`secure-boot/NvStrapsReBar-db.cer`](../secure-boot/NvStrapsReBar-db.cer) (RSA-2048, SHA-256, valid to
2046-10-22, SHA-256 fingerprint `2dcb22b1…a401a744`). Its private key exists only in the GitHub Actions
secret `NVSTRAPS_UEFI_SIGNING_KEY`; the Release workflow refuses to publish without it and checks both
shipped programs with `nvstraps-external-tool check-signed` and with Windows' own Authenticode check.

With Secure Boot on, the page reads `db` and, when the certificate is missing, shows how to add it
once: save `NvStrapsReBar-db.cer` to a FAT32 USB drive from the page, restart into BIOS setup (BitLocker
pauses for that restart only, because a `db` change alters PCR 7), and append it under Key Management →
Authorized Signatures (db). The page lists the menu path for MSI, ASUS and GIGABYTE. Use **Append**
only: "Set New" or clearing keys also removes Microsoft's keys. Restoring default keys and some BIOS
updates remove the certificate again; the page then asks for it again. Adding both programs' image
hashes with "Enroll Efi Image" also counts, but has to be redone with every release.

How it is signed: `nvstraps-external-tool sign` builds the Authenticode structure itself (PE image
digest, `SpcIndirectDataContent`, CMS `SignedData` without timestamps, so the output is deterministic)
and asks `openssl` only for the RSA PKCS#1 v1.5 signature over the signed attributes, so no RSA code
enters the Rust dependency tree. CI proves it on firmware: `npm run test:qemu:secure-boot` enrols
throwaway PK/KEK/db keys in OVMF with Secure Boot on, boots the diagnostic signed with the db key (its
report says `secureBoot: true`), and checks that the unsigned diagnostic and a signed one with one
changed byte are refused; `osslsigncode` verifies the same signature independently. On Windows the
Tauri workflow signs with a throwaway key and requires `Get-AuthenticodeSignature` to accept it.

Research of 2026-10-27 on the other routes; the sources are listed at the end.

| Route | For this project |
|---|---|
| Microsoft third-party UEFI CA signature (Hardware Dev Center) | Not possible for an individual. Since 2025-10-20 every non-shim submission needs an annual OCP S.A.F.E. audit (quoted at USD 80k–250k per component), a signed SPDX SBOM in a `.sbom` section whose vendor matches an EV certificate, and an organisation's Hardware Dev Center account. Since 2026-06-26 Microsoft returns only binaries signed with Microsoft UEFI CA 2023. |
| An own shim through shim-review | Not possible for an individual: it needs a legal entity, the Hardware Dev Center EV certificate, HSM-held keys and about 2–3 months of review. |
| A distribution's Microsoft-signed shim plus MokManager (as Ventoy does) | Possible with conditions: both images need a `.sbat` section (shim refuses images without one), each PC enrols the project's or its own certificate once in MokManager, and the project inherits every SBAT and dbx revocation of the borrowed shim (Ventoy broke this way in August 2024). |
| The user appends a certificate to `db` in BIOS setup | **Implemented** (above). MSI, ASUS and GIGABYTE offer Key Management → Authorized Signatures → Append (and "Enroll Efi Image"). "Set New" or clearing keys instead of Append can leave Windows unbootable or the GPU's GOP blocked, and restoring default keys or some BIOS updates remove the entry again. |

Both built images meet Microsoft's static PE rules: `NX_COMPAT` is set (DllCharacteristics `0x8160`),
SectionAlignment is `0x1000`, and no section is both writable and executable. They carry no `.sbat`
or `.sbom` section, which only the shim and Microsoft routes would need. Every route still changes
PCR 4 when the loader runs, so BitLocker needs the same one-restart pause.

Sources: [Microsoft UEFI signing requirements v9.0](https://techcommunity.microsoft.com/blog/hardware-dev-center/updated-microsoft-uefi-signing-requirements/1062916),
[signing with the 2023 certificates](https://techcommunity.microsoft.com/blog/hardware-dev-center/signing-with-the-new-2023-microsoft-uefi-certificates-what-submitters-need-to-kn/4455787),
[UEFI CA memory mitigations](https://techcommunity.microsoft.com/blog/hardware-dev-center/new-uefi-ca-memory-mitigation-requirements-for-signing/3608714),
[KB5062710 certificate expiry](https://support.microsoft.com/en-us/servicing/os/secure-boot/2025/06/windows-secure-boot-certificate-expiration-and-ca-updates),
[shim-review](https://github.com/rhboot/shim-review), [shim 16.1](https://github.com/rhboot/shim/tree/16.1),
[Ventoy Secure Boot](https://github.com/ventoy/Ventoy/blob/master/SecureBoot.md),
[MSI Intel 600 BIOS manual](https://download-2.msi.com/archive/mnu_exe/mb/Intel600BIOS.pdf),
[ASUS key management](https://www.asus.com/support/faq/1056845/),
[BitLocker for OEMs (PCR 7 binding)](https://learn.microsoft.com/en-us/windows-hardware/design/device-experiences/oem-bitlocker),
[TCG PC Client PFP](https://trustedcomputinggroup.org/wp-content/uploads/TCG-PC-Client-Platform-Firmware-Profile-Version-1.06-Revision-52_pub-3.pdf).

## Command line

The release's `external/` folder also contains `nvstraps-external-tool.exe`, a console program for
working with the same files by hand. Started without arguments (for example by double-clicking it)
it prints its usage, points to the app, and waits for Enter.

```powershell
.\nvstraps-external-tool.exe inspect .\diagnostic.json
.\nvstraps-external-tool.exe plan .\diagnostic.json 0 1 0 0 8192 `
  '\EFI\Microsoft\Boot\bootmgfw.efi' .\bootmgfw.efi `
  --cold-boot-experimental .\plan.json
.\nvstraps-external-tool.exe package .\NvStrapsDiagnostic.efi .\NvStrapsLoader.efi `
  .\plan.json .\external-package
.\nvstraps-external-tool.exe inject .\original.fd .\NvStrapsReBar.ffs .\patched.fd
```

`inject` keeps the injector's structural checks and refuses an image whose recognised signed-update
layout covers the injection.

## Proof in CI

- `npm run test:qemu:external` boots unmodified OVMF with disk-loaded EFI files: the production
  diagnostic enumerates QEMU's PCI and root resources and writes its report; a debug-only GPU model
  feeds the real host planner and packager; the loader runs the shared transaction against that
  model, measures 8 GiB from the strap fields and starts a successor with real `LoadImage`/`StartImage`;
  return from the successor exercises restoration; production rejects synthetic plans; a changed
  successor is refused before any write; a permanent write/restore failure halts before firmware
  fallback. The original OVMF hash stays unchanged, and only logs and reports are uploaded.
- The real-app journeys (`tests/real-app/external-boot.spec.ts`, see
  [REAL_APP_E2E.md](REAL_APP_E2E.md)) press the page's buttons in the real Tauri application through
  both modes, with the EFI system partition and the USB drive as folders and the boot variables in
  the simulated machine.
- Unit tests cover load-option and device-path parsing, the boot-entry changes (foreign entries
  untouched), the medium layout and ownership proof, candidate sizes, and the backend's command
  sequence against an in-memory platform.

The GPU model does not emulate NVIDIA silicon. Physical Turing writes, Windows' view of the new
aperture on real hardware, and sleep/resume need hardware trials.

Source owners: [planner and executor](../crates/nvstraps-external/src/lib.rs),
[UEFI programs](../crates/nvstraps-external-efi/src/app.rs),
[host files and boot entries](../crates/nvstraps-external-tool/src/lib.rs),
[app commands](../src-tauri/src/external_boot/mod.rs), [page](../src/guided/external-boot.tsx).
