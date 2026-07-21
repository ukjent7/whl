#!/usr/bin/env bash
#
# install_server_alpine.sh - hysteria server install script for Alpine Linux (OpenRC)
# Try `install_server_alpine.sh --help` for usage.
#
# Adapted from the official hysteria install_server.sh (apernet/hysteria),
# replacing systemd with OpenRC and simplifying architecture detection to
# amd64 / arm64 only, for Alpine Linux.
#
# Known differences from the upstream script:
#   - Single-instance only: this script does NOT provide the upstream's
#     "hysteria-server@<name>.service" template-unit equivalent for running
#     multiple independent instances/configs. Only one instance
#     (config: /etc/hysteria/config.yaml) is managed.
#   - `--remove` does not delete /etc/hysteria or the hysteria system user;
#     it only prints the manual cleanup commands (same policy as upstream).
#
# SPDX-License-Identifier: MIT
#

set -e


###
# SCRIPT CONFIGURATION
###

SCRIPT_NAME="$(basename "$0")"
SCRIPT_ARGS=("$@")

# Path for installing executable
EXECUTABLE_INSTALL_PATH="/usr/local/bin/hysteria"

# OpenRC init script path
OPENRC_INIT_PATH="/etc/init.d/hysteria-server"

# Directory to store hysteria config file
CONFIG_DIR="/etc/hysteria"

# URLs of GitHub
REPO_URL="https://github.com/apernet/hysteria"

# URL of Hysteria 2 API
HY2_API_BASE_URL="https://api.hy2.io/v1"

# curl command line flags.
# To use a proxy, specify ALL_PROXY in the environment, e.g.:
# export ALL_PROXY=socks5h://192.0.2.1:1080
CURL_FLAGS=(-L -f -q --retry 5 --retry-delay 10 --retry-max-time 60)


###
# AUTO DETECTED GLOBAL VARIABLE
###

OPERATING_SYSTEM="${OPERATING_SYSTEM:-}"
ARCHITECTURE="${ARCHITECTURE:-}"
HYSTERIA_USER="${HYSTERIA_USER:-}"
HYSTERIA_HOME_DIR="${HYSTERIA_HOME_DIR:-}"


###
# ARGUMENTS
###

# Supported operation: install, remove, check_update
OPERATION=
VERSION=
FORCE=
LOCAL_FILE=


###
# COMMAND REPLACEMENT & UTILITIES
###

has_command() {
  local _command=$1
  type -P "$_command" > /dev/null 2>&1
}

curl() {
  command curl "${CURL_FLAGS[@]}" "$@"
}

mktemp() {
  command mktemp "$@" "/tmp/hyservinst.XXXXXXXXXX"
}

tput() {
  if has_command tput; then
    command tput "$@"
  fi
}

tred() { tput setaf 1; }
tgreen() { tput setaf 2; }
tyellow() { tput setaf 3; }
tblue() { tput setaf 4; }
tbold() { tput bold; }
treset() { tput sgr0; }

note() {
  local _msg="$1"
  echo -e "$SCRIPT_NAME: $(tbold)note: $_msg$(treset)"
}

warning() {
  local _msg="$1"
  echo -e "$SCRIPT_NAME: $(tyellow)warning: $_msg$(treset)"
}

error() {
  local _msg="$1"
  echo -e "$SCRIPT_NAME: $(tred)error: $_msg$(treset)"
}

has_prefix() {
  local _s="$1"
  local _prefix="$2"

  if [[ -z "$_prefix" ]]; then
    return 0
  fi
  if [[ -z "$_s" ]]; then
    return 1
  fi
  [[ "x$_s" != "x${_s#"$_prefix"}" ]]
}

generate_random_password() {
  dd if=/dev/urandom bs=18 count=1 status=none | base64
}

show_argument_error_and_exit() {
  local _error_msg="$1"
  error "$_error_msg"
  echo "Try \"$0 --help\" for usage." >&2
  exit 22
}

install_content() {
  local _install_flags="$1"
  local _content="$2"
  local _destination="$3"
  local _overwrite="$4"

  local _tmpfile="$(mktemp)"

  echo -ne "Install $_destination ... "
  echo "$_content" > "$_tmpfile"
  if [[ -z "$_overwrite" && -e "$_destination" ]]; then
    echo -e "exists"
  elif install "$_install_flags" "$_tmpfile" "$_destination"; then
    echo -e "ok"
  else
    # NOTE: `install`'s exit status here is only checked as a condition
    # (elif), so `set -e` will NOT auto-exit on failure -- we must fail
    # explicitly ourselves, or a failed config/init-script install would
    # silently be treated as if nothing happened, and the script would go
    # on to report a successful install/update.
    echo -e "failed"
    rm -f "$_tmpfile"
    error "Failed to install '$_destination'."
    exit 74
  fi

  rm -f "$_tmpfile"
}

remove_file() {
  local _target="$1"
  echo -ne "Remove $_target ... "
  if rm -f "$_target"; then
    echo -e "ok"
  fi
}

exec_sudo() {
  local _saved_ifs="$IFS"
  IFS=$'\n'
  local _preserved_env=(
    $(env | grep "^OPERATING_SYSTEM=" || true)
    $(env | grep "^ARCHITECTURE=" || true)
    $(env | grep "^HYSTERIA_\w*=" || true)
    $(env | grep "^FORCE_\w*=" || true)
  )
  IFS="$_saved_ifs"

  exec sudo env \
    "${_preserved_env[@]}" \
    "$@"
}

is_user_exists() {
  local _user="$1"
  id "$_user" > /dev/null 2>&1
}

rerun_with_sudo() {
  if ! has_command sudo; then
    return 13
  fi

  local _target_script

  # We can only safely re-exec "$0" directly if it is a real, readable,
  # regular file right now (a normal `./install_server_alpine.sh` invocation
  # or `bash /path/to/script.sh`).
  #
  # This is NOT safely recoverable for either of:
  #   - `curl ... | bash` / `curl ... | sh`
  #       $0 is literally the string "bash"/"sh" (not a path at all).
  #   - `bash <(curl ...)` (process substitution)
  #       $0 is /dev/fd/NN, but that fd is backed by a *pipe*
  #       (confirmed: `stat /dev/fd/NN` shows `pipe:[...]`), and bash has
  #       already consumed part of that pipe while reading/executing the
  #       script body up to this point. Re-reading "$0" here only returns
  #       whatever is left unread in the pipe (i.e. the *rest* of the
  #       script after this line) -- never the full original source. This
  #       is true regardless of how it may look in ad-hoc testing: bash's
  #       internal read buffering can occasionally make a short script
  #       appear fully recoverable, but that is a buffering coincidence,
  #       not a guarantee, and must not be relied upon.
  #
  # So in both pipe and process-substitution cases, "$0" cannot be used to
  # reliably reconstruct this script. We must not silently do the wrong
  # thing here (e.g. the upstream approach of re-downloading a *different*,
  # systemd-based script from a URL, or naively `sudo bash "$0"` which
  # would just launch an empty shell) -- we reject explicitly instead.
  if [[ -f "$0" && -r "$0" ]]; then
    _target_script="$0"
  else
    error "Cannot safely re-run this script with sudo: it is being executed from a pipe or process substitution (\$0 is '$0'), and this script's own source cannot be reliably recovered from that stream at this point."
    note "Please save the script to a regular file first, then run it directly, e.g.:"
    note "  curl -o install_server_alpine.sh <script-url> && chmod +x install_server_alpine.sh && sudo ./install_server_alpine.sh"
    note "Alternatively, run this script as root directly (e.g. 'curl ... | sudo bash'), or specify FORCE_NO_ROOT=1 to proceed without root (some steps may fail)."
    return 74
  fi

  note "Re-running this script with sudo. You can also specify FORCE_NO_ROOT=1 to force this script to run as the current user."
  exec_sudo "$_target_script" "${SCRIPT_ARGS[@]}"
}

check_permission() {
  if [[ "$(id -u)" -eq '0' ]]; then
    return
  fi

  note "The user running this script is not root."

  case "$FORCE_NO_ROOT" in
    '1')
      warning "FORCE_NO_ROOT=1 detected, we will proceed without root, but you may get insufficient privileges errors."
      ;;
    *)
      if ! rerun_with_sudo; then
        error "Please run this script with root or specify FORCE_NO_ROOT=1 to force this script to run as the current user."
        exit 13
      fi
      ;;
  esac
}

check_environment_operating_system() {
  if [[ -n "$OPERATING_SYSTEM" ]]; then
    warning "OPERATING_SYSTEM=$OPERATING_SYSTEM detected, operating system detection will not be performed."
    return
  fi

  if ! [[ -f /etc/alpine-release ]]; then
    warning "This script is tailored for Alpine Linux; /etc/alpine-release was not found. Continuing anyway."
  fi

  if [[ "x$(uname)" == "xLinux" ]]; then
    OPERATING_SYSTEM=linux
    return
  fi

  error "This script only supports Linux."
  note "Specify OPERATING_SYSTEM=linux to bypass this check."
  exit 95
}

check_environment_architecture() {
  if [[ -n "$ARCHITECTURE" ]]; then
    warning "ARCHITECTURE=$ARCHITECTURE detected, architecture detection will not be performed."
    return
  fi

  case "$(uname -m)" in
    'amd64' | 'x86_64')
      ARCHITECTURE='amd64'
      ;;
    'armv8' | 'aarch64')
      ARCHITECTURE='arm64'
      ;;
    *)
      error "The architecture '$(uname -m)' is not supported by this simplified script (only amd64/arm64)."
      note "Specify ARCHITECTURE=<amd64|arm64> to bypass this check if you know the correct hysteria release asset name for your platform."
      exit 8
      ;;
  esac
}

check_environment_openrc() {
  if has_command rc-service && has_command rc-update; then
    return
  fi

  case "$FORCE_NO_OPENRC" in
    '1')
      warning "FORCE_NO_OPENRC=1, we will proceed but skip all OpenRC related commands."
      ;;
    *)
      error "rc-service / rc-update not found. This script requires OpenRC (Alpine's default init system)."
      note "Specify FORCE_NO_OPENRC=1 to skip all service-management steps and only install the binary + config."
      exit 95
      ;;
  esac
}

check_environment_curl() {
  if has_command curl; then
    return
  fi

  if has_command apk; then
    echo "Installing missing dependency 'curl' with apk ... "
    if apk add --no-cache curl; then
      echo "ok"
      return
    fi
  fi

  error "curl is required but not found, and could not be installed automatically. Please run 'apk add curl' manually."
  exit 65
}

check_environment() {
  check_environment_operating_system
  check_environment_architecture
  check_environment_openrc
  check_environment_curl
}

vercmp_segment() {
  local _lhs="$1"
  local _rhs="$2"

  if [[ "x$_lhs" == "x$_rhs" ]]; then
    echo 0
    return
  fi
  if [[ -z "$_lhs" ]]; then
    echo -1
    return
  fi
  if [[ -z "$_rhs" ]]; then
    echo 1
    return
  fi

  local _lhs_num="${_lhs//[A-Za-z]*/}"
  local _rhs_num="${_rhs//[A-Za-z]*/}"

  if [[ "x$_lhs_num" == "x$_rhs_num" ]]; then
    echo 0
    return
  fi
  if [[ -z "$_lhs_num" ]]; then
    echo -1
    return
  fi
  if [[ -z "$_rhs_num" ]]; then
    echo 1
    return
  fi
  local _numcmp=$(($_lhs_num - $_rhs_num))
  if [[ "$_numcmp" -ne 0 ]]; then
    echo "$_numcmp"
    return
  fi

  local _lhs_suffix="${_lhs#"$_lhs_num"}"
  local _rhs_suffix="${_rhs#"$_rhs_num"}"

  if [[ "x$_lhs_suffix" == "x$_rhs_suffix" ]]; then
    echo 0
    return
  fi
  if [[ -z "$_lhs_suffix" ]]; then
    echo 1
    return
  fi
  if [[ -z "$_rhs_suffix" ]]; then
    echo -1
    return
  fi
  if [[ "$_lhs_suffix" < "$_rhs_suffix" ]]; then
    echo -1
    return
  fi
  echo 1
}

vercmp() {
  local _lhs=${1#v}
  local _rhs=${2#v}

  while [[ -n "$_lhs" && -n "$_rhs" ]]; do
    local _clhs="${_lhs/.*/}"
    local _crhs="${_rhs/.*/}"

    local _segcmp="$(vercmp_segment "$_clhs" "$_crhs")"
    if [[ "$_segcmp" -ne 0 ]]; then
      echo "$_segcmp"
      return
    fi

    _lhs="${_lhs#"$_clhs"}"
    _lhs="${_lhs#.}"
    _rhs="${_rhs#"$_crhs"}"
    _rhs="${_rhs#.}"
  done

  if [[ "x$_lhs" == "x$_rhs" ]]; then
    echo 0
    return
  fi

  if [[ -z "$_lhs" ]]; then
    echo -1
    return
  fi

  if [[ -z "$_rhs" ]]; then
    echo 1
    return
  fi

  return
}

check_hysteria_user() {
  local _default_hysteria_user="$1"

  if [[ -n "$HYSTERIA_USER" ]]; then
    return
  fi

  # File capabilities (setcap) are how we let an unprivileged user bind :443.
  # In containers and some restricted sandboxes they either cannot be set, or
  # setcap appears to succeed but exec of the binary fails with
  # "Operation not permitted". Prefer running as root in those environments
  # (container/sandbox isolation is the security boundary).
  if is_in_container; then
    HYSTERIA_USER="root"
    note "Container environment detected; service will run as root (file capabilities are not reliable in containers)."
    return
  fi

  # Probe only when setcap already exists; if missing we still default to the
  # unprivileged user and let set_hysteria_capabilities try to install libcap
  # later (or warn). A hard root fallback here would force root on every
  # minimal Alpine before libcap is installed.
  if has_command setcap && ! file_capabilities_usable; then
    HYSTERIA_USER="root"
    note "File capabilities are not usable on this system (setcap/exec probe failed); service will run as root so privileged ports still work."
    return
  fi

  if [[ ! -e "$OPENRC_INIT_PATH" ]]; then
    HYSTERIA_USER="$_default_hysteria_user"
    return
  fi

  HYSTERIA_USER="$(grep -o '^command_user=["'"'"']\?\w*' "$OPENRC_INIT_PATH" | tail -1 | cut -d '=' -f 2 | tr -d '"'"'"'' || true)"

  if [[ -z "$HYSTERIA_USER" ]]; then
    HYSTERIA_USER="$_default_hysteria_user"
  fi
}

check_hysteria_homedir() {
  local _default_hysteria_homedir="$1"

  if [[ -n "$HYSTERIA_HOME_DIR" ]]; then
    return
  fi

  # For root (container mode) or non-existent users, use the explicit default
  # path rather than resolving ~ (which for root would be /root).
  if [[ "$HYSTERIA_USER" == "root" ]] || ! is_user_exists "$HYSTERIA_USER"; then
    HYSTERIA_HOME_DIR="$_default_hysteria_homedir"
    return
  fi

  HYSTERIA_HOME_DIR="$(eval echo ~"$HYSTERIA_USER")"
}


###
# ARGUMENTS PARSER
###

show_usage_and_exit() {
  echo
  echo -e "\t$(tbold)$SCRIPT_NAME$(treset) - hysteria server install script (Alpine/OpenRC)"
  echo
  echo -e "Usage:"
  echo
  echo -e "$(tbold)Install hysteria$(treset)"
  echo -e "\t$0 [ -f | -l <file> | --version <version> ]"
  echo -e "Flags:"
  echo -e "\t-f, --force\tForce re-install latest or specified version even if it has been installed."
  echo -e "\t-l, --local <file>\tInstall specified hysteria binary instead of downloading it."
  echo -e "\t--version <version>\tInstall specified version instead of the latest."
  echo
  echo -e "$(tbold)Remove hysteria$(treset)"
  echo -e "\t$0 --remove"
  echo
  echo -e "$(tbold)Check for the update$(treset)"
  echo -e "\t$0 -c"
  echo -e "\t$0 --check"
  echo
  echo -e "$(tbold)Show this help$(treset)"
  echo -e "\t$0 -h"
  echo -e "\t$0 --help"
  echo
  echo -e "$(tbold)Environment overrides$(treset)"
  echo -e "\tFORCE_NO_ROOT=1\tRun without root (may fail on privileged actions)"
  echo -e "\tFORCE_NO_OPENRC=1\tSkip OpenRC service install/management"
  echo -e "\tHYSTERIA_USER, HYSTERIA_HOME_DIR, ARCHITECTURE, OPERATING_SYSTEM"
  echo
  echo -e "$(tbold)Notes$(treset)"
  echo -e "\t- Single instance only (no multi-config template unit, unlike upstream)."
  echo -e "\t- --remove does not delete $CONFIG_DIR or the hysteria user; see the printed cleanup commands."
  exit 0
}

parse_arguments() {
  while [[ "$#" -gt '0' ]]; do
    case "$1" in
      '--remove')
        if [[ -n "$OPERATION" && "$OPERATION" != 'remove' ]]; then
          show_argument_error_and_exit "Option '--remove' is in conflict with other options."
        fi
        OPERATION='remove'
        ;;
      '--version')
        VERSION="$2"
        if [[ -z "$VERSION" ]]; then
          show_argument_error_and_exit "Please specify the version for option '--version'."
        fi
        shift
        if ! has_prefix "$VERSION" 'v'; then
          show_argument_error_and_exit "Version numbers should begin with 'v' (such as 'v2.0.0'), got '$VERSION'"
        fi
        ;;
      '-c' | '--check')
        if [[ -n "$OPERATION" && "$OPERATION" != 'check_update' ]]; then
          show_argument_error_and_exit "Option '-c' or '--check' is in conflict with other options."
        fi
        OPERATION='check_update'
        ;;
      '-f' | '--force')
        FORCE='1'
        ;;
      '-h' | '--help')
        show_usage_and_exit
        ;;
      '-l' | '--local')
        LOCAL_FILE="$2"
        if [[ -z "$LOCAL_FILE" ]]; then
          show_argument_error_and_exit "Please specify the local binary to install for option '-l' or '--local'."
        fi
        break
        ;;
      *)
        show_argument_error_and_exit "Unknown option '$1'"
        ;;
    esac
    shift
  done

  if [[ -z "$OPERATION" ]]; then
    OPERATION='install'
  fi

  case "$OPERATION" in
    'install')
      if [[ -n "$VERSION" && -n "$LOCAL_FILE" ]]; then
        show_argument_error_and_exit '--version and --local cannot be used together.'
      fi
      ;;
    *)
      if [[ -n "$VERSION" ]]; then
        show_argument_error_and_exit "--version is only valid for install operation."
      fi
      if [[ -n "$LOCAL_FILE" ]]; then
        show_argument_error_and_exit "--local is only valid for install operation."
      fi
      ;;
  esac
}


###
# FILE TEMPLATES
###

# /etc/init.d/hysteria-server  (OpenRC)
#
# IMPORTANT: This uses an unquoted heredoc (<<EOF) so $EXECUTABLE_INSTALL_PATH
# etc. expand at install time. That means backticks and $(...) inside the
# template body are command-substituted by *this* bash, not written literally.
# Never put shell examples like `export` in comments here -- bash will run them
# and dump `declare -x ...` lines into the generated OpenRC script (which then
# fails under /bin/sh with "declare: not found").
tpl_hysteria_server_openrc() {
  cat << EOF
#!/sbin/openrc-run

name="hysteria-server"
description="Hysteria 2 Server"

command="$EXECUTABLE_INSTALL_PATH"
command_args="server --config ${CONFIG_DIR}/config.yaml"
command_user="$HYSTERIA_USER:$HYSTERIA_USER"

# Mirrors the upstream systemd unit Environment=HYSTERIA_LOG_LEVEL=info.
# Inject via start-stop-daemon --env so the child process always gets it
# (plain export in this file would only affect the openrc-run shell).
start_stop_daemon_args="--env HYSTERIA_LOG_LEVEL=info"

command_background="yes"
pidfile="/run/\${RC_SVCNAME}.pid"
output_log="/var/log/\${RC_SVCNAME}.log"
error_log="/var/log/\${RC_SVCNAME}.err"

directory="$HYSTERIA_HOME_DIR"

depend() {
	use net
	after firewall
}

start_pre() {
	checkpath -d -m 0750 -o "$HYSTERIA_USER:$HYSTERIA_USER" "$HYSTERIA_HOME_DIR"
	checkpath -f -m 0640 -o "$HYSTERIA_USER:$HYSTERIA_USER" "\${output_log}"
	checkpath -f -m 0640 -o "$HYSTERIA_USER:$HYSTERIA_USER" "\${error_log}"
}
EOF
}

# /etc/hysteria/config.yaml
tpl_etc_hysteria_config_yaml() {
  cat << EOF
# listen: :443

acme:
  domains:
    - your.domain.net
  email: your@email.com

auth:
  type: password
  password: $(generate_random_password)

masquerade:
  type: proxy
  proxy:
    url: https://news.ycombinator.com/
    rewriteHost: true
EOF
}


###
# OPENRC
###

is_openrc_managed() {
  [[ "x$FORCE_NO_OPENRC" != "x1" ]] && has_command rc-service && has_command rc-update
}

get_running_status() {
  if ! is_openrc_managed; then
    return 1
  fi
  rc-service hysteria-server status > /dev/null 2>&1
}

stop_running_service() {
  if ! is_openrc_managed; then
    return
  fi

  if get_running_status; then
    echo -ne "Stopping hysteria-server ... "
    rc-service hysteria-server stop
    echo "done"
  fi
}

start_stopped_service() {
  if ! is_openrc_managed; then
    return
  fi

  echo -ne "Starting hysteria-server ... "
  rc-service hysteria-server start
  echo "done"
}


###
# CONTAINER / CAPABILITY DETECTION
###

# Detect whether we are running inside a container (Docker, Podman, LXC, etc.)
# where file capabilities are often not honored and cause "Operation not permitted".
is_in_container() {
  [[ -f /run/.containerenv ]] && return 0
  [[ -f /.dockerenv ]] && return 0
  [[ -f /run/.dockerenv ]] && return 0
  # systemd-nspawn / some orchestrators
  [[ -f /run/host/container-manager ]] && return 0
  # OpenVZ / Virtuozzo legacy
  [[ -d /proc/vz && ! -d /proc/bc ]] && return 0
  # cgroup v1/v2 path heuristics (best-effort; not exhaustive)
  if [[ -r /proc/1/cgroup ]]; then
    grep -qsE '(/docker|/lxc|/kubepods|/podman|/containerd|/libpod|/garden|/crio)' /proc/1/cgroup 2>/dev/null && return 0
  fi
  # env markers (null-delimited in /proc; tr to newlines for grep)
  if [[ -r /proc/1/environ ]]; then
    tr '\0' '\n' < /proc/1/environ 2>/dev/null | grep -qsE '^(container=|container_uuid=)' && return 0
  fi
  if [[ -r /proc/self/mountinfo ]]; then
    grep -qsE '(/docker|/lxc|/podman|/containers/storage|/libpod)' /proc/self/mountinfo 2>/dev/null && return 0
  fi
  return 1
}

# Probe whether file capabilities can be applied AND the resulting binary still
# executes. On many containers/VPS sandboxes, setcap succeeds but exec fails
# with "Operation not permitted" (exactly the failure mode seen with hysteria).
#
# Returns 0 if usable, 1 otherwise. Does not require the hysteria binary.
file_capabilities_usable() {
  if ! has_command setcap; then
    return 1
  fi

  local _probe _true
  if [[ -x /bin/true ]]; then
    _true=/bin/true
  elif [[ -x /usr/bin/true ]]; then
    _true=/usr/bin/true
  else
    return 1
  fi

  _probe="$(mktemp)"
  # Copy a known-good tiny binary; setcap on the live hysteria path is tested
  # separately after install.
  if ! cp "$_true" "$_probe" 2>/dev/null; then
    rm -f "$_probe"
    return 1
  fi
  chmod 755 "$_probe" 2>/dev/null || true

  if ! setcap 'cap_net_bind_service=ep' "$_probe" 2>/dev/null; then
    rm -f "$_probe"
    return 1
  fi

  if "$_probe" > /dev/null 2>&1; then
    setcap -r "$_probe" 2>/dev/null || true
    rm -f "$_probe"
    return 0
  fi

  setcap -r "$_probe" 2>/dev/null || true
  rm -f "$_probe"
  return 1
}


###
# HYSTERIA & GITHUB API
###

is_hysteria_installed() {
  if [[ -f "$EXECUTABLE_INSTALL_PATH" || -h "$EXECUTABLE_INSTALL_PATH" ]]; then
    return 0
  fi
  return 1
}

is_hysteria1_version() {
  local _version="$1"
  has_prefix "$_version" "v1." || has_prefix "$_version" "v0."
}

get_installed_version() {
  if is_hysteria_installed; then
    if "$EXECUTABLE_INSTALL_PATH" version > /dev/null 2>&1; then
      "$EXECUTABLE_INSTALL_PATH" version | grep '^Version' | grep -o 'v[.0-9]*'
    elif "$EXECUTABLE_INSTALL_PATH" -v > /dev/null 2>&1; then
      "$EXECUTABLE_INSTALL_PATH" -v | cut -d ' ' -f 3
    fi
  fi
}

get_latest_version() {
  if [[ -n "$VERSION" ]]; then
    echo "$VERSION"
    return
  fi

  local _tmpfile=$(mktemp)
  if ! curl -sS "$HY2_API_BASE_URL/update?cver=installscript&plat=${OPERATING_SYSTEM}&arch=${ARCHITECTURE}&chan=release&side=server" -o "$_tmpfile"; then
    error "Failed to get the latest version from Hysteria 2 API, please check your network and try again."
    exit 11
  fi

  # Avoid grep -P (PCRE): Alpine's default busybox grep does not support it,
  # and we don't want to require GNU grep just for this. Use sed instead,
  # which is POSIX and available via busybox on Alpine by default.
  local _latest_version=$(sed -n 's/.*"lver"[[:space:]]*:[[:space:]]*"\(v[^"]*\)".*/\1/p' "$_tmpfile" | head -1)

  if [[ -n "$_latest_version" ]]; then
    echo "$_latest_version"
  fi

  rm -f "$_tmpfile"
}

download_hysteria() {
  local _version="$1"
  local _destination="$2"

  local _download_url="$REPO_URL/releases/download/app/$_version/hysteria-$OPERATING_SYSTEM-$ARCHITECTURE"
  echo "Downloading hysteria binary: $_download_url ..."
  if ! curl -R -H 'Cache-Control: no-cache' "$_download_url" -o "$_destination"; then
    error "Download failed, please check your network and try again."
    return 11
  fi
  return 0
}

check_update() {
  echo -ne "Checking for installed version ... "
  local _installed_version="$(get_installed_version)"
  if [[ -n "$_installed_version" ]]; then
    echo "$_installed_version"
  else
    echo "not installed"
  fi

  echo -ne "Checking for latest version ... "
  local _latest_version="$(get_latest_version)"
  if [[ -n "$_latest_version" ]]; then
    echo "$_latest_version"
    VERSION="$_latest_version"
  else
    echo "failed"
    return 1
  fi

  local _vercmp="$(vercmp "$_installed_version" "$_latest_version")"
  if [[ "$_vercmp" -lt 0 ]]; then
    return 0
  fi

  return 1
}


###
# ENTRY
###

clear_hysteria_capabilities() {
  # Leaving file caps on a binary that cannot exec bricks the install
  # (seen as: -sh: .../hysteria: Operation not permitted).
  if has_command setcap; then
    setcap -r "$EXECUTABLE_INSTALL_PATH" 2>/dev/null || true
  fi
}

set_hysteria_capabilities() {
  # Hysteria runs as an unprivileged user (see HYSTERIA_USER), so it needs
  # explicit capabilities to bind low ports (e.g. :443) and use raw/admin
  # network features, mirroring what the upstream systemd unit grants via
  # CapabilityBoundingSet / AmbientCapabilities.
  #
  # In containers / some sandboxes, file capabilities cause
  # "Operation not permitted" on exec. The service then runs as root (see
  # check_hysteria_user), so caps are unnecessary and must be stripped.

  if [[ "$HYSTERIA_USER" == "root" ]] || is_in_container; then
    note "Skipping file capabilities (user=$HYSTERIA_USER; container/sandbox-safe install)."
    clear_hysteria_capabilities
    return
  fi

  if ! has_command setcap; then
    if has_command apk; then
      echo -ne "Installing 'setcap' (libcap) via apk ... "
      if apk add --no-cache libcap > /dev/null 2>&1; then
        echo "ok"
      else
        echo "failed"
      fi
    fi
  fi

  if ! has_command setcap; then
    warning "'setcap' is not available; hysteria will NOT be able to bind privileged ports (e.g. :443) as user '$HYSTERIA_USER'."
    note "Install the 'libcap' package (apk add libcap) and re-run, or set HYSTERIA_USER=root, or use a port >1024."
    return
  fi

  if ! file_capabilities_usable; then
    warning "File capabilities are not usable on this system; not applying setcap (avoids bricking the binary with Operation not permitted on exec)."
    note "Service user is '$HYSTERIA_USER'. For privileged ports, re-run with HYSTERIA_USER=root or use a port >1024."
    clear_hysteria_capabilities
    return
  fi

  echo -ne "Granting network capabilities to $EXECUTABLE_INSTALL_PATH ... "
  if ! setcap 'cap_net_bind_service,cap_net_admin,cap_net_raw+ep' "$EXECUTABLE_INSTALL_PATH"; then
    echo "failed"
    warning "Failed to set capabilities on $EXECUTABLE_INSTALL_PATH; binding to privileged ports as user '$HYSTERIA_USER' will likely fail."
    return
  fi

  # Defense in depth: even if the probe passed, verify *this* binary still runs.
  # If exec fails, strip caps immediately so the install is not left unusable.
  if ! "$EXECUTABLE_INSTALL_PATH" version > /dev/null 2>&1 && \
     ! "$EXECUTABLE_INSTALL_PATH" -v > /dev/null 2>&1; then
    echo "failed (binary not executable with capabilities)"
    warning "setcap succeeded but '$EXECUTABLE_INSTALL_PATH' cannot be executed (Operation not permitted). Removing capabilities."
    clear_hysteria_capabilities
    note "Re-run with HYSTERIA_USER=root if you need to bind privileged ports without file capabilities."
    return
  fi

  echo "ok"
}

perform_install_hysteria_binary() {
  if [[ -n "$LOCAL_FILE" ]]; then
    note "Performing local install: $LOCAL_FILE"

    echo -ne "Installing hysteria executable ... "

    if install -Dm755 "$LOCAL_FILE" "$EXECUTABLE_INSTALL_PATH"; then
      echo "ok"
    else
      exit 2
    fi

    set_hysteria_capabilities
    return
  fi

  local _tmpfile=$(mktemp)

  if ! download_hysteria "$VERSION" "$_tmpfile"; then
    rm -f "$_tmpfile"
    exit 11
  fi

  echo -ne "Installing hysteria executable ... "

  if install -Dm755 "$_tmpfile" "$EXECUTABLE_INSTALL_PATH"; then
    echo "ok"
    set_hysteria_capabilities
  else
    exit 13
  fi

  rm -f "$_tmpfile"
}

perform_remove_hysteria_binary() {
  remove_file "$EXECUTABLE_INSTALL_PATH"
}

perform_install_hysteria_example_config() {
  install_content -Dm644 "$(tpl_etc_hysteria_config_yaml)" "$CONFIG_DIR/config.yaml" ""
}

perform_install_hysteria_openrc() {
  if ! is_openrc_managed; then
    return
  fi

  install_content -Dm755 "$(tpl_hysteria_server_openrc)" "$OPENRC_INIT_PATH" "1"
}

perform_remove_hysteria_openrc() {
  if ! is_openrc_managed; then
    return
  fi

  rc-update del hysteria-server default > /dev/null 2>&1 || true
  remove_file "$OPENRC_INIT_PATH"
}

perform_install_hysteria_home() {
  if ! is_user_exists "$HYSTERIA_USER"; then
    echo -ne "Creating user $HYSTERIA_USER ... "
    # Alpine (busybox adduser) syntax: -D no password, -H no home create prompt, -h homedir
    adduser -D -H -h "$HYSTERIA_HOME_DIR" -s /sbin/nologin "$HYSTERIA_USER"
    echo "ok"
  fi

  mkdir -p "$HYSTERIA_HOME_DIR"
  chown "$HYSTERIA_USER:$HYSTERIA_USER" "$HYSTERIA_HOME_DIR"
}

perform_install() {
  local _is_fresh_install
  local _is_upgrade_from_hysteria1
  if ! is_hysteria_installed; then
    _is_fresh_install=1
  elif is_hysteria1_version "$(get_installed_version)"; then
    _is_upgrade_from_hysteria1=1
  fi

  local _is_update_required
  local _was_running

  if [[ -n "$LOCAL_FILE" ]] || [[ -n "$VERSION" ]] || check_update; then
    _is_update_required=1
  fi

  if [[ "x$FORCE" == "x1" ]]; then
    if [[ -z "$_is_update_required" ]]; then
      note "Option '--force' detected, re-install even if installed version is the latest."
    fi
    _is_update_required=1
  fi

  if is_hysteria1_version "$VERSION"; then
    error "This script can only install Hysteria 2."
    exit 95
  fi

  if [[ -n "$_is_update_required" ]]; then
    if get_running_status; then
      _was_running=1
    fi

    if [[ -n "$_was_running" ]]; then
      # Safety net: covers everything from stopping the service through to
      # the point where we've decided how/whether to bring it back up
      # (further below), not just the binary install step. If ANY step in
      # between fails (download, install, setcap, writing config/openrc
      # files, ...) while running under `set -e`, this trap fires on the
      # way out of the process and makes sure we don't leave the service
      # stopped without the user noticing. It is only disarmed once we've
      # explicitly decided what should happen to the service (see the
      # `trap - EXIT` calls below, one per outcome branch).
      trap 'warning "Install step failed after stopping hysteria-server; attempting to restart it with the previous binary so the service is not left down."; start_stopped_service || true' EXIT

      stop_running_service
    fi

    perform_install_hysteria_binary
  fi

  perform_install_hysteria_example_config
  perform_install_hysteria_home
  perform_install_hysteria_openrc

  if is_openrc_managed; then
    rc-update add hysteria-server default > /dev/null 2>&1 || true
  fi

  if [[ -z "$_is_update_required" ]]; then
    trap - EXIT
    echo
    echo "$(tgreen)Installed version is up-to-date, there is nothing to do.$(treset)"
    echo
  elif [[ -n "$_is_fresh_install" ]]; then
    trap - EXIT
    echo
    echo -e "$(tbold)Congratulations! Hysteria 2 has been successfully installed on your server.$(treset)"
    echo
    echo -e "What's next?"
    echo
    echo -e "\t+ Check out the quick server config guide at $(tblue)https://hysteria.network/docs/getting-started/Server/$(treset)"
    echo -e "\t+ Edit server config file at $(tred)$CONFIG_DIR/config.yaml$(treset)"
    echo -e "\t+ Start your hysteria server with $(tred)rc-service hysteria-server start$(treset)"
    echo -e "\t+ Hysteria is already set to start on boot (rc-update add hysteria-server default)"
    echo
  elif [[ -n "$_is_upgrade_from_hysteria1" ]]; then
    # Intentionally do NOT restart the service here: Hysteria 2's config
    # format is incompatible with Hysteria 1, so auto-starting with the old
    # config would likely just fail or misbehave. Disarm the safety net
    # without restarting -- leaving the (already-stopped) service stopped
    # is the deliberate, correct outcome for this branch.
    trap - EXIT
    echo -e "Skip automatic service restart due to $(tred)incompatible$(treset) upgrade."
    echo
    echo -e "$(tbold)Hysteria has been successfully updated to $VERSION from Hysteria 1.$(treset)"
    echo
    echo -e "$(tred)Hysteria 2 uses a completely redesigned protocol & config, which is NOT compatible with version 1.x.x.$(treset)"
    echo
    echo -e "\t+ Migrate server config file to Hysteria 2 format at $(tred)$CONFIG_DIR/config.yaml$(treset)"
    echo -e "\t+ Start your hysteria server with $(tred)rc-service hysteria-server restart$(treset)"
  else
    # Reached the end successfully: disarm the safety net and do the real
    # restart ourselves (rather than relying on the trap, which is only a
    # failure-path fallback).
    trap - EXIT
    if [[ -n "$_was_running" ]]; then
      start_stopped_service
    fi

    echo
    echo -e "$(tbold)Hysteria has been successfully updated to $VERSION.$(treset)"
    echo
    echo -e "Check out the latest changelog $(tblue)https://github.com/apernet/hysteria/blob/master/CHANGELOG.md$(treset)"
    echo
  fi
}

perform_remove() {
  stop_running_service
  perform_remove_hysteria_openrc
  perform_remove_hysteria_binary

  echo
  echo -e "$(tbold)Congratulations! Hysteria has been successfully removed from your server.$(treset)"
  echo
  echo -e "You still need to remove configuration files manually with the following commands:"
  echo
  echo -e "\t$(tred)rm -rf "$CONFIG_DIR"$(treset)"
  if [[ "x$HYSTERIA_USER" != "xroot" ]]; then
    echo -e "\t$(tred)deluser "$HYSTERIA_USER"$(treset)"
  fi
  echo
}

perform_check_update() {
  if check_update; then
    echo
    echo -e "$(tbold)Update available: $VERSION$(treset)"
    echo
    echo -e "$(tgreen)You can download and install the latest version by executing this script without any arguments.$(treset)"
    echo
  else
    echo
    echo "$(tgreen)Installed version is up-to-date.$(treset)"
    echo
  fi
}

main() {
  parse_arguments "$@"

  check_permission
  check_environment
  check_hysteria_user "hysteria"
  # Always use /var/lib/hysteria as the service working directory regardless
  # of the run user (root in containers, hysteria user on bare-metal).
  check_hysteria_homedir "/var/lib/hysteria"

  case "$OPERATION" in
    "install")
      perform_install
      ;;
    "remove")
      perform_remove
      ;;
    "check_update")
      perform_check_update
      ;;
    *)
      error "Unknown operation '$OPERATION'."
      ;;
  esac
}

main "$@"

# vim:set ft=bash ts=2 sw=2 sts=2 et:
