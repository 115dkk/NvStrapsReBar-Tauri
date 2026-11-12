#!/usr/bin/env bash
# Proves the dnf repository scripts with keys made for this run, on copies of the .rpm that
# `npm run build:linux-packages` wrote. Pull request builds run it: they never see the project
# key, and publishing must not be the first place where the repository is built and signed.
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
readonly BUNDLES="${REPO_ROOT}/target/release/bundle"
readonly PROJECT_KEY="${REPO_ROOT}/docs/RPM-GPG-KEY-nvstraps-rebar"

fail() {
  echo "dnf repository test: $*" >&2
  exit 1
}

for tool in gpg gpgconf rpm mktemp; do
  command -v "${tool}" >/dev/null 2>&1 || { echo "missing required tool: ${tool}" >&2; exit 2; }
done

shopt -s nullglob
rpms=("${BUNDLES}"/rpm/*.rpm)
shopt -u nullglob
[[ ${#rpms[@]} -eq 1 ]] || fail "expected exactly one .rpm under ${BUNDLES}/rpm, found ${#rpms[@]}"

readonly WORK="$(mktemp -d)"
cleanup() {
  for home in "${WORK}/signer" "${WORK}/stranger"; do
    gpgconf --homedir "${home}" --kill all >/dev/null 2>&1 || true
  done
  rm -rf "${WORK}"
}
trap cleanup EXIT
readonly NAME="$(basename "${rpms[0]}")"
readonly VERSION="$(rpm --dbpath "${WORK}/rpmdb" --query --package --nosignature --queryformat '%{VERSION}' "${rpms[0]}")"

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

# The package three times: as it was built, signed by the repository's key, and signed by a key
# that is not the repository's.
mkdir "${WORK}/unsigned" "${WORK}/signed" "${WORK}/foreign"
readonly UNSIGNED="${WORK}/unsigned/${NAME}"
readonly SIGNED="${WORK}/signed/${NAME}"
readonly FOREIGN="${WORK}/foreign/${NAME}"
cp "${rpms[0]}" "${UNSIGNED}"
cp "${rpms[0]}" "${SIGNED}"
cp "${rpms[0]}" "${FOREIGN}"
NVSTRAPS_RPM_SIGNING_KEY="${signer_key}" bash "${SCRIPT_DIR}/sign-linux-rpm.sh" "${SIGNER}" "${SIGNED}" >/dev/null
NVSTRAPS_RPM_SIGNING_KEY="${stranger_key}" bash "${SCRIPT_DIR}/sign-linux-rpm.sh" "${STRANGER}" "${FOREIGN}" >/dev/null

readonly SITE="${WORK}/site"
readonly REPOMD="${SITE}/rpm/repodata/repomd.xml"
build() {
  rm -rf "${SITE}"
  bash "${SCRIPT_DIR}/build-dnf-repository.sh" "${SITE}" "${SIGNER}" "$@"
}
sign() {
  NVSTRAPS_RPM_SIGNING_KEY="$1" bash "${SCRIPT_DIR}/sign-dnf-repository.sh" "${SITE}"
}
check() {
  bash "${SCRIPT_DIR}/check-dnf-repository.sh" "${SITE}" "$@"
}
refused() {
  local what="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    fail "${what} was accepted"
  fi
  echo "dnf repository test: ${what} is refused"
}

refused "a repository of unsigned packages only" build "${UNSIGNED}"
refused "a package signed with a key that is not the repository's" build "${SIGNED}" "${FOREIGN}"

built="$(build "${UNSIGNED}" "${SIGNED}")"
[[ "${built}" == *"${NAME} has no signature and is left out"* && "${built}" == *"1 package(s)"* ]] \
  || fail "the unsigned package was not left out: ${built}"
echo "dnf repository test: an unsigned package is left out beside a signed one"

refused "an unsigned repository" check
refused "a private key that is not the repository's" sign "${stranger_key}"
refused "a missing private key" sign ""
[[ ! -e "${REPOMD}.asc" ]] || fail "a refused signing left a signature behind"

accepted="$(sign "${signer_key}")"
[[ "${accepted}" == *"would install nvstraps-rebar ${VERSION}" ]] \
  || fail "the signed repository does not offer ${VERSION}: ${accepted}"
refused "a repository checked with a key other than its own" check "${STRANGER}"
refused "a repository checked with the project's key" check "${PROJECT_KEY}"

# Metadata changed after signing no longer matches the signature.
echo >>"${REPOMD}"
refused "metadata changed after signing" check

echo "dnf repository test: dnf accepts the repository with its own key only and would install ${VERSION}"
