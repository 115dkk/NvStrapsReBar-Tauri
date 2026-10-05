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

## 앱이 안내하는 순서

앱은 PC 상태에 맞는 화면으로 열리고, 화면마다 할 일 하나만 보여 줍니다. 설치는 네 단계로
진행하며, 중간에 앱을 닫아도 다음에 열면 같은 단계에서 이어집니다.

1. **준비**: 내 메인보드의 공식 BIOS 파일을 고르고 설치·복구 방법을 확인합니다. 앱에 등록된
   보드는 방법을 미리 채워 두고, 다른 보드는 설명서를 보고 질문 세 개에 답합니다. Above 4G만
   있는 오래된 보드는 분석기가 권하는 BIOS 패치도 확인합니다. 앱이 NvStrapsReBar DXE 드라이버를
   넣고 검사한 뒤, 새 BIOS 파일·손대지 않은 원본·체크섬·따라 하기 안내(영어·한국어)를 USB에
   저장합니다. 앱이 복구 파일 이름을 아는 보드(MSI PRO Z690-A DDR4의 `MSI.ROM`)에서는 원본
   사본을 그 이름으로 묶음 옆에도 저장합니다.
2. **설치**: 앱에서 BIOS 화면으로 다시 시작해 M-FLASH나 플래시백 버튼처럼 보드 제조사 도구로 새
   파일을 설치하고, 안내된 설정을 바꿉니다. Windows로 돌아오면 앱이 NvStrapsReBar 실행을 확인하고,
   BIOS 화면에서 한 일을 기록합니다.
3. **켜기**: 권장 크기를 저장하고(버튼이 확인 역할을 하며, 앱이 값을 다시 읽어 확인합니다) 다시
   시작합니다.
4. **마무리**: 앱이 NVIDIA 드라이버가 알려 주는 BAR 크기를 확인합니다. 게임마다 켜는 일은 그
   뒤에 마무리 화면과 홈에서 고를 수 있습니다.

설치가 끝나면 홈에 NVIDIA GPU마다 지금 BAR 크기가 나옵니다. **BAR 설정**에서는 Resizable BAR
확장을 켜고 끄고, GPU마다 크기를 정하거나 빼고, 필요한 보드에는 메인보드 쪽 BAR 크기 제한도
정합니다. 여기서 저장할 때는 확인 한 번이면 되고, 다음 재시작 때 적용됩니다. 이미 다른 도구로
원본 NvStrapsReBar를 설치해 뒀더라도, 앱이 넓어진 BAR를 알아보고 같은 UEFI 변수를 그대로
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
DDR4(MS-7D25)는 문서에 있는 M-FLASH 설치와 Flash BIOS Button 복구 방법을 앱이 미리 채워
주고, 다른 보드에서는 직접 고릅니다.

## 결과 확인

`nvidia-smi -q -d memory`를 돌려 보거나, 앱 첫 화면만 봐도 됩니다. 확장된 GPU는 새 BAR
크기가 초록색으로 나옵니다. NVIDIA 드라이버는 Resizable BAR를 게임마다 따로 적용합니다.
**게임마다 켜기** 화면에서 게임을 찾아 스위치를 켜거나, **모든 게임**을 켜서 따로 정한 값이
없는 게임에 한꺼번에 적용합니다. 앱이 프로필을 처음 바꿀 때 그 프로필의 바꾸기 전 값을 기록하고,
같은 화면에서 그 값으로 되돌립니다. 다른 NVIDIA 설정은 건드리지 않으므로 드라이버를 업데이트한
뒤에도 되돌릴 수 있습니다. 바꾼 설정은 게임을 다시 실행하면 적용되고, 앱을
관리자 권한으로 실행해야 바꿀 수 있습니다. 설정 번호는
[NVIDIA Profile Inspector](https://github.com/Orbmu2k/nvidiaProfileInspector)에서 가져왔고,
드라이버와는 NVIDIA가 공개한 NVAPI로 주고받습니다.

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

설치 파일은 같은 두 파일을 Inno Setup 7로 감쌉니다. `npm run tauri:ci` 다음에
`ISCC.exe installer\NvStrapsReBar.iss`를 실행하면 `target\installer\NvStrapsReBar-windows-x64-setup.exe`가
나옵니다. 설치할 때 MIT 라이선스를 보여 주고 시작 메뉴 바로가기를 만들며, 바탕화면 바로가기는
설치하는 사람이 고릅니다. CI는 이 파일을 포터블 ZIP과 함께 올립니다.

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
