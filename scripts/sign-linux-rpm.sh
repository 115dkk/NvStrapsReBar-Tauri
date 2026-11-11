#!/usr/bin/env bash
# Signs the .rpm that `npm run build:linux-packages` wrote (or the one named), then verifies the
# result.
#
# The OpenPGP private key comes from NVSTRAPS_RPM_SIGNING_KEY (ASCII-armoured, no passphrase) and
# is imported into a keyring that exists only for this run. Before anything is signed the key is
# compared with the public key that users import (docs/RPM-GPG-KEY-nvstraps-rebar unless another
# file is named), so a wrong secret cannot produce a package that nobody can verify.
#
# usage: sign-linux-rpm.sh [public-key-file [package.rpm]]
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
readonly BUNDLES="${REPO_ROOT}/target/release/bundle"
readonly PUBLIC_KEY="${1:-${REPO_ROOT}/docs/RPM-GPG-KEY-nvstraps-rebar}"

fail() {
  echo "rpm signing: $*" >&2
  exit 1
}

for tool in gpg gpgconf rpmsign awk mktemp; do
  command -v "${tool}" >/dev/null 2>&1 || { echo "missing required tool: ${tool}" >&2; exit 2; }
done
[[ -n "${NVSTRAPS_RPM_SIGNING_KEY:-}" ]] || fail "NVSTRAPS_RPM_SIGNING_KEY is not set"
[[ -f "${PUBLIC_KEY}" ]] || fail "no such public key: ${PUBLIC_KEY}"

if [[ -n "${2:-}" ]]; then
  rpms=("$2")
else
  shopt -s nullglob
  rpms=("${BUNDLES}"/rpm/*.rpm)
  shopt -u nullglob
  [[ ${#rpms[@]} -eq 1 ]] || fail "expected exactly one .rpm under ${BUNDLES}/rpm, found ${#rpms[@]}"
fi
readonly RPM="${rpms[0]}"
[[ -f "${RPM}" ]] || fail "no such package: ${RPM}"

readonly WORK="$(mktemp -d)"
export GNUPGHOME="${WORK}/gnupg"
mkdir -m 700 "${GNUPGHOME}"
cleanup() {
  gpgconf --kill all >/dev/null 2>&1 || true
  rm -rf "${WORK}"
}
trap cleanup EXIT

# printf is a shell builtin, so the key goes through a pipe and never into a file or a command line.
printf '%s\n' "${NVSTRAPS_RPM_SIGNING_KEY}" | gpg --batch --quiet --import
first_fingerprint() {
  awk -F: '$1 == "fpr" { print $10; exit }'
}
signing="$(gpg --batch --with-colons --list-secret-keys | first_fingerprint)"
published="$(gpg --batch --with-colons --show-keys "${PUBLIC_KEY}" | first_fingerprint)"
[[ -n "${signing}" ]] || fail "NVSTRAPS_RPM_SIGNING_KEY holds no private key"
[[ "${signing}" == "${published}" ]] \
  || fail "the private key is ${signing}, but $(basename "${PUBLIC_KEY}") is ${published}"

rpmsign \
  --define "_gpg_name ${signing}" \
  --define "_gpg_digest_algo sha256" \
  --define "_gpg_sign_cmd_extra_args --batch --pinentry-mode loopback" \
  --addsign "${RPM}"

bash "${SCRIPT_DIR}/check-rpm-signature.sh" "${RPM}" "${PUBLIC_KEY}"
