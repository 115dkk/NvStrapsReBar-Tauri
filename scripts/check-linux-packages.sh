#!/usr/bin/env bash
# Checks the .deb and .rpm that `npm run build:linux-packages` wrote: what they contain, what they
# depend on, that the packaged root helper is the static build and answers, and that the polkit
# policy names the path the helper is installed to. With --install it also installs the .deb on
# this machine (CI only: it needs sudo and changes the system), starts the helper from its
# installed path and keeps the application running under a virtual display for a few seconds.
#
# Nothing here writes a firmware variable: the helper is only started with an empty input, which
# makes it print its greeting and exit.
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
readonly BUNDLES="${REPO_ROOT}/target/release/bundle"
readonly APPLICATION="/usr/bin/nvstraps-rebar"
readonly HELPER_PATH="/usr/lib/nvstraps-rebar/nvstraps-rebar-helper"
readonly POLICY_PATH="/usr/share/polkit-1/actions/io.github.nvstrapsrebar.helper.policy"
readonly POLICY_SOURCE="${REPO_ROOT}/src-tauri/linux/io.github.nvstrapsrebar.helper.policy"
readonly HELLO='{"hello":{"protocol":1,"privileged":false}}'
readonly ROOT_HELLO='{"hello":{"protocol":1,"privileged":true}}'

install=false
if [[ "${1:-}" == "--install" ]]; then
  install=true
fi

fail() {
  echo "linux packages: $*" >&2
  exit 1
}

for tool in dpkg-deb rpm python3 file grep mktemp; do
  command -v "${tool}" >/dev/null 2>&1 || { echo "missing required tool: ${tool}" >&2; exit 2; }
done

shopt -s nullglob
debs=("${BUNDLES}"/deb/*.deb)
rpms=("${BUNDLES}"/rpm/*.rpm)
shopt -u nullglob
[[ ${#debs[@]} -eq 1 ]] || fail "expected exactly one .deb under ${BUNDLES}/deb, found ${#debs[@]}"
[[ ${#rpms[@]} -eq 1 ]] || fail "expected exactly one .rpm under ${BUNDLES}/rpm, found ${#rpms[@]}"
readonly DEB="${debs[0]}"
readonly RPM="${rpms[0]}"

# The policy is how pkexec recognises the helper, so its path must be the installed path.
python3 - "${POLICY_SOURCE}" "${HELPER_PATH}" <<'PY'
import sys
import xml.etree.ElementTree as ET

policy, helper = sys.argv[1], sys.argv[2]
root = ET.parse(policy).getroot()
actions = root.findall("action")
assert len(actions) == 1, "the policy must define exactly one action"
paths = [a.text for a in actions[0].findall("annotate")
         if a.get("key") == "org.freedesktop.policykit.exec.path"]
assert paths == [helper], f"policy names {paths}, the packages install {helper}"
defaults = {d.tag: d.text for d in actions[0].find("defaults")}
assert defaults == {"allow_any": "no", "allow_inactive": "no", "allow_active": "auth_admin"}, defaults
PY

expected_files=(
  "${APPLICATION}"
  "${HELPER_PATH}"
  "${POLICY_PATH}"
  "/usr/lib/nvstraps-rebar/NvStrapsReBar.ffs"
  "/usr/share/applications/nvstraps-rebar.desktop"
)

# dpkg-deb prints member paths with or without a leading "./"; rpm prints them absolute.
deb_files="$(dpkg-deb --contents "${DEB}" | awk '{print $6}' | sed -E 's#^\.?/?#/#')"
rpm_files="$(rpm --query --list --package "${RPM}")"
for path in "${expected_files[@]}"; do
  grep -Fxq "${path}" <<<"${deb_files}" || fail "$(basename "${DEB}") lacks ${path}"
  grep -Fxq "${path}" <<<"${rpm_files}" || fail "$(basename "${RPM}") lacks ${path}"
done

deb_depends="$(dpkg-deb --field "${DEB}" Depends)"
[[ "$(dpkg-deb --field "${DEB}" Package)" == "nvstraps-rebar" ]] || fail ".deb is not named nvstraps-rebar"
[[ "$(rpm --query --queryformat '%{NAME}' --package "${RPM}")" == "nvstraps-rebar" ]] || fail ".rpm is not named nvstraps-rebar"
grep -Fq "pkexec | policykit-1" <<<"${deb_depends}" || fail ".deb does not depend on pkexec: ${deb_depends}"
grep -Fq "libwebkit2gtk-4.1-0" <<<"${deb_depends}" || fail ".deb does not depend on WebKitGTK: ${deb_depends}"
rpm_requires="$(rpm --query --requires --package "${RPM}")"
grep -Fxq "polkit" <<<"${rpm_requires}" || fail ".rpm does not require polkit: ${rpm_requires}"
# rpm does not own /usr/lib/nvstraps-rebar/external, so removal needs the script that clears it.
rpm --query --scripts --package "${RPM}" | grep -Fq "rmdir /usr/lib/nvstraps-rebar/external /usr/lib/nvstraps-rebar" \
  || fail ".rpm has no post-remove script for its own directories"

# The helper inside each package: static, and it greets when started with no input.
readonly WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
dpkg-deb --extract "${DEB}" "${WORK}/deb"
# rpm2cpio (rpm 4.18 on Ubuntu) exits 1 after writing a complete archive, so its status is not
# used; the files it must have produced are checked below.
(set +o pipefail; cd "${WORK}" && mkdir rpm && cd rpm && rpm2cpio "${RPM}" | cpio --extract --make-directories --quiet)
for unpacked in "${WORK}/deb" "${WORK}/rpm"; do
  helper="${unpacked}${HELPER_PATH}"
  [[ -x "${helper}" ]] || fail "${helper} is not executable"
  file "${helper}" | grep -Eq 'static(ally|-pie) linked' || fail "the packaged helper is not static: $(file "${helper}")"
  greeting="$("${helper}" </dev/null)"
  [[ "${greeting}" == "${HELLO}" || "${greeting}" == "${ROOT_HELLO}" ]] || fail "unexpected helper greeting: ${greeting}"
  cmp --silent "${POLICY_SOURCE}" "${unpacked}${POLICY_PATH}" || fail "the packaged policy differs from the source"
done
cmp --silent "${WORK}/deb${HELPER_PATH}" "${WORK}/rpm${HELPER_PATH}" || fail "the two packages carry different helpers"

echo "linux packages: contents, dependencies, helper and policy are as expected"
echo "  $(basename "${DEB}")  sha256 $(sha256sum "${DEB}" | cut -d ' ' -f 1)"
echo "  $(basename "${RPM}")  sha256 $(sha256sum "${RPM}" | cut -d ' ' -f 1)"

if [[ "${install}" != true ]]; then
  exit 0
fi

for tool in sudo apt-get xvfb-run timeout; do
  command -v "${tool}" >/dev/null 2>&1 || { echo "missing required tool for --install: ${tool}" >&2; exit 2; }
done

sudo apt-get install --yes "${DEB}"
[[ -x "${APPLICATION}" ]] || fail "the application was not installed"
owner_and_mode="$(stat --format '%u %a' "${HELPER_PATH}")"
[[ "${owner_and_mode}" == "0 755" ]] || fail "installed helper is ${owner_and_mode}, expected root and 755"
[[ "$(sudo "${HELPER_PATH}" </dev/null)" == "${ROOT_HELLO}" ]] || fail "the installed helper did not greet as root"
cmp --silent "${POLICY_SOURCE}" "${POLICY_PATH}" || fail "the installed policy differs from the source"

# The window has to come up and stay up; the application only reads this machine.
set +e
xvfb-run --auto-servernum timeout 20 "${APPLICATION}" >"${WORK}/app.log" 2>&1
status=$?
set -e
if [[ ${status} -ne 124 ]]; then
  cat "${WORK}/app.log" >&2
  fail "the installed application exited with status ${status} instead of running until the timeout"
fi
if grep -Fq "panicked" "${WORK}/app.log"; then
  cat "${WORK}/app.log" >&2
  fail "the installed application panicked"
fi

echo "linux packages: the .deb installs, its helper answers as root, and the application stays up"
