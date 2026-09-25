#!/usr/bin/env bash
# 0.1.5-rc.2 → 0.1.7-rc.2 升级执行脚本。
#
# 默认 **只做检查与备份**（dry-run）；真正改动全局安装与服务要加 --apply。
# 演练依据：.upgrade/MIGRATION-CHECKLIST-v2.md（十节实测记录）。
#
# 用法:
#   bash .upgrade/run-upgrade-0.1.7.sh                 # 检查 + 预告，不动系统
#   bash .upgrade/run-upgrade-0.1.7.sh --apply         # 真正升级
#
# 可在演练沙箱里验证（不改真机）:
#   DSH_HOME_DIR_OVERRIDE=<沙箱 DSH_HOME> SKIP_INSTALL=1 SKIP_RESTART=1 \
#     bash .upgrade/run-upgrade-0.1.7.sh --apply
set -uo pipefail

TARGET_VERSION="${TARGET_VERSION:-0.1.7-rc.2}"
REPO="${REPO:-/home/h/app/deepseek-harness}"
# 演练时可覆盖，默认打真机。
DSH_HOME_DIR="${DSH_HOME_DIR_OVERRIDE:-/home/h/.dsh}"
GLOBAL="${GLOBAL_OVERRIDE:-/home/h/.npm-dlabal}"
UNIT="${UNIT_OVERRIDE:-/home/h/.config/systemd/user/dsh-web.service}"
SKIP_INSTALL="${SKIP_INSTALL:-0}"
SKIP_RESTART="${SKIP_RESTART:-0}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$DSH_HOME_DIR/backups/pre-0.1.7-$STAMP"
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

say() { printf '\n\033[1m══ %s ══\033[0m\n' "$*"; }
ok()  { printf '  \033[32m✅\033[0m %s\n' "$*"; }
bad() { printf '  \033[31m❌\033[0m %s\n' "$*"; }
warn(){ printf '  \033[33m⚠\033[0m %s\n' "$*"; }

say "0/6 目标"
echo "  DSH_HOME : $DSH_HOME_DIR"
echo "  GLOBAL   : $GLOBAL"
echo "  版本     : $TARGET_VERSION   模式: $([ "$APPLY" = 1 ] && echo APPLY || echo dry-run)"
[ "$SKIP_INSTALL" = 1 ] && warn "SKIP_INSTALL=1 —— 跳过全局安装"
[ "$SKIP_RESTART" = 1 ] && warn "SKIP_RESTART=1 —— 跳过服务重启"

# ── 1. 前置检查 ──────────────────────────────────────────────
say "1/6 前置检查"
for s in ensure-connstuck ensure-quotamisclass ensure-v0-tier-compat ensure-resume-cooldown; do
  if node "$REPO/local/patches/$s-patch.mjs" --check >/dev/null 2>&1; then ok "$s 健康"; else bad "$s 需重打（升级后由 ExecStartPre 自动重打）"; fi
done
if [ -d "$REPO/local/presets/memo-river" ] && [ -d "$REPO/local/presets/plugin-dev" ]; then
  ok "预设 bundle 在位（入库提交 $(cd "$REPO" && git log -1 --format=%h -- local/presets)）"
else
  bad "预设 bundle 缺失 —— 升级后无法恢复记忆河流，中止"; exit 1
fi
[ -d "$REPO/packages/client/ui-thinking-keywords" ] && warn "packages/client/ui-thinking-keywords 仍在工作区（只影响在仓库跑 pnpm install；本次升级不走那条路）"
df -h "$DSH_HOME_DIR" 2>/dev/null | tail -1 | awk '{print "  可用磁盘: "$4}'

# ── 2. 备份（唯一不可省的一步）───────────────────────────────
say "2/6 备份（sessions 优先）"
if [ "$APPLY" = 1 ]; then
  mkdir -p "$BACKUP"
  for item in sessions settings.yaml profiles .agent-presets; do
    [ -e "$DSH_HOME_DIR/$item" ] || { warn "$item 不存在，跳过"; continue; }
    cp -a "$DSH_HOME_DIR/$item" "$BACKUP/" && ok "备份 $item"
  done
  mkdir -p "$DSH_HOME_DIR/backups" && echo "$BACKUP" > "$DSH_HOME_DIR/backups/LAST-PRE-0.1.7.txt"
  ok "备份位置: $BACKUP"
else
  warn "dry-run：未备份。执行时会拷 sessions / settings.yaml / profiles / .agent-presets 到 $BACKUP"
fi

# ── 3. 全局安装 ──────────────────────────────────────────────
say "3/6 全局安装 → $TARGET_VERSION"
warn "必须写明确版本号：latest 仍指向 0.1.5-rc.3，裸装等于降级"
if [ "$SKIP_INSTALL" = 1 ]; then
  warn "已按 SKIP_INSTALL 跳过"
elif [ "$APPLY" = 1 ]; then
  npm i -g "@deepseek-ai/dsh@$TARGET_VERSION" && ok "已安装" || { bad "npm 安装失败，中止"; exit 1; }
else
  echo "  （dry-run）npm i -g @deepseek-ai/dsh@$TARGET_VERSION"
fi

# ── 4. profile 改造：装 bundle、去 preset-composer ────────────
say "4/6 profile 改造"
P="$DSH_HOME_DIR/profiles/web"
if [ ! -d "$P" ]; then bad "profile 目录不存在: $P（中止）"; exit 1; fi
if [ "$APPLY" = 1 ]; then
  cp -a "$P/package.json" "$P/package.json.bak-0.1.7-$STAMP" && ok "已备份 profile package.json"
  cp "$REPO/.upgrade/profile-web.package.json.target" "$P/package.json" && ok "已写入目标 package.json"
  mkdir -p "$P/node_modules/@local"
  ln -sfn "$REPO/local/presets/memo-river"                 "$P/node_modules/@local/dsh-memo-river-preset"
  ln -sfn "$REPO/local/presets/plugin-dev"                 "$P/node_modules/@local/dsh-plugin-dev-preset"
  ln -sfn "$REPO/local/presets/packages/memo-river-plugin" "$P/node_modules/@local/dsh-memo-river-plugin"
  ln -sfn "$REPO/local/presets/packages/memory-disclosure" "$P/node_modules/@local/dsh-memory-disclosure"
  ok "已建 4 条 @local 链接（只改 package.json 不建链接会报 Cannot find package）"
  rm -f "$P/node_modules/@dsh-external/dsh-preset-composer" && ok "已摘掉 preset-composer 链接"
else
  echo "  （dry-run）会：备份并覆写 profile package.json + 建 4 条 @local 链接 + 摘掉 preset-composer"
fi

# ── 5. 重启服务（ExecStartPre 会自动重打补丁）────────────────
say "5/6 重启宿主"
if [ "$SKIP_RESTART" = 1 ]; then
  warn "已按 SKIP_RESTART 跳过（会执行: systemctl --user restart dsh-web.service）"
elif [ "$APPLY" = 1 ]; then
  systemctl --user restart dsh-web.service && ok "已重启（这会中断当前 Web 会话）" || bad "重启失败，检查 $UNIT"
else
  echo "  （dry-run）systemctl --user restart dsh-web.service"
fi

# ── 6. 升级后验收 ────────────────────────────────────────────
say "6/6 升级后验收（升级完逐条跑）"
cat <<EOF
  a) 四个补丁器：node local/patches/<每个> --check  → 全 exit=0
  b) 组合树：DSH_HOME=$DSH_HOME_DIR dsh --profile web --dump-config | grep -E "preset-memo-river|preset-plugin-dev"
  c) 启动日志无 "agent preset …: never started"
  d) 设置：确认 $DSH_HOME_DIR/settings.yaml 变成 settings.yaml.imported，且
     llm-pi-ai 的 9 个中转站与 llm-deepseek 的 4 个模型仍在（唯一一次导入机会）
     —— 沙箱实测口径：dump-config 里 baseURL 9/9、models 23/23
  e) 会话：打开一条 v0 —— 目录里应新增 session.v4.jsonl.zstd，原 session.jsonl.zstd 逐字节不变
  f) 清理：profile 的 cordis.patch.yml 有 6 条悬空行（dsh-closedloop-mode / dsh-web-tools /
     dsh-graded-mode / dsh-engram-relay / dsh-memo-river / dsh-legacy-polyfill）可删
  g) billion-context-dsh：被跳过属预期；要用就 dsh plugin allow-version 精确豁免
  h) 模型：确认 deepseek-v4-flash-vision-exp 仍可用（release note 称默认列表移除了它）
EOF

say "完成"
if [ "$APPLY" = 0 ]; then
  echo "  这是 dry-run。确认无误后：bash .upgrade/run-upgrade-0.1.7.sh --apply"
else
  echo "  记得跑第 6 节验收。"
fi
