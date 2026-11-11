#!/usr/bin/env bash
# 一键初始化：换国内源 → 创建免密 sudo 用户（默认 kk）→ 安装开发工具
# 支持：Debian 系（Debian/Ubuntu/…）与 Fedora
# curl -fsSL https://raw.githubusercontent.com/ukjent7/whl/refs/heads/main/%E8%84%9A%E6%9C%AC/setup-dev-tools.sh | bash
# 工具：uv jq yq go ripgrep fd gh kaggle colab rust(minimal，含 rustfmt/clippy) bun zig
#       ruff shellcheck gawk wl-clipboard，以及 lsof/ps/ss/ping/dig/file/patch/rsync/ssh/zip 等基础工具
#
# 用法（root 或有 sudo 权限的用户均可）：
#   ./setup-dev-tools.sh
#
# 说明：本脚本不支持环境变量，所有配置写死在脚本顶部的常量里，需要改动直接编辑常量：
#   NEW_USER=kk                            要创建的用户名
#   MIRROR_HOST=mirrors.lzu.edu.cn         apt/dnf 镜像站
#   PYPI_MIRROR_HOST=mirrors.ustc.edu.cn   uv/pip 使用的 PyPI 镜像站（中科大）
#   RUST_MIRROR_HOST=mirrors.ustc.edu.cn   rustup/crates.io 镜像站
#   GOPROXY_URL=https://goproxy.cn,direct  Go 模块代理（写入 go env）
#   NPM_REGISTRY=https://registry.npmmirror.com  bun install 使用的 npm 源（写入 ~/.bunfig.toml）
#
# 流程：
#   阶段 1（root）：换 apt/dnf 源 → 安装 sudo → 创建用户 → 写入 NOPASSWD sudoers
#   阶段 2（新用户）：配置 uv/pip/bun/rustup/cargo 国内源 → 安装系统包与用户级工具 → 配置 GOPROXY
if [ ! -f "$0" ] || [ ! -r "$0" ]; then
  if [ -p /dev/stdin ]; then
    _self="$(mktemp /tmp/.setup-dev-tools.XXXXXX)" || exit 1
    cat > "$_self" || exit 1
    exec bash "$_self" "$@"
  fi
  printf '[x] 不支持的运行方式 ($0=%s)。请用: curl -fsSL <url> | bash 或 bash setup-dev-tools.sh\n' "$0" >&2
  exit 1
fi
# ─────────────────────────────────────────────────────────────
set -euo pipefail

# 账号与镜像配置（写死，不支持环境变量覆盖）
NEW_USER=kk
MIRROR_HOST=mirrors.lzu.edu.cn
# LZU 没有镜像 rustup/crates.io，这部分使用中科大
RUST_MIRROR_HOST=mirrors.ustc.edu.cn
# PyPI 镜像使用中科大（uv / pip 共用）
PYPI_MIRROR_HOST=mirrors.ustc.edu.cn
# Go 模块代理与 npm 源（兰州大学没有这两项）
GOPROXY_URL=https://goproxy.cn,direct
NPM_REGISTRY=https://registry.npmmirror.com

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# ---------- 识别发行版（两个阶段共用） ----------
[ -r /etc/os-release ] || die "找不到 /etc/os-release，无法识别发行版。"
# shellcheck disable=SC1091
. /etc/os-release
case " ${ID:-} ${ID_LIKE:-} " in
  *" debian "*|*" ubuntu "*) FAMILY=debian; ADMIN_GROUP=sudo  ;;
  *" fedora "*)              FAMILY=fedora; ADMIN_GROUP=wheel ;;
  *) die "不支持的发行版：${PRETTY_NAME:-unknown}（仅支持 Debian 系 / Fedora）" ;;
esac

# 首次修改前备份，只备份一次（避免重复运行时把已改过的文件当成原件）
backup_once() {
  if [ -e "$1" ] && [ ! -e "$1.bak.cn" ]; then
    cp -a "$1" "$1.bak.cn"
  fi
}

# =====================================================================
# 换源：apt / dnf（阶段 1，root）
# =====================================================================
mirror_debian() {   # $1 = http | https
  local scheme="$1" f
  local files=(/etc/apt/sources.list)
  shopt -s nullglob
  files+=(/etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources)
  shopt -u nullglob
  for f in "${files[@]}"; do
    [ -f "$f" ] || continue
    grep -qE 'deb\.debian\.org|ftp[a-z.]*\.debian\.org|archive\.ubuntu\.com|ports\.ubuntu\.com' "$f" || continue
    backup_once "$f"
    # 只替换主仓库；debian-security / security.ubuntu.com 保持官方源（镜像同步有延迟）
    sed -E -i \
      -e "s#https?://(deb\.debian\.org|ftp[a-z.]*\.debian\.org)/debian(/?)([[:space:]]|\$)#${scheme}://${MIRROR_HOST}/debian\2\3#g" \
      -e "s#https?://([a-z]{2}\.)?archive\.ubuntu\.com/ubuntu(/?)([[:space:]]|\$)#${scheme}://${MIRROR_HOST}/ubuntu\2\3#g" \
      -e "s#https?://ports\.ubuntu\.com/ubuntu-ports(/?)([[:space:]]|\$)#${scheme}://${MIRROR_HOST}/ubuntu-ports\1\2#g" \
      "$f"
    log "已切换 $f -> ${scheme}://${MIRROR_HOST}"
  done
}

mirror_debian_upgrade_https() {
  local f
  for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
    [ -f "$f" ] || continue
    sed -i "s#http://${MIRROR_HOST}/#https://${MIRROR_HOST}/#g" "$f"
  done
}

mirror_fedora() {
  # 依据 https://mirror.lzu.edu.cn/help/fedora/ ：
  #   Fedora 43 及更旧：直接改 /etc/yum.repos.d 下的 repo 文件
  #   Fedora 44 及更新：用 dnf config-manager setopt 写覆盖配置
  local fver="${VERSION_ID%%.*}"
  if [[ "$fver" =~ ^[0-9]+$ ]] && [ "$fver" -le 43 ]; then
    local f
    for f in /etc/yum.repos.d/fedora.repo /etc/yum.repos.d/fedora-updates.repo; do
      if [ -f "$f" ]; then
        backup_once "$f"
        sed -e 's|^metalink=|#metalink=|g' \
            -e "s|^#baseurl=http://download.example/pub/fedora/linux|baseurl=https://${MIRROR_HOST}/fedora|g" \
            -i "$f"
        log "已切换 $f -> https://${MIRROR_HOST}/fedora"
      else
        warn "未找到 $f，跳过"
      fi
    done
  else
    dnf config-manager setopt "fedora.baseurl=https://${MIRROR_HOST}/fedora/releases/\$releasever/Everything/\$basearch/os/"
    dnf config-manager setopt "fedora.metalink="
    dnf config-manager setopt "updates.baseurl=https://${MIRROR_HOST}/fedora/updates/\$releasever/Everything/\$basearch/"
    dnf config-manager setopt "updates.metalink="
    log "已通过 dnf config-manager 切换到 https://${MIRROR_HOST}/fedora"
  fi
}

# =====================================================================
# 阶段 1：以 root 身份换源、创建用户并配置免密 sudo
# =====================================================================
stage_root() {
  # 不是 root 就用 sudo 重新执行自己
  if [ "$(id -u)" -ne 0 ]; then
    have sudo || die "当前不是 root 且没有 sudo，请先切换到 root 再运行。"
    log "需要 root 权限，使用 sudo 重新执行"
    exec sudo bash "$0" "$@"
  fi

  log "检测到 ${PRETTY_NAME:-$ID}，使用 $FAMILY 流程（换源：apt/dnf -> ${MIRROR_HOST}，PyPI -> ${PYPI_MIRROR_HOST}）"

  # 1) 换系统源，并确保 sudo 可用（最小化系统/容器里常常没有）
  if [ "$FAMILY" = debian ]; then
    export DEBIAN_FRONTEND=noninteractive
    # 没有 ca-certificates 时 HTTPS 源拉不下来：先用 http，装好证书后再升级成 https
    local scheme=https
    dpkg -s ca-certificates >/dev/null 2>&1 || scheme=http
    mirror_debian "$scheme"
    apt-get update -y
    apt-get install -y ca-certificates sudo
    if [ "$scheme" = http ]; then
      mirror_debian_upgrade_https
      apt-get update -y
    fi
  else
    mirror_fedora
    dnf install -y sudo
  fi

  # 2) 创建用户
  if id "$NEW_USER" >/dev/null 2>&1; then
    log "用户 $NEW_USER 已存在，跳过创建"
  else
    log "创建用户 $NEW_USER"
    useradd -m -s /bin/bash "$NEW_USER"
  fi
  # 加入管理员组（sudo / wheel），即使有 NOPASSWD 规则也保持习惯一致
  if getent group "$ADMIN_GROUP" >/dev/null; then
    usermod -aG "$ADMIN_GROUP" "$NEW_USER"
  fi

  # 3) 写入免密 sudo（先校验语法，再落盘，避免写坏 sudoers 把自己锁在外面）
  local sudoers_file="/etc/sudoers.d/90-${NEW_USER}"
  local tmp
  tmp="$(mktemp)"
  echo "${NEW_USER} ALL=(ALL) NOPASSWD: ALL" > "$tmp"
  if visudo -cf "$tmp" >/dev/null; then
    install -m 0440 -o root -g root "$tmp" "$sudoers_file"
    log "已写入 $sudoers_file"
  else
    rm -f "$tmp"
    die "sudoers 语法校验失败，已中止"
  fi
  rm -f "$tmp"

  # 4) 把自己复制到 /tmp，以新用户的登录 shell 执行阶段 2
  local copy="/tmp/.setup-dev-tools.$$.sh"
  install -m 0755 "$0" "$copy"
  log "切换到用户 $NEW_USER 继续安装工具"
  runuser -l "$NEW_USER" -c "$(printf 'bash %q --user-stage' "$copy")"
  rm -f "$copy"

  echo
  log "全部完成。切换到新用户：su - $NEW_USER"
  warn "$NEW_USER 目前没有登录密码（只能通过 root 切换）。需要密码登录请执行：passwd $NEW_USER"
  warn "需要 SSH 登录请把公钥放到 /home/$NEW_USER/.ssh/authorized_keys"
}

# =====================================================================
# 换源：uv / pip / rustup / cargo（阶段 2，普通用户）
# =====================================================================
configure_user_mirrors() {
  local pypi="https://${PYPI_MIRROR_HOST}/pypi/web/simple"

  # uv：~/.config/uv/uv.toml（uv 不读 pip.conf）
  local uvconf="$HOME/.config/uv/uv.toml"
  if [ -e "$uvconf" ]; then
    warn "$uvconf 已存在，不覆盖（如需镜像请手动加入 [[index]] 段）"
  else
    mkdir -p "$(dirname "$uvconf")"
    {
      echo "[[index]]"
      echo "url = \"${pypi}\""
      echo "default = true"
    } > "$uvconf"
    log "已写入 $uvconf（PyPI -> $pypi）"
  fi

  # pip：给直接用 pip 的场景
  local pipconf="$HOME/.config/pip/pip.conf"
  if [ -e "$pipconf" ]; then
    warn "$pipconf 已存在，不覆盖"
  else
    mkdir -p "$(dirname "$pipconf")"
    printf '[global]\nindex-url = %s\n' "$pypi" > "$pipconf"
    log "已写入 $pipconf（PyPI -> $pypi）"
  fi

  # bun：全局 ~/.bunfig.toml 设置 npm 源（bun install 用）
  local bunconf="$HOME/.bunfig.toml"
  if [ -e "$bunconf" ]; then
    warn "$bunconf 已存在，不覆盖（如需镜像请手动加入 [install] registry）"
  else
    printf '[install]\nregistry = "%s"\n' "$NPM_REGISTRY" > "$bunconf"
    log "已写入 $bunconf（npm -> $NPM_REGISTRY）"
  fi

  # rustup：环境变量（持久化到 ~/.bashrc，rustup update 时也走镜像）
  export RUSTUP_DIST_SERVER="https://${RUST_MIRROR_HOST}/rust-static"
  export RUSTUP_UPDATE_ROOT="https://${RUST_MIRROR_HOST}/rust-static/rustup"
  if ! grep -q '# >>> cn-mirror rustup >>>' "$HOME/.bashrc" 2>/dev/null; then
    cat >> "$HOME/.bashrc" <<EOF

# >>> cn-mirror rustup >>>
export RUSTUP_DIST_SERVER="${RUSTUP_DIST_SERVER}"
export RUSTUP_UPDATE_ROOT="${RUSTUP_UPDATE_ROOT}"
# <<< cn-mirror rustup <<<
EOF
    log "已把 rustup 镜像变量写入 ~/.bashrc"
  fi

  # cargo：crates.io 稀疏索引镜像
  local cargoconf="$HOME/.cargo/config.toml"
  if [ -e "$cargoconf" ]; then
    warn "$cargoconf 已存在，不覆盖"
  else
    mkdir -p "$HOME/.cargo"
    cat > "$cargoconf" <<EOF
[source.crates-io]
replace-with = "mirror"

[source.mirror]
registry = "sparse+https://${RUST_MIRROR_HOST}/crates.io-index/"
EOF
    log "已写入 $cargoconf"
  fi
}

# =====================================================================
# 换源：Go 模块代理（需要 go 已安装，所以在安装系统包之后调用）
# =====================================================================
configure_go_mirror() {
  if ! have go; then
    warn "未找到 go，跳过 GOPROXY 配置"
    return 0
  fi
  # 只在还是官方默认值时才改，避免覆盖用户自己的设置
  if [ "$(go env GOPROXY)" = "https://proxy.golang.org,direct" ]; then
    go env -w "GOPROXY=${GOPROXY_URL}"
    log "已设置 GOPROXY=${GOPROXY_URL}（写入 $(go env GOENV)）"
  else
    warn "GOPROXY 已被自定义为 $(go env GOPROXY)，不覆盖"
  fi
}

# =====================================================================
# 阶段 2：以普通用户身份安装工具
# =====================================================================
stage_user() {
  [ "$(id -u)" -ne 0 ] || die "阶段 2 必须以普通用户运行（uv / rust 是用户级安装）。"
  have sudo || die "需要 sudo。"
  SUDO="sudo"

  mkdir -p "$HOME/.local/bin"
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$HOME/.bun/bin:$HOME/go/bin:$PATH"

  # ---------- 0. 用户级镜像配置 ----------
  configure_user_mirrors

  # ---------- 1. 系统包（包管理器） ----------
  install_debian() {
    export DEBIAN_FRONTEND=noninteractive
    log "apt 安装基础包"
    $SUDO apt-get update -y
    # build-essential：rust 链接需要 cc；apt 的 yq 是 python 版（非 mikefarah），故不装
    $SUDO apt-get install -y curl ca-certificates git build-essential unzip \
      jq ripgrep fd-find golang-go

    # Debian 里 fd 的可执行文件叫 fdfind，做个软链
    if ! have fd && have fdfind; then
      ln -sf "$(command -v fdfind)" "$HOME/.local/bin/fd"
      log "已创建 fd -> fdfind 软链（~/.local/bin/fd）"
    fi

    # GitHub CLI：发行版仓库版本偏旧，用官方 apt 源（国内访问可能较慢，需自行处理）
    if ! have gh; then
      log "添加 GitHub CLI 官方 apt 源"
      $SUDO mkdir -p -m 755 /etc/apt/keyrings
      curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | $SUDO tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
      $SUDO chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        | $SUDO tee /etc/apt/sources.list.d/github-cli.list >/dev/null
      $SUDO apt-get update -y
      $SUDO apt-get install -y gh
    fi

    # yq：Debian 的 apt 包是另一个同名项目（python 包装 jq），改用 mikefarah/yq 官方二进制
    if have yq && yq --version 2>&1 | grep -qi mikefarah; then
      log "yq (mikefarah) 已存在，跳过"
    else
      local arch
      case "$(dpkg --print-architecture)" in
        amd64) arch=amd64 ;;
        arm64) arch=arm64 ;;
        armhf) arch=arm ;;
        *) die "yq：不支持的架构 $(dpkg --print-architecture)" ;;
      esac
      log "下载 yq (mikefarah) 到 /usr/local/bin"
      curl -fsSL "https://github.com/mikefarah/yq/releases/latest/download/yq_linux_${arch}" -o /tmp/yq
      $SUDO install -m 0755 /tmp/yq /usr/local/bin/yq
      rm -f /tmp/yq
    fi
  }

  install_fedora() {
    log "dnf 安装基础包"
    # Fedora 的 yq 就是 mikefarah/yq；fd-find 提供 fd 命令；gh 在官方仓库里
    $SUDO dnf install -y curl ca-certificates git gcc unzip \
      jq yq golang ripgrep fd-find gh
  }

  case "$FAMILY" in
    debian) install_debian ;;
    fedora) install_fedora ;;
  esac

  # 额外的系统工具：基础命令 + shellcheck + gawk + wl-clipboard
  # 批量安装失败（比如某个包名在当前发行版不存在）时，逐个重试，只跳过有问题的
  install_extras() {
    local -a pkgs=("$@") cmd
    if [ "$FAMILY" = debian ]; then
      cmd=(apt-get install -y)
    else
      cmd=(dnf install -y)
    fi
    log "安装额外系统工具：${pkgs[*]}"
    if ! $SUDO "${cmd[@]}" "${pkgs[@]}"; then
      warn "批量安装失败，改为逐个安装"
      local p
      for p in "${pkgs[@]}"; do
        $SUDO "${cmd[@]}" "$p" || warn "跳过 $p（当前发行版仓库里可能没有这个包）"
      done
    fi
  }
  case "$FAMILY" in
    # lsof/ps/ss/ping/dig/file/patch/rsync/ssh/zip；gawk 会成为 awk 的默认实现（替换 mawk）
    debian) install_extras lsof procps iproute2 iputils-ping dnsutils file patch rsync \
              openssh-client zip shellcheck gawk wl-clipboard ;;
    fedora) install_extras lsof procps-ng iproute iputils bind-utils file patch rsync \
              openssh-clients zip ShellCheck gawk wl-clipboard ;;
  esac

  configure_go_mirror

  # zig：优先走包管理器；仓库里没有再退回 PyPI 的 ziglang 包（需要 uv，所以在 uv 之后调用）
  install_zig() {
    if have zig; then
      log "zig 已存在，跳过"
      return 0
    fi
    log "安装 zig（优先包管理器）"
    if [ "$FAMILY" = debian ]; then
      # Debian 稳定版仓库没有 zig，新版 Ubuntu 有；先看有没有候选版本
      if apt-cache policy zig 2>/dev/null | grep -qE 'Candidate: [^(]'; then
        $SUDO apt-get install -y zig || true
      fi
    else
      $SUDO dnf install -y zig || true
    fi
    if have zig; then
      return 0
    fi
    warn "仓库里没有可用的 zig，改用 PyPI 的 ziglang 包（经 uv + PyPI 镜像）"
    uv tool install --upgrade ziglang
    # ziglang 包装出来的可执行名是 python-zig，补一个 zig 入口
    printf '#!/bin/sh\nexec python-zig "$@"\n' > "$HOME/.local/bin/zig"
    chmod +x "$HOME/.local/bin/zig"
  }

  # bun：不在 apt/dnf 里，用官方安装脚本（装到 ~/.bun，依赖 unzip）
  install_bun() {
    if have bun; then
      log "bun 已存在，跳过"
      return 0
    fi
    log "安装 bun（官方脚本）"
    curl -fsSL https://bun.com/install | bash
    have bun || warn "bun 安装后不在 PATH 中，请重新打开终端后再试"
  }

  # ---------- 2. uv（官方安装脚本，装到 ~/.local/bin，可 uv self update） ----------
  if have uv; then
    log "uv 已存在，跳过"
  else
    log "安装 uv"
    curl -LsSf https://astral.sh/uv/install.sh | sh
  fi
  have uv || die "uv 安装失败或不在 PATH 中"

  # ---------- 3. Python CLI 工具（通过 uv tool 隔离安装，走 uv.toml 里的 PyPI 镜像） ----------
  log "安装 kaggle CLI"
  uv tool install --upgrade kaggle

  log "安装 Colab CLI (google-colab-cli)"
  uv tool install --upgrade google-colab-cli

  log "安装 ruff"
  uv tool install --upgrade ruff

  # ---------- 4. zig 与 bun ----------
  install_zig
  install_bun

  # ---------- 5. Rust（rustup, minimal profile；走 RUSTUP_* 镜像变量） ----------
  if have rustup; then
    log "rustup 已存在，更新 stable (minimal)"
    rustup set profile minimal
    rustup update stable
  else
    log "安装 Rust (rustup, minimal profile)"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --profile minimal --default-toolchain stable
  fi
  if [ -f "$HOME/.cargo/env" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.cargo/env"
  fi
  # minimal profile 不含 rustfmt / clippy，单独补上
  log "添加 rustfmt 与 clippy"
  rustup component add rustfmt clippy

  # ---------- 6. 汇总 ----------
  echo
  log "安装结果："
  for t in uv jq yq go rg fd gh kaggle colab ruff shellcheck bun zig rustc cargo rustfmt cargo-clippy gawk wl-copy lsof ss dig rsync; do
    if have "$t"; then
      case "$t" in
        go)     v=$(go version) ;;
        zig)    v=$(zig version 2>&1 | head -n1) ;;
        lsof)   v=$(lsof -v 2>&1 | grep -m1 revision || echo ok) ;;
        dig)    v=$(dig -v 2>&1 | head -n1) ;;
        colab)  v=$(colab version 2>&1 | head -n1) ;;
        *)      v=$("$t" --version 2>&1 | head -n1) ;;
      esac
      printf '  \033[32m✔\033[0m %-7s %s\n' "$t" "$v"
    else
      printf '  \033[31m✘\033[0m %-7s 未找到\n' "$t"
    fi
  done

  echo
  echo "后续手动步骤（以 $(id -un) 身份）："
  echo "  gh auth login"
  echo "  kaggle：在 kaggle.com 账号设置里创建 API token，按官方说明配置"
  echo "  colab：首次使用按其提示完成 Google 账号认证"
}

# ---------- 入口 ----------
if [ "${1:-}" = "--user-stage" ]; then
  stage_user
else
  stage_root "$@"
fi
