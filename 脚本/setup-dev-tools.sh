#!/usr/bin/env bash
# 一键初始化开发机：换国内源 → 建免密 sudo 用户 → 装开发工具（bun 官方脚本走 GitHub Releases，其余全程国内镜像）
#
#   bash setup-dev-tools.sh
#   curl -fsSL https://raw.githubusercontent.com/ukjent7/whl/refs/heads/main/%E8%84%9A%E6%9C%AC/setup-dev-tools.sh | bash
#
# 支持：Debian 13+、Ubuntu 24.04+、Fedora 41+（dnf5）；Debian/Ubuntu 衍生版尽力而为
# 工具：uv ruff kaggle colab zig(官方tarball) · rust(minimal+rustfmt/clippy) · bun · go yq · jq rg fd gh shellcheck gawk wl-clipboard 等
# 配置：只看下面几个常量，要改直接编辑。可重复运行。

if [[ ! -f $0 ]]; then  # curl | bash：先落盘，后面要以 root / 新用户身份重新执行自己
  self=$(mktemp /tmp/setup-dev-tools.XXXXXX) && cat >"$self" && exec bash "$self" "$@"
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
  debian) FAMILY=deb MIN=13 ;;
  ubuntu) FAMILY=deb MIN=24 ;;
  fedora) FAMILY=rpm MIN=41 ;;
  *) [[ " ${ID_LIKE:-} " == *" debian "* || " ${ID_LIKE:-} " == *" ubuntu "* ]] \
       || die "不支持 ${PRETTY_NAME:-$ID}（仅 Debian / Ubuntu / Fedora）"
     FAMILY=deb MIN=0; warn "${PRETTY_NAME:-$ID} 是衍生版，跳过版本检查" ;;
esac
# Debian 12 / Ubuntu 22.04 的 Go < 1.21，不能自动拉新工具链；Fedora 40- 还是 dnf4
[[ -z ${VERSION_ID:-} ]] || ((${VERSION_ID%%.*} >= MIN)) || die "${PRETTY_NAME:-$ID} 太旧，需要 $ID $MIN+"

# ═══════════════ 阶段 1（root）：换系统源、建用户 ═══════════════

switch_apt() {  # 改写 → apt update 验证 → 失败换下一个镜像 → 全失败则还原
  local scheme=https hosts re m f files=()
  # 最小化系统没有 CA 证书时用 http（apt 靠 GPG 签名校验，http 也不会被篡改）
  [[ -s /etc/ssl/certs/ca-certificates.crt ]] || scheme=http
  hosts='deb\.debian\.org|security\.debian\.org|ftp[.a-z0-9]*\.debian\.org|[.a-z0-9]*archive\.ubuntu\.com|security\.ubuntu\.com|ports\.ubuntu\.com'
  for m in "${MIRRORS[@]}"; do hosts+="|${m//./\\.}"; done
  # 主仓库和 security 一起换（USTC 的 security 同步延迟通常几小时；路径 debian-security / ubuntu）
  re="https?://($hosts)/(debian-security|debian|ubuntu|ubuntu-ports)(/|[[:space:]]|\$)"

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

switch_dnf() {  # dnf5 覆写文件：F41–F45 通用（F45 的 .repo 已挪到 /usr/share/dnf5/repos.d），回滚只需删文件
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
    switch_apt
    apt-get install -y sudo ca-certificates
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
  grep -qs '>>> setup-dev-tools' ~/.bashrc || cat >>~/.bashrc <<EOF

# >>> setup-dev-tools >>>
export PATH="\$HOME/.local/bin:\$HOME/.cargo/bin:\$HOME/.bun/bin:\$HOME/go/bin:\$PATH"
export RUSTUP_DIST_SERVER=$USTC/rust-static
export RUSTUP_UPDATE_ROOT=$USTC/rust-static/rustup
# <<< setup-dev-tools <<<
EOF
}

user_packages() {
  local p pkgs=(curl ca-certificates git unzip zip jq ripgrep fd-find gh gawk wl-clipboard lsof file patch rsync)
  if [[ $FAMILY == deb ]]; then
    pkgs+=(build-essential golang-go shellcheck procps iproute2 iputils-ping bind9-dnsutils openssh-client xz-utils)
  else
    pkgs+=(gcc golang ShellCheck procps-ng iproute iputils bind-utils openssh-clients yq zig uv ruff xz)
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

install_zig() {  # 官方分发：ziglang.org/download/index.json 自带版本号与每个 tarball 的 sha256
  local idx rel ver arch t sha got dir
  idx=$(curl -fsSL https://ziglang.org/download/index.json)
  rel=$(jq -r 'to_entries | map(select(.key != "master")) | .[0].key' <<<"$idx")
  ver=$(jq -r --arg r "$rel" '.[$r].version' <<<"$idx")
  case $(uname -m) in
    x86_64) arch=x86_64-linux ;; aarch64|arm64) arch=aarch64-linux ;;
    *) warn "zig 不支持 $(uname -m)"; return 1 ;;
  esac
  t=$(jq -r --arg r "$rel" --arg a "$arch" '.[$r][$a].tarball' <<<"$idx")
  sha=$(jq -r --arg r "$rel" --arg a "$arch" '.[$r][$a].shasum' <<<"$idx")
  log "安装 zig $ver (官方 tarball)"
  curl -fsSL "$t" -o /tmp/zig.tar.xz || return 1
  got=$(sha256sum /tmp/zig.tar.xz | awk '{print $1}')
  if [[ $got != "$sha" ]]; then warn "zig 官方 tarball 校验和不匹配"; rm -f /tmp/zig.tar.xz; return 1; fi
  mkdir -p ~/.local/opt
  tar -xJf /tmp/zig.tar.xz -C ~/.local/opt || { warn "zig 解压失败"; rm -f /tmp/zig.tar.xz; return 1; }
  dir=$(basename "${t%.tar.xz}")
  ln -sfn "$HOME/.local/opt/$dir/zig" ~/.local/bin/zig || { warn "zig 软链失败"; return 1; }
  rm -f /tmp/zig.tar.xz
}

user_tools() {
  if ! have uv; then
    log "安装 uv"
    curl -fsSL "$USTC/github-release/astral-sh/uv/LatestRelease/uv-installer.sh" |
      env UV_DOWNLOAD_URL="$USTC/github-release/astral-sh/uv/LatestRelease" UV_NO_MODIFY_PATH=1 sh
  fi
  # rpm 分支的 uv/ruff/zig 已由 dnf 装；deb 系源里没有，走 uv/PyPI 官方渠道
  have ruff  || { log "安装 ruff";  uv tool install --upgrade ruff; }
  have colab || { log "安装 colab";  uv tool install --upgrade google-colab-cli; }
  have kaggle || { log "安装 kaggle"; uv tool install --upgrade kaggle --with six; }  # kaggle 2.2.5 import six 却没声明依赖
  have zig || install_zig || warn "zig 未装上，报告里会显示未找到"

  have bun || { log "安装 bun"; install_bun || warn "bun 安装失败（需访问 GitHub Releases），可稍后手动执行 curl -fsSL https://bun.sh/install | bash"; }

  if ! have rustup; then
    log "安装 Rust"
    curl -fsSL "$USTC/misc/rustup-install.sh" | sh -s -- -y --no-modify-path --profile minimal
  fi
  rustup component add rustfmt clippy

  have go || { warn "没有 go，跳过 GOPROXY 和 yq"; return 0; }
  # 只改官方默认值，不覆盖用户自己的 GOPROXY
  [[ $(go env GOPROXY) != https://proxy.golang.org,direct ]] || go env -w GOPROXY="$GOPROXY_URL"
  # Debian/Ubuntu 源的 yq 是 kislyuk 的 Python 包装版（不是 mikefarah）；Fedora 源的就是原生 Go 版
  # USTC github-release 没有镜像 yq，go install 是 yq 官方 README 列明的安装方式；全脚本统一跟 latest
  # 注意：yq 新版 go.mod 要求 Go 1.26，Debian 13 自带 Go 1.24；GOTOOLCHAIN=auto 会经 goproxy.cn 拉新工具链编译（跟 latest 的代价）
  if [[ $(yq --version 2>&1) != *mikefarah* ]]; then
    log "安装 yq (mikefarah) @latest"
    GOTOOLCHAIN=auto GOBIN=~/.local/bin go install "github.com/mikefarah/yq/v4@latest"
  fi
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
