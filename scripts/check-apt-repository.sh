#!/usr/bin/env bash
# Checks an apt repository built by scripts/build-apt-repository.sh the way a user's apt does:
# `apt-get update` against it with one trusted key, then the version apt would install.
#
# apt runs with its own lists, cache and key directories made for this run, so no key or source
# on this machine can make the check pass, and nothing on this machine changes. The key is the
# repository's own (apt/nvstraps-rebar.asc) unless another file is named.
#
# usage: check-apt-repository.sh <site-directory> [public-key-file]
set -euo pipefail

readonly SUITE="preview"

fail() {
  echo "apt repository check: $*" >&2
  exit 1
}

for tool in apt-get apt-cache awk mktemp; do
  command -v "${tool}" >/dev/null 2>&1 || { echo "missing required tool: ${tool}" >&2; exit 2; }
done
readonly SITE="$(cd -- "${1:?usage: check-apt-repository.sh <site-directory> [public-key-file]}" && pwd)"
readonly APT="${SITE}/apt"
[[ -f "${APT}/dists/${SUITE}/Release" ]] || fail "no repository under ${APT}"
[[ -f "${SITE}/index.html" ]] || fail "${SITE} has no index.html"

readonly WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
# apt takes an armoured key only from a file whose name ends in .asc.
cp "${2:-${APT}/nvstraps-rebar.asc}" "${WORK}/trusted.asc"
mkdir -p "${WORK}/lists/partial" "${WORK}/cache/archives/partial" "${WORK}/empty"
: >"${WORK}/status"
echo "deb [arch=amd64 signed-by=${WORK}/trusted.asc] file://${APT} ${SUITE} main" >"${WORK}/sources.list"
readonly OPTIONS=(
  -o "Dir::Etc::sourcelist=${WORK}/sources.list"
  -o "Dir::Etc::sourceparts=${WORK}/empty"
  -o "Dir::Etc::trusted=${WORK}/empty/trusted.gpg"
  -o "Dir::Etc::trustedparts=${WORK}/empty"
  -o "Dir::State::lists=${WORK}/lists"
  -o "Dir::State::status=${WORK}/status"
  -o "Dir::Cache=${WORK}/cache"
  -o "Debug::NoLocking=1"
  -o "APT::Architecture=amd64"
)

# A missing or wrong signature is a warning to apt-get unless it is told to fail on any error.
if ! report="$(apt-get "${OPTIONS[@]}" -o "APT::Update::Error-Mode=any" update 2>&1)"; then
  echo "${report}" >&2
  fail "apt does not accept the repository with $(basename "${2:-nvstraps-rebar.asc}")"
fi
candidate="$(apt-cache "${OPTIONS[@]}" policy nvstraps-rebar | awk '$1 == "Candidate:" { print $2 }')"
[[ -n "${candidate}" && "${candidate}" != "(none)" ]] || fail "apt finds no nvstraps-rebar to install"

echo "apt repository check: apt accepts the repository and would install nvstraps-rebar ${candidate}"
