<!-- Research notes for the planned pre-export artifact/flasher compatibility
     checks (feature plan item 5). Produced 2026-08-21 by a Daybreak Blue
     research agent with repository read access and web search; reviewed and
     committed by Claude. Nothing here is implemented yet; use it to scope the
     FirmwareValidationReceipt work. -->

# Vendor-flasher compatibility research

> **Read [FIRMWARE_INJECTION_FEASIBILITY.md](FIRMWARE_INJECTION_FEASIBILITY.md) first.**
> This document reasons from vendor documentation and public parser sources; it was
> written without running the injector against a single retail BIOS image. When that
> baseline measurement was taken on 2026-08-22, `inject_ffs` refused all five retail
> images tested. The current implementation now produces independently decoded
> artifacts for all five raw ROMs, including both domains in the two dual-copy images.
> The acceptance checks below are therefore downstream work again; the per-vendor
> route limits remain unchanged.

**Bottom line:** the image can support strong structural and protection-risk checks, but it cannot produce a reliable universal “this vendor flasher will accept/reject/partially write this image” verdict. The backend should report deterministic invariants, recognized protection envelopes, and conditional risks—not promise flasher behavior.

No repository files were created, modified, or deleted.

## A. Ranked implementable pre-export checks

### A.1 Recommended checks

| Rank | Check | What it detects | Integration point | Effort / confidence / false-positive risk | Exact promise and limitation |
|---:|---|---|---|---|---|
| **1** | **Outer geometry lock** | Changed total byte length; moved/resized FVs; changed FV block maps, erase polarity, or top-level offsets | Add `analyze_firmware_pair(original, patched)` in `crates/nvstraps-ffs/src/firmware.rs`; call after `inject_ffs` at `src-tauri/src/deployment.rs:470` and again before packaging at `crates/nvstraps-deploy/src/store.rs:325` | **S / High / Near-zero** | Proves the injector did not alter outer image geometry. It does not prove vendor acceptance or signature validity. |
| **2** | **Baseline-relative FV/FFS structural audit** | New malformed FV headers, block maps, extension offsets, FFS states, file/section bounds, checksums, alignment, and non-erased inter-file padding | New public audit API beside `inspect_firmware_envelope` at `crates/nvstraps-ffs/src/firmware.rs:61` | **M / High / Low** | Proves the patched image introduces no new PI-structure defect. Compare against the original so pre-existing vendor quirks do not become false blockers. Proprietary vendor records remain outside this promise. |
| **3** | **Recursive injected-driver identity** | Missing, duplicate, corrupted, wrong-type, or wrong-build `NvStrapsReBar.ffs`, including inside supported LZMA/Tiano containers | Extend recursive parsing in `crates/nvstraps-ffs/src/firmware.rs`; compare the extracted FFS and PE hash with the bundled artifact built at `crates/nvstraps-ffs/src/lib.rs:149` | **M / High / Low** | Proves exactly one parser-visible target FFS contains the intended PE, DEPEX, UI name, file type, and checksums. It does not prove the flashed bank is active or that DXE dispatch will occur. |
| **4** | **Capsule and signed-envelope classifier** | Standard UEFI capsule; AMI Aptio signed/unsigned capsule; malformed declared sizes; body offset; likely authentication invalidation | Replace the plausibility-only classifier at `crates/nvstraps-ffs/src/firmware.rs:61` | **M / High for known GUIDs / Near-zero** | Reliably classifies recognized wrappers and warns when changed bytes are inside a signed envelope. It cannot prove that a board enforces the signature or validate undocumented AMI certificate layouts. |
| **5** | **FV used-size and extension audit** | Injection beyond `EFI_FV_EXT_TYPE_USED_SIZE_TYPE`; malformed extension/header overlap; used size beyond `FvLength` | Harden `update_used_size` at `crates/nvstraps-ffs/src/firmware.rs:1486` | **S / High / Low** | Proves the driver lies within the FV’s advertised used prefix, avoiding flashers that program only that prefix. A stale-high used size is conservative and should not be blocked. |
| **6** | **Changed-range/blast-radius receipt** | Unexpected modifications outside the selected allocation, terminal PAD, containing compressed FFS, permitted alignment bytes, and used-size field | Generate after injection in `src-tauri/src/deployment.rs:470`; store in `InjectionReceipt` at `src-tauri/src/deployment.rs:89` | **M / High for direct injection, Medium for recompression / Low** | Proves all changes are explainable by the selected insertion path. LZMA recompression legitimately changes many bytes in one containing FFS, so it needs a containment rule rather than a small-byte-count rule. |
| **7** | **FIT/KM/BPM/IBB coverage analysis** | Valid FIT; Startup ACM; KM/BPM; IBB segments; whether changed bytes intersect manifest-declared IBB coverage; source digest mismatch | New `boot_guard.rs` under `crates/nvstraps-ffs/src`; attach findings to the validation receipt | **L / High after source-digest validation / Low for overlap, high if phrased as enforcement** | Proves whether changed bytes intersect ranges declared by the image. It cannot determine silicon fuse provisioning, measured versus verified policy, or failure response from the image alone. |
| **8** | **AMI post-IBB/vendor-hash analysis** | AMI V1/V2/V3 vendor hash file, PMDA/OBB-style hashed ranges, PFAT/BIOS Guard envelope, and changed-range intersection | Same security-analysis module as rank 7 | **L / Medium-high / Medium** | Detects stronger evidence that DXE/FvMain bytes are hashed even when they are outside Boot Guard IBB. OEM PEI enforcement and proprietary signature coverage may still be unknown. |
| **9** | **Pinned route filename and optional project-ID consistency** | Export name inconsistent with the board-specific route; known MSI project string inconsistent with the original vendor filename | Enforce at `crates/nvstraps-deploy/src/lib.rs:438` and before writing at `crates/nvstraps-deploy/src/store.rs:416` | **S for route; M for IDs / High for pinned route / Low** | Proves the package uses the explicitly established filename. It must not invent a filename or board mapping from generic image strings. |
| **10** | **Vendor-specific advisory records** | Gigabyte BIOS/OEM ID and BiosDataRecord, known MSI sign-on records, Intel descriptor, AMI ROM holes | Optional advisory parser; never a universal blocker | **M–L / Medium / Medium-high** | Reports recognized evidence and known historical rejection surfaces. It must not claim to reproduce proprietary flasher validation. |

### Export architecture

The clean design is one serializable `FirmwareValidationReceipt` containing:

- Original and patched SHA-256 and lengths
- FV geometry comparison
- Structural findings
- Recursive driver identity and PE hash
- Changed ranges and expected owning structures
- Capsule/protection classification
- FIT and protected-range findings
- Filename/route verdict

Create it during preparation, bind its hash to `StepId::VerifyPatchedArtifact`, then rerun the same analysis immediately before `export_deployment_package`. The current exporter verifies artifact identity and package hashes at `crates/nvstraps-deploy/src/store.rs:325-358` and `:497-502`, but does not rerun BIOS structural validation.

### A.2 Structural invariants already preserved

1. **Total file size**

   The injector starts from an equal-length copy and performs bounded replacements, so the returned outer image currently remains the same length. This is structurally true for both direct insertion and nested recompression, but it is not explicitly asserted as a postcondition or covered by a direct `patched.len() == original.len()` test.

2. **FV size and placement**

   `FvLength`, FV starts, and outer layout are not rewritten. Direct insertion does not relocate existing FFS files. Nested recompression can change the size of the containing FFS but is accepted only when it fits its existing aligned extent plus immediately trailing erased capacity; later FFS files are not moved.

3. **FV header checksum**

   FV headers are checked at `crates/nvstraps-ffs/src/firmware.rs:1619`. The used-size extension normally resides beyond `HeaderLength`, so increasing `UsedSize` does not normally require recalculating the base FV-header checksum. The parser should nevertheless reject an extension header that overlaps the checksummed base header or extends beyond the FV. [S3]

4. **FFS checksums, state, and alignment**

   The generated driver has its header and data checksums verified at `crates/nvstraps-ffs/src/lib.rs:197-334`. Rebuilt containing FFS files recalculate size and checksums at `crates/nvstraps-ffs/src/firmware.rs:1344`. File boundaries must remain 8-byte FV-relative aligned, with correct erase-polarity interpretation and erased padding. [S4]

5. **Terminal PAD handling**

   Only a terminal PAD file is replaced. Its extent is erase-filled before the driver is written, so hidden later files are not discarded. The remainder stays erased.

6. **Nested LZMA recompression**

   The decompressed inner image retains its size. Recompression may grow or shrink and produces broad byte changes inside the containing compressed FFS. The code verifies decompression round-trip equality before accepting the result. This is safe outer-layout behavior, but the receipt should explicitly explain the larger diff.

7. **FIT pointer**

   Fixed outer size and unchanged top-level placement normally preserve the numerical FIT pointer and component addresses. That does **not** preserve a manifest digest if changed bytes intersect a protected range.

8. **Current independent verification gap**

   The second `inject_ffs` call at `src-tauri/src/deployment.rs:472` proves the same parser can rediscover the driver GUID and refuse a duplicate. It is useful, but it is not an independent all-FV/all-FFS audit and does not verify every sibling checksum or proprietary protection record.

### A.3 Capsules, Aptio generations, signatures, IDs, and checksums

#### Capsule formats

A standard `EFI_CAPSULE_HEADER` is 28 bytes. The current requirement that `HeaderSize` be a multiple of eight can miss a valid minimum-size header. [S1]

AMI Aptio adds:

- `RomImageOffset` at `0x1C`
- `RomLayoutOffset` at `0x1E`

The firmware body begins at `RomImageOffset`, not necessarily at standard `HeaderSize`. UEFITool recognizes: [S5][S6][S7]

- **Signed Aptio:** `4A3CA68B-7723-48FB-803D-578CC1FEC44D`
- **Unsigned Aptio:** `14EEBB90-890A-43DB-AED1-5D3C4588A418`

Another public parser labels `5A88641B-BBB9-4AA6-80F7-498AE407C31F` as an unsigned Aptio capsule. Treat that third GUID as “alternate Aptio capsule-like” unless independently cross-validated; do not label it signed.

For recognized signed capsules, UEFITool warns that modification may invalidate the signature; it does not itself cryptographically verify the signature. [S7]

#### Aptio IV versus Aptio V

There is no trustworthy universal byte-level classifier. Both generations can use the same Aptio capsule structure and GUIDs. Community guidance about where individual vendors put “Secure Flash” checks may help a human, but is not a safe backend rule. Generation should therefore be:

- Explicitly known from a board profile, or
- Reported as unknown

Do not infer it from `NVAR`, `$VSS`, capsule GUID, or one AMI string.

#### RSA and signed ranges

An RSA-looking blob is not sufficient. A useful check must establish:

1. Recognized enclosing format
2. Key/signature structure
3. Exact signed or hashed byte ranges
4. Intersection with patched ranges
5. Whether the original digest validates

Recognizable public formats include AMI PFAT/BIOS Guard and AMI vendor hash records, but no evidence supports one universal AMI Secure Flash RSA layout across these four motherboard vendors. [S8][S19][S20]

#### `$FLASHIMG` and `_AB`

No supporting definition was found in UEFITool, BIOSUtilities, EDK2, or the examined firmware-tool source. `$FLASHIMG` is likely confusion with Insyde’s real `$_IFLASH_BIOSIMG` family. `_AB` likewise lacks a substantiated AMI structure definition.

**Recommendation:** do not implement either marker.

#### Board and project IDs

- MSI images can contain `$MSESGN$<PROJECT>.<VERSION>` and `$MS1<PROJECT><VERSION>` near the last 64 KiB; Dasharo reproduces these records for MSI flasher compatibility. They are useful evidence, not a universal authenticated identity format. [M3]
- Reverse engineering of Gigabyte EFIFlash reports separate BIOS ID, OEMID, and BiosDataRecord FFS GUID checks. [G3][G4]
- ASUS and ASRock do not publish a fixed, universal retail-board-ID field usable by an offline parser.
- The authoritative source for the export filename should remain `FirmwareInstallRoute`, not a guessed string extracted from the image.

#### Checksums

Standard FV and FFS checksums are structural integrity checks and are freely recomputable; their validity does not imply vendor authentication. Gigabyte’s historical `Invalid BIOS image` path has been associated with a proprietary BiosDataRecord-based volume check whose algorithm was not publicly recovered. [G4]

### A.4 Boot Guard, selective flashing, and issue #57

#### Boot Guard detection and limits

A robust offline analyzer should:

1. Map the FIT pointer at physical `0xFFFFFFC0` into the file
2. Validate `_FIT_   ` and entry bounds
3. Parse:
   - `0x02` Startup ACM
   - `0x07` BIOS Startup Module
   - `0x0B` Key Manifest
   - `0x0C` Boot Policy Manifest
4. Parse BPM IBB segments and exclusions
5. Validate physical-address mapping by recomputing the original source digest
6. Intersect patched ranges with IBB, post-IBB, OBB, PMDA, and recognized AMI vendor-hash ranges

The format evolved from older Boot Guard manifests to CBnT-era KM/BPM structures; CPU marketing generation alone is not a safe parser selector. [S9][S10][S11][S12]

Runtime state is stronger than image metadata:

- HFSTS6 bit 8: measured policy
- HFSTS6 bit 9: verified policy
- HFSTS6 bits 7:6: enforcement policy
- IA32_BOOT_GUARD_SACM_INFO MSR `0x13A` bit 5: measured
- MSR bit 6: verified
- MSR bit 32: capability [S13][S14]

These are live ME/PCH/CPU facts, not firmware-file bytes.

Therefore:

- **Metadata present, no patched-range overlap:** Boot Guard IBB does not cover the change.
- **Overlap:** the image is unsafe on a platform with verified/enforced Boot Guard.
- **Metadata present:** does not prove the platform is fused or enforcing it.
- **Measured-only:** records measurements and can trigger TPM-sealed-secret recovery; it does not itself reject execution.
- **Boot Guard does not rewrite or selectively remove an FFS file.** A verified-boot failure is a boot-authentication failure, not a restoration routine.

#### Selective write and restoration mechanisms

A “success” result can still mean less than “every candidate byte became active” because a flasher may:

- Write only selected regions or FV used prefixes
- Preserve NVRAM, DMI, MAC, serial, or ROM-hole data
- Write only one bank on a dual-BIOS board
- Stage a capsule which is rejected on reboot
- Encounter chip-level write protection
- Trigger recovery firmware that restores another bank
- Dump a different bank or region than the one that booted

NVRAM preservation alone should not remove a new DXE FFS from a BIOS FV.

#### NvStrapsReBar issue #57

The reported platform is an **ASUS TUF B450M-PRO GAMING**, BIOS 4401, with a Dell OEM RTX 2080 Ti. Status remained `0xA`, which maps to the project’s `NotLoaded` sentinel at `src-tauri/src/status.rs:87`, and AFUDOS dumps reportedly lacked `NvStrapsReBar.ffs`. [I57]

Conclusions:

1. **Intel Boot Guard is excluded** because this is an AMD B450 platform.
2. The issue does not prove which mechanism removed or omitted the driver.
3. Plausible classes are:
   - The modified region never landed
   - Selective vendor/AFU write behavior
   - Recovery or alternate-bank restoration
   - Injection into an inactive FV or bank
   - A dump that did not represent the active full BIOS region
   - A search that failed to recurse into compressed firmware
4. If the later thread observations of a changed splash from the same image and eventual external-programmer success are accepted, they strengthen the partial-write/vendor-update-path explanation.
5. ReBarUEFI reports `AmdSpiRomProtectDxe` as an in-system flashing obstacle on newer AGESA releases, but that is community guidance and does not by itself prove selective removal in this case. [R1]

### A.5 Recommended post-boot diagnosis

Use a three-level proof chain rather than relying only on `NvStrapsReBarStatus`.

| Observation | Interpretation |
|---|---|
| Driver absent from an immediate post-write BIOS-region readback | The write did not land, the wrong region was written/dumped, or the tool omitted that region |
| Present immediately, absent after reboot | Recovery, dual-bank rollback, or post-write reconstruction |
| Present in readback but unavailable through `EFI_FIRMWARE_VOLUME2_PROTOCOL.ReadFile` | Inactive/unpublished FV, structural damage, or wrong active bank |
| Readable through FV2 but absent from loaded-image enumeration | FFS is present, but DXE dispatch, DEPEX, authentication, or loading failed |
| Present in loaded-image enumeration but status absent | Very early driver failure, `SetVariable` failure, or OS variable-read failure |
| Recognized error status present | The driver executed during the current boot; flashing is no longer the primary diagnosis |

Recommended implementation:

1. **Separate UEFI probe application**
   - Enumerate FV2 handles
   - Call `ReadFile` for `90D10790-BBFA-404B-873B-5BDB3ADA3C56`
   - Verify FFS/PE hash
   - Enumerate loaded images and inspect `FvFile(...)` device paths

2. **Recursive readback inspection**
   - Search structurally through nested LZMA and EFI/Tiano compression
   - Verify GUID, FFS type, DEPEX, UI name, and PE hash
   - Compare immediately after writing and again after the first reboot

3. **ESRT evidence**
   - `LastAttemptStatus = 4`: invalid image format
   - `LastAttemptStatus = 5`: authentication error
   - Applicable only when the update went through an ESRT/capsule firmware-resource path; absence says nothing about M-FLASH, Q-Flash, or similar pre-OS tools. [S16]

4. **Weak supporting signals**
   - BIOS version/date proves only that something changed
   - PCR0 comparison can prove measured firmware changed if a baseline exists, but cannot locate the change
   - A raw GUID byte search is insufficient because the file may be compressed

Readback with FPT, AFU, flashrom, or an external programmer should remain a manual, board-authorized diagnostic route; whole-image byte equality is often inappropriate because NVRAM and board-specific regions can change.

---

## B. Per-vendor flasher behavior

### B.1 Route table

| Flasher | Official preparation | Published or observed validation | Modified-image prediction |
|---|---|---|---|
| **MSI M-FLASH** | Use the extracted BIOS matching the motherboard model; no universal rename is documented. Select it from the M-FLASH file browser. Newer manuals show a generic “File Check” prompt. [M1][M2] | MSI does not publish the check algorithm. Reverse-engineered MSI images contain plaintext project/version records such as `$MSESGN$` and `$MS1`. X99 modified-image success and Z490 non-listing both appear upstream, so behavior varies. [M3][I30][R2] | **Board/firmware dependent; not predictable from image alone.** |
| **MSI Flash BIOS Button** | FAT32; rename to exactly **`MSI.ROM`**; place in USB root; use the dedicated BIOS port. CPU and RAM need not be installed. LED flashes while programming and turns off on documented completion. [M1] | MSI publishes no signature, board-ID, checksum, exact-size, or rejection-blink specification. Dasharo’s MSI support shows that at least some models accept non-AMI firmware carrying the expected MSI identity records, arguing against a universal RSA rule. [M3] | **Unknown per model. Filename compliance is predictable; payload acceptance is not.** |
| **ASUS EZ Flash 3** | FAT16/FAT32, single-partition USB; extract and place the model’s **`.CAP`** in the root; no BIOSRenamer step is specified for EZ Flash. [A1] | ASUS publishes no authentication algorithm. Signed Aptio capsules are recognizable, and modified `.CAP` images are commonly rejected in the ReBarUEFI evidence set. [S5][S7][R2] | **High rejection risk for modified signed CAP, but enforcement remains board-specific.** |
| **ASUS USB BIOS FlashBack** | MBR, FAT16/FAT32, single partition; run bundled **BIOSRenamer**, use its board-specific resulting `.CAP` name, put it in root, and use the dedicated port/button. Three initial blinks indicate start; LED off indicates completion; brief flashing followed by solid light indicates failure. [A2] | ASUS lists formatting, exact model, and filename as troubleshooting causes but does not publish internal signature or ID checks. The ReBAR DXE corpus contains no clear modern, repeatable modified-image success through ASUS FlashBack. | **Unproven for this payload; do not promise that it bypasses EZ Flash validation.** |
| **Gigabyte Q-Flash** | FAT12/FAT16/FAT32; retain the downloaded vendor filename; select it in Q-Flash. Exact motherboard model and hardware revision matter. [G1] | Official material says the file is verified without publishing the algorithm. Reverse engineering reports BIOS ID, OEMID, ROM/file BiosDataRecord GUID, and proprietary image-integrity gates; `Invalid BIOS image` is common in modified-image reports. [G2][G3][G4][R2] | **Strongly board/version dependent; both acceptance and rejection are documented.** |
| **Gigabyte Q-Flash Plus** | FAT32; rename exactly **`GIGABYTE.bin`**; place in USB root; use the designated port/button. CPU/RAM/GPU are not required on supported models. [G2] | Gigabyte does not publish the payload-validation policy. Isolated modified-image success exists, but controlled ReBAR DXE evidence is insufficient. | **Unknown; filename and media checks are the only reliable offline guidance.** |
| **ASRock Instant Flash** | FAT12/FAT16/FAT32; no universal rename is documented. Instant Flash automatically lists only images it considers suitable for that motherboard. [AR1] | Rejections may appear as non-listing/“No Image file detected” or `Secure Flash Check Fail!`. An ASRock B450M Pro4 report paired a 16,384 KiB original with a 16,396 KiB modified image and non-listing, but the issue did not prove that correcting size alone solved it. [I129][I33] | **Exact-size preservation is important; Secure Flash policy remains opaque and model-dependent.** |
| **ASRock BIOS Flashback** | FAT32; rename exactly **`creative.rom`**; place in USB root; use the dedicated port/button. Blinking means programming; off means completion; solid green means it is not operating properly. [AR2] | No published signature/checksum policy and no adequate NvStraps/ReBarUEFI modified-image outcome set was found. | **Unknown. Do not infer acceptance from the generic filename.** |

### B.2 What each validation concept means

- **Required filename:** deterministic only when the exact board route is pinned. ASUS FlashBack names are board-specific and must come from the bundled renamer/manual.
- **Exact file size:** preserving the input byte count is a necessary invariant for this injector, but only ASRock/ASUS community cases provided concrete size-related failures; no universal vendor rule was found.
- **Capsule header:** recognizable and bounds-checkable, but capsule presence alone does not reveal enforcement.
- **Embedded RSA signature:** recognizable only when its enclosing format and range semantics are known; generic RSA-pattern scanning is not trustworthy.
- **Board/project ID:** sometimes plaintext and sometimes proprietary; it is a compatibility signal, not proof of authenticity.
- **Checksums:** standard FV/FFS checksums prove structural consistency, while vendor checks may cover different ranges and use undocumented algorithms.
- **Aptio IV versus V:** cannot be reliably determined from a generic capsule or one marker.
- **`$FLASHIMG` / `_AB`:** unsupported as AMI validation markers and should not be implemented.

---

## C. Factual one-sentence copy to hand to the frontend

1. **Output size changed:** “The patched firmware is not the same byte length as the source, so it should not be exported for this flash route.”
2. **FV geometry changed:** “One or more firmware volumes moved or changed size, which is outside the injector’s supported modification model.”
3. **New structural defect:** “The patched image introduces an invalid firmware-volume, FFS, checksum, alignment, or section relationship.”
4. **Driver identity verified:** “The patched image contains exactly one structurally valid NvStrapsReBar driver matching the bundled build.”
5. **Driver missing or duplicated:** “The expected NvStrapsReBar driver could not be verified exactly once in the patched image.”
6. **Nested recompression used:** “The driver was inserted inside compressed firmware, so the containing FFS changed broadly while the outer firmware layout remained fixed.”
7. **Used-size failure:** “The inserted driver lies beyond the firmware volume’s advertised used range and may be skipped by selective flash tools.”
8. **Signed Aptio capsule:** “This file uses a signed AMI Aptio capsule, and modifying its payload may invalidate authentication.”
9. **Unsigned or standard capsule:** “This file is a firmware-update capsule rather than a raw BIOS body, so the required artifact form depends on the documented board route.”
10. **Malformed capsule:** “The capsule’s declared header, body offset, or image size does not fit the file.”
11. **Boot Guard IBB overlap:** “The modified bytes overlap a Boot Guard initial-boot-block range and can fail on hardware configured for verified enforcement.”
12. **Boot Guard metadata without overlap:** “Boot Guard metadata is present, but its declared IBB ranges do not cover the injected bytes.”
13. **Boot Guard policy unknown:** “The firmware file cannot reveal whether this machine’s silicon enables measured boot, verified boot, or enforcement.”
14. **AMI/vendor hash overlap:** “The modified bytes overlap a vendor-declared hashed range, so boot-time verification may fail even if flashing succeeds.”
15. **FIT mapping uncertain:** “The image does not provide enough consistent address information to evaluate Boot Guard coverage safely.”
16. **Route filename mismatch:** “The export filename does not match the board-specific flash route recorded in this machine profile.”
17. **MSI project mismatch:** “The MSI project identifier found in the image does not match the pinned board firmware route.”
18. **Unknown flasher policy:** “This image passes structural checks, but the motherboard flasher’s private acceptance policy cannot be predicted.”
19. **Post-flash readback absent:** “A post-flash firmware readback does not contain the driver, so the intended bytes were not proven active.”
20. **Present but not dispatched:** “The active firmware exposes the driver file, but it was not found among loaded UEFI images.”

---

## D. Cannot be predicted from the image alone

1. Whether a specific firmware revision of M-FLASH, EZ Flash, Q-Flash, or Instant Flash enforces a recognized signature.
2. Which trusted public key or certificate is provisioned on the motherboard.
3. Whether Intel Boot Guard is fused, disabled, measured-only, verified, or configured for a particular failure policy.
4. Whether an AMD firmware’s runtime SPI-protection driver will block a write.
5. Whether the flasher writes the whole BIOS region, selected FVs, a used prefix, boot block, NVRAM, DMI, ROM holes, or one dual-BIOS bank.
6. Whether recovery firmware will restore another bank after the first reboot.
7. Which bank or top-swap mapping will be active after flashing.
8. Whether chipset, descriptor, protected-range, or flash-chip status-register write protection is currently enabled.
9. Whether a USB drive/controller/partition layout will be accepted by a button flasher.
10. Whether same-version flashing or downgrade is permitted.
11. Whether a plaintext board/project identifier is actually consulted by that flasher revision.
12. Whether a successful progress indicator means every intended byte was written.
13. Whether a vendor-created dump is full SPI, BIOS-region-only, active-bank-only, or reconstructed.
14. Whether a raw GUID search missed a file because it is compressed.
15. Whether a structurally present DXE driver will be dispatched.
16. Whether status-variable absence means no dispatch, early failure, failed `SetVariable`, privilege failure, or OS read failure.
17. Whether an opaque AMI Secure Flash or vendor checksum record covers the injected range when its format is not publicly defined.

---

## E. Sources

### Standards and parser references

- **[S1] UEFI capsule services:** https://uefi.org/specs/UEFI/2.10/08_Services_Runtime_Services.html#capsule-services
- **[S2] UEFI firmware update and reporting:** https://uefi.org/specs/UEFI/2.10/23_Firmware_Update_and_Reporting.html
- **[S3] EDK2 FV structures:** https://github.com/tianocore/edk2/blob/master/MdePkg/Include/Pi/PiFirmwareVolume.h
- **[S4] EDK2 FFS structures:** https://github.com/tianocore/edk2/blob/master/MdePkg/Include/Pi/PiFirmwareFile.h
- **[S5] UEFITool capsule/FV definitions:** https://github.com/LongSoft/UEFITool/blob/new_engine/common/ffs.h
- **[S6] UEFITool GUID constants:** https://github.com/LongSoft/UEFITool/blob/new_engine/common/ffs.cpp
- **[S7] UEFITool capsule parser:** https://github.com/LongSoft/UEFITool/blob/new_engine/common/ffsparser.cpp
- **[S8] UEFITool protected-range definitions:** https://github.com/LongSoft/UEFITool/blob/new_engine/common/ffsparser.h
- **[S9] UEFITool FIT parser:** https://github.com/LongSoft/UEFITool/blob/new_engine/common/fitparser.cpp
- **[S10] Intel FIT specification:** https://cdrdv2-public.intel.com/599500/599500_FW_Interface_Table_BIOS_Spec_Rev1p6.pdf
- **[S11] EDK2 FIT entry definitions:** https://github.com/tianocore/edk2-platforms/blob/master/Silicon/Intel/IntelSiliconPkg/Include/IndustryStandard/FirmwareInterfaceTable.h
- **[S12] Fiano Boot Guard/CBnT metadata:** https://github.com/linuxboot/fiano/tree/main/pkg/intel/metadata
- **[S13] CSS HFSTS6 policy fields:** https://github.com/9elements/converged-security-suite/blob/master/pkg/provisioning/bootguard/hfsts.go
- **[S14] CSS MSR `0x13A` definitions:** https://github.com/9elements/converged-security-suite/blob/main/pkg/registers/msr_btg_sacm_info.go
- **[S15] EDK2 `FvUsedSizeEnable`:** https://tianocore-docs.github.io/edk2-FdfSpecification/release-1.28.01/3_edk_ii_fdf_file_format/35_fv_sections.html
- **[S16] Microsoft ESRT statuses:** https://learn.microsoft.com/en-us/windows-hardware/drivers/bringup/esrt-table-definition
- **[S19] BIOSUtilities format patterns:** https://github.com/platomav/BIOSUtilities/blob/master/biosutilities/common/patterns.py
- **[S20] BIOSUtilities AMI PFAT parser:** https://github.com/platomav/BIOSUtilities/blob/master/biosutilities/ami_pfat_extract.py

### Official vendor instructions

- **[M1] MSI Flash BIOS Button:** https://www.msi.com/support/technical_details/MB_Flash_BIOS_Button
- **[M2] MSI M-FLASH:** https://www.msi.com/support/technical_details/MB_BIOS_Update
- **[M3] MSI identity records used by Dasharo/coreboot:** https://sourcegraph.com/github.com/Dasharo/coreboot/-/blob/src/mainboard/msi/ms7d25/msi_id.S
- **[A1] ASUS EZ Flash 3:** https://www.asus.com/support/faq/1012815/
- **[A2] ASUS USB BIOS FlashBack:** https://www.asus.com/support/faq/1038568/
- **[G1] Gigabyte Q-Flash guide:** https://www.gigabyte.com/FileUpload/Global/MicroSite/121/flashbios_qflash.pdf
- **[G2] Gigabyte/AORUS Q-Flash and Q-Flash Plus:** https://global.aorus.com/blog/How-to-Update-Your-BIOS-Part-2.php
- **[AR1] ASRock Instant Flash:** https://www.asrock.com/support/BIOSIG.asp?cat=BIOS10
- **[AR2] ASRock BIOS Flashback:** https://www.asrock.com/support/QA/FlashbackSOP.pdf

### Reverse-engineering and upstream evidence

- **[G3] Gigabyte EFIFlash validation messages:** https://winraid.level1techs.com/t/tool-efiflash-v0-80-v0-85-v0-87-for-gigabyte-mainboards/34071
- **[G4] Gigabyte `Invalid BIOS image` research:** https://winraid.level1techs.com/t/flashing-gigabyte-while-avoiding-invalid-bios-image/31185
- **[R1] ReBarUEFI flashing modified firmware:** https://github.com/xCuri0/ReBarUEFI/wiki/Flashing-modified-UEFI
- **[R2] ReBarUEFI board/flasher evidence:** https://github.com/xCuri0/ReBarUEFI/issues/11
- **[I30] MSI Z490 non-listing report:** https://github.com/terminatorul/NvStrapsReBar/issues/30
- **[I33] ASRock Secure Flash report:** https://github.com/terminatorul/NvStrapsReBar/issues/33
- **[I57] ASUS B450 missing-driver report:** https://github.com/terminatorul/NvStrapsReBar/issues/57
- **[I129] ASRock exact-size/non-listing report:** https://github.com/terminatorul/NvStrapsReBar/issues/129
- **UEFITool PAD/alignment corruption case:** https://github.com/LongSoft/UEFITool/issues/231
- **ReBarUEFI pad-file guidance:** https://github.com/xCuri0/ReBarUEFI/wiki/Using-UEFIPatch
