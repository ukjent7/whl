#!/bin/sh
if ! command -v bash > /dev/null 2>&1; then
  echo "未找到 bash，正在通过 apk 安装 ..."
  if command -v apk > /dev/null 2>&1; then
    apk add --no-cache bash || { echo "错误: 安装 bash 失败，请手动执行 'apk add bash'" >&2; exit 65; }
  else
    echo "错误: 需要 bash，但 bash 和 apk 均不可用。" >&2
    exit 65
  fi
fi
if [ -z "${BASH_VERSION:-}" ]; then
  case "$0" in
    sh|ash|-sh|-ash|/bin/sh|/bin/ash|/dev/*|/proc/*)
      _tmp_script="$(mktemp /tmp/hyservinst.XXXXXXXXXX)" || exit 73
      chmod +x "$_tmp_script"
      if command -v curl > /dev/null 2>&1; then
        curl -q -L -f -o "$_tmp_script" 'https://raw.githubusercontent.com/ukjent7/whl/refs/heads/main/install_server_alpine.sh' || { echo "错误: 重新下载脚本失败。" >&2; exit 65; }
      elif command -v wget > /dev/null 2>&1; then
        wget -q -O "$_tmp_script" 'https://raw.githubusercontent.com/ukjent7/whl/refs/heads/main/install_server_alpine.sh' || { echo "错误: 重新下载脚本失败。" >&2; exit 65; }
      else
        echo "错误: 检测到管道执行，但 curl 和 wget 均不可用，无法重新下载。" >&2
        exit 65
      fi
      exec bash "$_tmp_script" "$@"
      ;;
    *)
      exec bash "$0" "$@"
      ;;
  esac
fi

set -e

SCRIPT_NAME="$(basename "$0")"

EXECUTABLE_INSTALL_PATH="/usr/local/bin/hysteria"
OPENRC_INIT_PATH="/etc/init.d/hysteria-server"
LOGROTATE_CONF_PATH="/etc/logrotate.d/hysteria-server"
CONFIG_DIR="/etc/hysteria"
REPO_URL="https://github.com/apernet/hysteria"
HY2_API_BASE_URL="https://api.hy2.io/v1"

HYSTERIA_USER="root"
HYSTERIA_HOME_DIR="/var/lib/hysteria"
OPERATING_SYSTEM="linux"
ARCHITECTURE=""

CURL_FLAGS=(-q -L -f --retry 5 --retry-delay 10 --retry-max-time 60)

OPERATION=
VERSION=
FORCE=
LOCAL_FILE=

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
  echo -e "$SCRIPT_NAME: $(tbold)注意: $_msg$(treset)"
}

warning() {
  local _msg="$1"
  echo -e "$SCRIPT_NAME: $(tyellow)警告: $_msg$(treset)"
}

error() {
  local _msg="$1"
  echo -e "$SCRIPT_NAME: $(tred)错误: $_msg$(treset)"
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
  echo "请运行 \"$0 --help\" 查看用法。" >&2
  exit 22
}

install_content() {
  local _install_flags="$1"
  local _content="$2"
  local _destination="$3"
  local _overwrite="$4"

  local _tmpfile="$(mktemp)"

  echo -ne "安装 $_destination ... "
  echo "$_content" > "$_tmpfile"
  if [[ -z "$_overwrite" && -e "$_destination" ]]; then
    echo -e "已存在"
  elif install "$_install_flags" "$_tmpfile" "$_destination"; then
    echo -e "完成"
  else
    echo -e "失败"
    rm -f "$_tmpfile"
    error "安装 '$_destination' 失败。"
    exit 74
  fi

  rm -f "$_tmpfile"
}

remove_file() {
  local _target="$1"
  echo -ne "移除 $_target ... "
  if rm -f "$_target"; then
    echo -e "完成"
  fi
}

check_permission() {
  if [[ "$(id -u)" -ne 0 ]]; then
    error "此脚本必须以 root 运行，请使用 sudo 或以 root 用户执行。"
    exit 13
  fi
}

check_environment_operating_system() {
  if ! [[ -f /etc/alpine-release ]]; then
    warning "此脚本专为 Alpine Linux 编写，未找到 /etc/alpine-release，仍将继续执行。"
  fi

  if [[ "$(uname)" != "Linux" ]]; then
    error "此脚本仅支持 Linux。"
    exit 95
  fi
  OPERATING_SYSTEM="linux"
}

check_environment_architecture() {
  case "$(uname -m)" in
    'amd64' | 'x86_64')
      ARCHITECTURE='amd64'
      ;;
    'armv8' | 'aarch64')
      ARCHITECTURE='arm64'
      ;;
    *)
      error "架构 '$(uname -m)' 不受支持（仅支持 amd64/arm64）。"
      exit 8
      ;;
  esac
}

check_environment_openrc() {
  if ! has_command rc-service || ! has_command rc-update; then
    error "未找到 rc-service / rc-update，此脚本需要 OpenRC（Alpine 默认初始化系统）。"
    exit 95
  fi
}

check_environment_curl() {
  if has_command curl; then
    return
  fi

  if has_command apk; then
    echo "正在通过 apk 安装缺失的依赖 'curl' ... "
    if apk add --no-cache curl; then
      echo "完成"
      return
    fi
  fi

  error "需要 curl 但未找到，且无法自动安装。请手动执行 'apk add curl'。"
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

show_usage_and_exit() {
  echo
  echo -e "\t$(tbold)$SCRIPT_NAME$(treset) - Hysteria 服务端安装脚本 (Alpine/OpenRC) [仅限 ROOT]"
  echo
  echo -e "用法:"
  echo
  echo -e "$(tbold)安装 hysteria$(treset)"
  echo -e "\t$0 [ -f | -l <文件> | --version <版本> ]"
  echo -e "参数:"
  echo -e "\t-f, --force\t强制重新安装，即使已是最新版本。"
  echo -e "\t-l, --local <文件>\t安装指定的本地 hysteria 二进制文件。"
  echo -e "\t--version <版本>\t安装指定版本而非最新版。"
  echo
  echo -e "$(tbold)卸载 hysteria$(treset)"
  echo -e "\t$0 --remove"
  echo
  echo -e "$(tbold)检查更新$(treset)"
  echo -e "\t$0 -c"
  echo -e "\t$0 --check"
  echo
  echo -e "$(tbold)显示帮助$(treset)"
  echo -e "\t$0 -h"
  echo -e "\t$0 --help"
  echo
  echo -e "$(tbold)说明$(treset)"
  echo -e "\t- 必须以 root 运行。"
  echo -e "\t- 服务以 root 身份运行，无需额外权限配置。"
  echo -e "\t- 仅支持单实例。"
  echo -e "\t- --remove 不会删除 $CONFIG_DIR，请手动移除。"
  exit 0
}

parse_arguments() {
  while [[ "$#" -gt '0' ]]; do
    case "$1" in
      '--remove')
        if [[ -n "$OPERATION" && "$OPERATION" != 'remove' ]]; then
          show_argument_error_and_exit "选项 '--remove' 与其他选项冲突。"
        fi
        OPERATION='remove'
        ;;
      '--version')
        VERSION="$2"
        if [[ -z "$VERSION" ]]; then
          show_argument_error_and_exit "请为 '--version' 指定版本号。"
        fi
        shift
        if ! has_prefix "$VERSION" 'v'; then
          show_argument_error_and_exit "版本号应以 'v' 开头（如 'v2.0.0'），当前为 '$VERSION'"
        fi
        ;;
      '-c' | '--check')
        if [[ -n "$OPERATION" && "$OPERATION" != 'check_update' ]]; then
          show_argument_error_and_exit "选项 '-c' 或 '--check' 与其他选项冲突。"
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
          show_argument_error_and_exit "请为 '-l' 或 '--local' 指定本地二进制文件路径。"
        fi
        break
        ;;
      *)
        show_argument_error_and_exit "未知选项 '$1'"
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
        show_argument_error_and_exit '--version 和 --local 不能同时使用。'
      fi
      ;;
    *)
      if [[ -n "$VERSION" ]]; then
        show_argument_error_and_exit "--version 仅用于安装操作。"
      fi
      if [[ -n "$LOCAL_FILE" ]]; then
        show_argument_error_and_exit "--local 仅用于安装操作。"
      fi
      ;;
  esac
}


tpl_hysteria_server_openrc() {
  cat << EOF
#!/sbin/openrc-run

name="hysteria-server"
description="Hysteria 2 Server"

supervisor="supervise-daemon"

command="$EXECUTABLE_INSTALL_PATH"
command_args="server --config ${CONFIG_DIR}/config.yaml"
command_user="root:root"

supervise_daemon_args="--env HYSTERIA_LOG_LEVEL=info"
export HYSTERIA_LOG_LEVEL=info

respawn_delay=1
respawn_max=10
respawn_period=60

pidfile="/run/\${RC_SVCNAME}.pid"
output_log="/var/log/\${RC_SVCNAME}.log"
error_log="/var/log/\${RC_SVCNAME}.err"

directory="$HYSTERIA_HOME_DIR"

depend() {
        use net
        after firewall
}

start_pre() {
        mkdir -p "$HYSTERIA_HOME_DIR" 2>/dev/null || true
        chmod 0750 "$HYSTERIA_HOME_DIR" 2>/dev/null || true

        checkpath -f -m 0640 -o "root:root" "\${output_log}" 2>/dev/null \\
                || { : > "\${output_log}"; chown root:root "\${output_log}" 2>/dev/null; chmod 0640 "\${output_log}" 2>/dev/null; }

        checkpath -f -m 0640 -o "root:root" "\${error_log}" 2>/dev/null \\
                || { : > "\${error_log}"; chown root:root "\${error_log}" 2>/dev/null; chmod 0640 "\${error_log}" 2>/dev/null; }

        mkdir -p "\$(dirname "\${pidfile}")" 2>/dev/null || true

        return 0
}
EOF
}

tpl_hysteria_logrotate() {
  cat << EOF
/var/log/hysteria-server.log /var/log/hysteria-server.err {
    weekly
    rotate 4
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
EOF
}

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


get_running_status() {
  rc-service hysteria-server status > /dev/null 2>&1
}

stop_running_service() {
  if get_running_status; then
    echo -ne "正在停止 hysteria-server ... "
    if rc-service hysteria-server stop; then
      echo "完成"
    else
      echo "警告"
      warning "停止 hysteria-server 时返回非零值，将继续执行并单独验证实际状态。"
    fi
  fi
}

start_stopped_service() {
  echo -ne "正在启动 hysteria-server ... "
  if rc-service hysteria-server start; then
    echo "完成"
  else
    echo "失败"
    warning "启动 hysteria-server 失败，请检查 'rc-service hysteria-server status' 及 /var/log/hysteria-server.* 日志。"
  fi
}


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
    error "从 Hysteria 2 API 获取最新版本失败，请检查网络后重试。"
    exit 11
  fi

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
  echo "正在下载 hysteria 二进制文件: $_download_url ..."
  if ! curl -R -H 'Cache-Control: no-cache' "$_download_url" -o "$_destination"; then
    error "下载失败，请检查网络后重试。"
    return 11
  fi
  return 0
}

check_update() {
  echo -ne "检查已安装版本 ... "
  local _installed_version="$(get_installed_version)"
  if [[ -n "$_installed_version" ]]; then
    echo "$_installed_version"
  else
    echo "未安装"
  fi

  echo -ne "检查最新版本 ... "
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


perform_install_hysteria_binary() {
  if [[ -n "$LOCAL_FILE" ]]; then
    note "执行本地安装: $LOCAL_FILE"

    echo -ne "正在安装 hysteria 可执行文件 ... "

    if install -Dm755 "$LOCAL_FILE" "$EXECUTABLE_INSTALL_PATH"; then
      echo "完成"
    else
      exit 2
    fi

    return
  fi

  local _tmpfile=$(mktemp)

  if ! download_hysteria "$VERSION" "$_tmpfile"; then
    rm -f "$_tmpfile"
    exit 11
  fi

  echo -ne "正在安装 hysteria 可执行文件 ... "

  if install -Dm755 "$_tmpfile" "$EXECUTABLE_INSTALL_PATH"; then
    echo "完成"
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
  install_content -Dm755 "$(tpl_hysteria_server_openrc)" "$OPENRC_INIT_PATH" "1"
}

perform_remove_hysteria_openrc() {
  rc-update del hysteria-server default > /dev/null 2>&1 || true
  remove_file "$OPENRC_INIT_PATH"
}

perform_install_hysteria_logrotate() {
  if ! has_command logrotate; then
    if has_command apk; then
      if ! apk add --no-cache logrotate > /dev/null 2>&1; then
        warning "logrotate 安装失败，日志轮转不会生效。可稍后手动执行 'apk add logrotate'。"
      fi
    fi
  fi

  install_content -Dm644 "$(tpl_hysteria_logrotate)" "$LOGROTATE_CONF_PATH" "1"

  if ! rc-update show default 2>/dev/null | grep -q crond; then
    rc-update add crond default > /dev/null 2>&1 || true
    rc-service crond start > /dev/null 2>&1 || true
    note "已自动启用 crond 以支持日志轮转。"
  fi
}

perform_install_hysteria_home() {
  mkdir -p "$HYSTERIA_HOME_DIR"
  chmod 0750 "$HYSTERIA_HOME_DIR"
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
      note "检测到 '--force'，即使已是最新版本也将重新安装。"
    fi
    _is_update_required=1
  fi

  if is_hysteria1_version "$VERSION"; then
    error "此脚本只能安装 Hysteria 2。"
    exit 95
  fi

  _exit_trap_armed=

  arm_exit_trap() {
    _exit_trap_armed=1
    trap '
      if [[ -n "$_exit_trap_armed" ]]; then
        warning "安装步骤在停止 hysteria-server 后失败，正在尝试以原有二进制文件重启服务。"
        start_stopped_service || true
      fi
    ' EXIT
  }

  disarm_exit_trap() {
    _exit_trap_armed=
    trap - EXIT
  }

  if [[ -n "$_is_update_required" ]]; then
    if get_running_status; then
      _was_running=1
    fi

    if [[ -n "$_was_running" ]]; then
      arm_exit_trap

      stop_running_service
    fi

    perform_install_hysteria_binary
  fi

  perform_install_hysteria_example_config
  perform_install_hysteria_home
  perform_install_hysteria_openrc
  perform_install_hysteria_logrotate

  rc-update add hysteria-server default > /dev/null 2>&1 || true

  if [[ -z "$_is_update_required" ]]; then
    disarm_exit_trap
    echo
    echo "$(tgreen)已安装版本为最新，无需操作。$(treset)"
    echo
  elif [[ -n "$_is_fresh_install" ]]; then
    disarm_exit_trap
    echo
    echo -e "$(tbold)恭喜！Hysteria 2 已成功安装。$(treset)"
    echo
    echo -e "接下来:"
    echo
    echo -e "\t+ 查看服务端配置指南: $(tblue)https://hysteria.network/docs/getting-started/Server/$(treset)"
    echo -e "\t+ 编辑配置文件: $(tred)$CONFIG_DIR/config.yaml$(treset)"
    echo -e "\t+ 启动服务: $(tred)rc-service hysteria-server start$(treset)"
    echo -e "\t+ 已设置开机自启 (rc-update add hysteria-server default)"
    echo
  elif [[ -n "$_is_upgrade_from_hysteria1" ]]; then
    disarm_exit_trap
    echo -e "由于$(tred)不兼容$(treset)升级，跳过自动重启服务。"
    echo
    echo -e "$(tbold)Hysteria 已从 v1 成功更新到 $VERSION。$(treset)"
    echo
    echo -e "$(tred)Hysteria 2 使用了全新的协议和配置格式，与 1.x.x 版本不兼容。$(treset)"
    echo
    echo -e "\t+ 请将配置文件迁移为 Hysteria 2 格式: $(tred)$CONFIG_DIR/config.yaml$(treset)"
    echo -e "\t+ 重启服务: $(tred)rc-service hysteria-server restart$(treset)"
  else
    disarm_exit_trap
    if [[ -n "$_was_running" ]]; then
      start_stopped_service
    fi

    echo
    echo -e "$(tbold)Hysteria 已成功更新到 $VERSION。$(treset)"
    echo
    echo -e "查看更新日志: $(tblue)https://github.com/apernet/hysteria/blob/master/CHANGELOG.md$(treset)"
    echo
  fi
}

perform_remove() {
  stop_running_service
  perform_remove_hysteria_openrc
  perform_remove_hysteria_binary
  remove_file "$LOGROTATE_CONF_PATH"

  echo
  echo -e "$(tbold)恭喜！Hysteria 已成功卸载。$(treset)"
  echo
  echo -e "请手动删除配置文件:"
  echo
  echo -e "\t$(tred)rm -rf "$CONFIG_DIR"$(treset)"
  echo
}

perform_check_update() {
  if check_update; then
    echo
    echo -e "$(tbold)发现新版本: $VERSION$(treset)"
    echo
    echo -e "$(tgreen)直接运行本脚本（不带参数）即可下载并安装最新版本。$(treset)"
    echo
  else
    echo
    echo "$(tgreen)已是最新版本。$(treset)"
    echo
  fi
}

main() {
  parse_arguments "$@"

  check_permission
  check_environment

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
      error "未知操作 '$OPERATION'。"
      ;;
  esac
}

main "$@"
