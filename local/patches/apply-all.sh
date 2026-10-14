#!/usr/bin/env bash
# dsh 启动前重打全部本地补丁（幂等）。
# 语义：每个补丁器独立跑；exit 2（目标不存在/版本漂移）不阻断启动——可用性优先，
#       但打完整段落日志留痕；exit 1（需要打却打失败/锚点 STALE）视为需要人看的信号，
#       同样放行启动但状态落 /var/tmp/dsh-local-patches.status。
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
STATUS=/var/tmp/dsh-local-patches.status
: > "$STATUS"
overall=0
for p in \
  ensure-connstuck-patch.mjs \
  ensure-quotamisclass-patch.mjs \
  ensure-v0-tier-compat-patch.mjs \
  ensure-resume-cooldown-patch.mjs \
  ensure-plugin-identity-patch.mjs \
  ensure-tooljsonrepair-patch.mjs \
  ensure-contextrow-visible-patch.mjs \
  ensure-identity-dedup-patch.mjs \
  /home/h/dsh-plugins/dsh-preset-composer/scripts/ensure-profile-version.mjs
do
  name=$(basename "$p")
  script="$DIR/$p"; [ -f "$script" ] || script="$p"
  if out=$(/usr/bin/node "$script" 2>&1); then
    echo "OK    $name" >> "$STATUS"
  else
    rc=$?
    echo "RED($rc) $name :: $(echo "$out" | tail -1)" >> "$STATUS"
    [ "$rc" -eq 2 ] || overall=1
  fi
done
cat "$STATUS"
# 永远放行启动：补丁缺席不该让 dsh 起不来；RED 项由人工/巡检跟进。
exit 0
