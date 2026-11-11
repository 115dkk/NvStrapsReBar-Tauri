#!/usr/bin/env bash
# Signs the Release file of the apt repository that scripts/build-apt-repository.sh built, then
# checks the repository the way apt does.
#
# The key is the one the .rpm is signed with: NVSTRAPS_RPM_SIGNING_KEY (ASCII-armoured, no
# passphrase), imported into a keyring that exists only for this run. Before anything is signed
# it is compared with the public key the repository hands to users (apt/nvstraps-rebar.asc), so
# a wrong secret cannot publish a repository that nobody can verify.
#
# usage: sign-apt-repository.sh <site-directory>
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SUITE="preview"

fail() {
  echo "apt signing: $*" >&2
  exit 1
}

for tool in gpg gpgconf awk mktemp; do
  command -v "${tool}" >/dev/null 2>&1 || { echo "missing required tool: ${tool}" >&2; exit 2; }
done
readonly SITE="${1:?usage: sign-apt-repository.sh <site-directory>}"
readonly PUBLIC_KEY="${SITE}/apt/nvstraps-rebar.asc"
readonly RELEASE="${SITE}/apt/dists/${SUITE}/Release"
[[ -n "${NVSTRAPS_RPM_SIGNING_KEY:-}" ]] || fail "NVSTRAPS_RPM_SIGNING_KEY is not set"
[[ -f "${PUBLIC_KEY}" ]] || fail "no such public key: ${PUBLIC_KEY}"
[[ -f "${RELEASE}" ]] || fail "no such Release file: ${RELEASE}"

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
  || fail "the private key is ${signing}, but the repository's key is ${published}"

sign() {
  gpg --batch --yes --pinentry-mode loopback --local-user "${signing}" --digest-algo SHA256 "$@"
}
# InRelease is what apt reads; Release.gpg is for older tools that read the two files apart.
sign --clearsign --output "${RELEASE%Release}InRelease" "${RELEASE}"
sign --armor --detach-sign --output "${RELEASE}.gpg" "${RELEASE}"

bash "${SCRIPT_DIR}/check-apt-repository.sh" "${SITE}"
