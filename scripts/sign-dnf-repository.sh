#!/usr/bin/env bash
# Signs the metadata of the dnf repository that scripts/build-dnf-repository.sh built, then
# checks the repository the way dnf does.
#
# The key is the one the .rpm is signed with: NVSTRAPS_RPM_SIGNING_KEY (ASCII-armoured, no
# passphrase), imported into a keyring that exists only for this run. Before anything is signed
# it is compared with the public key the repository hands to users
# (rpm/RPM-GPG-KEY-nvstraps-rebar), so a wrong secret cannot publish a repository that nobody
# can verify.
#
# usage: sign-dnf-repository.sh <site-directory>
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

fail() {
  echo "dnf signing: $*" >&2
  exit 1
}

for tool in gpg gpgconf awk mktemp; do
  command -v "${tool}" >/dev/null 2>&1 || { echo "missing required tool: ${tool}" >&2; exit 2; }
done
readonly SITE="${1:?usage: sign-dnf-repository.sh <site-directory>}"
readonly PUBLIC_KEY="${SITE}/rpm/RPM-GPG-KEY-nvstraps-rebar"
readonly REPOMD="${SITE}/rpm/repodata/repomd.xml"
[[ -n "${NVSTRAPS_RPM_SIGNING_KEY:-}" ]] || fail "NVSTRAPS_RPM_SIGNING_KEY is not set"
[[ -f "${PUBLIC_KEY}" ]] || fail "no such public key: ${PUBLIC_KEY}"
[[ -f "${REPOMD}" ]] || fail "no such metadata file: ${REPOMD}"

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

# dnf looks for the signature of repomd.xml in repomd.xml.asc.
gpg --batch --yes --pinentry-mode loopback --local-user "${signing}" --digest-algo SHA256 \
  --armor --detach-sign --output "${REPOMD}.asc" "${REPOMD}"

bash "${SCRIPT_DIR}/check-dnf-repository.sh" "${SITE}"
