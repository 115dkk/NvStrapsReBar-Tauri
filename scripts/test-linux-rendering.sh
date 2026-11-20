#!/usr/bin/env bash
# Shows which WebKit rendering variable the application sets for each desktop session beside
# NVIDIA's driver (see "Rendering beside NVIDIA's driver" in docs/LINUX.md). The application is
# started once per session under a virtual display, in a private mount namespace where
# /sys/class/drm and /proc/driver hold a stand-in GPU, and the environment of WebKit's web process
# is read: a variable the application sets after it started is not in its own /proc entry.
#
# It shows the choice of variable and that the choice reaches WebKit. It does not show an NVIDIA
# GPU, NVIDIA's driver or anything that is drawn. It needs root for the mount namespace; started
# through sudo, it runs the application as the user who called sudo.
set -euo pipefail

readonly RENDERING_NAMES=(
  WEBKIT_DISABLE_DMABUF_RENDERER
  __NV_DISABLE_EXPLICIT_SYNC
  WEBKIT_DISABLE_COMPOSITING_MODE
  WEBKIT_DMABUF_RENDERER_FORCE_SHM
)

usage_error() {
  echo "linux rendering test: $*" >&2
  exit 2
}

# Runs one application inside the mount namespace made by the outer invocation.
inside_namespace() {
  local tree="$1"
  local version="$2"
  local application="$3"
  local log="$4"
  local app_pid_file="$5"
  local child_pid_file="$6"
  local result="$7"
  local privilege_mode="$8"
  local run_uid="$9"
  local run_gid="${10}"
  local private_root="${11}"
  shift 11
  local -a scenario_environment=("$@")
  local -a privilege=()
  local -a clean_environment
  local wrapper_pid=""
  local app_pid=""
  local child_pid=""
  local entry name
  declare -A found=()

  mount --make-rprivate /
  mount -t tmpfs tmpfs /sys/class
  mkdir -p /sys/class/drm/card0/device /sys/class/drm/drivers

  if [[ "${tree}" == "nvidia" ]]; then
    printf '%s\n' '0x10de' >/sys/class/drm/card0/device/vendor
    printf '%s\n' '1' >/sys/class/drm/card0/device/boot_vga
    mkdir /sys/class/drm/drivers/nvidia
    ln -s ../../../drivers/nvidia /sys/class/drm/card0/device/driver
  else
    printf '%s\n' '0x8086' >/sys/class/drm/card0/device/vendor
    printf '%s\n' '1' >/sys/class/drm/card0/device/boot_vga
    mkdir /sys/class/drm/drivers/i915
    ln -s ../../../drivers/i915 /sys/class/drm/card0/device/driver
  fi

  mount -t tmpfs tmpfs /proc/driver
  if [[ "${tree}" == "nvidia" ]]; then
    mkdir -p /proc/driver/nvidia
    printf 'NVRM version: NVIDIA UNIX x86_64 Kernel Module  %s  Tue Sep  1 00:00:00 UTC 2026\n' \
      "${version}" >/proc/driver/nvidia/version
  fi

  if [[ "${privilege_mode}" == "setpriv" ]]; then
    privilege=(setpriv --reuid "${run_uid}" --regid "${run_gid}" --init-groups --)
  fi
  clean_environment=(
    env -i
    "PATH=${PATH}"
    "HOME=${private_root}/home"
    "XDG_CONFIG_HOME=${private_root}/config"
    "XDG_DATA_HOME=${private_root}/data"
    "XDG_CACHE_HOME=${private_root}/cache"
    "XDG_RUNTIME_DIR=${private_root}/runtime"
  )

  cleanup_application() {
    local attempt
    if [[ -n "${app_pid}" ]] && kill -0 "${app_pid}" 2>/dev/null; then
      kill "${app_pid}" 2>/dev/null || true
      for attempt in {1..50}; do
        kill -0 "${app_pid}" 2>/dev/null || break
        sleep 0.1
      done
      kill -KILL "${app_pid}" 2>/dev/null || true
    fi
    if [[ -n "${wrapper_pid}" ]] && kill -0 "${wrapper_pid}" 2>/dev/null; then
      kill "${wrapper_pid}" 2>/dev/null || true
      for attempt in {1..50}; do
        kill -0 "${wrapper_pid}" 2>/dev/null || break
        sleep 0.1
      done
      kill -KILL "${wrapper_pid}" 2>/dev/null || true
    fi
    if [[ -n "${wrapper_pid}" ]]; then
      wait "${wrapper_pid}" 2>/dev/null || true
    fi
  }
  trap cleanup_application EXIT INT TERM

  # The shell records its PID immediately before exec, identifying the application beneath
  # xvfb-run without depending on the wrapper's implementation.
  "${privilege[@]}" "${clean_environment[@]}" "${scenario_environment[@]}" \
    xvfb-run --auto-servernum bash -c \
      'printf "%s\n" "$$" >"$1"; exec "$2"' bash "${app_pid_file}" "${application}" \
      >"${log}" 2>&1 &
  wrapper_pid=$!

  set +e
  timeout 30 bash -c '
    wrapper_pid=$1
    app_pid_file=$2
    child_pid_file=$3
    while [[ ! -s "${app_pid_file}" ]]; do
      kill -0 "${wrapper_pid}" 2>/dev/null || exit 3
      sleep 0.1
    done
    app_pid="$(<"${app_pid_file}")"
    while kill -0 "${app_pid}" 2>/dev/null; do
      children="$(pgrep -o -P "${app_pid}" -f WebKitWebProcess 2>/dev/null || true)"
      if [[ -n "${children}" ]]; then
        printf "%s\n" "${children}" >"${child_pid_file}"
        exit 0
      fi
      sleep 0.1
    done
    exit 3
  ' bash "${wrapper_pid}" "${app_pid_file}" "${child_pid_file}"
  local wait_status=$?
  set -e

  if [[ -s "${app_pid_file}" ]]; then
    app_pid="$(<"${app_pid_file}")"
  fi
  if [[ ${wait_status} -ne 0 ]]; then
    cat "${log}" >&2
    if [[ ${wait_status} -eq 124 ]]; then
      echo "linux rendering test: WebKitWebProcess did not appear within 30 seconds" >&2
    else
      echo "linux rendering test: the application exited before WebKitWebProcess appeared" >&2
    fi
    return 1
  fi

  child_pid="$(<"${child_pid_file}")"
  while IFS= read -r -d '' entry; do
    for name in "${RENDERING_NAMES[@]}"; do
      if [[ "${entry}" == "${name}="* ]]; then
        found["${name}"]="${entry#*=}"
      fi
    done
  done <"/proc/${child_pid}/environ"

  : >"${result}"
  for name in "${RENDERING_NAMES[@]}"; do
    if [[ -v "found[${name}]" ]]; then
      printf '%s=%s\n' "${name}" "${found[${name}]}" >>"${result}"
    fi
  done

  cleanup_application
  wrapper_pid=""
  app_pid=""
  trap - EXIT INT TERM
}

if [[ "${1:-}" == "--inside-namespace" ]]; then
  shift
  inside_namespace "$@"
  exit
fi

[[ $# -eq 1 ]] || usage_error "usage: bash scripts/test-linux-rendering.sh <path to the application binary>"
readonly APPLICATION="$1"
[[ -x "${APPLICATION}" ]] || usage_error "application binary is not executable: ${APPLICATION}"
[[ "${OSTYPE}" == linux* ]] || usage_error "this test only runs on Linux"
[[ "$(id -u)" -eq 0 ]] || usage_error "this test must run as root; run it with sudo"

for tool in unshare mount xvfb-run pgrep timeout setpriv mktemp; do
  command -v "${tool}" >/dev/null 2>&1 || { echo "missing required tool: ${tool}" >&2; exit 2; }
done

readonly WORK="$(mktemp -d)"
cleanup() {
  rm -rf "${WORK}"
}
trap cleanup EXIT

readonly WAYLAND2_MANIFESTS="${WORK}/wayland2-manifests"
readonly OLD_MANIFESTS="${WORK}/old-manifests"
mkdir -p "${WAYLAND2_MANIFESTS}" "${OLD_MANIFESTS}"
printf '%s\n' '{"file_format_version":"1.0.0","ICD":{"library_path":"libnvidia-egl-wayland2.so.1"}}' \
  >"${WAYLAND2_MANIFESTS}/09_nvidia_wayland2.json"
printf '%s\n' '{"file_format_version":"1.0.0","ICD":{"library_path":"libnvidia-egl-wayland.so.1"}}' \
  >"${WAYLAND2_MANIFESTS}/10_nvidia_wayland.json"
printf '%s\n' '{"file_format_version":"1.0.0","ICD":{"library_path":"libnvidia-egl-wayland.so.1"}}' \
  >"${OLD_MANIFESTS}/10_nvidia_wayland.json"

privilege_mode=direct
run_uid=0
run_gid=0
if [[ -n "${SUDO_UID:-}" && -n "${SUDO_GID:-}" && "${SUDO_UID}" -ne 0 ]]; then
  privilege_mode=setpriv
  run_uid="${SUDO_UID}"
  run_gid="${SUDO_GID}"
fi
readonly privilege_mode run_uid run_gid

failed=0
scenario_number=0
run_scenario() {
  local scenario_name="$1"
  local tree="$2"
  local version="$3"
  local expected="$4"
  shift 4
  local -a scenario_environment=("$@")
  local scenario_root log app_pid_file child_pid_file result actual shown_expected shown_actual
  local status

  scenario_number=$((scenario_number + 1))
  scenario_root="${WORK}/scenario-${scenario_number}"
  log="${scenario_root}/application.log"
  app_pid_file="${scenario_root}/application.pid"
  child_pid_file="${scenario_root}/webkit.pid"
  result="${scenario_root}/rendering-environment"
  mkdir -p "${scenario_root}"/{home,config,data,cache,runtime}
  chmod 700 "${scenario_root}/runtime"
  : >"${log}"
  : >"${app_pid_file}"
  : >"${child_pid_file}"
  : >"${result}"
  if [[ "${privilege_mode}" == "setpriv" ]]; then
    chown -R "${run_uid}:${run_gid}" "${WORK}"
  fi

  set +e
  unshare --mount bash "${BASH_SOURCE[0]}" --inside-namespace \
    "${tree}" "${version}" "${APPLICATION}" "${log}" "${app_pid_file}" \
    "${child_pid_file}" "${result}" "${privilege_mode}" "${run_uid}" "${run_gid}" \
    "${scenario_root}" "${scenario_environment[@]}"
  status=$?
  set -e

  if [[ ${status} -ne 0 ]]; then
    echo "FAILED: ${scenario_name}: application inspection failed" >&2
    failed=$((failed + 1))
    return
  fi

  actual="$(tr '\n' ' ' <"${result}")"
  actual="${actual% }"
  shown_expected="${expected:-no rendering variable}"
  shown_actual="${actual:-no rendering variable}"
  if [[ "${actual}" == "${expected}" ]]; then
    echo "ok: ${scenario_name}: ${shown_actual}"
  else
    echo "FAILED: ${scenario_name}: expected ${shown_expected}, WebKit's web process has ${shown_actual}" >&2
    failed=$((failed + 1))
  fi
}

run_scenario "X11" nvidia 615.71.09 \
  "WEBKIT_DISABLE_DMABUF_RENDERER=1" \
  "XDG_SESSION_TYPE=x11"
run_scenario "Wayland, KDE Plasma" nvidia 615.71.09 \
  "__NV_DISABLE_EXPLICIT_SYNC=1" \
  "XDG_SESSION_TYPE=wayland" "XDG_CURRENT_DESKTOP=KDE" \
  "__EGL_EXTERNAL_PLATFORM_CONFIG_DIRS=${WAYLAND2_MANIFESTS}"
run_scenario "Wayland, Hyprland" nvidia 615.71.09 \
  "WEBKIT_DISABLE_DMABUF_RENDERER=1" \
  "XDG_SESSION_TYPE=wayland" "XDG_CURRENT_DESKTOP=Hyprland" \
  "__EGL_EXTERNAL_PLATFORM_CONFIG_DIRS=${WAYLAND2_MANIFESTS}"
run_scenario "Wayland, GNOME, egl-wayland2" nvidia 615.71.09 \
  "" \
  "XDG_SESSION_TYPE=wayland" "XDG_CURRENT_DESKTOP=ubuntu:GNOME" \
  "__EGL_EXTERNAL_PLATFORM_CONFIG_DIRS=${WAYLAND2_MANIFESTS}"
run_scenario "Wayland, GNOME, driver before 560" nvidia 550.163.01 \
  "__NV_DISABLE_EXPLICIT_SYNC=1" \
  "XDG_SESSION_TYPE=wayland" "XDG_CURRENT_DESKTOP=ubuntu:GNOME" \
  "__EGL_EXTERNAL_PLATFORM_CONFIG_DIRS=${WAYLAND2_MANIFESTS}"
run_scenario "Wayland, GNOME, egl-wayland" nvidia 615.71.09 \
  "__NV_DISABLE_EXPLICIT_SYNC=1" \
  "XDG_SESSION_TYPE=wayland" "XDG_CURRENT_DESKTOP=ubuntu:GNOME" \
  "__EGL_EXTERNAL_PLATFORM_CONFIG_DIRS=${OLD_MANIFESTS}"
run_scenario "another GPU" other "" \
  "" \
  "XDG_SESSION_TYPE=x11"
run_scenario "a variable the user set" nvidia 615.71.09 \
  "WEBKIT_DISABLE_COMPOSITING_MODE=1" \
  "XDG_SESSION_TYPE=x11" "WEBKIT_DISABLE_COMPOSITING_MODE=1"

if [[ ${failed} -ne 0 ]]; then
  echo "linux rendering test: ${failed} of 8 sessions failed" >&2
  exit 1
fi

echo "linux rendering test: 8 sessions gave the expected variable"
