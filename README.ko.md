# NvStrapsReBar

**ReBAR 지원 없이 나온 메인보드에서 NVIDIA Turing GPU(GTX 1600 / RTX 2000)의 Resizable BAR를
켜는 도구입니다.**

[English README → README.md](README.md)

Turing GPU는 하드웨어로는 Resizable BAR를 지원하지만 NVIDIA가 끝내 켜 주지 않았고, 오래된
메인보드에는 BIOS 설정에 ReBAR 항목 자체가 없습니다. NvStrapsReBar가 이 틈을 메웁니다. 부팅
때 Windows보다 먼저 실행되는 작은 UEFI 드라이버가 GPU의 BAR(CPU가 VRAM을 읽고 쓸 때
지나가는 메모리 창)를 기본 256 MiB에서 VRAM 전체 크기까지 넓혀 줍니다. 이 저장소는 원본
C/C++ [NvStrapsReBar](https://github.com/terminatorul/NvStrapsReBar)를 안정판 Rust로 다시 만든
것으로, BIOS 이미지를 준비하고 드라이버 설정을 고치는 Rust/Tauri Windows 앱까지 함께 들어
있습니다.

## 두 단계

앱은 전체 과정을 만나는 순서 그대로 두 단계로 보여 줍니다.

1. **펌웨어 설치**: 내 메인보드의 공식 BIOS 파일을 고릅니다. 앱이 파일을 확인하고
   NvStrapsReBar DXE 드라이버를 넣은 뒤(오래된 보드라면 미리 준비된 목록에서 고른 BIOS 패치도
   함께), 새 이미지·손대지 않은 원본·체크섬·따라 하기 안내를 한 묶음으로 내보냅니다. 플래시는
   M-FLASH나 플래시백 버튼처럼 보드 제조사가 주는 도구로 직접 합니다. 앱은 플래시하지
   않습니다.
2. **BAR 설정**: 새 BIOS로 한 번 부팅하고 나면, 앱이 UEFI 변수를 통해 드라이버와 대화합니다.
   Resizable BAR 확장을 켜고 끄고, GPU마다 크기를 정하거나 빼고, 필요한 보드에는 메인보드 쪽
   BAR 크기 제한도 정합니다. 저장은 확인 한 번이면 되고, 다음 재시작 때 적용됩니다.

첫 화면에는 NVIDIA GPU마다 지금 BAR 크기와 다음에 할 일이 나옵니다. 이미 다른 도구로 원본
NvStrapsReBar를 설치해 뒀더라도, 앱이 넓어진 BAR를 알아보고 같은 UEFI 변수를 그대로
편집합니다.

## 필요한 것

- NVIDIA Turing GPU: GTX 1600 또는 RTX 2000 시리즈
- UEFI 모드로 부팅하는 메인보드. BIOS 설정에서 **Above 4G Decoding**은 켜고 **CSM**은 꺼야
  합니다.
- 내 보드와 리비전에 맞는 공식 BIOS 이미지, 그리고 실제로 되는 플래시 방법과 복구
  방법(플래시백 버튼, 듀얼 BIOS, SPI 프로그래머 등)
- 관리자 권한을 쓸 수 있는 Windows 계정 (UEFI 변수를 읽고 쓰는 데 필요합니다). 필요해지면
  앱이 관리자 권한으로 다시 시작할지 물어봅니다.

GTX 1000(Pascal) 이하는 지원하지 않습니다. BAR가 바뀌면 Windows용 NVIDIA 드라이버가 죽기
때문에, 앱에서도 아예 고를 수 없습니다.

## 지금 상태

Rust 드라이버와 펌웨어 도구는 호스트 테스트와 QEMU/OVMF 부팅 테스트를 통과했지만, 실제
컴퓨터에서 플래시까지 끝까지 해 본 확인은 아직 없습니다. BIOS 플래시가 잘못되면 보드가 안
켜질 수 있으니, 복구 방법이 실제로 되는지 확인한 다음에만 진행하세요. MSI PRO Z690-A
DDR4(MS-7D25)는 문서에 있는 M-FLASH 설치와 Flash BIOS Button 복구 경로를 앱이 미리 채워
주고, 다른 보드에서는 직접 고릅니다.

## 결과 확인

`nvidia-smi -q -d memory`를 돌려 보거나, 앱 첫 화면만 봐도 됩니다. 확장된 GPU는 새 BAR
크기가 초록색으로 나옵니다. Resizable BAR를 게임마다 켜고 끄는 일은 NVIDIA 드라이버 몫이라,
앱이 공식 [NVIDIA Profile Inspector](https://github.com/Orbmu2k/nvidiaProfileInspector)
릴리스를 설치하고, 지금 프로필을 백업해 두고, 열어 주는 데까지 맡습니다.

## 하드웨어를 바꾸기 전에

먼저 BAR 설정에서 지금 설정을 파일로 저장해 두고, 확장을 끄고 저장한 다음, 컴퓨터를 끄고
나서 GPU를 바꾸거나 슬롯을 옮기세요. 교체가 끝나면 파일을 불러와 설정을 되돌립니다.
드라이버는 부팅 때 펌웨어가 정해 주는 주소로 GPU를 찾는데, 하드웨어가 바뀌면 이 주소도
바뀝니다. Windows 없이도 쓸 수 있는 안전장치가 두 가지 있습니다. BIOS 설정이 바뀌면
드라이버가 그 부팅에서는 스스로 쉬고(기본으로 켜져 있는 보호 기능), 시계 배터리를 빼거나
점퍼로 지우는 CMOS 리셋을 하면 꺼진 상태로 저장됩니다.

## 개발

필요한 것: Node.js 24+, `rustfmt`·`clippy`가 있는 안정판 Rust, `x86_64-unknown-uefi` 타깃.
패키지로 만든 앱을 쓰기만 할 때는 아무것도 필요 없습니다.

```powershell
npm ci
npm run check        # TypeScript, 단위 테스트, 린트
npm run check:rust   # fmt, clippy, 호스트·UEFI 타깃 테스트
npm run tauri dev
```

릴리스 빌드와 나머지 검사:

```powershell
npm run tauri:ci     # NvStrapsReBar.exe + NvStrapsReBar.ffs (앱에 함께 들어감)
npm run test:e2e     # Playwright 여정 테스트
npm run check:firmware
npm run check:riir   # C/C++ 소스와 지워진 EDK2 빌드 트리가 들어오면 거부
npm run check:miri   # 먼저: rustup toolchain install nightly --component miri --profile minimal
```

`npm run check:miri`는 호스트에서 돌릴 수 있는 계약 코드와 BAR1 MMIO 읽기·쓰기 코드를
해석합니다. Windows FFI와 UEFI 프로토콜 경계는 컴파일, Clippy, 네이티브 테스트, 그리고 QEMU와
OVMF가 있는 Linux에서 도는 `npm run test:qemu`(변수 저장소를 분리한 OVMF 사본으로 부팅)가
맡습니다.

더 깊은 문서(영어):

- [Rust UEFI 구현 상태](docs/RUST_UEFI_PORT.md)
- [Tauri 백엔드 계약](docs/TAURI_BACKEND.md)
- [RIIR와 원클릭 배포의 경계](docs/RIIR_AND_ONE_CLICK.md)
- [도메인 용어](CONTEXT.md)

## 만든 바탕

이 작업은 @terminatorul의 원본 C/C++
[NvStrapsReBar](https://github.com/terminatorul/NvStrapsReBar), 그 뿌리인
[ReBarUEFI](https://github.com/xCuri0/ReBarUEFI) 프로젝트, 그리고
[envytools](https://github.com/envytools/envytools)와 @mupuf, @Xelafic의 연구 위에 서
있습니다. 미리 준비해 둔 레거시 패치 목록은 출처와 해시를 그대로 지킵니다.

## 라이선스

저장소가 직접 가진 소스 코드는 [MIT 라이선스](LICENSE)로 배포합니다. 함께 들어 있는
Pretendard Variable·Jetendard 글꼴은 SIL Open Font License 1.1을 그대로 따르며 MIT로 바뀌지
않습니다. 출처와 해시는 [서드파티 고지](THIRD_PARTY_NOTICES.md)에 있고, 저작권 고지와 OFL
전문은 앱의 **Licenses** 버튼에서 오프라인으로 읽을 수 있습니다.
