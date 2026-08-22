# Third-party notices

Repository-owned source code is licensed under the repository's [MIT license](LICENSE). The
third-party works below retain their own licenses and are not relicensed under MIT.

## lzma-sdk-rs

- Component: `lzma-sdk-rs`
- Version: 0.2301.1
- Copyright: Copyright (c) 2026, Dani Sarfati
- License: BSD 3-Clause
- Upstream: <https://github.com/danifunker/lzma-sdk-rs>
- Full license: [`public/licenses/lzma-sdk-rs/LICENSE`](public/licenses/lzma-sdk-rs/LICENSE)

This pure-Rust 7-Zip LZMA SDK port is used to rebuild firmware GUID-defined
LZMA sections. The original LZMA SDK was placed in the public domain by Igor
Pavlov. The application includes the complete BSD notice in its offline
**Licenses** dialog.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `LICENSE` | 1,726 | `6557e553354f1ab90110a7828fb644a69daf0a9d7309c5cab6be4ab80983dd8c` |

## Pretendard

- Component: Pretendard Variable
- Version: 1.3.9
- Copyright: Copyright (c) 2021, Kil Hyung-jin
- Reserved Font Name: `Pretendard`
- License: SIL Open Font License, Version 1.1
- Upstream: <https://github.com/orioncactus/pretendard/tree/v1.3.9>
- Bundled font: [`src/assets/fonts/PretendardVariable.woff2`](src/assets/fonts/PretendardVariable.woff2)
- Full license: [`public/licenses/Pretendard/LICENSE`](public/licenses/Pretendard/LICENSE)

The bundled font is the unmodified `PretendardVariable.woff2` published in the upstream v1.3.9
release. Its weight axis covers 45–920.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `PretendardVariable.woff2` | 2,057,688 | `9599f12fd42fc0bce1cd50b47a0c022e108d7aa64dd0d1bb0ed44f3282d900b4` |
| `LICENSE` | 4,418 | `d31ddd9f2bed32fd7e302a205cf2380ba0de6529152d239ef99cfb6f261bfc04` |

Every application build includes the copyright notice and complete OFL text. Users can open it
offline through the application's **Licenses** button. `npm run check:third-party` verifies the
source files and production-build copies against the pinned size and hashes.

## Jetendard

- Component: Jetendard WebFont, upright static faces
- Version: 0.1.0
- Copyright: Copyright (c) 2026 Jung Woong Park
- Reserved Font Name: `Jetendard`
- License: SIL Open Font License, Version 1.1
- Upstream: <https://github.com/kuskhan/jetendard/releases/tag/v0.1.0>
- Release archive: <https://github.com/kuskhan/jetendard/releases/download/v0.1.0/Jetendard-WebFont.zip>
- Bundled fonts: [`src/assets/fonts/Jetendard/`](src/assets/fonts/Jetendard/)
- Full license: [`public/licenses/Jetendard/LICENSE`](public/licenses/Jetendard/LICENSE)

Jetendard combines JetBrains Mono Nerd Font Mono with Pretendard Korean glyphs so Korean occupies
two Latin monospace cells. This repository bundles only the upright Regular (400), SemiBold (600),
and Bold (700) WOFF2 faces used by the interface. The release archive is not redistributed; its
digest pins the exact source from which the three files were extracted.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `Jetendard-WebFont.zip` | 26,488,266 | `42101ca2849d79e6356ebe8841d010fc558365ace1e737d85496dc3061539159` |
| `Jetendard-Regular.woff2` | 1,680,500 | `a92e12e86d773a41915a92dc87d113f13f954a688508060e4cc3fa93ed08f189` |
| `Jetendard-SemiBold.woff2` | 1,689,308 | `00e92336e1ac1c596b95a06a3120d58d35f23d306834dbb3938032db02f7ee86` |
| `Jetendard-Bold.woff2` | 1,693,208 | `d128ebd88b0dbd3ea5441768970e53fbad1044d138904b3dd7ff15a49c3f075d` |
| `LICENSE` | 4,640 | `c6bd5bf88860a4baab08368d5a42cc82863e394400810719352a990d7fda78cb` |

Every application build includes both Jetendard's copyright notice and complete OFL text. Users
can read it offline through the application's **Licenses** dialog. `npm run check:third-party`
verifies the bundled source files and production-build copies against the pinned size and hashes.
