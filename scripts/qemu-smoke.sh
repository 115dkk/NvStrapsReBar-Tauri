#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
readonly OVMF_CODE="${NVSTRAPS_OVMF_CODE:-/usr/share/OVMF/OVMF_CODE_4M.fd}"
readonly OVMF_VARS="${NVSTRAPS_OVMF_VARS:-/usr/share/OVMF/OVMF_VARS_4M.fd}"
readonly ARTIFACT_ROOT="${NVSTRAPS_QEMU_ARTIFACT_DIR:-${REPO_ROOT}/target/qemu-smoke}"
readonly FIRMWARE_TARGET="${REPO_ROOT}/target/x86_64-unknown-uefi/release"
readonly EFI_IMAGE="${FIRMWARE_TARGET}/NvStrapsReBar.efi"
readonly FFS_IMAGE="${FIRMWARE_TARGET}/NvStrapsReBar.ffs"

for tool in cargo qemu-system-x86_64 timeout grep sha256sum mktemp; do
  if ! command -v "${tool}" >/dev/null 2>&1; then
    echo "missing required tool: ${tool}" >&2
    exit 2
  fi
done

if [[ ! -r "${OVMF_CODE}" || ! -r "${OVMF_VARS}" ]]; then
  echo "OVMF 4M images were not found." >&2
  echo "Set NVSTRAPS_OVMF_CODE and NVSTRAPS_OVMF_VARS to readable image paths." >&2
  exit 2
fi

mkdir -p "${ARTIFACT_ROOT}"
readonly RUN_DIR="$(mktemp -d "${ARTIFACT_ROOT}/run-XXXXXXXX")"
readonly PATCHED_CODE="${RUN_DIR}/OVMF_CODE_4M.nvstraps.fd"
readonly PATCHED_VARS="${RUN_DIR}/OVMF_VARS_4M.nvstraps.fd"
readonly SET_FAT="${RUN_DIR}/set-config"
readonly CHECK_FAT="${RUN_DIR}/check-status"
readonly SET_LOG="${RUN_DIR}/boot-set-config.log"
readonly CHECK_LOG="${RUN_DIR}/boot-check-status.log"
readonly DUPLICATE_LOG="${RUN_DIR}/duplicate-injection.log"
readonly RECEIPT="${RUN_DIR}/RECEIPT.txt"

mkdir "${SET_FAT}" "${CHECK_FAT}"
cp -- "${OVMF_VARS}" "${PATCHED_VARS}"
cp -- "${REPO_ROOT}/tests/qemu/set-config.nsh" "${SET_FAT}/startup.nsh"
cp -- "${REPO_ROOT}/tests/qemu/check-status.nsh" "${CHECK_FAT}/startup.nsh"

cd "${REPO_ROOT}"
cargo build -p nvstraps-uefi --release --target x86_64-unknown-uefi
cargo run -p nvstraps-ffs -- pack "${EFI_IMAGE}" "${FFS_IMAGE}"
cargo run -p nvstraps-ffs -- inspect "${FFS_IMAGE}"
cargo run -p nvstraps-ffs -- inject "${OVMF_CODE}" "${FFS_IMAGE}" "${PATCHED_CODE}"

if cargo run -p nvstraps-ffs -- inject \
  "${PATCHED_CODE}" "${FFS_IMAGE}" "${RUN_DIR}/duplicate-should-not-exist.fd" \
  >"${DUPLICATE_LOG}" 2>&1; then
  echo "duplicate firmware injection unexpectedly succeeded" >&2
  exit 1
fi

run_ovmf() {
  local fat_dir="$1"
  local log_file="$2"

  timeout --signal=TERM 60s qemu-system-x86_64 \
    -machine q35,accel=tcg \
    -m 512 \
    -drive "if=pflash,format=raw,unit=0,readonly=on,file=${PATCHED_CODE}" \
    -drive "if=pflash,format=raw,unit=1,file=${PATCHED_VARS}" \
    -drive "format=raw,file=fat:rw:${fat_dir}" \
    -display none \
    -serial stdio \
    -monitor none \
    -net none \
    -no-reboot \
    2>&1 | tee "${log_file}"
}

run_ovmf "${SET_FAT}" "${SET_LOG}"
grep -F "DataSize = 0x08" "${SET_LOG}" >/dev/null
grep -F "00000000: 28 00 00 00 00 00 00 00-" "${SET_LOG}" >/dev/null
grep -F "DataSize = 0x0E" "${SET_LOG}" >/dev/null
grep -F "00000000: 01 20 00 00 00 00 00 00-00 00 00 00 00 00" "${SET_LOG}" >/dev/null

run_ovmf "${CHECK_FAT}" "${CHECK_LOG}"
grep -F "DataSize = 0x08" "${CHECK_LOG}" >/dev/null
grep -F "00000000: 1E 00 00 00 00 00 00 00-" "${CHECK_LOG}" >/dev/null

{
  echo "NvStrapsReBar Rust UEFI QEMU smoke test: PASS"
  echo "OVMF code: ${OVMF_CODE}"
  echo "OVMF vars template: ${OVMF_VARS}"
  echo "Patched image SHA-256: $(sha256sum "${PATCHED_CODE}" | cut -d ' ' -f 1)"
  echo "Initial status: 40 (Unconfigured)"
  echo "Configured status: 30 (host-bridge hook installed)"
  echo "Duplicate injection: rejected"
} | tee "${RECEIPT}"

echo "QEMU evidence: ${RUN_DIR}"
