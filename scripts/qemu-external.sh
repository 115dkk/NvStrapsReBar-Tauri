#!/usr/bin/env bash
set -euo pipefail
readonly REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly CODE="${NVSTRAPS_OVMF_CODE:-/usr/share/OVMF/OVMF_CODE_4M.fd}"
readonly VARS="${NVSTRAPS_OVMF_VARS:-/usr/share/OVMF/OVMF_VARS_4M.fd}"
cd "${REPO_ROOT}"
mkdir -p target/qemu-external
readonly RUN="$(mktemp -d "${REPO_ROOT}/target/qemu-external/run-XXXXXXXX")"
mkdir "${RUN}/logs" "${RUN}/native" "${RUN}/model"
readonly BEFORE="$(sha256sum "${CODE}" | cut -d ' ' -f 1)"
cargo build -p nvstraps-external-efi --release --target x86_64-unknown-uefi
cargo build -p nvstraps-external-efi --features qemu-model --target x86_64-unknown-uefi
cargo build -p nvstraps-external-tool
readonly RELEASE="${REPO_ROOT}/target/x86_64-unknown-uefi/release"
readonly MODEL="${REPO_ROOT}/target/x86_64-unknown-uefi/debug"
readonly TOOL="${REPO_ROOT}/target/debug/nvstraps-external-tool"

run_vm() {
  local folder="$1" label="$2"
  local disk="${RUN}/${label}.fat.img"
  # vvfat's writable directory bridge can mis-reconstruct newly allocated files.
  # Use a real FAT image and read the guest's bytes back through mtools instead.
  truncate -s 128M "${disk}"
  mkfs.vfat -F 32 "${disk}"
  mcopy -s -i "${disk}" "${folder}"/* ::/
  cp -- "${VARS}" "${RUN}/${label}.vars.fd"
  timeout --signal=TERM 75s qemu-system-x86_64 \
    -machine q35,accel=tcg -m 512 \
    -drive "if=pflash,format=raw,unit=0,readonly=on,file=${CODE}" \
    -drive "if=pflash,format=raw,unit=1,file=${RUN}/${label}.vars.fd" \
    -drive "format=raw,file=${disk}" \
    -display none -serial stdio -monitor none -net none -no-reboot \
    2>&1 | tee "${RUN}/logs/${label}.log"
  if [[ "${label}" == *-diagnostic ]]; then
    mcopy -i "${disk}" ::/NvStrapsDiagnostic.json "${folder}/NvStrapsDiagnostic.json"
  fi
}

cp -- "${RELEASE}/NvStrapsDiagnostic.efi" "${RUN}/native/probe.efi"
printf 'fs0:\\probe.efi\r\nreset -s\r\n' > "${RUN}/native/startup.nsh"
run_vm "${RUN}/native" native-diagnostic
node tools/check-external-evidence.mjs diagnostic "${RUN}/native/NvStrapsDiagnostic.json" physical
cp -- "${RUN}/native/NvStrapsDiagnostic.json" "${RUN}/logs/native-diagnostic.json"

cp -- "${MODEL}/NvStrapsDiagnostic.efi" "${RUN}/model/probe.efi"
printf 'fs0:\\probe.efi\r\nreset -s\r\n' > "${RUN}/model/startup.nsh"
run_vm "${RUN}/model" model-diagnostic
node tools/check-external-evidence.mjs diagnostic "${RUN}/model/NvStrapsDiagnostic.json" qemuModel
"${TOOL}" plan "${RUN}/model/NvStrapsDiagnostic.json" 0 1 0 0 8192 \
  '\EFI\NvStraps\Next.efi' "${MODEL}/NvStrapsHandoffProbe.efi" --cold-boot-experimental "${RUN}/plan.json"
"${TOOL}" package "${MODEL}/NvStrapsDiagnostic.efi" "${MODEL}/NvStrapsLoader.efi" "${RUN}/plan.json" "${RUN}/package"
cp -- "${MODEL}/NvStrapsHandoffProbe.efi" "${RUN}/package/EFI/NvStraps/Next.efi"
printf 'fs0:\\EFI\\BOOT\\BOOTX64.EFI\r\nreset -s\r\n' > "${RUN}/package/startup.nsh"
run_vm "${RUN}/package" model-chainload
node tools/check-external-evidence.mjs success "${RUN}/logs/model-chainload.log"

mkdir -p "${RUN}/production-reject/EFI/NvStraps"
cp -- "${RELEASE}/NvStrapsLoader.efi" "${RUN}/production-reject/loader.efi"
cp -- "${RUN}/plan.json" "${RUN}/production-reject/EFI/NvStraps/plan.json"
printf 'fs0:\\loader.efi\r\nreset -s\r\n' > "${RUN}/production-reject/startup.nsh"
run_vm "${RUN}/production-reject" production-reject
node tools/check-external-evidence.mjs rejection "${RUN}/logs/production-reject.log" 'test plan rejected by production loader'

mkdir -p "${RUN}/tampered/EFI/NvStraps"
cp -- "${MODEL}/NvStrapsLoader.efi" "${RUN}/tampered/loader.efi"
cp -- "${RUN}/plan.json" "${RUN}/tampered/EFI/NvStraps/plan.json"
printf 'changed successor' > "${RUN}/tampered/EFI/NvStraps/Next.efi"
printf 'fs0:\\loader.efi\r\nreset -s\r\n' > "${RUN}/tampered/startup.nsh"
run_vm "${RUN}/tampered" successor-reject
node tools/check-external-evidence.mjs rejection "${RUN}/logs/successor-reject.log" 'pinned successor missing or changed'

test "${BEFORE}" = "$(sha256sum "${CODE}" | cut -d ' ' -f 1)"
cp -- "${RUN}/package/manifest.json" "${RUN}/logs/package-manifest.json"
printf '%s\n' \
  'PASS: disk-loaded native diagnostic on unmodified OVMF' \
  'PASS: diagnostic -> host plan -> immutable package -> EFI loader -> actual successor LoadImage/StartImage' \
  'PASS: shared transaction resized a synthetic Turing register model to 8 GiB and restored it on successor return' \
  'PASS: production loader rejects synthetic plans; altered successor rejected before mutation' \
  'GPU model is synthetic. No claim about physical Turing, vendor flash, Windows or S3 resume.' \
  "OVMF code SHA-256 unchanged: ${BEFORE}" > "${RUN}/logs/RECEIPT.txt"
cat "${RUN}/logs/RECEIPT.txt"
