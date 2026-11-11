#!/usr/bin/env bash
# Builds the apt repository that GitHub Pages serves, from the .deb packages named.
#
#   <site>/index.html                                      how to add the repository
#   <site>/apt/nvstraps-rebar.asc                          the public key users install
#   <site>/apt/pool/main/*.deb
#   <site>/apt/dists/preview/main/binary-amd64/Packages    and Packages.gz
#   <site>/apt/dists/preview/Release
#
# The Release file is not signed here; scripts/sign-apt-repository.sh does that. The repository
# is built from nothing each time, so what it offers is exactly the packages named.
#
# usage: build-apt-repository.sh <site-directory> <public-key-file> <package.deb>...
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly USAGE="usage: build-apt-repository.sh <site-directory> <public-key-file> <package.deb>..."
readonly SUITE="preview"

fail() {
  echo "apt repository: $*" >&2
  exit 1
}

for tool in apt-ftparchive dpkg-deb gzip; do
  command -v "${tool}" >/dev/null 2>&1 || { echo "missing required tool: ${tool}" >&2; exit 2; }
done
[[ $# -ge 3 ]] || fail "${USAGE}"
readonly SITE="$1"
readonly PUBLIC_KEY="$2"
shift 2
[[ -f "${PUBLIC_KEY}" ]] || fail "no such public key: ${PUBLIC_KEY}"
[[ ! -e "${SITE}" ]] || fail "${SITE} already exists; the repository is built from nothing"

readonly APT="${SITE}/apt"
readonly INDEX="dists/${SUITE}/main/binary-amd64"
mkdir -p "${APT}/pool/main" "${APT}/${INDEX}"
for deb in "$@"; do
  [[ -f "${deb}" ]] || fail "no such package: ${deb}"
  [[ "$(dpkg-deb --field "${deb}" Package)" == "nvstraps-rebar" ]] \
    || fail "$(basename "${deb}") is not an nvstraps-rebar package"
  [[ "$(dpkg-deb --field "${deb}" Architecture)" == "amd64" ]] \
    || fail "$(basename "${deb}") is not an amd64 package"
  [[ ! -e "${APT}/pool/main/$(basename "${deb}")" ]] || fail "$(basename "${deb}") was named twice"
  cp "${deb}" "${APT}/pool/main/"
done
cp "${PUBLIC_KEY}" "${APT}/nvstraps-rebar.asc"
cp "${SCRIPT_DIR}/apt-site/index.html" "${SITE}/index.html"

# apt-ftparchive writes the paths it is given into the index, so it runs in the repository root.
cd "${APT}"
apt-ftparchive --arch amd64 packages pool/main >"${INDEX}/Packages"
gzip --best --no-name --keep "${INDEX}/Packages"
apt-ftparchive \
  -o "APT::FTPArchive::Release::Origin=NvStrapsReBar" \
  -o "APT::FTPArchive::Release::Label=NvStrapsReBar Linux preview" \
  -o "APT::FTPArchive::Release::Suite=${SUITE}" \
  -o "APT::FTPArchive::Release::Codename=${SUITE}" \
  -o "APT::FTPArchive::Release::Architectures=amd64" \
  -o "APT::FTPArchive::Release::Components=main" \
  release "dists/${SUITE}" >Release.new
mv Release.new "dists/${SUITE}/Release"

echo "apt repository: $# package(s) in ${APT}"
grep -E '^(Package|Version):' "${INDEX}/Packages" | paste -d ' ' - -
