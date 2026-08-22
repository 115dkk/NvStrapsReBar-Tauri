<!-- The baseline measurement was produced on 2026-08-22 against retail BIOS
     images downloaded from vendor CDNs and independently re-derived with a
     second harness. The implementation/evidence section was updated after the
     resulting injector, encoder, driver, profile-policy, and receipt changes.

     This document supersedes the framing of FLASHER_COMPATIBILITY.md: producing
     a structurally valid artifact comes before predicting whether a private
     vendor flasher will accept it. Producing an image is still not a physical
     flash or boot claim. -->

# Can we produce a patched image at all? A measured answer

**Bottom line:** the current injector produces same-length artifacts for all five
measured raw ROM images. The earlier all-refusal result below is the baseline
that exposed the defects; it is no longer the shipping behavior. The remaining
boundary is vendor authentication and physical flashing, not “this machine must
live without ReBAR.” The application does not pretend it can re-sign a vendor
capsule or that a `.CAP` body is a full-chip programmer image. External SPI use
requires a separately read and pinned full-chip dump, or an exact BIOS-region
dump backed by a proven region map; that dump becomes the source and recovery
artifact.

## Implemented result and evidence

- The Rust DXE FFS is 20,564 bytes (SHA-256
  `bfcdaea690ebf71e930fe2c259cd14aa44babb70998dc9949822474a84fbbb41`),
  down from 34,900 bytes without removing execution, restore, S3, status, or
  configuration behavior. A compact panic path and dynamically sized UEFI pool
  buffers replace code pulled in by the generic allocator/formatter.
- `lzma-sdk-rs 0.2301.1` emits a 7-Zip-SDK-compatible known-size LZMA stream.
  Recompression preserves the source lc/lp/pb and dictionary bytes, uses the
  measured `fb=128, mc=80` search, and is round-tripped by both the repository
  decoder and CPython/liblzma. Authenticated or vendor-metadata guided sections
  are read for census but are not rewritten with stale metadata.
- Terminal nested FVs grow by UEFITool 0.28's block-map rule. `FvLength`,
  `NumBlocks`, FV/section sizes, used size, checksums, alignment, and a
  nonterminal containing FFS extent are rebuilt and re-parsed.
- Multiple independent DXE domains are never selected by offset. The user must
  bind `patchEveryDxeDomain` into the immutable profile, backed by tested USB
  Flashback or an external SPI programmer; Dual BIOS alone is not accepted as
  recovery authority. Mutation is all-or-none and the post-census requires the
  exact input FFS once in every pinned target.
- Source, driver, patched artifact, canonical census, target paths, growth, and
  recompression facts are stored in a content-addressed injection receipt. Resume
  and export regenerate the artifact and receipt and require exact equality.

### Final retail regression

All outputs retain the source ROM byte length. Every guided stream below decoded
with CPython/liblzma, each grown FV reproduced its block map and checksum, every
target contained exactly one 20,564-byte driver, all changed bytes stayed inside
the declared containing FFS extents, and reinjection was rejected as already
present.

The three ASUS “raw” rows are capsule bodies extracted for parser/compression
research only. They are not presented as full-chip programmer images; a real SPI
workflow must start from its own pinned readback or proven BIOS-region dump.

| Raw image | Targets | FV growth | Patched SHA-256 |
|---|---:|---|---|
| ASUS B450M-PRO 4401 | 1 | 20,480 bytes | `1de2a8d21d6fcf354a61ed58c54d288ffef67d26cd8e1cc3c43a529570d344dd` |
| ASUS Z490-A 2701 | 1 | 20,480 bytes | `e57db1696137f32948880b120886f7ff0cb52994497ecb4806ad0a84356d48ff` |
| ASUS X570-PLUS 4408 | 2 | 20,480 / 20,480 bytes | `cf0cf58bc1a59c9c204c4d67dfa579bf4573ae1a961e2608d81843b17e970b50` |
| MSI B450 TOMAHAWK | 2 | 20,480 / 20,480 bytes | `d72cf9baf92401f0bf426c7d95ae19096186235d05019b6a1ebcad2f85fa5952` |
| GIGABYTE Z490 ELITE F22 | 1 | 20,480 bytes | `626efd01fc78e0944ad6de44c383f9e647531882f2ad3a77252478b7a714ac5b` |

This remains host-side artifact evidence, not a claim that a private vendor
flasher accepts the bytes or that a physical board booted them. The local QEMU
run could not start because this machine's WSL distribution is mounted
read-only and lacks `/bin/bash`; the repository QEMU job remains a required CI
gate rather than being reported as a pass here.

## 1. The corpus

Five retail images, four boards, three vendors, both AMD and Intel. All are AMI
Aptio V. The ASUS B450 board is the exact board in upstream issue #57
("NvStrapsReBar.ffs missing after successful BIOS Flash").

| Board | File | Size |
|---|---|---|
| ASUS TUF B450M-PRO GAMING 4401 | `TUF-B450M-PRO-GAMING-ASUS-4401.CAP` | 16,779,264 |
| ASUS PRIME Z490-A 2701 | `PRIME-Z490-A-ASUS-2701.CAP` | 16,781,312 |
| ASUS TUF GAMING X570-PLUS 4408 | `TUF-GAMING-X570-PLUS-ASUS-4408.CAP` | 33,558,528 |
| MSI B450 TOMAHAWK 7C02vHD | `E7C02AMS.HD0` | 33,554,432 |
| GIGABYTE Z490 AORUS ELITE F22 | `Z490AORUSELITE.F22` | 33,554,432 |

Sources are the vendor CDNs: `dlcdnets.asus.com/pub/ASUS/mb/BIOS/<MODEL>-ASUS-<VER>.zip`,
`download.msi.com/bos_exe/mb/7C02vHD.zip`,
`download.gigabyte.com/FileList/BIOS/mb_bios_z490-aorus-elite_f22.zip`.

## 2. Baseline result before this patch: six refusals out of six

Running `nvstraps_ffs::inject_ffs(image, NvStrapsReBar.ffs)` on each image, plus
on the ASUS B450 file with its capsule header stripped, gives the same outcome
every time:

```
refused: no writable DXE volume was found through a supported layout
```

That message is `InjectionError::NoTopLevelDxeVolume`, and it survives to the
user as a substring, gaining two prefixes on the way and losing its specificity.
`deployment.rs:471` formats the `Display` string into `BackendError::Deployment`;
that variant's own `Display` adds `deployment workflow failed:`; `error.rs`
flattens it to the generic code `deployment_failed` and copies the whole string
into `ApiError::message`; `session.ts` reads `.message` and substitutes it into
`ui.deploymentOperationFailed`. A Korean user therefore sees

```
배포 작업 실패 · deployment workflow failed: firmware injection failed: no writable DXE volume was found through a supported layout
```

— a translated wrapper around two layers of untranslated English, ending in a
sentence that is, per the next section, the wrong explanation.

## 3. Why it actually fails

Every one of these images puts the DXE core inside an LZMA GUID-defined section
(`EE4E5898-3914-4259-9D6E-DC7BD79403CF`) within an `EFI_FV_FILETYPE_FIRMWARE_VOLUME_IMAGE`
file. Our injector does find it: `try_inject_lzma_guided` decompresses the
section and recurses into it.

The recursion fails for one of two reasons, depending on the image, and the loop
discards both the same way. When the inner volume has no room the recursion
returns `NoSpace`, which the loop swallows:

```rust
Err(InjectionError::NoTopLevelDxeVolume | InjectionError::NoSpace) => continue,
```

When the inner injection succeeds but the recompressed containing file no longer
fits, `replace_firmware_file` returns `Ok(None)` and the loop `continue`s on that
too. Either way, with no candidate left the function returns `Ok(None)`, and the
caller — having seen no volume with a DXE core at the top level — reports
`NoTopLevelDxeVolume`. The diagnosis the user receives points at the wrong thing
in both cases, and cannot distinguish between them.

## 4. The measured free space

Erased tail bytes at the end of the volume holding the live `DXE_CORE` file:

| Board | Free tail | Pad files in that volume |
|---|---:|---:|
| ASUS B450M-PRO 4401 | 3,016 | 0 |
| ASUS Z490-A 2701 | 3,840 | 0 |
| ASUS X570-PLUS 4408 | 2,528 / 2,920 | 0 |
| MSI B450 TOMAHAWK | 3,856 / 3,400 | 0 |
| GIGABYTE Z490 ELITE F22 | 4,088 | 0 |

Every value is under 4 KiB, which is one block. AMI evidently pads FvMain to a
block boundary and leaves nothing else. Our driver FFS is 34,900 bytes.

Free space elsewhere in these images is plentiful — the outer volume holding the
compressed FvMain has 1.1–4 MiB erased on the AMD boards — but on those boards it
belongs to volumes whose only contents are compressed volume images, so a DXE
driver written there would never be dispatched.

The two Intel boards do have a second candidate: an uncompressed volume carrying
a handful of DXE drivers with room to spare (ASUS Z490 at `0xd90070`, 19 files
and 237,720 free; GIGABYTE Z490 at `0x1df0070`, 19 files and 15,040 free). Our
injector cannot reach either, for two independent reasons: both are nested inside
a containing volume and so are dropped by the top-level filter, and neither holds
the DXE core, which is the only signal we use to identify a dispatchable volume.
Whether inserting into such a volume is actually safe is unresolved and not
something this measurement answers.

## 5. Two different blockers, and which one bites depends on the image

Injecting synthetic driver files of increasing size with our own code separates
the causes. The only variable is the FFS size; everything else is our shipping
injector.

| Board | Largest FFS `inject_ffs` accepts | Smallest refused | Where it lands |
|---|---:|---:|---|
| ASUS B450M-PRO 4401 | none | 596 | — |
| ASUS Z490-A 2701 | none | 596 | — |
| ASUS X570-PLUS 4408 | none | 596 | — |
| MSI B450 TOMAHAWK | 3,856 | 3,860 | first BIOS copy, `0x631578` |
| GIGABYTE Z490 ELITE F22 | 4,088 | 4,092 | `0x13ba000` |

The two accepted limits land exactly on those images' inner free tails.

So the injector does work on real firmware — just not on any image with a driver
of usable size, and not at all on three of the five. "Works" here means only that
the byte transformation completes: parse, inject, recompress, round-trip, rebuild.
None of this establishes that the resulting image is safe to flash, acceptable to
the vendor's flasher, or bootable.

The split is explained by one structural detail: whether the compressed FvMain
file is the last live file in its outer volume.

| Board | FvMain last in its volume? | Room to grow, from the aligned file end |
|---|---|---:|
| ASUS B450M-PRO 4401 | no | 0 |
| ASUS Z490-A 2701 | no | 0 |
| ASUS X570-PLUS 4408 | no | 0 |
| MSI B450 TOMAHAWK | yes | 3,074,296 |
| GIGABYTE Z490 ELITE F22 | yes | 2,055,088 |

`replace_firmware_file` only lets a rebuilt file exceed its original extent when
everything from the old file's 8-byte-aligned end to the volume end is
erase-filled. On the three ASUS images other live files follow FvMain, so the
rebuilt file must fit the original aligned extent — and as section 8 shows, our
recompression makes it 622 KiB to 1.12 MiB larger before any driver bytes are
added. That is why those three refuse even a 596-byte file. On the MSI and
GIGABYTE images FvMain is last, the bloat is absorbed by megabytes of trailing
free space, and the limit reverts to the inner volume's free tail.

To be precise about what the ASUS result proves: 596 bytes is the smallest valid
FFS we could construct, not a mathematical floor. The claim is that even the
minimum viable driver fails there, not that no byte sequence could ever fit.

Note also what the MSI row demonstrates: with a small enough driver our injector
does produce an image today, patched into the first of that file's two BIOS
copies. The dual-copy hazard in section 10 is reachable behaviour, not a
hypothetical.

## 6. Driver size is the deciding variable

| Driver | Size | Origin |
|---|---:|---|
| `ReBarDxe.ffs` | 2,578 | xCuri0/ReBarUEFI release |
| `NvStrapsReBar.ffs` | 13,628 | terminatorul/NvStrapsReBar v0.4-rc1 release |
| ours before this patch | 34,900 | this repository, former release profile |
| ours now | 20,564 | compact panic path and dynamic no-alloc UEFI buffers |

Before this patch, the PE was 34,816 bytes: `.text` 28,160, `.rdata` 5,120,
`.reloc` 512, headers 1,024. The release profile was already tuned, but the
generic panic formatter and allocator pulled in code the driver did not need.
The current PE is 20,480 bytes and the packed FFS is 20,564 bytes. Configuration
limits are unchanged; no-std storage uses the existing wire maxima, while UEFI
protocol, variable-name, and variable-data buffers grow dynamically from Boot
Services pool allocations.

This ordering explains a long-standing asymmetry in the upstream issue trackers:
ReBarDxe fits the existing slack on four of the five images with no structural
change at all — it misses the first X570 copy by 56 bytes — while NvStrapsReBar
fits none of them without growing a volume.

The table is a size comparison only. Our `inspect_ffs` would reject either
foreign file outright, since it requires this project's file GUID and its exact
DEPEX, PE32 and UI section layout.

## 7. What the reference tool does that we do not

Upstream defers to ReBarUEFI's instructions, which are: use UEFITool 0.28 — the
wiki notes that the NE line does not support adding modules — find the volume
containing PciBus (`3C1DE39F-D207-408A-AACC-731CFB7F1DD7`) by header-only GUID
search, right-click the last module in that volume, choose *Insert after*, and
save the image.

Worth confirming before going further: that is the same volume we pick. PciBus
appears exactly once in each image's decompressed FvMain, in the volume that also
holds the DXE core — at `0xaea818` on the ASUS B450 and `0xbbe208` on the
GIGABYTE Z490. So our target selection agrees with the community procedure. What
differs is entirely how the two handle capacity.

Two facts about UEFITool 0.28 matter for that.

First, modern UEFITool NE cannot help: `common/ffsbuilder.cpp`
`FfsBuilder::buildVolume` returns `U_NOT_IMPLEMENTED`, so the new engine cannot
rebuild volumes at all.

Second, 0.28.0's `ffsengine.cpp` `FfsEngine::reconstructVolume` grows a volume
when the body no longer fits, gated on the volume being nested:

```cpp
// Check if volume can be grown
// Root volume can't be grown
UINT8 parentType = model->type(index.parent());
if (parentType != Types::File && parentType != Types::Section) { ... }
UINT32 newSize = header.size() + reconstructed.size();
result = growVolume(header, volumeSize, newSize);
```

`growVolume` rounds the new size up to `blockMap[0].Length`, recomputes
`NumBlocks`, recomputes `FvLength` as the sum over the block map, recomputes the
16-bit header checksum, and refuses block maps with more than two entries. Its
rounding is `newSize += Length - newSize % Length`, which adds a whole extra
block when the size is already aligned — worth reproducing deliberately rather
than "fixing" into a conventional ceiling, since the community's working images
were built with this arithmetic.

That arithmetic checks out against our own parser. Applying it to the ASUS B450
FvMain — eight blocks of growth, driver written at the old tail, block map,
`FvLength` and checksum updated — produces a volume that `find_firmware_volumes`
accepts and walks to the end, with `scan_volume` reporting the driver live at
`0xf83448`. Two independent implementations agree on the result, so the remaining
uncertainty about growth is about firmware behaviour at boot, not about the
byte-level construction.

Our `replace_firmware_file` never touches `FvLength` or the block map, and only
lets a replacement exceed its original extent when everything from the old file
end to the volume end is erase-filled. In these images the compressed FvMain file
is followed by further live files, so that condition never holds either.

## 8. The baseline LZMA encoder, not its level, was the problem

We recompress with `oxiarc-lzma 0.3.6` at `GUIDED_LZMA_LEVEL = 3`. Recompressing
the *unmodified* ASUS B450 FvMain (16,269,328 bytes) against the vendor's own
3,037,823-byte payload, every level round-trips correctly:

| Level | Result | Delta vs vendor | Declared dictionary |
|---|---:|---:|---:|
| 1 | 3,842,640 | +804,817 | 1 MiB |
| 3 (current) | 3,785,690 | +747,867 | 1 MiB |
| 5 | 3,702,730 | +664,907 | 4 MiB |
| 6 | 3,695,180 | +657,357 | 4 MiB |
| 7 | 5,808,703 | +2,770,880 | 16 MiB |
| 8 | 5,630,447 | +2,592,624 | 16 MiB |
| 9 | 5,493,825 | +2,456,002 | 32 MiB |

For reference, liblzma at preset 9 produces 3,028,078 bytes — 9,745 *below* the
vendor's own payload — so the input is not the obstacle. Two conclusions follow,
and the first one corrects an assumption worth stating plainly: raising the level
does not fix this.

First, no level of the former encoder comes within 650 KiB of what the vendor achieved.
Recompressing a vendor FvMain back into its original extent is therefore not
achievable with that encoder, whatever the level.

Second, `oxiarc-lzma` regresses sharply at levels 7 and above: level 7 produces
2.1 MB more output than level 6 while enlarging the dictionary from 4 to 16 MiB.
A larger dictionary producing substantially worse output is not normal encoder
behaviour, and it means the naive fix — turn the level up — makes matters much
worse. The best available setting is level 6, worth about 90 KiB over the current
level 3.

The same shape holds on the other FvMains, so this is not one image's quirk.
Deltas against each vendor payload, at levels 3 / 6 / 9: MSI B450
+739,870 / +614,498 / +1,474,884; ASUS X570 +637,435 / +547,982 / +1,672,200.
Level 6 is the best setting on all three, level 9 regresses on all three, and the
best result anywhere is still 0.55–0.66 MB too large. The regression is not
confined to level 9 either: at level 7 the ASUS B450 output grows by 2,113,523
bytes over level 6, MSI by 1,139,110, and X570 by 1,381,913.

The declared dictionary size deserves separate attention. The vendor's stream
declares 16 MiB; our level 3 declares 1 MiB and level 6 declares 4 MiB, both
below it. Level 9 would declare 32 MiB, more than the vendor asked for, and the
firmware's own decompressor has to be able to honour that window at boot.

One trap to note if anyone budgets against these numbers: the crate's
`LzmaLevel::dict_size()` reports a different mapping from what its `compress`
wrapper actually writes into the stream — 8 MiB versus 4 MiB at level 6, and up
to 64 MiB at level 9. The stream header is authoritative; the accessor is not.

## 9. Putting growth and compression together

The numbers below use liblzma at preset 9, i.e. they describe what the procedure
could achieve with a competitive encoder, not what our current one does. Take
them as an upper bound on the approach: insert the driver at the aligned end of
live files, grow `FvLength` by whole blocks if needed, fix the header checksum,
recompress, and compare against the vendor's original payload size.

| Board | ReBarDxe 2,578 | upstream 13,628 | ours 34,900 |
|---|---|---|---|
| ASUS B450M 4401 | +0 blocks, fits (−8,754) | +3 blocks, fits (−3,107) | +8 blocks, **over by 7,389** |
| ASUS Z490-A 2701 | +0 blocks, fits (−16,799) | +3 blocks, fits (−11,493) | +8 blocks, fits (−579) |
| ASUS X570-PLUS 4408 | +1 block, fits (−7,120) | +3 blocks, fits (−1,659) | +8 blocks, **over by 8,728** |
| MSI B450 TOMAHAWK | +0 blocks, fits (−7,903) | +3 blocks, fits (−3,049) | +8 blocks, **over by 7,781** |
| GIGABYTE Z490 F22 | +0 blocks, fits (−31,095) | +3 blocks, fits (−27,386) | +8 blocks, fits (−16,601) |

"Fits" means the recompressed payload is no larger than the vendor's, so the
rebuilt file's aligned extent stays within the old capacity and nothing
downstream has to move. The rebuilt FFS may declare a shorter length and leave
erased bytes before the next file; what matters is the extent, not byte-for-byte
equality. That is precisely the constraint our in-place injector already enforces.

Read across the rows: with nested-volume growth and maximum recompression, the
upstream 13,628-byte driver would fit all five boards in place, with margins of
1.6–27 KiB. The baseline 34,900-byte driver fits two of five, and one of those by 579
bytes. Driver size is the whole margin.

## 10. Two further defects found along the way

### The capsule guard fails open on every real ASUS `.CAP`

All three ASUS capsules begin with `4A3CA68B-7723-48FB-803D-578CC1FEC44D`, which
UEFITool names `APTIO_SIGNED_CAPSULE_GUID`, and carry `Flags = 0x00010001`.
`inspect_firmware_envelope` requires `flags & !UEFI_CAPSULE_ALLOWED_FLAGS == 0`
with the mask set to `0x0007_0000`. Bit 0 is `EFI_CAPSULE_HEADER_FLAG_SETUP`, a
legitimate UEFI flag, so the plausibility test fails, the function returns
`RawOrVendorImage`, and `reject_uefi_capsule` never fires. The guard that exists
specifically to stop a user feeding a signed vendor capsule into the injector is
inert on the most common real input.

Two smaller problems in the same function: it requires `HeaderSize` to be a
multiple of eight, but a standard `EFI_CAPSULE_HEADER` is 28 bytes; and it
ignores the Aptio `RomImageOffset` field at `0x1C`, which is where the body
actually begins. In these files `RomImageOffset` happens to equal `HeaderSize`
(0x800 and 0x1000), so nothing breaks today, but the equality is not guaranteed.

### 32 MiB AMD images carry two complete, different BIOS copies

The MSI B450 TOMAHAWK and ASUS X570-PLUS files each contain two full AMI
structures with the same volume layout but different content — MSI's two FvMains
are 0xc19000 with 410 files and 0xcad000 with 425 files; the X570's are 0xccf000
with 469 files and 0xd73000 with 487 files. Parsing two complete-looking
structures does not prove both are independently bootable, nor tell us which one
the firmware selects; that question is not answerable from the image.

What is answerable is our behaviour. The injector walks candidates in file-offset
order and returns on the first success, with no active-copy logic at all. Section
5 shows this is not hypothetical: given a small enough driver the MSI image is
patched today, in its first copy at `0x631578`, leaving the second at `0x1693570`
untouched. "Flashed successfully, driver absent" is exactly the symptom that
would produce. Offset order is not a defensible way to choose a bank, and this
needs an explicit policy before anything else here ships.

## 11. What this means for the item 5 plan

`FLASHER_COMPATIBILITY.md` scoped a set of pre-export checks for predicting
vendor-flasher acceptance. At baseline that work was downstream of the fact that
none of the five images produced an artifact. The final regression at the top of
this document removes that prerequisite failure; flasher-policy analysis can now
operate on real generated artifacts.

The measured facts point at a different first tranche, in this order:

1. Report the real reason. Distinguish nested `NoSpace` from
   `NoTopLevelDxeVolume` and carry the numbers — which volume, how many bytes
   free, how many needed. This is a pure diagnosis fix with no behavioural risk.
2. Move the feasibility test to profile creation, where the user picks their BIOS
   file, instead of discovering it at export after the whole flow.
3. Fix the capsule classifier: correct the flags mask, accept a 28-byte header,
   recognise the Aptio GUIDs, and honour `RomImageOffset`.
4. Move `GUIDED_LZMA_LEVEL` from 3 to 6, and cap it there. This is worth about
   90 KiB and keeps the declared dictionary below the vendor's; levels 7 and
   above must be avoided until the encoder's regression is understood.
5. Decide what to do about the encoder. Closing the remaining ~650 KiB gap needs
   a competitive LZMA implementation, and without it, in-place recompression of a
   vendor FvMain stays out of reach on any board where the compressed file cannot
   grow.
6. Implement nested-volume growth along UEFITool's rules: nested volumes only,
   two-entry block maps only, round to `blockMap[0].Length`, recompute
   `FvLength` and the header checksum, and require the recompressed containing
   file to still fit its available extent.
7. Shrink the driver. Every byte here is margin that items 5 and 6 do not have to
   find; upstream's C driver does the same job in 13,628 bytes.

Items 1–3 and 5–7 are now implemented. Item 4's proposed oxiarc level change was
superseded rather than shipped: the encoder itself was replaced, source decoder
properties are preserved, and the tuned SDK search was independently decoded.
The dual-copy finding is resolved by an explicit, profile-bound all-domain policy
with independent recovery authority, atomic mutation, per-target post-census,
and a durable receipt. It is not resolved by guessing an active bank.

## Appendix: reproducing these measurements

Nothing here needs the application. Download an image from the vendor CDN paths
in section 1, unzip it, and strip the capsule header if there is one — take the
`RomImageOffset` at `0x1C` as the body start.

The injector verdicts come from a throwaway binary that depends on the
`nvstraps-ffs` crate by path and calls `inspect_firmware_envelope` and
`inject_ffs` directly. Building driver files of varying size for the size sweep
means calling `build_ffs` on a minimal PE — pad the `.text` region to whatever
length you want; `inspect_ffs` checks the headers, GUID, DEPEX, and UI name, not
the code.

The volume walk needs no special tooling: scan for `_FVH` at offset 40 of a
candidate header, verify revision 2 and the 16-bit header checksum, walk the FFS
files from past the extended header, and treat a live file of type `0x0B` whose
section stream carries GUID `EE4E5898-3914-4259-9D6E-DC7BD79403CF` as an LZMA
container to decompress and recurse into. Python's `lzma` module reads these
streams as `FORMAT_ALONE`.

The compression figures come from calling `oxiarc_lzma::compress` at each level
on the decompressed FvMain and comparing against the vendor's payload length
(the GUID-defined section size minus its 24-byte header). Every level was
round-tripped through `decompress_bytes` before its size was recorded.
