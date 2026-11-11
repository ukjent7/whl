#!/usr/bin/env bash
# 一键初始化（Debian 系 / Fedora）：换国内源 → 创建免密 sudo 用户 → 安装开发工具
#
#   bash setup-dev-tools.sh        或        curl -fsSL https://raw.githubusercontent.com/ukjent7/whl/refs/heads/main/%E8%84%9A%E6%9C%AC/setup-dev-tools.sh | bash
#
# 工具：uv jq yq go ripgrep fd gh kaggle colab ruff shellcheck gawk wl-clipboard
#       rust(minimal + rustfmt/clippy) bun zig，以及 lsof/ps/ss/ping/dig/file/patch/rsync/ssh/zip 等基础工具
# 流程：阶段 1（root）换系统源、建用户、配免密 sudo → 阶段 2（新用户）配语言源、装工具
# 配置：不读环境变量，所有选项都是下面的常量，要改直接编辑。

# curl | bash 时脚本来自管道：先落盘，后面才能重新执行自己
if [[ ! -f $0 ]]; then
  [[ -p /dev/stdin ]] || { echo "[x] 不支持的运行方式，请用 bash setup-dev-tools.sh 或 curl ... | bash" >&2; exit 1; }
  self=$(mktemp /tmp/setup-dev-tools.XXXXXX) && cat >"$self" && exec bash "$self" "$@"
  exit 1
fi
set -euo pipefail

NEW_USER=kk
MIRROR=mirrors.lzu.edu.cn                    # apt / dnf（兰州大学）
PYPI_MIRROR=mirrors.ustc.edu.cn              # uv / pip（中科大）
RUST_MIRROR=mirrors.ustc.edu.cn              # rustup / crates.io（兰大没有，用中科大）
GOPROXY_URL=https://goproxy.cn,direct        # Go 模块代理
NPM_REGISTRY=https://registry.npmmirror.com  # bun install 的 npm 源

log()    { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn()   { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die()    { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }
have()   { command -v "$1" >/dev/null; }
backup() { [[ -e $1.bak.cn ]] || cp -a "$1" "$1.bak.cn"; }          # 只备份一次，重跑时不会把改过的当原件
ensure() { if have "$1"; then log "$1 已存在，跳过"; else log "安装 $1"; eval "$2"; fi; }  # ensure 命令 '安装命令'

[[ -r /etc/os-release ]] || die "找不到 /etc/os-release，无法识别发行版"
# shellcheck disable=SC1091
. /etc/os-release
case " ${ID:-} ${ID_LIKE:-} " in
  *" debian "*|*" ubuntu "*) FAMILY=debian; ADMIN_GROUP=sudo;  PKG=(apt-get install -y) ;;
  *" fedora "*)              FAMILY=fedora; ADMIN_GROUP=wheel; PKG=(dnf install -y) ;;
  *) die "不支持的发行版：${PRETTY_NAME:-unknown}（仅支持 Debian 系 / Fedora）" ;;
esac
pkg() { sudo env DEBIAN_FRONTEND=noninteractive "${PKG[@]}" "$@"; }

# ═════════════════════ 阶段 1：root —— 换系统源、建用户 ═════════════════════

mirror_debian() {  # $1 = http | https；可重复执行（也会把已换成镜像的 http 升级为 https）
  local m=${MIRROR//./\\.} f
  local host="deb\.debian\.org|ftp[a-z.]*\.debian\.org|[a-z.]*archive\.ubuntu\.com|ports\.ubuntu\.com|$m"
  for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.{list,sources}; do
    [[ -f $f ]] || continue
    grep -qE "https?://($host)/" "$f" || continue
    backup "$f"
    # 只换主仓库；debian-security / security.ubuntu.com 保持官方源（镜像同步有延迟）
    sed -Ei "s#https?://($host)/(debian|ubuntu|ubuntu-ports)/?([[:space:]]|\$)#$1://$MIRROR/\2/\3#g" "$f"
    log "$f -> $1://$MIRROR"
  done
}

mirror_fedora() {  # 依据 https://mirror.lzu.edu.cn/help/fedora/：F43 及更旧改 repo 文件，F44+ 用 dnf config-manager 覆盖
  local base="https://$MIRROR/fedora" ver=${VERSION_ID%%.*} old=0 f kv
  local repos=(/etc/yum.repos.d/fedora{,-updates}.repo)
  local opts=("fedora.baseurl=$base/releases/\$releasever/Everything/\$basearch/os/"
              "updates.baseurl=$base/updates/\$releasever/Everything/\$basearch/"
              fedora.metalink= fedora.mirrorlist= updates.metalink= updates.mirrorlist=)
  [[ $ver =~ ^[0-9]+$ ]] && ((ver <= 43)) && old=1

  for f in "${repos[@]}"; do
    if [[ ! -f $f ]]; then warn "未找到 $f，跳过"; continue; fi
    backup "$f"
    # 有 metalink/mirrorlist 时 dnf 会忽略 baseurl，所以先注释掉
    sed -Ei 's/^[[:space:]]*(metalink|mirrorlist)[[:space:]]*=/#&/' "$f"
    if ((old)); then sed -i "s|^#baseurl=http://download.example/pub/fedora/linux|baseurl=$base|" "$f"; fi
  done
  if ((! old)); then
    for kv in "${opts[@]}"; do dnf config-manager setopt "$kv"; done
  fi

  # 换完立刻校验；镜像不可用（没同步完、缺 repodata…）就回滚到官方源，别把 dnf 留在坏状态
  if dnf makecache --refresh; then
    log "dnf 源 -> $base"
    return 0
  fi
  warn "镜像 $MIRROR 上的 Fedora $ver 元数据不可用，回滚到官方源（之后可换个 MIRROR 再运行）"
  for f in "${repos[@]}"; do
    if [[ -f $f.bak.cn ]]; then cp -a "$f.bak.cn" "$f"; fi
  done
  if ((! old)); then
    for kv in "${opts[@]}"; do dnf config-manager unsetopt "${kv%%=*}" || true; done
  fi
}

stage_root() {
  if ((EUID != 0)); then
    have sudo || die "当前不是 root 且没有 sudo，请先切换到 root 再运行"
    log "需要 root 权限，使用 sudo 重新执行"
    exec sudo bash "$0" "$@"
  fi
  log "检测到 ${PRETTY_NAME:-$ID}（$FAMILY）"

  # 1) 换系统源，并确保 sudo 可用（最小化系统/容器里常常没有）
  if [[ $FAMILY == debian ]]; then
    export DEBIAN_FRONTEND=noninteractive
    local scheme=https
    dpkg -s ca-certificates &>/dev/null || scheme=http   # 没证书时 HTTPS 源拉不下来：先 http，装好再升级
    mirror_debian "$scheme"
    apt-get update
    apt-get install -y ca-certificates sudo
    [[ $scheme == https ]] || mirror_debian https
  else
    mirror_fedora
    dnf install -y sudo
  fi

  # 2) 创建用户，写入免密 sudo
  id "$NEW_USER" &>/dev/null || { log "创建用户 $NEW_USER"; useradd -m -s /bin/bash "$NEW_USER"; }
  usermod -aG "$ADMIN_GROUP" "$NEW_USER"
  local f=/etc/sudoers.d/90-$NEW_USER
  # 先写成 .tmp（sudo 会忽略名字带 . 的文件），校验通过再改名，避免写坏 sudoers 把自己锁在外面
  echo "$NEW_USER ALL=(ALL) NOPASSWD: ALL" | install -m 0440 /dev/stdin "$f.tmp"
  visudo -cf "$f.tmp" >/dev/null || { rm -f "$f.tmp"; die "sudoers 语法校验失败，已中止"; }
  mv "$f.tmp" "$f"
  log "已写入 $f"

  # 3) 以新用户身份执行阶段 2（拷一份到 /tmp，新用户才读得到）
  tmp=$(mktemp /tmp/setup-dev-tools.XXXXXX)
  trap 'rm -f "$tmp"' EXIT
  install -m 0755 "$0" "$tmp"
  log "切换到 $NEW_USER 继续安装工具"
  runuser -l "$NEW_USER" -c "bash $tmp --user"

  echo
  log "全部完成。切换到新用户：su - $NEW_USER"
  warn "$NEW_USER 没有登录密码，只能从 root 切换；需要密码登录请执行：passwd $NEW_USER"
  warn "需要 SSH 登录请把公钥放进 /home/$NEW_USER/.ssh/authorized_keys"
}

# ═════════════════════ 阶段 2：新用户 —— 语言源与开发工具 ═════════════════════

write_once() {  # write_once 路径 <<EOF …EOF；文件已存在则不覆盖
  if [[ -e $1 ]]; then
    warn "$1 已存在，不覆盖"
  else
    mkdir -p "$(dirname "$1")"
    cat >"$1"
    log "已写入 $1"
  fi
}

user_mirrors() {
  local pypi="https://$PYPI_MIRROR/pypi/web/simple"

  write_once ~/.config/uv/uv.toml <<EOF
[[index]]
url = "$pypi"
default = true
EOF
  write_once ~/.config/pip/pip.conf <<EOF
[global]
index-url = $pypi
EOF
  write_once ~/.bunfig.toml <<EOF
[install]
registry = "$NPM_REGISTRY"
EOF
  write_once ~/.cargo/config.toml <<EOF
[source.crates-io]
replace-with = "mirror"

[source.mirror]
registry = "sparse+https://$RUST_MIRROR/crates.io-index/"
EOF

  # rustup：本次安装用 + 持久化到 ~/.bashrc（rustup update 也走镜像）
  export RUSTUP_DIST_SERVER=https://$RUST_MIRROR/rust-static
  export RUSTUP_UPDATE_ROOT=$RUSTUP_DIST_SERVER/rustup
  grep -qs 'cn-mirror rustup' ~/.bashrc || cat >>~/.bashrc <<EOF

# cn-mirror rustup
export RUSTUP_DIST_SERVER=$RUSTUP_DIST_SERVER
export RUSTUP_UPDATE_ROOT=$RUSTUP_UPDATE_ROOT
EOF
}

# Debian 仓库里没有、或版本不合适的几样：fd 软链、gh 官方源、mikefarah/yq
debian_extras() {
  local key=/etc/apt/keyrings/githubcli-archive-keyring.gpg arch
  arch=$(dpkg --print-architecture)

  if ! have fd && have fdfind; then   # Debian 里 fd 的可执行文件叫 fdfind
    ln -sf "$(command -v fdfind)" ~/.local/bin/fd
  fi

  if ! have gh; then                  # 发行版仓库版本偏旧，用官方 apt 源（国内访问可能较慢）
    log "添加 GitHub CLI 官方 apt 源"
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo install -Dm644 /dev/stdin "$key"
    echo "deb [arch=$arch signed-by=$key] https://cli.github.com/packages stable main" \
      | sudo install -Dm644 /dev/stdin /etc/apt/sources.list.d/github-cli.list
    sudo apt-get update
    pkg gh
  fi

  # apt 里的 yq 是另一个同名项目（python 包装 jq），改装 mikefarah/yq 官方二进制
  if ! { have yq && [[ $(yq --version 2>&1) == *mikefarah* ]]; }; then
    log "下载 yq (mikefarah)"
    curl -fsSL "https://github.com/mikefarah/yq/releases/latest/download/yq_linux_${arch/armhf/arm}" -o ~/.local/bin/yq
    chmod +x ~/.local/bin/yq
  fi
}

user_packages() {
  local pkgs p
  if [[ $FAMILY == debian ]]; then
    # build-essential：rust 链接要 cc；gawk 会取代 mawk 成为默认 awk
    pkgs=(curl ca-certificates git build-essential unzip jq ripgrep fd-find golang-go
          lsof procps iproute2 iputils-ping dnsutils file patch rsync openssh-client zip
          shellcheck gawk wl-clipboard)
  else
    # Fedora 的 yq 就是 mikefarah/yq，gh 也在官方仓库里
    pkgs=(curl ca-certificates git gcc unzip jq yq golang ripgrep fd-find gh
          lsof procps-ng iproute iputils bind-utils file patch rsync openssh-clients zip
          ShellCheck gawk wl-clipboard)
  fi
  log "安装系统包"
  pkg "${pkgs[@]}" || {   # 某个包名在当前发行版不存在时，逐个重试，只跳过有问题的
    warn "批量安装失败，改为逐个安装"
    for p in "${pkgs[@]}"; do pkg "$p" || warn "跳过 $p（当前发行版仓库里可能没有）"; done
  }
  if [[ $FAMILY == debian ]]; then debian_extras; fi
}

user_go() {
  have go || { warn "未找到 go，跳过 GOPROXY 配置"; return 0; }
  if [[ $(go env GOPROXY) == "https://proxy.golang.org,direct" ]]; then   # 只改官方默认值，不覆盖用户自己的设置
    go env -w "GOPROXY=$GOPROXY_URL"
    log "已设置 GOPROXY=$GOPROXY_URL"
  else
    warn "GOPROXY 已被自定义为 $(go env GOPROXY)，不覆盖"
  fi
}

install_zig() {  # 优先包管理器；没有就退回 PyPI 的 ziglang 包（经 uv）
  pkg zig 2>/dev/null && return
  warn "包管理器装不上 zig，改用 PyPI 的 ziglang"
  uv tool install --upgrade ziglang
  ln -sf "$(command -v python-zig)" ~/.local/bin/zig   # ziglang 提供的命令叫 python-zig
}

user_tools() {
  ensure uv  'curl -LsSf https://astral.sh/uv/install.sh | sh'
  ensure bun 'curl -fsSL https://bun.com/install | bash'
  ensure zig install_zig

  for t in kaggle google-colab-cli ruff; do   # 隔离安装，走 uv.toml 里的 PyPI 镜像
    log "安装 $t"
    uv tool install --upgrade "$t"
  done

  # Rust：minimal profile，再补 rustfmt / clippy；已装则更新
  have rustup || curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain stable
  rustup set profile minimal
  rustup update stable
  rustup component add rustfmt clippy
}

user_report() {
  local spec t flag v
  echo
  log "安装结果："
  for spec in uv jq yq "go version" rg fd gh kaggle "colab version" ruff shellcheck bun "zig version" \
              rustc cargo rustfmt cargo-clippy gawk wl-copy "lsof -v" ss "dig -v" rsync; do
    read -r t flag <<<"$spec"
    if have "$t"; then
      # shellcheck disable=SC2086
      v=$("$t" ${flag:---version} 2>&1 | grep -m1 -E '[0-9]+\.[0-9]+' || true)
      printf '  \033[32m✔\033[0m %-15s %s\n' "$t" "${v:-已安装}"
    else
      printf '  \033[31m✘\033[0m %-15s 未找到\n' "$t"
    fi
  done
  cat <<EOF

后续手动步骤（以 $(id -un) 身份）：
  gh auth login
  kaggle：在 kaggle.com 账号设置里创建 API token，按官方说明配置
  colab：首次使用按其提示完成 Google 账号认证
EOF
}

stage_user() {
  ((EUID != 0)) || die "阶段 2 必须以普通用户运行（uv / rust 都是用户级安装）"
  have sudo || die "需要 sudo"
  mkdir -p ~/.local/bin
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$HOME/.bun/bin:$HOME/go/bin:$PATH"

  user_mirrors
  user_packages
  user_go
  user_tools
  user_report
}

if [[ ${1:-} == --user ]]; then stage_user; else stage_root "$@"; fi
