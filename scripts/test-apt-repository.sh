#!/usr/bin/env bash
# Proves the apt repository scripts with keys made for this run, on the .deb that
# `npm run build:linux-packages` wrote. Pull request builds run it: they never see the project
# key, and publishing must not be the first place where the repository is built and signed.
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
readonly BUNDLES="${REPO_ROOT}/target/release/bundle"
readonly PROJECT_KEY="${REPO_ROOT}/docs/RPM-GPG-KEY-nvstraps-rebar"

fail() {
  echo "apt repository test: $*" >&2
  exit 1
}

for tool in gpg gpgconf dpkg-deb mktemp; do
  command -v "${tool}" >/dev/null 2>&1 || { echo "missing required tool: ${tool}" >&2; exit 2; }
done

shopt -s nullglob
debs=("${BUNDLES}"/deb/*.deb)
shopt -u nullglob
[[ ${#debs[@]} -eq 1 ]] || fail "expected exactly one .deb under ${BUNDLES}/deb, found ${#debs[@]}"
readonly DEB="${debs[0]}"
readonly VERSION="$(dpkg-deb --field "${DEB}" Version)"

readonly WORK="$(mktemp -d)"
cleanup() {
  for home in "${WORK}/signer" "${WORK}/stranger"; do
    gpgconf --homedir "${home}" --kill all >/dev/null 2>&1 || true
  done
  rm -rf "${WORK}"
}
trap cleanup EXIT

# Makes a signing key of the kind the project key is, and writes its public half beside it.
new_key() {
  mkdir -m 700 "$1"
  gpg --homedir "$1" --batch --quiet --pinentry-mode loopback --passphrase '' \
    --quick-generate-key "$2" rsa4096 sign never
  gpg --homedir "$1" --batch --armor --export >"$1/public.asc"
}
new_key "${WORK}/signer" "Signer made for one test run"
new_key "${WORK}/stranger" "Stranger made for one test run"
readonly SIGNER="${WORK}/signer/public.asc"
readonly STRANGER="${WORK}/stranger/public.asc"
signer_key="$(gpg --homedir "${WORK}/signer" --batch --armor --export-secret-keys)"
stranger_key="$(gpg --homedir "${WORK}/stranger" --batch --armor --export-secret-keys)"

readonly SITE="${WORK}/site"
readonly INDEX="${SITE}/apt/dists/preview/main/binary-amd64"
build() {
  rm -rf "${SITE}"
  bash "${SCRIPT_DIR}/build-apt-repository.sh" "${SITE}" "${SIGNER}" "${DEB}" >/dev/null
}
sign() {
  NVSTRAPS_RPM_SIGNING_KEY="$1" bash "${SCRIPT_DIR}/sign-apt-repository.sh" "${SITE}"
}
check() {
  bash "${SCRIPT_DIR}/check-apt-repository.sh" "${SITE}" "$@"
}
refused() {
  local what="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    fail "${what} was accepted"
  fi
  echo "apt repository test: ${what} is refused"
}

build
refused "an unsigned repository" check
refused "a private key that is not the repository's" sign "${stranger_key}"
refused "a missing private key" sign ""
[[ ! -e "${SITE}/apt/dists/preview/InRelease" ]] || fail "a refused signing left a signature behind"

accepted="$(sign "${signer_key}")"
[[ "${accepted}" == *"would install nvstraps-rebar ${VERSION}" ]] \
  || fail "the signed repository does not offer ${VERSION}: ${accepted}"
refused "a repository checked with a key other than its own" check "${STRANGER}"
refused "a repository checked with the project's key" check "${PROJECT_KEY}"

# A package list changed after signing no longer matches the signed Release file.
echo >>"${INDEX}/Packages"
gzip --best --no-name --force --keep "${INDEX}/Packages"
refused "a package list changed after signing" check

echo "apt repository test: apt accepts the repository with its own key only and would install ${VERSION}"
