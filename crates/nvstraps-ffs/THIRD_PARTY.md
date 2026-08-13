# Third-party notices

## TianoCore EDK2 compression format

`src/efi_compression.rs` is a clean Rust implementation of the EFI Standard
and Tiano compression wire formats. Its length-limited Huffman construction
and format behavior are derived from TianoCore EDK2 BaseTools
`EfiCompress.c`, `TianoCompress.c`, and `Decompress.c`.

- Upstream: <https://github.com/tianocore/edk2>
- License: BSD-2-Clause-Patent
- License text: `LICENSES/BSD-2-Clause-Patent.txt`

No EDK2 C or C++ code is compiled or linked into NvStrapsReBar.
