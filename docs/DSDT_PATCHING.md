# DSDT patching and boards without Above 4G Decoding

Issue #63 asked whether NvStrapsReBar could apply ReBarUEFI's DSDT workaround, so that an older
board without Above 4G Decoding gets a BAR larger than 1 GiB
([the question](https://github.com/115dkk/NvStrapsReBar-Tauri/issues/63#issuecomment-6807922767)).
This page records what was found on 2026-11-12. Whether the app should do any of it has not
been decided. Nothing here was tried on hardware. What other projects and systems do is taken
from the sources at the end.

**Bottom line.** A DSDT patch changes what the operating system is told about the board, not
what the firmware can do. On a board whose firmware has no Above 4G Decoding, ReBarUEFI reports
that it helps on Linux only, where the kernel resizes BARs by itself, and there an AMD or Intel
GPU needs neither this project's driver nor a BIOS flash. For the Turing GPUs this project is
for, the driver relies on the firmware to place the large BAR, which such a board cannot do. The
app does not patch DSDTs today.

## What a DSDT patch changes

- At boot the firmware's PCI code gives every BAR its address. Without Above 4G Decoding it uses
  addresses below 4 GiB only. ReBarUEFI's README puts what fits there at 1 GiB, in some cases
  512 MiB, and up to 2 GiB after lowering TOLUD in BIOS setup ([R1], [W3]).
- The DSDT is an ACPI table that the firmware hands to the operating system. In it, `_CRS` of
  the PCI root lists the address ranges that reach PCI devices. An operating system places or
  moves a BAR inside those ranges only.
- ReBarUEFI's DSDT patches add a 64-bit range to that list, or enlarge the one that is there
  ([W1]). They do not touch the firmware's own PCI code.

## Where ReBarUEFI uses it

[W1] names four kinds of board:

| Board | Has Above 4G Decoding | What the patch is for |
| --- | --- | --- |
| Sandy Bridge and Ivy Bridge boards after the UEFIPatch rule that opens the full 64 GiB | yes | The DSDT still announces 16 GiB; Windows fails to start or reports too few resources |
| ASRock boards from Haswell to Kaby Lake | yes | Their DSDT often lacks the 64-bit range; Windows does not start, or the GPU does not work, with Above 4G Decoding on |
| X79 boards after the UEFIPatch rule that extends the MMIOH limit | yes | The DSDT has to announce the range the patched firmware uses |
| Boards without Above 4G Decoding, hidden settings included | no | Lets the operating system place BARs above 4 GiB by itself. "this fix will only work in Linux for them though (atleast with GPUs)" |

In the first three the firmware can place a large BAR and the patch brings the DSDT in line with
it. The fourth is the board in the question.

## A board without Above 4G Decoding

**Look for the hidden setting first.** Some firmware has the option without showing it; [W2]
describes how to find its offset and switch it on with a modified GRUB shell. The same page says
that a firmware without the option at all is common on Haswell boards, and that makers
sometimes send a BIOS with it when asked.

**Without the setting, the firmware cannot place the BAR, whatever the DSDT says.** In
ReBarUEFI's issue about these boards ([I14]) one user forced the 64-bit range in the DSDT of a
Gigabyte Z97X-UD5H-BK: the operating system then saw the larger range, "but anything above 1G
resizebar won't POST". The maintainer's answers there: on such a board "the uefi has been built
without the code for 4g decoding", and giving it that code would mean swapping the PciHostBridge
and PciBus modules with those of a similar board that has it, or adding code to them.

**What is left is an operating system that resizes the BAR after the firmware is done.**

- *Linux does.* With a 64-bit range in the DSDT the kernel can place and resize BARs itself. The
  AMD and Intel drivers resize by default; NVIDIA's needs `NVreg_EnableResizableBar=1` ([W1],
  [N1]). The changed DSDT can be loaded from the initrd, so nothing is flashed ([K1], [A1]); it
  should be made from the running system's `/sys/firmware/acpi/tables/DSDT`, and the kernel may
  need `pci=realloc` ([W1]). The maintainer in [I14]: "if you're using linux you don't need to
  even flash rebardxe". One limit: a locked-down kernel ignores ACPI tables from the initrd
  ([K2]), and Ubuntu locks the kernel down when Secure Boot is on ([U1]).
- *Windows.* ReBarUEFI's README: "Currently there is no known method to get it on Windows
  without BIOS modification" ([R1]). With the DSDT changed inside the BIOS, [W1] says only
  that it "may also work on Windows for compute GPUs". Microsoft's driver documentation says
  that Windows renegotiates a GPU's BAR size after the firmware ([M1]); no report was found of
  that giving a GPU a larger BAR on a board of this kind.

## What NvStrapsReBar does today

- The UEFI driver changes sizes while the firmware enumerates PCI devices, through the same
  `PreprocessController` hook as ReBarUEFI's module (`crates/nvstraps-uefi/src/host_bridge.rs`).
  For the selected Turing GPU it first programs the straps that make the card offer larger BAR1
  sizes, then selects one; for other devices with a Resizable BAR capability it applies the
  motherboard-side BAR size (`crates/nvstraps-uefi/src/engine.rs`). In both cases the firmware
  places the BAR afterwards. That is why the README asks for Above 4G Decoding.
- For older boards the app offers the rules of ReBarUEFI's patch catalog (`UEFIPatch/`). Two of
  them say "MAY REQUIRE DSDT MODIFICATION". The app marks those with the `dsdtModification`
  risk and does not continue until the user confirms it; the DSDT change itself stays a manual
  step that follows [W1].
- The app's screens are about Turing GPUs. An AMD card such as the RX 5700 XT has its own
  Resizable BAR capability and is ReBarUEFI's case.

## What integrating it could mean

1. **Changing the DSDT inside the BIOS file while the app makes it.** This is for the first
   three kinds of board. [W1] does it by decompiling the DSDT with `iasl`, editing the source
   and compiling it again. Vendor DSDTs often do not compile again as they are: the page lists
   ten kinds of compiler errors to fix by hand, and where the DSDT sits in the AmiBoardInfo
   module the result may have to be smaller than the original, so code is cut out by hand as
   well. The app would need a compiler and those repairs built in, or edits to the compiled
   table that are checked per board family. A wrong DSDT leaves an operating system that does
   not start.
2. **Changing the DSDT in memory at boot, from the driver that is already in the firmware.**
   No source describes this; it is an idea, not a known method. It would avoid the compiler,
   but the driver would have to find the right `_CRS` in a table it did not write, and a
   mistake again leaves an operating system that does not start. On a board without Above 4G
   Decoding it would change only what the operating system is told, like any other DSDT patch.
3. **Setting up the Linux route for the user**: a changed DSDT in the initrd and a kernel
   parameter. That edits the boot configuration, which differs between distributions, needs
   the changed DSDT of point 1, and does nothing while Secure Boot is on. For a Turing GPU it
   would also need the driver to program the straps and leave BAR1 at 256 MiB, and NVIDIA's
   Linux driver to do the resize afterwards. Nobody has reported that combination working.

## Not decided

No decision has been taken. Three things speak against building it in.

- On a board without Above 4G Decoding a DSDT patch can help Linux only, and a Linux user with
  an AMD or Intel GPU gets there with ReBarUEFI's instructions, without this driver, this app
  or a flash.
- For Turing GPUs on such a board the missing part is the firmware's ability to place the BAR,
  which a DSDT does not add. The route around it in point 3 is untested everywhere.
- An automatic DSDT change can leave a PC unable to start its operating system, and the project
  has no such board to check it on. Where ReBarUEFI's catalog says a DSDT change may be needed,
  the app already stops and says so.

Two things would speak for it: a hardware report from an older board on which the manual DSDT
step was what stood in the way, or someone with a Turing GPU, Linux and a board without Above 4G
Decoding who is willing to try point 3 by hand first.

## For the PC in the question

ASRock H81M-HDS with a Radeon RX 5700 XT, 1 GiB BAR with ReBarUEFI so far. These steps are
ReBarUEFI's, collected here; none was tried by this project.

1. Look for the hidden Above 4G Decoding setting ([W2]). If it exists and works, ReBarUEFI's
   normal route applies, and an ASRock board of that generation may then need the DSDT fix of
   [W1] as well. ReBarUEFI's list has an ASRock Z97 Extreme3 with an RX 5700 XT at 8 GiB,
   "Requires DSDT modification".
2. On Linux without the setting: `sudo dmesg | grep "root bus resource"` shows whether a range
   above `0xffffffff` is announced. If not, follow "DSDT broken 4G Decoding fix (Haswell and
   up) / Linux no 4G Decoding fix" in [W1] with the DSDT of the running system, load it from
   the initrd ([A1], [K1]) with Secure Boot off, and add `pci=realloc` if the BAR stays small.
   The `amdgpu` driver resizes by itself.
3. On Windows without the setting: no method is known.

## Sources

Read on 2026-11-12. The ReBarUEFI wiki was at revision `1e48ef2` (2026-06-14).

- [R1] ReBarUEFI, README: <https://github.com/xCuri0/ReBarUEFI/blob/master/README.md>
- [W1] ReBarUEFI wiki, DSDT Patching: <https://github.com/xCuri0/ReBarUEFI/wiki/DSDT-Patching>
- [W2] ReBarUEFI wiki, Enabling hidden 4G decoding: <https://github.com/xCuri0/ReBarUEFI/wiki/Enabling-hidden-4G-decoding>
- [W3] ReBarUEFI wiki, Common issues (and fixes): <https://github.com/xCuri0/ReBarUEFI/wiki/Common-issues-(and-fixes)>
- [I14] ReBarUEFI issue 14, Missing 4G decoding on Gigabyte Z97X-Gaming 3: <https://github.com/xCuri0/ReBarUEFI/issues/14>
- [K1] Linux kernel documentation, Upgrading ACPI tables via initrd: <https://docs.kernel.org/admin-guide/acpi/initrd_table_override.html>
- [K2] kernel_lockdown(7), "The overriding of ACPI tables": <https://man7.org/linux/man-pages/man7/kernel_lockdown.7.html>
- [U1] Ubuntu security documentation, Kernel protections, "Lockdown enforcement is tied to UEFI Secure Boot": <https://documentation.ubuntu.com/security/security-features/kernel-protections/>
- [A1] ArchWiki, DSDT: <https://wiki.archlinux.org/title/DSDT>
- [N1] NVIDIA open GPU kernel modules, `EnableResizableBar` in `nv-reg.h`: <https://github.com/NVIDIA/open-gpu-kernel-modules/blob/main/kernel-open/nvidia/nv-reg.h>
- [M1] Microsoft, System and driver support for Resizable BAR: <https://learn.microsoft.com/en-us/windows-hardware/drivers/display/resizable-bar-support>

[R1]: https://github.com/xCuri0/ReBarUEFI/blob/master/README.md
[W1]: https://github.com/xCuri0/ReBarUEFI/wiki/DSDT-Patching
[W2]: https://github.com/xCuri0/ReBarUEFI/wiki/Enabling-hidden-4G-decoding
[W3]: https://github.com/xCuri0/ReBarUEFI/wiki/Common-issues-(and-fixes)
[I14]: https://github.com/xCuri0/ReBarUEFI/issues/14
[K1]: https://docs.kernel.org/admin-guide/acpi/initrd_table_override.html
[K2]: https://man7.org/linux/man-pages/man7/kernel_lockdown.7.html
[U1]: https://documentation.ubuntu.com/security/security-features/kernel-protections/
[A1]: https://wiki.archlinux.org/title/DSDT
[N1]: https://github.com/NVIDIA/open-gpu-kernel-modules/blob/main/kernel-open/nvidia/nv-reg.h
[M1]: https://learn.microsoft.com/en-us/windows-hardware/drivers/display/resizable-bar-support
