#!/usr/bin/env bash
# Proves the rpm signing scripts with keys made for this run, on a copy of the .rpm that
# `npm run build:linux-packages` wrote. Pull request builds run it: they never see the project
# key, and the Linux preview must not be the first place where signing is tried on that image.
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
readonly BUNDLES="${REPO_ROOT}/target/release/bundle"
readonly PROJECT_KEY="${REPO_ROOT}/docs/RPM-GPG-KEY-nvstraps-rebar"

fail() {
  echo "rpm signing test: $*" >&2
  exit 1
}

for tool in gpg gpgconf mktemp; do
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
readonly RPM="${WORK}/$(basename "${rpms[0]}")"
cp "${rpms[0]}" "${RPM}"

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
private_key="$(gpg --homedir "${WORK}/signer" --batch --armor --export-secret-keys)"

sign() {
  NVSTRAPS_RPM_SIGNING_KEY="$1" bash "${SCRIPT_DIR}/sign-linux-rpm.sh" "$2" "${RPM}"
}
verify() {
  bash "${SCRIPT_DIR}/check-rpm-signature.sh" "${RPM}" "$1"
}
refused() {
  local what="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    fail "${what} was accepted"
  fi
  echo "rpm signing test: ${what} is refused"
}

refused "an unsigned package" verify "${SIGNER}"
refused "a private key that is not the published one" sign "${private_key}" "${STRANGER}"
refused "a missing private key" sign "" "${SIGNER}"
cmp --silent "${rpms[0]}" "${RPM}" || fail "a refused signing changed the package"

sign "${private_key}" "${SIGNER}"
refused "a signature by a key other than the published one" verify "${STRANGER}"
refused "a signature by a key other than the project's" verify "${PROJECT_KEY}"

echo "rpm signing test: the package is signed and verified with its own key only"
