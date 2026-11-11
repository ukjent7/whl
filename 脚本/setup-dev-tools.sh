#!/usr/bin/env bash
# 一键初始化开发机：换国内源 → 建免密 sudo 用户 → 装开发工具（bun 官方脚本走 GitHub Releases，其余全程国内镜像）
#
#   bash setup-dev-tools.sh
#   curl -fsSL https://raw.githubusercontent.com/ukjent7/whl/refs/heads/main/%E8%84%9A%E6%9C%AC/setup-dev-tools.sh | bash
#
# 支持：Ubuntu 26.04+、Fedora 45+（dnf5）；只支持最新发行版，旧系统不保证
# 工具：uv ruff kaggle colab zig(系统包优先/PyPI兜底) · rust(minimal+rustfmt/clippy) · bun · go yq · jq rg fd gh shellcheck gawk wl-clipboard 等
# 配置：只看下面几个常量，要改直接编辑。可重复运行。

if [[ ! -f $0 ]]; then  # curl | bash：先落盘，后面要以 root / 新用户身份重新执行自己
  [[ -t 0 ]] && { echo '[x] 交互式终端请直接运行脚本文件，或用 curl -fsSL <url> | bash' >&2; exit 1; }
  self=$(mktemp /tmp/setup-dev-tools.XXXXXX) || exit 1
  cat >"$self"
  # 哨兵校验：网络断流导致下载半截时拒绝执行，绝不以 root 跑残缺脚本
  grep -qF '# <<< setup-dev-tools EOF <<<' "$self" || { rm -f "$self"; echo '[x] 脚本下载不完整，拒绝执行' >&2; exit 1; }
  exec bash "$self" "$@"
  exit 1
fi
set -euo pipefail

NEW_USER=kk
MIRRORS=(mirrors.ustc.edu.cn)  # apt/dnf 共用；兰大实测不稳定（updates 路径 302 到南大，南大 F45 repodata 坏）
USTC=https://mirrors.ustc.edu.cn                  # PyPI / Python / uv / rustup / crates
GOPROXY_URL=https://goproxy.cn,direct
NPM=https://registry.npmmirror.com

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null; }

# shellcheck disable=SC1091
. /etc/os-release
case $ID in
  ubuntu) FAMILY=deb MIN=26 ;;
  fedora) FAMILY=rpm MIN=45 ;;
  *) die "不支持 ${PRETTY_NAME:-$ID}（仅 Ubuntu 26.04+ / Fedora 45+）" ;;
esac
# 只支持最新发行版：旧系统的包版本/仓库布局不在保障范围
[[ -z ${VERSION_ID:-} ]] || ((${VERSION_ID%%.*} >= MIN)) || die "${PRETTY_NAME:-$ID} 太旧，需要 $ID $MIN+"

# ═══════════════ 阶段 1（root）：换系统源、建用户 ═══════════════

switch_apt() {  # 改写 → apt update 验证 → 失败换下一个镜像 → 全失败则还原
  local scheme=https hosts re m f files=()
  # 最小化系统没有 CA 证书时用 http（apt 靠 GPG 签名校验，http 也不会被篡改）
  [[ -s /etc/ssl/certs/ca-certificates.crt ]] || scheme=http
  hosts='[-.a-z0-9]*archive\.ubuntu\.com|security\.ubuntu\.com|ports\.ubuntu\.com'
  for m in "${MIRRORS[@]}"; do hosts+="|${m//./\\.}"; done
  # 主仓库和 security 一起换（USTC 的 security 同步延迟通常几小时；路径 ubuntu / ubuntu-ports）
  re="https?://($hosts)/(ubuntu|ubuntu-ports)(/|[[:space:]]|\$)"

  for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.{list,sources}; do
    [[ -f $f ]] && grep -qE "$re" "$f" && files+=("$f")
  done
  if ((${#files[@]} == 0)); then warn "没找到官方源地址，apt 源保持不变"; apt-get update; return; fi
  for f in "${files[@]}"; do [[ -e $f.orig ]] || cp -a "$f" "$f.orig"; done  # .orig 会被 apt 静默忽略

  for m in "${MIRRORS[@]}"; do
    for f in "${files[@]}"; do sed -E "s#$re#$scheme://$m/\\2\\3#g" "$f.orig" >"$f"; done
    # 默认情况下拉取失败只报 W: 且返回 0，必须让警告也算失败，才能真正校验镜像
    if apt-get update -o APT::Update::Error-Mode=any; then log "apt 源 -> $scheme://$m"; return; fi
    warn "$m 不可用，尝试下一个"
  done
  warn "所有镜像都不可用，还原官方源"
  for f in "${files[@]}"; do cp -a "$f.orig" "$f"; done
  apt-get update
}

switch_dnf() {  # dnf5 覆写文件：F45+ 的 .repo 在 /usr/share/dnf5/repos.d，回滚只需删文件
  local f=/etc/dnf/repos.override.d/90-cn-mirror.repo m
  mkdir -p "${f%/*}"
  dnf clean all >/dev/null 2>&1 || true  # WSL 镜像自带缓存常引用已轮换的旧 repomd 摘要（zck 404 根源）
  for m in "${MIRRORS[@]}"; do
    cat >"$f" <<EOF
[fedora]
baseurl=https://$m/fedora/releases/\$releasever/Everything/\$basearch/os/
metalink=

[updates]
baseurl=https://$m/fedora/updates/\$releasever/Everything/\$basearch/
metalink=
EOF
    if dnf makecache --refresh --repo=fedora,updates; then log "dnf 源 -> https://$m"; return; fi
    warn "dnf makecache 经 $m 失败（镜像未同步/本地缓存/代理都可能），尝试下一个"
  done
  warn "所有镜像都不可用，还原官方源"
  rm -f "$f"
  dnf clean all >/dev/null 2>&1 || true
}

stage_root() {
  if ((EUID != 0)); then
    have sudo || die "请用 root 运行（当前用户也没有 sudo）"
    exec sudo bash "$0" "$@"
  fi
  log "检测到 ${PRETTY_NAME:-$ID}"

  if [[ $FAMILY == deb ]]; then
    export DEBIAN_FRONTEND=noninteractive
    local had_ca=1
    [[ -s /etc/ssl/certs/ca-certificates.crt ]] || had_ca=0
    switch_apt
    apt-get install -y sudo ca-certificates
    ((had_ca)) || switch_apt  # 装前无证书走了 http，装好后重切回 https
  else
    switch_dnf
    dnf install -y sudo
  fi

  local group=sudo f=/etc/sudoers.d/90-$NEW_USER
  [[ $FAMILY == rpm ]] && group=wheel
  id "$NEW_USER" &>/dev/null || { log "创建用户 $NEW_USER"; useradd -m -s /bin/bash "$NEW_USER"; }
  usermod -aG "$group" "$NEW_USER"
  # 先写 .tmp（sudo 忽略带点的文件名），visudo 校验通过再改名，免得写坏 sudoers
  echo "$NEW_USER ALL=(ALL) NOPASSWD: ALL" | install -m 0440 /dev/stdin "$f.tmp"
  visudo -cf "$f.tmp" >/dev/null || { rm -f "$f.tmp"; die "sudoers 校验失败"; }
  mv "$f.tmp" "$f"

  tmp=$(mktemp /tmp/setup-dev-tools.XXXXXX)  # 全局变量：EXIT trap 触发时函数早已返回
  trap 'rm -f "$tmp"' EXIT
  install -m 0755 "$0" "$tmp"
  [[ $0 == /tmp/setup-dev-tools.* ]] && rm -f "$0"  # 清掉 curl|bash 自举落盘的副本（内容已复制走）
  log "切换到 $NEW_USER 安装工具"
  runuser -l "$NEW_USER" -c "bash $tmp --user"

  log "完成。切换用户：su - $NEW_USER"
  warn "$NEW_USER 没有密码，需要时执行 passwd $NEW_USER；SSH 登录请放公钥到 ~$NEW_USER/.ssh/authorized_keys"
}

# ═══════════════ 阶段 2（新用户）：语言源与开发工具 ═══════════════

write_once() {  # write_once 路径 <<EOF；已存在就不覆盖
  if [[ -e $1 ]]; then warn "$1 已存在，不覆盖"; return; fi
  mkdir -p "${1%/*}" && cat >"$1" && log "写入 $1"
}

user_config() {
  write_once ~/.config/uv/uv.toml <<EOF
python-install-mirror = "$USTC/github-release/astral-sh/python-build-standalone/"

[[index]]
url = "$USTC/pypi/simple"
default = true
EOF
  write_once ~/.config/pip/pip.conf <<EOF
[global]
index-url = $USTC/pypi/simple
EOF
  write_once ~/.cargo/config.toml <<EOF
[source.crates-io]
replace-with = "ustc"

[source.ustc]
registry = "sparse+$USTC/crates.io-index/"

[registries.ustc]
index = "sparse+$USTC/crates.io-index/"
EOF
  write_once ~/.bunfig.toml <<EOF
[install]
registry = "$NPM"
EOF
  # 环境变量块插到 .bashrc 最前面：deb 系 .bashrc 开头的非交互守卫（case $-）会直接 return，
  # 追加到末尾等于没写；插到头部对登录/交互 shell 都生效。临时文件放 $HOME 内建，免 SELinux 标签错位
  if ! grep -qs '>>> setup-dev-tools' ~/.bashrc; then
    {
      cat <<EOF
# >>> setup-dev-tools >>>
export PATH="\$HOME/.local/bin:\$HOME/.cargo/bin:\$HOME/.bun/bin:\$HOME/go/bin:\$PATH"
export RUSTUP_DIST_SERVER=$USTC/rust-static
export RUSTUP_UPDATE_ROOT=$USTC/rust-static/rustup
# <<< setup-dev-tools <<<

EOF
      cat ~/.bashrc 2>/dev/null || true
    } >~/.bashrc.tmp && mv ~/.bashrc.tmp ~/.bashrc && log "写入 ~/.bashrc（头部）"
  fi
}

user_packages() {
  local p pkgs=(curl ca-certificates git unzip zip jq ripgrep fd-find gh gawk wl-clipboard lsof file patch rsync)
  if [[ $FAMILY == deb ]]; then
    # 正常流程阶段 1 已更新过索引；只有直跑 --user 且本地无索引才补。zig 已固定在 Ubuntu 26.04+ universe
    compgen -G '/var/lib/apt/lists/*Packages*' >/dev/null || sudo apt-get update
    pkgs+=(build-essential golang-go zig shellcheck procps iproute2 iputils-ping bind9-dnsutils openssh-client)
  else
    pkgs+=(gcc golang ShellCheck procps-ng iproute iputils bind-utils openssh-clients yq zig uv ruff)
  fi
  log "安装系统包"
  sudo env DEBIAN_FRONTEND=noninteractive "${PKG[@]}" "${pkgs[@]}" || {
    warn "批量安装失败，逐个重试"
    for p in "${pkgs[@]}"; do sudo env DEBIAN_FRONTEND=noninteractive "${PKG[@]}" "$p" || warn "跳过 $p"; done
  }
  if ! have fd && have fdfind; then ln -sf "$(command -v fdfind)" ~/.local/bin/fd; fi  # Debian 系叫 fdfind
}

install_bun() {  # 官方脚本 bun.sh/install；二进制来自 GitHub Releases，是全脚本唯一不走国内镜像的环节
  log "安装 bun (官方脚本)"
  curl -fsSL https://bun.sh/install | BUN_INSTALL="$HOME/.bun" bash -s
}

user_tools() {
  if ! have uv; then
    log "安装 uv"
    curl -fsSL "$USTC/github-release/astral-sh/uv/LatestRelease/uv-installer.sh" |
      env UV_DOWNLOAD_URL="$USTC/github-release/astral-sh/uv/LatestRelease" UV_NO_MODIFY_PATH=1 sh
  fi
  # rpm 与 Ubuntu 26.04+ 的 uv/ruff/zig/yq 由包管理器装（/usr 下不动）；其余走 uv/PyPI 官方渠道（USTC 源）
  # ~/.local 里的用户版每次重跑都 --upgrade（全 latest 策略）
  [[ $(command -v ruff 2>/dev/null) == /usr/* ]]  || { log "安装/更新 ruff";  uv tool install --upgrade ruff; }
  [[ $(command -v colab 2>/dev/null) == /usr/* ]] || { log "安装/更新 colab";  uv tool install --upgrade google-colab-cli; }
  [[ $(command -v kaggle 2>/dev/null) == /usr/* ]] || { log "安装/更新 kaggle"; uv tool install --upgrade kaggle --with six; }  # kaggle 2.2.5 import six 却没声明依赖
  [[ $(command -v zig 2>/dev/null) == /usr/* ]] || { log "安装/更新 zig (PyPI ziglang)"; uv tool install --upgrade ziglang && ln -sf python-zig ~/.local/bin/zig; }  # ziglang 提供的命令叫 python-zig

  have bun || install_bun || warn "bun 安装失败（需访问 GitHub Releases），可稍后手动执行 curl -fsSL https://bun.sh/install | bash"

  if ! have rustup; then
    log "安装 Rust（含 rustfmt/clippy 组件）"
    curl -fsSL "$USTC/misc/rustup-install.sh" | sh -s -- -y --no-modify-path --profile minimal -c rustfmt -c clippy
  else
    rustup show active-toolchain >/dev/null 2>&1 || rustup default stable  # 无 default 时 component add 会报错
    rustup component add rustfmt clippy
  fi

  have go || { warn "没有 go，跳过 GOPROXY 和 yq"; return 0; }
  # 只改官方默认值，不覆盖用户自己的 GOPROXY
  [[ $(go env GOPROXY) != https://proxy.golang.org,direct ]] || go env -w GOPROXY="$GOPROXY_URL"
  # Ubuntu 26.04 / Fedora 45 自带 Go ≥ 1.26，yq @latest 原生编译即可；USTC 无 yq 二进制镜像，
  # go install 是 yq 官方 README 列明的方式。系统包（/usr 下的 mikefarah 版）不动，~/.local 版每次更新
  [[ $(command -v yq 2>/dev/null) == /usr/* && $(yq --version 2>&1) == *mikefarah* ]] || {
    log "安装/更新 yq (mikefarah) @latest"
    GOTOOLCHAIN=auto GOBIN=~/.local/bin go install "github.com/mikefarah/yq/v4@latest"
  }
}

user_report() {
  local c a v
  echo; log "安装结果："
  for c in uv ruff kaggle colab zig rustc cargo bun go yq jq rg fd gh shellcheck gawk wl-copy; do
    if have "$c"; then
      case $c in go|zig|colab) a=version ;; *) a=--version ;; esac
      v=$("$c" "$a" 2>&1 | grep -m1 -oE '[0-9]+\.[0-9]+[.0-9a-z+-]*' || true)
      printf '  \033[32m✔\033[0m %-11s %s\n' "$c" "${v:-已安装}"
    else
      printf '  \033[31m✘\033[0m %-11s 未找到\n' "$c"
    fi
  done
  printf '\n后续：gh auth login；kaggle 在官网生成 API token；colab 首次使用按提示登录 Google\n'
}

stage_user() {
  ((EUID != 0)) || die "阶段 2 要以普通用户运行"
  mkdir -p ~/.local/bin
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$HOME/.bun/bin:$HOME/go/bin:$PATH"
  export RUSTUP_DIST_SERVER=$USTC/rust-static RUSTUP_UPDATE_ROOT=$USTC/rust-static/rustup
  user_config
  user_packages
  user_tools
  user_report
}

if [[ $FAMILY == deb ]]; then PKG=(apt-get install -y); else PKG=(dnf install -y); fi
if [[ ${1:-} == --user ]]; then stage_user; else stage_root "$@"; fi
# <<< setup-dev-tools EOF <<<
