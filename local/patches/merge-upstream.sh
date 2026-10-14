#!/usr/bin/env bash
# 定期合并上游稳定版到 fork（不自动推送、不自动升级安装——报告留给人决策）。
# 语义：fetch upstream → 找比当前 merge 基线新的最高 dsh-v* 稳定 tag（排除 rc/alpha/beta）→
#       在 fork 仓库 local/auto-merge-upstream 分支上 merge → 跑补丁器干跑（--check）→
#       状态落盘 + 本地分支保留。push 与生产升级永远人工拍板。
set -uo pipefail
REPO=/home/h/deepseek-harness
LOG=/var/tmp/dsh-upstream-merge.log
cd "$REPO" || exit 2
{
  echo "=== $(date -Is) run start"
  git fetch origin --tags 2>&1 | tail -2
  # 当前 master 已含的上游最新 tag；官方至今只发 rc/alpha 预发布——
  # 优先非预发布 tag，没有则退而取最高 rc（排除 alpha/beta）
  pick_newest () { grep -vE -- '-(alpha|beta)' | sort -V | tail -1; }
  merged_all=$(git tag --merged master 'dsh-v*')
  base_tag=$(echo "$merged_all" | grep -vE -- '-(rc|alpha|beta)' | sort -V | tail -1)
  [ -n "$base_tag" ] || base_tag=$(echo "$merged_all" | pick_newest)
  newest=$(git tag -l 'dsh-v*' | grep -vE -- '-(rc|alpha|beta)' | sort -V | tail -1)
  [ -n "$newest" ] || newest=$(git tag -l 'dsh-v*' | pick_newest)
  echo "base_tag=$base_tag newest_stable=$newest"
  if [ "$base_tag" = "$newest" ]; then echo "UP-TO-DATE"; exit 0; fi
  git checkout -q master
  git branch -q -f local/auto-merge-upstream master
  git checkout -q local/auto-merge-upstream
  if git merge "$newest" --no-edit -m "local: auto-merge upstream $newest (待人工验证)"; then
    echo "MERGED $newest clean"
  else
    echo "CONFLICT on $newest — 人工处理：$(git diff --name-only --diff-filter=U | head -10)"
    git merge --abort
    git checkout -q master
    exit 1
  fi
  echo "--- 补丁器干跑（--check）---"
  shopt -s nullglob
  patches=(local/patches/ensure-*.mjs)
  if [ ${#patches[@]} -eq 0 ]; then echo "WARN: local/patches/ensure-*.mjs 未展开（目录缺失？）"; fi
  for f in "${patches[@]}"; do
    if /usr/bin/node "$f" --check >/dev/null 2>&1; then echo "OK    $f"; else echo "RED($?) $f — 锚点漂移，需适配"; fi
  done
  shopt -u nullglob
  git checkout -q master
  echo "branch local/auto-merge-upstream 已就绪，人工验证后 fast-forward master 并 push fork"
} >> "$LOG" 2>&1
