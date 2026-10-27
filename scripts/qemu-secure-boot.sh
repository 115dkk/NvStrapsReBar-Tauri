#!/usr/bin/env bash
# Proves the release signing path on real firmware verification: OVMF with Secure Boot on and a db
# certificate enrolled runs the diagnostic signed by nvstraps-external-tool with that certificate's key,
# and refuses the unsigned image and a signed image with one changed byte. The keys are throwaway
# stand-ins for secure-boot/NvStrapsReBar-db.cer; only logs and reports leave the run folder.
set -euo pipefail
readonly REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly CODE="${NVSTRAPS_OVMF_SECBOOT_CODE:-/usr/share/OVMF/OVMF_CODE_4M.secboot.fd}"
readonly VARS="${NVSTRAPS_OVMF_VARS:-/usr/share/OVMF/OVMF_VARS_4M.fd}"
readonly OWNER="7d5c2a18-0f6c-4d0c-9a8e-3c1b5e2f4a61"
cd "${REPO_ROOT}"
test -f "${CODE}" || { echo "Secure Boot OVMF code is missing: ${CODE}" >&2; exit 1; }
mkdir -p target/qemu-secure-boot
readonly RUN="$(mktemp -d "${REPO_ROOT}/target/qemu-secure-boot/run-XXXXXXXX")"
mkdir "${RUN}/logs" "${RUN}/keys"
readonly BEFORE="$(sha256sum "${CODE}" | cut -d ' ' -f 1)"
cargo build -p nvstraps-external-efi --release --target x86_64-unknown-uefi
cargo build -p nvstraps-external-tool
readonly IMAGE="${REPO_ROOT}/target/x86_64-unknown-uefi/release/NvStrapsDiagnostic.efi"
readonly TOOL="${REPO_ROOT}/target/debug/nvstraps-external-tool"

certificate() {
  openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 30 -subj "/CN=NvStrapsReBar CI $1" \
    -keyout "${RUN}/keys/$1.key" -out "${RUN}/keys/$1.pem" 2>/dev/null
}
certificate pk
certificate kek
certificate db
openssl x509 -in "${RUN}/keys/db.pem" -outform DER -out "${RUN}/keys/db.cer"

"${TOOL}" sign "${IMAGE}" "${RUN}/keys/db.cer" "${RUN}/keys/db.key" "${RUN}/signed.efi"
"${TOOL}" check-signed "${RUN}/signed.efi" "${RUN}/keys/db.cer"
# An independent implementation must read the same signature.
osslsigncode verify -in "${RUN}/signed.efi" -CAfile "${RUN}/keys/db.pem" 2>&1 | tee "${RUN}/logs/osslsigncode.txt"
rm -f -- "${RUN}"/keys/*.key

# One byte inside the hashed sections, far from the headers and the certificate table.
cp -- "${RUN}/signed.efi" "${RUN}/changed.efi"
printf '\x00' | dd of="${RUN}/changed.efi" bs=1 seek=4352 conv=notrunc status=none
cmp -s "${RUN}/signed.efi" "${RUN}/changed.efi" && printf '\x01' | dd of="${RUN}/changed.efi" bs=1 seek=4352 conv=notrunc status=none

virt-fw-vars --input "${VARS}" --output "${RUN}/secure.vars.fd" \
  --set-pk "${OWNER}" "${RUN}/keys/pk.pem" \
  --add-kek "${OWNER}" "${RUN}/keys/kek.pem" \
  --add-db "${OWNER}" "${RUN}/keys/db.pem" \
  --secure-boot

boot() {
  local label="$1" image="$2"
  local folder="${RUN}/${label}" disk="${RUN}/${label}.fat.img"
  mkdir -p "${folder}/EFI/BOOT"
  cp -- "${image}" "${folder}/EFI/BOOT/BOOTX64.EFI"
  truncate -s 64M "${disk}"
  mkfs.vfat -F 32 "${disk}" >/dev/null
  mcopy -s -i "${disk}" "${folder}"/* ::/
  cp -- "${RUN}/secure.vars.fd" "${RUN}/${label}.vars.fd"
  local result=0
  # The removable-media path is how a user's firmware starts it. After the diagnostic returns, the
  # firmware waits in its boot menu, so the timeout ends every run.
  timeout --signal=TERM 75s qemu-system-x86_64 \
    -machine q35,smm=on,accel=tcg -m 512 \
    -global driver=cfi.pflash01,property=secure,value=on \
    -drive "if=pflash,format=raw,unit=0,readonly=on,file=${CODE}" \
    -drive "if=pflash,format=raw,unit=1,file=${RUN}/${label}.vars.fd" \
    -drive "format=raw,file=${disk}" \
    -display none -serial stdio -monitor none -net none -no-reboot \
    2>&1 | tee "${RUN}/logs/${label}.log" || result=$?
  if [[ "${result}" != 0 && "${result}" != 124 ]]; then return "${result}"; fi
  mcopy -n -i "${disk}" ::/EFI/NvStraps/diagnostic.json "${RUN}/logs/${label}.json" 2>/dev/null || true
}

boot signed "${RUN}/signed.efi"
grep -q 'EXTERNAL-DIAGNOSTIC: saved' "${RUN}/logs/signed.log"
test -s "${RUN}/logs/signed.json"
grep -q '"secureBoot": true' "${RUN}/logs/signed.json"

boot unsigned "${IMAGE}"
boot changed "${RUN}/changed.efi"
for label in unsigned changed; do
  if grep -q 'EXTERNAL-DIAGNOSTIC' "${RUN}/logs/${label}.log" || test -e "${RUN}/logs/${label}.json"; then
    echo "Secure Boot ran the ${label} diagnostic" >&2
    exit 1
  fi
done

test "${BEFORE}" = "$(sha256sum "${CODE}" | cut -d ' ' -f 1)"
printf '%s\n' \
  'PASS: OVMF with Secure Boot on and a db certificate enrolled ran the diagnostic signed by nvstraps-external-tool; its report says secureBoot=true' \
  'PASS: osslsigncode verified the same signature independently' \
  'PASS: Secure Boot refused the unsigned diagnostic and a signed one with one changed byte' \
  'The certificates are throwaway CI keys; the release uses secure-boot/NvStrapsReBar-db.cer.' \
  "OVMF code SHA-256 unchanged: ${BEFORE}" > "${RUN}/logs/RECEIPT.txt"
cat "${RUN}/logs/RECEIPT.txt"
