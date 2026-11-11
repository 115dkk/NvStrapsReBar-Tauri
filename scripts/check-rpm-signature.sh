#!/usr/bin/env bash
# Verifies that an .rpm carries a signature made by the key in a public key file. The key is
# imported into an empty rpm database made for this run, so no other key on this machine can make
# the check pass. An unsigned package fails too: rpm calls it "digests OK", and this asks for a
# signature line.
#
# usage: check-rpm-signature.sh <package.rpm> [public-key-file]
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
readonly RPM="${1:?usage: check-rpm-signature.sh <package.rpm> [public-key-file]}"
readonly PUBLIC_KEY="${2:-${REPO_ROOT}/docs/RPM-GPG-KEY-nvstraps-rebar}"

fail() {
  echo "rpm signature: $*" >&2
  exit 1
}

for tool in rpmkeys grep mktemp; do
  command -v "${tool}" >/dev/null 2>&1 || { echo "missing required tool: ${tool}" >&2; exit 2; }
done
[[ -f "${RPM}" ]] || fail "no such package: ${RPM}"
[[ -f "${PUBLIC_KEY}" ]] || fail "no such public key: ${PUBLIC_KEY}"

readonly WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
rpmkeys --dbpath "${WORK}/rpmdb" --import "${PUBLIC_KEY}"

set +e
report="$(rpmkeys --dbpath "${WORK}/rpmdb" --checksig --verbose "${RPM}" 2>&1)"
status=$?
set -e
echo "${report}"
[[ ${status} -eq 0 ]] || fail "$(basename "${RPM}") does not verify against $(basename "${PUBLIC_KEY}")"
grep -Eiq 'signature.*: OK$' <<<"${report}" || fail "$(basename "${RPM}") is not signed"

echo "rpm signature: $(basename "${RPM}") is signed by the key in $(basename "${PUBLIC_KEY}")"
