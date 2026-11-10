#!/usr/bin/env bash
# Proves the Linux root helper on real firmware and a real kernel: OVMF with the NvStrapsReBar
# driver injected, a stock Linux kernel booted through its EFI stub, and the production
# nvstraps-rebar-helper (static musl build) as the only thing that touches the variable.
#
#   boot 1  the driver reports Unconfigured; the helper writes a configuration; an unprivileged
#           user can read it and can neither change nor delete it
#   boot 2  the driver reports that it acted on that configuration; the helper overwrites the
#           now-immutable variable with a longer and then a shorter one, refuses invalid bytes,
#           and deletes it
#   boot 3  the driver reports Unconfigured again
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
readonly OVMF_CODE="${NVSTRAPS_OVMF_CODE:-/usr/share/OVMF/OVMF_CODE_4M.fd}"
readonly OVMF_VARS="${NVSTRAPS_OVMF_VARS:-/usr/share/OVMF/OVMF_VARS_4M.fd}"
readonly BUSYBOX="${NVSTRAPS_BUSYBOX:-/usr/bin/busybox}"
readonly ARTIFACT_ROOT="${NVSTRAPS_QEMU_ARTIFACT_DIR:-${REPO_ROOT}/target/qemu-linux-helper}"
readonly FIRMWARE_TARGET="${REPO_ROOT}/target/x86_64-unknown-uefi/release"
readonly EFI_IMAGE="${FIRMWARE_TARGET}/NvStrapsReBar.efi"
readonly FFS_IMAGE="${FIRMWARE_TARGET}/NvStrapsReBar.ffs"
readonly HELPER="${REPO_ROOT}/target/x86_64-unknown-linux-musl/release/nvstraps-rebar-helper"

# Configurations the helper is asked to write. The first is the one tests/qemu/set-config.nsh
# sets from the UEFI shell, so the driver status it leads to is the same as in qemu-smoke.sh.
readonly SAMPLE_FIRST="0120000000000000000000000000"
readonly SAMPLE_LONGER="012000000000000000000001071e62141537010007000000"
readonly SAMPLE_SHORTER="0220000000000000000000000000"
readonly SAMPLE_INVALID="01200000000000000000000000ff"
# efivarfs puts the attribute word first: 7 is NV|BS|RT (configuration), 6 is BS|RT (status).
readonly STATUS_UNCONFIGURED="06000000""2800000000000000"
readonly STATUS_HOOK_INSTALLED="06000000""1e00000000000000"

for tool in cargo qemu-system-x86_64 timeout grep sha256sum mktemp cpio gzip; do
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

if [[ ! -x "${BUSYBOX}" ]] || ! "${BUSYBOX}" --list | grep -qx su; then
  echo "A static BusyBox with the su applet was not found at ${BUSYBOX}." >&2
  echo "Install busybox-static or set NVSTRAPS_BUSYBOX." >&2
  exit 2
fi

# A kernel with CONFIG_EFI_STUB=y and CONFIG_EFIVAR_FS=y. Ubuntu's generic kernel has both built
# in; without NVSTRAPS_LINUX_KERNEL the package is downloaded (not installed) and unpacked once.
resolve_kernel() {
  if [[ -n "${NVSTRAPS_LINUX_KERNEL:-}" ]]; then
    printf '%s\n' "${NVSTRAPS_LINUX_KERNEL}"
    return
  fi
  local cache="${ARTIFACT_ROOT}/kernel"
  local found
  found="$(find "${cache}" -name 'vmlinuz-*' -print -quit 2>/dev/null || true)"
  if [[ -z "${found}" ]]; then
    for tool in apt-cache apt-get dpkg-deb; do
      if ! command -v "${tool}" >/dev/null 2>&1; then
        echo "Set NVSTRAPS_LINUX_KERNEL to a kernel image with CONFIG_EFIVAR_FS=y." >&2
        exit 2
      fi
    done
    local package
    package="$(apt-cache depends linux-image-virtual \
      | sed -n 's/^ *Depends: \(linux-image-[0-9][^ ]*\)$/\1/p' | head -n 1)"
    if [[ -z "${package}" ]]; then
      echo "apt does not know a versioned kernel package; set NVSTRAPS_LINUX_KERNEL." >&2
      exit 2
    fi
    mkdir -p "${cache}/download"
    (cd "${cache}/download" && apt-get download "${package}" >&2)
    dpkg-deb -x "${cache}/download/"*.deb "${cache}/root"
    found="$(find "${cache}" -name 'vmlinuz-*' -print -quit)"
  fi
  printf '%s\n' "${found}"
}

mkdir -p "${ARTIFACT_ROOT}"
readonly KERNEL="$(resolve_kernel)"
if [[ ! -r "${KERNEL}" ]]; then
  echo "kernel image is not readable: ${KERNEL}" >&2
  exit 2
fi

readonly RUN_DIR="$(mktemp -d "${ARTIFACT_ROOT}/run-XXXXXXXX")"
readonly LOG_DIR="${RUN_DIR}/logs"
readonly PATCHED_CODE="${RUN_DIR}/OVMF_CODE_4M.nvstraps.fd"
readonly VARS="${RUN_DIR}/OVMF_VARS_4M.nvstraps.fd"
readonly INITRAMFS_ROOT="${RUN_DIR}/initramfs"
readonly INITRAMFS="${RUN_DIR}/initramfs.cpio.gz"
mkdir "${LOG_DIR}"

cd "${REPO_ROOT}"
cargo build -p nvstraps-uefi --release --target x86_64-unknown-uefi
cargo run -p nvstraps-ffs -- pack "${EFI_IMAGE}" "${FFS_IMAGE}"
cargo run -p nvstraps-ffs -- inject "${OVMF_CODE}" "${FFS_IMAGE}" "${PATCHED_CODE}"
cargo build -p nvstraps-linux-helper --release --target x86_64-unknown-linux-musl
cp -- "${OVMF_VARS}" "${VARS}"

mkdir -p "${INITRAMFS_ROOT}"/{bin,etc,proc,sys}
cp -- "${BUSYBOX}" "${INITRAMFS_ROOT}/bin/busybox"
cp -- "${HELPER}" "${INITRAMFS_ROOT}/bin/nvstraps-rebar-helper"
cp -- "${REPO_ROOT}/tests/qemu/linux-helper-init.sh" "${INITRAMFS_ROOT}/init"
chmod 0755 "${INITRAMFS_ROOT}/init" "${INITRAMFS_ROOT}/bin/busybox" \
  "${INITRAMFS_ROOT}/bin/nvstraps-rebar-helper"
{
  echo "SAMPLE_FIRST=${SAMPLE_FIRST}"
  echo "SAMPLE_LONGER=${SAMPLE_LONGER}"
  echo "SAMPLE_SHORTER=${SAMPLE_SHORTER}"
  echo "SAMPLE_INVALID=${SAMPLE_INVALID}"
} > "${INITRAMFS_ROOT}/etc/nvstraps-samples"
(cd "${INITRAMFS_ROOT}" && find . -print0 | cpio --null -o -H newc 2>/dev/null | gzip -9) \
  > "${INITRAMFS}"

boot() {
  local stage="$1"
  local log_file="${LOG_DIR}/boot-${stage}.log"

  timeout --signal=TERM 180s qemu-system-x86_64 \
    -machine q35,accel=tcg \
    -cpu max \
    -m 512 \
    -drive "if=pflash,format=raw,unit=0,readonly=on,file=${PATCHED_CODE}" \
    -drive "if=pflash,format=raw,unit=1,file=${VARS}" \
    -kernel "${KERNEL}" \
    -initrd "${INITRAMFS}" \
    -append "console=ttyS0 panic=-1 quiet nvstraps.stage=${stage}" \
    -display none \
    -serial stdio \
    -monitor none \
    -net none \
    -no-reboot \
    2>&1 | tee "${log_file}"
  grep -aF "NVSTRAPS-LINUX: stage ${stage} ends" "${log_file}" >/dev/null
}

# Every expectation is one exact line of the guest's report.
expect() {
  local stage="$1"
  local line="$2"
  if ! grep -aFx "NVSTRAPS-LINUX: ${line}" <(tr -d '\r' < "${LOG_DIR}/boot-${stage}.log") >/dev/null; then
    echo "boot ${stage}: expected line is missing: ${line}" >&2
    exit 1
  fi
}

boot 1
expect 1 "stage 1 begins: status=${STATUS_UNCONFIGURED} config=absent"
expect 1 'hello={"hello":{"protocol":1,"privileged":true}}'
expect 1 'write-first={"id":1,"ok":true}'
expect 1 "config-after-write=07000000${SAMPLE_FIRST}"
expect 1 "user-read=07000000${SAMPLE_FIRST}"
expect 1 "user-write=refused"
expect 1 "user-delete=refused"
expect 1 "config-after-user-attempts=07000000${SAMPLE_FIRST}"

boot 2
expect 2 "stage 2 begins: status=${STATUS_HOOK_INSTALLED} config=07000000${SAMPLE_FIRST}"
expect 2 'write-longer={"id":2,"ok":true}'
expect 2 "config-after-longer=07000000${SAMPLE_LONGER}"
expect 2 'write-shorter={"id":3,"ok":true}'
expect 2 "config-after-shorter=07000000${SAMPLE_SHORTER}"
expect 2 'write-invalid={"id":4,"ok":false,"error":{"code":"invalidConfiguration","message":"too many PCI bridge records"}}'
expect 2 "config-after-invalid=07000000${SAMPLE_SHORTER}"
expect 2 'delete={"id":5,"ok":true}'
expect 2 "config-after-delete=absent"
expect 2 'delete-again={"id":6,"ok":true}'
expect 2 "config-after-delete-again=absent"

boot 3
expect 3 "stage 3 begins: status=${STATUS_UNCONFIGURED} config=absent"

{
  echo "NvStrapsReBar Linux helper on OVMF and a real kernel: PASS"
  echo "Kernel: ${KERNEL}"
  echo "Patched OVMF SHA-256: $(sha256sum "${PATCHED_CODE}" | cut -d ' ' -f 1)"
  echo "Helper SHA-256: $(sha256sum "${HELPER}" | cut -d ' ' -f 1)"
  echo "Boot 1: driver Unconfigured (40); helper wrote the configuration; a normal user read it and could not change or delete it"
  echo "Boot 2: driver acted on the configuration Linux wrote (30); helper replaced the immutable variable with a longer and a shorter one, refused invalid bytes, deleted it"
  echo "Boot 3: driver Unconfigured (40) again"
  echo "Not shown: QEMU has no NVIDIA GPU, and polkit, the desktop application and a physical board were not involved"
} | tee "${LOG_DIR}/RECEIPT.txt"

echo "QEMU evidence: ${LOG_DIR}"
