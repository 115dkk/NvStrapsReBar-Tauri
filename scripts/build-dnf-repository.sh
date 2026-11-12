#!/usr/bin/env bash
# Builds the dnf repository that GitHub Pages serves beside the apt one, from the .rpm packages
# named.
#
#   <site>/rpm/nvstraps-rebar.repo               the file users put into /etc/yum.repos.d
#   <site>/rpm/RPM-GPG-KEY-nvstraps-rebar        the public key that file names
#   <site>/rpm/packages/*.rpm
#   <site>/rpm/repodata/repomd.xml               and the metadata it lists
#
# Only packages signed with that key go in: the repository asks dnf to check signatures, so dnf
# would install nothing else from it. A package without any signature is left out and named (the
# 1.1.5 preview was published before packages were signed). A package signed with another key
# stops the build, because a new preview that cannot go in must not pass unnoticed.
#
# repomd.xml is not signed here; scripts/sign-dnf-repository.sh does that. The repository is
# built from nothing each time, so what it offers is exactly the signed packages named.
#
# usage: build-dnf-repository.sh <site-directory> <public-key-file> <package.rpm>...
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly USAGE="usage: build-dnf-repository.sh <site-directory> <public-key-file> <package.rpm>..."

fail() {
  echo "dnf repository: $*" >&2
  exit 1
}

for tool in createrepo_c rpm mktemp; do
  command -v "${tool}" >/dev/null 2>&1 || { echo "missing required tool: ${tool}" >&2; exit 2; }
done
[[ $# -ge 3 ]] || fail "${USAGE}"
readonly SITE="$1"
readonly PUBLIC_KEY="$2"
shift 2
[[ -f "${PUBLIC_KEY}" ]] || fail "no such public key: ${PUBLIC_KEY}"
readonly RPM_ROOT="${SITE}/rpm"
[[ ! -e "${RPM_ROOT}" ]] || fail "${RPM_ROOT} already exists; the repository is built from nothing"

readonly WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
# Reads a package's header without judging its signature, and without this machine's rpm database.
header() {
  rpm --dbpath "${WORK}/rpmdb" --query --package --nosignature --queryformat "$1" "$2"
}
# The four places an rpm keeps a signature; each reads "(none)" when it is empty.
readonly SIGNATURES='%{RSAHEADER:pgpsig}%{DSAHEADER:pgpsig}%{SIGPGP:pgpsig}%{SIGGPG:pgpsig}'

mkdir -p "${RPM_ROOT}/packages"
included=()
for rpm in "$@"; do
  [[ -f "${rpm}" ]] || fail "no such package: ${rpm}"
  name="$(basename "${rpm}")"
  [[ "$(header '%{NAME} %{ARCH}' "${rpm}")" == "nvstraps-rebar x86_64" ]] \
    || fail "${name} is not an x86_64 nvstraps-rebar package"
  [[ ! -e "${RPM_ROOT}/packages/${name}" ]] || fail "${name} was named twice"
  if [[ "$(header "${SIGNATURES}" "${rpm}")" == "(none)(none)(none)(none)" ]]; then
    echo "dnf repository: ${name} has no signature and is left out"
    continue
  fi
  bash "${SCRIPT_DIR}/check-rpm-signature.sh" "${rpm}" "${PUBLIC_KEY}" >"${WORK}/signature-report" 2>&1 || {
    cat "${WORK}/signature-report" >&2
    fail "${name} is signed, but not with the key in $(basename "${PUBLIC_KEY}")"
  }
  cp "${rpm}" "${RPM_ROOT}/packages/"
  included+=("${RPM_ROOT}/packages/${name}")
done
[[ ${#included[@]} -gt 0 ]] || fail "no package named is signed with the key in $(basename "${PUBLIC_KEY}")"

cp "${PUBLIC_KEY}" "${RPM_ROOT}/RPM-GPG-KEY-nvstraps-rebar"
cp "${SCRIPT_DIR}/repository-site/nvstraps-rebar.repo" "${RPM_ROOT}/nvstraps-rebar.repo"
# gzip is the compression every dnf and yum reads. No sqlite copies: dnf does not use them.
createrepo_c --quiet --no-database --general-compress-type gz "${RPM_ROOT}"

echo "dnf repository: ${#included[@]} package(s) in ${RPM_ROOT}"
for rpm in "${included[@]}"; do
  header '%{NAME} %{VERSION}-%{RELEASE}\n' "${rpm}"
done
