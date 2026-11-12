#!/usr/bin/env bash
# Checks a dnf repository built by scripts/build-dnf-repository.sh the way a user's dnf does: it
# reads the repository's own .repo file, pointed at this directory and at one trusted key, and
# asks which version dnf would install.
#
# dnf runs in an install root made for this run, so its cache, its keys and its package database
# start empty: no key or repository on this machine can make the check pass. The key is the
# repository's own (rpm/RPM-GPG-KEY-nvstraps-rebar) unless another file is named.
#
# usage: check-dnf-repository.sh <site-directory> [public-key-file]
set -euo pipefail

fail() {
  echo "dnf repository check: $*" >&2
  exit 1
}

for tool in dnf sed grep mktemp; do
  command -v "${tool}" >/dev/null 2>&1 || { echo "missing required tool: ${tool}" >&2; exit 2; }
done
readonly SITE="$(cd -- "${1:?usage: check-dnf-repository.sh <site-directory> [public-key-file]}" && pwd)"
readonly RPM_ROOT="${SITE}/rpm"
readonly REPO_FILE="${RPM_ROOT}/nvstraps-rebar.repo"
[[ -f "${RPM_ROOT}/repodata/repomd.xml" ]] || fail "no repository under ${RPM_ROOT}"
[[ -f "${REPO_FILE}" ]] || fail "${RPM_ROOT} has no nvstraps-rebar.repo"
# Without these two settings dnf would take unsigned metadata and unsigned packages.
for setting in gpgcheck=1 repo_gpgcheck=1; do
  grep -qx "${setting}" "${REPO_FILE}" || fail "nvstraps-rebar.repo does not say ${setting}"
done

readonly WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
mkdir -p "${WORK}/repos" "${WORK}/root"
cp "${2:-${RPM_ROOT}/RPM-GPG-KEY-nvstraps-rebar}" "${WORK}/trusted-key"
# The repository as users get it, except for where it is read from and which key is trusted. A
# repository that cannot be verified must be an error here, not one that dnf skips.
sed -e "s|^baseurl=.*|baseurl=file://${RPM_ROOT}|" \
  -e "s|^gpgkey=.*|gpgkey=file://${WORK}/trusted-key|" \
  -e "s|^skip_if_unavailable=.*|skip_if_unavailable=0|" \
  "${REPO_FILE}" >"${WORK}/repos/nvstraps-rebar.repo"

# --assumeyes: dnf asks before it trusts the key of a repository it sees for the first time.
if ! answer="$(dnf --quiet --assumeyes --installroot "${WORK}/root" --releasever 0 \
  --setopt "reposdir=${WORK}/repos" \
  repoquery --available --latest-limit 1 --queryformat '%{version}\n' nvstraps-rebar 2>"${WORK}/report")"; then
  cat "${WORK}/report" >&2
  fail "dnf does not accept the repository with $(basename "${2:-RPM-GPG-KEY-nvstraps-rebar}")"
fi
version="$(grep -m 1 . <<<"${answer}" || true)"
if [[ -z "${version}" ]]; then
  cat "${WORK}/report" >&2
  fail "dnf finds no nvstraps-rebar to install"
fi

echo "dnf repository check: dnf accepts the repository and would install nvstraps-rebar ${version}"
